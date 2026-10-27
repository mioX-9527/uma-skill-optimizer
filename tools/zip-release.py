"""把 packaging/dist/uma-skill-optimizer 打成发布用的 zip(结构与历史包一致)。

用 Python zipfile 而不是 Compress-Archive:764 个文件、~400MB,PS 那个实现会慢到几分钟。
"""

from __future__ import annotations

import sys
import time
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "packaging" / "dist" / "uma-skill-optimizer"
OUT = ROOT / "packaging" / "uma-skill-optimizer-desktop-win64-v0.1.6.zip"


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    if not SRC.is_dir():
        print(f"没有打包产物:{SRC}")
        return 1
    files = sorted(p for p in SRC.rglob("*") if p.is_file())
    t0 = time.time()
    with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for i, p in enumerate(files, 1):
            z.write(p, "uma-skill-optimizer/" + p.relative_to(SRC).as_posix())
            if i % 100 == 0:
                print(f"  {i}/{len(files)}  {time.time() - t0:.0f}s", flush=True)
    size = OUT.stat().st_size / 1024 / 1024
    print(f"OK {OUT.name}  {len(files)} 个文件  {size:.1f} MB  {time.time() - t0:.0f}s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
