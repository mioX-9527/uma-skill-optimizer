import type { Course, RestrictionClause, RunnerConfig, Season, SkillConfig, SkillRestriction, Stats, Weather } from './types';

/**
 * 装配型限制判定。语义与触发代码一致:
 * - 单条子句内字段是「与」(& 连接);
 * - `anyOf` 多条子句是「或」(@ 变体 / condition_1·condition_2),任一满足即生效。
 * 不满足 ⇒ 整场不生效(绿技能不计入起跑属性)。
 *
 * 环境类取值缺省口径(与 UI 默认一致):场地状态 0=良、天气 1=晴、季节 1=春;
 * 干劲取 runner.motivation;属性条件取面板值(base_*,不含绿技能与干劲);
 * 赛道无 rotation 字段(如新潟草1000m 直線)→ 回转方向类技能不匹配。
 */
export function clauseSatisfied(c: RestrictionClause, runner: RunnerConfig, course: Course): boolean {
  if (c.tactics !== undefined && !c.tactics.includes(runner.tactic)) return false;
  if (c.distanceTypes !== undefined && (course.distanceType === undefined || !c.distanceTypes.includes(course.distanceType))) return false;
  if (c.surfaces !== undefined && !c.surfaces.includes(course.surface)) return false;
  if (c.venues !== undefined && !c.venues.includes(course.venue)) return false;
  if (c.grounds !== undefined && !c.grounds.includes(runner.groundCondition ?? 0)) return false;
  if (c.distances !== undefined && !c.distances.includes(course.distance)) return false;
  if (c.distanceMin !== undefined && course.distance < c.distanceMin) return false;
  if (c.distanceMax !== undefined && course.distance > c.distanceMax) return false;
  // is_basis_distance:标准距离 = 赛程全长为 400 米的整数倍(不是距离档)
  if (c.basisDistance !== undefined && (course.distance % 400 === 0) !== c.basisDistance) return false;

  if (c.rotations !== undefined && (course.rotation === undefined || !c.rotations.includes(course.rotation))) return false;
  if (c.weathers !== undefined && !c.weathers.includes(runner.weather ?? DEFAULT_WEATHER)) return false;
  if (c.seasons !== undefined && !c.seasons.includes(runner.season ?? DEFAULT_SEASON)) return false;
  if (c.motivations !== undefined && !c.motivations.includes(runner.motivation)) return false;
  if (c.abroad !== undefined && (course.overseas === true) !== c.abroad) return false;
  if (c.statsAtLeast !== undefined) {
    for (const [k, v] of Object.entries(c.statsAtLeast)) {
      if (v !== undefined && runner.stats[k as keyof Stats] < v) return false;
    }
  }
  if (c.statsBelow !== undefined) {
    for (const [k, v] of Object.entries(c.statsBelow)) {
      if (v !== undefined && runner.stats[k as keyof Stats] >= v) return false;
    }
  }
  return true;
}

/** 装配限制是否满足(anyOf 任一子句满足即生效;无 anyOf 则按本层字段判定) */
export function restrictionSatisfied(r: SkillRestriction, runner: RunnerConfig, course: Course): boolean {
  if (r.anyOf !== undefined) {
    if (r.anyOf.length === 0) return true;
    return r.anyOf.some(c => clauseSatisfied(c, runner, course));
  }
  return clauseSatisfied(r, runner, course);
}

/** 天气缺省 = 晴(1) */
export const DEFAULT_WEATHER: Weather = 1;
/** 季节缺省 = 春(1) */
export const DEFAULT_SEASON: Season = 1;

/** 技能在当前赛道/环境配置下是否生效(无装配限制视为生效) */
export function skillApplicable(skill: SkillConfig, course: Course, runner: RunnerConfig): boolean {
  return skill.restriction === undefined || restrictionSatisfied(skill.restriction, runner, course);
}
