// Show on "Claude edited this note" (F-096): where the view goes to bring what an agent changed on screen. Pure maths, no DOM.
const SIZE_FALLBACK = { width: 240, height: 64 } // a text the engine has not measured yet

/** The boxes (page coordinates) of the objects with these ids, in the order the note holds them. */
export function changedBoxes(objects, ids) {
  const wanted = new Set(ids)
  return objects
    .filter((object) => object && wanted.has(object.id) && object.geometry)
    .map(({ geometry: g }) => ({ x: g.x ?? 0, y: g.y ?? 0, width: (g.width ?? SIZE_FALLBACK.width) * Math.abs(g.scaleX ?? 1), height: (g.height ?? SIZE_FALLBACK.height) * Math.abs(g.scaleY ?? 1) }))
}

/**
 * The view ({x, y, scale}) that puts the union of `boxes` in the middle of the window: at the zoom it is at now, zoomed in to 100% (`base`) when
 * it is further out than that (so the words can be read), and zoomed out only as far as it takes to fit with room around it.
 */
export function viewForBoxes(boxes, { width, height, scale, base, top = 72, bottom = 88 }) {
  const left = Math.min(...boxes.map((b) => b.x))
  const right = Math.max(...boxes.map((b) => b.x + b.width))
  const above = Math.min(...boxes.map((b) => b.y))
  const below = Math.max(...boxes.map((b) => b.y + b.height))
  const room = { w: width * 0.84, h: Math.max(80, height - top - bottom) }
  const fit = Math.min(room.w / (right - left), room.h / (below - above))
  const next = Math.max(base * 0.25, Math.min(Math.max(scale, base), fit))
  return { scale: next, x: width / 2 - ((left + right) / 2) * next, y: top + room.h / 2 - ((above + below) / 2) * next }
}

/** A page box as it sits in the window now: the canvas's own offset plus the view. */
export const onScreen = (box, origin, view) => ({ left: origin.left + view.x + box.x * view.scale, top: origin.top + view.y + box.y * view.scale, width: box.width * view.scale, height: box.height * view.scale })
