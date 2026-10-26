/**
 * 「金技能到底是不是替换下位白」这个机制分歧的量化影响。
 *
 * 两种假设:
 *   A 叠加(代码现在的算法): 买了金 → 白 + 金 两个技能都在,同一帧各自发动
 *   B 替换:                 买了金 → 只有金生效,白作废
 *
 * 两者在收益上的差 = 「白单独能带来多少」,但价格完全一样(买金都是 304)。
 *
 * 用法: npx tsx tools/bench/prereq-mode.ts --plan app/_debug/plan_v2.json
 */
import { loadPlan } from './probe.js';
import { SKILL_INDEX, ExpectedEvaluator } from './model.js';
import type { SkillConfig } from '../../src/engine/index.js';

const PAIRS: readonly (readonly [string, string])[] = [
  ['201662', '201661'],   // 先走一步！ / 游戏到此为止！
  ['210291', '210292'],   // 巅峰之梦 / 背负信念
  ['202421', '202422'],   // 浑然忘我 / 不顾一切
  ['200751', '200752'],   // 内侧体验 / 弯里横
];

function main(): void {
  const args = new Map<string, string>();
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i]!;
    if (a.startsWith('--')) args.set(a.slice(2), process.argv[i + 1] ?? '');
  }
  const planPath = args.get('plan') ?? 'app/_debug/plan_v2.json';
  const { course, runner, candidates } = loadPlan(planPath);
  const ev = new ExpectedEvaluator(course, runner);
  const base = ev.evaluate([]);
  const span = ev.spurtTargetSpeed([]);
  const bps = span / 2.5;
  const ptOf = new Map(candidates.map(c => [c.id, c.pt] as const));

  console.log(`=== 「金是否替换下位白」的量化影响  ${planPath}`);
  console.log(`空手 ${base.toFixed(4)}s, 1 秒 = ${bps.toFixed(3)} 马身\n`);
  console.log('技能对                       白单装    金(叠加)   金(替换)   替换假设少算   差额占比');

  for (const [gid, wid] of PAIRS) {
    const g = SKILL_INDEX.get(gid) as SkillConfig | undefined;
    const w = SKILL_INDEX.get(wid) as SkillConfig | undefined;
    if (g === undefined || w === undefined) continue;
    const onlyW = (base - ev.evaluate([w])) * bps;
    const both = (base - ev.evaluate([w, g])) * bps;
    const onlyG = (base - ev.evaluate([g])) * bps;
    const lost = both - onlyG;
    const ratio = both > 0 ? lost / both : 0;
    const gp = ptOf.get(gid) ?? 0;
    console.log(
      `${g.name.slice(0, 10)}/${w.name.slice(0, 8)}`.padEnd(24, ' ') +
      onlyW.toFixed(3).padStart(9) + both.toFixed(3).padStart(11) + onlyG.toFixed(3).padStart(11) +
      lost.toFixed(3).padStart(14) + `${(ratio * 100).toFixed(0)}%`.padStart(9) +
      `  (金实付 ${gp}pt,含白的钱)`,
    );
  }

  console.log('\n读法:');
  console.log('  「金(叠加)」= 代码现在给你的数;「金(替换)」= 如果白作废时的真实收益。');
  console.log('  差额 = 你在"前置那 160pt"上买到的东西到底算不算数。');
  console.log('\n验证方法(游戏内约 1 分钟):');
  console.log('  装上「游戏到此为止！」+「先走一步！」跑一场,看技能发动提示/回放:');
  console.log('   · 出现两条(0.15 与 0.35 各一次)→ 叠加,代码现在是对的');
  console.log('   · 只出现一条(0.35)              → 替换,代码高估了金技能的收益');
}

void main();
