import { describe, expect, it } from 'vitest';
import { COURSES, SKILLS } from '../src/data.js';
import { optimize } from '../src/optimizer.js';
import { simulate } from '../src/engine/index.js';
import { BODY_LENGTH_METERS } from '../src/engine/index.js';
import type { RunnerConfig, SkillConfig } from '../src/engine/index.js';

/**
 * 回归:金技能与下位白是「升级替换」,不是叠加。
 *
 * 游戏内实测口径(用户 2026-10-27):
 *   花 160 买「游戏到此为止！」(0.15×3) 后,再花 160 买「先走一步！」,
 *   0.15×3 被替换成 0.35×3 —— 总共 320 买到的是「一个 0.35×3 的技能」,
 *   下位白那 0.15×3 不再单独生效。与 ○/◎ 同构。
 *
 * 曾经的实现会把白和金一起装进模拟(0.15+0.35=0.50),
 * 导致金技能收益被高估 27~29%(先走一步 3.674→2.680 马身)。
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

const GOLD = SKILLS.find(s => s.id === '201662')! as SkillConfig;   // 先走一步！
const WHITE = SKILLS.find(s => s.id === '201661')! as SkillConfig;  // 游戏到此为止！

const baseSec = simulate(course, runner).finishTimeSec;
const bps = simulate(course, runner).spurtTargetSpeed / BODY_LENGTH_METERS;

/** 只装金 / 白+金一起装 的收益(马身) */
const bodyOnlyGold = (baseSec - simulate(course, { ...runner, skills: [GOLD] }).finishTimeSec) * bps;
const bodyStacked = (baseSec - simulate(course, { ...runner, skills: [WHITE, GOLD] }).finishTimeSec) * bps;
const bodyOnlyWhite = (baseSec - simulate(course, { ...runner, skills: [WHITE] }).finishTimeSec) * bps;

describe('金技能替换下位白(不叠加)', () => {
  it('前提:两种口径在这个技能对上确实不同,否则本测试无意义', () => {
    // 赛道越短差值越小;1200m 上约 0.15 马身,2400m 上约 1.0 马身
    expect(bodyStacked - bodyOnlyGold).toBeGreaterThan(0.1);
  });

  it('单独买金的收益 = 只装金的模拟结果,不是白+金叠加', () => {
    const r = optimize({
      course, runner,
      candidates: [{ id: '201662', pt: 304, requires: '201661' }, { id: '201661', pt: 160 }],
      budget: 1000,
    });
    const gold = r.chosen.find(c => c.id === '201662');
    expect(gold).toBeDefined();
    expect(gold!.soloBody).toBeCloseTo(bodyOnlyGold, 6);
    expect(gold!.soloBody).not.toBeCloseTo(bodyStacked, 3);
  });

  it('买了金之后,下位白不再被单独装进组合(它被顶掉了,边际为 0)', () => {
    const r = optimize({
      course, runner,
      candidates: [{ id: '201662', pt: 304, requires: '201661' }, { id: '201661', pt: 160 }],
      budget: 1000,
    });
    const ids = new Set(r.chosen.map(c => c.id));
    expect(ids.has('201662')).toBe(true);
    // 买了金还单独买白 = 纯浪费,替换语义下它的边际是 0,贪心不该再选它
    expect(ids.has('201661')).toBe(false);
    // 且组合总收益就是"只装金"的收益,不该出现叠加那份
    expect((baseSec - r.finalSec) * bps).toBeCloseTo(bodyOnlyGold, 6);
  });

  it('单独买下位白,收益不受影响', () => {
    const r = optimize({
      course, runner,
      candidates: [{ id: '201661', pt: 160 }],
      budget: 1000,
    });
    const white = r.chosen.find(c => c.id === '201661');
    expect(white).toBeDefined();
    expect(white!.soloBody).toBeCloseTo(bodyOnlyWhite, 6);
  });

  it('价格仍是「白价 + 金价」的总和,与装入顺序无关', () => {
    const cands = [{ id: '201662', pt: 304, requires: '201661' }, { id: '201661', pt: 160 }];
    const r = optimize({ course, runner, candidates: cands, budget: 1000 });
    const ids = new Set(r.chosen.map(c => c.id));
    if (ids.has('201662')) expect(r.totalPt).toBe(304);
    else if (ids.has('201661')) expect(r.totalPt).toBe(160);
  });
});

/**
 * 下位白被顶掉后边际为 0,清单上必须给出解释。
 * 用户 2026-10-27 照着推荐列表问:「为什么浑然忘我的下位白也在购买列表里」
 * —— 钱没算错(162 + 144 = 306 = 金技能标价),缺的是那句说明。
 */
describe('下位白的 note 说明', () => {
  // 白价压低(60)才会出现「贪心先买白、再补买金」这条路:白价正常时金的比例更高,会直接买金
  const cands = [{ id: '201662', pt: 300, requires: '201661' }, { id: '201661', pt: 60 }];

  it('白先上车、金后补时:白带解释 note,金显示扣掉白之后的差额', () => {
    const r = optimize({ course, runner, candidates: cands, budget: 300 });
    const white = r.chosen.find(c => c.id === '201661');
    const gold = r.chosen.find(c => c.id === '201662');
    expect(white).toBeDefined();
    expect(gold).toBeDefined();
    // 白被金顶掉 → 边际为 0,这是 note 的触发条件
    expect(white!.finalMarginalBody).toBeCloseTo(0, 6);
    expect(white!.note).toBeDefined();
    expect(white!.note).toContain(GOLD.name);
    expect(white!.note).toContain('前置');
    // 金的显示价 = 标价 − 白价,总和不变
    expect(gold!.listPt).toBe(300);
    expect(gold!.pt).toBe(240);
    expect(r.totalPt).toBe(300);
  });

  it('没点金、白自己单独上车时,不能挂这条 note', () => {
    const r = optimize({ course, runner, candidates: [{ id: '201661', pt: 60 }], budget: 60 });
    const white = r.chosen.find(c => c.id === '201661');
    expect(white).toBeDefined();
    expect(white!.finalMarginalBody).toBeGreaterThan(0);
    expect(white!.note).toBeUndefined();
  });
});
