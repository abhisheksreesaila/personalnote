import os
import socket
import tempfile
import chromium_app
import unittest
from unittest import mock
from pathlib import Path
from types import SimpleNamespace

from chromium_app import (
    child_env,
    chromium_command,
    find_chromium,
    focus_window,
    profile_owner_pid,
    wait_for_profile_release,
    run_chromium_window,
    wait_for_idle,
)
from desktop import choose_engine


def which_from(*present):
    return lambda name: f"/usr/bin/{name}" if name in present else None


class DiscoveryTests(unittest.TestCase):
    def test_prefers_chromium_then_chrome_in_order(self):
        self.assertEqual(find_chromium(which_from("google-chrome", "chromium-browser"), exists=lambda p: False), "/usr/bin/chromium-browser")
        self.assertEqual(find_chromium(which_from("google-chrome", "google-chrome-stable")), "/usr/bin/google-chrome-stable")
        self.assertEqual(find_chromium(which_from("chromium", "google-chrome"), exists=lambda p: False), "/usr/bin/chromium")

    def test_uses_the_real_binary_directly_when_it_exists(self):
        self.assertEqual(find_chromium(which_from("chromium"), exists=lambda p: True), "/usr/lib/chromium/chromium")
        self.assertEqual(find_chromium(which_from("chromium"), exists=lambda p: False), "/usr/bin/chromium")

    def test_none_when_no_binary(self):
        self.assertIsNone(find_chromium(which_from()))


class EngineChoiceTests(unittest.TestCase):
    def test_auto_uses_chromium_on_linux_when_found(self):
        self.assertEqual(choose_engine("auto", "linux", which_from("chromium")), ("chromium", chromium_app.find_chromium(which_from("chromium"))))

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
        self.assertIn("--disable-extensions", command)


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

        def popen(command, **kwargs):
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
        self.assertIn("--app=http://127.0.0.1:5000/notes?host=desktop&engine=chromium", events[0][1])

    def test_idle_wait_also_runs_when_waiting_is_interrupted(self):
        events = []

        class Process:
            def wait(self):
                raise KeyboardInterrupt

        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(KeyboardInterrupt):
                run_chromium_window(
                    "http://127.0.0.1:5000", "/usr/bin/chromium", Path(tmp) / "p", FakeServer(),
                    popen=lambda c, **k: Process(), idle_wait=lambda s: events.append("idle-wait"),
                )
        self.assertEqual(events, ["idle-wait"])


class FocusTests(unittest.TestCase):
    def test_focuses_by_pid_with_hyprctl(self):
        calls = []

        def run(cmd, **kwargs):
            calls.append(cmd)
            return SimpleNamespace(returncode=0, stdout=b"ok\n")

        self.assertTrue(focus_window(4242, run=run, which=which_from("hyprctl")))
        self.assertEqual(calls, [["/usr/bin/hyprctl", "dispatch", "focuswindow", "pid:4242"]])

    def test_never_launches_another_window(self):
        calls = []

        def run(cmd, **kwargs):
            calls.append(cmd)
            return SimpleNamespace(returncode=0, stdout=b"No such window found")

        self.assertFalse(focus_window(4242, run=run, which=which_from("hyprctl")))
        self.assertFalse(focus_window(4242, run=run, which=which_from()))
        self.assertFalse(focus_window(None, run=run, which=which_from("hyprctl")))
        self.assertTrue(all(call[1:3] == ["dispatch", "focuswindow"] for call in calls))

    def test_output_must_be_exactly_ok(self):
        run = lambda cmd, **kw: SimpleNamespace(returncode=0, stdout=b"not ok at all")
        self.assertFalse(focus_window(1, run=run, which=which_from("hyprctl")))

    def test_a_missing_binary_never_raises(self):
        def run(cmd, **kwargs):
            raise FileNotFoundError

        self.assertFalse(focus_window(1, run=run, which=which_from("hyprctl")))


class ProfileLockTests(unittest.TestCase):
    def test_reads_the_pid_from_the_singleton_lock(self):
        with tempfile.TemporaryDirectory() as tmp:
            os.symlink("myhost-4321", Path(tmp) / "SingletonLock")
            ours = dict(hostname=lambda: "myhost", is_chromium=lambda pid: True)
            self.assertEqual(profile_owner_pid(Path(tmp), alive=lambda pid: True, **ours), 4321)
            self.assertIsNone(profile_owner_pid(Path(tmp), alive=lambda pid: False, **ours))

    def test_another_hosts_lock_or_a_recycled_pid_is_stale(self):
        with tempfile.TemporaryDirectory() as tmp:
            os.symlink("myhost-4321", Path(tmp) / "SingletonLock")
            self.assertIsNone(profile_owner_pid(Path(tmp), alive=lambda p: True, hostname=lambda: "other", is_chromium=lambda p: True))
            self.assertIsNone(profile_owner_pid(Path(tmp), alive=lambda p: True, hostname=lambda: "myhost", is_chromium=lambda p: False))

    def test_is_chromium_reads_proc_comm(self):
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "10").mkdir()
            (Path(tmp) / "10" / "comm").write_text("chromium\n")
            (Path(tmp) / "11").mkdir()
            (Path(tmp) / "11" / "comm").write_text("bash\n")
            self.assertTrue(chromium_app.is_chromium(10, comm_dir=tmp))
            self.assertFalse(chromium_app.is_chromium(11, comm_dir=tmp))
            self.assertFalse(chromium_app.is_chromium(12, comm_dir=tmp))

    def test_no_lock_or_a_garbled_lock_means_free(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertIsNone(profile_owner_pid(Path(tmp)))
            os.symlink("garbage", Path(tmp) / "SingletonLock")
            self.assertIsNone(profile_owner_pid(Path(tmp)))

    def test_our_own_dead_process_is_not_an_owner(self):
        with tempfile.TemporaryDirectory() as tmp:
            os.symlink("h-999999999", Path(tmp) / "SingletonLock")
            self.assertIsNone(profile_owner_pid(Path(tmp)))

    def test_keeps_waiting_while_another_process_holds_the_profile(self):
        owners = iter([777, 777, None])
        sleeps = []
        wait_for_profile_release(Path("p"), 100, sleep=sleeps.append, owner=lambda p: next(owners))
        self.assertEqual(len(sleeps), 2)

    def test_does_not_wait_on_its_own_process(self):
        sleeps = []
        wait_for_profile_release(Path("p"), 100, sleep=sleeps.append, owner=lambda p: 100)
        self.assertEqual(sleeps, [])


class HandoffTests(unittest.TestCase):
    def test_server_keeps_running_while_a_handed_off_window_is_open(self):
        events = []

        class Process:
            pid = 100

            def wait(self):
                events.append("child-exited")
                return 0

        owners = iter([777, None])  # a different live process holds the profile, then it closes

        def owner(profile):
            value = next(owners)
            events.append(f"owner={value}")
            return value

        with tempfile.TemporaryDirectory() as tmp:
            run_chromium_window(
                "http://127.0.0.1:5000", "/usr/bin/chromium", Path(tmp) / "p", FakeServer(),
                popen=lambda c, **k: Process(), idle_wait=lambda s: events.append("idle-wait"),
                owner=owner, release_wait=lambda profile, pid: wait_for_profile_release(profile, pid, sleep=lambda s: None, owner=owner),
            )
        self.assertEqual(events, ["child-exited", "owner=777", "owner=None", "idle-wait"])

    def test_non_zero_exit_is_returned(self):
        class Process:
            pid = 1

            def wait(self):
                return 3

        with tempfile.TemporaryDirectory() as tmp:
            code = run_chromium_window(
                "http://x", "/b", Path(tmp) / "p", FakeServer(),
                popen=lambda c, **k: Process(), idle_wait=lambda s: None, release_wait=lambda p, pid: None,
            )
        self.assertEqual(code, 3)


class StartupTests(unittest.TestCase):
    def run_main(self, **patches):
        import desktop

        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch.dict("os.environ", {"PERSONAL_NOTE_DB": str(Path(tmp) / "n.db"), "XDG_DATA_HOME": tmp}), \
                mock.patch.object(desktop, "focus_running_instance", return_value=None), \
                mock.patch.object(desktop, "choose_engine", return_value=("chromium", "/usr/bin/chromium")), \
                mock.patch.object(desktop, "check_profile_free", side_effect=patches.get("free")), \
                mock.patch.object(desktop, "LocalServer") as server, \
                mock.patch.object(desktop, "run_chromium_window", side_effect=patches.get("run", lambda *a, **k: 0)):
            server.return_value.start.return_value = "http://127.0.0.1:1"
            server.return_value.nonce = "n"
            server.return_value.fell_back = patches.get("fell_back", False)
            return desktop.main(["--no-build"]), server

    def test_nonzero_chromium_exit_is_reported(self):
        import io
        from contextlib import redirect_stderr

        err = io.StringIO()
        with redirect_stderr(err):
            code, _ = self.run_main(run=lambda *a, **k: 5)
        self.assertEqual(code, 1)
        self.assertIn("code 5", err.getvalue())

    def test_failure_to_launch_is_reported(self):
        import io
        from contextlib import redirect_stderr

        def boom(*a, **k):
            raise FileNotFoundError("chromium")

        err = io.StringIO()
        with redirect_stderr(err):
            code, _ = self.run_main(run=boom)
        self.assertEqual(code, 1)
        self.assertIn("Could not start the Chromium window", err.getvalue())

    def test_an_open_window_without_a_server_is_refused_before_any_server_starts(self):
        import desktop
        import io
        from contextlib import redirect_stderr

        err = io.StringIO()
        with redirect_stderr(err):
            code, server = self.run_main(free=desktop.DesktopError("A Personal Note window is already open"))
        self.assertEqual(code, 1)
        server.assert_not_called()
        self.assertIn("already open", err.getvalue())

    def test_a_port_fallback_is_warned_about(self):
        import io
        from contextlib import redirect_stderr

        err = io.StringIO()
        with redirect_stderr(err):
            self.run_main(fell_back=True)
        self.assertIn("3138 is in use", err.getvalue())

    def test_server_asks_for_the_stable_port(self):
        import desktop

        _, server = self.run_main()
        self.assertEqual(server.call_args.kwargs["preferred_port"], desktop.PREFERRED_PORT)


class StablePortTests(unittest.TestCase):
    def free_port(self):
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            return probe.getsockname()[1]

    def test_uses_the_preferred_port_when_free_and_the_same_one_next_time(self):
        from desktop import LocalServer
        from routes import create_app

        port = self.free_port()
        with tempfile.TemporaryDirectory() as tmp:
            urls = []
            for _ in range(2):
                server = LocalServer(create_app(Path(tmp) / "n.db"), preferred_port=port)
                try:
                    urls.append(server.start())
                finally:
                    server.stop()
        self.assertEqual(urls, [f"http://127.0.0.1:{port}"] * 2)

    def test_falls_back_to_another_port_when_taken(self):
        from desktop import LocalServer
        from routes import create_app

        with socket.socket() as holder, tempfile.TemporaryDirectory() as tmp:
            holder.bind(("127.0.0.1", 0))
            holder.listen()
            taken = holder.getsockname()[1]
            server = LocalServer(create_app(Path(tmp) / "n.db"), preferred_port=taken)
            try:
                self.assertNotEqual(server.start(), f"http://127.0.0.1:{taken}")
                self.assertTrue(server.fell_back)
            finally:
                server.stop()


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


class ChildEnvTests(unittest.TestCase):
    def test_restores_the_library_path_pyinstaller_replaced(self):
        env = child_env({"LD_LIBRARY_PATH": "/opt/pn/_internal", "LD_LIBRARY_PATH_ORIG": "/usr/local/lib", "HOME": "/h"}, frozen=True)
        self.assertEqual(env["LD_LIBRARY_PATH"], "/usr/local/lib")
        self.assertEqual(env["HOME"], "/h")

    def test_removes_the_library_path_when_there_was_none(self):
        # PyInstaller sets LD_LIBRARY_PATH_ORIG to "" when the variable was unset... or leaves it absent
        self.assertNotIn("LD_LIBRARY_PATH", child_env({"LD_LIBRARY_PATH": "/opt/pn/_internal", "LD_LIBRARY_PATH_ORIG": ""}, frozen=True))
        self.assertNotIn("LD_LIBRARY_PATH", child_env({"LD_LIBRARY_PATH": "/opt/pn/_internal"}, frozen=True))

    def test_an_unfrozen_run_is_left_alone(self):
        env = {"LD_LIBRARY_PATH": "/mine"}
        self.assertEqual(child_env(env, frozen=False), env)

    def test_the_input_is_not_modified(self):
        env = {"LD_LIBRARY_PATH": "/x", "LD_LIBRARY_PATH_ORIG": "/y"}
        child_env(env, frozen=True)
        self.assertEqual(env["LD_LIBRARY_PATH"], "/x")


class ChildProcessEnvTests(unittest.TestCase):
    def test_chromium_and_hyprctl_get_the_restored_environment(self):
        seen = {}

        class Process:
            pid = 1

            def wait(self):
                return 0

        def popen(command, **kwargs):
            seen["popen"] = kwargs.get("env")
            return Process()

        def run(cmd, **kwargs):
            seen["run"] = kwargs.get("env")
            return SimpleNamespace(returncode=0, stdout=b"ok")

        with mock.patch.dict("os.environ", {"LD_LIBRARY_PATH": "/bundle", "LD_LIBRARY_PATH_ORIG": "/orig"}), \
                mock.patch.object(chromium_app.sys, "frozen", True, create=True), \
                tempfile.TemporaryDirectory() as tmp:
            run_chromium_window(
                "http://x", "/usr/bin/chromium", Path(tmp) / "p", FakeServer(), popen=popen, run=run,
                idle_wait=lambda s: None, release_wait=lambda p, pid: None,
            )
            focus_window(5, run=run, which=which_from("hyprctl"))
        self.assertEqual(seen["popen"]["LD_LIBRARY_PATH"], "/orig")
        self.assertEqual(seen["run"]["LD_LIBRARY_PATH"], "/orig")
