import { readdir, readFile } from 'node:fs/promises'
import { extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const DIST_DIRECTORY = fileURLToPath(new URL('../dist/', import.meta.url))
const KIB = 1024
const budgets = {
  javascriptGzip: 240 * KIB,
  // The editors built on CodeMirror are not in the first load: the page editor comes when a page note opens (F-040), the Markdown text
  // editor is fetched once a canvas has opened and the window is idle (F-049). They have their own budget instead of eating the app's:
  // the two editors and the CodeMirror chunk they share.
  pageEditorGzip: 150 * KIB,
  cssGzip: 17.5 * KIB, // 16 until F-058 (secure notes: cover, sheets, pill, about 1 KiB gzip); the sidebar rebuild (F-064..) is also adding CSS
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

const checks = [
  ['JavaScript gzip (app, without the editors loaded on demand)', javascriptGzip, budgets.javascriptGzip],
  ['Editors gzip (CodeMirror, fetched after the first paint: on idle once a canvas opens, or with a page note)', pageEditorGzip, budgets.pageEditorGzip],
  ['CSS gzip', cssGzip, budgets.cssGzip],
  ['Largest JavaScript chunk', largestJavascript.raw, budgets.largestJavascriptRaw],
]

console.log('Production bundle performance budget')
for (const [label, actual, budget] of checks) {
  const status = actual <= budget ? 'PASS' : 'FAIL'
  console.log(`${status}  ${label}: ${kib(actual)} / ${kib(budget)}`)
}
console.log(`Largest chunk: ${relative(DIST_DIRECTORY, largestJavascript.path)}`)

if (checks.some(([, actual, budget]) => actual > budget)) process.exitCode = 1