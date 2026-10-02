"""Plain-text projections of notes for local agents (read-only, lossy)."""

from __future__ import annotations

from document_model import DocumentError, from_fabric, plain_text
from json_canvas import from_json_canvas, is_json_canvas


def _number(value) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def canvas_plain_text(document: dict, page_state: dict | None = None) -> str:
    """The Markdown projection of a canvas: text blocks by the top edge of their box, then the left edge, blank-line separated.

    Reads either stored format (JSON Canvas or old Fabric JSON); both go through the document model so the order is the same.
    """
    if not isinstance(document, dict):
        return ""
    try:
        doc = from_json_canvas(document) if is_json_canvas(document) else from_fabric(document, page_state)
    except DocumentError:
        return ""
    return plain_text(doc)


def mindmap_outline(document: dict) -> str:
    nodes = document.get("nodes", []) if isinstance(document, dict) else []
    if not isinstance(nodes, list):
        return ""
    by_id: dict[str, dict] = {}
    by_parent: dict[str | None, list[dict]] = {}
    for node in nodes:
        if not isinstance(node, dict) or not node.get("id"):
            continue
        by_id[str(node["id"])] = node
        parent = node.get("parentId")
        by_parent.setdefault(None if parent is None else str(parent), []).append(node)
    root_id = str(document.get("rootId") or "")
    roots = [by_id[root_id]] if root_id in by_id else by_parent.get(None, [])
    lines: list[str] = []
    visited: set[str] = set()

    def visit(node: dict, depth: int) -> None:
        node_id = str(node["id"])
        if node_id in visited:
            return
        visited.add(node_id)
        lines.append(f"{'  ' * depth}- {str(node.get('text') or 'Untitled idea').strip()}")
        for child in sorted(by_parent.get(node_id, []), key=lambda n: (_number(n.get("y")), str(n["id"]))):
            visit(child, depth + 1)

    for root in roots:
        visit(root, 0)
    for node in by_id.values():
        visit(node, 0)
    return "\n".join(lines)


def note_plain_text(note: dict) -> str:
    """Return the readable text of a serialized note."""
    content = note.get("content") or {}
    if note.get("noteType") == "mindmap":
        return mindmap_outline(content)
    return canvas_plain_text(content, note.get("pageState"))
