import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from starlette.testclient import TestClient

import desktop
import routes
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
        for payload in ({"text": "", "data": {}}, {"text": "x"}, {"text": "x", "data": []}):
            response = self.client.post("/api/speedtest/report", json=payload, headers=HEADERS)
            self.assertEqual(response.status_code, 400, payload if len(str(payload)) < 100 else "oversized")
        self.assertFalse(self.results.exists())

class SpeedTestInstanceTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)

    def tearDown(self):
        self.directory.cleanup()

    def client(self, **options):
        return TestClient(create_app(self.root / "n.db", **options))

    def test_only_the_speed_test_instance_says_it_is_one(self):
        self.assertEqual(self.client().get("/api/speedtest/status").json(), {"instance": False})
        self.assertEqual(self.client(speedtest_instance=True).get("/api/speedtest/status").json(), {"instance": True})

    def test_the_persons_app_launches_a_separate_instance_and_never_runs_the_test_itself(self):
        launched = []
        client = self.client(speedtest_launcher=lambda: launched.append(1))
        self.assertEqual(client.post("/api/speedtest/launch").status_code, 403)
        self.assertEqual(client.post("/api/speedtest/launch", headers=HEADERS).status_code, 202)
        self.assertEqual(launched, [1])

    def test_the_speed_test_instance_does_not_launch_another(self):
        launched = []
        client = self.client(speedtest_instance=True, speedtest_launcher=lambda: launched.append(1))
        self.assertEqual(client.post("/api/speedtest/launch", headers=HEADERS).status_code, 409)
        self.assertEqual(launched, [])

    def test_a_launcher_that_cannot_start_is_reported(self):
        def broken():
            raise OSError("no")

        self.assertEqual(self.client(speedtest_launcher=broken).post("/api/speedtest/launch", headers=HEADERS).status_code, 500)

    def test_the_command_the_app_runs_is_the_desktop_script_with_the_speedtest_flag(self):
        with mock.patch("routes.subprocess.Popen") as popen:
            routes.launch_speedtest_instance()
        command = popen.call_args.args[0]
        self.assertIn("--speedtest", command)
        self.assertTrue(any(str(part).endswith("desktop.py") for part in command))


def run_main(arguments, voice):
    app = mock.Mock()
    app.state.voice = voice
    server = mock.Mock(fell_back=False, nonce="n")
    server.start.return_value = "http://127.0.0.1:1"
    with mock.patch("routes.create_app", return_value=app) as create, mock.patch.object(desktop, "LocalServer", return_value=server), \
            mock.patch.object(desktop, "choose_engine", return_value=("webview", None)), mock.patch.object(desktop, "ensure_frontend_built"), \
            mock.patch.object(desktop, "run_window") as window, mock.patch.object(desktop, "record_instance"), mock.patch.object(desktop, "clear_instance"), \
            mock.patch.object(desktop, "focus_running_instance", return_value=None), mock.patch.object(desktop, "finish_speedtest"), \
            mock.patch.object(desktop, "default_database_path", side_effect=lambda: Path(os.environ.get("PERSONAL_NOTE_DB") or Path(tempfile.gettempdir()) / "x.db")), \
            mock.patch.dict(os.environ, {}, clear=False):
        desktop.main(arguments)
        voice_dir = os.environ.get("PERSONAL_NOTE_VOICE_DIR", "")
        os.environ.pop("PERSONAL_NOTE_DB", None)
        os.environ.pop("PERSONAL_NOTE_VOICE_DIR", None)
    return create, window, voice_dir


class SpeedTestVoiceTests(unittest.TestCase):
    def test_the_speed_test_never_starts_stops_or_shares_the_real_apps_voice_engine(self):
        voice = mock.Mock()
        create, window, voice_dir = run_main(["--speedtest"], voice)
        voice.autostart.assert_not_called()
        voice.shutdown.assert_not_called()
        self.assertEqual(create.call_args.kwargs.get("speedtest_instance"), True)
        self.assertIn("personal-note-speedtest-", voice_dir)
        storage = str(window.call_args.kwargs["storage"])
        self.assertIn("personal-note-speedtest-", storage)
        self.assertNotIn(str(desktop.app_data_dir()), storage)
        self.assertEqual(window.call_args.kwargs["query"], desktop.SPEEDTEST_QUERY)

    def test_an_ordinary_launch_still_starts_and_stops_the_voice_engine(self):
        voice = mock.Mock()
        create, window, _ = run_main([], voice)
        voice.autostart.assert_called_once()
        voice.shutdown.assert_called_once()
        self.assertFalse(create.call_args.kwargs.get("speedtest_instance"))
        self.assertNotIn("storage", window.call_args.kwargs)


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
