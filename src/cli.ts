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
import { MUST_CHECK, optimize } from './optimizer.js';
import { fmtBody, tableRow } from './fmt.js';
import basePt from './base-pt.json';

const STAT_KEYS = ['speed', 'stamina', 'power', 'guts', 'wisdom'] as const;
const TACTICS: readonly Tactic[] = ['nige', 'senko', 'sashi', 'oikomi'];
const APTITUDES: readonly Aptitude[] = ['S', 'A', 'B', 'C', 'D', 'E', 'F', 'G'];
const MOTIVATIONS: readonly Motivation[] = ['best', 'good', 'normal', 'bad', 'worst'];
const TACTIC_LABEL: Record<Tactic, string> = { nige: '逃马', senko: '先行', sashi: '差行', oikomi: '追马' };
const REASON_LABEL = {
  unaffordable: '超预算',
  inapplicable: '不适配本配置',
  'no-gain': '组合内无正收益',
  outbid: '被更优组合挤出',
} as const;
const GROUND_LABEL = ['良', '稍重', '重', '不良'];
const WEATHER_LABEL = ['', '晴', '阴', '雨', '雪'];
const SEASON_LABEL = ['', '春', '夏', '秋', '冬', '樱花'];

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
    /** 天气(技能条件用):1 晴 / 2 阴 / 3 雨 / 4 雪,缺省晴 */
    readonly weather?: 1 | 2 | 3 | 4;
    /** 季节(技能条件用):1 春 / 2 夏 / 3 秋 / 4 冬 / 5 樱花,缺省春 */
    readonly season?: 1 | 2 | 3 | 4 | 5;
    readonly courseFix?: number | 'auto';
  };
  readonly skills: readonly PlanSkillInput[];
  /**
   * 下位技能关系(可选)。格式 `[{ skillId, prereqId }]`,由游戏界面读取时自动带上。
   * 列表里金技能显示的价格已包含前置价,不声明这个关系会把「金 + 前置」重复计费。
   */
  readonly chains?: readonly { readonly skillId: string; readonly prereqId: string }[];
  /**
   * 可进化关系(可选),由游戏「技能进化」弹窗读到。
   * conditionMet=true 表示当前马娘已满足条件,结束养成时会免费进化,此时按进化后的数值算收益。
   */
  readonly evolutions?: readonly {
    readonly fromId: string;
    readonly toId: string;
    readonly to: string;
    readonly conditionMet: boolean;
  }[];
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
  const envNum = (key: 'groundCondition' | 'weather' | 'season', min: number, max: number) => {
    const v = raw[key];
    if (v === undefined) return undefined;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
      fail(`runner.${key} 取值 ${String(v)} 无效,允许整数 ${min}~${max}`);
    }
    return v;
  };
  const groundCondition = envNum('groundCondition', 0, 3);
  const weather = envNum('weather', 1, 4);
  const season = envNum('season', 1, 5);
  return {
    stats: raw.stats,
    greenBonus: raw.greenBonus ?? {},
    tactic: raw.tactic ?? 'senko',
    distanceAptitude: raw.distanceAptitude ?? 'A',
    surfaceAptitude: raw.surfaceAptitude ?? 'A',
    motivation: raw.motivation ?? 'normal',
    ...(groundCondition !== undefined ? { groundCondition: groundCondition as 0 | 1 | 2 | 3 } : {}),
    ...(weather !== undefined ? { weather: weather as 1 | 2 | 3 | 4 } : {}),
    ...(season !== undefined ? { season: season as 1 | 2 | 3 | 4 | 5 } : {}),
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
  // parseArgs 不做命名转换,键是原样的 'max-sims';此处历史上读过 args.maxSims,
  // 与实际键名不符 —— 这个开关因此从未生效过(2026-10-27 顺 优先级5 / 审计 P4 修复)
  const maxSimsRaw = args['max-sims'] ?? args.maxSims;
  const maxSims = typeof maxSimsRaw === 'string' ? Number(maxSimsRaw) : undefined;
  if (maxSims !== undefined && (!Number.isFinite(maxSims) || maxSims < 1)) {
    fail(`--max-sims 必须是 ≥1 的数字(收到 ${String(maxSimsRaw)})`);
  }

  const course = resolveCourse(plan.course);
  const runner = validateRunner(plan.runner);
  const resolved = plan.skills.map((s, i) => resolveSkill(s, i));
  const estPt = resolved.filter(r => r.ptEst).map(r => r.skill.name);
  // 上下位关系:只有当**前置也在候选里**才生效(前置不在=已经买过,显示价里本来就不含它)
  const chainMap = new Map((plan.chains ?? []).map(c => [String(c.skillId), String(c.prereqId)] as const));
  const candIdSet = new Set(resolved.map(r => r.skill.id));
  // 进化:条件已达成才按进化后算(结束养成时自动进化,不额外花 PT)。
  // **一个技能可能有多条进化路线**,各条单独算一遍单项收益,取最高的进主方案,其余在下面列出对比。
  // 注意 toId 是进化后的技能,它本身不在候选列表里(不用单独买),所以只校验 fromId。
  const ptOf = new Map(resolved.map(r => [r.skill.id, r.pt] as const));
  const nameOf = new Map(resolved.map(r => [r.skill.id, r.skill.name] as const));
  const evoGroups = new Map<string, { toId: string; to: string }[]>();
  for (const e of plan.evolutions ?? []) {
    if (!e.conditionMet || !candIdSet.has(e.fromId)) continue;
    const arr = evoGroups.get(e.fromId) ?? [];
    if (!arr.some(x => x.toId === e.toId)) arr.push({ toId: e.toId, to: e.to });
    evoGroups.set(e.fromId, arr);
  }

  /** 单技能试算:得到某个进化方向下的单项收益(马身) */
  const soloBodyOf = (fromId: string, toId: string | undefined): number => {
    const pt = ptOf.get(fromId) ?? 0;
    const r = optimize({
      course, runner, budget: 1e9,
      candidates: [toId !== undefined ? { id: fromId, pt, evolvesTo: toId } : { id: fromId, pt }],
    });
    return r.chosen[0]?.soloBody ?? 0;
  };

  const evoBest = new Map<string, string>();      // fromId → 选中的 toId
  const evoCompare: { from: string; options: { to: string; body: number }[] }[] = [];
  for (const [fromId, opts] of evoGroups) {
    const scored = opts.map(o => ({ to: o.to, toId: o.toId, body: soloBodyOf(fromId, o.toId) }));
    const base = soloBodyOf(fromId, undefined);
    scored.push({ to: '(不进化)', toId: '', body: base });
    scored.sort((a, b) => b.body - a.body);
    const top = scored[0]!;
    if (top.toId !== '') evoBest.set(fromId, top.toId);
    evoCompare.push({
      from: nameOf.get(fromId) ?? fromId,
      options: scored.map(s => ({ to: s.to, body: s.body })),
    });
  }
  const evoMap = evoBest;
  const candidates = resolved.map(r => {
    const req = chainMap.get(r.skill.id);
    const evo = evoMap.get(r.skill.id);
    return {
      id: r.skill.id,
      pt: r.pt,
      ...(req !== undefined && candIdSet.has(req) ? { requires: req } : {}),
      ...(evo !== undefined ? { evolvesTo: evo } : {}),
    };
  });
  console.log(`赛道: ${course.name}(${course.id})  跑法: ${TACTIC_LABEL[runner.tactic]}  预算: ${budget}pt  候选: ${candidates.length} 条`);
  console.log(`环境: 场地 ${GROUND_LABEL[runner.groundCondition ?? 0]}  天气 ${WEATHER_LABEL[runner.weather ?? 1]}  季节 ${SEASON_LABEL[runner.season ?? 1]}(只影响「绿技能/环境条件类技能」是否生效)`);
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
  // 会让推荐本身失真、必须先核对的问题(如 ◎ 价格来源不可信)—— 放到表格前面,
  // 别混在末尾那堆说明里(混进去就没人读了)
  const mustCheck = result.notes.filter(n => n.startsWith(MUST_CHECK));
  const plainNotes = result.notes.filter(n => !n.startsWith(MUST_CHECK));
  if (mustCheck.length > 0) {
    console.log('=== 需要先核对 ===');
    for (const n of mustCheck) console.log(`  ${n.slice(MUST_CHECK.length)}`);
    console.log('  ↑ 上面这些问题会让推荐结果失真,照买之前请先确认');
    console.log('');
  }
  console.log(`无技能完赛 ${result.baselineSec.toFixed(3)}s → 有技能完赛 ${result.finalSec.toFixed(3)}s`);
  console.log(`推荐购买 ${result.chosen.length} 项,合计 ${result.totalPt}pt(剩余 ${result.remainingPt}pt),总收益 ${fmtBody(result.totalBody)} 马身`);
  console.log(`(单项收益之和 ${fmtBody(result.sumSoloBody)} 马身;差值 = 技能间交互,单项收益仅供对照)`);
  console.log('');

  const W = { no: 3, name: 20, pt: 7, solo: 9, marg: 9, sec: 8 };
  console.log(tableRow(['#', '技能', 'PT', '单独马身', '集内边际', '边际(秒)'], [W.no, W.name, W.pt, W.solo, W.marg, W.sec], ['left', 'left', 'right', 'right', 'right', 'right']));
  result.chosen.forEach((c, i) => {
    // 实付价与标价不同时(前置已买,扣掉了那部分)标出来;含前置的也标
    const ptCell = c.pt !== c.listPt ? `${c.pt}*` : String(c.pt);
    const parts: string[] = [];
    if (c.includesPrereq.length > 0) parts.push(`含${c.includesPrereq.join('+')}`);
    if (c.evolvesTo !== null) parts.push(`⇒进化 ${c.evolvesTo}`);
    const nameCell = parts.length > 0 ? `${c.name}(${parts.join(',')})` : c.name;
    // 进化过的给出「未进化 → 进化后」对照,一眼看出进化值多少
    const soloCell = c.evolvesTo !== null
      ? `${fmtBody(c.soloBodyBefore)}→${fmtBody(c.soloBody)}`
      : fmtBody(c.soloBody);
    console.log(tableRow(
      [String(i + 1), nameCell, ptCell, soloCell, fmtBody(c.finalMarginalBody), c.finalMarginalSec.toFixed(3)],
      [W.no, W.name, W.pt, W.solo, W.marg, W.sec],
      ['left', 'left', 'right', 'right', 'right', 'right'],
    ));
  });
  if (evoCompare.length > 0) {
    console.log('');
    console.log('进化方向对比(单项马身,主方案按收益最高的那条算):');
    for (const c of evoCompare) {
      const line = c.options.map(o => `${o.to} ${fmtBody(o.body)}`).join('  |  ');
      console.log(`  ${c.from}: ${line}`);
    }
  }
  if (result.chosen.some(c => c.evolvesTo !== null)) {
    console.log('  ⇒进化 = 该金技能条件已达成,结束养成时免费变成进化技;「单独马身」显示 未进化→进化后');
  }

  if (result.rejected.length > 0) {
    console.log('');
    console.log('未购买技能(按剩余边际收益排序):');
    const hasDetail = result.rejected.some(r => r.detail !== '');
    const RW = { name: W.name, pt: W.pt, solo: W.solo, reason: 16, miss: 7, note: 30 };
    const widths = hasDetail ? [RW.name, RW.pt, RW.solo, RW.reason, RW.miss, RW.note] : [RW.name, RW.pt, RW.solo, RW.reason, RW.miss];
    const aligns = hasDetail
      ? (['left', 'right', 'right', 'left', 'right', 'left'] as const)
      : (['left', 'right', 'right', 'left', 'right'] as const);
    console.log(tableRow(hasDetail ? ['技能', 'PT', '单独马身', '原因', '差PT', '说明'] : ['技能', 'PT', '单独马身', '原因', '差PT'], widths, aligns));
    for (const r of result.rejected) {
      const cells = [
        r.name, String(r.pt), fmtBody(r.soloBody), REASON_LABEL[r.reason],
        r.reason === 'outbid' && r.missingPt > 0 ? String(r.missingPt) : '',
      ];
      if (hasDetail) cells.push(r.detail);
      console.log(tableRow(cells, widths, aligns));
    }
  }

  if (plainNotes.length > 0) {
    console.log('');
    for (const n of plainNotes) console.log(`[注意] ${n}`);
  }
  console.log(`\n(模拟次数: ${result.simsUsed})`);

  if (typeof args.out === 'string') {
    const out = { ...result, ptById: Object.fromEntries([...ptOf.entries()]) };
    writeFileSync(resolve(args.out), JSON.stringify(out, null, 2) + '\n');
    console.log(`结果 JSON 已写入 ${resolve(args.out)}`);
  }
}

main();
