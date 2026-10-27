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
import socket
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass

from PIL import Image

# 窗口模式(桌面版 exe / pythonw)里起 adb.exe 会**每次弹一个黑色控制台窗口**:
# 刷新设备要连 8 个端口 + 列设备 + 每屏截图,一次操作闪十几下黑框。
# CREATE_NO_WINDOW 让子进程不创建控制台(控制台版无影响,照常工作)。
_NO_WINDOW = 0x08000000 if os.name == "nt" else 0

# 兜底序列号(单实例、且只有一台在线时才会用到;正常走「先选设备」)
DEFAULT_SERIAL = "127.0.0.1:5555"

# 本进程是否已经扫过模拟器端口。第一次 `list_devices("auto")` 必须扫 ——
# 否则"MuMu 已在 adb 列表里"会让端口扫描被跳过,而雷电恰恰是需要扫才连得上的那台。
_swept_once = False
LDPPLAYER_ADB_CANDIDATES = (
    r"E:\leidian\LDPlayer9\adb.exe",
    r"C:\leidian\LDPlayer9\adb.exe",
    r"D:\leidian\LDPlayer9\adb.exe",
)

# 常见模拟器的默认 adb 端口。启动后不一定会自动进 adb 的服务器列表,列设备前顺手连一遍
# (端口没人监听时 connect 会立刻失败,不拖时间)。
#   雷电 实例 0 = 5555,实例 N = 5555+2N;MuMu 6 = 7555;MuMu 12 = 16384+32N;
#   夜神 = 62001/62025;BlueStacks = 5565。
# 注意:端口 ≠ 模拟器品牌(实测见过 5555 被 MuMu 占着),所以**只用来连,不用来贴标签**。
CANDIDATE_PORTS = (5555, 5557, 5559, 7555, 16384, 16416, 16448, 62001, 62025, 5565)

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
                cmd, capture_output=True, timeout=timeout or self.timeout, check=False,
                creationflags=_NO_WINDOW,
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

def local_ips() -> list[str]:
    """本机所有**非回环私有 IPv4**,默认路由那张网卡排第一。

    **为什么需要它**:`adb connect 127.0.0.1:5555` 只连得上「绑在 127.0.0.1 的那个监听」。
    实测(2026-10-27):雷电的 adb 监听在 `0.0.0.0:5555`,而 MuMu 抢先绑了 `127.0.0.1:5555`;
    Windows 建连时匹配更具体的地址 → 所有 5555 的连接都落到 MuMu,**雷电永远连不上**
    (表现出来就是"设备列表里根本没有我的雷电")。改用本机内网 IP 连 5555 就绕开了 ——
    那时匹配的是 0.0.0.0 那条,也就是雷电。

    只保留 RFC1918 私有地址:代理软件常见的 TUN 地址(198.18.x.x 之类)连过去会挂住。
    """
    out: list[str] = []
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect(("223.5.5.5", 53))     # UDP connect 不发包,只为让系统选出默认路由
            out.append(s.getsockname()[0])
        finally:
            s.close()
    except OSError:
        pass
    try:
        for ip in socket.gethostbyname_ex(socket.gethostname())[2]:
            if ip not in out:
                out.append(ip)
    except OSError:
        pass
    return [ip for ip in out if _is_private_ipv4(ip)]


def _is_private_ipv4(ip: str) -> bool:
    parts = ip.split(".")
    if len(parts) != 4 or not all(p.isdigit() for p in parts):
        return False
    a, b = int(parts[0]), int(parts[1])
    return a == 10 or (a == 172 and 16 <= b <= 31) or (a == 192 and b == 168)


def connect_candidates(adb_path: str, timeout: float = 1.5) -> None:
    """对常见模拟器端口挨个 `adb connect`,**并行**且超时很短。

    为什么要并行 + 短超时:端口没人监听时 adb 会立刻失败,但**端口有程序监听却不讲 adb 协议**
    (模拟器未启动完 / 别的服务占了端口)时,adb 会一直等到超时 —— 串行 8 个端口实测要 14s,
    整个界面像卡死。并行后最多 ~1.5s。

    每个端口连两次:`127.0.0.1` 和本机内网 IP。**两个都要**,因为模拟器绑的地址不一样 ——
    雷电绑 `0.0.0.0`,MuMu 绑 `127.0.0.1`;当 127.0.0.1:5555 被 MuMu 占住时,
    只有内网 IP:5555 能连到雷电(细节见 local_ips 的注释)。
    """
    targets = [(host, port) for host in ["127.0.0.1", *local_ips()] for port in CANDIDATE_PORTS]

    def one(target: tuple[str, int]) -> None:
        host, port = target
        try:
            subprocess.run(
                [adb_path, "connect", f"{host}:{port}"],
                capture_output=True, timeout=timeout, check=False,
                creationflags=_NO_WINDOW,
            )
        except (OSError, subprocess.TimeoutExpired):
            pass

    with ThreadPoolExecutor(max_workers=len(targets)) as pool:
        list(pool.map(one, targets))


def _raw_devices(path: str) -> list[dict]:
    try:
        proc = subprocess.run(
            [path, "devices", "-l"], capture_output=True, timeout=20, check=False,
            creationflags=_NO_WINDOW,
        )
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
      - `"auto"`(默认):**本进程第一次调用时扫一遍端口**,之后只在「一台在线设备都没有」时再扫。
      - `True`:强制扫一遍(界面上的「刷新设备」按钮用它,模拟器刚启动/掉线时能捞回来)。
      - `False`:只列,不连。

    为什么第一次必须扫:雷电的 adb 常常是"能连但不在 adb 列表里"的状态(尤其它被
    MuMu 抢了 127.0.0.1:5555 之后,只能靠内网 IP 连)。如果只在"一条设备都没有"时扫,
    那么 MuMu 已经在线的情况下永远发现不了雷电 —— 用户看到的就是"我的雷电哪去了"。

    `state` 里常见 `device` / `offline` / `unauthorized`;后两者仍要列出来,
    否则用户会以为"模拟器没开",其实是 adb 连接掉了或者没点授权。
    """
    path = adb_path or find_adb()
    devs = _raw_devices(path)
    need_sweep = connect is True or (
        connect == "auto" and (not _swept_once or not any(d["state"] == "device" for d in devs))
    )
    if need_sweep:
        connect_candidates(path)
        globals()["_swept_once"] = True
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
    """同一台模拟器常同时挂在好几个序列号下(`127.0.0.1:5555` / `7555` / `16384` /
    `emulator-5554` 都可能指向它)。不去重的话下拉框里全是重复项,用户根本挑不出来。

    身份键按可靠性排序:`ro.serialno` → `android_id` → 序列号本身。
    **实测坑(2026-10-27)**:这几台模拟器的 `ro.serialno` 全是空,只按它去重等于没去重
    (6 条里 3 条是同一台);`settings get secure android_id` 才分得清。

    保留哪一个:`host:port` 优先 —— `emulator-5554` 这种编号会随启动顺序变,不适合存进配置。
    """
    kept: dict[str, dict] = {}
    order: list[str] = []
    for row in rows:
        key = row.get("serialno") or row.get("android_id") or row["serial"]
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
        A=c8b49551f9a6d3f
        Physical size: 720x1280
        mCurrentFocus=Window{30e031d u0 com.bilibili.umamusu/com.xxx.MainActivity}
    """
    model = (re.search(r"^M=(.*)$", out, re.M) or [None, ""])[1].strip()
    serialno = (re.search(r"^S=(.*)$", out, re.M) or [None, ""])[1].strip()
    android_id = (re.search(r"^A=(.*)$", out, re.M) or [None, ""])[1].strip()
    if android_id.lower() in ("", "null", "unknown"):
        android_id = ""            # 有些 ROM 会吐字符串 null,别把它当身份
    m = re.search(r"(\d+)x(\d+)", out)
    size = f"{m.group(1)}x{m.group(2)}" if m else ""
    fg = re.search(r"mCurrentFocus=Window\{[^}]*?\s+([\w.]+)/", out)
    pkg = fg.group(1) if fg else None
    return {
        "model": model,
        "serialno": serialno,
        "android_id": android_id,
        "size": size,
        "foreground": pkg,
        "app": PACKAGE_LABELS.get(pkg or "", pkg or ""),
        "isUma": pkg in UMA_PACKAGES,
    }


def describe(serial: str, adb_path: str | None = None, timeout: float = 8.0) -> dict:
    """补一屏信息:机型 / 设备唯一序列号 / 分辨率 / 前台应用。**一次 shell 调用拿全**(省往返)。

    前台应用是关键信息 —— 多个模拟器同时开着时,只有它是"这台是不是赛马娘"的可靠信号。

    **去重键**:`ro.serialno` 优先,读不到就用 `settings get secure android_id`。
    实测(2026-10-27)几台模拟器的 `ro.serialno` 全是空,于是去重完全失效,下拉框里
    同一台机器出现 4 条(5555 / 7555 / 16384 / emulator-5554 都指向它);
    而 android_id 在每台 VM 上都不一样(两台 MuMu 是 d88c4dca… / 3f55c4a0…,雷电是 c8b4955…),正好能当身份。

    解析用 `M=` / `S=` / `A=` 前缀而不是按行号取值:机型为空时 getprop 会输出空行,
    按行号取会整体错位。
    """
    adb = Adb(serial, adb_path=adb_path, timeout=timeout)
    try:
        # `$(...)` 由设备端的 sh 展开,不经 Windows 的 shell
        out = adb.shell(
            "echo M=$(getprop ro.product.model); echo S=$(getprop ro.serialno); "
            "echo A=$(settings get secure android_id); "
            "wm size; dumpsys window | grep mCurrentFocus"
        )
    except AdbError as exc:
        return {"error": str(exc)}
    return parse_describe(out)
