import { GROUND_HP_COEF, HP_STRATEGY_COEF } from './constants';
import { effectiveStatsOf } from './effstats';
import type { Course, GroundCondition, PhaseId, RunnerConfig } from './types';

/** 体力上限 = 0.8 × 跑法系数 × 有效耐力(软上限+干劲;绿技能不参与) + 距离 */
export function maxHpOf(course: Course, runner: RunnerConfig): number {
  return 0.8 * HP_STRATEGY_COEF[runner.tactic] * effectiveStatsOf(runner, course).stamina + course.distance;
}

/** 终盘起的根性消耗系数 = 1 + 200/√(600×有效根性) */
export function gutsDrainModifier(runner: RunnerConfig): number {
  return 1 + 200 / Math.sqrt(600 * effectiveStatsOf(runner).guts);
}

export interface DrainOpts {
  /** 状态系数(节奏下降×0.6/下坡模式×0.4/焦躁×1.6,v0.1 恒 1) */
  readonly statusCoef: number;
  readonly ground: GroundCondition;
  /** 终盘起应用根性系数 */
  readonly gutsModifier: number;
  readonly phase: PhaseId;
}

/**
 * 秒间体力消耗 = 20 × (v − 基准速度 + 12.0)² / 144 × 状态系数 × 场地状态系数 × (终盘起)根性系数
 */
export function staminaDrainPerSecond(v: number, baseV: number, course: Course, opts: DrainOpts): number {
  const d = v - baseV + 12.0;
  const ground = GROUND_HP_COEF[course.surface][opts.ground];
  const guts = opts.phase >= 2 ? opts.gutsModifier : 1;
  return (20.0 * d * d * opts.statusCoef * ground * guts) / 144.0;
}
