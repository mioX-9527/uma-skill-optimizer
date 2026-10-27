import type { Course, SkillConfig } from './engine/index.js';
import coursesJson from '../data/courses.json';
import skillsJson from '../data/skills.json';

export interface SkillEntry extends SkillConfig {
  readonly nameJa?: string;
  readonly nameTrad?: string;
  readonly cnReleased?: boolean;
  readonly restrictionText?: string;
}

export const COURSES = coursesJson as unknown as Course[];
export const SKILLS = skillsJson as unknown as SkillEntry[];

// ── 单双圈(○/◎)关系 ────────────────────────────────────────────
// 游戏里 ○ 和 ◎ **占同一格**:没买时显示 ○,买完 ○ 同一格变成 ◎(可再买一次,
// 两笔费用分开付)。列表里只能看到「当前可买的那一级」的价格,所以 ◎ 的价格
// 只能从 BWIKI 的 SMW「技能消耗PT」拿(tools/fetch-skill-pt.mjs 生成),不能瞎编。
import skillPtJson from '../data/skill-pt.json';

const SKILL_PT = (skillPtJson as { pt: Record<string, number> }).pt;

export interface CircleUpgrade {
  /** 双圈(◎)技能 */
  readonly upId: string;
  readonly upName: string;
  /** 双圈价格(单独一付,不含单圈价) */
  readonly upPt: number;
  /** 单圈价格(参考;实际以 OCR 到的为准) */
  readonly basePt: number;
}

/** 单圈技能 id → 双圈升级信息;价格缺失的方向不进表(宁缺毋滥,不猜价) */
export const CIRCLE_UPGRADES: ReadonlyMap<string, CircleUpgrade> = (() => {
  const byId = new Map(SKILLS.map(s => [s.id, s] as const));
  const out = new Map<string, CircleUpgrade>();
  for (const up of SKILLS) {
    if (up.cnReleased === false) continue;
    if (!up.name.endsWith('◎')) continue;
    const baseName = up.name.slice(0, -1) + '○';
    const base = SKILLS.find(s => s.name === baseName && s.cnReleased !== false);
    if (base === undefined) continue;
    const upPt = up.nameJa === undefined ? NaN : SKILL_PT[up.nameJa];
    const basePt = base.nameJa === undefined ? NaN : SKILL_PT[base.nameJa];
    if (!Number.isFinite(upPt) || upPt === undefined || upPt <= 0) continue;   // 价格没抓到就先不提供这个方向
    out.set(base.id, { upId: up.id, upName: up.name, upPt, basePt: basePt ?? 0 });
  }
  return out;
})();

/** 双圈技能 id → 对应的单圈技能(用于「买了 ◎ 后 ○ 不再重复生效」的替换规则) */
export const CIRCLE_BASE: ReadonlyMap<string, string> = (() => {
  const out = new Map<string, string>();
  for (const [baseId, up] of CIRCLE_UPGRADES) out.set(up.upId, baseId);
  return out;
})();

// ── 金技能 → 下位白(前置)关系 ─────────────────────────────────
// 来源 BWIKI「前置技能」查询(tools/fetch-skill-chains.mjs),249 条。
// 用途:计划里没声明上下位关系时,提示用户"这条链漏了"——漏掉的代价实测 −0.601 马身
// (不带上位白模拟,金的收益被低估;或白被当成独立候选重复计价)。见审计文档 P9。
import chainsJson from '../data/skill-chains.json';

export interface SkillChainEntry {
  readonly skillId: string;
  readonly skillName: string;
  readonly prereqId: string;
  readonly prereqName: string;
  /** 金技能自己的价(不含前置) */
  readonly cost: number;
  /** 金 + 前置的总价 */
  readonly totalCost: number;
}

export const SKILL_CHAINS: ReadonlyMap<string, SkillChainEntry> = (() => {
  const raw = (chainsJson as { chains: readonly { skillId: string; skill: string; prereqId: string; prereq: string; cost: number; totalCost: number }[] }).chains;
  const out = new Map<string, SkillChainEntry>();
  for (const c of raw) {
    out.set(String(c.skillId), {
      skillId: String(c.skillId),
      skillName: c.skill,
      prereqId: String(c.prereqId),
      prereqName: c.prereq,
      cost: c.cost,
      totalCost: c.totalCost,
    });
  }
  return out;
})();
