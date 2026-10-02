// Prints, as JSON, what the JS document model does with every fixture (and with the invalid documents), so the Python mirror can
// be compared with it. The seeded benchmark note is built here and handed to Python through this output instead of being stored.
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { fromFabric, toFabric, validateDocument } from '../src/core/document/index.js'
import { COLUMNS, ROWS, generateNote } from './benchmark-note.mjs'

const fixtureDir = fileURLToPath(new URL('../tests/fixtures/documents/', import.meta.url))
const entries = fs.readdirSync(fixtureDir).filter((name) => name.endsWith('.json')).sort().map((file) => JSON.parse(fs.readFileSync(`${fixtureDir}${file}`, 'utf8')))
entries.push({ name: 'benchmark-600', content: generateNote(), pageState: { columns: COLUMNS, rows: ROWS } })

const fixtures = {}
for (const { name, content, pageState } of entries) {
  const model = fromFabric(content, pageState)
  fixtures[name] = {
    content,
    pageState,
    model,
    validation: validateDocument(model),
    validationWithoutIds: validateDocument(model, { requireIds: false }),
    fabric: toFabric(model),
  }
}

const invalid = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../tests/fixtures/invalid-documents.json', import.meta.url)), 'utf8'))
const invalidResults = invalid.map(({ name, document }) => {
  let fabricError = null
  try { toFabric(document) } catch (error) { fabricError = error.message }
  return { name, validation: validateDocument(document), structural: validateDocument(document, { requireIds: false, strict: false }), fabricError }
})

process.stdout.write(JSON.stringify({ fixtures, invalid: invalidResults }))
