@echo off
:: SPDX-License-Identifier: AGPL-3.0-or-later
:: Copyright (C) 2024-2026 Gracker (Chris) - SmartPerfetto
:: Standalone: install perfetto/ui deps (pnpm) on Windows. Same strategy as start-dev.ps1.
:: Usage: install-perfetto-ui-win.cmd <PERFETTO_DIR>
setlocal
if not exist "%APPDATA%\npm" mkdir "%APPDATA%\npm" 2>nul
if "%~1"=="" (
  echo Usage: %~nx0 ^<PERFETTO_DIR^>
  exit /b 1
)
set "UI=%~1\ui"
if not exist "%UI%\pnpm-lock.yaml" (
  echo Missing %UI%\pnpm-lock.yaml
  exit /b 1
)
cd /d "%UI%" || exit /b 1
call npx --yes pnpm@8.15.9 install --shamefully-hoist --frozen-lockfile
if errorlevel 1 (
  echo Retrying without frozen lockfile...
  call npx --yes pnpm@8.15.9 install --shamefully-hoist
)
exit /b %errorlevel%
