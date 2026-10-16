"""Settings → AI (F-093): which model every AI feature uses, chosen once.

The non-secret choices live in `ai-settings.json` in the app-data folder (PERSONAL_NOTE_AI_DIR overrides it), never in
the notes database, a backup or an export. The API key lives in the system keychain (a 0600 file on Linux) through
SecretStore and is never returned, logged or written anywhere else: the page only learns `keySaved`.
`AISettings.brain()` builds the jam_brain brain that future AI features share; the PERSONAL_NOTE_JAM_API_KEY
environment variable still overrides the saved key, for scripts.
"""

from __future__ import annotations

import json
import os
import re
import time
from pathlib import Path
from urllib.parse import urlparse

import app_paths
import jam_brain
from jam_brain import ClaudeCodeBrain, JamError, OpenAICompatibleBrain
from secret_store import SecretStore, SecretStoreError

SETTINGS_FILE = "ai-settings.json"
KEYCHAIN_SERVICE = "Personal Note AI"
KEYCHAIN_ACCOUNT = "api-key"
PROVIDERS = ("claude-code", "azure", "openai")
CLAUDE_MODELS = ("sonnet", "haiku", "opus")
DEFAULT_API_VERSION = "2024-10-21"
MAX_URL = 300
MAX_NAME = 100
MAX_KEY = 600
TEST_TIMEOUT = 30
TEST_SYSTEM = 'You are a connection check. Answer with JSON only: {"ok": true}'
_MODEL = re.compile(r"^[A-Za-z0-9._:/-]+$")  # org/model is fine: it goes in a request body
_DEPLOYMENT = re.compile(r"^[A-Za-z0-9._-]+$")  # it goes into a URL path, so no slash
_VERSION = re.compile(r"^[A-Za-z0-9._-]+$")

DEFAULTS = {"provider": "claude-code", "claudeModel": "sonnet", "endpoint": "", "deployment": "",
            "apiVersion": DEFAULT_API_VERSION, "baseUrl": "", "model": ""}


class AISettingsError(Exception):
    """A field the person typed is not acceptable; the message says which and is safe to show."""


def _url(value: str, label: str) -> str:
    value = value.strip().rstrip("/")
    if len(value) > MAX_URL:
        raise AISettingsError(f"The {label} is too long.")
    if value:
        parts = urlparse(value)
        if not (parts.scheme == "https" or (parts.scheme == "http" and parts.hostname in jam_brain.LOOPBACK_HOSTS)) or not parts.hostname:
            raise AISettingsError(f"The {label} must start with https:// (plain http is only allowed for this computer).")
        if parts.username or parts.password or parts.query or parts.fragment:
            raise AISettingsError(f"The {label} must be just an address, without a login, query or #.")
    return value


def _name(value: str, label: str, pattern) -> str:
    value = value.strip()
    if len(value) > MAX_NAME or (value and (not pattern.match(value) or ".." in value or value.startswith("/"))):
        raise AISettingsError(f"The {label} has characters it cannot have, or is too long.")
    return value


def validate(data: dict) -> dict:
    """The non-secret settings from a request body, checked; fields that are missing keep their default."""
    out = dict(DEFAULTS)
    for field in out:
        if field in data:
            if not isinstance(data[field], str):
                raise AISettingsError(f"The {field} must be text.")
            out[field] = data[field]
    if out["provider"] not in PROVIDERS:
        raise AISettingsError("Pick Claude Code, Azure OpenAI or an OpenAI-compatible service.")
    if out["claudeModel"] not in CLAUDE_MODELS:
        raise AISettingsError("The Claude model must be sonnet, haiku or opus.")
    out["endpoint"] = _url(out["endpoint"], "Azure endpoint")
    out["baseUrl"] = _url(out["baseUrl"], "base URL")
    out["deployment"] = _name(out["deployment"], "deployment name", _DEPLOYMENT)
    out["model"] = _name(out["model"], "model name", _MODEL)
    out["apiVersion"] = _name(out["apiVersion"], "API version", _VERSION) or DEFAULT_API_VERSION
    return out


def check_key(key) -> str:
    if not isinstance(key, str):
        raise AISettingsError("The key must be text.")
    key = key.strip()
    if not key or len(key) > MAX_KEY or not key.isprintable() or re.search(r"\s", key):
        raise AISettingsError("That does not look like an API key (no spaces or line breaks, up to 600 characters).")
    return key


def _destination(settings: dict) -> tuple:
    """Where a key would be sent: the provider and the host of its address."""
    address = {"azure": settings["endpoint"], "openai": settings["baseUrl"]}.get(settings["provider"], "")
    return settings["provider"], urlparse(address).netloc.lower()


class AISettings:
    def __init__(self, folder: Path | str | None = None, secret: SecretStore | None = None):
        self.folder = Path(folder) if folder else Path(os.environ.get("PERSONAL_NOTE_AI_DIR") or app_paths.app_data_dir())
        self.secret = secret or SecretStore(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, folder=self.folder)

    @property
    def path(self) -> Path:
        return self.folder / SETTINGS_FILE

    def load(self) -> dict:
        try:
            saved = json.loads(self.path.read_text("utf-8"))
            return validate(saved) if isinstance(saved, dict) else dict(DEFAULTS)
        except (OSError, ValueError, AISettingsError):  # missing or damaged: start from the defaults, never crash the page
            return dict(DEFAULTS)

    def has_key(self) -> bool:
        try:
            return bool(self.secret.load())
        except SecretStoreError:
            return False

    def view(self) -> dict:
        """What the page may see: the choices and whether a key is saved, never the key."""
        return {**self.load(), "keySaved": self.has_key(), "claudeCodeFound": bool(jam_brain.find_claude())}

    def save(self, data: dict) -> dict:
        settings = validate(data)
        key = check_key(data["apiKey"]) if data.get("apiKey") not in (None, "") else None
        dropped = False
        try:
            if key:
                self.secret.save(key)
            elif _destination(settings) != _destination(self.load()) and self.has_key():
                self.secret.delete()  # a key belongs to the service it was given for, never to a new address
                dropped = True
        except SecretStoreError as error:
            raise AISettingsError(f"The key could not be saved: {error}") from None
        self.folder.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_name(self.path.name + ".tmp")
        tmp.write_text(json.dumps(settings, indent=2), "utf-8")
        os.replace(tmp, self.path)
        return {**self.view(), "keyDropped": dropped}

    def remove_key(self) -> dict:
        try:
            self.secret.delete()
        except SecretStoreError as error:
            raise AISettingsError(f"The key could not be removed: {error}") from None
        return self.view()

    def brain(self, timeout: float = 90):
        """The brain these settings describe, for any AI feature; raises BrainUnavailable when it is not set up."""
        s = self.load()
        if s["provider"] == "claude-code":
            return ClaudeCodeBrain(model=s["claudeModel"], timeout=timeout)
        try:
            key = self.secret.load() or ""
        except SecretStoreError:
            key = ""
        if s["provider"] == "azure":
            return OpenAICompatibleBrain(azure_endpoint=s["endpoint"], deployment=s["deployment"],
                                         api_version=s["apiVersion"], timeout=timeout, key=key)
        return OpenAICompatibleBrain(base_url=s["baseUrl"], model=s["model"], timeout=timeout, key=key)

    def test(self, brain=None) -> dict:
        """One tiny real call through the brain: {ok, seconds} or {ok: False, error} in jam_brain's plain words."""
        started = time.monotonic()
        try:
            (brain or self.brain(TEST_TIMEOUT)).complete(TEST_SYSTEM, "ping")
        except JamError as error:  # BrainUnavailable is one
            return {"ok": False, "error": str(error)}
        return {"ok": True, "seconds": round(time.monotonic() - started, 1)}
