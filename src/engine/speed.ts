import {
  ACCEL_PHASE_RATIO,
  BASE_ACCEL,
  DIST_APT_ACCEL_MOD,
  DIST_APT_SPEED_MOD,
  SPEED_PHASE_RATIO,
  SURFACE_APT_ACCEL_MOD,
  UPHILL_BASE_ACCEL,
  aptitudeIndex,
  strategyPhase,
} from './constants';
import { effectiveStatsOf } from './effstats';
import type { Aptitude, Course, PhaseId, RunnerConfig } from './types';

/** 基准速度 = 22 − 全长/1000(≡20−(距离−2000)/1000;解包;Course.baseSpeed 冗余存同值) */
export function baseSpeedOf(course: Course): number {
  return course.baseSpeed ?? 20 - (course.distance - 2000) / 1000;
}

/**
 * 阶段目标速度(未含技能/温存/坡度):
 *   基准 × 跑法阶段系数;终盘(2)追加 √(500×有效速度)×距离适性×0.002。
 * 有效速度 = 软上限(1200+(面板−1200)/2)×干劲×赛道补正(默认按门槛属性自动计算,见 effstats.ts)。
 */
export function phaseTargetSpeed(course: Course, runner: RunnerConfig, phase: PhaseId): number {
  const p = strategyPhase(phase);
  let v = baseSpeedOf(course) * SPEED_PHASE_RATIO[runner.tactic][p]!;
  if (p === 2) {
    v += Math.sqrt(500 * effectiveStatsOf(runner, course).speed) * DIST_APT_SPEED_MOD[aptitudeIndex(runner.distanceAptitude)]! * 0.002;
  }
  return v;
}

/**
 * 末脚速度 =(终盘目标+0.01×基准)×1.05 + √(500×有效速度)×距离适性×0.002 + (450×有效根性)^0.597×0.0001
 */
export function lastSpurtSpeedOf(course: Course, runner: RunnerConfig): number {
  const base = baseSpeedOf(course);
  const eff = effectiveStatsOf(runner, course);
  const apt = DIST_APT_SPEED_MOD[aptitudeIndex(runner.distanceAptitude)]!;
  return (
    (phaseTargetSpeed(course, runner, 2) + 0.01 * base) * 1.05 +
    Math.sqrt(500 * eff.speed) * apt * 0.002 +
    Math.pow(450 * eff.guts, 0.597) * 0.0001
  );
}

/** 温存速度线(最低速度)= 0.85×基准 + √(200×有效根性)×0.001 */
export function minSpeedOf(course: Course, runner: RunnerConfig): number {
  return baseSpeedOf(course) * 0.85 + Math.sqrt(200 * effectiveStatsOf(runner, course).guts) * 0.001;
}

/** 基础加速度 = 0.0006(上坡 0.0004)×√(500×有效力量)×跑法阶段系数×场地适性×距离适性 */
export function baseAccelOf(course: Course, runner: RunnerConfig, phase: PhaseId, uphill: boolean): number {
  const coef = uphill ? UPHILL_BASE_ACCEL : BASE_ACCEL;
  return (
    coef *
    Math.sqrt(500 * effectiveStatsOf(runner, course).power) *
    ACCEL_PHASE_RATIO[runner.tactic][strategyPhase(phase)]! *
    SURFACE_APT_ACCEL_MOD[aptitudeIndex(runner.surfaceAptitude)]! *
    DIST_APT_ACCEL_MOD[aptitudeIndex(runner.distanceAptitude)]!
  );
}

/** 适性(S~G)对加速度的完整系数(测试/调试用) */
export function accelAptCoef(surface: Aptitude, distance: Aptitude): number {
  return SURFACE_APT_ACCEL_MOD[aptitudeIndex(surface)]! * DIST_APT_ACCEL_MOD[aptitudeIndex(distance)]!;
}
