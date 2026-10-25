"""OCR 封装(RapidOCR / PP-OCR)。

实测得到的三个约束,直接决定了这里的实现:
1. **「◎」会被整个丢掉**、「○」常被认成「。」甚至完全读不出 → 符号层不能靠 OCR,
   改用 `symbol.py` 的连通域形状检测(○ 是细线空心圆,填充率 0.23~0.30,汉字是 0.47~0.83)。
2. 720×1280 下字号偏小 → 裁出来的小块**先放大 2 倍**再识别,精度明显更好。
3. 首次调用要加载模型(~600ms),空全屏 det 约 260ms,单行带 OCR 约 300~400ms → 必须预热,
   且**不要整屏识别**,只识别裁好的行带。

返回的坐标一律换算回**原图坐标系**,方便上层按位置排序。
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from PIL import Image


@dataclass(frozen=True)
class TextBox:
    text: str
    score: float
    # 原图坐标系(左上/右下)
    x0: int
    y0: int
    x1: int
    y1: int

    @property
    def cx(self) -> float:
        return (self.x0 + self.x1) / 2

    @property
    def cy(self) -> float:
        return (self.y0 + self.y1) / 2

    @property
    def height(self) -> int:
        return self.y1 - self.y0


class Ocr:
    """懒加载 + 预热。engine 首次调用会下载/加载模型,别在计时逻辑里第一次调它。"""

    def __init__(self, upscale: float = 2.0, min_score: float = 0.5):
        self.upscale = upscale
        self.min_score = min_score
        self._engine = None

    @property
    def engine(self):
        if self._engine is None:
            from rapidocr import RapidOCR  # 延迟导入:不跑 OCR 时不需要 onnxruntime

            self._engine = RapidOCR()
        return self._engine

    def warmup(self) -> None:
        """跑一张 32x32 白图,把模型加载开销挪到流程开始前。"""
        blank = Image.new("RGB", (32, 32), (255, 255, 255))
        self.read(blank)

    def read(self, image: Image.Image) -> list[TextBox]:
        if image.width < 8 or image.height < 8:
            return []
        return self._run(image, use_det=True)

    def read_line(self, image: Image.Image) -> str:
        """单行小块(价格/角标)专用:跳过检测、直接识别。

        实测:det 对"右侧贴着裁剪边缘的小数字"经常直接检不到(200 检不到、130 检得到,
        纯属运气),而 rec-only 四条价格全是 0.999+。所以数字类裁剪一律走这条路。
        """
        if image.width < 8 or image.height < 8:
            return ""
        boxes = self._run(image, use_det=False)
        return " ".join(b.text for b in boxes)

    def _run(self, image: Image.Image, use_det: bool) -> list[TextBox]:
        scale = self.upscale
        work = image if scale == 1 else image.resize(
            (int(image.width * scale), int(image.height * scale)), Image.LANCZOS
        )
        arr = np.array(work.convert("RGB"))[:, :, ::-1]  # RGB → BGR,RapidOCR 吃 OpenCV 顺序
        if use_det:
            result = self.engine(arr)
        else:
            result = self.engine(arr, use_det=False, use_rec=True)
        txts = list(getattr(result, "txts", None) or [])
        scores = list(getattr(result, "scores", None) or [])
        boxes = getattr(result, "boxes", None)

        out: list[TextBox] = []
        if len(txts) == 0:
            return out
        for i, (text, score) in enumerate(zip(txts, scores)):
            if not text or score < self.min_score:
                continue
            # rec-only 模式没有 boxes,用整块区域代替
            if boxes is None or i >= len(boxes):
                x0, y0, x1, y1 = 0, 0, image.width, image.height
            else:
                xs = [float(p[0]) / scale for p in boxes[i]]
                ys = [float(p[1]) / scale for p in boxes[i]]
                x0, y0, x1, y1 = int(min(xs)), int(min(ys)), int(max(xs)), int(max(ys))
            out.append(TextBox(text=str(text).strip(), score=float(score), x0=x0, y0=y0, x1=x1, y1=y1))
        return out

    def read_text(self, image: Image.Image) -> str:
        """只要文本(按 y 再 x 排序后拼起来)。"""
        return " ".join(b.text for b in sorted(self.read(image), key=lambda b: (b.y0, b.x0)))
