"""从名字裁剪图里判定技能等级符号(○ / ◎)。

为什么单独做一层:PP-OCR **完全读不出 ○**——实测 det/rec-only × 2×/4× 四种配置,
「良场地○」一律返回「良场地」,「▶秋」这种更是一个字都对不上。放大也救不回来,
因为 ○ 的笔画只有 1~2px(汉字是 4~6px),模型把它当装饰直接忽略。

但它可测:○ 是一个**细线空心圆**,连通域特征与汉字差得非常远(实测值,720×1280 @320dpi):

    汉字   宽高 18~20px,填充率 0.47~0.83,洞占比 0.00~0.05
    ○     宽高 15~16px,填充率 0.24~0.30,洞占比 **0.52**

所以「填充率低 + 洞占比高 + 尺寸略小」三条同时成立就能稳定判成 ○,不需要模板、不需要训练。

◎ 是「同样的细环 + 中心实心点」,理论上填充率会比 ○ 高、洞占比会低一些。
**但当前截图里一条 ◎ 都没有**(用户澄清:○ 和 ◎ 在界面上是同一格,显示的是当前可买等级),
所以 ◎ 的阈值是推断值,标 `partial` 让上层转成「需确认」,等真样本再收紧。
"""

from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np
from PIL import Image


@dataclass(frozen=True)
class SymbolHit:
    symbol: str        # '○' | '◎'
    x: int             # 在原裁剪图内的列位置
    w: int
    h: int
    fill: float
    hole_ratio: float
    confident: bool    # False = 按推断阈值判的,建议上层标「需确认」


# 实测参数(720×1280)。换分辨率要重新采样。
THRESH = 200           # 二值化阈值:汉字灰阶≈90,○ 的细线≈190,卡片背景≈235
MIN_AREA = 15
# 符号比汉字小一圈:汉字 18~20 × 19~20,○ 是 15~16 × 16
W_RANGE = (11, 18)
H_RANGE = (12, 20)
ASPECT_RANGE = (0.70, 1.35)
# 主判据是填充率(○ 只有细环,汉字笔画粗):实测 ○ 0.23~0.30,汉字 0.47~0.83
O_FILL_MAX = 0.36
# 洞占比只作为辅助记录,不作为判据 —— ○ 的环只有 1px,抗锯齿下常有缺口,
# 洞会和外部背景连通,用完整名字带裁剪时"洞"时有时无,不可靠。
# ◎:环 + 中心实心点,填充率介于 ○ 与汉字之间。**推断值**,等真样本收紧。
E_FILL_RANGE = (0.36, 0.47)


def _components(gray: np.ndarray):
    ink = (gray < THRESH).astype(np.uint8)
    n, lab, stats, _ = cv2.connectedComponentsWithStats(ink, 8)
    for i in range(1, n):
        x, y, w, h, area = stats[i]
        if area < MIN_AREA or not (W_RANGE[0] <= w <= W_RANGE[1]) or not (H_RANGE[0] <= h <= H_RANGE[1]):
            continue
        aspect = w / float(h)
        if not (ASPECT_RANGE[0] <= aspect <= ASPECT_RANGE[1]):
            continue
        sub = (lab[y:y + h, x:x + w] == i).astype(np.uint8)
        inv = (1 - sub).astype(np.uint8)
        nh, _, hs, _ = cv2.connectedComponentsWithStats(inv, 8)
        hole_area = 0
        for j in range(1, nh):
            hx, hy, hw, hh, ha = hs[j]
            if hx == 0 or hy == 0 or hx + hw == w or hy + hh == h:
                continue          # 贴边的不是"洞",是背景
            if ha >= 5:
                hole_area += ha
        yield SymbolHit(
            symbol="?", x=int(x), w=int(w), h=int(h),
            fill=area / float(w * h), hole_ratio=hole_area / float(w * h),
            confident=True,
        )


def detect(name_crop: Image.Image) -> SymbolHit | None:
    """在名字裁剪图里找等级符号。命中多个时取最靠右的(符号紧跟在名字末尾)。"""
    if name_crop.width < 20 or name_crop.height < 20:
        return None
    gray = np.asarray(name_crop.convert("L"), dtype=np.uint8)
    hits: list[SymbolHit] = []
    for c in _components(gray):
        if c.fill <= O_FILL_MAX:
            hits.append(SymbolHit("○", c.x, c.w, c.h, c.fill, c.hole_ratio, True))
        elif E_FILL_RANGE[0] < c.fill <= E_FILL_RANGE[1]:
            hits.append(SymbolHit("◎", c.x, c.w, c.h, c.fill, c.hole_ratio, False))
    if not hits:
        return None
    return max(hits, key=lambda h: h.x)
