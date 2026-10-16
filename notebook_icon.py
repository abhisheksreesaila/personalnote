"""A notebook's icon (F-089): '' (the app guesses from the name), 'lucide:<name>', 'brand:x' or 'emoji:<one grapheme>'.

The names are the same list as `src/modules/library/notebook-icon.js` (a test compares them).
"""
import unicodedata

ICON_NAMES = (
    "house", "globe", "link", "bookmark", "book", "briefcase", "code", "heart", "plane", "cooking-pot", "dumbbell", "music",
    "camera", "lightbulb", "graduation-cap", "wallet", "shopping-cart", "baby", "paw-print", "leaf", "car", "gamepad-2",
    "film", "palette", "flask-conical", "calendar", "star", "inbox", "archive", "folder", "mic", "brain", "pencil", "map",
    "users", "rocket", "coffee", "sun", "moon", "flag",
)
BRAND_ICONS = ("x",)
MAX_EMOJI_CODE_POINTS = 16
ZWJ = "‍"


def _continues_grapheme(previous: str, char: str, regional_run: int) -> bool:
    code = ord(char)
    if previous == ZWJ or char == ZWJ:
        return True
    if char in "︎️⃣" or 0x1F3FB <= code <= 0x1F3FF or 0xE0020 <= code <= 0xE007F:
        return True
    if unicodedata.category(char).startswith("M"):
        return True
    return 0x1F1E6 <= code <= 0x1F1FF and regional_run % 2 == 1  # the second half of a flag


def is_single_emoji(text: str) -> bool:
    """One grapheme that is not plain text: a letter or digit alone is not an emoji (a digit may carry U+20E3, a keycap)."""
    if not text or len(text) > MAX_EMOJI_CODE_POINTS:
        return False
    first = text[0]
    keycap = first in "0123456789#*" and text[1:2] in ("\u20e3", "\ufe0f")
    if not keycap and (first.isalnum() or first in "#*" or unicodedata.category(first)[0] in "CZ"):
        return False
    regional = 1 if 0x1F1E6 <= ord(first) <= 0x1F1FF else 0
    for previous, char in zip(text, text[1:]):
        if not _continues_grapheme(previous, char, regional):
            return False
        regional = regional + 1 if 0x1F1E6 <= ord(char) <= 0x1F1FF else 0
    return True


def valid_icon(value) -> bool:
    if not isinstance(value, str):
        return False
    kind, _, name = value.partition(":")
    if kind == "lucide":
        return name in ICON_NAMES
    if kind == "brand":
        return name in BRAND_ICONS
    return kind == "emoji" and is_single_emoji(name)
