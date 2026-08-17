import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

// `--mode singlefile` inlines every asset into one portable index.html.
export default defineConfig(({ mode }) => ({
  base: './',
  plugins: [react(), ...(mode === 'singlefile' ? [viteSingleFile()] : [])],
  define: {
    __SINGLEFILE__: JSON.stringify(mode === 'singlefile'),
  },
  build: {
    target: 'es2022',
    outDir: mode === 'singlefile' ? 'dist-single' : 'dist',
    assetsInlineLimit: mode === 'singlefile' ? 100_000_000 : 4096,
    chunkSizeWarningLimit: 2000,
  },
  server: {
    host: true,
    port: 5173,
  },
}));
