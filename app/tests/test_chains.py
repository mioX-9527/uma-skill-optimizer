"""技能链的纯函数测试(不连真机、不读网络,毫秒级)。

背后是 2026-10-27 的一次真实事故:
    链是**三级** `良场地○(200152) → 良场地◎(200151) → 良场地恶煞(200154)`,
    而技能列表只显示当前可买的下一级 —— 这局 `良场地○` 和 `良场地恶煞` 在列表里,
    中间的 `良场地◎` 不在。
    `pairs_within` 按**直接前置**配,恶煞(前置=◎)永远配不上,于是推荐里同时留下
    「恶煞 284」和它的下位「良场地○ 81」;游戏里勾了恶煞之后良场地○ 变成「已获得」、
    加号点不动,合计多算 81pt —— 桌面显示「剩 1pt」,游戏实际剩 81pt。

所以这里锁两件事:
1. `pairs_within` **必须只看直接前置**(它的结果会变成 requires,参与价格与贪心排序);
2. `supersede_pairs` 做传递闭包,给出「谁覆盖谁」,只用于汇报口径。

跑法:`python app/tests/test_chains.py`
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from app.chains import _prereqs_in, pairs_within, supersede_pairs  # noqa: E402

FAILS: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    print(f"  {'ok  ' if ok else 'FAIL'} {name}  {detail}")
    if not ok:
        FAILS.append(name)


# 真实的三级链(取自 data/skill-chains.json)
CHAINS = {
    "200151": {"skillId": "200151", "prereqId": "200152"},   # 良场地◎ ← 良场地○
    "200154": {"skillId": "200154", "prereqId": "200151"},   # 良场地恶煞 ← 良场地◎
    # 一条普通的两级链(直接前置在池里)
    "201662": {"skillId": "201662", "prereqId": "201661"},   # 先走一步！ ← 游戏到此为止！
    # 一条孤立技能(没有任何前置)
    "999999": {"skillId": "999999", "prereqId": ""},
}


def main() -> int:
    print("pairs_within(只看直接前置)")
    # 中间级缺席:恶煞配不上,这是**有意为之** —— 它的结果会参与价格计算
    two = {("201662", "201661")}
    got = set(pairs_within({"200154", "200152"}, CHAINS))
    check("三级链不按传递闭包配对(价格口径不能变)", got == set(), str(got))
    check("(对照)直接前置在池里时正常配对", two == set(pairs_within({"201662", "201661"}, CHAINS)))
    check("孤立技能不产生配对", pairs_within({"999999"}, CHAINS) == [])

    print("supersede_pairs(传递闭包,只用于汇报)")
    got = dict(supersede_pairs({"200154", "200152"}, CHAINS))
    check("恶煞认出覆盖良场地○", got.get("200154") == "200152", str(got))
    check("中间级不在池里也能认出来", "200151" not in got, str(got))
    got2 = dict(supersede_pairs({"201662", "201661"}, CHAINS))
    check("两级链照样认", got2.get("201662") == "201661", str(got2))
    got3 = dict(supersede_pairs({"200152"}, CHAINS))
    check("只有下位、没有金时不产生覆盖", got3 == {}, str(got3))
    got4 = dict(supersede_pairs({"200154"}, CHAINS))
    check("只有金、没有下位时不产生覆盖", got4 == {}, str(got4))

    # 2026-10-28 用户指出:○ → ◎ → 金 是同一格"加钱一步步升级",金要覆盖**每一级**。
    # 只覆盖"第一个祖先"时,池里同时有 ○ 和 ◎ 就只删 ◎、漏掉 ○ → 金 + ○ 又叠加
    # (实测 56.5092s vs 只装金 56.5253s,收益虚高 0.16 马身、合计多算 81pt)。
    print("supersede_pairs(整条链,不只最近一级)")
    full = set(supersede_pairs({"200154", "200151", "200152"}, CHAINS))
    check("三级全在池里时,金覆盖 ◎ 和 ○,◎ 也覆盖 ○",
          full == {("200154", "200151"), ("200154", "200152"), ("200151", "200152")}, str(full))
    check("◎ 也覆盖 ○(同格升级)", set(supersede_pairs({"200151", "200152"}, CHAINS))
          == {("200151", "200152")})

    print("_prereqs_in(边界)")
    check("找不到返回空", _prereqs_in("999999", CHAINS, {"999999"}) == [])
    check("不在链表里返回空", _prereqs_in("888888", CHAINS, {"200152"}) == [])
    check("由近及远", _prereqs_in("200154", CHAINS, {"200152", "200151"}) == ["200151", "200152"])
    # 数据若出现环,不能死循环(limit 兜底)
    cyc = {"A": {"prereqId": "B"}, "B": {"prereqId": "A"}}
    check("环不会转死", _prereqs_in("A", cyc, {"A", "B"}) == ["B"])

    print()
    if FAILS:
        print(f"失败 {len(FAILS)} 项:{', '.join(FAILS)}")
        return 1
    print("全部通过")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
