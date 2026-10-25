"""版式 profile:把"哪一块是名字/价格、列表在哪"这类**必须靠截图校准**的数字集中到一处。

原则:
- 坐标一律是**原图像素**(720x1280),不跟随窗口缩放——换分辨率就换一份 profile。
- `calibrated: false` 时上层拒绝自动抓取,只允许跑 calibrate 出调试图,避免拿错坐标瞎读。

为什么是「锚定式」而不是「固定行高切行」(2026-10-25 实测):
- 技能卡片高度**不统一**:带「达成进化条件」标题的金卡更高,灰掉的已获得卡片更矮。
  按 row.height 累加切行,滚几屏之后就会把名字和价格串到隔壁卡上。
- 但每张可购买卡片右侧都有一个**纯绿色「+」按钮**,颜色饱和、位置固定(x≈629..671)。
  用它在 HSV 里做连通块,就得到每行精确的中心 y —— 与卡片高度、滚动位置完全无关。
- 附带收益:已获得/不可购买的卡片**没有这个按钮**,天然被排除,不需要再判灰度。
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

LAYOUT_DIR = Path(__file__).resolve().parent / "layouts"


@dataclass(frozen=True)
class Box:
    x: int
    y: int
    w: int
    h: int

    def crop(self, image: Image.Image) -> Image.Image:
        return image.crop((self.x, self.y, self.x + self.w, self.y + self.h))

    def as_tuple(self) -> tuple[int, int, int, int]:
        return (self.x, self.y, self.x + self.w, self.y + self.h)


@dataclass(frozen=True)
class Anchor:
    """绿色「+」按钮的检测参数(HSV 区间 + 几何过滤)。"""

    hsv_lo: tuple[int, int, int]
    hsv_hi: tuple[int, int, int]
    x_min: int
    x_max: int
    w_min: int
    w_max: int
    h_min: int
    h_max: int
    area_min: int


@dataclass
class Profile:
    raw: dict

    @property
    def calibrated(self) -> bool:
        return bool(self.raw.get("calibrated"))

    @property
    def resolution(self) -> tuple[int, int]:
        r = self.raw["resolution"]
        return (int(r["width"]), int(r["height"]))

    @property
    def list_top(self) -> int:
        """列表可视区顶部。低于它的行会被顶部渐隐遮罩压暗,名字读不准,直接不读。"""
        return int(self.raw["list"]["top"])

    @property
    def list_bottom(self) -> int:
        return int(self.raw["list"]["bottom"])

    @property
    def anchor(self) -> Anchor:
        a = self.raw["anchor"]
        return Anchor(
            hsv_lo=tuple(a["hsv_lo"]), hsv_hi=tuple(a["hsv_hi"]),
            x_min=int(a["x_min"]), x_max=int(a["x_max"]),
            w_min=int(a["w_range"][0]), w_max=int(a["w_range"][1]),
            h_min=int(a["h_range"][0]), h_max=int(a["h_range"][1]),
            area_min=int(a["area_min"]),
        )

    @property
    def scroll(self) -> dict:
        return self.raw["scroll"]

    # ── 行锚定 ────────────────────────────────────────────────────
    def find_rows(self, image: Image.Image) -> list[int]:
        """返回这一屏里所有**完整可见**的可购买行中心 y(升序)。"""
        a = self.anchor
        arr = np.asarray(image.convert("RGB"))[:, :, ::-1]     # RGB → BGR
        hsv = cv2.cvtColor(arr, cv2.COLOR_BGR2HSV)
        mask = cv2.inRange(hsv, a.hsv_lo, a.hsv_hi)
        mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
        n, _, stats, cent = cv2.connectedComponentsWithStats(mask, 8)

        ys: list[int] = []
        for i in range(1, n):
            x, y, w, h, area = stats[i]
            if area < a.area_min or not (a.x_min <= x <= a.x_max):
                continue
            if not (a.w_min <= w <= a.w_max) or not (a.h_min <= h <= a.h_max):
                continue
            cy = float(cent[i][1])
            # 只有完整落在可视区里的行才读:顶部被渐隐压过、底部被按钮压过的都会读歪
            if not (self.list_top <= cy <= self.list_bottom):
                continue
            ys.append(int(round(cy)))
        return sorted(ys)

    def crop_around(self, image: Image.Image, cy: int, name: str) -> Image.Image:
        """以行中心 cy 为基准裁一块(name/price)。"""
        c = self.raw["crops"][name]
        return image.crop((
            int(c["x0"]), max(0, cy + int(c["dy0"])),
            int(c["x1"]), max(0, cy + int(c["dy1"])),
        ))

    def row_band(self, image: Image.Image, cy: int) -> Image.Image:
        """整张卡片(用于调试图/未来判金卡)。"""
        half = int(self.raw.get("row_height", 185)) // 2
        return image.crop((0, max(0, cy - half), image.width, min(image.height, cy + half)))

    def price_band(self) -> tuple[int, int, int, int]:
        c = self.raw["crops"]["price"]
        return (int(c["x0"]), int(c["x1"]), int(c["dy0"]), int(c["dy1"]))

    def pt_balance_box(self) -> Box:
        c = self.raw["pt_balance"]
        return Box(int(c["x0"]), int(c["y0"]),
                   int(c["x1"]) - int(c["x0"]), int(c["y1"]) - int(c["y0"]))


def load_profile(width: int, height: int) -> Profile:
    """按实际分辨率找 profile;找不到就报清楚该建哪份。"""
    path = LAYOUT_DIR / f"{width}x{height}.json"
    if not path.is_file():
        available = ", ".join(p.stem for p in LAYOUT_DIR.glob("*.json")) or "(无)"
        raise FileNotFoundError(
            f"没有 {width}x{height} 的版式文件 {path}。已有:{available}。\n"
            f"  复制一份改名后跑 `python -m app.cli calibrate` 校准。"
        )
    with open(path, encoding="utf-8") as fh:
        return Profile(json.load(fh))
