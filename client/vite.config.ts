import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// VITE_BACKEND_URL lets the dev server proxy /api at a non-default backend
// (e.g. when the worktree's auto-assigned port isn't 3000). Defaults to
// http://localhost:3000 to preserve the original behaviour.
const backendUrl = process.env.VITE_BACKEND_URL || 'http://localhost:3000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': backendUrl,
    },
  },
});
