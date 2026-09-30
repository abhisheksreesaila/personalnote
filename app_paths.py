"""Where Personal Note keeps its notebook database.

Standard library only, so `bin/personal-note` still runs without a virtualenv.
Resolution never creates, moves, copies or deletes anything.
"""

from __future__ import annotations

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


def default_database_path(
    platform: str | None = None,
    env: Mapping[str, str] | None = None,
    home: Path | None = None,
    legacy_path: Path | None = None,
) -> Path:
    """PERSONAL_NOTE_DB, else the app-data database, else an existing legacy repo database."""
    env = os.environ if env is None else env
    override = env.get("PERSONAL_NOTE_DB", "")
    if override:
        return Path(override)
    appdata_db = app_data_dir(platform, env, home) / DATABASE_FILENAME
    legacy = LEGACY_DATABASE if legacy_path is None else legacy_path
    if not appdata_db.exists() and legacy.exists():
        return legacy
    return appdata_db
