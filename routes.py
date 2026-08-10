import ipaddress
import logging
import os
import secrets
import time
from pathlib import Path

from fasthtml.common import FastHTML
from starlette.responses import FileResponse, JSONResponse, Response
from starlette.staticfiles import StaticFiles

from intelligence_client import enrich_related_note, enrich_scan_page, enrichment_timeout
from intelligence_protocol import INTELLIGENCE_TIERS, PROTOCOL_VERSION
from services import ConflictError, NoteService, NotFoundError
from workspace_protocol import (
    WORKSPACE_PROTOCOL_VERSION,
    WorkspaceProtocol,
    WorkspaceProtocolError,
    load_capability_token,
)


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
    workspace_token, workspace_token_path = load_capability_token(data_path)
    workspace_protocol = WorkspaceProtocol(service, workspace_token)
    app = FastHTML(sess_cls=None)
    app.state.note_service = service
    app.state.workspace_token = workspace_token
    app.state.workspace_token_path = workspace_token_path

    def json_error(error: Exception) -> JSONResponse:
        status = 404 if isinstance(error, NotFoundError) else 409 if isinstance(error, ConflictError) else 500
        if status == 500:
            logger.exception("event=api.request outcome=failed error_class=%s", type(error).__name__)
        return JSONResponse(
            {"error": str(error) if status in {404, 409} else "Request failed"},
            status_code=status,
        )

    def is_loopback_host(host: str) -> bool:
        if host == "testclient":
            return True
        try:
            address = ipaddress.ip_address(host.split("%", 1)[0])
            return address.is_loopback or bool(address.ipv4_mapped and address.ipv4_mapped.is_loopback)
        except ValueError:
            return False

    def protocol_error(
        request_id: str | None,
        code: str,
        message: str,
        status_code: int,
    ) -> JSONResponse:
        return JSONResponse(
            {
                "protocolVersion": WORKSPACE_PROTOCOL_VERSION,
                "requestId": request_id,
                "error": {"code": code, "message": message},
            },
            status_code=status_code,
        )

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

    @app.post("/api/workspace/v1")
    async def workspace_request(request):
        request_started = time.perf_counter()
        request_id = None
        client_host = request.client.host if request.client else ""
        if not is_loopback_host(client_host):
            return protocol_error(None, "scope_denied", "Loopback access is required", 403)
        authorization = request.headers.get("authorization", "")
        scheme, _, credential = authorization.partition(" ")
        if scheme.casefold() != "bearer" or not secrets.compare_digest(
            credential, workspace_token
        ):
            return protocol_error(None, "authentication_required", "A valid capability token is required", 401)
        request_payload = await payload(request)
        request_id_value = request_payload.get("requestId")
        if isinstance(request_id_value, str) and 0 < len(request_id_value) <= 128:
            request_id = request_id_value
        else:
            return protocol_error(None, "invalid_request", "A valid requestId is required", 400)
        if request_payload.get("protocolVersion") != WORKSPACE_PROTOCOL_VERSION:
            return protocol_error(request_id, "unsupported_version", "Protocol version is not supported", 400)
        operation = request_payload.get("operation")
        input_data = request_payload.get("input", {})
        if not isinstance(operation, str) or not isinstance(input_data, dict):
            return protocol_error(request_id, "invalid_request", "Operation and input are required", 400)
        try:
            result = workspace_protocol.execute(operation, input_data)
            with service.connection() as connection:
                sequence = connection.execute(
                    "SELECT sequence FROM workspace_state WHERE id = 1"
                ).fetchone()[0]
            return JSONResponse(
                {
                    "protocolVersion": WORKSPACE_PROTOCOL_VERSION,
                    "requestId": request_id,
                    "result": result,
                    "execution": {
                        "mode": "local",
                        "actor": "local-agent",
                        "sourceRevision": f"workspace_rev_{sequence}",
                        "latencyMs": round((time.perf_counter() - request_started) * 1000, 2),
                    },
                }
            )
        except WorkspaceProtocolError as error:
            return protocol_error(request_id, error.code, str(error), error.status_code)
        except Exception as error:
            logger.exception(
                "event=workspace.request outcome=failed operation=%s error_class=%s",
                operation,
                type(error).__name__,
            )
            return protocol_error(request_id, "internal_error", "Request failed", 500)

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