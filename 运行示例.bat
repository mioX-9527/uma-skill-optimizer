@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo   赛马娘技能PT规划器 - 示例运行
echo ============================================
echo.
call npm run optimize -- --input examples\input.example.json
echo.
pause
