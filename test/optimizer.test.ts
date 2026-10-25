import { describe, expect, it } from 'vitest';
import { COURSES, SKILLS } from '../src/data.js';
import { optimize } from '../src/optimizer.js';
import type { CandidateSkill } from '../src/optimizer.js';

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

/** 从技能库取候选(白技能优先,保证便宜可组合) */
function candidates(n: number, pt: number): CandidateSkill[] {
  return SKILLS.filter(s => s.rarity === 'normal' && s.precision === 'precise' && !s.effects.some(e => e.type === 'unsupported'))
    .slice(0, n)
    .map(s => ({ id: s.id, pt }));
}

describe('optimize', () => {
  it('预算为硬约束:总花费不超过预算', () => {
    const r = optimize({ course, runner, candidates: candidates(12, 90), budget: 500, maxSims: 20000 });
    expect(r.totalPt).toBeLessThanOrEqual(500);
    expect(r.chosen.every(c => c.pt <= 500)).toBe(true);
  });

  it('有正收益:总马身 > 0,且完赛快于无技能基准', () => {
    const r = optimize({ course, runner, candidates: candidates(12, 90), budget: 500, maxSims: 20000 });
    expect(r.chosen.length).toBeGreaterThan(0);
    expect(r.totalBody).toBeGreaterThan(0);
    expect(r.finalSec).toBeLessThan(r.baselineSec);
  });

  it('组合总收益不低于任何单项单独收益(贪心不劣于只买一个)', () => {
    const cands = candidates(12, 90);
    const r = optimize({ course, runner, candidates: cands, budget: 500, maxSims: 20000 });
    const soloBodies = cands.map(c =>
      optimize({ course, runner, candidates: [c], budget: 500, maxSims: 20000 }).totalBody,
    );
    expect(r.totalBody).toBeGreaterThanOrEqual(Math.max(...soloBodies) - 1e-6);
  });

  it('单项收益之和 ≠ 总收益(技能交互,结果需如实区分两个口径)', () => {
    const r = optimize({ course, runner, candidates: candidates(12, 90), budget: 500, maxSims: 20000 });
    // 同一个组合下两个口径都应有值;不预设谁大谁小,只要求报告区分
    expect(Number.isFinite(r.sumSoloBody)).toBe(true);
    expect(Number.isFinite(r.totalBody)).toBe(true);
  });

  it('超过预算的候选被拒,其余候选在 result.rejected 分类', () => {
    const cands = [...candidates(10, 90), { id: SKILLS[0]!.id, pt: 9999 }];
    const r = optimize({ course, runner, candidates: cands, budget: 500, maxSims: 20000 });
    expect(r.chosen.every(c => c.pt < 9999)).toBe(true);
    expect(r.rejected.find(x => x.pt === 9999)?.reason).toBe('unaffordable');
  });

  it('同一输入结果确定(可复现)', () => {
    const cands = candidates(10, 90);
    const a = optimize({ course, runner, candidates: cands, budget: 400, maxSims: 20000 });
    const b = optimize({ course, runner, candidates: cands, budget: 400, maxSims: 20000 });
    expect(a.chosen.map(c => c.id)).toEqual(b.chosen.map(c => c.id));
    expect(a.totalBody).toBeCloseTo(b.totalBody, 9);
  });

  it('未知技能 id 报错', () => {
    expect(() => optimize({ course, runner, candidates: [{ id: 'nope', pt: 100 }], budget: 500 })).toThrow(/不存在/);
  });

  it('装配限制不满足的候选标为「不适配」而非「无收益」,且不会被选中', () => {
    const nige = SKILLS.find(s => s.name === '抢先')!; // 仅限逃马
    const r = optimize({ course, runner, candidates: [{ id: nige.id, pt: 90 }], budget: 500 });
    expect(r.chosen).toHaveLength(0);
    const rej = r.rejected.find(x => x.id === nige.id)!;
    expect(rej.reason).toBe('inapplicable');
    expect(rej.detail).toContain('逃马');
    expect(rej.soloBody).toBe(0);
  });

  it('效果未建模的候选标为「不适配」,并给出原因', () => {
    const unsupported = SKILLS.find(
      s => s.precision === 'unsupported' && !(s.effects.length > 0 && s.effects.every(e => e.type === 'passive')),
    )!;
    const r = optimize({ course, runner, candidates: [{ id: unsupported.id, pt: 100 }], budget: 500 });
    expect(r.rejected[0]!.reason).toBe('inapplicable');
    expect(r.rejected[0]!.detail).toContain('未建模');
  });

  it('绿技能(常时被动)进入候选池并产生正收益', () => {
    const green = SKILLS.find(
      s => s.precision === 'precise' && s.restriction === undefined && s.effects.length > 0 && s.effects.every(e => e.type === 'passive'),
    )!;
    const r = optimize({ course, runner, candidates: [{ id: green.id, pt: 100 }], budget: 500 });
    expect(r.chosen).toHaveLength(1);
    expect(r.totalBody).toBeGreaterThan(0);
  });

  it('受季节限制的绿技能:默认春标为不适配,改成秋季后生效有收益', () => {
    const autumn = SKILLS.find(s => s.name === '风霜高洁')!; // 仅限秋季
    const spring = optimize({ course, runner, candidates: [{ id: autumn.id, pt: 100 }], budget: 500 });
    const rej = spring.rejected.find(x => x.id === autumn.id)!;
    expect(rej.reason).toBe('inapplicable');
    expect(rej.detail).toContain('秋');

    const fall = optimize({
      course, runner: { ...runner, season: 3 }, candidates: [{ id: autumn.id, pt: 100 }], budget: 500,
    });
    expect(fall.chosen).toHaveLength(1);
    expect(fall.totalBody).toBeGreaterThan(0);
  });

  it('能发动但无收益的技能仍是「无收益」,与不适配区分开', () => {
    const heal = SKILLS.find(s => s.id === '200352')!; // 弯道恢复○:纯回复
    const r = optimize({ course, runner, candidates: [{ id: heal.id, pt: 90 }], budget: 500 });
    const rej = r.rejected.find(x => x.id === heal.id)!;
    expect(rej.reason).toBe('no-gain');
    // 若本赛道体力跑不空,会附上"体力未耗尽"的说明
    expect(rej.detail === '' || rej.detail.includes('体力')).toBe(true);
  });

  it('金技能申报下位后,「金+前置」只按金标价计费(不重复收前置的钱)', () => {
    // 游戏里金技能列表价 = 前置价 + 金技能自己的折后价;
    // 所以 先走一步！304 已经包含 游戏到此为止！160,两者一起买仍是 304,而不是 464。
    const pre = SKILLS.find(s => s.name === '游戏到此为止！')!;
    const gold = SKILLS.find(s => s.name === '先走一步！')!;
    const both = optimize({
      course, runner, budget: 2000,
      candidates: [
        { id: pre.id, pt: 160 },
        { id: gold.id, pt: 304, requires: pre.id },
      ],
    });
    expect(both.totalPt).toBeLessThanOrEqual(304);
    const goldRow = both.chosen.find(c => c.id === gold.id);
    expect(goldRow).toBeDefined();
    expect(goldRow!.includesPrereq).toContain(pre.name);   // 效果里确实带了前置
    // 前置被合并进来后,再单独买它没有额外收益
    const preRej = both.rejected.find(x => x.id === pre.id);
    if (preRej) expect(preRej.reason === 'no-gain' || preRej.reason === 'outbid').toBe(true);
  });

  it('前置不在候选里时,不申报关系、也不改价(已买过前置的情形)', () => {
    const gold = SKILLS.find(s => s.name === '先走一步！')!;
    const alone = optimize({ course, runner, candidates: [{ id: gold.id, pt: 144 }], budget: 2000 });
    expect(alone.totalPt).toBe(144);
  });
});

/**
 * 区段随机取位技能(randomPosition)的收益必须是**期望值**,不能是引擎默认取位那一个点。
 *
 * 引擎默认取位 = 「一进入区段就发动」。对「迅速果断」(差行·中盘随机位置·+0.35 速度 2.4s)
 * 在中山 2500m 上,默认取位落在 417m(中盘刚起点)只得 0.62 马身;而这段收益随位置变化很大:
 * 中盘主体稳定 ~1.04,靠近终盘时因「存速带进末脚加速段」能到 2.3。按满足区段均匀采样求均值
 * = 1.11 马身(与赛道模拟器 uma-race-sim 的 ablate.expectedBody 一致)。
 * 用单点值会把这些技能整体压低约 45%,金技能会被下位白技能挤掉。
 */
describe('区段随机取位技能按期望计价', () => {
  const nakayama = COURSES.find(c => c.id === 'c10506')!; // 中山 草 2500m
  const sashi = {
    stats: { speed: 1600, stamina: 1200, power: 1200, guts: 1200, wisdom: 1200 },
    greenBonus: {},
    tactic: 'sashi' as const,
    distanceAptitude: 'S' as const,
    surfaceAptitude: 'A' as const,
    motivation: 'best' as const,
    groundCondition: 0 as const,
    weather: 1 as const,
    season: 4 as const,
    courseFix: 'auto' as const,
    skills: [],
  };

  it('迅速果断:中山 2500m 差行约 1.1 马身(默认取位单点只有 0.62)', () => {
    const quick = SKILLS.find(s => s.id === '200591')!;
    expect(quick.randomPosition).toBe(true);
    const r = optimize({ course: nakayama, runner: sashi, candidates: [{ id: quick.id, pt: 180 }], budget: 900 });
    const solo = r.chosen[0]!.soloBody;
    expect(solo).toBeGreaterThan(0.9); // > 默认取位单点(0.62):确实换成了期望口径
    expect(solo).toBeLessThan(1.5);    // 也不该被尾部的 2.3 带偏
  });

  it('同一技能:差行生效、先行不适配(取位口径修好后仍受脚质限制)', () => {
    const quick = SKILLS.find(s => s.id === '200591')!;
    const senko = optimize({
      course: nakayama, runner: { ...sashi, tactic: 'senko' }, candidates: [{ id: quick.id, pt: 180 }], budget: 900,
    });
    expect(senko.rejected.find(x => x.id === quick.id)!.reason).toBe('inapplicable');
  });
});
