import json
import re
import sqlite3
import uuid
from contextlib import contextmanager
from pathlib import Path

from app_schema import initialize_schema


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
NOTEBOOK_COLOR_PATTERN = re.compile(r"^#[0-9a-f]{6}$", re.IGNORECASE)
WORD_PATTERN = re.compile(r"[\w'-]+", re.UNICODE)


class NotFoundError(Exception):
    pass


class ConflictError(Exception):
    pass


class WorkspaceImportError(ValueError):
    pass


class NoteService:
    def __init__(self, database_path: Path | str):
        self.database_path = Path(database_path)
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        with self.connection() as connection:
            self.default_notebook_id = initialize_schema(connection)
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
            "pageState": cls.parse_json(note["page_state"], DEFAULT_PAGE_STATE),
            "createdAt": note["created_at"],
            "updatedAt": note["updated_at"],
        }

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
        changed = False
        for item in objects:
            if not isinstance(item, dict):
                continue
            semantic_id = item.get("semanticId")
            if not isinstance(semantic_id, str) or not semantic_id or semantic_id in seen:
                semantic_id = cls.new_resource_id()
                item["semanticId"] = semantic_id
                changed = True
            seen.add(semantic_id)
        return document, changed

    @classmethod
    def ensure_block_ids(cls, connection: sqlite3.Connection) -> None:
        seen: set[str] = set()
        notes = connection.execute(
            "SELECT id, resource_id, revision, note_type, content FROM notes ORDER BY id"
        ).fetchall()
        for note in notes:
            if note["note_type"] != "canvas":
                continue
            document = cls.parse_json(note["content"], DEFAULT_CONTENT)
            document, changed = cls.normalize_canvas_document(document, seen)
            seen.update(
                item["semanticId"]
                for item in document["objects"]
                if isinstance(item, dict) and isinstance(item.get("semanticId"), str)
            )
            if not changed:
                continue
            revision = note["revision"] + 1
            connection.execute(
                """
                UPDATE notes
                SET content = ?, revision = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                (json.dumps(document, separators=(",", ":")), revision, note["id"]),
            )
            cls.record_change(connection, "note", note["resource_id"], revision, "updated")
        connection.commit()

    @classmethod
    def reserved_block_ids(
        cls,
        connection: sqlite3.Connection,
        exclude_note_id: int,
    ) -> set[str]:
        reserved: set[str] = set()
        rows = connection.execute(
            "SELECT content FROM notes WHERE id != ? AND note_type = 'canvas'",
            (exclude_note_id,),
        ).fetchall()
        for row in rows:
            document = cls.parse_json(row["content"], DEFAULT_CONTENT)
            for item in document.get("objects", []):
                if isinstance(item, dict) and isinstance(item.get("semanticId"), str):
                    reserved.add(item["semanticId"])
        return reserved

    @classmethod
    def canvas_text(cls, content: str) -> str:
        document = cls.parse_json(content, DEFAULT_CONTENT)
        return " ".join(
            item["text"]
            for item in document.get("objects", [])
            if isinstance(item, dict) and isinstance(item.get("text"), str)
        )

    @classmethod
    def mindmap_text(cls, content: str) -> str:
        document = cls.parse_json(content, DEFAULT_MINDMAP_CONTENT)
        return " ".join(
            node["text"]
            for node in document.get("nodes", [])
            if isinstance(node, dict) and isinstance(node.get("text"), str)
        )

    @classmethod
    def note_text(cls, note_type: str, content: str) -> str:
        return cls.mindmap_text(content) if note_type == "mindmap" else cls.canvas_text(content)

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
    ) -> None:
        body = cls.note_text(note_type, content)
        connection.execute("DELETE FROM note_search WHERE note_id = ?", (note_id,))
        connection.execute(
            "INSERT INTO note_search (note_id, title, body) VALUES (?, ?, ?)",
            (note_id, title, body),
        )

    @classmethod
    def rebuild_derived_indexes(cls, connection: sqlite3.Connection) -> None:
        connection.execute("DELETE FROM note_search")
        notes = connection.execute(
            "SELECT id, title, note_type, content FROM notes"
        ).fetchall()
        for note in notes:
            cls.index_note(
                connection,
                note["id"],
                note["title"],
                note["content"],
                note["note_type"],
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
                                    notebooks.name, notebooks.color,
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
                "noteCount": row["note_count"],
            }
            for row in rows
        ]

    def create_notebook(self, payload: dict) -> dict:
        name = str(payload.get("name") or "Untitled notebook").strip()[:80]
        name = name or "Untitled notebook"
        requested_color = payload.get("color")
        color = requested_color if isinstance(requested_color, str) and NOTEBOOK_COLOR_PATTERN.fullmatch(requested_color) else DEFAULT_NOTEBOOK_COLOR
        resource_id = self.new_resource_id()
        with self.connection() as connection:
            cursor = connection.execute(
                "INSERT INTO notebooks (resource_id, name, color) VALUES (?, ?, ?)",
                (resource_id, name, color),
            )
            self.record_change(connection, "notebook", resource_id, 1, "created")
            connection.commit()
            notebook_id = cursor.lastrowid
        return {"id": notebook_id, "resourceId": resource_id, "revision": 1, "name": name, "color": color, "noteCount": 0}

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
            revision = expected_revision + 1
            cursor = connection.execute(
                "UPDATE notebooks SET name = ?, color = ?, revision = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND revision = ?",
                (name, color, revision, notebook_id, expected_revision),
            )
            if cursor.rowcount == 0:
                raise ConflictError("Resource revision does not match")
            self.record_change(connection, "notebook", current["resource_id"], revision, "updated")
            connection.commit()
        return {"id": notebook_id, "resourceId": current["resource_id"], "revision": revision, "name": name, "color": color}

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
        initial_content = (
            DEFAULT_MINDMAP_CONTENT if note_type == "mindmap" else DEFAULT_CONTENT
        )
        try:
            requested_notebook_id = int(payload.get("notebookId"))
        except (TypeError, ValueError):
            requested_notebook_id = self.default_notebook_id
        resource_id = self.new_resource_id()
        with self.connection() as connection:
            notebook_id = requested_notebook_id if self.notebook_exists(connection, requested_notebook_id) else self.default_notebook_id
            cursor = connection.execute(
                "INSERT INTO notes (resource_id, note_type, title, content, notebook_id) VALUES (?, ?, ?, ?, ?)",
                (
                    resource_id,
                    note_type,
                    title,
                    json.dumps(initial_content, separators=(",", ":")),
                    notebook_id,
                ),
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
            default_content = DEFAULT_MINDMAP_CONTENT if note_type == "mindmap" else DEFAULT_CONTENT
            document = payload.get("content") or default_content
            if note_type == "mindmap":
                document = self.normalize_mindmap_document(document)
            else:
                document, _ = self.normalize_canvas_document(
                    document, self.reserved_block_ids(connection, note_id)
                )
            content = json.dumps(document, separators=(",", ":"))
            revision = expected_revision + 1
            cursor = connection.execute(
                """
                UPDATE notes
                SET title = ?, content = ?, page_state = ?, revision = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ? AND revision = ?
                """,
                (title, content, page_state, revision, note_id, expected_revision),
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
            self.index_note(connection, note_id, title, content, note_type)
            self.record_change(connection, "note", current["resource_id"], revision, "updated")
            connection.commit()
        return {"ok": True, "resourceId": current["resource_id"], "revision": revision}

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
                "SELECT resource_id, name, color, created_at, updated_at FROM notebooks ORDER BY id"
            ).fetchall()
            notes = connection.execute(
                "SELECT resource_id, note_type, title, content, page_state, notebook_id, created_at, updated_at FROM notes ORDER BY id"
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
                    "content": self.parse_json(row["content"], DEFAULT_CONTENT),
                    "pageState": self.parse_json(row["page_state"], DEFAULT_PAGE_STATE),
                    "createdAt": row["created_at"],
                    "updatedAt": row["updated_at"],
                }
                for row in notes
            ],
        }

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
                resource_id = self.new_resource_id()
                cursor = connection.execute(
                    "INSERT INTO notebooks (resource_id, name, color) VALUES (?, ?, ?)",
                    (resource_id, name or "Imported notebook", color),
                )
                imported_notebooks[notebook["resourceId"]] = cursor.lastrowid
                self.record_change(connection, "notebook", resource_id, 1, "created")

            for note in notes:
                note_type = note.get("noteType", "canvas")
                document = json.loads(json.dumps(note["content"]))
                if note_type == "mindmap":
                    document = self.normalize_mindmap_document(document)
                else:
                    document, _ = self.normalize_canvas_document(document, reserved_ids)
                    reserved_ids.update(
                        item["semanticId"]
                        for item in document.get("objects", [])
                        if isinstance(item, dict) and isinstance(item.get("semanticId"), str)
                    )
                page_state_value = note.get("pageState")
                page_state = page_state_value if isinstance(page_state_value, dict) else DEFAULT_PAGE_STATE
                title = str(note.get("title") or "Untitled note")[:180]
                resource_id = self.new_resource_id()
                cursor = connection.execute(
                    """
                    INSERT INTO notes
                        (resource_id, note_type, title, content, page_state, notebook_id)
                    VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (
                        resource_id,
                        note_type,
                        title,
                        json.dumps(document, separators=(",", ":")),
                        json.dumps(page_state, separators=(",", ":")),
                        imported_notebooks[note["notebookResourceId"]],
                    ),
                )
                note_id = cursor.lastrowid
                imported_note_ids.append(note_id)
                self.index_note(
                    connection,
                    note_id,
                    title,
                    json.dumps(document, separators=(",", ":")),
                    note_type,
                )
                self.record_change(connection, "note", resource_id, 1, "created")
            connection.commit()
        return {
            "mode": "merge",
            "notebooksImported": len(imported_notebooks),
            "notesImported": len(imported_note_ids),
            "noteIds": imported_note_ids,
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
