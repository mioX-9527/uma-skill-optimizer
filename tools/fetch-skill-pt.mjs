// 从 BWIKI SMW 批量抓「技能消耗PT」,产出 data/skill-pt.json(日文页名 → PT)。
//
// 为什么需要:单双圈(○/◎)占同一格,游戏列表里只会显示**当前可买的那一级**的价格 ——
// 没买 ○ 时看不到 ◎ 的价格。优化器要把 ◎ 也作为一个独立候选(买 ○ 之后才能买 ◎,
// 两笔费用分开付),就必须有 ◎ 的价格,这只能从 wiki 拿,不能瞎编。
//
// 用 SMW ask 一次批量查询(不是逐页抓),对限流友好;BWIKI 有 EdgeOne 防护,
// 所以依然带超时与退避(见 fetch-evolutions.mjs 的教训)。
// 注意:这个文件是纯 .mjs,别写 TS 类型标注(node 直接跑)。
//
// 用法:node tools/fetch-skill-pt.mjs
// 产出:data/skill-pt.json

import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://wiki.biligame.com/umamusume/api.php';
const UA = 'Mozilla/5.0 (research; uma-skill-optimizer)';
const PAGE_SIZE = 2000;                      // SMW 单页上限;自动按 offset 翻页
const PROP = '技能消耗PT';

/** 单次 ask;返回 {results, nextOffset} */
async function ask(query, offset) {
  const url = `${API}?action=ask&format=json&query=${encodeURIComponent(query)}&offset=${offset}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
      if (r.status === 567 || r.status === 429) {
        console.warn(`  [限流 ${r.status}] offset=${offset},退避 30s…`);
        await new Promise(res => setTimeout(res, 30000));
        continue;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      const results = j.query?.results ?? {};
      // SMW 的续页 offset 放在 query-continue-offset(也有版本放 query.offset)
      const next = j['query-continue-offset'] ?? j.query?.offset ?? null;
      return { results, nextOffset: typeof next === 'number' && next > 0 ? next : null };
    } catch (e) {
      console.warn(`  [重试 ${attempt + 1}/3] offset=${offset}:${e}`);
      await new Promise(res => setTimeout(res, 5000));
    }
  }
  throw new Error(`ask 连续失败(offset=${offset});稍后再跑一次即可`);
}

async function main() {
  const query = `[[${PROP}::+]]|?${PROP}|limit=${PAGE_SIZE}`;
  const pt = {};
  let offset = 0;
  for (;;) {
    let page;
    try {
      page = await ask(query, offset);
    } catch (e) {
      // 别让一页失败丢掉全部:写出已拿到的部分并提示补跑
      console.warn(`  [放弃 offset=${offset}] ${e.message}`);
      break;
    }
    const { results, nextOffset } = page;
    for (const [title, v] of Object.entries(results)) {
      // 繁体页(繁/xxx)跳过:与简体同价,按简体名入库
      if (title.startsWith('繁/')) continue;
      const raw = v.printouts?.[PROP]?.[0];
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0) pt[title] = n;
    }
    console.log(`  offset=${offset} 累计 ${Object.keys(pt).length} 条`);
    if (nextOffset === null) break;
    offset = nextOffset;
  }

  const out = resolve(ROOT, 'data/skill-pt.json');
  writeFileSync(out, JSON.stringify({
    note: '技能 PT 价格表(BWIKI SMW 技能消耗PT,日文页名 → PT)。用途:单双圈占同一格,'
        + '游戏列表只显示当前可买级的价格,◎ 的价格只能从这里拿;两笔购买分开付。',
    source: `BWIKI SMW ask: [[${PROP}::+]]|?${PROP}`,
    fetchedAt: new Date().toISOString(),
    pt,
  }, null, 2) + '\n', 'utf8');
  console.log(`\n写出 ${out}(${Object.keys(pt).length} 条)`);
}

main().catch(e => { console.error(e); process.exit(1); });
