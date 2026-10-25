// 将单文件构建产物复制为根目录 打开规划器.html(直接双击启动的方式)
import { copyFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(resolve(root, 'dist-standalone'), { recursive: true });
copyFileSync(resolve(root, 'dist-standalone/index.html'), resolve(root, '打开规划器.html'));
console.log('[standalone] 已生成 打开规划器.html(双击即可使用,无需安装 Node)');
