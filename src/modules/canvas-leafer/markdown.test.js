import test from 'node:test'
import assert from 'node:assert/strict'
import { parseMarkdown } from './markdown.js'

const shown = (source, line) => line.runs.map((run) => source.slice(run.from, run.to)).join('')
const styled = (source, line) => line.runs.map((run) => [source.slice(run.from, run.to), Object.keys(run.style).filter((key) => run.style[key]).sort().join('+')])

test('each source line is one line of the text, with its kind', () => {
  const source = '# Lisbon\nThe harbour walk.\n\n- bread\n- [x] wine\n2. fish\n> a quote\n---'
  const kinds = parseMarkdown(source).map((line) => line.kind)
  assert.deepEqual(kinds, ['heading', 'paragraph', 'blank', 'bullet', 'task', 'ordered', 'quote', 'rule'])
})

test('a heading hides its marks and keeps its level', () => {
  const source = '## Day two'
  const [line] = parseMarkdown(source)
  assert.equal(line.level, 2)
  assert.equal(shown(source, line), 'Day two')
  assert.deepEqual(line.marker, { from: 0, to: 3 })
})

test('list items keep their marker, depth and checked state', () => {
  const source = '- top\n  - inner\n- [ ] todo\n- [X] done\n12) twelfth'
  const lines = parseMarkdown(source)
  assert.deepEqual(lines.map((line) => line.depth), [0, 1, 0, 0, 0])
  assert.deepEqual(lines.map((line) => line.checked), [undefined, undefined, false, true, undefined])
  assert.equal(lines[4].number, '12)')
  assert.deepEqual(lines.map((line) => shown(source, line)), ['top', 'inner', 'todo', 'done', 'twelfth'])
})

test('emphasis, code, strikethrough and links are styled and their marks hidden', () => {
  const source = 'a **bold** and *it* or _it_, `x*y*`, ~~gone~~ [site](https://e.com)'
  const [line] = parseMarkdown(source)
  assert.equal(shown(source, line), 'a bold and it or it, x*y*, gone site')
  assert.deepEqual(styled(source, line), [
    ['a ', ''], ['bold', 'bold'], [' and ', ''], ['it', 'italic'], [' or ', ''], ['it', 'italic'], [', ', ''],
    ['x*y*', 'code'], [', ', ''], ['gone', 'strike'], [' ', ''], ['site', 'link'],
  ])
  assert.equal(line.runs.at(-1).style.link, 'https://e.com')
})

test('every run is exactly a slice of the source, so a word on screen maps back to its place in the Markdown', () => {
  const source = '> **Note:** call *Ana* about `the boat`'
  const [line] = parseMarkdown(source)
  for (const run of line.runs) assert.ok(run.from >= line.contentFrom && run.to <= line.to && run.from < run.to)
  assert.equal(shown(source, line), 'Note: call Ana about the boat')
})

test('unmatched marks and intraword underscores stay as typed', () => {
  const source = 'snake_case_name and 2 * 3 and **open'
  const [line] = parseMarkdown(source)
  assert.equal(shown(source, line), source)
})

test('a backslash escapes a mark', () => {
  const source = '\\*not italic\\*'
  const [line] = parseMarkdown(source)
  assert.equal(shown(source, line), '*not italic*')
})

test('fenced code keeps its lines as typed, unstyled inside', () => {
  const source = '```js\nconst a = **b**\n```\nafter'
  const lines = parseMarkdown(source)
  assert.deepEqual(lines.map((line) => line.kind), ['fence', 'code', 'fence', 'paragraph'])
  assert.equal(shown(source, lines[1]), 'const a = **b**')
  assert.deepEqual(styled(source, lines[1]), [['const a = **b**', 'code']])
})

test('line positions cover the source, so marks can find their line', () => {
  const source = 'one\ntwo\n'
  const lines = parseMarkdown(source)
  assert.deepEqual(lines.map((line) => [line.from, line.to]), [[0, 3], [4, 7], [8, 8]])
})

test('a backslash inside code is kept, and does not keep the code from closing', () => {
  const source = '`path\\` and `\\*x` and \\`not code`'
  const [line] = parseMarkdown(source)
  assert.deepEqual(styled(source, line), [['path\\', 'code'], [' and ', ''], ['\\*x', 'code'], [' and ', ''], ['`not code`', '']]) // (the escaping backslash is hidden)
})
