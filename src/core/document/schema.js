// The engine-independent document model (F-025). Plain data only: JSON in, JSON out, no Fabric, no DOM.
//
// A document:
//   { schemaVersion, page: { columns, rows, ...unknown }, objects: [DocObject], extras: { ...top-level Fabric keys } }
//
// A DocObject always has `type` and `z` (stacking order, 0 = back). Every other field is optional ("sparse"): a field is
// present only when the stored note had it, so converting back never invents data. The documented defaults below are what a
// reader should assume for an absent field; they are not written into the document.
//
//   id        the object's stable id (= the note's `semanticId`). Unique among top-level objects; connectors point at it.
//   geometry  { x, y, width, height, rotation, scaleX, scaleY, originX, originY }. x and y are the position of the origin
//             point in page pixels (Fabric `left`/`top`), rotation is degrees. A page is PAGE.width x PAGE.height.
//   opacity   0..1, default 1
//   extras    properties the model has no typed field for, kept verbatim so nothing is lost (Fabric defaults such as
//             fillRule or skewX, per-character text styles, future fields). Engines other than Fabric ignore them.
//
// Types and their own fields:
//   text       mode 'point' | 'box', content, style { fontFamily, fontSize, fontWeight, fontStyle, lineHeight, textAlign,
//              underline, overline, linethrough, charSpacing, padding, color }
//   sticky     content, style (as text), color (the paper colour, raw), colorKey (derived: 'c1'..'c5' when the colour is in a skin palette)
//   shape      kind 'rect' | 'circle'; rect: cornerRadius, cornerRadiusY; circle: radius; fill, fillKey (derived), stroke, strokeWidth
//   ink        kind 'stroke' | 'dot', tool ('pen' | 'highlight'), color (#rrggbb as stored), alpha (0..1, set when the stored
//              colour carries an alpha byte: the highlighter), blend; stroke: points [{x, y}] (a later `p` pressure value per point
//              is reserved), path (the drawn path commands), width, cap, join; dot: radius. `smoothing` is reserved for the
//              next engine; nothing stores it yet.
//   image      mediaRef { kind: 'inline', dataUrl } now, { kind: 'media', id } once the media library exists (F-023)
//   connector  fromId, toId, color, lineWidth, reverseX, reverseY, arrowheads { start, end } (the app draws one head, at the end)
//   group      children [DocObject]
//   unknown    raw: the original value, verbatim (an object type this model does not know, or something that is not an object)

export const SCHEMA_VERSION = 1

export const PAGE = Object.freeze({ width: 860, height: 1080 })

export const OBJECT_TYPES = Object.freeze(['text', 'sticky', 'shape', 'ink', 'image', 'connector', 'group', 'unknown'])
export const SHAPE_KINDS = Object.freeze(['rect', 'circle'])
export const INK_KINDS = Object.freeze(['stroke', 'dot'])
export const TEXT_MODES = Object.freeze(['point', 'box'])
export const MEDIA_KINDS = Object.freeze(['inline', 'media'])

export const DEFAULT_PAGE = Object.freeze({ columns: 1, rows: 1 })

export const DEFAULTS = Object.freeze({
  geometry: Object.freeze({ rotation: 0, scaleX: 1, scaleY: 1, originX: 'left', originY: 'top' }),
  opacity: 1,
  connector: Object.freeze({ lineWidth: 2.6, color: '#20201e', reverseX: false, reverseY: false, arrowheads: Object.freeze({ start: false, end: true }) }),
})

export class DocumentError extends Error {
  constructor(message, errors = []) {
    super(message)
    this.name = 'DocumentError'
    this.errors = errors
  }
}

export function emptyDocument() {
  return { schemaVersion: SCHEMA_VERSION, page: { ...DEFAULT_PAGE }, objects: [], extras: {} }
}
