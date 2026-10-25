/** 比赛阶段:0=序盘 1=中盘 2=终盘 3=最终冲刺(末脚) */
export type PhaseId = 0 | 1 | 2 | 3;

/** 跑法:nige=逃 senko=先 sashi=差 oikomi=追 */
export type Tactic = 'nige' | 'senko' | 'sashi' | 'oikomi';

export type Aptitude = 'S' | 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G';

/** 干劲:绝好调~绝不调 */
export type Motivation = 'best' | 'good' | 'normal' | 'bad' | 'worst';

export interface Corner {
  readonly n: number;
  readonly start: number;
  readonly end: number;
}

export interface Slope {
  readonly start: number;
  readonly end: number;
  /** 坡度 %,下坡为负 */
  readonly gradient: number;
}

/** 直线段(弯道之间的路段);frontType:1=看台前(正面)直线、2=看台对面直线(触发代码 straight_front_type) */
export interface Straight {
  readonly start: number;
  readonly end: number;
  readonly frontType: number;
}

export interface Course {
  readonly id: string;
  readonly name: string;
  readonly venue: string;
  readonly distance: number;
  readonly surface: 'turf' | 'dirt';
  /** 距离档(数据层冗余,便于筛选) */
  readonly distanceType?: 'short' | 'mile' | 'mid' | 'long';
  readonly corners: readonly Corner[];
  readonly slopes: readonly Slope[];
  readonly straights?: readonly Straight[];
  /** 阶段分界(米);按 中盘=1/6、终盘=2/3、最终盘=5/6(解包公式) */
  readonly phaseBounds: {
    readonly midStart: number;
    readonly lateStart: number;
    readonly finalStart: number;
  };
  /** 基准速度 m/s = 20 − (距离−2000)/1000(解包公式);字段冗余便于核对 */
  readonly baseSpeed?: number;
  /** 赛道补正门槛属性(course_set_status),用于赛道补正公式 */
  readonly courseSetStatus?: readonly PassiveStat[];
}

export interface Stats {
  readonly speed: number;
  readonly stamina: number;
  readonly power: number;
  readonly guts: number;
  readonly wisdom: number;
}

export type SkillRarity =
  | 'normal'
  | 'rareEvolved'
  | 'evolved'
  | 'unique1'
  | 'unique2'
  | 'unique3'
  | 'unique4'
  | 'unique5'
  | 'unique6'
  /** 继承固有(900xxx):数值/时长与本体不同,等级固定,智力增幅系数恒 1.0 */
  | 'uniqueHeir';

/** 条件精度层级:精确 / 近似(依赖他马,UI 需角标) / 不支持 */
export type Precision = 'precise' | 'approx' | 'unsupported';

/** 绿技能被动的属性种类 */
export type PassiveStat = 'speed' | 'stamina' | 'power' | 'guts' | 'wisdom';

export type SkillEffect =
  | { readonly type: 'targetSpeed'; readonly value: number }
  | { readonly type: 'acceleration'; readonly value: number }
  | { readonly type: 'currentSpeed'; readonly value: number }
  | { readonly type: 'lastSpurtExtension'; readonly value: number }
  | { readonly type: 'heal'; readonly value: number }
  /** 绿技能前提值:不参与比赛过程,由配置侧折算进 greenBonus */
  | { readonly type: 'passive'; readonly stat: PassiveStat; readonly value: number }
  /** v0.1 无法建模的效果(妨害/视野/横向速度等),仅保留信息 */
  | { readonly type: 'unsupported'; readonly label: string; readonly value: number | null };

/** 距离/时间类条件的基准偏移 */
export type ConditionBase = 'start' | 'midStart' | 'lateStart' | 'finalStart';

/**
 * 发动条件。精确层来源为 BWIKI「模块:技能数据库内容」的游戏解包触发代码
 * (如 running_style==4&is_lastspurt==1&corner==0),区段类条件可附加
 * 行进距离百分比 / 剩余距离窗口(withinPct / withinLeftM)对区段做联合裁剪。
 */
interface RegionExtras {
  readonly withinPct?: readonly [number, number];
  readonly withinLeftM?: readonly [number, number];
  /** 处于末脚(最终冲刺)状态时才可发动(触发代码 is_lastspurt==1) */
  readonly spurt?: boolean;
}

export type SkillCondition =
  | { readonly kind: 'raceStart' }
  | ({ readonly kind: 'phase'; readonly phase: PhaseId; readonly part?: 'firstHalf' | 'laterHalf' | 'firstQuarter' } & RegionExtras)
  | { readonly kind: 'phaseAfter'; readonly phase: PhaseId }
  | ({ readonly kind: 'cornerN'; readonly n: number } & RegionExtras)
  | ({ readonly kind: 'cornerFastest'; readonly phaseFilter?: PhaseId; readonly spurt?: boolean } & RegionExtras)
  | ({ readonly kind: 'finalCorner'; readonly part?: 'laterHalf' } & RegionExtras)
  /** 最终弯道及往后(最终弯道起点直至终点) */
  | { readonly kind: 'finalCornerOnward' }
  | { readonly kind: 'thirdCornerFromEnd' }
  | { readonly kind: 'lateCorner' }
  | { readonly kind: 'midCorner' }
  | ({ readonly kind: 'finalStraight' } & RegionExtras)
  | ({ readonly kind: 'straightFastest'; readonly phaseFilter?: PhaseId; readonly spurt?: boolean } & RegionExtras)
  /** 看台对面的直线(触发代码 straight_front_type==2) */
  | ({ readonly kind: 'backStraight' } & RegionExtras)
  | { readonly kind: 'lateStraight' }
  | ({ readonly kind: 'uphillFastest'; readonly phaseFilter?: PhaseId; readonly spurt?: boolean } & RegionExtras)
  | ({ readonly kind: 'downhillFastest'; readonly phaseFilter?: PhaseId; readonly spurt?: boolean } & RegionExtras)
  /** 末脚(最终冲刺)期间:动态起点(体力预算解算,≥ 终盘分界),非固定 5/6 */
  | { readonly kind: 'lastSpurt' }
  | { readonly kind: 'distanceRun'; readonly meters: number; readonly base: ConditionBase }
  /** 剩余距离落在 [fromMeters, toMeters] 区间(点条件时 from === to) */
  | ({ readonly kind: 'distanceLeft'; readonly fromMeters: number; readonly toMeters: number } & RegionExtras)
  /** 行进距离百分比落在 [fromPct, toPct] 区间(触发代码 distance_rate) */
  | ({ readonly kind: 'distanceRate'; readonly fromPct: number; readonly toPct: number } & RegionExtras)
  | { readonly kind: 'elapsedSec'; readonly seconds: number; readonly base: ConditionBase }
  | { readonly kind: 'positionPct'; readonly pct: number };

export interface SkillConfig {
  readonly id: string;
  readonly name: string;
  readonly rarity: SkillRarity;
  readonly precision: Precision;
  readonly effects: readonly SkillEffect[];
  /** 效果持续时间(秒);null=瞬时(heal 等) */
  readonly durationSec: number | null;
  /**
   * 冷却时间(秒,基准值),来自解包 float_cooldown_time;运行期按 距离/1000 缩放
   * (实际冷却 = 基准 × 距离/1000,与持续时间同规则)。<400s 基准的技能允许同场再次发动
   * (如 弧线大师 基准 30s,东京2400 实际 72s);null=一次性技能(基准 500s)
   */
  readonly cooldownSec?: number | null;
  readonly condition: SkillCondition;
  /** 脚质/场地/赛场等装配型限制 */
  readonly restriction?: SkillRestriction;
  /** 是否受智力增幅(固有/レア) */
  readonly wisdomScaled: boolean;
  /**
   * 触发代码含 *_random(进弯道/阶段/直线后随机位置发动)→ 发动位置在满足区段内随机,
   * 消融时按位置采样求期望(见 analysis ablate);false/缺省 = 条件满足即发动,无需采样。
   */
  readonly randomPosition?: boolean;
}

/** 场地状态:0=良 1=稍重 2=重 3=不良(触发代码 ground_condition 1良~4不良,映射为代码−1) */
export type GroundCondition = 0 | 1 | 2 | 3;

/** 技能的脚质/场地/赛场等装配型限制(不满足则整场不发动) */
export interface SkillRestriction {
  /** 脚质(大逃并入逃马) */
  readonly tactics?: readonly Tactic[];
  readonly distanceTypes?: readonly ('short' | 'mile' | 'mid' | 'long')[];
  readonly surfaces?: readonly ('turf' | 'dirt')[];
  readonly venues?: readonly string[];
  readonly grounds?: readonly GroundCondition[];
  /** 精确比赛距离(米) */
  readonly distances?: readonly number[];
  /** 比赛距离范围(米,触发代码 course_distance>=/<=) */
  readonly distanceMin?: number;
  readonly distanceMax?: number;
  /** 原始限制文本(展示用) */
  readonly rawText?: string;
}

export interface RunnerConfig {
  readonly stats: Stats;
  /** 绿技能提供的前提值(不参与软上限/干劲,仅按面板口径加算) */
  readonly greenBonus: Readonly<Partial<Stats>>;
  readonly tactic: Tactic;
  readonly distanceAptitude: Aptitude;
  readonly surfaceAptitude: Aptitude;
  readonly motivation: Motivation;
  readonly groundCondition?: GroundCondition;
  /**
   * 赛道补正:'auto'(缺省)= 按赛道门槛属性(courseSetStatus)与五维计算:
   * 1 + 平均((1+floor(min(属性,901)/300.01))×0.05)(uma-skill-tools CourseHelpers.courseSpeedModifier;
   * 属性取 (面板+绿)×干劲);空门槛赛道 = 1.0。数字 = 手动覆盖(1.2 最大 / 1.0 标准)。
   * 补正只乘有效速度(终盘/末脚速度加成),不作用于力量/根性/耐力。
   */
  readonly courseFix?: number | 'auto';
  /** 前提:脚色充分(终盘起 3 秒加速度,面板力量;默认开) */
  readonly assumeAshiiro?: boolean;
  /** 前提:耐力对决(终盘起速度,参照耐力=面板×干劲;默认开) */
  readonly assumeStaminaFight?: boolean;
  /** 全开冲刺(面板速度≥2001 时末脚达速后额外速度渐增至 +1m/s;默认开) */
  readonly fullSpurtEnabled?: boolean;
  readonly skills: readonly SkillConfig[];
}

export interface Activation {
  readonly skillId: string;
  readonly name: string;
  readonly atSec: number;
  readonly atMeter: number;
  readonly precision: Precision;
}

export interface SimOptions {
  /**
   * 体力探针模式:体力可降至负值、不进入温存(用于计算"不温存跑完全程所需 HP",
   * 即 614tools 耐力计算器的温存回避线口径)。exhaustedAtMeter 仍记录首次归零位置。
   */
  readonly ignoreExhaustion?: boolean;
  /**
   * 消融位置采样用:强制技能首次发动位置(米)。跑到该位置即发动(跳过条件/动态判定,
   * 仍受装配限制约束);后续发动照常按冷却规则衔接。未指定的技能按条件规则发动。
   */
  readonly positionOverrides?: ReadonlyMap<string, number>;
}

export interface SimResult {
  /** 完赛时间(秒,冲线帧线性插值) */
  readonly finishTimeSec: number;
  /** 末脚目标速度(m/s,有效属性口径);马身差换算基准(614tools 口径) */
  readonly spurtTargetSpeed: number;
  /** 逐帧序列(下标对齐);用 Float64 保存体力等大数值的帧间精度 */
  readonly t: Float64Array;
  readonly x: Float64Array;
  readonly v: Float64Array;
  readonly hp: Float64Array;
  readonly maxHp: number;
  readonly activations: readonly Activation[];
  /** 体力归零(进入温存)的位置;未耗尽为 null */
  readonly exhaustedAtMeter: number | null;
}
