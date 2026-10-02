"""Content-addressed media files: ``media/<sha256>.<ext>`` under one folder (F-023 will build on this scheme).

Notes never hold picture bytes. A picture or a derived SVG is written once under its SHA-256 and referenced by the stored path
``media/<sha256>.<ext>``, so identical bytes are stored once and a save that did not change a picture writes nothing.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import os
import re
import tempfile
from pathlib import Path
from urllib.parse import unquote_to_bytes

MEDIA_NAME = re.compile(r"^[0-9a-f]{64}\.(?:png|jpg|webp|gif|svg)$")
MAX_MEDIA_BYTES = 20 * 1024 * 1024
_DATA_IMAGE = re.compile(r"^data:image/(png|jpe?g|webp|gif|svg\+xml)(?:;charset=[\w-]+)?(;base64)?,", re.IGNORECASE)
_EXTENSIONS = {"png": "png", "jpeg": "jpg", "jpg": "jpg", "webp": "webp", "gif": "gif", "svg+xml": "svg"}
_MIME = {"png": "image/png", "jpg": "image/jpeg", "webp": "image/webp", "gif": "image/gif", "svg": "image/svg+xml"}
EXTENSION_BY_SUFFIX = {"png": "png", "jpg": "jpg", "jpeg": "jpg", "webp": "webp", "gif": "gif", "svg": "svg"}


def decode_data_url(url: str) -> tuple[bytes, str] | None:
    """(bytes, extension) of a base64 or percent-encoded image data URL, or None when it is not a small image."""
    if not isinstance(url, str):
        return None
    text = url.strip()
    match = _DATA_IMAGE.match(text)
    if not match:
        return None
    payload = text[match.end():]
    try:
        data = base64.b64decode(payload, validate=True) if match.group(2) else unquote_to_bytes(payload)
    except (binascii.Error, ValueError):
        return None
    if not data or len(data) > MAX_MEDIA_BYTES:
        return None
    return data, _EXTENSIONS[match.group(1).lower()]


def data_url_of(data: bytes, ext: str) -> str:
    return f"data:{_MIME[ext]};base64,{base64.b64encode(data).decode('ascii')}"


class MediaStore:
    def __init__(self, root: Path | str):
        self.root = Path(root)

    def from_id(self, media_id: str) -> str:
        return f"media/{media_id}"

    def file(self, media_id: str) -> Path | None:
        return self.root / media_id if MEDIA_NAME.match(str(media_id)) else None

    def read(self, media_id: str) -> bytes | None:
        path = self.file(media_id)
        try:
            return path.read_bytes() if path else None
        except OSError:
            return None

    def put_bytes(self, data: bytes, ext: str) -> str:
        name = f"{hashlib.sha256(data).hexdigest()}.{ext}"
        path = self.root / name
        if not path.exists():
            self.root.mkdir(parents=True, exist_ok=True)
            handle, temporary = tempfile.mkstemp(dir=self.root, suffix=".part")
            try:
                with os.fdopen(handle, "wb") as out:
                    out.write(data)
                os.replace(temporary, path)
            except BaseException:
                try:
                    os.unlink(temporary)
                except OSError:
                    pass
                raise
        return f"media/{name}"

    def put_text(self, text: str, ext: str) -> str:
        return self.put_bytes(text.encode("utf-8"), ext)

    def put_data_url(self, url: str) -> str | None:
        decoded = decode_data_url(url)
        return self.put_bytes(*decoded) if decoded else None
