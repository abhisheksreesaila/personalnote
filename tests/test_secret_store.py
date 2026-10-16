"""SecretStore: a keychain item on a Mac (fake Security here), a 0600 file elsewhere."""

import os
import stat
import tempfile
import unittest
from pathlib import Path

from secret_store import ERR_SEC_ITEM_NOT_FOUND, SecretStore, SecretStoreError


class FakeSecurity:
    kSecClass = "class"
    kSecClassGenericPassword = "generic"
    kSecAttrService = "service"
    kSecAttrAccount = "account"
    kSecReturnData = "return"
    kSecMatchLimit = "limit"
    kSecMatchLimitOne = "one"
    kSecValueData = "data"

    def __init__(self):
        self.items = {}
        self.calls = []
        self.fail = {}  # call name -> status

    def _key(self, query):
        return (query[self.kSecAttrService], query[self.kSecAttrAccount])

    def SecItemCopyMatching(self, query, _):  # noqa: N802
        self.calls.append("copy")
        if "copy" in self.fail:
            return self.fail["copy"], None
        key = self._key(query)
        return (0, self.items[key]) if key in self.items else (ERR_SEC_ITEM_NOT_FOUND, None)

    def SecItemUpdate(self, query, attrs):  # noqa: N802
        self.calls.append("update")
        if "update" in self.fail:
            return self.fail["update"]
        key = self._key(query)
        if key not in self.items:
            return ERR_SEC_ITEM_NOT_FOUND
        self.items[key] = attrs[self.kSecValueData]
        return 0

    def SecItemAdd(self, item, _):  # noqa: N802
        self.calls.append("add")
        if "add" in self.fail:
            return self.fail["add"], None
        self.items[self._key(item)] = item[self.kSecValueData]
        return 0, None

    def SecItemDelete(self, query):  # noqa: N802
        self.calls.append("delete")
        if "delete" in self.fail:
            return self.fail["delete"]
        return 0 if self.items.pop(self._key(query), None) is not None else ERR_SEC_ITEM_NOT_FOUND


class KeychainTests(unittest.TestCase):
    def setUp(self):
        self.security = FakeSecurity()
        self.store = SecretStore("Personal Note test", "key-a", platform="darwin", security=self.security)

    def test_mac_uses_the_keychain(self):
        self.assertTrue(self.store.uses_keychain)

    def test_not_found_is_none(self):
        self.assertIsNone(self.store.load())

    def test_first_save_updates_then_adds_and_round_trips(self):
        self.store.save("sk-first")
        self.assertEqual(self.security.calls, ["update", "add"])
        self.assertEqual(self.store.load(), "sk-first")

    def test_second_save_updates_in_place(self):
        self.store.save("one")
        self.security.calls.clear()
        self.store.save("two")
        self.assertEqual(self.security.calls, ["update"])
        self.assertEqual(self.store.load(), "two")

    def test_accounts_are_separate_items(self):
        SecretStore("Personal Note test", "key-b", platform="darwin", security=self.security).save("other")
        self.store.save("mine")
        self.assertEqual(self.store.load(), "mine")

    def test_delete_then_gone_and_deleting_nothing_is_fine(self):
        self.store.save("x")
        self.store.delete()
        self.assertIsNone(self.store.load())
        self.store.delete()

    def test_error_statuses_are_plain_and_hold_no_value(self):
        self.store.save("sk-secret")
        for call, action in (("copy", self.store.load), ("update", lambda: self.store.save("sk-secret")), ("delete", self.store.delete)):
            self.security.fail[call] = -25293
            with self.assertRaises(SecretStoreError) as caught:
                action()
            self.assertIn("-25293", str(caught.exception))
            self.assertNotIn("sk-secret", str(caught.exception))
            del self.security.fail[call]
        self.security.items.clear()
        self.security.fail["add"] = -25299 + 1
        with self.assertRaisesRegex(SecretStoreError, "keychain write failed"):
            self.store.save("sk-secret")


class FileTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = SecretStore("svc", "ai/key", folder=Path(self.tmp.name) / "data", platform="linux")

    def test_round_trip_in_an_owner_only_file(self):
        self.assertIsNone(self.store.load())
        self.store.save("sk-abc")
        self.assertEqual(self.store.load(), "sk-abc")
        self.assertEqual(stat.S_IMODE(os.stat(self.store.path).st_mode), 0o600)
        self.assertEqual(self.store.path.name, "ai_key.secret")

    def test_overwrite_and_delete(self):
        self.store.save("one")
        self.store.save("two")
        self.assertEqual(self.store.load(), "two")
        self.store.delete()
        self.assertIsNone(self.store.load())
        self.store.delete()

    def test_default_folder_is_the_app_data_folder(self):
        store = SecretStore("svc", "acct", platform="linux")
        self.assertEqual((store.path.parent.name, store.path.name), ("personal-note", "acct.secret"))

    def test_unreadable_file_is_a_plain_error(self):
        self.store.path.parent.mkdir(parents=True)
        self.store.path.write_bytes(b"\xff\xfe\x00")
        with self.assertRaisesRegex(SecretStoreError, "could not be read"):
            self.store.load()


if __name__ == "__main__":
    unittest.main()
