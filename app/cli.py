"""命令行入口:体检 / 截图 / 校准 / 识别 / 抓取。

    python -m app.cli doctor                  # 连通性与分辨率自检
    python -m app.cli shot -o frame.png       # 抓一帧
    python -m app.cli calibrate                # 出调试图(画行线与裁剪框)
    python -m app.cli ocr -i frame.png        # 对已存图片做整屏识别(不进游戏也能调匹配)
    python -m app.cli capture -o plan.json    # 全流程:划到顶→逐屏识别→去重→出候选
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from .adb import Adb, AdbError, dedupe_devices, describe, list_devices, probe, resolve_serial
from .capture import capture_all, frame_diff
from .layout import LAYOUT_DIR, load_profile
from .match import SkillIndex, evolutions_of, resolve_rows, to_plan_skills

DEBUG_DIR = Path(__file__).resolve().parent / "_debug"
FONT_CANDIDATES = (r"C:\Windows\Fonts\msyh.ttc", r"C:\Windows\Fonts\simhei.ttf")


def _font(size: int = 16):
    for p in FONT_CANDIDATES:
        if Path(p).is_file():
            try:
                return ImageFont.truetype(p, size)
            except OSError:
                continue
    return ImageFont.load_default()


def _say(msg: str = "") -> None:
    print(msg, flush=True)


def cmd_devices(args: argparse.Namespace) -> int:
    """列出所有 adb 设备,顺带把机型/分辨率/前台应用显示出来,方便挑 --serial。"""
    try:
        devs = list_devices(connect=True)
    except AdbError as exc:
        _say(f"[失败] {exc}")
        return 1
    if not devs:
        _say("没有找到设备。先启动模拟器,确认它开着 ADB 调试。")
        return 1
    rows = []
    for d in devs:
        row = dict(d)
        if d["state"] == "device":
            row.update(describe(d["serial"]))
        rows.append(row)
    for d in dedupe_devices(rows):     # 同一台机器的两个序列号只显示一次
        line = f"  {d['serial']:<20} {d['state']:<13} {d.get('model') or '':<10}"
        if d.get("size"):
            line += f" {d['size']:<10}"
        if d.get("isUma"):
            line += " ← 赛马娘"
        elif d.get("app"):
            line += f" 前台:{d['app']}"
        _say(line)
    _say()
    _say("用 --serial 指定要读的那台,例如:python -m app.cli capture --serial 127.0.0.1:16384")
    return 0


def cmd_doctor(args: argparse.Namespace) -> int:
    try:
        info = probe(args.serial)
    except AdbError as exc:
        _say(f"[失败] {exc}")
        return 1
    _say("ADB 体检 OK")
    for k, v in info.items():
        _say(f"  {k:<11} {v}")
    try:
        p = load_profile(*info["frame_size"])
        _say(f"  版式        {'已校准' if p.calibrated else '未校准(需跑 calibrate)'}  "
             f"列表区 y {p.list_top}..{p.list_bottom}")
    except FileNotFoundError as exc:
        _say(f"  版式        {exc}")
    return 0


def cmd_shot(args: argparse.Namespace) -> int:
    adb = Adb(args.serial)
    adb.connect()
    img = adb.screencap()
    out = Path(args.out or (DEBUG_DIR / "shot.png"))
    out.parent.mkdir(parents=True, exist_ok=True)
    img.save(out)
    _say(f"已保存 {out}  ({img.width}x{img.height})")
    return 0


def cmd_calibrate(args: argparse.Namespace) -> int:
    """把当前画面按 profile 定位行,画上锚点/裁剪框并存图,方便对着数字微调。"""
    adb = Adb(args.serial)
    meta = adb.connect()
    profile = load_profile(meta.width, meta.height)
    img = adb.screencap()
    DEBUG_DIR.mkdir(parents=True, exist_ok=True)

    raw_path = DEBUG_DIR / "calib_raw.png"
    img.save(raw_path)

    rows = profile.find_rows(img)
    vis = img.copy()
    d = ImageDraw.Draw(vis)
    font = _font(14)
    # 列表可视区
    d.rectangle((0, profile.list_top, img.width, profile.list_bottom), outline=(0, 200, 255), width=2)
    d.text((4, profile.list_top - 16), f"list {profile.list_top}..{profile.list_bottom}", font=font, fill=(0, 200, 255))
    # PT 余额框
    pb = profile.pt_balance_box()
    d.rectangle(pb.as_tuple(), outline=(0, 255, 255), width=2)
    d.text((pb.x, pb.y - 16), "pt", font=font, fill=(0, 255, 255))

    for i, cy in enumerate(rows):
        d.line((0, cy, img.width, cy), fill=(0, 220, 120), width=1)
        d.text((4, cy - 8), f"#{i} cy={cy}", font=font, fill=(0, 220, 120))
        for key, tint in (("name", (255, 0, 128)), ("price", (255, 220, 0))):
            c = profile.crop_around(img, cy, key)
            box = profile.raw["crops"][key]
            d.rectangle((int(box["x0"]), cy + int(box["dy0"]),
                         int(box["x1"]), cy + int(box["dy1"])), outline=tint, width=2)
            c.resize((c.width * 2, c.height * 2), Image.LANCZOS).save(
                DEBUG_DIR / f"row{i:02d}_{key}.png"
            )

    vis_path = DEBUG_DIR / "calib_lines.png"
    vis.save(vis_path)
    _say(f"定位到 {len(rows)} 行:{rows}")
    _say(f"原图   {raw_path}")
    _say(f"标注图 {vis_path}")
    _say(f"行裁剪 {DEBUG_DIR}\\row*_name.png / row*_price.png")
    _say(f"当前 profile:{LAYOUT_DIR / f'{meta.width}x{meta.height}.json'}")
    _say("对着 calib_lines.png 调整 list.top/bottom、anchor.*、crops.* 后重跑本命令。")
    return 0


def cmd_ocr(args: argparse.Namespace) -> int:
    """对一张已存图片跑识别 + 匹配。不连模拟器,方便离线调解析。"""
    from .ocr import Ocr

    path = Path(args.image)
    if not path.is_file():
        _say(f"[失败] 找不到图片 {path}")
        return 1
    index = SkillIndex.load()
    img = Image.open(path).convert("RGB")
    profile = None
    if args.rows:
        try:
            profile = load_profile(img.width, img.height)
        except FileNotFoundError as exc:
            _say(f"[失败] {exc}")
            return 1
        if not profile.calibrated:
            _say("[提示] profile 未标记 calibrated,仅按当前数字切行,结果仅供参考。")

    ocr = Ocr()
    ocr.warmup()
    if profile is None:
        _say("整屏文本:")
        for b in ocr.read(img):
            _say(f"  {b.score:.2f}  ({b.x0},{b.y0})  {b.text}")
        return 0

    from .capture import read_page

    rows = read_page(img, profile, ocr, page=0)
    matches = resolve_rows(rows, index)
    _say(f"识别到 {len(matches)} 行:")
    for m in matches:
        _say("  " + str(m))
    plan = to_plan_skills(matches)
    _say(f"\n可进候选 {len(plan)} 条:")
    _say(json.dumps(plan, ensure_ascii=False, indent=1))
    return 0


def cmd_capture(args: argparse.Namespace) -> int:
    adb = Adb(args.serial)
    meta = adb.connect()
    profile = load_profile(meta.width, meta.height)
    index = SkillIndex.load()
    from .ocr import Ocr

    ocr = Ocr()
    try:
        result = capture_all(adb, meta, profile, ocr,
                             max_pages=args.max_pages, progress=_say)
    except RuntimeError as exc:
        _say(f"[失败] {exc}")
        return 1

    matches = resolve_rows(result.rows, index)
    skills = to_plan_skills(matches)
    _say(f"\n共 {result.pages} 屏 / {result.frames} 帧,停因:{result.stop_reason}")
    if result.pt_balance is not None:
        _say(f"PT 余额(OCR):{result.pt_balance}")
    _say(f"技能 {len(matches)} 行,可进候选 {len(skills)} 条,"
         f"需人工确认 {sum(1 for m in matches if m.needs_confirm)} 行")
    for m in matches:
        _say("  " + str(m))

    # 上下位关系:金技能的显示价已包含前置价,必须把配对告诉优化器,否则会重复计费
    from .chains import load_chains, pairs_within

    cand_ids = {s["id"] for s in skills}
    chain_map = load_chains()
    pairs = pairs_within(cand_ids, chain_map)

    # 可进化关系:点开「进化 ⓘ」读到的。进化后的技能不在候选里(金技能免费变来的),
    # 必须回全量技能库把名字解析成 id —— 和桌面壳共用 evolutions_of。
    evolutions = evolutions_of(matches, index, note=lambda m: _say(f"[注意] {m}"))

    circle_up = {
        str(s["id"]): result.circle_pt[str(s["name"])[:-1]]
        for s in skills
        if str(s.get("name", "")).endswith("○") and str(s["name"])[:-1] in result.circle_pt
    }
    if circle_up:
        _say(f"现场补读双圈价:{circle_up}")

    plan = {
        "course": args.course or "东京 草 2400m",
        "budget": result.pt_balance if result.pt_balance else args.budget,
        "runner": {
            "stats": {"speed": 1200, "stamina": 1000, "power": 1100, "guts": 700, "wisdom": 900},
            "tactic": "senko", "distanceAptitude": "A", "surfaceAptitude": "A",
            "motivation": "normal", "groundCondition": 0, "weather": 1, "season": 1,
        },
        "skills": [{"id": s["id"], "pt": s["pt"]} for s in skills],
        "chains": [{"skillId": g, "prereqId": p} for g, p in pairs],
        "evolutions": evolutions,
        **({"circleUp": circle_up} if circle_up else {}),
    }
    out = Path(args.out or (DEBUG_DIR / "plan.json"))
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(plan, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    _say(f"\n已写出 {out}(面板/赛道是占位值,导入网页后改一下)")
    return 0


def main(argv: list[str] | None = None) -> int:
    try:  # Windows 控制台默认 GBK,中文输出会炸
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

    p = argparse.ArgumentParser(prog="app.cli", description="赛马娘技能购买界面自动读取")
    p.add_argument(
        "--serial", default=None,
        help="adb 设备序列号(主机:端口)。不填则自动挑:只有一台在线就用它,"
             "多台时挑前台是赛马娘的那台。用 `devices` 子命令看有哪些。",
    )
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("devices", help="列出所有 adb 设备(含前台应用)").set_defaults(func=cmd_devices)

    sub.add_parser("doctor", help="连通性与分辨率自检").set_defaults(func=cmd_doctor)

    ps = sub.add_parser("shot", help="抓一帧存成图片")
    ps.add_argument("-o", "--out")
    ps.set_defaults(func=cmd_shot)

    sub.add_parser("calibrate", help="出调试图(行线与裁剪框)").set_defaults(func=cmd_calibrate)

    po = sub.add_parser("ocr", help="对已存图片做识别(可选按行切)")
    po.add_argument("-i", "--image", required=True)
    po.add_argument("--rows", action="store_true", help="按 profile 切行后再识别")
    po.set_defaults(func=cmd_ocr)

    pc = sub.add_parser("capture", help="全流程抓取,输出 plan.json")
    pc.add_argument("-o", "--out")
    pc.add_argument("--max-pages", type=int, default=None, help="默认取版式里的 to_bottom.max_steps")
    pc.add_argument("--budget", type=int, default=1000)
    pc.add_argument("--course", default=None)
    pc.set_defaults(func=cmd_capture)

    args = p.parse_args(argv)
    # 没显式给 --serial 就自动挑一台(多模拟器共存时按"前台是赛马娘"选)
    if args.serial is None and args.cmd != "devices":
        try:
            args.serial = resolve_serial(None)
        except AdbError as exc:
            _say(f"[失败] {exc}")
            return 1
        _say(f"使用设备 {args.serial}")
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
