"""Seeds a scratch database for scripts/verify-note-links.mjs (F-095). Usage: PERSONAL_NOTE_DB=<scratch> python scripts/verify_note_links_seed.py

Notebooks Travel and Reading; notes: Lisbon trip, Hub (canvas), Reading list (page), a note whose title and words are HTML, a secure note
(locked in the app's own process, which has never unlocked it) and two X bookmarks.
"""
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services import NoteService  # noqa: E402

path = Path(os.environ["PERSONAL_NOTE_DB"])
service = NoteService(path)
travel = service.create_notebook({"name": "Travel", "color": "#4D839C", "category": "projects"})
reading = service.create_notebook({"name": "Reading", "color": "#6F8C63", "category": "areas"})


def page(title, markdown, notebook):
    note = service.create_note({"title": title, "noteType": "page", "notebookId": notebook["id"]})
    service.update_note(note["id"], {"title": title, "revision": note["revision"], "content": {"version": 1, "markdown": markdown, "ink": {"marks": [], "drawings": []}}})
    return service.get_note(note["id"])


lisbon = page("Lisbon trip", "# Lisbon\n\nHarbour walk at dusk\n\nBuy tickets\n\nPack the camera", travel)
service.create_note({"title": "Hub", "noteType": "canvas", "notebookId": travel["id"]})
page("Reading list", "First line of the reading list.\n\nSecond line, where a link can go.\n\nThird line.", reading)
page("<img src=x onerror=\"window.__pwned=1\"> sneaky", "<img src=x onerror=\"window.__pwned=1\"> <script>window.__pwned=2</script> words", reading)
secret = page("Card numbers", "ZEBRA-4111-1111-1111-1111 never shown", reading)
service.mark_secure(secret["id"], passphrase="correct horse battery")
service.import_x_bookmarks([
    {"id": "9001", "url": "https://x.com/ada/status/9001", "author_handle": "ada", "author_name": "Ada Lovelace", "text": "First bookmark about engines", "created_at": "2026-10-01T10:00:00.000Z"},
    {"id": "9002", "url": "https://x.com/bob/status/9002", "author_handle": "bob", "author_name": "Bob", "text": "Second bookmark about looms", "created_at": "2026-10-02T10:00:00.000Z"},
])
print(json.dumps({"lisbon": lisbon["resourceId"]}))
