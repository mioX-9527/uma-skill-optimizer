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

from app.capture import cart_state_from_lum  # noqa: E402
from app.select import (  # noqa: E402
    _clean, _pick, _taps_of, _targets_of, base_name, circle_family, row_key,
)


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


def test_circle_pair_merges_into_two_taps() -> None:
    """○ 和 ◎ 同时出现在推荐里 = 同一格点两下,不是"同名歧义"。

    2026-10-27 真机回放:优化器把"买 ○ 再升 ◎"当两笔选进推荐(chosen 里
    `跟前弯道○` 与 `跟前弯道◎` 都在,各有自己的价),旧代码按同名歧义处理 →
    只点了 1 下,双圈永远勾不上。这一条就是那个 bug 的回归测试。
    """
    ts = _targets_of([
        {"name": "跟前弯道○", "pt": 71},
        {"name": "跟前弯道◎", "pt": 76},
    ])
    assert len(ts) == 1, ts
    assert ts[0].taps == 2
    assert ts[0].display == "跟前弯道◎"      # 日志里报双圈那个名字
    # 反过来的顺序也要合并
    ts = _targets_of([{"name": "跟前弯道◎", "pt": 76}, {"name": "跟前弯道○", "pt": 71}])
    assert len(ts) == 1 and ts[0].taps == 2


def test_same_name_different_branch_stays_ambiguous() -> None:
    """库里的 (1)/(2) 是真·同名两行,不能合并成"点两下"。"""
    ts = _targets_of([
        {"name": "奇点(1)", "pt": 216},
        {"name": "奇点(2)", "pt": 180},
    ])
    assert len(ts) == 2
    assert ts[0].base == ts[1].base
    assert ts[0].family != ts[1].family
    assert all(t.taps == 1 for t in ts)
    # 单圈/双圈的 family 相同
    assert circle_family("跟前弯道○") == circle_family("跟前弯道◎") != circle_family("奇点(1)")


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


def test_cart_state_threshold() -> None:
    """「确定」按钮亮度 → 购物车空不空(实测 L 亮度:空车 103 / 有东西 165)。"""
    assert cart_state_from_lum(103.0, 135) is True
    assert cart_state_from_lum(165.0, 135) is False
    assert cart_state_from_lum(135.0, 135) is False     # 卡在边界上按"有东西"处理,宁可拦住
    assert cart_state_from_lum(None, 135) is None       # 读不到就不能乱判


if __name__ == "__main__":
    test_clean_strips_circle_symbols()
    test_base_name_strips_library_suffixes()
    test_row_key_is_normalized()
    test_taps_of()
    test_targets_of_accepts_names_and_dicts()
    test_circle_pair_merges_into_two_taps()
    test_same_name_different_branch_stays_ambiguous()
    test_pick_disambiguates_by_price()
    test_cart_state_threshold()
    print("OK: select.py 纯函数测试通过(9 项)")
