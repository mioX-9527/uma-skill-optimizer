"""ADB 封装:连接模拟器、取帧、滑动。

设计约束(均为实测得出,别随意改):
- 720x1280 屏下 `exec-out screencap -p` 约 0.9~1.1s/帧,瓶颈在模拟器侧 screencap 本身,
  所以一次流程里每抓一帧都要算进预算,不要为了"稳妥"多抓。
- raw 帧(不带 -p)同样耗时且体积 3.7MB,PNG 只用 420KB,故一律用 -p。
- 雷电自带 adb(与设备 SDK 28 同代)比 platform-tools 新版更稳,优先用它。

**为什么要有设备列表(`list_devices`)**:多个模拟器同时开着时,`adb devices` 会列出好几条,
而哪台有赛马娘跟序列号完全对不上 —— 实测踩过一次:默认写死的 `127.0.0.1:5555` 当天其实是
MuMu(前台碧蓝航线),雷电在 16384,于是"读取不了"查了半天。所以一律**先列设备、让用户选**,
并且把每台的前台应用一起显示出来(前台是赛马娘的那台会标出来)。
"""

from __future__ import annotations

import io
import os
import re
import shutil
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass

from PIL import Image

# 兜底序列号(单实例、且只有一台在线时才会用到;正常走「先选设备」)
DEFAULT_SERIAL = "127.0.0.1:5555"
LDPPLAYER_ADB_CANDIDATES = (
    r"E:\leidian\LDPlayer9\adb.exe",
    r"C:\leidian\LDPlayer9\adb.exe",
    r"D:\leidian\LDPlayer9\adb.exe",
)

# 常见模拟器的默认 adb 端口。启动后不一定会自动进 adb 的服务器列表,列设备前顺手连一遍
# (端口没人监听时 connect 会立刻失败,不拖时间)。
#   雷电 实例 0 = 5555,实例 N = 5555+2N;MuMu 6 = 7555;MuMu 12 = 16384;
#   夜神 = 62001/62025;BlueStacks = 5565。
# 注意:端口 ≠ 模拟器品牌(实测见过 5555 被 MuMu 占着),所以**只用来连,不用来贴标签**。
CANDIDATE_PORTS = (5555, 5557, 5559, 7555, 16384, 62001, 62025, 5565)

# 认得出来的游戏包名(只用于给人看的标签,认不出就原样显示包名)
UMA_PACKAGES = ("com.bilibili.umamusu", "jp.co.cygames.umamusume")
PACKAGE_LABELS = {
    "com.bilibili.umamusu": "赛马娘",
    "jp.co.cygames.umamusume": "赛马娘(日服)",
    "com.bilibili.azurlane": "碧蓝航线",
}


class AdbError(RuntimeError):
    """ADB 操作失败(已转成给人看的中文说明)"""


@dataclass(frozen=True)
class ScreenMeta:
    width: int
    height: int
    density: int
    serial: str

    @property
    def size(self) -> tuple[int, int]:
        return (self.width, self.height)


def find_adb() -> str:
    """按优先级找 adb:雷电自带 > PATH。找不到就报清楚让人自己装。"""
    for path in LDPPLAYER_ADB_CANDIDATES:
        if os.path.isfile(path):
            return path
    found = shutil.which("adb")
    if found:
        return found
    raise AdbError(
        "找不到 adb。请确认雷电模拟器装着(预期路径 E:\\leidian\\LDPlayer9\\adb.exe),"
        "或把 platform-tools 加进 PATH。"
    )


class Adb:
    def __init__(self, serial: str = DEFAULT_SERIAL, adb_path: str | None = None, timeout: float = 30.0):
        self.serial = serial
        self.adb = adb_path or find_adb()
        self.timeout = timeout

    # ── 底层 ────────────────────────────────────────────────
    def _run(self, *args: str, binary: bool = False, timeout: float | None = None) -> bytes | str:
        cmd = [self.adb, "-s", self.serial, *args]
        try:
            proc = subprocess.run(
                cmd, capture_output=True, timeout=timeout or self.timeout, check=False
            )
        except FileNotFoundError as exc:  # adb 路径错
            raise AdbError(f"adb 无法执行:{self.adb}") from exc
        except subprocess.TimeoutExpired as exc:
            raise AdbError(f"adb 命令超时:{' '.join(args)}") from exc
        if proc.returncode != 0:
            msg = proc.stderr.decode("utf-8", "ignore").strip() or proc.stdout.decode("utf-8", "ignore").strip()
            raise AdbError(f"adb {' '.join(args)} 失败:{msg}")
        return proc.stdout if binary else proc.stdout.decode("utf-8", "ignore")

    def shell(self, *args: str) -> str:
        return str(self._run("shell", *args))

    def foreground_package(self) -> str:
        """前台应用包名(只用于报错时给出线索)。读不到返回空串,不抛。"""
        try:
            out = self.shell("dumpsys window | grep mCurrentFocus")
        except AdbError:
            return ""
        m = re.search(r"mCurrentFocus=Window\{[^}]*?\s+([\w.]+)/", out)
        return m.group(1) if m else ""

    # ── 连接 ────────────────────────────────────────────────
    def connect(self) -> ScreenMeta:
        """连上并确认设备在线;返回屏幕信息。"""
        out = str(self._run("connect", self.serial, timeout=10))
        if "cannot" in out or "failed" in out:
            raise AdbError(f"连不上 {self.serial}:{out.strip()}\n  确认模拟器已启动,且该实例开着 ADB 调试。")
        # get-state 是 adb 宿主命令,不是设备 shell 命令(写成 shell get-state 会报 not found)
        state = str(self._run("get-state", timeout=10)).strip()
        if state != "device":
            raise AdbError(f"{self.serial} 状态是 {state!r}(应为 device),可能未授权或正在启动。")
        return self.meta()

    def meta(self) -> ScreenMeta:
        w, h = 0, 0
        m = re.search(r"(?:Override|Physical) size:\s*(\d+)x(\d+)", self.shell("wm", "size"))
        if m:
            w, h = int(m.group(1)), int(m.group(2))
        m = re.search(r"(?:Override|Physical) density:\s*(\d+)", self.shell("wm", "density"))
        density = int(m.group(1)) if m else 0
        if w <= 0 or h <= 0:
            raise AdbError("读不到屏幕分辨率(`wm size` 输出异常)。")
        return ScreenMeta(width=w, height=h, density=density, serial=self.serial)

    # ── 取帧 ────────────────────────────────────────────────
    def screencap(self) -> Image.Image:
        """PNG 帧,约 0.9~1.1s。返回值不含 alpha(游戏是不透明画面)。"""
        raw = self._run("exec-out", "screencap", "-p", binary=True)
        if not raw or raw[:8] != b"\x89PNG\r\n\x1a\n":
            raise AdbError("截图失败(返回的不是 PNG)。可能是模拟器卡顿,重试一次。")
        return Image.open(io.BytesIO(raw)).convert("RGB")

    def screencap_bytes(self) -> bytes:
        return bytes(self._run("exec-out", "screencap", "-p", binary=True))

    # ── 操作 ────────────────────────────────────────────────
    def tap(self, x: int, y: int) -> None:
        """点按坐标。只用于打开/关闭「技能进化」这类纯查看弹窗,不做任何会改存档的操作。"""
        self.shell("input", "tap", str(x), str(y))

    def swipe(self, x1: int, y1: int, x2: int, y2: int, duration_ms: int = 250) -> None:
        self.shell("input", "swipe", str(x1), str(y1), str(x2), str(y2), str(duration_ms))

    def swipe_vertical(self, meta: ScreenMeta, from_ratio: float, to_ratio: float, duration_ms: int = 250) -> None:
        """竖屏纵向滑动;x 取屏幕中线,ratio 是 y 相对屏高的比例。"""
        x = meta.width // 2
        self.swipe(x, int(meta.height * from_ratio), x, int(meta.height * to_ratio), duration_ms)

    def settle(self, seconds: float = 0.45) -> None:
        """滑动后等惯性停下再截图,否则会截到滚动模糊/错位。"""
        time.sleep(seconds)


def probe(serial: str = DEFAULT_SERIAL) -> dict:
    """连通性自检,给 CLI 的 doctor 子命令用。"""
    adb = Adb(serial)
    meta = adb.connect()
    t0 = time.perf_counter()
    img = adb.screencap()
    cost = time.perf_counter() - t0
    return {
        "adb": adb.adb,
        "serial": meta.serial,
        "size": f"{meta.width}x{meta.height}",
        "density": meta.density,
        "frame_ms": round(cost * 1000),
        "frame_size": img.size,
        "android": adb.shell("getprop", "ro.build.version.release").strip(),
    }


# ── 设备列表(多模拟器共存时用)─────────────────────────────────
def connect_candidates(adb_path: str, timeout: float = 1.5) -> None:
    """对常见模拟器端口挨个 `adb connect`,**并行**且超时很短。

    为什么要并行 + 短超时:端口没人监听时 adb 会立刻失败,但**端口有程序监听却不讲 adb 协议**
    (模拟器未启动完 / 别的服务占了端口)时,adb 会一直等到超时 —— 串行 8 个端口实测要 14s,
    整个界面像卡死。并行后最多 ~1.5s。
    """
    def one(port: int) -> None:
        try:
            subprocess.run(
                [adb_path, "connect", f"127.0.0.1:{port}"],
                capture_output=True, timeout=timeout, check=False,
            )
        except (OSError, subprocess.TimeoutExpired):
            pass

    with ThreadPoolExecutor(max_workers=len(CANDIDATE_PORTS)) as pool:
        list(pool.map(one, CANDIDATE_PORTS))


def _raw_devices(path: str) -> list[dict]:
    try:
        proc = subprocess.run([path, "devices", "-l"], capture_output=True, timeout=20, check=False)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise AdbError(f"列不出设备(`adb devices -l` 失败):{exc}") from exc
    out = proc.stdout.decode("utf-8", "ignore")
    devs: list[dict] = []
    for line in out.splitlines()[1:]:
        line = line.strip()
        if not line or line.startswith("*"):
            continue
        parts = line.split()
        if len(parts) < 2:
            continue
        model = ""
        for p in parts[2:]:
            if p.startswith("model:"):
                model = p[len("model:"):]
        devs.append({"serial": parts[0], "state": parts[1], "model": model})
    return devs


def list_devices(adb_path: str | None = None, connect: str | bool = "auto") -> list[dict]:
    """`adb devices -l` 的解析结果:[{serial, state, model}]。

    `connect`:
      - `"auto"`(默认):**只有一台在线设备都没有时**才去扫端口。常见情况省掉 1.5s。
      - `True`:强制扫一遍(界面上的「刷新设备」按钮用它,模拟器刚启动/掉线时能捞回来)。
      - `False`:只列,不连。

    `state` 里常见 `device` / `offline` / `unauthorized`;后两者仍要列出来,
    否则用户会以为"模拟器没开",其实是 adb 连接掉了或者没点授权。
    """
    path = adb_path or find_adb()
    devs = _raw_devices(path)
    need_sweep = connect is True or (connect == "auto" and not any(d["state"] == "device" for d in devs))
    if need_sweep:
        connect_candidates(path)
        devs = _raw_devices(path)
    return devs


def resolve_serial(serial: str | None = None) -> str:
    """决定读哪台设备。CLI 和桌面壳共用这一份逻辑。

    优先级:显式指定 > 只有一台在线就用它 > 多台时挑前台是赛马娘的那台 > 报错让人选。
    **不瞎猜**:多台又都不像赛马娘时宁可报错 —— 猜错的话会去读另一台模拟器的画面,
    报出来的是"横屏/读不到技能行",比"请选一台设备"难查得多。
    """
    if serial:
        return serial
    devs = [d for d in list_devices() if d["state"] == "device"]
    if not devs:
        raise AdbError(
            "一台在线的模拟器都没有。先启动模拟器(雷电/MuMu 都行),确认它开着 ADB 调试,"
            "再试一次;也可以用 `python -m app.cli devices` 看当前能连到哪些。"
        )
    if len(devs) == 1:
        return devs[0]["serial"]
    for d in devs:
        if describe(d["serial"]).get("isUma"):
            return d["serial"]
    raise AdbError(
        "有多台设备在线,而且没有一台的前台是赛马娘,请用 --serial 指定一台:\n"
        + "\n".join(f"  {d['serial']}  {d['model']}" for d in devs)
    )


def dedupe_devices(rows: list[dict]) -> list[dict]:
    """同一台模拟器常同时挂在 `127.0.0.1:5555` 和 `emulator-5554` 两个序列号下
    (实测:名字不同、`ro.serialno` 一样、前台应用一样)。不去重会在下拉框里出现
    两条一模一样的选项,用户会以为有两个模拟器。

    保留哪一个:`host:port` 优先 —— `emulator-5554` 这种编号会随启动顺序变,不适合存进配置。
    需要 `serialno` 字段(由 `describe` / `parse_describe` 提供);没有就退化成按序列号区分。
    """
    kept: dict[str, dict] = {}
    order: list[str] = []
    for row in rows:
        key = row.get("serialno") or row["serial"]
        prev = kept.get(key)
        if prev is None:
            kept[key] = row
            order.append(key)
        elif ":" in row["serial"] and ":" not in prev["serial"]:
            kept[key] = row
    return [kept[k] for k in order]


def parse_describe(out: str) -> dict:
    """解析 `describe` 的那条复合 shell 输出(单独拆出来是为了能跑假数据测试)。

    形如:
        M=PHM110
        S=0098ea74
        Physical size: 720x1280
        mCurrentFocus=Window{30e031d u0 com.bilibili.umamusu/com.xxx.MainActivity}
    """
    model = (re.search(r"^M=(.*)$", out, re.M) or [None, ""])[1].strip()
    serialno = (re.search(r"^S=(.*)$", out, re.M) or [None, ""])[1].strip()
    m = re.search(r"(\d+)x(\d+)", out)
    size = f"{m.group(1)}x{m.group(2)}" if m else ""
    fg = re.search(r"mCurrentFocus=Window\{[^}]*?\s+([\w.]+)/", out)
    pkg = fg.group(1) if fg else None
    return {
        "model": model,
        "serialno": serialno,
        "size": size,
        "foreground": pkg,
        "app": PACKAGE_LABELS.get(pkg or "", pkg or ""),
        "isUma": pkg in UMA_PACKAGES,
    }


def describe(serial: str, adb_path: str | None = None, timeout: float = 8.0) -> dict:
    """补一屏信息:机型 / 设备唯一序列号 / 分辨率 / 前台应用。**一次 shell 调用拿全**(省往返)。

    前台应用是关键信息 —— 多个模拟器同时开着时,只有它是"这台是不是赛马娘"的可靠信号。
    `ro.serialno` 用来**去重**:同一台模拟器常常同时挂在 `127.0.0.1:5555` 和
    `emulator-5554` 两个序列号下(实测两台名字不同、serialno 一样),不去重会在下拉框里
    出现两条一模一样的选项。

    解析用 `M=` / `S=` 前缀而不是按行号取值:机型为空时 getprop 会输出空行,
    按行号取会整体错位。
    """
    adb = Adb(serial, adb_path=adb_path, timeout=timeout)
    try:
        # `$(...)` 由设备端的 sh 展开,不经 Windows 的 shell
        out = adb.shell(
            "echo M=$(getprop ro.product.model); echo S=$(getprop ro.serialno); "
            "wm size; dumpsys window | grep mCurrentFocus"
        )
    except AdbError as exc:
        return {"error": str(exc)}
    return parse_describe(out)
