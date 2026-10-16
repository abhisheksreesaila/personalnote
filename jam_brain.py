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
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

from download_tls import open_url

MAX_EDITS = 12
MAX_GHOSTS = 3
MAX_WORDS = 4
MAX_TEXT = 40
MAX_REASON = 80
MAX_EMOJI = 8
JAM_KEY_ENV = "PERSONAL_NOTE_JAM_API_KEY"
ALLOWED_OPS = {"add_branch", "react", "ghost"}


class JamError(Exception):
    """The brain could not be reached or answered badly; the message is shown to the person as is."""


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


def build_user_prompt(map_json: dict, transcript: str) -> str:
    outline = [
        {"id": n["id"], "parent_id": n.get("parentId"), "text": n.get("text", "")}
        for n in map_json.get("nodes", [])
    ]
    return (
        f"Mind map title: {map_json.get('title', '')}\n"
        f"Centre node id: {map_json.get('rootId', '')}\n"
        f"Map (nodes):\n{json.dumps(outline, ensure_ascii=False)}\n\n"
        f"The person just said:\n\"\"\"\n{transcript.strip()}\n\"\"\"\n\nJSON only."
    )


def propose(map_json: dict, transcript: str, brain) -> JamEdits:
    """Ask the brain for edits to `map_json` given `transcript`; return them validated, or raise JamError."""
    if not transcript or not transcript.strip():
        raise JamError("There is nothing to jam on yet: say something first.")
    raw = brain.complete(SYSTEM_PROMPT, build_user_prompt(map_json, transcript))
    return parse_edits(raw, map_json)


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


def _text(value, what: str, limit=MAX_TEXT, required=True) -> str:
    if value is None or value == "":
        if required:
            raise JamError(f"The brain left out the {what}.")
        return ""
    if not isinstance(value, str):
        raise JamError(f"The brain gave a {what} that is not text.")
    value = value.strip()
    if len(value) > limit:
        raise JamError(f"The brain gave a {what} that is too long ({len(value)} characters, at most {limit}).")
    return value


def _keyword(value, what: str) -> str:
    value = _text(value, what)
    if len(value.split()) > MAX_WORDS:
        raise JamError(f"The brain gave a {what} longer than {MAX_WORDS} words: \"{value}\".")
    return value


def parse_edits(raw: str, map_json: dict) -> JamEdits:
    data = _extract_json(raw)
    items = data.get("edits") if isinstance(data, dict) else None
    if not isinstance(items, list):
        raise JamError("The brain's answer has no list of edits.")
    if len(items) > MAX_EDITS:
        raise JamError(f"The brain proposed {len(items)} edits; at most {MAX_EDITS} are accepted.")

    known = {str(n["id"]) for n in map_json.get("nodes", [])}
    existing = set(known)
    edits, ghosts = [], 0
    for item in items:
        if not isinstance(item, dict):
            raise JamError("The brain gave an edit that is not an object.")
        op = item.get("op")
        if op not in ALLOWED_OPS:
            raise JamError(f"The brain tried \"{op}\", which is not allowed: it may only add, react or suggest.")
        if op == "add_branch":
            parent = item.get("parent_id")
            if parent not in known:
                raise JamError(f"The brain put a branch under an unknown node ({parent!r}).")
            new_id = _text(item.get("id"), "branch id", 40, required=False)
            if new_id and new_id in existing:
                raise JamError(f"The brain reused the id {new_id!r}, which would replace an existing node.")
            emoji = _text(item.get("emoji"), "emoji", MAX_EMOJI, required=False)
            edits.append(AddBranch(parent, _keyword(item.get("text"), "branch text"), emoji, new_id))
            if new_id:
                known.add(new_id)
                existing.add(new_id)
        elif op == "react":
            node = item.get("node_id")
            if node not in known:
                raise JamError(f"The brain reacted to an unknown node ({node!r}).")
            if item.get("vote") not in ("up", "down"):
                raise JamError("The brain's reaction must be \"up\" or \"down\".")
            edits.append(React(node, item["vote"], _text(item.get("reason"), "reaction reason", MAX_REASON)))
        else:
            parent = item.get("parent_id")
            if parent not in known:
                raise JamError(f"The brain hung a suggestion on an unknown node ({parent!r}).")
            ghosts += 1
            if ghosts > MAX_GHOSTS:
                raise JamError(f"The brain offered more than {MAX_GHOSTS} suggestions.")
            edits.append(Ghost(parent, _keyword(item.get("text"), "suggestion text"), _text(item.get("why"), "suggestion reason", MAX_REASON)))
    return JamEdits(edits)


# ---------------------------------------------------------------- brains

_CLAUDE_PLACES = (
    "~/.local/bin",
    "~/.claude/local",
    "~/.claude/bin",
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "~/.local/share/mise/shims",
    "~/.mise/shims",
    "~/.volta/bin",
    "~/.npm-global/bin",
)


def find_claude(extra_dirs=()) -> str | None:
    """`claude` on PATH, else in the places installers use (a Mac app starts with a bare PATH)."""
    found = shutil.which("claude")
    if found:
        return found
    for place in (*extra_dirs, *_CLAUDE_PLACES):
        candidate = Path(place).expanduser() / "claude"
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return str(candidate)
    mise_installs = Path("~/.local/share/mise/installs").expanduser()
    if mise_installs.is_dir():
        for candidate in sorted(mise_installs.glob("*/*/bin/claude")):
            if os.access(candidate, os.X_OK):
                return str(candidate)
    return None


class ClaudeCodeBrain:
    """The person's own signed-in Claude Code, run as `claude -p` with no tools, no files and no saved session."""

    def __init__(self, model: str | None = None, timeout: float = 90, extra_dirs=()):
        self.model, self.timeout, self.extra_dirs = model, timeout, tuple(extra_dirs)

    def complete(self, system: str, user: str) -> str:
        exe = find_claude(self.extra_dirs)
        if not exe:
            raise JamError("Claude Code is not installed here. Install it and sign in, or pick another brain in Settings.")
        command = [exe, "-p", "--output-format", "json", "--tools", "", "--no-session-persistence",
                   "--setting-sources", "", "--system-prompt", system]
        if self.model:
            command += ["--model", self.model]
        with tempfile.TemporaryDirectory(prefix="jam-") as empty:  # nothing to read in the working folder
            try:
                done = subprocess.run(command, input=user, capture_output=True, text=True,
                                      timeout=self.timeout, cwd=empty)
            except subprocess.TimeoutExpired:
                raise JamError(f"Claude Code took longer than {int(self.timeout)} seconds; try again.") from None
            except OSError as exc:
                raise JamError(f"Claude Code could not start: {exc}") from None
        try:
            payload = json.loads(done.stdout)
        except ValueError:
            payload = None
        if done.returncode != 0 or not isinstance(payload, dict) or payload.get("is_error"):
            detail = (payload or {}).get("result") if isinstance(payload, dict) else None
            detail = detail or done.stderr.strip() or done.stdout.strip() or f"exit code {done.returncode}"
            raise JamError(f"Claude Code did not answer: {detail[:300]}")
        result = payload.get("result")
        if not isinstance(result, str):
            raise JamError("Claude Code answered with nothing.")
        return result


class OpenAICompatibleBrain:
    """Any chat-completions endpoint: base_url + model, or Azure OpenAI (endpoint + deployment + api-version).

    The key is read from the environment on every call and sent only as a header."""

    def __init__(self, base_url: str = "", model: str = "", *, azure_endpoint: str = "", deployment: str = "",
                 api_version: str = "2024-10-21", key_env: str = JAM_KEY_ENV, timeout: float = 90):
        self.base_url, self.model = base_url.rstrip("/"), model
        self.azure_endpoint, self.deployment = azure_endpoint.rstrip("/"), deployment
        self.api_version, self.key_env, self.timeout = api_version, key_env, timeout
        if not (self.azure_endpoint and self.deployment) and not (self.base_url and self.model):
            raise JamError("Set a base URL and model, or an Azure endpoint and deployment, for this brain.")

    def request_for(self, system: str, user: str) -> urllib.request.Request:
        key = os.environ.get(self.key_env, "")
        if not key:
            raise JamError(f"No API key: set the {self.key_env} environment variable.")
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
            with open_url(request, timeout=self.timeout) as response:
                payload = json.load(response)
        except urllib.error.HTTPError as exc:
            exc.close()
            raise JamError(f"The model service refused the request (HTTP {exc.code}).") from None
        except (urllib.error.URLError, OSError, TimeoutError) as exc:
            raise JamError(f"The model service could not be reached: {getattr(exc, 'reason', exc)}") from None
        except ValueError:
            raise JamError("The model service answered with something that is not JSON.") from None
        try:
            return payload["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError):
            raise JamError("The model service answered without a message.") from None
