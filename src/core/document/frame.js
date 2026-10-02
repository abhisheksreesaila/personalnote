// The page frame (F-032): its origin is the top-left corner of the first page, so pages added or folded on the top or left move every
// object by whole pages. These are the pure moves; the undo history applies one as a frame operation (core/document/history.js), to whatever
// objects exist when it is undone or redone, and the Leafer canvas's page rules (canvas-leafer/pages.js) decide how far.

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value)

// The object moved by whole distances in the page frame. A group's children are in the group's own frame, so they stay. An object the model
// does not know has no geometry; its raw Fabric left and top move, so it stays where it was on the page.
export function shiftedObject(object, dx, dy) {
  if (!object || (!dx && !dy)) return object
  if (object.type === 'unknown') {
    const raw = object.raw
    if (!raw || typeof raw !== 'object' || !isNumber(raw.left) || !isNumber(raw.top)) return object
    return { ...object, raw: { ...raw, left: raw.left + dx, top: raw.top + dy } }
  }
  if (!object.geometry) return object
  return { ...object, geometry: { ...object.geometry, x: (object.geometry.x ?? 0) + dx, y: (object.geometry.y ?? 0) + dy } }
}

export function shiftedDocument(doc, dx, dy) {
  if (!dx && !dy) return doc
  return { ...doc, objects: doc.objects.map((object) => shiftedObject(object, dx, dy)) }
}
