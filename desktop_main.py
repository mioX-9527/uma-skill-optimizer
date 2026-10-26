"""PyInstaller 打包入口(桌面版 exe)。

打包后路径对齐:app/main.py 里 `ROOT = Path(__file__).parent.parent` 会落在
`_internal/`(onedir),所以 `打开规划器.html` 要以 datas 平铺到 `_internal/` 根
(见 build_desktop.spec)。save_plan 的调试输出落在 `_internal/app/_debug/`,可写。

窗口模式(console=False)下 sys.stdout/stderr 可能是 None,直接 print 会崩 ——
最早期做流兜底(进内存,不落盘;参照 windows-pywebview-app 技能的启动清单)。
"""
import io
import sys

if sys.stdout is None:
    sys.stdout = io.StringIO()
if sys.stderr is None:
    sys.stderr = io.StringIO()

from app.main import main

if __name__ == "__main__":
    raise SystemExit(main())
