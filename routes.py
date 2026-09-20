import logging
import os
from pathlib import Path

from fasthtml.common import FastHTML
from starlette.responses import FileResponse, JSONResponse, Response
from starlette.staticfiles import StaticFiles

from portability import (
    PortabilityError,
    import_workspace_backup,
    markdown_archive,
    utc_timestamp,
    workspace_backup,
)
from services import ConflictError, NoteService, NotFoundError, WorkspaceImportError


logger = logging.getLogger(__name__)
ROOT = Path(__file__).resolve().parent


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


def create_app(database_path: Path | str | None = None) -> FastHTML:
    data_path = Path(database_path or os.getenv("PERSONAL_NOTE_DB", ROOT / "data" / "personal-note.db"))
    service = NoteService(data_path)
    app = FastHTML(sess_cls=None)
    app.state.note_service = service

    def json_error(error: Exception) -> JSONResponse:
        status = 404 if isinstance(error, NotFoundError) else 409 if isinstance(error, ConflictError) else 500
        if status == 500:
            logger.exception("event=api.request outcome=failed error_class=%s", type(error).__name__)
        return JSONResponse(
            {"error": str(error) if status in {404, 409} else "Request failed"},
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
