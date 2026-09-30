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
    clear_instance,
    focus_running_instance,
    frontend_is_stale,
    instance_file,
    record_instance,
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
            record_instance(db, base_url)
            self.assertEqual(focus_running_instance(db), base_url)
            deadline = time.time() + 2
            while not focused and time.time() < deadline:
                time.sleep(0.02)
            self.assertEqual(focused, [True])
        finally:
            server.stop()

    def test_no_record_means_no_running_instance(self):
        self.assertIsNone(focus_running_instance(self.root / "n.db"))

    def test_stale_record_is_ignored(self):
        db = self.root / "n.db"
        record_instance(db, "http://127.0.0.1:9")
        self.assertIsNone(focus_running_instance(db))

    def test_clear_instance_removes_only_the_record(self):
        db = self.root / "n.db"
        db.write_bytes(b"notes")
        record_instance(db, "http://127.0.0.1:9")
        clear_instance(db)
        self.assertFalse(instance_file(db).exists())
        self.assertEqual(db.read_bytes(), b"notes")


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


if __name__ == "__main__":
    unittest.main()
