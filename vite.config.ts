import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Proxy /api -> local express server (8787)
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true
      }
    }
  }
})
