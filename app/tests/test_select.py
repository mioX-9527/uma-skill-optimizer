"""app/select.py 的纯函数测试(不碰模拟器)。

真机勾选只能现场验,但"名字怎么对齐""双圈该点几下"错了会点错技能或漏点,必须钉住。

跑法:`python app/tests/test_select.py`
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from app.select import _clean, _taps_of  # noqa: E402


def test_clean_strips_circle_symbols() -> None:
    # OCR 读不出 ○/◎,行名字里只有基名,所以对位前必须剥掉
    assert _clean("良场地○") == "良场地"
    assert _clean("良场地◎") == "良场地"
    assert _clean(" 中山赛场○ ") == "中山赛场"
    assert _clean("先走一步！") == "先走一步！"


def test_taps_of() -> None:
    # 双圈要点两下:先单圈、再双圈;其余一下
    assert _taps_of("良场地◎") == 2
    assert _taps_of("良场地○") == 1
    assert _taps_of("先走一步！") == 1
    assert _taps_of("巅峰之梦") == 1


if __name__ == "__main__":
    test_clean_strips_circle_symbols()
    test_taps_of()
    print("OK: select.py 纯函数测试通过(2 项)")
