"""Cryptography for secure notes (F-057, ADR 0005). No SQLite and no platform calls here; `NoteService` owns the rows.

One random 32-byte data key encrypts every secure note (AES-256-GCM). The data key is only ever stored wrapped, by:
- "keychain": the Mac keychain key (given by `secure_platform` only after a Touch ID yes),
- "passphrase": a key derived from the person's passphrase with scrypt (Linux),
- "recovery": a key derived from the one-time recovery key shown when the first secure note is made.
"""

from __future__ import annotations

import base64
import hashlib
import json
import secrets
import time
from typing import Callable

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

KEY_BYTES = 32
NONCE_BYTES = 12
SEAL_VERSION = 1
WRAP_VERSION = 1
SCRYPT_N = 2**17  # ~0.25 s and 128 MB on a 2026 laptop
SCRYPT_R = 8
SCRYPT_P = 1
SALT_BYTES = 16
SCRYPT_MAXMEM = 2**28
MIN_PASSPHRASE_LENGTH = 8
RECOVERY_BYTES = 20  # 160 bits, written as 8 groups of 4 letters and digits
_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"


class DecryptError(Exception):
    """The key does not open this (wrong key, or the stored bytes were changed)."""


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def unb64(text: str) -> bytes:
    return base64.b64decode(text.encode("ascii"), validate=True)


def new_data_key() -> bytes:
    return secrets.token_bytes(KEY_BYTES)


def new_key_id() -> str:
    return f"key_{secrets.token_hex(8)}"


# ---- notes ----------------------------------------------------------------------------------------


def _note_aad(key_id: str, seal_id: str) -> bytes:
    """Bound into every sealed blob: the key and this note's own seal id, so a blob cannot be swapped or replayed into another note."""
    return f"personal-note:secure-note:v{SEAL_VERSION}:{key_id}:{seal_id}".encode()


def new_seal_id() -> str:
    return f"seal_{secrets.token_hex(12)}"


def seal(data_key: bytes, key_id: str, seal_id: str, payload: dict) -> str:
    """Encrypt a note's words (content, page state, format) into one text blob: version, nonce, ciphertext and tag."""
    nonce = secrets.token_bytes(NONCE_BYTES)
    plain = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return b64(bytes([SEAL_VERSION]) + nonce + AESGCM(data_key).encrypt(nonce, plain, _note_aad(key_id, seal_id)))


def is_sealed_text(value) -> bool:
    if not isinstance(value, str) or len(value) < 40 or len(value) > 200_000_000:
        return False
    try:
        raw = unb64(value)
    except Exception:
        return False
    return len(raw) > 1 + NONCE_BYTES + 16 and raw[0] == SEAL_VERSION


def unseal(data_key: bytes, key_id: str, seal_id: str, sealed: str) -> dict:
    try:
        raw = unb64(sealed)
        if raw[0] != SEAL_VERSION:
            raise DecryptError("This secure note was saved by a newer version")
        payload = AESGCM(data_key).decrypt(raw[1 : 1 + NONCE_BYTES], raw[1 + NONCE_BYTES :], _note_aad(key_id, seal_id))
        value = json.loads(payload.decode("utf-8"))
    except DecryptError:
        raise
    except (InvalidTag, ValueError, IndexError):
        raise DecryptError("This secure note could not be opened with that key") from None
    if not isinstance(value, dict):
        raise DecryptError("This secure note could not be read")
    return value


# ---- wrapping the data key ------------------------------------------------------------------------


def _wrap_aad(key_id: str, kind: str, version: int) -> bytes:
    return f"personal-note:wrapped-key:v{version}:{kind}:{key_id}".encode()


def wrap(wrapping_key: bytes, key_id: str, kind: str, data_key: bytes, version: int = WRAP_VERSION) -> str:
    nonce = secrets.token_bytes(NONCE_BYTES)
    return b64(nonce + AESGCM(wrapping_key).encrypt(nonce, data_key, _wrap_aad(key_id, kind, version)))


def unwrap(wrapping_key: bytes, key_id: str, kind: str, wrapped: str, version: int = WRAP_VERSION) -> bytes:
    try:
        raw = unb64(wrapped)
        key = AESGCM(wrapping_key).decrypt(raw[:NONCE_BYTES], raw[NONCE_BYTES:], _wrap_aad(key_id, kind, version))
    except (InvalidTag, ValueError, IndexError):
        raise DecryptError("That key does not open the secure notes") from None
    if len(key) != KEY_BYTES:
        raise DecryptError("That key does not open the secure notes")
    return key


def keychain_wrapping_key(device_key: bytes) -> bytes:
    """The keychain item is random already; it wraps the data key directly."""
    if len(device_key) != KEY_BYTES:
        raise DecryptError("The device key has the wrong length")
    return device_key


def new_scrypt_params(cost: int = SCRYPT_N) -> dict:
    return {"kdf": "scrypt", "n": cost, "r": SCRYPT_R, "p": SCRYPT_P}


def valid_scrypt_params(params) -> tuple[int, int, int]:
    """(n, r, p) if the stored settings are sane and fit the memory limit (128*r*n bytes), else DecryptError."""
    try:
        values = [params[key] for key in ("n", "r", "p")]
    except (TypeError, KeyError):
        raise DecryptError("The stored passphrase settings are not valid") from None
    if any(type(value) is not int for value in values):
        raise DecryptError("The stored passphrase settings are not valid")
    n, r, p = values
    if n < 2 or n & (n - 1) or r < 1 or p < 1 or r > 32 or p > 16 or 128 * r * n > SCRYPT_MAXMEM:
        raise DecryptError("The stored passphrase settings are not valid")
    return n, r, p


def passphrase_wrapping_key(passphrase: str, salt: bytes, params: dict) -> bytes:
    n, r, p = valid_scrypt_params(params)
    return hashlib.scrypt(passphrase.encode("utf-8"), salt=salt, n=n, r=r, p=p, dklen=KEY_BYTES, maxmem=SCRYPT_MAXMEM)


def check_passphrase(passphrase) -> str:
    if not isinstance(passphrase, str) or len(passphrase) < MIN_PASSPHRASE_LENGTH:
        raise ValueError(f"The passphrase needs at least {MIN_PASSPHRASE_LENGTH} characters")
    return passphrase


# ---- recovery key ---------------------------------------------------------------------------------


def new_recovery_key() -> str:
    """160 random bits as 32 letters and digits (base32), in groups of four: ABCD-EFGH-... Shown once, typed by hand."""
    number = int.from_bytes(secrets.token_bytes(RECOVERY_BYTES), "big")
    letters = []
    for _ in range(RECOVERY_BYTES * 8 // 5):
        letters.append(_ALPHABET[number & 31])
        number >>= 5
    text = "".join(letters)
    return "-".join(text[index : index + 4] for index in range(0, len(text), 4))


def normalize_recovery_key(value) -> str:
    if not isinstance(value, str):
        raise ValueError("Type the recovery key")
    text = "".join(ch for ch in value.upper() if ch not in "- \t\r\n")
    text = text.replace("0", "O").replace("1", "I").replace("8", "B")  # base32 has no 0, 1 or 8: forgive a misread
    if len(text) != RECOVERY_BYTES * 8 // 5 or any(ch not in _ALPHABET for ch in text):
        raise ValueError("That is not a recovery key")
    return text


def recovery_wrapping_key(recovery_key: str, salt: bytes) -> bytes:
    """The recovery key has 160 bits, so a plain HKDF is enough (no slow password hashing needed)."""
    return HKDF(algorithm=hashes.SHA256(), length=KEY_BYTES, salt=salt, info=b"personal-note:recovery:v1").derive(
        normalize_recovery_key(recovery_key).encode("ascii")
    )


def new_salt() -> bytes:
    return secrets.token_bytes(SALT_BYTES)


# ---- the keys held in memory ----------------------------------------------------------------------


class Keyring:
    """Data keys held in this process while secure notes are unlocked. Nothing is ever written down.

    The idle hook for the auto-lock (F-058): `set_idle_timeout(seconds)`; every successful `get` renews the time, and a key
    not used within it is forgotten. `lock()` forgets everything at once (leaving a note, the Mac sleeping, Lock now).
    """

    def __init__(self, clock: Callable[[], float] = time.monotonic):
        self._clock = clock
        self._keys: dict[str, bytes] = {}
        self._idle_timeout: float | None = None
        self._last_used = 0.0

    def set_idle_timeout(self, seconds: float | None) -> None:
        self._idle_timeout = seconds

    @property
    def idle_timeout(self) -> float | None:
        return self._idle_timeout

    def _expire(self) -> None:
        if self._keys and self._idle_timeout is not None and self._clock() - self._last_used > self._idle_timeout:
            self._keys.clear()

    def unlock(self, key_id: str, data_key: bytes) -> None:
        self._keys[key_id] = data_key
        self._last_used = self._clock()

    def get(self, key_id: str) -> bytes | None:
        self._expire()
        key = self._keys.get(key_id)
        if key is not None:
            self._last_used = self._clock()
        return key

    def touch(self) -> None:
        """Renew the quiet time of keys that are still held (a key already expired stays gone)."""
        self._expire()
        if self._keys:
            self._last_used = self._clock()

    def lock(self) -> None:
        self._keys.clear()

    def unlocked_ids(self) -> list[str]:
        self._expire()
        return list(self._keys)

    @property
    def is_unlocked(self) -> bool:
        self._expire()
        return bool(self._keys)

