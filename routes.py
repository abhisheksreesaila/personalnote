import logging
import os
import time
from pathlib import Path

from fasthtml.common import FastHTML
from starlette.responses import FileResponse, JSONResponse, Response
from starlette.staticfiles import StaticFiles

from intelligence_client import enrich_related_note, enrich_scan_page, enrichment_timeout
from intelligence_protocol import INTELLIGENCE_TIERS, PROTOCOL_VERSION
from services import NoteService, NotFoundError


logger = logging.getLogger(__name__)
ROOT = Path(__file__).resolve().parent


def runtime_capabilities() -> dict:
    deployment_name = os.getenv("PERSONAL_NOTE_DEPLOYMENT_NAME", "").strip()
    model_name = os.getenv("PERSONAL_NOTE_MODEL", "").strip()
    model_key = os.getenv("PERSONAL_NOTE_MODEL_KEY", "").strip()
    model_url = os.getenv("PERSONAL_NOTE_MODEL_URL", "").strip()
    tier = os.getenv("PERSONAL_NOTE_INTELLIGENCE_TIER", "local-first").strip().lower()
    if tier not in INTELLIGENCE_TIERS:
        tier = "local-first"
    is_local_endpoint = bool(
        model_url
        and (
            model_url.startswith("http://127.0.0.1")
            or model_url.startswith("http://localhost")
        )
    )
    intelligence_provider = (
        "azure-openai"
        if deployment_name
        else "openai-compatible"
        if model_name
        else "local-retrieval"
    )
    executor = (
        "cloud-model"
        if deployment_name or (model_name and not is_local_endpoint)
        else "local-model"
        if model_name
        else "deterministic"
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
            "protocolVersion": PROTOCOL_VERSION,
            "tier": tier,
            "executor": executor,
            "provider": intelligence_provider,
            "connectionConfigured": intelligence_provider != "local-retrieval",
            "credentialsConfigured": bool(model_key),
            "settingsSource": "server-environment",
            "tasks": ["rank-related", "scan-page"],
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
        suggestion = candidates[0] if candidates else None
        enrichment_ms = 0.0
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

    @app.post("/api/intelligence/related/enrich")
    async def enrich_related(request):
        request_started = time.perf_counter()
        request_payload = await payload(request)
        try:
            note_id = int(request_payload.get("noteId"))
        except (TypeError, ValueError):
            return JSONResponse({"error": "A valid noteId is required"}, status_code=400)
        current_text = str(request_payload.get("text") or "")[:24_000]
        candidates = service.related_candidates(note_id, current_text)
        enrichment_started = time.perf_counter()
        suggestion = await enrich_related_note(worker_url, current_text, candidates)
        enrichment_ms = (time.perf_counter() - enrichment_started) * 1000
        return JSONResponse({
            "suggestion": suggestion,
            "timing": {
                "enrichmentMs": round(enrichment_ms, 2),
                "serverMs": round((time.perf_counter() - request_started) * 1000, 2),
                "mode": suggestion.get("mode", "silent") if suggestion else "silent",
            },
        })

    @app.post("/api/intelligence/entities")
    async def intelligence_entities(request):
        request_payload = await payload(request)
        current_text = str(request_payload.get("text") or "")[:24_000]
        try:
            note_id = int(request_payload.get("noteId"))
        except (TypeError, ValueError):
            note_id = None
        return JSONResponse({"people": service.find_people(current_text, note_id)})

    @app.post("/api/intelligence/scan")
    async def intelligence_scan(request):
        request_started = time.perf_counter()
        request_payload = await payload(request)
        try:
            note_id = int(request_payload.get("noteId"))
        except (TypeError, ValueError):
            return JSONResponse({"error": "A valid noteId is required"}, status_code=400)

        current_text = str(request_payload.get("text") or "")[:24_000]
        segments = request_payload.get("segments") or []
        if not isinstance(segments, list):
            segments = []
        segments = [str(segment)[:8_000] for segment in segments][:80]

        focus_segments = request_payload.get("focusSegments") or []
        if not isinstance(focus_segments, list):
            focus_segments = []
        focus_segments = [str(segment)[:8_000] for segment in focus_segments][:40]

        try:
            text_object_count = max(0, int(request_payload.get("textObjectCount") or 0))
        except (TypeError, ValueError):
            text_object_count = 0
        try:
            focused_text_count = max(0, int(request_payload.get("focusedTextCount") or 0))
        except (TypeError, ValueError):
            focused_text_count = 0

        retrieval_started = time.perf_counter()
        local_scan = service.scan_page(
            note_id,
            current_text,
            segments,
            focus_segments,
            text_object_count,
            focused_text_count,
        )
        retrieval_ms = (time.perf_counter() - retrieval_started) * 1000

        enrichment_started = time.perf_counter()
        enriched = await enrich_scan_page(worker_url, current_text, local_scan)
        enrichment_ms = (time.perf_counter() - enrichment_started) * 1000

        scan_result = local_scan
        mode = local_scan.get("mode", "local-retrieval")
        if enriched:
            scan_result = {
                **local_scan,
                "calendarDrafts": enriched.get("calendarDrafts", local_scan["calendarDrafts"]),
                "people": enriched.get("people", local_scan["people"]),
                "related": enriched.get("related", local_scan["related"]),
                "scanSummary": enriched.get("scanSummary", ""),
                "mode": enriched.get("mode", mode),
            }
            mode = scan_result["mode"]

        total_ms = (time.perf_counter() - request_started) * 1000
        timing = {
            "retrievalMs": round(retrieval_ms, 2),
            "enrichmentMs": round(enrichment_ms, 2),
            "serverMs": round(total_ms, 2),
            "mode": mode,
        }
        return JSONResponse(
            {
                "scan": scan_result,
                "timing": timing,
            },
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