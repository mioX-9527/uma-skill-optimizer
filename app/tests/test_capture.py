"""端到端集成测试:造假帧 → 真 OCR → 匹配 → plan。

为什么要这个:校准要等真实截图,但**行锚定/去重/灰显/符号消歧/OCR**这整条链路现在就能验。
它同时把 PP-OCR 的真实缺陷(丢 ◎、○ 认成 。)带进回归,模型一升级就会暴露。

假帧按**真实界面**的样子造:每张可购买卡片右侧一个纯绿色「+」按钮(行锚点),
卡片高度**故意不统一**(140 / 210 / 150),因为真机就是这样——
带「达成进化条件」标题的金卡更高。按固定行高切行的实现会在这份数据上直接崩。

跑法:`python app/tests/test_capture.py`(需要 OCR 栈,约 6 秒)
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from PIL import Image, ImageDraw, ImageFont  # noqa: E402

from app.capture import capture_all  # noqa: E402
from app.layout import Profile, load_profile  # noqa: E402
from app.match import SkillIndex, is_unbuyable, resolve_rows, to_plan_skills  # noqa: E402
from app.ocr import Ocr  # noqa: E402

FONT = r"C:\Windows\Fonts\msyh.ttc"
FAILS: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    print(f"  {'ok  ' if cond else 'FAIL'} {name}  {detail if not cond else ''}")
    if not cond:
        FAILS.append(name)


def make_profile() -> Profile:
    """拿真实 profile 的数字,但强制视为已校准(测试用假帧,尺寸也对得上)。"""
    p = load_profile(720, 1280)
    raw = dict(p.raw)
    raw["calibrated"] = True
    return Profile(raw)


# (名字, 价格, 卡片高度, 是否已获得, 等级符号)
Item = tuple[str, int, int, bool, str]


def render_page(profile: Profile, items: list[Item], top: int = 520) -> Image.Image:
    """按真实界面画一页:卡片高度各异,可购买的有绿「+」,已获得的没有。

    等级符号按真机画法画成**细线空心圆**(1px 描边)——这正是 PP-OCR 读不出、
    但 symbol.py 能靠连通域填充率认出来的形态。
    """
    img = Image.new("RGB", profile.resolution, (24, 26, 32))
    d = ImageDraw.Draw(img)
    font = ImageFont.truetype(FONT, 22)
    small = ImageFont.truetype(FONT, 16)
    crops = profile.raw["crops"]
    ink = (58, 40, 24)          # 名字的深棕,灰阶约 44,稳稳低于二值化阈值 200

    y = top
    for name, pt, height, owned, symbol in items:
        bottom = y + height
        d.rectangle((8, y, 712, bottom),
                    fill=(206, 206, 210) if owned else (222, 236, 250))
        cy = (y + bottom) // 2
        if not owned:
            d.ellipse((629, cy - 22, 671, cy + 22), fill=(76, 175, 80))
        nc = crops["name"]
        tx, ty = nc["x0"] + 4, cy + nc["dy0"] + 6
        d.text((tx, ty), name, font=font, fill=ink)
        if symbol:
            tw = font.getbbox(name)[2]
            sx = tx + tw + 4
            d.ellipse((sx, ty + 4, sx + 14, ty + 19), outline=ink, width=1)
        d.text((nc["x0"] + 4, cy + 34), "本场比赛中速度略有提升", font=small, fill=(120, 126, 136))
        if not owned:
            pc = crops["price"]
            d.text((pc["x0"] + 2, cy + pc["dy0"] + 6), str(pt), font=font, fill=ink)
        else:
            d.text((470, cy - 12), "已获得", font=font, fill=(220, 90, 120))
        y = bottom + 14
    return img


class FakeAdb:
    """只实现 capture 用到的方法。y 变大 = 手指下划 = 回到更上面;y 变小 = 往下翻。"""

    def __init__(self, pages: list[Image.Image], start: int = 2):
        self.pages = pages
        self.index = min(start, len(pages) - 1)
        self.captures = 0

    def screencap(self) -> Image.Image:
        self.captures += 1
        return self.pages[max(0, min(self.index, len(self.pages) - 1))]

    def swipe(self, x1, y1, x2, y2, duration_ms: int = 250) -> None:
        if y2 > y1:                      # 向下划 → 回顶部方向
            self.index = max(0, self.index - 1)
        else:                            # 向上划 → 往下翻
            self.index = min(len(self.pages) - 1, self.index + 1)

    def settle(self, seconds: float = 0.0) -> None:
        pass

    def foreground_package(self) -> str:
        return ""


class Meta:
    width, height = 720, 1280
    size = (width, height)   # 和真实 ScreenMeta.size 对齐:横屏检查拿它跟截图尺寸比


def main() -> int:
    profile = make_profile()
    index = SkillIndex.load()
    ocr = Ocr()

    # 已获得(无按钮)、金卡(高)、普通卡混排。
    # 注意 ○ 只出一个等级:○ 和 ◎ 在界面上是同一格,不可能同时出现两行。
    p0: list[Item] = [("让你们见识一下白色闪电！", 0, 150, True, ""),
                      ("迅疾如风", 200, 140, False, ""),
                      ("中距离直线", 130, 210, False, "○")]
    p1: list[Item] = [("中距离直线", 130, 210, False, "○"),
                      ("弯道恢复", 90, 150, False, "○"),
                      ("直线能手", 100, 150, False, "")]
    p2: list[Item] = [("弯道恢复", 90, 150, False, "○"),
                      ("鹰眼", 88, 150, False, ""),
                      ("直线能手", 100, 160, False, "")]
    pages = [render_page(profile, p0), render_page(profile, p1), render_page(profile, p2),
             render_page(profile, p2)]     # 最后一页重复 = 到底
    adb = FakeAdb(pages, start=2)
    result = capture_all(adb, Meta(), profile, ocr, max_pages=10)

    print("抓取")
    check("从中间起步也能回顶后重新开始", result.frames >= 3, f"frames={result.frames}")
    check("有停止原因", bool(result.stop_reason), result.stop_reason)
    check("页数受控", result.pages <= 8, f"pages={result.pages}")
    check("没有读不出名字的行", not result.unread, str(result.unread))
    names = [r.name_text for r in result.rows]
    # 期望去重后 5 个:迅疾如风/中距离直线/弯道恢复/直线能手/鹰眼
    check("跨屏重叠被去重(5 个不同行)", len(result.rows) == 5, f"{len(result.rows)} 行:{names}")
    check("已获得(无绿按钮)的行不进候选", "让你们见识一下白色闪电！" not in names, str(names))

    print("符号检测")
    sym_rows = {r.name_text: r.symbol for r in result.rows}
    check("中距离直线 检出 ○", sym_rows.get("中距离直线") == "○", str(sym_rows))
    check("弯道恢复 检出 ○", sym_rows.get("弯道恢复") == "○", str(sym_rows))
    check("迅疾如风 不误判出符号", sym_rows.get("迅疾如风") is None, str(sym_rows))
    check("鹰眼 不误判出符号", sym_rows.get("鹰眼") is None, str(sym_rows))

    print("匹配")
    matches = resolve_rows(result.rows, index)
    for m in matches:
        print("   " + str(m))
    by_name = {m.skill.name: m for m in matches if m.skill}
    check("迅疾如风 精确命中", "迅疾如风" in by_name)
    check("鹰眼 精确命中", "鹰眼" in by_name)
    # ○ 由形状检测给出,应该直接命中单圈且不需要人工确认
    check("中距离直线 → 中距离直线○(符号已确定,无需确认)",
          "中距离直线○" in by_name and not by_name["中距离直线○"].needs_confirm,
          str(by_name.get("中距离直线○")))
    check("弯道恢复 → 弯道恢复○", "弯道恢复○" in by_name, str(list(by_name)))
    check("单圈价格带对", by_name["中距离直线○"].price == 130, str(by_name["中距离直线○"]))

    print("输出")
    plan = to_plan_skills(matches)
    pts = {p["name"]: p["pt"] for p in plan}
    check("可进候选 5 条", len(plan) == 5, str(pts))
    check("中距离直线○ 价格 130", pts.get("中距离直线○") == 130, str(pts))

    print("索引过滤")
    raw = SkillIndex.load().skills
    check("× 类减益绿技能不在索引里",
          not any(s.name.endswith("×") and "场地" in s.name for s in raw),
          str([s.name for s in raw if s.name.endswith("×") and "场地" in s.name][:3]))
    check("is_unbuyable 认得良场地×",
          is_unbuyable({"effects": [{"type": "passive", "stat": "power", "value": -40}]}))
    check("is_unbuyable 不误伤 回复类被动",
          not is_unbuyable({"effects": [{"type": "passive", "stat": "speed", "value": 40}]}))

    print("预检(这两种翻车以前是静默的)")
    class LandscapeAdb(FakeAdb):
        """模拟器横屏:screencap 出来是 1280x720,而 wm size 永远报 720x1280。"""
        def screencap(self):
            return super().screencap().rotate(90, expand=True)

    try:
        capture_all(LandscapeAdb(pages, start=0), Meta(), profile, ocr, max_pages=2)
        check("横屏直接报错而不是空转", False, "没抛异常")
    except RuntimeError as exc:
        check("横屏直接报错而不是空转", "横屏" in str(exc), str(exc))

    blank = render_page(profile, [])     # 空页 = 没有绿色「+」按钮 = 一行都读不到
    try:
        capture_all(FakeAdb([blank, blank], start=0), Meta(), profile, ocr, max_pages=2)
        check("不是技能页直接报错", False, "没抛异常")
    except RuntimeError as exc:
        check("不是技能页直接报错", "技能学习" in str(exc), str(exc))

    print()
    if FAILS:
        print(f"失败 {len(FAILS)} 项:{', '.join(FAILS)}")
        return 1
    print("全部通过")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
