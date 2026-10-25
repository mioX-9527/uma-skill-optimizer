"""桌面窗入口:pywebview 装一层壳,把「读取模拟器」变成窗口里的一个按钮。

为什么用壳而不是起 HTTP 服务:
- 网页版是纯前端,`file://` 下拿不到 adb;桌面壳能把 Python 能力直接暴露成 JS 对象,
  不用多一个常驻服务进程,也不用改前端打包方式。
- 前端只需判断 `window.pywebview?.api` 在不在,不在就隐藏按钮 → 单文件 HTML 版照旧可用。

调用面(前端 window.pywebview.api.*):
    doctor()            → 连通性/分辨率/版式状态
    capture_skills()    → 抓技能列表,返回 {skills, pt_balance, needs_confirm, warnings}
    save_plan(path?)    → 把结果写成 plan.json 并返回路径
"""

from __future__ import annotations

import json
import sys
import threading
import traceback
from pathlib import Path

from .adb import Adb, AdbError, DEFAULT_SERIAL
from .capture import capture_all
from .layout import load_profile
from .match import SkillIndex, resolve_rows, to_plan_skills

ROOT = Path(__file__).resolve().parent.parent
STANDALONE_HTML = ROOT / "打开规划器.html"


class Bridge:
    """暴露给前端的 API。所有方法都返回 dict(前端好处理),异常也转成 dict 而不是抛穿。"""

    def __init__(self, serial: str = DEFAULT_SERIAL):
        self.serial = serial
        self._index: SkillIndex | None = None
        self._last_plan: list[dict] = []
        self._pt_balance: int | None = None
        self._busy = threading.Lock()

    # ── 工具 ────────────────────────────────────────────────
    @property
    def index(self) -> SkillIndex:
        if self._index is None:
            self._index = SkillIndex.load()
        return self._index

    def _err(self, exc: Exception) -> dict:
        return {"ok": False, "error": str(exc), "detail": traceback.format_exc(limit=3)}

    # ── 前端 API ────────────────────────────────────────────
    def doctor(self) -> dict:
        try:
            adb = Adb(self.serial)
            meta = adb.connect()
            profile = load_profile(meta.width, meta.height)
            return {
                "ok": True,
                "serial": meta.serial,
                "size": [meta.width, meta.height],
                "density": meta.density,
                "calibrated": profile.calibrated,
                "rows": len(profile.rows()),
            }
        except (AdbError, FileNotFoundError, OSError) as exc:
            return self._err(exc)

    def capture_skills(self) -> dict:
        """抓取技能列表。整个过程要 10~20 秒,前端应显示进度/禁用按钮。"""
        if not self._busy.acquire(blocking=False):
            return {"ok": False, "error": "正在读取中,请稍候"}
        try:
            adb = Adb(self.serial)
            meta = adb.connect()
            profile = load_profile(meta.width, meta.height)
            from .ocr import Ocr

            result = capture_all(adb, meta, profile, Ocr())
            matches = resolve_rows(result.rows, self.index)
            skills = to_plan_skills(matches)
            self._last_plan = skills
            self._pt_balance = result.pt_balance

            # 上下位关系:金技能的列表价已含前置价,前端要据此避免重复计费
            from .chains import load_chains, pairs_within

            pairs = pairs_within({s["id"] for s in skills}, load_chains())

            confirm = [
                {"row": str(m), "alternatives": [a.name for a in m.alternatives]}
                for m in matches if m.needs_confirm
            ]
            warnings: list[str] = []
            if not profile.calibrated:
                warnings.append("版式未校准,结果可能串行")
            if result.stop_reason and "上限" in result.stop_reason:
                warnings.append(result.stop_reason)
            return {
                "ok": True,
                "skills": skills,
                "chains": [{"skillId": g, "prereqId": p} for g, p in pairs],
                "pt_balance": result.pt_balance,
                "pages": result.pages,
                "frames": result.frames,
                "stop_reason": result.stop_reason,
                "needs_confirm": confirm,
                "warnings": warnings,
            }
        except Exception as exc:  # noqa: BLE001 冒到前端就是一句中文报错
            return self._err(exc)
        finally:
            self._busy.release()

    def save_plan(self, path: str | None = None) -> dict:
        if not self._last_plan:
            return {"ok": False, "error": "还没有读取结果,先点「从模拟器读取」"}
        out = Path(path) if path else (ROOT / "app" / "_debug" / "plan.json")
        out.parent.mkdir(parents=True, exist_ok=True)
        plan = {
            "course": "东京 草 2400m",
            "budget": self._pt_balance or 1000,
            "runner": {
                "stats": {"speed": 1200, "stamina": 1000, "power": 1100, "guts": 700, "wisdom": 900},
                "tactic": "senko", "distanceAptitude": "A", "surfaceAptitude": "A",
                "motivation": "normal", "groundCondition": 0, "weather": 1, "season": 1,
            },
            "skills": [{"id": s["id"], "pt": s["pt"]} for s in self._last_plan],
        }
        out.write_text(json.dumps(plan, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        return {"ok": True, "path": str(out), "count": len(self._last_plan)}


def main() -> int:
    try:
        import webview
    except ImportError:
        print("缺 pywebview。装一下:pip install pywebview", file=sys.stderr)
        return 1
    if not STANDALONE_HTML.is_file():
        print(f"找不到 {STANDALONE_HTML},先跑 npm run web:standalone 生成单文件版。", file=sys.stderr)
        return 1
    webview.create_window(
        "赛马娘技能PT规划器(桌面版)",
        str(STANDALONE_HTML),
        js_api=Bridge(),
        width=1180,
        height=920,
    )
    webview.start()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
