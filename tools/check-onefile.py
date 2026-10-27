"""从单文件 exe 里抽出网页与 Python 代码,确认打进去的是刚构建的那份。

为什么值得单独验:onefile 把所有东西塞进 CArchive 且压缩,直接 grep exe 二进制什么都看不到;
而"根目录那个 exe 忘了重建"正是 2026-10-27 实际发生过的事(网页改了,exe 还是旧的)。
两层都要看 —— 只验网页会漏掉"网页新、Python 旧"这种半新不旧的产物。

跑法:python tools/check-onefile.py [exe路径]
"""

from __future__ import annotations

import marshal
import sys
import tempfile
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_EXE = ROOT / "uma-skill-optimizer.exe"
# 网页层:前端改过的东西里挑几个稳定的字符串常量(压缩后的 JS 里字符串原样保留)
NEEDLES = ("btn-pick", "在游戏里勾选这")
# Python 层按模块列出"这一版才有的名字"。加新功能时往这里补一行,以后就能一条命令验版本。
PY_NEEDLES: dict[str, tuple[str, ...]] = {
    "app.select": ("circle_family", "_targets_of", "_tap_n_times", "select_in_shop", "_MAX_STEP"),
    "app.adb": ("local_ips", "android_id", "_is_private_ipv4", "dedupe_devices"),
    "app.capture": ("cart_state", "cart_state_from_lum", "cart_dirty"),
    "app.chains": ("supersede_pairs", "_prereqs_in"),
}


def _extract(exe: Path, name: str) -> bytes | None:
    from PyInstaller.archive.readers import CArchiveReader

    reader = CArchiveReader(str(exe))
    toc = getattr(reader, "toc", {}) or {}
    key = next((k for k in toc if k.replace("\\", "/").endswith(name)), None)
    if key is None:
        return None
    if hasattr(reader, "extract"):
        data = reader.extract(key)
        return data if isinstance(data, bytes) else None
    import zlib

    entry = toc[key]
    # PyInstaller 6 的条目是 (dpos, dlen, ulen, flag, typcd, name);压缩过就要先解 zlib
    dpos, dlen, ulen, flag = entry[0], entry[1], entry[2], entry[3]
    raw = exe.read_bytes()[dpos:dpos + dlen]
    return zlib.decompress(raw) if flag else raw


def _names_of(code: types.CodeType) -> set[str]:
    """递归收集 code object 里出现的名字(co_names + 函数/类名)。

    字符串常量不可靠:注释和 f-string 片段都会混进来,查 ``'circle_family' in blob``
    在一个刚好提到该词的报错文案上就会假通过。名字表是编译器真正登记过的符号。
    """
    out: set[str] = set()

    def walk(c: types.CodeType) -> None:
        out.update(c.co_names)
        out.update(c.co_varnames)      # 局部变量名也算:如 android_id 只在函数里当变量/dict key
        out.add(c.co_name)
        for x in c.co_consts:
            if isinstance(x, types.CodeType):
                walk(x)

    walk(code)
    return out


def _pyz_names(exe: Path, module: str) -> set[str] | None:
    """从 exe 内嵌的 PYZ 里解出某个模块,返回它用到的名字集合。

    **坑**:自己按 `toc` 的偏移切片再 zlib 解会失败 —— 那个偏移不是压缩流的起点。
    必须走 `reader.extract('PYZ.pyz')` 拿到的才是 `PYZ\\0` 开头的真包。
    """
    from PyInstaller.archive.readers import CArchiveReader, ZlibArchiveReader

    reader = CArchiveReader(str(exe))
    tocs = getattr(reader, "toc", {}) or {}
    key = next((k for k in tocs if k.replace("\\", "/").endswith("PYZ.pyz")), None)
    if key is None:
        return None
    tmp = Path(tempfile.gettempdir()) / f"_check_{exe.stem}.pyz"
    tmp.write_bytes(reader.extract(key))
    try:
        archive = ZlibArchiveReader(str(tmp))
        if module not in archive.toc:
            print(f"  ✗ exe 里没有模块 {module}")
            return None
        obj = archive.extract(module)
        if not isinstance(obj, types.CodeType):
            obj = marshal.loads(obj)
        return _names_of(obj)
    finally:
        tmp.unlink(missing_ok=True)


def _read_html(exe: Path) -> bytes | None:
    """先按 onefile 从 CArchive 里抽;抽不到就按 onedir 去 exe 旁边的 `_internal` 找。

    两种产物都要能验:onedir 的网页是普通文件(`_internal/打开规划器.html`),
    不在 exe 的归档里 —— 只写死 CArchive 那条路会把 onedir 判成"没找到"。
    """
    data = _extract(exe, "打开规划器.html")
    if data is not None:
        return data
    for cand in (exe.parent / "_internal" / "打开规划器.html", exe.parent / "打开规划器.html"):
        if cand.is_file():
            return cand.read_bytes()
    return None


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    exe = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_EXE
    if not exe.is_file():
        print(f"没有这个文件:{exe}")
        return 1

    bad = 0
    html = _read_html(exe)
    if html is None:
        print("找不到 打开规划器.html(onefile 归档与同级 _internal 都没有)")
        return 1
    text = html.decode("utf-8", "ignore")
    missing = [n for n in NEEDLES if n not in text]
    print(f"网页 {len(html) / 1024 / 1024:.2f} MB ", end="")
    if missing:
        print(f"✗ 缺这些标记:{missing}")
        bad += 1
    else:
        print("✓ 是新的")

    for module, names in PY_NEEDLES.items():
        got = _pyz_names(exe, module)
        if got is None:
            bad += 1
            continue
        lack = [n for n in names if n not in got]
        print(f"{module:<14}", "✓ 是新的" if not lack else f"✗ 缺:{lack}")
        bad += bool(lack)

    print()
    print("全部是新的" if not bad else f"有 {bad} 处不是最新,别用这个 exe")
    return 0 if not bad else 1


if __name__ == "__main__":
    raise SystemExit(main())
