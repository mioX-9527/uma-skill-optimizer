"""把推荐组合在游戏的技能购买界面里"勾上":点加号加入购物车,**绝不点确定**。

用户要的是"省掉逐行找技能、逐个点加号"的操作,买入这一步仍然由人自己按「确定」。

**实测依据**(2026-10-27,雷电 720x1280,技能获取界面):

- 点行右侧绿色「+」= 加入购物车:该行变成「◎」(单圈)或不可再买,顶部「当前技能点数」
  同步减少,底部「确定」变亮。**不点确定不算购买**;点「−」可撤回,点数原样恢复。
  所以本模块的每一步都可以回退,但**必须保证不碰「确定」** —— 那是唯一不可逆的按钮
  (它在 (358,1083),「重置」在 (619,1082),两个按钮挨着,写坐标时别看串)。
- **买满的那一行会留在列表里,但名字被污染**:实测「长距离弯道」买到 ◎ 之后,那一行
  OCR 读出来是「长距离弯道启」(`symbol=None`、`price=None`)——「已获得」角标挤进了名字框。
  所以按名字精确比对在这一步会断,必须先做归一化、再允许"前缀 + 不可购买"的兜底。

**两个必须处理的细节**:

1. **双圈要两下**。推荐里是「良场地◎」时,列表里那一行先是「良场地○」,点一次 + 才变成
   「良场地◎」,再点一次 + 才算勾上。所以按名字尾缀决定点几下。
2. **点完行会重排**。第二次点之前必须重新截图、按名字重新定位 y(与 circle.py 同一个坑)。

**名字对位**(「继承固有没勾」的真正原因,2026-10-27 实测):

- 优化器/技能库里的名字带**库内区分用的尾缀**:`璀璨流星(继承)`、`决不让出领头的景色……！(继承)(1)`。
  而游戏列表里**只有基名**:`璀璨流星`、`决不让出领头的景色……！`。
- 拿库名直接跟行名比,继承版一条都对不上(实测界面上那一行就叫「璀璨流星」)。
  所以一律先 `base_name()` 剥尾缀,再用 `match.normalize` 归一(省略号/全半角/OCR 易混字)。

**「双圈没勾」的真正原因**:名字本来就对得上(◎ 早就剥了),问题在**点半途而废被当成成功** ——
双圈第二下没点上(列表还在动)时,旧代码返回"成功"并把原因丢掉,用户只看到「已勾选」,
实际购物车里只有单圈。现在分成三态(见 TAP_OK / TAP_PARTIAL / TAP_FAIL),部分成功会明说。

**开工前的前置检查**:如果购物车已经有东西(当前点数 ≠ 读取时的点数),直接拒绝 ——
在不知情的残留上再叠一串,用户根本算不清自己花了多少。
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from .adb import Adb, ScreenMeta
from .capture import (
    cart_state, check_on_skill_page, check_orientation, read_page, read_pt_balance, scroll_to_top,
)
from .layout import Profile
from .match import Row, normalize
from .ocr import Ocr

# 技能库为区分条目加的尾缀:「(继承)」是继承版,「(1)/(2)」是同名分支。全角半角都有,一起吃。
_SUFFIX_RE = re.compile(r"[（(]\s*(?:继承|\d+)\s*[）)]")
_SYMBOLS = "○◎"

# 一次点加号最多能掉多少点。单个技能最贵 ~350pt(实测势不可挡 324),
# 超过这个数就是 OCR 读错了,不能当成"点成功"。
_MAX_STEP = 400

# 点加号的三态结果:完全勾上 / 只勾上一部分(双圈只加了单圈) / 一下都没点上。
TAP_OK = "ok"
TAP_PARTIAL = "partial"
TAP_FAIL = "fail"


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


@dataclass(frozen=True)
class _Target:
    """一个要勾的技能。

    `display` 是给用户看的名字(带 ○/◎、带「(继承)」),`base` 是归一化后的**行名**,
    两者不是一回事 —— 报错要用 display(用户认的是那个),找行只能用 base。
    """

    display: str
    base: str
    # 只剥掉 ○/◎ 之后的归一化名。**同一个 family** 才说明它们占游戏里同一格(单圈/双圈),
    # 这时"两条都要"只是"要点两下";不同 family(如库里的 (1)/(2) 分支)才是真的同名歧义。
    family: str
    taps: int
    pt: int | None = None      # 计划里的标价,只在"游戏里两行同名"时用来消歧


def base_name(name: str) -> str:
    """技能库名 → 游戏列表里那一行的名字。

    剥掉三类尾缀:`○/◎`(等级,OCR 也读不出)、`(继承)`、`(1)/(2)`。
    **顺序有讲究**:先剥空白和符号(「 中山赛场○ 」这种带空格的),再剥括号尾缀,
    最后再剥一次符号(「XX(继承)◎」剥完括号会露出 ◎)。搞错顺序就永远匹配不上。
    """
    s = (name or "").strip().rstrip(_SYMBOLS).strip()
    s = _SUFFIX_RE.sub("", s).strip()
    return s.rstrip(_SYMBOLS).strip()


def circle_family(name: str) -> str:
    """只剥 ○/◎ 的归一化名 —— 用来判断两条是不是"同一格的两级"。

    `跟前弯道○` 和 `跟前弯道◎` 的 family 相同(游戏里是同一行,点两下);
    而 `决不让出领头的景色……！(继承)(1)` 与 `(2)` 的 family 不同(库里的两个同名分支)。
    把这两种情况分开,才不会像 2026-10-27 那样把"要点两下"误判成"同名只能勾一条"。
    """
    return normalize((name or "").strip().rstrip(_SYMBOLS).strip())


def _clean(name: str) -> str:
    """兼容旧名:等价于 `base_name`。"""
    return base_name(name)


def row_key(text: str) -> str:
    """行名/库名 → 比对键。走 match.normalize:全半角、易混字、省略号写法都归一。"""
    return normalize(base_name(text))


def _taps_of(name: str) -> int:
    """「良场地◎」要点两下(先单圈后双圈),其余一下。"""
    return 2 if name.rstrip().endswith("◎") else 1


def _targets_of(items: "list[str] | list[dict]") -> list[_Target]:
    """前端既能传 `['良场地◎']`,也能传 `[{name, pt}]`(带标价,同名行才分得清)。

    **同一格的 ○ 和 ◎ 会被合并成一条**(取 ◎ 的名字、点两下)。
    优化器把"买 ○ 再升 ◎"当成两笔选进推荐里,这是对的(游戏里确实是点两次、付两笔),
    但勾选时那是**同一行点两下**;不合并就会被当成"同名两条只能勾一条",
    结果只勾上单圈 —— 就是「双圈技能没勾上」这个报障。
    """
    merged: dict[tuple[str, str], _Target] = {}
    for it in items:
        if isinstance(it, dict):
            nm = str(it.get("name") or "")
            raw_pt = it.get("pt")
            pt = int(raw_pt) if isinstance(raw_pt, (int, float)) else None
        else:
            nm = str(it)
            pt = None
        base = row_key(nm)
        if not base:
            continue
        family = circle_family(nm)
        taps = _taps_of(nm)
        key = (base, family)
        prev = merged.get(key)
        if prev is None:
            merged[key] = _Target(display=nm, base=base, family=family, taps=taps, pt=pt)
        elif taps > prev.taps:
            # 同一格的两级都在推荐里:买到最后一级,名字也用 ◎ 那个(日志里更好认)
            merged[key] = _Target(display=nm, base=base, family=family, taps=taps, pt=pt)
    return list(merged.values())


def select_in_shop(adb: Adb, meta: ScreenMeta, profile: Profile, ocr: Ocr,
                   names: "list[str] | list[dict]", pt_before: int | None,
                   progress=None, max_pages: int | None = None,
                   last_after_pt: int | None = None) -> SelectOutcome:
    """按**界面从上到下**的顺序,把 names 里每个技能点加号勾上(不提交)。

    `pt_before` = 读取时记下的「当前技能点数」,用来确认购物车是干净的。
    `last_after_pt` = 上一次勾选之后剩下的点数。当前点数正好等于它,说明**上次勾的结果
    还在购物车里没清**,这时绝不能往上叠(同一格会被再点一次,单圈点成双圈、多花钱)。
    只看 `pt_before` 是不够的:如果用户是在购物车已经有东西的时候重新「从模拟器读取」,
    那次的余额本身就带着残留,比对永远相等。
    """
    check_orientation(adb, meta)
    check_on_skill_page(adb, profile, ocr)

    img = adb.screencap()
    now_pt = read_pt_balance(ocr, img, profile)
    # 最硬的判据:底部「确定」按钮亮不亮(空车 77 / 有东西 122,见版式文件注释)。
    # 它不依赖任何"上次读到多少点"的记忆,所以即使用户在车里有东西时重新读过一次也拦得住。
    empty, lum = cart_state(img, profile)
    if empty is False:
        raise SelectError(
            f"购物车里有东西:底部「确定」按钮是亮着的(亮度 {lum:.0f},空车约 103)。"
            f"请先点游戏里的「重置」把购物车清空,再让我勾 —— 否则会叠在旧选择上,"
            f"单双圈那种同一格会被多点一次,白花点数。"
        )
    if (last_after_pt is not None and now_pt is not None and now_pt == last_after_pt
            and now_pt != pt_before):
        raise SelectError(
            f"上次勾选的结果还留在购物车里(当前 {now_pt} 点,勾之前是 {pt_before} 点)。"
            f"请先点游戏里的「重置」把购物车清空再勾 —— 否则会叠在旧选择上,"
            f"单双圈那种同一格会被多点一次,白花点数。"
        )
    if pt_before is not None and now_pt is not None and now_pt != pt_before:
        raise SelectError(
            f"购物车里已经有东西了(当前 {now_pt} 点 / 读取时 {pt_before} 点)。"
            f"请先点游戏里的「重置」或把已选项取消,再让我勾。"
        )

    pending = _targets_of(names)
    out = SelectOutcome(pt_before=pt_before)
    steps = scroll_to_top(adb, meta, profile, ocr, progress)
    if progress:
        progress(f"已回到列表顶部(fling {steps} 次)")

    cfg = profile.scroll["to_bottom"]
    limit = max_pages if max_pages is not None else int(cfg["max_steps"])

    seen_pages: set[tuple[str, ...]] = set()
    stalled = 0
    for page in range(limit):
        img = adb.screencap()
        rows = read_page(img, profile, ocr, page)
        sig = tuple(r.name_text for r in rows)
        if sig in seen_pages:
            # 列表没动。**不能一次就退出**:点完加号后的那几秒里,swipe 常常被游戏忽略
            # (实测出现过"已勾选 1 项,剩下两项翻到底也没找到" —— 其实是被原地打转了)。
            # 连续三次都没动才算到底/卡死。
            stalled += 1
            if stalled >= 3:
                if progress:
                    progress(f"列表连续 {stalled} 屏没动,判定到底")
                break
        else:
            stalled = 0
            seen_pages.add(sig)

        for row in rows:
            key = row_key(row.name_text)
            if not key:
                continue
            cands = [t for t in pending if t.base == key]
            if not cands:
                continue
            target = _pick(cands, row.price)
            status, reason = _tap_n_times(adb, profile, ocr, key, target.taps)
            if status == TAP_OK:
                out.done.append(target.display)
                if progress:
                    progress(f"已勾选「{target.display}」")
            elif status == TAP_PARTIAL:
                # **关键**:点了几下半途而废(双圈只加了单圈)不能算成功 ——
                # 原来这里 ok=True 就把 reason 扔了,用户看到"已勾选",实际只买了一半。
                out.done.append(target.display)
                out.failed.append((target.display, reason))
                if progress:
                    progress(f"「{target.display}」只勾了一部分:{reason}")
            else:
                out.failed.append((target.display, reason))
                if progress:
                    progress(f"「{target.display}」没勾上:{reason}")
            # 真正同名(不同 family,如库里的 (1)/(2) 分支):游戏里那两行一模一样,
            # 只按名字没法区分,所以只勾其中一条,另一条必须明说"没勾"。
            # 注意 ○/◎ 不会走到这里 —— 它们在 _targets_of 已经合并成"点两下"了。
            for sib in [t for t in pending if t.base == key and t is not target]:
                out.failed.append(
                    (sib.display, f"与「{target.display}」同名,按名字只认得出其中一行,"
                                  f"已勾「{target.display}」;这一条请自己核对")
                )
            pending = [t for t in pending if t.base != key]

        if not pending:
            break
        # 下一页。上一步没走动时把这一下**做大做慢**(短促轻扫在刚点完加号的那几秒会被吃掉)。
        if stalled > 0:
            adb.swipe(360, int(cfg["y0"]), 360, int(cfg["y0"]) - 260, 650)
        else:
            adb.swipe(360, int(cfg["y0"]), 360, int(cfg["y1"]), int(cfg["duration_ms"]))
        adb.settle(float(cfg["settle_s"]) + (0.4 if stalled else 0.0))

    for t in pending:
        out.failed.append((t.display, "翻到底也没找到这一行"))

    try:
        out.pt_after = read_pt_balance(ocr, adb.screencap(), profile)
    except Exception:      # noqa: BLE001 读不到不影响主流程
        out.pt_after = None
    return out


def _pick(cands: list[_Target], price: int | None) -> _Target:
    """同名多条时挑一条:标价能对上就按标价挑,否则取第一条。

    **为什么会同名**:技能库里有 `决不让出领头的景色……！(继承)(1)/(2)` 这种同名的分支条目,
    剥掉尾缀后它们指向游戏里同一行名字。不按标价消歧就只能瞎猜,猜错就是买错技能。
    """
    if len(cands) == 1:
        return cands[0]
    if price is not None:
        hit = [t for t in cands if t.pt is not None and t.pt == price]
        if len(hit) == 1:
            return hit[0]
    return cands[0]


def _locate(adb: Adb, profile: Profile, ocr: Ocr, key: str) -> tuple[Row | None, str]:
    """当前屏里按归一化基名找行。返回 (行, 状态);状态 = exact / done / none。

    `done` 是"这一行已经不可购买了":买到「已获得」之后名字框会被角标污染
    (实测「长距离弯道」→「长距离弯道启」),精确比对断了,只能靠"前缀 + 没符号 + 没价格"认出来。
    """
    rows = read_page(adb.screencap(), profile, ocr, 0)
    exact = [r for r in rows if row_key(r.name_text) == key]
    if exact:
        return exact[0], "exact"
    for r in rows:
        k = row_key(r.name_text)
        if (k != key and k.startswith(key) and len(k) - len(key) <= 2
                and r.symbol is None and r.price is None):
            return r, "done"
    return None, "none"


def _read_pt_after(ocr: Ocr, adb: Adb, profile: Profile, pt0: int | None = None) -> int | None:
    """点完之后读点数,**取连续几帧里的最小值**,再做一次"降幅合理"校验。

    点数只会减少,所以"读到的最小值"比"读一次"可靠:一次读数可能正好落在过渡动画上,
    读回点之前的旧值 —— 旧逻辑据此判定"没点上",然后**又点了一下**,于是单圈被点成了双圈
    (多花一份钱)。宁可多截两帧,也不要重复点。

    但只看最小值会被 OCR 抖动带偏:读出一个偏低的数字(实测见过 2941 被读成 2401),
    看起来"点成功了"其实没点,最后表现为"已勾选但一点没花"。单个技能最多 300 多点,
    所以降幅超过 `_MAX_STEP` 一律当读数错误,退回点之前的那个值。
    """
    best: int | None = None
    for _ in range(3):
        v = read_pt_balance(ocr, adb.screencap(), profile)
        if v is not None and (best is None or v < best):
            best = v
        adb.settle(0.35)
    if best is not None and pt0 is not None and pt0 - best > _MAX_STEP:
        return pt0
    return best


def _tap_n_times(adb: Adb, profile: Profile, ocr: Ocr, key: str, taps: int) -> tuple[str, str]:
    """点 taps 次加号,返回 (状态, 原因)。状态见 TAP_OK / TAP_PARTIAL / TAP_FAIL。

    **为什么要区分"部分成功"**:双圈要点两下,第二下失败时技能其实已经部分勾上
    (单圈在购物车里)。原来这里返回 True 且把原因丢掉,用户只看到"已勾选",
    实际上双圈没到位 —— 也就是"双圈技能没勾上"这个报障的由来。
    """
    cfg = profile.raw.get("circle") or {}
    plus_x = int(cfg.get("plus_x", 650))
    done = 0

    for _ in range(taps):
        adb.settle(0.5)          # 列表还在惯性滚动时 tap 会被吃掉,先等它停
        row, state = _locate(adb, profile, ocr, key)
        if row is None:
            # 已经点成功了行却不见了 = 加满了被移出可购买列表,算成功
            if done > 0:
                return TAP_OK, ""
            return TAP_FAIL, f"找不到「{base_name(key)}」这一行(列表在动?)"
        if state == "done":
            return (TAP_OK, "") if done > 0 else (TAP_FAIL, "这一行已经买过了(不可再买)")

        pt0 = read_pt_balance(ocr, adb.screencap(), profile)
        if pt0 is None:
            # 读不到点数就**不敢点**:点了也无法判断有没有生效,重复点会把单圈点成双圈(多花钱)
            return (TAP_PARTIAL if done > 0 else TAP_FAIL), "读不到当前技能点数,不敢点(怕点重复)"
        adb.tap(plus_x, row.y)
        adb.settle(1.0)
        pt1 = _read_pt_after(ocr, adb, profile, pt0)
        if pt1 is not None and pt1 < pt0:
            done += 1
            continue
        if pt1 is None:
            # 同一道理:读数丢了就当"可能已生效",宁可让用户补一下,也不重复点
            return (TAP_PARTIAL if done > 0 else TAP_FAIL), "点了但读不到点数,无法确认是否生效"

        # 点数确实没动(点空:列表仍在动 / 行刚挪了位置):重定位再试一次
        adb.settle(1.0)
        row, state = _locate(adb, profile, ocr, key)
        if row is None or state == "done":
            return (TAP_OK, "") if done > 0 else (TAP_FAIL, "这一行已经买过了(不可再买)")
        pt0 = read_pt_balance(ocr, adb.screencap(), profile)
        if pt0 is None:
            return (TAP_PARTIAL if done > 0 else TAP_FAIL), "读不到当前技能点数,不敢再点(怕点重复)"
        adb.tap(plus_x, row.y)
        adb.settle(1.0)
        pt1 = _read_pt_after(ocr, adb, profile, pt0)
        if pt1 is None:
            return (TAP_PARTIAL if done > 0 else TAP_FAIL), "点了但读不到点数,无法确认是否生效"
        if pt1 >= pt0:
            if done > 0:
                return TAP_PARTIAL, (f"点了 {done}/{taps} 下,剩下的没点上(列表在动?)"
                                     f" —— 这一项只勾了一部分,请在游戏里核对")
            return TAP_FAIL, "点加号没生效(该行可能已买过或不可买)"
        done += 1

    return TAP_OK, ""
