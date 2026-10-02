// Entry for the Leafer canvas (F-027, F-028): a stored note -> document model -> Leafer nodes, and the edits made there. main.js imports
// it statically; Leafer is the canvas (ADR 0001), so there is no flag and no separate chunk.
import { createScene } from './scene.js'

// Every top-level object needs an id for an edit to name it (a note saved before ids existed has none); the Fabric path gives them
// out the same way when it saves.
function ensureIds(doc) {
  for (const object of doc.objects) if (object.type !== 'unknown' && !object.id) object.id = `res_${globalThis.crypto.randomUUID().replaceAll('-', '')}`
  return doc
}

export function createLeaferCanvas(options) {
  const scene = createScene(options)
  return {
    ...scene,
    // A document model (read from the stored note) -> Leafer nodes. `loadOptions.resolveMedia` shows library pictures.
    // The arrows are brought in line with the objects they join, as the Fabric path does on every load (a note an older app or an agent
    // saved with a stale arrow); the document returned is the one on screen.
    showDocument(doc, loadOptions) {
      scene.load(ensureIds(doc), loadOptions)
      const fixed = scene.followConnectors(doc)
      if (fixed === doc) return doc
      scene.load(fixed)
      return fixed
    },
  }
}
