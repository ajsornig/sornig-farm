@echo off
title Chicken Stream
echo Starting Chicken Stream...
echo.

cd /d "%~dp0"

:: Start web server in a new window
start "Chicken Stream - Web Server" cmd /k "node server/index.js"

:: Start Cloudflare tunnel in a new window
start "Chicken Stream - Tunnel" cmd /k ""%ProgramFiles(x86)%\cloudflared\cloudflared.exe" tunnel run chicken-stream"

echo.
echo Chicken Stream is running!
echo   Local:  http://localhost:3000
echo   Public: https://sornigfarm.com
echo.
echo Two windows opened - close them to stop the services.
pause
