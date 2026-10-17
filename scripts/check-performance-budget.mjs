import { readdir, readFile } from 'node:fs/promises'
import { extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const DIST_DIRECTORY = fileURLToPath(new URL('../dist/', import.meta.url))
const KIB = 1024
const budgets = {
  // 240 until F-092: the captain raised it to 260 on 2026-10-16 for jam sessions and the plugins after them ("two hundred sixty KB is fine");
  // F-097 moved the optional plugins and settings panels out of the first load (see firstLoadGzip below).
  javascriptGzip: 260 * KIB,
  // F-097: the JavaScript the first screen waits for (index.html's script and everything it imports statically). It measured 207.05 KiB with the
  // plugins and settings panels in it and 204.11 KiB after they moved out; 205 guards what was achieved, so putting optional code back in
  // the first load fails here. This number can only go down.
  firstLoadGzip: 205 * KIB,
  // The editors built on CodeMirror are not in the first load: the page editor comes when a page note opens (F-040), the Markdown text
  // editor is fetched once a canvas has opened and the window is idle (F-049). They have their own budget instead of eating the app's:
  // the two editors and the CodeMirror chunk they share.
  pageEditorGzip: 150 * KIB,
  cssGzip: 17.6 * KIB, // 17.1 until F-072/F-073 (omnibar and focus mode; the old search panel CSS is removed); before that 16 until F-058 (secure notes: about 1 KiB gzip) then 16.75; the PARA sidebar (shelves, drag, naming) adds about 0.3 KiB, trimmed first
  largestJavascriptRaw: 850 * KIB,
}

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const nestedFiles = await Promise.all(entries.map((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? listFiles(path) : [path]
  }))
  return nestedFiles.flat()
}

function kib(bytes) {
  return `${(bytes / KIB).toFixed(2)} KiB`
}

const files = await listFiles(DIST_DIRECTORY)
const assets = await Promise.all(files.map(async (path) => {
  const contents = await readFile(path)
  return {
    path,
    extension: extname(path),
    raw: contents.byteLength,
    gzip: gzipSync(contents).byteLength,
  }
}))

const isPageEditor = (asset) => /(^|\/)(page-editor|markdown-editor|codemirror)-[^/]*\.js$/.test(asset.path)
const javascript = assets.filter((asset) => asset.extension === '.js' && !isPageEditor(asset))
const pageEditorGzip = assets.filter(isPageEditor).reduce((total, asset) => total + asset.gzip, 0)
const css = assets.filter((asset) => asset.extension === '.css')
const javascriptGzip = javascript.reduce((total, asset) => total + asset.gzip, 0)
const cssGzip = css.reduce((total, asset) => total + asset.gzip, 0)
const largestJavascript = javascript.reduce((largest, asset) => asset.raw > largest.raw ? asset : largest, javascript[0])

// The first load: the module graph index.html starts (script and modulepreload links, then each file's static imports). index.html's own entry
// boots the app with one dynamic import(), which is followed (it is the app, not a plugin). Every other dynamic import() is not: that is the
// code fetched after the first paint.
const byName = new Map(assets.map((asset) => [relative(DIST_DIRECTORY, asset.path), asset]))
const html = await readFile(join(DIST_DIRECTORY, 'index.html'), 'utf8')
const firstLoad = new Set()
async function follow(name, entry = false) {
  if (firstLoad.has(name) || !byName.has(name)) return
  firstLoad.add(name)
  const code = await readFile(join(DIST_DIRECTORY, name), 'utf8')
  const here = name.includes('/') ? name.slice(0, name.lastIndexOf('/')) : ''
  for (const [, target] of code.matchAll(/(?:\bfrom|\bimport)\s*["']\.\/([^"']+\.js)["']/g)) await follow(join(here, target))
  if (entry) for (const [, target] of code.matchAll(/\bimport\(`\.\/([^`]+\.js)`\)/g)) await follow(join(here, target))
}
for (const [, target] of html.matchAll(/(?:src|href)="\/(assets\/[^"]+\.js)"/g)) await follow(target, true)
const firstLoadGzip = [...firstLoad].reduce((total, name) => total + byName.get(name).gzip, 0)

const checks = [
  ['JavaScript gzip (app, without the editors loaded on demand)', javascriptGzip, budgets.javascriptGzip],
  ['JavaScript gzip (first load: what the first screen waits for)', firstLoadGzip, budgets.firstLoadGzip],
  ['Editors gzip (CodeMirror, fetched after the first paint: on idle once a canvas opens, or with a page note)', pageEditorGzip, budgets.pageEditorGzip],
  ['CSS gzip', cssGzip, budgets.cssGzip],
  ['Largest JavaScript chunk', largestJavascript.raw, budgets.largestJavascriptRaw],
]

console.log('Production bundle performance budget')
for (const [label, actual, budget] of checks) {
  const status = actual <= budget ? 'PASS' : 'FAIL'
  console.log(`${status}  ${label}: ${kib(actual)} / ${kib(budget)}`)
}
console.log(`INFO  first load files: ${[...firstLoad].join(', ')}`)
console.log(`Largest chunk: ${relative(DIST_DIRECTORY, largestJavascript.path)}`)

if (checks.some(([, actual, budget]) => actual > budget)) process.exitCode = 1