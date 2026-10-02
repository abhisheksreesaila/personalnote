// Pictures on the Leafer canvas (F-033, F-023): a dropped, pasted or picked file is shrunk off the main thread, uploaded once to the media
// library (content-addressed files; the note keeps `media/<sha256>.<ext>` and nothing else), and placed the way the Fabric path placed
// it. The rules (what is stored as it came, what is re-encoded, how big a new picture is) are pure and tested in Node; the decode and
// encode use createImageBitmap and OffscreenCanvas, so a 12-megapixel photo never blocks a frame. No Leafer import: scene.js draws.
import { fitImage, IMAGE_MAX_DATA_URL, IMAGE_MAX_SIDE, imageFiles } from '../editor/objects.js'

export const MEDIA_PLACE_SIDE = 520 // a new picture is at most this big on its long side (page pixels)
const OFFSET = 28 // each further picture of one drop is placed this far down and right
const UPRIGHT = { rotation: 0, flipX: false, flipY: false, skewX: 0, skewY: 0 }
const CAN_HAVE_ALPHA = new Set(['image/png', 'image/webp', 'image/gif'])

export const MAX_MEGAPIXELS = 100 // a picture bigger than this is refused before it is decoded (it would need hundreds of MB of memory)
export const pictureFiles = imageFiles

// How a picture is stored. Small pictures in a kept format go in as they came; the rest are shrunk to 1400 on the long side and
// re-encoded (a GIF is frozen to one frame, as the Fabric path did).
export function imageStorage({ width, height, bytes, type }) {
  const target = fitImage({ width, height }, IMAGE_MAX_SIDE)
  const resized = target.width !== width || target.height !== height
  if (width * height > MAX_MEGAPIXELS * 1_000_000) return { keep: false, target, tooBig: true }
  return { keep: !resized && bytes <= IMAGE_MAX_DATA_URL && type !== 'image/gif', target }
}

// Transparency stays lossless as PNG (WebP is not written by every web view: WebKit falls back to PNG on its own, so asking for it
// would hand the library a file whose type we did not choose); an opaque picture becomes a JPEG on white, as before.
export function storedEncoding({ hasAlpha }) {
  return hasAlpha ? { type: 'image/png' } : { type: 'image/jpeg', quality: 0.85 }
}

// A new picture of stored size width x height, centred on `point`, at most 520 on the long side and never enlarged. Same geometry the
// Fabric path wrote (natural size, scaled about the box's centre, so x and y are the corner of the UNSCALED box), so the note opens the same in both. `index` offsets the 2nd, 3rd ... picture of one drop.
export function newImage({ id, z, mediaId, width, height, point, index = 0 }) {
  const shown = fitImage({ width, height }, MEDIA_PLACE_SIDE)
  const scale = shown.width / width
  return {
    id,
    type: 'image',
    z,
    mediaRef: { kind: 'media', id: mediaId },
    geometry: { x: point.x + index * OFFSET - width / 2, y: point.y + index * OFFSET - height / 2, width, height, scaleX: scale, scaleY: scale, ...UPRIGHT },
  }
}

// The pixel size from a picture's first bytes (PNG, JPEG, GIF, WebP), or null when it cannot be told.
export function readImageSize(b) {
  const u16 = (i) => (b[i] << 8) | b[i + 1]
  const u32 = (i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50) return { width: u32(16), height: u32(20) }
  if (b.length > 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return { width: b[6] | (b[7] << 8), height: b[8] | (b[9] << 8) }
  if (b.length > 30 && b[0] === 0x52 && b[8] === 0x57 && b[9] === 0x45) {
    const kind = String.fromCharCode(b[12], b[13], b[14], b[15])
    if (kind === 'VP8X') return { width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) }
    if (kind === 'VP8 ') return { width: (b[26] | (b[27] << 8)) & 0x3fff, height: (b[28] | (b[29] << 8)) & 0x3fff }
    if (kind === 'VP8L') { const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24); return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) } }
    return null
  }
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i += 1; continue }
      const marker = b[i + 1]
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xff) { i += marker === 0xff ? 1 : 2; continue }
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { width: u16(i + 7), height: u16(i + 5) }
      i += 2 + u16(i + 2)
    }
  }
  return null
}

// ---- browser side

async function decode(file) {
  if (typeof createImageBitmap === 'function') return createImageBitmap(file)
  const url = URL.createObjectURL(file)
  try {
    const image = new Image()
    image.src = url
    await image.decode()
    return image
  } finally { URL.revokeObjectURL(url) }
}

function scratch(width, height) {
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(width, height)
  const element = document.createElement('canvas')
  element.width = width
  element.height = height
  return element
}

const encode = (surface, { type, quality }) => (surface.convertToBlob ? surface.convertToBlob({ type, quality }) : new Promise((resolve) => surface.toBlob(resolve, type, quality)))

const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1
const ALPHA_MASK = LITTLE_ENDIAN ? 0xff000000 : 0x000000ff // the alpha byte's place in a pixel word

function hasTransparency(context, width, height) {
  const { data } = context.getImageData(0, 0, width, height)
  const pixels = new Uint32Array(data.buffer)
  for (let index = 0; index < pixels.length; index += 1) if (((pixels[index] & ALPHA_MASK) >>> 0) !== ALPHA_MASK) return true
  return false
}

// A picture file -> { blob, width, height }: what is uploaded, and its stored size. Decoded and drawn off the main thread where the web
// view can (createImageBitmap, OffscreenCanvas); the only work on the main thread is a scan for transparent pixels in PNG/WebP/GIF.
export async function prepareImage(file) {
  const header = readImageSize(new Uint8Array(await file.slice(0, 1 << 20).arrayBuffer()))
  if (header && imageStorage({ width: header.width, height: header.height, bytes: file.size, type: file.type }).tooBig) throw new Error(`That picture is too large (over ${MAX_MEGAPIXELS} megapixels)`)
  let bitmap
  try { bitmap = await decode(file) } catch { throw new Error('Could not read that picture') }
  try {
    const plan = imageStorage({ width: bitmap.width, height: bitmap.height, bytes: file.size, type: file.type })
    if (plan.keep) return { blob: file, width: bitmap.width, height: bitmap.height }
    const { width, height } = plan.target
    const surface = scratch(width, height)
    const context = surface.getContext('2d', { willReadFrequently: CAN_HAVE_ALPHA.has(file.type) })
    context.imageSmoothingQuality = 'high'
    context.drawImage(bitmap, 0, 0, width, height)
    const alpha = CAN_HAVE_ALPHA.has(file.type) && hasTransparency(context, width, height)
    if (!alpha) {
      context.globalCompositeOperation = 'destination-over'
      context.fillStyle = '#ffffff'
      context.fillRect(0, 0, width, height)
    }
    let encoding = storedEncoding({ hasAlpha: alpha })
    let blob = await encode(surface, encoding)
    if (!blob || blob.type !== encoding.type) { // a web view that cannot write the type hands back another: PNG it is
      encoding = { type: 'image/png' }
      blob = await encode(surface, encoding)
    }
    return { blob, width, height }
  } finally { bitmap.close?.() }
}

// Uploads picture bytes to the media library: -> the stored name `<sha256>.<ext>` (the same bytes are the same file).
export async function uploadPicture(blob, fetchImpl = fetch) {
  const response = await fetchImpl('/api/media', { method: 'POST', headers: { 'Content-Type': blob.type || 'application/octet-stream', 'x-personal-note': '1' }, body: blob })
  if (!response.ok) {
    let message = 'Could not store that picture'
    try { message = (await response.json()).error || message } catch { /* keep the general message */ }
    throw new Error(message)
  }
  return (await response.json()).id
}
