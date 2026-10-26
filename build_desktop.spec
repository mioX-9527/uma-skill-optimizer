# -*- mode: python ; coding: utf-8 -*-
"""桌面版 PyInstaller spec。构建:

    <python> -m PyInstaller --noconfirm --distpath packaging/dist --workpath packaging/build build_desktop.spec

产物:packaging/dist/uma-skill-optimizer/ 整个文件夹(onedir,双击里面 exe)。
说明:
- onedir 比 onefile 稳(启动快、杀软误报少),Release 只发 onedir 的 zip。
- cv2 / onnxruntime / rapidocr(含内置 PP-OCR 模型)都必须收进去,合计 ~200MB。
- `打开规划器.html` 以 datas 平铺到 _internal 根,与 app/main.py 的 ROOT 推导对齐。
"""
import os

HERE = SPECPATH                      # PyInstaller 注入:spec 所在目录

datas = [
    (os.path.join(HERE, "打开规划器.html"), "."),
    # OCR 匹配/前置链/价格表都要读 data/(app/match.py、app/chains.py 按 __file__ 相对推导)
    (os.path.join(HERE, "data"), "data"),
]
binaries = []
hiddenimports = [
    # app/ocr.py 里是函数内延迟导入,保险起见显式声明
    "rapidocr",
    "rapidocr_onnxruntime",
    "onnxruntime",
    "cv2",
    "pywebview",
]
excludes = [
    # 坑:不要排除 distutils —— hook-distutils 要拿它注册别名模块
    "tkinter", "matplotlib", "pandas", "scipy",
    "PyQt5", "PyQt6", "PySide2", "PySide6", "IPython", "notebook",
    "pytest", "docutils", "pydoc_data", "lib2to3",
    # 本项目用不到的大件(venv 里其它项目装的,严禁被拖进来)
    "torch", "torchvision", "torchaudio", "transformers", "safetensors",
    "paddle", "paddleocr", "jupyter", "tensorflow",
]

# rapidocr 的内置 PP-OCR 模型是包内数据文件,必须整体收集
from PyInstaller.utils.hooks import collect_all

for pkg in ("rapidocr", "rapidocr_onnxruntime", "onnxruntime"):
    try:
        d, b, h = collect_all(pkg, include_py_files=True)
        datas += d
        binaries += b
        hiddenimports += h
    except Exception as exc:
        print("[spec] collect_all(%s) 跳过:%s" % (pkg, exc))

a = Analysis(
    [os.path.join(HERE, "desktop_main.py")],
    pathex=[HERE],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    excludes=excludes,
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz, a.scripts, [], exclude_binaries=True,
    name="uma-skill-optimizer",
    debug=False, strip=False, upx=False,
    console=False,                       # 双击无黑窗
)
coll = COLLECT(
    exe, a.binaries, a.datas,
    strip=False, upx=False,
    name="uma-skill-optimizer",
)
