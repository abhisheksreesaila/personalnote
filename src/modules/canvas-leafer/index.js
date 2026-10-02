// Entry for the Leafer canvas (F-027): a stored note -> document model -> Leafer nodes. main.js imports it statically; Leafer is the
// canvas (ADR 0001), so there is no flag and no separate chunk.
import { fromFabric } from '../../core/document/index.js'
import { createScene } from './scene.js'

export function createLeaferCanvas(options) {
  const scene = createScene(options)
  return {
    ...scene,
    // A note as the app stores it today (Fabric JSON + page state) -> document model -> Leafer nodes.
    showNote(content, pageState, loadOptions) {
      const doc = fromFabric(content ?? { objects: [] }, pageState)
      scene.load(doc, loadOptions)
      return doc
    },
  }
}
