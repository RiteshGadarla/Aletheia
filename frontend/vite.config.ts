import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Air-gap: everything is bundled locally, no CDN or webfont origins.
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', assetsInlineLimit: 8192, sourcemap: false },
  server: {
    port: 5173,
    // Dev-only proxy to the Studio API; production is served behind the same origin.
    proxy: {
      // Studio API. Must match `make studio` (:8081) — :8080 is the all-in-one image's UI port.
      '/api': { target: process.env.VITE_API_TARGET || 'http://127.0.0.1:8081', changeOrigin: true },
    },
  },
});
