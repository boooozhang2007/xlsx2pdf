import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { nitro } from 'nitro/vite'
import { workflow } from 'workflow/vite'

export default defineConfig({
  plugins: [react(), nitro(), workflow()],
  nitro: {
    serverDir: './nitro',
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
  },
})
