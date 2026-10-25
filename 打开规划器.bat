@echo off
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
