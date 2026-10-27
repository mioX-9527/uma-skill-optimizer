"""把推荐组合在游戏的技能购买界面里"勾上":点加号加入购物车,**绝不点确定**。

用户要的是"省掉逐行找技能、逐个点加号"的操作,买入这一步仍然由人自己按「确定」。

**实测依据**(2026-10-27,雷电 720x1280):

- 点行右侧绿色「+」= 加入购物车:该行变成「◎」(单圈)或「已获得」,顶部「当前技能点数」
  同步减少,底部「确定」变亮。**不点确定不算购买**;点「−」可撤回,点数原样恢复。
- 所以本模块的每一步都可以回退,但**必须保证不碰「确定」** —— 那是唯一不可逆的按钮。

**两个必须处理的细节**:

1. **双圈要两下**。推荐里是「良场地◎」时,列表里那一行先是「良场地○」,点一次 + 才变成
   「良场地◎」,再点一次 + 才算勾上。所以按名字尾缀决定点几下。
2. **点完行会重排**。第二次点之前必须重新截图、按名字重新定位 y(与 circle.py 同一个坑)。

**开工前的前置检查**:如果购物车已经有东西(当前点数 ≠ 读取时的点数),直接拒绝 ——
在不知情的残留上再叠一串,用户根本算不清自己花了多少。
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .adb import Adb, ScreenMeta
from .capture import check_on_skill_page, check_orientation, read_page, read_pt_balance, scroll_to_top
from .layout import Profile
from .ocr import Ocr


class SelectError(RuntimeError):
    """前置条件不满足(不在购买页 / 购物车不干净)。"""


@dataclass
class SelectOutcome:
    done: list[str] = field(default_factory=list)        # 勾上的(用界面上的名字)
    failed: list[tuple[str, str]] = field(default_factory=list)   # (名字, 原因)
    pt_before: int | None = None
    pt_after: int | None = None

    @property
    def total(self) -> int:
        return len(self.done) + len(self.failed)


def _clean(name: str) -> str:
    """去掉名字尾部的 ○/◎ —— OCR 读不出这两个符号,行名字里只有基名。

    **顺序很关键**:必须先 strip 空白再剥符号。反过来的话 `" 中山赛场○ "` 的 rstrip("○◎")
    什么都剥不掉(末尾是空格),结果带着 ○ 去跟行名字对位,永远匹配不上。
    """
    return name.strip().rstrip("○◎").strip()


def _taps_of(name: str) -> int:
    """「良场地◎」要点两下(先单圈后双圈),其余一下。"""
    return 2 if name.rstrip().endswith("◎") else 1


def select_in_shop(adb: Adb, meta: ScreenMeta, profile: Profile, ocr: Ocr,
                   names: list[str], pt_before: int | None,
                   progress=None, max_pages: int | None = None) -> SelectOutcome:
    """按**界面从上到下**的顺序,把 names 里每个技能点加号勾上(不提交)。

    `pt_before` = 读取时记下的「当前技能点数」,用来确认购物车是干净的。
    """
    check_orientation(adb, meta)
    check_on_skill_page(adb, profile, ocr)

    img = adb.screencap()
    now_pt = read_pt_balance(ocr, img, profile)
    if pt_before is not None and now_pt is not None and now_pt != pt_before:
        raise SelectError(
            f"购物车里已经有东西了(当前 {now_pt} 点 / 读取时 {pt_before} 点)。"
            f"请先点游戏里的「重置」或把已选项取消,再让我勾。"
        )

    # 目标:基名 → 还要点几下(双圈两下)
    pending: dict[str, int] = {}
    display: dict[str, str] = {}
    for n in names:
        base = _clean(n)
        if base and base not in pending:
            pending[base] = _taps_of(n)
            display[base] = n

    out = SelectOutcome(pt_before=pt_before)
    steps = scroll_to_top(adb, meta, profile, ocr, progress)
    if progress:
        progress(f"已回到列表顶部(fling {steps} 次)")

    cfg = profile.scroll["to_bottom"]
    limit = max_pages if max_pages is not None else int(cfg["max_steps"])

    seen_pages: set[tuple[str, ...]] = set()
    for page in range(limit):
        img = adb.screencap()
        rows = read_page(img, profile, ocr, page)
        sig = tuple(r.name_text for r in rows)
        if sig in seen_pages:
            break
        seen_pages.add(sig)

        for row in rows:
            base = row.name_text.strip()
            taps = pending.get(base)
            if taps is None:
                continue
            ok, reason = _tap_n_times(adb, profile, ocr, base, taps)
            if ok:
                out.done.append(display[base])
                del pending[base]
                if progress:
                    progress(f"已勾选「{display[base]}」")
            else:
                out.failed.append((display[base], reason))
                del pending[base]
                if progress:
                    progress(f"「{display[base]}」没勾上:{reason}")

        if not pending:
            break
        # 下一页
        adb.swipe(360, cfg["y0"], 360, cfg["y1"], int(cfg["duration_ms"]))
        adb.settle(float(cfg["settle_s"]))

    for base in list(pending):
        out.failed.append((display[base], "翻到底也没找到这一行"))

    try:
        out.pt_after = read_pt_balance(ocr, adb.screencap(), profile)
    except Exception:      # noqa: BLE001 读不到不影响主流程
        out.pt_after = None
    return out


def _tap_n_times(adb: Adb, profile: Profile, ocr: Ocr, base: str, taps: int) -> tuple[bool, str]:
    """点 taps 次加号。每次都重新定位(行会重排),用点数变化确认点中了。"""
    cfg = profile.raw.get("circle") or {}
    plus_x = int(cfg.get("plus_x", 650))

    for i in range(taps):
        adb.settle(0.5)
        img = adb.screencap()
        row = next((r for r in read_page(img, profile, ocr, 0) if r.name_text.strip() == base), None)
        if row is None:
            return False, f"第 {i + 1} 次点之前没找到这一行(列表在动?)"
        pt0 = read_pt_balance(ocr, img, profile)
        adb.tap(plus_x, row.y)
        adb.settle(1.2)
        pt1 = read_pt_balance(ocr, adb.screencap(), profile)
        if pt0 is None or pt1 is None:
            return False, "读不到点数,无法确认是否点上"
        if pt1 >= pt0:
            # 可能是惯性滚动吃掉了点击,重定位再试一次
            adb.settle(0.8)
            img = adb.screencap()
            row = next((r for r in read_page(img, profile, ocr, 0) if r.name_text.strip() == base), None)
            if row is None:
                return False, "重试时找不到这一行"
            pt0 = read_pt_balance(ocr, img, profile)
            adb.tap(plus_x, row.y)
            adb.settle(1.2)
            pt1 = read_pt_balance(ocr, adb.screencap(), profile)
            if pt0 is None or pt1 is None or pt1 >= pt0:
                return False, "点加号没生效(该行可能已买过或不可买)"
    return True, ""
