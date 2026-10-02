import { INK_KINDS, MEDIA_KINDS, OBJECT_TYPES, SCHEMA_VERSION, SHAPE_KINDS, TEXT_MODES } from './schema.js'

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
const isNumber = (value) => typeof value === 'number' && Number.isFinite(value)
const isText = (value) => typeof value === 'string'

// Checks a document and lists every problem as { path, message }. `requireIds` (default on) wants every top-level object to
// have a unique, non-empty id; notes saved before ids were enforced fail that check but still convert. `strict: false`
// keeps only the structural checks (what is needed to convert the document back), which is what toFabric uses.
export function validateDocument(doc, { requireIds = true, strict = true } = {}) {
  const errors = []
  const report = (path, message, structural = false) => { if (strict || structural) errors.push({ path, message }) }

  if (!isObject(doc)) {
    errors.push({ path: '', message: 'a document must be an object' })
    return { ok: false, errors }
  }
  if (doc.schemaVersion !== SCHEMA_VERSION) report('schemaVersion', `unsupported schemaVersion ${JSON.stringify(doc.schemaVersion)} (this build reads ${SCHEMA_VERSION})`, true)
  if (!isObject(doc.page)) report('page', 'must be an object', true)
  else for (const key of ['columns', 'rows']) {
    if (!Number.isInteger(doc.page[key]) || doc.page[key] < 1) report(`page.${key}`, 'must be a whole number of at least 1')
  }
  if (!Array.isArray(doc.objects)) {
    errors.push({ path: 'objects', message: 'must be an array' })
    return { ok: false, errors }
  }

  const ids = new Map()
  const zs = new Map()
  doc.objects.forEach((object, index) => {
    const path = `objects[${index}]`
    checkObject(object, path, report)
    if (!isObject(object)) return
    if (requireIds && strict) {
      if (object.id === undefined) report(`${path}.id`, 'missing id')
      else if (object.id === '') report(`${path}.id`, 'empty id')
      else if (isText(object.id)) {
        if (ids.has(object.id)) report(`${path}.id`, `duplicate id ${JSON.stringify(object.id)} (also used by objects[${ids.get(object.id)}])`)
        else ids.set(object.id, index)
      }
    }
    if (object.z !== undefined) {
      if (zs.has(object.z)) report(`${path}.z`, `duplicate z (also used by objects[${zs.get(object.z)}])`)
      else zs.set(object.z, index)
    }
  })
  return { ok: errors.length === 0, errors }
}

function checkObject(object, path, report) {
  if (!isObject(object)) { report(path, 'must be an object', true); return }
  if (!OBJECT_TYPES.includes(object.type)) { report(`${path}.type`, `unknown object type ${JSON.stringify(object.type)}`, true); return }
  if (object.z !== undefined && !isNumber(object.z)) report(`${path}.z`, 'must be a finite number')
  if (object.id !== undefined && !isText(object.id)) report(`${path}.id`, 'must be a string')
  if (object.opacity !== undefined && !(isNumber(object.opacity) && object.opacity >= 0 && object.opacity <= 1)) report(`${path}.opacity`, 'must be a number from 0 to 1')
  if (object.geometry !== undefined) {
    if (!isObject(object.geometry)) report(`${path}.geometry`, 'must be an object')
    else {
      for (const key of ['x', 'y', 'width', 'height', 'rotation', 'scaleX', 'scaleY']) {
        if (object.geometry[key] !== undefined && !isNumber(object.geometry[key])) report(`${path}.geometry.${key}`, 'must be a finite number')
      }
      for (const key of ['originX', 'originY']) {
        if (object.geometry[key] !== undefined && !isText(object.geometry[key])) report(`${path}.geometry.${key}`, 'must be a string')
      }
    }
  }
  if (object.extras !== undefined && !isObject(object.extras)) report(`${path}.extras`, 'must be an object')

  switch (object.type) {
    case 'text':
      if (!TEXT_MODES.includes(object.mode)) report(`${path}.mode`, `must be ${TEXT_MODES.join(' or ')}`, true)
      if (!isText(object.content)) report(`${path}.content`, 'must be a string')
      break
    case 'sticky':
      if (!isText(object.content)) report(`${path}.content`, 'must be a string')
      if (!isText(object.color)) report(`${path}.color`, 'sticky needs a colour')
      break
    case 'shape':
      if (!SHAPE_KINDS.includes(object.kind)) report(`${path}.kind`, `must be one of ${SHAPE_KINDS.join(', ')}`, true)
      break
    case 'ink':
      if (!INK_KINDS.includes(object.kind)) report(`${path}.kind`, `must be one of ${INK_KINDS.join(', ')}`, true)
      if (object.alpha !== undefined && !(isNumber(object.alpha) && object.alpha >= 0 && object.alpha <= 1)) report(`${path}.alpha`, 'must be a number from 0 to 1')
      if (object.points !== undefined) {
        if (!Array.isArray(object.points)) report(`${path}.points`, 'must be an array')
        else object.points.forEach((point, index) => {
          for (const key of ['x', 'y']) {
            if (!isObject(point) || !isNumber(point[key])) report(`${path}.points[${index}].${key}`, 'must be a finite number')
          }
        })
      }
      break
    case 'image':
      if (!isObject(object.mediaRef) || !MEDIA_KINDS.includes(object.mediaRef.kind)) report(`${path}.mediaRef.kind`, `must be ${MEDIA_KINDS.join(' or ')}`, true)
      else if (object.mediaRef.kind === 'inline' && !isText(object.mediaRef.dataUrl)) report(`${path}.mediaRef.dataUrl`, 'inline pictures need a dataUrl', true)
      else if (object.mediaRef.kind === 'media' && !isText(object.mediaRef.id)) report(`${path}.mediaRef.id`, 'library pictures need an id', true)
      break
    case 'connector':
      for (const key of ['fromId', 'toId']) {
        if (!isText(object[key]) || object[key] === '') report(`${path}.${key}`, `connector needs a ${key}`)
      }
      break
    case 'group':
      if (!Array.isArray(object.children)) report(`${path}.children`, 'must be an array', true)
      else object.children.forEach((child, index) => checkObject(child, `${path}.children[${index}]`, report))
      break
    case 'unknown':
      if (object.raw === undefined) report(`${path}.raw`, 'unknown objects must keep their raw value', true)
      break
    default:
  }
}
