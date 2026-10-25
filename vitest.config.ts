import { defineConfig } from 'vitest/config';

// 独立配置,避免 vitest 读取 vite.config.ts 中的 root:'web' 导致测试根目录跑偏
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
});
