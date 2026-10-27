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

    **只看直接前置**(不要改成沿链往上找):这个结果会变成优化器的 `requires`,
    而 `requires` 参与价格与贪心排序。改成传递闭包会连带改掉价格口径,
    实测那局收益从 12.76 掉到 12.57 —— 见 `supersede_pairs` 的说明。
    """
    cmap = chains if chains is not None else load_chains()
    out: list[tuple[str, str]] = []
    for gid, c in cmap.items():
        pid = str(c.get("prereqId") or "")
        if gid in ids and pid in ids:
            out.append((gid, pid))
    return out


def supersede_pairs(ids: set[str], chains: dict[str, dict] | None = None) -> list[tuple[str, str]]:
    """挑出「上位在、它的某个下位也在」的覆盖关系:`(上位, 下位)`,**每一级都给一对**。

    两条来由,都是真机踩出来的:

    1. 金技能覆盖下位(2026-10-27):链可能是三级的
       `良场地○ → 良场地◎ → 良场地恶煞`,而列表里**只显示当前可买的下一级** ——
       这局 `良场地○` 和 `良场地恶煞` 在列表里,中间的 `良场地◎` 不在。
       `pairs_within` 按直接前置配,恶煞永远配不上,于是推荐里同时留下
       「恶煞 284」和它的下位「良场地○ 81」:游戏里勾了恶煞之后,良场地○ 那一行
       变成「已获得」、加号点不动,合计因此多算 81pt。

    2. **只给"第一个"祖先不够**(2026-10-28 用户指出):`○ → ◎ → 金` 本质是
       同一格"加钱一步步升上来"的三级,金在最顶端,覆盖下面**每一级**。
       上一版只覆盖第一个在池里的祖先,于是池里同时有 ○ 和 ◎ 时(现场读到双圈价
       就是这种情况)只覆盖了 ◎、○ 漏掉 —— 金 + ○ 又一起生效,
       实测 56.5092s vs 只装金 56.5253s,收益虚高 0.16 马身。
       所以这里返回**全部**在池祖先。

    这个判断本身是安全的:祖先在列表里说明它没买过 → 按购买顺序它下面那些中间层
    也一定没买过 → 上位技能的显示价必然含全部前置,下位不必单独买。
    """
    cmap = chains if chains is not None else load_chains()
    out: list[tuple[str, str]] = []
    for gid in ids:
        for pid in _prereqs_in(gid, cmap, ids):
            out.append((gid, pid))
    return out


def _prereqs_in(gid: str, cmap: dict[str, dict], ids: set[str],
                limit: int = 8) -> list[str]:
    """沿前置链一路往上,返回**所有**在候选池里的祖先(由近及远)。

    `limit` 是防呆:数据若有环(不该有)也不会转死循环。
    """
    out: list[str] = []
    cur = cmap.get(gid)
    seen: set[str] = {gid}
    for _ in range(limit):
        if cur is None:
            break
        pid = str(cur.get("prereqId") or "")
        if not pid or pid in seen:
            break
        if pid in ids:
            out.append(pid)
        seen.add(pid)
        cur = cmap.get(pid)
    return out
