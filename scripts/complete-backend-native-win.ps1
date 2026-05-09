# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2024-2026 Gracker (Chris)
# This file is part of SmartPerfetto. See LICENSE for details.
# Windows: when normal "npm install" fails on better-sqlite3 (prebuild-install not in PATH, no VS for node-gyp),
# install all deps without scripts, then run prebuild-install via node on the full path from inside better-sqlite3.

param(
  [Parameter(Mandatory = $true)]
  [string] $BackendDir
)

$ErrorActionPreference = "Continue"
$BackendDir = (Resolve-Path -LiteralPath $BackendDir).Path
Set-Location $BackendDir

Write-Host "Windows native fallback: npm install --ignore-scripts (skips better-sqlite3 postinstall)..." -ForegroundColor Yellow
npm install --ignore-scripts
if ($LASTEXITCODE -ne 0) {
  Write-Host "ignore-scripts install failed (exit $LASTEXITCODE)" -ForegroundColor Red
  exit $LASTEXITCODE
}

$prebuildBin = Join-Path $BackendDir "node_modules\prebuild-install\bin.js"
$bs3 = Join-Path $BackendDir "node_modules\better-sqlite3"
if (-not (Test-Path -LiteralPath $prebuildBin)) {
  Write-Host "Missing: $prebuildBin" -ForegroundColor Red
  exit 1
}
if (-not (Test-Path -LiteralPath $bs3)) {
  Write-Host "Missing: $bs3" -ForegroundColor Red
  exit 1
}

# prebuild 必须在 better-sqlite3 包目录下执行，且用显式 node 调 bin.js，避免 cmd 下找不到 prebuild-install
Write-Host "Running: node prebuild-install\bin.js in better-sqlite3 (prebuilt binary, usually no Visual Studio)..." -ForegroundColor Yellow
Push-Location $bs3
& node $prebuildBin
$pb = $LASTEXITCODE
Pop-Location
if ($pb -ne 0) {
  Write-Host "prebuild-install for better-sqlite3 failed. Next steps:" -ForegroundColor Red
  Write-Host "  1) Install Visual Studio 2022 Build Tools - [Desktop development with C++]" -ForegroundColor Yellow
  Write-Host "  2) Use 64-bit Python 3.10+ : npm config set python path\\to\\python.exe" -ForegroundColor Yellow
  Write-Host "  3) Close other apps if you saw EPERM on node_modules, then delete backend\\node_modules and retry." -ForegroundColor Yellow
  Write-Host "  See: docs/build-windows.md"
  exit $pb
}

# esbuild: tsx 依赖；--ignore-scripts 时未跑 postinstall
$esbuildInstall = Join-Path $BackendDir "node_modules\esbuild\install.js"
if (Test-Path -LiteralPath $esbuildInstall) {
  Write-Host "Running esbuild install.js..." -ForegroundColor Yellow
  & node $esbuildInstall
  if ($LASTEXITCODE -ne 0) {
    Write-Warning "esbuild install.js non-zero; if dev fails, run: cd backend; node node_modules/esbuild/install.js"
  }
}

Write-Host "Windows native fallback completed OK." -ForegroundColor Green
exit 0
