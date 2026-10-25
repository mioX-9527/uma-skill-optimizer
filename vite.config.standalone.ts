import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

/** 单文件构建:全部 JS/CSS 内联进一个 HTML,双击即可用 file:// 直接打开(无需 Node) */
export default defineConfig({
  root: 'web',
  base: './',
  plugins: [react(), viteSingleFile()],
  build: { outDir: '../dist-standalone', emptyOutDir: true },
});
