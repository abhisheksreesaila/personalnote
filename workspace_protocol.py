import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import time
import uuid
from pathlib import Path

from services import NoteService, WORD_PATTERN


WORKSPACE_PROTOCOL_VERSION = "1"
MAX_QUERY_CHARS = 400
MAX_QUERY_RESULTS = 20
MAX_BLOCK_CHARS = 8_000
MAX_EXCERPT_CHARS = 280
CURSOR_RETENTION_SECONDS = 86_400
ACTOR_ID = "local-agent"
PROPOSAL_TYPES = {"link_resources", "classify_note"}
CLASSIFICATION_CATEGORIES = {"inbox", "project", "area", "resource", "archive"}


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
            "operations": [
                "workspace.describe",
                "resource.get",
                "workspace.query",
                "proposal.create",
                "proposal.get",
                "proposal.cancel",
                "proposal.decide",
                "activity.list",
            ],
            "resourceKinds": ["workspace", "notebook", "note", "block", "proposal", "activity"],
            "scopes": ["workspace:read", "workspace:propose"],
            "inferenceTiers": ["local-only", "local-first"],
            "limits": {
                "queryChars": MAX_QUERY_CHARS,
                "queryResults": MAX_QUERY_RESULTS,
                "blockChars": MAX_BLOCK_CHARS,
                "excerptChars": MAX_EXCERPT_CHARS,
            },
            "cursorRetentionSeconds": CURSOR_RETENTION_SECONDS,
            "proposalTypes": sorted(PROPOSAL_TYPES),
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

    @staticmethod
    def json_value(value) -> str:
        return json.dumps(value, separators=(",", ":"), sort_keys=True)

    @classmethod
    def request_digest(cls, operation: str, input_data: dict) -> str:
        return cls.value_hash(cls.json_value({"operation": operation, "input": input_data}))

    def idempotent_response(self, connection, operation: str, input_data: dict):
        key = input_data.get("idempotencyKey")
        if not isinstance(key, str) or not 0 < len(key) <= 128:
            raise WorkspaceProtocolError(
                "invalid_request", "A valid idempotencyKey is required"
            )
        digest = self.request_digest(operation, input_data)
        existing = connection.execute(
            """
            SELECT request_digest, response_json FROM workspace_idempotency
            WHERE actor_id = ? AND operation = ? AND idempotency_key = ?
            """,
            (ACTOR_ID, operation, key),
        ).fetchone()
        if existing is None:
            return key, digest, None
        if existing["request_digest"] != digest:
            raise WorkspaceProtocolError(
                "idempotency_conflict",
                "The idempotency key was already used with a different request",
                409,
            )
        return key, digest, self.note_service.parse_json(existing["response_json"], {})

    @staticmethod
    def record_idempotent_response(
        connection, operation: str, key: str, digest: str, response: dict
    ) -> None:
        connection.execute(
            """
            INSERT INTO workspace_idempotency
                (actor_id, operation, idempotency_key, request_digest, response_json)
            VALUES (?, ?, ?, ?, ?)
            """,
            (ACTOR_ID, operation, key, digest, json.dumps(response, separators=(",", ":"))),
        )

    @staticmethod
    def record_activity(
        connection, activity_type: str, detail: dict, proposal_id: str | None = None
    ) -> None:
        connection.execute(
            """
            INSERT INTO workspace_activity (actor_id, activity_type, proposal_id, detail_json)
            VALUES (?, ?, ?, ?)
            """,
            (ACTOR_ID, activity_type, proposal_id, json.dumps(detail, separators=(",", ":"))),
        )

    @staticmethod
    def utf16_slice(value: str, start: int, end: int) -> str | None:
        if start < 0 or end < start:
            return None
        offsets = [0]
        for character in value:
            offsets.append(offsets[-1] + len(character.encode("utf-16-le")) // 2)
        try:
            start_index = offsets.index(start)
            end_index = offsets.index(end)
        except ValueError:
            return None
        return value[start_index:end_index]

    def validate_evidence(self, connection, evidence: list, expected_revisions: dict) -> None:
        for source_ref in evidence:
            if not isinstance(source_ref, dict) or source_ref.get("type") != "block_text":
                raise WorkspaceProtocolError("invalid_request", "Evidence must use block_text source references")
            note_id = source_ref.get("noteId")
            block_id = source_ref.get("blockId")
            span = source_ref.get("textSpan")
            if not isinstance(note_id, str) or not isinstance(block_id, str) or not isinstance(span, dict):
                raise WorkspaceProtocolError("invalid_request", "Evidence is incomplete")
            note = connection.execute(
                "SELECT revision, content FROM notes WHERE resource_id = ?", (note_id,)
            ).fetchone()
            if note is None or expected_revisions.get(note_id) != note["revision"]:
                raise WorkspaceProtocolError("revision_conflict", "Proposal evidence is stale", 409)
            document = self.note_service.parse_json(note["content"], {"objects": []})
            block = next(
                (
                    item for item in document.get("objects", [])
                    if isinstance(item, dict) and item.get("semanticId") == block_id
                ),
                None,
            )
            if not isinstance(block, dict) or not isinstance(block.get("text"), str):
                raise WorkspaceProtocolError("revision_conflict", "Proposal evidence is stale", 409)
            value = self.utf16_slice(block["text"], span.get("start"), span.get("end"))
            if value is None or source_ref.get("valueHash") != self.value_hash(value):
                raise WorkspaceProtocolError("revision_conflict", "Proposal evidence is stale", 409)

    def validate_proposal(self, connection, proposal: dict) -> tuple[str, dict, list, dict]:
        if not isinstance(proposal, dict):
            raise WorkspaceProtocolError("invalid_request", "A proposal is required")
        proposal_type = proposal.get("type")
        if proposal_type not in PROPOSAL_TYPES:
            raise WorkspaceProtocolError("invalid_request", "Unsupported proposal type")
        expected_revisions = proposal.get("expectedRevisions")
        evidence = proposal.get("evidence")
        if not isinstance(expected_revisions, dict) or not isinstance(evidence, list) or not evidence:
            raise WorkspaceProtocolError("invalid_request", "Expected revisions and evidence are required")
        normalized_revisions = {}
        for resource_id, revision in expected_revisions.items():
            if not isinstance(resource_id, str) or not isinstance(revision, int) or revision < 1:
                raise WorkspaceProtocolError("invalid_request", "Expected revisions are invalid")
            normalized_revisions[resource_id] = revision
        self.validate_evidence(connection, evidence, normalized_revisions)
        if proposal_type == "classify_note":
            note_id = proposal.get("noteId")
            category = proposal.get("category")
            if not isinstance(note_id, str) or category not in CLASSIFICATION_CATEGORIES:
                raise WorkspaceProtocolError("invalid_request", "Note classification is invalid")
            note = connection.execute(
                "SELECT revision FROM notes WHERE resource_id = ?", (note_id,)
            ).fetchone()
            if note is None or normalized_revisions.get(note_id) != note["revision"]:
                raise WorkspaceProtocolError("revision_conflict", "Proposal source is stale", 409)
            normalized = {"noteId": note_id, "category": category}
            preview = {"kind": "note_classification", "noteId": note_id, "category": category}
        else:
            source_id = proposal.get("sourceId")
            target_id = proposal.get("targetId")
            relationship_type = proposal.get("relationshipType", "related")
            if (
                not isinstance(source_id, str)
                or not isinstance(target_id, str)
                or source_id == target_id
                or not isinstance(relationship_type, str)
                or not re.fullmatch(r"[a-z][a-z0-9_]{0,47}", relationship_type)
            ):
                raise WorkspaceProtocolError("invalid_request", "Resource link is invalid")
            for resource_id in (source_id, target_id):
                note = connection.execute(
                    "SELECT revision FROM notes WHERE resource_id = ?", (resource_id,)
                ).fetchone()
                if note is None or normalized_revisions.get(resource_id) != note["revision"]:
                    raise WorkspaceProtocolError("revision_conflict", "Proposal source is stale", 409)
            normalized = {
                "sourceId": source_id,
                "targetId": target_id,
                "relationshipType": relationship_type,
            }
            preview = {"kind": "relationship", **normalized}
        normalized["expectedRevisions"] = normalized_revisions
        return proposal_type, normalized, evidence, preview

    def proposal_view(self, row) -> dict:
        return {
            "id": row["id"],
            "type": row["proposal_type"],
            "state": row["state"],
            "input": self.note_service.parse_json(row["input_json"], {}),
            "evidence": self.note_service.parse_json(row["evidence_json"], []),
            "preview": self.note_service.parse_json(row["preview_json"], {}),
            "decision": self.note_service.parse_json(row["decision_json"], None),
            "createdAt": row["created_at"],
            "updatedAt": row["updated_at"],
            "decidedAt": row["decided_at"],
            "appliedAt": row["applied_at"],
        }

    def proposal_create(self, input_data: dict) -> dict:
        with self.note_service.connection() as connection:
            key, digest, replay = self.idempotent_response(connection, "proposal.create", input_data)
            if replay is not None:
                return replay
            proposal_type, normalized, evidence, preview = self.validate_proposal(
                connection, input_data.get("proposal")
            )
            proposal_id = f"proposal_{uuid.uuid4().hex}"
            response = {
                "proposal": {
                    "id": proposal_id,
                    "type": proposal_type,
                    "state": "pending",
                    "input": normalized,
                    "evidence": evidence,
                    "preview": preview,
                }
            }
            connection.execute(
                """
                INSERT INTO workspace_proposals
                    (id, actor_id, proposal_type, state, input_json, evidence_json, preview_json,
                     idempotency_key, request_digest, response_json)
                VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)
                """,
                (
                    proposal_id, ACTOR_ID, proposal_type, self.json_value(normalized),
                    self.json_value(evidence), self.json_value(preview), key, digest,
                    self.json_value(response),
                ),
            )
            self.record_activity(connection, "proposal.created", {"type": proposal_type}, proposal_id)
            self.record_idempotent_response(connection, "proposal.create", key, digest, response)
            connection.commit()
        return response

    def proposal_get(self, input_data: dict) -> dict:
        proposal_id = input_data.get("id")
        if not isinstance(proposal_id, str):
            raise WorkspaceProtocolError("invalid_request", "A proposal id is required")
        with self.note_service.connection() as connection:
            row = connection.execute(
                "SELECT * FROM workspace_proposals WHERE id = ? AND actor_id = ?",
                (proposal_id, ACTOR_ID),
            ).fetchone()
        if row is None:
            raise WorkspaceProtocolError("not_found", "Proposal not found", 404)
        return {"proposal": self.proposal_view(row)}

    def proposal_cancel(self, input_data: dict) -> dict:
        proposal_id = input_data.get("id")
        if not isinstance(proposal_id, str):
            raise WorkspaceProtocolError("invalid_request", "A proposal id is required")
        with self.note_service.connection() as connection:
            key, digest, replay = self.idempotent_response(connection, "proposal.cancel", input_data)
            if replay is not None:
                return replay
            row = connection.execute(
                "SELECT * FROM workspace_proposals WHERE id = ? AND actor_id = ?", (proposal_id, ACTOR_ID)
            ).fetchone()
            if row is None:
                raise WorkspaceProtocolError("not_found", "Proposal not found", 404)
            if row["state"] != "pending":
                raise WorkspaceProtocolError("invalid_request", "Only pending proposals may be cancelled")
            connection.execute(
                "UPDATE workspace_proposals SET state = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                (proposal_id,),
            )
            response = {"proposal": {**self.proposal_view(row), "state": "cancelled"}}
            self.record_activity(connection, "proposal.cancelled", {}, proposal_id)
            self.record_idempotent_response(connection, "proposal.cancel", key, digest, response)
            connection.commit()
        return response

    def apply_proposal(self, connection, row, decision: dict) -> tuple[dict, dict]:
        proposal = self.note_service.parse_json(row["input_json"], {})
        evidence = self.note_service.parse_json(row["evidence_json"], [])
        expected_revisions = proposal.get("expectedRevisions", {})
        if not isinstance(expected_revisions, dict):
            raise WorkspaceProtocolError("revision_conflict", "Proposal source is stale", 409)
        for resource_id, revision in expected_revisions.items():
            note = connection.execute(
                "SELECT revision FROM notes WHERE resource_id = ?", (resource_id,)
            ).fetchone()
            if note is None or note["revision"] != revision:
                raise WorkspaceProtocolError("revision_conflict", "Proposal source is stale", 409)
        self.validate_evidence(connection, evidence, expected_revisions)
        if row["proposal_type"] == "classify_note":
            previous = connection.execute(
                "SELECT category, proposal_id FROM note_classifications WHERE note_resource_id = ?",
                (proposal["noteId"],),
            ).fetchone()
            connection.execute(
                """
                INSERT INTO note_classifications (note_resource_id, category, proposal_id)
                VALUES (?, ?, ?)
                ON CONFLICT(note_resource_id) DO UPDATE SET
                    category = excluded.category, proposal_id = excluded.proposal_id, updated_at = CURRENT_TIMESTAMP
                """,
                (proposal["noteId"], proposal["category"], row["id"]),
            )
            forward = {"action": "set_classification", **proposal}
            inverse = (
                {"action": "clear_classification", "noteId": proposal["noteId"]}
                if previous is None
                else {"action": "set_classification", "noteId": proposal["noteId"], "category": previous["category"], "proposalId": previous["proposal_id"]}
            )
            self.note_service.record_change(connection, "classification", proposal["noteId"], 1, "updated")
        else:
            relationship = connection.execute(
                """
                SELECT id FROM workspace_relationships
                WHERE source_resource_id = ? AND target_resource_id = ? AND relationship_type = ?
                """,
                (proposal["sourceId"], proposal["targetId"], proposal["relationshipType"]),
            ).fetchone()
            if relationship is None:
                relationship_id = f"relationship_{uuid.uuid4().hex}"
                connection.execute(
                    """
                    INSERT INTO workspace_relationships
                        (id, source_resource_id, target_resource_id, relationship_type, proposal_id)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    (relationship_id, proposal["sourceId"], proposal["targetId"], proposal["relationshipType"], row["id"]),
                )
                forward = {"action": "create_relationship", "relationshipId": relationship_id, **proposal}
                inverse = {"action": "delete_relationship", "relationshipId": relationship_id}
                self.note_service.record_change(connection, "relationship", relationship_id, 1, "created")
            else:
                forward = {"action": "relationship_already_exists", "relationshipId": relationship["id"]}
                inverse = {"action": "none"}
        connection.execute(
            """
            UPDATE workspace_proposals
            SET state = 'applied', decision_json = ?, forward_change_json = ?, inverse_change_json = ?,
                updated_at = CURRENT_TIMESTAMP, decided_at = CURRENT_TIMESTAMP, applied_at = CURRENT_TIMESTAMP
            WHERE id = ?
            """,
            (self.json_value(decision), self.json_value(forward), self.json_value(inverse), row["id"]),
        )
        self.record_activity(connection, "proposal.applied", {"decision": decision, "forwardChange": forward}, row["id"])
        return forward, inverse

    def proposal_decide(self, input_data: dict) -> dict:
        proposal_id = input_data.get("id")
        decision_name = input_data.get("decision")
        if not isinstance(proposal_id, str) or decision_name not in {"accept", "reject"}:
            raise WorkspaceProtocolError("invalid_request", "A proposal id and valid decision are required")
        with self.note_service.connection() as connection:
            key, digest, replay = self.idempotent_response(connection, "proposal.decide", input_data)
            if replay is not None:
                return replay
            row = connection.execute(
                "SELECT * FROM workspace_proposals WHERE id = ? AND actor_id = ?", (proposal_id, ACTOR_ID)
            ).fetchone()
            if row is None:
                raise WorkspaceProtocolError("not_found", "Proposal not found", 404)
            if row["state"] != "pending":
                raise WorkspaceProtocolError("invalid_request", "Only pending proposals may be decided")
            decision = {"decision": decision_name, "actorId": ACTOR_ID}
            if decision_name == "reject":
                connection.execute(
                    """
                    UPDATE workspace_proposals
                    SET state = 'rejected', decision_json = ?, updated_at = CURRENT_TIMESTAMP, decided_at = CURRENT_TIMESTAMP
                    WHERE id = ?
                    """,
                    (self.json_value(decision), proposal_id),
                )
                self.record_activity(connection, "proposal.rejected", {"decision": decision}, proposal_id)
            else:
                try:
                    self.apply_proposal(connection, row, decision)
                except WorkspaceProtocolError as error:
                    if error.code == "revision_conflict":
                        connection.execute(
                            "UPDATE workspace_proposals SET state = 'conflicted', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                            (proposal_id,),
                        )
                        self.record_activity(connection, "proposal.conflicted", {"reason": error.code}, proposal_id)
                        connection.commit()
                    raise
            updated = connection.execute(
                "SELECT * FROM workspace_proposals WHERE id = ?", (proposal_id,)
            ).fetchone()
            response = {"proposal": self.proposal_view(updated)}
            self.record_idempotent_response(connection, "proposal.decide", key, digest, response)
            connection.commit()
        return response

    def activity_list(self, input_data: dict) -> dict:
        try:
            limit = min(50, max(1, int(input_data.get("limit", 20))))
        except (TypeError, ValueError):
            raise WorkspaceProtocolError("invalid_request", "Limit must be an integer") from None
        with self.note_service.connection() as connection:
            rows = connection.execute(
                """
                SELECT * FROM workspace_activity WHERE actor_id = ?
                ORDER BY id DESC LIMIT ?
                """,
                (ACTOR_ID, limit),
            ).fetchall()
        return {"items": [
            {
                "id": row["id"], "type": row["activity_type"], "proposalId": row["proposal_id"],
                "detail": self.note_service.parse_json(row["detail_json"], {}), "createdAt": row["created_at"],
            }
            for row in rows
        ]}

    def execute(self, operation: str, input_data: dict) -> dict:
        if operation == "workspace.describe":
            return self.describe()
        if operation == "resource.get":
            return {"resource": self.resource_get(str(input_data.get("id") or ""))}
        if operation == "workspace.query":
            return self.query(input_data)
        if operation == "proposal.create":
            return self.proposal_create(input_data)
        if operation == "proposal.get":
            return self.proposal_get(input_data)
        if operation == "proposal.cancel":
            return self.proposal_cancel(input_data)
        if operation == "proposal.decide":
            return self.proposal_decide(input_data)
        if operation == "activity.list":
            return self.activity_list(input_data)
        raise WorkspaceProtocolError(
            "unsupported_operation", f"Unsupported operation: {operation}", 400
        )