/**
 * 重复模拟统计(用 make-traced.mjs 生成的带探针副本)。
 *
 * 回答三个问题:
 *   - 一次 optimize 里同一个「技能集合 + 随机位置」被完整重跑了多少次
 *   - 换成缓存能把总耗时降多少
 *   - 各个阶段分别重复了多少
 *
 * 用法:
 *   node tools/bench/make-traced.mjs
 *   npx tsx tools/bench/dupes.ts --plan app/_debug/plan_v2.json
 */
import { __trace, optimize } from './_traced/optimizer.traced.js';
import { loadPlan } from './probe.js';
import type { OptimizerStages } from '../../src/optimizer.js';

const LADDER: readonly (readonly [string, OptimizerStages])[] = [
  ['L0 纯贪心', { swap: false, twoOutSwap: false, spendDown: false, polish: false }],
  ['L1 +1换1交换', { swap: true, twoOutSwap: false, spendDown: false, polish: false }],
  ['L2 +预算花完', { swap: true, twoOutSwap: false, spendDown: true, polish: false }],
  ['L3 +2换1', { swap: true, twoOutSwap: true, spendDown: true, polish: false }],
  ['L4 +期望复核(现状)', { swap: true, twoOutSwap: true, spendDown: true, polish: true }],
];

function resetTrace(): void {
  __trace.total = 0;
  __trace.hits.clear();
}

function main(): void {
  const args = new Map<string, string>();
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i]!;
    if (a.startsWith('--')) args.set(a.slice(2), process.argv[i + 1] ?? '');
  }
  const planPath = args.get('plan') ?? 'app/_debug/plan_v2.json';
  const { course, runner, candidates, budget } = loadPlan(planPath);

  console.log(`=== 重复模拟统计 ${planPath}(${candidates.length} 候选 / ${budget}pt)`);
  console.log('阶段                       总模拟   不同场景   重复次数   重复率   可省模拟   耗时ms');
  for (const [label, stages] of LADDER) {
    resetTrace();
    const t0 = Date.now();
    optimize({ course, runner, candidates, budget, stages });
    const ms = Date.now() - t0;
    const total = __trace.total;
    const distinct = __trace.hits.size;
    const dup = total - distinct;
    console.log(
      label.padEnd(24),
      String(total).padStart(7),
      String(distinct).padStart(9),
      String(dup).padStart(9),
      `${((dup / Math.max(1, total)) * 100).toFixed(1)}%`.padStart(8),
      String(dup).padStart(9),
      String(ms).padStart(8),
    );
  }

  // 最常被重复模拟的场景 top5
  resetTrace();
  optimize({ course, runner, candidates, budget });
  const top = [...__trace.hits.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  console.log('\n被重跑最多的场景(技能集合 → 次数):');
  for (const [k, n] of top) {
    const head = k.split('|')[0]!;
    const ids = head === '' ? '(空手基线)' : head.split(',').length + ' 个技能';
    console.log(`  ${String(n).padStart(4)} 次  ${ids.padEnd(10)} ${k.slice(0, 90)}`);
  }
  const total = __trace.total;
  const distinct = __trace.hits.size;
  console.log(`\n合计: ${total} 次模拟 / ${distinct} 个不同场景 → 加缓存后最多降到 ${distinct} 次(省 ${total - distinct} 次, ${(((total - distinct) / total) * 100).toFixed(1)}%)`);
}

void main();
