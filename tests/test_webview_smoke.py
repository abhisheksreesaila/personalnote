"""Loads the built app in the real system web view, with its window hidden, and saves an edit.

Regression guard for engines other than Chromium (the desktop window, and the macOS app's WebKit):
a WebView without localStorage once stopped the notebook from loading at all. Skipped where there is
no system web view, no display, or no built frontend. The web context is private on purpose, which is
what removes localStorage.
"""

import json
import os
import tempfile
import threading
import time
import unittest
from pathlib import Path
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parent.parent


def _web_view_available() -> str | None:
    if not (ROOT / "dist" / "index.html").is_file():
        return "frontend not built"
    if not (os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY")) and os.name != "nt" and os.uname().sysname != "Darwin":
        return "no display"
    try:
        import webview  # noqa: F401
    except ImportError:
        return "pywebview not installed"
    if os.name != "nt" and os.uname().sysname == "Linux":
        try:
            import gi

            gi.require_version("WebKit2", "4.1")
        except (ImportError, ValueError):
            return "WebKitGTK not available"
    return None


@unittest.skipIf(_web_view_available() is not None, _web_view_available() or "")
class WebViewSmokeTest(unittest.TestCase):
    def test_notebook_loads_and_an_edit_is_saved_by_the_page_flush(self):
        os.environ.setdefault("WEBKIT_DISABLE_DMABUF_RENDERER", "1")
        import webview

        from desktop import LocalServer, flush_page
        from routes import create_app

        with tempfile.TemporaryDirectory() as tmp:
            server = LocalServer(create_app(Path(tmp) / "smoke.db"))
            base_url = server.start()
            outcome: dict = {}
            window = webview.create_window("smoke", base_url + "/notes", hidden=True, width=1280, height=800)

            def drive():
                try:
                    deadline = time.monotonic() + 20
                    while time.monotonic() < deadline:
                        listed = window.evaluate_js("document.querySelectorAll('[data-note-id]').length")
                        if listed:
                            break
                        time.sleep(0.1)
                    outcome["listed"] = listed
                    outcome["storage"] = window.evaluate_js("typeof localStorage")
                    window.evaluate_js(
                        "const t = document.querySelector('#note-title'); t.value = 'Smoke title';"
                        "t.dispatchEvent(new Event('input', { bubbles: true })); 0"
                    )
                    outcome["flushed"] = flush_page(window)
                    with urlopen(f"{base_url}/api/notes", timeout=3) as response:
                        outcome["titles"] = [note["title"] for note in json.load(response)]
                except Exception as error:  # reported by the assertions below
                    outcome["error"] = repr(error)
                finally:
                    window.destroy()

            try:
                webview.start(drive)
            finally:
                server.stop()

        self.assertNotIn("error", outcome)
        self.assertTrue(outcome["listed"], "the notes list never rendered")
        self.assertTrue(outcome["flushed"])
        self.assertIn("Smoke title", outcome["titles"])


if __name__ == "__main__":
    unittest.main()
