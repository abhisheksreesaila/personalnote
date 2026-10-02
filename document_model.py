"""Engine-independent document model, Python mirror of src/core/document/ (F-025).

Same shape, same rules, same fixtures (tests/fixtures/documents/). A document is
`{schemaVersion, page, objects, extras}`; see src/core/document/schema.js for the full field list. Nothing in the app uses
this yet: F-026 moves storage onto it. Until then it proves the model is lossless and gives agents-facing text helpers
(`plain_text`, `search_text`) that return exactly what note_text.py and NoteService.canvas_text return today.
"""

from __future__ import annotations

import copy
import re
from typing import Any, Callable

SCHEMA_VERSION = 1
PAGE = {"width": 860, "height": 1080}
OBJECT_TYPES = ("text", "sticky", "shape", "ink", "image", "connector", "group", "unknown")
SHAPE_KINDS = ("rect", "circle")
INK_KINDS = ("stroke", "dot")
TEXT_MODES = ("point", "box")
MEDIA_KINDS = ("inline", "media")
DEFAULT_PAGE = {"columns": 1, "rows": 1}
DEFAULT_CONNECTOR_ARROWHEADS = {"start": False, "end": True}

SKIN_PALETTES = {
    "crayon": ("#ffd60a", "#30d158", "#64b5ff", "#bf5af2", "#ff6b3d"),
    "paper": ("#ffd66b", "#9fe0c0", "#a9cfff", "#cdb8ff", "#ff9c85"),
    "night": ("#ffc877", "#7ee7c8", "#9db4ff", "#d3a6ff", "#ff8fb1"),
}
_KEY_BY_COLOR = {
    color: f"c{index + 1}"
    for colors in SKIN_PALETTES.values()
    for index, color in enumerate(colors)
}

_GEOMETRY = (
    ("left", "x"), ("top", "y"), ("width", "width"), ("height", "height"), ("angle", "rotation"),
    ("scaleX", "scaleX"), ("scaleY", "scaleY"), ("originX", "originX"), ("originY", "originY"),
)
_TEXT_STYLE = (
    ("fontFamily", "fontFamily"), ("fontSize", "fontSize"), ("fontWeight", "fontWeight"), ("fontStyle", "fontStyle"),
    ("lineHeight", "lineHeight"), ("textAlign", "textAlign"), ("underline", "underline"), ("overline", "overline"),
    ("linethrough", "linethrough"), ("charSpacing", "charSpacing"), ("padding", "padding"), ("fill", "color"),
)
_FIELDS = {
    "text": (("text", "content"), *((a, f"style.{b}") for a, b in _TEXT_STYLE)),
    "sticky": (("text", "content"), ("stickyColor", "color"), *((a, f"style.{b}") for a, b in _TEXT_STYLE)),
    "rect": (("rx", "cornerRadius"), ("ry", "cornerRadiusY"), ("fill", "fill"), ("stroke", "stroke"), ("strokeWidth", "strokeWidth")),
    "circle": (("radius", "radius"), ("fill", "fill"), ("stroke", "stroke"), ("strokeWidth", "strokeWidth")),
    "connector": (("fromId", "fromId"), ("toId", "toId"), ("color", "color"), ("lineWidth", "lineWidth"), ("reverseX", "reverseX"), ("reverseY", "reverseY")),
    "stroke": (("inkTool", "tool"), ("strokeWidth", "width"), ("globalCompositeOperation", "blend"), ("strokeLineCap", "cap"), ("strokeLineJoin", "join")),
    "dot": (("inkTool", "tool"), ("radius", "radius"), ("globalCompositeOperation", "blend")),
}
_FABRIC_TYPE = {"sticky": "Sticky", "rect": "Rect", "circle": "Circle", "stroke": "Path", "dot": "Circle", "image": "Image", "connector": "Connector", "group": "Group"}
_TEXT_TYPE = {"point": "IText", "box": "Textbox"}
_HEX_WITH_ALPHA = re.compile(r"^(#[0-9a-fA-F]{6})([0-9a-f]{2})$")


class DocumentError(ValueError):
    def __init__(self, message: str, errors: list[dict] | None = None):
        super().__init__(message)
        self.errors = errors or []


def empty_document() -> dict:
    return {"schemaVersion": SCHEMA_VERSION, "page": dict(DEFAULT_PAGE), "objects": [], "extras": {}}


def palette_key_for(color: Any) -> str | None:
    return _KEY_BY_COLOR.get(color.lower()) if isinstance(color, str) else None


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and value == value and value not in (float("inf"), float("-inf"))


def _set_path(target: dict, path: str, value: Any) -> None:
    *keys, last = path.split(".")
    node = target
    for key in keys:
        node = node.setdefault(key, {})
    node[last] = value


_MISSING = object()


def _get_path(source: Any, path: str) -> Any:
    node = source
    for key in path.split("."):
        node = node.get(key, _MISSING) if isinstance(node, dict) else _MISSING
    return node


def _take(rest: dict, target: dict, pairs) -> None:
    for fabric_key, path in pairs:
        if fabric_key in rest:
            _set_path(target, path, rest.pop(fabric_key))


def _put(source: dict, out: dict, pairs) -> None:
    for fabric_key, path in pairs:
        value = _get_path(source, path)
        if value is not _MISSING:
            out[fabric_key] = value


def _split_color(value: Any) -> tuple[Any, float | None]:
    match = _HEX_WITH_ALPHA.match(value) if isinstance(value, str) else None
    return (match.group(1), int(match.group(2), 16) / 255) if match else (value, None)


def _join_color(color: Any, alpha: float | None) -> Any:
    if alpha is None or not isinstance(color, str):
        return color
    return f"{color}{_js_round(alpha * 255):02x}"


def _js_round(value: float) -> int:
    # Math.round rounds halves up; Python's round() rounds them to even.
    return int(value + 0.5) if value >= 0 else -int(-value + 0.5)


def _classify(raw: dict) -> str | None:
    kind = raw.get("type")
    if kind in ("IText", "Textbox"):
        return "text" if isinstance(raw.get("text"), str) else None
    if kind == "Sticky":
        return "sticky" if isinstance(raw.get("text"), str) else None
    if kind == "Rect":
        return "rect"
    if kind == "Circle":
        return "dot" if raw.get("isInk") is True else "circle"
    if kind == "Path":
        return "stroke" if raw.get("isInk") is True else None
    if kind == "Image":
        return "image" if isinstance(raw.get("src"), str) else None
    if kind == "Connector":
        return "connector"
    if kind == "Group":
        return "group" if isinstance(raw.get("objects"), list) else None
    return None


def _object_from_fabric(raw: Any, index: int) -> dict:
    kind = _classify(raw) if isinstance(raw, dict) else None
    if kind is None:
        unknown: dict = {"type": "unknown", "z": index, "raw": copy.deepcopy(raw)}
        if isinstance(raw, dict) and isinstance(raw.get("semanticId"), str):
            unknown["id"] = raw["semanticId"]
        return unknown
    rest = copy.deepcopy(raw)
    model_type = "shape" if kind in ("rect", "circle") else "ink" if kind in ("stroke", "dot") else kind
    obj: dict = {"type": model_type, "z": index}
    rest.pop("type", None)
    if isinstance(rest.get("semanticId"), str):
        obj["id"] = rest.pop("semanticId")
    geometry: dict = {}
    _take(rest, geometry, _GEOMETRY)
    if geometry:
        obj["geometry"] = geometry
    _take(rest, obj, (("opacity", "opacity"),))

    if kind == "text":
        obj["mode"] = "point" if raw["type"] == "IText" else "box"
        _take(rest, obj, _FIELDS["text"])
    elif kind == "sticky":
        _take(rest, obj, _FIELDS["sticky"])
        key = palette_key_for(obj.get("color"))
        if key:
            obj["colorKey"] = key
    elif kind in ("rect", "circle"):
        obj["kind"] = kind
        _take(rest, obj, _FIELDS[kind])
        key = palette_key_for(obj.get("fill"))
        if key:
            obj["fillKey"] = key
    elif kind == "connector":
        _take(rest, obj, _FIELDS["connector"])
        obj["arrowheads"] = dict(DEFAULT_CONNECTOR_ARROWHEADS)
    elif kind == "image":
        obj["mediaRef"] = {"kind": "inline", "dataUrl": rest.pop("src")}
    elif kind == "group":
        obj["children"] = [_object_from_fabric(child, i) for i, child in enumerate(rest.pop("objects"))]
    else:  # ink stroke or dot
        obj["kind"] = kind
        rest.pop("isInk", None)
        _take(rest, obj, _FIELDS[kind])
        color_key = "fill" if kind == "dot" else "stroke"
        if color_key in rest:
            color, alpha = _split_color(rest.pop(color_key))
            obj["color"] = color
            if alpha is not None:
                obj["alpha"] = alpha
        if kind == "stroke":
            if isinstance(rest.get("inkPoints"), list):
                obj["points"] = rest.pop("inkPoints")
            if isinstance(rest.get("path"), list):
                obj["path"] = rest.pop("path")
    obj["extras"] = rest
    return obj


def from_fabric(content: Any, page_state: Any = None) -> dict:
    """Fabric content (`{version, objects}`) and the note's page state to a document."""
    source = content if isinstance(content, dict) else {}
    extras = {key: copy.deepcopy(value) for key, value in source.items() if key != "objects"}
    raw_objects = source.get("objects")
    objects = [_object_from_fabric(raw, i) for i, raw in enumerate(raw_objects)] if isinstance(raw_objects, list) else []
    page = copy.deepcopy(page_state) if isinstance(page_state, dict) else dict(DEFAULT_PAGE)
    return {"schemaVersion": SCHEMA_VERSION, "page": page, "objects": objects, "extras": extras}


def _ordered(objects: list[dict]) -> list[dict]:
    keyed = [(obj.get("z", index), index, obj) for index, obj in enumerate(objects)]
    keyed.sort(key=lambda item: (item[0], item[1]))
    return [obj for _, _, obj in keyed]


def _object_to_fabric(obj: dict, resolve_media: Callable[[dict], Any] | None) -> dict:
    if obj["type"] == "unknown":
        return copy.deepcopy(obj["raw"])
    out = copy.deepcopy(obj.get("extras") or {})
    if "id" in obj:
        out["semanticId"] = obj["id"]
    geometry = obj.get("geometry") or {}
    for fabric_key, key in _GEOMETRY:
        if key in geometry:
            out[fabric_key] = geometry[key]
    if "opacity" in obj:
        out["opacity"] = obj["opacity"]

    kind = obj["type"]
    if kind == "text":
        out["type"] = _TEXT_TYPE[obj["mode"]]
        _put(obj, out, _FIELDS["text"])
    elif kind == "sticky":
        out["type"] = _FABRIC_TYPE["sticky"]
        _put(obj, out, _FIELDS["sticky"])
    elif kind == "shape":
        out["type"] = _FABRIC_TYPE[obj["kind"]]
        _put(obj, out, _FIELDS[obj["kind"]])
    elif kind == "connector":
        out["type"] = _FABRIC_TYPE["connector"]
        _put(obj, out, _FIELDS["connector"])
    elif kind == "image":
        out["type"] = _FABRIC_TYPE["image"]
        ref = obj["mediaRef"]
        if ref["kind"] == "inline":
            out["src"] = ref["dataUrl"]
        else:
            resolved = resolve_media(ref) if resolve_media else None
            if not isinstance(resolved, str):
                raise DocumentError(f"Picture {ref.get('id')!r} is in the media library; pass resolve_media to turn it into a data URL")
            out["src"] = resolved
    elif kind == "group":
        out["type"] = _FABRIC_TYPE["group"]
        out["objects"] = [_object_to_fabric(child, resolve_media) for child in _ordered(obj["children"])]
    else:  # ink
        out["type"] = _FABRIC_TYPE[obj["kind"]]
        out["isInk"] = True
        _put(obj, out, _FIELDS[obj["kind"]])
        color_key = "fill" if obj["kind"] == "dot" else "stroke"
        if "color" in obj:
            out[color_key] = _join_color(obj["color"], obj.get("alpha"))
        if "points" in obj:
            out["inkPoints"] = copy.deepcopy(obj["points"])
        if "path" in obj:
            out["path"] = copy.deepcopy(obj["path"])
    return out


def to_fabric(doc: dict, resolve_media: Callable[[dict], Any] | None = None) -> dict:
    """Document to Fabric content. `resolve_media(ref)` turns a `{kind: 'media', id}` picture into a data URL."""
    result = validate_document(doc, require_ids=False, strict=False)
    if not result["ok"]:
        detail = "; ".join(f"{error['path']}: {error['message']}" for error in result["errors"])
        raise DocumentError(f"Not a valid document: {detail}", result["errors"])
    return {**copy.deepcopy(doc.get("extras") or {}), "objects": [_object_to_fabric(obj, resolve_media) for obj in _ordered(doc["objects"])]}


def page_state_of(doc: dict) -> dict:
    return copy.deepcopy(doc["page"])


def validate_document(doc: Any, require_ids: bool = True, strict: bool = True) -> dict:
    """Same checks and messages as validateDocument in src/core/document/validate.js."""
    errors: list[dict] = []

    def report(path: str, message: str, structural: bool = False) -> None:
        if strict or structural:
            errors.append({"path": path, "message": message})

    if not isinstance(doc, dict):
        return {"ok": False, "errors": [{"path": "", "message": "a document must be an object"}]}
    if doc.get("schemaVersion") != SCHEMA_VERSION:
        report("schemaVersion", f"unsupported schemaVersion {doc.get('schemaVersion')!r} (this build reads {SCHEMA_VERSION})", True)
    page = doc.get("page")
    if not isinstance(page, dict):
        report("page", "must be an object", True)
    else:
        for key in ("columns", "rows"):
            value = page.get(key)
            if not (isinstance(value, int) and not isinstance(value, bool) and value >= 1):
                report(f"page.{key}", "must be a whole number of at least 1")
    objects = doc.get("objects")
    if not isinstance(objects, list):
        return {"ok": False, "errors": [*errors, {"path": "objects", "message": "must be an array"}]}

    ids: dict[str, int] = {}
    zs: dict[Any, int] = {}
    for index, obj in enumerate(objects):
        path = f"objects[{index}]"
        _check_object(obj, path, report)
        if not isinstance(obj, dict):
            continue
        if require_ids and strict:
            if "id" not in obj:
                report(f"{path}.id", "missing id")
            elif obj["id"] == "":
                report(f"{path}.id", "empty id")
            elif isinstance(obj["id"], str):
                if obj["id"] in ids:
                    report(f"{path}.id", f"duplicate id {obj['id']!r} (also used by objects[{ids[obj['id']]}])")
                else:
                    ids[obj["id"]] = index
        if "z" in obj:
            if obj["z"] in zs:
                report(f"{path}.z", f"duplicate z (also used by objects[{zs[obj['z']]}])")
            elif _is_number(obj["z"]):
                zs[obj["z"]] = index
    return {"ok": not errors, "errors": errors}


def _check_object(obj: Any, path: str, report) -> None:
    if not isinstance(obj, dict):
        report(path, "must be an object", True)
        return
    if obj.get("type") not in OBJECT_TYPES:
        report(f"{path}.type", f"unknown object type {obj.get('type')!r}", True)
        return
    if "z" in obj and not _is_number(obj["z"]):
        report(f"{path}.z", "must be a finite number")
    if "id" in obj and not isinstance(obj["id"], str):
        report(f"{path}.id", "must be a string")
    if "opacity" in obj and not (_is_number(obj["opacity"]) and 0 <= obj["opacity"] <= 1):
        report(f"{path}.opacity", "must be a number from 0 to 1")
    if "geometry" in obj:
        geometry = obj["geometry"]
        if not isinstance(geometry, dict):
            report(f"{path}.geometry", "must be an object")
        else:
            for key in ("x", "y", "width", "height", "rotation", "scaleX", "scaleY"):
                if key in geometry and not _is_number(geometry[key]):
                    report(f"{path}.geometry.{key}", "must be a finite number")
            for key in ("originX", "originY"):
                if key in geometry and not isinstance(geometry[key], str):
                    report(f"{path}.geometry.{key}", "must be a string")
    if "extras" in obj and not isinstance(obj["extras"], dict):
        report(f"{path}.extras", "must be an object")

    kind = obj["type"]
    if kind == "text":
        if obj.get("mode") not in TEXT_MODES:
            report(f"{path}.mode", f"must be {' or '.join(TEXT_MODES)}", True)
        if not isinstance(obj.get("content"), str):
            report(f"{path}.content", "must be a string")
    elif kind == "sticky":
        if not isinstance(obj.get("content"), str):
            report(f"{path}.content", "must be a string")
        if not isinstance(obj.get("color"), str):
            report(f"{path}.color", "sticky needs a colour")
    elif kind == "shape":
        if obj.get("kind") not in SHAPE_KINDS:
            report(f"{path}.kind", f"must be one of {', '.join(SHAPE_KINDS)}", True)
    elif kind == "ink":
        if obj.get("kind") not in INK_KINDS:
            report(f"{path}.kind", f"must be one of {', '.join(INK_KINDS)}", True)
        if "alpha" in obj and not (_is_number(obj["alpha"]) and 0 <= obj["alpha"] <= 1):
            report(f"{path}.alpha", "must be a number from 0 to 1")
        if "points" in obj:
            if not isinstance(obj["points"], list):
                report(f"{path}.points", "must be an array")
            else:
                for i, point in enumerate(obj["points"]):
                    for key in ("x", "y"):
                        if not isinstance(point, dict) or not _is_number(point.get(key)):
                            report(f"{path}.points[{i}].{key}", "must be a finite number")
    elif kind == "image":
        ref = obj.get("mediaRef")
        if not isinstance(ref, dict) or ref.get("kind") not in MEDIA_KINDS:
            report(f"{path}.mediaRef.kind", f"must be {' or '.join(MEDIA_KINDS)}", True)
        elif ref["kind"] == "inline" and not isinstance(ref.get("dataUrl"), str):
            report(f"{path}.mediaRef.dataUrl", "inline pictures need a dataUrl", True)
        elif ref["kind"] == "media" and not isinstance(ref.get("id"), str):
            report(f"{path}.mediaRef.id", "library pictures need an id", True)
    elif kind == "connector":
        for key in ("fromId", "toId"):
            if not isinstance(obj.get(key), str) or obj[key] == "":
                report(f"{path}.{key}", f"connector needs a {key}")
    elif kind == "group":
        if not isinstance(obj.get("children"), list):
            report(f"{path}.children", "must be an array", True)
        else:
            for i, child in enumerate(obj["children"]):
                _check_object(child, f"{path}.children[{i}]", report)
    elif kind == "unknown":
        if "raw" not in obj:
            report(f"{path}.raw", "unknown objects must keep their raw value", True)


def _number(value: Any) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def _text_of(obj: Any) -> str | None:
    """The `text` an object carries, wherever the model keeps it, exactly as the old readers saw it on the Fabric JSON."""
    if not isinstance(obj, dict):
        return None
    if obj.get("type") == "unknown":
        raw = obj.get("raw")
        text = raw.get("text") if isinstance(raw, dict) else None
    elif obj.get("type") in ("text", "sticky"):
        text = obj.get("content")
    else:
        text = (obj.get("extras") or {}).get("text")
    return text if isinstance(text, str) else None


def _position(obj: dict) -> tuple[float, float]:
    if obj.get("type") == "unknown":
        raw = obj.get("raw") if isinstance(obj.get("raw"), dict) else {}
        return _number(raw.get("top")), _number(raw.get("left"))
    geometry = obj.get("geometry") or {}
    return _number(geometry.get("y")), _number(geometry.get("x"))


def plain_text(doc: dict) -> str:
    """Canvas text blocks, top to bottom then left to right. Identical to note_text.canvas_plain_text on the same note."""
    blocks = sorted((obj for obj in _ordered(doc.get("objects", [])) if isinstance(obj, dict)), key=_position)
    return "\n\n".join(text.strip() for text in (_text_of(obj) for obj in blocks) if text and text.strip())


def search_text(doc: dict) -> str:
    """Every text block in stored order, space-joined. Identical to NoteService.canvas_text on the same note."""
    return " ".join(text for text in (_text_of(obj) for obj in _ordered(doc.get("objects", []))) if text is not None)
