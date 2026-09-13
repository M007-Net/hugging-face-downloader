@echo off
title Hugging Face Downloader - Desktop
setlocal
cd /d "%~dp0"
if not exist "node_modules\electron\dist\electron.exe" (
  echo Desktop dependencies are not installed yet.
  echo Run npm install once, then launch this file again.
  echo.
  pause
  exit /b 1
)
call npm.cmd start
