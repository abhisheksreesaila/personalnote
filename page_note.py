"""Page notes (ADR 0003): Markdown text plus an ink layer stored beside it.

A page document is `{"version": 1, "markdown": str, "ink": {"marks": [...], "drawings": [...]}}`. The Markdown is canonical and never
contains ink. Marks and drawings are kept as the editor wrote them; this module only checks their outer shape, so the editor can grow
fields without a server change.
"""
from __future__ import annotations

import json

PAGE_DOCUMENT_VERSION = 1


def empty_page_document() -> dict:
    return {"version": PAGE_DOCUMENT_VERSION, "markdown": "", "ink": {"marks": [], "drawings": []}}


def normalize_page_document(document) -> dict:
    """A well-formed page document from whatever was sent: unknown or broken parts fall back to empty, never to an error."""
    if not isinstance(document, dict):
        return empty_page_document()
    markdown = document.get("markdown")
    ink = document.get("ink") if isinstance(document.get("ink"), dict) else {}
    marks = ink.get("marks") if isinstance(ink.get("marks"), list) else []
    drawings = ink.get("drawings") if isinstance(ink.get("drawings"), list) else []
    return {
        "version": PAGE_DOCUMENT_VERSION,
        "markdown": markdown if isinstance(markdown, str) else "",
        "ink": {
            **{key: value for key, value in ink.items() if key not in ("marks", "drawings")},
            "marks": [mark for mark in marks if isinstance(mark, dict)],
            "drawings": [drawing for drawing in drawings if isinstance(drawing, dict)],
        },
    }


def page_document_of(content: str) -> dict:
    try:
        return normalize_page_document(json.loads(content))
    except (TypeError, json.JSONDecodeError):
        return empty_page_document()


def page_text(content: str) -> str:
    """What search indexes, `read` prints and Markdown export writes: the Markdown itself."""
    return page_document_of(content)["markdown"]
