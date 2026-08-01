import json
import re
import sqlite3
from contextlib import contextmanager
from pathlib import Path

from app_schema import initialize_schema
from calendar_parse import parse_calendar_segments


DEFAULT_CONTENT = {"objects": []}
DEFAULT_PAGE_STATE = {"columns": 1, "rows": 1}
DEFAULT_NOTEBOOK_COLOR = "#B86B4B"
NOTEBOOK_COLOR_PATTERN = re.compile(r"^#[0-9a-f]{6}$", re.IGNORECASE)
WORD_PATTERN = re.compile(r"[\w'-]+", re.UNICODE)
PERSON_TOKEN = r"[A-Z][A-Za-zÀ-ÖØ-öø-ÿ'-]{1,40}"
PERSON_CUE_PATTERN = re.compile(
    rf"\b(?i:talk(?:ed|ing)? to|meet(?:ing)? with|met with|call|email|ask|tell|spoke with|follow up with)\s+({PERSON_TOKEN}(?:\s+{PERSON_TOKEN}){{0,2}})"
)
PERSON_SUBJECT_PATTERN = re.compile(
    rf"\b({PERSON_TOKEN}(?:\s+{PERSON_TOKEN})?)\s+(?i:said|says|asked|preferred|mentioned|agreed|decided|wants|needs|will|has|was)\b"
)
PERSON_TRAILING_WORDS = {"About", "At", "For", "Next", "On", "The", "Today", "Tomorrow", "With"}
RELATED_STOP_WORDS = {
    "about", "after", "again", "also", "because", "before", "being", "could",
    "from", "have", "into", "just", "more", "note", "only", "other", "should",
    "some", "that", "their", "them", "then", "there", "these", "they", "this",
    "through", "very", "what", "when", "where", "which", "while", "with", "would",
    "your",
}


class NotFoundError(Exception):
    pass


class NoteService:
    def __init__(self, database_path: Path | str):
        self.database_path = Path(database_path)
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        with self.connection() as connection:
            self.default_notebook_id = initialize_schema(connection)
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
            "title": note["title"],
            "notebookId": note["notebook_id"],
            "content": cls.parse_json(note["content"], DEFAULT_CONTENT),
            "pageState": cls.parse_json(note["page_state"], DEFAULT_PAGE_STATE),
            "createdAt": note["created_at"],
            "updatedAt": note["updated_at"],
        }

    @classmethod
    def canvas_text(cls, content: str) -> str:
        document = cls.parse_json(content, DEFAULT_CONTENT)
        return " ".join(
            item["text"]
            for item in document.get("objects", [])
            if isinstance(item, dict) and isinstance(item.get("text"), str)
        )

    @staticmethod
    def extract_people(text: str) -> list[str]:
        people = []
        seen = set()
        for pattern in (PERSON_CUE_PATTERN, PERSON_SUBJECT_PATTERN):
            for match in pattern.finditer(text):
                parts = match.group(1).strip().split()
                while len(parts) > 1 and parts[-1] in PERSON_TRAILING_WORDS:
                    parts.pop()
                name = " ".join(parts)
                normalized = name.casefold()
                if name and normalized not in seen:
                    people.append(name)
                    seen.add(normalized)
        return people

    @staticmethod
    def person_context(text: str, name: str, length: int = 180) -> str:
        position = text.casefold().find(name.casefold())
        start = max(0, position - 44)
        excerpt = text[start:start + length].strip()
        if start > 0:
            excerpt = f"...{excerpt}"
        if start + length < len(text):
            excerpt = f"{excerpt}..."
        return excerpt

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
    ) -> None:
        body = cls.canvas_text(content)
        connection.execute("DELETE FROM note_search WHERE note_id = ?", (note_id,))
        connection.execute(
            "INSERT INTO note_search (note_id, title, body) VALUES (?, ?, ?)",
            (note_id, title, body),
        )
        connection.execute("DELETE FROM note_people WHERE note_id = ?", (note_id,))
        combined_text = f"{title}. {body}".strip()
        for person in cls.extract_people(combined_text):
            connection.execute(
                """
                INSERT INTO note_people (note_id, name, normalized_name, context)
                VALUES (?, ?, ?, ?)
                """,
                (note_id, person, person.casefold(), cls.person_context(combined_text, person)),
            )

    @classmethod
    def rebuild_derived_indexes(cls, connection: sqlite3.Connection) -> None:
        connection.execute("DELETE FROM note_search")
        connection.execute("DELETE FROM note_people")
        notes = connection.execute("SELECT id, title, content FROM notes").fetchall()
        for note in notes:
            cls.index_note(connection, note["id"], note["title"], note["content"])
        connection.commit()

    @classmethod
    def ensure_derived_indexes(cls, connection: sqlite3.Connection) -> None:
        note_ids = {row[0] for row in connection.execute("SELECT id FROM notes")}
        indexed_ids = {
            int(row[0]) for row in connection.execute("SELECT note_id FROM note_search")
        }
        if note_ids != indexed_ids:
            cls.rebuild_derived_indexes(connection)

    @staticmethod
    def related_terms(text: str) -> set[str]:
        return {
            word.casefold()
            for word in WORD_PATTERN.findall(text)
            if len(word) >= 4 and word.casefold() not in RELATED_STOP_WORDS
        }

    @staticmethod
    def related_excerpt(body: str, terms: set[str], length: int = 180) -> str:
        folded = body.casefold()
        positions = [folded.find(term) for term in terms if folded.find(term) >= 0]
        start = max(0, min(positions, default=0) - 36)
        excerpt = body[start:start + length].strip()
        if start > 0:
            excerpt = f"...{excerpt}"
        if start + length < len(body):
            excerpt = f"{excerpt}..."
        return excerpt

    def notebook_exists(self, connection: sqlite3.Connection, notebook_id: int) -> bool:
        return connection.execute(
            "SELECT 1 FROM notebooks WHERE id = ?", (notebook_id,)
        ).fetchone() is not None

    def list_notebooks(self) -> list[dict]:
        with self.connection() as connection:
            rows = connection.execute(
                """
                SELECT notebooks.id, notebooks.name, notebooks.color,
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
        with self.connection() as connection:
            cursor = connection.execute(
                "INSERT INTO notebooks (name, color) VALUES (?, ?)", (name, color)
            )
            connection.commit()
            notebook_id = cursor.lastrowid
        return {"id": notebook_id, "name": name, "color": color, "noteCount": 0}

    def update_notebook(self, notebook_id: int, payload: dict) -> dict:
        with self.connection() as connection:
            current = connection.execute(
                "SELECT * FROM notebooks WHERE id = ?", (notebook_id,)
            ).fetchone()
            if current is None:
                raise NotFoundError("Notebook not found")
            name = str(payload.get("name", current["name"])).strip()[:80] or current["name"]
            requested_color = payload.get("color")
            color = requested_color if isinstance(requested_color, str) and NOTEBOOK_COLOR_PATTERN.fullmatch(requested_color) else current["color"]
            connection.execute(
                "UPDATE notebooks SET name = ?, color = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                (name, color, notebook_id),
            )
            connection.commit()
        return {"id": notebook_id, "name": name, "color": color}

    def delete_notebook(self, notebook_id: int) -> dict:
        with self.connection() as connection:
            notebook = connection.execute(
                "SELECT id FROM notebooks WHERE id = ?", (notebook_id,)
            ).fetchone()
            if notebook is None:
                raise NotFoundError("Notebook not found")
            destination = connection.execute(
                "SELECT id FROM notebooks WHERE id != ? ORDER BY id LIMIT 1",
                (notebook_id,),
            ).fetchone()
            if destination is None:
                cursor = connection.execute(
                    "INSERT INTO notebooks (name, color) VALUES (?, ?)",
                    ("My Notes", DEFAULT_NOTEBOOK_COLOR),
                )
                destination_id = cursor.lastrowid
            else:
                destination_id = destination["id"]
            connection.execute(
                "UPDATE notes SET notebook_id = ? WHERE notebook_id = ?",
                (destination_id, notebook_id),
            )
            connection.execute("DELETE FROM notebooks WHERE id = ?", (notebook_id,))
            connection.commit()
        return {"destinationNotebookId": destination_id}

    def list_notes(self) -> list[dict]:
        with self.connection() as connection:
            rows = connection.execute(
                "SELECT id, title, notebook_id, created_at, updated_at FROM notes ORDER BY updated_at DESC, id DESC"
            ).fetchall()
        return [
            {
                "id": row["id"],
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
        try:
            requested_notebook_id = int(payload.get("notebookId"))
        except (TypeError, ValueError):
            requested_notebook_id = self.default_notebook_id
        with self.connection() as connection:
            notebook_id = requested_notebook_id if self.notebook_exists(connection, requested_notebook_id) else self.default_notebook_id
            cursor = connection.execute(
                "INSERT INTO notes (title, notebook_id) VALUES (?, ?)",
                (title, notebook_id),
            )
            note = connection.execute(
                "SELECT * FROM notes WHERE id = ?", (cursor.lastrowid,)
            ).fetchone()
            self.index_note(connection, note["id"], note["title"], note["content"])
            connection.commit()
        return self.serialize_note(note)

    def update_note(self, note_id: int, payload: dict) -> dict:
        title = str(payload.get("title") or "Untitled note")[:180]
        content = json.dumps(payload.get("content") or DEFAULT_CONTENT, separators=(",", ":"))
        page_state = json.dumps(payload.get("pageState") or DEFAULT_PAGE_STATE, separators=(",", ":"))
        with self.connection() as connection:
            cursor = connection.execute(
                """
                UPDATE notes
                SET title = ?, content = ?, page_state = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                (title, content, page_state, note_id),
            )
            if cursor.rowcount == 0:
                raise NotFoundError("Note not found")
            try:
                notebook_id = int(payload.get("notebookId"))
            except (TypeError, ValueError):
                notebook_id = 0
            if self.notebook_exists(connection, notebook_id):
                connection.execute(
                    "UPDATE notes SET notebook_id = ? WHERE id = ?",
                    (notebook_id, note_id),
                )
            self.index_note(connection, note_id, title, content)
            connection.commit()
        return {"ok": True}

    def move_note(self, note_id: int, payload: dict) -> dict:
        try:
            notebook_id = int(payload.get("notebookId"))
        except (TypeError, ValueError):
            raise NotFoundError("Notebook not found") from None
        with self.connection() as connection:
            if not self.notebook_exists(connection, notebook_id):
                raise NotFoundError("Notebook not found")
            cursor = connection.execute(
                "UPDATE notes SET notebook_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                (notebook_id, note_id),
            )
            if cursor.rowcount == 0:
                raise NotFoundError("Note not found")
            connection.commit()
        return {"ok": True}

    def delete_note(self, note_id: int) -> None:
        with self.connection() as connection:
            connection.execute("DELETE FROM note_search WHERE note_id = ?", (note_id,))
            cursor = connection.execute("DELETE FROM notes WHERE id = ?", (note_id,))
            if cursor.rowcount == 0:
                raise NotFoundError("Note not found")
            connection.commit()

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
                "notebookId": note["notebook_id"],
                "notebookName": note["notebook_name"],
                "notebookColor": note["notebook_color"],
                "excerpt": note["search_excerpt"] or "",
                "updatedAt": note["updated_at"],
            }
            for note in rows
        ]

    def find_people(self, text: str, exclude_note_id: int | None = None) -> list[dict]:
        people = self.extract_people(text)[:4]
        if not people:
            return []
        matches = []
        with self.connection() as connection:
            for person in people:
                rows = connection.execute(
                    """
                    SELECT note_people.name, note_people.context, notes.id, notes.title,
                      notes.updated_at, notebooks.name AS notebook_name,
                      notebooks.color AS notebook_color
                    FROM note_people
                    JOIN notes ON notes.id = note_people.note_id
                    JOIN notebooks ON notebooks.id = notes.notebook_id
                    WHERE note_people.normalized_name = ?
                      AND (? IS NULL OR notes.id != ?)
                    ORDER BY notes.updated_at DESC, notes.id DESC
                    LIMIT 4
                    """,
                    (person.casefold(), exclude_note_id, exclude_note_id),
                ).fetchall()
                if not rows:
                    continue
                matches.append(
                    {
                        "name": rows[0]["name"],
                        "sourceCount": len(rows),
                        "sources": [
                            {
                                "noteId": row["id"],
                                "title": row["title"],
                                "context": row["context"],
                                "notebookName": row["notebook_name"],
                                "notebookColor": row["notebook_color"],
                                "sourceUpdatedAt": row["updated_at"],
                            }
                            for row in rows
                        ],
                    }
                )
        return matches

    def related_candidates(self, note_id: int, current_text: str) -> list[dict]:
        current_terms = self.related_terms(current_text)
        if len(current_terms) < 2:
            return []
        match_query = self.fts_query(sorted(current_terms), "OR")
        with self.connection() as connection:
            rows = connection.execute(
                """
                SELECT notes.*, notebooks.name AS notebook_name, notebooks.color AS notebook_color,
                  note_search.body AS indexed_body
                FROM note_search
                JOIN notes ON notes.id = CAST(note_search.note_id AS INTEGER)
                JOIN notebooks ON notebooks.id = notes.notebook_id
                WHERE note_search MATCH ? AND notes.id != ?
                ORDER BY bm25(note_search), notes.updated_at DESC
                LIMIT 40
                """,
                (match_query, note_id),
            ).fetchall()

        candidates = []
        for note in rows:
            body = note["indexed_body"]
            body_terms = self.related_terms(body)
            title_terms = self.related_terms(note["title"])
            shared_body = current_terms & body_terms
            shared_title = current_terms & title_terms
            shared_terms = shared_body | shared_title
            score = len(shared_body) + len(shared_title) * 2
            if score < 2 or len(shared_terms) < 2:
                continue
            labels = sorted(shared_terms, key=lambda term: (-len(term), term))[:3]
            display_labels = []
            for label in labels:
                original = re.search(rf"\b{re.escape(label)}\b", current_text, re.IGNORECASE)
                display_labels.append(original.group(0) if original else label)
            reason = f"Connected through {', '.join(display_labels[:-1])} and {display_labels[-1]}." if len(display_labels) > 1 else f"Connected through {display_labels[0]}."
            candidates.append(
                {
                    "noteId": note["id"],
                    "title": note["title"],
                    "notebookName": note["notebook_name"],
                    "notebookColor": note["notebook_color"],
                    "excerpt": self.related_excerpt(body, shared_terms),
                    "reason": reason,
                    "sourceUpdatedAt": note["updated_at"],
                    "score": score,
                    "confidence": min(0.96, 0.48 + score * 0.09),
                    "mode": "local-retrieval",
                }
            )
        return sorted(candidates, key=lambda item: (-item["score"], item["sourceUpdatedAt"]))[:5]

    def scan_page(
        self,
        note_id: int,
        text: str,
        segments: list[str],
        focus_segments: list[str],
        text_object_count: int,
        focused_text_count: int,
    ) -> dict:
        calendar_drafts = parse_calendar_segments(segments, focus_segments)
        people = self.find_people(text, note_id)
        candidates = self.related_candidates(note_id, text)
        related = candidates[0] if candidates else None
        tidy_focused = focused_text_count >= 2
        tidy_count = focused_text_count if tidy_focused else text_object_count
        return {
            "calendarDrafts": calendar_drafts,
            "people": people,
            "related": related,
            "relatedCandidates": candidates,
            "actions": {
                "canTidy": text_object_count >= 2,
                "tidyFocused": tidy_focused,
                "tidyCount": tidy_count,
            },
            "mode": "local-retrieval",
        }