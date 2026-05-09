@echo off
REM SPDX-License-Identifier: AGPL-3.0-or-later
REM SmartPerfetto: run start-dev.ps1 from repo root. Always passes -Quick (see ps1 for full build).
REM Use ASCII-only lines here: cmd.exe uses system code page; UTF-8 Chinese in REM can break parsing.
setlocal
cd /d "%~dp0.."
if errorlevel 1 (
  echo Failed to cd to repo root.
  exit /b 1
)
echo [start-dev.bat] repo: %CD%
echo [start-dev.bat] invoking: powershell -File scripts\start-dev.ps1 -Quick %*
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-dev.ps1" -Quick %*
set "EX=%ERRORLEVEL%"
echo [start-dev.bat] exit code: %EX%
pause
exit /b %EX%
