# SPDX-License-Identifier: AGPL-3.0-or-later
# 在 Windows 上为 Perfetto UI WASM 准备 emsdk：官方无 win 的 GCS tgz，用 emscripten-core/emsdk 安装 4.0.8 后 junction 到 buildtools\win64\emsdk
param(
  [Parameter(Mandatory = $true)]
  [string] $PerfettoDir
)
$ErrorActionPreference = "Stop"
$PerfettoDir = (Resolve-Path -LiteralPath $PerfettoDir).Path
$Win64 = Join-Path $PerfettoDir "buildtools\win64"
$Link = Join-Path $Win64 "emsdk"
$Emcc = Join-Path $Link "emscripten\emcc"
$EmccPy = Join-Path $Link "emscripten\emcc.py"
$SrcRoot = Join-Path $PerfettoDir "buildtools\emsdk_git"
$Clone = Join-Path $SrcRoot "emsdk"
$Upstream = Join-Path $Clone "upstream"

if ((Test-Path -LiteralPath $Emcc) -or (Test-Path -LiteralPath $EmccPy)) {
  Write-Host "OK: emsdk already present at $Link" -ForegroundColor Green
  return
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  throw "git is required to clone emsdk. Install Git for Windows and retry."
}

New-Item -ItemType Directory -Path $Win64 -Force | Out-Null
if (-not (Test-Path -LiteralPath (Join-Path $Clone "emsdk.bat"))) {
  New-Item -ItemType Directory -Path $SrcRoot -Force | Out-Null
  Write-Host "Cloning emscripten-core/emsdk (one-time, small repo)..." -ForegroundColor Cyan
  git clone "https://github.com/emscripten-core/emsdk.git" $Clone
  if ($LASTEXITCODE -ne 0) { throw "git clone emsdk failed" }
}

if (-not (Test-Path -LiteralPath (Join-Path $Clone "emsdk.bat"))) { throw "emsdk clone failed: $Clone" }

Write-Host "emsdk install 4.0.8 (首包较大，需数分钟)..." -ForegroundColor Cyan
Push-Location $Clone
& .\emsdk.bat install 4.0.8
if ($LASTEXITCODE -ne 0) { Pop-Location; throw "emsdk install 4.0.8 failed" }
& .\emsdk.bat activate 4.0.8
if ($LASTEXITCODE -ne 0) { Pop-Location; throw "emsdk activate 4.0.8 failed" }
Pop-Location

# 4.x 默认将 LLVM+emscripten 装到 upstream\；若不存在则在仓库内找 emcc.py
if (-not (Test-Path -LiteralPath (Join-Path $Upstream "emscripten\emcc.py"))) {
  $emcc = Get-ChildItem -Path $Clone -Recurse -Filter "emcc.py" -ErrorAction SilentlyContinue | Where-Object { $_.DirectoryName -match '[\\/]emscripten$' } | Select-Object -First 1
  if ($emcc) { $Upstream = (Resolve-Path (Join-Path $emcc.DirectoryName "..")).Path }
  else { throw "emcc.py not found under emsdk after install; see $Clone" }
}
$Upstream = (Resolve-Path -LiteralPath $Upstream).Path
if (-not (Test-Path -LiteralPath (Join-Path $Upstream "emscripten\emcc.py"))) {
  throw "invalid emsdk layout at $Upstream"
}

# 已有则先删（旧 junction / 目录）
if (Test-Path -LiteralPath $Link) {
  if ((Get-Item -LiteralPath $Link).LinkType) {
    cmd /c "rmdir `"$Link`""
  } else {
    Remove-Item -Recurse -Force -LiteralPath $Link
  }
}
cmd /c "mklink /J `"$Link`" `"$Upstream`""
if ($LASTEXITCODE -ne 0) { throw "mklink junction failed" }
Write-Host "Junction: $Link -> $Upstream" -ForegroundColor Green
