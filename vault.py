"""Obsidian vault export and import (F-026).

A notebook becomes a folder of `.canvas` files (JSON Canvas 1.0 with the `pn` extensions, see ``json_canvas.py``); pictures and the
derived ink/shape SVGs go to `attachments/` and are referenced from the canvas files by vault-relative paths, which is how Obsidian
resolves `file` nodes. Mind maps are written as Markdown outlines (`.md`). Import reads a folder or ZIP of `.canvas` and `.md` files
as new notes in new notebooks: it never changes or deletes anything that already exists.

What Obsidian shows: text and stickies as text cards (Markdown rendered; a sticky keeps its colour), pictures as image cards, ink
strokes, shapes and highlighter as image cards of their SVG, connectors as arrows. What Obsidian ignores: the `pn` objects. If it
rewrites a canvas and drops them, the next import still reads every native field, so nothing visible is lost, but exact rotation,
ink points and sticky styling are, in that case.
"""

from __future__ import annotations

import hashlib
import io
import json
import re
import zipfile
from pathlib import Path, PurePosixPath

from json_canvas import FOREIGN_TEXT_STYLE, estimate_text_box, to_json_canvas, validate_json_canvas
from media_store import EXTENSION_BY_SUFFIX, MediaStore, data_url_of, decode_data_url
from note_text import mindmap_outline
from services import InvalidNoteContentError

MAX_FILE_BYTES = 20 * 1024 * 1024
MAX_TOTAL_BYTES = 200 * 1024 * 1024
MAX_FILES = 20_000
DEFAULT_NOTEBOOK = "Imported vault"
ATTACHMENTS = "attachments"
_FORBIDDEN = re.compile(r'[\\/:*?"<>|#^\[\]\x00-\x1f]+')


class PortabilityVaultError(ValueError):
    """A vault folder or archive that cannot be safely imported."""


def vault_name(value: str, fallback: str) -> str:
    cleaned = _FORBIDDEN.sub("-", str(value or "")).strip(" .-")
    return cleaned[:100] or fallback


class _VaultMedia:
    """The media interface of ``to_json_canvas`` writing into the vault's attachments folder."""

    def __init__(self, source: MediaStore, attachments: dict[str, bytes]):
        self.source = source
        self.attachments = attachments

    def _keep(self, name: str, data: bytes) -> str:
        path = f"{ATTACHMENTS}/{name}"
        self.attachments[path] = data
        return path

    def from_id(self, media_id: str) -> str:
        data = self.source.read(media_id)
        return self._keep(media_id, data) if data is not None else f"{ATTACHMENTS}/{media_id}"

    def _named(self, data: bytes, ext: str) -> str:
        return self._keep(f"{hashlib.sha256(data).hexdigest()}.{ext}", data)

    def put_text(self, text: str, ext: str) -> str:
        return self._named(text.encode("utf-8"), ext)

    def put_data_url(self, url: str) -> str | None:
        decoded = decode_data_url(url)
        return self._named(*decoded) if decoded else None


def _unique(path: str, used: set[str]) -> str:
    candidate, suffix = path, 2
    stem, dot, extension = path.rpartition(".")
    while candidate.lower() in used:
        candidate = f"{stem} ({suffix}){dot}{extension}"
        suffix += 1
    used.add(candidate.lower())
    return candidate


def export_vault_files(service) -> dict[str, bytes]:
    """The vault as {relative path: bytes}."""
    return export_vault(service)[0]


def export_vault(service) -> tuple[dict[str, bytes], list[str]]:
    """The vault as ({relative path: bytes}, titles of notes that could not be written)."""
    files: dict[str, bytes] = {}
    skipped: list[str] = []
    used: set[str] = set()
    for note in service.export_rows():
        folder = vault_name(note["notebookName"], "Notebook")
        title = vault_name(note["title"], f"Note {note['id']}")
        if note["noteType"] == "mindmap":
            outline = mindmap_outline(note["content"])
            path = _unique(f"{folder}/{title}.md", used)
            files[path] = f"# {note['title']}\n\n{outline}\n".encode("utf-8")
            continue
        try:
            document = service.document_of(note["content"], note["contentFormat"], note["pageState"])
        except InvalidNoteContentError:
            skipped.append(note["title"])
            continue
        canvas = to_json_canvas(document, media=_VaultMedia(service.media, files))
        if not validate_json_canvas(canvas)["ok"]:  # never write a file Obsidian could refuse
            skipped.append(note["title"])
            continue
        path = _unique(f"{folder}/{title}.canvas", used)
        files[path] = json.dumps(canvas, ensure_ascii=False, indent="\t").encode("utf-8")
    return files, skipped


def export_vault_archive(service) -> bytes:
    buffer = io.BytesIO()
    files, skipped = export_vault(service)
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for path, data in files.items():
            archive.writestr(path, data)
        if skipped:
            archive.writestr("NOT-EXPORTED.txt", "These notes could not be exported:\n" + "\n".join(f"- {title}" for title in skipped) + "\n")
    return buffer.getvalue()


def export_vault_directory(service, destination: Path | str) -> dict:
    """Write the vault into a folder. Existing files are never overwritten: the export stops before writing if one would be."""
    root = Path(destination)
    files, skipped = export_vault(service)
    clashes = [path for path in files if (root / path).exists()]
    if clashes:
        raise PortabilityVaultError(f"Refusing to overwrite {len(clashes)} existing file(s), for example {clashes[0]}; export into an empty folder")
    for path, data in files.items():
        target = root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    canvases = sum(1 for path in files if path.endswith(".canvas"))
    return {"ok": True, "path": str(root), "canvasFiles": canvases, "attachments": sum(1 for path in files if path.startswith(f"{ATTACHMENTS}/")), "skipped": skipped}


# ---- import -----------------------------------------------------------------------------------------------------------------

def _safe_path(name: str) -> str | None:
    path = PurePosixPath(name.replace("\\", "/"))
    if path.is_absolute() or ".." in path.parts or any(part.startswith(".") for part in path.parts):
        return None
    return str(path)


def read_archive(data: bytes) -> dict[str, bytes]:
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as error:
        raise PortabilityVaultError("That is not a ZIP archive") from error
    with archive:
        infos = [info for info in archive.infolist() if not info.is_dir()]
        if len(infos) > MAX_FILES or sum(info.file_size for info in infos) > MAX_TOTAL_BYTES:
            raise PortabilityVaultError("The vault is larger than the import limit")
        files: dict[str, bytes] = {}
        for info in infos:
            path = _safe_path(info.filename)
            if path is None or info.file_size > MAX_FILE_BYTES:
                continue
            files[path] = archive.read(info)
    return files


def read_directory(folder: Path | str) -> dict[str, bytes]:
    root = Path(folder).resolve()
    if not root.is_dir():
        raise PortabilityVaultError(f"{folder} is not a folder")
    files: dict[str, bytes] = {}
    total = 0
    for path in sorted(root.rglob("*")):
        relative = path.relative_to(root)
        if path.is_symlink() or not path.is_file() or any(part.startswith(".") for part in relative.parts):
            continue
        size = path.stat().st_size
        if size > MAX_FILE_BYTES:
            continue
        total += size
        if len(files) >= MAX_FILES or total > MAX_TOTAL_BYTES:
            raise PortabilityVaultError("The vault is larger than the import limit")
        files[relative.as_posix()] = path.read_bytes()
    return files


def _resolve_attachment(files: dict[str, bytes], folder: str, name: str) -> bytes | None:
    """Obsidian paths are vault-relative; a path next to the canvas is also tried, then a unique file name anywhere."""
    for candidate in (name, f"{folder}/{name}" if folder else name):
        path = _safe_path(candidate)
        if path in files:
            return files[path]
    base = PurePosixPath(name).name.lower()
    matches = [path for path in files if PurePosixPath(path).name.lower() == base]
    return files[matches[0]] if len(matches) == 1 else None


def _inline_attachments(canvas: dict, files: dict[str, bytes], folder: str) -> None:
    for node in canvas.get("nodes") or []:
        if not isinstance(node, dict) or node.get("type") != "file" or not isinstance(node.get("file"), str):
            continue
        suffix = node["file"].split("#")[0].rsplit(".", 1)[-1].lower()
        ext = EXTENSION_BY_SUFFIX.get(suffix)
        data = _resolve_attachment(files, folder, node["file"]) if ext else None
        if data is not None:
            node["file"] = data_url_of(data, ext)


def _markdown_canvas(text: str) -> dict:
    """A Markdown file as a canvas with one text card, placed like the agent CLI's appended text."""
    width = 716
    height = round(estimate_text_box({"content": text, "geometry": {"width": width}, "style": dict(FOREIGN_TEXT_STYLE)})["height"])
    return {"nodes": [{"id": "markdown", "type": "text", "text": text, "x": 72, "y": 80, "width": width, "height": height}], "edges": []}


def import_vault_files(service, files: dict[str, bytes]) -> dict:
    notebooks: dict[str, dict] = {}
    notes: list[dict] = []
    skipped: list[str] = []
    for path, data in sorted(files.items()):
        suffix = PurePosixPath(path).suffix.lower()
        if suffix not in (".canvas", ".md"):
            continue
        folder = str(PurePosixPath(path).parent)
        folder = "" if folder == "." else folder
        try:
            text = data.decode("utf-8-sig")
            if suffix == ".canvas":
                canvas = json.loads(text)
                if not isinstance(canvas, dict):
                    raise ValueError("not an object")
                _inline_attachments(canvas, files, folder)
            else:
                canvas = _markdown_canvas(text)
        except (UnicodeDecodeError, ValueError):
            skipped.append(path)
            continue
        key = folder or DEFAULT_NOTEBOOK
        notebooks.setdefault(key, {"resourceId": key, "name": (folder.replace("/", " / ") or DEFAULT_NOTEBOOK)[:80]})
        notes.append({
            "notebookResourceId": key, "noteType": "canvas", "title": PurePosixPath(path).stem[:180] or "Untitled note",
            "content": canvas, "pageState": {"columns": 1, "rows": 1},
        })
    if not notes:
        raise PortabilityVaultError("No .canvas or .md files found")
    try:
        result = service.import_workspace_snapshot({"notebooks": list(notebooks.values()), "notes": notes})
    except Exception as error:
        if isinstance(error, ValueError):
            raise PortabilityVaultError(str(error)) from error
        raise
    return {**result, "skipped": skipped}


def import_vault_archive(service, data: bytes) -> dict:
    return import_vault_files(service, read_archive(data))


def import_vault_directory(service, folder: Path | str) -> dict:
    return import_vault_files(service, read_directory(folder))


__all__ = [
    "PortabilityVaultError", "export_vault_archive", "export_vault_directory", "export_vault_files", "import_vault_archive",
    "import_vault_directory", "import_vault_files",
]
