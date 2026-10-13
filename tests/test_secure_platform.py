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


if __name__ == "__main__":
    unittest.main()
