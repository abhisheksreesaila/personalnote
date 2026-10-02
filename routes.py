import json
import logging
import os
from datetime import datetime
from pathlib import Path

from fasthtml.common import FastHTML
from starlette.responses import FileResponse, JSONResponse, Response
from starlette.staticfiles import StaticFiles

from app_paths import app_data_dir, default_database_path, resource_root
from portability import (
    PortabilityError,
    import_workspace_backup,
    markdown_archive,
    utc_timestamp,
    workspace_backup,
)
from media_store import MAX_MEDIA_BYTES, MEDIA_NAME, sniff_image
from services import ConflictError, InvalidNoteContentError, NoteService, NotFoundError, WorkspaceImportError
from vault import PortabilityVaultError, export_vault_archive, import_vault_archive
from voice_runtime import VoiceError, VoiceRuntime, app_version


logger = logging.getLogger(__name__)
ROOT = resource_root()


def runtime_capabilities() -> dict:
    """Return only capabilities that are part of the v1 notebook runtime."""
    return {
        "storage": {
            "engine": "sqlite",
            "location": "this-device",
            "encryption": "not-enabled",
        },
        "portability": {
            "workspaceBackup": True,
            "mergeImport": True,
            "markdownAssets": True,
        },
        "modules": {
            "mindmap": {"available": True, "loading": "on-demand"},
            "voice": {
                "available": True,
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


def speedtest_folder() -> Path:
    """The speed test's results (F-034) live in the app-data folder (PERSONAL_NOTE_SPEEDTEST_DIR overrides it), never beside the notes."""
    folder = os.environ.get("PERSONAL_NOTE_SPEEDTEST_DIR")
    return Path(folder) if folder else app_data_dir() / "speedtest"


MAX_SPEEDTEST_REPORT_CHARS = 200_000


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


def create_app(
    database_path: Path | str | None = None,
    voice: VoiceRuntime | None = None,
    bound_host: str | None = None,
) -> FastHTML:
    """`bound_host` is the address the server listens on; when it is loopback, only loopback Host headers are served."""
    data_path = Path(database_path or default_database_path())
    service = NoteService(data_path)
    # FastHTML writes a session key file; keep it beside the database, not in the (possibly read-only) cwd.
    app = FastHTML(sess_cls=None, key_fname=str(data_path.with_name(".sesskey")))
    app.state.note_service = service
    app.state.voice = voice or default_voice_runtime()
    if bound_host is not None and host_name(bound_host) in LOOPBACK_NAMES:
        app.add_middleware(LoopbackHostMiddleware)

    def json_error(error: Exception) -> JSONResponse:
        status = 404 if isinstance(error, NotFoundError) else 409 if isinstance(error, ConflictError) else 400 if isinstance(error, InvalidNoteContentError) else 500
        if status == 500:
            logger.exception("event=api.request outcome=failed error_class=%s", type(error).__name__)
        return JSONResponse(
            {"error": str(error) if status in {400, 404, 409} else "Request failed"},
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
        return JSONResponse({"status": "ok", "app": "personal-note", "backend": "fasthtml"})

    @app.get("/api/settings/capabilities")
    def settings_capabilities():
        return JSONResponse(runtime_capabilities())

    def voice_response(call, status_code: int = 200) -> JSONResponse:
        try:
            return JSONResponse(call(), status_code=status_code)
        except VoiceError as error:
            return JSONResponse({"error": str(error)}, status_code=409)

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
        return voice_response(lambda: app.state.voice.cancel_install())

    @app.delete("/api/voice")
    def voice_remove(request):
        if not from_this_app(request):
            return forbidden()
        return voice_response(lambda: app.state.voice.remove())

    @app.post("/api/speedtest/report")
    async def speedtest_report(request):
        """Saves the speed test's results as a text file and a JSON file the person can find again (and send along)."""
        if not from_this_app(request):
            return forbidden()
        body = await payload(request)
        text = body.get("text")
        data = body.get("data")
        if not isinstance(text, str) or not text.strip() or len(text) > MAX_SPEEDTEST_REPORT_CHARS or not isinstance(data, dict):
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

    @app.get("/api/search")
    def search(request):
        return JSONResponse(service.search(request.query_params.get("q", "")))

    @app.get("/api/notes")
    def list_notes():
        return JSONResponse(service.list_notes())

    @app.get("/api/notes/{note_id}")
    def get_note(note_id: int):
        try:
            return JSONResponse(service.get_note(note_id))
        except Exception as error:
            return json_error(error)

    @app.post("/api/notes")
    async def create_note(request):
        return JSONResponse(service.create_note(await payload(request)), status_code=201)

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

    @app.delete("/api/notes/{note_id}")
    def delete_note(note_id: int):
        try:
            service.delete_note(note_id)
            return Response(status_code=204)
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
