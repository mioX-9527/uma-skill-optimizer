import { MOTIVATION_WISDOM_MULT, STAT_SOFT_CAP } from './constants';
import { restrictionSatisfied } from './restriction';
import type { Course, PassiveStat, RunnerConfig, Stats } from './types';

/**
 * 有效属性管线(614tools worker 实证):
 *   各属性 = 软上限(1200 + (面板−1200)/2) × 干劲乘数;速度再 × 赛道补正。
 *   面板属性先并入绿技能加成(常时被动,614tools ZP:逐项相加后统一过软上限与干劲)。
 * 物理公式(终盘/末脚速度加成、最低速度根性项、体力上限、加速度、上坡减速、
 * 耗体力根性修正)全部使用有效属性;耐力对决参照值中绿加成不吃干劲(例外,见 simulate.ts sfRef)。
 */
export interface EffectiveStats extends Stats {
  /** 末脚速度加成与终盘加成用的有效速度(含赛道补正) */
  readonly speed: number;
}

export function softCap(stat: number): number {
  return stat <= STAT_SOFT_CAP ? stat : STAT_SOFT_CAP + (stat - STAT_SOFT_CAP) / 2;
}

const STAT_LIST: readonly PassiveStat[] = ['speed', 'stamina', 'power', 'guts', 'wisdom'];

/**
 * 起跑即生效的属性加成合计:
 * ① 已选技能中的常时被动(绿技能,condition=raceStart,全部效果为 passive);
 * ② 手动 greenBonus(用户从游戏面板抄前提值合计时直接填)。
 * 带装配限制(如 顺时针◎ 需顺时针赛道、东京赛场◎ 需东京)的绿技能按 course + 环境配置判定,
 * 不匹配不计入;course 缺省时,带限制的绿技能不计入(生产路径均传 course,无限制的绿技能不受影响)。
 * 带发动前提(prereq)的被动同样不计入:其加成要到比赛中段才成立,起跑折算会凭空常驻。
 * 例外口径:耐力对决参照值中绿加成不吃干劲(simulate.ts sfRef)。
 */
export function passiveBonusOf(runner: RunnerConfig, course?: Course, inert?: ReadonlySet<string>): Stats {
  const out: Record<PassiveStat, number> = { speed: 0, stamina: 0, power: 0, guts: 0, wisdom: 0 };
  for (const s of runner.skills) {
    if (s.effects.length === 0 || s.condition?.kind !== 'raceStart') continue;
    if (!s.effects.every(e => e.type === 'passive')) continue;
    // 消融「只去掉效果」:绿技能按无效果处理(仍算持有/生效,不影响别的技能前提)
    if (inert?.has(s.id) === true) continue;
    // 带发动前提的被动(如「序盘发动技能数≥3」)加成在比赛中段才成立,起跑折算无法表达 → 不计入
    if (s.prereq !== undefined) continue;
    if (s.restriction !== undefined) {
      if (course === undefined) continue;
      if (!restrictionSatisfied(s.restriction, runner, course)) continue;
    }
    for (const e of s.effects) {
      if (e.type === 'passive') out[e.stat] += e.value ?? 0;
    }
  }
  for (const k of STAT_LIST) out[k] += runner.greenBonus?.[k] ?? 0;
  return out;
}

/**
 * 赛道补正(uma-skill-tools CourseHelpers.courseSpeedModifier):
 *   1 + 平均( (1 + floor(min(参照属性,901)/300.01)) × 0.05 ),参照属性 = 赛道 courseSetStatus
 *   (门槛属性种类)上的 (面板+绿)×干劲。≥901→×1.2、601~900→×1.15、301~600→×1.10、
 *   ≤300→×1.05;courseSetStatus 为空(如东京2400)→ ×1.0(无补正)。
 * courseFix 传数字 = 手动覆盖;'auto'/缺省 = 上式。
 */
export function courseFixOf(course: Course | undefined, runner: RunnerConfig, inert?: ReadonlySet<string>): number {
  const manual = runner.courseFix;
  if (typeof manual === 'number') return manual;
  const refs = course?.courseSetStatus ?? [];
  if (refs.length === 0) return 1;
  const bonus = passiveBonusOf(runner, course, inert);
  const stat = (kind: PassiveStat): number => (runner.stats[kind] + bonus[kind]) * MOTIVATION_WISDOM_MULT[runner.motivation];
  const sum = refs.reduce(
    (acc, kind) => acc + (1 + Math.floor(Math.min(stat(kind), 901) / 300.01)) * 0.05,
    0,
  );
  return 1 + sum / refs.length;
}

export function effectiveStatsOf(runner: RunnerConfig, course?: Course, inert?: ReadonlySet<string>): EffectiveStats {
  const m = MOTIVATION_WISDOM_MULT[runner.motivation];
  const bonus = passiveBonusOf(runner, course, inert);
  const fix = courseFixOf(course, runner, inert);
  return {
    speed: softCap(runner.stats.speed + bonus.speed) * m * fix,
    stamina: softCap(runner.stats.stamina + bonus.stamina) * m,
    power: softCap(runner.stats.power + bonus.power) * m,
    guts: softCap(runner.stats.guts + bonus.guts) * m,
    wisdom: softCap(runner.stats.wisdom + bonus.wisdom) * m,
  };
}
