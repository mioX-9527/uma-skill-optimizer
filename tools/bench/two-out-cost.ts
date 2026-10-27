/**
 * 2出1入 阶段的收益 / 成本对照（P1 的验收脚本）。
 *
 * 用法:
 *   npx tsx tools/bench/two-out-cost.ts                       # 跑 app/_debug 下三份 plan
 *   npx tsx tools/bench/two-out-cost.ts --plan app/_debug/plan_v2.json
 *
 * 为什么单独一支:这个阶段是**默认开启**的,改它等于改所有人的求解时间。
 * 它的收益必须同时给出「找到多少马身」和「多花多少次模拟 / 多少毫秒」,
 * 只报收益等于默认放行一次隐性性能回归(2026-10-27 实测 +125% 模拟次数)。
 *
 * 只做 A/B 对照,不验证最优性 —— 那由 test/optimizer.stages.test.ts 与 bench 负责。
 */
import { readFileSync } from 'node:fs';
import { COURSES, SKILLS } from '../../src/data.js';
import { lookup } from '../../src/lookup.js';
import { optimize } from '../../src/optimizer.js';
import type { Course, RunnerConfig } from '../../src/engine/index.js';

const DEFAULT_PLANS = ['app/_debug/plan_v2.json', 'app/_debug/plan_final.json', 'app/_debug/plan_evo2.json'];

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i]!;
  if (!a.startsWith('--')) continue;
  const next = process.argv[i + 1];
  if (next !== undefined && !next.startsWith('--')) {
    args.set(a.slice(2), next);
    i++;
  } else args.set(a.slice(2), '');
}
const only = args.get('plan');
const plans = only !== undefined && only !== '' ? [only] : DEFAULT_PLANS;

/** 与 cli.ts 同法解析 plan(按 id 取技能、按名称取赛道、chains → requires) */
function loadPlan(path: string) {
  const plan = JSON.parse(readFileSync(path, 'utf8'));
  const cr = lookup(COURSES, c => [c.name], plan.course);
  if (!cr.value) throw new Error(`赛道没找到: ${plan.course}`);
  const course: Course = cr.value;
  const runner: RunnerConfig = { ...plan.runner, skills: [] };
  const ids = new Set<string>(plan.skills.map((s: { id: string }) => s.id));
  const chainMap = new Map<string, string>(
    (plan.chains ?? []).map((c: { skillId: string; prereqId: string }) => [String(c.skillId), String(c.prereqId)]),
  );
  const candidates = plan.skills.map((s: { id: string; pt: number }) => {
    const skill = SKILLS.find(k => k.id === s.id);
    if (!skill) throw new Error(`技能没找到: ${s.id}`);
    const req = chainMap.get(s.id);
    return { id: s.id, pt: s.pt, ...(req !== undefined && ids.has(req) ? { requires: req } : {}) };
  });
  return { course, runner, candidates, budget: plan.budget as number };
}

const ON = { swap: true, spendDown: true, polish: true, groupSwap: true, twoOutSwap: true } as const;
const OFF = { ...ON, twoOutSwap: false } as const;

console.log('plan        预算   | 关掉 2换1                       | 开启 2换1                       | Δ');
for (const path of plans) {
  let p;
  try {
    p = loadPlan(path);
  } catch (e) {
    console.log(`${path}  跳过: ${(e as Error).message}(app/_debug 是本地调试产物,不进仓库)`);
    continue;
  }
  const t0 = performance.now();
  const off = optimize({ ...p, stages: OFF });
  const t1 = performance.now();
  const on = optimize({ ...p, stages: ON });
  const t2 = performance.now();
  const d = on.totalBody - off.totalBody;
  const name = (path.split('/').pop() ?? path).replace('.json', '');
  console.log(
    `${name.padEnd(11)} ${String(p.budget).padStart(4)}  | `
    + `${off.totalBody.toFixed(3)}马身 ${off.chosen.length}项 ${String(off.simsUsed).padStart(4)}次 ${(t1 - t0).toFixed(0)}ms`.padEnd(32)
    + `| ${on.totalBody.toFixed(3)}马身 ${on.chosen.length}项 ${String(on.simsUsed).padStart(4)}次 ${(t2 - t1).toFixed(0)}ms`.padEnd(32)
    + `| ${d >= 0 ? '+' : ''}${d.toFixed(3)}马身 / ${on.simsUsed - off.simsUsed >= 0 ? '+' : ''}${on.simsUsed - off.simsUsed}次`,
  );
}
