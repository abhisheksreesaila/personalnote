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
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import urlopen
from typing import Any

from app_paths import DATABASE_FILENAME, LEGACY_DATABASE, app_data_dir, default_database_path
from startup import check_existing_server, probe_host
from migration import MigrationError, migrate_legacy_database
from plugin_manifest import PluginManifestError, parse_plugin_manifest
from plugin_settings import PluginSettings, PluginSettingsError
from portability import PortabilityError, import_workspace_backup, markdown_archive, workspace_backup
from note_text import note_plain_text
from search_runtime import SearchError, SearchRuntime, default_search_runtime, reap_dead_cli_engines
from services import ConflictError, InvalidNoteContentError, NoteService, NotFoundError, SecureError, UnsupportedNoteTypeError, WorkspaceImportError, AppendTextError
from vault import PortabilityVaultError, export_vault_directory, import_vault_archive, import_vault_directory

ROOT = Path(__file__).resolve().parent
ENV_FILE = ROOT / ".env"
DEFAULT_AGENT = "Claude Code"


class CliError(Exception):
    """Expected command error rendered as JSON."""


def env_setting(name: str, default: str) -> str:
    """Environment first, then the checkout's .env (same file main.py loads); standard library only."""
    if os.environ.get(name):
        return os.environ[name]
    try:
        for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
            key, separator, value = line.strip().partition("=")
            if separator and key.strip() == name and value.strip():
                return value.strip().strip("\"'")
    except OSError:
        pass
    return default


def database_path(value: str | None) -> Path:
    return Path(value) if value else default_database_path()


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


def read_stdin_text() -> str:
    if sys.stdin is None or sys.stdin.isatty():
        raise CliError("Provide --text, or pipe the text on standard input")
    return sys.stdin.read()


def print_text(value: str) -> None:
    print(value)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="personal-note",
        description="Personal Note local workspace CLI. Output is JSON unless --text is given on read commands.",
    )
    parser.add_argument("--database", help="SQLite database path (defaults to PERSONAL_NOTE_DB, else the app-data folder)")
    parser.add_argument("--agent", default=DEFAULT_AGENT, help=f"Name shown in the app while this agent works (default: {DEFAULT_AGENT})")
    agent_option = argparse.ArgumentParser(add_help=False)
    agent_option.add_argument("--agent", default=argparse.SUPPRESS, help="Name shown in the app while this agent works")
    subcommands = parser.add_subparsers(dest="command", required=True)

    status = subcommands.add_parser("status", help="Report local workspace diagnostics")
    status.set_defaults(handler=command_status)

    notebooks = subcommands.add_parser("notebooks", help="Manage notebooks")
    notebook_commands = notebooks.add_subparsers(dest="notebook_command", required=True)
    notebook_commands.add_parser("list", help="List notebooks").set_defaults(handler=command_notebooks_list)
    create_notebook = notebook_commands.add_parser("create", help="Create a notebook")
    create_notebook.add_argument("--name", required=True)
    create_notebook.add_argument("--color")
    create_notebook.add_argument("--icon", type=icon_argument, help="lucide:<name>, brand:x or emoji:<one emoji>; omit to let the app guess from the name")
    create_notebook.add_argument("--category", choices=["projects", "areas", "resources", "archive"])
    create_notebook.set_defaults(handler=command_notebooks_create)

    notes = subcommands.add_parser("notes", help="Manage notes")
    note_commands = notes.add_subparsers(dest="note_command", required=True)
    note_commands.add_parser("list", help="List note summaries").set_defaults(handler=command_notes_list)
    get_note = note_commands.add_parser("get", help="Read a note as full JSON (canvas or map document)", parents=[agent_option])
    get_note.add_argument("note_id", type=int)
    get_note.set_defaults(handler=command_notes_get)
    read_note = note_commands.add_parser(
        "read", help="Read a note as plain text (canvas in reading order, mind map as an outline, page as its Markdown)", parents=[agent_option]
    )
    read_note.add_argument("note_id", type=int)
    read_note.add_argument("--text", dest="as_text", action="store_true", help="Print only the text instead of JSON")
    read_note.set_defaults(handler=command_notes_read)
    append_note = note_commands.add_parser(
        "append", help="Append text to a canvas note (below its content) or a page note (a new paragraph at the end)", parents=[agent_option]
    )
    append_note.add_argument("note_id", type=int)
    append_note.add_argument("--text", help="Text to append; omit or use - to read standard input")
    append_note.add_argument("--revision", type=int, help="Fail if the note is no longer at this revision")
    append_note.set_defaults(handler=command_notes_append)
    write_note = note_commands.add_parser(
        "write",
        help="Replace a page note's Markdown, or a canvas note's Markdown text (the first, or --object); its ink finds its words again (marks it can't place are kept as loose ink)",
        parents=[agent_option],
    )
    write_note.add_argument("--object", dest="object_id", help="Canvas notes: the id of the Markdown text to replace (default: the first in reading order)")
    write_note.add_argument("note_id", type=int)
    write_note.add_argument("--text", help="The new Markdown; omit or use - to read standard input")
    write_note.add_argument("--revision", type=int, help="Fail if the note is no longer at this revision")
    write_note.set_defaults(handler=command_notes_write)
    create_note = note_commands.add_parser("create", help="Create a canvas, mind-map or page note", parents=[agent_option])
    create_note.add_argument("--title", required=True)
    create_note.add_argument("--notebook-id", type=int, help="Omit to leave the note in the Inbox")
    create_note.add_argument("--type", dest="note_type", choices=("canvas", "mindmap", "page"), default="canvas")
    create_note.add_argument("--text", help="Initial text (Markdown for a page); not valid for mind maps")
    create_note.set_defaults(handler=command_notes_create)
    move_note = note_commands.add_parser("move", help="File a note into a notebook, or back to the Inbox")
    move_note.add_argument("note_id", type=int)
    destination = move_note.add_mutually_exclusive_group(required=True)
    destination.add_argument("--notebook-id", type=int)
    destination.add_argument("--inbox", action="store_true", help="Unfile the note")
    move_note.set_defaults(handler=command_notes_move)
    update_note = note_commands.add_parser("update", help="Change a note's icon (one emoji and a tint 1-5; 'none' goes back to the guess from its title)")
    update_note.add_argument("note_id", type=int)
    update_note.add_argument("--icon", required=True, type=note_icon_argument, help="One emoji, or none")
    update_note.add_argument("--tint", type=int, choices=(1, 2, 3, 4, 5), help="Tint of the icon's tile; omit to let the app pick one for the emoji")
    update_note.add_argument("--revision", type=int, help="Fail if the note is no longer at this revision")
    update_note.set_defaults(handler=command_notes_update)
    delete_note = note_commands.add_parser("delete", help="Delete a note")
    delete_note.add_argument("note_id", type=int)
    delete_note.set_defaults(handler=command_notes_delete)

    search = subcommands.add_parser("search", help="Search note titles and content", parents=[agent_option])
    search.add_argument("query")
    search.add_argument("--meaning", action="store_true", help="Find notes by what they mean, not their words (needs search by meaning, downloaded in the app's Settings); each match has a score")
    search.add_argument("--text", dest="as_text", action="store_true", help="Print one readable line per match instead of JSON")
    search.set_defaults(handler=command_search)

    export = subcommands.add_parser("export", help="Export user-owned workspace data")
    export_commands = export.add_subparsers(dest="export_command", required=True)
    workspace = export_commands.add_parser("workspace", help="Write a lossless workspace backup")
    workspace.add_argument("--output", help="Output JSON file; omit to write JSON to stdout")
    workspace.set_defaults(handler=command_export_workspace)
    markdown = export_commands.add_parser("markdown", help="Write a readable Markdown ZIP")
    markdown.add_argument("--output", required=True)
    markdown.set_defaults(handler=command_export_markdown)
    vault = export_commands.add_parser("vault", help="Write an Obsidian vault folder (.canvas files + attachments); never overwrites")
    vault.add_argument("--output", required=True, help="Folder to write into (created if missing; must not contain files of the same names)")
    vault.set_defaults(handler=command_export_vault)

    imported = subcommands.add_parser("import", help="Merge a lossless workspace backup")
    imported.add_argument("input", help="Workspace backup JSON file")
    imported.set_defaults(handler=command_import)

    import_vault = subcommands.add_parser("import-vault", help="Import an Obsidian vault folder or ZIP (.canvas and .md files) as new notes")
    import_vault.add_argument("input", help="Vault folder or ZIP archive")
    import_vault.set_defaults(handler=command_import_vault)

    migrate = subcommands.add_parser(
        "migrate-data",
        help="Copy this checkout's data/personal-note.db into the app-data folder (never deletes or moves the original)",
    )
    migrate.add_argument("--from", dest="source", help="Legacy database (default: data/personal-note.db in this checkout)")
    migrate.add_argument("--to", dest="destination", help="Destination database (default: the app-data folder)")
    migrate.add_argument("--force-merge", action="store_true", help="Merge again even though this checkout was already migrated to the destination")
    migrate.add_argument("--yes", action="store_true", help="Continue even if a Personal Note server is answering on HOST:PORT")
    migrate.set_defaults(handler=command_migrate_data, needs_service=False)

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


def icon_argument(value: str) -> str:
    from notebook_icon import valid_icon
    if not valid_icon(value):
        raise argparse.ArgumentTypeError("use lucide:<name>, brand:x or emoji:<one emoji>")
    return value


def note_icon_argument(value: str) -> str:
    from note_icon import is_chosen_icon
    if value != "none" and not is_chosen_icon(value):
        raise argparse.ArgumentTypeError("use one emoji, or none")
    return "" if value == "none" else value


def command_notebooks_list(service: NoteService, _args: argparse.Namespace) -> list[dict]:
    return service.list_notebooks()


def command_notebooks_create(service: NoteService, args: argparse.Namespace) -> dict:
    return service.create_notebook({"name": args.name, "color": args.color, "category": args.category, "icon": args.icon})


def command_notes_list(service: NoteService, _args: argparse.Namespace) -> list[dict]:
    return service.list_notes()


def agent_view(note: dict) -> dict:
    """A secure note's words never reach an agent: it sees the title and that the note is locked."""
    if note.get("secure"):
        return {**note, "content": None, "pageState": None, "locked": True}
    return note


def command_notes_get(service: NoteService, args: argparse.Namespace) -> dict:
    note = agent_view(service.get_note(args.note_id))
    service.record_agent_activity(args.agent, note["id"], "reading")
    return note


def command_notes_read(service: NoteService, args: argparse.Namespace) -> dict | None:
    note = service.get_note(args.note_id)
    if note.get("secure"):
        raise CliError("This is a secure note: agents cannot read or write it")
    service.record_agent_activity(args.agent, note["id"], "reading")
    text = note_plain_text(note)
    if args.as_text:
        print_text(text)
        return None
    return {
        "id": note["id"],
        "title": note["title"],
        "noteType": note["noteType"],
        "notebookId": note["notebookId"],
        "revision": note["revision"],
        "updatedAt": note["updatedAt"],
        "text": text,
    }


def command_notes_append(service: NoteService, args: argparse.Namespace) -> dict:
    text = args.text if args.text not in (None, "-") else read_stdin_text()
    with service.as_agent(args.agent):
        result = service.append_text(args.note_id, text, revision=args.revision)
    service.record_agent_activity(args.agent, args.note_id, "writing")
    return result


def command_notes_write(service: NoteService, args: argparse.Namespace) -> dict:
    text = args.text if args.text not in (None, "-") else read_stdin_text()
    with service.as_agent(args.agent):
        if service.get_note(args.note_id)["noteType"] == "canvas":
            result = service.write_canvas_text(args.note_id, text, object_id=args.object_id, revision=args.revision)
        else:
            result = service.write_page(args.note_id, text, revision=args.revision)
    service.record_agent_activity(args.agent, args.note_id, "writing")
    return result


def command_notes_create(service: NoteService, args: argparse.Namespace) -> dict:
    if args.note_type == "mindmap":
        PluginSettings().require("mindmap")
    if args.note_type == "mindmap" and args.text is not None:
        raise CliError("--text is only supported for canvas notes")
    payload: dict[str, Any] = {"title": args.title, "noteType": args.note_type}
    if args.notebook_id is not None:
        payload["notebookId"] = args.notebook_id
    note = service.create_note(payload)
    if args.text is not None:
        service.append_text(note["id"], args.text, revision=note["revision"])
        note = service.get_note(note["id"])
    service.record_agent_activity(args.agent, note["id"], "writing")
    return note


def command_notes_move(service: NoteService, args: argparse.Namespace) -> dict:
    return service.move_note(args.note_id, {"notebookId": None if args.inbox else args.notebook_id})


def command_notes_update(service: NoteService, args: argparse.Namespace) -> dict:
    service.refuse_agent_on_secure(args.note_id)  # a secure note is the app's alone, as for every other agent write
    payload = {"icon": args.icon, "tint": args.tint or 0}
    if args.revision is not None:
        payload["revision"] = args.revision
    return service.set_note_icon(args.note_id, payload)


def command_notes_delete(service: NoteService, args: argparse.Namespace) -> dict:
    service.refuse_agent_on_secure(args.note_id)  # agents never delete a secure note (the app can)
    service.delete_note(args.note_id)
    return {"ok": True, "id": args.note_id}


def search_engine(database: Path) -> SearchRuntime:
    """This command's own handle on the search-by-meaning engine. It has its own pid file (named for this process), so starting its engine
    never stops the running app's or another command's; engines left by commands that died are cleaned up first."""
    root = default_search_runtime(database).root
    reap_dead_cli_engines(root)
    return default_search_runtime(database, pid_name=f"engine-cli-{os.getpid()}.pid")


def running_app(database: Path) -> str | None:
    """The address of the app when it is running on this very database (its /health names the file), else None."""
    try:
        base = check_existing_server(env_setting("HOST", "127.0.0.1"), int(env_setting("PORT", "3137")))
        if base is None:
            return None
        with urlopen(f"{base}/health", timeout=1) as response:
            health = json.load(response)
    except (RuntimeError, OSError, ValueError):
        return None
    return base if health.get("database") == str(Path(database).resolve()) else None


NOT_INSTALLED = "Search by meaning is not installed. Download it in the app's Settings."


def meaning_from_app(base: str, query: str) -> list[dict] | None:
    """What the running app says (it already has the engine and the index); None when it cannot be asked."""
    try:
        with urlopen(f"{base}/api/search/meaning?{urlencode({'q': query, 'limit': 5, 'strict': 1})}", timeout=120) as response:
            matches = json.load(response)
        if not matches:  # the app answers [] both for "nothing matches" and "not installed"
            with urlopen(f"{base}/api/search-meaning/status", timeout=5) as response:
                if json.load(response).get("state") != "ready":
                    raise CliError(NOT_INSTALLED)
        return matches
    except HTTPError as error:
        if error.code == 503:  # the app's engine is down: say so, as the command's own engine would
            try:
                raise CliError(json.load(error)["error"]) from error
            except (ValueError, KeyError):
                raise CliError("The search engine did not answer. Try again.") from error
        return None
    except (OSError, ValueError):
        return None


def meaning_matches(service: NoteService, query: str) -> list[dict]:
    asked = running_app(service.database_path)
    if asked and (matches := meaning_from_app(asked, query)) is not None:
        return matches
    engine = search_engine(service.database_path)
    try:
        if not engine.installed():
            raise CliError(NOT_INSTALLED)
        service.embedder = engine
        return service.meaning_matches(query)
    except SearchError as error:
        raise CliError(str(error)) from error
    finally:
        engine.shutdown()


def command_search(service: NoteService, args: argparse.Namespace) -> list[dict] | None:
    if args.meaning:
        PluginSettings().require("meaning")  # off: exit 2 with the reason, before any engine or app is asked
    matches = meaning_matches(service, args.query) if args.meaning else service.search(args.query)
    service.record_agent_activity(args.agent, None, "reading")
    if not args.as_text:
        return matches
    for match in matches:
        if args.meaning:
            print_text(f"#{match['id']} {match['title']} [{match['notebookName']}] - {match['score']:.2f}")
            continue
        excerpt = " ".join(match["excerpt"].split())
        print_text(f"#{match['id']} {match['title']} [{match['notebookName']}]" + (f" - {excerpt}" if excerpt else ""))
    return None


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


def command_export_vault(service: NoteService, args: argparse.Namespace) -> dict:
    try:
        return export_vault_directory(service, args.output)
    except OSError as error:
        raise CliError(f"Cannot write {args.output}: {error}") from error


def command_import_vault(service: NoteService, args: argparse.Namespace) -> dict:
    source = Path(args.input)
    try:
        if source.is_file():
            return import_vault_archive(service, source.read_bytes())
        return import_vault_directory(service, source)
    except OSError as error:
        raise CliError(f"Cannot read {args.input}: {error}") from error


def command_migrate_data(_service: None, args: argparse.Namespace) -> dict:
    source = Path(args.source) if args.source else LEGACY_DATABASE
    destination = Path(args.destination) if args.destination else app_data_dir() / DATABASE_FILENAME
    return migrate_legacy_database(
        source,
        destination,
        force_merge=args.force_merge,
        server_host=probe_host(env_setting("HOST", "127.0.0.1")),
        server_port=int(env_setting("PORT", "3137")),
        allow_running_server=args.yes,
    )


def command_plugins_inspect(_service: NoteService, args: argparse.Namespace) -> dict:
    manifest = parse_plugin_manifest(read_json(args.manifest))
    return {"ok": True, "manifest": manifest.as_dict(), "execution": "not-supported"}


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        service = NoteService(database_path(args.database)) if getattr(args, "needs_service", True) else None
        result = args.handler(service, args)
        if result is not None:
            emit(result)
        return 0
    except (CliError, SecureError, NotFoundError, ConflictError, UnsupportedNoteTypeError, AppendTextError, InvalidNoteContentError, PortabilityError, PortabilityVaultError, WorkspaceImportError, PluginManifestError, PluginSettingsError, MigrationError) as error:
        emit({"ok": False, "error": str(error)})
        return 2
    except Exception:
        emit({"ok": False, "error": "Command failed"})
        return 1


if __name__ == "__main__":
    sys.exit(main())
