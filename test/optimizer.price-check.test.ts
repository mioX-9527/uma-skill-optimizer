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

describe('P9:上下位关系漏声明（结果会让价格失真）', () => {
  // 巅峰之梦(320pt, 含下位白 背负信念 180pt)—— plan_v2 里声明过这层关系
  const GOLD = '210291';
  const WHITE = '210292';

  it('金和白都在候选里、但没传 requires → 必须报【必须核对】', () => {
    const r = optimize({ course, runner, candidates: [{ id: GOLD, pt: 320 }, { id: WHITE, pt: 180 }], budget: 900 });
    const hit = r.notes.filter(n => n.startsWith(MUST_CHECK));
    expect(hit).toHaveLength(1);
    expect(hit[0]).toContain('上下位关系');
  });

  it('传了 requires(关系已声明)→ 不报', () => {
    const r = optimize({
      course, runner,
      candidates: [{ id: GOLD, pt: 320, requires: WHITE }, { id: WHITE, pt: 180 }],
      budget: 900,
    });
    expect(r.notes.some(n => n.startsWith(MUST_CHECK))).toBe(false);
  });

  it('只有金、白不在候选里(已买过)→ 不报', () => {
    const r = optimize({ course, runner, candidates: [{ id: GOLD, pt: 320 }], budget: 900 });
    expect(r.notes.some(n => n.startsWith(MUST_CHECK))).toBe(false);
  });
});

describe('缺价的单双圈方向要明说「没算」', () => {
  // 良场地○(200152):它的 ◎(良场地◎)在 skill-pt 里没有基准价 → 这个方向被跳过。
  // 用良场地而不是长距离弯道,是因为后者在本测试赛道上"不适配"会被过滤掉,测不到这条提示。
  const NO_PRICE = '200152';

  it('○ 有 ◎ 兄弟、但缺价格 → 提示"这次没有纳入比较"', () => {
    const r = optimize({ course, runner, candidates: [{ id: NO_PRICE, pt: 60 }], budget: 900 });
    const hit = r.notes.filter(n => n.includes('没有纳入比较'));
    expect(hit).toHaveLength(1);
    expect(hit[0]).toContain('良场地◎');
  });

  it('价格齐的方向(标准距离)不报这条', () => {
    const r = optimize({ course, runner, candidates: [{ id: BASE, pt: 81 }], budget: 900 });
    expect(r.notes.some(n => n.includes('没有纳入比较'))).toBe(false);
  });

  it('○ 不在候选里当然不报', () => {
    const r = optimize({ course, runner, candidates: [{ id: '200561', pt: 120 }], budget: 900 });
    expect(r.notes.some(n => n.includes('没有纳入比较'))).toBe(false);
  });
});
