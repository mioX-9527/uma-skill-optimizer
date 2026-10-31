"""match.py 的回归测试(不需要模拟器/截图,纯逻辑)。

跑法:`python app/tests/test_match.py`
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from app.match import (  # noqa: E402
    Row, SkillIndex, UniqueIndex, base_name, match_owned, match_row, normalize,
    resolve_rows, strip_owned_badge, to_plan_skills,
)

INDEX = SkillIndex.load()
UQ = UniqueIndex.load()
FAILS: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    if cond:
        print(f"  ok   {name}")
    else:
        print(f"  FAIL {name}  {detail}")
        FAILS.append(name)


def main() -> int:
    print("normalize / base_name")
    check("句号归一成圈", normalize("弯道恢复。") == "弯道恢复○", normalize("弯道恢复。"))
    check("去空格小写", normalize(" 中距离 直线◎ ") == "中距离直线◎")
    check("base_name 去符号", base_name("中距离直线◎") == "中距离直线")
    check("base_name 无符号不变", base_name("迅疾如风") == "迅疾如风")

    print("单行匹配")
    m = match_row(Row(name_text="迅疾如风", price_text="200"), INDEX)
    check("精确命中唯一技能", m.skill is not None and m.skill.name == "迅疾如风" and not m.needs_confirm,
          str(m))

    m = match_row(Row(name_text="弯道恢复。", price_text="90"), INDEX)  # OCR 把 ○ 认成句号
    check("○→。仍能命中 弯道恢复○", m.skill is not None and m.skill.name == "弯道恢复○", str(m))

    m = match_row(Row(name_text="中距离直线", price_text="130"), INDEX)  # ◎ 被 OCR 吃掉
    check("缺符号时不硬猜:标需确认并给备选",
          m.needs_confirm and {a.name for a in m.alternatives} | {m.skill.name} >= {"中距离直线◎", "中距离直线○"},
          str(m))

    m = match_row(Row(name_text="中距离直钱◎", price_text="130"), INDEX)  # 错别字
    check("错别字走模糊匹配到◎", m.skill is not None and m.skill.name == "中距离直线◎", str(m))

    # × 类减益技能(效果全为负的被动)玩家买不到,索引里不该有它;
    # OCR 真读成「直线赛道×」时,正确行为是退回 ○ 并标需确认
    m = match_row(Row(name_text="直线赛道×", price_text="40"), INDEX)
    check("× 类减益不在索引里,退回 ○ 并需确认",
          m.skill is not None and m.skill.name == "直线赛道○" and m.needs_confirm, str(m))
    check("直线赛道× 本身查不到", not INDEX.exact("直线赛道×"))

    # ○ 和 ◎ 在界面上是**同一格**(○ 是 ◎ 的下位,买了 ○ 同格才变 ◎),
    # 所以"同名两行"根本不会出现。符号由 symbol.py 的形状检测给出。
    print("符号由形状检测给出(OCR 读不出 ○)")
    m = match_row(Row(name_text="中距离直线", price_text="130", symbol="◎"), INDEX)
    check("检测到 ◎ → 直接命中双圈,不需要确认",
          m.skill is not None and m.skill.name == "中距离直线◎" and not m.needs_confirm, str(m))
    m = match_row(Row(name_text="中距离直线", price_text="90", symbol="○"), INDEX)
    check("检测到 ○ → 直接命中单圈",
          m.skill is not None and m.skill.name == "中距离直线○" and not m.needs_confirm, str(m))
    m = match_row(Row(name_text="中距离直线", price_text="90", symbol="◎", symbol_confident=False), INDEX)
    check("◎ 是推断值(暂无真样本)→ 命中但标需确认",
          m.skill is not None and m.skill.name == "中距离直线◎" and m.needs_confirm, str(m))

    print("符号检测不出来时才标待确认(不按价格瞎配)")
    single = resolve_rows([Row(name_text="中距离直线", price_text="130")], INDEX)
    check("没符号的裸名字仍是 needs_confirm", single[0].needs_confirm, str(single[0]))

    print("已获得(灰显)不进 plan")
    rows = [Row(name_text="迅疾如风", price_text="200", grayed=False),
            Row(name_text="中距离直线○", price_text="90", grayed=True)]
    plan = to_plan_skills(resolve_rows(rows, INDEX))
    check("灰显被过滤", len(plan) == 1 and plan[0]["name"] == "迅疾如风", str(plan))
    check("plan 字段与 plan.json 同格式", set(plan[0]) == {"id", "name", "pt"}, str(plan[0]))

    print("未实装的日服技能不参与匹配")
    jp_only = None
    for s in INDEX.skills:
        pass
    import json
    raw = json.loads((Path(__file__).resolve().parents[2] / "data" / "skills.json").read_text(encoding="utf-8"))
    cn_names = {normalize(s["name"]) for s in raw if s.get("cnReleased") is not False}
    for s in raw:
        if s.get("cnReleased") is False and normalize(s["name"]) not in cn_names:
            jp_only = s["name"]
            break
    check("数据里存在仅日服的技能(测试前提)", jp_only is not None, str(jp_only))
    if jp_only:
        check("仅日服技能不命中", INDEX.exact(jp_only) == [], jp_only)

    print("固有技能只能命中继承版")
    # 购买界面能学到的固有技能一定是继承版(uniqueHeir),数值只有本体的 50~60%。
    # 本体的名字不带「(继承)」,OCR 读到的也是不带后缀的名字,所以很容易误命中本体。
    m = match_row(Row(name_text="向着，更远的地方……", price_text="130"), INDEX)
    check("命中 900591(继承)而不是 100591(本体)",
          m.skill is not None and m.skill.id == "900591", str(m))
    check("稀有度是 uniqueHeir", m.skill is not None and m.skill.rarity == "uniqueHeir", str(m))
    check("索引里没有 unique1~6 本体",
          not any(r.rarity in {f"unique{i}" for i in range(1, 7)} for r in INDEX.skills))
    # 直接拿本体 id 去查不该命中
    check("本体 id 100591 不在索引里", not any(r.id == "100591" for r in INDEX.skills))

    print("背景技能:固有本体索引 + 已学行匹配")
    # 购买页顶部显示的是**本体固有**(默认已获得、带等级),SkillIndex 故意不收它,
    # 所以要单独一个不过滤 unique1~6 的索引(UniqueIndex)。
    ref = UQ.exact("时来运转，龙腾九霄")
    check("固有本体精确命中 100981", ref is not None and ref.id == "100981", str(ref))
    check("继承版不在固有索引里(900981 是 uniqueHeir)",
          UQ.exact("璀璨流星(继承)") is None or UQ.exact("璀璨流星(继承)").id != "900981")
    check("固有索引里没有 uniqueHeir",
          all(not r.rarity.startswith("uniqueHeir") for r in
              [UQ.exact(n) for n in ("时来运转，龙腾九霄")] if r))
    check("strip_owned_badge 剥角标", strip_owned_badge("已获得时来运转，龙腾九霄") == "时来运转，龙腾九霄")
    ref = match_owned("已获得时来运转，龙腾九霄", INDEX, UQ)
    check("match_owned:带角标的固有命中本体", ref is not None and ref.id == "100981", str(ref))
    ref = match_owned("迅疾如风", INDEX, UQ)
    check("match_owned:普通已学技能命中", ref is not None and ref.name == "迅疾如风", str(ref))
    ref = match_owned("中距离直线", INDEX, UQ)
    check("match_owned:同名多等级(○/◎)拿不准不猜", ref is None, str(ref))
    ref = match_owned("本场比赛中速度略有提升", INDEX, UQ)
    check("match_owned:描述文字匹配不上返回 None", ref is None, str(ref))

    print()
    if FAILS:
        print(f"失败 {len(FAILS)} 项:{', '.join(FAILS)}")
        return 1
    print("全部通过")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
