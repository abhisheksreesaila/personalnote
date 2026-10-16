"""One small secret (a token, an API key) kept outside the notes database, backups and logs.

`SecretStore(service, account)` holds a text value: in the macOS login keychain (a generic-password item, through
pyobjc's Security, as secure_platform does), or elsewhere in a file readable only by the owner (0600) under the app
data folder. The value is never logged and never appears in an error message. UNVERIFIED on a real Mac keychain
until a signed-in feature (scripts/x-setup.sh) has been run there.
"""

from __future__ import annotations

import os
import re
import sys
from pathlib import Path
from typing import Any

import app_paths

ERR_SEC_ITEM_NOT_FOUND = -25300


class SecretStoreError(Exception):
    """The store could not be read or written; the message says what, never the value."""


class SecretStore:
    def __init__(self, service: str, account: str, *, folder: Path | None = None, platform: str | None = None, security: Any = None):
        self.service = service
        self.account = account
        self.platform = sys.platform if platform is None else platform
        self._security = security
        self.path = None
        if self.platform != "darwin":
            name = re.sub(r"[^A-Za-z0-9._-]", "_", account) + ".secret"
            self.path = (Path(folder) if folder else app_paths.app_data_dir(self.platform)) / name

    @property
    def uses_keychain(self) -> bool:
        return self.path is None

    # -- keychain

    @property
    def security(self) -> Any:
        if self._security is None:
            import Security  # noqa: N813

            self._security = Security
        return self._security

    def _query(self) -> dict:
        s = self.security
        return {s.kSecClass: s.kSecClassGenericPassword, s.kSecAttrService: self.service, s.kSecAttrAccount: self.account}

    def _keychain_load(self) -> str | None:
        s = self.security
        query = self._query()
        query[s.kSecReturnData] = True
        query[s.kSecMatchLimit] = s.kSecMatchLimitOne
        status, data = s.SecItemCopyMatching(query, None)
        if status == ERR_SEC_ITEM_NOT_FOUND:
            return None
        if status != 0:
            raise SecretStoreError(f"keychain read failed ({status})")
        return bytes(data).decode("utf-8")

    def _keychain_save(self, value: str) -> None:
        s = self.security
        blob = value.encode("utf-8")
        try:
            from Foundation import NSData
        except ImportError:  # not a Mac: only a test's fake Security gets here
            data = blob
        else:
            data = NSData.dataWithBytes_length_(blob, len(blob))
        status = s.SecItemUpdate(self._query(), {s.kSecValueData: data})
        if status == ERR_SEC_ITEM_NOT_FOUND:
            item = self._query()
            item[s.kSecValueData] = data
            status, _ = s.SecItemAdd(item, None)
        if status != 0:
            raise SecretStoreError(f"keychain write failed ({status})")

    def _keychain_delete(self) -> None:
        status = self.security.SecItemDelete(self._query())
        if status not in (0, ERR_SEC_ITEM_NOT_FOUND):
            raise SecretStoreError(f"keychain delete failed ({status})")

    # -- public

    def load(self) -> str | None:
        if self.uses_keychain:
            return self._keychain_load()
        try:
            return self.path.read_text("utf-8")
        except FileNotFoundError:
            return None
        except (OSError, UnicodeDecodeError):
            raise SecretStoreError("the saved secret could not be read") from None

    def save(self, value: str) -> None:
        if self.uses_keychain:
            return self._keychain_save(value)
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_name(self.path.name + ".tmp")
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                handle.write(value)
            os.replace(tmp, self.path)
        except OSError:
            raise SecretStoreError("the secret could not be saved") from None

    def delete(self) -> None:
        if self.uses_keychain:
            return self._keychain_delete()
        self.path.unlink(missing_ok=True)
