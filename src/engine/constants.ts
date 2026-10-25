import type { Aptitude, Motivation, PhaseId, SkillRarity, Tactic } from './types';

/** 游戏 30fps,引擎按 1/30s 步长积分 */
export const FPS = 30;
export const DT = 1 / FPS;

/** 出闸初速(解包/614tools) */
export const GATE_SPEED = 3.0;
/** 起步冲刺加速度,至基准速度 85% 后退出 */
export const GATE_ACCEL = 24.0;
export const GATE_EXIT_RATIO = 0.85;

/** 起跑延迟 0.1×随机,期望模型取 0.05 */
export const START_DELAY_EXPECTED = 0.05;

/**
 * 起步放缓段:出闸后前 100m 目标速度 = 序盘目标 × 0.915(≈17.54 m/s@东京2400,用时 ~5.98s)。
 * 来源:614tools「起步放缓/放缓速度」(Excel 系解包);uma-skill-tools 无此段——
 * 两套逆向的分歧点,按对拍基准(614tools)采纳,见 docs/formulas.md。
 * TODO(calibration): 100m 是否随赛道变化待查。
 */
export const START_PACE_DOWN_UNTIL_M = 100;
export const START_PACE_DOWN_RATIO = 0.915;

/** 马身换算:1 马身 = 2.5m(614tools) */
export const BODY_LENGTH_METERS = 2.5;

/** 适性序号(S~G = 0~7) */
export function aptitudeIndex(a: Aptitude): number {
  return 'SABCDEFG'.indexOf(a);
}

/**
 * 以下常量表全部来自解包模型(uma-skill-tools RaceSolver/HpPolicy,GPL-3.0,事实引用),
 * 采纳理由与出处见 docs/formulas.md。
 */

/** 跑法×阶段 目标速度系数(列=序/中/终;最终盘同终盘,末脚速度另行计算) */
export const SPEED_PHASE_RATIO: Readonly<Record<Tactic, readonly [number, number, number]>> = {
  nige: [1.0, 0.98, 0.962],
  senko: [0.978, 0.991, 0.975],
  sashi: [0.938, 0.998, 0.994],
  oikomi: [0.931, 1.0, 1.0],
};

/** 跑法×阶段 加速度系数 */
export const ACCEL_PHASE_RATIO: Readonly<Record<Tactic, readonly [number, number, number]>> = {
  nige: [1.0, 1.0, 0.996],
  senko: [0.985, 1.0, 0.996],
  sashi: [0.975, 1.0, 1.0],
  oikomi: [0.945, 1.0, 0.997],
};

/** 跑法对体力上限的系数 */
export const HP_STRATEGY_COEF: Readonly<Record<Tactic, number>> = {
  nige: 0.95,
  senko: 0.89,
  sashi: 1.0,
  oikomi: 0.995,
};

/** 距离适性:目标速度附加项系数 / 加速度系数(S~G) */
export const DIST_APT_SPEED_MOD = [1.05, 1.0, 0.9, 0.8, 0.6, 0.4, 0.2, 0.1] as const;
export const DIST_APT_ACCEL_MOD = [1.0, 1.0, 1.0, 1.0, 1.0, 0.6, 0.5, 0.4] as const;

/** 场地(跑道)适性:加速度系数(S~G) */
export const SURFACE_APT_ACCEL_MOD = [1.05, 1.0, 0.9, 0.8, 0.7, 0.5, 0.3, 0.1] as const;

/** 基础加速度系数(上坡用较小值) */
export const BASE_ACCEL = 0.0006;
export const UPHILL_BASE_ACCEL = 0.0004;

/** 阶段减速度(序/中/终) */
export const PHASE_DECEL: readonly [number, number, number] = [-1.2, -0.8, -1.0];

/** 体力耗尽后的固定减速 */
export const EXHAUST_DECEL = -1.2;

/**
 * 序盘 PDM(取位放缓)系数:目标速度 ×0.915(614tools sim1!AG2)。
 * 区间 0~int(d/24)m,仅非逃马(逃马改为 位置取り争い,期望模型不启用);发动目标/即时速度技能时提前解除。
 */
export const PDM_SLOWDOWN_RATIO = 0.915;

/** 场地状态对体力消耗的系数(下标=良/稍重/重/不良) */
export const GROUND_HP_COEF: Readonly<Record<'turf' | 'dirt', readonly [number, number, number, number]>> = {
  turf: [1.0, 1.0, 1.02, 1.02],
  dirt: [1.0, 1.0, 1.01, 1.02],
};

/**
 * 干劲对有效属性的乘数(614tools worker:{绝好调1.04,好调1.02,普通1,不调0.98,绝不调0.96};
 * 最低速度实验逐步验证:√(200×根性×干劲)×0.001)
 */
export const MOTIVATION_WISDOM_MULT: Readonly<Record<Motivation, number>> = {
  best: 1.04,
  good: 1.02,
  normal: 1.0,
  bad: 0.98,
  worst: 0.96,
};

/** 属性软上限:超过 1200 的部分减半(614tools E(stat)=1200+(stat−1200)/2) */
export const STAT_SOFT_CAP = 1200;

/**
 * 干劲(智力)增幅的基准乘数,按 脚质×发动阶段(614tools Ce 表):
 * 逃[.26,.23,.19,.16] 先[.21,.21,.21,.21] 差[.19,.18,.23,.24] 追[.15,.17,.25,.27](序/中/终/最终)
 */
export const WISDOM_BASE_MULT: Readonly<Record<Tactic, readonly [number, number, number, number]>> = {
  nige: [0.26, 0.23, 0.19, 0.16],
  senko: [0.21, 0.21, 0.21, 0.21],
  sashi: [0.19, 0.18, 0.23, 0.24],
  oikomi: [0.15, 0.17, 0.25, 0.27],
};

/** 赛道补正对有效速度的乘数(614tools xe:最大=1.2,标准/无=1) */
export const COURSE_FIX_MAX = 1.2;

/** 全开冲刺:面板速度门槛、增速系数、额外速度上限(614tools F/_e/ve) */
export const FULL_SPURT_SPEED_GATE = 2001;
export const FULL_SPURT_RATE = 0.068;
export const FULL_SPURT_CAP = 1.0;

/** 脚色充分(前提):终盘开始起 3 秒,加速度 += √((力量−1200)×130)×0.001(面板力量,不软上限) */
export const ASHIIRO_DURATION_SEC = 3;

/** 耐力对决(前提):终盘起速度 += √(参照耐力−1200)×0.0085×距离系数(参照耐力=面板×干劲,不软上限) */
export function staminaFightDistCoef(distance: number): number {
  if (distance < 2101) return 0;
  if (distance < 2201) return 0.5;
  if (distance < 2401) return 1;
  if (distance < 2601) return 1.5;
  return 1.8;
}

/**
 * 智力增幅的等级系数(614tools:{固有Lv.2:1.01,Lv.3:1.04,Lv.4:1.07,Lv.5:1.1,Lv.6:1.13};
 * 通常/レア=1,固有Lv.1 推定 1)。normal(通常白技)为 0 = 不受智力增幅。
 */
export const RARITY_LEVEL_FACTOR: Readonly<Record<SkillRarity, number>> = {
  normal: 0,
  rareEvolved: 1.0,
  // 进化技能:本体技能进化后的强化版,等级系数按 1.0
  evolved: 1.0,
  unique1: 1.0,
  unique2: 1.01,
  unique3: 1.04,
  unique4: 1.07,
  unique5: 1.1,
  unique6: 1.13,
  // 继承固有(900xxx)不可升级,按 Lv.1 = 1.0
  uniqueHeir: 1.0,
};

/** 末脚延展折算为冲刺额外加速度的比例(Excel AA79,614tools) */
export const LAST_SPURT_EXT_ACCEL_SCALE = 0.1;

/** 策略用的阶段上限:最终盘(3)与终盘(2)在跑法系数上同表 */
export function strategyPhase(phase: PhaseId): 0 | 1 | 2 {
  return (phase > 2 ? 2 : phase) as 0 | 1 | 2;
}
