import { BODY_LENGTH_METERS, sampleableSpans, simulate, skillApplicable } from '../engine/index.js';
import type { Course, Region, RunnerConfig } from '../engine/index.js';

/** 区段随机类技能的期望位置采样数(在满足区段全长上均匀取点;用于逐位置明细) */
export const POSITION_SAMPLES = 7;
/** 联合蒙特卡洛抽样组数上限(按随机技能数量自适应,控制总模拟次数) */
const MC_DRAWS_MAX = 24;
/** 联合蒙特卡洛抽样组数下限 */
const MC_DRAWS_MIN = 8;

/** 同场多次发动的技能的「逐次」收益拆分(带冷却技能,如 先走一步！:开赛10s + 冷却30s) */
export interface FiringSample {
  /** 第几次发动(1 基) */
  readonly index: number;
  readonly atMeter: number;
  readonly atSec: number;
  /** 只去掉这一次发动的效果后,完赛变慢的幅度(马身);其余各次照常生效 */
  readonly deltaBody: number;
}

export interface PositionSample {
  /** 强制发动位置(米) */
  readonly meter: number;
  /** 该位置发动时的马身收益(相对无该技能;其余技能按规则发动,对照用) */
  readonly deltaBody: number;
}

export interface AblationRow {
  readonly skillId: string;
  readonly name: string;
  /** 是否在基准模拟中发动(approx/unsupported 或条件未满足时可能不发动) */
  readonly activated: boolean;
  readonly activatedAtMeter: number | null;
  readonly activatedAtSec: number | null;
  /** 发动次数(带冷却的技能如 弧线大师 可逐弯道多次发动) */
  readonly activationCount: number;
  /** 去掉该技能后完赛变慢的秒数;>0 表示该技能带来正收益(规则取位口径) */
  readonly deltaSec: number;
  /** 距离收益(米),按 Δ时间 × 末速近似(规则取位口径) */
  readonly deltaMeter: number;
  /** 规则取位口径的马身收益 = 米差 / 2.5(供对照) */
  readonly deltaBody: number;
  /**
   * 区段随机类技能(randomPosition)的逐位置收益明细(固定其余技能规则发动,对照用)。
   * null/缺省 = 未采样(非随机位置、点条件/动态条件不可枚举)。
   */
  readonly positionSamples?: readonly PositionSample[];
  /**
   * 期望马身(联合蒙特卡洛):该技能与其余随机技能的发动位置联合随机时,
   * 去掉它的完赛时间差期望(拉丁超立方确定性抽样,可复现)。
   */
  readonly expectedBody?: number;
  /** 各抽样组下该技能边际收益的 [min, max](环境波动区间) */
  readonly bodyRange?: readonly [number, number];
  /**
   * 当前赛道/环境配置下装配限制是否满足(false = 整场不生效,如 逆时针◎ 在顺时针赛道)。
   * UI 对 false 的行标注「不生效」:收益恒 0,不代表技能本身无用。
   */
  readonly applicable: boolean;
  /**
   * 依赖本技能「先发动」的其他已选技能(其 prereq 指向本技能)。
   * 说明为何「从牌组里删掉它」的损失可能大于本行收益:它一停,这些技能也不发动。
   */
  readonly dependentIds?: readonly string[];
  /**
   * **存速**:进入末脚(最终冲刺)那一帧仍然生效的速度加成(m/s)。
   * 缺省 = 该技能在末脚起点之前就已结束(或没有持续型速度效果)。
   * 这段速度会以「更高的起步速度」带进终盘加速段 —— 加速段不必从原速重新爬,
   * 收益 ≈ 存速值 × 剩余加速时长(2400m 约 0.4 m/s²×10s)。
   */
  readonly carryOverSpeed?: number;
  /** 存速还能保持多久(秒,自末脚起点起算;超过加速段的部分会在上限处被吃掉) */
  readonly carryOverLeftSec?: number;
  /**
   * 同场多次发动(带冷却)的技能 = 逐次收益拆分:每次发动各值多少马身。
   * 总量(deltaBody)是「整条技能都去掉」,逐次量是「只去掉这一次」——
   * 因技能间/前后段耦合,Σ逐次 与 deltaBody 不必严格相等,但同一技能内可看出哪一次在挣钱。
   * 缺省 = 只发动一次(或无发动)。
   */
  readonly firingSamples?: readonly FiringSample[];
}

export interface AblationReport {
  readonly fullTimeSec: number;
  readonly noSkillTimeSec: number;
  /** 全技能总收益(无技能 − 全技能);规则取位口径 */
  readonly totalDeltaSec: number;
  /** 单项收益之和;与 totalDeltaSec 的差 = 技能间交互(回体改变后续发动位置等),UI 需同时展示 */
  readonly sumDeltaSec: number;
  /** 全技能总收益的马身口径(= totalDeltaSec × 末脚目标速度 / 2.5,与逐行同一换算) */
  readonly totalDeltaBody: number;
  readonly rows: readonly AblationRow[];
  /** 联合蒙特卡洛组数;undefined = 未启用(无随机位置技能) */
  readonly mcDraws?: number;
  /** Σ 单项收益的期望口径(各行 expectedBody 之和,联合随机环境) */
  readonly sumExpectedSec?: number;
  /** Σ 单项收益期望的马身口径(与逐行同一换算) */
  readonly sumExpectedBody?: number;
  /** 实测总收益的期望口径(全技能联合随机 vs 无技能);规则取位口径见 totalDeltaSec */
  readonly totalExpectedSec?: number;
  /** totalExpectedSec 的 95% 置信半宽(秒,±) */
  readonly totalExpectedCI?: number;
  /** 实测总收益期望的马身口径(与逐行同一换算) */
  readonly totalExpectedBody?: number;
  /** Σ 规则取位收益的马身口径(与逐行同一换算) */
  readonly sumDeltaBody?: number;
}

/** 在满足区段全长上均匀取 K 个采样点(按区段长度加权;第 i 点取 (i+0.5)/K 分位) */
function samplePositions(spans: readonly Region[], k: number): number[] {
  const total = spans.reduce((a, s) => a + (s[1] - s[0]), 0);
  const out: number[] = [];
  for (let i = 0; i < k; i++) {
    let target = ((i + 0.5) / k) * total;
    for (const s of spans) {
      const len = s[1] - s[0];
      if (target <= len) {
        out.push(s[0] + target);
        break;
      }
      target -= len;
    }
  }
  return out;
}

/** 分位数 → 米(按区段长度加权的累计分布) */
function quantileToMeter(spans: readonly Region[], u: number): number {
  let target = u * spans.reduce((a, s) => a + (s[1] - s[0]), 0);
  for (const s of spans) {
    const len = s[1] - s[0];
    if (target <= len) return s[0] + target;
    target -= len;
  }
  return spans[spans.length - 1]![1];
}

/**
 * leave-one-out 消融:对每个技能跑一次"去掉它"的模拟。
 * 注意不能用增量法(逐个累加):技能间存在位置/体力耦合,消融法才能如实度量单项贡献。
 *
 * **「去掉」的口径是「只去掉效果、保留发动」**(`inertSkills`),不是从牌组里删掉:
 * 技能仍按规则判定条件/前提并记入发动史,因此别的技能的 prereq(如「已发动回复技能≥3」)照常满足。
 * 否则 3 个回复技能会各自背上「大招因此不发动」的 1.77 马身,同一份收益被重复计 3 次、Σ 项远大于总收益。
 * 依赖关系另外用 `dependentIds` 提示(从牌组删掉它才会连带失去那些技能)。
 *
 * 位置随机技能(触发代码含 *_random,randomPosition)的处理分两层:
 * 1. 逐位置明细(positionSamples):满足区段全长均匀取 K 点,逐点强制发动后做**单项消融**
 *    (同位置强制发动 vs 强制发动但去掉本技能效果)= 该落点的边际收益,口径与期望一致
 *    (2026-10-31 勘误:此前对比空场,明细混入了牌组其他技能的合计收益,与期望不可比);
 * 2. 联合蒙特卡洛期望(方案二):所有随机位置技能的发动位置联合拉丁超立方抽样
 *    (确定性、可复现),每组下跑全技能与逐技能 leave-one-out——
 *    Σ 单项与实测总收益的期望口径均来自联合随机环境,含技能间随机耦合。
 * 名次类条件(order_rate 等,发动依赖名次状态)不可枚举,维持规则取位。
 */
export function ablate(course: Course, runner: RunnerConfig): AblationReport {
  const full = simulate(course, runner);
  const none = simulate(course, { ...runner, skills: [] });
  // 马身差换算基准 = 末脚(冲刺)目标速度(614tools 口径)
  const endV = full.spurtTargetSpeed;

  // 随机位置技能及其满足区段(联合 MC 的抽样域);仅统计规则下确实会发动的技能
  // (装配限制不满足时该技能整场不发动,采样无意义)
  const firedIds = new Set(full.activations.map(a => a.skillId));
  const mcSkills = runner.skills
    .map(s => ({ skill: s, spans: s.randomPosition === true ? sampleableSpans(s.condition, course) : null }))
    .filter((e): e is { skill: (typeof runner.skills)[number]; spans: readonly Region[] } => e.spans !== null && firedIds.has(e.skill.id));
  const mcDraws =
    mcSkills.length > 0 ? Math.max(MC_DRAWS_MIN, Math.min(MC_DRAWS_MAX, Math.round(240 / (mcSkills.length + 1)))) : undefined;

  // 联合抽样表:第 d 组、第 i 个随机技能 → 发动位置(拉丁超立方:每组每技能各占一个分层)
  const drawTable: Array<Map<string, number>> = [];
  if (mcDraws !== undefined) {
    for (let d = 0; d < mcDraws; d++) {
      const map = new Map<string, number>();
      mcSkills.forEach((e, i) => {
        const phi = ((i + 1) * 0.6180339887498949) % 1;
        const u = (((d + 0.5) / mcDraws + phi) % 1 + 1) % 1;
        map.set(e.skill.id, quantileToMeter(e.spans, u));
      });
      drawTable.push(map);
    }
  }

  // 联合 MC:每组跑全技能(所有随机技能强制到本组位置)与逐技能 leave-one-out
  const totals: number[] = [];
  const marginals: number[][] = mcSkills.map(() => []);
  if (mcDraws !== undefined) {
    for (let d = 0; d < mcDraws; d++) {
      const ov = drawTable[d]!;
      const fullD = simulate(course, runner, { positionOverrides: ov });
      totals.push(none.finishTimeSec - fullD.finishTimeSec);
      mcSkills.forEach((e, i) => {
        const withoutD = simulate(course, runner, { positionOverrides: ov, inertSkills: new Set([e.skill.id]) });
        // 该技能在联合随机环境 d 下的边际贡献 = 去掉它后变慢的幅度(其余随机技能保持本组位置)
        marginals[i]!.push(withoutD.finishTimeSec - fullD.finishTimeSec);
      });
    }
  }
  const mean = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
  const totalExpectedSec = totals.length > 0 ? mean(totals) : undefined;
  const totalExpectedCI =
    totals.length > 1
      ? 1.96 * Math.sqrt(totals.reduce((a, v) => a + (v - totalExpectedSec!) ** 2, 0) / (totals.length - 1)) / Math.sqrt(totals.length)
      : 0;

  /**
   * 本技能是否是别的已选技能的「先发前提」提供者。
   * 只认「必须已发动」的依赖(usedSkillBaseIds / requiresFirstBlock);
   * ownedSkillBaseIds 是持有即满足,与发动无关,不算依赖。
   */
  const baseIdOf = (id: string): string => id.replace(/-b\d+$/, '');
  const dependents = new Map<string, string[]>();
  for (const dep of runner.skills) {
    const p = dep.prereq;
    if (p === undefined) continue;
    const providers = new Set<string>();
    for (const clause of p.anyOf ?? [p]) {
      if (clause.requiresFirstBlock === true) providers.add(`${baseIdOf(dep.id)}-b1`);
      for (const id of clause.usedSkillBaseIds ?? []) {
        for (const s2 of runner.skills) if (baseIdOf(s2.id) === id) providers.add(s2.id);
      }
    }
    for (const id of providers) {
      if (id === dep.id) continue;
      const list = dependents.get(id) ?? [];
      if (!list.includes(dep.id)) list.push(dep.id);
      dependents.set(id, list);
    }
  }
  const dependentsOf = (id: string): string[] => dependents.get(id) ?? [];

  /**
   * 存速:进入末脚(最终冲刺)那一帧的「起步速度」被持续型速度技能抬高了多少。
   * 直接取「完整模拟 − 只去掉该技能效果」在同一位置的瞬时速度差(**精确值**,不做衰减建模:
   * 技能若在末脚起点前不久结束,这段时间按阶段减速度已经衰减掉一部分,差值自动反映)。
   * 只对带持续时间的速度技能计算(绿技能/被动是常时,不算存速)。
   */
  const spurtM = full.spurtStartMeter;
  const speedAt = (r: typeof full, meter: number): number | null => {
    for (let i = 1; i < r.x.length; i++) {
      if (r.x[i - 1]! < meter && r.x[i]! >= meter) return r.v[i - 1]!;
    }
    return null;
  };
  const carryOverOf = (
    skill: RunnerConfig['skills'][number],
    without: typeof full,
    acts: readonly { atSec: number }[],
  ): { speed: number; leftSec: number } | null => {
    if (spurtM === null) return null;
    const dur = skill.durationSec !== null && skill.durationSec > 0 ? skill.durationSec * distScale : 0;
    if (dur <= 0) return null;
    if (!skill.effects.some(e => e.type === 'targetSpeed' || e.type === 'currentSpeed')) return null;
    const a = speedAt(full, spurtM);
    const b = speedAt(without, spurtM);
    if (a === null || b === null) return null;
    const speed = a - b;
    if (speed <= 0.01) return null;
    // 剩余时长(负值 = 已在进入末脚前 X 秒结束,残余部分靠衰减)
    const covering = acts.filter(x => x.atSec <= full.spurtStartSec!).pop();
    const leftSec = covering !== undefined ? covering.atSec + dur - full.spurtStartSec! : 0;
    return { speed, leftSec };
  };
  const distScale = course.distance / 1000;

  const rows: AblationRow[] = runner.skills.map(skill => {
    // 装配限制是否满足(不满足 = 整场不生效:绿技能不计入属性,普通技能不发动)
    const applicable = skillApplicable(skill, course, runner);
    // 常时被动(绿技能):无发动点,常时生效(引擎已并入起跑属性),视为已发动
    const isPassiveRaceStart =
      applicable && skill.effects.length > 0 && skill.effects.every(e => e.type === 'passive') && skill.condition?.kind === 'raceStart';
    const without = simulate(course, runner, { inertSkills: new Set([skill.id]) });
    const acts = full.activations.filter(a => a.skillId === skill.id);
    const deltaSec = without.finishTimeSec - full.finishTimeSec;
    const deltaMeter = deltaSec * endV;

    let positionSamples: PositionSample[] | undefined;
    let bodyRange: [number, number] | undefined;
    let expectedBody: number | undefined;
    if (skill.randomPosition === true && acts.length > 0) {
      // 逐位置明细(固定其余技能规则发动,对照用):同位置强制发动 vs 强制发动但去掉本技能效果
      // —— 单项消融口径,与期望(联合 MC 边际)可直接对比(2026-10-31 勘误:此前对比空场,
      //    明细值混入了牌组其他技能的合计收益,与期望口径不可比)
      const spans = sampleableSpans(skill.condition, course);
      if (spans !== null) {
        positionSamples = samplePositions(spans, POSITION_SAMPLES).map(meter => {
          const ov = new Map([[skill.id, meter]]);
          const forced = simulate(course, runner, { positionOverrides: ov });
          const forcedWithout = simulate(course, runner, { positionOverrides: ov, inertSkills: new Set([skill.id]) });
          return {
            meter: Math.round(meter),
            deltaBody: ((forcedWithout.finishTimeSec - forced.finishTimeSec) * endV) / BODY_LENGTH_METERS,
          };
        });
      }
      // 期望 = 联合 MC 边际收益均值(与其他随机技能联合随机)
      const mIdx = mcSkills.findIndex(e => e.skill.id === skill.id);
      if (mIdx >= 0 && marginals[mIdx]!.length > 0) {
        const secs = marginals[mIdx]!;
        expectedBody = (mean(secs) * endV) / BODY_LENGTH_METERS;
        bodyRange = [
          (Math.min(...secs) * endV) / BODY_LENGTH_METERS,
          (Math.max(...secs) * endV) / BODY_LENGTH_METERS,
        ];
      }
    }

    // 同场多次发动(带冷却):逐次拆分 —— 只去掉第 i 次的效果,其余各次照常
    const firingSamples: FiringSample[] | undefined =
      acts.length > 1 && !isPassiveRaceStart
        ? acts.map((a, i) => {
            const withoutI = simulate(course, runner, { inertFirings: new Map([[skill.id, new Set([i])]]) });
            return {
              index: i + 1,
              atMeter: a.atMeter,
              atSec: a.atSec,
              deltaBody: ((withoutI.finishTimeSec - full.finishTimeSec) * endV) / BODY_LENGTH_METERS,
            };
          })
        : undefined;

    return {
      skillId: skill.id,
      name: skill.name,
      activated: isPassiveRaceStart ? true : acts.length > 0,
      activatedAtMeter: acts[0]?.atMeter ?? null,
      activatedAtSec: acts[0]?.atSec ?? null,
      activationCount: acts.length,
      deltaSec,
      deltaMeter,
      deltaBody: deltaMeter / BODY_LENGTH_METERS,
      applicable,
      ...(dependentsOf(skill.id).length > 0 ? { dependentIds: dependentsOf(skill.id) } : {}),
      ...(() => {
        const carry = carryOverOf(skill, without, acts);
        return carry !== null ? { carryOverSpeed: carry.speed, carryOverLeftSec: carry.leftSec } : {};
      })(),
      ...(firingSamples !== undefined ? { firingSamples } : {}),
      ...(positionSamples !== undefined ? { positionSamples } : {}),
      ...(expectedBody !== undefined ? { expectedBody, bodyRange } : {}),
    };
  });

  const totalDeltaSec = none.finishTimeSec - full.finishTimeSec;
  const sumDeltaSec = rows.reduce((a, r) => a + r.deltaSec, 0);
  // 马身换算统一用末脚冲刺目标速度(与逐行一致;UI 不得再用粗略 20m/s,否则与行内对不上)
  const toBody = (secs: number): number => (secs * endV) / BODY_LENGTH_METERS;
  const sumExpectedSec = rows.reduce(
    (a, r) => a + (r.expectedBody !== undefined ? (r.expectedBody * BODY_LENGTH_METERS) / endV : r.deltaSec),
    0,
  );

  return {
    fullTimeSec: full.finishTimeSec,
    noSkillTimeSec: none.finishTimeSec,
    totalDeltaSec,
    sumDeltaSec,
    rows,
    /** 各合计的马身口径(与逐行同一换算):总收益 / Σ规则 / Σ期望 / 总期望 */
    totalDeltaBody: toBody(totalDeltaSec),
    sumDeltaBody: toBody(sumDeltaSec),
    ...(mcDraws !== undefined
      ? {
          mcDraws,
          sumExpectedSec,
          ...(totalExpectedSec !== undefined
            ? { totalExpectedSec, totalExpectedCI, totalExpectedBody: toBody(totalExpectedSec) }
            : {}),
          sumExpectedBody: toBody(sumExpectedSec),
        }
      : {}),
  };
}
