"""技能上下位关系(金技能的「前置技能」)。

数据来自 `data/skill-chains.json`,由 `node tools/fetch-skill-chains.mjs` 从 BWIKI 的
SMW 查询生成(`[[前置技能::+]]|?前置技能|?技能消耗PT|?共需技能PT`)。

**为什么需要它(2026-10-25 用户点破 + 四条实测印证)**:
- 买了金技能的下位白技能后,金技能的标价会抵扣掉白的实付价;
- 更关键的是**列表里金技能显示的价格本身就是「前置价 + 金技能自己的折后价」**。
  实测四组,与 wiki 的原始价完全吻合:

      先走一步！  显示 304 = 前置「游戏到此为止！」160 + 160×0.9(=144)
      巅峰之梦    显示 320 = 前置「背负信念」200     + 200×0.6(=120)
      浑然忘我    显示 288 = 前置「不顾一切」180     + 180×0.6(=108)
      内侧体验    显示 304 = 前置「弯里横」160       + 160×0.9(=144)

  所以「金 304 + 前置 160 = 464」是**高估**,实际两者一起只要 304。
  反过来说:前置已经在列表里(说明还没买),金技能的显示价才含前置;
  前置不在列表里(已获得),显示价就是金技能自己的价 —— 「迅速果断 180」正是这种情况
  (它的前置「向前抢位」在界面上是已获得灰显)。
"""

from __future__ import annotations

import json
from pathlib import Path

CHAINS_PATH = Path(__file__).resolve().parent.parent / "data" / "skill-chains.json"


def load_chains(path: Path | None = None) -> dict[str, dict]:
    """返回 {金技能 id: chain 记录}。文件不存在时返回空(降级,不影响其余流程)。"""
    p = path or CHAINS_PATH
    if not p.is_file():
        return {}
    with open(p, encoding="utf-8") as fh:
        data = json.load(fh)
    out: dict[str, dict] = {}
    for c in data.get("chains", []):
        out.setdefault(str(c["skillId"]), c)
    return out


def pairs_within(ids: set[str], chains: dict[str, dict] | None = None) -> list[tuple[str, str]]:
    """挑出「金技能和它的前置都在候选里」的配对。

    只有这种配对才需要做价格扣减:前置在列表里说明没买过,金技能的显示价已经包含前置;
    前置不在列表里(已获得)时,显示价已经是纯金价,不能减。
    """
    cmap = chains if chains is not None else load_chains()
    out: list[tuple[str, str]] = []
    for gid, c in cmap.items():
        pid = str(c.get("prereqId") or "")
        if gid in ids and pid in ids:
            out.append((gid, pid))
    return out
