/**
 * 真实规模(不能穷举)下的阶段贡献与健壮性检查。
 *
 *   1. 完整候选池上跑「阶段阶梯」,看每个阶段在真实规模下到底加了多少马身
 *   2. 多次重跑是否完全一致(确定性检查)
 *   3. maxSims 给小了会怎样(是否抛异常而不是降级)
 *   4. 最终组合在「独立抽样口径」下的收益,以及推荐是否稳定
 *
 * 用法: npx tsx tools/bench/fullrun.ts --plan app/_debug/plan_v2.json
 */
import { optimize, type OptimizerStages } from '../../src/optimizer.js';
import { loadPlan } from './probe.js';
import { SKILL_INDEX, expandPool, skillsOf, ExpectedEvaluator, toBody, type Item } from './model.js';

const LADDER: readonly (readonly [string, OptimizerStages])[] = [
  ['L0 纯贪心', { swap: false, twoOutSwap: false, spendDown: false, polish: false }],
  ['L1 +1换1交换', { swap: true, twoOutSwap: false, spendDown: false, polish: false }],
  ['L2 +预算花完', { swap: true, twoOutSwap: false, spendDown: true, polish: false }],
  ['L3 +2换1', { swap: true, twoOutSwap: true, spendDown: true, polish: false }],
  ['L4 +期望复核(现状)', { swap: true, twoOutSwap: true, spendDown: true, polish: true }],
];

function main(): void {
  const args = new Map<string, string>();
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i]!;
    if (a.startsWith('--')) args.set(a.slice(2), process.argv[i + 1] ?? '');
  }
  const planPath = args.get('plan') ?? 'app/_debug/plan_v2.json';
  const runs = Number(args.get('runs') ?? 3);
  const holdoutDraws = Number(args.get('holdoutDraws') ?? 32);

  const { course, runner, candidates, budget } = loadPlan(planPath);
  const ev = new ExpectedEvaluator(course, runner);
  const baseSec = ev.evaluate([]);
  const items = expandPool(candidates);
  const itemsMap = new Map(items.map((i: Item) => [i.id, i] as const));
  console.log(`=== 真实规模 ${planPath}  ${candidates.length} 候选 / ${budget}pt(展开后 ${items.length})`);

  console.log('\n1) 阶段阶梯(同一份输入,逐级打开精修阶段)');
  console.log('阶段                        收益(马身)   总PT  项数   相对L0(马身)   模拟次数   耗时ms');
  let baseBody = Number.NaN;
  const picked: Record<string, readonly string[]> = {};
  for (const [label, stages] of LADDER) {
    const t0 = Date.now();
    const r = optimize({ course, runner, candidates, budget, stages });
    const ms = Date.now() - t0;
    const chosenItems = r.chosen.map(c => itemsMap.get(c.id)!);
    const sec = ev.evaluate(skillsOf(chosenItems));
    const body = toBody(baseSec - sec, ev.spurtTargetSpeed(skillsOf(chosenItems)));
    if (Number.isNaN(baseBody)) baseBody = body;
    picked[label] = r.chosen.map(c => c.id);
    console.log(
      label.padEnd(24),
      body.toFixed(3).padStart(10),
      String(r.totalPt).padStart(6),
      String(r.chosen.length).padStart(4),
      (body - baseBody >= 0 ? '+' : '') + (body - baseBody).toFixed(3),
      String(r.simsUsed).padStart(9),
      String(ms).padStart(8),
    );
  }
  for (const [label, ids] of Object.entries(picked)) {
    const same = ids.length === picked['L0 纯贪心']!.length && ids.every((x, i) => x === picked['L0 纯贪心']![i]);
    if (!same) console.log(`   ${label} 的组合与 L0 不同`);
  }

  console.log('\n2) 多次重跑一致性');
  const sigs = new Set<string>();
  for (let i = 0; i < runs; i++) {
    const r = optimize({ course, runner, candidates, budget });
    sigs.add(r.chosen.map(c => c.id).join(',') + '|' + r.finalSec.toFixed(9) + '|' + r.simsUsed);
  }
  console.log(`   ${runs} 次重跑得到 ${sigs.size} 种结果 → ${sigs.size === 1 ? '完全一致(确定性)' : '不完全一致,存在非确定性'}`);

  console.log('\n3) maxSims 给小了会怎样');
  for (const ms_ of [1200, 1000, 800, 500]) {
    try {
      const r = optimize({ course, runner, candidates, budget, maxSims: ms_ });
      console.log(`   maxSims=${String(ms_).padStart(5)} → 正常返回,用了 ${r.simsUsed} 次, ${r.chosen.length} 项`);
    } catch (e) {
      console.log(`   maxSims=${String(ms_).padStart(5)} → 抛异常: ${(e as Error).message}`);
    }
  }

  console.log('\n4) 最终组合的独立口径复核 + 相邻方案对比');
  const r = optimize({ course, runner, candidates, budget });
  const chosenItems = r.chosen.map(c => itemsMap.get(c.id)!);
  const skills = skillsOf(chosenItems);
  const a = ev.evaluate(skills);
  const b = ev.evaluateIndependent(skills, holdoutDraws);
  const span = ev.spurtTargetSpeed(skills);
  console.log(`   推荐组合(${r.chosen.length} 项, ${r.totalPt}pt): ${r.chosen.map(c => SKILL_INDEX.get(c.id)?.name ?? c.id).join(' + ')}`);
  console.log(`   产品口径(A,共同分位 12 点) ${a.toFixed(5)}s → ${toBody(baseSec - a, span).toFixed(3)} 马身`);
  console.log(`   独立口径(B,各技能独立 LHS ${holdoutDraws} 组) ${b.mean.toFixed(5)}s ±${b.ci.toFixed(5)} → ${toBody(baseSec - b.mean, span).toFixed(3)} 马身 (±${toBody(b.ci, span).toFixed(3)})`);
  console.log(`   两口径差值 ${((b.mean - a) * span / 2.5).toFixed(4)} 马身 / 抽样误差 ±${(toBody(b.ci, span)).toFixed(4)} 马身`);
  const abs = Math.abs(b.mean - a);
  console.log(`   差值是否超过抽样误差? ${abs > b.ci ? '超过 → 两种口径存在系统性偏差' : '未超过 → 与抽样误差同量级'}`);
}

void main();
