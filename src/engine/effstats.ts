import { MOTIVATION_WISDOM_MULT, STAT_SOFT_CAP } from './constants';
import type { Course, PassiveStat, RunnerConfig, Stats } from './types';

/**
 * 有效属性管线(614tools worker 实证):
 *   各属性 = 软上限(1200 + (面板−1200)/2) × 干劲乘数;速度再 × 赛道补正。
 * 物理公式(终盘/末脚速度加成、最低速度根性项、体力上限、加速度、上坡减速、
 * 耗体力根性修正)全部使用有效属性;干劲(智力)增幅与耐力对决参照值用面板×干劲口径(见 skills.ts)。
 */
export interface EffectiveStats extends Stats {
  /** 末脚速度加成与终盘加成用的有效速度(含赛道补正) */
  readonly speed: number;
}

export function softCap(stat: number): number {
  return stat <= STAT_SOFT_CAP ? stat : STAT_SOFT_CAP + (stat - STAT_SOFT_CAP) / 2;
}

/**
 * 赛道补正(uma-skill-tools CourseHelpers.courseSpeedModifier):
 *   1 + 平均( (1 + floor(min(参照属性,901)/300.01)) × 0.05 ),参照属性 = 赛道 courseSetStatus
 *   (门槛属性种类);参照属性取 (面板+绿)×干劲。≥901→×1.2、601~900→×1.15、301~600→×1.10、
 *   ≤300→×1.05;courseSetStatus 为空(如东京2400)→ ×1.0(无补正)。
 * courseFix 传数字 = 手动覆盖;'auto'/缺省 = 上式。
 */
export function courseFixOf(course: Course | undefined, runner: RunnerConfig): number {
  const manual = runner.courseFix;
  if (typeof manual === 'number') return manual;
  const refs = course?.courseSetStatus ?? [];
  if (refs.length === 0) return 1;
  const m = MOTIVATION_WISDOM_MULT[runner.motivation];
  const stat = (kind: PassiveStat) => (runner.stats[kind] + (runner.greenBonus[kind] ?? 0)) * m;
  const sum = refs.reduce(
    (acc, kind) => acc + (1 + Math.floor(Math.min(stat(kind), 901) / 300.01)) * 0.05,
    0,
  );
  return 1 + sum / refs.length;
}

export function effectiveStatsOf(runner: RunnerConfig, course?: Course): EffectiveStats {
  const m = MOTIVATION_WISDOM_MULT[runner.motivation];
  const fix = courseFixOf(course, runner);
  return {
    speed: softCap(runner.stats.speed) * m * fix,
    stamina: softCap(runner.stats.stamina) * m,
    power: softCap(runner.stats.power) * m,
    guts: softCap(runner.stats.guts) * m,
    wisdom: softCap(runner.stats.wisdom) * m,
  };
}
