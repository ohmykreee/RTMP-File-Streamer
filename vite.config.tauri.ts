// Vite config for the Tauri renderer (src/renderer-tauri). The Electron build
// keeps using electron-vite and its own config — the two renderer trees are
// built independently so merges from main stay conflict-free.
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  root: path.resolve(root, 'src/renderer-tauri'),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@shared': path.resolve(root, 'src/shared'),
      '@renderer': path.resolve(root, 'src/renderer-tauri/src'),
    },
  },
  build: {
    outDir: path.resolve(root, 'out/renderer-tauri'),
    emptyOutDir: true,
    target: 'chrome130',
  },
  server: {
    port: 1420,
    strictPort: true,
  },
  clearScreen: false,
})
