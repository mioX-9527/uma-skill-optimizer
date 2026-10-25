@echo off
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
