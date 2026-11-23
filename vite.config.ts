import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API_TARGET = process.env.API_URL || 'http://127.0.0.1:4321';

export default defineConfig({
  plugins: [react()],
  publicDir: false,
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': {
        target: API_TARGET,
        changeOrigin: false,
      },
      '/mock': {
        target: API_TARGET,
        changeOrigin: false,
      },
      '/proxy': {
        target: API_TARGET,
        changeOrigin: false,
      },
      '/media': {
        target: API_TARGET,
        changeOrigin: false,
      },
    },
  },
});
