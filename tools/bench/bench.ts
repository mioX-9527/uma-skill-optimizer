/**
 * 技能规划器算法基准测试(只读)。
 *
 *   穷举:小规模候选池上遍历所有满足 PT 约束的子集 → 真实最优解
 *   对照:把现有算法按「阶段阶梯」拆开,量化每阶段的实际贡献
 *   复核:用独立抽样口径(ablate 式 LHS)重算最终候选,检查是否只是估计口径巧合
 *
 * 用法:
 *   npx tsx tools/bench/bench.ts --plan app/_debug/plan_v2.json [--k 10] [--budget 1200] [--instances 5]
 *
 * 输出:stdout 文本表 + tools/bench/results/*.json
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { optimize, type OptimizerStages, type OptimizerResult } from '../../src/optimizer.js';
import type { Course, RunnerConfig } from '../../src/engine/index.js';
import { loadPlan } from './probe.js';
import { SKILL_INDEX, expandPool, combine, skillsOf, totalSpent, isBlocked, ExpectedEvaluator, toBody, type Item, type RawCand } from './model.js';

/** 阶段阶梯:逐级打开,量化每个阶段的实际贡献 */
const LADDER: readonly (readonly [string, OptimizerStages])[] = [
  ['L0 纯贪心', { swap: false, twoOutSwap: false, spendDown: false, polish: false }],
  ['L1 +1换1交换', { swap: true, twoOutSwap: false, spendDown: false, polish: false }],
  ['L2 +预算花完', { swap: true, twoOutSwap: false, spendDown: true, polish: false }],
  ['L3 +2换1', { swap: true, twoOutSwap: true, spendDown: true, polish: false }],
  ['L4 +期望复核(现状)', { swap: true, twoOutSwap: true, spendDown: true, polish: true }],
];

/** 确定性伪随机(便于复现的实例生成) */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

interface Instance {
  readonly name: string;
  readonly budget: number;
  readonly cands: readonly RawCand[];
}

/** 稀释后的候选池:按单项收益排前的 M 条(让实例里近似的选项更多,更像真难题) */
function rankUsableBySolo(
  all: readonly RawCand[],
  course: Course,
  runner: RunnerConfig,
  budget: number,
  ev: ExpectedEvaluator,
): readonly RawCand[] {
  const usable = all.filter(c => {
    const sk = SKILL_INDEX.get(c.id);
    if (sk === undefined) return false;
    if (c.pt > budget) return false;
    return !isBlocked(sk, course, runner);
  });
  const base = ev.evaluate([]);
  const items = expandPool(usable);
  const scored = items.map(i => ({ id: i.id, sec: base - ev.evaluate(skillsOf([i])) }));
  const rank = new Map(scored.map(s => [s.id, s.sec] as const));
  return usable.slice().sort((a, b) => (rank.get(b.id) ?? 0) - (rank.get(a.id) ?? 0));
}

/** 从完整候选里挑小规模子集 */
function buildInstances(
  pool: readonly RawCand[],
  budget: number,
  k: number,
  count: number,
  seed: number,
): Instance[] {
  const out: Instance[] = [];
  const rnd = lcg(seed);
  for (let i = 0; i < count; i++) {
    const p = pool.slice();
    // Fisher-Yates(用确定性 LCG,保证可复现)
    for (let j = p.length - 1; j > 0; j--) {
      const r = Math.floor(rnd() * (j + 1));
      [p[j], p[r]] = [p[r]!, p[j]!];
    }
    out.push({ name: `k${k}-b${budget}-#${i + 1}`, budget, cands: p.slice(0, k) });
  }
  return out;
}

interface VariantRow {
  readonly level: string;
  readonly sec: number;
  readonly pt: number;
  readonly nChosen: number;
  readonly body: number;
  readonly gapSec: number;
  readonly gapBody: number;
  readonly sims: number;
  readonly ms: number;
  readonly ids: readonly string[];
}

function runVariant(
  cands: readonly RawCand[],
  budget: number,
  course: Course,
  runner: RunnerConfig,
  stages: OptimizerStages,
  ev: ExpectedEvaluator,
  baseSec: number,
  optSec: number,
  optIds: readonly string[],
): VariantRow {
  const t0 = Date.now();
  const r: OptimizerResult = optimize({ course, runner, candidates: cands, budget, ...(Object.keys(stages).length > 0 ? { stages } : {}) });
  const ms = Date.now() - t0;
  const items = new Map(expandPool(cands).map(i => [i.id, i] as const));
  const chosenItems = r.chosen.map(c => items.get(c.id)!);
  const sec = ev.evaluate(skillsOf(chosenItems));
  const bodyPerSec = ev.spurtTargetSpeed(skillsOf(chosenItems)) / 2.5;
  return {
    level: '',
    sec,
    pt: r.totalPt,
    nChosen: r.chosen.length,
    body: (baseSec - sec) * bodyPerSec,
    gapSec: sec - optSec,
    gapBody: (sec - optSec) * bodyPerSec,
    sims: r.simsUsed,
    ms,
    ids: optIds.length === 0 ? optIds : r.chosen.map(c => c.id),
  };
}

/** 穷举:所有子集 → 满足预算的最优组合(同形子集缓存,顺带统计重复) */
function bruteForce(
  cands: readonly RawCand[],
  budget: number,
  ev: ExpectedEvaluator,
  opts: { useCache?: boolean } = {},
): {
  bestSec: number;
  bestIds: readonly string[];
  bestPt: number;
  evaluated: number;
  cacheHits: number;
  infeasible: number;
  allSecs: { ids: string[]; sec: number; pt: number; key: string }[];
} {
  const useCache = opts.useCache !== false;
  const items = expandPool(cands);
  const allMap = new Map(items.map(i => [i.id, i] as const));
  const best = { sec: Number.POSITIVE_INFINITY, ids: [] as string[], pt: 0 };
  interface Row { ids: string[]; sec: number; pt: number; key: string }
  const allSecs: Row[] = [];
  const cache = new Map<string, number>();
  let evaluated = 0;
  let cacheHits = 0;
  let infeasible = 0;
  const n = items.length;
  for (let mask = 0; mask < 1 << n; mask++) {
    const subset: Item[] = [];
    for (let b = 0; b < n; b++) if ((mask & (1 << b)) !== 0) subset.push(items[b]!);
    const pt = totalSpent(subset, allMap);
    if (pt > budget) { infeasible++; continue; }
    const skills = skillsOf(subset);
    const key = skills.map(s => s.id).join(',');
    let sec = useCache ? cache.get(key) : undefined;
    if (sec === undefined) {
      sec = ev.evaluate(skills);
      evaluated++;
      cache.set(key, sec);
    } else cacheHits++;
    allSecs.push({ ids: subset.map(i => i.id).sort(), sec, pt, key });
    if (sec < best.sec - 1e-12) { best.sec = sec; best.ids = subset.map(i => i.id); best.pt = pt; }
  }
  allSecs.sort((a, b) => a.sec - b.sec);
  return { bestSec: best.sec, bestIds: best.ids, bestPt: best.pt, evaluated, cacheHits, infeasible, allSecs };
}

function fmt(n: number, w: number, d = 3): string {
  return n.toFixed(d).padStart(w);
}

function numList(v: string | undefined, def: readonly number[]): number[] {
  if (v === undefined || v === '') return [...def];
  return v.split(',').map(s => Number(s.trim())).filter(n => Number.isFinite(n));
}

function main(): void {
  const args = new Map<string, string>();
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i]!;
    if (a.startsWith('--')) args.set(a.slice(2), process.argv[i + 1] ?? '');
  }
  const planPath = args.get('plan') ?? 'app/_debug/plan_v2.json';
  const budgets = numList(args.get('budgets'), [Number(args.get('budget') ?? 1200)]);
  const ks = numList(args.get('k'), [10]);
  const nInstances = Number(args.get('instances') ?? 3);
  const seed = Number(args.get('seed') ?? 20261026);
  const topPool = Number(args.get('topPool') ?? 16);
  const topN = Number(args.get('holdoutTop') ?? 12);
  const holdoutDraws = Number(args.get('holdoutDraws') ?? 24);

  const loaded = loadPlan(planPath);
  const { course, runner, candidates: all } = loaded;
  const ev = new ExpectedEvaluator(course, runner);
  const baseSec = ev.evaluate([]);
  const bodyPerSecBase = ev.spurtTargetSpeed([]) / 2.5;

  console.log(`=== 基准: ${planPath}`);
  console.log(`赛道 ${course.name} ${course.distance}m | 空手基线 ${baseSec.toFixed(4)}s | 换算 ${bodyPerSecBase.toFixed(3)} 马身/秒`);
  console.log(`配置: 候选规模 k=${ks.join('/')} 预算=${budgets.join('/')} 每档 ${nInstances} 个实例 seed=${seed} 取样池=单项收益前 ${topPool} 条 holdout=${holdoutDraws}组\n`);

  mkdirSync('tools/bench/results', { recursive: true });
  const report: Record<string, unknown>[] = [];

  for (const k of ks) {
    for (const budget of budgets) {
      const pool = rankUsableBySolo(all, course, runner, budget, ev).slice(0, topPool);
      if (pool.length < k) { console.log(`跳过 k=${k}/budget=${budget}:可用候选只有 ${pool.length} 条`); continue; }
      for (const inst of buildInstances(pool, budget, k, nInstances, seed + k * 7919 + budget)) {
        runInstance(inst, course, runner, ev, baseSec, bodyPerSecBase, topN, holdoutDraws, report);
      }
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outPath = `tools/bench/results/bench-${stamp}.json`;
  writeFileSync(outPath, JSON.stringify({ plan: planPath, ks, budgets, nInstances, seed, topPool, holdoutDraws, report }, null, 2));
  console.log(`\n结果 JSON → ${outPath}`);
}

function runInstance(
  inst: Instance,
  course: Course,
  runner: RunnerConfig,
  ev: ExpectedEvaluator,
  baseSec: number,
  bodyPerSecBase: number,
  topN: number,
  holdoutDraws: number,
  report: Record<string, unknown>[],
): void {
  console.log(`──────── 实例 ${inst.name}(${inst.cands.length} 候选, 预算 ${inst.budget}pt)`);
  console.log(`   候选: ${inst.cands.map(c => SKILL_INDEX.get(c.id)?.name ?? c.id).join('、')}`);
  const t0 = Date.now();
  const bf = bruteForce(inst.cands, inst.budget, ev);
  const bfMs = Date.now() - t0;
  const optBody = (baseSec - bf.bestSec) * bodyPerSecBase;

  // 一致性校验:bench 的复刻口径必须与 optimize 汇报的值完全一致
  const full = optimize({ course, runner, candidates: inst.cands, budget: inst.budget });
  const itemsMap = new Map(expandPool(inst.cands).map(i => [i.id, i] as const));
  const chosenItems = full.chosen.map(c => itemsMap.get(c.id)!);
  const paritySec = ev.evaluate(skillsOf(chosenItems));
  const parityOk = Math.abs(paritySec - full.finalSec) < 1e-9;

  console.log(`穷举: 可行组合 ${bf.evaluated + bf.cacheHits} 个(其中 ${bf.cacheHits} 个与已算过的技能集合完全相同,走缓存), 超预算 ${bf.infeasible} 个, 耗时 ${bfMs}ms`);
  console.log(`最优 ${bf.bestSec.toFixed(5)}s (${optBody.toFixed(3)} 马身) 花费 ${bf.bestPt}pt  组合=[${bf.bestIds.map(id => itemsMap.get(id)?.name ?? id).join(' + ')}]`);
  console.log(`口径一致性检查: bench 复刻 vs optimize 汇报 = ${parityOk ? 'OK' : `不一致! ${paritySec} vs ${full.finalSec}`}`);

  const rows: VariantRow[] = LADDER.map(([label, stages]) => {
    const r = runVariant(inst.cands, inst.budget, course, runner, stages, ev, baseSec, bf.bestSec, bf.bestIds);
    return { ...r, level: label };
  });

  console.log('\n阶段                        收益(马身)   总PT  项数   与最优差(马身)   模拟次数   耗时ms');
  for (const r of rows) {
    console.log(
      r.level.padEnd(24),
      fmt(r.body, 10, 3),
      String(r.pt).padStart(6),
      String(r.nChosen).padStart(4),
      fmt(r.gapBody, 13, 3),
      String(r.sims).padStart(9),
      String(r.ms).padStart(8),
    );
  }

  // ── 独立复核:换成「各随机技能独立抽样」的口径,看名次是否稳定 ──
  const top = bf.allSecs.slice(0, topN);
  const holdout = top.map(t => {
    const subset = t.ids.map(id => itemsMap.get(id)!);
    const h = ev.evaluateIndependent(skillsOf(subset), holdoutDraws);
    return { names: t.ids.map(id => itemsMap.get(id)?.name ?? id), secA: t.sec, secB: h.mean, ci: h.ci };
  });
  const byB = holdout.slice().sort((a, b) => a.secB - b.secB);
  console.log(`\n独立复核(各随机技能独立 LHS,${holdoutDraws} 组;与产品算法的「同一分位」口径不同):`);
  console.log('      A口径(s)     B口径(s)      B±CI    技能组合');
  for (const h of byB.slice(0, 5)) {
    console.log('  ', fmt(h.secA, 10, 5), fmt(h.secB, 10, 5), ('±' + h.ci.toFixed(4)).padStart(9), '  ' + h.names.join(' + ').slice(0, 70));
  }
  const bestA = bf.bestIds.slice().sort().join(',');
  const bestBIds = bf.allSecs.find(x => Math.abs(x.sec - byB[0]!.secA) < 1e-12)?.ids;
  const bestB = (bestBIds ?? []).slice().sort().join(',');
  const same = bestA === bestB;
  console.log(`两口径最优一致? ${same ? '一致' : '不一致(A/B 给出不同的最优组合)'}`);

  report.push({
    instance: inst.name, budget: inst.budget, k: inst.cands.length,
    bruteForce: { bestSec: bf.bestSec, bestIds: bf.bestIds, bestPt: bf.bestPt, evaluated: bf.evaluated, cacheHits: bf.cacheHits, infeasible: bf.infeasible, ms: bfMs },
    parityOk,
    ladder: rows,
    holdoutTop: byB.slice(0, 5),
    holdoutAgrees: same,
  });
  console.log('');
}

void main();
