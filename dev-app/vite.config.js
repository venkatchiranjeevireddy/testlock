import { defineConfig } from 'vite';
export default defineConfig({
  build: { target: 'es2020', chunkSizeWarningLimit: 4000 },
  // mind-ar ships large prebuilt bundles; keep them out of dep pre-bundling quirks
  optimizeDeps: { exclude: ['mind-ar'] },
});
