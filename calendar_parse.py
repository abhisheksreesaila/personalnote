"""Local calendar draft parsing for page scan — mirrors src/intelligence/calendar-draft.js."""

from __future__ import annotations

import re
from datetime import datetime, timedelta
from typing import Any

from dateparser.search import search_dates


EVENT_CUE = re.compile(
    r"\b(?:appointment|breakfast|call|coffee|deadline|dinner|event|interview|lunch|"
    r"meet|meeting|reminder|review|schedule|sync|workshop|standup|stand-up|huddle|"
    r"catchup|catch-up|dentist|doctor|flight|pickup|drop-off|tomorrow|today)\b",
    re.IGNORECASE,
)
TIME_CUE = re.compile(
    r"\b(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)\b",
    re.IGNORECASE,
)


def clean_title(text: str) -> str:
    value = re.sub(r"\s+", " ", text)
    value = re.sub(r"\s+([,.;!?])", r"\1", value)
    value = re.sub(r"\b(?:on|at|for)\s*$", "", value, flags=re.IGNORECASE)
    return value.strip(" \t\n\r,.;:!-")


def parse_calendar_draft(text: str, reference_date: datetime | None = None) -> dict[str, Any] | None:
    trimmed = text.strip()
    if not trimmed:
        return None
    has_event_cue = EVENT_CUE.search(trimmed) is not None
    has_time_cue = TIME_CUE.search(trimmed) is not None
    if not has_event_cue and not has_time_cue:
        return None

    base = reference_date or datetime.now()
    settings = {
        "PREFER_DATES_FROM": "future",
        "RELATIVE_BASE": base,
        "RETURN_AS_TIMEZONE_AWARE": False,
    }
    matches = search_dates(trimmed, settings=settings)
    if not matches:
        return None

    date_text, start = matches[0]
    if not has_event_cue and not TIME_CUE.search(date_text):
        return None

    before = trimmed[: trimmed.find(date_text)]
    after = trimmed[trimmed.find(date_text) + len(date_text) :]
    title = clean_title(f"{before} {after}")
    if not title:
        return None

    has_explicit_time = bool(TIME_CUE.search(date_text) or re.search(r"\d{1,2}:\d{2}", date_text))

    if (
        has_explicit_time
        and not re.search(r"(?:am|pm|a\.m\.|p\.m\.)", date_text, re.IGNORECASE)
        and 1 <= start.hour <= 6
        and "breakfast" not in title.lower()
    ):
        start = start + timedelta(hours=12)

    return {
        "title": title,
        "startAt": start.isoformat(),
        "dateText": date_text,
        "hasExplicitTime": has_explicit_time,
        "durationMinutes": 60,
    }


def parse_calendar_segments(
    segments: list[str],
    focus_segments: list[str] | None = None,
    reference_date: datetime | None = None,
) -> list[dict[str, Any]]:
    focus_set = {segment.strip() for segment in focus_segments or [] if segment.strip()}
    ordered = list(
        dict.fromkeys(
            [segment.strip() for segment in focus_segments or [] if segment.strip()]
            + [segment.strip() for segment in segments if segment.strip()],
        ),
    )
    drafts: list[dict[str, Any]] = []
    seen: set[str] = set()
    for segment in ordered:
        draft = parse_calendar_draft(segment, reference_date)
        if not draft:
            continue
        key = f"{draft['title']}|{draft['startAt']}"
        if key in seen:
            continue
        seen.add(key)
        draft["priority"] = segment in focus_set
        drafts.append(draft)
    return drafts
