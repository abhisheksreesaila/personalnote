import json
import logging
import os
import re
import sqlite3
import tempfile
import time
import uuid
from contextlib import contextmanager
from pathlib import Path

from app_schema import initialize_schema
from document_model import DocumentError, empty_document, from_fabric, plain_text
from json_canvas import estimate_text_box, from_json_canvas, is_json_canvas, to_json_canvas
from media_store import MediaStore, data_url_of

logger = logging.getLogger(__name__)

# How a note's `content` column is encoded.
FORMAT_CANVAS = "json-canvas"  # JSON Canvas 1.0 + pn extensions (ADR 0002)
FORMAT_FABRIC = "fabric"  # Fabric JSON: notes saved before F-026 until they are converted
FORMAT_MINDMAP = "mindmap"  # normalized mind-map JSON
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
NOTE_TYPES = {"canvas", "mindmap"}
DEFAULT_NOTEBOOK_COLOR = "#B86B4B"
NOTEBOOK_CATEGORIES = ("projects", "areas", "resources", "archive")
DEFAULT_NOTEBOOK_CATEGORY = "projects"
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


def empty_canvas_text() -> str:
    return json.dumps(to_json_canvas(empty_document()), separators=(",", ":"))


class NoteService:
    def __init__(self, database_path: Path | str, media_dir: Path | str | None = None):
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
        }

    @staticmethod
    def format_of(note) -> str:
        if note["note_type"] == "mindmap":
            return FORMAT_MINDMAP
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
            "SELECT id, content, page_state, title FROM notes WHERE note_type = 'canvas' AND content_format = ? ORDER BY id",
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
                os.link(temporary, target)
            except FileExistsError:
                pass
            finally:
                os.unlink(temporary)
            return target
        finally:
            source.close()

    def ensure_block_ids(self, connection: sqlite3.Connection) -> None:
        """Block ids are unique across the workspace; repair any that are missing, empty or shared (imports, copies)."""
        seen: set[str] = set()
        notes = connection.execute(
            "SELECT id, resource_id, revision, note_type, content, content_format, page_state, title FROM notes ORDER BY id"
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
            "SELECT content, content_format FROM notes WHERE id != ? AND note_type = 'canvas'",
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
            "SELECT id, title, note_type, content, content_format, page_state FROM notes"
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
            destination = connection.execute(
                "SELECT id FROM notebooks WHERE id != ? ORDER BY id LIMIT 1",
                (notebook_id,),
            ).fetchone()
            if destination is None:
                destination_resource_id = self.new_resource_id()
                cursor = connection.execute(
                    "INSERT INTO notebooks (resource_id, name, color) VALUES (?, ?, ?)",
                    (destination_resource_id, "My Notes", DEFAULT_NOTEBOOK_COLOR),
                )
                destination_id = cursor.lastrowid
                self.record_change(connection, "notebook", destination_resource_id, 1, "created")
            else:
                destination_id = destination["id"]
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
                "SELECT id, resource_id, revision, note_type, title, notebook_id, created_at, updated_at FROM notes ORDER BY updated_at DESC, id DESC"
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
        return self.serialize_note(note)

    def create_note(self, payload: dict) -> dict:
        title = str(payload.get("title") or "Untitled note")[:180]
        requested_note_type = str(payload.get("noteType") or "canvas")
        note_type = requested_note_type if requested_note_type in NOTE_TYPES else "canvas"
        initial_text = (
            json.dumps(DEFAULT_MINDMAP_CONTENT, separators=(",", ":")) if note_type == "mindmap" else empty_canvas_text()
        )
        content_format = FORMAT_MINDMAP if note_type == "mindmap" else FORMAT_CANVAS
        try:
            requested_notebook_id = int(payload.get("notebookId"))
        except (TypeError, ValueError):
            requested_notebook_id = self.default_notebook_id
        resource_id = self.new_resource_id()
        with self.connection() as connection:
            notebook_id = requested_notebook_id if self.notebook_exists(connection, requested_notebook_id) else self.default_notebook_id
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
            expected_revision = self.expected_revision(payload, current["revision"])
            note_type = current["note_type"]
            body = None
            if note_type == "mindmap":
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
            cursor = connection.execute(
                """
                UPDATE notes
                SET title = ?, content = ?, content_format = ?, page_state = ?, revision = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ? AND revision = ?
                """,
                (title, content, content_format, page_state, revision, note_id, expected_revision),
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
            self.index_note(connection, note_id, title, content, note_type, content_format, body=body)
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

    def append_text(self, note_id: int, text: str, revision: int | None = None) -> dict:
        """Add a text block below a canvas note's content, growing pages as needed.

        Existing objects are never rewritten. The write goes through update_note,
        so a stale revision raises ConflictError and leaves the note unchanged.
        """
        text = str(text).strip("\n")
        if not text.strip():
            raise AppendTextError("Text to append is empty")
        if len(text) > APPEND_MAX_LENGTH:
            raise AppendTextError("Text to append is too long")
        note = self.get_note(note_id)
        if note["noteType"] != "canvas":
            raise UnsupportedNoteTypeError("Text can only be appended to canvas notes")
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
        try:
            notebook_id = int(payload.get("notebookId"))
        except (TypeError, ValueError):
            raise NotFoundError("Notebook not found") from None
        with self.connection() as connection:
            if not self.notebook_exists(connection, notebook_id):
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
                "SELECT resource_id, note_type, title, content, content_format, page_state, notebook_id, created_at, updated_at FROM notes ORDER BY id"
            ).fetchall()
            notebook_resources = {
                row["id"]: row["resource_id"]
                for row in connection.execute("SELECT id, resource_id FROM notebooks")
            }
        return {
            "workspaceId": workspace["workspace_id"],
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
            "notes": [
                {
                    "resourceId": row["resource_id"],
                    "notebookResourceId": notebook_resources[row["notebook_id"]],
                    "noteType": row["note_type"],
                    "title": row["title"],
                    "contentFormat": self.format_of(row),
                    "content": self.snapshot_content(row),
                    "pageState": self.parse_json(row["page_state"], DEFAULT_PAGE_STATE),
                    "createdAt": row["created_at"],
                    "updatedAt": row["updated_at"],
                }
                for row in notes
            ],
        }

    def snapshot_content(self, row) -> dict:
        """A note's content for a backup or export: canvases as self-contained JSON Canvas (pictures and SVGs inline as data URLs)."""
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
                SELECT notes.id, notes.note_type, notes.title, notes.content, notes.content_format, notes.page_state, notebooks.name AS notebook_name
                FROM notes JOIN notebooks ON notebooks.id = notes.notebook_id ORDER BY notes.id
                """
            ).fetchall()
        return [
            {
                "id": row["id"],
                "noteType": row["note_type"],
                "title": row["title"],
                "notebookName": row["notebook_name"],
                "content": self.parse_json(row["content"], DEFAULT_CONTENT),
                "contentFormat": self.format_of(row),
                "pageState": self.parse_json(row["page_state"], DEFAULT_PAGE_STATE),
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
            if note.get("notebookResourceId") not in notebook_keys:
                raise WorkspaceImportError("Every note must reference an included notebook")
            if note.get("noteType", "canvas") not in NOTE_TYPES:
                raise WorkspaceImportError("Backup contains an unsupported note type")
            if not isinstance(note.get("content"), dict):
                raise WorkspaceImportError("Every note must contain a document object")

        imported_notebooks: dict[str, int] = {}
        imported_note_ids: list[int] = []
        with self.connection() as connection:
            reserved_ids = self.reserved_block_ids(connection, -1)
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
                if note_type == "mindmap":
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
                        (resource_id, note_type, title, content, content_format, page_state, notebook_id)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        resource_id,
                        note_type,
                        title,
                        content,
                        content_format,
                        json.dumps(page_state, separators=(",", ":")),
                        imported_notebooks[note["notebookResourceId"]],
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
                JOIN notebooks ON notebooks.id = notes.notebook_id
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
                "notebookName": note["notebook_name"],
                "notebookColor": note["notebook_color"],
                "excerpt": note["search_excerpt"] or "",
                "updatedAt": note["updated_at"],
            }
            for note in rows
        ]
