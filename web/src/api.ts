import type { Aptitude, Motivation, Stats, Tactic } from '../../src/engine/index.js';
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
}

export interface PlanState {
  readonly courseId: string;
  readonly budget: number;
  readonly stats: Stats;
  readonly tactic: Tactic;
  readonly distanceAptitude: Aptitude;
  readonly surfaceAptitude: Aptitude;
  readonly motivation: Motivation;
  readonly skills: readonly PlanSkill[];
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
  passive: () => '被动(引擎暂不计入)',
  unsupported: () => '未建模效果',
};

export function describeEffects(skill: SkillEntry): string {
  const parts = skill.effects.map(e => (EFFECT_LABEL[e.type] ?? (() => e.type))('value' in e ? (e.value as number) : 0));
  const dur = skill.durationSec === null ? '' : ` · ${skill.durationSec}s`;
  return parts.join(' / ') + dur;
}

export function searchSkills(query: string, limit = 14): readonly SkillEntry[] {
  const q = normalizeName(query);
  if (q === '') return [];
  const scored: Array<{ s: SkillEntry; score: number }> = [];
  for (const s of SKILLS) {
    if (s.cnReleased === false) continue;
    const names = [s.name, s.nameJa ?? '', s.nameTrad ?? ''].map(normalizeName);
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
      },
      skills: state.skills.map(s => ({ id: s.id, name: s.name, pt: s.pt })),
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
    return {
      id: entry.id,
      name: entry.name,
      pt: typeof e.pt === 'number' ? e.pt : defaultPt(entry),
      rarity: entry.rarity,
      precision: entry.precision,
    };
  });
  const stats: Stats = { speed: stat('speed'), stamina: stat('stamina'), power: stat('power'), guts: stat('guts'), wisdom: stat('wisdom') };
  const pick = <T extends string>(v: unknown, allowed: readonly T[], dflt: T): T =>
    typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : dflt;
  return {
    courseId: course.id,
    budget,
    stats,
    tactic: pick(r.tactic, TACTICS, 'senko'),
    distanceAptitude: pick(r.distanceAptitude, APTITUDES, 'A'),
    surfaceAptitude: pick(r.surfaceAptitude, APTITUDES, 'A'),
    motivation: pick(r.motivation, MOTIVATIONS, 'normal'),
    skills,
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
  readonly skills: readonly { id: string; pt: number }[];
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
    courseFix: 'auto',
    skills: [],
  };
  try {
    return Promise.resolve(optimizeSync({ course, runner, candidates: input.skills, budget: input.budget }));
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
