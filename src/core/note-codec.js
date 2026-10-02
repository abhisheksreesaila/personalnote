// The browser end of the stored note format (F-026). The server stores and serves JSON Canvas (ADR 0002); the editor reads it straight
// into the document model and writes the model straight back (pictures from the media library fetched from /api/media and shown as data
// URLs; a picture that came from the library is saved as its path, not sent again).
// A note the server could not convert yet (contentFormat 'fabric', the old canvas engine's JSON) is read through the legacy reader and
// its next save converts it.
// Named files, not the index: the browser ships the reader and writer, not the SVG pictures, foreign-canvas reading, validator or
// projection (jsoncanvas-extras.js), which only the server side and the tests need.
import { fromFabric } from './document/legacy-fabric.js'
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
// each library picture in it (a data URL; a placeholder when it cannot be fetched). This is how the editor opens a note.
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

// A document model (what the editor holds) -> JSON Canvas for the server. SVG pictures of ink and shapes are left out (the server derives them).
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

  // The kept JSON of one object's node (written now when it is not kept yet), and of one connector's edge.
  function nodeOf(doc, object) {
    let json = nodes.get(object)
    if (json === undefined) {
      written += 1
      json = JSON.stringify(writeJsonCanvas({ ...doc, objects: [object] }, options).nodes[0])
      nodes.set(object, json)
    }
    return json
  }

  function edgeOf(doc, object, from, to, at) {
    let entry = edges.get(object)
    if (!entry || entry.from !== from || entry.to !== to || entry.rank !== at) {
      written += 1
      const edge = writeJsonCanvas({ ...doc, objects: [{ ...from, z: 0 }, { ...to, z: 1 }, { ...object, z: 2 }].filter((item, index, all) => all.findIndex((other) => other.id === item.id) === index) }, options).edges[0]
      edge.pn.z = at
      entry = { from, to, rank: at, json: JSON.stringify(edge) }
      edges.set(object, entry)
    }
    return entry.json
  }

  // The objects by id, or null for a document the encoder cannot vouch for (an object without a unique id).
  function byIdOf(list) {
    const byId = new Map()
    for (const object of list) {
      if (!object || typeof object.id !== 'string' || object.id === '' || byId.has(object.id)) return null
      byId.set(object.id, object)
    }
    return byId
  }

  const joinable = (byId, object) => {
    const from = byId.get(object.fromId)
    const to = byId.get(object.toId)
    return from && to && from.type !== 'connector' && to.type !== 'connector' ? { from, to } : null
  }

  return {
    stats: () => ({ written }),
    // Writes the JSON of the objects not kept yet, for at most `budgetMs`, so the first save of a note that was just opened (it would write
    // every object: 150 ms on 5,000) finds them ready. Meant for idle time; returns true when nothing is left to write.
    warm(doc, budgetMs = 6, clock = () => performance.now()) {
      const deadline = clock() + budgetMs
      const list = stacking(doc)
      const byId = byIdOf(list)
      if (!byId) return true
      for (let at = 0; at < list.length; at += 1) {
        const object = list[at]
        const before = written
        if (object.type === 'connector') {
          const ends = joinable(byId, object)
          if (ends) edgeOf(doc, object, ends.from, ends.to, at)
        } else nodeOf(doc, object)
        if (written !== before && clock() > deadline) return false // only an object that had to be written counts against the slice
      }
      return true
    },
    encode(doc) {
      const list = stacking(doc)
      const byId = byIdOf(list)
      if (!byId) return fallback(compactStacking(doc))
      const nodeJson = []
      const edgeJson = []
      for (let at = 0; at < list.length; at += 1) {
        const object = list[at]
        if (object.type === 'connector') {
          const ends = joinable(byId, object)
          if (!ends) return fallback(compactStacking(doc))
          edgeJson.push(edgeOf(doc, object, ends.from, ends.to, at))
        } else nodeJson.push(nodeOf(doc, object))
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
