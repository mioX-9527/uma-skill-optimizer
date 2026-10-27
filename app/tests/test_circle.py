"""app/circle.py 的纯函数测试(不碰模拟器)。

真机流程(tap 加号 → 读数 → 撤回)只能现场验,但"哪些单圈值得探""价格文本怎么解析"
这两处错了会静默影响结果,必须钉住。

跑法(与其它测试一致,不依赖 pytest):`python app/tests/test_circle.py`
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from app.circle import load_missing_circle_bases, parse_price  # noqa: E402


def test_parse_price() -> None:
    assert parse_price("66") == 66
    assert parse_price(" 99 ") == 99
    assert parse_price("110pt") == 110
    assert parse_price("") is None
    assert parse_price("已获得") is None


def test_missing_bases() -> None:
    miss = load_missing_circle_bases()
    # 2026-10-27 实测:国服可见 65 个 ◎ 里有 16 个缺基准价
    assert len(miss) == 16, f"缺价名单应为 16 个,实际 {len(miss)}"
    assert "长距离弯道" in miss
    assert "良场地" in miss
    # 价格齐的不该进来(否则会白点一次加号)
    assert "标准距离" not in miss
    assert "跟前弯道" not in miss
    # 名字里不带 ○/◎,与 OCR 读出来的名字对齐
    assert all(not n.endswith("○") and not n.endswith("◎") for n in miss)


if __name__ == "__main__":
    test_parse_price()
    test_missing_bases()
    print("OK: circle.py 纯函数测试通过(2 项)")
