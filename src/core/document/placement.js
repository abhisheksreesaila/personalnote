// Test support: the documented placement formula, written out with no Fabric and no matrix library, so the docs can be checked
// against what Fabric does. For a box with centre c: p' = c + Rotate(rotation) * Scale(flip) * SkewX * SkewY * (p - c), where
// Scale is diag(scaleX, scaleY) negated on an axis when flipped, SkewX = [[1, tan(skewX)], [0, 1]], SkewY = [[1, 0], [tan(skewY), 1]]
// (so SkewY acts first), and rotation is clockwise degrees with y pointing down. Not imported by the app.
const toRadians = (degrees) => degrees * (Math.PI / 180)
const corners = (x, y, width, height) => [[x, y], [x + width, y], [x + width, y + height], [x, y + height]]

function transformer(g) {
  const width = g.width ?? 0
  const height = g.height ?? 0
  const cx = (g.x ?? 0) + width / 2
  const cy = (g.y ?? 0) + height / 2
  const sx = (g.flipX ? -1 : 1) * (g.scaleX ?? 1)
  const sy = (g.flipY ? -1 : 1) * (g.scaleY ?? 1)
  const tanX = Math.tan(toRadians(g.skewX ?? 0))
  const tanY = Math.tan(toRadians(g.skewY ?? 0))
  const cos = Math.cos(toRadians(g.rotation ?? 0))
  const sin = Math.sin(toRadians(g.rotation ?? 0))
  return ({ x, y }) => {
    let px = x - cx
    let py = y - cy
    py += tanY * px // SkewY first
    px += tanX * py // then SkewX
    px *= sx // then scale and flip
    py *= sy
    return { x: cx + px * cos - py * sin, y: cy + px * sin + py * cos } // then rotate
  }
}

const pairs = (path) => path.flatMap((command) => { const out = []; for (let i = 1; i + 1 < command.length; i += 2) out.push({ x: command[i], y: command[i + 1] }); return out })

// Page positions of every modelled object's box corners and ink points, from the model alone. Same order as oracle.fabricPoints.
export function placedPoints(objects, toPage = (point) => point, out = []) {
  for (const object of objects) {
    if (object.type === 'unknown') continue
    const g = object.geometry ?? {}
    const place = transformer(g)
    const emit = (point) => { const moved = toPage(place(point)); out.push(moved.x, moved.y) }
    corners(g.x ?? 0, g.y ?? 0, g.width ?? 0, g.height ?? 0).forEach(([x, y]) => emit({ x, y }))
    if (object.type === 'ink' && object.kind === 'stroke') {
      for (const point of [...pairs(object.path), ...(object.points ?? [])]) emit({ x: (g.x ?? 0) + point.x, y: (g.y ?? 0) + point.y })
    }
    if (object.type === 'group') {
      const children = [...object.children].sort((a, b) => (a.z ?? 0) - (b.z ?? 0))
      placedPoints(children, (point) => toPage(place({ x: (g.x ?? 0) + point.x, y: (g.y ?? 0) + point.y })), out)
    }
  }
  return out
}
