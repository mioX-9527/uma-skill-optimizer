#!/usr/bin/env node
/**
 * 从本地 uma-race-sim 仓库同步引擎/分析源码与数据到本项目。
 *
 * 源(默认 ../uma-race-sim,可用 --from 覆盖):
 *   packages/engine/src   → src/engine   (逐文件复制)
 *   packages/analysis/src → src/analysis (ablate.ts 中 @uma-race-sim/engine 改写为相对导入)
 *   data/skills.json      → data/skills.json
 *   data/courses.json     → data/courses.json
 *
 * 本项目不把引擎当 npm 依赖(避免跨仓 file: 链接),采用"vendor 复制 + 本脚本重同步"。
 * 引擎更新后跑一次 `npm run sync` 即可。
 */
import { cpSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const argIdx = process.argv.indexOf('--from');
const from = argIdx >= 0 ? resolve(process.argv[argIdx + 1]) : resolve(projectRoot, '../uma-race-sim');

const mustExist = p => {
  if (!existsSync(p)) {
    console.error(`[sync] 找不到 ${p}\n  请确认 uma-race-sim 仓库位置,或用 --from <路径> 指定。`);
    process.exit(1);
  }
};
mustExist(from);
const engineSrc = join(from, 'packages/engine/src');
const analysisSrc = join(from, 'packages/analysis/src');
const dataSrc = join(from, 'data');
mustExist(engineSrc);
mustExist(analysisSrc);
mustExist(join(dataSrc, 'skills.json'));
mustExist(join(dataSrc, 'courses.json'));

function copyTree(srcDir, destDir) {
  rmSync(destDir, { recursive: true, force: true });
  mkdirSync(destDir, { recursive: true });
  for (const name of readdirSync(srcDir)) {
    const p = join(srcDir, name);
    if (statSync(p).isDirectory()) copyTree(p, join(destDir, name));
    else writeFileSync(join(destDir, name), readFileSync(p));
  }
}

copyTree(engineSrc, join(projectRoot, 'src/engine'));
copyTree(analysisSrc, join(projectRoot, 'src/analysis'));

// analysis → engine 的唯一跨包引用改写为相对导入(../engine/index.js: src/analysis → src/engine)
const ablatePath = join(projectRoot, 'src/analysis/ablate.ts');
const ablate = readFileSync(ablatePath, 'utf8');
const rewritten = ablate
  .replace(/from '@uma-race-sim\/engine'/g, "from '../engine/index.js'")
  .replace(/from '@uma-race-sim\/engine\/test\/(.*)'/g, "from '../engine/test/$1'");
if (rewritten === ablate && ablate.includes('@uma-race-sim/')) {
  console.error('[sync] 警告: analysis 中存在未识别的 @uma-race-sim 引用,请手动检查 src/analysis');
}
writeFileSync(ablatePath, rewritten);

mkdirSync(join(projectRoot, 'data'), { recursive: true });
for (const f of ['skills.json', 'courses.json']) {
  writeFileSync(join(projectRoot, 'data', f), readFileSync(join(dataSrc, f)));
}

// 记录同步来源与版本,便于追溯
let version = null;
const versionPath = join(dataSrc, 'version.json');
if (existsSync(versionPath)) {
  try { version = JSON.parse(readFileSync(versionPath, 'utf8')); } catch { /* 忽略 */ }
}
writeFileSync(
  join(projectRoot, 'data/SYNC_INFO.json'),
  JSON.stringify({ syncedAt: new Date().toISOString(), from, version }, null, 2) + '\n',
);

console.log(`[sync] 完成: engine/analysis 源码与 skills/courses 数据已同步自 ${from}`);

// 自动重新生成根目录单文件版(打开规划器.html),保持与引擎/数据同步;依赖未装时跳过并提示
const viteInstalled = existsSync(join(projectRoot, 'node_modules/vite'));
if (!viteInstalled) {
  console.log('[sync] 跳过 打开规划器.html 重新生成(未安装依赖);请先 npm install 再跑一次 npm run sync');
} else {
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync('npm', ['run', 'web:standalone'], { cwd: projectRoot, stdio: 'inherit', shell: true });
  if (r.status !== 0) {
    console.error('[sync] 警告: 打开规划器.html 重新生成失败(网页版源码已同步,可手动跑 npm run web:standalone)');
  }
}
