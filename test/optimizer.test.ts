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
});
