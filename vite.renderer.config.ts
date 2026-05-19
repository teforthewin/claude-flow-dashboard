import { resolve } from 'path';
import { defineConfig } from 'vite';

// Standalone Vite config for building the renderer as a browser bundle
// (used by the Docker UI service). Mirrors the `renderer` section of
// electron.vite.config.ts so the Electron and web builds stay in sync.
export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  base: './',
  resolve: {
    alias: {
      vue: 'vue/dist/vue.esm-bundler.js',
    },
  },
  build: {
    outDir: resolve(__dirname, 'out/renderer'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'src/renderer/index.html'),
      },
    },
  },
});
