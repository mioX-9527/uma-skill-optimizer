/**
 * 决策过程逐脚印 trace。
 *
 * 目的:用大白话回答"它到底怎么选的"——
 * 打印每一步的全部候选边际、排序依据、选中者、花费变化。
 * 复刻已通过 parity 校验(与 optimize L0 逐字一致)。
 *
 * 用法: npx tsx tools/bench/trace.ts --plan app/_debug/plan_v2.json
 */
import { loadPlan } from './probe.js';
import { SKILL_INDEX, expandPool, skillsOf, totalSpent, costOf, isBlocked, ExpectedEvaluator, type Item } from './model.js';
import { sampleableSpans, simulate } from '../../src/engine/index.js';
import type { Region, SkillConfig } from '../../src/engine/index.js';

const EPS = 0.0005;

function main(): void {
  const args = new Map<string, string>();
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i]!;
    if (a.startsWith('--')) args.set(a.slice(2), process.argv[i + 1] ?? '');
  }
  const planPath = args.get('plan') ?? 'app/_debug/plan_v2.json';
  const topN = Number(args.get('top') ?? 5);

  const { course, runner, candidates, budget } = loadPlan(planPath);
  const ev = new ExpectedEvaluator(course, runner);
  const baseSec = ev.evaluate([]);
  const span = ev.spurtTargetSpeed([]);
  const bodyPerSec = span / 2.5;

  // 与 optimizer.ts 同法的 spans / 中点
  const spansCache = new Map<string, readonly Region[] | null>();
  for (const s of SKILL_INDEX.values()) spansCache.set(s.id, s.randomPosition === true ? sampleableSpans(s.condition, course) : null);
  const midOf = (s: SkillConfig): number => {
    const spans = spansCache.get(s.id)!;
    let t = 0.5 * spans!.reduce((a, r) => a + (r[1] - r[0]), 0);
    for (const r of spans!) { const len = r[1] - r[0]; if (t <= len) return r[0] + t; t -= len; }
    return spans![spans.length - 1]![1];
  };
  const search = (skills: readonly SkillConfig[]): number => {
    const rnd = skills.filter(s => spansCache.get(s.id) !== null);
    if (rnd.length === 0) return simulate(course, { ...runner, skills }).finishTimeSec;
    return simulate(course, { ...runner, skills }, { positionOverrides: new Map(rnd.map(s => [s.id, midOf(s)])) }).finishTimeSec;
  };

  const items = expandPool(candidates);
  const all = new Map(items.map((i: Item) => [i.id, i] as const));
  const usable = items.filter(i => i.pt <= budget && !isBlocked(SKILL_INDEX.get(i.id)!, course, runner));

  console.log(`=== ${planPath}`);
  console.log(`赛道 ${course.name} ${course.distance}m | 跑法 ${runner.tactic} | 预算 ${budget}pt`);
  console.log(`候选 ${candidates.length} 条 → 展开双圈后 ${items.length} 条 → 剔除「本配置不生效」后 ${usable.length} 条`);
  console.log(`空手基线 ${baseSec.toFixed(4)}s,末脚目标速度 ${span.toFixed(3)} m/s → 1 秒 = ${bodyPerSec.toFixed(3)} 马身\n`);

  console.log('── 单项收益(每个技能单独装上,不买别的),按「马身/100pt」降序前 12 ──');
  const solo = usable.map(i => {
    const sec = baseSec - ev.evaluate(skillsOf([i]));
    return { i, body: sec * bodyPerSec, per100: (sec * bodyPerSec) / Math.max(1, i.pt) * 100 };
  }).sort((a, b) => b.per100 - a.per100);
  const pad26 = (v: string): string => v.slice(0, 24).padEnd(26, ' ');
  const num = (v: number, w: number, d = 3): string => v.toFixed(d).padStart(w);
  console.log(pad26('技能') + 'PT'.padStart(6) + '单独马身'.padStart(11) + '马身/100pt'.padStart(13));
  for (const s of solo.slice(0, 12)) {
    console.log(pad26(s.i.name) + String(s.i.pt).padStart(6) + num(s.body, 11) + num(s.per100, 13));
  }
  const zero = solo.filter(s => s.body <= EPS * bodyPerSec);
  console.log(`(单项马身 ≈0 的有 ${zero.length} 条:要么买来就不发动,要么买了但不快)`);

  console.log('\n── 贪心逐轮决策(排序依据 = 边际秒数 ÷ 本次实际要付的 PT)──');
  const chosen: string[] = [];
  const rows: string[] = [];
  for (let step = 1; ; step++) {
    const cur = skillsOf(chosen.map(id => all.get(id)!));
    const curSec = search(cur);
    const spentNow = totalSpent(chosen.map(id => all.get(id)!), all);
    const scored = usable.filter(i => !chosen.includes(i.id)).map(i => {
      const cost = costOf(i, new Set(chosen), all);
      const affordable = spentNow + cost <= budget;
      const gain = affordable ? (curSec - search(skillsOf([...chosen.map(id => all.get(id)!), i]))) : Number.NaN;
      const ratio = cost > 0 ? gain / cost : Number.POSITIVE_INFINITY;
      return { i, cost, affordable, gainSec: gain, body: gain * bodyPerSec, ratio };
    });
    const feas = scored.filter(s => s.affordable && s.gainSec > EPS).sort((a, b) => b.ratio - a.ratio);
    if (feas.length === 0) {
      const notAfford = scored.filter(s => !s.affordable).length;
      console.log(`第 ${step} 轮:没有能买得起且有正收益的候选了,停。(${usable.length - chosen.length} 个未选里 ${notAfford} 个买不起)`);
      break;
    }
    const best = feas[0]!;
    rows.push(`${String(step).padStart(3)}  ${best.i.name.slice(0, 22).padEnd(24)} 边际 ${best.body.toFixed(3).padStart(7)} 马身  实付 ${String(best.cost).padStart(4)}pt  ${(best.body / Math.max(1, best.cost) * 100).toFixed(3).padStart(7)} 马身/100pt`);
    console.log(rows[rows.length - 1]);
    console.log(`      本轮其它候选的前 ${topN}: ${feas.slice(1, 1 + topN).map(s => `${s.i.name.slice(0, 10)}(${(s.body / Math.max(1, s.cost) * 100).toFixed(2)})`).join('  ')}`);
    chosen.push(best.i.id);
  }

  console.log('\n── 贪心结束 ──');
  const finalItems = chosen.map(id => all.get(id)!);
  const secA = ev.evaluate(skillsOf(finalItems));
  console.log(`装入 ${chosen.length} 项, 花费 ${totalSpent(finalItems, all)}pt, 剩余 ${budget - totalSpent(finalItems, all)}pt`);
  console.log(`组合: ${finalItems.map(i => i.name).join(' + ')}`);
  console.log(`期望口径 ${secA.toFixed(5)}s → ${((baseSec - secA) * bodyPerSec).toFixed(3)} 马身`);

  console.log('\n── 结算時的 leave-one-out 边际(「去掉它你自己会慢多少」)──');
  const loo = finalItems.map(i => {
    const without = skillsOf(finalItems.filter(x => x.id !== i.id));
    const sec = ev.evaluate(without);
    return { i, loss: (sec - secA) * bodyPerSec, paid: costOf(i, new Set(chosen), all) };
  }).sort((a, b) => b.loss - a.loss);
  console.log(pad26('技能') + '实付PT'.padStart(8) + '集内边际'.padStart(11) + '边际马身/100pt'.padStart(16));
  for (const l of loo) {
    console.log(pad26(l.i.name) + String(l.paid).padStart(8) + num(l.loss, 11) + num(l.loss / Math.max(1, l.paid) * 100, 16));
  }
  console.log(`\n注意:上面这列加起来 = ${loo.reduce((a, b) => a + b.loss, 0).toFixed(3)} 马身,而总收益只有 ${((baseSec - secA) * bodyPerSec).toFixed(3)} 马身 —— 差的就是技能之间的交互(先加速的抬高后者的起步速度等),所以这列只能看单个贡献,不能相加。`);
}

void main();
