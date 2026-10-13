import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  // Relative base for standalone and embedded hosting
  base: './',
  plugins: [react()],
  server: {
    // Honor harness-assigned ports; fall back to vite's default.
    port: process.env.PORT ? Number(process.env.PORT) : 5173,
    // Cross-origin isolation enables SharedArrayBuffer if we adopt it later.
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
})
