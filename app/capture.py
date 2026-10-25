"""翻页抓取编排:fling 回顶 → 小步逐屏 → 按钮锚定取行 → 去重 → 判停。

实测出来的四条规则(2026-10-25,雷电 720x1280):
1. **滑动必须落在列表区内**(y 480~960)。起点落在上半屏马娘立绘上时,游戏直接忽略这次滑动。
2. **回顶用短时长长距离 fling**(duration 120ms):每次滚 3~4 行;而慢速拖 250px 只滚不到一行,
   十几步也爬不回顶。
3. **判停比对「这一屏读到的技能名序列」**,不用像素差。列表有 overscroll 回弹,
   到底时像素仍在抖(实测差 5~20),而名字序列会稳定下来。
4. **精读用小步慢拖**(每次 1~1.5 行),保证相邻两屏重叠 ≥1 行——重叠是唯一的防漏手段。
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from PIL import Image

from .adb import Adb, ScreenMeta
from .layout import Profile
from .match import Row, normalize
from .ocr import Ocr
from .symbol import detect as detect_symbol


@dataclass
class CaptureResult:
    rows: list[Row] = field(default_factory=list)
    pages: int = 0
    stop_reason: str = ""
    pt_balance: int | None = None
    frames: int = 0
    # 每屏读到的名字,便于排查"哪屏漏了"
    pages_seen: list[list[str]] = field(default_factory=list)
    # 按钮检测到了但名字没识别出来(OCR 空/被遮),这类行是真漏,必须报出来
    unread: list[str] = field(default_factory=list)


def frame_diff(a: Image.Image, b: Image.Image) -> float:
    """两帧的平均灰度差(0~255)。仅供参考,判停不用它。"""
    if a.size != b.size:
        return 255.0
    ga = np.asarray(a.convert("L"), dtype=np.int16)
    gb = np.asarray(b.convert("L"), dtype=np.int16)
    return float(np.abs(ga - gb).mean())


def read_pt_balance(ocr: Ocr, image: Image.Image, profile: Profile) -> int | None:
    """读顶部「当前技能点数」——纯数字,识别率最高,顺手当预算用。"""
    import re

    text = ocr.read_line(profile.pt_balance_box().crop(image))
    m = re.search(r"\d{2,6}", text.replace(",", ""))
    return int(m.group()) if m else None


def read_page(image: Image.Image, profile: Profile, ocr: Ocr, page: int) -> list[Row]:
    """从一屏里读出所有可购买行(尚未去重)。名字读不出来的也返回(空名字),由上层统计。"""
    rows: list[Row] = []
    for cy in profile.find_rows(image):
        name_crop = profile.crop_around(image, cy, "name")
        name = ocr.read_text(name_crop)
        # ○ 的笔画只有 1~2px,PP-OCR 一律读不出来 → 用连通域形状单独判(见 symbol.py)
        hit = detect_symbol(name_crop)
        # 价格是一小块纯数字:走 rec-only,不用检测(检测对小数字不稳定,实测会漏)
        price = ocr.read_line(profile.crop_around(image, cy, "price"))
        rows.append(Row(name_text=name.strip(), price_text=price, y=cy, page=page,
                        symbol=hit.symbol if hit else None,
                        symbol_confident=hit.confident if hit else True))
    return rows


def attach_evolutions(adb: Adb, image: Image.Image, profile: Profile, ocr: Ocr,
                      rows: list[Row], progress=None) -> int:
    """把这一屏里「可进化」的金技能逐个点开读弹窗,结果挂到对应行上。

    为什么要真点:静态映射不知道当前马娘是否满足条件,也不保证覆盖所有分支;
    弹窗里才写着「条件已达成」。实测一次 ≈ 2.5 秒(点开 1.1 + OCR 0.5 + 返回 0.8)。
    """
    from .evolve import find_all_buttons, read_evolution

    if not rows:
        return 0
    buttons = find_all_buttons(image, profile.list_top, profile.list_bottom)
    if not buttons:
        return 0
    used: set[int] = set()
    opened = 0
    for bx, by in buttons:
        # 找 y 最接近的那一行;只有可购买行(有绿色 + 按钮)才值得读
        best_i, best_d = -1, 10 ** 9
        for i, r in enumerate(rows):
            if i in used:
                continue
            d = abs(r.y - by)
            if d < best_d:
                best_i, best_d = i, d
        if best_i < 0 or best_d > 90:
            continue
        used.add(best_i)
        evo = read_evolution(adb, ocr, image, type("Btn", (), {"tap_x": bx, "tap_y": by, "row_cy": by})())
        if evo is None:
            if progress:
                progress(f"    进化弹窗没读到(行 cy={rows[best_i].y})")
            continue
        rows[best_i].evolve = evo
        opened += 1
        if progress:
            for t in evo.targets:
                flag = "条件已达成" if t.condition_met else "条件未达成"
                progress(f"    可进化:{evo.from_name} → {t.name}({flag})")
    return opened


def _signature(rows: list[Row]) -> tuple[str, ...]:
    return tuple(normalize(r.name_text) for r in rows)


def _drag(adb: Adb, cfg: dict) -> None:
    adb.swipe(int(cfg["x"]), int(cfg["y0"]), int(cfg["x"]), int(cfg["y1"]),
              int(cfg["duration_ms"]))
    adb.settle(float(cfg["settle_s"]))


def scroll_to_top(adb: Adb, meta: ScreenMeta, profile: Profile, ocr: Ocr,
                  progress=None) -> int:
    """fling 回顶。

    判停用 `find_rows` 的 cy 序列,**不做 OCR**——回顶只为定位,识别放到后面的精读阶段,
    这样每次只要 1 秒(截图 + 一次 HSV 检测)。

    两个实测教训:
    - **不要用像素差判停**:列表到底/到顶会 overscroll 回弹,像素一直在抖。
    - **不要用「两次相同」就收工**:偶发一次 fling 没滚动会误判到顶,导致顶部几条被漏掉
      (实测就这么漏掉过 闪光☆着陆 / Q.E.D. 两条)。所以要求连续 3 次 cy 序列完全一致。
    """
    cfg = profile.scroll["to_top"]
    prev: tuple[int, ...] | None = None
    same = 0
    for step in range(int(cfg["max_steps"])):
        adb.swipe(int(cfg["x"]), int(cfg["y0"]), int(cfg["x"]), int(cfg["y1"]),
                  int(cfg["duration_ms"]))
        adb.settle(float(cfg["settle_s"]))
        cur = tuple(profile.find_rows(adb.screencap()))
        if progress and step % 4 == 0:
            progress(f"  回顶 {step + 1}/{cfg['max_steps']} 行中心={cur}")
        if prev is not None and cur == prev:
            same += 1
            if same >= 2:          # 连续 3 次一致 → 真的到顶
                return step + 1
        else:
            same = 0
        prev = cur
    return int(cfg["max_steps"])


def check_orientation(adb: Adb, meta: ScreenMeta) -> None:
    """确认截图方向和版式一致。**不碰 OCR**,所以放在 warmup 之前 —— 横屏时能立刻报错,
    不用先花两秒加载 OCR 模型。

    `wm size` 报的永远是竖屏物理尺寸(720x1280),而 `screencap` 给的是旋转后的位图
    (横屏时 1280x720)。方向一错,所有裁切框全落在错误位置,每一屏都读不出名字,
    表现就是"读取不了"—— 而且不会报错,只会安静地空转 26 屏。
    """
    image = adb.screencap()
    if image.size != meta.size:
        raise RuntimeError(
            f"截图是 {image.size[0]}x{image.size[1]},而模拟器分辨率是 {meta.width}x{meta.height}"
            f" —— 模拟器现在是**横屏**。\n"
            f"  赛马娘的技能页是竖屏,先把模拟器转回竖屏(雷电右侧工具栏的旋转按钮),"
            f"再点「从模拟器读取」。"
        )


def check_on_skill_page(adb: Adb, profile: Profile, ocr: Ocr) -> None:
    """确认当前真的停在「技能学习」列表:第一屏至少得读出一个技能名。

    停在别的界面(别的游戏 / 育成已结束的结算页)时,一行技能都找不到。
    不拦的话它会老老实实滚 26 屏、每帧跑一遍 OCR,几十秒后给一堆空结果。
    """
    image = adb.screencap()
    if not any(r.name_text for r in read_page(image, profile, ocr, 0)):
        adb.settle(0.5)  # 偶发:截图正落在滑动动画里,补一帧再判
        image = adb.screencap()
        if not any(r.name_text for r in read_page(image, profile, ocr, 0)):
            fg = adb.foreground_package()
            raise RuntimeError(
                "一行技能都没读到,当前页面不像「技能学习」列表"
                + (f"(前台应用:{fg})" if fg else "")
                + "。\n  请先回到 育成 → 技能学习(能上下滚动的那一屏),再读。"
            )


def capture_all(adb: Adb, meta: ScreenMeta, profile: Profile, ocr: Ocr,
                max_pages: int | None = None, progress=None,
                read_evolve: bool = True) -> CaptureResult:
    if not profile.calibrated:
        raise RuntimeError(
            "版式还没校准(profile.calibrated=false),先跑 `python -m app.cli calibrate`。\n"
            "  坐标不对时硬抓只会把名字和价格串错行。"
        )
    check_orientation(adb, meta)
    ocr.warmup()
    check_on_skill_page(adb, profile, ocr)
    if progress:
        progress("已确认停在技能列表(竖屏)")
    result = CaptureResult()
    steps = scroll_to_top(adb, meta, profile, ocr, progress)
    if progress:
        progress(f"已到列表顶部(fling {steps} 次)")

    cfg = profile.scroll["to_bottom"]
    limit = max_pages if max_pages is not None else int(cfg["max_steps"])

    # 去重键 = (归一化名字, 价格):只按名字会把 ○/◎ 当同一行合并掉
    # (OCR 常常把两者的符号都读丢),而这两者是不同技能、价格也不同。
    seen: dict[tuple[str, int | None], Row] = {}
    prev_sig: tuple[str, ...] | None = None
    prev_names: set[str] = set()
    same_streak = 0
    gaps: list[str] = []       # 连续两次相邻屏零交集 → 可能跳过了行
    gap_streak = 0

    for page in range(limit):
        image = adb.screencap()
        result.frames += 1
        result.pages = page + 1
        if result.pt_balance is None:
            result.pt_balance = read_pt_balance(ocr, image, profile)

        rows = read_page(image, profile, ocr, page)
        if not any(r.name_text for r in rows):
            # 偶发:截图正落在滑动动画中间,整屏一个名字都没读到。补拍一次再判。
            adb.settle(0.5)
            image = adb.screencap()
            result.frames += 1
            rows = read_page(image, profile, ocr, page)

        blank = [r for r in rows if not r.name_text]
        if blank:
            result.unread.append(f"第{page + 1}屏 cy={[r.y for r in blank]}")

        # 可进化的金技能:点开「进化 ⓘ」读弹窗(只读操作,用返回键关闭)
        if read_evolve:
            attach_evolutions(adb, image, profile, ocr, rows, progress)
        new = 0
        for row in rows:
            key = (normalize(row.name_text), row.price)
            if not key[0]:
                continue
            if key in seen:
                # 同一技能跨屏重现:后一屏读到了进化信息就补上(前一屏可能在边缘没点到)
                if seen[key].evolve is None and row.evolve is not None:
                    seen[key].evolve = row.evolve
                continue
            seen[key] = row
            new += 1
        result.pages_seen.append([r.name_text for r in rows])
        if progress:
            shown = " / ".join(f"{r.name_text} {r.price or ''}" for r in rows) or "(无)"
            progress(f"第 {page + 1} 屏 +{new} 累计 {len(seen)}:{shown}")

        cur_names = {normalize(r.name_text) for r in rows if r.name_text}
        if prev_names and cur_names and not (prev_names & cur_names):
            # 相邻两屏零交集可能是"滚得太狠",也可能只是上一屏的行刚好被更小的
            # 可读区切掉了(可见区只放得下 2 行,每次滚 1 行时很常见)。所以连续两次才报。
            gap_streak += 1
            if gap_streak >= 2:
                gaps.append(f"第 {page - 1}~{page + 1} 屏")
        else:
            gap_streak = 0
        prev_names = cur_names

        sig = _signature(rows)
        if prev_sig is not None and sig and sig == prev_sig:
            same_streak += 1
            if same_streak >= 2:
                result.stop_reason = "连续三屏内容相同(到底了)"
                break
        else:
            same_streak = 0
        prev_sig = sig

        _drag(adb, cfg)
    else:
        result.stop_reason = f"达到 {limit} 屏上限,可能还有未读到的技能"

    result.rows = list(seen.values())
    if result.unread:
        result.stop_reason += (
            f";⚠ {len(result.unread)} 行按钮在但名字没读出来({', '.join(result.unread[:3])}),"
            f"这些技能漏了"
        )
    if gaps:
        result.stop_reason += (
            f";⚠ {len(gaps)} 处连续两屏无重叠({', '.join(gaps[:4])}),可能跳过了技能——"
            f"可调小版式 scroll.to_bottom 的 y0-y1 距离后重抓"
        )
    return result
