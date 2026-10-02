"""Explicit, user-run copy of a checkout's legacy database into the app-data folder.

Never deletes or moves the legacy file. When the destination already holds notes (for example the
macOS app started first) the legacy notes are merged in with the same validated, merge-only import
as a backup restore, so nothing already there is overwritten.
"""

from __future__ import annotations

import json
import os
import shutil
import sqlite3
from pathlib import Path
from urllib.error import URLError
from urllib.request import urlopen

from app_paths import instance_file, marker_path, write_migration_marker
from media_store import MEDIA_NAME
from portability import import_workspace_backup, workspace_backup
from services import NoteService


class MigrationError(Exception):
    """Expected, user-fixable problem."""


def copy_media(source: Path, target: Path) -> None:
    """Copy the content-addressed media files the copied notes point at; a file already there is never replaced."""
    if not source.is_dir():
        return
    target.mkdir(parents=True, exist_ok=True)
    for file in source.iterdir():
        if file.is_file() and not file.is_symlink() and MEDIA_NAME.match(file.name) and not (target / file.name).exists():
            partial = target / (file.name + ".part")
            shutil.copyfile(file, partial)
            os.replace(partial, target / file.name)


def _answers_health(url: str) -> bool:
    try:
        with urlopen(url.rstrip("/") + "/health", timeout=1) as response:
            return json.load(response).get("app") == "personal-note"
    except (OSError, URLError, ValueError, AttributeError):
        return False


def _open_desktop_instance(database: Path) -> bool:
    """Liveness by asking the recorded server, which works the same on every platform."""
    try:
        record = json.loads(instance_file(database).read_text(encoding="utf-8"))
        return _answers_health(record["url"])
    except (OSError, ValueError, KeyError, TypeError):
        return False


def _already_migrated_to(legacy: Path, destination: Path) -> bool:
    try:
        marker = json.loads(marker_path(legacy).read_text(encoding="utf-8"))
        return Path(marker["migratedTo"]).resolve() == destination.resolve()
    except (OSError, ValueError, KeyError, TypeError):
        return False


def migrate_legacy_database(
    legacy: Path,
    destination: Path,
    *,
    force_merge: bool = False,
    server_port: int | None = None,
    server_host: str = "127.0.0.1",
    allow_running_server: bool = False,
) -> dict:
    if not legacy.is_file():
        raise MigrationError(f"No legacy database at {legacy}; nothing to migrate.")
    if legacy.resolve() == destination.resolve():
        raise MigrationError("The legacy and app-data databases are the same file.")
    if _already_migrated_to(legacy, destination) and not force_merge:
        return {"ok": True, "mode": "already-migrated", "from": str(legacy), "to": str(destination), "legacyKept": True}
    if server_port is not None and not allow_running_server and _answers_health(f"http://{server_host}:{server_port}"):
        raise MigrationError(
            f"A Personal Note server is answering on port {server_port} and may keep writing to the legacy file. "
            "Stop it (for example the npm start / main.py server) and run again, or pass --yes to continue anyway."
        )
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
        copy_media(legacy.parent / "media", destination.parent / "media")
        result = {"mode": "copied"}
    write_migration_marker(legacy, destination)
    return {"ok": True, "from": str(legacy), "to": str(destination), "legacyKept": True, **result}
