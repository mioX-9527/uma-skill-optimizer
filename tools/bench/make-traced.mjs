/**
 * 生成 optimizer 的「带探针副本」:把每次模拟的 (技能集合 + 随机位置覆盖) 记下来,
 * 用来回答「同一个技能集合被重复模拟了多少次」。
 *
 * 为什么不直接改 src:这条探针只是审计工具,不该进生产代码路径。
 * 副本由本脚本从 src/optimizer.ts 原样派生,只插入计数代码。
 *
 * 用法: node tools/bench/make-traced.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const SRC = 'src/optimizer.ts';
const OUT = 'tools/bench/_traced/optimizer.traced.ts';

let code = readFileSync(SRC, 'utf8');

// 1) 修正相对导入(副本在 tools/bench/_traced/ 下)
code = code.replace(/from '\.\/engine\/index\.js'/g, "from '../../../src/engine/index.js'");
code = code.replace(/from '\.\/data\.js'/g, "from '../../../src/data.js'");

// 2) 注入探针
const anchor = `  const sim = (skills: readonly SkillConfig[], opts?: SimOptions): SimResult => {
    if (simsUsed >= maxSims) throw new Error(\`模拟次数超过上限 \${maxSims}\`);
    simsUsed++;
    return opts === undefined ? simulate(course, { ...runner, skills }) : simulate(course, { ...runner, skills }, opts);
  };`;

const traced = `  /** [探针] 每次记录一次; key 包含所有会影响模拟结果的因素 */
  const TRACE: { total: number; hits: Map<string, number> } = { total: 0, hits: new Map() };
  const simKey = (skills: readonly SkillConfig[], opts?: SimOptions): string => {
    const ids = skills.map(s => s.id).join(',');
    const ov = opts?.positionOverrides;
    const pos = ov === undefined || ov.size === 0
      ? ''
      : '|' + [...ov.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => \`\${k}@\${v.toFixed(3)}\`).join(',');
    return ids + pos;
  };
  const sim = (skills: readonly SkillConfig[], opts?: SimOptions): SimResult => {
    if (simsUsed >= maxSims) throw new Error(\`模拟次数超过上限 \${maxSims}\`);
    simsUsed++;
    TRACE.total++;
    const k = simKey(skills, opts);
    TRACE.hits.set(k, (TRACE.hits.get(k) ?? 0) + 1);
    return opts === undefined ? simulate(course, { ...runner, skills }) : simulate(course, { ...runner, skills }, opts);
  };`;

if (!code.includes(anchor)) {
  console.error('[make-traced] 未找到 sim 闭包锚点 —— src/optimizer.ts 结构变了,请同步本脚本');
  process.exit(1);
}
code = code.replace(anchor, traced);

// 3) 导出探针数据
if (!code.includes('export function optimize(')) {
  console.error('[make-traced] 未找到 optimize 导出');
  process.exit(1);
}
code = code.replace(
  'export function optimize(',
  `/** [探针] 最近一次 optimize 的模拟记录 */
export const __trace = { total: 0, hits: new Map<string, number>() };

export function optimize(`,
);
code = code.replace(
  'const TRACE: { total: number; hits: Map<string, number> } = { total: 0, hits: new Map() };',
  'const TRACE: { total: number; hits: Map<string, number> } = __trace;',
);

mkdirSync('tools/bench/_traced', { recursive: true });
writeFileSync(OUT, code, 'utf8');
console.log(`已生成 ${OUT}(${code.length} 字节)`);
