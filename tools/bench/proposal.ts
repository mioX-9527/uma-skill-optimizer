/**
 * 候选改进方案的**先算后改**实验台。
 *
 * 不改 src,而是在 bench 里把「贪心 + 各邻域」重新实现一遍,用同一套 PT 计费、
 * 同一套互斥规则、同一个收益口径,先验证它能复刻现有算法(L0),再往上加:
 *
 *   N1 1出1入(现有)  N2 2出1入(缺)  N3 2出2入(缺)  N4 1出2~3入(现有的"多换一")
 *   MS 多起点贪心(按不同首选项起贪心,取最好的)
 *
 * 为什么要复刻而不是直接调 optimize:optimize 只暴露"全开"这一条流水线,
 * 没法单独插一个邻域进去对比;而 phases 阶梯已经证明了后面的加价≈0。
 * 复刻的忠实性由 checkParity() 断言(必须能逐字复刻 L0 的结果)。
 *
 * 用法: npx tsx tools/bench/proposal.ts --plan app/_debug/plan_v2.json [--k 10] [--budgets 1000]
 */
import { optimize } from '../../src/optimizer.js';
import type { OptimizerResult } from '../../src/optimizer.js';
import { loadPlan } from './probe.js';
import { SKILL_INDEX, expandPool, combine as _unusedCombine, skillsOf, totalSpent, costOf, isBlocked, ExpectedEvaluator, toBody, type Item, type RawCand } from './model.js';
import { sampleableSpans, simulate } from '../../src/engine/index.js';
import type { Course, Region, RunnerConfig, SkillConfig } from '../../src/engine/index.js';

void _unusedCombine;

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** 带缓存的双口径评估器(用于测量"加缓存能省多少") */
class Evaluator {
  private readonly spansCache = new Map<string, readonly Region[] | null>();
  private readonly cacheSearch = new Map<string, number>();
  private readonly cacheExp = new Map<string, number>();
  sims = 0;
  /** 是否启用缓存 */
  cache = false;

  constructor(private readonly course: Course, private readonly runner: RunnerConfig) {
    for (const s of SKILL_INDEX.values()) this.spansCache.set(s.id, s.randomPosition === true ? sampleableSpans(s.condition, course) : null);
  }

  private spansOf(s: SkillConfig): readonly Region[] | null {
    return this.spansCache.get(s.id) ?? null;
  }

  private key(skills: readonly SkillConfig[], mode: 'search' | 'exp'): string {
    const ids = skills.map(s => s.id).join(',');
    return `${mode}|${ids}`;
  }

  /** 区段中点单点(optimize 的搜索口径) */
  search(skills: readonly SkillConfig[]): number {
    const k = this.key(skills, 'search');
    const hit = this.cache ? this.cacheSearch.get(k) : undefined;
    if (hit !== undefined) return hit;
    const rnd = skills.filter(s => this.spansOf(s) !== null);
    let v: number;
    if (rnd.length === 0) v = simulate(this.course, { ...this.runner, skills }).finishTimeSec;
    else {
      const ov = new Map(rnd.map(s => {
        const spans = this.spansOf(s)!;
        let t = 0.5 * spans.reduce((a, r) => a + (r[1] - r[0]), 0);
        for (const r of spans) { const len = r[1] - r[0]; if (t <= len) return [s.id, r[0] + t] as const; t -= len; }
        return [s.id, spans[spans.length - 1]![1]] as const;
      }));
      v = simulate(this.course, { ...this.runner, skills }, { positionOverrides: ov }).finishTimeSec;
    }
    this.sims++;
    this.cacheSearch.set(k, v);
    return v;
  }

  /** 12 点期望(产品汇报口径) */
  expected(skills: readonly SkillConfig[]): number {
    const k = this.key(skills, 'exp');
    const hit = this.cache ? this.cacheExp.get(k) : undefined;
    if (hit !== undefined) return hit;
    const rnd = skills.filter(s => this.spansOf(s) !== null);
    let v: number;
    if (rnd.length === 0) v = simulate(this.course, { ...this.runner, skills }).finishTimeSec;
    else {
      let sum = 0;
      for (let i = 0; i < 12; i++) {
        const u = (i + 0.5) / 12;
        const ov = new Map(rnd.map(s => {
          const spans = this.spansOf(s)!;
          let t = u * spans.reduce((a, r) => a + (r[1] - r[0]), 0);
          for (const r of spans) { const len = r[1] - r[0]; if (t <= len) return [s.id, r[0] + t] as const; t -= len; }
          return [s.id, spans[spans.length - 1]![1]] as const;
        }));
        sum += simulate(this.course, { ...this.runner, skills }, { positionOverrides: ov }).finishTimeSec;
        this.sims++;
      }
      v = sum / 12;
    }
    this.cacheExp.set(k, v);
    return v;
  }
}

interface Ctx {
  readonly ev: Evaluator;
  readonly items: readonly Item[];
  readonly all: ReadonlyMap<string, Item>;
  readonly budget: number;
  readonly eps: number;
}

interface SearchResult {
  readonly ids: readonly string[];
  readonly sims: number;
  readonly ms: number;
}

const eps = 0.0005;

function spent(ctx: Ctx, ids: readonly string[]): number {
  return totalSpent(ids.map(i => ctx.all.get(i)!), ctx.all);
}
function skillSet(ctx: Ctx, ids: readonly string[]): SkillConfig[] {
  return skillsOf(ids.map(i => ctx.all.get(i)!));
}
function cost(ctx: Ctx, id: string, currentIds: readonly string[]): number {
  return costOf(ctx.all.get(id)!, new Set(currentIds), ctx.all);
}

/** 动态贪心:每装入一项后重算所有候选的边际 (与 optimizer.greedyFill 同法) */
function greedyFill(ctx: Ctx, seed: readonly string[], maxSims = 1e9): { ids: string[]; ok: boolean } {
  const chosen = [...seed];
  for (;;) {
    if (ctx.ev.sims > maxSims) return { ids: chosen, ok: false };
    let sp = spent(ctx, chosen);
    const cur = ctx.ev.search(skillSet(ctx, chosen));
    let best: { id: string; ratio: number } | null = null;
    for (const c of ctx.items) {
      if (chosen.includes(c.id)) continue;
      const costI = cost(ctx, c.id, chosen);
      if (sp + costI > ctx.budget) continue;
      const next = [...chosen, c.id];
      const gain = cur - ctx.ev.search(skillSet(ctx, next));
      if (gain <= eps) continue;
      const ratio = costI > 0 ? gain / costI : Number.POSITIVE_INFINITY;
      if (best === null || ratio > best.ratio) best = { id: c.id, ratio };
    }
    if (best === null) break;
    chosen.push(best.id);
    sp = spent(ctx, chosen);
  }
  return { ids: chosen, ok: true };
}

/** 局部搜索:out 件换出,ins 件换入;贪心式重复直到没有改进 */
function localSwap(
  ctx: Ctx,
  start: readonly string[],
  maxOut: number,
  maxIn: number,
  poolSize: number,
  maxRounds: number,
  maxSims: number,
): { ids: string[]; ok: boolean } {
  let chosen = [...start];
  for (let round = 0; round < maxRounds; round++) {
    const cur = ctx.ev.search(skillSet(ctx, chosen));
    const pool = ctx.items.filter(c => !chosen.includes(c.id)).slice(0, poolSize);
    let best: { out: string[]; inn: string[]; gain: number } | null = null;
    for (let no = 1; no <= Math.min(maxOut, chosen.length); no++) {
      for (const outIds of combos(chosen, no)) {
        const rest = chosen.filter(x => !outIds.includes(x));
        const restIds = new Set(rest);
        let restCost = spent(ctx, rest);
        // 换入 1..maxIn 件
        for (let ni = 1; ni <= maxIn; ni++) {
          for (const inn of combos(pool.map(p => p.id), ni)) {
            const cur2 = [...rest];
            let ok = true;
            let addCost = 0;
            for (const id of inn) {
              const c = cost(ctx, id, cur2);
              addCost += c;
              cur2.push(id);
            }
            if (restCost + addCost > ctx.budget) { ok = false; }
            if (!ok) continue;
            const next = [...rest, ...inn];
            const totalC = spent(ctx, next);
            if (totalC > ctx.budget) continue;
            const gain = cur - ctx.ev.search(skillSet(ctx, next));
            if (gain > eps && (best === null || gain > best.gain)) best = { out: outIds, inn, gain };
            void restIds;
          }
        }
      }
    }
    if (best === null) break;
    chosen = [...chosen.filter(x => !best!.out.includes(x)), ...best.inn];
    const g = greedyFill(ctx, chosen, maxSims);
    chosen = g.ids;
    if (!g.ok) return { ids: chosen, ok: false };
    if (ctx.ev.sims > maxSims) return { ids: chosen, ok: false };
  }
  return { ids: chosen, ok: true };
}

function combos<T>(arr: readonly T[], k: number): T[][] {
  const out: T[][] = [];
  const rec = (start: number, acc: T[]): void => {
    if (acc.length === k) { out.push([...acc]); return; }
    for (let i = start; i < arr.length; i++) { acc.push(arr[i]!); rec(i + 1, acc); acc.pop(); }
  };
  rec(0, []);
  return out;
}

function runNamed(ctx: Ctx, name: string, fn: () => readonly string[], finish: (ids: readonly string[], sims0: number, t0: number) => SearchResult): SearchResult {
  const sims0 = ctx.ev.sims;
  const t0 = Date.now();
  const ids = fn();
  return finish(ids, sims0, t0);
}
void runNamed;

function makeFinish(ctx: Ctx): (ids: readonly string[], sims0: number, t0: number) => SearchResult {
  return (ids, sims0, t0) => ({ ids, sims: ctx.ev.sims - sims0, ms: Date.now() - t0 });
}

function main(): void {
  const args = new Map<string, string>();
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i]!;
    if (a.startsWith('--')) args.set(a.slice(2), process.argv[i + 1] ?? '');
  }
  const planPath = args.get('plan') ?? 'app/_debug/plan_v2.json';
  const ks = (args.get('k') ?? '10').split(',').map(Number);
  const budgets = (args.get('budgets') ?? '1000').split(',').map(Number);
  const instances = Number(args.get('instances') ?? 2);
  const seed = Number(args.get('seed') ?? 20261026);
  const topPool = Number(args.get('topPool') ?? 14);
  const poolLim = Number(args.get('poolLim') ?? 6);
  const simBudget = Number(args.get('simBudget') ?? 20000);

  const loaded = loadPlan(planPath);
  const { course, runner, candidates } = loaded;

  console.log(`=== 改进方案先算后改实验台 ${planPath}`);
  console.log(`k=${ks.join('/')} budget=${budgets.join('/')} instances=${instances} poolLim=${poolLim}\n`);

  let totalsNow = 0;
  let totalsProp = 0;
  let n = 0;

  for (const k of ks) {
    for (const budget of budgets) {
      const usable = candidates.filter(c => {
        const sk = SKILL_INDEX.get(c.id);
        return sk !== undefined && c.pt <= budget && !isBlocked(sk, course, runner);
      });

      const baseEv = new ExpectedEvaluator(course, runner);
      const baseSec = baseEv.evaluate([]);
      // 与 bench.ts 完全同法的取样池:按单项收益排前 topPool 条后再洗牌
      const rankedScores = expandPool(usable).map(i => ({ id: i.id, sec: baseSec - baseEv.evaluate(skillsOf([i])) }));
      const rank = new Map(rankedScores.map(s => [s.id, s.sec] as const));
      const ranked = usable.slice().sort((a, b) => (rank.get(b.id) ?? 0) - (rank.get(a.id) ?? 0)).slice(0, topPool);
      if (ranked.length < k) { console.log(`跳过 k=${k}/b=${budget}:可用 ${ranked.length}`); continue; }

      const rnd = lcg(seed + k * 7919 + budget);
      for (let ii = 0; ii < instances; ii++) {
        const pool = ranked.slice();
        for (let j = pool.length - 1; j > 0; j--) { const r = Math.floor(rnd() * (j + 1)); [pool[j], pool[r]] = [pool[r]!, pool[j]!]; }
        const chosenPool = pool.slice(0, k);
        const { items, all } = buildItems(chosenPool);
        console.log(`──── k=${k} b=${budget} #${ii + 1}  候选: ${chosenPool.map(c => SKILL_INDEX.get(c.id)?.name ?? c.id).join('、')}`);

        // ① 现有算法(全开)
        const curR: OptimizerResult = optimize({ course, runner, candidates: chosenPool, budget });
        const ev0 = new Evaluator(course, runner);
        const curSec = baseEv.evaluate(skillSet2(chosenPool, curR.chosen.map(c => c.id)));

        // ② 复刻的纯贪心(必须能逐字复刻 optimize 的 L0 组合,否则实验不可信)
        const ctx0: Ctx = { ev: ev0, items, all, budget, eps };
        const g = greedyFill(ctx0, []);
        const l0 = optimize({ course, runner, candidates: chosenPool, budget, stages: { swap: false, twoOutSwap: false, spendDown: false, polish: false } });
        const parity = g.ids.join(',') === l0.chosen.map(c => c.id).join(',');
        console.log(`   复刻校验: 我的贪心 vs optimize L0 = ${parity ? '一致' : `不一致\n     我:${g.ids}\n     L0:${l0.chosen.map(c => c.id)}`}`);
        if (!parity) { console.log('   (复刻不一致 → 本实例的后续数字仅供参考)'); }

        // ③ 各方案
        const bodies = (ids: readonly string[]): number => {
          const s = baseEv.evaluate(skillSet2(chosenPool, ids));
          return (baseSec - s) * (baseEv.spurtTargetSpeed(skillSet2(chosenPool, ids)) / 2.5);
        };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const evNameOf = (ids: readonly string[]): string => ids.map(i => all.get(i)?.name ?? i).join('+');
        void evNameOf;

        const results: { name: string; body: number; res: SearchResult }[] = [];
        const push = (name: string, res: SearchResult) => results.push({ name, body: bodies(res.ids), res });

        // A. 现状(optimize 全开)
        push('A 现状(optimize 全开)', { ids: curR.chosen.map(c => c.id), sims: curR.simsUsed, ms: 0 });

        // B. 纯贪心
        const evB = new Evaluator(course, runner);
        const ctxB: Ctx = { ev: evB, items, all, budget, eps };
        const tB = Date.now();
        const gB = greedyFill(ctxB, []);
        push('B 动态贪心', { ids: gB.ids, sims: evB.sims, ms: Date.now() - tB });

        // C. 贪心 + 1出1入
        const evC = new Evaluator(course, runner);
        const ctxC: Ctx = { ev: evC, items, all, budget, eps };
        const tC = Date.now();
        const gC0 = greedyFill(ctxC, []);
        const gC = localSwap(ctxC, gC0.ids, 1, 1, 1e9, 20, simBudget);
        push('C +1出1入', { ids: gC.ids, sims: evC.sims, ms: Date.now() - tC });

        // D. 贪心 + 1出1入 + 2出1入
        const evD = new Evaluator(course, runner);
        const ctxD: Ctx = { ev: evD, items, all, budget, eps };
        const tD = Date.now();
        const gD0 = greedyFill(ctxD, []);
        const gD1 = localSwap(ctxD, gD0.ids, 1, 1, 1e9, 20, simBudget);
        const gD = localSwap(ctxD, gD1.ids, 2, 1, 1e9, 8, simBudget);
        push('D +2出1入', { ids: gD.ids, sims: evD.sims, ms: Date.now() - tD });

        // E. D + 2出2入
        const evE = new Evaluator(course, runner);
        const ctxE: Ctx = { ev: evE, items, all, budget, eps };
        const tE = Date.now();
        const gE0 = greedyFill(ctxE, []);
        const gE1 = localSwap(ctxE, gE0.ids, 1, 1, 1e9, 20, simBudget);
        const gE2 = localSwap(ctxE, gE1.ids, 2, 1, 1e9, 8, simBudget);
        const gE = localSwap(ctxE, gE2.ids, 2, 2, poolLim, 4, simBudget);
        push('E +2出2入', { ids: gE.ids, sims: evE.sims, ms: Date.now() - tE });

        // F. 多起点:前 5 个不同首选项起贪心 +1出1入+2出1入,取最好
        const evF = new Evaluator(course, runner);
        const ctxF: Ctx = { ev: evF, items, all, budget, eps };
        const tF = Date.now();
        let bestF: { ids: readonly string[]; sec: number } | null = null;
        const starters: (readonly string[])[] = [[]];
        // 用单项收益最高的前 4 个候选做起点
        const soloRank = items.slice().sort((a, b) => (baseSec - baseEv.evaluate(skillsOf([b]))) - (baseSec - baseEv.evaluate(skillsOf([a]))));
        for (const s of soloRank.slice(0, 4)) starters.push([s.id]);
        for (const st of starters) {
          const r0 = greedyFill(ctxF, [...st]);
          const r1 = localSwap(ctxF, r0.ids, 1, 1, 1e9, 20, simBudget);
          const r2 = localSwap(ctxF, r1.ids, 2, 1, 1e9, 8, simBudget);
          const sec = evF.expected(skillSet(ctxF, r2.ids));
          if (bestF === null || sec < bestF.sec) bestF = { ids: r2.ids, sec };
        }
        push('F 多起点(5)+D邻域', { ids: bestF!.ids, sims: evF.sims, ms: Date.now() - tF });

        console.log('   方案                      收益(马身)   相对现状   模拟次数   耗时ms');
        const base = results[0]!.body;
        for (const r of results) {
          console.log(
            '   ' + r.name.padEnd(24),
            r.body.toFixed(3).padStart(10),
            ((r.body - base >= 0 ? '+' : '') + (r.body - base).toFixed(3)).padStart(10),
            String(r.res.sims).padStart(9),
            String(r.res.ms).padStart(8),
          );
        }
        totalsNow += results[0]!.body;
        totalsProp += results[results.length - 1]!.body;
        n++;
        void curSec;
        console.log('');
      }
    }
  }
  console.log(`合计 ${n} 个实例: 现状平均 ${(totalsNow / n).toFixed(3)} 马身 → 多起点+全邻域平均 ${(totalsProp / n).toFixed(3)} 马身(提升 ${(totalsProp - totalsNow).toFixed(3)})`);
}

function skillSet2(pool: readonly RawCand[], ids: readonly string[]): SkillConfig[] {
  const items = expandPool(pool);
  const map = new Map(items.map(i => [i.id, i] as const));
  return skillsOf(ids.map(i => map.get(i)!));
}

function buildItems(pool: readonly RawCand[]): { items: readonly Item[]; all: ReadonlyMap<string, Item> } {
  const items = expandPool(pool);
  return { items, all: new Map(items.map(i => [i.id, i] as const)) };
}

void toBody;
main();
