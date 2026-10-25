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
3. 弹窗底部的「关闭」按钮**点不动**(同样是点击事件的问题),改用 `keyevent 4`(返回键)关闭,
   稳定可靠且不影响列表位置。
"""

from __future__ import annotations

import re
from dataclasses import dataclass

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
class Evolution:
    """弹窗内容。"""

    from_name: str
    to_name: str
    condition_met: bool

    def as_dict(self) -> dict:
        return {"from": self.from_name, "to": self.to_name, "conditionMet": self.condition_met}


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

def read_popup(ocr, image: Image.Image) -> Evolution | None:
    """从「技能进化」弹窗截图里读进化前/后名字与条件是否达成。

    版式实测(720×1280):
        进化的技能  y≈105   前名 y≈165~195
        条件已达成  y≈440~465(粉色小标签,没有则不显示)
        进化技能    y≈365   后名 y≈470~500
    """
    def rec(box: tuple[int, int, int, int]) -> str:
        crop = image.crop(box)
        return ocr.read_text(crop).strip()

    # 后名区域避开左侧「条件已达成」标签,所以 x 从 150 起
    before = rec((130, 150, 470, 205))
    after = rec((150, 455, 470, 510))
    cond = rec((20, 432, 175, 472))
    if not before or not after:
        return None
    return Evolution(
        from_name=before,
        to_name=re.sub(r"^[成达已条态为](?=[\u4e00-\u9fa5]{2,})", "", after),
        condition_met="条件已达成" in cond or "已达成" in cond,
    )


def read_evolution(adb, ocr, image: Image.Image, btn: EvolveButton) -> Evolution | None:
    """点开 → 读 → 返回键关闭。整个过程**只读**,不做任何会改存档的操作。"""
    adb.tap(btn.tap_x, btn.tap_y)
    adb.settle(1.1)
    popup = adb.screencap()
    evo = read_popup(ocr, popup)
    # 关闭用返回键:弹窗底部的「关闭」按钮点不动(实测)
    adb.shell("input", "keyevent", "4")
    adb.settle(0.8)
    return evo
