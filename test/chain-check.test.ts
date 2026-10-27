import { describe, expect, it } from 'vitest';
import { describeMissingChains, findMissingChains } from '../src/chain-check.js';
import { CIRCLE_BASE, SKILL_CHAINS } from '../src/data.js';

/**
 * P9 回归:金技能 → 下位白 关系漏声明的检测。
 *
 * 为什么必须有测试:这条链断了不会报错、不会崩溃,只会让收益/计价静默失真
 * (实测去掉声明后 plan_v2 从 10.497 → 9.896 马身,−0.601)。这种"安静的错"只能靠断言钉住。
 */

/** 取技能链里的一对真实数据做夹具(不硬编码名字,数据更新后仍然有效) */
const sample = [...SKILL_CHAINS.values()].find(c => c.prereqId !== c.skillId)!;
const GOLD = sample.skillId;
const WHITE = sample.prereqId;

describe('findMissingChains', () => {
  it('金技能在候选里、没声明关系 → 必须报出来', () => {
    const r = findMissingChains({ candidateIds: [GOLD, WHITE, '999999'], declared: new Map() });
    expect(r).toHaveLength(1);
    expect(r[0]!.skillId).toBe(GOLD);
    expect(r[0]!.prereqId).toBe(WHITE);
    expect(r[0]!.totalCost).toBeGreaterThan(r[0]!.cost);
  });

  it('下位白也在候选里 → 标记为「会被重复计价」', () => {
    const r = findMissingChains({ candidateIds: [GOLD, WHITE], declared: new Map() });
    expect(r[0]!.prereqInPlan).toBe(true);
  });

  it('下位白不在候选里 → 视为已买过,不报(报了就是噪音)', () => {
    // 实测每份真实 plan 都会命中这种条目(迅速果断 / 向前抢位),一旦误报就变成"狼来了"
    expect(findMissingChains({ candidateIds: [GOLD], declared: new Map() })).toEqual([]);
  });

  it('已声明关系 → 不报(不判断声明对不对,那是另一份证据的事)', () => {
    const r = findMissingChains({ candidateIds: [GOLD, WHITE], declared: new Map([[GOLD, WHITE]]) });
    expect(r).toEqual([]);
  });

  it('金技能不在候选里 → 不报', () => {
    expect(findMissingChains({ candidateIds: [WHITE, '999999'], declared: new Map() })).toEqual([]);
  });

  it('没有链的普通技能 → 不报', () => {
    // 候选里塞一堆非金技能,不应该有任何提示
    const normals = [...SKILL_CHAINS.values()].map(c => c.prereqId).filter(id => !SKILL_CHAINS.has(id));
    expect(findMissingChains({ candidateIds: normals.slice(0, 20), declared: new Map() })).toEqual([]);
  });

  it('双圈 ◎ → ○ 不算漏声明(同格共价由单双圈表自动处理,报了是噪音)', () => {
    // 链表 249 条里有 44 条是双圈;这些即使 ○ 也在候选里也不需要 plan.chains
    const circle = [...SKILL_CHAINS.values()].find(c => CIRCLE_BASE.has(c.skillId));
    expect(circle).toBeDefined();
    const r = findMissingChains({
      candidateIds: [circle!.skillId, circle!.prereqId],
      declared: new Map(),
    });
    expect(r.some(m => m.skillId === circle!.skillId)).toBe(false);
  });

  it('多条漏声明按名字排序,提示文案点名到技能', () => {
    const two = [...SKILL_CHAINS.values()].slice(0, 2);
    const ids = two.flatMap(c => [c.skillId, c.prereqId]);
    const r = findMissingChains({ candidateIds: ids, declared: new Map() });
    expect(r).toHaveLength(2);
    const text = describeMissingChains(r);
    expect(text).toContain('2 条');
    for (const t of two) expect(text).toContain(t.skillName);
    expect(describeMissingChains([])).toBe('');
  });
});
