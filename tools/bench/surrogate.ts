/**
 * 替代目标(surrogate)偏差实验。
 *
 * 背景:optimizer 的**搜索**用 simSearch(随机取位技能固定在区段中点,1 次模拟),
 * 而**汇报**用 simExpected(12 点等距期望)。两者若给出不同的排序,
 * 等于"优化的是 A、报告的是 B"。
 *
 * 本实验量化三件事:
 *   1. 同一组合在两种口径下的完赛时间差有多大(秒 / 马身)
 *   2. 随机两个组合的**排序**在两种口径下是否一致(不一致率)
 *   3. 在贪心的每一步,按两种口径挑出来的"下一步最优候选"是否是同一个(这是最关键的)
 *
 * 用法: npx tsx tools/bench/surrogate.ts --plan app/_debug/plan_v2.json [--samples 20]
 */
import { loadPlan } from './probe.js';
import { SKILL_INDEX, expandPool, skillsOf, totalSpent, isBlocked, ExpectedEvaluator, type Item, type RawCand } from './model.js';
import { combine } from './model.js';
import type { Course, Region, RunnerConfig, SkillConfig } from '../../src/engine/index.js';
import { simulate, sampleableSpans } from '../../src/engine/index.js';

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** 单个随机技能的区段中点 = simSearch 的口径 */
function midpointOf(course: Course, s: SkillConfig, spansCache: Map<string, readonly Region[] | null>): number {
  const spans = spansCache.get(s.id)!;
  let target = 0.5 * spans!.reduce((a, r) => a + (r[1] - r[0]), 0);
  for (const r of spans!) {
    const len = r[1] - r[0];
    if (target <= len) return r[0] + target;
    target -= len;
  }
  return spans![spans!.length - 1]![1];
}

function simSearchSec(course: Course, runner: RunnerConfig, skills: readonly SkillConfig[], spansCache: Map<string, readonly Region[] | null>): number {
  const randoms = skills.filter(s => spansCache.get(s.id) !== null);
  if (randoms.length === 0) return simulate(course, { ...runner, skills }).finishTimeSec;
  const ov = new Map(randoms.map(s => [s.id, midpointOf(course, s, spansCache)] as const));
  return simulate(course, { ...runner, skills }, { positionOverrides: ov }).finishTimeSec;
}

function main(): void {
  const args = new Map<string, string>();
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i]!;
    if (a.startsWith('--')) args.set(a.slice(2), process.argv[i + 1] ?? '');
  }
  const planPath = args.get('plan') ?? 'app/_debug/plan_v2.json';
  const samples = Number(args.get('samples') ?? 20);
  const budgetCap = Number(args.get('budget') ?? 2034);

  const loaded = loadPlan(planPath);
  const { course, runner, candidates } = loaded;
  const ev = new ExpectedEvaluator(course, runner);
  const bodyPerSec = ev.spurtTargetSpeed([]) / 2.5;

  const usable = candidates.filter(c => {
    const sk = SKILL_INDEX.get(c.id);
    return sk !== undefined && c.pt <= budgetCap && !isBlocked(sk, course, runner);
  });
  const items = expandPool(usable);
  const allMap = new Map(items.map(i => [i.id, i] as const));
  const spansCache = new Map<string, readonly Region[] | null>();
  for (const sk of SKILL_INDEX.values()) {
    spansCache.set(sk.id, sk.randomPosition === true ? sampleableSpans(sk.condition, course) : null);
  }
  console.log(`=== 替代目标偏差实验 ${planPath}`);
  console.log(`可用候选 ${items.length} 条,抽样 ${samples} 个基准组合,换算 ${bodyPerSec.toFixed(3)} 马身/秒\n`);

  const rnd = lcg(20261026);
  const sets: Item[][] = [];
  for (let i = 0; i < 60 && sets.length < samples; i++) {
    const n = 2 + Math.floor(rnd() * 5);
    const pick: Item[] = [];
    const pool = items.slice();
    for (let j = 0; j < n; j++) {
      const k = Math.floor(rnd() * pool.length);
      pick.push(pool[k]!);
      pool.splice(k, 1);
    }
    if (totalSpent(pick, allMap) <= budgetCap) sets.push(pick);
  }

  // 1) 同一组合两口径的差值
  let maxDiff = 0;
  let sumDiff = 0;
  let sumBias = 0;
  const secSearch: number[] = [];
  const secExp: number[] = [];
  for (const s of sets) {
    const skills = skillsOf(s);
    const a = simSearchSec(course, runner, skills, spansCache);
    const b = ev.evaluate(skills);
    secSearch.push(a);
    secExp.push(b);
    maxDiff = Math.max(maxDiff, Math.abs(a - b));
    sumDiff += Math.abs(a - b);
    sumBias += a - b;
  }
  console.log(`1) 组合层面的口径差 |搜索口径 − 期望口径|`);
  console.log(`   平均 ${(sumDiff / sets.length).toFixed(4)}s (${((sumDiff / sets.length) * bodyPerSec).toFixed(3)} 马身)`);
  console.log(`   最大 ${maxDiff.toFixed(4)}s (${(maxDiff * bodyPerSec).toFixed(3)} 马身)`);
  console.log(`   平均偏差(搜索−期望,正=搜索偏慢) ${(sumBias / sets.length).toFixed(4)}s\n`);

  // 2) 两两排序一致性
  let pairs = 0;
  let disagree = 0;
  const eps = 0.0005;
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      const ds = secSearch[i]! - secSearch[j]!;
      const de = secExp[i]! - secExp[j]!;
      if (Math.abs(de) < eps) continue;   // 期望口径下几乎打平,不问排序
      pairs++;
      if (Math.sign(ds) !== Math.sign(de) || Math.abs(ds) < eps) disagree++;
    }
  }
  console.log(`2) 两两排序一致性(${pairs} 对有效比较)`);
  console.log(`   两种口径给出不同胜负的组合对数: ${disagree} (${((disagree / Math.max(1, pairs)) * 100).toFixed(1)}%)\n`);

  // 3) 贪心"下一步选谁"是否一致 —— 最关键的检验
  let steps = 0;
  let pickDiff = 0;
  let sumLossBody = 0;
  let maxLossBody = 0;
  for (const s of sets) {
    const baseSkills = skillsOf(s);
    const chosenIds = new Set(s.map(i => i.id));
    const curSearch = simSearchSec(course, runner, baseSkills, spansCache);
    const curExp = ev.evaluate(baseSkills);
    let bestS: { id: string; ratio: number } | null = null;
    let bestE: { id: string; ratio: number; gain: number } | null = null;
    for (const cand of items) {
      if (chosenIds.has(cand.id)) continue;
      const cost = totalSpent([...s, cand], allMap) - totalSpent(s, allMap);
      if (cost <= 0) continue;
      const next = skillsOf([...s, cand]);
      const expensive = next.length > baseSkills.length;
      if (!expensive) continue;                       // 装进去没多任何技能(被 ◎ 顶掉之类),跳过
      const gS = curSearch - simSearchSec(course, runner, next, spansCache);
      const gE = curExp - ev.evaluate(next);
      const rS = gS / cost;
      const rE = gE / cost;
      if (bestS === null || rS > bestS.ratio) bestS = { id: cand.id, ratio: rS };
      if (bestE === null || rE > bestE.ratio) bestE = { id: cand.id, ratio: rE, gain: gE };
    }
    if (bestS === null || bestE === null) continue;
    steps++;
    if (bestS.id !== bestE.id) {
      pickDiff++;
      const lossBody = (bestE.gain - gainOf(skillsOf([...s, allMap.get(bestS.id)!]), ev, curExp)) * bodyPerSec;
      sumLossBody += Math.max(0, lossBody);
      maxLossBody = Math.max(maxLossBody, lossBody);
    }
  }
  console.log(`3) 贪心"下一步最优候选"是否一致(${steps} 个决策点)`);
  console.log(`   两种口径挑中不同候选的决策点: ${pickDiff} (${((pickDiff / Math.max(1, steps)) * 100).toFixed(1)}%)`);
  console.log(`   按错口径选错造成的期望收益损失: 平均 ${(sumLossBody / Math.max(1, steps)).toFixed(4)} 马身,最大 ${maxLossBody.toFixed(4)} 马身`);
  console.log(`   (注:单步损失小不代表累计损失小 —— 贪心每一步都按错口径排序会累积偏差)`);
}

function gainOf(
  skills: readonly SkillConfig[],
  ev: ExpectedEvaluator,
  curExp: number,
): number {
  return curExp - ev.evaluate(skills);
}

void main();
