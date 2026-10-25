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
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://wiki.biligame.com/umamusume/api.php';
const UA = 'Mozilla/5.0 (research; uma-skill-optimizer)';
const CONCURRENCY = 2;   // 别调高:BWIKI 有 EdgeOne 防护,2026-10-25 连续请求被限流拦截(返回 567 拦截页)

async function parseHtml(page) {
  const url = `${API}?action=parse&page=${encodeURIComponent(page)}&prop=text&format=json`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // **必须带超时**:被 EdgeOne 限流时连接会被挂住(实测无超时整个抓取卡死在半路)
      const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15_000) });
      if (r.status === 404) return null;
      if (r.status === 567 || r.status === 429) {
        // 限流:退避 30s 再试(继续硬打只会越封越久)
        console.warn(`  [限流 ${r.status}] ${page},退避 30s…`);
        await new Promise(res => setTimeout(res, 30_000));
        continue;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      return j.parse?.text?.['*'] ?? null;
    } catch (e) {
      if (attempt === 2) return null;
      await new Promise(res => setTimeout(res, 5_000));
    }
  }
  return null;
}

/** HTML 实体 → 原文(wiki 的 title 里会出现 &#39; 这类转义) */
export function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;/g, "'");
}

/**
 * 抠「可进化技能」那一行里的技能名(日文标题,也就是页面名)。
 *
 * **不能按 `</tr>` 截断**(2026-10-25 踩坑):这一格里每个进化技能是一个
 * `<span class="popup">`,悬浮说明里还嵌着**内嵌表格**(有自己的 `<tr>`)——
 * 第一个 `</tr>` 就把后面全截掉了,实测「迅速果断」有 6 个进化只抓到 1 个。
 *
 * 正确做法:逐个 popup span 做**标签配平**找到块尾,取块内第一个 `title`
 * (即图标链接的名字);块与块之间若直接出现 `</td>`,说明单元格结束。
 */
export function evolvables(html) {
  if (html === null) return null;
  const i = html.indexOf('可进化技能');
  if (i < 0) return null;                       // 该页没有这个栏位 = 不能进化
  const rest = html.slice(i);
  const spanRe = /<\/?span\b/g;
  const names = [];
  let searchFrom = 0;
  for (;;) {
    const start = rest.indexOf('<span class="popup"', searchFrom);
    if (start < 0) break;
    // 配平 <span>/</span> 找这个 popup 的块尾(悬浮说明里的嵌套 span 也要算进去)
    // 注意正则匹配到的是 `</span`(不带 >,因为 \b 停在 n 后面),判闭合要用 startsWith,不能全等
    spanRe.lastIndex = start;
    let depth = 0;
    let end = rest.length;
    let m;
    while ((m = spanRe.exec(rest)) !== null) {
      depth += m[0].startsWith('</') ? -1 : 1;
      if (depth === 0) { end = m.index + m[0].length; break; }
    }
    const block = rest.slice(start, end);
    const t = (block.match(/<a [^>]*title="([^"]+)"/) ?? [])[1];
    if (t !== undefined) names.push(decodeEntities(t));
    // 块之后、下一个 popup 之前出现 `</td>` = 这一格结束
    const next = rest.indexOf('<span class="popup"', end);
    const between = rest.slice(end, next < 0 ? Math.min(rest.length, end + 500) : next);
    if (between.includes('</td>')) break;
    searchFrom = end;
  }
  return [...new Set(names)];
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

// 只在直接执行时才联网抓取;被 vitest import 时跳过(解析函数有离线回归)
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error(e); process.exit(1); });
}
