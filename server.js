import Database from 'better-sqlite3'
import express from 'express'
import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const dataDirectory = path.join(__dirname, 'data')
mkdirSync(dataDirectory, { recursive: true })

const database = new Database(path.join(dataDirectory, 'personal-note.db'))
database.pragma('journal_mode = WAL')
database.exec(`
  CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL DEFAULT 'Untitled note',
    content TEXT NOT NULL DEFAULT '{"objects":[]}',
    page_state TEXT NOT NULL DEFAULT '{"columns":1,"rows":1}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS notebooks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '#B86B4B',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`)

const noteColumns = database.prepare('PRAGMA table_info(notes)').all()
if (!noteColumns.some((column) => column.name === 'notebook_id')) {
  database.exec('ALTER TABLE notes ADD COLUMN notebook_id INTEGER REFERENCES notebooks(id)')
}

let defaultNotebook = database.prepare('SELECT id FROM notebooks ORDER BY id LIMIT 1').get()
if (!defaultNotebook) {
  const result = database.prepare('INSERT INTO notebooks (name, color) VALUES (?, ?)').run('My Notes', '#B86B4B')
  defaultNotebook = { id: Number(result.lastInsertRowid) }
}
database.prepare('UPDATE notes SET notebook_id = ? WHERE notebook_id IS NULL').run(defaultNotebook.id)

const app = express()
app.use(express.json({ limit: '12mb' }))

function parseJson(value, fallback) {
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function serializeNote(note) {
  return {
    id: note.id,
    title: note.title,
    notebookId: note.notebook_id,
    content: parseJson(note.content, { objects: [] }),
    pageState: parseJson(note.page_state, { columns: 1, rows: 1 }),
    createdAt: note.created_at,
    updatedAt: note.updated_at,
  }
}

function isNotebookColor(value) {
  return /^#[0-9a-f]{6}$/i.test(value)
}

function notebookExists(id) {
  return Boolean(database.prepare('SELECT 1 FROM notebooks WHERE id = ?').get(id))
}

function canvasText(content) {
  const document = parseJson(content, { objects: [] })
  return (document.objects || [])
    .map((object) => typeof object.text === 'string' ? object.text : '')
    .filter(Boolean)
    .join(' ')
}

app.get('/api/notebooks', (_request, response) => {
  const notebooks = database.prepare(`
    SELECT notebooks.id, notebooks.name, notebooks.color,
      COUNT(notes.id) AS note_count
    FROM notebooks
    LEFT JOIN notes ON notes.notebook_id = notebooks.id
    GROUP BY notebooks.id
    ORDER BY notebooks.updated_at DESC, notebooks.id ASC
  `).all()
  response.json(notebooks.map((notebook) => ({
    id: notebook.id,
    name: notebook.name,
    color: notebook.color,
    noteCount: notebook.note_count,
  })))
})

app.post('/api/notebooks', (request, response) => {
  const name = String(request.body.name || 'Untitled notebook').trim().slice(0, 80) || 'Untitled notebook'
  const color = isNotebookColor(request.body.color) ? request.body.color : '#B86B4B'
  const result = database.prepare('INSERT INTO notebooks (name, color) VALUES (?, ?)').run(name, color)
  response.status(201).json({ id: Number(result.lastInsertRowid), name, color, noteCount: 0 })
})

app.put('/api/notebooks/:id', (request, response) => {
  const current = database.prepare('SELECT * FROM notebooks WHERE id = ?').get(request.params.id)
  if (!current) return response.status(404).json({ error: 'Notebook not found' })
  const name = String(request.body.name ?? current.name).trim().slice(0, 80) || current.name
  const color = isNotebookColor(request.body.color) ? request.body.color : current.color
  database.prepare(`
    UPDATE notebooks SET name = ?, color = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(name, color, request.params.id)
  response.json({ id: current.id, name, color })
})

app.delete('/api/notebooks/:id', (request, response) => {
  const notebook = database.prepare('SELECT id FROM notebooks WHERE id = ?').get(request.params.id)
  if (!notebook) return response.status(404).json({ error: 'Notebook not found' })
  let destination = database.prepare('SELECT id FROM notebooks WHERE id != ? ORDER BY id LIMIT 1').get(notebook.id)
  if (!destination) {
    const result = database.prepare('INSERT INTO notebooks (name, color) VALUES (?, ?)').run('My Notes', '#B86B4B')
    destination = { id: Number(result.lastInsertRowid) }
  }
  const removeNotebook = database.transaction(() => {
    database.prepare('UPDATE notes SET notebook_id = ? WHERE notebook_id = ?').run(destination.id, notebook.id)
    database.prepare('DELETE FROM notebooks WHERE id = ?').run(notebook.id)
  })
  removeNotebook()
  response.json({ destinationNotebookId: destination.id })
})

app.get('/api/search', (request, response) => {
  const query = String(request.query.q || '').trim().toLocaleLowerCase()
  if (!query) return response.json([])
  const notes = database.prepare(`
    SELECT notes.*, notebooks.name AS notebook_name, notebooks.color AS notebook_color
    FROM notes
    JOIN notebooks ON notebooks.id = notes.notebook_id
    ORDER BY notes.updated_at DESC
  `).all()
  const matches = notes.flatMap((note) => {
    const body = canvasText(note.content)
    const titleMatch = note.title.toLocaleLowerCase().includes(query)
    const bodyIndex = body.toLocaleLowerCase().indexOf(query)
    if (!titleMatch && bodyIndex < 0) return []
    const start = Math.max(0, bodyIndex - 42)
    const excerpt = bodyIndex >= 0 ? body.slice(start, start + 120).trim() : ''
    return [{
      id: note.id,
      title: note.title,
      notebookId: note.notebook_id,
      notebookName: note.notebook_name,
      notebookColor: note.notebook_color,
      excerpt,
      updatedAt: note.updated_at,
    }]
  })
  response.json(matches.slice(0, 30))
})

app.get('/api/notes', (_request, response) => {
  const notes = database.prepare('SELECT id, title, notebook_id, created_at, updated_at FROM notes ORDER BY updated_at DESC, id DESC').all()
  response.json(notes.map((note) => ({
    id: note.id,
    title: note.title,
    notebookId: note.notebook_id,
    createdAt: note.created_at,
    updatedAt: note.updated_at,
  })))
})

app.get('/api/notes/:id', (request, response) => {
  const note = database.prepare('SELECT * FROM notes WHERE id = ?').get(request.params.id)
  if (!note) return response.status(404).json({ error: 'Note not found' })
  response.json(serializeNote(note))
})

app.post('/api/notes', (request, response) => {
  const title = String(request.body.title || 'Untitled note').slice(0, 180)
  const requestedNotebookId = Number(request.body.notebookId)
  const notebookId = notebookExists(requestedNotebookId) ? requestedNotebookId : defaultNotebook.id
  const result = database.prepare('INSERT INTO notes (title, notebook_id) VALUES (?, ?)').run(title, notebookId)
  const note = database.prepare('SELECT * FROM notes WHERE id = ?').get(result.lastInsertRowid)
  response.status(201).json(serializeNote(note))
})

app.put('/api/notes/:id', (request, response) => {
  const title = String(request.body.title || 'Untitled note').slice(0, 180)
  const content = JSON.stringify(request.body.content || { objects: [] })
  const pageState = JSON.stringify(request.body.pageState || { columns: 1, rows: 1 })
  const result = database.prepare(`
    UPDATE notes
    SET title = ?, content = ?, page_state = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(title, content, pageState, request.params.id)
  if (!result.changes) return response.status(404).json({ error: 'Note not found' })
  const notebookId = Number(request.body.notebookId)
  if (notebookExists(notebookId)) {
    database.prepare('UPDATE notes SET notebook_id = ? WHERE id = ?').run(notebookId, request.params.id)
  }
  response.json({ ok: true })
})

app.patch('/api/notes/:id/notebook', (request, response) => {
  const notebookId = Number(request.body.notebookId)
  if (!notebookExists(notebookId)) return response.status(404).json({ error: 'Notebook not found' })
  const result = database.prepare(`
    UPDATE notes SET notebook_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(notebookId, request.params.id)
  if (!result.changes) return response.status(404).json({ error: 'Note not found' })
  response.json({ ok: true })
})

app.delete('/api/notes/:id', (request, response) => {
  const result = database.prepare('DELETE FROM notes WHERE id = ?').run(request.params.id)
  if (!result.changes) return response.status(404).json({ error: 'Note not found' })
  response.status(204).end()
})

const distDirectory = path.join(__dirname, 'dist')
if (existsSync(distDirectory)) {
  app.use(express.static(distDirectory))
  app.get('*path', (_request, response) => response.sendFile(path.join(distDirectory, 'index.html')))
}

const port = Number(process.env.PORT) || 3137
app.listen(port, () => console.log(`Personal Note API listening on http://localhost:${port}`))