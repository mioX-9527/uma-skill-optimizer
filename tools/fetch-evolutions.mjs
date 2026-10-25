// 从 BWIKI 抓「金技能 → 可进化技能」的关系。
//
// 为什么单独抓:进化技能(evolved)是金技能**达成条件后免费进化**来的,效果与金技能不同
// (一般更强、常带额外效果)。要按进化前后分别算收益,就必须知道哪个金技能能进化成哪个。
//
// 这个关系**不在 SMW 属性里**(`?可进化技能` 查出来是空数组),而是模板内嵌 query 现算的,
// 所以只能解析渲染后的 HTML:页面里有一行「可进化技能」,`<td>` 里是带 title 的 `<a>`。
// 顺带确认:白技能页面根本没有这一行(返回 null),所以只对金技能跑。
//
// 用法:node tools/fetch-evolutions.mjs
// 产出:data/skill-evolutions.json

import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://wiki.biligame.com/umamusume/api.php';
const UA = 'Mozilla/5.0 (research; uma-skill-optimizer)';
const CONCURRENCY = 6;

async function parseHtml(page) {
  const url = `${API}?action=parse&page=${encodeURIComponent(page)}&prop=text&format=json`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA } });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      return j.parse?.text?.['*'] ?? null;
    } catch (e) {
      if (attempt === 1) return null;
      await new Promise(res => setTimeout(res, 800));
    }
  }
  return null;
}

/** HTML 实体 → 原文(wiki 的 title 里会出现 &#39; 这类转义) */
function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;/g, "'");
}

/** 抠「可进化技能」那一行里的技能名(日文标题,也就是页面名) */
function evolvables(html) {
  if (html === null) return null;
  const i = html.indexOf('可进化技能');
  if (i < 0) return null;                       // 该页没有这个栏位 = 不能进化
  const end = html.indexOf('</tr>', i);
  const seg = html.slice(i, end < 0 ? i + 2000 : end);
  return [...new Set([...seg.matchAll(/<a [^>]*title="([^"]+)"/g)].map(m => decodeEntities(m[1])))];
}

async function pool(items, worker, limit) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await worker(items[i], i);
    }
  }));
  return out;
}

async function main() {
  const skills = JSON.parse(readFileSync(resolve(ROOT, 'data/skills.json'), 'utf8'));
  const cn = skills.filter(s => s.cnReleased !== false);
  const gold = cn.filter(s => s.rarity === 'rareEvolved');
  console.log(`国服金技能 ${gold.length} 个,开始查可进化技能(并发 ${CONCURRENCY})…`);

  // 进化技能按日文名建索引(wiki 给的是日文标题)
  const evoByJa = new Map();
  const evoByCn = new Map();
  for (const s of cn) {
    if (s.rarity !== 'evolved') continue;
    if (s.nameJa) evoByJa.set(s.nameJa, s);
    evoByCn.set(s.name, s);
  }

  let done = 0;
  const rows = await pool(gold, async (g) => {
    const html = await parseHtml(g.nameJa ?? g.name);
    const names = evolvables(html);
    done++;
    if (done % 40 === 0) process.stdout.write(`  ${done}/${gold.length}\n`);
    if (names === null || names.length === 0) return null;

    const targets = names.map(n => evoByJa.get(n) ?? evoByCn.get(n) ?? null).filter(Boolean);
    const missing = names.filter(n => !evoByJa.has(n) && !evoByCn.has(n));
    return { from: g, targets, missing, found: html !== null };
  }, CONCURRENCY);

  const evolutions = [];
  const missingNames = new Set();
  const noPage = [];
  for (const row of rows) {
    if (row === null) continue;
    if (!row.found) { noPage.push(row.from.name); continue; }
    for (const m of row.missing) missingNames.add(m);
    for (const t of row.targets) {
      evolutions.push({
        fromId: row.from.id,
        from: row.from.name,
        fromEffects: row.from.effects,
        fromDurationSec: row.from.durationSec,
        toId: t.id,
        to: t.name,
        toNameJa: t.nameJa ?? null,
        toEffects: t.effects,
        toDurationSec: t.durationSec,
      });
    }
  }

  const out = resolve(ROOT, 'data/skill-evolutions.json');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({
    generatedAt: new Date().toISOString(),
    source: 'BWIKI action=parse HTML: 技能页「可进化技能」栏(模板内嵌 query,不在 SMW 属性里)',
    note: '金技能达成条件后免费进化成 to; 两者效果不同,要分别算收益',
    count: evolutions.length,
    evolutions,
  }, null, 2) + '\n', 'utf8');

  const fromCount = new Set(evolutions.map(e => e.fromId)).size;
  console.log(`\n写出 ${out}`);
  console.log(`  能进化的金技能 ${fromCount} / ${gold.length},进化关系 ${evolutions.length} 条`);
  console.log(`  进化技能名对不上 ${missingNames.size} 个${missingNames.size ? ':' + [...missingNames].slice(0, 6).join('、') : ''}`);
  console.log(`  页面取不到 ${noPage.length} 个${noPage.length ? ':' + noPage.slice(0, 5).join('、') : ''}`);
}

main().catch(e => { console.error(e); process.exit(1); });
