@echo off
title Hugging Face Downloader
rem PowerShell is named absolutely rather than by PATH: CreateProcess searches the
rem current directory first, so a "powershell.exe" sitting beside this file would win.
set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS%" set "PS=powershell.exe"
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0hf-download.ps1" %*
set "code=%ERRORLEVEL%"
rem Without this the window closes instantly on any failure that happens outside the
rem script's own error handling, so a double-click user sees a flash and nothing else.
if not "%code%"=="0" (
  echo.
  echo The downloader exited with code %code%.
  pause
)
exit /b %code%
