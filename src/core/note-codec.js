// The browser end of the stored note format (F-026). The server stores and serves JSON Canvas; until the Leafer editor reads the
// document model directly, the Fabric editor on main still needs Fabric JSON. So:
//   load: JSON Canvas -> document model -> Fabric JSON (pictures fetched from /api/media and handed to Fabric as data URLs)
//   save: Fabric JSON -> document model -> JSON Canvas (a picture that came from the media library is sent as its path, not again)
// A note the server could not convert yet (contentFormat 'fabric') loads as it is, and its next save converts it.
// Named files, not the index: the browser ships the reader and writer, not the SVG pictures, foreign-canvas reading, validator or
// projection (jsoncanvas-extras.js), which only the server side and the tests need.
import { fromFabric, toFabricUnchecked } from './document/fabric.js'
import { isJsonCanvas, readJsonCanvas, writeJsonCanvas } from './document/jsoncanvas.js'
import { compactStacking, stacking } from './document/operations.js'
import { DEFAULT_PAGE, PAGE, SCHEMA_VERSION } from './document/schema.js'

const dataUrlByName = new Map() // media file name -> data URL, so a note's pictures are fetched once
const pathByDataUrl = new Map() // data URL -> 'media/<name>', so an unchanged picture is saved as a reference
const PLACEHOLDER = (name) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><!-- ${name} --><rect width="120" height="80" fill="#ddd"/></svg>`)}`

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

// note: { content, contentFormat, pageState } as the API returns it. -> { doc, resolveMedia }: the document model, and how to show
// each library picture in it (a data URL; a placeholder when it cannot be fetched). This is how the Leafer editor opens a note.
export async function decodeNoteDocument(note, { fetchMedia = defaultFetchMedia } = {}) {
  const content = note.content || { objects: [] }
  if (!isJsonCanvas(content)) return { doc: fromFabric(content, note.pageState || { columns: 1, rows: 1 }), resolveMedia: undefined }
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
  // A picture that could not be fetched shows a placeholder unique to it, which remembers the original reference, so a save
  // (opening a note can trigger one) writes `media/<name>` back instead of the placeholder. Not cached: the next open retries.
  const resolveMedia = (ref) => {
    const url = dataUrlByName.get(ref.id)
    if (url) return url
    const placeholder = PLACEHOLDER(ref.id)
    pathByDataUrl.set(placeholder, `media/${ref.id}`)
    return placeholder
  }
  return { doc, resolveMedia }
}

// The same, as Fabric JSON for the Fabric editor on main: -> { content: Fabric JSON, pageState }
export async function decodeNote(note, { fetchMedia = defaultFetchMedia } = {}) {
  const content = note.content || { objects: [] }
  if (!isJsonCanvas(content)) return { content, pageState: note.pageState || { columns: 1, rows: 1 } }
  const { doc, resolveMedia } = await decodeNoteDocument(note, { fetchMedia })
  return { content: toFabricUnchecked(doc, { resolveMedia }), pageState: doc.page }
}

// Fabric JSON + page state -> JSON Canvas for the server. SVG pictures of ink and shapes are left out (the server derives them).
export function encodeNote(fabricContent, pageState) {
  const doc = fromFabric(fabricContent, pageState)
  return writeJsonCanvas(doc, { derived: 'omit', media: { putDataUrl: (url) => pathByDataUrl.get(url) ?? url } })
}

// A document model (what the Leafer editor holds) -> JSON Canvas, the same way encodeNote writes it, without the Fabric detour.
export function encodeDocument(doc) {
  return writeJsonCanvas(doc, { derived: 'omit', media: { putDataUrl: (url) => pathByDataUrl.get(url) ?? url } })
}

// A document model -> the JSON text of its JSON Canvas, made so that saving costs what changed. Objects are immutable values, so the
// JSON of each node is kept per object (and of each edge per connector, its two ends and its place in the stack); an edit writes the
// objects it replaced and the connectors that touch them, and the text is joined from the kept pieces. The bytes are exactly those of
// JSON.stringify(encodeDocument(compactStacking(doc))). A document it cannot vouch for (an object without a unique id, a connector
// whose end is missing) is written by the plain writer.
export function createDocumentEncoder() {
  const nodes = new WeakMap() // object -> JSON of its node
  const edges = new WeakMap() // connector -> { from, to, rank, json }
  let written = 0
  const options = { derived: 'omit', media: { putDataUrl: (url) => pathByDataUrl.get(url) ?? url } }

  function fallback(doc) {
    written += doc.objects.length
    return JSON.stringify(writeJsonCanvas(doc, options))
  }

  return {
    stats: () => ({ written }),
    encode(doc) {
      const list = stacking(doc)
      const byId = new Map()
      for (const object of list) {
        if (!object || typeof object.id !== 'string' || object.id === '' || byId.has(object.id)) return fallback(compactStacking(doc))
        byId.set(object.id, object)
      }
      const rank = new Map(list.map((object, index) => [object.id, index]))
      const nodeJson = []
      const edgeJson = []
      for (const object of list) {
        if (object.type === 'connector') {
          const from = byId.get(object.fromId)
          const to = byId.get(object.toId)
          if (!from || !to || from.type === 'connector' || to.type === 'connector') return fallback(compactStacking(doc))
          const at = rank.get(object.id)
          let entry = edges.get(object)
          if (!entry || entry.from !== from || entry.to !== to || entry.rank !== at) {
            written += 1
            const edge = writeJsonCanvas({ ...doc, objects: [{ ...from, z: 0 }, { ...to, z: 1 }, { ...object, z: 2 }].filter((item, index, all) => all.findIndex((other) => other.id === item.id) === index) }, options).edges[0]
            edge.pn.z = at
            entry = { from, to, rank: at, json: JSON.stringify(edge) }
            edges.set(object, entry)
          }
          edgeJson.push(entry.json)
        } else {
          let json = nodes.get(object)
          if (json === undefined) {
            written += 1
            json = JSON.stringify(writeJsonCanvas({ ...doc, objects: [object] }, options).nodes[0])
            nodes.set(object, json)
          }
          nodeJson.push(json)
        }
      }
      const pn = { schemaVersion: SCHEMA_VERSION, page: doc.page ?? DEFAULT_PAGE, grid: { width: PAGE.width, height: PAGE.height } }
      if (doc.extras && Object.keys(doc.extras).length) pn.extras = doc.extras
      return `{"nodes":[${nodeJson.join(',')}],"edges":[${edgeJson.join(',')}],"pn":${JSON.stringify(pn)}}`
    },
  }
}

// Test support.
export function forgetMedia() {
  dataUrlByName.clear()
  pathByDataUrl.clear()
}
