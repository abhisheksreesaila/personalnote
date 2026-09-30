"""Scriptable local interface for Personal Note workspaces.

The CLI intentionally calls the same NoteService and portability contracts as the
web API. It does not bypass revisions, storage rules, or backup validation.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

from plugin_manifest import PluginManifestError, parse_plugin_manifest
from portability import PortabilityError, import_workspace_backup, markdown_archive, workspace_backup
from services import ConflictError, NoteService, NotFoundError, WorkspaceImportError

ROOT = Path(__file__).resolve().parent


class CliError(Exception):
    """Expected command error rendered as JSON."""


def database_path(value: str | None) -> Path:
    return Path(value or os.getenv("PERSONAL_NOTE_DB", ROOT / "data" / "personal-note.db"))


def emit(value: Any) -> None:
    print(json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True))


def read_json(path: str) -> dict:
    try:
        value = json.loads(Path(path).read_text(encoding="utf-8"))
    except OSError as error:
        raise CliError(f"Cannot read {path}: {error}") from error
    except json.JSONDecodeError as error:
        raise CliError(f"Invalid JSON in {path}: {error.msg}") from error
    if not isinstance(value, dict):
        raise CliError("JSON input must be an object")
    return value


def write_json(path: str | None, value: dict) -> None:
    encoded = json.dumps(value, ensure_ascii=False, indent=2) + "\n"
    if path:
        try:
            Path(path).write_text(encoded, encoding="utf-8")
        except OSError as error:
            raise CliError(f"Cannot write {path}: {error}") from error
        emit({"ok": True, "path": str(Path(path)), "format": value.get("format")})
    else:
        print(encoded, end="")


def text_document(text: str) -> dict:
    return {"objects": [{"type": "IText", "text": text, "left": 72, "top": 80}]}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Personal Note local workspace CLI")
    parser.add_argument("--database", help="SQLite database path (defaults to PERSONAL_NOTE_DB or data/personal-note.db)")
    subcommands = parser.add_subparsers(dest="command", required=True)

    status = subcommands.add_parser("status", help="Report local workspace diagnostics")
    status.set_defaults(handler=command_status)

    notebooks = subcommands.add_parser("notebooks", help="Manage notebooks")
    notebook_commands = notebooks.add_subparsers(dest="notebook_command", required=True)
    notebook_commands.add_parser("list", help="List notebooks").set_defaults(handler=command_notebooks_list)
    create_notebook = notebook_commands.add_parser("create", help="Create a notebook")
    create_notebook.add_argument("--name", required=True)
    create_notebook.add_argument("--color")
    create_notebook.set_defaults(handler=command_notebooks_create)

    notes = subcommands.add_parser("notes", help="Manage notes")
    note_commands = notes.add_subparsers(dest="note_command", required=True)
    note_commands.add_parser("list", help="List note summaries").set_defaults(handler=command_notes_list)
    get_note = note_commands.add_parser("get", help="Read a note")
    get_note.add_argument("note_id", type=int)
    get_note.set_defaults(handler=command_notes_get)
    create_note = note_commands.add_parser("create", help="Create a canvas or mind-map note")
    create_note.add_argument("--title", required=True)
    create_note.add_argument("--notebook-id", type=int)
    create_note.add_argument("--type", dest="note_type", choices=("canvas", "mindmap"), default="canvas")
    create_note.add_argument("--text", help="Initial canvas text; not valid for mind maps")
    create_note.set_defaults(handler=command_notes_create)
    delete_note = note_commands.add_parser("delete", help="Delete a note")
    delete_note.add_argument("note_id", type=int)
    delete_note.set_defaults(handler=command_notes_delete)

    search = subcommands.add_parser("search", help="Search note titles and content")
    search.add_argument("query")
    search.set_defaults(handler=command_search)

    export = subcommands.add_parser("export", help="Export user-owned workspace data")
    export_commands = export.add_subparsers(dest="export_command", required=True)
    workspace = export_commands.add_parser("workspace", help="Write a lossless workspace backup")
    workspace.add_argument("--output", help="Output JSON file; omit to write JSON to stdout")
    workspace.set_defaults(handler=command_export_workspace)
    markdown = export_commands.add_parser("markdown", help="Write a readable Markdown ZIP")
    markdown.add_argument("--output", required=True)
    markdown.set_defaults(handler=command_export_markdown)

    imported = subcommands.add_parser("import", help="Merge a lossless workspace backup")
    imported.add_argument("input", help="Workspace backup JSON file")
    imported.set_defaults(handler=command_import)

    plugins = subcommands.add_parser("plugins", help="Inspect plugin package manifests")
    plugin_commands = plugins.add_subparsers(dest="plugin_command", required=True)
    inspect_plugin = plugin_commands.add_parser("inspect", help="Validate a plugin manifest without installing or executing it")
    inspect_plugin.add_argument("manifest", help="Plugin manifest JSON file")
    inspect_plugin.set_defaults(handler=command_plugins_inspect)
    return parser


def command_status(service: NoteService, _args: argparse.Namespace) -> dict:
    snapshot = service.workspace_snapshot()
    return {
        "ok": True,
        "database": str(service.database_path),
        "workspaceId": snapshot["workspaceId"],
        "notebookCount": len(snapshot["notebooks"]),
        "noteCount": len(snapshot["notes"]),
        "storage": "sqlite",
    }


def command_notebooks_list(service: NoteService, _args: argparse.Namespace) -> list[dict]:
    return service.list_notebooks()


def command_notebooks_create(service: NoteService, args: argparse.Namespace) -> dict:
    return service.create_notebook({"name": args.name, "color": args.color})


def command_notes_list(service: NoteService, _args: argparse.Namespace) -> list[dict]:
    return service.list_notes()


def command_notes_get(service: NoteService, args: argparse.Namespace) -> dict:
    return service.get_note(args.note_id)


def command_notes_create(service: NoteService, args: argparse.Namespace) -> dict:
    if args.note_type == "mindmap" and args.text is not None:
        raise CliError("--text is only supported for canvas notes")
    payload: dict[str, Any] = {"title": args.title, "noteType": args.note_type}
    if args.notebook_id is not None:
        payload["notebookId"] = args.notebook_id
    note = service.create_note(payload)
    if args.text is None:
        return note
    result = service.update_note(
        note["id"],
        {
            "title": note["title"],
            "notebookId": note["notebookId"],
            "revision": note["revision"],
            "content": text_document(args.text),
            "pageState": note["pageState"],
        },
    )
    return service.get_note(note["id"]) | {"revision": result["revision"]}


def command_notes_delete(service: NoteService, args: argparse.Namespace) -> dict:
    service.delete_note(args.note_id)
    return {"ok": True, "id": args.note_id}


def command_search(service: NoteService, args: argparse.Namespace) -> list[dict]:
    return service.search(args.query)


def command_export_workspace(service: NoteService, args: argparse.Namespace) -> None:
    write_json(args.output, workspace_backup(service))
    return None


def command_export_markdown(service: NoteService, args: argparse.Namespace) -> dict:
    output = Path(args.output)
    try:
        output.write_bytes(markdown_archive(service))
    except OSError as error:
        raise CliError(f"Cannot write {output}: {error}") from error
    return {"ok": True, "path": str(output), "format": "personal-note-markdown"}


def command_import(service: NoteService, args: argparse.Namespace) -> dict:
    return import_workspace_backup(service, read_json(args.input))


def command_plugins_inspect(_service: NoteService, args: argparse.Namespace) -> dict:
    manifest = parse_plugin_manifest(read_json(args.manifest))
    return {"ok": True, "manifest": manifest.as_dict(), "execution": "not-supported"}


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        result = args.handler(NoteService(database_path(args.database)), args)
        if result is not None:
            emit(result)
        return 0
    except (CliError, NotFoundError, ConflictError, PortabilityError, WorkspaceImportError, PluginManifestError) as error:
        emit({"ok": False, "error": str(error)})
        return 2
    except Exception:
        emit({"ok": False, "error": "Command failed"})
        return 1


if __name__ == "__main__":
    sys.exit(main())
