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

from .adb import Adb, AdbError, dedupe_devices, describe, list_devices, resolve_serial
from .capture import capture_all
from .layout import load_profile
from .match import SkillIndex, resolve_rows, to_plan_skills

ROOT = Path(__file__).resolve().parent.parent
STANDALONE_HTML = ROOT / "打开规划器.html"


class Bridge:
    """暴露给前端的 API。所有方法都返回 dict(前端好处理),异常也转成 dict 而不是抛穿。"""

    def __init__(self, serial: str | None = None):
        # 不写死序列号:多模拟器共存时 5555 未必是赛马娘那台(实测被 MuMu 占过)。
        # 前端会先调 devices() 让用户选,再把选中的 serial 传进来。
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

    def _resolve(self, serial: str | None) -> str:
        """选定要读哪台设备(逻辑在 adb.resolve_serial,CLI 共用同一份)。"""
        return resolve_serial(serial or self.serial)

    # ── 前端 API ────────────────────────────────────────────
    def devices(self, force: bool = False) -> dict:
        """列出所有 adb 设备,并带上机型/分辨率/前台应用,供前端做下拉框。

        `force=True` 才会去扫一遍常见模拟器端口(界面上的「刷新设备」按钮用),
        平时(`force=False`)只在**一台在线设备都没有**时才扫,省 1.5s。
        """
        try:
            devs = list_devices(connect=True if force else "auto")
            out = []
            for d in devs:
                row = {"serial": d["serial"], "state": d["state"], "model": d["model"]}
                if d["state"] == "device":
                    row.update(describe(d["serial"]))
                out.append(row)
            out = dedupe_devices(out)
            # 推荐项:前台是赛马娘 > 唯一在线 > 无
            online = [r for r in out if r["state"] == "device"]
            recommend = next((r["serial"] for r in online if r.get("isUma")), None)
            if recommend is None and len(online) == 1:
                recommend = online[0]["serial"]
            return {"ok": True, "devices": out, "recommended": recommend, "serial": self.serial}
        except (AdbError, FileNotFoundError, OSError) as exc:
            return self._err(exc)

    def doctor(self, serial: str | None = None) -> dict:
        try:
            adb = Adb(self._resolve(serial))
            meta = adb.connect()
            profile = load_profile(meta.width, meta.height)
            return {
                "ok": True,
                "serial": meta.serial,
                "size": [meta.width, meta.height],
                "density": meta.density,
                "calibrated": profile.calibrated,
                # 版式是按钮锚定式,没有"固定行数"这个概念了,这里给出列表可视区更有用
                "list": [profile.list_top, profile.list_bottom],
            }
        except (AdbError, FileNotFoundError, OSError) as exc:
            return self._err(exc)

    def capture_skills(self, serial: str | None = None) -> dict:
        """抓取技能列表。整个过程要 10~20 秒,前端应显示进度/禁用按钮。"""
        if not self._busy.acquire(blocking=False):
            return {"ok": False, "error": "正在读取中,请稍候"}
        try:
            adb = Adb(self._resolve(serial))
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
    # 中文提示一律在这里打印,不写进 .bat —— cmd 在 chcp 65001 下解析含中文的批处理
    # 会按字节错位重读,把 echo 行的尾巴当成命令执行(实测见 启动桌面版.bat 注释)。
    print("=" * 44)
    print("  赛马娘技能PT规划器 - 桌面版")
    print("  窗口里点「从模拟器读取」,自动填技能和价格")
    print("=" * 44)
    print()

    try:
        import webview
    except ImportError:
        print("缺 pywebview。装一下:pip install pywebview", file=sys.stderr)
        return 1
    if not STANDALONE_HTML.is_file():
        print(f"找不到 {STANDALONE_HTML}", file=sys.stderr)
        print("先跑一次 `npm run web:standalone` 生成单文件版;", file=sys.stderr)
        print("不想装 Node 的话,直接双击同名 .html 也能用(只是不能自动读模拟器)。", file=sys.stderr)
        return 1
    print("启动中... 关闭窗口即退出")
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
