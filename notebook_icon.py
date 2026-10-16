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


def _is_regional(char: str) -> bool:
    return 0x1F1E6 <= ord(char) <= 0x1F1FF


def _is_pictograph(char: str) -> bool:
    return unicodedata.category(char) == "So" or _is_regional(char)


def is_single_emoji(text: str) -> bool:
    """One emoji: a pictograph or a flag pair or a keycap, with variation selectors, skin tones, joiners (only between pictographs) and tags."""
    if not text or len(text) > MAX_EMOJI_CODE_POINTS:
        return False
    first = text[0]
    keycap = first in "0123456789#*" and text[1:2] in ("\u20e3", "\ufe0f")
    if not keycap and not _is_pictograph(first):
        return False
    regional = 1 if _is_regional(first) else 0
    for previous, char in zip(text, text[1:]):
        if char in "\ufe0e\ufe0f\u20e3" or 0x1F3FB <= ord(char) <= 0x1F3FF or 0xE0020 <= ord(char) <= 0xE007F:
            pass
        elif char == ZWJ:
            if not _is_pictograph(previous) and previous not in "\ufe0f" and not (0x1F3FB <= ord(previous) <= 0x1F3FF):
                return False
        elif previous == ZWJ:
            if not _is_pictograph(char):
                return False
        elif not (_is_regional(char) and regional % 2 == 1):  # the second half of a flag
            return False
        regional = regional + 1 if _is_regional(char) else 0
    return text[-1] != ZWJ


def valid_icon(value) -> bool:
    if not isinstance(value, str):
        return False
    kind, _, name = value.partition(":")
    if kind == "lucide":
        return name in ICON_NAMES
    if kind == "brand":
        return name in BRAND_ICONS
    return kind == "emoji" and is_single_emoji(name)
