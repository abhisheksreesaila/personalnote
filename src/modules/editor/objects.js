// Pure helpers for the dock's Sticky note and Image tools. No DOM here so the rules (palette, defaults, image sizing) are easy to test.

export const IMAGE_MAX_SIDE = 1400
export const IMAGE_MAX_DATA_URL = 300 * 1024
export const PALETTE_SIZE = 5
export const STICKY_FONT = 'Caveat'
export const STICKY_WIDTH = 240
export const STICKY_PADDING = 22
export const STICKY_MIN_HEIGHT = 200
const FALLBACK_COLORS = ['#ffd60a', '#30d158', '#64b5ff', '#bf5af2', '#ff6b3d']
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

function channels(hex) {
  const value = hex.replace('#', '')
  return [0, 2, 4].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16))
}

function luminance(hex) {
  const [r, g, b] = channels(hex).map((channel) => {
    const v = channel / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export function contrastRatio(first, second) {
  const [a, b] = [luminance(first), luminance(second)].sort((x, y) => y - x)
  return (a + 0.05) / (b + 0.05)
}

// A deep shade of the note's own colour, like the mockup's k1-k5 text tones.
export function stickyInk(fill) {
  return `#${channels(fill).map((channel) => Math.round(channel * 0.16).toString(16).padStart(2, '0')).join('')}`
}

// `read` returns a CSS custom property value, e.g. (name) => styles.getPropertyValue(name).
export function objectPalette(read) {
  return Array.from({ length: PALETTE_SIZE }, (_, index) => {
    const value = String(read(`--sk-c${index + 1}`) || '').trim().toLowerCase()
    const fill = /^#[0-9a-f]{6}$/.test(value) ? value : FALLBACK_COLORS[index]
    return { fill, ink: stickyInk(fill) }
  })
}

export function stickyDefaults({ fill, ink }) {
  return {
    width: STICKY_WIDTH,
    fontFamily: STICKY_FONT,
    fontSize: 34,
    fontWeight: 500,
    lineHeight: 1.05,
    fill: ink,
    stickyColor: fill,
  }
}

export function fitImage({ width, height }, maxSide = IMAGE_MAX_SIDE) {
  const longest = Math.max(width, height)
  if (longest <= maxSide) return { width, height }
  const ratio = maxSide / longest
  return { width: Math.round(width * ratio), height: Math.round(height * ratio) }
}

export function imageFiles(files) {
  return Array.from(files || []).filter((file) => IMAGE_TYPES.has(file.type))
}
