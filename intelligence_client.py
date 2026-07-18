import logging

import httpx


logger = logging.getLogger(__name__)


async def enrich_related_note(
    intelligence_url: str,
    current_text: str,
    candidates: list[dict],
) -> dict | None:
    if not candidates:
        return None
    if not intelligence_url:
        return candidates[0]

    try:
        async with httpx.AsyncClient(timeout=0.45) as client:
            response = await client.post(
                f"{intelligence_url.rstrip('/')}/rank",
                json={"currentText": current_text, "candidates": candidates},
            )
            response.raise_for_status()
            result = response.json()
    except (httpx.HTTPError, ValueError) as error:
        logger.debug("event=intelligence.rank outcome=fallback error_class=%s", type(error).__name__)
        return candidates[0]

    selected_id = result.get("selectedId")
    selected = next((item for item in candidates if item["noteId"] == selected_id), candidates[0])
    observation = result.get("observation")
    if isinstance(observation, str) and observation.strip():
        selected = {**selected, "reason": observation.strip()[:180]}
    return {**selected, "mode": result.get("mode", selected["mode"])}