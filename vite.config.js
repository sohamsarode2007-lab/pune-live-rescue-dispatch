import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The React client lives in client/; the API + Socket.IO server (server/index.js) runs on port 3001.
export default defineConfig({
  root: 'client',
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    host: true,
    // ngrok tunnels for phone testing (GPS needs HTTPS)
    allowedHosts: ['.ngrok-free.app', '.ngrok.app', '.ngrok.io', '.ngrok-free.dev'],
    proxy: {
      '/api': 'http://localhost:3001',
      '/socket.io': { target: 'http://localhost:3001', ws: true },
    },
  },
});
