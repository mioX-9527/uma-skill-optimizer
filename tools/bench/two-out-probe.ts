/**
 * 真实规模探针:「2出1入」邻域能否在现有管线的最终组合上找到改进?
 * 读 plan → optimize() 全开 → 从最终组合枚举全部预算内的 1出1入 与 2出1入 移动,
 * 直接用口径 A(12 点期望,与汇报口径一致)评估。
 * 1出1入 应该找不到改进(管线的交换阶段已收敛)——找不到即探针自身正确性的 sanity check。
 * 计费/互斥复用 model.ts 的复刻实现(与 src 同法,bench 口径一致性检查 9/9 OK)。
 * 用法: npx tsx tools/bench/two-out-probe.ts --plan app/_debug/plan_v2.json
 */
import { optimize } from '../../src/optimizer.js';
import { loadPlan } from './probe.js';
import {
  SKILL_INDEX, expandPool, skillsOf, totalSpent, costOf, isBlocked,
  ExpectedEvaluator, type Item, type RawCand,
} from './model.js';

const eps = 0.0005;

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i]!;
  if (a.startsWith('--')) args.set(a.slice(2), process.argv[i + 1] ?? '');
}
const planPath = args.get('plan') ?? 'app/_debug/plan_v2.json';

const { course, runner, budget, candidates } = loadPlan(planPath);
const usable = candidates.filter(c => {
  const sk = SKILL_INDEX.get(c.id);
  return sk !== undefined && c.pt <= budget && !isBlocked(sk, course, runner);
});
const items = expandPool(usable as readonly RawCand[]);
const all = new Map(items.map(i => [i.id, i] as const));

const res = optimize({ course, runner, candidates: usable, budget });
const chosenIds = res.chosen.map(c => c.id);
const chosen = chosenIds.map(id => {
  const it = all.get(id);
  if (it === undefined) throw new Error(`组合里的 ${id} 不在展开池`);
  return it;
});

const ev = new ExpectedEvaluator(course, runner);
const baseSec = ev.evaluate([]);
const currentSec = ev.evaluate(skillsOf(chosen));
const currentSpurt = ev.spurtTargetSpeed(skillsOf(chosen));
const currentBody = ((baseSec - currentSec) * currentSpurt) / 2.5;

console.log(`plan=${planPath}  候选 ${usable.length} 条  预算 ${budget}pt  已选 ${chosen.length} 项`);
console.log(`当前组合收益(探针) = ${currentBody.toFixed(3)} 马身  |  optimize 汇报 totalBody = ${res.totalBody.toFixed(3)} 马身`);

/** 移动评估:Δ秒按当前组合的末速换算马身(马身绝对值偏差 ~2%,不影响有无改进的判定) */
const deltaBodyOf = (set: readonly Item[]): number => {
  const sec = ev.evaluate(skillsOf(set));
  return ((currentSec - sec) * currentSpurt) / 2.5;
};

const pool = items.filter(i => !chosenIds.includes(i.id));
let checked1 = 0, checked2 = 0;
let best1: { out: Item; inn: Item; delta: number } | null = null;
let best2: { outs: readonly Item[]; inn: Item; delta: number } | null = null;

// 1出1入 sanity check(管线已收敛,应无改进)
for (const out of chosen) {
  const rest = chosen.filter(c => c !== out);
  const restIds = new Set(rest.map(c => c.id));
  const restSpent = totalSpent(rest, all);
  for (const inn of pool) {
    if (restSpent + costOf(inn, restIds, all) > budget) continue;
    checked1++;
    const delta = deltaBodyOf([...rest, inn]);
    if (delta > eps && (best1 === null || delta > best1.delta)) best1 = { out, inn, delta };
  }
}

// 2出1入(待验证的新邻域)
for (let x = 0; x < chosen.length; x++) {
  for (let y = x + 1; y < chosen.length; y++) {
    const outs = [chosen[x]!, chosen[y]!];
    const rest = chosen.filter(c => c !== outs[0] && c !== outs[1]);
    const restIds = new Set(rest.map(c => c.id));
    const restSpent = totalSpent(rest, all);
    for (const inn of pool) {
      if (restSpent + costOf(inn, restIds, all) > budget) continue;
      checked2++;
      const delta = deltaBodyOf([...rest, inn]);
      if (delta > eps && (best2 === null || delta > best2.delta)) best2 = { outs, inn, delta };
    }
  }
}

console.log(`\n1出1入:检查 ${checked1} 个移动 → ${best1 === null ? '无改进(管线已收敛,探针正常)' : `有改进 ${best1.delta.toFixed(3)} 马身(异常:管线没收敛?)`}`);
if (best1 !== null) console.log(`  「${best1.out.name}」→「${best1.inn.name}」+${best1.delta.toFixed(3)}`);
console.log(`2出1入:检查 ${checked2} 个移动 → ${best2 === null ? '无改进(真实规模下补这个邻域不会改变推荐)' : `有改进,最佳 +${best2.delta.toFixed(3)} 马身`}`);
if (best2 !== null) {
  console.log(`  「${best2.outs[0]!.name}」+「${best2.outs[1]!.name}」→「${best2.inn.name}」+${best2.delta.toFixed(3)} 马身`);
}
