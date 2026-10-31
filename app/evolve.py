"""读「技能进化」弹窗:某个金技能能不能进化、进化成什么。

**为什么要真的点开**(2026-10-25 用户指出):
- BWIKI 能给「金技能 → 可进化技能」的静态映射,但**不知道当前马娘是否满足条件**,
  也不保证覆盖所有分支(一个技能可能能进化成不同的几个)。
- 游戏里每张可进化的卡片左下角有个白色胶囊「进化 ⓘ」,点 ⓘ 弹出的窗口里写得很清楚:
  进化前名字 / 进化后名字 / 是否「条件已达成」。这是唯一权威来源。

**实测踩到的三个点**:
1. `input tap` 在这个游戏里**大部分情况无效**(连顶部的信息 ⓘ 都不响应),只有 ⓘ 按钮能吃进去。
   而 `input swipe` 一直有效(翻列表用的就是它),所以不是 adb 不通。
2. **必须点准 ⓘ 圆圈本身**,点在左边「进化」两个字上没有反应。
   ⓘ 的 bbox 实测约 30×30(720×1280),中心取白块质心最稳。
3. 弹窗的关闭:**点底部「关 闭」按钮 + 轮询确认**(2026-10-31 实测 adb tap 点得动;
   旧记录「点不动、改用返回键」是关窗动画没播完就截图的误判,而返回键在 ⓘ 没点开时
   会把技能购买页整个退出去 —— 真机三次事故后彻底移除,见 read_evolution)。
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

# 「进化 ⓘ」胶囊的白底判据(白得发亮,在金色/灰色卡片上很好分)
WHITE_MIN = 230
# ⓘ 圆圈实测 30×30 左右;「进化」文字块是 61×24 的宽扁块,靠宽高比区分
ICON_W_RANGE = (22, 38)
ICON_ASPECT = (0.75, 1.30)
# 两处都会出现「进化 ⓘ」:**已获得**的卡片在左下角,而**可购买**的卡片在右侧价格区下方。
# 所以左右两段都要扫;中间是名字/描述,不放行以免把别的白块算进来。
X_RANGES = ((18, 175), (540, 712))


@dataclass(frozen=True)
class EvolveButton:
    """一张卡片上的「进化 ⓘ」入口。"""

    row_cy: int      # 所属行中心 y
    tap_x: int       # ⓘ 中心
    tap_y: int


@dataclass(frozen=True)
class EvolveTarget:
    """弹窗里的一个「进化技能」卡片。一个技能可能有多个进化方向,所以这是列表的一项。"""

    name: str
    condition_met: bool


@dataclass(frozen=True)
class PopupInfo:
    """「技能进化」弹窗的内容。"""

    from_name: str
    targets: tuple[EvolveTarget, ...]

    def as_dict(self) -> dict:
        return {
            "from": self.from_name,
            "targets": [{"to": t.name, "conditionMet": t.condition_met} for t in self.targets],
        }


# 弹窗里三种卡片的实测底色(720×1280)
GOLD_CARD = (255, 223, 122)     # 进化前的技能卡
PINK_CARD = (255, 205, 231)     # 进化技能卡(可能有多个,垂直排列)
COND_TAG = (255, 119, 187)      # 「条件已达成」小标签
_COLOR_TOL = 12


def _row_matches(arr: np.ndarray, y: int, rgb: tuple[int, int, int], tol: int = _COLOR_TOL) -> bool:
    px = arr[y, 360]            # 取中轴线:卡片背景在这里最干净
    return all(abs(int(px[i]) - rgb[i]) <= tol for i in range(3))


# 卡片纵向取样列:横跨卡片宽度,靠"多数列命中"抵抗文字/图标的遮挡
_PROBE_COLS = (80, 180, 280, 380, 480, 580, 660)


def _color_bands(arr: np.ndarray, rgb: tuple[int, int, int], y0: int, y1: int,
                 min_h: int = 40, need: int = 4, tol: int = 24) -> list[tuple[int, int]]:
    """找某个底色的连续行段(多列投票)。

    两个坑都踩过:
    1. 单点采样会被卡片里的图标/文字打断,一张卡片被切成两三段;
    2. 按整行占比也不行 —— 卡片内部本身就是**两种同色系**底色(深金 255,223,122 / 浅金 255,243,205),
       换行处占比骤降。
    多列投票(7 列里至少 4 列命中)能同时扛住这两种情况:文字最多遮住一两列。
    """
    strip = arr[y0:min(y1, arr.shape[0])].astype(int)
    target = np.array(rgb, dtype=int)
    votes = np.zeros(strip.shape[0], dtype=int)
    for x in _PROBE_COLS:
        if x >= strip.shape[1]:
            continue
        votes += (np.abs(strip[:, x, :] - target).max(axis=1) <= tol).astype(int)
    ok = votes >= need
    out: list[tuple[int, int]] = []
    start = None
    for i, v in enumerate(ok):
        if v and start is None:
            start = i
        elif not v and start is not None:
            if i - start >= min_h:
                out.append((start + y0, i + y0))
            start = None
    if start is not None and len(ok) - start >= min_h:
        out.append((start + y0, min(y1, arr.shape[0])))
    return out


def _white_mask(arr: np.ndarray) -> np.ndarray:
    return ((arr[:, :, 0] > WHITE_MIN) & (arr[:, :, 1] > WHITE_MIN) & (arr[:, :, 2] > WHITE_MIN)).astype(np.uint8)


def _scan(arr: np.ndarray, y0: int, y1: int, x0: int, x1: int) -> list[tuple[int, int, int, int]]:
    """在一个矩形里找近正方白块,返回 [(cx, cy, w, h)]。"""
    sub = arr[y0:y1, x0:x1]
    if sub.size == 0:
        return []
    n, _, stats, cent = cv2.connectedComponentsWithStats(_white_mask(sub), 8)
    out = []
    for i in range(1, n):
        _x, _y, w, h, area = stats[i]
        if not (ICON_W_RANGE[0] <= w <= ICON_W_RANGE[1] and ICON_W_RANGE[0] <= h <= ICON_W_RANGE[1]):
            continue
        if area < 300 or not (ICON_ASPECT[0] <= w / float(h) <= ICON_ASPECT[1]):
            continue
        out.append((int(round(cent[i][0])) + x0, int(round(cent[i][1])) + y0, int(w), int(h)))
    return out


def find_all_buttons(image: Image.Image, top: int, bottom: int) -> list[tuple[int, int]]:
    """扫描列表可视区里所有「进化 ⓘ」,返回 [(x, y)]。

    比 `find_button` 更省事的地方:不依赖行锚定。已获得的卡片没有绿色 + 按钮,
    所以 find_rows 看不到它们 —— 但它们的进化入口同样要读(判断当前马娘能不能进化)。
    """
    arr = np.asarray(image.convert("RGB"))
    y0, y1 = max(0, top), min(arr.shape[0], bottom)
    out: list[tuple[int, int]] = []
    for x0, x1 in X_RANGES:
        out.extend((cx, cy) for cx, cy, _w, _h in _scan(arr, y0, y1, x0, x1))
    return sorted(out, key=lambda p: p[1])


def find_button(image: Image.Image, row_cy: int, dy: int = 80) -> EvolveButton | None:
    """在一行卡片里找「进化 ⓘ」,找不到返回 None。"""
    arr = np.asarray(image.convert("RGB"))
    y0, y1 = max(0, row_cy - dy), min(arr.shape[0], row_cy + dy)
    best: tuple[int, int] | None = None
    for x0, x1 in X_RANGES:
        for cx, cy, _w, _h in _scan(arr, y0, y1, x0, x1):
            if best is None or cx > best[0]:
                best = (cx, cy)
    if best is None:
        return None
    return EvolveButton(row_cy=row_cy, tap_x=best[0], tap_y=best[1])

def card_boxes(arr: np.ndarray) -> list[tuple[int, int, int, int]]:
    """找所有「进化技能」卡片的 bbox (x, y, w, h)。

    这些卡片有**洋红色边框**(259,119,187 附近),边框本身会连成一个空心中框,
    bbox 就是整张卡片 —— 这是最稳的定位方式:一个进化方向一张卡,多方向自然多一个框,
    完全不依赖固定 y(多一张卡整块会往下排)。
    """
    a = arr.astype(np.int16)          # uint8 直接减会下溢(254-255 → 255),必须先转有符号
    m = ((np.abs(a[:, :, 0] - 255) <= 18)
         & (np.abs(a[:, :, 1] - COND_TAG[1]) <= 40)
         & (np.abs(a[:, :, 2] - COND_TAG[2]) <= 35)).astype(np.uint8)
    n, _, stats, _ = cv2.connectedComponentsWithStats(m, 8)
    out: list[tuple[int, int, int, int]] = []
    for i in range(1, n):
        x, y, w, h, area = stats[i]
        if w < 420 or not (90 <= h <= 260):      # 卡片宽度约 658,高度约 165
            continue
        if y < 380 or y > 1100:
            continue
        out.append((int(x), int(y), int(w), int(h)))
    return sorted(out, key=lambda b: b[1])


def read_popup(ocr, image: Image.Image) -> PopupInfo | None:
    """从「技能进化」弹窗截图读:进化前名字 + **全部**进化方向(含各自条件是否达成)。

    版式实测(720×1280):
        进化前的技能卡  金色底,名字在 y≈165~195
        进化技能卡      粉色底 + 洋红边框,y 由 card_boxes() 定位;每张 = 一个方向
        条件小标签      在每张卡左上角,写「条件已达成 / 未达成」
    """
    arr = np.asarray(image.convert("RGB"))

    def rec(box: tuple[int, int, int, int]) -> str:
        return ocr.read_text(image.crop(box)).strip()

    boxes = card_boxes(arr)
    if not boxes:
        return None
    before = rec((130, 150, 480, 205))

    targets: list[EvolveTarget] = []
    for x, y, w, h in boxes:
        # 名字在条件标签下方,左边对齐到 150 避开标签
        name = rec((150, y + 10, min(x + w, 500), min(y + h, y + 48)))
        # 标签压在卡片上边框上,要往上多留一点(实测 -6..+28 才完整)
        cond = rec((max(x, 20), max(y - 6, 0), min(x + 165, x + w), min(y + 28, y + h)))
        name = re.sub(r"^[成达已条态为](?=[\u4e00-\u9fa5]{2,})", "", name).strip()
        if not name:
            continue
        targets.append(EvolveTarget(name=name, condition_met=("已达成" in cond)))

    if not before or not targets:
        return None
    return PopupInfo(from_name=before, targets=tuple(targets))


def read_evolution(adb, ocr, image: Image.Image, btn: EvolveButton) -> PopupInfo | None:
    """点开 → 读 → 点「关闭」收起。**全程不碰返回键**。

    2026-10-31 真机三次事故的结论:
    - 返回键(keyevent 4)曾用于关弹窗,但 ⓘ 偶发点不进去(游戏吞 tap)时它会把
      技能购买页整个退出去 —— **已彻底移除,任何路径都不再发 keyevent**。
    - 弹窗的「关闭」按钮 adb tap **点得动**(旧记录「点不动」是关窗动画没播完就
      截图的误判),点完必须**轮询确认**真的回到列表,不能只等固定时长。
    - ⓘ 点了个寂寞(diff=0)时什么都不按,直接跳过这条。
    - 弹窗开着但「关闭」连点 3 次都没关掉 → 抛错中止整次抓取(弹窗开着继续抓
      也没有意义),由用户手动点「关闭」。
    - ⚠ 判"弹窗开了"的基线必须**点按前现拍一张**:页首截图到 attach 之间隔着
      read_page/owned 扫描好几秒,而上一页双圈补读的 +/− 点按会给列表留下残余
      惯性 —— 拿旧帧当基线,列表停稳后的位移就被误判成"弹窗开了"
      (2026-10-31 第四次事故的根因:对着不存在的弹窗点「关闭」3 次)。
    """
    ref_band = None
    from .capture import frame_diff

    # ⓘ 偶发被游戏吞 tap、或只是把卡点成按压态(画面变暗但没弹窗):判定不用像素差,
    # 用弹窗的硬特征 —— 顶部全宽绿色「技能进化」标题栏(列表页该区域绿像素为 0)。
    # 没点开就补点,最多 3 次(全程不碰任何键,列表无副作用)。
    evo = None
    popup = None
    for _attempt in range(3):
        # ⓘ 坐标以**现拍帧**为准:attach 拿到的按钮位置来自页首帧,抓取流程里
        # read_page/owned 扫描耗掉几秒,列表惯性可能让它漂移 —— 拿旧坐标点就落空。
        tx, ty = btn.tap_x, btn.tap_y
        fresh = adb.screencap()
        fresh_btns = find_all_buttons(fresh, _band_top, _band_bottom)
        if fresh_btns:
            near = min(fresh_btns, key=lambda q: abs(q[1] - ty))
            if abs(near[1] - ty) <= 150:
                tx, ty = near
        adb.tap(tx, ty)
        adb.settle(1.1)
        popup = adb.screencap()
        if _popup_open(popup):
            evo = read_popup(ocr, popup)
            if evo is None:
                # 弹窗开了但没读出来(可能截在入场动画上):等一下重读一次
                adb.settle(0.8)
                popup = adb.screencap()
                evo = read_popup(ocr, popup)
                if evo is None:
                    _dump(popup, "evolve_parse_fail.png")
            break
    else:
        return None                      # 三次都没开出弹窗:放弃这条,继续往下走
    for attempt in range(3):
        adb.tap(*CLOSE_BTN)
        if _wait_closed(adb):
            return evo
        # 没关掉:把此刻画面存下来(「关不上」时弹窗长什么样是定位问题的关键)
        _dump(adb.screencap(), f"evolve_close_fail_{attempt}.png")
    raise RuntimeError(
        "「技能进化」弹窗的「关闭」按钮点了 3 次都没关掉。"
        "请在模拟器里手动点「关闭」,然后重新读取(工具不会替你按返回键)。"
        f"现场帧已存 app/_debug/evolve_close_fail_*.png")


# 「技能进化」弹窗是全屏的,底部「关闭」按钮中心(720x1280 实测)
CLOSE_BTN = (360, 1180)
# ⓘ 重定位的扫描范围(720x1280 列表可视区)
_band_top, _band_bottom = 460, 978
# 列表带(y 560~950)差异超过它 = 有东西盖上来了;没弹窗时列表带完全静止(实测 0.0)
_POPUP_DIFF = 8.0


def _band(img: Image.Image) -> Image.Image:
    """列表带裁剪:避开立绘 Live2D 动画区(上方)和标题,是唯一静止的比对区。"""
    return img.crop((0, 560, 720, 950))


def _dump(img: Image.Image, name: str) -> None:
    """调试帧落盘(失败现场);存图失败不影响主流程。"""
    try:
        dbg = Path(__file__).resolve().parent / "_debug"
        dbg.mkdir(parents=True, exist_ok=True)
        img.save(dbg / name)
    except Exception:          # noqa: BLE001
        pass


def _popup_open(img: Image.Image) -> bool:
    """「技能进化」弹窗的硬特征:顶部全宽绿色标题栏。

    实测(720x1280):弹窗帧该区域绿像素 52206,列表帧(包括卡被点成按压态的)为 0
    —— 列表上方是蓝色「技能获取」标题和立绘,永远凑不出这条绿带。比像素差可靠:
    卡的按压态、滚动惯性、立绘动画都不会伪造出一条全宽绿带。
    """
    arr = np.asarray(img.convert("RGB"))[:, :, ::-1]
    hsv = cv2.cvtColor(arr, cv2.COLOR_BGR2HSV)
    mask = cv2.inRange(hsv, (35, 90, 80), (75, 255, 255))
    return int(mask[20:130].sum() / 255) > 10000


def _wait_closed(adb, timeout_s: float = 4.0) -> bool:
    """轮询等弹窗关掉:绿色「技能进化」标题栏消失即为关掉(关窗有动画,不能只等固定时长)。

    不再比列表带像素差 —— 卡的按压态(点 ⓘ 时顺带点暗了)可能持续到关窗之后,
    拿它当"没关上"的信号会把好端端关掉的弹窗误判成失败。
    """
    import time

    deadline = time.time() + timeout_s
    while time.time() < deadline:
        time.sleep(0.5)
        if not _popup_open(adb.screencap()):
            return True
    return False
