/**
 * 「可进化技能」行解析的离线回归(不联网)。
 *
 * 踩的坑(2026-10-25,用户指出「迅速果断有 6 个进化的」):旧实现按第一个 `</tr>` 截断,
 * 而这一格里每个进化技能是一个 `<span class="popup">`,悬浮说明里还嵌着**内嵌表格**
 * (有自己的 `<tr>`)—— 结果 6 个进化只抓到 1 个,数据文件把雷腾云奔等 5 个方向全丢了,
 * 进而让我据它做出了「迅速果断只有一个进化方向」的错误结论。
 *
 * 结构按 2026-10-25 实抓的 BWIKI HTML 仿造:
 *   <td> 里是 6 个连续的 <span class="popup">(图标+隐藏悬浮说明,说明里有内嵌表格),
 *   格子以 </span></span>\n</td></tr> 结束,后面是「相关支援卡」等其他区块(也有 popup,不能混进来)。
 */
import { describe, expect, it } from 'vitest';
// @ts-expect-error 工具脚本是 .mjs,无类型声明(解析函数本身被本文件回归覆盖)
import { evolvables } from '../tools/fetch-evolutions.mjs';

/** 一个进化技能的 popup 块(图标链接 + 隐藏悬浮说明,说明里嵌内嵌表格) */
function popup(title: string, jaLabel: string): string {
  return `<span class="popup"><span style="display:inline-block;"><div class="sj-an">`
    + `<a href="/umamusume/${title}" title="${title}"><img alt="ico" /></a>&#160;`
    + `<a href="/umamusume/${title}" title="${title}"><font>${jaLabel}</font></a></div></span>`
    + `<span style="display:none;min-width:300px" data-size="500"><div style="line-height:27px">${jaLabel}/中文名<hr />`
    + `<table><tbody><tr><td>内嵌说明表格(有自己的 &lt;tr&gt;,会骗过按 &lt;/tr&gt; 截断的旧实现)</td></tr></tbody></table>`
    + `</div></span></span>`;
}

const SIX = ['真夏の思い切り', '雷騰雲奔', 'ちゃちゃっと始めんで！', 'ウイニングロード', '急行！ヒーロー参上！', 'アンビシャスカード'];

const PAGE = `<table><tbody>`
  + `<tr><th>触发条件</th><td>居中,中盘随机位置</td></tr>`
  + `<tr><th>可解锁技能\n</th>\n<td>\n</td></tr>`
  // 可进化技能行:6 个连续 popup,格子以 </span></span>\n</td></tr> 结束
  + `<tr><th>可进化技能\n</th>\n<td>${SIX.map(n => popup(n, n)).join('')}</td></tr></tbody></table>`
  // 后面的区块同样用 popup(支援卡),绝不能混进进化列表
  + `<div><table><tbody><tr><th>相关支援卡</th></tr><tr><th>SSR</th><td>`
  + popup('サポートカード', '某支援卡')
  + `</td></tr></tbody></table></div>`;

describe('evolvables(可进化技能行解析)', () => {
  it('6 个进化方向一个不少(按 </tr> 截断的旧实现只能抓到 1 个)', () => {
    expect(evolvables(PAGE)).toEqual(SIX);
  });

  it('popup 里重复出现的同名链接去重', () => {
    const one = `<tr><th>可进化技能</th><td>${popup('雷騰雲奔', '雷騰雲奔')}</td></tr>`;
    expect(evolvables(one)).toEqual(['雷騰雲奔']);
  });

  it('该页没有「可进化技能」栏位 = 不能进化(返回 null,与旧行为一致)', () => {
    expect(evolvables('<table><tr><th>技能描述</th><td>x</td></tr></table>')).toBeNull();
  });

  it('栏位存在但为空 = 返回空数组(金技能未开放进化)', () => {
    expect(evolvables('<tr><th>可进化技能\n</th>\n<td>\n</td></tr>')).toEqual([]);
  });
});

/**
 * 数据文件完整性:解析器修好后重抓的数据必须与 BWIKI 页面一致。
 * 用户 2026-10-25 指出「迅速果断有 6 个进化的」,而旧数据只有 1 条 —— 这条锁住那个回归。
 * (重新生成:`node tools/fetch-evolutions.mjs`;被限流时它会自己退避,别调高并发。)
 */
describe('skill-evolutions.json 数据完整性', () => {
  it('迅速果断(200591)有 6 个进化方向,含雷腾云奔', async () => {
    const { default: data } = await import('../data/skill-evolutions.json');
    const dirs = data.evolutions.filter((e: { fromId: string }) => e.fromId === '200591');
    expect(dirs.length).toBe(6);
    const toIds = dirs.map((e: { toId: string }) => e.toId);
    expect(toIds).toContain('102101111'); // 雷腾云奔 —— 旧解析把它弄丢过
    expect(toIds).toContain('100102111'); // 盛夏的奋力一搏(同值但 2.4s→4s,收益最高)
  });

  it('多方向技能不少(解析截断会批量丢方向,不止迅速果断一个)', async () => {
    const { default: data } = await import('../data/skill-evolutions.json');
    const byFrom = new Map<string, number>();
    for (const e of data.evolutions) byFrom.set(e.fromId, (byFrom.get(e.fromId) ?? 0) + 1);
    const multi = [...byFrom.values()].filter(n => n > 1).length;
    expect(multi).toBeGreaterThanOrEqual(100);
  });
});
