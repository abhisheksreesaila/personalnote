"""Document model <-> JSON Canvas 1.0 (the stored note format, ADR 0002, F-026).

Python mirror of ``src/core/document/jsoncanvas.js``: same output for the same document (the tests compare them on every fixture),
so read that file's header for the design. Short version: JSON Canvas fields carry what other apps use (ids, integer boxes, Markdown
text, colours, file paths, edges, z-order = array order); a namespaced ``pn`` object on each node and edge carries the exact model
object, and the native fields win where another app changed them. Ink and shapes also get a derived SVG ``file`` node.

``media`` is an object with optional ``from_id(id) -> path``, ``put_text(text, ext) -> path`` and ``put_data_url(url) -> path``
(``MediaStore`` in ``media_store.py`` is the content-addressed one the server uses). Without it, inline pictures and SVG pictures stay
``data:`` URLs in the node's ``file``. ``derived="omit"`` writes ``file: ""`` for SVG nodes (the browser's transport form).
"""

from __future__ import annotations

import copy
import math
import re
from typing import Any
from urllib.parse import quote

from document_model import (
    DEFAULT_PAGE,
    PAGE,
    SCHEMA_VERSION,
    DocumentError,
    _is_number,
    _ordered,
    plain_text,
    plain_text_blocks,
)

PRESETS = {"1": "#fb464c", "2": "#e9973f", "3": "#e0de71", "4": "#44cf6e", "5": "#53dfdd", "6": "#a882ff"}
FOREIGN_TEXT_STYLE = {"fontFamily": "Source Serif 4", "fontSize": 24, "lineHeight": 1.45, "padding": 8, "color": "#20201e"}
DEFAULT_CONNECTOR = {"lineWidth": 2.6, "color": "#20201e", "arrowheads": {"start": False, "end": True}}
IMAGE_EXTENSIONS = {"png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp"}
SIDES = ("top", "right", "bottom", "left")
_HEX6 = re.compile(r"^#[0-9a-fA-F]{6}$")
_PRESET = re.compile(r"^[1-6]$")
_DATA_URL = re.compile(r"^data:([^;,]+)(;base64)?,", re.IGNORECASE)

__all__ = [
    "FOREIGN_TEXT_STYLE", "PRESETS", "estimate_text_box", "from_json_canvas", "is_data_url", "is_json_canvas", "native_box",
    "plain_text", "plain_text_blocks", "svg_of", "to_json_canvas", "validate_json_canvas",
]


def _is_object(value: Any) -> bool:
    return isinstance(value, dict)


def _round(value: float) -> int:
    """Math.round: halves go up."""
    return math.floor(value + 0.5)


def _clone(value: Any) -> Any:
    return copy.deepcopy(value)


def is_data_url(value: Any) -> bool:
    return isinstance(value, str) and value.startswith("data:")


def _num(value: float) -> str:
    rounded = _round(value * 1000) / 1000
    return str(int(rounded)) if rounded == int(rounded) else repr(rounded)


def _escape(value: Any) -> str:
    return str(value).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def _svg_data_url(svg: str) -> str:
    return "data:image/svg+xml;charset=utf-8," + quote(svg, safe="-_.!~*'()")


def _hex_of(value: Any) -> str | None:
    return value if isinstance(value, str) and _HEX6.match(value) else None


def _preset_hex(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    if _HEX6.match(value):
        return value.lower()
    return PRESETS.get(value)


def _color_from_native(native: Any, stored: Any) -> Any:
    if native is None:
        return stored
    hex_value = _preset_hex(native)
    if hex_value is None:
        return stored
    return stored if isinstance(stored, str) and stored.lower() == hex_value else hex_value


# --- boxes -----------------------------------------------------------------------------------------------------------------

def estimate_text_box(obj: dict) -> dict:
    style = obj.get("style") or {}
    geometry = obj.get("geometry") or {}
    width = geometry.get("width", 200)
    size = style["fontSize"] if _is_number(style.get("fontSize")) else 24
    line_height = style["lineHeight"] if _is_number(style.get("lineHeight")) else 1.16
    padding = style["padding"] if _is_number(style.get("padding")) else 0
    per_line = max(1, math.floor(width / (size * 0.5)))
    content = obj.get("content")
    lines = sum(max(1, math.ceil(len(line) / per_line)) for line in str("" if content is None else content).split("\n"))
    return {"width": width, "height": lines * size * line_height + padding * 2}


def native_box(obj: dict) -> dict:
    """The integer box JSON Canvas readers see for a model object."""
    geometry = obj.get("geometry") or {}
    textual = obj.get("type") in ("text", "sticky")
    estimate = estimate_text_box(obj) if textual and ("width" not in geometry or "height" not in geometry) else None
    width = geometry["width"] if "width" in geometry else (estimate["width"] if estimate else 0)
    height = geometry["height"] if "height" in geometry else (estimate["height"] if estimate else 0)
    return {
        "x": _round(geometry.get("x", 0)),
        "y": _round(geometry.get("y", 0)),
        "width": max(1, _round(width)),
        "height": max(1, _round(height)),
    }


def _raw_box(raw: Any) -> dict:
    source = raw if _is_object(raw) else {}

    def n(value: Any, fallback: int) -> int:
        return _round(value) if _is_number(value) else fallback

    return {"x": n(source.get("left"), 0), "y": n(source.get("top"), 0), "width": max(1, n(source.get("width"), 1)), "height": max(1, n(source.get("height"), 1))}


# --- SVG pictures ----------------------------------------------------------------------------------------------------------

def _path_data(path: list) -> str:
    return " ".join(command[0] + "".join(f" {_num(value)}" for value in command[1:]) for command in path)


def svg_of(obj: dict, box: dict) -> str:
    w, h = box["width"], box["height"]

    def head(pad: float) -> str:
        return f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="{_num(-pad)} {_num(-pad)} {_num(w + pad * 2)} {_num(h + pad * 2)}">'

    geometry = obj.get("geometry") or {}
    if obj.get("type") == "shape":
        sw = obj["strokeWidth"] if _is_number(obj.get("strokeWidth")) else 0
        fill = obj["fill"] if isinstance(obj.get("fill"), str) else "none"
        stroke = f' stroke="{_escape(obj["stroke"])}" stroke-width="{_num(sw)}"' if isinstance(obj.get("stroke"), str) else ""
        if obj.get("kind") == "circle":
            radius = obj["radius"] if obj.get("radius") is not None else min(w, h) / 2
            body = f'<circle cx="{_num(w / 2)}" cy="{_num(h / 2)}" r="{_num(radius)}" fill="{_escape(fill)}"{stroke}/>'
        else:
            corner = obj.get("cornerRadius") if obj.get("cornerRadius") is not None else 0
            corner_y = obj["cornerRadiusY"] if obj.get("cornerRadiusY") is not None else (obj["cornerRadius"] if obj.get("cornerRadius") is not None else 0)
            body = (
                f'<rect x="0" y="0" width="{_num(geometry["width"] if "width" in geometry else w)}" '
                f'height="{_num(geometry["height"] if "height" in geometry else h)}" rx="{_num(corner)}" ry="{_num(corner_y)}" fill="{_escape(fill)}"{stroke}/>'
            )
        return f"{head(sw / 2)}{body}</svg>"
    color = _escape(obj["color"] if obj.get("color") is not None else "#20201e")
    opacity = f' opacity="{_num(obj["alpha"])}"' if obj.get("alpha") is not None else ""
    if obj.get("kind") == "dot":
        radius = obj["radius"] if obj.get("radius") is not None else min(w, h) / 2
        return f'{head(0)}<circle cx="{_num(w / 2)}" cy="{_num(h / 2)}" r="{_num(radius)}" fill="{color}"{opacity}/></svg>'
    sw = obj["width"] if _is_number(obj.get("width")) else 2
    cap = f' stroke-linecap="{_escape(obj["cap"])}"' if isinstance(obj.get("cap"), str) else ' stroke-linecap="round"'
    join = f' stroke-linejoin="{_escape(obj["join"])}"' if isinstance(obj.get("join"), str) else ' stroke-linejoin="round"'
    path = obj["path"] if obj.get("path") is not None else []
    return f'{head(sw / 2)}<path d="{_escape(_path_data(path))}" fill="none" stroke="{color}" stroke-width="{_num(sw)}"{cap}{join}{opacity}/></svg>'


# --- document -> JSON Canvas -----------------------------------------------------------------------------------------------

class _Store:
    def __init__(self, media: Any):
        self.media = media

    def _call(self, name: str, *args: Any) -> Any:
        method = getattr(self.media, name, None) if self.media is not None else None
        return method(*args) if method else None

    def from_id(self, media_id: str) -> str:
        found = self._call("from_id", media_id)
        if found is not None:
            return found
        return media_id if "/" in str(media_id) else f"media/{media_id}"

    def put_text(self, text: str, ext: str) -> str:
        found = self._call("put_text", text, ext)
        if found is not None:
            return found
        return _svg_data_url(text) if ext == "svg" else text

    def put_data_url(self, url: str) -> str:
        found = self._call("put_data_url", url)
        return url if found is None else found


def _externalize(obj: dict, store: _Store) -> dict:
    copy_ = _clone(obj)

    def visit(item: dict) -> None:
        if item.get("type") == "image" and (item.get("mediaRef") or {}).get("kind") == "inline":
            path = store.put_data_url(item["mediaRef"]["dataUrl"])
            if isinstance(path, str) and not is_data_url(path) and path.startswith("media/"):
                item["mediaRef"] = {"kind": "media", "id": path[len("media/"):]}
        if item.get("type") == "group":
            for child in item["children"]:
                visit(child)

    visit(copy_)
    return copy_


_PN_SKIP = ("id", "z", "type", "content", "mediaRef", "children", "raw")


def _pn_of(obj: dict, extra: dict | None = None) -> dict:
    pn = {"type": obj["type"]}
    pn.update(extra or {})
    pn.update({key: _clone(value) for key, value in obj.items() if key not in _PN_SKIP})
    return pn


def _sides(source: dict, target: dict) -> tuple[str, str]:
    dx = target["x"] + target["width"] / 2 - (source["x"] + source["width"] / 2)
    dy = target["y"] + target["height"] / 2 - (source["y"] + source["height"] / 2)
    if abs(dx) >= abs(dy):
        return ("right", "left") if dx >= 0 else ("left", "right")
    return ("bottom", "top") if dy >= 0 else ("top", "bottom")


def to_json_canvas(doc: dict, media: Any = None, derived: str = "file") -> dict:
    store = _Store(media)
    objects = _ordered(doc.get("objects") or [])
    used = {obj.get("id") for obj in objects if isinstance(obj, dict) and isinstance(obj.get("id"), str) and obj["id"] != ""}
    counter = 0
    seen: set[str] = set()

    def fallback_id() -> str:
        nonlocal counter
        while True:
            candidate = f"node-{counter}"
            counter += 1
            if candidate not in used:
                used.add(candidate)
                return candidate

    nodes: list[dict] = []
    connectors: list[tuple] = []
    boxes: dict[str, dict] = {}
    for index, obj in enumerate(objects):
        object_id = obj.get("id")
        has_id = isinstance(object_id, str) and object_id != "" and object_id not in seen
        node_id = object_id if has_id else fallback_id()
        seen.add(node_id)
        if has_id:
            no_id: dict = {}
        elif "id" not in obj or object_id is None:
            no_id = {"noId": True}
        else:
            no_id = {"origId": object_id}
        if obj["type"] == "connector":
            connectors.append((obj, node_id, no_id, index))
            continue
        if obj["type"] == "unknown":
            box = _raw_box(obj.get("raw"))
            node = {"id": node_id, "type": "text", **box, "text": "", "pn": {"type": "unknown", **no_id, "raw": _clone(obj.get("raw"))}}
        else:
            box = native_box(obj)
            boxes[node_id] = box
            node = {"id": node_id, "type": "text", **box}
            pn = _pn_of(obj, no_id)
            kind = obj["type"]
            if kind == "text":
                node["text"] = obj["content"] if obj.get("content") is not None else ""
            elif kind == "sticky":
                node["text"] = obj["content"] if obj.get("content") is not None else ""
                hex_value = _hex_of(obj.get("color"))
                if hex_value:
                    node["color"] = hex_value
            elif kind == "image":
                node["type"] = "file"
                ref = obj["mediaRef"]
                node["file"] = store.from_id(ref["id"]) if ref["kind"] == "media" else store.put_data_url(ref["dataUrl"])
                if not isinstance(node["file"], str):
                    node["file"] = ref["dataUrl"]
            elif kind == "group":
                node["type"] = "group"
                pn["children"] = [_externalize(child, store) for child in obj["children"]]
            else:  # shape, ink
                node["type"] = "file"
                node["file"] = "" if derived == "omit" else store.put_text(svg_of(obj, box), "svg")
            node["pn"] = pn
        nodes.append(node)

    node_ids = {node["id"] for node in nodes}
    edges: list[dict] = []
    detached: list[dict] = []
    for obj, edge_id, no_id, index in connectors:
        from_id, to_id = obj.get("fromId"), obj.get("toId")
        z = obj["z"] if obj.get("z") is not None else index
        pn = {**_pn_of(obj, no_id), "z": z}
        pn.pop("fromId", None)
        pn.pop("toId", None)
        if from_id not in node_ids or to_id not in node_ids:
            entry = {**_clone(obj), "z": z}
            if not no_id.get("noId"):
                entry["id"] = obj.get("id")
            detached.append(entry)
            continue
        edge: dict = {"id": edge_id, "fromNode": from_id, "toNode": to_id}
        unit = {"x": 0, "y": 0, "width": 1, "height": 1}
        edge["fromSide"], edge["toSide"] = _sides(boxes.get(from_id, unit), boxes.get(to_id, unit))
        heads = obj.get("arrowheads") or DEFAULT_CONNECTOR["arrowheads"]
        if heads.get("start"):
            edge["fromEnd"] = "arrow"
        if not heads.get("end"):
            edge["toEnd"] = "none"
        hex_value = _hex_of(obj.get("color"))
        if hex_value:
            edge["color"] = hex_value
        edge["pn"] = pn
        edges.append(edge)
    edges.sort(key=lambda edge: edge["pn"]["z"])

    pn_top: dict = {"schemaVersion": SCHEMA_VERSION, "page": _clone(doc.get("page") or DEFAULT_PAGE), "grid": {"width": PAGE["width"], "height": PAGE["height"]}}
    if doc.get("extras"):
        pn_top["extras"] = _clone(doc["extras"])
    if detached:
        pn_top["detached"] = detached
    return {"nodes": nodes, "edges": edges, "pn": pn_top}


# --- JSON Canvas -> document -----------------------------------------------------------------------------------------------

def is_json_canvas(value: Any) -> bool:
    return _is_object(value) and not isinstance(value.get("objects"), list) and (isinstance(value.get("nodes"), list) or isinstance(value.get("edges"), list) or _is_object(value.get("pn")))


def _image_extension(path: Any) -> bool:
    name = re.split(r"[?#]", str(path))[0]
    return name.split(".")[-1].lower() in IMAGE_EXTENSIONS


def _media_ref_of(file: str) -> dict:
    if is_data_url(file):
        return {"kind": "inline", "dataUrl": file}
    return {"kind": "media", "id": file[len("media/"):] if file.startswith("media/") else file}


def _plain_geometry(node: dict) -> dict:
    return {"x": node["x"], "y": node["y"], "width": node["width"], "height": node["height"], "rotation": 0, "scaleX": 1, "scaleY": 1, "flipX": False, "flipY": False, "skewX": 0, "skewY": 0}


def _geometry_over(geometry: dict, node: dict, expected: dict) -> dict:
    if all(node[key] == expected[key] for key in ("x", "y", "width", "height")):
        return geometry
    return {**geometry, "x": node["x"], "y": node["y"], "width": node["width"], "height": node["height"]}


def _foreign_objects(node: dict) -> list[dict]:
    geometry = _plain_geometry(node)
    color = _preset_hex(node.get("color"))
    kind = node.get("type")
    if kind == "text":
        base = {"id": node["id"], "geometry": geometry, "content": str(node.get("text") if node.get("text") is not None else ""), "style": dict(FOREIGN_TEXT_STYLE), "extras": {}}
        if color:
            return [{**base, "type": "sticky", "color": color}]
        return [{**base, "type": "text", "mode": "box"}]
    if kind == "file" and _image_extension(node.get("file")):
        return [{"id": node["id"], "type": "image", "geometry": geometry, "mediaRef": _media_ref_of(node["file"]), "extras": {}}]
    if kind in ("file", "link"):
        content = f"[[{node['file']}{node.get('subpath') or ''}]]" if kind == "file" else f"[{node['url']}]({node['url']})"
        return [{"id": node["id"], "type": "text", "mode": "box", "geometry": geometry, "content": content, "style": dict(FOREIGN_TEXT_STYLE), "extras": {}}]
    frame = {
        "id": node["id"], "type": "shape", "kind": "rect", "geometry": geometry, "cornerRadius": 12, "cornerRadiusY": 12,
        "fill": "transparent", "stroke": color or "#8a8a85", "strokeWidth": 2, "extras": {"strokeDashArray": [8, 6]},
    }
    label = node.get("label")
    if not isinstance(label, str) or not label:
        return [frame]
    label_geometry = _plain_geometry({"x": node["x"] + 12, "y": node["y"] + 8, "width": max(1, node["width"] - 24), "height": 40})
    return [frame, {"id": f"{node['id']}-label", "type": "text", "mode": "box", "geometry": label_geometry, "content": label, "style": dict(FOREIGN_TEXT_STYLE), "extras": {}}]


_VALID_NODE_KINDS = {"text", "sticky", "shape", "ink", "image", "group"}


def _object_from_node(node: dict) -> list[dict]:
    pn = node["pn"] if _is_object(node.get("pn")) else None
    kind = pn.get("type") if pn else None
    if pn and kind == "unknown":
        obj: dict = {"type": "unknown", "raw": _clone(pn.get("raw"))}
        if pn.get("origId") is not None:
            obj["id"] = pn["origId"]
        elif not pn.get("noId"):
            obj["id"] = node["id"]
        return [obj]
    if not pn or kind not in _VALID_NODE_KINDS:
        return _foreign_objects(node)
    obj = {**_clone(pn), "id": node["id"]}
    for key in ("noId", "origId", "member"):
        obj.pop(key, None)
    if pn.get("noId"):
        obj.pop("id", None)
    elif "origId" in pn:
        obj["id"] = pn["origId"]
    obj["geometry"] = _geometry_over(obj.get("geometry") or _plain_geometry(node), node, native_box({**obj, "content": node.get("text"), "geometry": obj.get("geometry")}))
    if kind in ("text", "sticky"):
        obj["content"] = node["text"] if isinstance(node.get("text"), str) else ""
        if kind == "sticky":
            color = _color_from_native(node.get("color"), obj.get("color"))
            if color is not None:
                obj["color"] = color
    elif kind == "image":
        obj["mediaRef"] = _media_ref_of(node["file"]) if isinstance(node.get("file"), str) and node["file"] != "" else {"kind": "inline", "dataUrl": ""}
    elif kind == "group":
        obj["children"] = _clone(pn["children"]) if isinstance(pn.get("children"), list) else []
    if "extras" not in obj or not obj["extras"]:
        obj["extras"] = obj.get("extras") or {}
    return [obj]


def _connector_from_edge(edge: dict) -> dict:
    pn = edge["pn"] if _is_object(edge.get("pn")) and edge["pn"].get("type") == "connector" else None
    heads = {"start": edge.get("fromEnd") == "arrow", "end": edge.get("toEnd") != "none"}
    if not pn:
        color = _preset_hex(edge.get("color"))
        return {
            "id": edge["id"], "type": "connector",
            "geometry": {"x": 0, "y": 0, "width": 0, "height": 0, "rotation": 0, "scaleX": 1, "scaleY": 1, "flipX": False, "flipY": False, "skewX": 0, "skewY": 0},
            "fromId": edge["fromNode"], "toId": edge["toNode"], "color": color or DEFAULT_CONNECTOR["color"], "lineWidth": DEFAULT_CONNECTOR["lineWidth"],
            "reverseX": False, "reverseY": False, "arrowheads": heads, "extras": {},
        }
    obj = {**_clone(pn), "id": edge["id"], "fromId": edge["fromNode"], "toId": edge["toNode"]}
    for key in ("noId", "origId", "z"):
        obj.pop(key, None)
    if pn.get("noId"):
        obj.pop("id", None)
    elif "origId" in pn:
        obj["id"] = pn["origId"]
    color = _color_from_native(edge.get("color"), obj.get("color"))
    if color is not None:
        obj["color"] = color
    stored = pn.get("arrowheads") or DEFAULT_CONNECTOR["arrowheads"]
    if stored.get("start") != heads["start"] or stored.get("end") != heads["end"]:
        obj["arrowheads"] = heads
    if "extras" not in obj:
        obj["extras"] = {}
    return obj


def _foreign_frame(nodes: list[dict]) -> dict:
    if not nodes:
        return {"dx": 0, "dy": 0, "columns": 1, "rows": 1}
    min_x = min(n["x"] for n in nodes)
    min_y = min(n["y"] for n in nodes)
    dx = 72 - min_x if min_x < 0 else 0
    dy = 72 - min_y if min_y < 0 else 0
    max_x = max(n["x"] + n["width"] for n in nodes) + dx
    max_y = max(n["y"] + n["height"] for n in nodes) + dy
    return {"dx": dx, "dy": dy, "columns": max(1, math.ceil((max_x + 72) / PAGE["width"])), "rows": max(1, math.ceil((max_y + 72) / PAGE["height"]))}


def from_json_canvas(canvas: Any) -> dict:
    if not _is_object(canvas):
        raise DocumentError("A JSON Canvas must be an object")
    if canvas.get("nodes") is not None and not isinstance(canvas["nodes"], list):
        raise DocumentError("nodes must be an array")
    if canvas.get("edges") is not None and not isinstance(canvas["edges"], list):
        raise DocumentError("edges must be an array")
    pn_top = canvas["pn"] if _is_object(canvas.get("pn")) else None
    if pn_top and _is_number(pn_top.get("schemaVersion")) and pn_top["schemaVersion"] > SCHEMA_VERSION:
        raise DocumentError(f"This note was saved by a newer version (schemaVersion {pn_top['schemaVersion']})")
    nodes = [
        node for node in (canvas.get("nodes") or [])
        if _is_object(node) and isinstance(node.get("id"), str) and node.get("type") in ("text", "file", "link", "group")
        and all(_is_number(node.get(key)) for key in ("x", "y", "width", "height"))
    ]
    nodes = [node for node in nodes if not (_is_object(node.get("pn")) and node["pn"].get("member"))]
    edges = [
        edge for edge in (canvas.get("edges") or [])
        if _is_object(edge) and isinstance(edge.get("id"), str) and isinstance(edge.get("fromNode"), str) and isinstance(edge.get("toNode"), str)
    ]
    dx = dy = 0
    if pn_top and _is_object(pn_top.get("page")):
        page = _clone(pn_top["page"])
    else:
        found = _foreign_frame(nodes)
        dx, dy = found["dx"], found["dy"]
        page = {"columns": found["columns"], "rows": found["rows"]}
    if dx or dy:
        nodes = [{**node, "x": node["x"] + dx, "y": node["y"] + dy} for node in nodes]

    items: list[dict] = []
    for node in nodes:
        items.extend(_object_from_node(node))
    infinity = float("inf")
    pending = [
        (edge["pn"]["z"] if _is_object(edge.get("pn")) and _is_number(edge["pn"].get("z")) else infinity, _connector_from_edge(edge))
        for edge in edges
    ]
    for entry in (pn_top.get("detached") if pn_top and isinstance(pn_top.get("detached"), list) else []):
        if not _is_object(entry):
            continue
        detached = _clone(entry)
        z = detached.pop("z", None)
        pending.append((z if _is_number(z) else infinity, detached))
    pending.sort(key=lambda item: item[0])
    for z, obj in pending:
        position = min(int(z) if z != infinity else len(items), len(items))
        items.insert(position, obj)
    for index, obj in enumerate(items):
        obj["z"] = index
    extras = _clone(pn_top["extras"]) if pn_top and _is_object(pn_top.get("extras")) else {}
    return {"schemaVersion": SCHEMA_VERSION, "page": page, "objects": items, "extras": extras}


# --- spec check ------------------------------------------------------------------------------------------------------------

def _is_integer(value: Any) -> bool:
    return (isinstance(value, int) and not isinstance(value, bool)) or (isinstance(value, float) and value.is_integer())


def validate_json_canvas(canvas: Any) -> dict:
    """Checks a canvas against JSON Canvas 1.0 and lists every problem as {path, message}. `pn` and other extras are allowed."""
    errors: list[dict] = []

    def report(path: str, message: str) -> None:
        errors.append({"path": path, "message": message})

    if not _is_object(canvas):
        return {"ok": False, "errors": [{"path": "", "message": "a canvas must be an object"}]}
    for key in ("nodes", "edges"):
        if canvas.get(key) is not None and not isinstance(canvas[key], list):
            report(key, "must be an array")
    ids: set[str] = set()
    node_ids: set[str] = set()

    def color_ok(value: Any) -> bool:
        return isinstance(value, str) and bool(_PRESET.match(value) or _HEX6.match(value))

    for index, node in enumerate(canvas["nodes"] if isinstance(canvas.get("nodes"), list) else []):
        path = f"nodes[{index}]"
        if not _is_object(node):
            report(path, "must be an object")
            continue
        node_id = node.get("id")
        if not isinstance(node_id, str) or node_id == "":
            report(f"{path}.id", "missing id")
        elif node_id in ids:
            report(f"{path}.id", f"duplicate id {_json_string(node_id)}")
        else:
            ids.add(node_id)
            node_ids.add(node_id)
        if node.get("type") not in ("text", "file", "link", "group"):
            report(f"{path}.type", f"unknown node type {_json_value(node.get('type'))}")
        for key in ("x", "y", "width", "height"):
            if not _is_integer(node.get(key)):
                report(f"{path}.{key}", "must be an integer")
        if node.get("color") is not None and not color_ok(node["color"]):
            report(f"{path}.color", 'must be a hex colour or a preset "1" to "6"')
        if node.get("type") == "text" and not isinstance(node.get("text"), str):
            report(f"{path}.text", "text nodes need a text string")
        if node.get("type") == "file":
            if not isinstance(node.get("file"), str) or node["file"] == "":
                report(f"{path}.file", "file nodes need a path")
            if node.get("subpath") is not None and not (isinstance(node["subpath"], str) and node["subpath"].startswith("#")):
                report(f"{path}.subpath", "must start with #")
        if node.get("type") == "link" and not isinstance(node.get("url"), str):
            report(f"{path}.url", "link nodes need a url")
        if node.get("type") == "group":
            if node.get("label") is not None and not isinstance(node["label"], str):
                report(f"{path}.label", "must be a string")
            if node.get("backgroundStyle") is not None and node["backgroundStyle"] not in ("cover", "ratio", "repeat"):
                report(f"{path}.backgroundStyle", "must be cover, ratio or repeat")
    for index, edge in enumerate(canvas["edges"] if isinstance(canvas.get("edges"), list) else []):
        path = f"edges[{index}]"
        if not _is_object(edge):
            report(path, "must be an object")
            continue
        edge_id = edge.get("id")
        if not isinstance(edge_id, str) or edge_id == "":
            report(f"{path}.id", "missing id")
        elif edge_id in ids:
            report(f"{path}.id", f"duplicate id {_json_string(edge_id)}")
        else:
            ids.add(edge_id)
        for key in ("fromNode", "toNode"):
            if not isinstance(edge.get(key), str):
                report(f"{path}.{key}", "missing")
            elif edge[key] not in node_ids:
                report(f"{path}.{key}", f"refers to unknown node {_json_string(edge[key])}")
        for key in ("fromSide", "toSide"):
            if edge.get(key) is not None and edge[key] not in SIDES:
                report(f"{path}.{key}", "must be top, right, bottom or left")
        for key in ("fromEnd", "toEnd"):
            if edge.get(key) is not None and edge[key] not in ("none", "arrow"):
                report(f"{path}.{key}", "must be none or arrow")
        if edge.get("color") is not None and not color_ok(edge["color"]):
            report(f"{path}.color", 'must be a hex colour or a preset "1" to "6"')
        if edge.get("label") is not None and not isinstance(edge["label"], str):
            report(f"{path}.label", "must be a string")
    return {"ok": not errors, "errors": errors}


def _json_string(value: str) -> str:
    import json
    return json.dumps(value, ensure_ascii=False)


def _json_value(value: Any) -> str:
    import json
    return "undefined" if value is None else json.dumps(value, ensure_ascii=False)
