import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  build: {
    rolldownOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        landingNote: fileURLToPath(new URL('./landing-note.html', import.meta.url)),
        landingSpatial: fileURLToPath(new URL('./landing-spatial.html', import.meta.url)),
        spatialDocs: fileURLToPath(new URL('./spatial-docs.html', import.meta.url)),
      },
    },
  },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:3137',
    },
  },
})