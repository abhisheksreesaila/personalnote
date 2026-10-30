// The graphite pencil strike (F-107): pure geometry. A line is a list of points; the outline wobbles a little and its width follows an uneven
// pressure, as a pencil does. Everything is a function of the points and a seed, so a struck label looks the same every time it is drawn.
export const seedOf = (text) => [...String(text)].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) % 1000, 7)

export function strikePoints(x0, x1, y, step = 6) {
  const count = Math.max(2, Math.ceil((x1 - x0) / step))
  return Array.from({ length: count + 1 }, (_, i) => ({ x: x0 + ((x1 - x0) * i) / count, y }))
}

export function pencilOutline(points, seed = 0) {
  const last = points.length - 1
  const centre = points.map((point, i) => ({ x: point.x, y: point.y + 0.9 * Math.sin(i * 0.7 + seed * 2) + 0.55 * Math.sin(i * 1.9 + seed) }))
  const widths = points.map((_, i) => (1.3 + 1.7 * (0.5 + 0.5 * Math.sin(i * 0.31 + seed))) * Math.min(1, 0.45 + Math.min(i, last - i) / 3)) // light at both ends
  const outline = new Array(2 * points.length)
  centre.forEach((point, i) => {
    const before = centre[Math.max(0, i - 1)]
    const after = centre[Math.min(last, i + 1)]
    const length = Math.hypot(after.x - before.x, after.y - before.y) || 1
    const nx = (-(after.y - before.y) / length) * widths[i] / 2
    const ny = ((after.x - before.x) / length) * widths[i] / 2
    outline[i] = { x: point.x + nx, y: point.y + ny }
    outline[2 * points.length - 1 - i] = { x: point.x - nx, y: point.y - ny }
  })
  return { outline, widths }
}

export function pencilPath(points, seed = 0) {
  if (points.length < 2) return ''
  const fmt = (point) => `${Math.round(point.x * 10) / 10} ${Math.round(point.y * 10) / 10}`
  return `M ${pencilOutline(points, seed).outline.map(fmt).join(' L ')} Z`
}

// How much of the label's line the stroke has crossed, 0 to 1.
export function strikeProgress(points, row) {
  const xs = points.map((point) => point.x)
  return Math.min(1, (Math.max(...xs) - Math.min(...xs)) / Math.max(1, row.x1 - row.x0))
}

// A settle spring from 0 to 1 over t in [0, 1]: a small overshoot, then rest.
export const settle = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : 1 - Math.exp(-7 * t) * Math.cos(11 * t))
