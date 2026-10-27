import { describe, expect, it } from 'vitest';
import { COURSES } from '../src/data.js';
import { MUST_CHECK, optimize } from '../src/optimizer.js';
import type { RunnerConfig } from '../src/engine/index.js';

/**
 * P8 回归:双圈 ◎ 的价格是从单圈 ○ 的实付价推算的。
 * 推算依据离谱时(OCR 读错)必须**把话说在最前面**(MUST_CHECK = CLI/UI 会提到表格之前),
 * 而不是静默回落到基准价让用户照着错的价比划。
 *
 * ○ 的价读偏 ±40pt 就能让推荐组合变化(±0.245 马身),比整个精修层的收益还大。
 *
 * 注意行为边界:只有当 ◎ 是**从 ○ 推算出来**的才有这个问题;玩家界面直接读到 ◎ 的价格时
 * (○ 和 ◎ 都在候选里)不推算,也就不报。
 */

const course = COURSES.find(c => c.id === '10601') ?? COURSES[0]!;
const runner: RunnerConfig = {
  stats: { speed: 1200, stamina: 1000, power: 1100, guts: 700, wisdom: 900 },
  greenBonus: {},
  tactic: 'senko',
  distanceAptitude: 'A',
  surfaceAptitude: 'A',
  motivation: 'normal',
  groundCondition: 0,
  weather: 1,
  season: 1,
  courseFix: 'auto',
  skills: [],
};

// 标准距离 ○ / ◎ 这一对(单圈基准 90pt / 双圈基准 110pt)
const BASE = '200132';
const UP = '200131';

describe('双圈 ◎ 的价格异常提示', () => {
  it('○ 实付价 2.2 倍基准(明显读错)→ 推算出的 ◎ 必须挂【必须核对】', () => {
    const r = optimize({ course, runner, candidates: [{ id: BASE, pt: 200 }], budget: 1200 });
    const hit = r.notes.filter(n => n.startsWith(MUST_CHECK));
    expect(hit).toHaveLength(1);
    expect(hit[0]).toContain('请核对');
    expect(hit[0]).toContain('标准距离');
  });

  it('○ 实付价低于基准 4 成 → 同样提示(折扣再低也不该低于 4 折)', () => {
    const r = optimize({ course, runner, candidates: [{ id: BASE, pt: 30 }], budget: 1200 });
    expect(r.notes.some(n => n.startsWith(MUST_CHECK))).toBe(true);
  });

  it('9 折(合理区间内)→ 不许乱报', () => {
    const r = optimize({ course, runner, candidates: [{ id: BASE, pt: 81 }], budget: 1200 });
    expect(r.notes.some(n => n.startsWith(MUST_CHECK))).toBe(false);
  });

  it('○ 和 ◎ 都是界面直接读到的价 → 不推算、不报', () => {
    const r = optimize({
      course, runner,
      candidates: [{ id: BASE, pt: 200 }, { id: UP, pt: 110 }],
      budget: 1200,
    });
    expect(r.notes.some(n => n.startsWith(MUST_CHECK))).toBe(false);
  });

  it('候选里没有单双圈 → 当然不报', () => {
    const r = optimize({ course, runner, candidates: [{ id: '200561', pt: 120 }], budget: 1200 });
    expect(r.notes.some(n => n.startsWith(MUST_CHECK))).toBe(false);
  });
});
