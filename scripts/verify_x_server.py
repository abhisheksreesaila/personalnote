"""The app wired to a fake X, for scripts/verify-x-bookmarks.mjs (never for real use).

Starts the fake X from tests/test_x_bookmarks.py, a tiny control server to add bookmarks to it, and the real app (create_app) with an
XSync that talks to the fake and "opens the browser" by following the authorize link itself. Everything comes from the environment:
PERSONAL_NOTE_DB, PN_X_FOLDER (token and client id files), PN_X_API_PORT, PN_X_CONTROL_PORT, PN_X_CALLBACK_PORT, PN_X_POSTS (how many
bookmarks to start with, once), PN_X_FIRST_DELAY (seconds before the first automatic sync).
Control: POST /add?text=... puts a new bookmark on top; GET /calls says how many bookmark calls X has seen.
"""

import json
import os
import sys
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import uvicorn  # noqa: E402

import x_bookmarks  # noqa: E402
from routes import close_search, create_app  # noqa: E402
from secret_store import SecretStore  # noqa: E402
from tests.test_x_bookmarks import FakeX, make_posts  # noqa: E402
from tests.test_x_sync import follow  # noqa: E402
from x_sync import XSync  # noqa: E402

folder = Path(os.environ["PN_X_FOLDER"])
state_file = folder / "fake-posts.json"
posts = json.loads(state_file.read_text()) if state_file.exists() else make_posts(int(os.environ.get("PN_X_POSTS", "5")))
fake = FakeX(posts)
state_file.write_text(json.dumps(posts))


class AnyToken(set):
    """A restart forgets the fake's tokens; the real rotation is covered by the unit tests, so here every token is good."""

    def __contains__(self, item):
        return True


fake.access, fake.refresh = AnyToken(), AnyToken()


class Control(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        query = {k: v[0] for k, v in urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query).items()}
        n = 2000 + len(fake.posts)
        fake.posts.insert(0, {"id": str(n), "text": query.get("text", f"new post {n}"), "author_id": "u1", "created_at": "2026-03-01T10:00:00.000Z"})
        state_file.write_text(json.dumps(fake.posts))
        self.reply({"posts": len(fake.posts)})

    def do_GET(self):
        self.reply({"bookmarkCalls": len(fake.bookmark_calls)})

    def reply(self, body):
        raw = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


control = ThreadingHTTPServer(("127.0.0.1", int(os.environ["PN_X_CONTROL_PORT"])), Control)
threading.Thread(target=control.serve_forever, daemon=True).start()

sync = XSync(
    None,
    token_store=x_bookmarks.default_token_store("linux", folder),
    client_id_secret=SecretStore("id", "x-client-id", platform="linux", folder=folder),
    open_browser=follow,
    client_options={"authorize_url": f"{fake.base}/authorize", "api_base": f"{fake.base}/2", "callback_port": int(os.environ["PN_X_CALLBACK_PORT"])},
    first_delay=float(os.environ.get("PN_X_FIRST_DELAY", "3600")),
)
app = create_app(os.environ["PERSONAL_NOTE_DB"], x_sync=sync)
sync.service = app.state.note_service
sync.start()
try:
    uvicorn.run(app, host="127.0.0.1", port=int(os.environ["PN_X_API_PORT"]), log_level="warning")
finally:
    close_search(app)
    fake.stop()
