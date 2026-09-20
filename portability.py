"""User-owned workspace backup and readable export formats.

This module depends only on the core ``NoteService`` snapshot/import contract.
It deliberately knows nothing about editor runtimes, voice capture, or optional
features. Canonical backups are lossless JSON; Markdown archives are readable,
lossy projections with extracted embedded image assets.
"""

from __future__ import annotations

import base64
import binascii
import io
import json
import re
import zipfile
from datetime import datetime, timezone
from pathlib import PurePosixPath


BACKUP_FORMAT = "personal-note-workspace"
BACKUP_VERSION = 1
_DATA_URL = re.compile(
    r"^data:(image/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=\s]+)$",
    re.IGNORECASE,
)
_IMAGE_EXTENSIONS = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
}


class PortabilityError(ValueError):
    """Raised when a backup cannot be safely imported."""


def utc_timestamp() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def safe_name(value: str, fallback: str) -> str:
    normalized = re.sub(r"[^a-zA-Z0-9._-]+", "-", str(value).strip()).strip("-.")
    return (normalized[:80] or fallback).lower()


def workspace_backup(service) -> dict:
    snapshot = service.workspace_snapshot()
    return {
        "format": BACKUP_FORMAT,
        "version": BACKUP_VERSION,
        "exportedAt": utc_timestamp(),
        **snapshot,
    }


def import_workspace_backup(service, payload: dict) -> dict:
    if not isinstance(payload, dict):
        raise PortabilityError("Backup must be a JSON object")
    if payload.get("format") != BACKUP_FORMAT or payload.get("version") != BACKUP_VERSION:
        raise PortabilityError("Unsupported Personal Note backup format")
    return service.import_workspace_snapshot(payload)


def _extract_data_image(value, archive: zipfile.ZipFile, asset_path: str) -> str | None:
    if not isinstance(value, str):
        return None
    match = _DATA_URL.fullmatch(value.strip())
    if not match:
        return None
    media_type = match.group(1).lower()
    try:
        content = base64.b64decode(match.group(2), validate=True)
    except (binascii.Error, ValueError):
        return None
    if not content or len(content) > 20 * 1024 * 1024:
        return None
    extension = _IMAGE_EXTENSIONS[media_type]
    path = f"{asset_path}.{extension}"
    archive.writestr(path, content)
    return path


def _canvas_markdown(note: dict, archive: zipfile.ZipFile, asset_root: str) -> list[str]:
    objects = note.get("content", {}).get("objects", [])
    if not isinstance(objects, list):
        return []
    sortable = [item for item in objects if isinstance(item, dict)]
    sortable.sort(key=lambda item: (float(item.get("top") or 0), float(item.get("left") or 0)))
    lines: list[str] = []
    asset_number = 0
    for item in sortable:
        text = item.get("text")
        if isinstance(text, str) and text.strip():
            lines.extend([text.strip(), ""])
        asset = _extract_data_image(
            item.get("src"), archive, f"{asset_root}/image-{asset_number + 1}"
        )
        if asset:
            asset_number += 1
            relative_asset = PurePosixPath("../..").joinpath(asset)
            lines.extend([f"![Canvas image {asset_number}]({relative_asset})", ""])
    return lines


def _mindmap_markdown(note: dict, archive: zipfile.ZipFile, asset_root: str) -> list[str]:
    document = note.get("content", {})
    nodes = document.get("nodes", []) if isinstance(document, dict) else []
    if not isinstance(nodes, list):
        return []
    by_parent: dict[str | None, list[dict]] = {}
    by_id: dict[str, dict] = {}
    for node in nodes:
        if not isinstance(node, dict):
            continue
        node_id = str(node.get("id") or "")
        if not node_id:
            continue
        by_id[node_id] = node
        parent_id = node.get("parentId")
        by_parent.setdefault(None if parent_id is None else str(parent_id), []).append(node)
    root_id = str(document.get("rootId") or "")
    roots = [by_id[root_id]] if root_id in by_id else by_parent.get(None, [])
    lines: list[str] = []
    visited: set[str] = set()
    asset_number = 0

    def visit(node: dict, depth: int) -> None:
        nonlocal asset_number
        node_id = str(node.get("id"))
        if node_id in visited:
            return
        visited.add(node_id)
        text = str(node.get("text") or "Untitled idea").strip()
        lines.append(f"{'  ' * depth}- {text}")
        asset = _extract_data_image(
            node.get("image"), archive, f"{asset_root}/image-{asset_number + 1}"
        )
        if asset:
            asset_number += 1
            relative_asset = PurePosixPath("../..").joinpath(asset)
            lines.append(f"{'  ' * (depth + 1)}![Mind-map image {asset_number}]({relative_asset})")
        children = sorted(
            by_parent.get(node_id, []), key=lambda item: (float(item.get("y") or 0), str(item.get("id")))
        )
        for child in children:
            visit(child, depth + 1)

    for root in roots:
        visit(root, 0)
    for node in nodes:
        if isinstance(node, dict) and str(node.get("id")) not in visited:
            visit(node, 0)
    return lines


def markdown_archive(service) -> bytes:
    backup = workspace_backup(service)
    buffer = io.BytesIO()
    used_paths: set[str] = set()
    manifest = {
        "format": "personal-note-markdown",
        "version": 1,
        "exportedAt": backup["exportedAt"],
        "notes": [],
    }
    notebooks = {item["resourceId"]: item for item in backup["notebooks"]}

    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(
            "README.md",
            "# Personal Note Markdown export\n\n"
            "This archive is a readable projection, not a lossless restore format. "
            "Spatial positions, ink, and styling remain available only in a whole-workspace JSON backup. "
            "Embedded PNG, JPEG, WebP, and GIF data images are extracted into `assets/`.\n",
        )
        for index, note in enumerate(backup["notes"], start=1):
            notebook = notebooks.get(note.get("notebookResourceId"), {})
            notebook_name = safe_name(notebook.get("name", "notebook"), "notebook")
            base = safe_name(note.get("title", "untitled-note"), f"note-{index}")
            path = f"notes/{notebook_name}/{base}.md"
            suffix = 2
            while path in used_paths:
                path = f"notes/{notebook_name}/{base}-{suffix}.md"
                suffix += 1
            used_paths.add(path)
            asset_root = f"assets/{base}-{index}"
            lines = [
                f"# {note.get('title') or 'Untitled note'}",
                "",
                f"- Type: {note.get('noteType', 'canvas')}",
                f"- Notebook: {notebook.get('name', 'Notebook')}",
                f"- Updated: {note.get('updatedAt', '')}",
                "",
            ]
            if note.get("noteType") == "mindmap":
                lines.extend(_mindmap_markdown(note, archive, asset_root))
            else:
                lines.extend(_canvas_markdown(note, archive, asset_root))
            archive.writestr(path, "\n".join(lines).rstrip() + "\n")
            manifest["notes"].append({
                "resourceId": note.get("resourceId"),
                "path": path,
                "noteType": note.get("noteType", "canvas"),
            })
        archive.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))
    return buffer.getvalue()
