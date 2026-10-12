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


# ---------- re-anchoring after an agent rewrites the Markdown (mirrors src/page/ink-state.js) ----------
def _is_word_char(char: str) -> bool:
    return char.isalnum() or char in "_'"


def find_quote(text: str, quote) -> int | None:
    """Start of the best whole-word match for a quote {exact, prefix, suffix} (most context agreeing on either side), or None."""
    if not isinstance(quote, dict) or not isinstance(quote.get("exact"), str) or len(quote["exact"].strip()) < 2:
        return None
    exact, prefix, suffix = quote["exact"], quote.get("prefix") or "", quote.get("suffix") or ""
    best, best_score = None, -1
    at = text.find(exact)
    while at != -1:
        before = text[at - 1] if at > 0 else " "
        end = at + len(exact)
        after = text[end] if end < len(text) else " "
        whole = not (_is_word_char(exact[0]) and _is_word_char(before)) and not (_is_word_char(exact[-1]) and _is_word_char(after))
        if whole:
            left = 0
            while left < len(prefix) and at - 1 - left >= 0 and text[at - 1 - left] == prefix[len(prefix) - 1 - left]:
                left += 1
            right = 0
            while right < len(suffix) and end + right < len(text) and text[end + right] == suffix[right]:
                right += 1
            if left + right > best_score:
                best, best_score = at, left + right
        at = text.find(exact, at + 1)
    return best


def _under_line(text: str, at: int) -> dict:
    """Where a drawing goes to sit under the line holding `at`: before the next line, or after the last one."""
    newline = text.find("\n", at)
    return {"pos": newline + 1, "side": -1} if newline != -1 else {"pos": len(text), "side": 1}


def reanchor_ink(ink: dict, markdown: str) -> dict:
    """The ink for a page whose Markdown was replaced wholesale: every mark and linked drawing looks for its quoted words again.

    A mark that can't be found becomes loose ink (kept, never dropped). A linked drawing whose word is gone is unlinked and unfolded,
    so nothing stays hidden. A drawing of its own goes back under the line it sat under, when that line is still there.
    """
    marks = []
    for mark in ink.get("marks", []):
        anchor = mark.get("anchor") if isinstance(mark.get("anchor"), dict) else None
        if not anchor or anchor.get("pos") is None:
            marks.append(mark)
            continue
        found = find_quote(markdown, anchor.get("quote"))
        rest = {key: value for key, value in mark.items() if key != "loose"}
        if found is None:
            marks.append({**rest, "loose": True, "anchor": {**anchor, "pos": None, "end": None}})
        else:
            marks.append({**rest, "anchor": {**anchor, "pos": found, "end": found + len(anchor["quote"]["exact"])}})
    drawings = []
    for drawing in ink.get("drawings", []):
        link = drawing.get("link") if isinstance(drawing.get("link"), dict) else None
        if link and link.get("quote"):
            found = find_quote(markdown, link["quote"])
            if found is None:
                drawings.append({**drawing, "link": None, "folded": False, **_under_line(markdown, len(markdown))})
            else:
                drawings.append({**drawing, "link": {**link, "pos": found, "end": found + len(link["quote"]["exact"])}, **_under_line(markdown, found)})
            continue
        found = find_quote(markdown, drawing.get("quote"))
        if found is not None:
            drawings.append({**drawing, **_under_line(markdown, found)})
        else:
            drawings.append({**drawing, "pos": min(int(drawing.get("pos") or 0), len(markdown))})
    return {**ink, "marks": marks, "drawings": drawings}
