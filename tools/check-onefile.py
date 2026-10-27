"""从单文件 exe 里抽 `打开规划器.html`,确认打进去的网页是刚构建的那份。

为什么值得单独验:onefile 把所有东西塞进 CArchive 且压缩,直接 grep exe 二进制什么都看不到;
而"根目录那个 exe 忘了重建"正是 2026-10-27 实际发生过的事(网页改了,exe 还是旧的)。

跑法:python tools/check-onefile.py [exe路径]
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_EXE = ROOT / "uma-skill-optimizer.exe"
NEEDLES = ("btn-pick", "在游戏里勾选这")


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


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    exe = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_EXE
    if not exe.is_file():
        print(f"没有这个文件:{exe}")
        return 1
    html = _extract(exe, "打开规划器.html")
    if html is None:
        print("exe 里没找到 打开规划器.html")
        return 1
    text = html.decode("utf-8", "ignore")
    missing = [n for n in NEEDLES if n not in text]
    print(f"{exe.name}:{len(html) / 1024 / 1024:.2f} MB 的网页")
    if missing:
        print("✗ 缺这些标记:", missing)
        return 1
    print("✓ 网页是新的(含 btn-pick / 在游戏里勾选这)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
