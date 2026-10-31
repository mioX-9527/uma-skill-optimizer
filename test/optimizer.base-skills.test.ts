import { describe, expect, it } from 'vitest';
import { COURSES, SKILLS } from '../src/data.js';
import { sampleableSpans, simulate, skillApplicable } from '../src/engine/index.js';
import { optimize } from '../src/optimizer.js';
import type { SkillConfig } from '../src/engine/index.js';

const course = COURSES.find(c => c.id === 'c10101')!; // 札幌 草 1400m(短,模拟快)
const runner = {
  stats: { speed: 1200, stamina: 900, power: 1100, guts: 700, wisdom: 900 },
  greenBonus: {},
  tactic: 'senko' as const,
  distanceAptitude: 'A' as const,
  surfaceAptitude: 'A' as const,
  motivation: 'normal' as const,
  skills: [],
};

const byId = (id: string): SkillConfig => SKILLS.find(s => s.id === id)!;
const byName = (name: string): SkillConfig => SKILLS.find(s => s.name === name)!;

/** 便宜且会生效的白技能候选 */
function cheapCands(n: number, pt = 100): { id: string; pt: number }[] {
  return SKILLS.filter(s =>
    s.rarity === 'normal' && s.precision === 'precise'
    && s.randomPosition !== true
    && !s.effects.some(e => e.type === 'unsupported')
    && skillApplicable(s, course, runner))
    .slice(0, n)
    .map(s => ({ id: s.id, pt }));
}

/** 与 optimizer 相同口径的"区段中点/期望取位"复算工具(只用于回归断言) */
function quantileToMeter(spans: readonly [number, number][], u: number): number {
  let target = u * spans.reduce((a, s) => a + (s[1] - s[0]), 0);
  for (const s of spans) {
    const len = s[1] - s[0];
    if (target <= len) return s[0] + target;
    target -= len;
  }
  return spans[spans.length - 1]![1];
}

describe('optimize baseSkills(背景技能)', () => {
  it('背景技能进基线:基线比无背景时更快,结果里带背景摘要', () => {
    const green = SKILLS.find(s =>
      s.rarity === 'normal'
      && s.effects.length > 0 && s.effects.every(e => e.type === 'passive')
      && s.condition.kind === 'raceStart'
      && s.prereq === undefined && skillApplicable(s, course, runner))!;
    const plain = optimize({ course, runner, candidates: cheapCands(8), budget: 500, maxSims: 20000 });
    const withBase = optimize({
      course, runner, candidates: cheapCands(8), budget: 500, maxSims: 20000,
      baseSkills: [green.id],
    });
    expect(withBase.baseSkills).toEqual([{ id: green.id, name: green.name }]);
    expect(withBase.baselineSec).toBeLessThan(plain.baselineSec);   // 绿技能加成进了基线
    // 基线抬高后,同一批候选的边际变少 → 总马身不应大于无背景时
    expect(withBase.totalBody).toBeLessThanOrEqual(plain.totalBody + 1e-6);
  });

  it('候选与背景同 id → 标「已学习」剔除,不进推荐也不占预算', () => {
    const owned = cheapCands(3, 100)[0]!;
    const r = optimize({
      course, runner,
      candidates: [owned, ...cheapCands(3, 100).filter(c => c.id !== owned.id)],
      budget: 500, maxSims: 20000,
      baseSkills: [owned.id],
    });
    expect(r.chosen.find(c => c.id === owned.id)).toBeUndefined();
    const rej = r.rejected.find(x => x.id === owned.id)!;
    expect(rej.reason).toBe('inapplicable');
    expect(rej.detail).toContain('已学习');
    expect(r.baseSkills.map(b => b.id)).toContain(owned.id);
  });

  it('背景白 + 候选金:模拟里白被金替换(不叠加),实付价按游戏显示口径', () => {
    const white = byName('良场地○');
    const gold = byName('良场地恶煞');
    // 手工算"只装金"的完赛时间:效果被金替换,背景白不应与金叠加
    // (参照 optimizer.ts 注释里的实测:白+金叠加 56.5092s vs 只装金 56.5253s)
    const goldOnly = simulate(course, { ...runner, skills: [gold] });
    // 场景 A(现实流程):白已拥有时,游戏列表里金显示的就是差额价(284-160=124),无需 requires
    const a = optimize({
      course, runner,
      candidates: [{ id: gold.id, pt: 124 }],
      budget: 500, maxSims: 20000,
      baseSkills: [white.id],
    });
    expect(a.chosen.map(c => c.id)).toContain(gold.id);
    expect(a.finalSec).toBeCloseTo(goldOnly.finishTimeSec, 6);
    expect(a.totalPt).toBe(124);
    // 场景 B:白同时被(误)列成候选 → 被标「已学习」剔除,金按 requires 抵扣差额
    const b = optimize({
      course, runner,
      candidates: [{ id: gold.id, pt: 284, requires: white.id }, { id: white.id, pt: 160 }],
      budget: 500, maxSims: 20000,
      baseSkills: [white.id],
    });
    expect(b.chosen.map(c => c.id)).toContain(gold.id);
    expect(b.chosen.find(c => c.id === white.id)).toBeUndefined();
    expect(b.totalPt).toBe(284 - 160);
  });

  it('背景里同时有金和下位白:白被金替换(不叠加),模拟等价于只装金', () => {
    const gold = byName('先走一步！');
    const white = byName('游戏到此为止！');
    const goldOnly = simulate(course, { ...runner, skills: [gold] });
    const stacked = simulate(course, { ...runner, skills: [gold, white] });
    expect(stacked.finishTimeSec).not.toBeCloseTo(goldOnly.finishTimeSec, 3);   // 两片确实有差,测试才有效
    const r = optimize({
      course, runner, candidates: [], budget: 500, maxSims: 20000,
      baseSkills: [gold.id, white.id],
    });
    // 游戏内机制:买金自动拥有白,效果被金**替换** —— 背景里两块都读到也只该算金
    expect(r.finalSec).toBeCloseTo(goldOnly.finishTimeSec, 6);
    expect(r.finalSec).not.toBeCloseTo(stacked.finishTimeSec, 3);
  });

  it('背景里 ○/◎ 两级全占(数据缺边的超长距离回复):名字兜底顶替不崩溃,结果=只装◎', () => {
    // 这对的边在 CIRCLE_BASE/SKILL_CHAINS 里都缺(◎ 无基准价),靠名字配对兜底;
    // 且数据里 ○/◎ 效果数值恰好相同,叠加与否不可区分 —— 断言只验证结果与只装◎一致
    const o = byName('超长距离回复○');
    const d = byName('超长距离回复◎');
    const dOnly = simulate(course, { ...runner, skills: [d] });
    const r = optimize({
      course, runner, candidates: [], budget: 500, maxSims: 20000,
      baseSkills: [o.id, d.id],
    });
    expect(r.finalSec).toBeCloseTo(dOnly.finishTimeSec, 6);
  });

  it('绿缩放固有:同一配置下,perGreen 越大 → 选中绿候选后完赛越快;greenCount 如实报告', () => {
    const green = SKILLS.find(s =>
      s.rarity === 'normal'
      && s.effects.length > 0 && s.effects.every(e => e.type === 'passive')
      && s.condition.kind === 'raceStart'
      && s.prereq === undefined && skillApplicable(s, course, runner))!;
    const zero = optimize({
      course, runner, candidates: [{ id: green.id, pt: 100 }], budget: 500, maxSims: 20000,
      baseSkills: ['100981'],
      greenScaling: { '100981': { base: [{ type: 'targetSpeed', value: 0.25 }], perGreen: [] } },
    });
    const big = optimize({
      course, runner, candidates: [{ id: green.id, pt: 100 }], budget: 500, maxSims: 20000,
      baseSkills: ['100981'],
      greenScaling: {
        '100981': {
          base: [{ type: 'targetSpeed', value: 0.25 }],
          perGreen: [{ type: 'targetSpeed', value: 0.05 }, { type: 'acceleration', value: 0.05 }],
        },
      },
    });
    expect(zero.chosen.map(c => c.id)).toContain(green.id);
    expect(big.chosen.map(c => c.id)).toContain(green.id);
    expect(big.greenCount).toBe(1);
    expect(big.finalSec).toBeLessThan(zero.finalSec);   // 绿候选给固有加了成 → 更快
    expect(big.totalBody).toBeGreaterThan(zero.totalBody);
  });

  it('绿缩放引擎原生生效:不传 greenScaling 时 100981 按上游 scaleByGreen 展开(1 绿=纯 0.25)', () => {
    const green = SKILLS.find(s =>
      s.rarity === 'normal'
      && s.effects.length > 0 && s.effects.every(e => e.type === 'passive')
      && s.condition.kind === 'raceStart'
      && s.prereq === undefined && skillApplicable(s, course, runner))!;
    const withDefault = optimize({
      course, runner, candidates: [{ id: green.id, pt: 100 }], budget: 500, maxSims: 20000,
      baseSkills: ['100981'],
    });
    // 手工复算:分档模型下 1 绿落在「0-2 绿:无增量」档 → 效果 = 纯 0.25 速度。
    // 固有是 randomPosition,finalSec 走 12 点期望口径 → 取位也要复刻
    const derived: SkillConfig = {
      ...byId('100981'),
      effects: [{ type: 'targetSpeed', value: 0.25 }],
    };
    const spans = sampleableSpans(derived.condition, course)!;
    let sum = 0;
    const N = 12;
    for (let i = 0; i < N; i++) {
      const ov = new Map([[derived.id, quantileToMeter(spans as [number, number][], (i + 0.5) / N)]]);
      sum += simulate(course, { ...runner, skills: [derived, byId(green.id)] }, { positionOverrides: ov }).finishTimeSec;
    }
    expect(withDefault.finalSec).toBeCloseTo(sum / N, 6);
  });

  it('带装配限制的绿技能不计入绿技能数(restriction 不满足)', () => {
    const restricted = SKILLS.find(s =>
      s.rarity === 'normal'
      && s.effects.length > 0 && s.effects.every(e => e.type === 'passive')
      && s.condition.kind === 'raceStart' && s.prereq === undefined
      && s.restriction !== undefined && !skillApplicable(s, course, runner));
    if (restricted === undefined) return;   // 数据里暂无此类技能时跳过
    const applicable = SKILLS.find(s =>
      s.rarity === 'normal'
      && s.effects.length > 0 && s.effects.every(e => e.type === 'passive')
      && s.condition.kind === 'raceStart' && s.prereq === undefined
      && skillApplicable(s, course, runner))!;
    const r = optimize({
      course, runner, candidates: [], budget: 500, maxSims: 20000,
      baseSkills: [restricted.id, applicable.id],
    });
    expect(r.greenCount).toBe(1);
  });

  it('randomPosition 固有在背景里:期望口径取位覆盖背景(与手工 12 点期望一致)', () => {
    const uniq = byId('100981');          // randomPosition: true
    expect(uniq.randomPosition).toBe(true);
    const cand = cheapCands(1, 100)[0]!;
    const candSkill = byId(cand.id);
    const r = optimize({
      course, runner, candidates: [cand], budget: 500, maxSims: 20000,
      baseSkills: [uniq.id],
    });
    expect(r.chosen.map(c => c.id)).toContain(cand.id);
    // 手工复算期望口径:两个随机技能一起在各自满足区段上取同一组分位点。
    // 默认表是分档模型:绿数 ≤2 时无追加 → 固有效果 = 纯 0.25 速度(与绿数无关)
    const uniqDerived: SkillConfig = { ...uniq, effects: [{ type: 'targetSpeed', value: 0.25 }] };
    const uniqSpans = sampleableSpans(uniq.condition, course)!;
    const candSpans = sampleableSpans(candSkill.condition, course);
    let sum = 0;
    const N = 12;
    for (let i = 0; i < N; i++) {
      const u = (i + 0.5) / N;
      const ov = new Map<string, number>([[uniq.id, quantileToMeter(uniqSpans as [number, number][], u)]]);
      if (candSpans !== null) ov.set(candSkill.id, quantileToMeter(candSpans as [number, number][], u));
      sum += simulate(course, { ...runner, skills: [uniqDerived, candSkill] }, { positionOverrides: ov }).finishTimeSec;
    }
    expect(r.finalSec).toBeCloseTo(sum / N, 6);
  });
});
