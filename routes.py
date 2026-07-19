import logging
import os
import time
from pathlib import Path

from fasthtml.common import FastHTML
from starlette.responses import FileResponse, JSONResponse, Response
from starlette.staticfiles import StaticFiles

from intelligence_client import enrich_related_note
from services import NoteService, NotFoundError


logger = logging.getLogger(__name__)
ROOT = Path(__file__).resolve().parent


def runtime_capabilities() -> dict:
    deployment_name = os.getenv("PERSONAL_NOTE_DEPLOYMENT_NAME", "").strip()
    model_name = os.getenv("PERSONAL_NOTE_MODEL", "").strip()
    model_key = os.getenv("PERSONAL_NOTE_MODEL_KEY", "").strip()
    intelligence_provider = (
        "azure-openai"
        if deployment_name
        else "openai-compatible"
        if model_name
        else "local-retrieval"
    )
    auth_configured = all(
        os.getenv(name, "").strip()
        for name in ("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "SESSION_SECRET")
    )
    return {
        "authentication": {
            "provider": "google",
            "available": True,
            "enabled": False,
            "configured": auth_configured,
            "mode": "development-bypass",
        },
        "intelligence": {
            "framework": "mastra",
            "provider": intelligence_provider,
            "connectionConfigured": intelligence_provider != "local-retrieval",
            "credentialsConfigured": bool(model_key),
            "settingsSource": "server-environment",
        },
        "storage": {
            "engine": "sqlite",
            "location": "this-device",
            "encryption": "not-enabled",
        },
    }


def create_app(
    database_path: Path | str | None = None,
    intelligence_url: str | None = None,
) -> FastHTML:
    data_path = Path(database_path or os.getenv("PERSONAL_NOTE_DB", ROOT / "data" / "personal-note.db"))
    worker_url = intelligence_url if intelligence_url is not None else os.getenv("INTELLIGENCE_URL", "http://127.0.0.1:4112")
    service = NoteService(data_path)
    app = FastHTML(sess_cls=None)
    app.state.note_service = service

    def json_error(error: Exception) -> JSONResponse:
        status = 404 if isinstance(error, NotFoundError) else 500
        if status == 500:
            logger.exception("event=api.request outcome=failed error_class=%s", type(error).__name__)
        return JSONResponse({"error": str(error) if status == 404 else "Request failed"}, status_code=status)

    async def payload(request) -> dict:
        try:
            value = await request.json()
            return value if isinstance(value, dict) else {}
        except Exception:
            return {}

    @app.get("/health")
    def health():
        return JSONResponse({"status": "ok", "app": "personal-note", "backend": "fasthtml", "fhSaas": "0.9.14"})

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

    @app.post("/api/intelligence/related")
    async def related_note(request):
        request_started = time.perf_counter()
        request_payload = await payload(request)
        try:
            note_id = int(request_payload.get("noteId"))
        except (TypeError, ValueError):
            return JSONResponse({"error": "A valid noteId is required"}, status_code=400)
        current_text = str(request_payload.get("text") or "")[:24_000]
        retrieval_started = time.perf_counter()
        candidates = service.related_candidates(note_id, current_text)
        retrieval_ms = (time.perf_counter() - retrieval_started) * 1000
        enrichment_started = time.perf_counter()
        suggestion = await enrich_related_note(worker_url, current_text, candidates)
        enrichment_ms = (time.perf_counter() - enrichment_started) * 1000
        total_ms = (time.perf_counter() - request_started) * 1000
        timing = {
            "retrievalMs": round(retrieval_ms, 2),
            "enrichmentMs": round(enrichment_ms, 2),
            "serverMs": round(total_ms, 2),
            "mode": suggestion.get("mode", "silent") if suggestion else "silent",
        }
        return JSONResponse(
            {"suggestion": suggestion, "timing": timing},
            headers={
                "Server-Timing": (
                    f"retrieval;dur={retrieval_ms:.2f}, "
                    f"intelligence;dur={enrichment_ms:.2f}"
                )
            },
        )

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