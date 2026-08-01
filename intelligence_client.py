import logging
import os

import httpx

from intelligence_protocol import PROTOCOL_VERSION


logger = logging.getLogger(__name__)


def enrichment_timeout() -> float:
    try:
        configured = float(os.getenv("INTELLIGENCE_ENRICH_TIMEOUT", "4.0"))
    except ValueError:
        configured = 4.0
    return min(10.0, max(0.5, configured))


def intelligence_tier() -> str:
    value = os.getenv("PERSONAL_NOTE_INTELLIGENCE_TIER", "local-first").strip().lower()
    if value in {"local-only", "local-first", "cloud-ok"}:
        return value
    return "local-first"


def _apply_rank_output(candidate: dict, result: dict) -> dict:
    selected_id = result.get("selectedId")
    if selected_id is None and "output" in result:
        output = result.get("output") or {}
        selected_id = output.get("selectedId")
    selected = next((item for item in candidate if item["noteId"] == selected_id), candidate[0])
    observation = result.get("observation")
    if not isinstance(observation, str) or not observation.strip():
        output = result.get("output") or {}
        observation = output.get("observation")
    if isinstance(observation, str) and observation.strip():
        selected = {**selected, "reason": observation.strip()[:180]}
    mode = result.get("mode", selected.get("mode", "local-retrieval"))
    return {**selected, "mode": mode}


async def execute_intelligence_task(
    intelligence_url: str,
    task: str,
    input_payload: dict,
    *,
    tier: str | None = None,
    latency_budget_ms: int | None = None,
) -> dict | None:
    if not intelligence_url:
        return None

    preferences: dict = {"tier": tier or intelligence_tier()}
    if latency_budget_ms is not None:
        preferences["latencyBudgetMs"] = latency_budget_ms

    body = {
        "protocolVersion": PROTOCOL_VERSION,
        "task": task,
        "input": input_payload,
        "preferences": preferences,
    }

    try:
        async with httpx.AsyncClient(timeout=enrichment_timeout()) as client:
            response = await client.post(
                f"{intelligence_url.rstrip('/')}/v1/execute",
                json=body,
            )
            response.raise_for_status()
            return response.json()
    except (httpx.HTTPError, ValueError) as error:
        logger.debug(
            "event=intelligence.execute outcome=fallback task=%s error_class=%s",
            task,
            type(error).__name__,
        )
        return None


async def enrich_scan_page(
    intelligence_url: str,
    current_text: str,
    local_scan: dict,
) -> dict | None:
    protocol_result = await execute_intelligence_task(
        intelligence_url,
        "scan-page",
        {
            "currentText": current_text,
            "segments": [],
            "focusSegments": [],
            "calendarDrafts": local_scan.get("calendarDrafts", []),
            "people": local_scan.get("people", []),
            "relatedCandidates": local_scan.get("relatedCandidates", []),
            "actions": local_scan.get("actions", {}),
        },
    )
    if not protocol_result:
        return None
    output = protocol_result.get("output") or {}
    return {
        "calendarDrafts": output.get("calendarDrafts", local_scan.get("calendarDrafts", [])),
        "people": output.get("people", local_scan.get("people", [])),
        "related": output.get("related", local_scan.get("related")),
        "scanSummary": output.get("scanSummary", ""),
        "mode": protocol_result.get("mode", local_scan.get("mode", "local-retrieval")),
    }


async def enrich_related_note(
    intelligence_url: str,
    current_text: str,
    candidates: list[dict],
) -> dict | None:
    if not candidates:
        return None

    protocol_result = await execute_intelligence_task(
        intelligence_url,
        "rank-related",
        {"currentText": current_text, "candidates": candidates},
    )
    if protocol_result:
        return _apply_rank_output(candidates, protocol_result)

    if not intelligence_url:
        return candidates[0]

    try:
        async with httpx.AsyncClient(timeout=enrichment_timeout()) as client:
            response = await client.post(
                f"{intelligence_url.rstrip('/')}/rank",
                json={"currentText": current_text, "candidates": candidates},
            )
            response.raise_for_status()
            result = response.json()
    except (httpx.HTTPError, ValueError) as error:
        logger.debug("event=intelligence.rank outcome=fallback error_class=%s", type(error).__name__)
        return candidates[0]

    return _apply_rank_output(candidates, result)
