"""把 .bat 规整成「UTF-8(无 BOM) + CRLF + chcp 65001」。

两个坑:
1. **Windows 批处理必须是 CRLF 行尾**。用 LF 时 cmd 会把多行当一行解析,
   `if errorlevel 1 (` 这类块直接崩,双击就是一串「此时不应有 ...」。
   (这三个 bat 最早就是 LF,这就是"点击启动桌面版报错"的原因。)
2. **编码要和 chcp 配套**。用 chcp 65001 就保持 UTF-8:既让 bat 自己的中文 echo 正常,
   也让 Node/tsx 的 UTF-8 输出正常。改成 GBK+936 反而会让 tsx 的中文全乱。
   BOM 不能加 —— 会让第一行变成 `\\ufeff@echo off`,cmd 直接报"不是内部或外部命令"。
"""
from pathlib import Path

ROOT = Path(r"C:/Users/mio/Desktop/uma-skill-optimizer")

NEW = {
    "启动桌面版.bat": """@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo   赛马娘技能PT规划器 - 桌面版
echo   窗口里可以点「从模拟器读取」自动填技能和价格
echo ============================================
echo.

set "PY=%USERPROFILE%\\.workbuddy\\binaries\\python\\envs\\default\\Scripts\\python.exe"
if not exist "%PY%" set "PY=python"

"%PY%" -c "import webview" >nul 2>nul
if errorlevel 1 (
  echo [首次运行] 正在安装依赖, 请稍候...
  call "%PY%" -m pip install -r app\\requirements.txt
  if errorlevel 1 (
    echo.
    echo 依赖安装失败。手动执行: pip install -r app\\requirements.txt
    pause
    exit /b 1
  )
)

if not exist "打开规划器.html" (
  echo 缺少 打开规划器.html, 先跑一次: npm run web:standalone
  pause
  exit /b 1
)

echo 启动中... 关闭窗口即退出
"%PY%" -m app.main
if errorlevel 1 (
  echo.
  echo [启动失败] 上面是错误信息。
  echo 不想装 Python 的话, 直接双击 打开规划器.html 也能用(只是不能自动读模拟器)。
  pause
)
""",
    "打开规划器.bat": """@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo   赛马娘技能PT规划器 - 网页版启动中...
echo   浏览器将自动打开 http://localhost:5183
echo   关闭本窗口即停止服务
echo ============================================
start "" cmd /c "timeout /t 3 >nul & start http://localhost:5183/"
call npx vite --port 5183
pause
""",
    "运行示例.bat": """@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo   赛马娘技能PT规划器 - 示例运行
echo ============================================
echo.
call npm run optimize -- --input examples\\input.example.json
echo.
pause
""",
}


def main() -> int:
    for name, text in NEW.items():
        p = ROOT / name
        body = "\r\n".join(text.splitlines()) + "\r\n"
        p.write_bytes(body.encode("utf-8"))
        d = p.read_bytes()
        crlf = d.count(b"\r\n")
        lone_lf = d.count(b"\n") - crlf
        bom = d[:3] == b"\xef\xbb\xbf"
        print(f"{name:18} {len(d):5}B  CRLF={crlf:3} 裸LF={lone_lf}  BOM={bom}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
