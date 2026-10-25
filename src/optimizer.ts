import { BODY_LENGTH_METERS, simulate } from './engine/index.js';
import type { Course, RunnerConfig, SimResult, SkillConfig } from './engine/index.js';
import { SKILLS, type SkillEntry } from './data.js';

const SKILL_INDEX = new Map(SKILLS.map(s => [s.id, s] as const));

/** 一名候选技能:技能库 id + 实际 PT 价格(游戏内显示价,含折扣) */
export interface CandidateSkill {
  readonly id: string;
  readonly pt: number;
}

export interface OptimizerInput {
  readonly course: Course;
  /** 马娘面板(skills 字段被忽略,由优化器按候选组合填充) */
  readonly runner: RunnerConfig;
  readonly candidates: readonly CandidateSkill[];
  /** PT 预算(硬约束) */
  readonly budget: number;
  /** 模拟次数上限(默认 30000;单次模拟 ~1.3ms,30000 次 ≈ 40s) */
  readonly maxSims?: number;
  /** 视为有效收益的最小时间差(秒),默认 0.0005s ≈ 0.003 马身 */
  readonly minImprovementSec?: number;
  readonly onProgress?: (line: string) => void;
}

export interface ChosenSkill {
  readonly id: string;
  readonly name: string;
  readonly pt: number;
  /** 单独购买时的马身收益 */
  readonly soloBody: number;
  /** 在最终组合内的边际马身(leave-one-out 口径) */
  readonly finalMarginalBody: number;
  /** 在最终组合内的边际时间收益(秒) */
  readonly finalMarginalSec: number;
}

export interface RejectedSkill {
  readonly id: string;
  readonly name: string;
  readonly pt: number;
  readonly soloBody: number;
  /** unaffordable=超预算 no-gain=组合内无正收益 outbid=收益为正但被更优组合挤出 */
  readonly reason: 'unaffordable' | 'no-gain' | 'outbid';
  /** 还差多少 PT 能上车(仅 outbid 时,预算用尽后有意义的字段) */
  readonly missingPt: number;
  readonly lastMarginalBody: number;
}

export interface OptimizerResult {
  /** 推荐购买清单(按购入顺序) */
  readonly chosen: readonly ChosenSkill[];
  readonly totalBody: number;
  readonly totalPt: number;
  readonly remainingPt: number;
  readonly baselineSec: number;
  readonly finalSec: number;
  /** 各单项马身收益之和(与 totalBody 的差 = 技能间交互,UI/输出需同时展示) */
  readonly sumSoloBody: number;
  readonly rejected: readonly RejectedSkill[];
  readonly simsUsed: number;
  readonly notes: readonly string[];
}

interface Cand {
  readonly id: string;
  readonly skill: SkillEntry;
  readonly pt: number;
  /** 单独购买时的时间收益(秒) */
  soloSec: number;
  /** 最近一次已知的时间边际(秒) */
  lastMarginal: number;
  state: 'pool' | 'chosen' | 'no-gain';
}

const DEFAULT_MAX_SIMS = 30000;
const DEFAULT_MIN_IMPROVEMENT_SEC = 0.0005;

function timeGain(before: SimResult, after: SimResult): number {
  return before.finishTimeSec - after.finishTimeSec;
}

/** 推荐购买组合:贪心(按 马身/PT 效率,装入后重算所有边际)+ 交换局部搜索 + 预算回填 */
export function optimize(input: OptimizerInput): OptimizerResult {
  const { course, runner, budget } = input;
  const maxSims = input.maxSims ?? DEFAULT_MAX_SIMS;
  const eps = input.minImprovementSec ?? DEFAULT_MIN_IMPROVEMENT_SEC;
  const notes: string[] = [];

  let simsUsed = 0;
  const sim = (skills: readonly SkillConfig[]): SimResult => {
    if (simsUsed >= maxSims) throw new Error(`模拟次数超过上限 ${maxSims}`);
    simsUsed++;
    return simulate(course, { ...runner, skills });
  };

  // ── 候选解析:去重、查库、绿技能提示 ────────────────────────────────
  const seen = new Set<string>();
  for (const c of input.candidates) {
    if (seen.has(c.id)) throw new Error(`候选技能重复: ${c.id}`);
    seen.add(c.id);
  }
  const unknown = input.candidates.filter(c => !SKILL_INDEX.has(c.id));
  if (unknown.length > 0) {
    throw new Error(`技能库中不存在这些 id: ${unknown.map(c => c.id).join(', ')}`);
  }
  const cands: Cand[] = input.candidates.map(c => {
    const skill = SKILL_INDEX.get(c.id)!;
    return { id: c.id, skill, pt: c.pt, soloSec: 0, lastMarginal: 0, state: 'pool' };
  });

  const passiveOnly = cands.filter(c => c.skill.effects.length > 0 && c.skill.effects.every(e => e.type === 'passive'));
  if (passiveOnly.length > 0) {
    notes.push(`绿技能(仅被动加成)当前引擎版本不参与比赛过程模拟,以下技能建模收益为 0、不会被推荐购买:${passiveOnly.map(c => c.skill.name).join('、')}`);
  }
  const unsupported = cands.filter(c => c.skill.precision === 'unsupported');
  if (unsupported.length > 0) {
    notes.push(`以下技能的效果类型暂不支持建模(收益按 0 处理):${unsupported.map(c => c.skill.name).join('、')}`);
  }

  // ── 基准与单项收益 ──────────────────────────────────────────────
  const baseSim = sim([]);
  const soloT = new Map<string, number>();
  for (const c of cands) {
    const t = sim([c.skill]).finishTimeSec;
    soloT.set(c.id, t);
    c.soloSec = baseSim.finishTimeSec - t;
    c.lastMarginal = c.soloSec;
  }
  for (const c of cands) {
    if (c.pt > budget) c.state = 'no-gain';
  }

  const skillsOf = (cs: readonly Cand[]) => cs.map(c => c.skill);
  const chosen: Cand[] = [];
  let spent = 0;
  const remaining = () => budget - spent;
  const pool = () => cands.filter(c => c.state === 'pool');

  /** 贪心装入:每轮重算全部在池候选的边际,选 边际/PT 效率 最高者 */
  const greedyFill = () => {
    for (;;) {
      const feasible = pool().filter(c => c.pt <= remaining());
      if (feasible.length === 0) return;
      const cur = sim(skillsOf(chosen));
      let best: { cand: Cand; gain: number; ratio: number } | null = null;
      for (const c of feasible) {
        const gain = timeGain(cur, sim([...skillsOf(chosen), c.skill]));
        c.lastMarginal = gain;
        if (gain <= eps) continue;
        const ratio = gain / c.pt;
        if (best === null || ratio > best.ratio) best = { cand: c, gain, ratio };
      }
      if (best === null) {
        for (const c of feasible) if (c.lastMarginal <= eps) c.state = 'no-gain';
        return;
      }
      best.cand.state = 'chosen';
      chosen.push(best.cand);
      spent += best.cand.pt;
    }
  };

  greedyFill();

  // ── 交换局部搜索:换出已选、换入未选,收益提升则交换并回填预算 ────────
  const SWAP_ROUNDS = 10;
  const SWAP_POOL = 50;
  for (let round = 0; round < SWAP_ROUNDS; round++) {
    if (chosen.length === 0 || pool().length === 0) break;
    // 换入候选只看最近边际靠前的一批(池太大时剪枝)
    const insertCands = pool()
      .slice()
      .sort((a, b) => b.lastMarginal - a.lastMarginal)
      .slice(0, SWAP_POOL);
    const cur = sim(skillsOf(chosen));
    let best: { out: Cand; in: Cand; gain: number } | null = null;
    for (const b of insertCands) {
      for (const a of chosen) {
        if (b.pt > remaining() + a.pt) continue;
        const next = chosen.filter(x => x !== a);
        const gain = timeGain(cur, sim([...skillsOf(next), b.skill]));
        if (gain > eps && (best === null || gain > best.gain)) best = { out: a, in: b, gain };
      }
    }
    if (best === null) break;
    chosen.splice(chosen.indexOf(best.out), 1, best.in);
    best.out.state = 'pool';
    best.in.state = 'chosen';
    best.out.lastMarginal = 0;
    spent += best.in.pt - best.out.pt;
    greedyFill();
  }

  // ── 汇报:最终组合的 leave-one-out 边际 + 未上车技能分类 ────────────
  const finalSim = sim(skillsOf(chosen));
  const bodyPerSec = finalSim.spurtTargetSpeed / BODY_LENGTH_METERS;
  const finalMarginals = new Map<string, number>();
  for (const a of chosen) {
    const t = sim(skillsOf(chosen.filter(x => x !== a))).finishTimeSec;
    finalMarginals.set(a.id, t - finalSim.finishTimeSec);
  }

  const rejected: RejectedSkill[] = [];
  for (const c of cands) {
    if (c.state === 'chosen') continue;
    const reason: RejectedSkill['reason'] =
      c.pt > budget ? 'unaffordable' : c.lastMarginal <= eps ? 'no-gain' : 'outbid';
    rejected.push({
      id: c.id,
      name: c.skill.name,
      pt: c.pt,
      soloBody: c.soloSec * bodyPerSec,
      reason,
      missingPt: Math.max(0, c.pt - remaining()),
      lastMarginalBody: c.lastMarginal * bodyPerSec,
    });
  }
  rejected.sort((a, b) => b.lastMarginalBody - a.lastMarginalBody);

  const budgetLimited = rejected.some(r => r.reason === 'outbid' && r.missingPt > 0);
  if (budgetLimited) {
    notes.push(`预算用尽:上表中「差PT」列 = 再充多少 PT 可让该技能上车(按当前组合的边际收益排序)。`);
  }
  if (simsUsed >= maxSims * 0.98) {
    notes.push(`已接近模拟次数上限(${simsUsed}/${maxSims}),搜索提前收敛;可用 --max-sims 提高上限获得更优解。`);
  }

  return {
    chosen: chosen.map(c => ({
      id: c.id,
      name: c.skill.name,
      pt: c.pt,
      soloBody: c.soloSec * bodyPerSec,
      finalMarginalBody: (finalMarginals.get(c.id) ?? 0) * bodyPerSec,
      finalMarginalSec: finalMarginals.get(c.id) ?? 0,
    })),
    totalBody: (baseSim.finishTimeSec - finalSim.finishTimeSec) * bodyPerSec,
    totalPt: spent,
    remainingPt: remaining(),
    baselineSec: baseSim.finishTimeSec,
    finalSec: finalSim.finishTimeSec,
    sumSoloBody: cands.reduce((acc, c) => acc + c.soloSec * bodyPerSec, 0),
    rejected,
    simsUsed,
    notes,
  };
}
