@echo off
chcp 65001 >nul 2>&1
title Moyu Reader
cd /d "%~dp0"

REM Prefer the built-in Windows PowerShell - no install needed.
where powershell >nul 2>&1
if %errorlevel%==0 (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0server.ps1"
  goto :done
)

REM Fallback for trimmed-down Windows builds that ship pwsh instead.
where pwsh >nul 2>&1
if %errorlevel%==0 (
  pwsh -NoProfile -File "%~dp0server.ps1"
  goto :done
)

echo.
echo   PowerShell not found. Cannot start the local server.
echo   Enable "Windows PowerShell" in Windows Features and try again.
echo.
pause
exit /b 1

:done
echo.
echo   Moyu exited.
pause