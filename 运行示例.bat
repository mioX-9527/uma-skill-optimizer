@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem ASCII-only on purpose: see tools/fix-bat-encoding.py

echo ============================================
echo   Uma Skill PT Planner - sample run
echo ============================================
echo.
call npm run optimize -- --input examples\input.example.json
echo.
pause
