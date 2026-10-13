import json
import logging
import os
import re
import shutil
import sqlite3
import tempfile
import time
import uuid
from contextlib import contextmanager
from pathlib import Path

import secure_crypto as sc
import secure_platform as default_secure_platform
from app_schema import initialize_schema
from document_model import DocumentError, empty_document, from_fabric, plain_text
from json_canvas import estimate_text_box, from_json_canvas, is_json_canvas, to_json_canvas
from media_store import MediaStore, data_url_of
from page_note import empty_page_document, find_quote, normalize_page_document, page_document_of, page_text, reanchor_ink, utf16

logger = logging.getLogger(__name__)

# How a note's `content` column is encoded.
FORMAT_CANVAS = "json-canvas"  # JSON Canvas 1.0 + pn extensions (ADR 0002)
FORMAT_FABRIC = "fabric"  # Fabric JSON: notes saved before F-026 until they are converted
FORMAT_MINDMAP = "mindmap"  # normalized mind-map JSON
FORMAT_PAGE = "page"  # page note: {version, markdown, ink} (ADR 0003)
FABRIC_BACKUP_SUFFIX = ".fabric-backup"

DEFAULT_CONTENT = {"objects": []}
DEFAULT_PAGE_STATE = {"columns": 1, "rows": 1}
DEFAULT_MINDMAP_CONTENT = {
    "version": 1,
    "title": "Untitled mind map",
    "rootId": "root",
    "defaultPresentation": "box",
    "nodes": [
        {
            "id": "root",
            "parentId": None,
            "text": "Central idea",
            "x": 0,
            "y": 0,
            "color": "#ef684b",
            "fontSize": 28,
            "bold": True,
            "font": "hand",
            "presentation": "box",
            "curve": 78,
        }
    ],
}
NOTE_TYPES = {"canvas", "mindmap", "page"}
DEFAULT_NOTEBOOK_COLOR = "#B86B4B"
NOTEBOOK_CATEGORIES = ("projects", "areas", "resources", "archive")
DEFAULT_NOTEBOOK_CATEGORY = "projects"
INBOX_NAME = "Inbox"  # the built-in home of unfiled notes (notes.notebook_id IS NULL); not a notebook row
NOTEBOOK_COLOR_PATTERN = re.compile(r"^#[0-9a-f]{6}$", re.IGNORECASE)
WORD_PATTERN = re.compile(r"[\w'-]+", re.UNICODE)
PAGE_WIDTH = 860
PAGE_HEIGHT = 1080
APPEND_LEFT = 72
APPEND_TOP = 80
APPEND_GAP = 24
APPEND_FONT_SIZE = 24
APPEND_LINE_HEIGHT = 1.45
APPEND_PADDING = 8
APPEND_MAX_LENGTH = 100_000
AGENT_ACTIVITY_WINDOW = 10.0
AGENT_ACTIONS = {"reading", "writing"}
CHANGES_LIMIT = 500


class NotFoundError(Exception):
    pass


class ConflictError(Exception):
    pass


class WorkspaceImportError(ValueError):
    pass


class UnsupportedNoteTypeError(ValueError):
    pass


class AppendTextError(ValueError):
    """Text to append is blank or too long."""


class InvalidNoteContentError(ValueError):
    """A canvas note's content is not a document this version can read."""


class SecureError(Exception):
    """Base of the secure-note errors (F-057); the message is safe to show."""


class SecureLockedError(SecureError):
    """The note's words are locked: unlock secure notes first."""


class SecureAuthError(SecureError):
    """Touch ID, the passphrase or the recovery key was not accepted."""


class SecureSetupError(SecureError):
    """A passphrase is needed, or the request does not fit the secure-note setup."""


class SecureNoteAgentError(SecureError):
    """Agents (the CLI) never read or write a secure note's words."""


def empty_canvas_text() -> str:
    return json.dumps(to_json_canvas(empty_document()), separators=(",", ":"))


class NoteService:
    def __init__(
        self,
        database_path: Path | str,
        media_dir: Path | str | None = None,
        secure_platform=None,
        scrypt_cost: int = sc.SCRYPT_N,
        clock=time.monotonic,
    ):
        # Secure notes (F-057): the platform seam (Touch ID + keychain on a Mac), the key cost for passphrases, and the keys held while unlocked.
        self.secure_platform = secure_platform if secure_platform is not None else default_secure_platform
        self.scrypt_cost = scrypt_cost
        self.keyring = sc.Keyring(clock)
        self.database_path = Path(database_path)
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        # Content-addressed picture and SVG files (`media/<sha256>.<ext>` in notes); beside the database unless told otherwise.
        self.media = MediaStore(media_dir if media_dir is not None else self.database_path.parent / "media")
        self.keep_fabric_backup()
        with self.connection() as connection:
            self.default_notebook_id = initialize_schema(connection)
            self.ensure_block_ids(connection)
            self.convert_legacy_notes(connection)
            self.ensure_block_ids(connection)
            self.ensure_derived_indexes(connection)

    def connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.database_path, timeout=10)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode = WAL")
        connection.execute("PRAGMA foreign_keys = ON")
        return connection

    @contextmanager
    def connection(self):
        connection = self.connect()
        try:
            yield connection
        finally:
            connection.close()

    @staticmethod
    def parse_json(value: str, fallback):
        try:
            return json.loads(value)
        except (TypeError, json.JSONDecodeError):
            return fallback

    @classmethod
    def serialize_note(cls, note: sqlite3.Row) -> dict:
        return {
            "id": note["id"],
            "resourceId": note["resource_id"],
            "revision": note["revision"],
            "noteType": note["note_type"],
            "title": note["title"],
            "notebookId": note["notebook_id"],
            "content": cls.parse_json(note["content"], DEFAULT_CONTENT),
            "contentFormat": cls.format_of(note),
            "pageState": cls.parse_json(note["page_state"], DEFAULT_PAGE_STATE),
            "createdAt": note["created_at"],
            "updatedAt": note["updated_at"],
            "secure": bool(note["secure"]),
            "locked": False,
        }

    @staticmethod
    def format_of(note) -> str:
        if note["note_type"] == "mindmap":
            return FORMAT_MINDMAP
        if note["note_type"] == "page":
            return FORMAT_PAGE
        return FORMAT_FABRIC if note["content_format"] == FORMAT_FABRIC else FORMAT_CANVAS

    @staticmethod
    def new_resource_id() -> str:
        return f"res_{uuid.uuid4().hex}"

    @staticmethod
    def record_change(
        connection: sqlite3.Connection,
        resource_kind: str,
        resource_id: str,
        revision: int,
        change_type: str,
    ) -> int:
        sequence = connection.execute(
            """
            UPDATE workspace_state
            SET sequence = sequence + 1, updated_at = CURRENT_TIMESTAMP
            WHERE id = 1
            RETURNING sequence
            """
        ).fetchone()[0]
        connection.execute(
            """
            INSERT INTO workspace_changes
                (sequence, resource_kind, resource_id, revision, change_type)
            VALUES (?, ?, ?, ?, ?)
            """,
            (sequence, resource_kind, resource_id, revision, change_type),
        )
        return int(sequence)

    @staticmethod
    def expected_revision(payload: dict, current_revision: int) -> int:
        if "revision" not in payload:
            return current_revision
        try:
            expected = int(payload["revision"])
        except (TypeError, ValueError):
            raise ConflictError("A valid revision is required") from None
        if expected != current_revision:
            raise ConflictError("Resource revision does not match")
        return expected

    @classmethod
    def normalize_canvas_document(
        cls,
        document: dict,
        reserved_ids: set[str] | None = None,
    ) -> tuple[dict, bool]:
        if not isinstance(document, dict):
            document = dict(DEFAULT_CONTENT)
        objects = document.get("objects")
        if not isinstance(objects, list):
            objects = []
            document["objects"] = objects
        seen = set(reserved_ids or ())
        in_document: set[str] = set()
        id_map: dict[str, str] = {}
        changed = False
        for item in objects:
            if not isinstance(item, dict):
                continue
            semantic_id = item.get("semanticId")
            if not isinstance(semantic_id, str) or not semantic_id or semantic_id in seen:
                new_id = cls.new_resource_id()
                # First holder of an id that had to change: connectors pointing at it follow.
                if isinstance(semantic_id, str) and semantic_id and semantic_id not in in_document:
                    id_map[semantic_id] = new_id
                semantic_id = new_id
                item["semanticId"] = semantic_id
                changed = True
            seen.add(semantic_id)
            in_document.add(semantic_id)
        if id_map:
            for item in objects:
                if isinstance(item, dict) and item.get("type") == "Connector":
                    for key in ("fromId", "toId"):
                        if item.get(key) in id_map:
                            item[key] = id_map[item[key]]
        return document, changed

    # ---- canvas documents: JSON Canvas storage (F-026) -------------------------------------------------------------------

    @staticmethod
    def stored_ids(content, content_format: str) -> list[str]:
        """The block ids a stored canvas holds: node and edge ids, or Fabric semanticIds for a note not yet converted."""
        if not isinstance(content, dict):
            return []
        if content_format == FORMAT_FABRIC:
            return [i["semanticId"] for i in content.get("objects", []) if isinstance(i, dict) and isinstance(i.get("semanticId"), str)]
        entries = [*(content.get("nodes") or []), *(content.get("edges") or [])]
        return [i["id"] for i in entries if isinstance(i, dict) and isinstance(i.get("id"), str)]

    @classmethod
    def repair_ids(cls, doc: dict, reserved_ids: set[str] | None = None) -> bool:
        """Give every top-level object a unique, non-empty id that no other note uses; connectors follow an id that changed."""
        seen = set(reserved_ids or ())
        in_document: set[str] = set()
        id_map: dict[str, str] = {}
        changed = False
        for obj in doc.get("objects", []):
            if not isinstance(obj, dict) or (obj.get("type") == "unknown" and not isinstance(obj.get("raw"), dict)):
                continue
            object_id = obj.get("id")
            if not isinstance(object_id, str) or not object_id or object_id in seen:
                new_id = cls.new_resource_id()
                if isinstance(object_id, str) and object_id and object_id not in in_document:
                    id_map[object_id] = new_id
                object_id = new_id
                obj["id"] = object_id
                changed = True
            seen.add(object_id)
            in_document.add(object_id)
        if id_map:
            for obj in doc.get("objects", []):
                if isinstance(obj, dict) and obj.get("type") == "connector":
                    for key in ("fromId", "toId"):
                        if obj.get(key) in id_map:
                            obj[key] = id_map[obj[key]]
        return changed

    @staticmethod
    def normalize_page(doc: dict) -> None:
        page = doc.get("page") if isinstance(doc.get("page"), dict) else {}
        for key in ("columns", "rows"):
            value = page.get(key)
            page[key] = value if isinstance(value, int) and not isinstance(value, bool) and value >= 1 else 1
        doc["page"] = page

    @classmethod
    def document_of(cls, content, content_format: str | None = None, page_state=None) -> dict:
        """The document model of stored or incoming canvas content in either format. Raises InvalidNoteContentError."""
        try:
            if content_format == FORMAT_CANVAS or (content_format is None and is_json_canvas(content)):
                return from_json_canvas(content)
            return from_fabric(content if isinstance(content, dict) else dict(DEFAULT_CONTENT), page_state if isinstance(page_state, dict) else None)
        except DocumentError as error:
            raise InvalidNoteContentError(str(error)) from error

    def canvas_text_of(self, doc: dict) -> str:
        """The stored form of a document: JSON Canvas text, with pictures and SVGs written to the media store."""
        return json.dumps(to_json_canvas(doc, media=self.media), separators=(",", ":"), ensure_ascii=False)

    def prepare_canvas(self, content, page_state, reserved_ids: set[str] | None):
        """Incoming canvas content (JSON Canvas or old Fabric JSON) -> (document, stored text, page state, search body)."""
        document = self.document_of(content, None, page_state)
        self.repair_ids(document, reserved_ids)
        self.normalize_page(document)
        return document, self.canvas_text_of(document), document["page"], plain_text(document)

    def convert_legacy_notes(self, connection: sqlite3.Connection) -> None:
        """Once per old note: Fabric JSON -> JSON Canvas. (The database was copied aside first, see keep_fabric_backup.)

        Each note converts in its own transaction and is checked by reading the stored text back; a note that fails stays in
        Fabric format (it still opens, the next save converts it) and the failure is logged. Revisions and the change feed are
        untouched: the note says the same thing. Safe to run again.
        """
        rows = connection.execute(
            "SELECT id, content, page_state, title FROM notes WHERE note_type = 'canvas' AND content_format = ? AND secure = 0 ORDER BY id",
            (FORMAT_FABRIC,),
        ).fetchall()
        for row in rows:
            try:
                content = json.loads(row["content"])
                page_state = self.parse_json(row["page_state"], DEFAULT_PAGE_STATE)
                document = from_fabric(content, page_state if isinstance(page_state, dict) else None)
                self.normalize_page(document)
                text = self.canvas_text_of(document)
                if not self.same_after_storage(document, json.loads(text)):
                    raise DocumentError("the stored note does not read back the same")
                connection.execute(
                    "UPDATE notes SET content = ?, content_format = ?, page_state = ? WHERE id = ? AND content_format = ?",
                    (text, FORMAT_CANVAS, json.dumps(document["page"], separators=(",", ":")), row["id"], FORMAT_FABRIC),
                )
                connection.execute("DELETE FROM note_search WHERE note_id = ?", (row["id"],))
                connection.execute(
                    "INSERT INTO note_search (note_id, title, body) VALUES (?, ?, ?)", (row["id"], row["title"], plain_text(document))
                )
                connection.commit()
            except Exception:
                connection.rollback()
                logger.exception("event=note.convert outcome=failed note_id=%s; the note stays in its old format", row["id"])

    @staticmethod
    def same_after_storage(document: dict, stored_canvas: dict) -> bool:
        """The stored canvas reads back as the same document (pictures now point at the media store, which is the intended change)."""
        back = from_json_canvas(stored_canvas)

        def strip(doc: dict) -> dict:
            return {**doc, "objects": [{**o, "mediaRef": None} if o.get("type") == "image" else o for o in doc["objects"]]}

        return json.dumps(strip(back), sort_keys=True) == json.dumps(strip(document), sort_keys=True)

    def keep_fabric_backup(self) -> Path | None:
        """Before an old database is touched at all, copy it beside itself as `<name>.fabric-backup`.

        "Old" means it has a notes table without the `content_format` column, so the copy is exactly what the previous version
        wrote (before any column is added or any note converted). An existing copy is never replaced. Nothing is done for a new
        database or one already upgraded.
        """
        if not self.database_path.is_file():
            return None
        target = self.database_path.with_name(self.database_path.name + FABRIC_BACKUP_SUFFIX)
        if target.exists():
            return None
        source = sqlite3.connect(self.database_path, timeout=10)
        try:
            columns = {row[1] for row in source.execute("PRAGMA table_info(notes)")}
            if not columns or "content_format" in columns:
                return None
            # A temp file of its own (two processes may start at once), linked into place so an existing copy is never replaced.
            handle, temporary = tempfile.mkstemp(dir=target.parent, prefix=target.name + ".", suffix=".tmp")
            os.close(handle)
            copy = sqlite3.connect(temporary)
            try:
                source.backup(copy)
            finally:
                copy.close()
            try:
                try:
                    os.link(temporary, target)
                except FileExistsError:
                    pass
                except OSError:
                    # No hard links on this file system (exFAT, some network drives): an exclusive-create copy is just as no-clobber.
                    try:
                        with open(temporary, "rb") as source_file, open(target, "xb") as destination:
                            shutil.copyfileobj(source_file, destination)
                    except FileExistsError:
                        pass
                    except BaseException:
                        target.unlink(missing_ok=True)  # never leave a half-written copy that later starts would trust
                        raise
            finally:
                os.unlink(temporary)
            return target
        finally:
            source.close()

    def ensure_block_ids(self, connection: sqlite3.Connection) -> None:
        """Block ids are unique across the workspace; repair any that are missing, empty or shared (imports, copies)."""
        seen: set[str] = set()
        notes = connection.execute(
            "SELECT id, resource_id, revision, note_type, content, content_format, page_state, title FROM notes WHERE secure = 0 ORDER BY id"
        ).fetchall()
        for note in notes:
            if note["note_type"] != "canvas":
                continue
            if note["content_format"] == FORMAT_FABRIC:
                document = self.parse_json(note["content"], DEFAULT_CONTENT)
                document, changed = self.normalize_canvas_document(document, seen)
                seen.update(self.stored_ids(document, FORMAT_FABRIC))
                if not changed:
                    continue
                text = json.dumps(document, separators=(",", ":"))
            else:
                content = self.parse_json(note["content"], None)
                ids = self.stored_ids(content, FORMAT_CANVAS)
                if len(set(ids)) == len(ids) and not seen.intersection(ids):
                    seen.update(ids)
                    continue
                try:
                    doc = self.document_of(content, FORMAT_CANVAS)
                except InvalidNoteContentError:
                    logger.exception("event=note.ids outcome=skipped note_id=%s", note["id"])
                    continue
                self.repair_ids(doc, seen)
                seen.update(o["id"] for o in doc["objects"] if isinstance(o, dict) and isinstance(o.get("id"), str))
                text = self.canvas_text_of(doc)
            revision = note["revision"] + 1
            connection.execute(
                "UPDATE notes SET content = ?, revision = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                (text, revision, note["id"]),
            )
            self.record_change(connection, "note", note["resource_id"], revision, "updated")
        connection.commit()

    @classmethod
    def reserved_block_ids(
        cls,
        connection: sqlite3.Connection,
        exclude_note_id: int,
    ) -> set[str]:
        reserved: set[str] = set()
        rows = connection.execute(
            "SELECT content, content_format FROM notes WHERE id != ? AND note_type = 'canvas' AND secure = 0",
            (exclude_note_id,),
        ).fetchall()
        for row in rows:
            reserved.update(cls.stored_ids(cls.parse_json(row["content"], None), row["content_format"]))
        return reserved

    @classmethod
    def canvas_text(cls, content: str, content_format: str = FORMAT_FABRIC, page_state: str | None = None) -> str:
        """The text search indexes for a canvas: its text blocks in reading order (top edge first), blank-line separated."""
        parsed = cls.parse_json(content, None)
        try:
            document = cls.document_of(parsed, FORMAT_CANVAS if content_format == FORMAT_CANVAS else FORMAT_FABRIC, cls.parse_json(page_state, None))
        except InvalidNoteContentError:
            return ""
        return plain_text(document)

    @classmethod
    def mindmap_text(cls, content: str) -> str:
        document = cls.parse_json(content, DEFAULT_MINDMAP_CONTENT)
        return " ".join(
            node["text"]
            for node in document.get("nodes", [])
            if isinstance(node, dict) and isinstance(node.get("text"), str)
        )

    @classmethod
    def note_text(cls, note_type: str, content: str, content_format: str = FORMAT_FABRIC, page_state: str | None = None) -> str:
        if note_type == "page":
            return page_text(content)
        return cls.mindmap_text(content) if note_type == "mindmap" else cls.canvas_text(content, content_format, page_state)

    @staticmethod
    def normalize_mindmap_document(document: dict) -> dict:
        if not isinstance(document, dict) or not isinstance(document.get("nodes"), list):
            return json.loads(json.dumps(DEFAULT_MINDMAP_CONTENT))
        nodes = [node for node in document["nodes"] if isinstance(node, dict)]
        if not nodes:
            return json.loads(json.dumps(DEFAULT_MINDMAP_CONTENT))
        document["nodes"] = nodes
        document["version"] = 1
        return document

    @staticmethod
    def fts_query(terms, operator: str = "AND") -> str:
        escaped = [f'"{str(term).replace(chr(34), chr(34) * 2)}"' for term in terms]
        return f" {operator} ".join(escaped)

    @classmethod
    def index_note(
        cls,
        connection: sqlite3.Connection,
        note_id: int,
        title: str,
        content: str,
        note_type: str = "canvas",
        content_format: str = FORMAT_FABRIC,
        page_state: str | None = None,
        body: str | None = None,
    ) -> None:
        """Index a note. `body` is the Markdown-projection text when the caller already has the document."""
        if body is None:
            body = cls.note_text(note_type, content, content_format, page_state)
        connection.execute("DELETE FROM note_search WHERE note_id = ?", (note_id,))
        connection.execute(
            "INSERT INTO note_search (note_id, title, body) VALUES (?, ?, ?)",
            (note_id, title, body),
        )

    @classmethod
    def rebuild_derived_indexes(cls, connection: sqlite3.Connection) -> None:
        connection.execute("DELETE FROM note_search")
        notes = connection.execute(
            "SELECT id, title, note_type, content, content_format, page_state, secure FROM notes"
        ).fetchall()
        for note in notes:
            cls.index_note(
                connection,
                note["id"],
                note["title"],
                note["content"],
                note["note_type"],
                note["content_format"],
                note["page_state"],
                body="" if note["secure"] else None,  # a secure note is found by its title only
            )
        connection.commit()

    @classmethod
    def ensure_derived_indexes(cls, connection: sqlite3.Connection) -> None:
        note_ids = {row[0] for row in connection.execute("SELECT id FROM notes")}
        indexed_ids = {
            int(row[0]) for row in connection.execute("SELECT note_id FROM note_search")
        }
        if note_ids != indexed_ids:
            cls.rebuild_derived_indexes(connection)

    def notebook_exists(self, connection: sqlite3.Connection, notebook_id: int) -> bool:
        return connection.execute(
            "SELECT 1 FROM notebooks WHERE id = ?", (notebook_id,)
        ).fetchone() is not None

    def list_notebooks(self) -> list[dict]:
        with self.connection() as connection:
            rows = connection.execute(
                """
                                SELECT notebooks.id, notebooks.resource_id, notebooks.revision,
                                    notebooks.name, notebooks.color, notebooks.category,
                  COUNT(notes.id) AS note_count
                FROM notebooks
                LEFT JOIN notes ON notes.notebook_id = notebooks.id
                GROUP BY notebooks.id
                ORDER BY notebooks.updated_at DESC, notebooks.id ASC
                """
            ).fetchall()
        return [
            {
                "id": row["id"],
                "resourceId": row["resource_id"],
                "revision": row["revision"],
                "name": row["name"],
                "color": row["color"],
                "category": row["category"],
                "noteCount": row["note_count"],
            }
            for row in rows
        ]

    def create_notebook(self, payload: dict) -> dict:
        name = str(payload.get("name") or "Untitled notebook").strip()[:80]
        name = name or "Untitled notebook"
        requested_color = payload.get("color")
        color = requested_color if isinstance(requested_color, str) and NOTEBOOK_COLOR_PATTERN.fullmatch(requested_color) else DEFAULT_NOTEBOOK_COLOR
        category = self.notebook_category(payload.get("category"), DEFAULT_NOTEBOOK_CATEGORY)
        resource_id = self.new_resource_id()
        with self.connection() as connection:
            cursor = connection.execute(
                "INSERT INTO notebooks (resource_id, name, color, category) VALUES (?, ?, ?, ?)",
                (resource_id, name, color, category),
            )
            self.record_change(connection, "notebook", resource_id, 1, "created")
            connection.commit()
            notebook_id = cursor.lastrowid
        return {"id": notebook_id, "resourceId": resource_id, "revision": 1, "name": name, "color": color, "category": category, "noteCount": 0}

    @staticmethod
    def notebook_category(value, fallback: str) -> str:
        return value if isinstance(value, str) and value in NOTEBOOK_CATEGORIES else fallback

    def update_notebook(self, notebook_id: int, payload: dict) -> dict:
        with self.connection() as connection:
            current = connection.execute(
                "SELECT * FROM notebooks WHERE id = ?", (notebook_id,)
            ).fetchone()
            if current is None:
                raise NotFoundError("Notebook not found")
            expected_revision = self.expected_revision(payload, current["revision"])
            name = str(payload.get("name", current["name"])).strip()[:80] or current["name"]
            requested_color = payload.get("color")
            color = requested_color if isinstance(requested_color, str) and NOTEBOOK_COLOR_PATTERN.fullmatch(requested_color) else current["color"]
            category = self.notebook_category(payload.get("category"), current["category"])
            revision = expected_revision + 1
            cursor = connection.execute(
                "UPDATE notebooks SET name = ?, color = ?, category = ?, revision = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND revision = ?",
                (name, color, category, revision, notebook_id, expected_revision),
            )
            if cursor.rowcount == 0:
                raise ConflictError("Resource revision does not match")
            self.record_change(connection, "notebook", current["resource_id"], revision, "updated")
            connection.commit()
        return {"id": notebook_id, "resourceId": current["resource_id"], "revision": revision, "name": name, "color": color, "category": category}

    def delete_notebook(self, notebook_id: int) -> dict:
        with self.connection() as connection:
            notebook = connection.execute(
                "SELECT * FROM notebooks WHERE id = ?", (notebook_id,)
            ).fetchone()
            if notebook is None:
                raise NotFoundError("Notebook not found")
            # Its notes are not lost and not guessed into another notebook: they go back to the Inbox to be filed again.
            destination_id = None
            moved_notes = connection.execute(
                "SELECT id, resource_id, revision FROM notes WHERE notebook_id = ?",
                (notebook_id,),
            ).fetchall()
            for note in moved_notes:
                revision = note["revision"] + 1
                connection.execute(
                    "UPDATE notes SET notebook_id = ?, revision = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                    (destination_id, revision, note["id"]),
                )
                self.record_change(connection, "note", note["resource_id"], revision, "updated")
            connection.execute("DELETE FROM notebooks WHERE id = ?", (notebook_id,))
            self.record_change(
                connection,
                "notebook",
                notebook["resource_id"],
                notebook["revision"] + 1,
                "deleted",
            )
            connection.commit()
        return {
            "destinationNotebookId": destination_id,
            "movedNotes": [
                {"id": note["id"], "revision": note["revision"] + 1}
                for note in moved_notes
            ],
        }

    def list_notes(self) -> list[dict]:
        with self.connection() as connection:
            rows = connection.execute(
                "SELECT id, resource_id, revision, note_type, title, notebook_id, created_at, updated_at, secure FROM notes ORDER BY updated_at DESC, id DESC"
            ).fetchall()
        return [
            {
                "id": row["id"],
                "resourceId": row["resource_id"],
                "revision": row["revision"],
                "noteType": row["note_type"],
                "title": row["title"],
                "notebookId": row["notebook_id"],
                "createdAt": row["created_at"],
                "updatedAt": row["updated_at"],
                "secure": bool(row["secure"]),
            }
            for row in rows
        ]

    def get_note(self, note_id: int) -> dict:
        with self.connection() as connection:
            note = connection.execute(
                "SELECT * FROM notes WHERE id = ?", (note_id,)
            ).fetchone()
        if note is None:
            raise NotFoundError("Note not found")
        if not note["secure"]:
            return self.serialize_note(note)
        revealed = self.reveal_row(note)
        if revealed is None:
            # Locked: the title and the facts about the note, never its words.
            return {**self.serialize_note(note), "content": None, "pageState": None, "locked": True}
        return self.serialize_note(revealed)

    def create_note(self, payload: dict) -> dict:
        title = str(payload.get("title") or "Untitled note")[:180]
        requested_note_type = str(payload.get("noteType") or "canvas")
        note_type = requested_note_type if requested_note_type in NOTE_TYPES else "canvas"
        if note_type == "page":
            initial_text, content_format = json.dumps(empty_page_document(), separators=(",", ":")), FORMAT_PAGE
        elif note_type == "mindmap":
            initial_text, content_format = json.dumps(DEFAULT_MINDMAP_CONTENT, separators=(",", ":")), FORMAT_MINDMAP
        else:
            initial_text, content_format = empty_canvas_text(), FORMAT_CANVAS
        try:
            requested_notebook_id = int(payload.get("notebookId"))
        except (TypeError, ValueError):
            requested_notebook_id = None
        resource_id = self.new_resource_id()
        with self.connection() as connection:
            # No notebook asked for (or one that is gone): the note is unfiled and lands in the Inbox (notebook_id NULL).
            notebook_id = requested_notebook_id if requested_notebook_id is not None and self.notebook_exists(connection, requested_notebook_id) else None
            cursor = connection.execute(
                "INSERT INTO notes (resource_id, note_type, title, content, content_format, notebook_id) VALUES (?, ?, ?, ?, ?, ?)",
                (resource_id, note_type, title, initial_text, content_format, notebook_id),
            )
            note = connection.execute(
                "SELECT * FROM notes WHERE id = ?", (cursor.lastrowid,)
            ).fetchone()
            self.index_note(
                connection,
                note["id"],
                note["title"],
                note["content"],
                note["note_type"],
                note["content_format"],
            )
            self.record_change(connection, "note", resource_id, 1, "created")
            connection.commit()
        return self.serialize_note(note)

    def update_note(self, note_id: int, payload: dict) -> dict:
        title = str(payload.get("title") or "Untitled note")[:180]
        page_state = json.dumps(payload.get("pageState") or DEFAULT_PAGE_STATE, separators=(",", ":"))
        with self.connection() as connection:
            current = connection.execute(
                "SELECT * FROM notes WHERE id = ?", (note_id,)
            ).fetchone()
            if current is None:
                raise NotFoundError("Note not found")
            data_key = None
            if current["secure"]:
                data_key = self.keyring.get(current["secure_key_id"])
                if data_key is None:
                    raise SecureLockedError("This note is locked. Unlock secure notes to change it.")
                if payload.get("content") is None:
                    # A client that saved the locked view must not wipe the words.
                    raise SecureSetupError("A secure note can only be saved with its words")
            expected_revision = self.expected_revision(payload, current["revision"])
            note_type = current["note_type"]
            body = None
            if note_type == "page":
                content_format = FORMAT_PAGE
                content = json.dumps(normalize_page_document(payload.get("content")), separators=(",", ":"))
            elif note_type == "mindmap":
                content_format = FORMAT_MINDMAP
                document = self.normalize_mindmap_document(payload.get("content") or DEFAULT_MINDMAP_CONTENT)
                content = json.dumps(document, separators=(",", ":"))
            else:
                # Either format comes in (the app sends JSON Canvas; older scripts send Fabric JSON); JSON Canvas is stored.
                content_format = FORMAT_CANVAS
                document, content, saved_page, body = self.prepare_canvas(
                    payload.get("content") or DEFAULT_CONTENT, payload.get("pageState"), self.reserved_block_ids(connection, note_id)
                )
                page_state = json.dumps(saved_page, separators=(",", ":"))
            revision = expected_revision + 1
            stored_content, stored_page_state, sealed = content, page_state, None
            if data_key is not None:
                # A secure note keeps its words only sealed; the plain columns hold an empty placeholder and search sees the title only.
                sealed = sc.seal(data_key, current["secure_key_id"], current["seal_id"] or "", {"content": content, "page_state": page_state, "content_format": content_format})
                stored_content, stored_page_state, body = self.placeholder_content(note_type), json.dumps(DEFAULT_PAGE_STATE), ""
            cursor = connection.execute(
                """
                UPDATE notes
                SET title = ?, content = ?, content_format = ?, page_state = ?, sealed = ?, revision = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ? AND revision = ?
                """,
                (title, stored_content, content_format, stored_page_state, sealed, revision, note_id, expected_revision),
            )
            if cursor.rowcount == 0:
                raise ConflictError("Resource revision does not match")
            try:
                notebook_id = int(payload.get("notebookId"))
            except (TypeError, ValueError):
                notebook_id = 0
            if self.notebook_exists(connection, notebook_id):
                connection.execute(
                    "UPDATE notes SET notebook_id = ? WHERE id = ?",
                    (notebook_id, note_id),
                )
            self.index_note(connection, note_id, title, stored_content, note_type, content_format, body=body)
            self.record_change(connection, "note", current["resource_id"], revision, "updated")
            connection.commit()
        return {"ok": True, "resourceId": current["resource_id"], "revision": revision}

    @staticmethod
    def object_bottom(item: dict) -> float:
        def number(key: str, default: float = 0.0) -> float:
            try:
                return float(item.get(key) if item.get(key) is not None else default)
            except (TypeError, ValueError):
                return default

        # Fabric 7 objects default to a centre origin, so `top` may be the middle of the object.
        below_top = {"top": 1.0, "center": 0.5, "bottom": 0.0}.get(item.get("originY"), 0.5)
        top = number("top")
        height = number("height", -1.0)
        if height < 0:
            text = item.get("text")
            if isinstance(text, str):
                size = number("fontSize", APPEND_FONT_SIZE)
                height = (text.count("\n") + 1) * size * number("lineHeight", APPEND_LINE_HEIGHT)
            else:
                height = 40.0
        else:
            height *= abs(number("scaleY", 1.0))
        return top + height * below_top

    @staticmethod
    def estimate_text_height(text: str, width: float) -> float:
        characters_per_line = max(1, int(width / (APPEND_FONT_SIZE * 0.5)))
        lines = sum(max(1, -(-len(line) // characters_per_line)) for line in text.split("\n"))
        return lines * APPEND_FONT_SIZE * APPEND_LINE_HEIGHT + APPEND_PADDING * 2

    def write_page(self, note_id: int, markdown: str, revision: int | None = None) -> dict:
        """Replace a page note's Markdown (an agent's rewrite). Marks and linked drawings find their words again; none are dropped."""
        self.refuse_agent_on_secure(note_id)
        if len(markdown) > APPEND_MAX_LENGTH * 10:
            raise AppendTextError("Text is too long")
        note = self.get_note(note_id)
        if note["noteType"] != "page":
            raise UnsupportedNoteTypeError("Only page notes can be rewritten as Markdown")
        document = note["content"]
        if markdown != document["markdown"]:
            document = {**document, "markdown": markdown, "ink": reanchor_ink(document["ink"], markdown)}
        expected = note["revision"] if revision is None else revision
        return self.update_note(note_id, {"title": note["title"], "content": document, "revision": expected, "notebookId": note["notebookId"]})

    def write_canvas_text(self, note_id: int, markdown: str, object_id: str | None = None, revision: int | None = None) -> dict:
        """Replace the Markdown of a canvas note's text (an agent's rewrite, F-052): the one named, else the first Markdown text in
        reading order; a note without one gets one, as append does. The text's marks and the objects linked to its words find those words
        again; a mark whose words are gone is kept as ink beside the text, and a linked object whose words are gone is unlinked and shown.
        """
        self.refuse_agent_on_secure(note_id)
        if len(markdown) > APPEND_MAX_LENGTH * 10:
            raise AppendTextError("Text is too long")
        note = self.get_note(note_id)
        if note["noteType"] != "canvas":
            raise UnsupportedNoteTypeError("Only canvas notes have Markdown texts to write")
        document = self.document_of(note["content"], note["contentFormat"], note["pageState"])
        texts = [item for item in document["objects"] if isinstance(item, dict) and item.get("type") == "text" and item.get("format") == "markdown"]
        if object_id is not None:
            texts = [item for item in texts if item.get("id") == object_id]
            if not texts:
                raise NotFoundError(f"No Markdown text {object_id} in note {note_id}")
        if not texts:
            return self.append_text(note_id, markdown, revision=revision)
        target = min(texts, key=lambda item: (item["geometry"].get("y", 0), item["geometry"].get("x", 0)))
        expected = note["revision"] if revision is None else revision
        if markdown != target.get("content"):
            self._reanchor_canvas_text(document, target, markdown)
            # The new words' height, as append measures it (the app measures them again when it draws them), and pages for them.
            geometry = target["geometry"]
            geometry["height"] = round(self.estimate_text_height(markdown, geometry.get("width") or PAGE_WIDTH - 2 * APPEND_LEFT), 2)
            self.normalize_page(document)
            document["page"]["rows"] = max(document["page"]["rows"], -(-int(geometry.get("y", 0) + geometry["height"] + APPEND_LEFT) // PAGE_HEIGHT))
        return self.update_note(note_id, {"title": note["title"], "notebookId": note["notebookId"], "revision": expected, "content": to_json_canvas(document, media=self.media)})

    def _reanchor_canvas_text(self, document: dict, target: dict, markdown: str) -> None:
        g = target["geometry"]
        marks = []
        for mark in target.get("marks") or []:
            anchor = mark.get("anchor") if isinstance(mark.get("anchor"), dict) else None
            found = self._find_words(markdown, anchor)
            if found is None:  # its words are gone: the stroke stays on the canvas as ordinary ink, where it was last drawn
                if anchor:
                    document["objects"].append(self._loose_ink(mark, g, len(document["objects"])))
                continue
            start = utf16(markdown[:found])
            marks.append({**mark, "anchor": {**anchor, "pos": start, "end": start + utf16(anchor["quote"]["exact"])}})
        target["marks"] = marks
        target["content"] = markdown
        for item in document["objects"]:
            link = item.get("link") if isinstance(item, dict) and isinstance(item.get("link"), dict) else None
            if not link or link.get("textId") != target.get("id"):
                continue
            found = self._find_words(markdown, link)
            if found is None:
                item["link"] = None
                item["folded"] = False
            else:
                start = utf16(markdown[:found])
                item["link"] = {**link, "pos": start, "end": start + utf16(link["quote"]["exact"])}

    @staticmethod
    def _find_words(markdown: str, anchor: dict | None) -> int | None:
        """Where an anchor's words are in the new Markdown (a code-point index), found by their quote. A one-letter word ("I", "a"),
        which a quote alone can't find safely, is found when enough of its context still surrounds it."""
        quote = (anchor or {}).get("quote") or {}
        exact = quote.get("exact")
        if not isinstance(exact, str) or not exact.strip():
            return None
        if len(exact.strip()) >= 2:
            return find_quote(markdown, quote)
        prefix, suffix = quote.get("prefix") or "", quote.get("suffix") or ""
        best, best_score = None, 2  # at least three characters of context must agree
        at = markdown.find(exact)
        while at != -1:
            end = at + len(exact)
            before = markdown[at - 1] if at > 0 else " "
            after = markdown[end] if end < len(markdown) else " "
            if not (before.isalnum() or before in "_'") and not (after.isalnum() or after in "_'"):
                left = 0
                while left < len(prefix) and at - 1 - left >= 0 and markdown[at - 1 - left] == prefix[len(prefix) - 1 - left]:
                    left += 1
                right = 0
                while right < len(suffix) and end + right < len(markdown) and markdown[end + right] == suffix[right]:
                    right += 1
                if left + right > best_score:
                    best, best_score = at, left + right
            at = markdown.find(exact, at + 1)
        return best

    def _loose_ink(self, mark: dict, text_geometry: dict, z: int) -> dict:
        """A mark whose words are gone, as an ordinary ink object where the mark was last drawn: its box from its path (or its dot)."""
        at = mark.get("at") if isinstance(mark.get("at"), dict) else {"x": mark["anchor"].get("dx", 0), "y": mark["anchor"].get("dy", 0)}
        if mark.get("kind") == "dot":
            size = {"width": 2 * float(mark.get("radius") or 1), "height": 2 * float(mark.get("radius") or 1)}
        else:
            numbers = [value for command in mark.get("path") or [] for value in command[1:] if isinstance(value, (int, float))]
            xs, ys = numbers[0::2] or [0], numbers[1::2] or [0]
            size = {"width": max(xs) - min(0, min(xs)), "height": max(ys) - min(0, min(ys))}
        identity = {"rotation": 0, "scaleX": 1, "scaleY": 1, "flipX": False, "flipY": False, "skewX": 0, "skewY": 0}
        return {
            **{key: value for key, value in mark.items() if key not in ("anchor", "id", "at")},
            "id": self.new_resource_id(), "type": "ink", "z": z,
            "geometry": {**identity, "x": text_geometry.get("x", 0) + at["x"], "y": text_geometry.get("y", 0) + at["y"], **size},
            "opacity": 1, "visible": True, "strokeUniform": False, "blend": "source-over", "extras": {},
        }

    def append_text(self, note_id: int, text: str, revision: int | None = None) -> dict:
        """Add a text block below a canvas note's content, growing pages as needed.

        Existing objects are never rewritten. The write goes through update_note,
        so a stale revision raises ConflictError and leaves the note unchanged.
        """
        self.refuse_agent_on_secure(note_id)
        text = str(text).strip("\n")
        if not text.strip():
            raise AppendTextError("Text to append is empty")
        if len(text) > APPEND_MAX_LENGTH:
            raise AppendTextError("Text to append is too long")
        note = self.get_note(note_id)
        if note["noteType"] == "page":
            # A new paragraph at the end of the Markdown; every mark and drawing keeps its position because nothing before it moved.
            document = note["content"]
            markdown = document["markdown"].rstrip("\n")
            document["markdown"] = f"{markdown}\n\n{text}" if markdown else text
            expected = note["revision"] if revision is None else revision
            return self.update_note(note_id, {"title": note["title"], "content": document, "revision": expected, "notebookId": note["notebookId"]})
        if note["noteType"] != "canvas":
            raise UnsupportedNoteTypeError("Text can only be appended to canvas and page notes")
        document = self.document_of(note["content"], note["contentFormat"], note["pageState"])
        objects = [item for item in document["objects"] if isinstance(item, dict)]
        width = PAGE_WIDTH - 2 * APPEND_LEFT
        top = (
            max(self.doc_object_bottom(item) for item in objects) + APPEND_GAP
            if objects
            else APPEND_TOP
        )
        bottom = top + self.estimate_text_height(text, width)
        self.normalize_page(document)
        page = document["page"]
        page["rows"] = max(page["rows"], -(-int(bottom + APPEND_LEFT) // PAGE_HEIGHT))
        # A text node (Markdown) with no stored height: whatever shows the note measures it, as it did for the old Textbox.
        document["objects"].append(
            {
                "id": self.new_resource_id(),
                "type": "text",
                "format": "markdown",  # F-048: canvas text is Markdown (ADR 0004)
                "z": len(document["objects"]),
                "mode": "box",
                "geometry": {
                    "x": APPEND_LEFT, "y": round(top, 2), "width": width, "rotation": 0, "scaleX": 1, "scaleY": 1,
                    "flipX": False, "flipY": False, "skewX": 0, "skewY": 0,
                },
                "content": text,
                "style": {
                    "fontFamily": "Source Serif 4", "fontSize": APPEND_FONT_SIZE, "lineHeight": APPEND_LINE_HEIGHT,
                    "padding": APPEND_PADDING, "color": "#20201e",
                },
                "extras": {},
            }
        )
        return self.update_note(
            note_id,
            {
                "title": note["title"],
                "notebookId": note["notebookId"],
                "revision": note["revision"] if revision is None else revision,
                "content": to_json_canvas(document, media=self.media),
            },
        )

    @staticmethod
    def doc_object_bottom(item: dict) -> float:
        """Bottom edge of a document object, ignoring rotation (as the old Fabric-level rule did)."""
        if item.get("type") == "unknown":
            raw = item.get("raw")
            return NoteService.object_bottom(raw) if isinstance(raw, dict) else 0.0
        geometry = item.get("geometry") or {}
        top = float(geometry.get("y") or 0)
        if geometry.get("height") is not None:
            height = float(geometry["height"])
            return top + height / 2 + height * abs(float(geometry.get("scaleY", 1.0))) / 2
        if item.get("type") in ("text", "sticky"):
            return top + estimate_text_box(item)["height"]
        return top + 40.0

    def move_note(self, note_id: int, payload: dict) -> dict:
        """File a note into a notebook, or back to the Inbox with an explicit `"notebookId": null`."""
        if "notebookId" in payload and payload["notebookId"] is None:
            notebook_id = None
        else:
            try:
                notebook_id = int(payload.get("notebookId"))
            except (TypeError, ValueError):
                raise NotFoundError("Notebook not found") from None
        with self.connection() as connection:
            if notebook_id is not None and not self.notebook_exists(connection, notebook_id):
                raise NotFoundError("Notebook not found")
            current = connection.execute(
                "SELECT * FROM notes WHERE id = ?", (note_id,)
            ).fetchone()
            if current is None:
                raise NotFoundError("Note not found")
            expected_revision = self.expected_revision(payload, current["revision"])
            revision = expected_revision + 1
            cursor = connection.execute(
                "UPDATE notes SET notebook_id = ?, revision = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND revision = ?",
                (notebook_id, revision, note_id, expected_revision),
            )
            if cursor.rowcount == 0:
                raise ConflictError("Resource revision does not match")
            self.record_change(connection, "note", current["resource_id"], revision, "updated")
            connection.commit()
        return {"ok": True, "resourceId": current["resource_id"], "revision": revision}

    def delete_note(self, note_id: int) -> None:
        with self.connection() as connection:
            note = connection.execute(
                "SELECT resource_id, revision FROM notes WHERE id = ?", (note_id,)
            ).fetchone()
            if note is None:
                raise NotFoundError("Note not found")
            connection.execute("DELETE FROM note_search WHERE note_id = ?", (note_id,))
            cursor = connection.execute("DELETE FROM notes WHERE id = ?", (note_id,))
            if cursor.rowcount == 0:
                raise NotFoundError("Note not found")
            self.record_change(
                connection, "note", note["resource_id"], note["revision"] + 1, "deleted"
            )
            connection.commit()

    # ---- secure notes (F-057, ADR 0005) ----------------------------------------------------------------------------------

    @staticmethod
    def placeholder_content(note_type: str) -> str:
        """What a secure note's plain `content` column holds: an empty document of its type (the words are only in `sealed`)."""
        if note_type == "page":
            return json.dumps(empty_page_document(), separators=(",", ":"))
        if note_type == "mindmap":
            return json.dumps(DEFAULT_MINDMAP_CONTENT, separators=(",", ":"))
        return empty_canvas_text()

    def reveal_row(self, row) -> dict | None:
        """A secure note's row with its words put back, or None while its key is not held (locked)."""
        data_key = self.keyring.get(row["secure_key_id"])
        if data_key is None:
            return None
        try:
            payload = sc.unseal(data_key, row["secure_key_id"], row["seal_id"] or "", row["sealed"])
        except sc.DecryptError as error:
            logger.error("event=secure.open outcome=failed note_id=%s", row["id"])
            raise SecureAuthError(str(error)) from error
        content, page_state = payload.get("content"), payload.get("page_state")
        if not isinstance(content, str) or not isinstance(page_state, str):
            raise SecureAuthError("This secure note could not be read")
        revealed = dict(row)
        revealed.update(content=content, page_state=page_state, content_format=payload.get("content_format") or row["content_format"])
        return revealed

    def refuse_agent_on_secure(self, note_id: int) -> None:
        """The agent writes (append, rewrite) never touch a secure note, locked or not."""
        with self.connection() as connection:
            row = connection.execute("SELECT secure FROM notes WHERE id = ?", (note_id,)).fetchone()
        if row is not None and row["secure"]:
            raise SecureNoteAgentError("This is a secure note: agents cannot read or write it")

    def secure_status(self) -> dict:
        with self.connection() as connection:
            configured = connection.execute("SELECT COUNT(*) FROM secure_keys").fetchone()[0] > 0
            count = connection.execute("SELECT COUNT(*) FROM notes WHERE secure = 1").fetchone()[0]
        return {
            "backend": self.secure_platform.backend(),
            "configured": configured,
            "unlocked": self.keyring.is_unlocked,
            "secureNotes": count,
        }

    def lock_secure(self) -> dict:
        """Forget every key held in memory (and the Touch ID yes); secure notes read as locked again."""
        self.keyring.lock()
        forget = getattr(self.secure_platform, "forget_authentication", None)
        if forget is not None:
            forget()
        return self.secure_status()

    def _device_wrapping_key(self, reason: str, passphrase, salt: bytes | None = None, params: dict | None = None) -> tuple[str, bytes]:
        """The key that wraps the data key on this computer: (kind, key). A Mac asks for Touch ID first; elsewhere a passphrase is used."""
        if self.secure_platform.available():
            if not self.secure_platform.authenticate(reason):
                raise SecureAuthError("Touch ID was not accepted")
            try:
                return "keychain", sc.keychain_wrapping_key(self.secure_platform.key_get_or_create())
            except (default_secure_platform.NotAuthenticated, default_secure_platform.Unavailable, OSError, sc.DecryptError) as error:
                logger.warning("event=secure.keychain outcome=failed error_class=%s", type(error).__name__)
                raise SecureAuthError("The keychain key could not be read") from error
        if not isinstance(passphrase, str) or not passphrase:
            raise SecureSetupError("Type the passphrase for secure notes")
        return "passphrase", b""

    def _primary_key(self, connection: sqlite3.Connection, passphrase) -> tuple[str, bytes, str | None]:
        """(key id, data key, recovery key or None) for sealing a note; makes the keys the first time."""
        primary = connection.execute("SELECT key_id FROM secure_keys WHERE is_primary = 1 ORDER BY id LIMIT 1").fetchone()
        if primary is not None:
            if passphrase is not None:
                raise SecureSetupError("A passphrase is only used when the first secure note is made; use add passphrase to add one")
            data_key = self.keyring.get(primary["key_id"])
            if data_key is None:
                raise SecureLockedError("Secure notes are locked. Unlock them first.")
            return primary["key_id"], data_key, None
        # First secure note on this computer: a new data key, wrapped by this computer's key and by a one-time recovery key.
        if self.secure_platform.available():
            if passphrase is not None:
                raise SecureSetupError("This Mac uses Touch ID, not a passphrase")
        else:
            try:
                sc.check_passphrase(passphrase)
            except ValueError as error:
                raise SecureSetupError(str(error)) from None
        kind, device_key = self._device_wrapping_key("Personal Note is making your first secure note", passphrase)
        key_id, data_key = sc.new_key_id(), sc.new_data_key()
        salt, params = None, None
        if kind == "passphrase":
            salt_bytes, params = sc.new_salt(), sc.new_scrypt_params(self.scrypt_cost)
            device_key = sc.passphrase_wrapping_key(passphrase, salt_bytes, params)
            salt = sc.b64(salt_bytes)
        recovery_key = sc.new_recovery_key()
        recovery_salt = sc.new_salt()
        rows = [
            (key_id, kind, sc.WRAP_VERSION, salt, json.dumps(params) if params else None, sc.wrap(device_key, key_id, kind, data_key)),
            (
                key_id, "recovery", sc.WRAP_VERSION, sc.b64(recovery_salt), None,
                sc.wrap(sc.recovery_wrapping_key(recovery_key, recovery_salt), key_id, "recovery", data_key),
            ),
        ]
        for row in rows:
            connection.execute(
                "INSERT INTO secure_keys (key_id, kind, version, salt, params, wrapped, is_primary) VALUES (?, ?, ?, ?, ?, ?, 1)", row
            )
        return key_id, data_key, recovery_key

    def mark_secure(self, note_id: int, revision: int | None = None, passphrase: str | None = None) -> dict:
        """Make a whole note secure: its words are sealed (AES-256-GCM) and leave the plain columns and the search index.

        Returns {ok, resourceId, revision}, plus `recoveryKey` exactly once: when the first secure note creates the keys.
        Needs the secure notes unlocked when keys already exist; on a Mac the first one asks for Touch ID, elsewhere for a passphrase.
        """
        recovery_key = None
        with self.connection() as connection:
            current = connection.execute("SELECT * FROM notes WHERE id = ?", (note_id,)).fetchone()
            if current is None:
                raise NotFoundError("Note not found")
            if current["secure"]:
                return {"ok": True, "resourceId": current["resource_id"], "revision": current["revision"]}
            expected = self.expected_revision({} if revision is None else {"revision": revision}, current["revision"])
            key_id, data_key, recovery_key = self._primary_key(connection, passphrase)
            seal_id = sc.new_seal_id()
            sealed = sc.seal(
                data_key, key_id, seal_id,
                {"content": current["content"], "page_state": current["page_state"], "content_format": current["content_format"]},
            )
            new_revision = expected + 1
            cursor = connection.execute(
                """
                UPDATE notes SET secure = 1, secure_key_id = ?, seal_id = ?, sealed = ?, content = ?, page_state = ?, revision = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ? AND revision = ?
                """,
                (key_id, seal_id, sealed, self.placeholder_content(current["note_type"]), json.dumps(DEFAULT_PAGE_STATE), new_revision, note_id, expected),
            )
            if cursor.rowcount == 0:
                raise ConflictError("Resource revision does not match")
            self.index_note(connection, note_id, current["title"], "", current["note_type"], current["content_format"], body="")
            self.record_change(connection, "note", current["resource_id"], new_revision, "updated")
            connection.commit()
        self.keyring.unlock(key_id, data_key)
        self.scrub_old_words()
        result = {"ok": True, "resourceId": current["resource_id"], "revision": new_revision}
        if recovery_key is not None:
            result["recoveryKey"] = recovery_key
        return result

    def scrub_old_words(self) -> None:
        """Remove what the plain note left behind in the file: old search entries, freed pages and the write-ahead log."""
        try:
            with self.connection() as connection:
                connection.execute("INSERT INTO note_search(note_search) VALUES ('optimize')")
                connection.commit()
                connection.execute("VACUUM")
                connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        except sqlite3.Error:
            logger.exception("event=secure.scrub outcome=failed")

    def unmark_secure(self, note_id: int, revision: int | None = None) -> dict:
        """Take a note out of secure: its words go back to the plain columns and the search index. Needs the note unlocked."""
        with self.connection() as connection:
            current = connection.execute("SELECT * FROM notes WHERE id = ?", (note_id,)).fetchone()
            if current is None:
                raise NotFoundError("Note not found")
            if not current["secure"]:
                return {"ok": True, "resourceId": current["resource_id"], "revision": current["revision"]}
            revealed = self.reveal_row(current)
            if revealed is None:
                raise SecureLockedError("This note is locked. Unlock secure notes to change it.")
            expected = self.expected_revision({} if revision is None else {"revision": revision}, current["revision"])
            new_revision = expected + 1
            cursor = connection.execute(
                """
                UPDATE notes SET secure = 0, secure_key_id = NULL, seal_id = NULL, sealed = NULL, content = ?, page_state = ?, content_format = ?,
                    revision = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ? AND revision = ?
                """,
                (revealed["content"], revealed["page_state"], revealed["content_format"], new_revision, note_id, expected),
            )
            if cursor.rowcount == 0:
                raise ConflictError("Resource revision does not match")
            self.index_note(connection, note_id, current["title"], revealed["content"], current["note_type"], revealed["content_format"], revealed["page_state"])
            self.record_change(connection, "note", current["resource_id"], new_revision, "updated")
            connection.commit()
        return {"ok": True, "resourceId": current["resource_id"], "revision": new_revision}

    def unlock_secure(self, passphrase: str | None = None, recovery_key: str | None = None) -> dict:
        """Hold the data keys in memory. A recovery key if given; else Touch ID on a Mac, or the passphrase elsewhere.

        After a recovery-key unlock this computer's own wrap is added (Touch ID + keychain on a Mac; on Linux the `passphrase` given
        with the recovery key), so the next unlock does not need the recovery key. `deviceWrapAdded` says whether that happened.
        A stored row that cannot be used is skipped, never fatal.
        """
        with self.connection() as connection:
            rows = connection.execute("SELECT * FROM secure_keys ORDER BY id").fetchall()
        if not rows:
            raise SecureSetupError("There are no secure notes yet")
        opened: set[str] = set()
        if recovery_key is not None:
            try:
                sc.normalize_recovery_key(recovery_key)
            except ValueError as error:
                raise SecureAuthError(str(error)) from None
            if passphrase is not None and not self.secure_platform.available():
                try:
                    sc.check_passphrase(passphrase)
                except ValueError as error:
                    raise SecureSetupError(str(error)) from None
            for row in rows:
                if row["kind"] == "recovery":
                    opened |= self._try_row(row, lambda r: sc.recovery_wrapping_key(recovery_key, sc.unb64(r["salt"])))
        elif self.secure_platform.available():
            _kind, device_key = self._device_wrapping_key("Personal Note is unlocking your secure notes", None)
            for row in rows:
                if row["kind"] == "keychain":
                    opened |= self._try_row(row, lambda r: device_key)
        else:
            if not isinstance(passphrase, str) or not passphrase:
                raise SecureSetupError("Type the passphrase for secure notes")
            for row in rows:
                if row["kind"] == "passphrase":
                    opened |= self._try_row(row, lambda r: sc.passphrase_wrapping_key(passphrase, sc.unb64(r["salt"]), json.loads(r["params"])))
        if not opened:
            raise SecureAuthError("That did not open the secure notes" if recovery_key is None else "That recovery key does not open these notes")
        added = recovery_key is not None and self._add_device_wraps(sorted(opened), passphrase)
        return {**self.secure_status(), "deviceWrapAdded": added}

    def add_passphrase(self, passphrase: str) -> dict:
        """Linux: add (or re-add) this computer's passphrase wrap for the data keys that are unlocked now."""
        if self.secure_platform.available():
            raise SecureSetupError("This Mac uses Touch ID, not a passphrase")
        try:
            sc.check_passphrase(passphrase)
        except ValueError as error:
            raise SecureSetupError(str(error)) from None
        key_ids = self.keyring.unlocked_ids()
        if not key_ids:
            raise SecureLockedError("Unlock secure notes first")
        return {**self.secure_status(), "deviceWrapAdded": self._add_device_wraps(key_ids, passphrase)}

    def _add_device_wraps(self, key_ids: list[str], passphrase) -> bool:
        """Wrap the unlocked data keys for this computer, unless a wrap of this computer's already opens them. True when one was added."""
        if self.secure_platform.available():
            kind = "keychain"
            try:
                _kind, device_key = self._device_wrapping_key("Personal Note is adding this Mac to your secure notes", None)
            except SecureAuthError:
                return False
            salt_text, params, new_key = None, None, device_key
        else:
            kind = "passphrase"
            if not isinstance(passphrase, str):
                return False
            salt_bytes, params = sc.new_salt(), sc.new_scrypt_params(self.scrypt_cost)
            salt_text, new_key = sc.b64(salt_bytes), sc.passphrase_wrapping_key(passphrase, salt_bytes, params)
        added = False
        with self.connection() as connection:
            for key_id in key_ids:
                data_key = self.keyring.get(key_id)
                rows = connection.execute("SELECT * FROM secure_keys WHERE key_id = ?", (key_id,)).fetchall()
                if data_key is None:
                    continue
                for row in rows:
                    if row["kind"] != kind:
                        continue
                    try:
                        if kind == "keychain":
                            existing = device_key
                        else:
                            existing = sc.passphrase_wrapping_key(passphrase, sc.unb64(row["salt"]), json.loads(row["params"]))
                        sc.unwrap(existing, key_id, kind, row["wrapped"], row["version"])
                        break
                    except Exception:
                        continue
                else:
                    connection.execute(
                        "INSERT INTO secure_keys (key_id, kind, version, salt, params, wrapped, is_primary) VALUES (?, ?, ?, ?, ?, ?, ?)",
                        (
                            key_id, kind, sc.WRAP_VERSION, salt_text, json.dumps(params) if params else None,
                            sc.wrap(new_key, key_id, kind, data_key), 1 if any(row["is_primary"] for row in rows) else 0,
                        ),
                    )
                    added = True
            connection.commit()
        return added

    def _try_row(self, row, derive) -> set[str]:
        """Try one stored wrapped key; a row that is damaged or does not open is skipped (logged), never fatal."""
        try:
            data_key = sc.unwrap(derive(row), row["key_id"], row["kind"], row["wrapped"], row["version"])
        except sc.DecryptError:
            return set()
        except Exception:
            logger.warning("event=secure.unlock outcome=row_skipped kind=%s", row["kind"])
            return set()
        self.keyring.unlock(row["key_id"], data_key)
        return {row["key_id"]}

    def secure_key_rows(self, connection: sqlite3.Connection) -> list[dict]:
        """The wrapped keys, for a backup (never a data key, passphrase or recovery key)."""
        return [
            {
                "keyId": row["key_id"], "kind": row["kind"], "version": row["version"], "salt": row["salt"],
                "params": self.parse_json(row["params"], None), "wrapped": row["wrapped"], "primary": bool(row["is_primary"]),
            }
            for row in connection.execute("SELECT * FROM secure_keys ORDER BY id").fetchall()
        ]

    @staticmethod
    def check_secure_import(snapshot: dict, notes: list, local_key_ids: set[str]) -> list[dict]:
        """Validate a backup's secure keys and secure notes before anything is written; returns the key rows."""
        keys = snapshot.get("secureKeys", [])
        if not isinstance(keys, list):
            raise WorkspaceImportError("Backup secure keys must be a list")
        for key in keys:
            if (
                not isinstance(key, dict) or not isinstance(key.get("keyId"), str) or not key["keyId"] or len(key["keyId"]) > 64
                or key.get("kind") not in ("keychain", "passphrase", "recovery") or not isinstance(key.get("version"), int)
                or isinstance(key.get("version"), bool) or not isinstance(key.get("wrapped"), str)
                or not (key.get("salt") is None or isinstance(key.get("salt"), str))
                or not (key.get("params") is None or isinstance(key.get("params"), dict))
            ):
                raise WorkspaceImportError("A secure key in the backup cannot be read")
            try:
                sc.unb64(key["wrapped"])
                if key["kind"] != "keychain":
                    if not key.get("salt"):
                        raise ValueError("salt")
                    sc.unb64(key["salt"])
                if key["kind"] == "passphrase":
                    sc.valid_scrypt_params(key.get("params"))
            except Exception:
                raise WorkspaceImportError("A secure key in the backup cannot be read") from None
        known = local_key_ids | {key["keyId"] for key in keys}
        for note in notes:
            if not note.get("secure"):
                continue
            key_id = note.get("keyId")
            seal_id = note.get("sealId")
            if (
                not sc.is_sealed_text(note.get("sealed")) or not isinstance(key_id, str) or key_id not in known
                or not isinstance(seal_id, str) or not seal_id or len(seal_id) > 64
            ):
                raise WorkspaceImportError("A secure note in the backup cannot be read")
        return keys

    def workspace_snapshot(self) -> dict:
        """Return canonical notebook and note data without local database IDs."""
        with self.connection() as connection:
            workspace = connection.execute(
                "SELECT workspace_id FROM workspace_state WHERE id = 1"
            ).fetchone()
            notebooks = connection.execute(
                "SELECT resource_id, name, color, category, created_at, updated_at FROM notebooks ORDER BY id"
            ).fetchall()
            notes = connection.execute(
                "SELECT resource_id, note_type, title, content, content_format, page_state, notebook_id, created_at, updated_at, secure, secure_key_id, seal_id, sealed FROM notes ORDER BY id"
            ).fetchall()
            secure_keys = self.secure_key_rows(connection)
            notebook_resources = {
                row["id"]: row["resource_id"]
                for row in connection.execute("SELECT id, resource_id FROM notebooks")
            }
        return {
            "workspaceId": workspace["workspace_id"],
            "secureKeys": secure_keys,
            "notebooks": [
                {
                    "resourceId": row["resource_id"],
                    "name": row["name"],
                    "color": row["color"],
                    "category": row["category"],
                    "createdAt": row["created_at"],
                    "updatedAt": row["updated_at"],
                }
                for row in notebooks
            ],
            "notes": [self.snapshot_note(row, notebook_resources) for row in notes],
        }

    def snapshot_note(self, row, notebook_resources: dict) -> dict:
        note = {
            "resourceId": row["resource_id"],
            "notebookResourceId": notebook_resources.get(row["notebook_id"]),  # None = Inbox
            "noteType": row["note_type"],
            "title": row["title"],
            "contentFormat": self.format_of(row),
            "createdAt": row["created_at"],
            "updatedAt": row["updated_at"],
        }
        if row["secure"]:
            # Ciphertext only, whether or not the note is unlocked right now; the wrapped keys travel in `secureKeys`.
            return {**note, "content": {}, "pageState": dict(DEFAULT_PAGE_STATE), "secure": True, "keyId": row["secure_key_id"], "sealId": row["seal_id"], "sealed": row["sealed"]}
        return {
            **note,
            "content": self.snapshot_content(row),
            "pageState": self.parse_json(row["page_state"], DEFAULT_PAGE_STATE),
        }

    def snapshot_content(self, row) -> dict:
        """A note's content for a backup or export: canvases as self-contained JSON Canvas (pictures and SVGs inline as data URLs)."""
        if row["note_type"] == "page":
            return page_document_of(row["content"])
        content = self.parse_json(row["content"], DEFAULT_CONTENT)
        if row["note_type"] == "mindmap":
            return content
        try:
            document = self.document_of(content, self.format_of(row), self.parse_json(row["page_state"], None))
        except InvalidNoteContentError:
            return content
        for obj in document["objects"]:
            self.inline_media(obj)
        return to_json_canvas(document)

    def export_rows(self) -> list[dict]:
        """Every note with its notebook's name and its stored content as is (media still referenced by path), for vault export."""
        with self.connection() as connection:
            rows = connection.execute(
                """
                SELECT notes.id, notes.note_type, notes.title, notes.content, notes.content_format, notes.page_state, notes.secure, notebooks.name AS notebook_name
                FROM notes LEFT JOIN notebooks ON notebooks.id = notes.notebook_id ORDER BY notes.id
                """
            ).fetchall()
        return [
            {
                "id": row["id"],
                "noteType": row["note_type"],
                "title": row["title"],
                "notebookName": row["notebook_name"] or INBOX_NAME,
                "content": self.parse_json(row["content"], DEFAULT_CONTENT),
                "contentFormat": self.format_of(row),
                "pageState": self.parse_json(row["page_state"], DEFAULT_PAGE_STATE),
                "secure": bool(row["secure"]),
            }
            for row in rows
        ]

    def inline_media(self, obj: dict) -> None:
        if obj.get("type") == "image" and obj["mediaRef"]["kind"] == "media":
            media_id = obj["mediaRef"]["id"]
            data = self.media.read(media_id)
            if data is not None:
                obj["mediaRef"] = {"kind": "inline", "dataUrl": data_url_of(data, media_id.rsplit(".", 1)[1])}
        if obj.get("type") == "group":
            for child in obj["children"]:
                self.inline_media(child)

    def import_workspace_snapshot(self, snapshot: dict) -> dict:
        """Merge a validated backup into the workspace without overwriting data."""
        notebooks = snapshot.get("notebooks")
        notes = snapshot.get("notes")
        if not isinstance(notebooks, list) or not isinstance(notes, list):
            raise WorkspaceImportError("Backup must contain notebooks and notes")
        if len(notebooks) > 1_000 or len(notes) > 20_000:
            raise WorkspaceImportError("Backup exceeds the supported workspace size")

        encoded_size = len(json.dumps(snapshot, ensure_ascii=False).encode("utf-8"))
        if encoded_size > 100 * 1024 * 1024:
            raise WorkspaceImportError("Backup exceeds the 100 MB import limit")

        notebook_keys: set[str] = set()
        for notebook in notebooks:
            if not isinstance(notebook, dict):
                raise WorkspaceImportError("Each notebook must be an object")
            key = notebook.get("resourceId")
            if not isinstance(key, str) or not key or key in notebook_keys:
                raise WorkspaceImportError("Notebook resource IDs must be unique")
            notebook_keys.add(key)
        for note in notes:
            if not isinstance(note, dict):
                raise WorkspaceImportError("Each note must be an object")
            if note.get("notebookResourceId") is not None and note.get("notebookResourceId") not in notebook_keys:
                raise WorkspaceImportError("Every note must reference an included notebook, or none (the Inbox)")
            if note.get("noteType", "canvas") not in NOTE_TYPES:
                raise WorkspaceImportError("Backup contains an unsupported note type")
            if not isinstance(note.get("content"), dict):
                raise WorkspaceImportError("Every note must contain a document object")

        imported_notebooks: dict[str, int] = {}
        imported_note_ids: list[int] = []
        with self.connection() as connection:
            local_key_rows = connection.execute("SELECT key_id, kind, wrapped FROM secure_keys").fetchall()
            backup_keys = self.check_secure_import(snapshot, notes, {row["key_id"] for row in local_key_rows})
            reserved_ids = self.reserved_block_ids(connection, -1)
            self.import_secure_keys(connection, backup_keys, local_key_rows)
            for notebook in notebooks:
                name = str(notebook.get("name") or "Imported notebook").strip()[:80]
                color_value = notebook.get("color")
                color = color_value if isinstance(color_value, str) and NOTEBOOK_COLOR_PATTERN.fullmatch(color_value) else DEFAULT_NOTEBOOK_COLOR
                category = self.notebook_category(notebook.get("category"), DEFAULT_NOTEBOOK_CATEGORY)
                resource_id = self.new_resource_id()
                cursor = connection.execute(
                    "INSERT INTO notebooks (resource_id, name, color, category) VALUES (?, ?, ?, ?)",
                    (resource_id, name or "Imported notebook", color, category),
                )
                imported_notebooks[notebook["resourceId"]] = cursor.lastrowid
                self.record_change(connection, "notebook", resource_id, 1, "created")

            for note in notes:
                note_type = note.get("noteType", "canvas")
                page_state_value = note.get("pageState")
                page_state = page_state_value if isinstance(page_state_value, dict) else DEFAULT_PAGE_STATE
                body = None
                secure_key_id, seal_id, sealed = None, None, None
                if note.get("secure"):
                    # Still encrypted: stored as it came, the words are never opened here. Search sees the title only.
                    secure_key_id, seal_id, sealed, body = note["keyId"], note["sealId"], note["sealed"], ""
                    content_format = {"page": FORMAT_PAGE, "mindmap": FORMAT_MINDMAP}.get(note_type, FORMAT_CANVAS)
                    content = self.placeholder_content(note_type)
                    page_state = dict(DEFAULT_PAGE_STATE)
                elif note_type == "page":
                    content_format = FORMAT_PAGE
                    content = json.dumps(normalize_page_document(note["content"]), separators=(",", ":"))
                elif note_type == "mindmap":
                    content_format = FORMAT_MINDMAP
                    content = json.dumps(self.normalize_mindmap_document(json.loads(json.dumps(note["content"]))), separators=(",", ":"))
                else:
                    # A backup made before JSON Canvas (version 1) carries Fabric JSON; both are accepted and JSON Canvas is stored.
                    content_format = FORMAT_CANVAS
                    try:
                        document, content, page_state, body = self.prepare_canvas(json.loads(json.dumps(note["content"])), page_state, reserved_ids)
                    except InvalidNoteContentError as error:
                        raise WorkspaceImportError(f"A note in the backup cannot be read: {error}") from error
                    reserved_ids.update(o["id"] for o in document["objects"] if isinstance(o, dict) and isinstance(o.get("id"), str))
                title = str(note.get("title") or "Untitled note")[:180]
                resource_id = self.new_resource_id()
                cursor = connection.execute(
                    """
                    INSERT INTO notes
                        (resource_id, note_type, title, content, content_format, page_state, notebook_id, secure, secure_key_id, seal_id, sealed)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        resource_id,
                        note_type,
                        title,
                        content,
                        content_format,
                        json.dumps(page_state, separators=(",", ":")),
                        imported_notebooks.get(note.get("notebookResourceId")),  # no notebook: the Inbox
                        1 if sealed else 0,
                        secure_key_id,
                        seal_id,
                        sealed,
                    ),
                )
                note_id = cursor.lastrowid
                imported_note_ids.append(note_id)
                self.index_note(connection, note_id, title, content, note_type, content_format, body=body)
                self.record_change(connection, "note", resource_id, 1, "created")
            connection.commit()
        return {
            "mode": "merge",
            "notebooksImported": len(imported_notebooks),
            "notesImported": len(imported_note_ids),
            "noteIds": imported_note_ids,
        }

    @staticmethod
    def import_secure_keys(connection: sqlite3.Connection, keys: list[dict], local_rows: list) -> None:
        """Add a backup's wrapped keys beside the ones already here (merge-only); the first keys a workspace gets become its primary."""
        have = {(row["key_id"], row["kind"], row["wrapped"]) for row in local_rows}
        make_primary = not local_rows and keys
        primary_key_id = next((key["keyId"] for key in keys if key.get("primary")), keys[0]["keyId"]) if make_primary else None
        for key in keys:
            if (key["keyId"], key["kind"], key["wrapped"]) in have:
                continue
            connection.execute(
                "INSERT INTO secure_keys (key_id, kind, version, salt, params, wrapped, is_primary) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (
                    key["keyId"], key["kind"], key["version"], key.get("salt"),
                    json.dumps(key["params"]) if key.get("params") else None, key["wrapped"],
                    1 if make_primary and key["keyId"] == primary_key_id else 0,
                ),
            )

    def record_agent_activity(
        self, agent: str, note_id: int | None, action: str, now: float | None = None
    ) -> None:
        """Remember that a local agent is reading or writing; it expires on its own."""
        if action not in AGENT_ACTIONS:
            raise ValueError("Unsupported agent action")
        name = str(agent or "").strip()[:80] or "Agent"
        with self.connection() as connection:
            connection.execute(
                """
                INSERT INTO agent_activity (agent, note_id, action, at) VALUES (?, ?, ?, ?)
                ON CONFLICT(agent) DO UPDATE
                SET note_id = excluded.note_id, action = excluded.action, at = excluded.at
                """,
                (name, note_id, action, time.time() if now is None else now),
            )
            connection.commit()

    def active_agents(self, now: float | None = None) -> list[dict]:
        moment = time.time() if now is None else now
        with self.connection() as connection:
            rows = connection.execute(
                """
                SELECT agent_activity.*, notes.title AS note_title
                FROM agent_activity
                LEFT JOIN notes ON notes.id = agent_activity.note_id
                WHERE agent_activity.at >= ?
                ORDER BY agent_activity.at DESC
                """,
                (moment - AGENT_ACTIVITY_WINDOW,),
            ).fetchall()
        return [
            {
                "agent": row["agent"],
                "noteId": row["note_id"],
                "noteTitle": row["note_title"],
                "action": row["action"],
                "at": row["at"],
            }
            for row in rows
        ]

    def changes_since(self, since: int | None) -> dict:
        """Cheap change feed: the current sequence plus changes after `since`."""
        with self.connection() as connection:
            sequence = connection.execute(
                "SELECT sequence FROM workspace_state WHERE id = 1"
            ).fetchone()[0]
            if since is None or since >= sequence:
                return {"sequence": sequence, "changes": [], "overflow": False}
            rows = connection.execute(
                """
                SELECT sequence, resource_kind, resource_id, revision, change_type
                FROM workspace_changes WHERE sequence > ? ORDER BY sequence LIMIT ?
                """,
                (since, CHANGES_LIMIT + 1),
            ).fetchall()
        return {
            "sequence": sequence,
            "overflow": len(rows) > CHANGES_LIMIT,
            "changes": [
                {
                    "sequence": row["sequence"],
                    "resourceKind": row["resource_kind"],
                    "resourceId": row["resource_id"],
                    "revision": row["revision"],
                    "changeType": row["change_type"],
                }
                for row in rows[:CHANGES_LIMIT]
            ],
        }

    def search(self, query: str) -> list[dict]:
        terms = WORD_PATTERN.findall(query.strip())
        if not terms:
            return []
        match_query = self.fts_query(terms)
        with self.connection() as connection:
            rows = connection.execute(
                """
                SELECT notes.*, notebooks.name AS notebook_name, notebooks.color AS notebook_color,
                  snippet(note_search, 2, '', '', ' … ', 18) AS search_excerpt
                FROM note_search
                JOIN notes ON notes.id = CAST(note_search.note_id AS INTEGER)
                LEFT JOIN notebooks ON notebooks.id = notes.notebook_id
                WHERE note_search MATCH ?
                ORDER BY bm25(note_search), notes.updated_at DESC
                LIMIT 30
                """,
                (match_query,),
            ).fetchall()
        return [
            {
                "id": note["id"],
                "title": note["title"],
                "noteType": note["note_type"],
                "notebookId": note["notebook_id"],
                "notebookName": note["notebook_name"] or INBOX_NAME,
                "notebookColor": note["notebook_color"] or DEFAULT_NOTEBOOK_COLOR,
                "excerpt": note["search_excerpt"] or "",
                "updatedAt": note["updated_at"],
            }
            for note in rows
        ]
