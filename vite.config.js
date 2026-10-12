import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  build: {
    rolldownOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        landingNote: fileURLToPath(new URL('./landing-note.html', import.meta.url)),
        spatialDocs: fileURLToPath(new URL('./spatial-docs.html', import.meta.url)),
      },
      // CodeMirror is shared by the two editors that load on demand (page notes, Markdown text on the canvas): one chunk of its own.
      output: { advancedChunks: { groups: [{ name: 'codemirror', test: /node_modules[\\/]@(codemirror|lezer)[\\/]/ }] } },
    },
  },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:3137',
    },
  },
})