@echo off
REM SPDX-License-Identifier: AGPL-3.0-or-later
REM SmartPerfetto: stop local dev (same idea as scripts\stop-dev.sh).
REM PID handling uses CMD only (for /f) so it works under PowerShell Constrained Language (no [System.IO.File]::...).
setlocal EnableDelayedExpansion
cd /d "%~dp0.."
if errorlevel 1 (
  echo Failed to cd to repo root.
  exit /b 1
)
set "ROOT=%CD%"

echo ==============================================
echo Stopping SmartPerfetto (Windows)
echo Project: %ROOT%
echo PID files: %ROOT%\.backend.pid  %ROOT%\.frontend.pid
echo ==============================================

call :KillPidFile "%ROOT%\.backend.pid"
call :KillPidFile "%ROOT%\.frontend.pid"

echo Freeing listeners on ports 3000 and 10000...
call :KillPortListeners 3000
call :KillPortListeners 10000

echo Stopping trace_processor_shell.exe if present...
taskkill /F /T /IM trace_processor_shell.exe 2>nul

echo.
echo Done.
echo ==============================================
exit /b 0

:KillPidFile
set "PIDFILE=%~1"
if not exist "%PIDFILE%" (
  echo [missing] %PIDFILE%
  exit /b 0
)
set "SPID="
for /f "usebackq delims=" %%P in ("%PIDFILE%") do set "SPID=%%P"
if not defined SPID (
  echo [warn] empty PID file: %PIDFILE%
  del /f /q "%PIDFILE%" 2>nul
  exit /b 0
)
set "SPID=!SPID: =!"
echo [stop] %PIDFILE% -^> PID !SPID!
taskkill /PID !SPID! /T /F 2>nul
if errorlevel 1 echo [warn] taskkill exit !errorlevel! for PID !SPID! ^(may already be gone^)
del /f /q "%PIDFILE%" 2>nul
exit /b 0

:KillPortListeners
set "PORT=%~1"
REM netstat -ano: last column is PID; match local address ending with :PORT (avoid :30000 matching :3000).
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr /R /C:":%PORT% " ^| findstr /i "LISTENING"') do (
  echo   port !PORT! -^> PID %%a
  taskkill /F /PID %%a 2>nul
)
pause
exit /b 0
