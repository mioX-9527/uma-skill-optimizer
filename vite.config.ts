import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'web',
  plugins: [react()],
  server: { port: 5183 },
  build: { outDir: '../dist-web', emptyOutDir: true },
});
