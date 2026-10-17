import sqlite3
import uuid


SCHEMA = """
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
    resource_id TEXT,
    revision INTEGER NOT NULL DEFAULT 1,
    note_type TEXT NOT NULL DEFAULT 'canvas',
    content_format TEXT NOT NULL DEFAULT 'fabric',
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
  category TEXT NOT NULL DEFAULT 'projects',
  icon TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE VIRTUAL TABLE IF NOT EXISTS note_search USING fts5(
    note_id UNINDEXED,
    title,
    body,
    tokenize = 'unicode61 remove_diacritics 2'
);
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
CREATE TABLE IF NOT EXISTS agent_activity (
    agent TEXT PRIMARY KEY,
    note_id INTEGER,
    action TEXT NOT NULL CHECK (action IN ('reading', 'writing')),
    at REAL NOT NULL
);
-- F-096: what a local agent's write replaced, so the app can show it and take it back. Not in backup or export.
CREATE TABLE IF NOT EXISTS agent_edits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    agent TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'applied' CHECK (state IN ('applied', 'undone')),
    after_revision INTEGER NOT NULL,
    live_revision INTEGER NOT NULL,
    changed TEXT NOT NULL,
    before_content TEXT NOT NULL,
    before_format TEXT NOT NULL,
    before_page_state TEXT NOT NULL,
    after_content TEXT NOT NULL,
    after_format TEXT NOT NULL,
    after_page_state TEXT NOT NULL,
    at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_edits_note ON agent_edits (note_id, after_revision);
CREATE TABLE IF NOT EXISTS secure_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('keychain', 'passphrase', 'recovery')),
    version INTEGER NOT NULL DEFAULT 1,
    salt TEXT,
    params TEXT,
    wrapped TEXT NOT NULL,
    is_primary INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- Derived (F-079): one meaning vector per non-secure note. Never in backup or export; rebuilt when missing or when the model changes.
CREATE TABLE IF NOT EXISTS note_embeddings (
    note_id INTEGER PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL,
    model TEXT NOT NULL,
    dims INTEGER NOT NULL,
    vector BLOB NOT NULL,
    text_hash TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- X bookmarks (F-088): every post ever imported (so a moved, archived or deleted note is never imported again; seq orders them
-- oldest to newest) and the one notebook they land in, tracked by id so renaming or recolouring it changes nothing.
-- Not in backup or export: the notes are, as normal notes.
CREATE TABLE IF NOT EXISTS x_posts (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id TEXT NOT NULL UNIQUE,
    note_id INTEGER REFERENCES notes(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS x_notebook (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    notebook_id INTEGER REFERENCES notebooks(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_workspace_changes_resource
ON workspace_changes(resource_kind, resource_id, sequence);
"""


def initialize_schema(connection: sqlite3.Connection) -> int | None:
    connection.executescript(SCHEMA)
    note_columns = {
        row[1] for row in connection.execute("PRAGMA table_info(notes)").fetchall()
    }
    notebook_column_added = "notebook_id" not in note_columns
    if notebook_column_added:
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
    if "content_format" not in note_columns:
        # How `content` is encoded: 'json-canvas' (JSON Canvas 1.0 + pn), 'fabric' (before F-026, until converted) or 'mindmap'.
        # Every row that exists when the column appears is old, so the default is 'fabric'.
        try:
            connection.execute(
                "ALTER TABLE notes ADD COLUMN content_format TEXT NOT NULL DEFAULT 'fabric'"
            )
        except sqlite3.OperationalError as error:
            # Another process starting at the same moment added it first.
            if "duplicate column" not in str(error):
                raise
    # Secure notes (F-057, ADR 0005): `sealed` holds the encrypted words; `content` and `page_state` then hold an empty placeholder.
    for column, definition in (
        ("secure", "INTEGER NOT NULL DEFAULT 0"),
        ("secure_key_id", "TEXT"),
        ("seal_id", "TEXT"),
        ("sealed", "TEXT"),
    ):
        if column not in note_columns:
            try:
                connection.execute(f"ALTER TABLE notes ADD COLUMN {column} {definition}")
            except sqlite3.OperationalError as error:
                if "duplicate column" not in str(error):
                    raise
    connection.execute(
        "UPDATE notes SET content_format = 'mindmap' WHERE note_type = 'mindmap' AND content_format = 'fabric'"
    )

    notebook_columns = {
        row[1] for row in connection.execute("PRAGMA table_info(notebooks)").fetchall()
    }
    if "category" not in notebook_columns:
        connection.execute(
            "ALTER TABLE notebooks ADD COLUMN category TEXT NOT NULL DEFAULT 'projects'"
        )
    if "icon" not in notebook_columns:
        connection.execute("ALTER TABLE notebooks ADD COLUMN icon TEXT NOT NULL DEFAULT ''")
    if "resource_id" not in notebook_columns:
        connection.execute("ALTER TABLE notebooks ADD COLUMN resource_id TEXT")
    if "revision" not in notebook_columns:
        connection.execute(
            "ALTER TABLE notebooks ADD COLUMN revision INTEGER NOT NULL DEFAULT 1"
        )

    workspace = connection.execute(
        "SELECT workspace_id, sequence FROM workspace_state WHERE id = 1"
    ).fetchone()
    fresh_database = workspace is None
    if workspace is None:
        connection.execute(
            "INSERT INTO workspace_state (id, workspace_id) VALUES (1, ?)",
            (f"ws_{uuid.uuid4().hex}",),
        )

    default_notebook = connection.execute(
        "SELECT id FROM notebooks ORDER BY id LIMIT 1"
    ).fetchone()
    if default_notebook is None and not (fresh_database or notebook_column_added):
        # The Inbox is a place to start, so a workspace whose notebooks were all deleted stays that way.
        default_notebook_id = None
    elif default_notebook is None:
        # A brand-new database starts with one notebook; so does one from before notebooks existed (its notes need somewhere to go).
        cursor = connection.execute(
            "INSERT INTO notebooks (name, color) VALUES (?, ?)",
            ("My Notes", "#B86B4B"),
        )
        default_notebook_id = cursor.lastrowid
    else:
        default_notebook_id = default_notebook[0]

    # Only a database from before notebooks existed has notes with no notebook to file: they go to the first notebook.
    # Afterwards NULL means Inbox (F-064), so it must never be filled in again on a later start.
    if notebook_column_added and default_notebook_id is not None:
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
    return default_notebook_id