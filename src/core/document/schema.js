// The engine-independent document model (F-025). Plain data only: JSON in, JSON out, no Fabric, no DOM.
//
// A document:
//   { schemaVersion, page: { columns, rows, ...unknown }, objects: [DocObject], extras: { ...top-level Fabric keys } }
//
// A DocObject always has `type`, `z` (stacking order, 0 = back) and, except for `unknown`, `geometry`. Everything else is optional
// ("sparse"): a field is present only when the stored note had it, so converting back never invents data. The defaults below are
// what a reader assumes for an absent field; they are not written into the document.
//
// Coordinate frames (the engine-neutral part; legacy-fabric.js owns every Fabric convention):
//   page frame    x right, y down, in page pixels, origin at the top-left of the first page. A page is PAGE.width x PAGE.height;
//                 the note is `page.columns` x `page.rows` pages.
//   geometry      { x, y, width, height, rotation, scaleX, scaleY, flipX, flipY, skewX, skewY }
//                 The box is `width` x `height` with its top-left corner at (x, y) in the parent frame, before any transform. It does
//                 not include the stroke. With centre c = (x + width/2, y + height/2), a point p of the box is placed at
//                   p' = c + Rotate(rotation) * Scale * SkewX * SkewY * (p - c)
//                 where Scale = diag(+-scaleX, +-scaleY) (negative on a flipped axis), SkewX = [[1, tan(skewX)], [0, 1]],
//                 SkewY = [[1, 0], [tan(skewY), 1]] with the skews in degrees, and Rotate turns clockwise by `rotation` degrees
//                 (y points down). Matrices apply right to left, so SkewY acts first, then SkewX, then scale and flip, then
//                 rotation. There are no origins. Every modelled object has all of x, y, rotation, scale*, flip*, skew*. width and
//                 height are absent only when the saved note had no size for a text block (an agent-written Textbox: the engine
//                 measures it) and then count as 0; for such a block rotation, scale and skew are only meaningful once the engine
//                 has measured the height, so an adapter must measure the text first and place it from the measured box.
//   parent frame  the page frame for top-level objects; for a group's children, the group's own box frame: (0, 0) is the group
//                 box's top-left corner, before the group's own transform.
//   ink frame     an ink stroke's `path` commands and `points` are in the object's box frame: relative to the box's top-left corner
//                 (the path's own bounding box), unscaled. A point p is drawn at centre + M * (p - (width/2, height/2)). Nothing
//                 depends on Fabric's pathOffset or on where the path was first drawn.
//
// Every object:
//   id        the object's stable id (= the note's `semanticId`). Unique among top-level objects; connectors point at it.
//   geometry  as above.
//   opacity   0..1, default 1.   visible   default true.
//   shadow    { color, blur, x, y, extras? } or absent; x and y are the offset in page pixels.
//   strokeUniform  true when the stroke width ignores scale (default false).
//   extras    properties the model has no typed field for, kept verbatim so nothing is lost: Fabric defaults such as fillRule or
//             paintFirst, `strokeWidth` on text and groups, and per-character text `styles` (no feature uses those yet; if one does
//             they become typed runs, and until then they ride along here). Engines other than Fabric ignore extras.
//
// Types and their own fields:
//   text       mode 'point' | 'box', content, style { fontFamily, fontSize, fontWeight, fontStyle, lineHeight, textAlign,
//              underline, overline, linethrough, charSpacing, padding, color }
//   sticky     content, style (as text), color (the paper colour, raw), colorKey (derived: 'c1'..'c5' when the colour is in a skin palette)
//   shape      kind 'rect' | 'circle'; rect: cornerRadius, cornerRadiusY; circle: radius; fill, fillKey (derived), stroke, strokeWidth
//   ink        kind 'stroke' | 'dot', tool ('pen' | 'highlight'), color (#rrggbb as stored), alpha (0..1, set when the stored
//              colour carries an alpha byte: the highlighter), blend; stroke: points [{x, y}] (a later `p` pressure value per point
//              is reserved), path (absolute M, L, Q, C, Z commands), width (the stroke width), cap, join; dot: radius. `smoothing` is
//              reserved for the next engine; nothing stores it yet. A stroke's geometry width/height are its path's bounding box.
//   image      mediaRef { kind: 'inline', dataUrl } now, { kind: 'media', id } once the media library exists (F-023)
//   connector  fromId, toId, color, lineWidth, reverseX, reverseY, arrowheads { start, end } (the app draws one head, at the end)
//   group      children [DocObject], in the group's box frame
//   unknown    raw: the original value, verbatim: an object type this model does not know, an object whose placement fields are
//              malformed, an ink path with commands other than absolute M/L/Q/C/Z, or something that is not an object. Unknown
//              objects have no geometry; a group's unknown children stay in Fabric's group-centred frame.

export const SCHEMA_VERSION = 1

export const PAGE = Object.freeze({ width: 860, height: 1080 })

export const OBJECT_TYPES = Object.freeze(['text', 'sticky', 'shape', 'ink', 'image', 'connector', 'group', 'unknown'])
export const SHAPE_KINDS = Object.freeze(['rect', 'circle'])
export const INK_KINDS = Object.freeze(['stroke', 'dot'])
export const TEXT_MODES = Object.freeze(['point', 'box'])
export const MEDIA_KINDS = Object.freeze(['inline', 'media'])

export const DEFAULT_PAGE = Object.freeze({ columns: 1, rows: 1 })

export const DEFAULTS = Object.freeze({
  geometry: Object.freeze({ rotation: 0, scaleX: 1, scaleY: 1, flipX: false, flipY: false, skewX: 0, skewY: 0 }),
  opacity: 1,
  visible: true,
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
