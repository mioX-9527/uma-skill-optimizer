"""ADB 封装:连接雷电模拟器、取帧、滑动。

设计约束(均为实测得出,别随意改):
- 720x1280 屏下 `exec-out screencap -p` 约 0.9~1.1s/帧,瓶颈在模拟器侧 screencap 本身,
  所以一次流程里每抓一帧都要算进预算,不要为了"稳妥"多抓。
- raw 帧(不带 -p)同样耗时且体积 3.7MB,PNG 只用 420KB,故一律用 -p。
- 雷电自带 adb(与设备 SDK 28 同代)比 platform-tools 新版更稳,优先用它。
"""

from __future__ import annotations

import io
import os
import re
import shutil
import subprocess
import time
from dataclasses import dataclass

from PIL import Image

# 雷电实例 0 的 adb 端口;多开时实例 N = 5555 + 2N
DEFAULT_SERIAL = "127.0.0.1:5555"
LDPPLAYER_ADB_CANDIDATES = (
    r"E:\leidian\LDPlayer9\adb.exe",
    r"C:\leidian\LDPlayer9\adb.exe",
    r"D:\leidian\LDPlayer9\adb.exe",
)


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
