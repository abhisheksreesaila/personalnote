import tempfile
import unittest
from unittest import mock
from pathlib import Path
from types import SimpleNamespace

from chromium_app import (
    chromium_command,
    find_chromium,
    focus_window,
    run_chromium_window,
    wait_for_idle,
)
from desktop import choose_engine


def which_from(*present):
    return lambda name: f"/usr/bin/{name}" if name in present else None


class DiscoveryTests(unittest.TestCase):
    def test_prefers_chromium_then_chrome_in_order(self):
        self.assertEqual(find_chromium(which_from("google-chrome", "chromium-browser")), "/usr/bin/chromium-browser")
        self.assertEqual(find_chromium(which_from("google-chrome", "google-chrome-stable")), "/usr/bin/google-chrome-stable")
        self.assertEqual(find_chromium(which_from("chromium", "google-chrome")), "/usr/bin/chromium")

    def test_none_when_no_binary(self):
        self.assertIsNone(find_chromium(which_from()))


class EngineChoiceTests(unittest.TestCase):
    def test_auto_uses_chromium_on_linux_when_found(self):
        self.assertEqual(choose_engine("auto", "linux", which_from("chromium")), ("chromium", "/usr/bin/chromium"))

    def test_auto_falls_back_to_webview(self):
        self.assertEqual(choose_engine("auto", "linux", which_from()), ("webview", None))

    def test_auto_stays_webview_on_mac_and_windows(self):
        self.assertEqual(choose_engine("auto", "darwin", which_from("chromium")), ("webview", None))
        self.assertEqual(choose_engine("auto", "win32", which_from("chromium")), ("webview", None))

    def test_explicit_webview_wins(self):
        self.assertEqual(choose_engine("webview", "linux", which_from("chromium")), ("webview", None))

    def test_explicit_chromium_without_a_binary_is_an_error(self):
        with self.assertRaises(Exception):
            choose_engine("chromium", "linux", which_from())


class CommandTests(unittest.TestCase):
    def test_command_line(self):
        command = chromium_command("/usr/bin/chromium", "http://127.0.0.1:5000/notes?host=desktop", Path("/data/chromium-profile"))
        self.assertEqual(command[0], "/usr/bin/chromium")
        self.assertIn("--app=http://127.0.0.1:5000/notes?host=desktop", command)
        self.assertIn("--user-data-dir=/data/chromium-profile", command)
        self.assertIn("--class=PersonalNote", command)


class FakeServer:
    def __init__(self, busy_polls=0):
        self.on_focus = None
        self.busy_polls = busy_polls
        self._server = SimpleNamespace(server_state=SimpleNamespace(tasks=set()))
        self.polls = 0


class IdleWaitTests(unittest.TestCase):
    def clock(self):
        now = [0.0]
        return now, (lambda: now[0]), (lambda seconds: now.__setitem__(0, now[0] + seconds))

    def test_waits_the_settle_time_even_when_idle(self):
        now, clock, sleep = self.clock()
        wait_for_idle(FakeServer(), settle=0.4, grace=1.5, sleep=sleep, clock=clock)
        self.assertAlmostEqual(now[0], 0.4)

    def test_waits_for_requests_in_flight_but_never_past_the_grace_period(self):
        now, clock, sleep = self.clock()
        server = FakeServer()
        server._server.server_state.tasks.add("request")  # never finishes
        wait_for_idle(server, settle=0.4, grace=1.5, sleep=sleep, clock=clock)
        self.assertGreaterEqual(now[0], 1.5)
        self.assertLess(now[0], 1.7)

    def test_returns_as_soon_as_the_request_finishes(self):
        now, clock, sleep = self.clock()
        server = FakeServer()
        server._server.server_state.tasks.add("request")

        def finishing_sleep(seconds):
            sleep(seconds)
            if now[0] >= 0.8:
                server._server.server_state.tasks.clear()

        wait_for_idle(server, settle=0.4, grace=1.5, sleep=finishing_sleep, clock=clock)
        self.assertLess(now[0], 1.0)


class RunWindowTests(unittest.TestCase):
    def test_launches_waits_for_exit_then_lets_the_save_land(self):
        events = []

        class Process:
            def wait(self):
                events.append("exited")
                return 0

        def popen(command):
            events.append(("launch", command))
            return Process()

        with tempfile.TemporaryDirectory() as tmp:
            profile = Path(tmp) / "chromium-profile"
            server = FakeServer()
            code = run_chromium_window(
                "http://127.0.0.1:5000", "/usr/bin/chromium", profile, server,
                popen=popen, idle_wait=lambda s: events.append("idle-wait"),
            )
            self.assertTrue(profile.is_dir())
        self.assertEqual(code, 0)
        self.assertEqual(events[1:], ["exited", "idle-wait"])
        self.assertIn("--app=http://127.0.0.1:5000/notes?host=desktop", events[0][1])

    def test_idle_wait_also_runs_when_waiting_is_interrupted(self):
        events = []

        class Process:
            def wait(self):
                raise KeyboardInterrupt

        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(KeyboardInterrupt):
                run_chromium_window(
                    "http://127.0.0.1:5000", "/usr/bin/chromium", Path(tmp) / "p", FakeServer(),
                    popen=lambda c: Process(), idle_wait=lambda s: events.append("idle-wait"),
                )
        self.assertEqual(events, ["idle-wait"])


class FocusTests(unittest.TestCase):
    command = ["/usr/bin/chromium", "--app=http://x"]

    def test_uses_hyprctl_when_it_finds_the_window(self):
        calls = []

        def run(cmd, **kwargs):
            calls.append(cmd)
            return SimpleNamespace(returncode=0, stdout=b"ok")

        self.assertTrue(focus_window(self.command, run=run, which=which_from("hyprctl")))
        self.assertEqual(calls, [["/usr/bin/hyprctl", "dispatch", "focuswindow", "class:PersonalNote"]])

    def test_relaunches_with_the_same_profile_without_hyprctl(self):
        calls = []
        ok = focus_window(self.command, run=lambda cmd, **kw: calls.append(cmd) or SimpleNamespace(returncode=0, stdout=b""), which=which_from())
        self.assertTrue(ok)
        self.assertEqual(calls, [self.command])

    def test_relaunches_when_hyprctl_finds_no_window(self):
        calls = []

        def run(cmd, **kwargs):
            calls.append(cmd)
            return SimpleNamespace(returncode=0, stdout=b"No such window found")

        focus_window(self.command, run=run, which=which_from("hyprctl"))
        self.assertEqual(calls[-1], self.command)

    def test_a_missing_binary_never_raises(self):
        def run(cmd, **kwargs):
            raise FileNotFoundError

        self.assertFalse(focus_window(self.command, run=run, which=which_from()))


class SingleInstanceTests(unittest.TestCase):
    def test_second_launch_focuses_the_first_and_starts_no_server(self):
        import desktop

        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch.dict("os.environ", {"PERSONAL_NOTE_DB": str(Path(tmp) / "n.db")}), \
                mock.patch.object(desktop, "focus_running_instance", return_value="http://127.0.0.1:1"), \
                mock.patch.object(desktop, "LocalServer") as server, \
                mock.patch.object(desktop, "run_chromium_window") as window:
            self.assertEqual(desktop.main(["--no-build", "--engine", "chromium"]), 0)
        server.assert_not_called()
        window.assert_not_called()


if __name__ == "__main__":
    unittest.main()
