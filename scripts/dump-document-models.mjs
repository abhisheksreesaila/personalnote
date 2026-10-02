// Prints the JS document model of every fixture as JSON ({ name: model }), so the Python mirror can be compared with it.
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { fromFabric } from '../src/core/document/index.js'

const dir = fileURLToPath(new URL('../tests/fixtures/documents/', import.meta.url))
const models = {}
for (const file of fs.readdirSync(dir).filter((name) => name.endsWith('.json')).sort()) {
  const { name, content, pageState } = JSON.parse(fs.readFileSync(`${dir}${file}`, 'utf8'))
  models[name] = fromFabric(content, pageState)
}
process.stdout.write(JSON.stringify(models))
