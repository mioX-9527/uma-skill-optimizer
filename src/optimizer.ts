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

  let simsUsed = 0;
  const sim = (skills: readonly SkillConfig[], opts?: SimOptions): SimResult => {
    if (simsUsed >= maxSims) throw new Error(`模拟次数超过上限 ${maxSims}`);
    simsUsed++;
    return opts === undefined ? simulate(course, { ...runner, skills }) : simulate(course, { ...runner, skills }, opts);
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
      withSkills: [...preSkills, evolved ?? skill],
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
  // ◎ 的价格来自 BWIKI 的 SMW 技能消耗PT(data/skill-pt.json),抓不到的不提供,不猜价。
  {
    const seenIds = new Set(cands.map(c => c.id));
    for (const base of [...cands]) {
      const up = CIRCLE_UPGRADES.get(base.id);
      if (up === undefined || seenIds.has(up.upId)) continue;
      const upSkill = SKILL_INDEX.get(up.upId);
      if (upSkill === undefined) continue;
      seenIds.add(up.upId);
      cands.push({
        id: up.upId,
        skill: upSkill,
        pt: up.upPt,
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
  for (const c of cands) {
    if (c.state === 'blocked') continue;
    if (c.evoCands.length > 0) {
      // 多条进化方向:**逐个方向都算一遍**,取收益最高的当主方案,其余在结果里列出对比。
      // (进化是免费的,方向之间互斥 —— 只能变其中一种,所以这里取 max 而不是求和。)
      let best = c.evoCands[0]!;
      for (const dir of c.evoCands) {
        const sec = baseSim.finishTimeSec - simExpected([...c.preSkills, dir]).finishTimeSec;
        c.evoSecs.set(dir.id, sec);
        if (sec > (c.evoSecs.get(best.id) ?? -Infinity)) best = dir;
      }
      c.evolved = best;
      c.withSkills = [...c.preSkills, best];
      c.soloSec = c.evoSecs.get(best.id)!;
    } else {
      // 带前置的候选,单独买等于把前置一起买了,所以按 withSkills 算单项收益
      c.soloSec = baseSim.finishTimeSec - simExpected(c.withSkills).finishTimeSec;
    }
    // 进化前的对照值:只看这个技能本身,不含前置
    c.soloSecBefore = c.evolved === undefined
      ? c.soloSec
      : baseSim.finishTimeSec - simExpected([c.skill]).finishTimeSec;
    c.lastMarginal = c.soloSec;
  }
  for (const c of cands) {
    if (c.state === 'pool' && c.pt > budget) c.state = 'no-gain';
  }

  // 去重合并:前置技能可能已经被别的候选带进来了,同一技能在模拟里只能出现一次
  // 去重合并:前置技能可能已经被别的候选带进来了,同一技能在模拟里只能出现一次;
  // 另外单双圈占同一格,**买了 ◎ 之后 ○ 不再重复生效**(◎ 是升级版,同格替换不叠加)
  const combine = (...groups: readonly (readonly SkillConfig[])[]): SkillConfig[] => {
    const m = new Map<string, SkillConfig>();
    for (const g of groups) for (const s of g) m.set(s.id, s);
    for (const [upId, baseId] of CIRCLE_BASE) {
      if (m.has(upId) && m.has(baseId)) m.delete(baseId);
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

  greedyFill();

  // ── 交换局部搜索:换出已选、换入未选,收益提升则交换并回填预算 ────────
  const SWAP_ROUNDS = 10;
  const SWAP_POOL = 50;
  for (let round = 0; round < SWAP_ROUNDS; round++) {
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
        if (inCost > remaining() + a.pt) continue;
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
  spendDown();
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
    let best: { out: Cand; delta: number } | null = null;
    for (const a of outs) {
      const next = chosen.filter(x => x !== a);
      const nextIds = new Set(next.map(x => x.id));
      if (costOf(c, nextIds) > budget - totalSpent(next)) continue;   // 换了也装不下
      const t = simSearch(combine(skillsOf(next), c.withSkills)).finishTimeSec;
      const delta = finalSim.finishTimeSec - t;                        // 正 = 换完更快
      if (best === null || delta > best.delta) best = { out: a, delta };
    }
    if (best === null) return '换掉任何一项都装不下它(预算不够)';
    const d = best.delta * bodyPerSec;
    return d > 0
      ? `换掉「${best.out.skill.name}」就能换入它,总收益还能多 ${d.toFixed(2)} 马身`
      : `换掉「${best.out.skill.name}」换入它后总收益会少 ${Math.abs(d).toFixed(2)} 马身,所以不换`;
  };

  const rejected: RejectedSkill[] = [];
  const chosenSet = new Set(chosen.map(c => c.id));
  for (const c of cands) {
    if (c.state === 'chosen') continue;
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
      detail: c.blockedDetail ?? (prereqNote !== '' ? prereqNote : (healIdle !== '' ? healIdle : (reason === 'outbid' ? swapHintOf(c) : ''))),
      ...(c.evolved !== undefined ? { evolvesTo: c.evolved.name } : {}),
      ...(c.skill.prereq !== undefined && c.soloSec <= eps ? { soloUnavailable: true } : {}),
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
  if (simsUsed >= maxSims * 0.98) {
    notes.push(`已接近模拟次数上限(${simsUsed}/${maxSims}),搜索提前收敛;可用 --max-sims 提高上限获得更优解。`);
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
        finalMarginalBody: (finalMarginals.get(c.id) ?? 0) * bodyPerSec,
        finalMarginalSec: finalMarginals.get(c.id) ?? 0,
        ...(c.filler === true ? { filler: true } : {}),
        ...(c.skill.prereq !== undefined && c.soloSec <= eps ? { soloUnavailable: true } : {}),
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
