"""app/select.py 的纯函数测试(不碰模拟器)。

真机勾选只能现场验,但"名字怎么对齐""双圈该点几下"错了会点错技能或漏点,必须钉住。

**这组用例是 2026-10-27 两次实测漏勾的回放**:
- 库里叫「璀璨流星(继承)」,游戏列表里叫「璀璨流星」 → 精确比对全断,一个都勾不上。
- 库里 `决不让出领头的景色……！(继承)(1)/(2)` 剥完尾缀撞名 → 必须按标价消歧。

跑法:`python app/tests/test_select.py`
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from app.select import _clean, _pick, _taps_of, _targets_of, base_name, row_key  # noqa: E402


def test_clean_strips_circle_symbols() -> None:
    # OCR 读不出 ○/◎,行名字里只有基名,所以对位前必须剥掉
    assert _clean("良场地○") == "良场地"
    assert _clean("良场地◎") == "良场地"
    assert _clean(" 中山赛场○ ") == "中山赛场"
    assert _clean("先走一步！") == "先走一步！"


def test_base_name_strips_library_suffixes() -> None:
    # 「(继承)」是库内尾缀,游戏列表里没有 → 不剥就永远匹配不上
    assert base_name("璀璨流星(继承)") == "璀璨流星"
    assert base_name("向着，更远的地方……(继承)") == "向着，更远的地方……"
    # 同名分支的序号也是库内尾缀
    assert base_name("决不让出领头的景色……！(继承)(1)") == "决不让出领头的景色……！"
    assert base_name("Seirios(继承)(1)") == "Seirios"
    assert base_name("博弈者(1)") == "博弈者"
    # 全角括号也要吃
    assert base_name("红焰档/LP1211-M（继承）") == "红焰档/LP1211-M"
    # 双圈 + 继承同时出现,顺序不能错
    assert base_name("良场地(继承)◎") == "良场地"
    assert base_name(" 良场地◎ ") == "良场地"


def test_row_key_is_normalized() -> None:
    # 行名与库名都可能被 OCR 读歪:省略号/全半角/大小写都要归一
    assert row_key("璀璨流星(继承)") == row_key("璀璨流星")
    assert row_key("向着，更远的地方……(继承)") == row_key("向着,更远的地方...")
    assert row_key("Seirios◎") == row_key("seirios")


def test_taps_of() -> None:
    # 双圈要点两下:先单圈、再双圈;其余一下
    assert _taps_of("良场地◎") == 2
    assert _taps_of("良场地○") == 1
    assert _taps_of("先走一步！") == 1
    assert _taps_of("巅峰之梦") == 1
    # 继承版双圈同样两下(尾缀不影响判断顺序)
    assert _taps_of("良场地(继承)◎") == 2


def test_targets_of_accepts_names_and_dicts() -> None:
    ts = _targets_of(["良场地◎", {"name": "璀璨流星(继承)", "pt": 140}])
    assert [t.display for t in ts] == ["良场地◎", "璀璨流星(继承)"]
    assert [t.base for t in ts] == [row_key("良场地"), row_key("璀璨流星")]
    assert [t.taps for t in ts] == [2, 1]
    assert ts[1].pt == 140
    # 同一个技能传两遍只算一次(否则第二次会把 ◎ 也点上)
    assert len(_targets_of(["良场地○", "良场地○"])) == 1
    # 空名字直接丢掉
    assert _targets_of([""]) == []


def test_pick_disambiguates_by_price() -> None:
    # 库里「(1)/(2)」两条剥完尾缀同名,游戏里只有一行 → 按标价认
    ts = _targets_of([
        {"name": "决不让出领头的景色……！(继承)(1)", "pt": 200},
        {"name": "决不让出领头的景色……！(继承)(2)", "pt": 180},
    ])
    assert len(ts) == 2 and ts[0].base == ts[1].base
    assert _pick(ts, 180).pt == 180
    assert _pick(ts, 200).pt == 200
    # 标价对不上 / 没给价 → 取第一条(后面会明说"其余同名条目没勾")
    assert _pick(ts, None) is ts[0]
    assert _pick(ts, 999) is ts[0]
    # 只有一个候选时不用看价
    assert _pick(ts[:1], None) is ts[0]


if __name__ == "__main__":
    test_clean_strips_circle_symbols()
    test_base_name_strips_library_suffixes()
    test_row_key_is_normalized()
    test_taps_of()
    test_targets_of_accepts_names_and_dicts()
    test_pick_disambiguates_by_price()
    print("OK: select.py 纯函数测试通过(6 项)")
