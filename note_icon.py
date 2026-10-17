"""A note's emoji icon (F-100): a chosen emoji with a tint 1-5, else a guess from the title, else the type's default.

Guessing is done here, not in the browser, so it costs the first load nothing (the list arrives with every row's icon resolved).
"""
import re

from notebook_icon import is_single_emoji

TYPE_DEFAULTS = {"page": "📄", "canvas": "🎨", "mindmap": "🧠"}
TINTS = (1, 2, 3, 4, 5)

_WORDS = {
    "✈️": "trip trips travel flight flights holiday vacation lisbon paris",
    "🛒": "grocery groceries shopping shop",
    "🚀": "startup launch pitch rocket",
    "🗓️": "weekly week review calendar schedule planning plan agenda",
    "💡": "idea ideas brainstorm inspiration",
    "📚": "reading books book library study",
    "💼": "work job career office business meeting meetings client",
    "💰": "money budget finance finances taxes expenses invoice",
    "🍳": "recipe recipes cooking food meal meals dinner",
    "🏃": "workout fitness gym run running exercise health",
    "🎵": "music song songs playlist",
    "🎬": "movie movies film films",
    "📷": "photo photos photography camera",
    "🏠": "home house chores garden family",
    "❤️": "love wedding date dates",
    "💻": "code coding programming dev software bug bugs",
    "🎓": "school class course courses learning university homework",
    "🐾": "pet pets dog cat",
    "🚗": "car cars driving",
    "✅": "todo todos checklist tasks task",
    "🔖": "bookmark bookmarks links link",
    "🧪": "experiment experiments lab research",
    "📝": "journal diary draft",
    "🎯": "goal goals okr okrs target",
}
_BY_WORD = {word: emoji for emoji, words in _WORDS.items() for word in words.split()}


def guess_emoji(title: str) -> str:
    """The title's own leading emoji, else the emoji of the first word it knows, else ''."""
    title = (title or "").strip()
    first = title.split(None, 1)[0] if title else ""
    if is_single_emoji(first):
        return first
    for word in re.split(r"[^\w-]+", title.lower()):
        if word in _BY_WORD:
            return _BY_WORD[word]
    return ""


def tint_of(emoji: str) -> int:
    """The same emoji always gets the same one of the five tints, so a list of them is colourful but steady."""
    return sum(map(ord, emoji)) % len(TINTS) + 1


def shown_icon(title: str, note_type: str, emoji: str = "", tint: int = 0) -> dict:
    """What a row draws: {emoji, tint, chosen}. A chosen emoji wins, then the title's guess, then the type's default."""
    if emoji:
        return {"emoji": emoji, "tint": tint if tint in TINTS else tint_of(emoji), "chosen": True}
    guess = guess_emoji(title) or TYPE_DEFAULTS.get(note_type, TYPE_DEFAULTS["canvas"])
    return {"emoji": guess, "tint": tint_of(guess), "chosen": False}


def valid_tint(value) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value in TINTS


def is_chosen_icon(value) -> bool:
    return isinstance(value, str) and is_single_emoji(value)
