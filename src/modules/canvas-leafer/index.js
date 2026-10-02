// Entry for the Leafer canvas (F-027, F-028): a stored note -> document model -> Leafer nodes, and the edits made there. main.js imports
// it statically; Leafer is the canvas (ADR 0001), so there is no flag and no separate chunk.
import { fromFabric } from '../../core/document/index.js'
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
    // A note as the app stores it today (Fabric JSON + page state) -> document model -> Leafer nodes.
    showNote(content, pageState, loadOptions) {
      const doc = ensureIds(fromFabric(content ?? { objects: [] }, pageState))
      scene.load(doc, loadOptions)
      return doc
    },
  }
}
