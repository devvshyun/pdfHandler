import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  // Relative base so the static build also works from a sub-path (e.g. GitHub Pages).
  base: './',
  resolve: {
    alias: {
      // Use the shared operations straight from source so Vite bundles them as ESM.
      '@pdfhandler/core': fileURLToPath(new URL('../packages/core/src/index.ts', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: { '/api': process.env.VITE_API_PROXY ?? 'http://localhost:3000' },
  },
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
});
