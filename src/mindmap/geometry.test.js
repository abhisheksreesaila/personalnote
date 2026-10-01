import assert from 'node:assert/strict'
import test from 'node:test'

import { branchGeometry, cubicAt, ribbonOutline } from './geometry.js'

const root = { x: 0, y: 0, hw: 105, hh: 38 }
const childAt = (angle, radius) => ({ x: Math.cos(angle) * radius, y: Math.sin(angle) * radius, hw: 70, hh: 21 })
const WIDTHS = { start: 34, end: 8 }
const angles = (step) => Array.from({ length: Math.round(360 / step) }, (_, i) => (i * step * Math.PI) / 180)

function curvatureSigns(geometry) {
  const signs = new Set()
  for (let i = 1; i < 100; i++) {
    const d1 = cubicAt(geometry, i / 100, 1)
    const d2 = cubicAt(geometry, i / 100, 2)
    const cross = d1.x * d2.y - d1.y * d2.x
    if (Math.abs(cross) > 1e-6 * Math.hypot(d1.x, d1.y) ** 3) signs.add(Math.sign(cross))
  }
  return signs
}

const segmentsCross = (a, b, c, d) => {
  const side = (p, q, r) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x))
  return side(a, b, c) * side(a, b, d) < 0 && side(c, d, a) * side(c, d, b) < 0
}

test('a branch bends once, never an S, for a child in any direction', () => {
  for (const radius of [170, 240, 400]) {
    for (const angle of angles(5)) {
      for (const curve of [0, 78, 100]) {
        const geometry = branchGeometry(root, childAt(angle, radius), { curve })
        assert.ok(curvatureSigns(geometry).size <= 1, `S-bend at ${angle} r${radius} curve${curve}`)
      }
    }
  }
})

test('a branch leaves the parent heading toward the child and meets the child on its facing side', () => {
  for (const angle of angles(15)) {
    const child = childAt(angle, 260)
    const { sx, sy, ex, ey, controls } = branchGeometry(root, child)
    const outward = { x: Math.cos(angle), y: Math.sin(angle) }
    assert.ok((controls[0].x - sx) * outward.x + (controls[0].y - sy) * outward.y > 0, 'leaves away from the centre')
    assert.ok((ex - child.x) * Math.cos(angle) + (ey - child.y) * Math.sin(angle) < 0, 'arrives on the side facing the parent')
    assert.ok(Math.abs(sx) <= root.hw + 1e-6 && Math.abs(sy) <= root.hh + 1e-6)
  }
})

test('the ribbon narrows steadily with no pinch and no crossing edges', () => {
  for (const radius of [230, 300, 400]) {
    for (const angle of angles(5)) {
      const geometry = branchGeometry(root, childAt(angle, radius))
      const { outline, widths } = ribbonOutline(geometry, WIDTHS)
      widths.forEach((width, i) => {
        assert.ok(width >= WIDTHS.end - 1e-9, `pinched at ${angle}`)
        if (i) assert.ok(width <= widths[i - 1] + 1e-9, 'width grew')
      })
      assert.ok(widths[0] > widths.at(-1))
      for (let i = 0; i < outline.length - 1; i++) {
        for (let j = i + 2; j < outline.length - 1; j++) {
          if (i === 0 && j === outline.length - 2) continue
          assert.ok(!segmentsCross(outline[i], outline[i + 1], outline[j], outline[j + 1]), `self-crossing at ${angle} r${radius}`)
        }
      }
    }
  }
})

test('dragging a child around its parent moves the branch in small steps', () => {
  let previous = null
  for (const angle of [...angles(0.5), 0]) {
    const { controls, sx, sy, ex, ey } = branchGeometry(root, childAt(angle, 220))
    const current = [controls[0], controls[1], { x: sx, y: sy }, { x: ex, y: ey }]
    if (previous) current.forEach((point, i) => assert.ok(Math.hypot(point.x - previous[i].x, point.y - previous[i].y) < 12, `jump at ${angle}`))
    previous = current
  }
})

test('a pinned branch title keeps its attachment point', () => {
  const pinned = branchGeometry(root, { x: 200, y: 100, hw: 50, hh: 20, pin: true })
  assert.deepEqual([pinned.ex, pinned.ey], [200, 105])
})

test('a saved port that faces the other node is honoured', () => {
  const g = branchGeometry(root, childAt(0, 260), { sourcePort: 'right', targetPort: 'left' })
  assert.deepEqual([g.sx, g.sy], [93, 0])
  assert.deepEqual([g.ex, g.ey], [191, 0])
})

test('saved ports are only a hint: any child position still leaves and enters the facing sides', () => {
  const inside = (p, f) => Math.abs(p.x - f.x) < f.hw - 0.5 && Math.abs(p.y - f.y) < f.hh - 0.5
  for (const [sourcePort, targetPort] of [['right', 'left'], ['bottom', 'top'], ['top', 'bottom'], ['left', 'right']]) {
    for (const radius of [240, 330]) {
      for (const angle of angles(3)) {
        const child = childAt(angle, radius)
        const g = branchGeometry(root, child, { sourcePort, targetPort })
        assert.ok(curvatureSigns(g).size <= 1, `S-bend ${sourcePort} at ${angle}`)
        let left = false
        for (let i = 0; i <= 100; i++) {
          const inParent = inside(cubicAt(g, i / 100), root)
          if (!inParent) left = true
          assert.ok(!(left && inParent), `back under the parent: ${sourcePort} at ${angle} t=${i}`)
        }
        assert.ok(left)
        const toward = { x: Math.cos(angle), y: Math.sin(angle) }
        assert.ok((g.sx - root.x) * toward.x + (g.sy - root.y) * toward.y > 0, 'leaves the parent on its facing side')
        assert.ok((g.ex - child.x) * toward.x + (g.ey - child.y) * toward.y < 0, 'enters the child on its facing side')
      }
    }
  }
})

test('with saved ports, dragging a child around the parent still moves attachments and controls in small steps', () => {
  for (const [sourcePort, targetPort] of [['right', 'left'], ['bottom', 'top'], ['top', 'bottom'], ['left', 'right']]) {
    for (const radius of [240, 330]) {
      let previous = null
      for (const angle of [...angles(0.5), 0]) {
        const { controls, sx, sy, ex, ey } = branchGeometry(root, childAt(angle, radius), { sourcePort, targetPort })
        const current = [controls[0], controls[1], { x: sx, y: sy }, { x: ex, y: ey }]
        if (previous) current.forEach((point, i) => assert.ok(Math.hypot(point.x - previous[i].x, point.y - previous[i].y) < 4, `jump ${sourcePort} r${radius} at ${angle} point ${i}`))
        previous = current
      }
    }
  }
})
