"""Jam sessions (F-086): one brain call turns a mind map plus what was just said into validated map edits.

The brain only ever adds and reacts: add_branch, react (thumbs up or down with a reason) and ghost (a faint
suggestion the person accepts or lets fade). Anything that removes, renames or moves a node, names an unknown node,
or runs long is rejected whole with a JamError, so the map is never half-changed. This module never touches the map;
the caller applies the returned JamEdits.

Two brains sit behind one method, `complete(system, user) -> str`: ClaudeCodeBrain runs the person's own signed-in
`claude -p`, and OpenAICompatibleBrain calls any chat-completions endpoint, Azure included. Keys come from the
environment (JAM_KEY_ENV names the variable) and are never logged or stored.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
import unicodedata
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

from urllib.parse import urlparse

from download_tls import https_context

MAX_EDITS = 12
MAX_GHOSTS = 3
MAX_WORDS = 4
MAX_TEXT = 40
MAX_REASON = 80
MAX_EMOJI = 8
JAM_KEY_ENV = "PERSONAL_NOTE_JAM_API_KEY"
LOOPBACK_HOSTS = ("127.0.0.1", "localhost", "::1")
ALLOWED_OPS = {"add_branch", "react", "ghost"}


class JamError(Exception):
    """The brain could not be reached or answered badly; the message is shown to the person as is."""


class BrainUnavailable(JamError):
    """The brain could not be reached or refused (not installed, no key, timeout): asking again would not help."""


class BrainNotSetUp(BrainUnavailable):
    """Nothing to ask yet: Claude Code is not installed, or the model address or key is missing. Settings → AI is the fix."""


@dataclass(frozen=True)
class AddBranch:
    parent_id: str
    text: str
    emoji: str = ""
    id: str = ""  # optional new id, so later edits in the same answer can hang off this branch


@dataclass(frozen=True)
class React:
    node_id: str
    vote: str  # "up" or "down"
    reason: str


@dataclass(frozen=True)
class Ghost:
    parent_id: str
    text: str
    why: str


@dataclass(frozen=True)
class JamEdits:
    edits: list = field(default_factory=list)
    dropped: list = field(default_factory=list)  # why edits were trimmed, for a debug log

    @property
    def branches(self):
        return [edit for edit in self.edits if isinstance(edit, AddBranch)]

    @property
    def reactions(self):
        return [edit for edit in self.edits if isinstance(edit, React)]

    @property
    def ghosts(self):
        return [edit for edit in self.edits if isinstance(edit, Ghost)]


SYSTEM_PROMPT = """You are the quiet partner in a spoken brainstorm, growing a Tony Buzan mind map.
You get the current map (JSON) and what the person just said. Answer with JSON only, no prose, no code fence.

Buzan rules:
- The centre is the central idea. Main branches (children of the centre) are the big themes, a few of them.
- One keyword (at most 4 words) per branch, never a sentence. Put detail on sub-branches, one idea each.
- Use an emoji only where it makes a branch easier to find; leave it out otherwise.
- Reactions are short: a thumbs up or down on an existing branch with a reason under 80 characters.
- Offer 1 to 3 ghosts: faint "what about..." branches the person may accept or ignore, each with a short why.
- Add only what was said or what follows closely from it. Do not repeat branches already on the map.

You can only add and react. Never remove, rename or move a node.

Answer exactly in this shape (up to 12 edits in all):
{"edits": [
  {"op": "add_branch", "parent_id": "<existing node id or an id you gave earlier in this answer>", "text": "keyword", "emoji": "", "id": "<optional new id like n1>"},
  {"op": "react", "node_id": "<existing node id>", "vote": "up", "reason": "short reason"},
  {"op": "ghost", "parent_id": "<node id>", "text": "keyword", "why": "short reason"}
]}"""


def build_user_prompt(map_json: dict, transcript: str, pending_ghosts=()) -> str:
    outline = [
        {"id": n["id"], "parent_id": n.get("parentId"), "text": n.get("text", "")}
        for n in map_json.get("nodes", [])
    ]
    waiting = "; ".join(getattr(g, "text", g) for g in pending_ghosts)
    waiting = f"Waiting suggestions (do not repeat): {waiting}\n" if waiting else ""
    return (
        f"Mind map title: {map_json.get('title', '')}\n"
        f"Centre node id: {map_json.get('rootId', '')}\n"
        f"Map (nodes):\n{json.dumps(outline, ensure_ascii=False)}\n{waiting}\n"
        f"The person just said:\n\"\"\"\n{transcript.strip()}\n\"\"\"\n\nJSON only."
    )


def propose(map_json: dict, transcript: str, brain, pending_ghosts=()) -> JamEdits:
    """Ask the brain for edits to `map_json` given `transcript`; return them validated, or raise JamError.

    `pending_ghosts` (texts, or Ghost objects) are suggestions still waiting; the brain is told not to repeat them.
    A hard-rule failure is retried once with the error fed back; a brain that cannot be reached is not retried."""
    if not transcript or not transcript.strip():
        raise JamError("There is nothing to jam on yet: say something first.")
    prompt = build_user_prompt(map_json, transcript, pending_ghosts)
    try:
        return parse_edits(brain.complete(SYSTEM_PROMPT, prompt), map_json)
    except BrainUnavailable:
        raise
    except JamError as first:
        retry = f"{prompt}\n\nYour last answer was rejected: {first} Answer again, fixing that. JSON only."
        return parse_edits(brain.complete(SYSTEM_PROMPT, retry), map_json)


def _extract_json(raw: str):
    text = (raw or "").strip()
    fenced = re.match(r"^```(?:json)?\s*(.*?)\s*```$", text, re.S)
    if fenced:
        text = fenced.group(1)
    try:
        return json.loads(text)
    except ValueError:
        pass
    start, end = text.find("{"), text.rfind("}")
    if start != -1 and end > start:
        try:
            return json.loads(text[start : end + 1])
        except ValueError:
            pass
    raise JamError("The brain did not answer with map edits (it did not return JSON).")


def _text(value, what: str, required=True) -> str:
    """Text fields: missing or not text is a hard failure; length is a soft limit checked by the caller."""
    if value is None or value == "":
        if required:
            raise JamError(f"The brain left out the {what}.")
        return ""
    if not isinstance(value, str):
        raise JamError(f"The brain gave a {what} that is not text.")
    return value.strip()


def is_emoji(text: str) -> bool:
    """Only symbols, emoji modifiers and joiners: no letters, digits, spaces or punctuation."""
    return 0 < len(text) <= MAX_EMOJI and all(
        unicodedata.category(c) in ("So", "Sk", "Cf", "Mn", "Me") and c not in "\u200b\u200c\ufeff" for c in text)


def _too_long(text: str, limit: int, what: str, words: int | None = None) -> str | None:
    if len(text) > limit:
        return f"{what} longer than {limit} characters"
    if words and len(text.split()) > words:
        return f"{what} longer than {words} words"
    return None


def parse_edits(raw: str, map_json: dict) -> JamEdits:
    """Hard rules raise JamError (removing ops, unknown or reused ids, bad shape). Soft limits trim and are
    reported in `JamEdits.dropped`."""
    data = _extract_json(raw)
    items = data.get("edits") if isinstance(data, dict) else None
    if not isinstance(items, list):
        raise JamError("The brain's answer has no list of edits.")

    dropped = []
    for number in range(MAX_EDITS + 1, len(items) + 1):
        dropped.append(f"edit {number} cut: at most {MAX_EDITS} edits are kept")
    items = items[:MAX_EDITS]

    known = {str(n["id"]) for n in map_json.get("nodes", [])}
    existing = set(known)
    lost_ids = set()  # ids of dropped branches: whatever hangs off them goes too
    edits, ghosts = [], 0
    for number, item in enumerate(items, 1):
        if not isinstance(item, dict):
            raise JamError("The brain gave an edit that is not an object.")
        op = item.get("op")
        if not isinstance(op, str):
            raise JamError("The brain gave an edit whose op is not text.")
        if op not in ALLOWED_OPS:
            raise JamError(f"The brain tried \"{op}\", which is not allowed: it may only add, react or suggest.")
        anchor = item.get("node_id") if op == "react" else item.get("parent_id")
        if not isinstance(anchor, str):
            raise JamError("The brain gave an edit that names its node in a way that is not text.")
        new_id = _text(item.get("id"), "branch id", required=False) if op == "add_branch" else ""
        if new_id and new_id in existing:
            raise JamError(f"The brain reused the id {new_id!r}, which would replace an existing node.")
        if anchor in lost_ids:
            dropped.append(f"edit {number} dropped: it hangs off a dropped branch")
            if new_id:
                lost_ids.add(new_id)
            continue
        if anchor not in known:
            raise JamError(f"The brain used an unknown node ({anchor!r}).")

        if op == "add_branch":
            text = _text(item.get("text"), "branch text")
            emoji = _text(item.get("emoji"), "emoji", required=False)
            if emoji and not is_emoji(emoji):
                dropped.append(f"edit {number}: emoji ignored, it is not an emoji")
                emoji = ""
            problem = _too_long(text, MAX_TEXT, "text") or _too_long(text, MAX_TEXT, "text", MAX_WORDS)
            if problem:
                dropped.append(f"edit {number} dropped: {problem}")
                if new_id:
                    lost_ids.add(new_id)
                continue
            edits.append(AddBranch(anchor, text, emoji, new_id))
            if new_id:
                lost_ids.discard(new_id)
                known.add(new_id)
                existing.add(new_id)
        elif op == "react":
            if item.get("vote") not in ("up", "down"):
                raise JamError("The brain's reaction must be \"up\" or \"down\".")
            reason = _text(item.get("reason"), "reaction reason")
            problem = _too_long(reason, MAX_REASON, "reason")
            if problem:
                dropped.append(f"edit {number} dropped: {problem}")
                continue
            edits.append(React(anchor, item["vote"], reason))
        else:
            text, why = _text(item.get("text"), "suggestion text"), _text(item.get("why"), "suggestion reason")
            problem = (_too_long(text, MAX_TEXT, "text") or _too_long(text, MAX_TEXT, "text", MAX_WORDS)
                       or _too_long(why, MAX_REASON, "reason"))
            if problem:
                dropped.append(f"edit {number} dropped: {problem}")
                continue
            if ghosts >= MAX_GHOSTS:
                dropped.append(f"edit {number} dropped: only {MAX_GHOSTS} suggestions are kept")
                continue
            ghosts += 1
            edits.append(Ghost(anchor, text, why))
    if items and not edits:
        raise JamError("Nothing usable was left in the brain's answer after trimming it.")
    return JamEdits(edits, dropped)


# ---------------------------------------------------------------- brains

_HOME_PLACES = (
    "~/.local/bin",
    "~/.claude/local",
    "~/.claude/bin",
    "~/.bun/bin",
    "~/.volta/bin",
    "~/.npm-global/bin",
    "~/.local/share/mise/shims",
    "~/.mise/shims",
)
_SYSTEM_PLACES = ("/opt/homebrew/bin", "/usr/local/bin")
_HOME_PATTERNS = (  # globs under the home folder, newest-looking name last
    ".nvm/versions/node/*/bin/claude",
    ".local/share/mise/installs/claude/*/claude",
    ".local/share/mise/installs/claude/*/bin/claude",
    ".local/share/mise/installs/*/*/bin/claude",
)


def find_claude(extra_dirs=()) -> str | None:
    """`claude` on PATH, else in the places installers use (a Mac app starts with a bare PATH)."""
    found = shutil.which("claude")
    if found:
        return found
    home = Path("~").expanduser()
    for place in (*extra_dirs, *_HOME_PLACES, *_SYSTEM_PLACES):
        candidate = Path(place).expanduser() / "claude"
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return str(candidate)
    for pattern in _HOME_PATTERNS:
        for candidate in sorted(home.glob(pattern), reverse=True):
            if candidate.is_file() and os.access(candidate, os.X_OK):
                return str(candidate)
    return None


class ClaudeCodeBrain:
    """The person's own signed-in Claude Code, run as `claude -p` with no tools, no files and no saved session."""

    def __init__(self, model: str | None = "sonnet", timeout: float = 90, extra_dirs=()):
        self.model, self.timeout, self.extra_dirs = model, timeout, tuple(extra_dirs)

    def complete(self, system: str, user: str) -> str:
        exe = find_claude(self.extra_dirs)
        if not exe:
            raise BrainNotSetUp("Claude Code is not installed here. Install it and sign in, or pick another brain in Settings.")
        command = [exe, "-p", "--output-format", "json", "--tools", "", "--no-session-persistence",
                   "--setting-sources", "", "--strict-mcp-config", "--system-prompt", system]
        if self.model:
            command += ["--model", self.model]
        # npm installs are `#!/usr/bin/env node`: the folder that holds claude usually holds node too
        env = {**os.environ, "PATH": str(Path(exe).parent) + os.pathsep + os.environ.get("PATH", "")}
        with tempfile.TemporaryDirectory(prefix="jam-") as empty:  # nothing to read in the working folder
            try:
                done = subprocess.run(command, input=user, capture_output=True, text=True,
                                      timeout=self.timeout, cwd=empty, env=env)
            except subprocess.TimeoutExpired:
                raise BrainUnavailable(f"Claude Code took longer than {int(self.timeout)} seconds; try again.") from None
            except OSError as exc:
                raise BrainUnavailable(f"Claude Code could not start: {exc}") from None
        try:
            payload = json.loads(done.stdout)
        except ValueError:
            payload = None
        if done.returncode != 0 or not isinstance(payload, dict) or payload.get("is_error"):
            detail = (payload or {}).get("result") if isinstance(payload, dict) else None
            detail = detail or done.stderr.strip() or done.stdout.strip() or f"exit code {done.returncode}"
            raise BrainUnavailable(f"Claude Code did not answer: {detail[:300]}")
        result = payload.get("result")
        if not isinstance(result, str):
            raise BrainUnavailable("Claude Code answered with nothing.")
        return result


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """urllib copies Authorization and api-key headers to a redirect target; refuse every redirect instead."""

    def redirect_request(self, *args, **kwargs):
        return None


def _opener():
    return urllib.request.build_opener(_NoRedirect, urllib.request.HTTPSHandler(context=https_context()))


class OpenAICompatibleBrain:
    """Any chat-completions endpoint: base_url + model, or Azure OpenAI (endpoint + deployment + api-version).

    The key (the environment variable, else the saved one) is sent only as a header and never shown."""

    def __init__(self, base_url: str = "", model: str = "", *, azure_endpoint: str = "", deployment: str = "",
                 api_version: str = "2024-10-21", key_env: str = JAM_KEY_ENV, timeout: float = 90, key: str = ""):
        self._key = key  # a saved key (Settings → AI); the environment variable still wins, for scripts
        self.base_url, self.model = base_url.rstrip("/"), model
        self.azure_endpoint, self.deployment = azure_endpoint.rstrip("/"), deployment
        self.api_version, self.key_env, self.timeout = api_version, key_env, timeout
        if not (self.azure_endpoint and self.deployment) and not (self.base_url and self.model):
            raise BrainNotSetUp("Set a base URL and model, or an Azure endpoint and deployment, for this brain.")
        for url in (self.base_url, self.azure_endpoint):
            parts = urlparse(url)
            if url and not (parts.scheme == "https" or (parts.scheme == "http" and parts.hostname in LOOPBACK_HOSTS)):
                raise BrainUnavailable("The model address must start with https:// (plain http is only allowed for this computer).")

    def request_for(self, system: str, user: str) -> urllib.request.Request:
        key = os.environ.get(self.key_env, "") or self._key
        if not key:
            raise BrainNotSetUp(f"No API key: add one in Settings → AI, or set the {self.key_env} environment variable.")
        body = {"messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
                "response_format": {"type": "json_object"}}
        headers = {"Content-Type": "application/json"}
        if self.azure_endpoint:
            url = (f"{self.azure_endpoint}/openai/deployments/{self.deployment}/chat/completions"
                   f"?api-version={self.api_version}")
            headers["api-key"] = key
        else:
            url = f"{self.base_url}/chat/completions"
            headers["Authorization"] = f"Bearer {key}"
            body["model"] = self.model
        return urllib.request.Request(url, json.dumps(body).encode(), headers, method="POST")

    def complete(self, system: str, user: str) -> str:
        request = self.request_for(system, user)
        try:
            with _opener().open(request, timeout=self.timeout) as response:
                payload = json.load(response)
        except urllib.error.HTTPError as exc:
            exc.close()
            raise BrainUnavailable(f"The model service refused the request (HTTP {exc.code}).") from None
        except (urllib.error.URLError, OSError, TimeoutError) as exc:
            raise BrainUnavailable(f"The model service could not be reached: {getattr(exc, 'reason', exc)}") from None
        except ValueError:
            raise BrainUnavailable("The model service answered with something that is not JSON.") from None
        try:
            return payload["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError):
            raise BrainUnavailable("The model service answered without a message.") from None
