import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import time
from pathlib import Path

from services import NoteService, WORD_PATTERN


WORKSPACE_PROTOCOL_VERSION = "1"
MAX_QUERY_CHARS = 400
MAX_QUERY_RESULTS = 20
MAX_BLOCK_CHARS = 8_000
MAX_EXCERPT_CHARS = 280
CURSOR_RETENTION_SECONDS = 86_400


class WorkspaceProtocolError(Exception):
    def __init__(self, code: str, message: str, status_code: int = 400):
        super().__init__(message)
        self.code = code
        self.status_code = status_code


def load_capability_token(database_path: Path) -> tuple[str, Path | None]:
    configured = os.getenv("PERSONAL_NOTE_AGENT_TOKEN", "").strip()
    if configured:
        return configured, None
    token_path = Path(
        os.getenv(
            "PERSONAL_NOTE_AGENT_TOKEN_FILE",
            database_path.parent / "workspace.token",
        )
    )
    token_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        token = token_path.read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        token = secrets.token_urlsafe(32)
        try:
            with token_path.open("x", encoding="utf-8") as token_file:
                token_file.write(f"{token}\n")
        except FileExistsError:
            token = token_path.read_text(encoding="utf-8").strip()
    if not token:
        raise RuntimeError("Workspace capability token is empty")
    return token, token_path


class WorkspaceProtocol:
    def __init__(self, note_service: NoteService, capability_token: str):
        self.note_service = note_service
        self.capability_token = capability_token

    @staticmethod
    def value_hash(value: str) -> str:
        digest = hashlib.sha256(value.encode("utf-8")).hexdigest()
        return f"sha256:{digest}"

    @staticmethod
    def utf16_offset(value: str, index: int) -> int:
        return len(value[:index].encode("utf-16-le")) // 2

    @classmethod
    def text_source_ref(
        cls,
        note,
        block_id: str,
        text: str,
        start: int,
        end: int,
    ) -> dict:
        cited_value = text[start:end]
        return {
            "type": "block_text",
            "resourceId": block_id,
            "noteId": note["resource_id"],
            "noteRevision": note["revision"],
            "blockId": block_id,
            "textSpan": {
                "start": cls.utf16_offset(text, start),
                "end": cls.utf16_offset(text, end),
            },
            "valueHash": cls.value_hash(cited_value),
            "excerpt": cited_value[:MAX_EXCERPT_CHARS],
        }

    @staticmethod
    def bounds(item: dict) -> dict:
        def number(name: str, default: float = 0.0) -> float:
            value = item.get(name, default)
            return float(value) if isinstance(value, (int, float)) else default

        return {
            "x": number("left"),
            "y": number("top"),
            "width": number("width") * number("scaleX", 1.0),
            "height": number("height") * number("scaleY", 1.0),
        }

    @classmethod
    def block_resource(cls, note, item: dict) -> dict | None:
        text = item.get("text")
        block_id = item.get("semanticId")
        if not isinstance(text, str) or not isinstance(block_id, str):
            return None
        projected_text = text[:MAX_BLOCK_CHARS]
        return {
            "schemaVersion": "1",
            "kind": "block",
            "id": block_id,
            "revision": note["revision"],
            "origin": "canonical",
            "data": {
                "noteId": note["resource_id"],
                "blockKind": "text",
                "text": projected_text,
                "truncated": len(text) > len(projected_text),
                "bounds": cls.bounds(item),
            },
            "evidence": [
                cls.text_source_ref(note, block_id, text, 0, len(projected_text))
            ],
            "createdAt": note["created_at"],
            "updatedAt": note["updated_at"],
        }

    @staticmethod
    def envelope(kind: str, row, data: dict) -> dict:
        return {
            "schemaVersion": "1",
            "kind": kind,
            "id": row["resource_id"],
            "revision": row["revision"],
            "origin": "canonical",
            "data": data,
            "createdAt": row["created_at"],
            "updatedAt": row["updated_at"],
        }

    def workspace_state(self, connection):
        return connection.execute(
            "SELECT * FROM workspace_state WHERE id = 1"
        ).fetchone()

    def describe(self) -> dict:
        with self.note_service.connection() as connection:
            workspace = self.workspace_state(connection)
        return {
            "workspaceId": workspace["workspace_id"],
            "protocolVersions": [WORKSPACE_PROTOCOL_VERSION],
            "operations": ["workspace.describe", "resource.get", "workspace.query"],
            "resourceKinds": ["workspace", "notebook", "note", "block"],
            "scopes": ["workspace:read"],
            "inferenceTiers": ["local-only", "local-first"],
            "limits": {
                "queryChars": MAX_QUERY_CHARS,
                "queryResults": MAX_QUERY_RESULTS,
                "blockChars": MAX_BLOCK_CHARS,
                "excerptChars": MAX_EXCERPT_CHARS,
            },
            "cursorRetentionSeconds": CURSOR_RETENTION_SECONDS,
            "adapter": {"transport": "http", "mode": "loopback-capability"},
        }

    def resource_get(self, resource_id: str) -> dict:
        if not resource_id:
            raise WorkspaceProtocolError("invalid_request", "A resource id is required")
        with self.note_service.connection() as connection:
            workspace = self.workspace_state(connection)
            if resource_id == workspace["workspace_id"]:
                return {
                    "schemaVersion": "1",
                    "kind": "workspace",
                    "id": workspace["workspace_id"],
                    "revision": workspace["sequence"],
                    "origin": "canonical",
                    "data": {"name": "Personal Note"},
                    "createdAt": workspace["created_at"],
                    "updatedAt": workspace["updated_at"],
                }
            notebook = connection.execute(
                """
                SELECT notebooks.*,
                  (SELECT COUNT(*) FROM notes WHERE notes.notebook_id = notebooks.id) AS note_count
                FROM notebooks WHERE resource_id = ?
                """,
                (resource_id,),
            ).fetchone()
            if notebook is not None:
                return self.envelope(
                    "notebook",
                    notebook,
                    {
                        "name": notebook["name"],
                        "color": notebook["color"],
                        "noteCount": notebook["note_count"],
                    },
                )
            note = connection.execute(
                "SELECT * FROM notes WHERE resource_id = ?", (resource_id,)
            ).fetchone()
            if note is not None:
                document = self.note_service.parse_json(note["content"], {"objects": []})
                block_ids = [
                    item["semanticId"]
                    for item in document.get("objects", [])
                    if isinstance(item, dict)
                    and isinstance(item.get("text"), str)
                    and isinstance(item.get("semanticId"), str)
                ][:200]
                notebook_resource_id = connection.execute(
                    "SELECT resource_id FROM notebooks WHERE id = ?", (note["notebook_id"],)
                ).fetchone()[0]
                return self.envelope(
                    "note",
                    note,
                    {
                        "title": note["title"],
                        "notebookId": notebook_resource_id,
                        "blockIds": block_ids,
                        "blocksTruncated": len(block_ids) >= 200,
                        "pageState": self.note_service.parse_json(note["page_state"], {}),
                    },
                )
            notes = connection.execute("SELECT * FROM notes ORDER BY id").fetchall()
            for candidate in notes:
                document = self.note_service.parse_json(candidate["content"], {"objects": []})
                for item in document.get("objects", []):
                    if isinstance(item, dict) and item.get("semanticId") == resource_id:
                        resource = self.block_resource(candidate, item)
                        if resource is not None:
                            return resource
        raise WorkspaceProtocolError("not_found", "Resource not found", 404)

    def encode_cursor(self, query: str, offset: int, workspace_id: str) -> str:
        payload = {
            "actor": "local-agent",
            "issuedAt": int(time.time()),
            "offset": offset,
            "queryHash": self.value_hash(query.casefold()),
            "version": WORKSPACE_PROTOCOL_VERSION,
            "workspaceId": workspace_id,
        }
        encoded = base64.urlsafe_b64encode(
            json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
        ).rstrip(b"=")
        signature = hmac.new(
            self.capability_token.encode("utf-8"), encoded, hashlib.sha256
        ).digest()
        return f"{encoded.decode()}.{base64.urlsafe_b64encode(signature).decode().rstrip('=')}"

    def decode_cursor(self, cursor: str, query: str, workspace_id: str) -> int:
        try:
            encoded_text, signature_text = cursor.split(".", 1)
            encoded = encoded_text.encode("ascii")
            signature = base64.urlsafe_b64decode(signature_text + "=" * (-len(signature_text) % 4))
            expected = hmac.new(
                self.capability_token.encode("utf-8"), encoded, hashlib.sha256
            ).digest()
            if not hmac.compare_digest(signature, expected):
                raise ValueError
            payload = json.loads(
                base64.urlsafe_b64decode(encoded + b"=" * (-len(encoded) % 4))
            )
            if (
                payload["actor"] != "local-agent"
                or payload["version"] != WORKSPACE_PROTOCOL_VERSION
                or payload["workspaceId"] != workspace_id
                or payload["queryHash"] != self.value_hash(query.casefold())
            ):
                raise ValueError
            if int(time.time()) - int(payload["issuedAt"]) > CURSOR_RETENTION_SECONDS:
                raise WorkspaceProtocolError("cursor_expired", "Cursor has expired", 409)
            return max(0, int(payload["offset"]))
        except WorkspaceProtocolError:
            raise
        except (KeyError, TypeError, ValueError, json.JSONDecodeError):
            raise WorkspaceProtocolError("invalid_cursor", "Cursor is invalid") from None

    @staticmethod
    def excerpt_span(text: str, match_start: int) -> tuple[int, int]:
        start = max(0, match_start - 80)
        end = min(len(text), start + MAX_EXCERPT_CHARS)
        start = max(0, end - MAX_EXCERPT_CHARS)
        return start, end

    def query(self, input_data: dict) -> dict:
        query = str(input_data.get("query") or "").strip()[:MAX_QUERY_CHARS]
        terms = WORD_PATTERN.findall(query)
        if not terms:
            raise WorkspaceProtocolError("invalid_request", "A searchable query is required")
        try:
            limit = int(input_data.get("limit", 10))
        except (TypeError, ValueError):
            raise WorkspaceProtocolError("invalid_request", "Limit must be an integer") from None
        limit = min(MAX_QUERY_RESULTS, max(1, limit))
        with self.note_service.connection() as connection:
            workspace = self.workspace_state(connection)
            offset = self.decode_cursor(
                str(input_data["cursor"]), query, workspace["workspace_id"]
            ) if input_data.get("cursor") else 0
            rows = connection.execute(
                """
                SELECT notes.*, bm25(note_search) AS rank
                FROM note_search
                JOIN notes ON notes.id = CAST(note_search.note_id AS INTEGER)
                WHERE note_search MATCH ?
                ORDER BY rank, notes.updated_at DESC, notes.id DESC
                LIMIT 80
                """,
                (self.note_service.fts_query(terms, "OR"),),
            ).fetchall()
            matches = []
            for note in rows:
                document = self.note_service.parse_json(note["content"], {"objects": []})
                for item in document.get("objects", []):
                    if not isinstance(item, dict) or not isinstance(item.get("text"), str):
                        continue
                    text = item["text"]
                    positions = [
                        match.start()
                        for term in terms
                        if (match := re.search(re.escape(term), text, re.IGNORECASE))
                    ]
                    if not positions:
                        continue
                    block_id = item.get("semanticId")
                    if not isinstance(block_id, str):
                        continue
                    start, end = self.excerpt_span(text, min(positions))
                    source_ref = self.text_source_ref(note, block_id, text, start, end)
                    matches.append(
                        {
                            "resource": {
                                "kind": "block",
                                "id": block_id,
                                "revision": note["revision"],
                            },
                            "note": {
                                "id": note["resource_id"],
                                "title": note["title"],
                            },
                            "score": round(max(0.0, -float(note["rank"])) + len(positions), 6),
                            "excerpt": source_ref["excerpt"],
                            "sourceRefs": [source_ref],
                        }
                    )
            matches.sort(key=lambda match: (-match["score"], match["resource"]["id"]))
            page = matches[offset:offset + limit]
            next_offset = offset + len(page)
            next_cursor = (
                self.encode_cursor(query, next_offset, workspace["workspace_id"])
                if next_offset < len(matches)
                else None
            )
        return {"items": page, "nextCursor": next_cursor}

    def execute(self, operation: str, input_data: dict) -> dict:
        if operation == "workspace.describe":
            return self.describe()
        if operation == "resource.get":
            return {"resource": self.resource_get(str(input_data.get("id") or ""))}
        if operation == "workspace.query":
            return self.query(input_data)
        raise WorkspaceProtocolError(
            "unsupported_operation", f"Unsupported operation: {operation}", 400
        )