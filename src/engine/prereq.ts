import { restrictionSatisfied } from './restriction';
import type { ActivationCounter, FiredSkill, PrereqContext, SkillConfig, SkillPrereq } from './types';

/** 去掉分支后缀:203061-b2 → 203061 */
export function baseIdOf(id: string): string {
  return id.replace(/-b\d+$/, '');
}

/** 常时被动(绿技能)判定:纯 passive 且起跑即生效 */
function isGreenSkill(s: SkillConfig): boolean {
  return s.effects.length > 0 && s.effects.every(e => e.type === 'passive') && s.condition.kind === 'raceStart';
}

/**
 * 计数器当前值。
 * - all/start/middle/laterHalf/endAfter/heal 来自本次比赛已发动的技能史(绿技能不发动,不计入);
 * - green 为当前赛道/环境下生效的绿技能数,heir 为牌组里的继承技数量。
 */
export function counterValue(k: ActivationCounter, ctx: PrereqContext): number {
  const { fired, course, runner } = ctx;
  switch (k) {
    case 'all':
      return fired.length;
    case 'start':
      return fired.filter(f => f.phase === 0).length;
    case 'middle':
      return fired.filter(f => f.phase === 1).length;
    case 'laterHalf':
      return fired.filter(f => f.meter >= course.distance / 2).length;
    case 'endAfter':
      return fired.filter(f => f.phase >= 2).length;
    case 'heal':
      return fired.filter(f => f.heal).length;
    case 'green':
      // 只数当前赛道/环境下真正生效的绿技能
      return runner.skills.filter(
        s => isGreenSkill(s) && (s.restriction === undefined || restrictionSatisfied(s.restriction, runner, course)),
      ).length;
    case 'heir':
      return runner.skills.filter(s => s.rarity === 'uniqueHeir').length;
  }
}

/**
 * 前提是否满足。`anyOf` 任一子句满足即成立(对应触发代码 `@` 变体的「或」)。
 * 空对象 `{}` 视为「无前提」= 恒真。
 */
export function prereqSatisfied(p: SkillPrereq, ctx: PrereqContext): boolean {
  if (p.anyOf !== undefined && p.anyOf.length > 0) {
    return p.anyOf.some(c => prereqSatisfied(c, ctx));
  }
  if (p.counters !== undefined) {
    for (const [k, req] of Object.entries(p.counters)) {
      if (req === undefined) continue;
      const v = counterValue(k as ActivationCounter, ctx);
      if (req.min !== undefined && v < req.min) return false;
      if (req.max !== undefined && v > req.max) return false;
    }
  }
  if (p.usedSkillBaseIds !== undefined && p.usedSkillBaseIds.length > 0) {
    const used = new Set(ctx.fired.map(f => baseIdOf(f.skillId)));
    for (const id of p.usedSkillBaseIds) if (!used.has(id)) return false;
  }
  if (p.ownedSkillBaseIds !== undefined && p.ownedSkillBaseIds.length > 0) {
    const owned = new Set(ctx.runner.skills.map(s => baseIdOf(s.id)));
    for (const id of p.ownedSkillBaseIds) if (!owned.has(id)) return false;
  }
  if (p.requiresFirstBlock === true) {
    const first = `${ctx.baseId}-b1`;
    if (!ctx.fired.some(f => f.skillId === first)) return false;
  }
  return true;
}
