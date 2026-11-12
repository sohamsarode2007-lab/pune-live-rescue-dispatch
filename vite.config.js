import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The React client lives in client/; the API server (server/index.js) runs on port 3001.
export default defineConfig({
  root: 'client',
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    host: true,
    proxy: { '/api': 'http://localhost:3001' },
  },
});
