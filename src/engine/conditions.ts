import type { ConditionBase, Course, PhaseId, SkillCondition } from './types';

/** 赛道上的可发动区间 [from, to](米);from === to 表示"越过 from 即触发"的点条件 */
export type Region = readonly [number, number];

export interface FrameState {
  readonly t: number;
  readonly x: number;
  readonly phase: PhaseId;
  /** 是否处于末脚(最终冲刺)状态 */
  readonly isSpurt: boolean;
}

function boundOf(course: Course, key: ConditionBase | PhaseId): number {
  const b = course.phaseBounds;
  switch (key) {
    case 'start':
    case 0:
      return 0;
    case 'midStart':
    case 1:
      return b.midStart;
    case 'lateStart':
    case 2:
      return b.lateStart;
    case 'finalStart':
    case 3:
      return b.finalStart;
  }
}

function phaseEndOf(course: Course, phase: PhaseId): number {
  switch (phase) {
    case 0:
      return course.phaseBounds.midStart;
    case 1:
      return course.phaseBounds.lateStart;
    case 2:
      return course.phaseBounds.finalStart;
    case 3:
      return course.distance;
  }
}

/** 阶段内部按 part(前半/后半/前四分之一)裁剪 */
function clipPart(from: number, to: number, part: 'firstHalf' | 'laterHalf' | 'firstQuarter' | undefined): Region {
  if (part === undefined) return [from, to];
  const len = to - from;
  if (part === 'firstHalf') return [from, from + len / 2];
  if (part === 'laterHalf') return [from + len / 2, to];
  return [from, from + len / 4];
}

/** 区段与窗口的交集;空交集丢弃 */
function intersect(rs: readonly Region[], win: Region): Region[] {
  const out: Region[] = [];
  for (const r of rs) {
    const lo = Math.max(r[0], win[0]);
    const hi = Math.min(r[1], win[1]);
    if (hi >= lo) out.push([lo, hi]);
  }
  return out;
}

/** 赛道直线段(弯道之间的空隙);注意与 realStraights 的区别 */
export function straightGaps(course: Course): readonly Region[] {
  const gaps: Region[] = [];
  let cursor = 0;
  for (const c of course.corners) {
    if (c.start > cursor) gaps.push([cursor, c.start]);
    cursor = Math.max(cursor, c.end);
  }
  if (cursor < course.distance) gaps.push([cursor, course.distance]);
  return gaps;
}

/**
 * 真实直线段(用于「直線」类技能条件):以解包 straights 列表为准。
 * 138 条赛道中有 28 条存在「既非弯道也非直线」的过渡区(如 有馬記念中山2500 起跑后
 * 最初的 100m、大井1200 的 300m 起跑引道),这些区段不触发 直線/corner==0 条件。
 * 数据缺失时回退为弯道间隙。
 */
export function realStraights(course: Course): readonly Region[] {
  const list = (course.straights ?? []).filter(s => s.end > s.start).map(s => [s.start, s.end] as Region);
  if (list.length > 0) return list;
  return straightGaps(course);
}

/** 看台对面的直线段(frontType===2);无该数据时回退为最长的非最终直线 */
function backStraightRegions(course: Course): readonly Region[] {
  const named = (course.straights ?? []).filter(s => s.frontType === 2).map(s => [s.start, s.end] as Region);
  if (named.length > 0) return named;
  const gaps = straightGaps(course).slice(0, -1);
  const longest = gaps.reduce<Region | null>((a, g) => (a === null || g[1] - g[0] > a[1] - a[0] ? g : a), null);
  return longest ? [longest] : [];
}

/**
 * 静态条件 → 赛道上的可发动区间(设计思路参考 uma-skill-tools ConditionParser,见 THIRD_PARTY.md)。
 * 区段类条件(corner/straight/slope 等)返回全部满足段:一次性技能在首个命中段发动,
 * 带冷却的技能(如 弧线大师 30s)可在后续段再次发动。
 * withinPct / withinLeftM 窗口(触发代码 distance_rate / remain_distance 与区段条件联用时)对区段取交集。
 */
export function activationRegions(cond: SkillCondition, course: Course): readonly Region[] {
  const L = course.distance;
  const late = course.phaseBounds.lateStart;
  const phaseFilter = 'phaseFilter' in cond ? cond.phaseFilter : undefined;
  const spurtFilter = 'spurt' in cond ? cond.spurt === true : false;

  let regions: Region[];
  switch (cond.kind) {
    case 'raceStart':
      regions = [[0, 0]];
      break;
    /** 末脚(动态起点):可发动区间为 [终盘分界, 终点],配合逐帧 isSpurt 判定 */
    case 'lastSpurt':
      regions = [[late, L]];
      break;
    case 'phase': {
      const from = boundOf(course, cond.phase);
      const to = cond.phase < 3 ? boundOf(course, (cond.phase + 1) as PhaseId) : L;
      regions = [clipPart(from, to, cond.part)];
      break;
    }
    case 'phaseAfter':
      regions = [[boundOf(course, cond.phase), L]];
      break;
    case 'cornerN': {
      const c = course.corners[cond.n - 1];
      regions = c ? [[c.start, c.end]] : [];
      break;
    }
    case 'cornerFastest': {
      let cs = course.corners.map(c => [c.start, c.end] as Region);
      if (spurtFilter) cs = cs.filter(([, end]) => end > late).map(([from, end]) => [Math.max(from, late), end] as Region);
      else if (phaseFilter !== undefined) {
        const lo = boundOf(course, phaseFilter);
        const hi = phaseEndOf(course, phaseFilter);
        cs = intersect(cs, [lo, hi]);
      }
      regions = cs;
      break;
    }
    case 'finalCorner': {
      const c = course.corners[course.corners.length - 1];
      regions = c ? [clipPart(c.start, c.end, cond.part === 'laterHalf' ? 'laterHalf' : undefined)] : [];
      break;
    }
    case 'finalCornerOnward': {
      const c = course.corners[course.corners.length - 1];
      regions = c ? [[c.start, L]] : [];
      break;
    }
    case 'thirdCornerFromEnd': {
      const c = course.corners[course.corners.length - 3];
      regions = c ? [[c.start, c.end]] : [];
      break;
    }
    case 'lateCorner': {
      const c = course.corners.find(c => c.end > late);
      regions = c ? [[Math.max(c.start, late), c.end]] : [];
      break;
    }
    case 'midCorner': {
      const mid = course.phaseBounds.midStart;
      const c = course.corners.find(c => c.end > mid);
      regions = c ? [[Math.max(c.start, mid), c.end]] : [];
      break;
    }
    case 'finalStraight': {
      // 最终直线 = straights 列表末段(通常即末弯道出口到终点);无数据时按末弯道出口推
      const last = course.straights?.[course.straights.length - 1];
      if (last !== undefined && last.end > last.start) regions = [[last.start, last.end]];
      else {
        const lastCorner = course.corners[course.corners.length - 1];
        const from = lastCorner ? lastCorner.end : 0;
        regions = from < L ? [[from, L]] : [];
      }
      break;
    }
    case 'straightFastest': {
      let gs = realStraights(course);
      if (spurtFilter) gs = gs.filter(([, end]) => end > late).map(([from, end]) => [Math.max(from, late), end] as Region);
      else if (phaseFilter !== undefined) {
        const lo = boundOf(course, phaseFilter);
        const hi = phaseEndOf(course, phaseFilter);
        gs = intersect(gs, [lo, hi]);
      }
      regions = [...gs];
      break;
    }
    case 'backStraight':
      regions = [...backStraightRegions(course)];
      break;
    case 'lateStraight': {
      const g = realStraights(course).find(g => g[1] > late);
      regions = g ? [[Math.max(g[0], late), g[1]]] : [];
      break;
    }
    case 'uphillFastest': {
      let ss = course.slopes.filter(s => s.gradient > 0).map(s => [s.start, s.end] as Region);
      if (spurtFilter) ss = ss.filter(([, end]) => end > late).map(([from, end]) => [Math.max(from, late), end] as Region);
      else if (phaseFilter !== undefined) {
        const lo = boundOf(course, phaseFilter);
        const hi = phaseEndOf(course, phaseFilter);
        ss = intersect(ss, [lo, hi]);
      }
      regions = ss;
      break;
    }
    case 'downhillFastest': {
      let ss = course.slopes.filter(s => s.gradient < 0).map(s => [s.start, s.end] as Region);
      if (spurtFilter) ss = ss.filter(([, end]) => end > late).map(([from, end]) => [Math.max(from, late), end] as Region);
      else if (phaseFilter !== undefined) {
        const lo = boundOf(course, phaseFilter);
        const hi = phaseEndOf(course, phaseFilter);
        ss = intersect(ss, [lo, hi]);
      }
      regions = ss;
      break;
    }
    case 'distanceRun': {
      const p = Math.min(boundOf(course, cond.base) + cond.meters, L);
      regions = [[p, p]];
      break;
    }
    case 'distanceLeft': {
      const from = Math.max(L - cond.toMeters, 0);
      const to = Math.max(L - cond.fromMeters, 0);
      regions = [[Math.min(from, to), Math.max(from, to)]];
      break;
    }
    case 'distanceRate': {
      const from = Math.min((L * cond.fromPct) / 100, L);
      const to = Math.min((L * cond.toPct) / 100, L);
      regions = [[from, Math.max(from, to)]];
      break;
    }
    case 'elapsedSec':
      regions = [[0, L]];
      break;
    case 'positionPct': {
      const p = (L * cond.pct) / 100;
      regions = [[p, p]];
      break;
    }
  }

  if ('withinPct' in cond && cond.withinPct !== undefined) {
    regions = intersect(regions, [(L * cond.withinPct[0]) / 100, (L * cond.withinPct[1]) / 100]);
  }
  if ('withinLeftM' in cond && cond.withinLeftM !== undefined) {
    regions = intersect(regions, [L - cond.withinLeftM[1], L - cond.withinLeftM[0]]);
  }
  return regions;
}

export function inRegion(r: Region, x: number): boolean {
  return r[0] === r[1] ? x >= r[0] : x >= r[0] && x <= r[1];
}

/**
 * 区段随机类技能(randomPosition)的可采样区间:activationRegions 结果中长度 > 0 的段。
 * 点条件(raceStart 等)与动态条件(lastSpurt/带 spurt 标记,起点随体力预算变化)不可枚举 → null,
 * 消融时这些技能不采样、维持规则发动。
 */
export function sampleableSpans(cond: SkillCondition, course: Course): readonly Region[] | null {
  if (cond.kind === 'lastSpurt' || cond.kind === 'raceStart' || cond.kind === 'elapsedSec' || cond.kind === 'positionPct' || cond.kind === 'distanceRun') {
    return null;
  }
  if ('spurt' in cond && cond.spurt === true) return null;
  const spans = activationRegions(cond, course).filter(r => r[1] > r[0]);
  return spans.length > 0 ? spans : null;
}

/** 区间命中后的动态谓词;返回 true 表示本帧可发动 */
export function dynamicSatisfied(cond: SkillCondition, s: FrameState): boolean {
  switch (cond.kind) {
    case 'elapsedSec':
      // v0.1 精确层仅支持基准=起步;其余基准属近似层,由数据侧标记 approx
      return cond.base === 'start' && s.t >= cond.seconds;
    case 'lastSpurt':
      return s.isSpurt;
    default:
      // 任何带 spurt 标记的条件(区段/窗口)都要求处于末脚状态
      return 'spurt' in cond && cond.spurt === true ? s.isSpurt : true;
  }
}
