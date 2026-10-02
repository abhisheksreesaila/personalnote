// Small pure rules that turn Fabric-era style conventions into Leafer's. No Leafer import.

// Fabric lays text out with a line pitch of fontSize * 1.13 * lineHeight, and puts the first baseline at
// fontSize * 1.13 * (1 - 0.222) below the box top (_fontSizeMult and _fontSizeFraction in fabric's text classes).
const FABRIC_FONT_SIZE_MULT = 1.13
const FABRIC_FONT_SIZE_FRACTION = 0.222
// Leafer puts a row's baseline at (rowHeight + 0.7 * fontSize) / 2 below the row top (Text.__baseLine).
const LEAFER_ASCENT = 0.7

// `pitch` is the Leafer lineHeight (px) that gives Fabric's line spacing; `firstBaselineShift` moves the Leafer text node so its
// first baseline lands where Fabric's does (negative moves it up).
export function fabricLineMetrics(fontSize, lineHeightMultiplier) {
  const pitch = fontSize * FABRIC_FONT_SIZE_MULT * lineHeightMultiplier
  const fabricBaseline = fontSize * FABRIC_FONT_SIZE_MULT * (1 - FABRIC_FONT_SIZE_FRACTION)
  const leaferBaseline = (pitch + LEAFER_ASCENT * fontSize) / 2
  return { pitch, firstBaselineShift: fabricBaseline - leaferBaseline }
}

// The highlighter's colour is stored as #rrggbb plus a separate alpha in the model; Leafer wants one colour.
export function withAlpha(color, alpha) {
  if (alpha === undefined || typeof color !== 'string') return color
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color)
  if (!match) return color
  const [r, g, b] = match.slice(1).map((part) => Number.parseInt(part, 16))
  return `rgba(${r}, ${g}, ${b}, ${Math.round(alpha * 1000) / 1000})`
}

// Fabric quotes a font family for the canvas unless it is a list, already quoted, or a generic name. An unquoted "Source Serif 4"
// is not a valid canvas font (a bare 4), so without this the context silently keeps its previous font.
const GENERIC_FONTS = ['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'math', 'emoji', 'fangsong']
export function canvasFamily(family) {
  if (family.includes("'") || family.includes('"') || family.includes(',') || GENERIC_FONTS.includes(family.toLowerCase())) return family
  return `"${family}"`
}
