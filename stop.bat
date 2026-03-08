@echo off
echo Stopping Chicken Stream...
taskkill /f /im node.exe /fi "WINDOWTITLE eq Chicken Stream*" 2>nul
taskkill /f /im cloudflared.exe 2>nul
echo Done.
pause
