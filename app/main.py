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

import io
import json
import sys
import threading
import traceback
from pathlib import Path

from .adb import Adb, AdbError, dedupe_devices, describe, list_devices, resolve_serial
from .capture import capture_all
from .layout import load_profile
from .match import SkillIndex, evolutions_of, resolve_rows, to_plan_skills

# pythonw(无控制台)下 sys.stdout/stderr 是 None,任何 print 都会直接崩。
# 兜底进内存(不落盘);真启动失败时 main() 会把报错写到 app/_debug/startup-error.log 并弹窗。
if sys.stdout is None:
    sys.stdout = io.StringIO()
if sys.stderr is None:
    sys.stderr = io.StringIO()

ROOT = Path(__file__).resolve().parent.parent
STANDALONE_HTML = ROOT / "打开规划器.html"


class Bridge:
    """暴露给前端的 API。所有方法都返回 dict(前端好处理),异常也转成 dict 而不是抛穿。"""

    def __init__(self, serial: str | None = None):
        # 不写死序列号:多模拟器共存时 5555 未必是赛马娘那台(实测被 MuMu 占过)。
        # 前端会先调 devices() 让用户选,再把选中的 serial 传进来。
        self._serial = serial
        self._index: SkillIndex | None = None
        self._last_plan: list[dict] = []
        self._pt_balance: int | None = None
        # 上一次「在游戏里勾选」之后剩下的点数。下次勾选时如果余额还停在这个值,
        # 说明购物车没清(用户直接又点了一次),必须拦住 —— 见 select_in_shop。
        self._cart_residue_pt: int | None = None
        self._busy = threading.Lock()

    # ── 工具 ────────────────────────────────────────────────
    def _get_index(self) -> SkillIndex:
        """技能库(懒加载)。**名字必须带下划线**:pywebview 会遍历 js_api 的公开属性,
        暴露成 property 的话,窗口初始化时就会触发加载 —— 打包后若缺数据文件,
        遍历期抛的错只会在日志里留一句「Error while processing index」,功能静默变残废。"""
        if self._index is None:
            self._index = SkillIndex.load()
        return self._index

    def _err(self, exc: Exception) -> dict:
        return {"ok": False, "error": str(exc), "detail": traceback.format_exc(limit=3)}

    def _resolve(self, serial: str | None) -> str:
        """选定要读哪台设备(逻辑在 adb.resolve_serial,CLI 共用同一份)。"""
        return resolve_serial(serial or self._serial)

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
            return {"ok": True, "devices": out, "recommended": recommend, "serial": self._serial}
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
            # 记住这次读的是哪台:后面「在游戏里勾选」要接着用同一台 —— 模拟器重连后
            # 同一台机器会同时挂在 5555/7555/16384/emulator-5554 几个序列号下,
            # 不带序列号重新 resolve 会因为"挑不出哪台是赛马娘"直接报错。
            self._serial = adb.serial
            profile = load_profile(meta.width, meta.height)
            from .ocr import Ocr

            result = capture_all(adb, meta, profile, Ocr())
            matches = resolve_rows(result.rows, self._get_index())
            skills = to_plan_skills(matches)
            self._last_plan = skills
            self._pt_balance = result.pt_balance

            # 现场读到的双圈价:按单圈技能 id 传给前端,让它直接用真价(不再用折扣推算)
            circle_up: dict[str, int] = {}
            for s in skills:
                nm = str(s.get("name", ""))
                if nm.endswith("○") and nm[:-1] in result.circle_pt:
                    circle_up[str(s["id"])] = result.circle_pt[nm[:-1]]

            # 上下位关系:金技能的列表价已含前置价,前端要据此避免重复计费
            from .chains import load_chains, pairs_within, supersede_pairs

            skill_ids = {s["id"] for s in skills}
            all_chains = load_chains()
            pairs = pairs_within(skill_ids, all_chains)
            # 「买金就送下位」的覆盖关系(沿链传递闭包):推荐里要把下位去掉,
            # 否则用户会看到一项根本点不动的技能,合计也多算一份钱(见 chains.supersede_pairs)
            supersedes = supersede_pairs(skill_ids, all_chains)

            # 进化关系:进化后的技能不在候选里(金技能免费变来的),得单独告诉前端
            warning_lines: list[str] = []
            evolutions = evolutions_of(matches, self._get_index(), note=warning_lines.append)

            confirm = [
                {"row": str(m), "alternatives": [a.name for a in m.alternatives]}
                for m in matches if m.needs_confirm
            ]
            warnings: list[str] = []
            if not profile.calibrated:
                warnings.append("版式未校准,结果可能串行")
            if result.stop_reason and "上限" in result.stop_reason:
                warnings.append(result.stop_reason)
            warnings.extend(warning_lines)
            return {
                "ok": True,
                "skills": skills,
                "chains": [{"skillId": g, "prereqId": p} for g, p in pairs],
                "supersedes": [{"gold": g, "lower": l} for g, l in supersedes],
                "evolutions": evolutions,
                "circle_up": circle_up,
                "cart_dirty": result.cart_dirty,
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

    def select_skills(self, items: list | None = None, serial: str | None = None) -> dict:
        """把推荐组合在技能购买界面里**勾上**(点加号加入购物车),**不点「确定」**。

        `items` 可以是 `['良场地◎']`,也可以是 `[{'name': '良场地◎', 'pt': 99}]` ——
        带标价时,游戏里两行同名(库里的 `(1)/(2)` 分支剥完尾缀会撞名)才能按价格分清。
        名字用界面上显示的那个(带 ○/◎):`◎` 会自动点两下(先单圈、再双圈)。
        名字里的 `(继承)`、`(1)` 这些**库内尾缀会被自动剥掉** —— 游戏列表里只有基名
        (实测漏勾就是这条:库名「璀璨流星(继承)」,界面上叫「璀璨流星」)。

        前置检查:购物车必须是干净的(当前点数 == 读取时点数),否则直接拒绝。
        """
        if not self._busy.acquire(blocking=False):
            return {"ok": False, "error": "正在读取/计算中,请稍候"}
        try:
            from .ocr import Ocr
            from .select import SelectError, select_in_shop

            adb = Adb(self._resolve(serial))
            meta = adb.connect()
            profile = load_profile(meta.width, meta.height)
            try:
                out = select_in_shop(adb, meta, profile, Ocr(), list(items or []), self._pt_balance,
                                     last_after_pt=self._cart_residue_pt)
            except SelectError as exc:
                return {"ok": False, "error": str(exc)}
            # 记下"勾完之后剩多少":下次余额还停在这儿 = 购物车没清
            self._cart_residue_pt = (
                out.pt_after if out.pt_after is not None and out.pt_after != out.pt_before else None
            )
            return {
                "ok": True,
                "done": out.done,
                "failed": [{"name": n, "reason": r} for n, r in out.failed],
                "pt_before": out.pt_before,
                "pt_after": out.pt_after,
            }
        except Exception as exc:  # noqa: BLE001 冒到前端就是一句中文报错
            return self._err(exc)
        finally:
            self._busy.release()

    def save_plan(self, text: str | None = None) -> dict:
        """把前端给的计划 JSON 存成文件(**弹系统保存对话框**,用户自己选位置)。

        旧实现是自己拼一份 plan(固定东京2400 + 占位五维),和界面配置对不上,
        而且前端从来没调用过它 —— 桌面版点「导出 JSON」其实什么都没落盘
        (WebView2 里 a[download] 会被静默丢掉)。现在改成:前端把 JSON 原文传进来。
        """
        if not isinstance(text, str) or text.strip() == "":
            return {"ok": False, "error": "没有可保存的内容(先在界面上算一次)"}
        try:
            import webview

            win = webview.windows[0] if webview.windows else None
            picked = None
            dialog_ok = win is not None
            if win is not None:
                picked = win.create_file_dialog(
                    webview.SAVE_DIALOG,
                    save_filename="skill-plan.json",
                    file_types=("JSON 文件 (*.json)", "所有文件 (*.*)"),
                )
        except Exception as exc:                        # noqa: BLE001
            return {"ok": False, "error": f"打开保存对话框失败:{exc}"}
        if isinstance(picked, (list, tuple)):
            picked = picked[0] if picked else None
        if not picked:
            if dialog_ok:
                return {"ok": False, "cancelled": True}
            # 没有窗口/对话框不可用:兜底写到 app/_debug/,总能找到文件
            picked = str(Path(__file__).resolve().parent / "_debug" / "skill-plan.json")
        out = Path(picked)
        if out.suffix == "":
            out = out.with_suffix(".json")
        try:
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_text(text, encoding="utf-8")
        except OSError as exc:
            return {"ok": False, "error": f"写入失败:{exc}"}
        return {"ok": True, "path": str(out)}


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
    try:
        _rc = main()
    except BaseException:
        # pythonw 下没有控制台,报错要落到文件 + 弹窗,否则用户只会看到"点了没反应"
        _err = traceback.format_exc()
        sys.stderr.write(_err)
        if sys.stderr.__class__ is io.StringIO:
            _log = Path(__file__).resolve().parent / "_debug" / "startup-error.log"
            _log.parent.mkdir(parents=True, exist_ok=True)
            _log.write_text(_err, encoding="utf-8")
            import ctypes

            ctypes.windll.user32.MessageBoxW(
                None, f"桌面版启动失败,日志已写到:\n{_log}", "赛马娘技能PT规划器", 0x10,
            )
        _rc = 1
    raise SystemExit(_rc)
