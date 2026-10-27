import { BODY_LENGTH_METERS, sampleableSpans, simulate, skillApplicable } from './engine/index.js';
import type { Course, Region, RestrictionClause, RunnerConfig, SimResult, SimOptions, SkillConfig, SkillRestriction, Tactic } from './engine/index.js';
import { CIRCLE_BASE, CIRCLE_UPGRADES, SKILLS, type SkillEntry } from './data.js';

const SKILL_INDEX = new Map(SKILLS.map(s => [s.id, s] as const));

/**
 * 区段随机取位技能(randomPosition)的期望口径采样点数。
 *
 * **为什么必须取期望**:这类技能(如「迅速果断」= 中盘随机位置发动)只模拟一次会落在
 * 规则取位的那个点上,而收益随位置变化很大——中盘前段 ~1.0 马身,临近终盘的尾部能到 2.3
 * (存速带进末脚加速段)。单点值系统性偏低约 45%,会把金技能排到下位白技能后面。
 * 参考实现(uma-race-sim `ablate.ts` 的 expectedBody)就是按满足区段均匀取点求均值,
 * 这里用同一口径:N 个等距分位点,取完赛时间差的均值。
 */
const RANDOM_POSITION_DRAWS = 12;

/** 第 i 个等距分位(i 从 0 起;/ N) */
const DRAWS: readonly number[] = Array.from(
  { length: RANDOM_POSITION_DRAWS },
  (_, i) => (i + 0.5) / RANDOM_POSITION_DRAWS,
);

/** 分位数 → 米(按区段长度加权的累计分布;与引擎 samplePositions 同法) */
function quantileToMeter(spans: readonly Region[], u: number): number {
  let target = u * spans.reduce((a, s) => a + (s[1] - s[0]), 0);
  for (const s of spans) {
    const len = s[1] - s[0];
    if (target <= len) return s[0] + target;
    target -= len;
  }
  return spans[spans.length - 1]![1];
}

/** 一名候选技能:技能库 id + 实际 PT 价格(游戏内显示价,含折扣) */
export interface CandidateSkill {
  readonly id: string;
  readonly pt: number;
  /**
   * 下位技能 id(前置技能)。**必须由调用方从游戏里读到的实际价格关系给出**。
   *
   * 为什么需要:列表里金技能显示的价格是「前置价 + 金技能自己的折后价」——
   * 买了前置之后金技能会抵扣掉那部分。实测(与 BWIKI 原始价吻合):
   *   先走一步！304 = 前置「游戏到此为止！」160 + 160×0.9
   *   巅峰之梦  320 = 前置「背负信念」200     + 200×0.6
   * 所以「金 304 + 前置 160 = 464」是高估,两者一起买只要 304。
   * 给出 requires 后:单独买金按 304 计(会自动带上前置),先买前置再买金按 304-160=144 计。
   */
  readonly requires?: string;
  /**
   * 进化后的技能 id(条件已达成时才有值)。
   * 进化是金技能**免费**变的,不额外花 PT,但效果不同(一般更强)。
   * 从游戏「技能进化」弹窗读到,见 app/evolve.py。
   */
  readonly evolvesTo?: string;
  /**
   * 其他进化方向(一个技能可能有多条进化路线,条件各自判断)。
   * 优化时**逐个方向都算一遍**,取收益最高的作为主方案,其余在结果里列出来对比。
   */
  readonly evolveAlternatives?: readonly string[];
}

export interface OptimizerInput {
  readonly course: Course;
  /** 马娘面板(skills 字段被忽略,由优化器按候选组合填充) */
  readonly runner: RunnerConfig;
  readonly candidates: readonly CandidateSkill[];
  /** PT 预算(硬约束) */
  readonly budget: number;
  /** 模拟次数上限(默认 30000;单次模拟 ~1.3ms,30000 次 ≈ 40s) */
  readonly maxSims?: number;
  /** 视为有效收益的最小时间差(秒),默认 0.0005s ≈ 0.003 马身 */
  readonly minImprovementSec?: number;
  readonly onProgress?: (line: string) => void;
  /**
   * 各精修阶段的开关。**纯增量**:不传时全部为 true,行为与历史版本逐字一致。
   * 只用于基准测试/回归:关掉某个阶段就能量化它对最终收益的实际贡献,
   * 避免"看起来有用"但从不验证的改动。
   */
  readonly stages?: OptimizerStages;
}

/** 阶段开关(见 OptimizerInput.stages) */
export interface OptimizerStages {
  /** 1 换 1 交换局部搜索(SWAP_ROUNDS 轮) */
  readonly swap?: boolean;
  /** 2 出 1 入邻域(两个已选换一个未选;1换1 与多换一都补不了这个方向) */
  readonly twoOutSwap?: boolean;
  /** 把剩余 PT 花完的收尾补选 */
  readonly spendDown?: boolean;
  /** 期望口径复核(12 点期望下的加入/换出) */
  readonly polish?: boolean;
  /** 多换一(N 个便宜技能换掉一个贵的) */
  readonly groupSwap?: boolean;
}

export interface ChosenSkill {
  readonly id: string;
  readonly name: string;
  /** 实付价。带前置且前置也买了 → 已扣掉前置那部分;否则含前置 */
  readonly pt: number;
  /** 该候选标价(列表上显示的那个数,含未买的前置) */
  readonly listPt: number;
  /** 会一并买下的下位技能名(没有则为空数组) */
  readonly includesPrereq: readonly string[];
  /** 单独购买时的马身收益(已按进化后的数值算) */
  readonly soloBody: number;
  /** 进化后的技能名;没进化/条件未达成为空 */
  readonly evolvesTo: string | null;
  /** 不进化时这个技能单独的收益,用于对照(未进化时等于 soloBody) */
  readonly soloBodyBefore: number;
  /**
   * 多条进化方向时的逐方向单项马身(按收益降序;第一条 = 主方案)。
   * 用户要求"全部列出来分别算收益",这里就是那个列表;只有一个方向时不给。
   */
  readonly evolveOptions?: readonly { id: string; name: string; soloBody: number }[];
  /** 在最终组合内的边际马身(leave-one-out 口径) */
  readonly finalMarginalBody: number;
  /** 在最终组合内的边际时间收益(秒) */
  readonly finalMarginalSec: number;
  /** 收尾凑数项:把剩余 PT 换掉的(边际约 0,不影响成绩,但 PT 不结转,留着也是浪费) */
  readonly filler?: boolean;
  /** 价格是按单圈折扣推算的(双圈 ◎ 看板上没有价),界面上标 ≈ */
  readonly ptInferred?: boolean;
  /** 性价比:集内边际马身 ÷ 实付 PT × 100(即"每 100pt 换多少马身"),用于跨技能横比 */
  readonly bodyPer100Pt: number;
  /** 这是双圈 ◎ 且单圈 ○ 也在候选里时,给出单圈名 —— 界面上显示「单圈 → 双圈」 */
  readonly circleFrom?: string;
  /**
   * 单独买不会发动(发动前提要先有别的技能发动过),所以**单独马身不成立**——
   * 界面上别显示 0.00(会被读成"没收益"),显示「—」,真实价值看「集内边际」。
   */
  readonly soloUnavailable?: boolean;
  /**
   * 需要说明的一句话(如:发动前提是「中盘已发动≥3个技能」,单看自己不发动、
   * 单独马身显示 0 但组合里生效)。没有要解释的就不给。
   */
  readonly note?: string;
}

export interface RejectedSkill {
  readonly id: string;
  readonly name: string;
  readonly pt: number;
  readonly soloBody: number;
  /**
   * unaffordable=超预算 inapplicable=本配置下买不了/不会生效(装配限制、效果未建模等,
   * 此时单独马身恒为 0,不代表技能无用) no-gain=能发动但组合内无正收益
   * outbid=收益为正但被更优组合挤出
   */
  readonly reason: 'unaffordable' | 'inapplicable' | 'no-gain' | 'outbid';
  /** 原因的具体说明(reason 为 inapplicable 时必填,如「仅限逃马」) */
  readonly detail: string;
  /** 进化后的技能名(有进化关系时才给,供名字列标注「→」) */
  readonly evolvesTo?: string | null;
  /** 单独买不会发动 → 单独马身无意义 */
  readonly soloUnavailable?: boolean;
  /** 价格是按单圈折扣推算的(双圈 ◎ 看板上没有价) */
  readonly ptInferred?: boolean;
  /** 双圈 ◎:单圈的名字(界面显示「单圈 → 双圈」) */
  readonly circleFrom?: string;
  /** 还差多少 PT 能上车(仅 outbid 时,预算用尽后有意义的字段) */
  readonly missingPt: number;
  readonly lastMarginalBody: number;
}

export interface OptimizerResult {
  /** 推荐购买清单(按购入顺序) */
  readonly chosen: readonly ChosenSkill[];
  readonly totalBody: number;
  readonly totalPt: number;
  readonly remainingPt: number;
  readonly baselineSec: number;
  readonly finalSec: number;
  /** 各单项马身收益之和(与 totalBody 的差 = 技能间交互,UI/输出需同时展示) */
  readonly sumSoloBody: number;
  readonly rejected: readonly RejectedSkill[];
  readonly simsUsed: number;
  readonly notes: readonly string[];
}

interface Cand {
  readonly id: string;
  readonly skill: SkillEntry;
  /** 显示价(未买前置时它包含前置的价) */
  pt: number;
  /** 买这个技能时会一并装入的技能:自己(+未买的前置)+ 择优后的进化形态 */
  withSkills: readonly SkillConfig[];
  /** 下位技能 id 列表(为空表示没有前置) */
  readonly requires: readonly string[];
  /** 下位技能的显示价之和:当前置已在组合里时,可抵扣掉这么多 */
  readonly requiresPt: number;
  /** 会一并装入的前置技能(可能为空) */
  readonly preSkills: readonly SkillConfig[];
  /** 进化后的技能(条件已达成时才有);模拟用它,PT 不变。多条方向时 = 择优结果 */
  evolved: SkillEntry | undefined;
  /** 所有进化方向;≥2 时逐个方向算单项收益再择优(用户要求全部列出来) */
  readonly evoCands: readonly SkillEntry[];
  /** 每个方向单独购买的时间收益(秒),key = 方向技能 id */
  readonly evoSecs: Map<string, number>;
  /** 未进化时的单项收益(秒),用来对照进化带来多少 */
  soloSecBefore: number;
  /** 单独购买时的时间收益(秒) */
  soloSec: number;
  /** 最近一次已知的时间边际(秒) */
  lastMarginal: number;
  state: 'pool' | 'chosen' | 'no-gain' | 'blocked';
  /** state==='blocked' 时的原因说明(装配限制/未建模等) */
  blockedDetail: string | null;
  /**
   * 单双圈链(○/◎ 占同一格):价格**不含**单圈价,单圈没买时要连它一起付
   * (游戏规则:点了单圈才能点双圈)。区别于金技能的「价格已含前置价」。
   */
  circleChain?: boolean;
  /** 单双圈链的单圈候选 id(circleChain 时必有) */
  baseId?: string;
  /** 收尾"花完预算"时装入的(边际约 0,只为不浪费 PT) */
  filler?: boolean;
  /** 价格是按单圈折扣推算的(双圈 ◎) */
  ptInferred?: boolean;
}

const DEFAULT_MAX_SIMS = 30000;
const DEFAULT_MIN_IMPROVEMENT_SEC = 0.0005;

const TACTIC_LABEL: Record<Tactic, string> = { nige: '逃马', senko: '先行', sashi: '差行', oikomi: '追马' };

/**
 * 把「发动前提」翻成人话。意义:**它会让单独马身显示 0**,不说清楚用户会以为技能没用
 * (实测:尾巴跃龙门 250pt 单独 0.00,但组合里因为中盘技能够 3 个而生效)。
 */
const COUNTER_LABEL: Record<string, string> = {
  all: '整场', start: '序盘', middle: '中盘', laterHalf: '后半程', endAfter: '终盘及之后',
  heal: '回复技能', green: '绿技能', heir: '继承技能',
};

function describePrereq(prereq: SkillConfig['prereq']): string {
  if (prereq === undefined) return '';
  const parts: string[] = [];
  for (const [key, req] of Object.entries(prereq.counters ?? {})) {
    const label = COUNTER_LABEL[key] ?? key;
    const min = req.min ?? 0;
    const max = req.max;
    if (max !== undefined && max === min) parts.push(`${label}恰好发动 ${min} 个技能`);
    else if (min > 0 && max !== undefined) parts.push(`${label}发动 ${min}~${max} 个技能`);
    else if (min > 0) parts.push(`${label}已发动 ≥${min} 个技能`);
  }
  if (prereq.requiresFirstBlock === true) parts.push('本技能第一段已发动');
  if ((prereq.usedSkillBaseIds ?? []).length > 0) parts.push('指定技能已发动过');
  if ((prereq.ownedSkillBaseIds ?? []).length > 0) parts.push('牌组内有指定技能');
  if (parts.length === 0) return '有发动前提';
  return `发动前提:${parts.join('、')}`;
}
const DISTANCE_LABEL: Record<string, string> = { short: '短距离', mile: '英里', mid: '中距离', long: '长距离' };
const SURFACE_LABEL: Record<string, string> = { turf: '草地', dirt: '泥地' };
const GROUND_LABEL = ['良', '稍重', '重', '不良'];
const WEATHER_LABEL = ['', '晴', '阴', '雨', '雪'];
const SEASON_LABEL = ['', '春', '夏', '秋', '冬', '樱花'];
const ROTATION_LABEL: Record<number, string> = { 1: '顺时针', 2: '逆时针' };
const STAT_LABEL: Record<string, string> = { speed: '速度', stamina: '耐力', power: '力量', guts: '根性', wisdom: '智力' };

/** 单条限制子句里不满足的项(仅供展示,判定以引擎 skillApplicable 为准) */
function describeClause(c: RestrictionClause, runner: RunnerConfig, course: Course): string[] {
  const parts: string[] = [];
  if (c.tactics !== undefined && !c.tactics.includes(runner.tactic)) {
    parts.push(`仅限${c.tactics.map(t => TACTIC_LABEL[t]).join('/')}`);
  }
  if (c.distanceTypes !== undefined) {
    const ok = course.distanceType !== undefined && c.distanceTypes.includes(course.distanceType);
    if (!ok) parts.push(`仅限${c.distanceTypes.map(d => DISTANCE_LABEL[d] ?? d).join('/')}`);
  }
  if (c.surfaces !== undefined && !c.surfaces.includes(course.surface)) {
    parts.push(`仅限${c.surfaces.map(s => SURFACE_LABEL[s] ?? s).join('/')}`);
  }
  if (c.venues !== undefined && !c.venues.includes(course.venue)) {
    parts.push(`仅限${c.venues.join('/')}赛场`);
  }
  if (c.grounds !== undefined && !c.grounds.includes(runner.groundCondition ?? 0)) {
    parts.push(`仅限${c.grounds.map(g => GROUND_LABEL[g] ?? String(g)).join('/')}场地`);
  }
  if (c.distances !== undefined && !c.distances.includes(course.distance)) {
    parts.push(`仅限 ${c.distances.join('/')}m`);
  }
  if (c.distanceMin !== undefined && course.distance < c.distanceMin) parts.push(`需 ≥${c.distanceMin}m`);
  if (c.distanceMax !== undefined && course.distance > c.distanceMax) parts.push(`需 ≤${c.distanceMax}m`);
  if (c.basisDistance !== undefined && (course.distance % 400 === 0) !== c.basisDistance) {
    parts.push(c.basisDistance ? '仅限标准距离(400 倍数)' : '仅限非标准距离');
  }
  if (c.rotations !== undefined && (course.rotation === undefined || !c.rotations.includes(course.rotation))) {
    parts.push(`仅限${c.rotations.map(r => ROTATION_LABEL[r] ?? `${r} 向`).join('/')}赛道`);
  }
  if (c.weathers !== undefined && !c.weathers.includes(runner.weather ?? 1)) {
    parts.push(`仅限${c.weathers.map(w => `${WEATHER_LABEL[w] ?? w}天`).join('/')}`);
  }
  if (c.seasons !== undefined && !c.seasons.includes(runner.season ?? 1)) {
    parts.push(`仅限${c.seasons.map(s => `${SEASON_LABEL[s] ?? s}季`).join('/')}`);
  }
  if (c.motivations !== undefined && !c.motivations.includes(runner.motivation)) {
    parts.push(`仅限特定干劲(${c.motivations.join('/')})`);
  }
  if (c.abroad !== undefined && (course.overseas === true) !== c.abroad) {
    parts.push(c.abroad ? '仅限海外赛场' : '仅限国内赛场');
  }
  if (c.statsAtLeast !== undefined) {
    for (const [k, v] of Object.entries(c.statsAtLeast)) {
      if (v !== undefined && runner.stats[k as keyof typeof runner.stats] < v) {
        parts.push(`${STAT_LABEL[k] ?? k}需 ≥${v}`);
      }
    }
  }
  if (c.statsBelow !== undefined) {
    for (const [k, v] of Object.entries(c.statsBelow)) {
      if (v !== undefined && runner.stats[k as keyof typeof runner.stats] >= v) {
        parts.push(`${STAT_LABEL[k] ?? k}需 <${v}`);
      }
    }
  }
  return parts;
}

/** 装配限制不满足时,说明是哪一条不满足;anyOf 多分支按「或」拼接 */
function describeRestriction(r: SkillRestriction, runner: RunnerConfig, course: Course): string {
  const clauses = r.anyOf ?? [r];
  const per = clauses.map(c => describeClause(c, runner, course).join('、')).filter(s => s !== '');
  if (r.anyOf !== undefined && per.length > 1) return per.map(s => `(${s})`).join(' 或 ');
  return per[0] ?? '';
}

function timeGain(before: SimResult, after: SimResult): number {
  return before.finishTimeSec - after.finishTimeSec;
}

/** 推荐购买组合:贪心(按 马身/PT 效率,装入后重算所有边际)+ 交换局部搜索 + 预算回填 */
export function optimize(input: OptimizerInput): OptimizerResult {
  const { course, runner, budget } = input;
  const maxSims = input.maxSims ?? DEFAULT_MAX_SIMS;
  const eps = input.minImprovementSec ?? DEFAULT_MIN_IMPROVEMENT_SEC;
  const notes: string[] = [];
  // 阶段开关缺省全部开启 —— 不传 stages 时代码路径与历史版本完全一致
  const stages = input.stages ?? {};
  const doSwap = stages.swap ?? true;
  const doTwoOut = stages.twoOutSwap ?? true;
  const doSpendDown = stages.spendDown ?? true;
  const doPolish = stages.polish ?? true;
  const doGroupSwap = stages.groupSwap ?? true;

  let simsUsed = 0;
  // 搜索共用一个「模拟预算」。超限不再 throw(审计 P4 / 优先级5:此前 maxSims 给小一点就整次
  // 求解失败,一个结果都拿不到),而是停掉剩余搜索阶段、用已找到的组合走完汇报。
  // 汇报本身只需 1+已选数 个组合,量很小,超限后放行(searchOpen=false)。
  let searchOpen = true;
  const simsExhausted = { sentinel: true };
  const sim = (skills: readonly SkillConfig[], opts?: SimOptions): SimResult => {
    if (simsUsed >= maxSims && searchOpen) {
      searchOpen = false;
      notes.push(`模拟次数达到上限(${maxSims}),搜索提前收敛,以下结果来自已找到的组合;可用 --max-sims 提高上限获得更优解。`);
      throw simsExhausted;
    }
    simsUsed++;
    return opts === undefined ? simulate(course, { ...runner, skills }) : simulate(course, { ...runner, skills }, opts);
  };

  /** 包一层:某个搜索阶段把模拟预算用完时,剩余阶段整体跳过(汇报不受影响) */
  const runStage = (fn: () => void): void => {
    if (!searchOpen) return;
    try {
      fn();
    } catch (e) {
      if (e === simsExhausted) return;
      throw e;
    }
  };

  /**
   * 汇报口径:**期望收益**。随机取位技能在满足区段上等距取 N 点,完赛时间取均值
   * (与 uma-race-sim `ablate.ts` 的 expectedBody 同一口径)。只用于「显示给用户的数」,
   * 因为每次要多跑 N 遍,放进搜索循环会把耗时翻 N 倍。
   */
  const spanCache = new Map<string, readonly Region[] | null>();
  const spansOf = (s: SkillConfig): readonly Region[] | null => {
    let v = spanCache.get(s.id);
    if (v === undefined) {
      v = s.randomPosition === true ? sampleableSpans(s.condition, course) : null;
      spanCache.set(s.id, v);
    }
    return v;
  };
  /** 随机技能的「代表位置」= 区段中点;搜索口径用,单次模拟即可 */
  const midCache = new Map<string, number>();
  const midOf = (s: SkillConfig): number => {
    let v = midCache.get(s.id);
    if (v === undefined) {
      v = quantileToMeter(spansOf(s)!, 0.5);
      midCache.set(s.id, v);
    }
    return v;
  };
  const anyRandom = (skills: readonly SkillConfig[]): boolean => skills.some(s => spansOf(s) !== null);

  const simExpected = (skills: readonly SkillConfig[]): SimResult => {
    if (!anyRandom(skills)) return sim(skills);
    const randoms = skills.filter(s => spansOf(s) !== null);
    let sumSec = 0;
    let last: SimResult | null = null;
    for (const u of DRAWS) {
      const ov = new Map(randoms.map(s => [s.id, quantileToMeter(spansOf(s)!, u)] as const));
      last = sim(skills, { positionOverrides: ov });
      sumSec += last.finishTimeSec;
    }
    return { ...last!, finishTimeSec: sumSec / DRAWS.length };
  };

  /**
   * 搜索口径:随机技能固定在区段中点发动。
   *
   * 为什么不能沿用引擎的默认取位:默认取位是「一进入区段就发动」(如迅速果断落在 417m,
   * 中盘刚起点),对收益没有代表性——实测同一条赛道 0.62 马身,而区段中点 1.04、
   * 全程期望 1.11。用它排序会把所有随机取位技能系统性压低约 45%,
   * 金技能会被下位白技能挤掉。中点单点值与期望的偏差只剩「尾部存速」那一小块(~7%),
   * 排序够用,且只要 1 次模拟。
   */
  const simSearch = (skills: readonly SkillConfig[]): SimResult => {
    if (!anyRandom(skills)) return sim(skills);
    const ov = new Map(skills.filter(s => spansOf(s) !== null).map(s => [s.id, midOf(s)] as const));
    return sim(skills, { positionOverrides: ov });
  };

  // ── 候选解析:去重、查库、绿技能提示 ────────────────────────────────
  const seen = new Set<string>();
  for (const c of input.candidates) {
    if (seen.has(c.id)) throw new Error(`候选技能重复: ${c.id}`);
    seen.add(c.id);
  }
  const unknown = input.candidates.filter(c => !SKILL_INDEX.has(c.id));
  if (unknown.length > 0) {
    throw new Error(`技能库中不存在这些 id: ${unknown.map(c => c.id).join(', ')}`);
  }
  const cands: Cand[] = input.candidates.map(c => {
    const skill = SKILL_INDEX.get(c.id)!;
    // 前置技能必须在候选池里:不在就说明它已经买过(或买不到),此时显示价里不含前置,不能抵扣
    const pre = c.requires !== undefined ? SKILL_INDEX.get(c.requires) : undefined;
    const preListed = c.requires !== undefined && seen.has(c.requires) && pre !== undefined;
    const prePt = preListed
      ? (input.candidates.find(x => x.id === c.requires)?.pt ?? 0)
      : 0;
    // 条件已达成 → 结束养成时会免费进化,模拟应该用进化后的数值。
    // 多条进化路线时这里的 evolved 先放"第一个",真正的择优在算完单项收益后做。
    const evoIds = [
      ...(c.evolvesTo !== undefined ? [c.evolvesTo] : []),
      ...(c.evolveAlternatives ?? []),
    ].filter((id, i, a) => a.indexOf(id) === i);
    const evoCands = evoIds.map(id => SKILL_INDEX.get(id)).filter((s): s is SkillEntry => s !== undefined);
    const evolved = evoCands[0];
    const preSkills: readonly SkillConfig[] = preListed ? [pre!] : [];
    return {
      id: c.id,
      skill,
      pt: c.pt,
      // 买了金技能后,下位白的效果被金**替换**(0.15×3 → 0.35×3),不是叠加。
      // 游戏内实测口径(用户 2026-10-27):买金的总支出 = 白价 + 金价,换来的是
      // 「一个 0.35×3 的技能」,白的 0.15×3 不再单独生效。与 ○/◎ 同构。
      // 所以模拟里只装金自己;若组合里同时选了白,由 combine() 把白删掉。
      withSkills: [evolved ?? skill],
      requires: preListed ? [c.requires!] : [],
      requiresPt: prePt,
      preSkills,
      evolved,
      evoCands,
      evoSecs: new Map(),
      soloSec: 0,
      soloSecBefore: 0,
      lastMarginal: 0,
      state: 'pool' as const,
      blockedDetail: null,
    };
  });

  // ── 单双圈:○ 和 ◎ 占同一格,买完 ○ 同一格变成 ◎(再买一次,价格另付)──
  // 列表里只会显示「当前可买的那一级」,所以 ○ 在候选里时要把 ◎ 补出来,
  // 否则单圈的收益永远只是半截(用户:单双圈的马身收益要分开写)。
  //
  // ◎ 的价格:游戏里看不到,但**同格共用一个折扣**(用户 2026-10-26 指出)。
  // 所以用你号上 ○ 的实际价格反推折扣率,再套到 ◎ 的 BWIKI 基准价上:
  //   ◎实价 = round(◎基准价 × ○实价 / ○基准价)
  // 例:顺时针○ 基准 90、你号 81(9折)→ 顺时针◎ 基准 110 → 99。
  // 基准价或实价缺失、折扣率离谱(OCR 读错)时回落到基准价。
  {
    const seenIds = new Set(cands.map(c => c.id));
    for (const base of [...cands]) {
      const up = CIRCLE_UPGRADES.get(base.id);
      if (up === undefined || seenIds.has(up.upId)) continue;
      const upSkill = SKILL_INDEX.get(up.upId);
      if (upSkill === undefined) continue;
      seenIds.add(up.upId);
      const ratio = up.basePt > 0 ? base.pt / up.basePt : 1;
      const sane = ratio >= 0.4 && ratio <= 1.05;          // 折扣只可能更低;超出必是 OCR 读错
      if (!sane) {
        // 审计 P8:此前只是静默回落基准价,OCR 读错时用户毫不知情——
        // 而 ○ 的价格读偏 ±40pt 就能让推荐组合变化(±0.245 马身),必须让人去核对。
        notes.push(
          `「${up.upName}」的价格是按单圈折扣推算的,但推算数据异常` +
          `(「${base.skill.name}」实付 ${base.pt}pt / 基准 ${up.basePt}pt = ${ratio.toFixed(2)},` +
          `合理区间 0.40~1.05),已改按基准价 ${up.upPt}pt 计 —— 请核对单圈的实际价格是否读对。`,
        );
      }
      const upPt = sane ? Math.max(1, Math.round(up.upPt * ratio)) : up.upPt;
      cands.push({
        id: up.upId,
        skill: upSkill,
        pt: upPt,
        withSkills: [upSkill],          // ◎ 是 ○ 的升级版(同格替换),效果只算 ◎ 不叠加
        requires: [base.id],
        requiresPt: 0,                  // 价格不含单圈价,靠 circleChain 分开计费
        preSkills: [],
        evolved: undefined,
        evoCands: [],
        evoSecs: new Map(),
        soloSec: 0,
        soloSecBefore: 0,
        lastMarginal: 0,
        state: 'pool' as const,
        blockedDetail: null,
        circleChain: true,
        baseId: base.id,
        ptInferred: sane && Math.abs(ratio - 1) > 1e-9,
      });
    }
  }

  /** 这个候选当前的实付价:前置已在组合里 → 只付差额;否则要连前置一起付 */
  const costOf = (c: Cand, chosenIds: ReadonlySet<string>): number => {
    const prereqChosen = c.requires.length > 0 && c.requires.every(r => chosenIds.has(r));
    if (c.circleChain === true) {
      // ◎:价格不含 ○。○ 还没买 → 要连 ○ 的实付价一起(点了单圈才能点双圈)
      const base = c.baseId !== undefined ? cands.find(x => x.id === c.baseId) : undefined;
      return c.pt + (prereqChosen || base === undefined ? 0 : costOf(base, chosenIds));
    }
    return prereqChosen ? Math.max(0, c.pt - c.requiresPt) : c.pt;
  };

  // ── 剔除"本配置下根本不会生效"的候选:这类技能模拟收益恒为 0,
  //    若按 no-gain 汇报会被误读成"技能没用",实际是限制不满足或效果未建模
  //
  //    绿技能(常时被动,condition=raceStart 且全 passive)自上游 0.8 起由引擎
  //    `effstats.passiveBonusOf` 并入起跑属性参与模拟,**属于正常候选**,不在此剔除;
  //    但两条例外仍要被剔除:① 数据层标 unsupported 的条件型被动(依赖名次/人数,
  //    剔除以免按"无条件加成"高估);② 带发动前提(prereq)的被动——引擎本身也已跳过。
  for (const c of cands) {
    const allPassive = c.skill.effects.length > 0 && c.skill.effects.every(e => e.type === 'passive');
    const greenLike = allPassive && c.skill.condition.kind === 'raceStart' && c.skill.prereq === undefined;
    const restriction = c.skill.restriction;
    const blocked =
      c.skill.precision === 'unsupported'
        ? allPassive ? '条件型被动(依赖名次/人数等),数据层未建模' : '效果类型未建模,引擎不计入'
      : allPassive && !greenLike
        ? '非常时被动(非起跑加成/带发动前提),引擎不计入起跑属性'
      : restriction !== undefined && !skillApplicable(c.skill, course, runner)
        ? describeRestriction(restriction, runner, course)
      : null;
    if (blocked !== null) {
      c.state = 'blocked';
      c.blockedDetail = blocked === '' ? '装配限制不满足' : blocked;
    }
  }

  // ── 基准与单项收益(已标注 blocked 的候选不参与模拟:其收益按定义恒为 0) ──
  const baseSim = sim([]);
  runStage(() => {
    for (const c of cands) {
      if (c.state === 'blocked') continue;
      if (c.evoCands.length > 0) {
        // 多条进化方向:**逐个方向都算一遍**,取收益最高的当主方案,其余在结果里列出对比。
        // (进化是免费的,方向之间互斥 —— 只能变其中一种,所以这里取 max 而不是求和。)
        let best = c.evoCands[0]!;
        for (const dir of c.evoCands) {
          const sec = baseSim.finishTimeSec - simExpected([dir]).finishTimeSec;
          c.evoSecs.set(dir.id, sec);
          if (sec > (c.evoSecs.get(best.id) ?? -Infinity)) best = dir;
        }
        c.evolved = best;
        c.withSkills = [best];
        c.soloSec = c.evoSecs.get(best.id)!;
      } else {
        // 单独买金 = 连下位白一起买下,但白的效果被金替换掉 —— 收益只算金自己那一份。
        // (价格仍然是"白价+金价"的总和,由 costOf/totalSpent 保证,与顺序无关。)
        c.soloSec = baseSim.finishTimeSec - simExpected(c.withSkills).finishTimeSec;
      }
      // 进化前的对照值:只看这个技能本身,不含前置
      c.soloSecBefore = c.evolved === undefined
        ? c.soloSec
        : baseSim.finishTimeSec - simExpected([c.skill]).finishTimeSec;
      c.lastMarginal = c.soloSec;
    }
  });
  // 双圈 ◎ 的"对照值"取单圈 ○ 的单项收益 —— 这样界面上能显示「单圈 0.29 → 双圈 0.43」,
  // 一眼看清双圈是**完整效果**还是**增量**。集内边际那列才是增量(◎−○)。
  for (const c of cands) {
    if (c.circleChain !== true || c.baseId === undefined) continue;
    const base = cands.find(x => x.id === c.baseId);
    if (base !== undefined && base.state !== 'blocked') c.soloSecBefore = base.soloSec;
  }
  for (const c of cands) {
    if (c.state === 'pool' && c.pt > budget) c.state = 'no-gain';
  }

  // 去重合并:前置技能可能已经被别的候选带进来了,同一技能在模拟里只能出现一次;
  // 另外单双圈占同一格,**买了 ◎ 之后 ○ 不再重复生效**(◎ 是升级版,同格替换不叠加)
  const combine = (...groups: readonly (readonly SkillConfig[])[]): SkillConfig[] => {
    const m = new Map<string, SkillConfig>();
    for (const g of groups) for (const s of g) m.set(s.id, s);
    // 单双圈:◎ 顶掉 ○
    for (const [upId, baseId] of CIRCLE_BASE) {
      if (m.has(upId) && m.has(baseId)) m.delete(baseId);
    }
    // 金技能顶掉它的下位白:与 ○/◎ 同构的"升级替换"关系。
    // 少了这一步,组合里同时选了金和白时,白那 0.15×3 会被当成额外收益算进去。
    for (const c of cands) {
      const baseId = c.requires.length === 1 ? c.requires[0]! : undefined;
      if (baseId !== undefined && m.has(c.id) && m.has(baseId)) m.delete(baseId);
    }
    return [...m.values()];
  };
  const skillsOf = (cs: readonly Cand[]): SkillConfig[] => combine(...cs.map(c => c.withSkills));
  const chosen: Cand[] = [];
  let spent = 0;
  const remaining = () => budget - spent;
  const pool = () => cands.filter(c => c.state === 'pool');
  const chosenIds = () => new Set(chosen.map(c => c.id));
  const costIn = (c: Cand) => costOf(c, chosenIds());

  /**
   * 一组技能的实际总价。
   * 每个技能的 pt 已含前置价;若前置也在组里,那部分只该收一次,所以扣掉。
   * (与选择顺序无关:先买前置再买金 = 先买金自动带前置,总价相同)
   */
  const totalSpent = (cs: readonly Cand[]): number => {
    const ids = new Set(cs.map(c => c.id));
    return cs.reduce((sum, c) => {
      const prereqChosen = c.requires.length > 0 && c.requires.every(r => ids.has(r));
      if (c.circleChain === true) {
        // ◎:价格不含 ○。○ 不在本组合里 → 要把它的实付价一起算(否则预算会虚低)
        const base = c.baseId !== undefined ? cands.find(x => x.id === c.baseId) : undefined;
        return sum + c.pt + (prereqChosen || base === undefined ? 0 : costOf(base, ids));
      }
      return sum + (prereqChosen ? Math.max(0, c.pt - c.requiresPt) : c.pt);
    }, 0);
  };

  /** 贪心装入:每轮重算全部在池候选的边际,选 边际/PT 效率 最高者 */
  const greedyFill = () => {
    for (;;) {
      const feasible = pool().filter(c => costIn(c) <= remaining());
      if (feasible.length === 0) return;
      const cur = simSearch(skillsOf(chosen));
      let best: { cand: Cand; gain: number; ratio: number } | null = null;
      for (const c of feasible) {
        const gain = timeGain(cur, simSearch(combine(skillsOf(chosen), c.withSkills)));
        c.lastMarginal = gain;
        if (gain <= eps) continue;
        const cost = costIn(c);
        // 前置已付清且差额为 0 → 白送,优先级最高
        const ratio = cost > 0 ? gain / cost : Number.POSITIVE_INFINITY;
        if (best === null || ratio > best.ratio) best = { cand: c, gain, ratio };
      }
      if (best === null) {
        for (const c of feasible) if (c.lastMarginal <= eps) c.state = 'no-gain';
        return;
      }
      best.cand.state = 'chosen';
      chosen.push(best.cand);
      spent = totalSpent(chosen);
    }
  };

  runStage(() => greedyFill());

  // ── 交换局部搜索:换出已选、换入未选,收益提升则交换并回填预算 ────────
  const SWAP_ROUNDS = 10;
  const SWAP_POOL = 50;
  runStage(() => {
    for (let round = 0; round < (doSwap ? SWAP_ROUNDS : 0); round++) {
      if (chosen.length === 0 || pool().length === 0) break;
      // 换入候选只看最近边际靠前的一批(池太大时剪枝)
      const insertCands = pool()
        .slice()
        .sort((a, b) => b.lastMarginal - a.lastMarginal)
        .slice(0, SWAP_POOL);
      const cur = simSearch(skillsOf(chosen));
      let best: { out: Cand; in: Cand; gain: number } | null = null;
      for (const b of insertCands) {
        for (const a of chosen) {
          const next = chosen.filter(x => x !== a);
          const nextIds = new Set(next.map(x => x.id));
          const inCost = costOf(b, nextIds);
          // 预算必须**按换完之后的真实总额**判:换出 a 不只腾出它的价,还可能让别的技能变贵
          // (换掉前置白会让金技能涨回全额),用 `remaining() + a.pt` 会高估可用预算
          // —— 实测出现 2533 预算花出 2595 的超支。
          if (totalSpent(next) + inCost > budget) continue;
          const gain = timeGain(cur, simSearch(combine(skillsOf(next), b.withSkills)));
          if (gain > eps && (best === null || gain > best.gain)) best = { out: a, in: b, gain };
        }
      }
      if (best === null) break;
      chosen.splice(chosen.indexOf(best.out), 1, best.in);
      best.out.state = 'pool';
      best.in.state = 'chosen';
      best.out.lastMarginal = 0;
      spent = totalSpent(chosen);
      greedyFill();
    }
  });

  // ── 花完剩余预算:PT **不结转**,留着就是纯浪费 ──────────────────
  // 主搜索只装"边际 > 阈值(约 0.003 马身)"的技能,收尾常剩几十上百 PT。
  // 两轮清掉:① 先装边际为正但没到阈值的(有收益,只是小);
  //          ② 再装边际 ≈0 的(不影响成绩,纯粹把 PT 换掉)。
  // 负收益的一律不要 —— 那会真的变慢(如自带速度惩罚的回复技能)。
  const spendDown = () => {
    for (const allowZero of [false, true]) {
      for (;;) {
        const feasible = pool().filter(c => costIn(c) <= remaining());
        if (feasible.length === 0) break;
        const cur = simSearch(skillsOf(chosen));
        let best: { cand: Cand; gain: number } | null = null;
        for (const c of feasible) {
          const gain = timeGain(cur, simSearch(combine(skillsOf(chosen), c.withSkills)));
          c.lastMarginal = gain;
          if (gain < -eps) continue;
          if (!allowZero && gain <= eps) continue;
          if (best === null || gain > best.gain) best = { cand: c, gain };
        }
        if (best === null) break;
        best.cand.state = 'chosen';
        best.cand.filler = true;
        chosen.push(best.cand);
        spent = totalSpent(chosen);
      }
    }
  };
  runStage(() => {
    if (doSpendDown) spendDown();
  });

  // ── 2 出 1 入:两个已选换一个未选(审计 P1)───────────────────────
  // 1换1 与「多换一」的方向都是"换出更少、换入更多",补不了反向:当两个凑数技能
  // 各自的边际都不高、但占着预算时,只有"两个一起让位给一个更优的"能跳出。
  // **必须在 spendDown 之后**:凑数项(○/小边际白)是 spendDown 才装进来的,
  // 排在它前面时换出对根本还不在组合里(plan_v2 实测踩过)。
  //
  // 全枚举(每对换出 × 每个换入 × 1 次模拟)在真实规模(组合 ~13 项、池 ~30)要
  // 上千次模拟,放不进管线;而且只用口径 S 还会漏掉「S 口径不显正、期望口径为正」
  // 的移动(plan_v2 实测「良场地○+标准距离○ → 一线胜机」+0.042 马身,只有期望口径
  // 看得见)。所以分两段:
  //   ① 期望口径有界复核:换出对 = A 口径 leave-one-out **最弱 3 项**的两两组合
  //     (plan_v2 的改进对恰好在其中;报告口径本来就要算这组边际),换入 = 可行池里
  //     solo 前 8 —— 规模有界(≈3×8×12 次模拟,与池大小无关);
  //   ② 口径 S 兜底扫一遍:① 限制的换出对之外也可能有改进,用
  //     proxy = solo(换入) − marg(换出a) − marg(换出b) 剪枝后逐个 1 次模拟。
  //     proxy 是"忽略交互的上界估计",剪掉的是"换入的单独收益还不够抵两个换出的
  //     边际"这类几乎必然无改进的组合;协同项偶尔漏过就漏过(与改前一样看不见)。
  // 轮数 = 1:第 2 轮起在 plan_v2 / plan_final / plan_evo2 上 0 兑现,却要多付 ~550 次模拟
  // (实测 tools/bench/two-out-cost.ts:rounds=3 时 1799 次 / 8.4s,rounds=1 时 1244 次 / 5.7s,
  //  三份 plan 的最终收益与组合**逐字相同**)。等出现"一次移动后又能再移一次"的实例再加。
  const TWO_OUT_ROUNDS = 1;
  const TWO_OUT_WEAK = 3;
  const TWO_OUT_INS = 8;
  const TWO_OUT_PROXY_SLACK = 0.02;   // 秒;容忍交互估算误差(口径 S↔A 单组合差最大 ~0.02s)
  let twoOutMoves = 0;
  runStage(() => {
    // 换入池**绕过 greedyFill 的永久 no-gain 剔除**:那是相对"当时的组合"判的,
    // 换掉两项之后组合变了,被剔的技能可能重新变优(plan_v2 实测:一线胜机在
    // 贪心阶段被剔,而 2换1 的最优移动恰恰是把它换进来 —— 审计 R1 的活案例)。
    // 预算可行性由每个移动自己判,不需要提前剔除。用函数而非快照:换出的两项
    // 每轮回池后也要能被再次换入。
    const widePool = () => cands.filter(c => c.state !== 'chosen' && c.state !== 'blocked');
    for (let round = 0; round < (doTwoOut ? TWO_OUT_ROUNDS : 0); round++) {
      if (chosen.length < 2 || widePool().length === 0) break;
      type Move = { outs: [Cand, Cand]; in: Cand; gain: number };
      const applyMove = (m: Move): void => {
        for (const o of m.outs) {
          chosen.splice(chosen.indexOf(o), 1);
          o.state = 'pool';
          o.lastMarginal = 0;
        }
        m.in.state = 'chosen';
        m.in.filler = false;
        chosen.push(m.in);
        spent = totalSpent(chosen);
        twoOutMoves++;
        // 注意:**这里不能跑 greedyFill 回填**。本阶段的移动是期望口径(A)确认过的,
        // 而 greedyFill 按搜索口径(S)装填,S 认为正收益的项在 A 口径下可能是负的
        // —— 实测 plan_v2 上 A 确认的 +0.042 马身被 S 回填吃掉一半以上。
        // 腾出的预算交给后面的 polish(A 口径)去补选/校正。
      };

      // ① 期望口径有界复核:最弱 3 项的两两组合 × solo 前 8 的可行换入
      // (marg = t(去掉它) − t(现在),正值 = 贡献;升序取最弱)
      const curA = simExpected(skillsOf(chosen));
      const weakOuts = chosen
        .map(c => ({ c, marg: simExpected(skillsOf(chosen.filter(x => x !== c))).finishTimeSec - curA.finishTimeSec }))
        .sort((a, b) => a.marg - b.marg)
        .slice(0, TWO_OUT_WEAK)
        .map(w => w.c);
      const insBySolo = widePool()
        .slice()
        .sort((a, b) => b.soloSec - a.soloSec)
        .slice(0, TWO_OUT_INS);
      let bestA: Move | null = null;
      for (let x = 0; x < weakOuts.length; x++) {
        for (let y = x + 1; y < weakOuts.length; y++) {
          const a = weakOuts[x]!;
          const b = weakOuts[y]!;
          const next = chosen.filter(c => c !== a && c !== b);
          const nextIds = new Set(next.map(c => c.id));
          const restSpent = totalSpent(next);
          for (const c of insBySolo) {
            // 与 1换1 同法:按换完之后的真实总额判预算
            if (restSpent + costOf(c, nextIds) > budget) continue;
            const gain = timeGain(curA, simExpected(combine(skillsOf(next), c.withSkills)));
            if (gain > eps && (bestA === null || gain > bestA.gain)) bestA = { outs: [a, b], in: c, gain };
          }
        }
      }
      if (bestA !== null) {
        applyMove(bestA);
        continue;
      }

      // ② 口径 S 兜底:全池枚举,proxy 剪枝(sMarg 同上,正值 = 贡献)
      const curS = simSearch(skillsOf(chosen));
      const sMarg = new Map<string, number>();
      for (const a of chosen) {
        sMarg.set(a.id, simSearch(skillsOf(chosen.filter(x => x !== a))).finishTimeSec - curS.finishTimeSec);
      }
      let bestS: Move | null = null;
      for (let x = 0; x < chosen.length; x++) {
        for (let y = x + 1; y < chosen.length; y++) {
          const a = chosen[x]!;
          const b = chosen[y]!;
          const next = chosen.filter(c => c !== a && c !== b);
          const nextIds = new Set(next.map(c => c.id));
          const restSpent = totalSpent(next);
          for (const c of widePool()) {
            if (restSpent + costOf(c, nextIds) > budget) continue;
            // proxy 剪枝:换入的 solo 收益连两个换出的边际都抵不上 → 几乎必然无改进
            const proxy = c.soloSec - (sMarg.get(a.id) ?? 0) - (sMarg.get(b.id) ?? 0);
            if (proxy <= -TWO_OUT_PROXY_SLACK) continue;
            const gain = timeGain(curS, simSearch(combine(skillsOf(next), c.withSkills)));
            if (gain > eps && (bestS === null || gain > bestS.gain)) bestS = { outs: [a, b], in: c, gain };
          }
        }
      }
      if (bestS === null) break;
      // 期望口径确认后才落子:S 口径为正的移动在 A 口径下可能是负的
      // (plan_v2 实测:S 段把 A 段刚拿到的 +0.042 马身吃掉了一半以上)
      const restS = chosen.filter(x => x !== bestS.outs[0] && x !== bestS.outs[1]);
      const curS2 = simExpected(skillsOf(chosen));
      const tS2 = simExpected(combine(skillsOf(restS), bestS.in.withSkills)).finishTimeSec;
      if (curS2.finishTimeSec - tS2 <= eps) break;
      applyMove(bestS);
    }
  });
  if (twoOutMoves > 0) {
    notes.push(`做了 ${twoOutMoves} 次「2换1」调整:两个已选技能让位给一个更优的候选(1换1/多换一 都补不了这个方向)。`);
  }

  // ── 期望口径复核(把"猜"清掉)────────────────────────────────────
  // 搜索阶段为了速度,对随机取位技能用**区段中点单点**估计(simSearch,1 次模拟);
  // 而展示给用户的每个马身都是 simExpected(12 点期望)。两套口径可能给出不同结论 ——
  // 这里用**期望口径**对最终组合再核一遍:加入 / 换出,真变快才动。
  // 用户明确要求:马身必须是模拟出来的,不能是估算。
  let polishMoves = 0;
  runStage(() => {
    for (let round = 0; round < (doPolish ? 2 : 0); round++) {
    const cur = simExpected(skillsOf(chosen));
    const outs = chosen.slice().sort((a, b) => a.lastMarginal - b.lastMarginal).slice(0, 2);
    const ins = pool().slice().sort((a, b) => b.lastMarginal - a.lastMarginal).slice(0, 6);
    let best: { out: Cand | null; into: Cand; delta: number } | null = null;
    for (const into of ins) {
      if (costIn(into) <= remaining()) {
        const t = simExpected(combine(skillsOf(chosen), into.withSkills)).finishTimeSec;
        const delta = cur.finishTimeSec - t;
        if (delta > eps && (best === null || delta > best.delta)) best = { out: null, into, delta };
      }
      for (const a of outs) {
        const next = chosen.filter(x => x !== a);
        const nextIds = new Set(next.map(x => x.id));
        if (costOf(into, nextIds) > budget - totalSpent(next)) continue;
        const t = simExpected(combine(skillsOf(next), into.withSkills)).finishTimeSec;
        const delta = cur.finishTimeSec - t;
        if (delta > eps && (best === null || delta > best.delta)) best = { out: a, into, delta };
      }
    }
    if (best === null) break;
    if (best.out !== null) {
      chosen.splice(chosen.indexOf(best.out), 1);
      best.out.state = 'pool';
      best.out.lastMarginal = 0;
    }
    best.into.state = 'chosen';
    best.into.filler = false;
    chosen.push(best.into);
    spent = totalSpent(chosen);
    polishMoves++;
    }
  });
  // ── 多换一:**N 个便宜技能换掉一个贵的**(用户 2026-10-26:白打折高、金打折低时,
  //    可能三个白 ≈ 一个金)。贪心按 马身/PT 排序,天然不会主动"拆金成三个白",
  //    这里补一次:枚举「换出 1 项 × 换入 1~3 项」。
  //    审计 P2:全走期望口径时每个组合 12 次模拟,真实规模吃了 ~240 次(约 1/5)却
  //    13 个实例 0 兑现。改为**口径 S 预筛**(1 次/组合)、只对筛出的最优者用
  //    期望口径确认 —— 真变快才动,成本降一个量级,能力保留。
  let groupMoves = 0;
  runStage(() => {
    for (let round = 0; round < (doGroupSwap ? 2 : 0); round++) {
      const curS = simSearch(skillsOf(chosen));
      const weakest = chosen.slice().sort((a, b) => a.lastMarginal - b.lastMarginal).slice(0, 2);
      const priciest = chosen.slice().sort((a, b) => costOf(b, chosenIds()) - costOf(a, chosenIds()))[0];
      const outs = [...new Set([...weakest, ...(priciest !== undefined ? [priciest] : [])])];
      const ins = pool().slice().sort((a, b) => b.lastMarginal - a.lastMarginal).slice(0, 5);
      const subsets: Cand[][] = [];
      for (let i = 0; i < ins.length; i++) {
        subsets.push([ins[i]!]);
        for (let j = i + 1; j < ins.length; j++) {
          subsets.push([ins[i]!, ins[j]!]);
          for (let k = j + 1; k < ins.length; k++) subsets.push([ins[i]!, ins[j]!, ins[k]!]);
        }
      }
      let best: { out: Cand; group: Cand[]; sGain: number } | null = null;
      for (const a of outs) {
        const rest = chosen.filter(x => x !== a);
        for (const group of subsets) {
          const set = [...rest, ...group];
          if (totalSpent(set) > budget) continue;
          const sGain = timeGain(curS, simSearch(combine(skillsOf(rest), ...group.map(g => g.withSkills))));
          if (sGain > eps && (best === null || sGain > best.sGain)) best = { out: a, group, sGain };
        }
      }
      if (best === null) break;
      // 期望口径确认:筛出来的最优移动要真变快才落子(搜索口径可能有 ~7% 偏差)
      const rest = chosen.filter(x => x !== best.out);
      const curA = simExpected(skillsOf(chosen));
      const tA = simExpected(combine(skillsOf(rest), ...best.group.map(g => g.withSkills))).finishTimeSec;
      if (curA.finishTimeSec - tA <= eps) break;
      chosen.splice(chosen.indexOf(best.out), 1);
      best.out.state = 'pool';
      best.out.lastMarginal = 0;
      for (const g of best.group) {
        g.state = 'chosen';
        g.filler = false;
        chosen.push(g);
      }
      spent = totalSpent(chosen);
      groupMoves++;
    }
  });
  if (groupMoves > 0) {
    notes.push(
      `做了 ${groupMoves} 次「多换一」调整:用 1~3 个更便宜的技能替换掉更贵的一项(搜索口径预筛、期望口径确认后落子)。`,
    );
  }
  const fillerCount = chosen.filter(c => c.filler === true).length;

  // ── 汇报:最终组合的 leave-one-out 边际 + 未上车技能分类 ────────────
  const finalSim = simExpected(skillsOf(chosen));
  const bodyPerSec = finalSim.spurtTargetSpeed / BODY_LENGTH_METERS;
  const finalMarginals = new Map<string, number>();
  for (const a of chosen) {
    const t = simExpected(skillsOf(chosen.filter(x => x !== a))).finishTimeSec;
    finalMarginals.set(a.id, t - finalSim.finishTimeSec);
  }
  /** 多方向时的逐方向单项马身,按收益降序(只有一个方向时不给,免得刷屏) */
  const evolveOptionsOf = (c: Cand) =>
    c.evoCands.length > 1
      ? [...c.evoSecs.entries()]
          .map(([id, sec]) => ({ id, name: SKILL_INDEX.get(id)?.name ?? id, soloBody: sec * bodyPerSec }))
          .sort((a, b) => b.soloBody - a.soloBody)
      : undefined;

  /**
   * 「被挤出」到底值不值得换?用户最常问的就是这个:
   * "为什么不买这个更便宜、单独马身更高的?"
   * → 直接算一遍"换掉最弱的 N 项试试",把结论写成一句话。
   * 只对 reason==='outbid' 的候选算,且只看最弱的几项(限制模拟次数)。
   */
  const swapHintOf = (c: Cand): string => {
    // 顺序很关键:先看"换掉它腾出的 PT 够不够",不够的换了也白换。
    // 差多少 PT 才装得下 → 只有价格 ≥ 这个数的已选项才可能换得进来。
    const need = costOf(c, chosenSet) - remaining();
    const byMarginal = chosen.slice().sort(
      (a, b) => (finalMarginals.get(a.id) ?? 0) - (finalMarginals.get(b.id) ?? 0),
    );
    const outs = [
      ...byMarginal.filter(a => costOf(a, new Set(chosen.filter(x => x !== a).map(x => x.id))) >= need),
      ...byMarginal,
    ].slice(0, 12);
    // 审计 P2 / 优先级3:此前 1换1 用搜索口径、2换1 用期望口径,都和 finalSim(期望口径)直接
    // 相减 —— 两口径单组合差平均 0.04、最大 0.196 马身,用户看到的建议可能失真。
    // 统一为:**口径 S 筛出最优移动(1 次/组合,顺带把 2换1 的开销从 36×12 降下来),
    // 再用期望口径确认这一个移动**,显示的数字与 finalSim 同口径。
    const curS = simSearch(skillsOf(chosen));
    let bestS: { out: Cand; with?: Cand; sGain: number } | null = null;
    for (const a of outs) {
      const next = chosen.filter(x => x !== a);
      const nextIds = new Set(next.map(x => x.id));
      if (costOf(c, nextIds) > budget - totalSpent(next)) continue;   // 换了也装不下
      const sGain = curS.finishTimeSec - simSearch(combine(skillsOf(next), c.withSkills)).finishTimeSec;
      if (bestS === null || sGain > bestS.sGain) bestS = { out: a, sGain };
    }
    // 2 换 1:用户常问「追击+十万火急 换掉内侧体验行不行」——单独看每一项都被挤掉,
    // 但两项合起来可能更划算。这里顺带试一次(搭档只取池里边际最高的 3 个)。
    const partners = pool().filter(x => x.id !== c.id).slice(0, 3);
    for (const d of partners) {
      for (const a of outs) {
        const next = chosen.filter(x => x !== a);
        const nextIds = new Set(next.map(x => x.id));
        const cost = costOf(c, nextIds) + costOf(d, new Set([...nextIds, c.id]));
        if (totalSpent(next) + cost > budget) continue;
        const sGain = curS.finishTimeSec
          - simSearch(combine(skillsOf(next), c.withSkills, d.withSkills)).finishTimeSec;
        if (bestS === null || sGain > bestS.sGain) bestS = { out: a, with: d, sGain };
      }
    }
    if (bestS === null) return '换掉任何一项都装不下它(预算不够)';
    // 期望口径确认:显示给用户的差值必须与 finalSim 同口径
    const next = chosen.filter(x => x !== bestS.out);
    const t = simExpected(
      bestS.with === undefined
        ? combine(skillsOf(next), c.withSkills)
        : combine(skillsOf(next), c.withSkills, bestS.with.withSkills),
    ).finishTimeSec;
    const delta = finalSim.finishTimeSec - t;                          // 正 = 换完更快
    const d = delta * bodyPerSec;
    const outName = bestS.with !== undefined
      ? `「${bestS.out.skill.name}」换成「${c.skill.name}+${bestS.with.skill.name}」`
      : `「${bestS.out.skill.name}」换成它`;
    return d > 0
      ? `${outName},总收益还能多 ${d.toFixed(2)} 马身`
      : `${outName},总收益会少 ${Math.abs(d).toFixed(2)} 马身,所以不换`;
  };

  const rejected: RejectedSkill[] = [];
  const chosenSet = new Set(chosen.map(c => c.id));
  // 换出建议要做 1换1 + 2换1 的模拟,很贵 —— 只给"边际最高"的前 8 项算,其余给结论性文案
  const hintIds = new Set(
    cands
      .filter(c => c.state !== 'chosen')
      .sort((a, b) => b.lastMarginal - a.lastMarginal)
      .slice(0, 8)
      .map(c => c.id),
  );
  // 「已经买到手的技能」:已选技能本身 + 它自带的前置白 + 双圈所需的单圈。
  // 买金技能 = 连下位白一起买了(价格里已经含了),所以那个白**不能再出现在「未购买」里**
  // —— 用户 2026-10-26 直接指出这一点。
  const ownedIds = new Set<string>();
  for (const c of chosen) {
    for (const sk of c.withSkills) ownedIds.add(sk.id);
    for (const r of c.requires) ownedIds.add(r);
  }
  let impliedCount = 0;
  for (const c of cands) {
    if (c.state === 'chosen') continue;
    if (ownedIds.has(c.id)) { impliedCount++; continue; }   // 已随别的技能一起买了

    const reason: RejectedSkill['reason'] =
      c.state === 'blocked' ? 'inapplicable'
      : c.pt > budget ? 'unaffordable'
      : c.lastMarginal <= eps ? 'no-gain'
      : 'outbid';
    // 能发动但没收益的回体技能:多半是本组合体力没跑空(体力有富余时回复无价值),不是技能本身无用
    const healIdle =
      reason === 'no-gain' &&
      finalSim.exhaustedAtMeter === null &&
      c.skill.effects.some(e => e.type === 'heal') &&
      c.skill.effects.every(e => e.type === 'heal' || e.type === 'passive')
        ? '本组合体力未耗尽,回复类技能无额外收益'
        : '';
    // 发动前提没满足时单独模拟恒为 0:必须解释,否则"单独马身 0"会被读成"这技能没用"
    const prereqNote =
      c.blockedDetail === null && c.soloSec <= eps && c.skill.prereq !== undefined
        ? `${describePrereq(c.skill.prereq)}。单独买不会发动,所以「单独马身」不适用;组合里满足前提后按「集内边际」计`
        : '';
    rejected.push({
      id: c.id,
      name: c.skill.name,
      pt: costOf(c, chosenSet),
      soloBody: c.soloSec * bodyPerSec,
      reason,
      detail: c.blockedDetail ?? (prereqNote !== '' ? prereqNote : (healIdle !== '' ? healIdle : (reason === 'outbid' && hintIds.has(c.id) ? swapHintOf(c) : ''))),
      ...(c.evolved !== undefined ? { evolvesTo: c.evolved.name } : {}),
      ...(c.skill.prereq !== undefined && c.soloSec <= eps ? { soloUnavailable: true } : {}),
      ...(c.ptInferred === true ? { ptInferred: true } : {}),
      ...(c.circleChain === true && c.baseId !== undefined && SKILL_INDEX.get(c.baseId) !== undefined
        ? { circleFrom: SKILL_INDEX.get(c.baseId)!.name }
        : {}),
      missingPt: Math.max(0, costOf(c, chosenSet) - remaining()),
      lastMarginalBody: c.lastMarginal * bodyPerSec,
    });
  }
  rejected.sort((a, b) => b.lastMarginalBody - a.lastMarginalBody);

  const budgetLimited = rejected.some(r => r.reason === 'outbid' && r.missingPt > 0);
  if (budgetLimited) {
    notes.push(`预算用尽:上表中「差PT」列 = 再充多少 PT 可让该技能上车(按当前组合的边际收益排序)。`);
  }
  const greenChosen = chosen.filter(c => c.skill.effects.length > 0 && c.skill.effects.every(e => e.type === 'passive'));
  if (greenChosen.length > 0) {
    notes.push(
      `绿技能(常时被动)没有"发动位置",收益来自起跑属性加成;属性要过软上限(1200)与干劲,` +
      `面板越高同类加成越挤,所以第二个同类绿技能的边际通常明显低于第一个。`,
    );
  }
  // 真撞上限时 sim() 的哨兵已经写过一条更明确的 note,这里只报"差点撞到"的情形
  if (searchOpen && simsUsed >= maxSims * 0.98) {
    notes.push(`已接近模拟次数上限(${simsUsed}/${maxSims}),搜索提前收敛;可用 --max-sims 提高上限获得更优解。`);
  }
  if (impliedCount > 0) {
    notes.push(
      `另有 ${impliedCount} 项技能**已随金技能/双圈一起买到**(价格里已含),所以不在「未购买」里单列。`,
    );
  }
  {
    const kind = (r: string) => (r === 'normal' ? '白' : r.startsWith('unique') ? '继承' : '金');
    const tally = new Map<string, { n: number; pt: number }>();
    for (const c of chosen) {
      const k = kind(c.skill.rarity);
      const t = tally.get(k) ?? { n: 0, pt: 0 };
      tally.set(k, { n: t.n + 1, pt: t.pt + costOf(c, chosenSet) });
    }
    const parts = [...tally.entries()].map(([k, v]) => `${k} ${v.n} 项 / ${v.pt}pt`);
    if (parts.length > 1) {
      notes.push(`买入构成:${parts.join('、')} —— 白技能是独立候选,金技能的价格已含它的下位白;` +
        `要不要为了金多花那部分 PT,按「马身/100pt」横比即可。`);
    }
  }
  if (polishMoves > 0) {
    notes.push(
      `搜索阶段用「区段中点」快速估计,收尾又按 12 点期望复核了一遍:据此调整了 ${polishMoves} 处` +
      `(上表所有马身都是模拟值,不是公式估算)。`,
    );
  }
  if (fillerCount > 0) {
    notes.push(
      `已把剩余 PT 尽量花完:其中 ${fillerCount} 项是「凑数」技能(边际≈0,不改变成绩)——` +
      `PT 不结转,留着等于白扔,所以标了 ⓘ 的那些照买即可。`,
    );
  }
  if (remaining() > 0) {
    notes.push(
      `还剩 ${remaining()} PT:未选技能最便宜的一档也买不起了(或买了会变慢,如自带速度惩罚的回复技能)。`,
    );
  }

  // 金技能的下位白同样会被「顶掉」(和 ○/◎ 同构):它自己在终局里边际为 0,
  // 但买它的钱不是白花 —— 那是点金技能的前置。不说清楚会被读成"怎么买了个没用的技能"
  // (用户 2026-10-27 就照着列表问了「下位白为什么也在推荐购买里」)。
  // 注意只认「金已在组合里」的情况;白单独被选(没点金)时它能自己贡献收益,不需要这段话。
  const goldReplacer = new Map<string, string>();   // 下位白 id → 顶掉它的金技能名
  for (const g of chosen) {
    if (g.circleChain === true || g.skill.rarity !== 'rareEvolved') continue;
    for (const r of g.requires) if (!goldReplacer.has(r)) goldReplacer.set(r, g.skill.name);
  }

  return {
    chosen: chosen.map(c => {
      // 前置也被选了 → 那部分只收一次,所以这里显示差额
      const prereqPaid = c.requires.length > 0 && c.requires.every(r => chosenSet.has(r));
      return {
        id: c.id,
        name: c.skill.name,
        pt: prereqPaid ? Math.max(0, c.pt - c.requiresPt) : c.pt,
        listPt: c.pt,
        includesPrereq: c.requires
          .map(r => SKILL_INDEX.get(r)?.name)
          .filter((n): n is string => n !== undefined),
        soloBody: c.soloSec * bodyPerSec,
        evolvesTo: c.evolved?.name ?? null,
        soloBodyBefore: c.soloSecBefore * bodyPerSec,
        ...(evolveOptionsOf(c) !== undefined ? { evolveOptions: evolveOptionsOf(c) } : {}),
        ...(c.skill.prereq !== undefined && c.soloSec <= eps
          ? { note: `${describePrereq(c.skill.prereq)}。单独买不会发动 → 单独马身记「—」,真实价值看「集内边际」` }
          : {}),
        // 单圈自己边际为 0 是因为双圈顶掉了它 —— 但买它正是为了能点双圈,别让人以为白买了
        ...(() => {
          const up = CIRCLE_UPGRADES.get(c.id);
          if (up === undefined || !chosenSet.has(up.upId) || finalMarginals.get(c.id) === undefined) return {};
          if ((finalMarginals.get(c.id) ?? 0) * bodyPerSec > eps) return {};
          return { note: `买它是为了点「${up.upName}」——双圈顶掉单圈后,它自己的边际为 0 是正常的` };
        })(),
        // 金技能顶掉下位白:同一套解释,只是换成了"升级替换"关系
        ...(() => {
          const upName = goldReplacer.get(c.id);
          if (upName === undefined || finalMarginals.get(c.id) === undefined) return {};
          if ((finalMarginals.get(c.id) ?? 0) * bodyPerSec > eps) return {};
          return {
            note: `买它是为了点「${upName}」——金技能顶掉下位白,它自己的边际为 0 是正常的;` +
              `这 ${Math.max(0, c.pt - c.requiresPt)}pt 不是白花,是点金技能绕不开的前置` +
              `(「${upName}」那一行显示的就是扣掉它之后的差额)`,
          };
        })(),
        finalMarginalBody: (finalMarginals.get(c.id) ?? 0) * bodyPerSec,
        finalMarginalSec: finalMarginals.get(c.id) ?? 0,
        ...(c.filler === true ? { filler: true } : {}),
        ...(c.ptInferred === true ? { ptInferred: true } : {}),
        ...(c.circleChain === true && c.baseId !== undefined && SKILL_INDEX.get(c.baseId) !== undefined
          ? { circleFrom: SKILL_INDEX.get(c.baseId)!.name }
          : {}),
        bodyPer100Pt: costOf(c, chosenSet) > 0
          ? ((finalMarginals.get(c.id) ?? 0) * bodyPerSec) / costOf(c, chosenSet) * 100
          : 0,
        ...(c.skill.prereq !== undefined && c.soloSec <= eps ? { soloUnavailable: true } : {}),
      ...(c.ptInferred === true ? { ptInferred: true } : {}),
      };
    }),
    totalBody: (baseSim.finishTimeSec - finalSim.finishTimeSec) * bodyPerSec,
    totalPt: spent,
    remainingPt: remaining(),
    baselineSec: baseSim.finishTimeSec,
    finalSec: finalSim.finishTimeSec,
    sumSoloBody: cands.reduce((acc, c) => acc + c.soloSec * bodyPerSec, 0),
    rejected,
    simsUsed,
    notes,
  };
}
