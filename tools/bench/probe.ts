/**
 * 候选池探针:把 plan JSON 解析成候选池后,打印每个候选的关键事实。
 *
 * 目的:审计时用来确认「randomPosition 技能有哪些」「前置/双圈关系怎么落地」
 * 「哪些候选被 blocked」,以及核对 PT / applicabble 判定。只读,不改动任何算法。
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { COURSES, SKILLS, CIRCLE_UPGRADES, CIRCLE_BASE, type SkillEntry } from '../../src/data.js';
import { sampleableSpans, skillApplicable, simulate } from '../../src/engine/index.js';
import type { Course, RunnerConfig, SkillConfig } from '../../src/engine/index.js';
import { lookup } from '../../src/lookup.js';

const STAT_KEYS = ['speed', 'stamina', 'power', 'guts', 'wisdom'] as const;

interface PlanSkill {
  readonly id?: string;
  readonly name?: string;
  readonly pt?: number;
}
interface Plan {
  readonly course: string;
  readonly budget: number;
  readonly runner: Record<string, unknown>;
  readonly skills: readonly PlanSkill[];
  readonly chains?: readonly { skillId: string; prereqId: string }[];
  readonly evolutions?: readonly { fromId: string; toId: string; conditionMet?: boolean }[];
}

/** 解析 plan JSON → { course, runner, candidates }(与 src/cli.ts 同口径) */
export function loadPlan(path: string): {
  course: Course;
  runner: RunnerConfig;
  budget: number;
  candidates: readonly { id: string; pt: number; requires?: string; evolvesTo?: string }[];
} {
  const plan: Plan = JSON.parse(readFileSync(path, 'utf8'));
  const hit = lookup(COURSES, c => [c.name], plan.course);
  if (!hit.value) throw new Error(`赛道未找到: ${plan.course}`);
  const raw = plan.runner as Record<string, unknown>;
  const runner: RunnerConfig = {
    stats: (raw.stats ?? {}) as RunnerConfig['stats'],
    greenBonus: (plan.runner.greenBonus as RunnerConfig['greenBonus']) ?? {},
    tactic: (plan.runner.tactic as RunnerConfig['tactic']) ?? 'senko',
    distanceAptitude: (plan.runner.distanceAptitude as RunnerConfig['distanceAptitude']) ?? 'A',
    surfaceAptitude: (plan.runner.surfaceAptitude as RunnerConfig['surfaceAptitude']) ?? 'A',
    motivation: (plan.runner.motivation as RunnerConfig['motivation']) ?? 'normal',
    ...(plan.runner.groundCondition !== undefined ? { groundCondition: plan.runner.groundCondition as 0 } : {}),
    ...(plan.runner.weather !== undefined ? { weather: plan.runner.weather as 1 } : {}),
    ...(plan.runner.season !== undefined ? { season: plan.runner.season as 1 } : {}),
    courseFix: (plan.runner.courseFix as number | 'auto') ?? 'auto',
    skills: [],
  };
  const resolved = plan.skills.map(s => {
    if (s.id !== undefined) {
      const k = SKILLS.find(x => x.id === s.id);
      if (k === undefined) throw new Error(`技能 id 不存在: ${s.id}`);
      return { skill: k, pt: s.pt ?? 0 };
    }
    const r = lookup(SKILLS, k => [k.name, k.nameJa ?? '', k.nameTrad ?? ''], s.name!);
    if (!r.value) throw new Error(`技能名未找到: ${s.name}`);
    return { skill: r.value, pt: s.pt ?? 0 };
  });
  const candIdSet = new Set(resolved.map(r => r.skill.id));
  const chainMap = new Map((plan.chains ?? []).map(c => [String(c.skillId), String(c.prereqId)] as const));
  const evoBest = new Map<string, string>();
  for (const e of plan.evolutions ?? []) {
    if (e.conditionMet !== true || !candIdSet.has(e.fromId)) continue;
    if (!evoBest.has(e.fromId)) evoBest.set(e.fromId, e.toId);
  }
  const candidates = resolved.map(r => {
    const req = chainMap.get(r.skill.id);
    const evo = evoBest.get(r.skill.id);
    return {
      id: r.skill.id,
      pt: r.pt,
      ...(req !== undefined && candIdSet.has(req) ? { requires: req } : {}),
      ...(evo !== undefined ? { evolvesTo: evo } : {}),
    };
  });
  return { course: hit.value, runner, budget: plan.budget, candidates };
}

/** 按 optimizer.ts 的规则展开候选池(补双圈 ◎),返回带 Patch描述的候选 */
export interface Probed {
  readonly id: string;
  readonly name: string;
  readonly pt: number;
  readonly randomPosition: boolean;
  readonly spans: readonly [number, number][] | null;
  readonly applicable: boolean;
  readonly requires: readonly string[];
  readonly circleChain: boolean;
  readonly evolvesTo?: string;
}

export function probePool(
  candidates: readonly { id: string; pt: number; requires?: string; evolvesTo?: string }[],
  course: Course,
  runner: RunnerConfig,
): { probed: Probed[]; added: Probed[] } {
  const index = new Map(SKILLS.map(s => [s.id, s] as const));
  const seen = new Set(candidates.map(c => c.id));
  const make = (id: string, pt: number, requires: string[], circleChain: boolean, evolvesTo?: string): Probed => {
    const skill = index.get(id)!;
    const spans = skill.randomPosition === true ? sampleableSpans(skill.condition, course) : null;
    return {
      id,
      name: skill.name,
      pt,
      randomPosition: skill.randomPosition === true,
      spans: spans as readonly [number, number][] | null,
      applicable: skillApplicable(skill as SkillConfig, course, runner),
      requires,
      circleChain,
      ...(evolvesTo !== undefined ? { evolvesTo } : {}),
    };
  };
  const probed = candidates.map(c =>
    make(c.id, c.pt, c.requires !== undefined && seen.has(c.requires) ? [c.requires] : [], false, c.evolvesTo),
  );
  const added: Probed[] = [];
  const seenIds = new Set(probed.map(c => c.id));
  for (const base of [...probed]) {
    const up = CIRCLE_UPGRADES.get(base.id);
    if (up === undefined || seenIds.has(up.upId)) continue;
    const upSkill = index.get(up.upId);
    if (upSkill === undefined) continue;
    seenIds.add(up.upId);
    const ratio = up.basePt > 0 ? base.pt / up.basePt : 1;
    const sane = ratio >= 0.4 && ratio <= 1.05;
    const upPt = sane ? Math.max(1, Math.round(up.upPt * ratio)) : up.upPt;
    added.push(make(up.upId, upPt, [base.id], true));
  }
  return { probed, added };
}

function main(): void {
  const path = process.argv[2] ?? 'app/_debug/plan_v2.json';
  const { course, runner, budget, candidates } = loadPlan(path);
  console.log(`赛道 ${course.name} 距离 ${course.distance}m  预算 ${budget}pt`);
  console.log(`原始候选 ${candidates.length} 条`);
  const { probed, added } = probePool(candidates, course, runner);
  console.log(`展开双圈后 ${probed.length + added.length} 条(新增 ${added.length} 条 ◎)\n`);
  const all = [...probed, ...added];
  console.log('id'.padEnd(10), '名称'.padEnd(18), 'PT'.padStart(5), '随机?', '适用?', '前置', ' 区段');
  for (const c of all) {
    console.log(
      c.id.padEnd(10),
      c.name.padEnd(16),
      String(c.pt).padStart(5),
      c.randomPosition ? 'R  ' : '   ',
      c.applicable ? 'Y  ' : 'N  ',
      c.requires.join(',') || '-',
      c.spans === null ? '' : JSON.stringify(c.spans.map(s => [Math.round(s[0]), Math.round(s[1])])),
    );
  }
  const nRand = all.filter(c => c.randomPosition).length;
  const nBlocked = all.filter(c => !c.applicable).length;
  console.log(`\nrandomPosition 技能 ${nRand} 条;装配限制不满足 ${nBlocked} 条`);
  const base = simulate(course, runner);
  console.log(`空手基线 ${base.finishTimeSec.toFixed(4)}s  末脚目标速度 ${base.spurtTargetSpeed.toFixed(3)} m/s`);
  console.log(`CIRCLE_BASE 对数 ${CIRCLE_BASE.size}`);
}

// 仅当本文件作为入口执行时才打印;被 import 时保持静默
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
