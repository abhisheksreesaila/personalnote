// The browser end of the stored note format (F-026). The server stores and serves JSON Canvas; until the Leafer editor reads the
// document model directly, the Fabric editor on main still needs Fabric JSON. So:
//   load: JSON Canvas -> document model -> Fabric JSON (pictures fetched from /api/media and handed to Fabric as data URLs)
//   save: Fabric JSON -> document model -> JSON Canvas (a picture that came from the media library is sent as its path, not again)
// A note the server could not convert yet (contentFormat 'fabric') loads as it is, and its next save converts it.
// Named files, not the index: the browser ships the reader and writer, not the SVG pictures, foreign-canvas reading, validator or
// projection (jsoncanvas-extras.js), which only the server side and the tests need.
import { fromFabric, toFabricUnchecked } from './document/fabric.js'
import { isJsonCanvas, readJsonCanvas, writeJsonCanvas } from './document/jsoncanvas.js'

const dataUrlByName = new Map() // media file name -> data URL, so a note's pictures are fetched once
const pathByDataUrl = new Map() // data URL -> 'media/<name>', so an unchanged picture is saved as a reference
const PLACEHOLDER = 'data:image/svg+xml;charset=utf-8,%3Csvg xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22 width%3D%22120%22 height%3D%2280%22%3E%3Crect width%3D%22120%22 height%3D%2280%22 fill%3D%22%23ddd%22%2F%3E%3C%2Fsvg%3E'

async function defaultFetchMedia(name) {
  const response = await fetch(`/api/media/${name}`)
  if (!response.ok) throw new Error(`media ${name}: ${response.status}`)
  const blob = await response.blob()
  return await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

function mediaNames(objects, out = new Set()) {
  for (const object of objects) {
    if (object.type === 'image' && object.mediaRef?.kind === 'media') out.add(object.mediaRef.id)
    if (object.type === 'group') mediaNames(object.children, out)
  }
  return out
}

// note: { content, contentFormat, pageState } as the API returns it. -> { content: Fabric JSON, pageState }
export async function decodeNote(note, { fetchMedia = defaultFetchMedia } = {}) {
  const content = note.content || { objects: [] }
  if (!isJsonCanvas(content)) return { content, pageState: note.pageState || { columns: 1, rows: 1 } }
  // The server canonicalizes every canvas it stores, so every node carries `pn`. One that does not (a file edited by hand behind
  // the server's back) is refused here rather than silently dropped by the lean reader.
  if ((content.nodes || []).some((node) => !node?.pn) || (content.edges || []).some((edge) => !edge?.pn)) throw new Error('This note was not written by Personal Note; import it instead')
  const doc = readJsonCanvas(content)
  await Promise.all([...mediaNames(doc.objects)].filter((name) => !dataUrlByName.has(name)).map(async (name) => {
    try {
      const url = await fetchMedia(name)
      dataUrlByName.set(name, url)
      pathByDataUrl.set(url, `media/${name}`)
    } catch (error) {
      console.error(error)
    }
  }))
  return { content: toFabricUnchecked(doc, { resolveMedia: (ref) => dataUrlByName.get(ref.id) ?? PLACEHOLDER }), pageState: doc.page }
}

// Fabric JSON + page state -> JSON Canvas for the server. SVG pictures of ink and shapes are left out (the server derives them).
export function encodeNote(fabricContent, pageState) {
  const doc = fromFabric(fabricContent, pageState)
  return writeJsonCanvas(doc, { derived: 'omit', media: { putDataUrl: (url) => pathByDataUrl.get(url) ?? url } })
}

// Test support.
export function forgetMedia() {
  dataUrlByName.clear()
  pathByDataUrl.clear()
}
