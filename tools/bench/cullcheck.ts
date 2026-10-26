/**
 * 两个针对具体风险的定点检查:
 *
 *  1) 贪心的「永久 no-gain 剔除」到底有没有真的剔掉后来用得上的技能。
 *     optimizer.ts greedyFill 在「所有买得起的候选边际都 ≈0」时,
 *     会把这些候选**永久**标成 no-gain(后续所有阶段都只看 pool(),
 *     再也回不来)。这对「先攒够 N 个技能才发动」的技能是反向的。
 *
 *  2) 搜索没找到最优的那些实例,到底需要多大的邻域才能修好
 *     (1出1入 / 2出1入 / 2出2入)。
 *
 * 用法: npx tsx tools/bench/cullcheck.ts --plan app/_debug/plan_v2.json
 */
import { optimize } from '../../src/optimizer.js';
import { loadPlan } from './probe.js';
import { SKILL_INDEX, expandPool, skillsOf, totalSpent, isBlocked, ExpectedEvaluator, type Item } from './model.js';

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
  const instanceSeeds = Number(args.get('instances') ?? 12);

  const { course, runner, candidates } = loadPlan(planPath);
  const ev = new ExpectedEvaluator(course, runner);

  console.log(`=== 永久 no-gain 剔除检查 ${planPath}`);
  let total = 0;
  let everCulled = 0;
  let culledUseful = 0;
  const detail: string[] = [];

  for (let i = 0; i < instanceSeeds; i++) {
    const budget = [700, 1000, 1400, 2034][i % 4]!;
    const usable = candidates.filter(c => {
      const sk = SKILL_INDEX.get(c.id);
      return sk !== undefined && c.pt <= budget && !isBlocked(sk, course, runner);
    });
    const rnd = lcg(20261026 + i * 977);
    const pool = usable.slice();
    for (let j = pool.length - 1; j > 0; j--) { const r = Math.floor(rnd() * (j + 1)); [pool[j], pool[r]] = [pool[r]!, pool[j]!]; }
    const inst = pool.slice(0, 10);
    const r = optimize({ course, runner, candidates: inst, budget });
    const noGain = r.rejected.filter(x => x.reason === 'no-gain');
    total++;
    if (noGain.length === 0) continue;
    everCulled++;

    // 被永久剔除的技能,放到**最终组合**上是不是其实有正收益?
    const items = expandPool(inst);
    const allMap = new Map(items.map((x: Item) => [x.id, x] as const));
    const chosenItems = r.chosen.map(c => allMap.get(c.id)!);
    const baseSec = ev.evaluate(skillsOf(chosenItems));
    const spent0 = totalSpent(chosenItems, allMap);
    for (const ng of noGain) {
      const cand = allMap.get(ng.id);
      if (cand === undefined) continue;
      if (spent0 + ng.pt > budget) continue;          // 预算装不下,不算被白白剔掉
      const after = ev.evaluate(skillsOf([...chosenItems, cand]));
      if (baseSec - after > 0.0005) {
        culledUseful++;
        if (detail.length < 8) detail.push(`  实例#${i + 1}(预算${budget}): 「${ng.name}」被永久剔除,但加到最终组合上仍多 ${(((baseSec - after) * ev.spurtTargetSpeed(skillsOf([...chosenItems, cand]))) / 2.5).toFixed(3)} 马身`);
      }
    }
  }
  console.log(`跑了 ${total} 个随机实例`);
  console.log(`发生过 no-gain 永久剔除的实例: ${everCulled}/${total}`);
  console.log(`其中「被剔除但加到最终组合上仍有正收益且买得起」的技能数: ${culledUseful}`);
  if (detail.length > 0) { console.log('明细:'); for (const d of detail) console.log(d); }
  else console.log('→ 本轮实例里没观察到这个陷阱被触发(风险存在但未复现)');
}

void main();
