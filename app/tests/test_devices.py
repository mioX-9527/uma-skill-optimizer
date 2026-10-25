"""设备列表的纯解析/去重测试(不连真机,毫秒级)。

这两段逻辑背后各有一个真机踩出来的坑,所以值得单独锁住:
1. `parse_describe` 靠 `M=` / `S=` 前缀取值,不按行号 —— 机型为空时 getprop 会输出空行。
2. `_dedupe_devices` 按 `ro.serialno` 去重 —— 同一台模拟器常同时挂在
   `127.0.0.1:5555` 和 `emulator-5554` 两个序列号下,下拉框会出现两条一模一样的选项。

跑法:`python app/tests/test_devices.py`
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from app.adb import parse_describe  # noqa: E402
from app.adb import dedupe_devices  # noqa: E402

FAILS: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    print(f"  {'ok  ' if ok else 'FAIL'} {name}  {detail}")
    if not ok:
        FAILS.append(name)


UMA_OUT = """M=PHM110
S=0098ea74
Physical size: 720x1280
  mCurrentFocus=Window{30e031d u0 com.bilibili.umamusu/com.manjuu.umamusu.MainActivity}
"""

AZUR_OUT = """M=PHM110
S=0098ea74
Physical size: 720x1280
  mCurrentFocus=Window{30e031d u0 com.bilibili.azurlane/com.manjuu.azurlane.MainActivity}
"""

# 机型读不到时 getprop 会吐一个空行;按行号取值会整体错位(实测)
EMPTY_MODEL_OUT = """M=
S=abcdef01
Physical size: 1080x1920
  mCurrentFocus=Window{1 u0 com.miHoYo.Yuanshen/com.x.MainActivity}
"""


def main() -> int:
    print("parse_describe")
    d = parse_describe(UMA_OUT)
    check("机型", d["model"] == "PHM110", d["model"])
    check("serialno(去重键)", d["serialno"] == "0098ea74", d["serialno"])
    check("分辨率", d["size"] == "720x1280", d["size"])
    check("前台包名", d["foreground"] == "com.bilibili.umamusu", str(d["foreground"]))
    check("认出是赛马娘", d["isUma"] is True and d["app"] == "赛马娘", str(d["app"]))

    a = parse_describe(AZUR_OUT)
    check("碧蓝航线不算赛马娘", a["isUma"] is False and a["app"] == "碧蓝航线", str(a["app"]))

    e = parse_describe(EMPTY_MODEL_OUT)
    check("机型为空时不错位", e["model"] == "" and e["serialno"] == "abcdef01", repr(e))
    check("认不出的包名原样显示", e["app"] == "com.miHoYo.Yuanshen" and e["isUma"] is False, e["app"])

    print("_dedupe_devices")
    same = [
        {"serial": "emulator-5554", "state": "device", "model": "PHM110", "serialno": "0098ea74"},
        {"serial": "127.0.0.1:5555", "state": "device", "model": "PHM110", "serialno": "0098ea74"},
    ]
    rows = dedupe_devices(same)
    check("同一台机器的两个序列号只留一个", len(rows) == 1, str(rows))
    check("保留 host:port(emulator-N 编号会随启动顺序变)", rows[0]["serial"] == "127.0.0.1:5555", rows[0]["serial"])

    distinct = [
        {"serial": "127.0.0.1:5555", "state": "device", "serialno": "aaa"},
        {"serial": "127.0.0.1:16384", "state": "device", "serialno": "bbb"},
    ]
    check("不同设备都保留", len(dedupe_devices(distinct)) == 2)

    no_serialno = [
        {"serial": "127.0.0.1:5555", "state": "offline"},
        {"serial": "127.0.0.1:5557", "state": "offline"},
    ]
    check("读不到 serialno 时按序列号区分,不误合并", len(dedupe_devices(no_serialno)) == 2)

    print()
    if FAILS:
        print(f"失败 {len(FAILS)} 项:{', '.join(FAILS)}")
        return 1
    print("全部通过")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
