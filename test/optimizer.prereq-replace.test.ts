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
// 三级链那组:良场地○ → 良场地◎(中间级) → 良场地恶煞
const GOLD_2 = SKILLS.find(s => s.id === '200154')! as SkillConfig;   // 良场地恶煞
const WHITE_2 = SKILLS.find(s => s.id === '200152')! as SkillConfig;  // 良场地○

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
 * 买金就送下位 —— 所以下位**不该出现在推荐列表里**。
 *
 * 用户 2026-10-27 实测:「良场地恶煞 284」勾上之后,「良场地○」那一行立刻变成
 * 「已获得」、加号点不动。旧版把两者都列进推荐(合计 284+81),桌面显示「剩 1pt」,
 * 游戏实际剩 81pt。清单上也因此出现过「浑然忘我的下位白为什么也要买」的疑问。
 */
describe('买金就送下位:下位不进推荐', () => {
  // 白价压低(60)才会出现「贪心先买白、再补买金」这条路:白价正常时金的比例更高,会直接买金
  const cands = [{ id: '201662', pt: 300, requires: '201661' }, { id: '201661', pt: 60 }];

  it('金在组合里时,下位被剔除;合计只算金的全价', () => {
    const r = optimize({ course, runner, candidates: cands, budget: 300 });
    const ids = new Set(r.chosen.map(c => c.id));
    expect(ids.has('201662')).toBe(true);
    // 买金就送白 → 白不该出现(否则用户会去点一个点不动的行)
    expect(ids.has('201661')).toBe(false);
    const gold = r.chosen.find(c => c.id === '201662')!;
    expect(gold.listPt).toBe(300);
    expect(gold.pt).toBe(300);        // 白的价已经含在金里,不再单独抵扣
    expect(r.totalPt).toBe(300);
    expect(r.notes.join('\n')).toContain('不用单独买');
  });

  it('没点金、白自己单独上车时,白照常留在推荐里', () => {
    const r = optimize({ course, runner, candidates: [{ id: '201661', pt: 60 }], budget: 60 });
    const white = r.chosen.find(c => c.id === '201661');
    expect(white).toBeDefined();
    expect(white!.pt).toBe(60);
    expect(white!.finalMarginalBody).toBeGreaterThan(0);
    expect(white!.note).toBeUndefined();
  });

  it('三级链:中间那级不在候选里,靠 supersedes 也能认出覆盖关系', () => {
    // 200154 良场地恶煞(金) → 200151 良场地◎(中间级,不在候选) → 200152 良场地○
    const r = optimize({
      course, runner,
      candidates: [{ id: '200154', pt: 284 }, { id: '200152', pt: 81 }],
      budget: 400,
      supersedes: [{ gold: '200154', lower: '200152' }],
    });
    const ids = new Set(r.chosen.map(c => c.id));
    expect(ids.has('200154')).toBe(true);
    expect(ids.has('200152')).toBe(false);
    expect(r.totalPt).toBe(284);
    expect(r.remainingPt).toBe(400 - 284);   // 提示语里的"还剩"必须同口径
    expect(r.notes.join('\n')).toContain('不用单独买');
  });

  /**
   * 模拟层也必须认这条覆盖关系 —— 否则白装了、金也装了,引擎会把两份效果各算一遍。
   * 实测(2026-10-27 用户问"会不会又算成金+白"):良场地○ + 良场地恶煞 同装比只装金
   * 快 0.161 马身,收益直接虚高。
   */
  it('supersedes 覆盖的下位白绝不能进模拟(否则效果叠加、收益虚高)', () => {
    const goldOnly = simulate(course, { ...runner, skills: [GOLD_2] }).finishTimeSec;
    const both = simulate(course, { ...runner, skills: [WHITE_2, GOLD_2] }).finishTimeSec;
    // 前提:这个技能对确实会叠加,否则本测试测不出东西
    expect(both).toBeLessThan(goldOnly);

    const r = optimize({
      course, runner,
      candidates: [{ id: '200154', pt: 284 }, { id: '200152', pt: 81 }],
      budget: 400,
      supersedes: [{ gold: '200154', lower: '200152' }],
    });
    // 最终成绩必须是"只装金",不能是"白+金"
    expect(r.finalSec).toBeCloseTo(goldOnly, 6);
    expect(r.finalSec).not.toBeCloseTo(both, 6);
  });

  /**
   * 「买金送白」只该在**两个都买**时生效,不能把白永久压制掉。
   * 用户 2026-10-28 追问:"会不会只考虑学金,不考虑只学白?" —— 这条锁住它。
   */
  it('预算买不起金时,白仍必须能单独买(白是独立技能,有自己的收益)', () => {
    const cands = [{ id: '200154', pt: 284 }, { id: '200152', pt: 81 }];
    const sup = [{ gold: '200154', lower: '200152' }];

    for (const budget of [81, 150, 283]) {          // 都买不起金(284)
      const r = optimize({ course, runner, candidates: cands, budget, supersedes: sup });
      expect(r.chosen.map(c => c.id)).toEqual(['200152']);
      expect(r.totalPt).toBe(81);
      expect(r.totalBody).toBeGreaterThan(0);
    }

    // 够买金时切到金(收益更高),且不会把白也算上
    const rich = optimize({ course, runner, candidates: cands, budget: 284, supersedes: sup });
    expect(rich.chosen.map(c => c.id)).toEqual(['200154']);
    expect(rich.totalPt).toBe(284);

    // 候选池里只有白(金根本不在池里,比如已经拥有) → 白照常可买
    const whiteOnly = optimize({ course, runner, candidates: [{ id: '200152', pt: 81 }], budget: 81, supersedes: sup });
    expect(whiteOnly.chosen.map(c => c.id)).toEqual(['200152']);
    expect(whiteOnly.totalPt).toBe(81);
  });
});
