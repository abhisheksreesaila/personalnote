import json
import os
import tempfile
import time
import unittest
from pathlib import Path
from urllib.error import URLError
from urllib.request import Request, urlopen

from desktop import (
    LocalServer,
    MISSING_CHROMIUM,
    report_startup_error,
    EMPTY_NOTICE,
    clear_instance,
    empty_notebook_notice,
    flush_page,
    focus_running_instance,
    frontend_is_stale,
    instance_file,
    record_instance,
    window_url,
)
from routes import create_app


class TempDirCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)


class LocalServerTests(TempDirCase):
    def test_serves_the_app_on_a_free_loopback_port_and_stops_cleanly(self):
        server = LocalServer(create_app(self.root / "n.db"))
        base_url = server.start()
        self.assertTrue(base_url.startswith("http://127.0.0.1:"))
        with urlopen(f"{base_url}/health", timeout=2) as response:
            self.assertEqual(json.load(response)["app"], "personal-note")
        server.stop()
        with self.assertRaises((URLError, OSError)):
            urlopen(f"{base_url}/health", timeout=1)

    def test_two_servers_get_different_ports(self):
        first = LocalServer(create_app(self.root / "a.db"))
        second = LocalServer(create_app(self.root / "b.db"))
        try:
            self.assertNotEqual(first.start(), second.start())
        finally:
            first.stop()
            second.stop()

    def test_stop_before_start_is_harmless(self):
        LocalServer(create_app(self.root / "n.db")).stop()


class SingleInstanceTests(TempDirCase):
    def test_focus_reaches_a_running_instance(self):
        focused = []
        app = create_app(self.root / "n.db")
        server = LocalServer(app, on_focus=lambda: focused.append(True))
        base_url = server.start()
        db = self.root / "n.db"
        try:
            record_instance(db, base_url, server.nonce)
            self.assertEqual(focus_running_instance(db), base_url)
            deadline = time.time() + 2
            while not focused and time.time() < deadline:
                time.sleep(0.02)
            self.assertEqual(focused, [True])
        finally:
            server.stop()

    def test_focus_without_the_nonce_is_refused(self):
        focused = []
        server = LocalServer(create_app(self.root / "n.db"), on_focus=lambda: focused.append(True))
        base_url = server.start()
        db = self.root / "n.db"
        try:
            record_instance(db, base_url, "not-the-nonce")
            self.assertIsNone(focus_running_instance(db))
            request = Request(base_url + "/_desktop/focus", method="POST")
            with self.assertRaises(URLError) as refused:
                urlopen(request, timeout=2)
            refused.exception.close()
            time.sleep(0.1)
            self.assertEqual(focused, [])
        finally:
            server.stop()

    def test_no_record_means_no_running_instance(self):
        self.assertIsNone(focus_running_instance(self.root / "n.db"))

    def test_stale_record_is_ignored(self):
        db = self.root / "n.db"
        record_instance(db, "http://127.0.0.1:9", "n")
        self.assertIsNone(focus_running_instance(db))

    def test_instance_record_is_private_from_the_start(self):
        db = self.root / "n.db"
        record_instance(db, "http://127.0.0.1:9", "n")
        self.assertEqual(instance_file(db).stat().st_mode & 0o777, 0o600 if os.name != "nt" else instance_file(db).stat().st_mode & 0o777)

    def test_clear_instance_removes_only_the_record(self):
        db = self.root / "n.db"
        db.write_bytes(b"notes")
        record_instance(db, "http://127.0.0.1:9", "n")
        clear_instance(db)
        self.assertFalse(instance_file(db).exists())
        self.assertEqual(db.read_bytes(), b"notes")


class FakeWindow:
    def __init__(self, results):
        self.results = list(results)
        self.scripts = []

    def evaluate_js(self, script):
        self.scripts.append(script)
        if script == "window.__flushResult" and self.results:
            return self.results.pop(0)
        return None


class FlushPageTests(unittest.TestCase):
    def test_returns_true_once_the_page_reports_everything_saved(self):
        window = FakeWindow([None, None, 1])
        self.assertTrue(flush_page(window, timeout=2))

    def test_returns_false_when_the_page_reports_unsaved_edits(self):
        self.assertFalse(flush_page(FakeWindow([0]), timeout=2))

    def test_gives_up_after_the_timeout(self):
        started = time.monotonic()
        self.assertFalse(flush_page(FakeWindow([]), timeout=0.2))
        self.assertLess(time.monotonic() - started, 1.5)

    def test_a_broken_window_never_raises(self):
        class Broken:
            def evaluate_js(self, script):
                raise RuntimeError("gone")

        self.assertFalse(flush_page(Broken(), timeout=0.2))


class EmptyNoticeTests(TempDirCase):
    def test_missing_or_untouched_database_gets_the_notice(self):
        from services import NoteService

        db = self.root / "n.db"
        self.assertEqual(empty_notebook_notice(db), EMPTY_NOTICE)
        service = NoteService(db)
        self.assertEqual(empty_notebook_notice(db), EMPTY_NOTICE)
        service.create_note({"title": "Untitled note", "noteType": "canvas"})
        self.assertEqual(empty_notebook_notice(db), EMPTY_NOTICE)

    def test_a_notebook_with_real_notes_gets_no_notice(self):
        from services import NoteService

        db = self.root / "n.db"
        NoteService(db).create_note({"title": "Groceries", "noteType": "canvas"})
        self.assertIsNone(empty_notebook_notice(db))


class FrontendBuildTests(TempDirCase):
    def project(self):
        (self.root / "src").mkdir()
        (self.root / "src" / "main.js").write_text("a")
        (self.root / "index.html").write_text("a")
        (self.root / "dist").mkdir()
        (self.root / "dist" / "index.html").write_text("built")
        return self.root

    def set_mtime(self, path, when):
        os.utime(path, (when, when))

    def test_missing_dist_is_stale(self):
        (self.root / "index.html").write_text("a")
        self.assertTrue(frontend_is_stale(self.root))

    def test_fresh_dist_is_not_stale(self):
        root = self.project()
        now = time.time()
        self.set_mtime(root / "src" / "main.js", now - 100)
        self.set_mtime(root / "index.html", now - 100)
        self.set_mtime(root / "dist" / "index.html", now)
        self.assertFalse(frontend_is_stale(root))

    def test_newer_source_makes_dist_stale(self):
        root = self.project()
        now = time.time()
        self.set_mtime(root / "dist" / "index.html", now - 100)
        self.set_mtime(root / "src" / "main.js", now)
        self.assertTrue(frontend_is_stale(root))


class StartupErrorTests(unittest.TestCase):
    def which(self, *present):
        return lambda name: f"/usr/bin/{name}" if name in present else None

    def test_uses_a_desktop_notification_when_available(self):
        calls = []
        used = report_startup_error("boom", which=self.which("notify-send", "zenity"), run=lambda c, **k: calls.append(c))
        self.assertEqual(used, "notify-send")
        self.assertEqual(calls[0][0], "/usr/bin/notify-send")
        self.assertIn("boom", calls[0])

    def test_falls_back_to_a_dialog(self):
        calls = []
        self.assertEqual(report_startup_error("boom", which=self.which("zenity"), run=lambda c, **k: calls.append(c)), "zenity")
        calls.clear()
        self.assertEqual(report_startup_error("boom", which=self.which("kdialog"), run=lambda c, **k: calls.append(c)), "kdialog")

    def test_without_any_tool_it_only_writes_to_stderr(self):
        import io
        from contextlib import redirect_stderr

        err = io.StringIO()
        with redirect_stderr(err):
            self.assertIsNone(report_startup_error("boom", which=self.which(), run=lambda c, **k: self.fail("no tool")))
        self.assertIn("boom", err.getvalue())

    def test_a_failing_tool_never_raises(self):
        def broken(c, **k):
            raise OSError("no display")

        self.assertIsNone(report_startup_error("boom", which=self.which("notify-send"), run=broken))


class MissingChromiumTests(TempDirCase):
    def run_main(self, frozen, platform):
        import io
        from contextlib import redirect_stderr
        from unittest import mock

        import desktop

        shown = []
        err = io.StringIO()
        with mock.patch.dict("os.environ", {"PERSONAL_NOTE_DB": str(self.root / "n.db")}), \
                mock.patch.object(desktop.sys, "frozen", frozen, create=True), \
                mock.patch.object(desktop.sys, "platform", platform), \
                mock.patch.object(desktop, "focus_running_instance", return_value=None), \
                mock.patch.object(desktop, "choose_engine", return_value=("webview", None)), \
                mock.patch.object(desktop, "report_startup_error", side_effect=shown.append), \
                mock.patch.object(desktop, "LocalServer") as server, \
                redirect_stderr(err):
            code = desktop.main(["--no-build"])
        return code, shown, server

    def test_the_packaged_linux_app_stops_before_starting_a_server_and_says_why(self):
        code, shown, server = self.run_main(True, "linux")
        self.assertEqual(code, 1)
        self.assertEqual(shown, [MISSING_CHROMIUM])
        server.assert_not_called()


class SessionKeyLocationTests(TempDirCase):
    def test_the_session_key_is_kept_beside_the_database_not_in_the_working_directory(self):
        # Launched from a menu the working directory is the home folder or / (not writable in a bundle).
        work = self.root / "cwd"
        work.mkdir()
        previous = os.getcwd()
        os.chdir(work)
        try:
            create_app(self.root / "data" / "n.db")
        finally:
            os.chdir(previous)
        self.assertFalse((work / ".sesskey").exists())
        self.assertTrue((self.root / "data" / ".sesskey").exists())


class ServeOnlyTests(TempDirCase):
    def test_serve_runs_the_app_without_a_window_until_told_to_stop(self):
        import signal
        import subprocess
        import sys

        env = {**os.environ, "PERSONAL_NOTE_DB": str(self.root / "n.db"), "XDG_DATA_HOME": str(self.root / "xdg")}
        root = Path(__file__).resolve().parent.parent
        process = subprocess.Popen(
            [sys.executable, str(root / "desktop.py"), "--serve", "--port", "0", "--no-build"],
            cwd=self.root, env=env, stdout=subprocess.PIPE, text=True,
        )
        try:
            line = process.stdout.readline().strip()
            self.assertTrue(line.startswith("Serving on http://127.0.0.1:"), line)
            url = line.removeprefix("Serving on ")
            with urlopen(f"{url}/health", timeout=3) as response:
                self.assertEqual(json.load(response)["app"], "personal-note")
            process.send_signal(signal.SIGTERM)
            self.assertEqual(process.wait(timeout=10), 0)
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()
            process.stdout.close()
        self.assertFalse(instance_file(self.root / "n.db").exists())


class VoiceLifecycleTests(TempDirCase):
    def pid_alive(self, pid):
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return False
        return True

    def test_an_installed_engine_starts_with_the_app_and_stops_when_it_closes(self):
        import signal
        import subprocess
        import sys

        import voice_runtime
        from tests.test_voice import FAKE_ENGINE

        voice = self.root / "voice"
        (voice / "engine" / "bin").mkdir(parents=True)
        engine = voice / "engine" / "bin" / voice_runtime.ENGINE_BINARY
        engine.write_text(FAKE_ENGINE)
        engine.chmod(0o755)
        (voice / "models").mkdir()
        with open(voice / "models" / voice_runtime.MODEL_FILE, "wb") as handle:
            handle.truncate(voice_runtime.MODEL_BYTES)  # sparse: the fake engine never reads it
        (voice / "installed.json").write_text(json.dumps({"model": {"sha256": voice_runtime.MODEL_SHA256}}))

        env = {
            **os.environ, "PERSONAL_NOTE_DB": str(self.root / "n.db"), "XDG_DATA_HOME": str(self.root / "xdg"),
            "PERSONAL_NOTE_VOICE_DIR": str(voice),
        }
        root = Path(__file__).resolve().parent.parent
        process = subprocess.Popen(
            [sys.executable, str(root / "desktop.py"), "--serve", "--port", "0", "--no-build"],
            cwd=self.root, env=env, stdout=subprocess.PIPE, text=True,
        )
        engine_pid = None
        try:
            url = process.stdout.readline().strip().removeprefix("Serving on ")
            status = {}
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline and not status.get("running"):
                with urlopen(f"{url}/api/voice/status", timeout=3) as response:
                    status = json.load(response)
                time.sleep(0.1)
            self.assertTrue(status["running"], status)
            self.assertTrue(status["endpoint"].startswith("ws://127.0.0.1:"))
            engine_pid = int(subprocess.check_output(["pgrep", "-f", str(engine)], text=True).split()[0])
            process.send_signal(signal.SIGTERM)
            self.assertEqual(process.wait(timeout=15), 0)
            time.sleep(0.3)
            self.assertFalse(self.pid_alive(engine_pid), "the engine stops with the app")
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()
            process.stdout.close()
            if engine_pid and self.pid_alive(engine_pid):
                os.kill(engine_pid, signal.SIGKILL)


class WindowUrlTests(unittest.TestCase):
    def test_desktop_window_tells_the_page_it_is_the_desktop_app(self):
        self.assertEqual(window_url("http://127.0.0.1:5000", "linux"), "http://127.0.0.1:5000/notes?host=desktop")


if __name__ == "__main__":
    unittest.main()
