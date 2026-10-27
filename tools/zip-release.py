"""把 packaging/dist/uma-skill-optimizer 打成发布用的 zip(结构与历史包一致)。

用 Python zipfile 而不是 Compress-Archive:764 个文件、~400MB,PS 那个实现会慢到几分钟。

跑法:`python tools/zip-release.py 0.1.8 [源目录]`(版本号就是文件名里那个,不给就直接报错,
宁可不生成也不要用错版本号 —— 发布包改名是发布环节唯一容易搞混的地方)。
源目录默认 `packaging/dist/uma-skill-optimizer`;窗口还开着、旧 dist 被占用时,
可以先 `--distpath packaging/dist-new` 打包再把这里指过去。
"""

from __future__ import annotations

import sys
import time
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "packaging" / "dist" / "uma-skill-optimizer"


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    if len(sys.argv) < 2:
        print("用法:python tools/zip-release.py <版本号,如 0.1.7>")
        return 2
    version = sys.argv[1].lstrip("v")
    src = Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else SRC
    out = ROOT / "packaging" / f"uma-skill-optimizer-desktop-win64-v{version}.zip"
    if not src.is_dir():
        print(f"没有打包产物:{src}")
        return 1
    files = sorted(p for p in src.rglob("*") if p.is_file())
    t0 = time.time()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for i, p in enumerate(files, 1):
            z.write(p, "uma-skill-optimizer/" + p.relative_to(src).as_posix())
            if i % 200 == 0:
                print(f"  {i}/{len(files)}  {time.time() - t0:.0f}s", flush=True)
    size = out.stat().st_size / 1024 / 1024
    print(f"OK {out.name}  {len(files)} 个文件  {size:.1f} MB  {time.time() - t0:.0f}s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
