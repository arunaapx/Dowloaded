import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In production nginx serves this build and proxies /api to the Rust store on
// 127.0.0.1:8090, so both live on one origin. This proxy makes `npm run dev`
// behave the same way, which keeps the fetch paths identical in both.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8090', changeOrigin: true },
    },
  },
  preview: {
    port: 4173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8090', changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
