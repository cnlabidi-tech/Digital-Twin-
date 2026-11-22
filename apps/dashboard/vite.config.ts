import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Dev server on :5173 proxies API and WebSocket calls to the backend on :4000,
// so the browser sees a single origin (same as production, where the backend
// serves the built files).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:4000',
      '/ws': { target: 'ws://localhost:4000', ws: true },
    },
  },
});
