import type { Aptitude, GroundCondition, Motivation, Season, Stats, Tactic, Weather } from '../../src/engine/index.js';
import { COURSES, SKILLS, type SkillEntry } from '../../src/data.js';
import { normalizeName } from '../../src/lookup.js';
import basePt from '../../src/base-pt.json';
import type { OptimizerResult } from '../../src/optimizer.js';

export type { OptimizerResult };

export interface PlanSkill {
  readonly id: string;
  readonly name: string;
  readonly pt: number;
  readonly rarity: string;
  readonly precision: string;
  /**
   * 进化后的技能 id(从模拟器读「进化 ⓘ」得到,条件达成才有)。
   * 进化是金技能**免费**变的,所以不额外占 PT 也不单独出现在候选里 ——
   * 不带上这个,优化器只会按进化前的数值算,用户就会问"为什么还是只有迅速果断"。
   */
  readonly evolvesTo?: string;
  /** 其他进化方向(一个技能可能有多条);优化器逐个算收益再择优 */
  readonly evolveAlternatives?: readonly string[];
}

/** 下位技能关系:skillId 的列表价已包含 prereqId 的价格 */
export interface PlanChain {
  readonly skillId: string;
  readonly prereqId: string;
}

/**
 * 「买金就送下位」的覆盖关系。
 *
 * 与 `PlanChain` 的区别:链是**直接**前置(参与价格抵扣),这条是沿链传递闭包后的
 * 覆盖关系(只用于把下位从推荐里去掉)。三级链 `良场地○ → 良场地◎ → 良场地恶煞`
 * 中间那级不在可买列表里,所以链配不上,必须靠这个才能认出恶煞覆盖了良场地○。
 */
export interface PlanSupersede {
  readonly gold: string;
  readonly lower: string;
}

export interface PlanState {
  readonly courseId: string;
  readonly budget: number;
  readonly stats: Stats;
  readonly tactic: Tactic;
  readonly distanceAptitude: Aptitude;
  readonly surfaceAptitude: Aptitude;
  readonly motivation: Motivation;
  /** 场地状态(进体力消耗;也用于「良场地◎」类技能判定) */
  readonly groundCondition: GroundCondition;
  /** 天气(仅用于技能条件判定) */
  readonly weather: Weather;
  /** 季节(仅用于技能条件判定) */
  readonly season: Season;
  readonly skills: readonly PlanSkill[];
  /**
   * 下位技能关系(从模拟器读技能时自动带上)。
   * 金技能的列表价 = 前置价 + 金自己的折后价,不声明这个会把「金+前置」重复计费。
   */
  readonly chains: readonly PlanChain[];
  /**
   * 「买金就送下位」的覆盖关系(从模拟器读技能时自动带上,沿链传递闭包)。
   * 买了金技能后下位那一行会变成「已获得」、加号点不动,所以推荐里要去掉它、合计也不算那份钱。
   */
  readonly supersedes?: readonly PlanSupersede[];
  /**
   * 读取时现场从游戏里读到的双圈实付价:{单圈技能 id: 双圈还需点数}。
   * 有值的 ◎ 不再用「◎基准 × 单圈折扣」推算(那些缺基准价的 ◎ 也能进候选了)。
   */
  readonly circleUp?: Record<string, number>;
}

export const RARITY_LABEL: Record<string, string> = {
  normal: '白',
  rareEvolved: '金',
  evolved: '进化',
  unique1: '固有1', unique2: '固有2', unique3: '固有3', unique4: '固有4', unique5: '固有5', unique6: '固有6',
  uniqueHeir: '继承固有',
};

export const PRECISION_LABEL: Record<string, string> = { precise: '', approx: '近似', unsupported: '不支持' };

const EFFECT_LABEL: Record<string, (v: number) => string> = {
  targetSpeed: v => `目标速度${v >= 0 ? '+' : ''}${v}`,
  currentSpeed: v => `即时速度${v >= 0 ? '+' : ''}${v}`,
  acceleration: v => `加速度${v >= 0 ? '+' : ''}${v}`,
  lastSpurtExtension: v => `末脚延展+${v}`,
  heal: v => `回复${(v * 100).toFixed(2)}%体力`,
  passive: () => '被动',
  unsupported: () => '未建模效果',
};

const STAT_LABEL: Record<string, string> = { speed: '速度', stamina: '耐力', power: '力量', guts: '根性', wisdom: '智力' };

export function describeEffects(skill: SkillEntry): string {
  const parts = skill.effects.map(e =>
    e.type === 'passive'
      // 绿技能:引擎把它并入起跑属性(不占发动位置),这里直接标成属性加成
      ? `绿技能 ${STAT_LABEL[e.stat] ?? e.stat}${e.value >= 0 ? '+' : ''}${e.value}`
      : (EFFECT_LABEL[e.type] ?? (() => e.type))('value' in e ? (e.value as number) : 0),
  );
  const dur = skill.durationSec === null ? '' : ` · ${skill.durationSec}s`;
  return parts.join(' / ') + dur;
}

export function searchSkills(query: string, limit = 14): readonly SkillEntry[] {
  const q = normalizeName(query);
  if (q === '') return [];
  const scored: Array<{ s: SkillEntry; score: number }> = [];
  for (const s of SKILLS) {
    if (s.cnReleased === false) continue;
    // 固有技能本体(unique1~6)在育成里靠觉醒/自带获得,技能购买界面买不到;
    // 界面能学的是继承版(uniqueHeir),数值只有本体的 50~60%。搜索里别给本体,免得选错。
    if (/^unique[1-6]$/.test(s.rarity)) continue;
    const names = [s.name, s.nameJa ?? '', s.nameTrad ?? ''].map(normalizeName);
    // 继承版在界面上的显示名不带「(继承)」,补一个别名让裸名字也能搜到
    if (s.rarity === 'uniqueHeir') names.push(normalizeName(s.name.replace(/[（(]继承[）)]/g, '')));
    let score = -1;
    if (names[0] === q) score = 0;
    else if (names.some(n => n === q)) score = 1;
    else if (names.some(n => n.startsWith(q))) score = 2;
    else if (names.some(n => n.includes(q))) score = 3;
    if (score >= 0) scored.push({ s, score });
  }
  return scored
    .sort((a, b) => a.score - b.score || a.s.name.length - b.s.name.length)
    .slice(0, limit)
    .map(x => x.s);
}

export function defaultPt(skill: SkillEntry): number {
  return (basePt.defaultByRarity as Record<string, number>)[skill.rarity] ?? 200;
}

export function courseOf(id: string) {
  return COURSES.find(c => c.id === id) ?? COURSES[0]!;
}

export function courseOptions(query: string): readonly { id: string; label: string }[] {
  const q = normalizeName(query);
  const list = q === '' ? COURSES : COURSES.filter(c => normalizeName(`${c.name}${c.id}`).includes(q));
  return list.map(c => ({ id: c.id, label: `${c.name} (${c.id})` }));
}

// ── 导入/导出(与 CLI 输入 JSON 同格式) ─────────────────────────────

export function exportPlan(state: PlanState): string {
  const course = COURSES.find(c => c.id === state.courseId);
  return JSON.stringify(
    {
      course: course?.name ?? state.courseId,
      budget: state.budget,
      runner: {
        stats: state.stats,
        tactic: state.tactic,
        distanceAptitude: state.distanceAptitude,
        surfaceAptitude: state.surfaceAptitude,
        motivation: state.motivation,
        groundCondition: state.groundCondition,
        weather: state.weather,
        season: state.season,
      },
      skills: state.skills.map(s => ({
        id: s.id, name: s.name, pt: s.pt,
        ...(s.evolvesTo !== undefined ? { evolvesTo: s.evolvesTo } : {}),
        ...(s.evolveAlternatives !== undefined && s.evolveAlternatives.length > 0
          ? { evolveAlternatives: s.evolveAlternatives }
          : {}),
      })),
      ...(state.chains.length > 0 ? { chains: state.chains } : {}),
    },
    null,
    2,
  );
}

const APTITUDES: readonly Aptitude[] = ['S', 'A', 'B', 'C', 'D', 'E', 'F', 'G'];
const TACTICS: readonly Tactic[] = ['nige', 'senko', 'sashi', 'oikomi'];
const MOTIVATIONS: readonly Motivation[] = ['best', 'good', 'normal', 'bad', 'worst'];

/** 解析 CLI 同格式 JSON;抛出带中文说明的 Error */
export function importPlan(text: string): PlanState {
  const raw: unknown = JSON.parse(text);
  if (typeof raw !== 'object' || raw === null) throw new Error('JSON 格式不正确');
  const p = raw as Record<string, unknown>;
  const courseQ = typeof p.course === 'string' ? p.course : '';
  const nq = normalizeName(courseQ);
  const course = COURSES.find(c => c.id === courseQ) ?? COURSES.find(c => normalizeName(c.name) === nq)
    ?? COURSES.find(c => normalizeName(c.name).includes(nq));
  if (!course) throw new Error(`找不到赛道「${courseQ}」`);
  if (!Array.isArray(p.skills)) throw new Error('缺少 skills 数组');
  const budget = typeof p.budget === 'number' ? p.budget : 1000;
  const r = (p.runner ?? {}) as Record<string, unknown>;
  const statsRaw = (r.stats ?? {}) as Record<string, unknown>;
  const stat = (k: string) => {
    const v = statsRaw[k];
    return typeof v === 'number' && v >= 0 ? v : 0;
  };
  const skills: PlanSkill[] = p.skills.map((s, i) => {
    if (typeof s !== 'object' || s === null) throw new Error(`skills[${i}] 格式不正确`);
    const e = s as Record<string, unknown>;
    let entry: SkillEntry | undefined;
    if (typeof e.id === 'string') entry = SKILLS.find(k => k.id === e.id);
    else if (typeof e.name === 'string') {
      const hits = searchSkills(e.name, 50).filter(k => normalizeName(k.name) === normalizeName(e.name as string));
      if (hits.length === 1) entry = hits[0];
    }
    if (!entry) throw new Error(`skills[${i}]「${String(e.name ?? e.id ?? '?')}」无法唯一匹配到技能,请改用 id`);
    // 进化:存的是技能 id,这里只在 id 合法时带上(未知 id 会被优化器报错,不如先丢掉)
    const knownId = (v: unknown): string | undefined =>
      typeof v === 'string' && SKILLS.some(k => k.id === v) ? v : undefined;
    const evolvesTo = knownId(e.evolvesTo);
    const alts = Array.isArray(e.evolveAlternatives)
      ? e.evolveAlternatives.map(knownId).filter((x): x is string => x !== undefined)
      : [];
    return {
      id: entry.id,
      name: entry.name,
      pt: typeof e.pt === 'number' ? e.pt : defaultPt(entry),
      rarity: entry.rarity,
      precision: entry.precision,
      ...(evolvesTo !== undefined ? { evolvesTo } : {}),
      ...(alts.length > 0 ? { evolveAlternatives: alts } : {}),
    };
  });
  const stats: Stats = { speed: stat('speed'), stamina: stat('stamina'), power: stat('power'), guts: stat('guts'), wisdom: stat('wisdom') };
  const pick = <T extends string>(v: unknown, allowed: readonly T[], dflt: T): T =>
    typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : dflt;
  const int = (v: unknown, min: number, max: number, dflt: number): number =>
    typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : dflt;
  return {
    courseId: course.id,
    budget,
    stats,
    tactic: pick(r.tactic, TACTICS, 'senko'),
    distanceAptitude: pick(r.distanceAptitude, APTITUDES, 'A'),
    surfaceAptitude: pick(r.surfaceAptitude, APTITUDES, 'A'),
    motivation: pick(r.motivation, MOTIVATIONS, 'normal'),
    groundCondition: int(r.groundCondition, 0, 3, 0) as GroundCondition,
    weather: int(r.weather, 1, 4, 1) as Weather,
    season: int(r.season, 1, 5, 1) as Season,
    skills,
    ...(p.circleUp !== undefined && typeof p.circleUp === 'object' && p.circleUp !== null
      ? {
          circleUp: Object.fromEntries(
            Object.entries(p.circleUp as Record<string, unknown>)
              .filter(([k, v]) => typeof k === 'string' && typeof v === 'number' && (v as number) > 0)
              .map(([k, v]) => [k, v as number]),
          ),
        }
      : {}),
    chains: Array.isArray(p.chains)
      ? (p.chains as unknown[])
          .map(c => c as Record<string, unknown>)
          .filter(c => typeof c.skillId === 'string' && typeof c.prereqId === 'string')
          .map(c => ({ skillId: c.skillId as string, prereqId: c.prereqId as string }))
          .filter(c => skills.some(s => s.id === c.skillId) && skills.some(s => s.id === c.prereqId))
      : [],
  };
}

// ── Worker 调用(http 下后台计算不卡界面;file:// 单文件版回退主线程) ──

import OptimizerWorker from './optimizer.worker?worker&inline';
import { optimize as optimizeSync } from '../../src/optimizer.js';
import type { RunnerConfig } from '../../src/engine/index.js';

let worker: Worker | null = null;
let seq = 0;
type Pending = { resolve: (r: OptimizerResult) => void; reject: (e: Error) => void };
const pending = new Map<number, Pending>();

function getWorker(): Worker {
  if (worker === null) {
    worker = new OptimizerWorker();
    worker.onmessage = (e: MessageEvent) => {
      const { seq: id, ok, result, error } = e.data as { seq: number; ok: boolean; result?: OptimizerResult; error?: string };
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      if (ok && result) p.resolve(result);
      else p.reject(new Error(error ?? '未知错误'));
    };
  }
  return worker;
}

export interface RunInput {
  readonly courseId: string;
  readonly budget: number;
  readonly stats: Stats;
  readonly tactic: Tactic;
  readonly distanceAptitude: Aptitude;
  readonly surfaceAptitude: Aptitude;
  readonly motivation: Motivation;
  readonly groundCondition: GroundCondition;
  readonly weather: Weather;
  readonly season: Season;
  /** 现场读到的双圈实付价:{单圈 id: 点数};由 App 从 plan.circleUp 传下来 */
  readonly circleUp?: Record<string, number>;
  /**
   * 买金就送下位的覆盖关系;由 App 从 plan.supersedes 传下来。
   * **只影响汇报**(下位不进推荐列表、不计入合计),不影响搜索。
   */
  readonly supersedes?: readonly PlanSupersede[];
  /** requires = 下位技能 id(列表价已含它);由 App 从 plan.chains 展开后传入 */
  readonly skills: readonly {
    id: string; pt: number; requires?: string;
    evolvesTo?: string; evolveAlternatives?: readonly string[];
  }[];
}

function runOnMain(input: RunInput): Promise<OptimizerResult> {
  const course = COURSES.find(c => c.id === input.courseId);
  if (!course) return Promise.reject(new Error(`找不到赛道 ${input.courseId}`));
  const runner: RunnerConfig = {
    stats: input.stats,
    greenBonus: {},
    tactic: input.tactic,
    distanceAptitude: input.distanceAptitude,
    surfaceAptitude: input.surfaceAptitude,
    motivation: input.motivation,
    groundCondition: input.groundCondition,
    weather: input.weather,
    season: input.season,
    courseFix: 'auto',
    skills: [],
  };
  try {
    return Promise.resolve(optimizeSync({
      course, runner, candidates: input.skills, budget: input.budget,
      ...(input.circleUp !== undefined ? { circleUpOverride: input.circleUp } : {}),
      ...(input.supersedes !== undefined ? { supersedes: input.supersedes } : {}),
    }));
  } catch (e) {
    return Promise.reject(e as Error);
  }
}

export function runOptimize(input: RunInput): Promise<OptimizerResult> {
  if (location.protocol === 'file:') return runOnMain(input);
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    try {
      getWorker().postMessage({ seq: id, ...input });
    } catch {
      // Worker 不可用时回退主线程计算
      pending.delete(id);
      void runOnMain(input).then(resolve, reject);
    }
  });
}
