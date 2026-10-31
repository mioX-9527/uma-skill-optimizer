import {
  ASHIIRO_DURATION_SEC,
  DT,
  EXHAUST_DECEL,
  FULL_SPURT_CAP,
  FULL_SPURT_RATE,
  FULL_SPURT_SPEED_GATE,
  GATE_ACCEL,
  GATE_EXIT_RATIO,
  GATE_SPEED,
  MOTIVATION_WISDOM_MULT,
  PHASE_DECEL,
  PDM_SLOWDOWN_RATIO,
  START_DELAY_EXPECTED,
  staminaFightDistCoef,
  strategyPhase,
} from './constants';
import {
  activationRegions,
  dynamicSatisfied,
  inRegion,
  type FrameState,
} from './conditions';
import { effectiveStatsOf, passiveBonusOf } from './effstats';
import { phaseAt } from './phase';
import { baseIdOf, counterValue, prereqSatisfied } from './prereq';
import { baseAccelOf, baseSpeedOf, lastSpurtSpeedOf, minSpeedOf, phaseTargetSpeed } from './speed';
import {
  accelerationBonus,
  applyInstant,
  effectMultiplier,
  expandScaleByGreen,
  restrictionSatisfied,
  spurtExtensionGrowth,
  targetSpeedBonus,
  type Buff,
} from './skills';
import { gutsDrainModifier, maxHpOf, staminaDrainPerSecond } from './stamina';
import type { Activation, Course, FiredSkill, RunnerConfig, SimOptions, SimResult, SkillConfig, Slope } from './types';

const MAX_SECONDS = 600;

/** 当前位置所在的坡道段 */
export function slopeAt(course: Course, x: number): Slope | null {
  for (const s of course.slopes) {
    if (x >= s.start && x < s.end) return s;
  }
  return null;
}

interface SpurtCtx {
  readonly pos: number;
  readonly hp: number;
}

/**
 * 末脚(最终冲刺)开始位置:按体力预算解算(解包 HpPolicy.getLastSpurtPair 的确定性最优解,
 * 忽略与智力相关的"次优接受率"随机项)。体力充裕时从终盘分界(2/3)即开始末脚。
 * (614tools 为固定 2/3 切换的简化模型;此处保留解包口径,体力充裕时两者一致)
 */
function solveSpurtTransition(
  course: Course,
  runner: RunnerConfig,
  ctx: SpurtCtx,
  inert?: ReadonlySet<string>,
): number {
  const baseV = baseSpeedOf(course);
  const gutsMod = gutsDrainModifier(runner, course);
  const ground = runner.groundCondition ?? 0;
  const drainAt = (v: number): number =>
    staminaDrainPerSecond(v, baseV, course, { statusCoef: 1, ground, gutsModifier: gutsMod, phase: 2 });
  const spurtV = lastSpurtSpeedOf(course, runner, inert);
  const target2 = phaseTargetSpeed(course, runner, 2, inert);
  const late = course.phaseBounds.lateStart;

  // 体力足以全程末脚:从终盘分界开始
  const maxDist = course.distance - late;
  const sFull = (maxDist - 60) / spurtV;
  if (ctx.hp >= drainAt(spurtV) * sFull) return late;

  // 否则解最优(最早完赛)的冲刺起点
  const remain = course.distance - 60 - ctx.pos;
  const candidates: Array<[number, number]> = [];
  for (let speed = spurtV - 0.1; speed >= target2; speed -= 0.1) {
    const dur = Math.min(
      remain / speed,
      Math.max(
        0,
        (target2 * ctx.hp - drainAt(target2) * remain) /
          (target2 * drainAt(speed) - drainAt(target2) * speed),
      ),
    );
    const spurtDistance = dur * speed + 60;
    candidates.push([course.distance - spurtDistance, speed]);
  }
  if (candidates.length === 0) return course.distance;
  candidates.sort(
    (a, b) =>
      (a[0] - ctx.pos) / target2 + (course.distance - a[0]) / a[1] -
      ((b[0] - ctx.pos) / target2 + (course.distance - b[0]) / b[1]),
  );
  return candidates[0]![0];
}

/**
 * 单马确定性期望模拟:dt 帧级积分,物理公式见 docs/formulas.md(解包模型 + 614tools 交叉验证)。
 * 随机项(焦躁/追比/下坡模式/位置保持等)v0.1 不参与计算;全开冲刺/前提机制按期望建模。
 */
export function simulate(course: Course, runner: RunnerConfig, opts: SimOptions = {}): SimResult {
  // 绿技能发动数分档(小林历奇固有等):绿技能均在起跑时生效,数量整场恒定,
  // 开局按 counterValue('green') 一次性展开成普通 effects,后续发动/效果/消融流程完全复用
  const greenCount = counterValue('green', { course, runner, baseId: '', fired: [] });
  runner = { ...runner, skills: expandScaleByGreen(runner.skills, greenCount) };
  const ignoreExhaustion = opts.ignoreExhaustion === true;
  const positionOverrides = opts.positionOverrides;
  /** 消融「只去掉效果、保留发动」的技能 id(仍计入 fired / activations) */
  const inert = opts.inertSkills;
  /** 消融「逐次发动拆分」:只去掉这些 (技能, 发动序号) 的效果 */
  const inertFirings = opts.inertFirings;
  /** 各技能本场已发动次数(供 inertFirings 定位第几次) */
  const fireIdx = new Map<string, number>();
  const baseV = baseSpeedOf(course);
  const maxHp = maxHpOf(course, runner, inert);
  const minSpeed = minSpeedOf(course, runner, inert);
  const gutsMod = gutsDrainModifier(runner, course, inert);
  const spurtV = lastSpurtSpeedOf(course, runner, inert);
  const ground = runner.groundCondition ?? 0;
  const distScale = course.distance / 1000;
  const late = course.phaseBounds.lateStart;
  const eff = effectiveStatsOf(runner, course, inert);

  // 序盘 PDM(取位放缓):仅非逃马,0~int(d/24);发动目标/即时速度技能时提前解除(614tools)
  const pdmApplies = runner.tactic !== 'nige';
  const pdmEndM = Math.floor(course.distance / 24);
  let pdmActive = pdmApplies;

  // 前提机制(614tools 默认开启):脚色充分(终盘起 3s 加速度,面板力量)、耐力对决(终盘起速度)
  const ashiiroOn = (runner.assumeAshiiro ?? true) && runner.stats.power > 1200;
  const ashiiroBonus = ashiiroOn ? Math.sqrt((runner.stats.power - 1200) * 130) * 0.001 : 0;
  let ashiiroRemaining = 0;
  let ashiiroDone = false;
  const sfOn = (runner.assumeStaminaFight ?? true) && staminaFightDistCoef(course.distance) > 0;
  // 耐力对决参照值:面板×干劲 + 绿加成(绿不吃干劲,614tools worker Je 口径)
  const sfGreen = passiveBonusOf(runner, course, inert).stamina;
  const sfRef = runner.stats.stamina * MOTIVATION_WISDOM_MULT[runner.motivation] + sfGreen;
  const sfBonus = sfOn && sfRef > 1200 ? Math.sqrt(sfRef - 1200) * 0.0085 * staminaFightDistCoef(course.distance) : 0;

  // 全开冲刺:速度 ≥2001(含绿加成,614tools B2 口径)且进入末脚后速度达冲刺目标(含坡度修正)时
  const fsOn =
    (runner.fullSpurtEnabled ?? true) &&
    runner.stats.speed + passiveBonusOf(runner, course, inert).speed >= FULL_SPURT_SPEED_GATE;
  const fsRate = fsOn ? (FULL_SPURT_RATE * baseAccelOf(course, runner, 2, false, inert)) / Math.pow(distScale, 1.5) : 0;
  let fsStarted = false;
  let fsExtra = 0;

  const tArr: number[] = [];
  const xArr: number[] = [];
  const vArr: number[] = [];
  const hpArr: number[] = [];
  let v = GATE_SPEED;
  let x = 0;
  let t = 0;
  let hp = maxHp;
  let tempering = false;
  let spurtOn = false;
  let spurtTransition: number | null = null;
  /** 末脚起点的位置/时刻(首次进入末脚那一帧;存速判定基准) */
  let spurtStartMeter: number | null = null;
  let spurtStartSec: number | null = null;
  let startDash = true;
  let exhaustedAtMeter: number | null = null;
  const buffs: Buff[] = [];
  const activations: Activation[] = [];
  /** 一次性技能的已发动标记(冷却缺失或 ≥ 一场最长冷却 500s) */
  const activated = new Set<string>();
  /** 已发动技能史(供 prereq 计数器:已发动数量 / 回复数量 / 某技能是否发动过) */
  const fired: FiredSkill[] = [];
  /** 带冷却技能的下次可发动时刻(秒,基准值已按 距离/1000 缩放) */
  const readyAt = new Map<string, number>();
  /** 位置采样:已按强制位置发动过的技能 */
  const overrideFired = new Set<string>();

  /** 前提是否满足(已发动技能数 / 回复数 / 指定技能 / 本技能第一段) */
  const prereqOk = (s: SkillConfig): boolean =>
    s.prereq === undefined ||
    prereqSatisfied(s.prereq, { course, runner, baseId: baseIdOf(s.id), fired });

  /** 记录一次发动(供后续技能的前提判定) */
  const noteFired = (s: SkillConfig, frame: FrameState): void => {
    fired.push({
      skillId: s.id,
      phase: frame.phase,
      meter: frame.x,
      // 回复类技能计数:按效果类型判定(负值的「回复×」也属回复技能分类)
      heal: s.effects.some(e => e.type === 'heal'),
    });
  };

  /** 发动效果入栈(共用路径:规则发动与位置采样强制发动);inertThis = 只去掉这一次的效果 */
  const applyFire = (s: SkillConfig, frame: FrameState, inertThis = false): void => {
    // 消融「只去掉效果」:照常算发动(已记入 fired/activations),但不施加效果
    if (inertThis || inert?.has(s.id) === true) return;
    const mult = effectMultiplier(s, runner, frame.phase, course);
    const dur = s.durationSec !== null && s.durationSec > 0 ? s.durationSec * distScale : 0;
    if (dur > 0) buffs.push({ skill: s, untilSec: t + dur, mult });
    const st = applyInstant(s, { v, hp, maxHp }, mult);
    v = st.v;
    hp = st.hp;
    // 目标/即时速度技能提前解除序盘 PDM(614tools sim1!BX)
    if (s.effects.some(e => (e.type === 'targetSpeed' || e.type === 'currentSpeed') && e.value !== 0)) pdmActive = false;
    // 回复改变体力预算:末脚尚未开始时重算起点
    if (s.effects.some(e => e.type === 'heal') && !spurtOn) spurtTransition = null;
  };

  const record = (): void => {
    tArr.push(t);
    xArr.push(x);
    vArr.push(v + fsExtra);
    hpArr.push(hp);
  };
  record();

  const dt = DT;
  while (x < course.distance && t < MAX_SECONDS) {
    const phase = phaseAt(course, x);
    const p2 = strategyPhase(phase);

    if (phase >= 2 && spurtTransition === null) {
      spurtTransition = solveSpurtTransition(course, runner, { pos: x, hp }, inert);
    }
    if (!spurtOn && spurtTransition !== null && x >= spurtTransition) {
      spurtOn = true;
      spurtStartMeter = x;
      spurtStartSec = t;
    }
    if (pdmActive && x >= pdmEndM) pdmActive = false;
    if (ashiiroOn && !ashiiroDone && x >= late) {
      ashiiroRemaining = ASHIIRO_DURATION_SEC;
      ashiiroDone = true;
    }

    // ---- 目标速度 ----
    const slope = slopeAt(course, x);
    let target: number;
    if (spurtOn) {
      target = spurtV;
    } else if (p2 === 0) {
      // 序盘 PDM(取位放缓):出闸后前 int(d/24) m 目标压低(614tools sim1!AG2)
      target = phaseTargetSpeed(course, runner, 0, inert) * (pdmActive ? PDM_SLOWDOWN_RATIO : 1);
    } else {
      target = phaseTargetSpeed(course, runner, phase, inert);
    }
    target += targetSpeedBonus(buffs, t);
    // 前提:耐力对决(终盘起概算加速)
    if (sfBonus > 0 && x >= late) target += sfBonus;
    if (hp <= 0 && !ignoreExhaustion) tempering = true;
    if (tempering) {
      target = Math.min(target, minSpeed);
    } else if (slope !== null && slope.gradient > 0) {
      // 上坡减速:gradient%×200/有效力量,下限温存线
      target = Math.max(target - (slope.gradient * 200) / eff.power, minSpeed);
    }

    // ---- 加速度 ----
    let accel: number;
    if (tempering) {
      accel = EXHAUST_DECEL;
    } else if (v > target) {
      accel = PHASE_DECEL[p2];
    } else {
      accel =
        baseAccelOf(course, runner, phase, slope !== null && slope.gradient > 0, inert) +
        accelerationBonus(buffs, t) +
        (ashiiroRemaining > 0 ? ashiiroBonus : 0);
    }
    if (startDash) accel = Math.max(accel, GATE_ACCEL);

    // ---- 积分 ----
    const dv = target - v;
    if (dv > 0) v += Math.min(dv, accel * dt);
    else if (dv < 0) v += Math.max(dv, accel * dt);
    if (startDash && v >= GATE_EXIT_RATIO * baseV) startDash = false;
    if (!startDash && v < minSpeed) v = minSpeed;

    hp -= staminaDrainPerSecond(v, baseV, course, {
      statusCoef: 1,
      ground,
      gutsModifier: gutsMod,
      phase,
    }) * dt;
    if (hp <= 0 && exhaustedAtMeter === null) exhaustedAtMeter = x;

    for (let i = buffs.length - 1; i >= 0; i--) {
      if (t >= buffs[i]!.untilSec) buffs.splice(i, 1);
    }

    // ---- 全开冲刺:末脚内首次达到冲刺目标(含上坡修正)后,额外速度按速率增长(上限 +1 m/s) ----
    if (fsOn && spurtOn) {
      const uphillPenalty = slope !== null && slope.gradient > 0 ? (slope.gradient * 200) / eff.power : 0;
      if (!fsStarted) {
        if (v >= spurtV - uphillPenalty - 1e-9) fsStarted = true;
      }
      if (fsStarted) {
        fsExtra = Math.min(FULL_SPURT_CAP, Math.max(0, fsExtra + (fsRate + spurtExtensionGrowth(buffs, t)) * dt));
      }
    }

    // ---- 技能发动 ----
    const frame: FrameState = { t, x, phase, isSpurt: spurtOn };
    for (const s of runner.skills) {
      if (s.precision === 'unsupported') continue;
      // 常时被动(绿技能)已并入起跑属性(effstats passiveBonusOf),不走发动通道
      if (s.effects.length > 0 && s.effects.every(e => e.type === 'passive')) continue;
      const once = s.cooldownSec === null || s.cooldownSec === undefined;
      if (once ? activated.has(s.id) : (readyAt.get(s.id) ?? 0) > t) continue;
      // 位置采样(消融):强制首次发动位置——未到指定位置前压制规则发动,到达即发动(跳过区段/动态判定)
      const overrideM = positionOverrides?.get(s.id);
      if (overrideM !== undefined && !overrideFired.has(s.id)) {
        if (x < overrideM) continue;
        if (s.restriction !== undefined && !restrictionSatisfied(s.restriction, runner, course)) continue;
        // 强制位置也尊重发动前提:前提未满足时继续等待(否则消融会凭空发动)
        if (!prereqOk(s)) continue;
        overrideFired.add(s.id);
        if (once) activated.add(s.id);
        else readyAt.set(s.id, t + s.cooldownSec * distScale);
        activations.push({ skillId: s.id, name: s.name, atSec: t, atMeter: x, precision: s.precision });
        const idx = fireIdx.get(s.id) ?? 0;
        fireIdx.set(s.id, idx + 1);
        noteFired(s, frame);
        applyFire(s, frame, inertFirings?.get(s.id)?.has(idx) === true);
        continue;
      }
      if (s.restriction !== undefined && !restrictionSatisfied(s.restriction, runner, course)) continue;
      const hit = activationRegions(s.condition, course).some(r => inRegion(r, x));
      if (!hit) continue;
      if (!dynamicSatisfied(s.condition, frame)) continue;
      // 发动前提(已发动技能数/回复数/需先发动的技能):不满足则本帧不发动,后续帧继续尝试
      if (!prereqOk(s)) continue;
      if (once) activated.add(s.id);
      else readyAt.set(s.id, t + s.cooldownSec * distScale);
      activations.push({ skillId: s.id, name: s.name, atSec: t, atMeter: x, precision: s.precision });
      const idx = fireIdx.get(s.id) ?? 0;
      fireIdx.set(s.id, idx + 1);
      noteFired(s, frame);
      applyFire(s, frame, inertFirings?.get(s.id)?.has(idx) === true);
    }

    if (ashiiroRemaining > 0) ashiiroRemaining = Math.max(0, ashiiroRemaining - dt);

    x += (v + fsExtra) * dt;
    t += dt;
    record();
  }

  const interp = interpolateFinish(tArr, xArr, course.distance) ?? t;
  return {
    finishTimeSec: interp + START_DELAY_EXPECTED,
    spurtTargetSpeed: spurtV,
    spurtStartMeter,
    spurtStartSec,
    t: Float64Array.from(tArr),
    x: Float64Array.from(xArr),
    v: Float64Array.from(vArr),
    hp: Float64Array.from(hpArr),
    maxHp,
    activations,
    exhaustedAtMeter,
  };
}

/** 冲线时刻线性插值 */
function interpolateFinish(ts: readonly number[], xs: readonly number[], distance: number): number | null {
  for (let i = xs.length - 1; i >= 1; i--) {
    const x0 = xs[i - 1]!;
    const x1 = xs[i]!;
    const t0 = ts[i - 1]!;
    const t1 = ts[i]!;
    if (x1 >= distance && x0 < distance) {
      const ratio = (distance - x0) / (x1 - x0);
      return t0 + (t1 - t0) * ratio;
    }
  }
  return null;
}
