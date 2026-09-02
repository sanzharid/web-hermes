import { defineConfig } from 'vite';

// Static output only. No server-side pieces, no proxies.
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      output: {
        // Keep transformers.js in its own chunk so the app shell stays small.
        manualChunks: (id) => (id.includes('@huggingface/transformers') || id.includes('onnxruntime-web') ? 'inference' : undefined),
      },
    },
  },
  optimizeDeps: {
    exclude: ['@huggingface/transformers'],
  },
  worker: {
    format: 'es',
  },
  server: {
    headers: {
      // Cross-origin isolation enables SharedArrayBuffer, which enables multi-threaded WASM inference.
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    },
  },
  preview: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    },
  },
});
