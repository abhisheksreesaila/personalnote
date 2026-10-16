"""X bookmarks (F-087) against a local fake X: sign-in with PKCE, refresh, pagination, the 800 cap, since-id, errors.

No network: a loopback HTTP server plays authorize, token, users/me and bookmarks. Its bookmark list is in
bookmarked order (newest first), as X's is.
"""

import json
import logging
import os
import socket
import stat
import tempfile
import time
import threading
import unittest
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import x_bookmarks
from secret_store import SecretStore
from x_bookmarks import TokenStore, XClient, XError, challenge_for

CLIENT_ID = "client-abc"
USER_ID = "4242"


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def make_posts(count: int) -> list[dict]:
    """Newest bookmark first. Ids descend; every 3rd post has a photo, every 7th a video preview only."""
    posts = []
    for i in range(count):
        n = count - i
        post = {"id": str(1000 + n), "text": f"post {n}", "author_id": "u1", "created_at": f"2026-01-01T00:00:{n % 60:02d}.000Z"}
        if n % 3 == 0:
            post["attachments"] = {"media_keys": [f"m{n}"]}
        posts.append(post)
    return posts


class FakeX:
    def __init__(self, posts):
        self.posts = posts
        self.codes = {}  # code -> (challenge, redirect_uri)
        self.access = {"access-1"}
        self.refresh = {"refresh-1"}
        self.token_calls = []
        self.bookmark_calls = []
        self.fail_next = None  # (status, headers)
        self.expires_in = 7200
        self.counter = 1
        self.tamper_state = False
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def send(self, status, body=None, headers=None):
                raw = json.dumps(body or {}).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                for k, v in (headers or {}).items():
                    self.send_header(k, v)
                self.end_headers()
                self.wfile.write(raw)

            def do_GET(self):
                parts = urllib.parse.urlsplit(self.path)
                q = {k: v[0] for k, v in urllib.parse.parse_qs(parts.query).items()}
                if parts.path == "/authorize":
                    assert q["response_type"] == "code" and q["client_id"] == CLIENT_ID
                    assert q["code_challenge_method"] == "S256"
                    assert q["scope"] == "tweet.read users.read bookmark.read offline.access"
                    code = f"code-{len(outer.codes) + 1}"
                    outer.codes[code] = (q["code_challenge"], q["redirect_uri"])
                    state = "forged" if outer.tamper_state else q["state"]
                    location = q["redirect_uri"] + "?" + urllib.parse.urlencode({"code": code, "state": state})
                    self.send(302, headers={"Location": location})
                    return
                if self.headers.get("Authorization", "").removeprefix("Bearer ") not in outer.access:
                    self.send(401, {"title": "Unauthorized"})
                    return
                if outer.fail_next:
                    status, headers = outer.fail_next
                    outer.fail_next = None
                    self.send(status, {"title": "nope"}, headers)
                    return
                if parts.path == "/2/users/me":
                    self.send(200, {"data": {"id": USER_ID, "username": "captain"}})
                elif parts.path == f"/2/users/{USER_ID}/bookmarks":
                    outer.bookmark_calls.append(q)
                    start = int(q.get("pagination_token", 0))
                    size = int(q["max_results"])
                    chunk = outer.posts[start : start + size]
                    keys = [k for p in chunk for k in p.get("attachments", {}).get("media_keys", [])]
                    body = {
                        "data": chunk,
                        "includes": {
                            "users": [{"id": "u1", "name": "Ada Lovelace", "username": "ada"}],
                            "media": [
                                {"media_key": k, "type": "photo", "url": f"https://pbs.example/{k}.jpg"} for k in keys
                            ],
                        },
                        "meta": {"result_count": len(chunk)},
                    }
                    if start + size < len(outer.posts):
                        body["meta"]["next_token"] = str(start + size)
                    self.send(200, body)
                else:
                    self.send(404)

            def do_POST(self):
                form = {k: v[0] for k, v in urllib.parse.parse_qs(self.rfile.read(int(self.headers["Content-Length"])).decode()).items()}
                outer.token_calls.append({"form": form, "authorization": self.headers.get("Authorization")})
                if outer.fail_next and self.path.endswith("/oauth2/token"):
                    status, headers = outer.fail_next
                    outer.fail_next = None
                    self.send(status, {"error": "invalid_request"}, headers)
                    return
                if form["grant_type"] == "authorization_code":
                    challenge, redirect = outer.codes.pop(form["code"])
                    if challenge_for(form["code_verifier"]) != challenge or form["redirect_uri"] != redirect:
                        self.send(400, {"error": "invalid_grant"})
                        return
                elif form["grant_type"] == "refresh_token":
                    if form["refresh_token"] not in outer.refresh:
                        self.send(400, {"error": "invalid_grant"})
                        return
                    outer.refresh.discard(form["refresh_token"])
                outer.counter += 1
                access, refresh = f"access-{outer.counter}", f"refresh-{outer.counter}"
                outer.access.add(access)
                outer.refresh.add(refresh)
                self.send(200, {"access_token": access, "refresh_token": refresh, "expires_in": outer.expires_in, "token_type": "bearer"})

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def stop(self):
        self.server.shutdown()
        self.server.server_close()


class Clock:
    def __init__(self, now=1_000_000.0):
        self.now = now

    def __call__(self):
        return self.now


class XTestCase(unittest.TestCase):
    posts = 5

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.x = FakeX(make_posts(self.posts))
        self.addCleanup(self.x.stop)
        self.clock = Clock()
        self.store = x_bookmarks.default_token_store("linux", Path(self.tmp.name))
        self.port = free_port()
        self.client = self.make_client()

    def make_client(self):
        return XClient(
            CLIENT_ID,
            self.store,
            authorize_url=f"{self.x.base}/authorize",
            api_base=f"{self.x.base}/2",
            callback_port=self.port,
            clock=self.clock,
        )

    def browser(self, url):
        """Stands in for the captain's browser: follows the authorize redirect back to the loopback callback."""
        def follow():
            try:
                urllib.request.urlopen(url, timeout=10).close()
            except (urllib.error.URLError, OSError):
                pass  # the callback may be refused or never answered: tests assert what sign_in does

        threading.Thread(target=follow, daemon=True).start()

    def sign_in(self):
        return self.client.sign_in(self.browser, timeout=10)


class SignInTests(XTestCase):
    def test_sign_in_stores_tokens_and_user(self):
        self.assertEqual(self.sign_in(), {"user_id": USER_ID})
        saved = self.store.load()
        self.assertEqual((saved["access_token"], saved["refresh_token"], saved["user_id"]), ("access-2", "refresh-2", USER_ID))
        self.assertEqual(saved["client_id"], CLIENT_ID)
        self.assertTrue(self.client.signed_in())

    def test_token_request_is_public_client_pkce_with_exact_redirect(self):
        self.sign_in()
        call = self.x.token_calls[0]
        self.assertIsNone(call["authorization"])  # no client secret
        self.assertEqual(call["form"]["redirect_uri"], f"http://127.0.0.1:{self.port}/x/callback")
        self.assertEqual(call["form"]["client_id"], CLIENT_ID)
        self.assertGreaterEqual(len(call["form"]["code_verifier"]), 43)  # RFC 7636 minimum

    def test_fixed_redirect_is_the_loopback_ip(self):
        self.assertEqual(x_bookmarks.REDIRECT_URI, "http://127.0.0.1:38457/x/callback")

    def test_state_mismatch_is_ignored_and_nothing_is_stored(self):
        self.x.tamper_state = True
        with self.assertRaisesRegex(XError, "timed out"):
            self.client.sign_in(self.browser, timeout=1)
        self.assertEqual(self.x.token_calls, [])
        self.assertIsNone(self.store.load())

    def test_a_forged_callback_does_not_end_the_wait(self):
        def browser(url):
            def run():
                try:
                    urllib.request.urlopen(f"http://127.0.0.1:{self.port}/x/callback?code=evil&state=wrong", timeout=5)
                except urllib.error.HTTPError as error:
                    self.assertEqual(error.code, 400)
                urllib.request.urlopen(url, timeout=10).read()

            threading.Thread(target=run, daemon=True).start()

        self.assertEqual(self.client.sign_in(browser, timeout=10), {"user_id": USER_ID})
        self.assertEqual(len(self.x.token_calls), 1)
        self.assertNotEqual(self.x.token_calls[0]["form"]["code"], "evil")

    def test_an_idle_connection_cannot_hold_sign_in_past_its_deadline(self):
        started = time.monotonic()
        idle = []

        def browser(url):
            idle.append(socket.create_connection(("127.0.0.1", self.port), timeout=10))  # connects, sends nothing

        with self.assertRaisesRegex(XError, "timed out"):
            self.client.sign_in(browser, timeout=2)
        idle[0].close()
        self.assertLess(time.monotonic() - started, 6)

    def test_callback_server_stops_after_one_callback(self):
        self.sign_in()
        with self.assertRaises(urllib.error.URLError):
            urllib.request.urlopen(f"http://127.0.0.1:{self.port}/x/callback?code=x&state=y", timeout=2)

    def test_user_who_denies_gets_a_plain_message(self):
        def browser(url):
            query = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)
            denied = query["redirect_uri"][0] + "?" + urllib.parse.urlencode({"error": "access_denied", "state": query["state"][0]})
            threading.Thread(target=lambda: urllib.request.urlopen(denied, timeout=5).read(), daemon=True).start()

        with self.assertRaisesRegex(XError, "X did not allow the sign-in"):
            self.client.sign_in(browser, timeout=10)
        self.assertEqual(self.x.token_calls, [])

    def test_busy_port_is_explained(self):
        with socket.socket() as s:
            s.bind(("127.0.0.1", self.port))
            s.listen()
            with self.assertRaisesRegex(XError, f"Port {self.port} .* busy"):
                self.sign_in()

    def test_stored_client_id_is_reused(self):
        self.sign_in()
        again = XClient(None, self.store, api_base=f"{self.x.base}/2")
        self.assertEqual(again.client_id, CLIENT_ID)

    def test_token_file_is_owner_only(self):
        self.sign_in()
        self.assertEqual(stat.S_IMODE(os.stat(self.store.secret.path).st_mode), 0o600)

    def test_sign_out_forgets_the_tokens(self):
        self.sign_in()
        self.client.sign_out()
        self.assertFalse(self.client.signed_in())


class FetchTests(XTestCase):
    posts = 5

    def setUp(self):
        super().setUp()
        self.sign_in()
        self.x.bookmark_calls.clear()

    def test_normalized_newest_first(self):
        got = self.client.fetch_new()
        self.assertEqual([b["id"] for b in got], ["1005", "1004", "1003", "1002", "1001"])
        self.assertEqual(
            got[0],
            {
                "id": "1005",
                "url": "https://x.com/ada/status/1005",
                "author_name": "Ada Lovelace",
                "author_handle": "ada",
                "text": "post 5",
                "created_at": "2026-01-01T00:00:05.000Z",
                "image_url": None,
            },
        )
        self.assertEqual(got[2]["image_url"], "https://pbs.example/m3.jpg")

    def test_asks_x_for_the_fields_it_needs(self):
        self.client.fetch_new()
        q = self.x.bookmark_calls[0]
        self.assertEqual(q["expansions"], "author_id,attachments.media_keys")
        self.assertEqual((q["tweet.fields"], q["user.fields"], q["media.fields"]), ("created_at", "username,name", "url,preview_image_url"))
        self.assertEqual(q["max_results"], "100")

    def test_since_id_returns_only_newer_with_no_duplicates(self):
        got = self.client.fetch_new("1003")
        self.assertEqual([b["id"] for b in got], ["1005", "1004"])

    def test_newest_stored_id_unbookmarked_still_stops_at_the_next_known_one(self):
        # 1005 was stored, then un-bookmarked on X; 1004 is still there and stored
        self.x.posts.pop(0)
        self.x.posts.insert(0, {"id": "1006", "text": "new", "author_id": "u1"})
        got = self.client.fetch_new({"1005", "1004", "1003"})
        self.assertEqual([b["id"] for b in got], ["1006"])
        self.assertEqual([c["max_results"] for c in self.x.bookmark_calls], ["1", "10"])

    def test_nothing_new_costs_one_post_and_one_call(self):
        self.assertEqual(self.client.fetch_new("1005"), [])
        self.assertEqual(len(self.x.bookmark_calls), 1)
        self.assertEqual(self.x.bookmark_calls[0]["max_results"], "1")

    def test_one_new_then_pages_on_ten_at_a_time(self):
        self.x.posts.insert(0, {"id": "1006", "text": "newest", "author_id": "u1"})
        got = self.client.fetch_new("1005")
        self.assertEqual([b["id"] for b in got], ["1006"])
        self.assertEqual([c["max_results"] for c in self.x.bookmark_calls], ["1", "10"])
        self.assertEqual(self.x.bookmark_calls[1]["pagination_token"], "1")

    def test_not_connected_says_so(self):
        self.client.sign_out()
        with self.assertRaisesRegex(XError, "not connected") as caught:
            self.client.fetch_new()
        self.assertEqual(caught.exception.kind, "signed_out")


class PaginationTests(XTestCase):
    posts = 950

    def setUp(self):
        super().setUp()
        self.sign_in()
        self.x.bookmark_calls.clear()

    def test_stops_at_800_across_pages(self):
        got = self.client.fetch_new()
        self.assertEqual(len(got), 800)
        self.assertEqual(len({b["id"] for b in got}), 800)
        self.assertEqual((got[0]["id"], got[-1]["id"]), ("1950", "1151"))
        self.assertEqual(len(self.x.bookmark_calls), 8)

    def test_all_pages_are_followed_when_under_the_cap(self):
        self.assertEqual(len(self.client.fetch_new(limit=250)), 250)
        self.assertEqual([c["max_results"] for c in self.x.bookmark_calls], ["100", "100", "50"])

    def test_pages_grow_one_ten_hundred_while_new_posts_keep_coming(self):
        self.assertEqual(len(self.client.fetch_new("no-such-id")), 800)
        sizes = [c["max_results"] for c in self.x.bookmark_calls]
        self.assertEqual(sizes[:4], ["1", "10", "100", "100"])


class RefreshTests(XTestCase):
    def setUp(self):
        super().setUp()
        self.sign_in()
        self.x.token_calls.clear()

    def test_expired_token_is_refreshed_and_the_new_pair_kept(self):
        self.clock.now += 7200
        self.assertEqual(len(self.client.fetch_new()), 5)
        form = self.x.token_calls[0]["form"]
        self.assertEqual((form["grant_type"], form["refresh_token"], form["client_id"]), ("refresh_token", "refresh-2", CLIENT_ID))
        saved = self.store.load()
        self.assertEqual((saved["access_token"], saved["refresh_token"], saved["user_id"]), ("access-3", "refresh-3", USER_ID))

    def test_valid_token_is_not_refreshed(self):
        self.client.fetch_new()
        self.assertEqual(self.x.token_calls, [])

    def test_a_401_refreshes_once_and_retries(self):
        self.x.access.discard("access-2")
        self.assertEqual(len(self.client.fetch_new()), 5)
        self.assertEqual(len(self.x.token_calls), 1)

    def test_refused_refresh_token_means_signed_out(self):
        self.clock.now += 7200
        self.x.refresh.clear()
        with self.assertRaisesRegex(XError, "Connect X again") as caught:
            self.client.fetch_new()
        self.assertEqual(caught.exception.kind, "signed_out")


class ErrorTests(XTestCase):
    def setUp(self):
        super().setUp()
        self.sign_in()

    def test_402_means_no_credit(self):
        self.x.fail_next = (402, {})
        with self.assertRaises(XError) as caught:
            self.client.fetch_new()
        self.assertEqual(caught.exception.kind, "no_credits")
        self.assertEqual(str(caught.exception), "X has no API credit left on this account. Add credit in the X developer console, then sync again.")

    def test_429_says_when_to_retry(self):
        self.x.fail_next = (429, {"x-rate-limit-reset": str(int(self.clock.now) + 600)})
        with self.assertRaises(XError) as caught:
            self.client.fetch_new()
        self.assertEqual(str(caught.exception), "X is limiting requests. Try again in about 10 minutes.")
        self.assertEqual((caught.exception.kind, caught.exception.retry_at), ("rate_limited", self.clock.now + 600))

    def test_429_without_a_reset_header_still_reads_plainly(self):
        self.x.fail_next = (429, {})
        with self.assertRaisesRegex(XError, "Try again in a few minutes"):
            self.client.fetch_new()

    def test_unreachable_x_is_a_network_message(self):
        self.x.stop()
        with self.assertRaisesRegex(XError, "Could not reach X") as caught:
            self.client.fetch_new()
        self.assertEqual(caught.exception.kind, "network")

    def test_401_that_stays_401_means_connect_again(self):
        self.x.access.clear()
        self.x.refresh.clear()
        with self.assertRaisesRegex(XError, "Connect X again"):
            self.client.fetch_new()


class SecretsStayOutOfLogsTests(XTestCase):
    def test_no_token_or_code_in_logs_or_messages(self):
        with self.assertLogs(level=logging.DEBUG) as logs:
            logging.getLogger("personal-note.x").warning("start")
            self.sign_in()
            self.clock.now += 7200
            self.client.fetch_new()
            self.x.fail_next = (429, {})
            with self.assertRaises(XError) as caught:
                self.client.fetch_new()
        text = "\n".join(logs.output) + str(caught.exception)
        for secret in ("access-", "refresh-", "code-", "code_verifier"):
            self.assertNotIn(secret, text)


class DefaultStoreTests(unittest.TestCase):
    def test_linux_uses_a_file_under_the_app_data_folder(self):
        secret = x_bookmarks.default_token_store("linux").secret
        self.assertEqual((secret.path.name, secret.path.parent.name), ("x-tokens.secret", "personal-note"))

    def test_mac_uses_the_keychain(self):
        self.assertTrue(x_bookmarks.default_token_store("darwin").secret.uses_keychain)

    def test_a_corrupt_token_file_says_connect_again(self):
        with tempfile.TemporaryDirectory() as folder:
            store = x_bookmarks.default_token_store("linux", Path(folder))
            store.secret.path.write_text("{not json")
            with self.assertRaisesRegex(XError, "Connect X again") as caught:
                store.load()
            self.assertEqual(caught.exception.kind, "signed_out")
            client = XClient("id", store)
            self.assertFalse(client.signed_in())
            with self.assertRaisesRegex(XError, "Connect X again"):
                client.fetch_new()


if __name__ == "__main__":
    unittest.main()
