import { LAST_SPURT_EXT_ACCEL_SCALE, MOTIVATION_WISDOM_MULT, RARITY_LEVEL_FACTOR, WISDOM_BASE_MULT } from './constants';
import { passiveBonusOf } from './effstats';
import type { Course, PhaseId, RunnerConfig, SkillConfig, SkillEffect } from './types';

export { restrictionSatisfied, skillApplicable } from './restriction';

/**
 * 绿技能发动数分档(小林历奇固有等)展开:把 scaleByGreen 按当前生效绿技能数
 * 展开成普通 effects,之后的发动/效果/消融流程完全复用。
 * 未落入任何档 = 仅 base;无 scaleByGreen 的技能原样返回(引用不变)。
 */
export function expandScaleByGreen(skills: readonly SkillConfig[], greenCount: number): SkillConfig[] {
  return skills.map(s => {
    const sc = s.scaleByGreen;
    if (sc === undefined) return s;
    const tier = sc.tiers.find(t => greenCount >= t.min && (t.max === undefined || greenCount <= t.max));
    const effects: readonly SkillEffect[] = tier === undefined ? sc.base : [...sc.base, ...tier.effects];
    if (sameEffects(effects, s.effects)) return s;
    return { ...s, effects };
  });
}

/** 展开结果与原 effects 逐项相等时保留原引用(避免无谓的引用变更破坏调用方缓存/比较) */
function sameEffects(a: readonly SkillEffect[], b: readonly SkillEffect[]): boolean {
  return a.length === b.length && a.every((e, i) => JSON.stringify(e) === JSON.stringify(b[i]));
}

export interface Buff {
  readonly skill: SkillConfig;
  readonly untilSec: number;
  /** 发动时刻(阶段)锁定的智力增幅乘数 */
  readonly mult: number;
}

/** 参照智力 =(面板+绿技能)×干劲(614tools 说明文字口径;绿加成经 passiveBonusOf,含回转方向判定) */
export function referenceWisdom(runner: RunnerConfig, course?: Course): number {
  return (runner.stats.wisdom + passiveBonusOf(runner, course).wisdom) * MOTIVATION_WISDOM_MULT[runner.motivation];
}

/**
 * 智力补正:超过 1200 的部分按档位累计(614tools 页脚):
 * 0–200 每 20 +0.02;200–400 每 20 +0.06;400–800 每 20 +0.01;800–1900 每 100 +0.01。
 * 按档位向上取整到 0.01(示例:参照智力 1872 → 0.94)。
 */
export function wisdomCorrection(w: number): number {
  const over = w - 1200;
  if (over <= 0) return 0;
  let c = 0;
  c += (Math.min(over, 200) / 20) * 0.02;
  c += (Math.max(0, Math.min(over - 200, 200)) / 20) * 0.06;
  c += (Math.max(0, Math.min(over - 400, 400)) / 20) * 0.01;
  c += (Math.max(0, over - 800) / 100) * 0.01;
  return Math.ceil(c * 100) / 100;
}

/**
 * 智力增幅乘数:×(1 + 基准乘数[脚质×发动阶段] × 智力补正 × 等级系数)。
 * 基准乘数为 脚质×阶段 矩阵(614tools Ce 表:逃[.26,.23,.19,.16] 先[.21×4]
 * 差[.19,.18,.23,.24] 追[.15,.17,.25,.27]),按发动时的阶段锁定;
 * 仅对正值的目标/即时速度效果生效(负值不缩放)。
 */
export function effectMultiplier(skill: SkillConfig, runner: RunnerConfig, phase: PhaseId, course?: Course): number {
  if (!skill.wisdomScaled || skill.rarity === 'normal') return 1;
  const base = WISDOM_BASE_MULT[runner.tactic][phase];
  return 1 + base * wisdomCorrection(referenceWisdom(runner, course)) * RARITY_LEVEL_FACTOR[skill.rarity];
}

/** 正值按增幅缩放,负值原样(614tools 口径) */
function scaled(value: number, mult: number): number {
  return value > 0 ? value * mult : value;
}

/** 激活中的目标速度加成(m/s);「即时速度上升」在持续期内同时抬高目标速度(614tools) */
export function targetSpeedBonus(buffs: readonly Buff[], t: number): number {
  let sum = 0;
  for (const b of buffs) {
    if (t >= b.untilSec) continue;
    for (const e of b.skill.effects) {
      if (e.type === 'targetSpeed' || e.type === 'currentSpeed') sum += scaled(e.value, b.mult);
    }
  }
  return sum;
}

export function accelerationBonus(buffs: readonly Buff[], t: number): number {
  let sum = 0;
  for (const b of buffs) {
    if (t >= b.untilSec) continue;
    for (const e of b.skill.effects) {
      if (e.type === 'acceleration') sum += e.value;
    }
  }
  return sum;
}

/** 激活中的末脚延展合计(×0.1 后作为全开冲刺的额外增速速率,614tools growthEffect) */
export function spurtExtensionGrowth(buffs: readonly Buff[], t: number): number {
  let sum = 0;
  for (const b of buffs) {
    if (t >= b.untilSec) continue;
    for (const e of b.skill.effects) {
      if (e.type === 'lastSpurtExtension') sum += e.value * LAST_SPURT_EXT_ACCEL_SCALE;
    }
  }
  return sum;
}

export interface InstantState {
  readonly v: number;
  readonly hp: number;
  readonly maxHp: number;
}

/** 发动瞬间的一次性效果:即时速度提升(正值受增幅)、体力回复 */
export function applyInstant(skill: SkillConfig, s: InstantState, mult: number): InstantState {
  let { v, hp } = s;
  for (const e of skill.effects) {
    if (e.type === 'currentSpeed') v += scaled(e.value, mult);
    else if (e.type === 'heal') {
      // TODO(calibration): 真实回复量与智力/干劲相关;v0.1 按体力上限 × value
      hp = Math.min(s.maxHp, hp + s.maxHp * e.value);
    }
  }
  return { v, hp, maxHp: s.maxHp };
}
