"""Explicit, user-run copy of a checkout's legacy database into the app-data folder.

Never deletes or moves the legacy file. When the destination already holds notes (for example the
macOS app started first) the legacy notes are merged in with the same validated, merge-only import
as a backup restore, so nothing already there is overwritten.
"""

from __future__ import annotations

import json
import os
import sqlite3
from pathlib import Path

from app_paths import instance_file, write_migration_marker
from portability import import_workspace_backup, workspace_backup
from services import NoteService


class MigrationError(Exception):
    """Expected, user-fixable problem."""


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


def _open_desktop_instance(database: Path) -> bool:
    try:
        record = json.loads(instance_file(database).read_text(encoding="utf-8"))
        return _pid_alive(int(record["pid"]))
    except (OSError, ValueError, KeyError, TypeError):
        return False


def migrate_legacy_database(legacy: Path, destination: Path) -> dict:
    if not legacy.is_file():
        raise MigrationError(f"No legacy database at {legacy}; nothing to migrate.")
    if legacy.resolve() == destination.resolve():
        raise MigrationError("The legacy and app-data databases are the same file.")
    for database in (legacy, destination):
        if _open_desktop_instance(database):
            raise MigrationError("Personal Note is open on this database. Close it and run the command again.")

    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        source = NoteService(legacy)
        summary = import_workspace_backup(NoteService(destination), workspace_backup(source))
        result = {"mode": "merged", "import": summary}
    else:
        partial = destination.with_name(destination.name + ".partial")
        partial.unlink(missing_ok=True)
        source_connection = sqlite3.connect(legacy, timeout=10)
        target_connection = sqlite3.connect(partial)
        try:
            source_connection.backup(target_connection)
        finally:
            target_connection.close()
            source_connection.close()
        os.replace(partial, destination)
        result = {"mode": "copied"}
    write_migration_marker(legacy, destination)
    return {"ok": True, "from": str(legacy), "to": str(destination), "legacyKept": True, **result}
