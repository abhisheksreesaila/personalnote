"""X bookmarks (F-087): sign in to X once, then fetch new bookmarks. No UI and no routes here (F-088 adds them).

OAuth 2.0 Authorization Code with PKCE as a public client (a "Native App" in the X developer console): no secret.
The only outbound hosts are x.com (authorize) and api.x.com (token, users/me, bookmarks), after the captain signs in.
Tokens live in the macOS login keychain, or in a 0600 file under the app data folder elsewhere; never in SQLite,
backups, exports or logs. UNVERIFIED on a Mac keychain until scripts/x-setup.sh has been run there.
"""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
import secrets
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any, Callable

import app_paths
import download_tls

logger = logging.getLogger("personal-note.x")

# X matches the callback exactly, so it is fixed. 127.0.0.1 (not "localhost") is what X's docs recommend.
CALLBACK_PORT = 38457
CALLBACK_PATH = "/x/callback"
REDIRECT_URI = f"http://127.0.0.1:{CALLBACK_PORT}{CALLBACK_PATH}"
SCOPES = "tweet.read users.read bookmark.read offline.access"
AUTHORIZE_URL = "https://x.com/i/oauth2/authorize"
API_BASE = "https://api.x.com/2"
MAX_BOOKMARKS = 800  # X returns at most the latest 800
PAGE_SIZE = 100
EXPIRY_SKEW = 60
KEYCHAIN_SERVICE = "Personal Note X bookmarks"
KEYCHAIN_ACCOUNT = "x-tokens"
ERR_SEC_ITEM_NOT_FOUND = -25300


class XError(Exception):
    """A failure with a message fit to show the captain. `kind` is signed_out, no_credits, rate_limited, network or other."""

    def __init__(self, message: str, kind: str = "other", retry_at: float | None = None):
        super().__init__(message)
        self.kind = kind
        self.retry_at = retry_at


# ---- Token storage ----------------------------------------------------------------------------


class FileTokenStore:
    """A JSON file readable only by the owner (0600), for computers without a keychain."""

    def __init__(self, path: Path):
        self.path = Path(path)

    def load(self) -> dict | None:
        try:
            return json.loads(self.path.read_text("utf-8"))
        except FileNotFoundError:
            return None

    def save(self, tokens: dict) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_name(self.path.name + ".tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(tokens, handle)
        os.replace(tmp, self.path)

    def clear(self) -> None:
        self.path.unlink(missing_ok=True)


class KeychainTokenStore:
    """One generic-password item in the login keychain holding the token JSON (pyobjc's Security, as secure_platform)."""

    def __init__(self, security: Any = None):
        self._security = security

    @property
    def security(self) -> Any:
        if self._security is None:
            import Security  # noqa: N813

            self._security = Security
        return self._security

    def _query(self) -> dict:
        s = self.security
        return {s.kSecClass: s.kSecClassGenericPassword, s.kSecAttrService: KEYCHAIN_SERVICE, s.kSecAttrAccount: KEYCHAIN_ACCOUNT}

    def load(self) -> dict | None:
        s = self.security
        query = self._query()
        query[s.kSecReturnData] = True
        query[s.kSecMatchLimit] = s.kSecMatchLimitOne
        status, data = s.SecItemCopyMatching(query, None)
        if status == ERR_SEC_ITEM_NOT_FOUND:
            return None
        if status != 0:
            raise OSError(f"keychain read failed ({status})")
        return json.loads(bytes(data).decode("utf-8"))

    def save(self, tokens: dict) -> None:
        from Foundation import NSData

        s = self.security
        blob = json.dumps(tokens).encode("utf-8")
        data = NSData.dataWithBytes_length_(blob, len(blob))
        status = s.SecItemUpdate(self._query(), {s.kSecValueData: data})
        if status == ERR_SEC_ITEM_NOT_FOUND:
            item = self._query()
            item[s.kSecValueData] = data
            status, _ = s.SecItemAdd(item, None)
        if status != 0:
            raise OSError(f"keychain write failed ({status})")

    def clear(self) -> None:
        status = self.security.SecItemDelete(self._query())
        if status not in (0, ERR_SEC_ITEM_NOT_FOUND):
            raise OSError(f"keychain delete failed ({status})")


def default_token_store(platform: str | None = None):
    platform = sys.platform if platform is None else platform
    if platform == "darwin":
        return KeychainTokenStore()
    return FileTokenStore(app_paths.app_data_dir(platform) / "x-tokens.json")


# ---- PKCE -------------------------------------------------------------------------------------


def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def new_verifier() -> str:
    return _b64url(secrets.token_bytes(48))


def challenge_for(verifier: str) -> str:
    return _b64url(hashlib.sha256(verifier.encode("ascii")).digest())


# ---- Client -----------------------------------------------------------------------------------


def _wait_text(retry_at: float | None, now: float) -> str:
    if not retry_at:
        return "in a few minutes"
    minutes = max(1, int((retry_at - now + 59) // 60))
    return f"in about {minutes} minute{'s' if minutes != 1 else ''}"


class XClient:
    def __init__(
        self,
        client_id: str | None = None,
        store=None,
        *,
        authorize_url: str = AUTHORIZE_URL,
        api_base: str = API_BASE,
        callback_port: int = CALLBACK_PORT,
        opener: Callable = download_tls.open_url,
        clock: Callable[[], float] = time.time,
    ):
        self.store = store if store is not None else default_token_store()
        stored = self.store.load() or {}
        self.client_id = client_id or stored.get("client_id")
        self.authorize_url = authorize_url
        self.api_base = api_base.rstrip("/")
        self.callback_port = callback_port
        self._open = opener
        self._clock = clock

    @property
    def redirect_uri(self) -> str:
        return f"http://127.0.0.1:{self.callback_port}{CALLBACK_PATH}"

    def signed_in(self) -> bool:
        return bool((self.store.load() or {}).get("refresh_token"))

    def sign_out(self) -> None:
        self.store.clear()

    # -- HTTP

    def _request(self, url: str, *, data: dict | None = None, token: str | None = None) -> dict:
        headers = {"Accept": "application/json"}
        body = None
        if data is not None:
            body = urllib.parse.urlencode(data).encode("ascii")
            headers["Content-Type"] = "application/x-www-form-urlencoded"
        if token:
            headers["Authorization"] = f"Bearer {token}"
        request = urllib.request.Request(url, data=body, headers=headers)
        try:
            with self._open(request, timeout=30) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            logger.warning("X answered %s for %s", error.code, urllib.parse.urlsplit(url).path)
            error.close()
            raise self._http_error(error) from None
        except (urllib.error.URLError, TimeoutError, OSError, ValueError) as error:
            logger.warning("X request failed: %s", type(error).__name__)
            raise XError("Could not reach X. Check the internet connection and try again.", "network") from None

    def _http_error(self, error: urllib.error.HTTPError) -> XError:
        if error.code == 401:
            return XError("X no longer accepts this sign-in. Connect X again.", "signed_out")
        if error.code == 402:
            return XError("X has no API credit left on this account. Add credit in the X developer console, then sync again.", "no_credits")
        if error.code == 429:
            try:
                retry_at = float(error.headers.get("x-rate-limit-reset"))
            except (TypeError, ValueError):
                retry_at = None
            return XError(f"X is limiting requests. Try again {_wait_text(retry_at, self._clock())}.", "rate_limited", retry_at)
        return XError(f"X could not do that (error {error.code}).", "other")

    # -- Sign-in

    def authorization_url(self, verifier: str, state: str) -> str:
        query = {
            "response_type": "code",
            "client_id": self.client_id,
            "redirect_uri": self.redirect_uri,
            "scope": SCOPES,
            "state": state,
            "code_challenge": challenge_for(verifier),
            "code_challenge_method": "S256",
        }
        return f"{self.authorize_url}?{urllib.parse.urlencode(query, quote_via=urllib.parse.quote)}"

    def sign_in(self, open_browser: Callable[[str], Any], timeout: float = 300) -> dict:
        """Open X in the browser, wait for the one callback on 127.0.0.1, store the tokens. Returns {"user_id"}."""
        if not self.client_id:
            raise XError("No X client id yet. Run scripts/x-setup.sh.", "signed_out")
        verifier, state = new_verifier(), secrets.token_urlsafe(24)
        result: dict[str, str] = {}

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802
                parts = urllib.parse.urlsplit(self.path)
                if parts.path != CALLBACK_PATH:
                    self.send_error(404)
                    return
                result.update({k: v[0] for k, v in urllib.parse.parse_qs(parts.query).items()})
                result["_done"] = "1"
                page = b"<!doctype html><title>Personal Note</title><p>You can close this tab and go back to Personal Note.</p>"
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(page)))
                self.end_headers()
                self.wfile.write(page)

            def log_message(self, *args):  # the query holds the code
                pass

        try:
            server = HTTPServer(("127.0.0.1", self.callback_port), Handler)
        except OSError:
            raise XError(f"Port {self.callback_port} on this computer is busy, so X cannot sign in. Close what uses it and retry.") from None
        try:
            server.timeout = 0.5
            open_browser(self.authorization_url(verifier, state))
            deadline = time.monotonic() + timeout
            while "_done" not in result:
                if time.monotonic() > deadline:
                    raise XError("X sign-in timed out. Try Connect X again.")
                server.handle_request()
        finally:
            server.server_close()
        if result.get("state") != state:
            raise XError("The X sign-in did not match this request, so it was refused. Try Connect X again.")
        if "code" not in result:
            raise XError("X did not allow the sign-in. Try Connect X again.", "signed_out")
        tokens = self._token_call(
            {"grant_type": "authorization_code", "code": result["code"], "redirect_uri": self.redirect_uri, "code_verifier": verifier}
        )
        me = self._request(f"{self.api_base}/users/me", token=tokens["access_token"])
        tokens["user_id"] = me["data"]["id"]
        self.store.save(tokens)
        return {"user_id": tokens["user_id"]}

    def _token_call(self, form: dict) -> dict:
        form = {**form, "client_id": self.client_id}
        answer = self._request(f"{self.api_base}/oauth2/token", data=form)
        if "access_token" not in answer:
            raise XError("X did not return a sign-in. Try Connect X again.", "signed_out")
        return {
            "client_id": self.client_id,
            "access_token": answer["access_token"],
            "refresh_token": answer.get("refresh_token") or form.get("refresh_token"),
            "expires_at": self._clock() + int(answer.get("expires_in", 7200)),
        }

    def _fresh_tokens(self, force: bool = False) -> dict:
        tokens = self.store.load()
        if not tokens or not tokens.get("refresh_token"):
            raise XError("X is not connected. Connect X in Settings.", "signed_out")
        if not force and tokens.get("expires_at", 0) - EXPIRY_SKEW > self._clock():
            return tokens
        try:
            new = self._token_call({"grant_type": "refresh_token", "refresh_token": tokens["refresh_token"]})
        except XError as error:
            if error.kind == "other":  # a refused refresh token (400): the sign-in is gone
                raise XError("X no longer accepts this sign-in. Connect X again.", "signed_out") from None
            raise
        new["user_id"] = tokens.get("user_id")
        self.store.save(new)
        return new

    # -- Bookmarks

    def _get(self, path: str, params: dict) -> dict:
        url = f"{self.api_base}{path}?{urllib.parse.urlencode(params)}"
        try:
            return self._request(url, token=self._fresh_tokens()["access_token"])
        except XError as error:
            if error.kind != "signed_out" or not self.signed_in():
                raise
        return self._request(url, token=self._fresh_tokens(force=True)["access_token"])

    def fetch_new(self, since_id: str | None = None, limit: int = MAX_BOOKMARKS) -> list[dict]:
        """Bookmarks newer than `since_id` (the newest id seen last time), newest first, at most `limit`.

        X lists in bookmarked order. X bills per post returned, so with a since_id the first page is one post:
        when it is the one already seen, that single read is the whole hourly run.
        """
        user_id = (self.store.load() or {}).get("user_id")
        if not user_id:
            raise XError("X is not connected. Connect X in Settings.", "signed_out")
        found: list[dict] = []
        token = None
        size = 1 if since_id else PAGE_SIZE
        while len(found) < limit:
            params = {
                "max_results": size,
                "expansions": "author_id,attachments.media_keys",
                "tweet.fields": "created_at",
                "user.fields": "username,name",
                "media.fields": "url,preview_image_url",
            }
            if token:
                params["pagination_token"] = token
            page = self._get(f"/users/{user_id}/bookmarks", params)
            for item in _normalize(page):
                if item["id"] == since_id:
                    return found
                found.append(item)
                if len(found) >= limit:
                    return found
            token = (page.get("meta") or {}).get("next_token")
            if not token:
                break
            size = PAGE_SIZE
        return found


def _normalize(page: dict) -> list[dict]:
    includes = page.get("includes") or {}
    users = {u["id"]: u for u in includes.get("users", [])}
    media = {m["media_key"]: m for m in includes.get("media", [])}
    items = []
    for post in page.get("data") or []:
        author = users.get(post.get("author_id"), {})
        image = None
        for key in (post.get("attachments") or {}).get("media_keys", []):
            m = media.get(key, {})
            image = m.get("url") or m.get("preview_image_url")
            if image:
                break
        handle = author.get("username", "")
        items.append(
            {
                "id": post["id"],
                "url": f"https://x.com/{handle or 'i'}/status/{post['id']}",
                "author_name": author.get("name", ""),
                "author_handle": handle,
                "text": post.get("text", ""),
                "created_at": post.get("created_at", ""),
                "image_url": image,
            }
        )
    return items


def _live_check() -> int:
    """`python x_bookmarks.py` (run by scripts/x-setup.sh): sign in for real, then list the 5 latest bookmarks."""
    import webbrowser

    client = XClient(os.environ.get("PN_X_CLIENT_ID"))
    try:
        if not client.signed_in():
            print("Opening X in your browser to sign in...")
            client.sign_in(webbrowser.open)
            print("Signed in. The tokens are saved on this computer, not in the notes database.")
        found = client.fetch_new(limit=5)
    except XError as error:
        print(f"Problem: {error}")
        return 1
    if not found:
        print("Connected, but X lists no bookmarks for this account yet.")
    for item in found:
        text = " ".join(item["text"].split())
        print(f"- @{item['author_handle']} ({item['created_at'][:10]}): {text[:90]}\n  {item['url']}")
    return 0


if __name__ == "__main__":
    sys.exit(_live_check())
