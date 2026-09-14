@echo off
title Hugging Face Downloader - Desktop (diagnostic)
setlocal
rem pushd, not cd /d: cmd.exe cannot make a UNC path the current directory, and with
rem @echo off that failure is silent - the relative check below then ran against
rem whatever directory it fell back to and reported missing dependencies on a copy
rem that was fully installed. pushd maps a UNC path to a temporary drive letter.
pushd "%~dp0" || (
  echo Could not open the folder this launcher lives in.
  pause
  exit /b 1
)
if not exist "node_modules\electron\dist\electron.exe" (
  popd
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
popd
echo.
echo App exited with code %code%.
pause
exit /b %code%
