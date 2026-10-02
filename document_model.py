"""Engine-independent document model, Python mirror of src/core/document/ (F-025).

Same shape, same rules, same fixtures (tests/fixtures/documents/); tests/test_document_model.py compares it with the JS
build on every fixture. The Fabric placement rules live in the "geometry" section below, as in src/core/document/geometry.js. A document is
`{schemaVersion, page, objects, extras}`; see src/core/document/schema.js for the full field list. Nothing in the app uses
this yet: F-026 moves storage onto it. Until then it proves the Fabric conversion is render-equivalent and gives agent-facing text helpers
(`plain_text_blocks`, `plain_text`, `search_text`); search_text equals NoteService.canvas_text, plain_text reads by top edge (see its docstring).
"""

from __future__ import annotations

import copy
import json
import math
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
_HEX_WITH_ALPHA = re.compile(r"(#[0-9a-fA-F]{6})([0-9a-f]{2})")


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


# --- geometry: the only place that knows Fabric's placement rules (mirror of src/core/document/geometry.js) -------------

def _to_radians(degrees: float) -> float:
    return degrees * (math.pi / 180)


def _cosine(radians: float) -> float:
    if radians == 0:
        return 1
    quarter = abs(radians) / (math.pi / 2)
    if quarter in (1, 3):
        return 0
    if quarter == 2:
        return -1
    return math.cos(radians)


def _sine(radians: float) -> float:
    if radians == 0:
        return 0
    sign = 1 if radians > 0 else -1
    quarter = radians / (math.pi / 2)
    if quarter == 1:
        return sign
    if quarter == 2:
        return 0
    if quarter == 3:
        return -sign
    return math.sin(radians)


def _rotate_point(point: dict, radians: float, origin: dict) -> dict:
    sin, cos = _sine(radians), _cosine(radians)
    x, y = point["x"] - origin["x"], point["y"] - origin["y"]
    return {"x": x * cos - y * sin + origin["x"], "y": x * sin + y * cos + origin["y"]}


_ORIGINS = {"left": 0, "top": 0, "center": 0.5, "right": 1, "bottom": 1}


def _origin_number(origin: Any) -> float:
    if isinstance(origin, (int, float)) and not isinstance(origin, bool):
        return origin
    return _ORIGINS.get(origin, 0.5) if isinstance(origin, str) else 0.5


def _transformed_dimensions(width=0, height=0, stroke_width=0, stroke_uniform=False, scale_x=1, scale_y=1, skew_x=0, skew_y=0) -> dict:
    pre = 0 if stroke_uniform else stroke_width
    post = stroke_width if stroke_uniform else 0
    dim_x, dim_y = width + pre, height + pre
    if skew_x == 0 and skew_y == 0:
        return {"x": dim_x * scale_x + post, "y": dim_y * scale_y + post}

    def multiply(a, b):
        return [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3]]

    m = [scale_x, 0, 0, scale_y]
    if skew_x:
        m = multiply(m, [1, 0, math.tan(_to_radians(skew_x)), 1])
    if skew_y:
        m = multiply(m, [1, math.tan(_to_radians(skew_y)), 0, 1])
    half_x, half_y = dim_x / 2, dim_y / 2
    xs, ys = [], []
    for px, py in ((-half_x, -half_y), (half_x, -half_y), (-half_x, half_y), (half_x, half_y)):
        xs.append(m[0] * px + m[2] * py)
        ys.append(m[1] * px + m[3] * py)
    return {"x": max(xs) - min(xs) + post, "y": max(ys) - min(ys) + post}


def _center_from_origin(left, top, origin_x, origin_y, angle, dimensions) -> dict:
    point = {"x": left + (0.5 - _origin_number(origin_x)) * dimensions["x"], "y": top + (0.5 - _origin_number(origin_y)) * dimensions["y"]}
    return _rotate_point(point, _to_radians(angle), {"x": left, "y": top}) if angle else point


def _origin_from_center(x, y, origin_x, origin_y, angle, dimensions) -> dict:
    point = {"x": x + (_origin_number(origin_x) - 0.5) * dimensions["x"], "y": y + (_origin_number(origin_y) - 0.5) * dimensions["y"]}
    return _rotate_point(point, _to_radians(angle), {"x": x, "y": y}) if angle else point


def _curve_bounds(beg_x, beg_y, cp1_x, cp1_y, cp2_x, cp2_y, end_x, end_y) -> list[dict]:
    ts: list[float] = []
    b = 6 * beg_x - 12 * cp1_x + 6 * cp2_x
    a = -3 * beg_x + 9 * cp1_x - 9 * cp2_x + 3 * end_x
    c = 3 * cp1_x - 3 * beg_x
    for axis in range(2):
        if axis > 0:
            b = 6 * beg_y - 12 * cp1_y + 6 * cp2_y
            a = -3 * beg_y + 9 * cp1_y - 9 * cp2_y + 3 * end_y
            c = 3 * cp1_y - 3 * beg_y
        if abs(a) < 1e-12:
            if abs(b) < 1e-12:
                continue
            t = -c / b
            if 0 < t < 1:
                ts.append(t)
            continue
        b2ac = b * b - 4 * c * a
        if b2ac < 0:
            continue
        root = math.sqrt(b2ac)
        t1 = (-b + root) / (2 * a)
        if 0 < t1 < 1:
            ts.append(t1)
        t2 = (-b - root) / (2 * a)
        if 0 < t2 < 1:
            ts.append(t2)
    xs, ys = [beg_x, end_x], [beg_y, end_y]
    for t in ts:
        u = 1 - t
        xs.append(u * u * u * beg_x + 3 * u * u * t * cp1_x + 3 * u * t * t * cp2_x + t * t * t * end_x)
        ys.append(u * u * u * beg_y + 3 * u * u * t * cp1_y + 3 * u * t * t * cp2_y + t * t * t * end_y)
    return [{"x": min(xs), "y": min(ys)}, {"x": max(xs), "y": max(ys)}]


_ARGUMENT_COUNT = {"M": 2, "L": 2, "Q": 4, "C": 6, "Z": 0}


def _is_simple_path(path: Any) -> bool:
    return isinstance(path, list) and all(
        isinstance(command, list)
        and len(command) > 0
        and isinstance(command[0], str)
        and command[0] in _ARGUMENT_COUNT
        and len(command) == _ARGUMENT_COUNT[command[0]] + 1
        and all(_is_number(value) for value in command[1:])
        for command in path
    )


def _path_bounds(path: list) -> dict:
    """The box Fabric gives a Path, quirks included (a Q is measured as a cubic with both controls the Q's one; an L from its sub-path start)."""
    points: list[dict] = []
    start_x = start_y = x = y = 0
    for command in path:
        kind = command[0]
        if kind == "L":
            x, y = command[1], command[2]
            points += [{"x": start_x, "y": start_y}, {"x": x, "y": y}]
        elif kind == "M":
            x, y = command[1], command[2]
            start_x, start_y = x, y
        elif kind == "C":
            points += _curve_bounds(x, y, command[1], command[2], command[3], command[4], command[5], command[6])
            x, y = command[5], command[6]
        elif kind == "Q":
            points += _curve_bounds(x, y, command[1], command[2], command[1], command[2], command[3], command[4])
            x, y = command[3], command[4]
        else:  # Z
            x, y = start_x, start_y
    left = top = right = bottom = 0
    for index, point in enumerate(points):
        if point["x"] > right or not index:
            right = point["x"]
        if point["x"] < left or not index:
            left = point["x"]
        if point["y"] > bottom or not index:
            bottom = point["y"]
        if point["y"] < top or not index:
            top = point["y"]
    return {"left": left, "top": top, "width": right - left, "height": bottom - top}


def _shift_path(path: list, dx: float, dy: float) -> list:
    return [[value if index == 0 else value + (dx if index % 2 == 1 else dy) for index, value in enumerate(command)] for command in path]


# --- Fabric JSON <-> model ------------------------------------------------------------------------------------------

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
    match = _HEX_WITH_ALPHA.fullmatch(value) if isinstance(value, str) else None
    return (match.group(1), int(match.group(2), 16) / 255) if match else (value, None)


def _join_color(color: Any, alpha: float | None) -> Any:
    if alpha is None or not isinstance(color, str):
        return color
    return f"{color}{_js_round(alpha * 255):02x}"


def _js_round(value: float) -> int:
    # Math.round rounds halves up; Python's round() rounds them to even.
    return int(value + 0.5) if value >= 0 else -int(-value + 0.5)


_NUMERIC_PLACEMENT = ("left", "top", "width", "height", "angle", "scaleX", "scaleY", "skewX", "skewY", "strokeWidth")


def _has_clean_placement(raw: dict) -> bool:
    return (
        all(key not in raw or _is_number(raw[key]) for key in _NUMERIC_PLACEMENT)
        and all(key not in raw or isinstance(raw[key], bool) for key in ("flipX", "flipY", "strokeUniform", "visible"))
        and all(key not in raw or (isinstance(raw[key], str) and raw[key] in ("left", "center", "right", "top", "bottom")) for key in ("originX", "originY"))
    )


def _classify(raw: dict) -> str | None:
    if not _has_clean_placement(raw):
        return None
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
        return "stroke" if raw.get("isInk") is True and _is_simple_path(raw.get("path")) else None
    if kind == "Image":
        return "image" if isinstance(raw.get("src"), str) else None
    if kind == "Connector":
        return "connector"
    if kind == "Group":
        return "group" if isinstance(raw.get("objects"), list) else None
    return None


def _stroke_width_of_raw(raw: dict) -> float:
    return raw["strokeWidth"] if _is_number(raw.get("strokeWidth")) else 0 if raw.get("type") == "Connector" else 1


def _stroke_width_of_model(obj: dict) -> float:
    if obj["type"] == "shape":
        stored = obj.get("strokeWidth")
    elif obj["type"] == "ink" and obj.get("kind") == "stroke":
        stored = obj.get("width")
    else:
        stored = (obj.get("extras") or {}).get("strokeWidth")
    return stored if _is_number(stored) else 0 if obj["type"] == "connector" else 1


_FLAT = {"dx": 0, "dy": 0}
_PLACEMENT_KEYS = ("left", "top", "width", "height", "angle", "scaleX", "scaleY", "flipX", "flipY", "skewX", "skewY", "originX", "originY")


def _geometry_from_fabric(rest: dict, frame: dict, size: dict | None) -> dict:
    """Fabric placement to neutral geometry: top-left of the box in the parent frame, size, and rotation/scale/flip/skew about its centre."""
    geometry = {
        "rotation": rest.get("angle", 0), "scaleX": rest.get("scaleX", 1), "scaleY": rest.get("scaleY", 1),
        "flipX": rest.get("flipX", False), "flipY": rest.get("flipY", False), "skewX": rest.get("skewX", 0), "skewY": rest.get("skewY", 0),
    }
    width = size["width"] if size else rest.get("width")
    height = size["height"] if size else rest.get("height")
    dimensions = _transformed_dimensions(
        width or 0, height or 0, _stroke_width_of_raw(rest), rest.get("strokeUniform") is True,
        geometry["scaleX"], geometry["scaleY"], geometry["skewX"], geometry["skewY"],
    )
    center = _center_from_origin(rest.get("left", 0), rest.get("top", 0), rest.get("originX", "center"), rest.get("originY", "center"), geometry["rotation"], dimensions)
    for key in _PLACEMENT_KEYS:
        rest.pop(key, None)
    ordered: dict = {"x": center["x"] - (width or 0) / 2 + frame["dx"], "y": center["y"] - (height or 0) / 2 + frame["dy"]}
    if width is not None:
        ordered["width"] = width
    if height is not None:
        ordered["height"] = height
    ordered.update(geometry)
    return ordered


def _geometry_to_fabric(obj: dict, frame: dict, out: dict) -> None:
    geometry = obj.get("geometry") or {}
    rotation = geometry.get("rotation", 0)
    scale_x, scale_y = geometry.get("scaleX", 1), geometry.get("scaleY", 1)
    skew_x, skew_y = geometry.get("skewX", 0), geometry.get("skewY", 0)
    width, height = geometry.get("width"), geometry.get("height")
    center = {"x": geometry.get("x", 0) + (width or 0) / 2 - frame["dx"], "y": geometry.get("y", 0) + (height or 0) / 2 - frame["dy"]}
    out["angle"] = rotation
    out["scaleX"], out["scaleY"] = scale_x, scale_y
    out["flipX"], out["flipY"] = geometry.get("flipX", False), geometry.get("flipY", False)
    out["skewX"], out["skewY"] = skew_x, skew_y
    if width is not None:
        out["width"] = width
    if height is not None:
        out["height"] = height
    if width is not None and height is not None:
        out["originX"] = out["originY"] = "center"
        out["left"], out["top"] = center["x"], center["y"]
    else:
        dimensions = _transformed_dimensions(width or 0, height or 0, _stroke_width_of_model(obj), obj.get("strokeUniform") is True, scale_x, scale_y, skew_x, skew_y)
        point = _origin_from_center(center["x"], center["y"], "left", "top", rotation, dimensions)
        out["originX"], out["originY"] = "left", "top"
        out["left"], out["top"] = point["x"], point["y"]


def _shadow_from_fabric(rest: dict) -> dict | None:
    shadow = rest.get("shadow")
    if not (isinstance(shadow, dict) and isinstance(shadow.get("color"), str) and _is_number(shadow.get("blur")) and _is_number(shadow.get("offsetX")) and _is_number(shadow.get("offsetY"))):
        return None
    del rest["shadow"]
    model = {"color": shadow["color"], "blur": shadow["blur"], "x": shadow["offsetX"], "y": shadow["offsetY"]}
    others = {key: value for key, value in shadow.items() if key not in ("color", "blur", "offsetX", "offsetY")}
    if others:
        model["extras"] = others
    return model


def _object_from_fabric(raw: Any, index: int, frame: dict = _FLAT) -> dict:
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

    bounds = _path_bounds(rest["path"]) if kind == "stroke" else None
    obj["geometry"] = _geometry_from_fabric(rest, frame, bounds)
    _take(rest, obj, (("opacity", "opacity"), ("visible", "visible"), ("strokeUniform", "strokeUniform")))
    shadow = _shadow_from_fabric(rest)
    if shadow is not None:
        obj["shadow"] = shadow

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
        child_frame = {"dx": (obj["geometry"].get("width") or 0) / 2, "dy": (obj["geometry"].get("height") or 0) / 2}
        obj["children"] = [_object_from_fabric(child, i, child_frame) for i, child in enumerate(rest.pop("objects"))]
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
            # Path and points are stored relative to the box's top-left corner, so they do not depend on Fabric's pathOffset.
            obj["path"] = _shift_path(rest.pop("path"), -bounds["left"], -bounds["top"])
            points = rest.get("inkPoints")
            if isinstance(points, list) and all(isinstance(p, dict) and _is_number(p.get("x")) and _is_number(p.get("y")) for p in points):
                obj["points"] = [{**p, "x": p["x"] - bounds["left"], "y": p["y"] - bounds["top"]} for p in points]
                del rest["inkPoints"]
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


def _object_to_fabric(obj: dict, resolve_media: Callable[[dict], Any] | None, frame: dict = _FLAT) -> dict:
    if obj["type"] == "unknown":
        return copy.deepcopy(obj["raw"])
    out = copy.deepcopy(obj.get("extras") or {})
    if "id" in obj:
        out["semanticId"] = obj["id"]
    _geometry_to_fabric(obj, frame, out)
    for key in ("opacity", "visible", "strokeUniform"):
        if key in obj:
            out[key] = obj[key]
    if "shadow" in obj:
        shadow = obj["shadow"]
        out["shadow"] = {"color": shadow["color"], "blur": shadow["blur"], "offsetX": shadow["x"], "offsetY": shadow["y"], **(shadow.get("extras") or {})}

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
                raise DocumentError(f"Picture {json.dumps(ref.get('id'), ensure_ascii=False)} is in the media library; pass resolve_media to turn it into a data URL")
            out["src"] = resolved
    elif kind == "group":
        out["type"] = _FABRIC_TYPE["group"]
        geometry = obj.get("geometry") or {}
        child_frame = {"dx": (geometry.get("width") or 0) / 2, "dy": (geometry.get("height") or 0) / 2}
        out["objects"] = [_object_to_fabric(child, resolve_media, child_frame) for child in _ordered(obj["children"])]
    else:  # ink
        out["type"] = _FABRIC_TYPE[obj["kind"]]
        out["isInk"] = True
        _put(obj, out, _FIELDS[obj["kind"]])
        color_key = "fill" if obj["kind"] == "dot" else "stroke"
        if "color" in obj:
            out[color_key] = _join_color(obj["color"], obj.get("alpha"))
        geometry = obj.get("geometry") or {}
        x, y = geometry.get("x", 0), geometry.get("y", 0)
        if "path" in obj:
            out["path"] = _shift_path(obj["path"], x, y)
        if "points" in obj:
            out["inkPoints"] = [{**p, "x": p["x"] + x, "y": p["y"] + y} for p in obj["points"]]
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


def _js_json(container: dict, key: str) -> str:
    """JSON.stringify of a field, as the JS validator words its messages ('undefined' when the field is missing)."""
    return json.dumps(container[key], ensure_ascii=False) if key in container else "undefined"


def validate_document(doc: Any, require_ids: bool = True, strict: bool = True) -> dict:
    """Same checks and messages as validateDocument in src/core/document/validate.js."""
    errors: list[dict] = []

    def report(path: str, message: str, structural: bool = False) -> None:
        if strict or structural:
            errors.append({"path": path, "message": message})

    if not isinstance(doc, dict):
        return {"ok": False, "errors": [{"path": "", "message": "a document must be an object"}]}
    if doc.get("schemaVersion") != SCHEMA_VERSION:
        report("schemaVersion", f"unsupported schemaVersion {_js_json(doc, 'schemaVersion')} (this build reads {SCHEMA_VERSION})", True)
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
                    report(f"{path}.id", f"duplicate id {_js_json(obj, 'id')} (also used by objects[{ids[obj['id']]}])")
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
        report(f"{path}.type", f"unknown object type {_js_json(obj, 'type')}", True)
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
            for key in ("x", "y", "width", "height", "rotation", "scaleX", "scaleY", "skewX", "skewY"):
                if key in geometry and not _is_number(geometry[key]):
                    report(f"{path}.geometry.{key}", "must be a finite number")
            for key in ("flipX", "flipY"):
                if key in geometry and not isinstance(geometry[key], bool):
                    report(f"{path}.geometry.{key}", "must be true or false")
    for key in ("visible", "strokeUniform"):
        if key in obj and not isinstance(obj[key], bool):
            report(f"{path}.{key}", "must be true or false")
    if "shadow" in obj:
        shadow = obj["shadow"]
        if not isinstance(shadow, dict):
            report(f"{path}.shadow", "must be an object")
        else:
            if not isinstance(shadow.get("color"), str):
                report(f"{path}.shadow.color", "must be a string")
            for key in ("blur", "x", "y"):
                if not _is_number(shadow.get(key)):
                    report(f"{path}.shadow.{key}", "must be a finite number")
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


def plain_text_blocks(doc: dict) -> list[str]:
    """The text blocks of a canvas in reading order: by the top edge of each box, then its left edge.

    note_text.canvas_plain_text sorts by Fabric's `top`/`left`, which are the object's *origin point*: the centre for objects
    made in the app, the top-left corner for agent-written ones. This sorts by the box's top-left on every object, so a tall
    sticky and a short text block that were centred on the same line now read top-edge first. The blocks are the same set.
    """
    ordered = sorted((obj for obj in _ordered(doc.get("objects", [])) if isinstance(obj, dict)), key=_position)
    return [text.strip() for text in (_text_of(obj) for obj in ordered) if text and text.strip()]


def plain_text(doc: dict) -> str:
    return "\n\n".join(plain_text_blocks(doc))


def search_text(doc: dict) -> str:
    """Every text block in stored order, space-joined. Identical to NoteService.canvas_text on the same note."""
    return " ".join(text for text in (_text_of(obj) for obj in _ordered(doc.get("objects", []))) if text is not None)
