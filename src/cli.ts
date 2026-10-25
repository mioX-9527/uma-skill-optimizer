#!/usr/bin/env node
/**
 * 技能PT规划器 CLI
 *
 * 用法:
 *   npm run optimize -- --input <plan.json> [--budget <pt>] [--out <result.json>] [--max-sims <n>]
 *
 * 输入 JSON 格式见 examples/input.example.json。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Aptitude, Course, Motivation, RunnerConfig, Stats, Tactic } from './engine/index.js';
import { COURSES, SKILLS, type SkillEntry } from './data.js';
import { lookup } from './lookup.js';
import { optimize } from './optimizer.js';
import { fmtBody, tableRow } from './fmt.js';
import basePt from './base-pt.json';

const STAT_KEYS = ['speed', 'stamina', 'power', 'guts', 'wisdom'] as const;
const TACTICS: readonly Tactic[] = ['nige', 'senko', 'sashi', 'oikomi'];
const APTITUDES: readonly Aptitude[] = ['S', 'A', 'B', 'C', 'D', 'E', 'F', 'G'];
const MOTIVATIONS: readonly Motivation[] = ['best', 'good', 'normal', 'bad', 'worst'];
const TACTIC_LABEL: Record<Tactic, string> = { nige: '逃马', senko: '先行', sashi: '差行', oikomi: '追马' };
const REASON_LABEL = { unaffordable: '超预算', 'no-gain': '组合内无正收益', outbid: '被更优组合挤出' } as const;

interface PlanSkillInput {
  readonly id?: string;
  readonly name?: string;
  readonly pt?: number;
}

interface PlanInput {
  readonly course: string;
  readonly budget: number;
  readonly runner: {
    readonly stats: Stats;
    readonly tactic?: Tactic;
    readonly distanceAptitude?: Aptitude;
    readonly surfaceAptitude?: Aptitude;
    readonly motivation?: Motivation;
    readonly greenBonus?: Partial<Stats>;
    readonly groundCondition?: 0 | 1 | 2 | 3;
    readonly courseFix?: number | 'auto';
  };
  readonly skills: readonly PlanSkillInput[];
}

function parseArgs(argv: readonly string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) {
      if (out.input === undefined) out.input = a;
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out[key] = next;
      i++;
    } else out[key] = true;
  }
  return out;
}

function fail(msg: string): never {
  console.error(`[错误] ${msg}`);
  process.exit(1);
}

function resolveCourse(query: string): Course {
  const r = lookup(COURSES, c => [c.name], query);
  if (r.value) return r.value;
  const listing = r.matches.slice(0, 12).map(c => `  ${c.id}  ${c.name}`).join('\n');
  fail(`赛道「${query}」${r.matches.length > 1 ? `匹配到 ${r.matches.length} 条,请用 id 精确指定:\n${listing}` : '未找到,可先用名称关键字检查:\n' + COURSES.slice(0, 3).map(c => `  ${c.id}  ${c.name}`).join('\n') + ' …'}`);
}

function resolveSkill(s: PlanSkillInput, idx: number): { skill: SkillEntry; pt: number; ptEst: boolean } {
  if (!s.id && !s.name) fail(`skills[${idx}]: 缺少 id 或 name`);
  let skill: SkillEntry | undefined;
  if (s.id) {
    skill = SKILLS.find(k => k.id === s.id);
    if (!skill) fail(`skills[${idx}]: 技能库中不存在 id ${s.id}`);
  } else {
    const r = lookup(SKILLS, k => [k.name, k.nameJa ?? '', k.nameTrad ?? ''], s.name!);
    if (!r.value) {
      const listing = r.matches.slice(0, 10).map(k => `  ${k.id}  ${k.name}`).join('\n');
      fail(`skills[${idx}]: 技能「${s.name}」${r.matches.length > 1 ? `匹配到 ${r.matches.length} 条,请改用 id:\n${listing}` : '未找到(检查名称,或用 id 指定)'}`);
    }
    skill = r.value;
  }
  if (s.pt !== undefined) {
    if (typeof s.pt !== 'number' || s.pt < 0) fail(`skills[${idx}](${skill.name}): pt 必须是非负数字`);
    return { skill, pt: s.pt, ptEst: false };
  }
  const fallback = (basePt.defaultByRarity as Record<string, number>)[skill.rarity];
  return { skill, pt: fallback ?? 200, ptEst: true };
}

function validateRunner(raw: PlanInput['runner']): RunnerConfig {
  if (!raw?.stats) fail('runner.stats 缺失');
  for (const k of STAT_KEYS) {
    const v = raw.stats[k];
    if (typeof v !== 'number' || v < 0) fail(`runner.stats.${k} 必须是非负数字`);
  }
  for (const [key, allowed] of [['tactic', TACTICS], ['distanceAptitude', APTITUDES], ['surfaceAptitude', APTITUDES], ['motivation', MOTIVATIONS]] as const) {
    const v = raw[key as keyof PlanInput['runner']] as string | undefined;
    if (v !== undefined && !(allowed as readonly string[]).includes(v)) {
      fail(`runner.${key} 取值 ${v} 无效,允许: ${allowed.join('/')}`);
    }
  }
  return {
    stats: raw.stats,
    greenBonus: raw.greenBonus ?? {},
    tactic: raw.tactic ?? 'senko',
    distanceAptitude: raw.distanceAptitude ?? 'A',
    surfaceAptitude: raw.surfaceAptitude ?? 'A',
    motivation: raw.motivation ?? 'normal',
    ...(raw.groundCondition !== undefined ? { groundCondition: raw.groundCondition } : {}),
    courseFix: raw.courseFix ?? 'auto',
    skills: [],
  };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const inputPath = typeof args.input === 'string' ? args.input : typeof args._input === 'string' ? args._input : undefined;
  if (!inputPath) fail('用法: npm run optimize -- --input <plan.json>\n输入格式见 examples/input.example.json');
  let plan: PlanInput;
  try {
    plan = JSON.parse(readFileSync(resolve(inputPath), 'utf8'));
  } catch (e) {
    fail(`读取输入文件失败: ${(e as Error).message}`);
  }
  if (typeof plan.course !== 'string' || !Array.isArray(plan.skills)) {
    fail('输入需包含 course(字符串) 与 skills(数组);格式见 examples/input.example.json');
  }
  const budget = typeof args.budget === 'string' ? Number(args.budget) : plan.budget;
  if (!Number.isFinite(budget) || budget < 0) fail('预算(--budget 或 budget)必须是非负数字');
  const maxSims = typeof args.maxSims === 'string' ? Number(args.maxSims) : undefined;

  const course = resolveCourse(plan.course);
  const runner = validateRunner(plan.runner);
  const resolved = plan.skills.map((s, i) => resolveSkill(s, i));
  const estPt = resolved.filter(r => r.ptEst).map(r => r.skill.name);
  const candidates = resolved.map(r => ({ id: r.skill.id, pt: r.pt }));
  const ptOf = new Map(candidates.map(c => [c.id, c.pt] as const));

  console.log(`赛道: ${course.name}(${course.id})  跑法: ${TACTIC_LABEL[runner.tactic]}  预算: ${budget}pt  候选: ${candidates.length} 条`);
  if (estPt.length > 0) {
    console.log(`[注意] 以下技能未提供 pt,使用兜底估算价(游戏内有折扣时请以实际显示价为准):\n  ${estPt.join('、')}`);
  }

  const result = optimize({
    course,
    runner,
    candidates,
    budget,
    ...(maxSims !== undefined ? { maxSims } : {}),
  });

  console.log('');
  console.log(`无技能完赛 ${result.baselineSec.toFixed(3)}s → 有技能完赛 ${result.finalSec.toFixed(3)}s`);
  console.log(`推荐购买 ${result.chosen.length} 项,合计 ${result.totalPt}pt(剩余 ${result.remainingPt}pt),总收益 ${fmtBody(result.totalBody)} 马身`);
  console.log(`(单项收益之和 ${fmtBody(result.sumSoloBody)} 马身;差值 = 技能间交互,单项收益仅供对照)`);
  console.log('');

  const W = { no: 3, name: 20, pt: 7, solo: 9, marg: 9, sec: 8 };
  console.log(tableRow(['#', '技能', 'PT', '单独马身', '集内边际', '边际(秒)'], [W.no, W.name, W.pt, W.solo, W.marg, W.sec], ['left', 'left', 'right', 'right', 'right', 'right']));
  result.chosen.forEach((c, i) => {
    console.log(tableRow(
      [String(i + 1), c.name, String(c.pt), fmtBody(c.soloBody), fmtBody(c.finalMarginalBody), c.finalMarginalSec.toFixed(3)],
      [W.no, W.name, W.pt, W.solo, W.marg, W.sec],
      ['left', 'left', 'right', 'right', 'right', 'right'],
    ));
  });

  if (result.rejected.length > 0) {
    console.log('');
    console.log('未购买技能(按剩余边际收益排序):');
    console.log(tableRow(['技能', 'PT', '单独马身', '原因', '差PT'], [W.name, W.pt, W.solo, 16, 7], ['left', 'right', 'right', 'left', 'right']));
    for (const r of result.rejected) {
      console.log(tableRow(
        [r.name, String(r.pt), fmtBody(r.soloBody), REASON_LABEL[r.reason], r.reason === 'outbid' && r.missingPt > 0 ? String(r.missingPt) : ''],
        [W.name, W.pt, W.solo, 16, 7],
        ['left', 'right', 'right', 'left', 'right'],
      ));
    }
  }

  if (result.notes.length > 0) {
    console.log('');
    for (const n of result.notes) console.log(`[注意] ${n}`);
  }
  console.log(`\n(模拟次数: ${result.simsUsed})`);

  if (typeof args.out === 'string') {
    const out = { ...result, ptById: Object.fromEntries([...ptOf.entries()]) };
    writeFileSync(resolve(args.out), JSON.stringify(out, null, 2) + '\n');
    console.log(`结果 JSON 已写入 ${resolve(args.out)}`);
  }
}

main();
