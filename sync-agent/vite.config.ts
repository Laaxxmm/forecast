import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// Renderer-only Vite config. Electron main/preload are compiled by tsc
// (see tsconfig.electron.json) — keeping the two build systems separate
// avoids wrestling with Electron-specific Vite plugins.
export default defineConfig({
  plugins: [react()],
  root: __dirname,
  base: './', // critical for loading assets from file:// in production
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 5174,
    strictPort: true,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
});
