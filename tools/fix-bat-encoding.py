"""把三个 .bat 规整成「纯 ASCII + CRLF + chcp 65001」。

踩过三个坑,顺序就是踩到的顺序:

1. **必须是 CRLF 行尾**。用 LF 时 cmd 会把多行当一行解析,`if errorlevel 1 (` 这类块
   直接崩,双击就是一串「此时不应有 ...」。(最早这三个 bat 就是 LF。)
2. **BOM 不能加**。加了第一行会变成 `\\ufeff@echo off`,cmd 报「不是内部或外部命令」。
3. **bat 里不能出现中文**(2026-10-25 实测,这是最阴的一个)。
   `chcp 65001` + 批处理里有非 ASCII 字符时,cmd 会**按字节错位重读文件**,
   把某行 echo 的尾巴当成命令执行:

       C:\\>启动桌面版.bat
       ============================================
         赛马娘技能PT规划器 - 桌面版
       '��」自动填技能和价格' is not recognized as an internal or external command

   同一份文件里,中文放第 5 行没事、放第 6 行就炸 —— 取决于字节偏移,跟"有没有写对"无关,
   任何一次编辑都可能把它挪到会炸的位置。所以结论不是"小心点写",而是**别在 bat 里写中文**:
   中文提示交给 Python(app/main.py),Python 在 chcp 65001 下输出 UTF-8 完全正常。
   文件名同理 `打开规划器.html` 也别出现在 bat 里(main.py 里有存在性检查)。

编码仍是 UTF-8(纯 ASCII 的 UTF-8 就是 ASCII 本身),这样 Node/tsx/vite 的 UTF-8 输出
在 chcp 65001 下仍然正常 —— 别改成 GBK+936,那会让 tsx 的中文全乱。

本文件是这三个 bat 的**唯一真源**:改 bat 请改这里再跑一遍,直接改 .bat 会被覆盖。
"""
from pathlib import Path

ROOT = Path(r"C:/Users/mio/Desktop/uma-skill-optimizer")

NEW = {
    "启动桌面版.bat": """@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem ================================================================
rem  KEEP THIS FILE ASCII-ONLY. No Chinese, no CJK file names.
rem
rem  cmd.exe mis-parses batch files that mix "chcp 65001" with
rem  non-ASCII text: it resumes reading at a wrong byte offset and
rem  runs the tail of an echo line as a command, e.g.
rem      'xx...' is not recognized as an internal or external command
rem  Chinese output lives in Python instead (app/main.py).
rem  See tools/fix-bat-encoding.py for the full story.
rem ================================================================

set "PY=%USERPROFILE%\\.workbuddy\\binaries\\python\\envs\\default\\Scripts\\python.exe"
if not exist "%PY%" set "PY=python"

"%PY%" -c "import webview" >nul 2>nul
if errorlevel 1 (
  echo [setup] Installing GUI dependencies, please wait...
  call "%PY%" -m pip install -r app\\requirements.txt
  if errorlevel 1 (
    echo.
    echo [setup] Install failed. Run manually: pip install -r app\\requirements.txt
    pause
    exit /b 1
  )
)

"%PY%" -m app.main
if errorlevel 1 (
  echo.
  echo [error] Desktop app exited with an error, see the log above.
  pause
)
""",
    "打开规划器.bat": """@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem ASCII-only on purpose: see tools/fix-bat-encoding.py

echo ============================================
echo   Uma Skill PT Planner - web version
echo   Opening http://localhost:5183
echo   Close this window to stop the server
echo ============================================
start "" cmd /c "timeout /t 3 >nul & start http://localhost:5183/"
call npx vite --port 5183
pause
""",
    "运行示例.bat": """@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem ASCII-only on purpose: see tools/fix-bat-encoding.py

echo ============================================
echo   Uma Skill PT Planner - sample run
echo ============================================
echo.
call npm run optimize -- --input examples\\input.example.json
echo.
pause
""",
}


def main() -> int:
    bad = 0
    for name, text in NEW.items():
        try:
            text.encode("ascii")
        except UnicodeEncodeError as exc:
            # 不是"建议",是硬约束:中文一旦混进来,cmd 就可能按字节错位重读
            print(f"!! {name} 含非 ASCII 字符({exc.object[exc.start:exc.end]!r}),会触发 cmd 解析错位")
            bad += 1
        p = ROOT / name
        body = "\r\n".join(text.splitlines()) + "\r\n"
        p.write_bytes(body.encode("utf-8"))
        d = p.read_bytes()
        crlf = d.count(b"\r\n")
        lone_lf = d.count(b"\n") - crlf
        bom = d[:3] == b"\xef\xbb\xbf"
        ascii_ok = all(b < 0x80 for b in d)
        print(f"{name:18} {len(d):4}B  CRLF={crlf:3} 裸LF={lone_lf}  BOM={bom}  纯ASCII={ascii_ok}")
        if lone_lf or bom or not ascii_ok:
            bad += 1
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
