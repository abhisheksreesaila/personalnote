import threading
import unittest
from unittest import mock

import desktop_menu as dm
import secure_platform as sp


class FakeWindow:
    native = None

    def __init__(self):
        self.scripts = []

    def evaluate_js(self, script):
        self.scripts.append(script)

    def minimize(self):
        pass


class NotMacTests(unittest.TestCase):
    def test_other_platforms_use_a_passphrase(self):
        self.assertFalse(sp.available("linux"))
        self.assertEqual(sp.backend("linux"), "passphrase")
        self.assertEqual(sp.backend("darwin"), "touchid")

    def test_calls_report_unavailable_off_a_mac(self):
        with mock.patch.object(sp.sys, "platform", "linux"):
            with self.assertRaises(sp.Unavailable):
                sp.authenticate("why")
            with self.assertRaises(sp.Unavailable):
                sp.key_get_or_create()
            with self.assertRaises(sp.Unavailable):
                sp.set_capture_hidden(FakeWindow(), True)

    def test_self_test_says_passphrase_off_a_mac(self):
        shown = []
        lines = sp.run_self_test(FakeWindow(), shown.append, platform="linux")
        self.assertEqual(lines, [sp.PASSPHRASE_MESSAGE])
        self.assertEqual(shown, [sp.PASSPHRASE_MESSAGE])


class FakeSecurity:
    kSecClass, kSecClassGenericPassword = "class", "generic"
    kSecAttrService, kSecAttrAccount = "svc", "acct"
    kSecReturnData, kSecMatchLimit, kSecMatchLimitOne, kSecValueData = "ret", "limit", "one", "value"

    def __init__(self):
        self.stored = None

    def SecItemCopyMatching(self, query, _result):
        if self.stored is None:
            return sp.ERR_SEC_ITEM_NOT_FOUND, None
        return 0, self.stored

    def SecItemAdd(self, item, _result):
        self.stored = bytes(item[self.kSecValueData])
        return 0, None


class KeychainTests(unittest.TestCase):
    def setUp(self):
        self.addCleanup(sp.forget_authentication)
        sp.forget_authentication()
        patcher = mock.patch.object(sp, "available", return_value=True)
        patcher.start()
        self.addCleanup(patcher.stop)
        nsdata = mock.MagicMock()
        nsdata.NSData.dataWithBytes_length_ = lambda data, length: data
        modules = mock.patch.dict("sys.modules", {"Foundation": nsdata})
        modules.start()
        self.addCleanup(modules.stop)

    def test_key_is_refused_without_a_touch_id_yes(self):
        with self.assertRaises(sp.NotAuthenticated):
            sp.key_get_or_create(FakeSecurity())

    def test_key_is_created_once_then_read_back(self):
        security = FakeSecurity()
        sp._authenticated_at = sp.time.monotonic()
        first = sp.key_get_or_create(security)
        self.assertEqual(len(first), sp.KEY_BYTES)
        self.assertEqual(sp.key_get_or_create(security), first)

    def test_an_old_yes_expires(self):
        sp._authenticated_at = sp.time.monotonic() - sp.UNLOCK_WINDOW_SECONDS - 1
        with self.assertRaises(sp.NotAuthenticated):
            sp.key_get_or_create(FakeSecurity())


class SelfTestTests(unittest.TestCase):
    def run_test(self, auth, key=b"k" * 32, hide=True):
        shown, pauses, hides = [], [], []
        with mock.patch.object(sp, "authenticate", return_value=auth), \
                mock.patch.object(sp, "key_get_or_create", return_value=key), \
                mock.patch.object(sp, "set_capture_hidden", side_effect=lambda w, h: hides.append(h) or hide):
            lines = sp.run_self_test(FakeWindow(), shown.append, pause=pauses.append, platform="darwin")
        return lines, shown, pauses, hides

    def test_all_three_run_and_report_without_the_key(self):
        lines, shown, pauses, hides = self.run_test(True)
        self.assertEqual(hides, [True, False])
        self.assertEqual(pauses, [sp.CAPTURE_HIDDEN_SECONDS])
        text = " ".join(lines)
        self.assertIn("Touch ID: yes", text)
        self.assertIn("read back OK (32 bytes)", text)
        self.assertNotIn("kkkk", text + " ".join(shown))

    def test_no_touch_id_means_no_key(self):
        lines, _, _, _ = self.run_test(False)
        self.assertIn("Touch ID: no", lines[0])
        self.assertIn("skipped", lines[1])

    def test_window_is_restored_even_if_the_wait_fails(self):
        hides = []
        with mock.patch.object(sp, "authenticate", return_value=False), \
                mock.patch.object(sp, "set_capture_hidden", side_effect=lambda w, h: hides.append(h) or True):
            sp.run_self_test(FakeWindow(), lambda m: None, pause=mock.Mock(side_effect=RuntimeError("x")), platform="darwin")
        self.assertEqual(hides, [True, False])

    def test_a_window_that_cannot_be_hidden_is_reported(self):
        lines, _, pauses, hides = self.run_test(True, hide=False)
        self.assertEqual((pauses, hides), ([], [True]))
        self.assertIn("Window hiding: failed", lines)


class MenuWiringTests(unittest.TestCase):
    def test_help_menu_has_the_secure_unlock_item(self):
        titles = [i.title for i in dm.iter_items(dm.HELP_ITEMS)]
        self.assertIn("Test secure unlock…", titles)

    def test_the_item_runs_the_test_on_a_worker_thread(self):
        window, ran, notes = FakeWindow(), threading.Event(), []
        threads = []

        def fake_test(win, notify):
            threads.append(threading.current_thread())
            notify("done")
            ran.set()

        actions = dm.MenuActions(window, lambda: None, notify=notes.append, secure_test=fake_test)
        self.assertTrue(actions.run(dm.Item("Test secure unlock…", action="secure-test")))
        self.assertTrue(ran.wait(2))
        self.assertEqual(notes, ["done"])
        self.assertIsNot(threads[0], threading.main_thread())


def in_worker(function):
    box = {}
    thread = threading.Thread(target=lambda: box.setdefault("v", function()))
    thread.start()
    thread.join(5)
    return box["v"]


def namespace(**kw):
    import types

    return types.SimpleNamespace(**kw)


class FakeContext:
    can = True
    answer = True  # True/False replies at once; None never replies

    def __init__(self):
        self.invalidated = False

    @classmethod
    def alloc(cls):
        return cls()

    def init(self):
        return self

    def canEvaluatePolicy_error_(self, policy, error):
        return self.can, None

    def evaluatePolicy_localizedReason_reply_(self, policy, reason, reply):
        self.policy, self.reason = policy, reason
        if self.answer is not None:
            reply(self.answer, None)

    def invalidate(self):
        self.invalidated = True


class AuthenticateTests(unittest.TestCase):
    def setUp(self):
        sp.forget_authentication()
        self.addCleanup(sp.forget_authentication)
        self.context = FakeContext()
        FakeContext.can, FakeContext.answer = True, True
        la = mock.MagicMock()
        la.LAContext.alloc = lambda: self.context
        for patcher in (mock.patch.object(sp, "available", return_value=True), mock.patch.dict("sys.modules", {"LocalAuthentication": la})):
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_a_yes_is_true_and_unlocks_the_key(self):
        self.assertTrue(in_worker(lambda: sp.authenticate("why")))
        self.assertEqual((self.context.policy, self.context.reason), (sp.LA_POLICY_OWNER_AUTH, "why"))
        self.assertTrue(sp._recently_authenticated())

    def test_a_no_is_false_and_does_not_unlock(self):
        FakeContext.answer = False
        self.assertFalse(in_worker(lambda: sp.authenticate("why")))
        self.assertFalse(sp._recently_authenticated())

    def test_no_reply_times_out_and_invalidates(self):
        FakeContext.answer = None
        self.assertFalse(in_worker(lambda: sp.authenticate("why", timeout=0.05)))
        self.assertTrue(self.context.invalidated)

    def test_a_prompt_that_cannot_be_shown_is_false(self):
        FakeContext.can = False
        self.assertFalse(in_worker(lambda: sp.authenticate("why")))

    def test_refuses_the_main_thread(self):
        with self.assertRaises(RuntimeError):
            sp.authenticate("why")


class FakeNative:
    def __init__(self):
        self.values = []

    def setSharingType_(self, value):
        self.values.append((value, threading.current_thread() is threading.main_thread()))


class CaptureTests(unittest.TestCase):
    def setUp(self):
        patcher = mock.patch.object(sp, "available", return_value=True)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_on_the_main_thread_it_sets_none_then_read_only(self):
        window = namespace(native=FakeNative())
        self.assertTrue(sp.set_capture_hidden(window, True))
        self.assertTrue(sp.set_capture_hidden(window, False))
        self.assertEqual([v for v, _ in window.native.values], [0, 1])

    def test_from_a_worker_it_hops_through_the_main_loop(self):
        calls = []
        helper = mock.MagicMock()

        def call_after(function):
            calls.append(1)
            function()  # a fake main loop

        helper.callAfter = call_after
        window = namespace(native=FakeNative())
        with mock.patch.dict("sys.modules", {"PyObjCTools": mock.MagicMock(AppHelper=helper), "PyObjCTools.AppHelper": helper}):
            self.assertTrue(in_worker(lambda: sp.set_capture_hidden(window, True)))
        self.assertEqual(calls, [1])
        self.assertEqual(window.native.values[0][0], sp.SHARING_NONE)

    def test_no_native_window_is_false(self):
        self.assertFalse(sp.set_capture_hidden(namespace(native=None), True))


class RaceTests(unittest.TestCase):
    def test_duplicate_item_on_add_is_read_back(self):
        class Racing(FakeSecurity):
            def SecItemAdd(self, item, result):
                self.stored = b"r" * 32  # the other writer won
                return sp.ERR_SEC_DUPLICATE_ITEM, None

        nsdata = mock.MagicMock()
        nsdata.NSData.dataWithBytes_length_ = lambda data, length: data
        with mock.patch.object(sp, "available", return_value=True), mock.patch.dict("sys.modules", {"Foundation": nsdata}):
            sp._authenticated_at = sp.time.monotonic()
            self.addCleanup(sp.forget_authentication)
            self.assertEqual(sp.key_get_or_create(Racing()), b"r" * 32)

    def test_a_second_run_while_one_is_going_is_refused(self):
        entered, release, shown = threading.Event(), threading.Event(), []

        def slow_auth(reason):
            entered.set()
            release.wait(5)
            return False

        with mock.patch.object(sp, "authenticate", side_effect=slow_auth), \
                mock.patch.object(sp, "set_capture_hidden", return_value=False):
            first = threading.Thread(target=sp.run_self_test, args=(FakeWindow(), lambda m: None), kwargs={"platform": "darwin"})
            first.start()
            self.assertTrue(entered.wait(5))
            lines = sp.run_self_test(FakeWindow(), shown.append, platform="darwin")
            release.set()
            first.join(5)
        self.assertEqual(lines, ["already running"])
        self.assertIn("already running", shown[0])
        self.assertFalse(sp._test_lock.locked())


if __name__ == "__main__":
    unittest.main()


class FakeCenter:
    def __init__(self):
        self.observers = {}
        self.removed = []

    def addObserverForName_object_queue_usingBlock_(self, name, _object, _queue, block):
        token = object()
        self.observers[name] = block
        return token

    def removeObserver_(self, token):
        self.removed.append(token)


class FakeWorkspace:
    def __init__(self):
        self.center = FakeCenter()

    def notificationCenter(self):
        return self.center


class LockEventTests(unittest.TestCase):
    def test_sleep_and_screen_lock_events_each_call_back(self):
        workspace, distributed = FakeWorkspace(), FakeCenter()
        calls = []
        stop = sp.watch_lock_events(lambda why: calls.append(why), workspace=workspace, distributed=distributed)
        self.assertTrue(callable(stop))
        for name in ("NSWorkspaceWillSleepNotification", "NSWorkspaceScreensDidSleepNotification", "NSWorkspaceSessionDidResignActiveNotification"):
            workspace.center.observers[name](None)
        distributed.observers["com.apple.screenIsLocked"](None)
        self.assertEqual(calls, ["sleep", "screen sleep", "session switch", "screen locked"])

    def test_a_failing_callback_does_not_break_the_notification(self):
        workspace, distributed = FakeWorkspace(), FakeCenter()

        def boom(_why):
            raise RuntimeError("no")

        sp.watch_lock_events(boom, workspace=workspace, distributed=distributed)
        workspace.center.observers["NSWorkspaceWillSleepNotification"](None)

    def test_stopping_removes_every_observer(self):
        workspace, distributed = FakeWorkspace(), FakeCenter()
        stop = sp.watch_lock_events(lambda why: None, workspace=workspace, distributed=distributed)
        stop()
        self.assertEqual(len(workspace.center.removed), 3)
        self.assertEqual(len(distributed.removed), 2)

    def test_off_a_mac_there_is_nothing_to_watch(self):
        with mock.patch.object(sp.sys, "platform", "linux"):
            self.assertIsNone(sp.watch_lock_events(lambda why: None))
