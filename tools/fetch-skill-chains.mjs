// 从 BWIKI 抓「技能前置关系」(金技能 ← 下位白技能)。
//
// 为什么要这个:游戏里买了金技能的下位白技能后,金技能的价格会抵扣掉白的实付价。
// 所以「白 + 金」的实际总价 = 金技能单价,等于白技能免费。优化器按固定 pt 相加会低估这类组合。
// skills.json 没有这个关系,名字也推不出来(弧线大师 ← 弯道能手○),只能从 wiki 拿。
//
// wiki 用的是 Semantic MediaWiki,直接 ask 查询比爬页面稳:
//   [[ID::200331]]|?前置技能|?技能消耗PT|?共需技能PT
//   → 弧线大师 / 弯道能手○ / 180 / 360   (360 = 180 + 180,即"共需"含前置)
//
// 用法:node tools/fetch-skill-chains.mjs

import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://wiki.biligame.com/umamusume/api.php';
const UA = 'Mozilla/5.0 (research; uma-skill-optimizer)';

async function ask(query) {
  const url = `${API}?action=ask&format=json&query=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`ask 失败 HTTP ${res.status}`);
  const json = await res.json();
  return json.query?.results ?? {};
}

const first = (v) => (Array.isArray(v) ? v[0] : v) ?? null;

async function main() {
  console.log('查询 wiki(SMW ask)…');
  const results = await ask('[[前置技能::+]]|?前置技能|?技能消耗PT|?共需技能PT|limit=3000');
  console.log(`  命中 ${Object.keys(results).length} 个页面`);

  const skills = JSON.parse(readFileSync(resolve(ROOT, 'data/skills.json'), 'utf8'));
  // wiki 的页面名不带「(1)/(2)/(继承)」后缀,而 skills.json 里同一技能多等级会带 —— 两边都要能对上
  const stripSuffix = (n) => n.replace(/[（(][^）)]*[）)]\s*$/, '');
  const byName = new Map();
  const byStripped = new Map();
  for (const s of skills) {
    if (!byName.has(s.name)) byName.set(s.name, s);
    const st = stripSuffix(s.name);
    if (!byStripped.has(st)) byStripped.set(st, s);
  }
  const lookup = (n) => byName.get(n) ?? byStripped.get(stripSuffix(n)) ?? null;

  const chains = [];
  const unmatchedSkill = [];
  const unmatchedPrereq = [];

  for (const [page, item] of Object.entries(results)) {
    // 只要简中服页面:标题形如「简/弧线大师」,另有日文/繁中页会干扰
    if (!page.startsWith('简/')) continue;
    const cnName = page.slice(2);
    const prereqNames = (item.printouts?.['前置技能'] ?? []).map(String).filter(Boolean);
    if (prereqNames.length === 0) continue;

    const self = lookup(cnName);
    if (!self) { unmatchedSkill.push(cnName); continue; }

    for (const pn of prereqNames) {
      const pre = lookup(pn);
      if (!pre) { unmatchedPrereq.push(`${cnName} → ${pn}`); continue; }
      chains.push({
        skillId: self.id,
        skill: self.name,
        skillRarity: self.rarity,
        cost: Number(first(item.printouts?.['技能消耗PT'])) || null,
        totalCost: Number(first(item.printouts?.['共需技能PT'])) || null,
        prereqId: pre.id,
        prereq: pre.name,
        prereqRarity: pre.rarity,
      });
    }
  }

  // 前置自己的 pt 推不出来时,用"共需 − 本技能"补
  for (const c of chains) {
    if (c.cost && c.totalCost && !c.prereqCost) c.prereqCost = c.totalCost - c.cost;
  }

  const out = resolve(ROOT, 'data/skill-chains.json');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({
    generatedAt: new Date().toISOString(),
    source: 'BWIKI SMW ask: [[前置技能::+]]|?前置技能|?技能消耗PT|?共需技能PT',
    note: 'skillId 需要先买 prereqId;游戏里买了前置后,本技能价格会抵扣前置的实付价',
    count: chains.length,
    chains,
  }, null, 2) + '\n', 'utf8');

  const gold = chains.filter(c => c.skillRarity === 'rareEvolved').length;
  console.log(`\n写出 ${out}`);
  console.log(`  前置关系 ${chains.length} 条,其中金技能 ${gold} 条`);
  console.log(`  技能名在 skills.json 里找不到:${unmatchedSkill.length} 个`);
  if (unmatchedSkill.length) console.log('    ' + unmatchedSkill.slice(0, 8).join('、'));
  console.log(`  前置技能名找不到:${unmatchedPrereq.length} 个`);
  if (unmatchedPrereq.length) console.log('    ' + unmatchedPrereq.slice(0, 8).join('、'));

  // 覆盖率:350 个金技能里有多少条有前置
  const allGold = skills.filter(s => s.rarity === 'rareEvolved' && s.cnReleased !== false);
  const covered = new Set(chains.filter(c => c.skillRarity === 'rareEvolved').map(c => c.skillId));
  console.log(`  金技能覆盖:${covered.size} / ${allGold.length}`);
}

main().catch(e => { console.error(e); process.exit(1); });
