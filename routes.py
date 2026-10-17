import asyncio
import json
import logging
import os
import threading
import time
import subprocess
import sys
from datetime import datetime
from pathlib import Path

from fasthtml.common import FastHTML
from starlette.responses import FileResponse, JSONResponse, Response
from starlette.staticfiles import StaticFiles

from ai_settings import AISettings, AISettingsError
import jam_brain
from plugin_settings import PluginSettings, PluginSettingsError
from app_paths import app_data_dir, default_database_path, resource_root
from portability import (
    PortabilityError,
    import_workspace_backup,
    markdown_archive,
    utc_timestamp,
    workspace_backup,
)
from media_store import MAX_MEDIA_BYTES, MEDIA_NAME, sniff_image
from services import (
    ConflictError,
    InvalidNoteContentError,
    NoteService,
    NotFoundError,
    SecureAuthError,
    SecureError,
    SecureLockedError,
    SecureNoteAgentError,
    WorkspaceImportError,
)
from vault import PortabilityVaultError, export_vault_archive, import_vault_archive
from meaning_index import MeaningIndexer
from search_runtime import SearchError, SearchRuntime, default_search_runtime, reap_dead_cli_engines
from x_bookmarks import XError
from x_sync import XSync
from voice_runtime import VoiceError, VoiceRuntime, app_version


logger = logging.getLogger(__name__)
JAM_MAX_NODES = 500
JAM_MAX_TRANSCRIPT = 6000
ROOT = resource_root()


def runtime_capabilities(mindmap_on: bool = True, voice_on: bool = True) -> dict:
    """Return only capabilities that are part of the v1 notebook runtime."""
    return {
        "storage": {
            "engine": "sqlite",
            "location": "this-device",
            "encryption": "secure-notes",  # whole notes marked secure are AES-256-GCM encrypted; the rest of the file is plain
        },
        "portability": {
            "workspaceBackup": True,
            "mergeImport": True,
            "markdownAssets": True,
        },
        "modules": {
            "mindmap": {"available": mindmap_on, "loading": "on-demand"},
            "page": {"available": True, "loading": "on-demand"},
            "voice": {
                "available": voice_on,
                "localServiceRequired": True,
                "durableOutput": "transcript-text",
                "audioRetention": "none",
            },
        },
    }


APP_HEADER = "x-personal-note"


def default_voice_runtime() -> VoiceRuntime:
    """Voice lives in the app-data folder (PERSONAL_NOTE_VOICE_DIR overrides it), never beside the notes."""
    folder = os.environ.get("PERSONAL_NOTE_VOICE_DIR")
    return VoiceRuntime(root=Path(folder) if folder else app_data_dir() / "voice", version=app_version(ROOT))


def close_search(app) -> None:
    """The app is closing: stop the engine first, so a batch waiting on it fails at once, then the thread that was waiting."""
    app.state.search.shutdown()
    app.state.indexer.stop()
    app.state.x_sync.stop()


def speedtest_folder() -> Path:
    """The speed test's results (F-034) live in the app-data folder (PERSONAL_NOTE_SPEEDTEST_DIR overrides it), never beside the notes."""
    folder = os.environ.get("PERSONAL_NOTE_SPEEDTEST_DIR")
    return Path(folder) if folder else app_data_dir() / "speedtest"


MAX_SPEEDTEST_REPORT_BYTES = 1024 * 1024


SPEEDTEST_SETTLE_SECONDS = 1.5


def speedtest_command() -> list[str]:
    if getattr(sys, "frozen", False):
        return [sys.executable, "--speedtest"]
    return [sys.executable, str(Path(__file__).resolve().parent / "desktop.py"), "--speedtest", "--no-build"]


def launch_speedtest_instance(settle: float = SPEEDTEST_SETTLE_SECONDS):
    """Start the speed test as a separate app instance (temporary notebook, own window profile, own port): it never runs in the person's notebook.

    Its output goes to launch.log in the speed test's results folder. Raises OSError when it cannot start or has already exited after `settle` seconds
    (a missing window engine, say); otherwise returns the running process.
    """
    folder = speedtest_folder()
    folder.mkdir(parents=True, exist_ok=True)
    log_path = folder / "launch.log"
    with open(log_path, "ab") as log:
        process = subprocess.Popen(speedtest_command(), stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
    try:
        code = process.wait(timeout=settle)
    except subprocess.TimeoutExpired:
        return process
    raise OSError(f"The speed test window closed at once (exit code {code}); see {log_path}")


LOOPBACK_NAMES = {"127.0.0.1", "localhost", "::1"}


def host_name(header: str) -> str:
    """The host part of a Host header: no port, no IPv6 brackets, lower case."""
    header = header.strip().lower()
    if header.startswith("["):
        return header[1:].split("]", 1)[0]
    return header.rsplit(":", 1)[0] if header.count(":") == 1 else header


class LoopbackHostMiddleware:
    """Refuse requests whose Host is not a loopback name (DNS rebinding: another site's name resolving to 127.0.0.1)."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] in ("http", "websocket"):
            headers = dict(scope.get("headers") or [])
            if host_name(headers.get(b"host", b"").decode("latin-1")) not in LOOPBACK_NAMES:
                if scope["type"] == "http":
                    await Response("Forbidden host", status_code=403)(scope, receive, send)
                else:
                    await send({"type": "websocket.close", "code": 1008})
                return
        await self.app(scope, receive, send)


SECURE_IDLE_SECONDS = 300.0  # secure notes lock again after 5 quiet minutes


def secure_idle_seconds() -> float:
    """The quiet time before secure notes lock. `PERSONAL_NOTE_SECURE_IDLE_SECONDS` shortens it for checks; nonsense keeps 5 minutes."""
    try:
        value = float(os.environ.get("PERSONAL_NOTE_SECURE_IDLE_SECONDS", ""))
    except ValueError:
        return SECURE_IDLE_SECONDS
    return value if value > 0 else SECURE_IDLE_SECONDS


def create_app(
    database_path: Path | str | None = None,
    voice: VoiceRuntime | None = None,
    search: SearchRuntime | None = None,
    bound_host: str | None = None,
    speedtest_instance: bool = False,
    speedtest_launcher=None,
    desktop_host: bool = False,
    secure_platform=None,
    ai: AISettings | None = None,
    plugins: PluginSettings | None = None,
    brain=None,
    x_sync: XSync | None = None,
) -> FastHTML:
    """`bound_host` is the address the server listens on; when it is loopback, only loopback Host headers are served.
    `brain` is a function returning the jam brain (a check script's scripted one); without it, Settings → AI decides."""
    data_path = Path(database_path or default_database_path())
    speedtest_process: dict = {}  # the speed test this app started: one at a time
    search = search or default_search_runtime(data_path)
    service = NoteService(data_path, secure_platform=secure_platform, embedder=search)
    service.keyring.set_idle_timeout(secure_idle_seconds())
    # FastHTML writes a session key file; keep it beside the database, not in the (possibly read-only) cwd.
    app = FastHTML(sess_cls=None, key_fname=str(data_path.with_name(".sesskey")))
    app.state.note_service = service
    app.state.voice = voice or default_voice_runtime()
    app.state.voice.enabled = lambda: app.state.plugins.enabled("voice")
    app.state.search = search
    app.state.ai = ai or AISettings()
    app.state.plugins = plugins or PluginSettings()
    app.state.indexer = MeaningIndexer(service, search, enabled=lambda: app.state.plugins.enabled("meaning"))
    app.state.x_sync = x_sync or XSync(service)  # started by main.py / desktop.py, not here: a test's app never reaches X
    if not speedtest_instance:
        if app.state.plugins.enabled("meaning"):
            app.state.indexer.start()  # a quiet thread: it embeds only when the download is installed, never on a request
        if getattr(search, 'root', None):  # an engine a command that died left behind (a Mac has no way to stop it with its parent): stopped off the main thread
            threading.Thread(target=reap_dead_cli_engines, args=(search.root,), name='reap-cli-engines', daemon=True).start()
    if bound_host is not None and host_name(bound_host) in LOOPBACK_NAMES:
        app.add_middleware(LoopbackHostMiddleware)

    def json_error(error: Exception) -> JSONResponse:
        if isinstance(error, SecureLockedError):
            status = 423  # Locked
        elif isinstance(error, (SecureAuthError, SecureNoteAgentError)):
            status = 403
        elif isinstance(error, SecureError):
            status = 400
        else:
            status = 404 if isinstance(error, NotFoundError) else 409 if isinstance(error, ConflictError) else 400 if isinstance(error, InvalidNoteContentError) else 500
        if status == 500:
            logger.exception("event=api.request outcome=failed error_class=%s", type(error).__name__)
        return JSONResponse(
            {"error": str(error) if status in {400, 403, 404, 409, 423} else "Request failed"},
            status_code=status,
        )

    async def payload(request) -> dict:
        try:
            value = await request.json()
            return value if isinstance(value, dict) else {}
        except Exception:
            return {}

    @app.get("/health")
    def health():
        return JSONResponse({"status": "ok", "app": "personal-note", "backend": "fasthtml", "database": str(data_path.resolve())})  # the command line checks this is its own notebook

    @app.get("/api/settings/capabilities")
    def settings_capabilities():
        return JSONResponse(runtime_capabilities(app.state.plugins.enabled("mindmap"), app.state.plugins.enabled("voice")))

    def plugin_response(plugin_id: str, call, error_class, status_code: int = 200) -> JSONResponse:
        """Run `call` for a plugin's feature; while the plugin is off nothing starts and the reason is plain (409)."""
        try:
            app.state.plugins.require(plugin_id)
            return JSONResponse(call(), status_code=status_code)
        except (error_class, PluginSettingsError) as error:
            return JSONResponse({"error": str(error)}, status_code=409)

    def voice_response(call, status_code: int = 200) -> JSONResponse:
        return plugin_response("voice", call, VoiceError, status_code)

    def from_this_app(request) -> bool:
        # A custom header cannot be sent cross-site without a CORS preflight, which this server never allows,
        # so another web page cannot start a 750 MB download or remove voice behind the user's back.
        return bool(request.headers.get(APP_HEADER))

    def forbidden() -> JSONResponse:
        return JSONResponse({"error": "Forbidden"}, status_code=403)

    @app.get("/api/voice/status")
    def voice_status():
        return JSONResponse(app.state.voice.status())

    @app.post("/api/voice/install")
    def voice_install(request):
        if not from_this_app(request):
            return forbidden()
        return voice_response(lambda: app.state.voice.start_install(), 202)

    @app.post("/api/voice/engine/start")
    def voice_engine_start(request):
        if not from_this_app(request):
            return forbidden()
        return voice_response(lambda: app.state.voice.start_engine())

    @app.post("/api/voice/cancel")
    def voice_cancel(request):
        if not from_this_app(request):
            return forbidden()
        return JSONResponse(app.state.voice.cancel_install())

    @app.delete("/api/voice")
    def voice_remove(request):
        if not from_this_app(request):
            return forbidden()
        try:
            return JSONResponse(app.state.voice.remove())
        except VoiceError as error:
            return JSONResponse({"error": str(error)}, status_code=409)

    def search_response(call, status_code: int = 200) -> JSONResponse:
        return plugin_response("meaning", call, SearchError, status_code)

    @app.get("/api/search-meaning/status")
    def search_meaning_status():
        return JSONResponse(app.state.search.status() | {"index": app.state.indexer.status()})

    @app.post("/api/search-meaning/install")
    def search_meaning_install(request):
        if not from_this_app(request):
            return forbidden()
        return search_response(lambda: app.state.search.start_install(), 202)

    @app.post("/api/search-meaning/cancel")
    def search_meaning_cancel(request):
        if not from_this_app(request):
            return forbidden()
        return JSONResponse(app.state.search.cancel_install())

    def follow_plugin(plugin_id: str, on: bool) -> None:
        """Off stops what the plugin started (the data and the downloads stay); on lets it start again, lazily as before."""
        if plugin_id == "meaning" and not on:
            app.state.indexer.stop()
            app.state.search.cancel_install()
            app.state.search.stop_engine()  # not shutdown(): switching on again must be able to start it
        elif plugin_id == "meaning" and not speedtest_instance:
            app.state.indexer.start()
        elif plugin_id == "voice" and not on:
            app.state.voice.cancel_install()
            app.state.voice.stop_engine()

    @app.get("/api/plugins")
    def plugins_view():
        return JSONResponse({"plugins": app.state.plugins.view()})

    @app.post("/api/plugins/{plugin_id}")
    async def plugins_switch(request, plugin_id: str):
        if not from_this_app(request):
            return forbidden()
        try:
            state = app.state.plugins.set_enabled(plugin_id, (await payload(request)).get("enabled"))
        except PluginSettingsError as error:
            return JSONResponse({"error": str(error)}, status_code=400)
        await asyncio.to_thread(follow_plugin, plugin_id, state[plugin_id])  # stopping an engine or the indexer waits for a batch: never on the event loop, which saves notes
        return JSONResponse({"plugins": state})

    jam_turn_lock = threading.Lock()  # one brain call at a time: a plan's limits are for the person, not for a stuck button

    def checked_jam_request(body: dict):
        """(map, transcript, waiting ghost texts) from a request body, or raise ValueError in plain words."""
        map_json, transcript, ghosts = body.get("map"), body.get("transcript"), body.get("ghosts", [])
        nodes = map_json.get("nodes") if isinstance(map_json, dict) else None
        if not isinstance(nodes, list) or not 0 < len(nodes) <= JAM_MAX_NODES or not all(isinstance(n, dict) and isinstance(n.get("id"), str) for n in nodes):
            raise ValueError("Send the mind map to jam on.")
        if not isinstance(transcript, str) or not transcript.strip():
            raise ValueError("There is nothing to jam on yet: say something first.")
        if len(transcript) > JAM_MAX_TRANSCRIPT:
            raise ValueError("That is too much to jam on at once: jam a little sooner.")
        if not isinstance(ghosts, list) or len(ghosts) > 10 or not all(isinstance(g, str) for g in ghosts):
            raise ValueError("The waiting suggestions must be a short list of text.")
        return map_json, transcript, ghosts

    def jam_turn_edits(map_json: dict, transcript: str, ghosts: list) -> list:
        edits = jam_brain.propose(map_json, transcript, brain() if brain else app.state.ai.brain(), ghosts).edits
        wire = {jam_brain.AddBranch: lambda e: {"op": "add_branch", "parentId": e.parent_id, "text": e.text, "emoji": e.emoji, "id": e.id},
                jam_brain.React: lambda e: {"op": "react", "nodeId": e.node_id, "vote": e.vote, "reason": e.reason},
                jam_brain.Ghost: lambda e: {"op": "ghost", "parentId": e.parent_id, "text": e.text, "why": e.why}}
        return [wire[type(edit)](edit) for edit in edits]

    @app.post("/api/jam/turn")
    async def jam_turn(request):
        """One jam turn: the map and what was said go to the brain, the validated edits come back. Nothing is saved here."""
        if not from_this_app(request):
            return forbidden()
        try:
            app.state.plugins.require("jam")
            app.state.plugins.require("mindmap")
            app.state.plugins.require("voice")  # ADR 0007: Jam needs Mind maps and Voice
        except PluginSettingsError as error:
            return JSONResponse({"error": str(error)}, status_code=409)
        try:
            map_json, transcript, ghosts = checked_jam_request(await payload(request))
        except ValueError as error:
            return JSONResponse({"error": str(error)}, status_code=400)
        if not jam_turn_lock.acquire(blocking=False):
            return JSONResponse({"error": "Claude is still working on the last turn.", "busy": True}, status_code=409)
        try:
            started = time.monotonic()
            edits = await asyncio.to_thread(jam_turn_edits, map_json, transcript, ghosts)  # a model call takes seconds: never on the event loop, which saves notes
            return JSONResponse({"edits": edits, "seconds": round(time.monotonic() - started, 1)})
        except jam_brain.BrainNotSetUp as error:
            return JSONResponse({"error": str(error), "setup": True}, status_code=409)
        except jam_brain.JamError as error:
            return JSONResponse({"error": str(error)}, status_code=502)
        finally:
            jam_turn_lock.release()

    @app.get("/api/ai/settings")
    def ai_settings_view():
        return JSONResponse(app.state.ai.view())

    async def ai_response(request, call) -> JSONResponse:
        if not from_this_app(request):
            return forbidden()
        try:
            return JSONResponse(await asyncio.to_thread(call, await payload(request)))
        except AISettingsError as error:
            return JSONResponse({"error": str(error)}, status_code=400)

    @app.post("/api/ai/settings")
    async def ai_settings_save(request):
        return await ai_response(request, app.state.ai.save)

    @app.delete("/api/ai/key")
    async def ai_key_remove(request):
        return await ai_response(request, lambda _: app.state.ai.remove_key())

    @app.post("/api/ai/test")
    async def ai_test(request):
        # one real model call (off the event loop, see ai_response); it tests the saved settings
        return await ai_response(request, lambda _: app.state.ai.test())

    def x_response(call) -> JSONResponse:
        try:
            call()
        except XError as error:
            return JSONResponse({"error": str(error)}, status_code=409)
        return JSONResponse(app.state.x_sync.status())

    @app.get("/api/x/status")
    def x_status():
        return JSONResponse(app.state.x_sync.status())

    @app.post("/api/x/client-id")
    async def x_client_id(request):
        if not from_this_app(request):
            return forbidden()
        value = (await payload(request)).get("clientId")
        return x_response(lambda: app.state.x_sync.set_client_id(value))

    @app.post("/api/x/connect")
    def x_connect(request):
        if not from_this_app(request):
            return forbidden()
        return x_response(app.state.x_sync.connect)

    @app.post("/api/x/sync")
    def x_sync_now(request):
        if not from_this_app(request):
            return forbidden()
        return x_response(app.state.x_sync.sync)

    @app.delete("/api/x")
    def x_disconnect(request):
        if not from_this_app(request):
            return forbidden()
        return x_response(app.state.x_sync.disconnect)

    @app.get("/api/speedtest/status")
    def speedtest_status():
        """True only in the separate instance the speed test runs in (a temporary notebook): the page runs the test there and nowhere else."""
        # canLaunch: only the desktop app starts the test (it has a window to open it in); the speed test instance itself runs it.
        return JSONResponse({"instance": speedtest_instance, "canLaunch": bool(desktop_host and not speedtest_instance)})

    @app.post("/api/speedtest/launch")
    def speedtest_launch(request):
        """The person's own app starts the speed test as a separate instance; it never runs the test in this notebook."""
        if not from_this_app(request):
            return forbidden()
        if speedtest_instance:
            return JSONResponse({"error": "This is the speed test"}, status_code=409)
        if not desktop_host:
            return JSONResponse({"error": "The speed test starts from the desktop app"}, status_code=409)
        running = speedtest_process.get("process")
        if running is not None and running.poll() is None:
            return JSONResponse({"error": "A speed test is already running"}, status_code=409)
        try:
            speedtest_process["process"] = (speedtest_launcher or launch_speedtest_instance)()
        except OSError as error:
            logger.exception("event=speedtest.launch outcome=failed")
            return JSONResponse({"error": f"The speed test could not be started: {error}"}, status_code=500)
        return JSONResponse({"started": True}, status_code=202)

    @app.post("/api/speedtest/report")
    async def speedtest_report(request):
        """Saves the speed test's results as a text file and a JSON file the person can find again (and send along)."""
        if not from_this_app(request):
            return forbidden()
        raw = await request.body()
        if len(raw) > MAX_SPEEDTEST_REPORT_BYTES:
            return JSONResponse({"error": "The report is too large"}, status_code=413)
        try:
            body = json.loads(raw)
        except ValueError:
            body = {}
        body = body if isinstance(body, dict) else {}
        text = body.get("text")
        data = body.get("data")
        if not isinstance(text, str) or not text.strip() or not isinstance(data, dict):
            return JSONResponse({"error": "A speed test report needs text and data"}, status_code=400)
        folder = speedtest_folder()
        try:
            folder.mkdir(parents=True, exist_ok=True)
            stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
            name = f"speedtest-{stamp}"
            number = 1
            while (folder / f"{name}.txt").exists() or (folder / f"{name}.json").exists():
                number += 1
                name = f"speedtest-{stamp}-{number}"
            text_path = folder / f"{name}.txt"
            json_path = folder / f"{name}.json"
            text_path.write_text(text if text.endswith("\n") else text + "\n", encoding="utf-8")
            json_path.write_text(json.dumps(data, indent=1), encoding="utf-8")
        except OSError:
            logger.exception("event=speedtest.report outcome=failed")
            return JSONResponse({"error": "The results could not be saved"}, status_code=500)
        return JSONResponse({"path": str(text_path), "jsonPath": str(json_path)}, status_code=201)

    @app.get("/api/changes")
    def changes(request):
        try:
            since = int(request.query_params.get("since"))
        except (TypeError, ValueError):
            since = None
        return JSONResponse(service.changes_since(since) | {"agents": service.active_agents()})

    @app.get("/api/notebooks")
    def list_notebooks():
        return JSONResponse(service.list_notebooks())

    @app.post("/api/notebooks")
    async def create_notebook(request):
        return JSONResponse(service.create_notebook(await payload(request)), status_code=201)

    @app.put("/api/notebooks/{notebook_id}")
    async def update_notebook(request, notebook_id: int):
        try:
            return JSONResponse(service.update_notebook(notebook_id, await payload(request)))
        except Exception as error:
            return json_error(error)

    @app.delete("/api/notebooks/{notebook_id}")
    def delete_notebook(notebook_id: int):
        try:
            return JSONResponse(service.delete_notebook(notebook_id))
        except Exception as error:
            return json_error(error)

    @app.get("/api/search/meaning")
    def search_meaning(request):
        """The omnibar's "By meaning" group. Never an error and never a download: without the install, or with the engine down, it is []."""
        try:
            limit = max(1, min(int(request.query_params.get("limit", 5)), 20))
        except ValueError:
            limit = 5
        try:
            app.state.plugins.require("meaning")
        except PluginSettingsError as error:  # off: nothing is asked of the engine
            return JSONResponse({"error": str(error)}, status_code=409) if request.query_params.get("strict") else JSONResponse([])
        try:
            return JSONResponse(service.meaning_matches(request.query_params.get("q", ""), limit))
        except SearchError as error:
            if request.query_params.get("strict"):  # the command line wants to know "engine down" from "no match"; the omnibar does not
                return JSONResponse({"error": str(error)}, status_code=503)
            return JSONResponse([])

    @app.get("/api/search")
    def search(request):
        return JSONResponse(service.search(request.query_params.get("q", "")))

    @app.get("/api/notes")
    def list_notes():
        return JSONResponse(service.list_notes())

    @app.get("/api/note-links")
    def note_links(request):
        # What a link card shows (F-095): {resourceId: {id, title, excerpt, secure, notebook} | null when the note is gone}.
        return JSONResponse(service.note_links(request.query_params.get("refs", "").split(",")))

    @app.post("/api/notes/{note_id}/x-done")
    def x_done(request, note_id: int):
        if not from_this_app(request):
            return forbidden()
        try:
            return JSONResponse(service.mark_x_done(note_id))
        except Exception as error:
            return json_error(error)

    @app.get("/api/notes/{note_id}/agent-edit")
    def agent_edit(request, note_id: int):
        # The agent write that made this revision of the note (F-096): {edit: {id, agent, state, changed, ...} | null}.
        try:
            revision = int(request.query_params.get("revision"))
        except (TypeError, ValueError):
            revision = 0
        return JSONResponse({"edit": service.agent_edit_at(note_id, revision)})

    @app.post("/api/agent-edits/{edit_id}/undo")
    def undo_agent_edit(request, edit_id: int):
        if not from_this_app(request):
            return forbidden()
        try:
            return JSONResponse(service.undo_agent_edit(edit_id))
        except Exception as error:
            return json_error(error)

    @app.post("/api/agent-edits/{edit_id}/redo")
    def redo_agent_edit(request, edit_id: int):
        if not from_this_app(request):
            return forbidden()
        try:
            return JSONResponse(service.redo_agent_edit(edit_id))
        except Exception as error:
            return json_error(error)

    @app.get("/api/notes/{note_id}")
    def get_note(request, note_id: int):
        try:
            note = service.get_note(note_id)
            if note["secure"] and not note["locked"] and not from_this_app(request):
                # A casual local request (curl) gets the locked view; the words go only to this app.
                note = {**note, "content": None, "pageState": None, "locked": True}
            return JSONResponse(note)
        except Exception as error:
            return json_error(error)

    @app.post("/api/notes")
    async def create_note(request):
        body = await payload(request)
        try:
            if body.get("noteType") == "mindmap":
                app.state.plugins.require("mindmap")  # off: no new maps; the ones already there stay readable and in every backup
            return JSONResponse(service.create_note(body), status_code=201)
        except PluginSettingsError as error:
            return JSONResponse({"error": str(error)}, status_code=409)

    @app.put("/api/notes/{note_id}")
    async def update_note(request, note_id: int):
        try:
            return JSONResponse(service.update_note(note_id, await payload(request)))
        except Exception as error:
            return json_error(error)

    @app.patch("/api/notes/{note_id}/notebook")
    async def move_note(request, note_id: int):
        try:
            return JSONResponse(service.move_note(note_id, await payload(request)))
        except Exception as error:
            return json_error(error)

    @app.patch("/api/notes/{note_id}/icon")
    async def set_note_icon(request, note_id: int):
        try:
            return JSONResponse(service.set_note_icon(note_id, await payload(request)))
        except Exception as error:
            return json_error(error)

    @app.delete("/api/notes/{note_id}")
    def delete_note(note_id: int):
        try:
            service.delete_note(note_id)
            return Response(status_code=204)
        except Exception as error:
            return json_error(error)

    @app.get("/api/secure/status")
    def secure_status():
        return JSONResponse(service.secure_status())

    @app.post("/api/secure/unlock")
    async def secure_unlock(request):
        """Touch ID on a Mac (nothing in the body), a passphrase elsewhere, or the recovery key from any machine."""
        if not from_this_app(request):
            return forbidden()
        body = await payload(request)
        try:
            # Touch ID and scrypt wait or burn time: off the event loop, so the page's other requests keep being answered.
            return JSONResponse(await asyncio.to_thread(service.unlock_secure, passphrase=body.get("passphrase"), recovery_key=body.get("recoveryKey")))
        except Exception as error:
            return json_error(error)

    @app.post("/api/secure/passphrase")
    async def secure_add_passphrase(request):
        """Linux: add a passphrase wrap for the notes unlocked now (after a restore with the recovery key)."""
        if not from_this_app(request):
            return forbidden()
        try:
            passphrase = (await payload(request)).get("passphrase")
            return JSONResponse(await asyncio.to_thread(service.add_passphrase, passphrase))
        except Exception as error:
            return json_error(error)

    @app.post("/api/secure/touch")
    def secure_touch(request):
        """The open page is in use: renew the quiet time. Never unlocks anything."""
        if not from_this_app(request):
            return forbidden()
        return JSONResponse(service.touch_secure())

    @app.post("/api/secure/lock")
    def secure_lock(request):
        if not from_this_app(request):
            return forbidden()
        return JSONResponse(service.lock_secure())

    @app.post("/api/notes/{note_id}/secure")
    async def mark_note_secure(request, note_id: int):
        """Make the note secure. The first one on this computer returns `recoveryKey` once: show it, it is never kept."""
        if not from_this_app(request):
            return forbidden()
        body = await payload(request)
        try:
            return JSONResponse(await asyncio.to_thread(service.mark_secure, note_id, revision=body.get("revision"), passphrase=body.get("passphrase")))
        except Exception as error:
            return json_error(error)

    @app.delete("/api/notes/{note_id}/secure")
    def unmark_note_secure(request, note_id: int):
        if not from_this_app(request):
            return forbidden()
        try:
            return JSONResponse(service.unmark_secure(note_id))
        except Exception as error:
            return json_error(error)

    @app.get("/api/export/workspace")
    def export_workspace():
        body = workspace_backup(service)
        date = utc_timestamp()[:10]
        return JSONResponse(
            body,
            headers={"Content-Disposition": f'attachment; filename="personal-note-backup-{date}.json"'},
        )

    @app.get("/api/export/markdown")
    def export_markdown():
        date = utc_timestamp()[:10]
        return Response(
            markdown_archive(service),
            media_type="application/zip",
            headers={"Content-Disposition": f'attachment; filename="personal-note-markdown-{date}.zip"'},
        )

    @app.post("/api/media")
    async def upload_media(request):
        # A picture dropped, pasted or picked in the app: stored once under its SHA-256, so the note holds only `media/<name>`.
        if not from_this_app(request):  # a raw body can be sent cross-site without a preflight, unlike JSON
            return forbidden()
        try:
            if int(request.headers.get("content-length") or 0) > MAX_MEDIA_BYTES:
                return JSONResponse({"error": "That picture is larger than 20 MB"}, status_code=413)
        except ValueError:
            pass
        received = bytearray()
        async for chunk in request.stream():  # counted as it arrives: a body without Content-Length is cut off too
            received.extend(chunk)
            if len(received) > MAX_MEDIA_BYTES:
                return JSONResponse({"error": "That picture is larger than 20 MB"}, status_code=413)
        data = bytes(received)
        extension = sniff_image(data)
        if extension is None:
            return JSONResponse({"error": "That is not a PNG, JPEG, WebP or GIF picture"}, status_code=400)
        path = service.media.put_bytes(data, extension)
        return JSONResponse({"id": path.removeprefix("media/"), "path": path}, status_code=201)

    @app.get("/api/media/{name}")
    def get_media(name: str):
        # Content-addressed files only: a name that is not `<sha256>.<ext>` never reaches the file system.
        path = service.media.file(name) if MEDIA_NAME.fullmatch(name) else None
        if path is None or not path.is_file():
            return JSONResponse({"error": "Not found"}, status_code=404)
        return FileResponse(path, headers={
            "Cache-Control": "public, max-age=31536000, immutable",
            "X-Content-Type-Options": "nosniff",
            # An SVG opened directly must not run script or load anything.
            "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        })

    @app.get("/api/export/vault")
    def export_vault():
        date = utc_timestamp()[:10]
        return Response(
            export_vault_archive(service),
            media_type="application/zip",
            headers={"Content-Disposition": f'attachment; filename="personal-note-obsidian-vault-{date}.zip"'},
        )

    @app.post("/api/import/vault")
    async def import_vault(request):
        if not from_this_app(request):  # a raw body can be sent cross-site without a preflight, unlike JSON
            return forbidden()
        try:
            result = import_vault_archive(service, await request.body())
            return JSONResponse(result, status_code=201)
        except (PortabilityVaultError, WorkspaceImportError) as error:
            return JSONResponse({"error": str(error)}, status_code=400)
        except Exception as error:
            logger.exception("event=vault.import outcome=failed error_class=%s", type(error).__name__)
            return JSONResponse({"error": "Import failed; the existing workspace was not changed"}, status_code=500)

    @app.post("/api/import/workspace")
    async def import_workspace(request):
        try:
            result = import_workspace_backup(service, await payload(request))
            return JSONResponse(result, status_code=201)
        except (PortabilityError, WorkspaceImportError) as error:
            return JSONResponse({"error": str(error)}, status_code=400)
        except Exception as error:
            logger.exception(
                "event=workspace.import outcome=failed error_class=%s",
                type(error).__name__,
            )
            return JSONResponse({"error": "Import failed; the existing workspace was not changed"}, status_code=500)

    dist_path = ROOT / "dist"
    if dist_path.exists():
        assets_path = dist_path / "assets"
        if assets_path.exists():
            app.mount("/assets", StaticFiles(directory=assets_path), name="assets")

        @app.get("/{path:path}")
        def frontend(path: str):
            requested = dist_path / path
            if path and requested.is_file() and dist_path in requested.resolve().parents:
                return FileResponse(requested)
            return FileResponse(dist_path / "index.html")

    return app
