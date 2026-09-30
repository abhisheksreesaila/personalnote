"""Plain-text projections of notes for local agents (read-only, lossy)."""

from __future__ import annotations


def _number(value) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def canvas_plain_text(document: dict) -> str:
    """Canvas text blocks ordered top to bottom, then left to right, like the Markdown export."""
    objects = document.get("objects", []) if isinstance(document, dict) else []
    if not isinstance(objects, list):
        return ""
    blocks = sorted(
        (item for item in objects if isinstance(item, dict)),
        key=lambda item: (_number(item.get("top")), _number(item.get("left"))),
    )
    return "\n\n".join(
        item["text"].strip()
        for item in blocks
        if isinstance(item.get("text"), str) and item["text"].strip()
    )


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
    return canvas_plain_text(content)
