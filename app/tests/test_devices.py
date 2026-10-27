"""设备列表的纯解析/去重测试(不连真机,毫秒级)。

这几段逻辑背后各有一个真机踩出来的坑,所以值得单独锁住:
1. `parse_describe` 靠 `M=` / `S=` / `A=` 前缀取值,不按行号 —— 机型为空时 getprop 会输出空行。
2. `dedupe_devices` 按 `ro.serialno` → `android_id` 去重 —— 同一台模拟器常同时挂在
   `127.0.0.1:5555` / `7555` / `16384` / `emulator-5554` 好几个序列号下,下拉框会出现重复项。
   **实测这几台的 `ro.serialno` 全是空**,所以只按它去重等于没去重。
3. `local_ips` 只留私有地址 —— 代理软件的 TUN 地址(198.18.x.x)连过去会挂住。

跑法:`python app/tests/test_devices.py`
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from app.adb import _is_private_ipv4, dedupe_devices, parse_describe  # noqa: E402

FAILS: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    print(f"  {'ok  ' if ok else 'FAIL'} {name}  {detail}")
    if not ok:
        FAILS.append(name)


UMA_OUT = """M=PHM110
S=0098ea74
A=c8b49551f9a6d3f
Physical size: 720x1280
  mCurrentFocus=Window{30e031d u0 com.bilibili.umamusu/com.manjuu.umamusu.MainActivity}
"""

AZUR_OUT = """M=PHM110
S=0098ea74
A=c8b49551f9a6d3f
Physical size: 720x1280
  mCurrentFocus=Window{30e031d u0 com.bilibili.azurlane/com.manjuu.azurlane.MainActivity}
"""

# 机型读不到时 getprop 会吐一个空行;按行号取值会整体错位(实测)
EMPTY_MODEL_OUT = """M=
S=abcdef01
A=null
Physical size: 1080x1920
  mCurrentFocus=Window{1 u0 com.miHoYo.Yuanshen/com.x.MainActivity}
"""


def main() -> int:
    print("parse_describe")
    d = parse_describe(UMA_OUT)
    check("机型", d["model"] == "PHM110", d["model"])
    check("serialno(去重键)", d["serialno"] == "0098ea74", d["serialno"])
    check("android_id(serialno 为空时的去重键)", d["android_id"] == "c8b49551f9a6d3f", d["android_id"])
    check("分辨率", d["size"] == "720x1280", d["size"])
    check("前台包名", d["foreground"] == "com.bilibili.umamusu", str(d["foreground"]))
    check("认出是赛马娘", d["isUma"] is True and d["app"] == "赛马娘", str(d["app"]))

    a = parse_describe(AZUR_OUT)
    check("碧蓝航线不算赛马娘", a["isUma"] is False and a["app"] == "碧蓝航线", str(a["app"]))

    e = parse_describe(EMPTY_MODEL_OUT)
    check("机型为空时不错位", e["model"] == "" and e["serialno"] == "abcdef01", repr(e))
    check("android_id 是字符串 null 时当空处理", e["android_id"] == "", repr(e["android_id"]))
    check("认不出的包名原样显示", e["app"] == "com.miHoYo.Yuanshen" and e["isUma"] is False, e["app"])

    print("_dedupe_devices")
    same = [
        {"serial": "emulator-5554", "state": "device", "model": "PHM110", "serialno": "0098ea74"},
        {"serial": "127.0.0.1:5555", "state": "device", "model": "PHM110", "serialno": "0098ea74"},
    ]
    rows = dedupe_devices(same)
    check("同一台机器的两个序列号只留一个", len(rows) == 1, str(rows))
    check("保留 host:port(emulator-N 编号会随启动顺序变)", rows[0]["serial"] == "127.0.0.1:5555", rows[0]["serial"])

    # 真机实测的那一组:serialno 全空,只有 android_id 分得清
    real = [
        {"serial": "127.0.0.1:16384", "state": "device", "serialno": "", "android_id": "d88c4dca"},
        {"serial": "127.0.0.1:5555", "state": "device", "serialno": "", "android_id": "d88c4dca"},
        {"serial": "emulator-5554", "state": "device", "serialno": "", "android_id": "d88c4dca"},
        {"serial": "127.0.0.1:7555", "state": "device", "serialno": "", "android_id": "d88c4dca"},
        {"serial": "127.0.0.1:5557", "state": "device", "serialno": "", "android_id": "3f55c4a0"},
        {"serial": "192.168.197.224:5555", "state": "device", "serialno": "", "android_id": "c8b49551"},
    ]
    rows = dedupe_devices(real)
    check("serialno 全空时按 android_id 去重(6 条 → 3 台)", len(rows) == 3, str([r["serial"] for r in rows]))
    keep = {r["android_id"]: r["serial"] for r in rows}
    check("雷电那条(内网 IP)没被 127.0.0.1:5555 吃掉",
          keep.get("c8b49551") == "192.168.197.224:5555", str(keep))

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

    print("local_ips 地址过滤")
    check("10.x 算私有", _is_private_ipv4("10.0.2.15") is True)
    check("192.168.x 算私有", _is_private_ipv4("192.168.197.224") is True)
    check("172.16~31 算私有", _is_private_ipv4("172.20.0.1") is True)
    check("172.32 不算私有", _is_private_ipv4("172.32.0.1") is False)
    check("代理 TUN 的 198.18.x 不算私有", _is_private_ipv4("198.18.0.1") is False)
    check("回环不算私有", _is_private_ipv4("127.0.0.1") is False)

    print()
    if FAILS:
        print(f"失败 {len(FAILS)} 项:{', '.join(FAILS)}")
        return 1
    print("全部通过")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
