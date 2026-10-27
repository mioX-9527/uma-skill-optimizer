import { describe, expect, it } from 'vitest';
import { COURSES, SKILLS } from '../src/data.js';
import { optimize } from '../src/optimizer.js';
import type { RunnerConfig } from '../src/engine/index.js';

/**
 * 回归测试:锁住 optimize 的对外行为。
 *
 * 背景:为了做算法审计给 OptimizerInput 加了可选的 stages 开关。
 * 它必须是**纯增量**的 —— 不传 stages 时行为要与改动前逐字一致。
 * 这里把这条约束钉死,以后改搜索流程也先看这些用例。
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

/** 挑几个本赛道确定可用的候选,让测试跑得快又不退化成空集 */
function pickCandidates(n: number): { id: string; pt: number }[] {
  const out: { id: string; pt: number }[] = [];
  for (const s of SKILLS) {
    if (out.length >= n) break;
    if (s.condition.kind !== 'phase' && s.condition.kind !== 'straightFastest') continue;
    if (s.restriction !== undefined) continue;
    if (s.precision === 'unsupported') continue;
    out.push({ id: s.id, pt: 120 });
  }
  return out;
}

const candidates = pickCandidates(8);

describe('optimize 对外行为回归', () => {
  it('同一输入重跑结果完全一致(确定性)', () => {
    const a = optimize({ course, runner, candidates, budget: 900 });
    const b = optimize({ course, runner, candidates, budget: 900 });
    expect(a.chosen.map(c => c.id)).toEqual(b.chosen.map(c => c.id));
    expect(a.finalSec).toBe(b.finalSec);
    expect(a.totalBody).toBe(b.totalBody);
    expect(a.simsUsed).toBe(b.simsUsed);
  });

  it('不传 stages 时,模拟次数不变默认值 30000 的上限语义不受影响', () => {
    const r = optimize({ course, runner, candidates, budget: 900 });
    expect(r.simsUsed).toBeLessThan(30000);
    expect(r.simsUsed).toBeGreaterThan(0);
  });

  it('stages 全关 = 纯贪心,模拟次数不多于全开', () => {
    const off = optimize({
      course, runner, candidates, budget: 900,
      stages: { swap: false, twoOutSwap: false, spendDown: false, polish: false },
    });
    const on = optimize({ course, runner, candidates, budget: 900 });
    expect(off.simsUsed).toBeLessThanOrEqual(on.simsUsed);
  });

  it('twoOutSwap 关掉时不产生 2换1 说明,开启时预算仍不超支', () => {
    const off = optimize({ course, runner, candidates, budget: 900, stages: { twoOutSwap: false } });
    const on = optimize({ course, runner, candidates, budget: 900, stages: { twoOutSwap: true } });
    expect(off.notes.some(n => n.includes('2换1'))).toBe(false);
    // 开启后这条 note 只在真的做成了移动时才出现,内容要能让人看懂方向
    if (on.notes.some(n => n.includes('2换1'))) {
      expect(on.notes.some(n => n.includes('两个已选技能让位给一个更优的候选'))).toBe(true);
    }
    for (const r of [off, on]) {
      expect(r.totalPt).toBeLessThanOrEqual(900);
      expect(r.finalSec).toBeLessThanOrEqual(r.baselineSec + 1e-9);
    }
  });

  it('PT 预算是硬约束:各种预算下都不能超支', () => {
    for (const budget of [300, 600, 900, 1500]) {
      const r = optimize({ course, runner, candidates, budget });
      expect(r.totalPt).toBeLessThanOrEqual(budget);
      expect(r.remainingPt).toBe(budget - r.totalPt);
    }
  });

  it('finalSec 必须在空手基线基础上变快(或至少不更慢)', () => {
    const r = optimize({ course, runner, candidates, budget: 900 });
    expect(r.finalSec).toBeLessThanOrEqual(r.baselineSec + 1e-9);
  });
});
