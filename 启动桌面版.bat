@echo off
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

set "PY=%USERPROFILE%\.workbuddy\binaries\python\envs\default\Scripts\python.exe"
if not exist "%PY%" set "PY=python"

"%PY%" -c "import webview" >nul 2>nul
if errorlevel 1 (
  echo [setup] Installing GUI dependencies, please wait...
  call "%PY%" -m pip install -r app\requirements.txt
  if errorlevel 1 (
    echo.
    echo [setup] Install failed. Run manually: pip install -r app\requirements.txt
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
