# SPDX-License-Identifier: AGPL-3.0-or-later
# 在 Windows 上安装 backend 依赖；better-sqlite3 需要 C++ 工具链或预编译命中（见 docs/build-windows.md）
$ErrorActionPreference = "Continue"
$ScriptDir = $PSScriptRoot
if (-not $ScriptDir) { $ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path }
$Backend = Join-Path (Join-Path $ScriptDir "..") "backend"
Set-Location $Backend
Write-Host "==> $Backend - npm install"
Write-Host "    若 better-sqlite3 失败: 需安装 VS2022 Build Tools 并勾选 [使用 C++ 的桌面开发]（见 docs/build-windows.md）"
Write-Host ""
npm install
$code = $LASTEXITCODE
if ($code -ne 0) {
  Write-Host ""
  Write-Host "Trying Windows fallback: scripts\complete-backend-native-win.ps1 ..." -ForegroundColor Yellow
  $fb = Join-Path $ScriptDir "complete-backend-native-win.ps1"
  if (Test-Path $fb) { & $fb -BackendDir $Backend; $code = $LASTEXITCODE } else { $code = 1 }
  if ($code -ne 0) {
    Write-Host ""
    Write-Host " -----------------------------------------------------------"  -ForegroundColor Red
    Write-Host " 若仍失败: 1) 安装 VS2022 - 使用 C++ 的桌面开发" -ForegroundColor Yellow
    Write-Host "         2) 64 位 Python: npm config set python <path>" -ForegroundColor Yellow
    Write-Host "         3) EPERM: 关闭占用 node_modules 的 IDE/杀毒" -ForegroundColor Yellow
    Write-Host " 下载: https://visualstudio.microsoft.com/visual-cpp-build-tools/ " -ForegroundColor Cyan
    Write-Host " -----------------------------------------------------------"  -ForegroundColor Red
  }
}
exit $code
