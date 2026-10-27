import { describe, expect, it } from 'vitest';
import { COURSES, SKILLS } from '../src/data.js';
import { optimize } from '../src/optimizer.js';
import { BODY_LENGTH_METERS, simulate } from '../src/engine/index.js';
import type { RunnerConfig, SkillConfig } from '../src/engine/index.js';

/**
 * 回归:○ → ◎ → 金 是**同一格"加钱一步步升上来"**的三级(用户 2026-10-28 点明的)。
 *
 * 链:良场地○(200152) → 良场地◎(200151) → 良场地恶煞(200154)
 *
 * 这里锁四件事,每一条都对应一个真实错过的算法:
 * 1. 覆盖要展开到**整条链**:只覆盖"第一个在池里的祖先"时,池里同时有 ○ 和 ◎
 *    就只删 ◎、漏掉 ○ → 金 + ○ 又叠加(56.5092s vs 只装金 56.5253s,虚高 0.16 马身)。
 * 2. 现场读价生成的双圈不在 CIRCLE_BASE 静态表里,也必须顶掉单圈 ——
 *    否则 ○+◎ 同装算出 0.413(实际 ◎ 只有 0.254)。
 * 3. 只选 ◎(单圈没进购物车)时,合计要把单圈那一份算进来:
 *    游戏里要点两下才升级,漏算是"显示 30、实际付 111"。
 * 4. 买不起上位时,下位仍要能单独买(不能被覆盖关系永久压制)。
 */

const course = COURSES[0]!;
const runner: RunnerConfig = {
  stats: { speed: 1200, stamina: 1000, power: 1100, guts: 700, wisdom: 900 },
  greenBonus: {},
  tactic: 'senko',
  distanceAptitude: 'A',
  surfaceAptitude: 'A',
  motivation: 'normal',
  courseFix: 'auto',
  skills: [],
};

const W = SKILLS.find(s => s.id === '200152')! as SkillConfig;   // 良场地○
const U = SKILLS.find(s => s.id === '200151')! as SkillConfig;   // 良场地◎
const G = SKILLS.find(s => s.id === '200154')! as SkillConfig;   // 良场地恶煞

const baseSec = simulate(course, runner).finishTimeSec;
const bps = simulate(course, runner).spurtTargetSpeed / BODY_LENGTH_METERS;
const secOf = (sk: SkillConfig[]) => simulate(course, { ...runner, skills: sk }).finishTimeSec;
const bodyOf = (sk: SkillConfig[]) => (baseSec - secOf(sk)) * bps;

const goldOnly = secOf([G]);
const stackedGoldWhite = secOf([G, W]);
const upgradeOnly = secOf([U]);
const stackedCircle = secOf([U, W]);

/** 这一对技能确实会叠加(否则下面的断言没有意义) */
const stackingIsReal = Math.abs(stackedGoldWhite - goldOnly) > 1e-6
  && Math.abs(stackedCircle - upgradeOnly) > 1e-6;

const cands = [{ id: '200152', pt: 81 }, { id: '200154', pt: 284 }];   // ○ 81 / 金 284
const CIRCLE_UP = { '200152': 30 };                                   // 现场读到 ◎ 还要 30

describe('○ → ◎ → 金 三级链', () => {
  it('前置技能确实会叠加(否则这组回归没意义)', () => {
    expect(stackingIsReal).toBe(true);
    expect(bodyOf([G, W])).toBeGreaterThan(bodyOf([G]));
    expect(bodyOf([U, W])).toBeGreaterThan(bodyOf([U]));
  });

  it('supersedes 只给"最近一级"(金→◎)时,也要覆盖到单圈', () => {
    const r = optimize({
      course, runner, candidates: cands, budget: 500,
      circleUpOverride: CIRCLE_UP,
      supersedes: [{ gold: '200154', lower: '200151' }],   // 只给 ◎ 这一级
    });
    const ids = r.chosen.map(c => c.id);
    expect(ids).toContain('200154');
    expect(ids).not.toContain('200152');       // 单圈不能又被买一遍
    expect(ids).not.toContain('200151');       // 双圈也不必买
    expect(r.finalSec).toBeCloseTo(goldOnly, 6);
    expect(r.totalPt).toBe(284);               // 金是 284 全包,不能再加 81
  });

  it('supersedes 什么都没给(旧数据)时,靠技能链也能展开到整条链', () => {
    const r = optimize({
      course, runner, candidates: cands, budget: 500, circleUpOverride: CIRCLE_UP,
    });
    expect(r.chosen.map(c => c.id)).toEqual(['200154']);
    expect(r.finalSec).toBeCloseTo(goldOnly, 6);
    expect(r.totalPt).toBe(284);
  });

  it('现场读价生成的双圈要顶掉单圈,不能两边都算', () => {
    const r = optimize({
      course, runner, candidates: cands, budget: 111, circleUpOverride: CIRCLE_UP,
    });
    const ids = r.chosen.map(c => c.id);
    expect(ids).toContain('200151');           // 买不起金 → 升双圈
    expect(r.finalSec).toBeCloseTo(upgradeOnly, 6);
    expect(r.finalSec).not.toBeCloseTo(stackedCircle, 6);
  });

  it('只选双圈时,合计要含单圈那一份(游戏里要点两下)', () => {
    const r = optimize({
      course, runner, candidates: cands, budget: 111, circleUpOverride: CIRCLE_UP,
    });
    // ○ 81 + 升级 30 = 111,不是 30
    expect(r.totalPt).toBe(111);
    expect(r.remainingPt).toBe(0);
  });

  it('预算梯度:买不起上位就买下位,不会因为"它有个上位"被永久压制', () => {
    const at = (b: number) => optimize({
      course, runner, candidates: cands, budget: b, circleUpOverride: CIRCLE_UP,
    });
    expect(at(60).chosen).toHaveLength(0);                        // 什么都不够
    expect(at(81).chosen.map(c => c.id)).toEqual(['200152']);     // 只够单圈
    expect(at(110).chosen.map(c => c.id)).toEqual(['200152']);    // 差 1 点升不了双圈
    expect(at(111).chosen.map(c => c.id)).toEqual(['200151']);    // 够双圈
    expect(at(283).chosen.map(c => c.id)).toEqual(['200151']);    // 差 1 点买不起金
    expect(at(284).chosen.map(c => c.id)).toEqual(['200154']);    // 够金 → 直接买金
  });

  it('金和双圈不会被一起买(金已含整条链)', () => {
    const r = optimize({
      course, runner, candidates: cands, budget: 500, circleUpOverride: CIRCLE_UP,
      supersedes: [{ gold: '200154', lower: '200151' }],
    });
    expect(r.chosen.map(c => c.id)).toEqual(['200154']);
  });
});
