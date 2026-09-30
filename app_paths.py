"""Where Personal Note keeps its notebook database.

Standard library only, so `bin/personal-note` still runs without a virtualenv.
Resolution never creates, moves, copies or deletes anything.
"""

from __future__ import annotations

import json
import os
import sys
from collections.abc import Mapping
from pathlib import Path

DATABASE_FILENAME = "personal-note.db"
LEGACY_DATABASE = Path(__file__).resolve().parent / "data" / DATABASE_FILENAME


def app_data_dir(platform: str | None = None, env: Mapping[str, str] | None = None, home: Path | None = None) -> Path:
    platform = sys.platform if platform is None else platform
    env = os.environ if env is None else env
    home = Path.home() if home is None else home
    if platform == "darwin":
        return home / "Library" / "Application Support" / "Personal Note"
    if platform.startswith("win"):
        return Path(env.get("APPDATA") or home / "AppData" / "Roaming") / "Personal Note"
    xdg = env.get("XDG_DATA_HOME", "")
    base = Path(xdg) if xdg and Path(xdg).is_absolute() else home / ".local" / "share"
    return base / "personal-note"


def marker_path(legacy: Path) -> Path:
    """Written next to the legacy database by `personal-note migrate-data`; nothing else writes it."""
    return legacy.with_name(legacy.name + ".migrated")


def write_migration_marker(legacy: Path, destination: Path) -> None:
    marker_path(legacy).write_text(json.dumps({"migratedTo": str(destination)}), encoding="utf-8")


def instance_file(database: Path) -> Path:
    """Record of a running desktop app that owns this database."""
    return database.with_name(database.name + ".desktop.json")


def default_database_path(
    platform: str | None = None,
    env: Mapping[str, str] | None = None,
    home: Path | None = None,
    legacy_path: Path | None = None,
) -> Path:
    """Choose the notebook database. Nothing is created, moved, copied or deleted here.

    1. PERSONAL_NOTE_DB, if set.
    2. An existing legacy `data/personal-note.db` in this checkout, until the user has run
       `personal-note migrate-data` (which leaves a marker) and the app-data database exists.
       Another install creating an empty app-data database first therefore never hides the notes.
    3. The app-data database.
    """
    env = os.environ if env is None else env
    override = env.get("PERSONAL_NOTE_DB", "")
    if override:
        return Path(override)
    appdata_db = app_data_dir(platform, env, home) / DATABASE_FILENAME
    legacy = LEGACY_DATABASE if legacy_path is None else legacy_path
    if legacy.exists() and not (marker_path(legacy).exists() and appdata_db.exists()):
        return legacy
    return appdata_db
