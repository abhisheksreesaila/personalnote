import sqlite3


SCHEMA = """
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL DEFAULT 'Untitled note',
  content TEXT NOT NULL DEFAULT '{"objects":[]}',
  page_state TEXT NOT NULL DEFAULT '{"columns":1,"rows":1}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS notebooks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#B86B4B',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
"""


def initialize_schema(connection: sqlite3.Connection) -> int:
    connection.executescript(SCHEMA)
    note_columns = {
        row[1] for row in connection.execute("PRAGMA table_info(notes)").fetchall()
    }
    if "notebook_id" not in note_columns:
        connection.execute(
            "ALTER TABLE notes ADD COLUMN notebook_id INTEGER REFERENCES notebooks(id)"
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
    connection.commit()
    return int(default_notebook_id)