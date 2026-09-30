"""Validation for local Personal Note plugin package manifests.

This is intentionally only a package boundary. Plugins are not executed yet, and
therefore receive no host authority, filesystem access, database access, or keys.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

HOST_API_VERSION = 1
ALLOWED_CAPABILITIES = frozenset({
    "commands", "editor-pane", "note-metadata", "search", "export-transform",
    "storage", "notifications", "network",
})


class PluginManifestError(ValueError):
    """The package manifest is malformed or incompatible with this host."""


@dataclass(frozen=True)
class PluginManifest:
    identifier: str
    name: str
    version: str
    host_api: int
    capabilities: tuple[str, ...]

    def as_dict(self) -> dict[str, Any]:
        return {
            "id": self.identifier,
            "name": self.name,
            "version": self.version,
            "hostApi": self.host_api,
            "capabilities": list(self.capabilities),
        }


def parse_plugin_manifest(value: Any) -> PluginManifest:
    if not isinstance(value, dict):
        raise PluginManifestError("Plugin manifest must be a JSON object")
    identifier = value.get("id")
    name = value.get("name")
    version = value.get("version")
    host_api = value.get("hostApi")
    capabilities = value.get("capabilities", [])
    if not isinstance(identifier, str) or not identifier or len(identifier) > 120:
        raise PluginManifestError("Plugin id is required")
    if not isinstance(name, str) or not name.strip() or len(name) > 120:
        raise PluginManifestError("Plugin name is required")
    if not isinstance(version, str) or not version.strip() or len(version) > 80:
        raise PluginManifestError("Plugin version is required")
    if host_api != HOST_API_VERSION:
        raise PluginManifestError(f"Plugin requires unsupported host API {host_api!r}")
    if not isinstance(capabilities, list) or any(not isinstance(item, str) for item in capabilities):
        raise PluginManifestError("Plugin capabilities must be a list of strings")
    unknown = sorted(set(capabilities) - ALLOWED_CAPABILITIES)
    if unknown:
        raise PluginManifestError(f"Plugin requests unsupported capabilities: {', '.join(unknown)}")
    if len(capabilities) != len(set(capabilities)):
        raise PluginManifestError("Plugin capabilities must not contain duplicates")
    return PluginManifest(identifier, name.strip(), version.strip(), host_api, tuple(sorted(capabilities)))
