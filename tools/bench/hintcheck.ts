/**
 * 「换出建议」(swapHintOf) 的口径检查。
 *
 * optimizer.ts 里 swapHintOf 把 **simSearch(区段中点)** 的完赛时间
 * 与 **finalSim(simExpected,12 点期望)** 直接相减。两者不是同一个统计量,
 * 差值里混着"口径偏差",可能给出与事实相反的建议。
 *
 * 本脚本在同一批候选上把两个口径都算一遍,统计建议符号翻转的比例。
 *
 * 用法: npx tsx tools/bench/hintcheck.ts --plan app/_debug/plan_v2.json
 */
import { optimize } from '../../src/optimizer.js';
import { loadPlan } from './probe.js';
import { SKILL_INDEX, expandPool, skillsOf, totalSpent, ExpectedEvaluator, toBody, type Item } from './model.js';
import { simulate, sampleableSpans } from '../../src/engine/index.js';
import type { Region, SkillConfig } from '../../src/engine/index.js';

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function main(): void {
  const args = new Map<string, string>();
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i]!;
    if (a.startsWith('--')) args.set(a.slice(2), process.argv[i + 1] ?? '');
  }
  const planPath = args.get('plan') ?? 'app/_debug/plan_v2.json';
  const budgetOverride = Number(args.get('budget') ?? NaN);

  const { course, runner, candidates, budget: planBudget } = loadPlan(planPath);
  const budget = Number.isFinite(budgetOverride) ? budgetOverride : planBudget;
  const ev = new ExpectedEvaluator(course, runner);
  const items = expandPool(candidates);
  const itemsMap = new Map(items.map((i: Item) => [i.id, i] as const));
  const allMap = itemsMap;

  const spanCache = new Map<string, readonly Region[] | null>();
  for (const s of SKILL_INDEX.values()) spanCache.set(s.id, s.randomPosition === true ? sampleableSpans(s.condition, course) : null);
  const midOf = (s: SkillConfig): number => {
    const spans = spanCache.get(s.id)!;
    let t = 0.5 * spans!.reduce((a, r) => a + (r[1] - r[0]), 0);
    for (const r of spans!) { const len = r[1] - r[0]; if (t <= len) return r[0] + t; t -= len; }
    return spans![spans.length - 1]![1];
  };
  const simSearch = (skills: readonly SkillConfig[]): number => {
    const rnd = skills.filter(s => spanCache.get(s.id) !== null);
    if (rnd.length === 0) return simulate(course, { ...runner, skills }).finishTimeSec;
    return simulate(course, { ...runner, skills }, { positionOverrides: new Map(rnd.map(s => [s.id, midOf(s)])) }).finishTimeSec;
  };

  const r = optimize({ course, runner, candidates, budget });
  const chosenItems = r.chosen.map(c => itemsMap.get(c.id)!);
  const chosenSkills = skillsOf(chosenItems);
  const finalA = ev.evaluate(chosenSkills);       // 期望口径(产品汇报口径)
  const finalSearch = simSearch(chosenSkills);    // 搜索口径
  const span = ev.spurtTargetSpeed(chosenSkills); // 换算
  const remaining = budget - totalSpent(chosenItems, allMap);

  console.log(`=== swapHintOf 口径检查 ${planPath}`);
  console.log(`最终组合 ${r.chosen.length} 项 / ${r.totalPt}pt / 剩余 ${remaining}pt`);
  console.log(`最终组合: 期望口径 ${finalA.toFixed(5)}s  搜索口径 ${finalSearch.toFixed(5)}s  差 ${((finalSearch - finalA) * span / 2.5).toFixed(4)} 马身\n`);

  const rnd = lcg(4242);
  let checked = 0;
  let flips = 0;
  let maxAbsMixed = 0;
  const examples: string[] = [];
  for (const cand of items) {
    if (chosenItems.some(c => c.id === cand.id)) continue;
    const cost = totalSpent([...chosenItems, cand], allMap) - totalSpent(chosenItems, allMap);
    if (cost > remaining) continue;
    const nextSkills = skillsOf([...chosenItems, cand]);
    const nextA = ev.evaluate(nextSkills);
    const nextSearch = simSearch(nextSkills);
    const deltaA = (finalA - nextA) * span / 2.5;          // 正 = 期望口径下真的更快
    const deltaMixed = (finalA - nextSearch) * span / 2.5; // swapHintOf 用的混口径
    checked++;
    if (Math.sign(deltaA) !== Math.sign(deltaMixed) && Math.abs(deltaA) > 0.005 && Math.abs(deltaMixed) > 0.005) {
      flips++;
      if (examples.length < 6) examples.push(`   ${cand.name}: 期望口径 ${deltaA >= 0 ? '+' : ''}${deltaA.toFixed(3)} 马身 / 混口径 ${deltaMixed >= 0 ? '+' : ''}${deltaMixed.toFixed(3)} 马身`);
    }
    maxAbsMixed = Math.max(maxAbsMixed, Math.abs(deltaMixed - deltaA));
  }
  console.log(`检查了 ${checked} 个"买得起"的未选技能(纯加入,不换出)`);
  console.log(`建议符号翻转(两口径结论相反): ${flips} 个`);
  console.log(`混口径 vs 期望口径的最大数值偏差: ${maxAbsMixed.toFixed(4)} 马身`);
  if (examples.length > 0) { console.log('示例:'); for (const e of examples) console.log(e); }
}

void main();
