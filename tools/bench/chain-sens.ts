/**
 * 「金 / 下位白」价格关系的鲁棒性实验。
 *
 * optimizer 的计价模型是:
 *   单独买金        → 付 c.pt(自动带走下位白)
 *   先买白、再买金  → 白付 白.pt,金再付 (c.pt − 白.pt)
 * 也就是说 **"金 − 白"这个差额完全取决于列表上读到的白技能实付价**。
 * 而列表价是 OCR 读的、含玩家自己的折扣。那么只要白的折扣读偏了,
 * 金的"增量价"就跟着偏 —— 这是你担心的那件事。
 *
 * 本脚本做三件事:
 *   1. chains 完全不声明(会从0基础开局),看金技能会怎样被误判
 *   2. 只扫某一条链里**下位白**的实付价,看金的上榜/落榜翻转点在哪
 *   3. 扫**金自己**的显示价,看它对"增量性价比"的敏感度
 *
 * 用法: npx tsx tools/bench/chain-sens.ts --plan app/_debug/plan_v2.json
 */
import { optimize } from '../../src/optimizer.js';
import { loadPlan } from './probe.js';
import { SKILL_INDEX, expandPool, skillsOf, ExpectedEvaluator, type Item } from './model.js';
import type { RawCand } from './model.js';

interface Variant {
  readonly label: string;
  readonly cands: readonly RawCand[];
}

function main(): void {
  const args = new Map<string, string>();
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i]!;
    if (a.startsWith('--')) args.set(a.slice(2), process.argv[i + 1] ?? '');
  }
  const planPath = args.get('plan') ?? 'app/_debug/plan_v2.json';
  const { course, runner, candidates, budget } = loadPlan(planPath);
  const ev = new ExpectedEvaluator(course, runner);
  const baseSec = ev.evaluate([]);
  const bodyPerSec = ev.spurtTargetSpeed([]) / 2.5;

  const GOLD = '210291';   // 巅峰之梦
  const WHITE = '210292';  // 背负信念
  const GOLD2 = '201662';  // 先走一步！
  const WHITE2 = '201661'; // 游戏到此为止！

  const only = args.get('only');

  console.log(`=== 金/白价格关系鲁棒性 ${planPath}  预算 ${budget}pt`);
  console.log('原则:实付价(UI 上直接读到的)就是这一把要付的钱,直接用;原价不参与决策。');
  console.log('      唯一需要推算的是双圈 ◎ —— 列表上永远只显示当前能买的那一级,看不到 ◎。');

  const run = (label: string, cands: readonly RawCand[]): void => {
    const r = optimize({ course, runner, candidates: cands, budget });
    const items = expandPool(cands);
    const map = new Map(items.map((i: Item) => [i.id, i] as const));
    const chosenIds = new Set(r.chosen.map(c => c.id));
    const hasGold = chosenIds.has(GOLD);
    const hasWhite = chosenIds.has(WHITE);
    const hasGold2 = chosenIds.has(GOLD2);
    const body = (baseSec - r.finalSec) * bodyPerSec;
    const delta = (pt: number): string => {
      const g = map.get(GOLD); const w = map.get(WHITE);
      return g && w ? ` [增量=${g.pt - w.pt}]` : '';
    };
    console.log(
      `  ${label.padEnd(34)} 收益 ${body.toFixed(3).padStart(7)} 马身  ${String(r.totalPt).padStart(4)}pt  ` +
      `巅峰之梦:${hasGold ? '是' : '否'} 背负信念:${hasWhite ? '是' : '否'} 先走一步:${hasGold2 ? '是' : '否'}${hasGold ? '' : delta(0)}`,
    );
  };

  if (only === undefined || only === '1') {
  console.log('\n1) chains 完全不声明(等价于 OCR 没读到上下位关系)');
  run('  基线(有 chains)', candidates);
  run('  去掉全部 chains', candidates.map(c => ({ id: c.id, pt: c.pt })));

  }
  if (only === undefined || only === '2') {
  console.log('\n2) 只扫「背负信念」(下位白)的实付价');
  const baseWhite = candidates.find(c => c.id === WHITE)?.pt ?? 0;
  for (const wpt of [-80, -40, -20, 0, 20, 40, 80, 120]) {
    const v = baseWhite + wpt;
    if (v <= 0) continue;
    run(`  背负信念 pt=${String(v).padStart(4)} (${wpt >= 0 ? '+' : ''}${wpt})`, candidates.map(c => (c.id === WHITE ? { ...c, pt: v } : c)));
  }

  }
  if (only === undefined || only === '3') {
  console.log('\n3) 双圈 ◎:列表上看不到 ◎ 的价格,只能从 ○ 的实付价反推 —— 扫 ○ 的实付价');
  const CIRC_O = '201322';   // 跟前弯道○
  const CIRC_D = '201321';   // 跟前弯道◎
  const baseO = candidates.find(c => c.id === CIRC_O)?.pt ?? 0;
  for (const d of [-40, -20, 0, 20, 40]) {
    const v = Math.max(1, baseO + d);
    run(`  跟前弯道○ pt=${String(v).padStart(4)} (${d >= 0 ? '+' : ''}${d})`, candidates.map(c => (c.id === CIRC_O ? { ...c, pt: v } : c)));
    void CIRC_D;
  }

  }
  if (only === undefined || only === '4') {
  console.log('\n4) 极端:下位白比金还贵(增量算成负数,被 Math.max(0,·) 截成 0 = 白送)');
  run('  背负信念 pt=360(>金 320)', candidates.map(c => (c.id === WHITE ? { ...c, pt: 360 } : c)));
  }
  if (only === undefined || only === '5') {
  // 5) 把「必须先买下位白」这条路逼出来:预算小于金技能的共需价时,只能先买白
  //    这时 白实付价 才会真正进账,抵扣逻辑才被触发。
  console.log('\n5) 定向:预算卡在「买不起金、只买得起白」时,扫白的实付价');
  const small = candidates.filter(c => [GOLD, WHITE, '900591', '202522', '201322', '200722', '200732'].includes(c.id));
  for (const b of [300, 340, 400, 500, 700]) {
    for (const wpt of [100, 180, 260]) {
      const cands = small.map(c => (c.id === WHITE ? { ...c, pt: wpt } : c));
      const r = optimize({ course, runner, candidates: cands, budget: b });
      const ids = new Set(r.chosen.map(c => c.id));
      const items = expandPool(cands);
      const map = new Map(items.map((i: Item) => [i.id, i] as const));
      const g = map.get(GOLD);
      const w = map.get(WHITE);
      const inc = g && w ? g.pt - w.pt : Number.NaN;
      console.log(
        `  预算${String(b).padStart(4)} 白pt=${String(wpt).padStart(3)} → 金增量=${String(inc).padStart(3)}  ` +
        `巅峰之梦:${ids.has(GOLD) ? '被选中' : '落榜  '} 背负信念:${ids.has(WHITE) ? '先买' : '  -'}  ` +
        `总收益 ${((baseSec - r.finalSec) * bodyPerSec).toFixed(3)} 马身 / ${r.totalPt}pt`,
      );
    }
  }

  }
  console.log('\n注:金的显示价(304/320/288)是 UI 上直接读的,不推算 —— 上面只扫「下位白」和「单圈 ○」。');
  console.log('    因为 增量 = 金显示价 − 白实付价,而 ◎ 价 = ◎基准 × (○实付 / ○基准),它们都随实付价走。');
  void Object.keys({} as Variant);
}

void main();
