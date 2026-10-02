import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from starlette.testclient import TestClient

import desktop
from routes import create_app

HEADERS = {"x-personal-note": "1"}


class SpeedTestReportTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        root = Path(self.directory.name)
        self.results = root / "results"
        self.environment = mock.patch.dict(os.environ, {"PERSONAL_NOTE_SPEEDTEST_DIR": str(self.results)})
        self.environment.start()
        self.client = TestClient(create_app(root / "personal-note.db"))

    def tearDown(self):
        self.client.close()
        self.environment.stop()
        self.directory.cleanup()

    def test_the_report_is_saved_as_text_and_json_and_the_paths_come_back(self):
        data = {"when": "2026-10-02T10:00:00.000Z", "results": [{"name": "Pan", "p50": 16.7, "p95": 16.8, "max": 33.4}]}
        response = self.client.post("/api/speedtest/report", json={"text": "Personal Note speed test\nPan 16.7", "data": data}, headers=HEADERS)
        self.assertEqual(response.status_code, 201)
        body = response.json()
        text_path = Path(body["path"])
        json_path = Path(body["jsonPath"])
        self.assertEqual(text_path.parent, self.results)
        self.assertEqual(text_path.read_text(encoding="utf-8"), "Personal Note speed test\nPan 16.7\n")
        self.assertEqual(json.loads(json_path.read_text(encoding="utf-8")), data)

    def test_two_reports_in_the_same_second_do_not_overwrite_each_other(self):
        payload = {"text": "one", "data": {"n": 1}}
        first = self.client.post("/api/speedtest/report", json=payload, headers=HEADERS).json()
        second = self.client.post("/api/speedtest/report", json=payload, headers=HEADERS).json()
        self.assertNotEqual(first["path"], second["path"])
        self.assertEqual(len(list(self.results.glob("*.txt"))), 2)

    def test_a_request_not_from_the_app_is_refused_and_writes_nothing(self):
        response = self.client.post("/api/speedtest/report", json={"text": "x", "data": {}})
        self.assertEqual(response.status_code, 403)
        self.assertFalse(self.results.exists())

    def test_an_empty_or_oversized_report_is_refused(self):
        for payload in ({"text": "", "data": {}}, {"text": "x"}, {"text": "x" * 200_001, "data": {}}, {"text": "x", "data": []}):
            response = self.client.post("/api/speedtest/report", json=payload, headers=HEADERS)
            self.assertEqual(response.status_code, 400, payload if len(str(payload)) < 100 else "oversized")
        self.assertFalse(self.results.exists())


class SpeedTestWindowTests(unittest.TestCase):
    def test_the_temporary_notebook_goes_away_and_the_results_are_named(self):
        with tempfile.TemporaryDirectory() as results, mock.patch.dict(os.environ, {"PERSONAL_NOTE_SPEEDTEST_DIR": results}):
            folder = Path(tempfile.mkdtemp(prefix="personal-note-speedtest-"))
            (folder / "speedtest.db").write_text("x")
            started = 1000.0
            report = Path(results) / "speedtest-20261002-100000.txt"
            report.write_text("numbers")
            os.utime(report, (started + 5, started + 5))
            with mock.patch("builtins.print") as printed:
                desktop.finish_speedtest(folder, started)
            self.assertFalse(folder.exists())
            self.assertIn(str(report), printed.call_args.args[0])

    def test_a_folder_that_is_not_the_speed_tests_own_is_never_removed(self):
        with tempfile.TemporaryDirectory() as directory, mock.patch.dict(os.environ, {"PERSONAL_NOTE_SPEEDTEST_DIR": directory}):
            other = Path(tempfile.mkdtemp(prefix="my-notes-"))
            try:
                with mock.patch("builtins.print") as printed:
                    desktop.finish_speedtest(other, 0.0)
                self.assertTrue(other.exists())
                self.assertIn("did not finish", printed.call_args.args[0])
            finally:
                other.rmdir()


if __name__ == "__main__":
    unittest.main()
