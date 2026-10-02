"""Builds the CLI-written document fixtures (F-025) with the same code the agent CLI uses.

A temporary database, never the real one. The Fabric-format fixtures it builds on were generated once with Fabric 7.4.0 and are frozen
(see tests/fixtures/documents/README.md):

    .venv/bin/python scripts/generate_cli_fixture.py
"""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from services import NoteService  # noqa: E402

FIXTURES = ROOT / "tests" / "fixtures" / "documents"


def write(name: str, description: str, note: dict, source: str) -> None:
    payload = {
        "name": name,
        "description": description,
        "source": source,
        "pageState": note["pageState"],
        "content": note["content"],
    }
    (FIXTURES / f"{name}.json").write_text(json.dumps(payload, indent=1, ensure_ascii=False) + "\n")
    print(f"wrote {name} ({len(note['content']['objects'])} objects)")


def seed_ids() -> None:
    """Resource ids are random uuids; a counter makes the fixtures reproducible."""
    counter = iter(range(1, 10_000))
    NoteService.new_resource_id = staticmethod(lambda: f"res_{next(counter):032x}")


def main() -> None:
    seed_ids()
    with tempfile.TemporaryDirectory() as directory:
        service = NoteService(Path(directory) / "fixture.db")
        notebook_id = service.list_notebooks()[0]["id"]

        # A note made by the CLI: `notes create --text`, then two appends (the second one grows the pages).
        note_id = service.create_note({"title": "CLI note", "notebookId": notebook_id})["id"]
        service.append_text(note_id, "Keep a searchable local idea")
        service.append_text(note_id, "Second thought\nwith two lines")
        service.append_text(note_id, "A long one. " * 120)
        write("cli-created", "A note written only by the CLI: three appended Textboxes, the last long enough to grow the page.", service.get_note(note_id), "NoteService.append_text")

        # A note drawn in the app and then appended to by an agent.
        app = json.loads((FIXTURES / "app-objects.json").read_text())
        created = service.create_note({"title": "App note plus agent", "notebookId": notebook_id})
        service.update_note(created["id"], {
            "title": created["title"],
            "notebookId": notebook_id,
            "revision": created["revision"],
            "content": app["content"],
            "pageState": app["pageState"],
        })
        service.append_text(created["id"], "Agent follow-up below the drawing")
        write("cli-appended", "The app-objects note with an agent's Textbox appended underneath.", service.get_note(created["id"]), "NoteService.append_text on app-objects")


if __name__ == "__main__":
    main()
