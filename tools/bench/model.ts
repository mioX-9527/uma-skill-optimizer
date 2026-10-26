/**
 * 候选池 / 收益口径的**只读复刻**,用于基准测试里的穷举与独立复核。
 *
 * 为什么是复刻而不是直接调 optimize 的内部函数:optimize 的内部状态(Cand、 combine、
 * totalSpent)没有导出,穷举需要在「同一套 PT 计费 / 同一套互斥规则 / 同一套收益口径」
 * 下遍历组合,否则最优解不可比。
 *
 * 一致性保证:`bench.ts` 会用 checkParity() 断言「本文件算出的时间内==
 * optimize 汇报的 finalSec」,一旦 src 改了结算口径而这里没跟上,测试立刻失败。
 */
import { BODY_LENGTH_METERS, sampleableSpans, simulate } from '../../src/engine/index.js';
import type { Course, Region, RunnerConfig, SimResult, SkillConfig } from '../../src/engine/index.js';
import { CIRCLE_BASE, CIRCLE_UPGRADES, SKILLS, type SkillEntry } from '../../src/data.js';

export const SKILL_INDEX = new Map(SKILLS.map(s => [s.id, s] as const));

/** optimizer.ts 里的常量,必须同步:RANDOM_POSITION_DRAWS */
export const RANDOM_POSITION_DRAWS = 12;
export const DRAWS: readonly number[] = Array.from(
  { length: RANDOM_POSITION_DRAWS },
  (_, i) => (i + 0.5) / RANDOM_POSITION_DRAWS,
);

function quantileToMeter(spans: readonly Region[], u: number): number {
  let target = u * spans.reduce((a, s) => a + (s[1] - s[0]), 0);
  for (const s of spans) {
    const len = s[1] - s[0];
    if (target <= len) return s[0] + target;
    target -= len;
  }
  return spans[spans.length - 1]![1];
}

/** 候选:与 optimize 的输入同形 */
export interface RawCand {
  readonly id: string;
  readonly pt: number;
  readonly requires?: string;
  readonly evolvesTo?: string;
}

/** 展开后的候选(补双圈 ◎;与 optimizer.ts 的 cands 同构) */
export interface Item {
  readonly id: string;
  readonly pt: number;
  readonly requires: readonly string[];
  readonly circleChain: boolean;
  readonly baseId?: string;
  /** 买它时会一并装入的技能(自己 + 未买的前置 + 进化形态) */
  readonly withSkills: readonly SkillConfig[];
  /** 技能名(仅用于输出) */
  readonly name: string;
}

/**
 * 按 optimizer.ts 的规则展开候选池(补 ◎、算 withSkills)。
 * input: 原始候选列表。poolIds: 参与计费/替补判定的候选 id 集合。
 */
export function expandPool(input: readonly RawCand[]): Item[] {
  const seen = new Set(input.map(c => c.id));
  const conflict = (c: RawCand): boolean => seen.has(c.id);
  void conflict;
  const itemOf = (c: RawCand, circleChain: boolean, baseId?: string): Item => {
    const skill = SKILL_INDEX.get(c.id)!;
    const preListed = c.requires !== undefined && seen.has(c.requires);
    const pre = preListed ? SKILL_INDEX.get(c.requires!) : undefined;
    const evolved = c.evolvesTo !== undefined ? SKILL_INDEX.get(c.evolvesTo) : undefined;
    const preSkills: readonly SkillConfig[] = pre !== undefined ? [pre] : [];
    return {
      id: c.id,
      pt: c.pt,
      requires: preListed ? [c.requires!] : [],
      circleChain,
      ...(baseId !== undefined ? { baseId } : {}),
      // 与 src 同步:金技能替换下位白,模拟里只装金自己
      withSkills: [evolved ?? skill],
      name: skill.name,
    };
  };
  const items = input.map(c => itemOf(c, false));
  const byId = new Map(items.map(i => [i.id, i] as const));
  const seenIds = new Set(items.map(i => i.id));
  for (const base of [...items]) {
    const up = CIRCLE_UPGRADES.get(base.id);
    if (up === undefined || seenIds.has(up.upId)) continue;
    if (SKILL_INDEX.get(up.upId) === undefined) continue;
    seenIds.add(up.upId);
    const ratio = up.basePt > 0 ? base.pt / up.basePt : 1;
    const sane = ratio >= 0.4 && ratio <= 1.05;
    const upPt = sane ? Math.max(1, Math.round(up.upPt * ratio)) : up.upPt;
    byId.set(up.upId, itemOf({ id: up.upId, pt: upPt, requires: base.id }, true, base.id));
  }
  return [...byId.values()];
}

/** 与 optimizer.ts 的 combine 同法:去重 + ◎ 顶掉 ○ */
export function combine(groups: readonly (readonly SkillConfig[])[]): SkillConfig[] {
  const m = new Map<string, SkillConfig>();
  for (const g of groups) for (const s of g) m.set(s.id, s);
  for (const [upId, baseId] of CIRCLE_BASE) {
    if (m.has(upId) && m.has(baseId)) m.delete(baseId);
  }
  return [...m.values()];
}

export function skillsOf(items: readonly Item[]): SkillConfig[] {
  // 与 src 的 combine 同法:去重 + ◎顶○ + 金顶下位白
  const m = new Map<string, SkillConfig>();
  for (const i of items) for (const s of i.withSkills) m.set(s.id, s);
  for (const [upId, baseId] of CIRCLE_BASE) {
    if (m.has(upId) && m.has(baseId)) m.delete(baseId);
  }
  for (const i of items) {
    const baseId = i.requires.length === 1 ? i.requires[0]! : undefined;
    if (baseId !== undefined && m.has(i.id) && m.has(baseId)) m.delete(baseId);
  }
  return [...m.values()];
}

/** 与 optimizer.ts 的 costOf/totalSpent 同法(与装入顺序无关) */
export function costOf(item: Item, ids: ReadonlySet<string>, all: ReadonlyMap<string, Item>): number {
  const prereqChosen = item.requires.length > 0 && item.requires.every(r => ids.has(r));
  if (item.circleChain) {
    const base = item.baseId !== undefined ? all.get(item.baseId) : undefined;
    return item.pt + (prereqChosen || base === undefined ? 0 : costOf(base, ids, all));
  }
  const requiresPt = prereqChosen ? (all.get(item.requires[0]!)?.pt ?? 0) : 0;
  return prereqChosen ? Math.max(0, item.pt - requiresPt) : item.pt;
}

export function totalSpent(items: readonly Item[], all: ReadonlyMap<string, Item>): number {
  const ids = new Set(items.map(i => i.id));
  return items.reduce((sum, c) => sum + costOf(c, ids, all), 0);
}

/** 是否会被 optimizer 剔除(blocked / 超预算)——剔除后不进池 */
export function isBlocked(skill: SkillEntry, course: Course, runner: RunnerConfig): boolean {
  const allPassive = skill.effects.length > 0 && skill.effects.every(e => e.type === 'passive');
  const greenLike = allPassive && skill.condition.kind === 'raceStart' && skill.prereq === undefined;
  if (skill.precision === 'unsupported') return true;
  if (allPassive && !greenLike) return true;
  if (skill.restriction !== undefined) {
    // 与 src/engine/restriction.ts clauseSatisfied 同口径
    const r = skill.restriction;
    const ok = r.anyOf !== undefined
      ? (r.anyOf.length === 0 || r.anyOf.some(c => clauseOk(c, runner, course)))
      : clauseOk(r as never, runner, course);
    if (!ok) return true;
  }
  return false;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function clauseOk(c: any, runner: RunnerConfig, course: Course): boolean {
  if (c.tactics !== undefined && !c.tactics.includes(runner.tactic)) return false;
  if (c.distanceTypes !== undefined && (course.distanceType === undefined || !c.distanceTypes.includes(course.distanceType))) return false;
  if (c.surfaces !== undefined && !c.surfaces.includes(course.surface)) return false;
  if (c.venues !== undefined && !c.venues.includes(course.venue)) return false;
  if (c.grounds !== undefined && !c.grounds.includes(runner.groundCondition ?? 0)) return false;
  if (c.distances !== undefined && !c.distances.includes(course.distance)) return false;
  if (c.distanceMin !== undefined && course.distance < c.distanceMin) return false;
  if (c.distanceMax !== undefined && course.distance > c.distanceMax) return false;
  if (c.basisDistance !== undefined && (course.distance % 400 === 0) !== c.basisDistance) return false;
  if (c.rotations !== undefined && (course.rotation === undefined || !c.rotations.includes(course.rotation))) return false;
  if (c.weathers !== undefined && !c.weathers.includes(runner.weather ?? 1)) return false;
  if (c.seasons !== undefined && !c.seasons.includes(runner.season ?? 1)) return false;
  if (c.motivations !== undefined && !c.motivations.includes(runner.motivation)) return false;
  if (c.abroad !== undefined && (course.overseas === true) !== c.abroad) return false;
  if (c.statsAtLeast !== undefined) {
  for (const [k, v] of Object.entries(c.statsAtLeast as Record<string, number | undefined>)) {
    if (v !== undefined && ((runner.stats as unknown as Record<string, number>)[k] ?? 0) < v) return false;
  }
  }
  if (c.statsBelow !== undefined) {
  for (const [k, v] of Object.entries(c.statsBelow as Record<string, number | undefined>)) {
    if (v !== undefined && ((runner.stats as unknown as Record<string, number>)[k] ?? 0) >= v) return false;
  }
  }
  return true;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * 收益口径 A(产品口径 / 与 optimize 汇报一致):
 * 区段随机技能在**同一分位 u** 上同时取点(完全相关),12 点等距求均值。
 */
export class ExpectedEvaluator {
  private readonly spanCache = new Map<string, readonly Region[] | null>();
  /** 评估次数统计(可选) */
  private readonly counter = new Map<string, number>();

  constructor(private readonly course: Course, private readonly runner: RunnerConfig) {}

  spansOf(s: SkillConfig): readonly Region[] | null {
    let v = this.spanCache.get(s.id);
    if (v === undefined) {
      v = s.randomPosition === true ? sampleableSpans(s.condition, this.course) : null;
      this.spanCache.set(s.id, v);
    }
    return v;
  }

  /** 期望完赛时间(秒);越小越好 */
  evaluate(skills: readonly SkillConfig[]): number {
    const randoms = skills.filter(s => this.spansOf(s) !== null);
    if (randoms.length === 0) return this.raw(skills).finishTimeSec;
    let sum = 0;
    for (const u of DRAWS) {
      const ov = new Map(randoms.map(s => [s.id, quantileToMeter(this.spansOf(s)!, u)] as const));
      sum += this.raw(skills, ov).finishTimeSec;
    }
    return sum / DRAWS.length;
  }

  /** 原始一次模拟(可带/不带 FindFirst 位置覆盖) */
  raw(skills: readonly SkillConfig[], ov?: ReadonlyMap<string, number>): SimResult {
    return ov === undefined || ov.size === 0
      ? simulate(this.course, { ...this.runner, skills })
      : simulate(this.course, { ...this.runner, skills }, { positionOverrides: ov });
  }

  /** 末脚目标速度(optimizer 用它做 马身/秒 换算) */
  spurtTargetSpeed(skills: readonly SkillConfig[]): number {
    return this.raw(skills).spurtTargetSpeed;
  }

  /**
   * 收益口径 B(独立复核用,参照 src/analysis/ablate.ts):
   * 各随机技能**独立**拉丁超立方抽样(每个技能占一个分层),含 95% 置信半宽。
   * 与口径 A 的差别正是「相关 vs 独立」造成的估计偏差。
   */
  evaluateIndependent(skills: readonly SkillConfig[], draws: number): { mean: number; ci: number } {
    const randoms = skills.filter(s => this.spansOf(s) !== null);
    if (randoms.length === 0) return { mean: this.raw(skills).finishTimeSec, ci: 0 };
    const totals: number[] = [];
    for (let d = 0; d < draws; d++) {
      const ov = new Map<string, number>();
      randoms.forEach((s, i) => {
        const phi = ((i + 1) * 0.6180339887498949) % 1;
        const u = ((((d + 0.5) / draws) + phi) % 1 + 1) % 1;
        ov.set(s.id, quantileToMeter(this.spansOf(s)!, u));
      });
      totals.push(this.raw(skills, ov).finishTimeSec);
    }
    const mean = totals.reduce((a, b) => a + b, 0) / totals.length;
    const sd = Math.sqrt(totals.reduce((a, v) => a + (v - mean) ** 2, 0) / Math.max(1, totals.length - 1));
    return { mean, ci: totals.length > 1 ? (1.96 * sd) / Math.sqrt(totals.length) : 0 };
  }

  /** 评估次数统计(可选);key → 次数 */
  hitCounts(): ReadonlyMap<string, number> {
    return this.counter;
  }

  mark(key: string): void {
    this.counter.set(key, (this.counter.get(key) ?? 0) + 1);
  }
}

/** 秒 → 马身(与 optimizer.ts 同一换算基准) */
export function toBody(sec: number, spurtTargetSpeed: number): number {
  return (sec * spurtTargetSpeed) / BODY_LENGTH_METERS;
}
