@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo   赛马娘技能PT规划器 - 桌面版
echo   (窗口里可以点「从模拟器读取」自动填技能和价格)
echo ============================================
echo.

rem 优先用装好依赖的解释器;没有就退回系统 python
set "PY=%USERPROFILE%\.workbuddy\binaries\python\envs\default\Scripts\python.exe"
if not exist "%PY%" set "PY=python"

"%PY%" -c "import webview" >nul 2>nul
if errorlevel 1 (
  echo [首次运行] 正在安装依赖,请稍候...
  call "%PY%" -m pip install -r app\requirements.txt
  if errorlevel 1 (
    echo.
    echo 依赖安装失败。手动执行:pip install -r app\requirements.txt
    pause
    exit /b 1
  )
)

if not exist "打开规划器.html" (
  echo 缺少 打开规划器.html,先跑一次:npm run web:standalone
  pause
  exit /b 1
)

"%PY%" -m app.main
if errorlevel 1 pause
