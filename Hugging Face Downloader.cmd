@echo off
title Hugging Face Downloader - Desktop (diagnostic)
setlocal
cd /d "%~dp0"
if not exist "node_modules\electron\dist\electron.exe" (
  echo Desktop dependencies are not installed yet.
  echo Run npm install once, then launch this file again.
  echo.
  pause
  exit /b 1
)
rem Runs electron directly rather than through npm so this works without Node on
rem PATH. cmd.exe waits for a process it starts directly - even a GUI one - so
rem this console stays open for the life of the app and shows any startup error
rem that the windowless .vbs launcher would swallow.
echo Starting Hugging Face Downloader. Close this window to quit the app.
echo.
"node_modules\electron\dist\electron.exe" .
set "code=%ERRORLEVEL%"
echo.
echo App exited with code %code%.
pause
exit /b %code%
