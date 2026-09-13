@echo off
title Hugging Face Downloader
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0hf-download.ps1" %*
