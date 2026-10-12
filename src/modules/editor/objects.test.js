import assert from 'node:assert/strict'
import test from 'node:test'
import {
  IMAGE_MAX_SIDE,
  contrastRatio,
  fitImage,
  imageFiles,
  objectPalette,
  stickyDefaults,
  stickyInk,
} from './objects.js'

const crayon = { '--sk-c1': '#ffd60a', '--sk-c2': '#30d158', '--sk-c3': '#64b5ff', '--sk-c4': '#bf5af2', '--sk-c5': '#ff6b3d' }
const paper = { '--sk-c1': '#ffd66b', '--sk-c2': '#9fe0c0', '--sk-c3': '#a9cfff', '--sk-c4': '#cdb8ff', '--sk-c5': '#ff9c85' }
const night = { '--sk-c1': '#ffc877', '--sk-c2': '#7ee7c8', '--sk-c3': '#9db4ff', '--sk-c4': '#d3a6ff', '--sk-c5': '#ff8fb1' }

test('the object palette is the skin\'s five colours, in order, read from its tokens', () => {
  const palette = objectPalette((name) => crayon[name])
  assert.deepEqual(palette.map((entry) => entry.fill), ['#ffd60a', '#30d158', '#64b5ff', '#bf5af2', '#ff6b3d'])
})

test('a missing token falls back to a sticky yellow instead of breaking creation', () => {
  const palette = objectPalette(() => '')
  assert.equal(palette.length, 5)
  assert.ok(palette.every((entry) => /^#[0-9a-f]{6}$/i.test(entry.fill)))
})

test('sticky text is readable on every colour of every skin', () => {
  for (const tokens of [crayon, paper, night]) {
    for (const { fill, ink } of objectPalette((name) => tokens[name])) {
      assert.equal(ink, stickyInk(fill))
      assert.ok(contrastRatio(ink, fill) >= 4.5, `${ink} on ${fill} is ${contrastRatio(ink, fill).toFixed(2)}`)
    }
  }
})

test('a sticky is a fixed-width handwriting note that carries its own colour', () => {
  const sticky = stickyDefaults({ fill: '#ffd60a', ink: '#4d3f00' })
  assert.equal(sticky.fontFamily, 'Caveat')
  assert.equal(sticky.fill, '#4d3f00')
  assert.equal(sticky.stickyColor, '#ffd60a')
  assert.ok(sticky.width >= 200)
})

test('large pictures are scaled down to the maximum side, small ones are never enlarged', () => {
  assert.deepEqual(fitImage({ width: 4000, height: 2000 }), { width: IMAGE_MAX_SIDE, height: IMAGE_MAX_SIDE / 2 })
  assert.deepEqual(fitImage({ width: 800, height: 600 }), { width: 800, height: 600 })
  assert.deepEqual(fitImage({ width: 1000, height: 3000 }, 1500), { width: 500, height: 1500 })
})

test('only real picture files are taken from a drop or a file picker', () => {
  const files = [
    { name: 'a.png', type: 'image/png' },
    { name: 'b.txt', type: 'text/plain' },
    { name: 'c.jpg', type: 'image/jpeg' },
    { name: 'd.svg', type: 'image/svg+xml' },
    { name: 'e.webp', type: 'image/webp' },
    { name: 'f.gif', type: 'image/gif' },
  ]
  assert.deepEqual(imageFiles(files).map((file) => file.name), ['a.png', 'c.jpg', 'e.webp', 'f.gif'])
  assert.deepEqual(imageFiles(null), [])
})
