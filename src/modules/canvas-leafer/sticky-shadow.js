// The sticky note's drop shadow, baked once per size into an image (F-024 §2: a live blurred shadow on every sticky is the largest
// single cost of a whole-desk pan). Same look as the Fabric sticky: black at 26%, blur 16, 9 px down, under a paper rounded
// 4 / 4 / 24 / 4. Browser only (it draws on a canvas); the cache keeps one image per distinct size.
import { pixelRatioFor, readPerf } from './perf.js'
export const STICKY_CORNERS = [4, 4, 24, 4]
const MARGIN = 44
const BLUR = 16
const OFFSET_Y = 9
const FAR = 4000
const cache = new Map()

// The same shadow as a live blur (the cost F-024 measured; only used to measure it: perf.bakedShadow = false).
export const liveStickyShadow = () => ({ x: 0, y: OFFSET_Y, blur: BLUR, color: 'rgba(0, 0, 0, .26)' })

export function bakedStickyShadow(width, height) {
  const w = Math.max(1, Math.round(width))
  const h = Math.max(1, Math.round(height))
  const key = `${w}x${h}`
  let entry = cache.get(key)
  if (entry) return entry
  const ratio = pixelRatioFor(globalThis.devicePixelRatio, readPerf())
  const canvas = document.createElement('canvas')
  canvas.width = Math.ceil((w + MARGIN * 2) * ratio)
  canvas.height = Math.ceil((h + MARGIN * 2) * ratio)
  const ctx = canvas.getContext('2d')
  ctx.scale(ratio, ratio)
  // Canvas shadows ignore the transform, so blur and offset are in device pixels. Draw the paper far off to the left and let only
  // its shadow (offset back by the same distance) land on the image: the shadow alone, no paper.
  ctx.shadowColor = 'rgba(0, 0, 0, .26)'
  ctx.shadowBlur = BLUR * ratio
  ctx.shadowOffsetX = FAR * ratio
  ctx.shadowOffsetY = OFFSET_Y * ratio
  ctx.fillStyle = '#000'
  ctx.beginPath()
  ctx.roundRect(MARGIN - FAR, MARGIN, w, h, STICKY_CORNERS)
  ctx.fill()
  entry = { url: canvas.toDataURL('image/png'), margin: MARGIN, width: w + MARGIN * 2, height: h + MARGIN * 2 }
  cache.set(key, entry)
  return entry
}
