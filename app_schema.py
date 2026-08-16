import sqlite3
import uuid


SCHEMA = """
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
    resource_id TEXT,
    revision INTEGER NOT NULL DEFAULT 1,
    note_type TEXT NOT NULL DEFAULT 'canvas',
  title TEXT NOT NULL DEFAULT 'Untitled note',
  content TEXT NOT NULL DEFAULT '{"objects":[]}',
  page_state TEXT NOT NULL DEFAULT '{"columns":1,"rows":1}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS notebooks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
    resource_id TEXT,
    revision INTEGER NOT NULL DEFAULT 1,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#B86B4B',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE VIRTUAL TABLE IF NOT EXISTS note_search USING fts5(
    note_id UNINDEXED,
    title,
    body,
    tokenize = 'unicode61 remove_diacritics 2'
);
CREATE TABLE IF NOT EXISTS note_people (
    note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    normalized_name TEXT NOT NULL,
    context TEXT NOT NULL,
    PRIMARY KEY (note_id, normalized_name)
);
CREATE INDEX IF NOT EXISTS idx_note_people_name ON note_people(normalized_name);
CREATE TABLE IF NOT EXISTS workspace_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    workspace_id TEXT NOT NULL UNIQUE,
    sequence INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS workspace_changes (
    sequence INTEGER PRIMARY KEY,
    resource_kind TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    change_type TEXT NOT NULL CHECK (change_type IN ('created', 'updated', 'deleted')),
    occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_workspace_changes_resource
ON workspace_changes(resource_kind, resource_id, sequence);
CREATE TABLE IF NOT EXISTS workspace_proposals (
    id TEXT PRIMARY KEY,
    actor_id TEXT NOT NULL,
    proposal_type TEXT NOT NULL CHECK (proposal_type IN ('link_resources', 'classify_note')),
    state TEXT NOT NULL CHECK (state IN ('pending', 'accepted', 'rejected', 'cancelled', 'conflicted', 'applied')),
    input_json TEXT NOT NULL,
    evidence_json TEXT NOT NULL,
    preview_json TEXT NOT NULL,
    decision_json TEXT,
    forward_change_json TEXT,
    inverse_change_json TEXT,
    idempotency_key TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    response_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    decided_at TEXT,
    applied_at TEXT,
    UNIQUE (actor_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_workspace_proposals_actor_state
ON workspace_proposals(actor_id, state, updated_at DESC);
CREATE TABLE IF NOT EXISTS workspace_activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id TEXT NOT NULL,
    activity_type TEXT NOT NULL,
    proposal_id TEXT REFERENCES workspace_proposals(id),
    detail_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_workspace_activity_actor_created
ON workspace_activity(actor_id, created_at DESC, id DESC);
CREATE TABLE IF NOT EXISTS workspace_idempotency (
    actor_id TEXT NOT NULL,
    operation TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    response_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (actor_id, operation, idempotency_key)
);
CREATE TABLE IF NOT EXISTS workspace_policy_grants (
    id TEXT PRIMARY KEY,
    actor_id TEXT NOT NULL,
    operation TEXT NOT NULL,
    scope_json TEXT NOT NULL,
    expires_at TEXT,
    revoked_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS workspace_relationships (
    id TEXT PRIMARY KEY,
    source_resource_id TEXT NOT NULL,
    target_resource_id TEXT NOT NULL,
    relationship_type TEXT NOT NULL,
    proposal_id TEXT NOT NULL REFERENCES workspace_proposals(id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (source_resource_id, target_resource_id, relationship_type)
);
CREATE TABLE IF NOT EXISTS note_classifications (
    note_resource_id TEXT PRIMARY KEY,
    category TEXT NOT NULL CHECK (category IN ('inbox', 'project', 'area', 'resource', 'archive')),
    proposal_id TEXT NOT NULL REFERENCES workspace_proposals(id),
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
"""


def initialize_schema(connection: sqlite3.Connection) -> int:
    connection.executescript(SCHEMA)
    proposal_columns = {
        row[1] for row in connection.execute("PRAGMA table_info(workspace_proposals)").fetchall()
    }
    if "response_json" not in proposal_columns:
        connection.execute(
            "ALTER TABLE workspace_proposals ADD COLUMN response_json TEXT NOT NULL DEFAULT '{}'"
        )
    note_columns = {
        row[1] for row in connection.execute("PRAGMA table_info(notes)").fetchall()
    }
    if "notebook_id" not in note_columns:
        connection.execute(
            "ALTER TABLE notes ADD COLUMN notebook_id INTEGER REFERENCES notebooks(id)"
        )
    if "resource_id" not in note_columns:
        connection.execute("ALTER TABLE notes ADD COLUMN resource_id TEXT")
    if "revision" not in note_columns:
        connection.execute(
            "ALTER TABLE notes ADD COLUMN revision INTEGER NOT NULL DEFAULT 1"
        )
    if "note_type" not in note_columns:
        connection.execute(
            "ALTER TABLE notes ADD COLUMN note_type TEXT NOT NULL DEFAULT 'canvas'"
        )

    notebook_columns = {
        row[1] for row in connection.execute("PRAGMA table_info(notebooks)").fetchall()
    }
    if "resource_id" not in notebook_columns:
        connection.execute("ALTER TABLE notebooks ADD COLUMN resource_id TEXT")
    if "revision" not in notebook_columns:
        connection.execute(
            "ALTER TABLE notebooks ADD COLUMN revision INTEGER NOT NULL DEFAULT 1"
        )

    workspace = connection.execute(
        "SELECT workspace_id, sequence FROM workspace_state WHERE id = 1"
    ).fetchone()
    if workspace is None:
        connection.execute(
            "INSERT INTO workspace_state (id, workspace_id) VALUES (1, ?)",
            (f"ws_{uuid.uuid4().hex}",),
        )

    default_notebook = connection.execute(
        "SELECT id FROM notebooks ORDER BY id LIMIT 1"
    ).fetchone()
    if default_notebook is None:
        cursor = connection.execute(
            "INSERT INTO notebooks (name, color) VALUES (?, ?)",
            ("My Notes", "#B86B4B"),
        )
        default_notebook_id = cursor.lastrowid
    else:
        default_notebook_id = default_notebook[0]

    connection.execute(
        "UPDATE notes SET notebook_id = ? WHERE notebook_id IS NULL",
        (default_notebook_id,),
    )
    for table in ("notebooks", "notes"):
        missing = connection.execute(
            f"SELECT id FROM {table} WHERE resource_id IS NULL OR resource_id = ''"
        ).fetchall()
        for row in missing:
            connection.execute(
                f"UPDATE {table} SET resource_id = ? WHERE id = ?",
                (f"res_{uuid.uuid4().hex}", row[0]),
            )

    connection.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_notes_resource_id ON notes(resource_id)"
    )
    connection.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_notebooks_resource_id ON notebooks(resource_id)"
    )

    change_count = connection.execute(
        "SELECT COUNT(*) FROM workspace_changes"
    ).fetchone()[0]
    if change_count == 0:
        resources = connection.execute(
            """
            SELECT 'notebook', resource_id, revision, created_at FROM notebooks
            UNION ALL
            SELECT 'note', resource_id, revision, created_at FROM notes
            ORDER BY created_at, resource_id
            """
        ).fetchall()
        for resource_kind, resource_id, revision, created_at in resources:
            sequence = connection.execute(
                "UPDATE workspace_state SET sequence = sequence + 1, updated_at = CURRENT_TIMESTAMP WHERE id = 1 RETURNING sequence"
            ).fetchone()[0]
            connection.execute(
                """
                INSERT INTO workspace_changes
                    (sequence, resource_kind, resource_id, revision, change_type, occurred_at)
                VALUES (?, ?, ?, ?, 'created', ?)
                """,
                (sequence, resource_kind, resource_id, revision, created_at),
            )
    connection.commit()
    return int(default_notebook_id)