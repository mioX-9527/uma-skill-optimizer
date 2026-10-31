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
  /** 海外赛场(触发代码 is_abroad:隆尚/圣安妮塔公园/德尔马) */
  readonly overseas?: boolean;
  /**
   * 交流重赏赛场(触发代码 is_dirtgrade):地方竞马场(大井/川崎/船桥/盛冈)只办交流重赏,
   * 因此这一条**由赛场确定**,不是临场条件。海外泥地(圣安妮塔公园/德尔马)不属于交流重赏。
   */
  readonly dirtGrade?: boolean;
  /**
   * 赛场回转方向:1=顺时针(中山/京都/阪神/札幌/函馆/福岛/小仓/大井/隆尚),
   * 2=逆时针(东京/中京/新潟/川崎/船桥/盛冈/圣安妮塔公园/德尔马);
   * 直線赛道(新潟草1000m)无回转,缺省 → 回转方向类技能一律不生效。
   * 来源:game course_data.json 的 turn 字段(1=右/2=左/4=直線),与 JRA 官方口径一致。
   */
  readonly rotation?: 1 | 2;
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

/** 一次技能发动记录(供 prereq 计数器与「需已发动某技能」判定) */
export interface FiredSkill {
  readonly skillId: string;
  /** 发动时所处阶段 */
  readonly phase: PhaseId;
  /** 发动位置(米) */
  readonly meter: number;
  /** 是否为回复(耐力恢复)技能 */
  readonly heal: boolean;
}

/** 前提判定上下文 */
export interface PrereqContext {
  readonly course: Course;
  readonly runner: RunnerConfig;
  /** 本技能基础 id(去掉 -b1/-b2 后缀),用于 requiresFirstBlock */
  readonly baseId: string;
  /** 已发动技能(同一帧内先于本技能发动的也计入) */
  readonly fired: readonly FiredSkill[];
}

/** 技能发动计数器的种类(触发代码 activate_count_* / is_activate_* 的判定对象) */
export type ActivationCounter =
  /** activate_count_all:已发动技能总数 */
  | 'all'
  /** activate_count_start:序盘(phase 0)发动的技能数 */
  | 'start'
  /** activate_count_middle:中盘(phase 1)发动的技能数 */
  | 'middle'
  /** activate_count_later_half:比赛后半段(行进 ≥50%)发动的技能数 */
  | 'laterHalf'
  /** activate_count_end_after:终盘及之后(phase ≥2)发动的技能数 */
  | 'endAfter'
  /** activate_count_heal / is_activate_heal_skill:发动的回复技能数 */
  | 'heal'
  /** activate_count_param_skill:生效的绿技能(被动参数技能)数 */
  | 'green'
  /** succession_skill_count:继承技能数 */
  | 'heir';

/** 单个计数器约束(值域闭区间;== 时 min=max) */
export interface CounterReq {
  readonly min?: number;
  readonly max?: number;
}

/**
 * 技能发动前提(触发代码里依赖「自身技能发动史 / 持有技能」的条件)。
 * 与 restriction 的区别:restriction 是赛道与比赛环境的静态适配(装配限制),
 * 这里是在比赛过程中才能满足的前置状态 —— 不满足时该技能不发动,而不是整场判为不适用。
 */
export interface SkillPrereq {
  /** 计数器约束,字段间为「与」 */
  readonly counters?: Readonly<Partial<Record<ActivationCounter, CounterReq>>>;
  /** 需要已发动过的技能(触发代码 is_used_skill_id==X;按基础 id 匹配,忽略 -b1/-b2) */
  readonly usedSkillBaseIds?: readonly string[];
  /** 需要已选入牌组的技能(触发代码 is_exist_skill_id==X) */
  readonly ownedSkillBaseIds?: readonly string[];
  /** 需要本技能第一段效果已发动(触发代码 is_activate_other_skill_detail==1,即 -b2 依赖 -b1) */
  readonly requiresFirstBlock?: boolean;
  /** 多分支:任一前提满足即可(@ 变体之间为「或」) */
  readonly anyOf?: readonly SkillPrereq[];
}

/**
 * 绿技能发动数分档(如 小林历奇固有 时来运转，龙腾九霄):效果随「当前生效的绿技能数」分档。
 * 数据来源为 BWIKI 技能页备注(解包为单行满档值,无分档编码),由 clean-skills 写入。
 */
export interface ScaleByGreen {
  /** 不随绿技能数变化的固定效果 */
  readonly base: readonly SkillEffect[];
  /** 分档:[min, max] 含端点(max 省略=∞)→ 档位效果(叠加在 base 上);未落入任何档 = 仅 base */
  readonly tiers: readonly { readonly min: number; readonly max?: number; readonly effects: readonly SkillEffect[] }[];
}

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
  /**
   * 发动前提(已发动技能数/已发动回复技能数/需已发动的具体技能等)。
   * 见 ActivationCounter;不满足则该次不发动(不是"不适用")。
   */
  readonly prereq?: SkillPrereq;
  /** 是否受智力增幅(固有/レア) */
  readonly wisdomScaled: boolean;
  /**
   * 触发代码含 *_random(进弯道/阶段/直线后随机位置发动)→ 发动位置在满足区段内随机,
   * 消融时按位置采样求期望(见 analysis ablate);false/缺省 = 条件满足即发动,无需采样。
   */
  readonly randomPosition?: boolean;
  /** 绿技能发动数分档:simulate 开头按当前生效绿技能数展开成普通 effects(见 ScaleByGreen) */
  readonly scaleByGreen?: ScaleByGreen;
}

/** 场地状态:0=良 1=稍重 2=重 3=不良(触发代码 ground_condition 1良~4不良,映射为代码−1) */
export type GroundCondition = 0 | 1 | 2 | 3;

/** 天气:1=晴 2=阴 3=雨 4=雪(触发代码 weather==N;仅作技能条件,不进物理公式) */
export type Weather = 1 | 2 | 3 | 4;

/** 季节:1=春 2=夏 3=秋 4=冬 5=樱花(触发代码 season==N;仅作技能条件,不进物理公式) */
export type Season = 1 | 2 | 3 | 4 | 5;

/**
 * 单条限制子句(全部字段为「与」关系:都满足才成立)。
 * 触发代码里同一支(& 连接)的多条限定都落在这里。
 */
export interface RestrictionClause {
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
  /**
   * 是否为「标准距离」赛道(触发代码 is_basis_distance==1/0)。
   * 游戏定义:赛程全长是 **400 米的整数倍** ⇒ 标准距离(如 1200/1600/2000/2400/3200);
   * 否则为非标准距离(如 1400/1800/2200/2500)。注意它**不是距离档**(短/英里/中/长),
   * 2500 属长距离但非 400 倍数,1600 属英里但是 400 倍数。
   */
  readonly basisDistance?: boolean;
  /** 赛场回转方向(触发代码 rotation==N:1=顺时针,2=逆时针;直線赛道不匹配) */
  readonly rotations?: readonly number[];
  /** 天气(触发代码 weather==N:1晴/2阴/3雨/4雪) */
  readonly weathers?: readonly Weather[];
  /** 季节(触发代码 season==N:1春/2夏/3秋/4冬/5樱花) */
  readonly seasons?: readonly Season[];
  /** 干劲(触发代码 motivation==N/>=N/<=N:1绝不调~5绝好调) */
  readonly motivations?: readonly Motivation[];
  /** 是否为海外赛场(触发代码 is_abroad==0/1) */
  readonly abroad?: boolean;
  /**
   * 是否为交流重赏(触发代码 is_dirtgrade==1/!=1)。
   * 与枠番/人气不同,它**能由赛场确定**:地方竞马场(大井/川崎/船桥/盛冈)办的泥地重赏即交流重赏
   * (ダートグレード競走),JRA 十场与海外赛场都不是。
   */
  readonly dirtGrade?: boolean;
  /** 面板属性下限(含,触发代码 base_speed>=N 等;取面板值,不含绿技能与干劲) */
  readonly statsAtLeast?: Readonly<Partial<Record<PassiveStat, number>>>;
  /** 面板属性上限(不含,触发代码 base_wiz<N 等) */
  readonly statsBelow?: Readonly<Partial<Record<PassiveStat, number>>>;
  /**
   * **临场条件**(触发代码里的 post_number/publicity/random_lot 等,原始 token 形式)。
   * 这些条件由开赛时的实际情况决定(闸位、人气、抽选、赛事等级、比赛时段),**无法由赛道、
   * 跑法或环境配置确定** ⇒ 引擎不做猜测:默认视为「不满足」,技能整场不生效、绿技能不计入起跑属性。
   * 语义上是「不能保证 100% 发动,所以不计收益」,不是「一定不发动」;UI 用「临场条件」标注。
   * 例:幸运7(`random_lot==50&post_number==7`)、擅长外道◎(`post_number>=6`)。
   */
  readonly undetermined?: readonly string[];
  /** 原始限制文本(展示用) */
  readonly rawText?: string;
}

/**
 * 技能的脚质/场地/赛场等装配型限制(不满足则整场不发动;绿技能则不计入起跑属性)。
 * 单子句时直接用本层字段;触发代码存在多分支(@ 变体或 condition_1/condition_2)时
 * 用 `anyOf` 表示「任一支满足即生效」——分支之间是 OR,不能压成一层并集,
 * 否则「A 分支限短距离、B 分支不限」会被错压成「限短距离」。
 */
export interface SkillRestriction extends RestrictionClause {
  /** 多分支子句:任一满足即生效;缺省 = 使用本层扁平字段 */
  readonly anyOf?: readonly RestrictionClause[];
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
  /** 天气(技能条件;缺省 1=晴) */
  readonly weather?: Weather;
  /** 季节(技能条件;缺省 1=春) */
  readonly season?: Season;
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
  /**
   * 消融「只去掉效果、保留发动」:这些技能照常判定条件/前提并记入发动史(供其他技能的
   * prereq 计数),但不施加任何效果(不改速度/体力/属性)。用于把单项收益从「前置连带」里
   * 剥出来 —— 否则 3 个回复技能各自都会背上「大招因此不发动」的收益,重复计账。
   */
  readonly inertSkills?: ReadonlySet<string>;
  /**
   * 消融「逐次发动拆分」:只去掉该技能**第 i 次发动**(0 基序号)的效果,其余各次照常生效。
   * 该次仍记入发动史(前提计数)与 activations,只是不施加效果。
   * 用于带冷却、同场多次发动的技能(如 先走一步！ 开赛10s + 冷却30s):
   * 总量是「去掉整条技能」,逐次量是「只去掉这一次」—— 两者可对照,看哪一次在挣钱。
   */
  readonly inertFirings?: ReadonlyMap<string, ReadonlySet<number>>;
}

export interface SimResult {
  /** 完赛时间(秒,冲线帧线性插值) */
  readonly finishTimeSec: number;
  /** 末脚目标速度(m/s,有效属性口径);马身差换算基准(614tools 口径) */
  readonly spurtTargetSpeed: number;
  /**
   * 末脚(最终冲刺)起点:位置(米)。体力充足时 = 终盘分界,体力不足时由 HP 预算解算推迟;
   * null = 全程未进入末脚(极端体力不足)。**「存速」的判定基准**:
   * 进入末脚的瞬时速度由中盘速度技能抬高,这段速度会被带进终盘加速段(不需要"还回去")。
   */
  readonly spurtStartMeter: number | null;
  /** 末脚起点时刻(秒);判定技能在进入末脚时是否仍生效(存速) */
  readonly spurtStartSec: number | null;
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
