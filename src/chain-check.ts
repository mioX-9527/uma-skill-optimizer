import { CIRCLE_BASE, SKILL_CHAINS, type SkillChainEntry } from './data.js';

/**
 * 「金技能 → 下位白」关系漏声明的检测(P9)。
 *
 * 背景:plan 里 `chains` 是 OCR 从游戏界面读出来的上下位关系。没声明时,
 * 优化器会把金技能当成"自己一份收益"、价格按全额算,于是:
 *   - 白也在候选里 → 金和白会被当成两个独立候选,重复计价(白那部分钱被重复算)
 *   - 白不在候选里 → 收益被低估(模拟金时不带上位白,少了它那一份)
 * 实测代价:去掉 chains 后 plan_v2 从 10.497 → 9.896 马身(**−0.601**)。
 *
 * 所以这里不做任何自动修复(猜错链的代价比漏更大),只负责**把漏掉的链指出来**,
 * 由用户/OCR 去确认。
 */

export interface MissingChain {
  readonly skillId: string;
  readonly skillName: string;
  readonly prereqId: string;
  readonly prereqName: string;
  /** 金自己的价 */
  readonly cost: number;
  /** 金 + 下位白的总价 */
  readonly totalCost: number;
  /** 下位白是否也在候选列表里(是 → 会被重复计价;否 → 视为已买过,只是收益可能低估) */
  readonly prereqInPlan: boolean;
}

export interface MissingChainInput {
  /** 候选技能 id(已解析成游戏技能库的 id) */
  readonly candidateIds: readonly string[];
  /** 计划里已声明的 skillId → prereqId */
  readonly declared: ReadonlyMap<string, string>;
}

/**
 * 找出「候选里有金技能、它确实有下位白、但计划没声明这条链」的条目。
 *
 * **只报下位白也在候选里的情况。** 白不在候选里说明玩家已经买过它,金技能的显示价
 * 本来就不含那一份,模拟时金也会顶掉白的效果(P10),所以不会算错 —— 报出来只是噪音
 * (实测每份真实 plan 都会命中一条,全是这种正常情况)。
 * 真正咬人的是白也在候选里:金按全额计价、白又被当成独立候选再付一次,重复计价。
 * 已声明的不报(不判断声明得对不对——那需要另一份证据)。
 */
export function findMissingChains(input: MissingChainInput): MissingChain[] {
  const present = new Set(input.candidateIds);
  const out: MissingChain[] = [];
  for (const id of present) {
    const entry: SkillChainEntry | undefined = SKILL_CHAINS.get(id);
    if (entry === undefined) continue;              // 不是金技能(或没有已知的下位白)
    if (input.declared.has(id)) continue;           // 已声明
    // 双圈 ◎ → ○ 这段**不需要** plan.chains:同格共价由 CIRCLE_UPGRADES 自动处理,
    // 报出来是噪音(链表 249 条里有 44 条是双圈)。
    if (CIRCLE_BASE.has(id)) continue;
    if (!present.has(entry.prereqId)) continue;     // 白不在候选里 = 已买过,不算错
    out.push({
      skillId: entry.skillId,
      skillName: entry.skillName,
      prereqId: entry.prereqId,
      prereqName: entry.prereqName,
      cost: entry.cost,
      totalCost: entry.totalCost,
      prereqInPlan: true,
    });
  }
  return out.sort((a, b) => a.skillName.localeCompare(b.skillName, 'zh'));
}

/** 把检测结果拼成一句给人看的提示(CLI / UI 共用) */
export function describeMissingChains(list: readonly MissingChain[]): string {
  if (list.length === 0) return '';
  const parts = list.map(m => `「${m.skillName}」的下位白「${m.prereqName}」`);
  return `检测到 ${list.length} 条没声明的上下位关系:${parts.join('、')}。` +
    `这两个技能都在你的候选列表里,但关系没声明 —— 金技能的价格已含下位白,` +
    `不声明就会把白再算一次钱(实测最大影响 0.6 马身)。请重新读取或手动补上这条关系。`;
}
