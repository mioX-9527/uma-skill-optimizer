"""把 OCR 出来的技能名映射到 skills.json 里的技能。

为什么需要这一层(实测依据):
- PP-OCR 会**整个丢掉「◎」**("中距离直线◎" → "中距离直线"),把「○」认成「。」。
  而 ○/◎ 恰好是不同技能、价格也不同,不能靠改名硬猜。
- 所以这里做两件事:
  1) 单行匹配:先按「去掉/补上尾符号」的所有变体去精确命中,再退化成模糊匹配;
  2) 跨行消歧:同一基础名(如"中距离直线")在一屏里出现多行时,**用价格排序去对应 ○/◎**。
     游戏里技能价格随等级单调,所以"贵的那行是 ◎"是可靠信号。
- 拿不准时**不猜**:标 needs_confirm 并把备选给出来,让界面点一下,总比默默买错强。
"""

from __future__ import annotations

import json
import re
import unicodedata
from dataclasses import dataclass, field
from difflib import SequenceMatcher
from pathlib import Path

# 等级符号 → 价格序(数字越大越贵)。只收技能名里真实会用到的。
SYMBOL_RANK: dict[str, int] = {"×": 0, "○": 1, "◎": 2}
SYMBOLS = tuple(SYMBOL_RANK)
# 全角/易混字符归一:OCR 常把 ○ 认成句号或零
_CONFUSIONS = {"。": "○", "０": "0", "１": "1", "２": "2", "３": "3", "４": "4",
               "５": "5", "６": "6", "７": "7", "８": "8", "９": "9", "，": ","}

_REPO_ROOT = Path(__file__).resolve().parent.parent
SKILLS_PATH = _REPO_ROOT / "data" / "skills.json"


def normalize(text: str) -> str:
    """名称归一化:与前端 src/lookup.ts 同口径(去空白/小写),再加 OCR 易混字符修正。"""
    s = unicodedata.normalize("NFKC", text)
    for bad, good in _CONFUSIONS.items():
        s = s.replace(bad, good)
    # 省略号写法五花八门(…/.../。。),「向着，更远的地方…」每屏都可能认成不同的点,必须归一
    s = re.sub(r"[.．·…]+", "…", s)
    return re.sub(r"\s+", "", s).lower()


def base_name(name: str) -> str:
    """去掉末尾等级符号后的基础名。"""
    return name[:-1] if name and name[-1] in SYMBOLS else name


@dataclass(frozen=True)
class SkillRef:
    id: str
    name: str
    rarity: str
    precision: str

    @property
    def is_gold(self) -> bool:
        return self.rarity in ("rareEvolved", "evolved")


@dataclass
class Row:
    """从一屏里解析出的一行技能(OCR 结果)。"""

    name_text: str
    price_text: str = ""
    grayed: bool = False  # 已获得/不可购买(低饱和度)
    y: int = 0
    page: int = 0
    # 形状检测出来的等级符号(OCR 读不出 ○)。见 symbol.py
    symbol: str | None = None
    symbol_confident: bool = True

    @property
    def price(self) -> int | None:
        m = re.search(r"\d{2,4}", self.price_text)
        return int(m.group()) if m else None


@dataclass
class Match:
    base: Row
    skill: SkillRef | None = None
    confidence: float = 0.0
    needs_confirm: bool = False
    alternatives: list[SkillRef] = field(default_factory=list)

    @property
    def price(self) -> int | None:
        return self.base.price

    def __str__(self) -> str:
        name = self.skill.name if self.skill else f"??({self.base.name_text})"
        flag = "  <-需确认" if self.needs_confirm else ""
        alt = f"  备选:{'/'.join(a.name for a in self.alternatives)}" if self.alternatives else ""
        return f"{name:<16} {str(self.price or ''):>5}pt  conf={self.confidence:.2f}{flag}{alt}"


def is_unbuyable(s: dict) -> bool:
    """减益版绿技能(名字带 ×,效果全为负的被动)。

    这类技能**不会出现在自己的技能购买列表**里(它们是对手施加给你的减益)。
    但 skills.json 里有条目,OCR 又常把 ○ 的符号读丢,不排除掉就会把
    「良场地○ 81pt」错配成「良场地× 81pt」——实测就这么错过一次。
    """
    effs = s.get("effects") or []
    if not effs or not all(e.get("type") == "passive" for e in effs):
        return False
    vals = [e.get("value") for e in effs]
    return all(isinstance(v, (int, float)) and v < 0 for v in vals)


class SkillIndex:
    def __init__(self, skills: list[dict]):
        self.skills: list[SkillRef] = []
        self._by_norm: dict[str, list[SkillRef]] = {}
        for s in skills:
            if s.get("cnReleased") is False:  # 未实装的日服技能不可能出现在国服界面上
                continue
            if is_unbuyable(s):               # × 类减益绿技能,买不到
                continue
            ref = SkillRef(id=s["id"], name=s["name"], rarity=s.get("rarity", ""), precision=s.get("precision", ""))
            self.skills.append(ref)
            for alias in (s.get("name"), s.get("nameJa"), s.get("nameTrad")):
                if not alias:
                    continue
                self._by_norm.setdefault(normalize(alias), []).append(ref)

    @classmethod
    def load(cls, path: Path | None = None) -> "SkillIndex":
        with open(path or SKILLS_PATH, encoding="utf-8") as fh:
            return cls(json.load(fh))

    def exact(self, text: str) -> list[SkillRef]:
        return self._by_norm.get(normalize(text), [])

    def prefix(self, text: str, limit: int = 8) -> list[SkillRef]:
        q = normalize(text)
        if not q:
            return []
        out: list[SkillRef] = []
        seen: set[str] = set()
        for norm_name, refs in self._by_norm.items():
            if norm_name.startswith(q):
                for r in refs:
                    if r.id not in seen:
                        seen.add(r.id)
                        out.append(r)
        # 同前缀多等级时让 ○ 排在 ◎/× 前面:OCR 丢符号时 ○ 是最可能的真相
        out.sort(key=lambda r: SYMBOL_RANK.get(r.name[-1], 9))
        return out[:limit]

    def fuzzy(self, text: str, threshold: float = 0.72, limit: int = 5) -> list[tuple[SkillRef, float]]:
        q = normalize(text)
        if not q:
            return []
        scored: list[tuple[SkillRef, float]] = []
        for norm_name, refs in self._by_norm.items():
            score = SequenceMatcher(None, q, norm_name).ratio()
            if score >= threshold:
                for r in refs:
                    scored.append((r, score))
        scored.sort(key=lambda x: (-x[1], SYMBOL_RANK.get(x[0].name[-1], 9)))
        return scored[:limit]


def _symbol_variants(base: str) -> list[str]:
    """名字缺等级符号时,补出所有可能的完整名。"""
    return [base + sym for sym in SYMBOLS] + [base]


def match_row(row: Row, index: SkillIndex) -> Match:
    """单行匹配:原样精确 > 补符号变体 > 前缀 > 模糊。

    注意第一步**必须先按原样匹配**:OCR 有时真的把「×」认对了,此时再去展开符号变体
    只会把 直线赛道× 扩展成 直线赛道○/◎ 三个候选,平白多出一个"需确认"。
    """
    text = normalize(row.name_text)
    if not text:
        return Match(base=row, needs_confirm=True)

    # 0) 形状检测已经确定符号(OCR 读不出 ○,见 symbol.py)——这是最可靠的信号,优先用
    ocr_has_symbol = bool(row.name_text) and row.name_text[-1] in SYMBOLS
    if row.symbol and not ocr_has_symbol:
        cand = index.exact(base_name(row.name_text) + row.symbol)
        if len(cand) == 1:
            return Match(base=row, skill=cand[0],
                         confidence=1.0 if row.symbol_confident else 0.85,
                         needs_confirm=not row.symbol_confident)

    # 1) 原样精确(尊重 OCR 给出的符号)
    hits = index.exact(row.name_text)
    if len(hits) == 1:
        return Match(base=row, skill=hits[0], confidence=1.0)
    if len(hits) > 1:
        ranked = sorted(hits, key=lambda r: SYMBOL_RANK.get(r.name[-1], 9))
        return Match(base=row, skill=ranked[0], confidence=0.7, needs_confirm=True, alternatives=ranked[1:])

    # 2) 符号被 OCR 吃掉了(◎ 全丢 / ○ 变句号后仍缺)→ 补符号再精确匹配
    variants: list[SkillRef] = []
    for variant in _symbol_variants(base_name(row.name_text)):
        for ref in index.exact(variant):
            if ref not in variants:
                variants.append(ref)
    if len(variants) == 1:
        return Match(base=row, skill=variants[0], confidence=0.9)
    if variants:
        ranked = sorted(variants, key=lambda r: SYMBOL_RANK.get(r.name[-1], 9))
        return Match(base=row, skill=ranked[0], confidence=0.7, needs_confirm=True, alternatives=ranked[1:])

    # 2) 前缀(OCR 只认出了名字前半段)
    pre = index.prefix(row.name_text)
    if len(pre) == 1:
        return Match(base=row, skill=pre[0], confidence=0.85)
    if pre:
        return Match(base=row, skill=pre[0], confidence=0.6, needs_confirm=True, alternatives=pre[1:4])

    # 3) 模糊(OCR 错别字)
    fz = index.fuzzy(row.name_text)
    if fz:
        best, score = fz[0]
        alt = [r for r, _ in fz[1:] if r.id != best.id]
        return Match(base=row, skill=best, confidence=score,
                     needs_confirm=score < 0.85, alternatives=alt[:3])

    return Match(base=row, needs_confirm=True)


def resolve_rows(rows: list[Row], index: SkillIndex) -> list[Match]:
    """整表匹配。

    **这里曾经有一段「跨行价格消歧」,已经删掉**。它基于一个错误前提:
    「同一基础名(如 标准距离)会出现 ○ 和 ◎ 两行,可按价格反推哪个是哪个」。
    实际上赛马娘里 ○ 是 ◎ 的下位技能、**两者占同一格**,格子里显示的是"当前可买等级"
    (买了 ○ 之后同一格才变成 ◎)。所以同名两行根本不会同时出现,那段逻辑从未触发,
    留着只会误导后来人。

    现在符号由 `symbol.py` 的形状检测给出(○ 是细线空心圆,填充率 0.23~0.30,汉字是 0.47~0.83),
    OCR 读不出符号也能判准;判不出来时按「不猜」原则标 needs_confirm。
    """
    matches = [match_row(r, index) for r in rows]

    # 同 id 只保留第一次出现(跨屏重叠时会重复,防御一下)
    seen: set[str] = set()
    for m in matches:
        if m.skill and m.skill.id in seen:
            m.needs_confirm = True
        elif m.skill:
            seen.add(m.skill.id)
    return matches


def to_plan_skills(matches: list[Match]) -> list[dict]:
    """转成优化器吃的 skills 数组(与 web/CLI 的 plan.json 同格式)。

    防御性去重:同一 id 只留一条(跨屏重叠或同技能被切成两行时会发生)。
    """
    out: list[dict] = []
    seen: set[str] = set()
    for m in matches:
        if m.skill is None or m.price is None or m.base.grayed:
            continue
        if m.skill.id in seen:
            continue
        seen.add(m.skill.id)
        out.append({"id": m.skill.id, "name": m.skill.name, "pt": m.price})
    return out
