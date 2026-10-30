import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  build: {
    rolldownOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        landingNote: fileURLToPath(new URL('./landing-note.html', import.meta.url)),
      },
      // CodeMirror is shared by the two editors that load on demand (page notes, Markdown text on the canvas): one chunk of its own.
      // The mind-map editor (src/mindmap/, fetched only when a mind map opens) is one named chunk too, so it has a budget of its own.
      output: {
        advancedChunks: {
          groups: [
            { name: 'codemirror', test: /node_modules[\\/]@(codemirror|lezer)[\\/]/ },
            { name: 'mindmap-editor', test: /src[\\/]mindmap[\\/]/ },
          ],
        },
      },
    },
  },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:3137',
    },
  },
})