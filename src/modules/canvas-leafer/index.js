// Lazy entry for the Leafer canvas (F-027). main.js imports this only when the engine switch is on, so Leafer and the document
// model it reads land in their own chunk and the default Fabric path pays nothing at startup.
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
