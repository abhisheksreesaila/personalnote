import { readdir, readFile } from 'node:fs/promises'
import { extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const DIST_DIRECTORY = fileURLToPath(new URL('../dist/', import.meta.url))
const KIB = 1024
const budgets = {
  javascriptGzip: 230 * KIB,
  cssGzip: 13 * KIB,
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

const javascript = assets.filter((asset) => asset.extension === '.js')
const css = assets.filter((asset) => asset.extension === '.css')
const javascriptGzip = javascript.reduce((total, asset) => total + asset.gzip, 0)
const cssGzip = css.reduce((total, asset) => total + asset.gzip, 0)
const largestJavascript = javascript.reduce((largest, asset) => asset.raw > largest.raw ? asset : largest, javascript[0])

const checks = [
  ['JavaScript gzip', javascriptGzip, budgets.javascriptGzip],
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