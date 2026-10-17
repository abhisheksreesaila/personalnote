"""Built-in plugins (F-090, ADR 0006): which ones are switched on, per machine.

The choice lives in `plugins.json` in the app-data folder (PERSONAL_NOTE_PLUGINS_DIR overrides it), never in the notes database, a backup or an
export, so the server, the page and the command line all read the same answer. A missing or damaged file means every plugin keeps its default.
Switching a plugin off hides it and keeps its data; nothing here deletes a note.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import app_paths

SETTINGS_FILE = "plugins.json"
DEFAULTS = {"mindmap": True}  # id -> on by default; Voice and Search by meaning join in F-091
NAMES = {"mindmap": "Mind maps"}


class PluginSettingsError(Exception):
    """A plugin or value that does not exist, or a plugin that is off; the message is safe to show."""


class PluginSettings:
    def __init__(self, folder: Path | str | None = None):
        self.folder = Path(folder) if folder else Path(os.environ.get("PERSONAL_NOTE_PLUGINS_DIR") or app_paths.app_data_dir())

    @property
    def path(self) -> Path:
        return self.folder / SETTINGS_FILE

    def view(self) -> dict:
        """{plugin id: on}, every known plugin present."""
        try:
            saved = json.loads(self.path.read_text("utf-8"))
        except (OSError, ValueError):
            saved = {}
        saved = saved if isinstance(saved, dict) else {}
        return {key: saved[key] if isinstance(saved.get(key), bool) else default for key, default in DEFAULTS.items()}

    def enabled(self, plugin_id: str) -> bool:
        return self.view().get(plugin_id, False)

    def set_enabled(self, plugin_id: str, enabled) -> dict:
        if plugin_id not in DEFAULTS:
            raise PluginSettingsError("There is no such plugin.")
        if not isinstance(enabled, bool):
            raise PluginSettingsError("Say whether the plugin is on or off.")
        state = {**self.view(), plugin_id: enabled}
        self.folder.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_name(self.path.name + ".tmp")
        tmp.write_text(json.dumps(state, indent=2), "utf-8")
        os.replace(tmp, self.path)
        return state

    def require(self, plugin_id: str) -> None:
        """Raise PluginSettingsError, in plain words, when a plugin is off."""
        if not self.enabled(plugin_id):
            raise PluginSettingsError(f"{NAMES.get(plugin_id, plugin_id)} is switched off. Turn it on in Settings → Plugins.")
