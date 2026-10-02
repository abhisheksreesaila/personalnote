// A three-way merge of the document model (F-029): `base` is the document as last loaded or last saved (what both sides started
// from), `local` what the user has now, `remote` what an agent (or another window) saved. Pure JS, no engine.
//
// Per object, by id:
//   changed only by the agent      -> the agent's version (a rewrite, or its deletion)
//   changed only by the user       -> the user's version (a deletion by the user stays deleted)
//   changed by both                -> field by field (and inside geometry and style): a field only one side changed takes that
//                                     side's value; a field both changed takes the user's. An object the user changed beats an
//                                     agent's deletion.
//   added by the agent             -> appended on top; added by the user -> kept
// A stacking renumber alone (a JSON Canvas round trip) and an empty `extras` are not changes. The user's stacking is kept.
// Untouched objects keep their identity (the same reference), so the history and the scene see no change in them.
import { deepEqual } from './history.js'

const plain = (object) => { const { z, extras, ...rest } = object; return extras && Object.keys(extras).length ? { ...rest, extras } : rest }
const same = (a, b) => a === b || Boolean(a && b && deepEqual(plain(a), plain(b)))
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const NESTED = new Set(['geometry', 'style'])

function mergeFields(base, local, remote, nested) {
  const out = { ...remote }
  for (const key of new Set([...Object.keys(base ?? {}), ...Object.keys(local), ...Object.keys(remote)])) {
    if (key === 'z') continue
    const b = base?.[key]
    const l = local[key]
    const r = remote[key]
    let value
    if (deepEqual(l, b)) value = r // the user did not touch this field
    else if (nested && NESTED.has(key) && isObject(l) && isObject(r) && isObject(b)) value = mergeFields(b, l, r, false)
    else value = l
    if (value === undefined) delete out[key]
    else out[key] = value
  }
  if (local.z !== undefined) out.z = local.z
  return out
}

const idsOf = (document) => new Map(document.objects.filter((object) => object && object.id !== undefined).map((object) => [object.id, object]))

// -> { doc, added: [ids the agent appended], changed: [ids whose object differs from `local`] }
export function mergeDocuments({ base, local, remote }) {
  const inBase = idsOf(base)
  const inRemote = idsOf(remote)
  const inLocal = idsOf(local)
  const objects = []
  const changed = []
  for (const object of local.objects) {
    const id = object?.id
    if (id === undefined) { objects.push(object); continue }
    const was = inBase.get(id)
    const now = inRemote.get(id)
    let result = object
    if (!was) { // made by the user (or by both)
      if (now && !same(object, now)) result = mergeFields({}, object, now, true)
    } else if (same(object, was)) { // untouched by the user
      if (!now) result = null // the agent deleted it
      else if (!same(now, was)) result = { ...now, z: object.z }
    } else if (now && !same(now, was)) result = mergeFields(was, object, now, true) // both changed it
    if (result === null) { changed.push(id); continue }
    if (result !== object) changed.push(id)
    objects.push(result)
  }
  let top = local.objects.reduce((most, object, index) => Math.max(most, (object?.z ?? index) + 1), 0)
  const added = []
  for (const [id, object] of inRemote) {
    if (inLocal.has(id) || inBase.has(id)) continue // known: handled above, or deleted by the user
    objects.push({ ...object, z: top++ })
    added.push(id)
    changed.push(id)
  }
  // no connector is left pointing at something that is gone
  const present = new Set(objects.map((object) => object?.id))
  const kept = objects.filter((object) => {
    if (object?.type !== 'connector' || (present.has(object.fromId) && present.has(object.toId))) return true
    changed.push(object.id)
    return false
  })
  const page = deepEqual(local.page, base.page) ? remote.page : local.page
  const unchanged = !changed.length && deepEqual(page, local.page)
  return { doc: unchanged ? local : { ...local, objects: kept, page: deepEqual(page, local.page) ? local.page : page }, added, changed }
}
