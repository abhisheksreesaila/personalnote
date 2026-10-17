"""F-096: what an agent's write changed, and how to take it back without taking the person's later edits with it.

Pure functions, no database. `services.py::NoteService` stores each agent write as a before and an after snapshot and asks these two
questions: what did it change (so the app can show it), and can it be turned back over what is stored now (a three-way merge: the
agent's version is the base, what is stored now is the person's, the version to go back to is the target). When the person changed the
same thing since, the answer is "no" (None), never a guess.
"""
from page_note import utf16

CONTEXT = 24  # characters of surrounding text that pin down where a short change sits


def _plain(item: dict) -> dict:
    """An object without its stacking (a renumber is not a change) and without an empty `extras`."""
    return {key: value for key, value in item.items() if key != "z" and not (key == "extras" and not value)}


def _by_id(document: dict) -> dict:
    return {item["id"]: item for item in document["objects"] if isinstance(item, dict) and item.get("id") is not None}


def changed_object_ids(before: dict, after: dict, limit: int = 50) -> list[str]:
    """Ids of the objects the write added or rewrote, in the order they stand in the note."""
    was = _by_id(before)
    return [
        item["id"]
        for item in after["objects"]
        if isinstance(item, dict) and item.get("id") is not None and (item["id"] not in was or _plain(was[item["id"]]) != _plain(item))
    ][:limit]


def _trim(before: str, after: str) -> tuple[int, int]:
    """How much text both share at the start and at the end (never overlapping)."""
    limit = min(len(before), len(after))
    prefix = 0
    while prefix < limit and before[prefix] == after[prefix]:
        prefix += 1
    suffix = 0
    while suffix < limit - prefix and before[len(before) - 1 - suffix] == after[len(after) - 1 - suffix]:
        suffix += 1
    return prefix, suffix


def changed_lines(before: str, after: str) -> dict:
    """The lines of `after` the write touched, as UTF-16 offsets {from, to} (what the page editor counts in)."""
    prefix, suffix = _trim(before, after)
    end = len(after) - suffix
    start = after.rfind("\n", 0, prefix) + 1
    stop = after.find("\n", end)
    stop = len(after) if stop == -1 else stop
    return {"from": utf16(after[:start]), "to": utf16(after[:stop])}


def merge_markdown(base: str, ours: str, target: str) -> str | None:
    """`target` laid over `ours`, or None when the person changed the very words that differ between `base` and `target`."""
    if ours == base:
        return target
    prefix, suffix = _trim(base, target)
    old = base[prefix:len(base) - suffix]
    new = target[prefix:len(target) - suffix]
    before_context = base[max(0, prefix - CONTEXT):prefix]
    after_context = base[len(base) - suffix:len(base) - suffix + CONTEXT]
    if old and ours.count(old) == 1:
        at = ours.find(old)
    else:  # empty, or said more than once: the words around it say which one
        wanted = before_context + old + after_context
        if ours.count(wanted) != 1:
            return None
        at = ours.find(wanted) + len(before_context)
    return ours[:at] + new + ours[at + len(old):]


def merge_canvas(base: dict, ours: dict, target: dict) -> dict | None:
    """The objects of `target` laid over `ours`, object by object; None when the person changed an object the agent's write also touched."""
    was, now, going = _by_id(base), _by_id(ours), _by_id(target)
    same = lambda a, b: _plain(a) == _plain(b)
    objects, restored = [], []
    for id in dict.fromkeys([*was, *now, *going]):
        b, c, t = was.get(id), now.get(id), going.get(id)
        if c is None:
            if t is not None and b is None:
                restored.append(t)  # the agent had removed it: it comes back
            elif t is not None and not same(t, b):
                return None  # the person removed what the agent rewrote
            continue
        if b is None:
            if t is not None and not same(c, t):
                return None
            objects.append(c)
        elif same(c, b):
            if t is not None:
                objects.append(t if not same(t, b) else c)
        elif t is None or not (same(t, b) or same(c, t)):
            return None  # the person changed it, and the way back changes it too
        else:
            objects.append(c)
    # (objects the person made carry no id the agent knew: they were never in base, target or ours-by-id above, so keep them in their place)
    kept = [item for item in ours["objects"] if not (isinstance(item, dict) and item.get("id") is not None)]
    page = target["page"] if ours.get("page") == base.get("page") else ours["page"]
    order = {id: index for index, id in enumerate(now)}
    objects.sort(key=lambda item: order.get(item.get("id"), len(order)))
    return {**ours, "objects": [*objects, *restored, *kept], "page": page}

