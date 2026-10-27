"""读取双圈(◎)的真实价格:点加号把单圈加进购物车,那一行会变成 ◎ 并显示「还需」价。

**实测依据**(2026-10-27,雷电 720x1280,中山 2500m 购买界面):

- 绿色 **+ 按钮能被 `input tap` 点动**。这与 `evolve.py` 里"tap 大多无效"不冲突 ——
  那条说的是技能行/信息面板;`+` / `−` 是可交互控件。
- 点 `+` 之后:该行**立刻变成「◎」**,价格换成"双圈还需要多少点数";顶部「当前技能点数」
  同步减掉单圈价;底部「确定」变亮。**此时还没真正购买**。
- 点 `−` 撤回:价格与点数都恢复原值。
  实测 `顺时针○` 54pt → 行变「顺时针◎ 66pt」→ 点 − 后回到 54pt / 2941 点,**一分没花**。
- 66 与「◎基准 110 × 单圈实付 54 / 单圈基准 90 = 66」完全吻合,说明读到的就是这个数。

**为什么值得做**:◎ 的基准价要从 wiki 抓,而 wiki 有 16 个词条缺数据(BWIKI 对本机 IP
还全站 567)。现场读一步,就绕开了整个"缺基准价"的坑,而且拿到的是**你号的真实折扣价**。

**三条安全约束(改这个文件前先读)**:

1. **绝不点「确定」**。只点 `+` 和 `−`,两者都在行右侧固定位置。
2. 点 `+` 后必须校验"点数确实减少了";没减少说明点空了 → 立刻放弃,**不要**再去点 `−`
   (避免在未知状态下乱点)。
3. 用过就必须把点数校验回原值;对不上抛 `CircleProbeError`,让上层提示用户手动看购物车。
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path

from PIL import Image

from .adb import Adb
from .capture import read_page, read_pt_balance
from .layout import Profile
from .match import Row
from .ocr import Ocr

DATA_DIR = Path(__file__).resolve().parent.parent / "data"


class CircleProbeError(RuntimeError):
    """读价过程中出现"状态没还原"的情况 —— 需要用户手动检查购物车。"""


@dataclass(frozen=True)
class ProbeResult:
    price: int | None          # 双圈还需的点数;None = 没读到
    ok: bool                   # 是否"点了并成功还原"
    note: str = ""


def parse_price(text: str) -> int | None:
    """从价格文本里取数字(与 match.Row.price 同一条正则)。"""
    m = re.search(r"\d{2,4}", text or "")
    return int(m.group()) if m else None


def _tap_cfg(profile: Profile) -> tuple[int, int]:
    """(加号 x, 减号 x)。写进版式,换分辨率要重新校准。"""
    c = profile.raw.get("circle") or {}
    return int(c.get("plus_x", 650)), int(c.get("minus_x", 515))


def probe_upgrade_price(adb: Adb, profile: Profile, ocr: Ocr, name: str,
                        pt_before: int) -> ProbeResult:
    """把 name 这一行的单圈加进购物车、读双圈价、再撤回。

    `pt_before` = 点之前的「当前技能点数」,用它判断"点中了没有"和"撤回了没有"。

    **为什么要在点之前重新定位**:实测吃过两次亏 ——
    1. 刚滑完列表时截图,等真去点时列表还在惯性滚动,拿旧 y 点会**点空**(点数不变);
    2. 用 `input tap` 也不行,游戏在滚动中会忽略极短触摸。
    所以这里:先 settle → **重新截一帧按名字找这一行** → 用那一帧的 y 点 → 用点数变化确认点中了。
    价格 OCR 会抖(同一行读出过 72/88),读不成就重截一次。
    """
    plus_x, minus_x = _tap_cfg(profile)
    tapped = False

    def _pt() -> int | None:
        return read_pt_balance(ocr, adb.screencap(), profile)

    try:
        adb.settle(1.0)
        img = adb.screencap()
        row = next((r for r in read_page(img, profile, ocr, 0)
                    if r.name_text == name and r.symbol == "○"), None)
        if row is None:
            return ProbeResult(None, False, "点之前重新定位时没找到这一行(列表还在动)")
        y = row.y

        for attempt in range(2):
            adb.tap(plus_x, y)
            adb.settle(1.2)
            pt_after = _pt()
            if pt_after is not None and pt_after < pt_before:
                tapped = True
                break
            if attempt == 0:
                adb.settle(0.8)
                img = adb.screencap()
                again = next((r for r in read_page(img, profile, ocr, 0)
                              if r.name_text == name and r.symbol == "○"), None)
                if again is None:
                    break
                y = again.y
        if not tapped:
            return ProbeResult(None, False, "点加号没生效(可能列表仍在动或该行不可买)")

        # 价格要"读到两次一致"才采信:实测同一行读出过 99 / 66(价格还在动画中就截了图),
        # 而两位数的 OCR 抖动没法事后分辨谁对 —— 宁可这一次不读,也不能写个错的进去。
        # 加购后还要**按名字重新定位**:行的 y 会因重排微动,用旧 y 会读到隔壁行的价
        # (实测把良场地的 99 读成了别行的 66)。定位到之后同一帧裁价格,再要求两次一致。
        seen: list[int] = []
        for _ in range(4):
            img = adb.screencap()
            now = next((r for r in read_page(img, profile, ocr, 0) if r.name_text == name), None)
            if now is not None:
                v = parse_price(ocr.read_line(profile.crop_around(img, now.y, "price")))
                if v is not None:
                    seen.append(v)
                    if len(seen) >= 2 and seen[-1] == seen[-2]:
                        return ProbeResult(v, True, "")
            adb.settle(0.45)
        return ProbeResult(None, False, f"价格读数不稳定({'/'.join(map(str, seen)) or '空'}),已跳过")
    finally:
        if tapped:
            back = None
            for attempt in range(2):
                adb.tap(minus_x, y)
                adb.settle(1.2)
                back = _pt()
                if back == pt_before:
                    break
                if attempt == 0:
                    adb.settle(0.5)
            else:
                raise CircleProbeError(
                    f"撤回后点数对不上(点前 {pt_before} / 撤回后 {back})——"
                    f"请手动打开技能购买界面的购物车确认没有残留"
                )


# ── 哪些单圈值得探:配对的双圈在 data/skill-pt.json 里没有基准价 ──────────

def load_missing_circle_bases(data_dir: Path | None = None) -> set[str]:
    """返回「有 ◎ 兄弟、但 ◎ 或 ○ 缺基准价」的单圈技能名(**不含 ○ 后缀**)。

    与前端 `data.ts` 的 CIRCLE_UPGRADES_MISSING 同一判据:名单里的技能,
    前端会提示"没有纳入比较"。这些正是现场读一步就能补上的。
    """
    d = data_dir or DATA_DIR
    try:
        skills = json.loads((d / "skills.json").read_text(encoding="utf-8"))
        pt = json.loads((d / "skill-pt.json").read_text(encoding="utf-8")).get("pt", {})
    except OSError:
        return set()

    by_name = {s["name"]: s for s in skills if isinstance(s, dict)}
    out: set[str] = set()
    for up in skills:
        name = up.get("name", "")
        if not name.endswith("◎") or up.get("cnReleased") is False:
            continue
        base = by_name.get(name[:-1] + "○")
        if base is None:
            continue
        up_pt = pt.get(up.get("nameJa") or "")
        base_pt = pt.get(base.get("nameJa") or "")
        if isinstance(up_pt, (int, float)) and up_pt > 0 and isinstance(base_pt, (int, float)):
            continue                      # 价格齐,前端本来就会算,不用现场读
        out.add(name[:-1])                # 去掉 ◎,得到"长距离弯道"这样的基名
    return out


def attach_circle_prices(adb: Adb, profile: Profile, ocr: Ocr, rows: list[Row],
                         pt_before: int | None, limit: int = 3,
                         known: set[str] | None = None) -> dict[str, int]:
    """对缺价的单圈行逐个现场读双圈价,返回 {单圈基名: 双圈还需点数}。

    只处理 `symbol == '○'` 且命中缺价名单的行;`limit` 防止一次读太多把用户等烦
    (每个约 2.5 秒)。
    """
    if not rows or pt_before is None or limit <= 0:
        return {}
    missing = load_missing_circle_bases()
    if not missing:
        return {}

    out: dict[str, int] = {}
    for r in rows:
        if len(out) >= limit:
            break
        if r.symbol != "○" or not r.name_text:
            continue
        base = r.name_text.strip()
        if base not in missing or (known is not None and base in known):
            continue
        res = probe_upgrade_price(adb, profile, ocr, base, pt_before)
        if res.ok and res.price is not None:
            out[base] = res.price
    return out
