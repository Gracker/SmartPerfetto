# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2024-2026 Gracker (Chris)
# This file is part of SmartPerfetto. See LICENSE for details.
# SmartPerfetto 原生 Windows 开发启动：后端 :3000 + Perfetto UI :10000（行为接近 start-dev.sh）

param(
  [switch] $Quick,
  [switch] $Clean,
  # 仅当显式指定时才对 perfetto/out/ui 执行 gn clean（会删 ninja 产物；不碰 buildtools 已下载的 emsdk/llvm 等，但会拉长下次全量编译）
  [switch] $ForceGnClean,
  # 传给 ui/build.js --clean-out-ui：删除 perfetto/out/ui/ui（tsc/dist 等）；默认不删，增量构建快。也可设 SMARTPERFETTO_CLEAN_UI_OUT=1
  [switch] $CleanUiOut,
  [switch] $WslUi,
  [switch] $Help
)

$ErrorActionPreference = "Stop"
if ($Help) {
  Write-Host @"
Usage: .\scripts\start-dev.ps1 [-Quick] [-Clean] [-ForceGnClean] [-CleanUiOut] [-WslUi] [-Help]
  -Quick         跳过构建，仅启动服务（需已有 backend\dist 与 perfetto\out\ui）
  -Clean         启动前清理 logs 下旧文件（保留各类型最近 10 个）；不删除 perfetto/buildtools 等已下载工具
  -ForceGnClean  对 perfetto/out/ui 执行 gn clean（默认不执行；也可设环境变量 SMARTPERFETTO_FORCE_GN_CLEAN=1）
  -CleanUiOut    删除 perfetto/out/ui/ui 后再跑 UI 构建（全量 TS/打包）；默认保留以增量编译。也可设 SMARTPERFETTO_CLEAN_UI_OUT=1
  -WslUi         在 WSL 内构建 Perfetto UI（WASM 需 emsdk；与 SMARTPERFETTO_UI_WSL=1 等效）
"@
  exit 0
}

function Test-CommandLine {
  param([string] $Name)
  $c = Get-Command $Name -ErrorAction SilentlyContinue
  if (-not $c) { throw "Required command not found: $Name" }
}

function Stop-PortListener {
  param([int] $Port)
  try {
    $conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    foreach ($c in $conns) {
      Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
    }
  } catch {
    # 老系统无 Get-NetTCPConnection 时忽略
  }
}

function Get-ProjectRoot {
  $d = $PSScriptRoot
  if (-not $d) { $d = Split-Path -Parent $MyInvocation.MyCommand.Path }
  return (Resolve-Path (Join-Path $d "..")).Path
}

function ConvertTo-WslPath {
  param([string] $WinPath)
  $p = (Resolve-Path -LiteralPath $WinPath).Path
  if ($p.Length -lt 2 -or $p[1] -ne ':') { throw "Cannot map to WSL path (expected X:\...): $p" }
  $d = $p[0].ToString().ToLower()
  $tail = if ($p.Length -gt 2) { ($p.Substring(2) -replace '\\', '/').TrimStart('/') } else { "" }
  if ($tail) { return "/mnt/$d/$tail" } else { return "/mnt/$d" }
}

# 基于 tools/install-build-deps 的 Windows 依赖补齐（不传 --ui，避开上游“Windows UI unsupported”分支）。
# 通过 --filter 拉取 trace_processor/UI-WASM 在本仓库里实际会用到的 BUILD_DEPS_HOST 子集，
# 避免“缺一个补一个”的反复失败。
function Install-PerfettoHostBuildtoolsWin {
  param([string] $PerfettoDir)
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw "git is required for install-build-deps git deps" }
  $bt = Join-Path $PerfettoDir "buildtools"
  $ibd = Join-Path $PerfettoDir "tools\install-build-deps"
  Write-Host "Fetching Windows build deps from tools/install-build-deps filters..." -ForegroundColor Cyan
  $filters = @(
    "buildtools/googletest",
    "buildtools/protobuf",
    "buildtools/abseil-cpp",
    "buildtools/zlib",
    "buildtools/sqlite",
    "buildtools/sqlite_src",
    "buildtools/re2",
    "buildtools/pcre2",
    "buildtools/linenoise",
    "buildtools/llvm-project",
    "buildtools/expat/src",
    "buildtools/lzma",
    "buildtools/zstd"
  )
  $fArgs = ($filters | ForEach-Object { "--filter $_" }) -join " "
  cmd /c "cd /d `"$PerfettoDir`" && python3 `"$ibd`" --no-toolchain --no-dev-tools $fArgs"
  $ibdExit = $LASTEXITCODE
  if ($ibdExit -ne 0) {
    # install-build-deps 可能在 git/curl/test_data 任一步失败。
    # 只要核心 buildtools 已到位，就允许继续，避免被非关键步骤阻塞 UI/WASM 构建。
    Write-Warning "install-build-deps exited with code $ibdExit. Verifying required buildtools before deciding..."
  }
  $mustHave = @(
    (Join-Path $bt "googletest\googletest\src\gtest-all.cc"),
    (Join-Path $bt "protobuf\upb_generator\minitable\fasttable.cc"),
    (Join-Path $bt "abseil-cpp\absl\base\internal\throw_delegate.cc"),
    (Join-Path $bt "zlib\cpu_features.c"),
    (Join-Path $bt "sqlite\sqlite3.c"),
    (Join-Path $bt "sqlite_src\ext\misc\percentile.c"),
    (Join-Path $bt "re2\re2\bitmap256.cc"),
    (Join-Path $bt "llvm-project\llvm\lib\Demangle\DLangDemangle.cpp")
  )
  foreach ($m in $mustHave) {
    if (-not (Test-Path -LiteralPath $m)) {
      if ($ibdExit -ne 0) {
        throw "missing after filtered install-build-deps (exit $ibdExit): $m"
      }
      throw "missing after filtered install-build-deps: $m"
    }
  }
  Write-Host "OK: Windows host build deps are ready." -ForegroundColor Green
}

function Ensure-WindowsUiBuildtoolsJunctions {
  param([string] $PerfettoDir)
  if ($env:OS -ne "Windows_NT") { return }
  $src = Join-Path $PerfettoDir "buildtools"
  if (-not (Test-Path -LiteralPath $src)) { return }
  # ninja 里路径相对于子目录解析：例如 wasm/obj/buildtools/*.ninja 中 ../../buildtools → out/ui/wasm/buildtools。
  # 若此处已是普通空目录，旧逻辑会因 Test-Path 为真而跳过 mklink，导致 “missing” 源码。
  $srcFull = (Resolve-Path -LiteralPath $src).Path
  $llvmMarkerRel = "llvm-project\llvm\lib\Demangle\DLangDemangle.cpp"
  $outUi = Join-Path $PerfettoDir "out\ui"
  $targets = @(
    (Join-Path $outUi "buildtools"),
    (Join-Path $outUi "wasm\buildtools"),
    (Join-Path $outUi "wasm_memory64\buildtools")
  )
  foreach ($t in $targets) {
    $parent = Split-Path -Parent $t
    if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
    $viaLink = Join-Path $t $llvmMarkerRel
    if ((Test-Path -LiteralPath $t) -and (Test-Path -LiteralPath $viaLink)) { continue }
    if (Test-Path -LiteralPath $t) {
      $item = Get-Item -LiteralPath $t -Force -ErrorAction SilentlyContinue
      # junction 只能用 rmdir 删链接本身，禁止 rmdir /s，否则会删掉 buildtools 目标目录内容
      if ($item -and ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        cmd /c "rmdir `"$t`" 1>nul 2>nul"
      } else {
        Remove-Item -LiteralPath $t -Recurse -Force -ErrorAction SilentlyContinue
      }
    }
    cmd /c "mklink /J `"$t`" `"$srcFull`" 1>nul 2>nul"
  }
}

function Get-NodeForPerfettoBuild {
  param([string] $PerfettoDir)
  # Windows 上 perfetto/tools/node 常为小体积 Linux 包装脚本，cmd 无法执行；仅使用 node.exe 或系统 Node
  $nodeExe = Join-Path $PerfettoDir "tools\node.exe"
  if (Test-Path -LiteralPath $nodeExe) { return $nodeExe }
  if ($env:OS -ne "Windows_NT") {
    $hermetic = Join-Path $PerfettoDir "tools\node"
    if (Test-Path -LiteralPath $hermetic) { return $hermetic }
  }
  return (Get-Command node -ErrorAction Stop).Source
}

function Get-NodeForPerfettoUi {
  param([string] $PerfettoDir)
  $ui = Join-Path $PerfettoDir "ui"
  if (Test-Path -LiteralPath (Join-Path $ui "node.exe")) { return (Join-Path $ui "node.exe") }
  if ($env:OS -ne "Windows_NT") {
    if (Test-Path -LiteralPath (Join-Path $ui "node")) { return (Join-Path $ui "node") }
  }
  $tExe = Join-Path $PerfettoDir "tools\node.exe"
  if (Test-Path -LiteralPath $tExe) { return $tExe }
  if ($env:OS -ne "Windows_NT") {
    $t = Join-Path $PerfettoDir "tools\node"
    if (Test-Path -LiteralPath $t) { return $t }
  }
  return (Get-Command node -ErrorAction Stop).Source
}

$ProjectRoot = Get-ProjectRoot
$WslUiMarker = Join-Path $ProjectRoot ".use-wsl-perfetto-frontend"
$Script:UiBuildUsedWsl = $false
$LogsDir = Join-Path $ProjectRoot "logs"
$Timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
$BackendLog = Join-Path $LogsDir "backend_$Timestamp.log"
$FrontendLog = Join-Path $LogsDir "frontend_$Timestamp.log"

if ($Clean) {
  New-Item -ItemType Directory -Force -Path $LogsDir | Out-Null
  foreach ($prefix in @("backend_", "frontend_", "combined_")) {
    Get-ChildItem -Path $LogsDir -Filter "${prefix}*.log" -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending |
      Select-Object -Skip 10 |
      Remove-Item -Force -ErrorAction SilentlyContinue
  }
}

New-Item -ItemType Directory -Force -Path $LogsDir | Out-Null

Write-Host "=============================================="
Write-Host "SmartPerfetto (Windows)  -  Project: $ProjectRoot"
Write-Host "Mode: $(if ($Quick) { 'Quick' } else { 'Full build' })"
Write-Host "Backend log:  $BackendLog"
Write-Host "Frontend log: $FrontendLog"
Write-Host "PID files:    $(Join-Path $ProjectRoot '.backend.pid') ; $(Join-Path $ProjectRoot '.frontend.pid')"
Write-Host "=============================================="

Test-CommandLine "node"
Test-CommandLine "npm"
$Script:BackendBasePath = $env:PATH
if ($env:OS -eq "Windows_NT") {
  $gNode0 = Get-Command node -ErrorAction SilentlyContinue
  if ($gNode0) { $env:SMARTPERFETTO_NODE = $gNode0.Source }
}
# Perfetto ui/build.js 调用 python3；合并 Machine+User PATH 后，在 %TEMP% 生成带绝对路径的 python3.cmd（node 子进程里 where 仍常失败）
if ($env:OS -eq "Windows_NT") {
  $pMachine = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $pUser = [Environment]::GetEnvironmentVariable("Path", "User")
  $pProcess = $env:PATH
  $merged = ( @($pMachine, $pUser) | Where-Object { $_ } ) -join ";"
  if ($merged) {
    $env:PATH = if ($pProcess) { "$merged;$pProcess" } else { $merged }
  }
  $pyc = $null
  $gPy = Get-Command "python" -ErrorAction SilentlyContinue
  $gPyl = Get-Command "py" -ErrorAction SilentlyContinue
  foreach ($can in @($gPy, $gPyl)) {
    if (-not $can) { continue }
    if ($can.Path -notlike "*WindowsApps*") { $pyc = $can; break }
  }
  if (-not $pyc) {
    $pyc = (Get-Command "python" -ErrorAction SilentlyContinue)
    if (-not $pyc) { $pyc = (Get-Command "py" -ErrorAction SilentlyContinue) }
  }
  if (-not $pyc) {
    Write-Host 'Python 3 not found: add py and/or python to User or System PATH (or install Python 3.10+ x64).' -ForegroundColor Red
    exit 1
  }
  $exeQ = $pyc.Path
  if ($pyc.Name -match '^py(\.exe)?$') {
    $usePy64 = $false
    try {
      & $exeQ -3-64 -c "import struct,sys; sys.exit(0 if struct.calcsize('P')==8 else 1)" 1>$null 2>$null
      if ($LASTEXITCODE -eq 0) { $usePy64 = $true }
    } catch { }
    if ($usePy64) {
      $p3Body = @('@echo off', ('"{0}" -3-64 %*' -f $exeQ))
    } else {
      $p3Body = @('@echo off', ('"{0}" -3 %*' -f $exeQ))
    }
  } else {
    $p3Body = @('@echo off', ('"{0}" %*' -f $exeQ))
  }
  $tP3 = Join-Path $env:TEMP "SmartPerfetto-wpython3"
  if (-not (Test-Path -LiteralPath $tP3)) {
    New-Item -ItemType Directory -Path $tP3 -Force | Out-Null
  }
  $p3File = Join-Path $tP3 "python3.cmd"
  $p3Body -join [Environment]::NewLine | Set-Content -LiteralPath $p3File -Encoding ascii
  $staticPyShim = Join-Path $ProjectRoot "scripts\win-python3-shim"
  $p0 = $env:PATH
  if (Test-Path (Join-Path $staticPyShim "python3.cmd")) {
    $env:PATH = $tP3 + ';' + $staticPyShim + ';' + $p0
  } else {
    $env:PATH = $tP3 + ';' + $p0
  }
}
# Perfetto UI 在 Windows 上用 pnpm@8（npx），不跑 tools/install-build-deps --ui；勿嵌套 powershell -File 子 .ps1（ConstrainedLanguage 会报 DotSourceNotSupported）

$PerfettoDir = Join-Path $ProjectRoot "perfetto"
$UiDir = Join-Path $PerfettoDir "ui"
$TpExe = Join-Path $PerfettoDir "out\ui\trace_processor_shell.exe"

if (-not (Test-Path (Join-Path $UiDir "package.json"))) {
  Write-Host "perfetto/ui not found. Run: git submodule update --init --recursive" -ForegroundColor Red
  exit 1
}
# gn 依赖仓库内的 buildtools/BUILD.gn（由子模块提供）；仅有 install-build-deps 拉取的源码树仍不足以 gn gen。
if (-not $Quick) {
  $gnBuildtoolsRoot = Join-Path $PerfettoDir "buildtools\BUILD.gn"
  if (-not (Test-Path -LiteralPath $gnBuildtoolsRoot)) {
    Write-Host "Missing: $gnBuildtoolsRoot" -ForegroundColor Red
    Write-Host "perfetto 子模块未完整检出（常见：仅有人工拷贝的 buildtools 依赖目录）。请在 SmartPerfetto 根目录执行：" -ForegroundColor Yellow
    Write-Host "  git submodule update --init --recursive" -ForegroundColor Cyan
    exit 1
  }
}

Stop-PortListener 3000
Stop-PortListener 10000
try { cmd /c "taskkill /F /T /IM trace_processor_shell.exe 1>nul 2>nul" } catch { }

$BackendDir = Join-Path $ProjectRoot "backend"
$BackendMod = Join-Path $BackendDir "node_modules"
$TsxCli = Join-Path $BackendDir "node_modules\tsx\dist\cli.mjs"
# node_modules 存在但无 tsx = 曾中断的安装（如 better-sqlite3 失败），需重新 npm install
$needBackendNpm = (-not (Test-Path $BackendMod)) -or (-not (Test-Path $TsxCli))
if ($needBackendNpm) {
  if ((Test-Path $BackendMod) -and (-not (Test-Path $TsxCli))) {
    Write-Host "Backend node_modules is incomplete (missing tsx). Running npm install..." -ForegroundColor Yellow
  } else {
    Write-Host "Installing backend dependencies (npm install)..."
  }
  Push-Location $BackendDir
  npm install
  $npmInstCode = $LASTEXITCODE
  Pop-Location
  if ($npmInstCode -ne 0) {
    Write-Host "Standard npm install failed; trying Windows fallback (ignore-scripts + node prebuild-install)..." -ForegroundColor Yellow
    $nativeWin = Join-Path $ProjectRoot "scripts\complete-backend-native-win.ps1"
    & $nativeWin -BackendDir $BackendDir
    $npmInstCode = $LASTEXITCODE
  }
  if ($npmInstCode -ne 0) {
    Write-Host "Backend dependency install still failed (exit $npmInstCode). Install VS2022 C++ workload and/or see docs/build-windows.md" -ForegroundColor Red
    exit $npmInstCode
  }
  if (-not (Test-Path $TsxCli)) {
    Write-Host "Still missing: $TsxCli after npm install. Fix install errors then retry." -ForegroundColor Red
    exit 1
  }
}

if (-not (Test-Path (Join-Path $ProjectRoot "backend\.env"))) {
  Write-Warning "backend/.env missing  -  copy backend/.env.example and set ANTHROPIC_API_KEY (or proxy)."
}

if (-not $Quick) {
  & (Join-Path $ProjectRoot "scripts\fetch-trace-processor.ps1")
  if (-not (Test-Path $TpExe)) {
    Write-Host "trace_processor_shell.exe not found after fetch." -ForegroundColor Red
    exit 1
  }

  Write-Host "Generating frontend types + backend tsc..."
  if ($env:OS -eq "Windows_NT") {
    # 后端脚本不依赖 python3 shim；使用精简 PATH，规避 Windows 下 tsx 子进程 spawn UNKNOWN。
    cmd /c "set `"PATH=$Script:BackendBasePath`" && cd /d `"$BackendDir`" && npm run generate:frontend-types >> `"$BackendLog`" 2>&1 && npm run build >> `"$BackendLog`" 2>&1"
  } else {
    cmd /c "cd /d `"$BackendDir`" && npm run generate:frontend-types >> `"$BackendLog`" 2>&1 && npm run build >> `"$BackendLog`" 2>&1"
  }
  if ($LASTEXITCODE -ne 0) {
    Write-Host "Backend build failed. Log: $BackendLog" -ForegroundColor Red
    exit $LASTEXITCODE
  }

  $lockUi = Join-Path $UiDir "pnpm-lock.yaml"
  if (-not (Test-Path -LiteralPath $lockUi)) {
    Write-Host "Missing $lockUi" -ForegroundColor Red
    exit 1
  }
  # npx 会访问全局 prefix（Windows 上常为 %APPDATA%\npm）；若目录不存在会 ENOENT
  $npmAppDataBin = Join-Path $env:APPDATA "npm"
  if (-not (Test-Path -LiteralPath $npmAppDataBin)) {
    New-Item -ItemType Directory -Path $npmAppDataBin -Force | Out-Null
  }
  Write-Host "Installing Perfetto UI deps (pnpm@8 via npx)..."
  $PnpmNpx = "pnpm@8.15.9"
  cmd /c "cd /d `"$UiDir`" && npx --yes $PnpmNpx install --shamefully-hoist --frozen-lockfile >> `"$FrontendLog`" 2>&1"
  if ($LASTEXITCODE -ne 0) {
    Write-Warning "frozen-lockfile failed, retrying without it..."
    cmd /c "cd /d `"$UiDir`" && npx --yes $PnpmNpx install --shamefully-hoist >> `"$FrontendLog`" 2>&1"
  }
  if ($LASTEXITCODE -ne 0) {
    Write-Host "UI install failed. Log: $FrontendLog" -ForegroundColor Red
    exit $LASTEXITCODE
  }
  $nm = Join-Path $UiDir "node_modules"
  if (-not (Test-Path -LiteralPath $nm)) { New-Item -ItemType Directory -Path $nm -Force | Out-Null }
  $sum = (Get-FileHash -Algorithm SHA256 -LiteralPath $lockUi).Hash.ToLower()
  $marker = Join-Path $nm ".last_install"
  Set-Content -LiteralPath $marker -Value $sum -Encoding ascii -NoNewline
  Write-Host "Wrote $marker" -ForegroundColor Green

  Write-Host "Perfetto UI buildtools (typefaces + catapult from GCS, not in git)..."
  try {
    & (Join-Path $ProjectRoot "scripts\fetch-perfetto-ui-buildtools.ps1") -PerfettoDir $PerfettoDir
  } catch {
    Write-Host "fetch-perfetto-ui-buildtools failed: $_" -ForegroundColor Red
    exit 1
  }

  $useWslUi = ($env:OS -eq "Windows_NT") -and ($WslUi -or ($env:SMARTPERFETTO_UI_WSL -eq "1"))
  if ($useWslUi) {
    if (-not (Get-Command wsl -ErrorAction SilentlyContinue)) {
      Write-Host "WSL (wsl) not found. Install WSL2 or do not use -WslUi." -ForegroundColor Red
      exit 1
    }
  } elseif ($env:OS -eq "Windows_NT") {
    try {
      & (Join-Path $ProjectRoot "scripts\fetch-perfetto-gn-ninja-win.ps1") -PerfettoDir $PerfettoDir
    } catch {
      Write-Host "fetch-perfetto-gn-ninja-win failed: $_" -ForegroundColor Red
      exit 1
    }
    # 原生 Windows WASM：emsdk 无 GCS 的 win tgz，用官方 emsdk 安装 4.0.8 后 junction 到 buildtools\win64\emsdk
    try {
      & (Join-Path $ProjectRoot "scripts\bootstrap-perfetto-emsdk-win.ps1") -PerfettoDir $PerfettoDir
    } catch {
      Write-Host "bootstrap-perfetto-emsdk-win failed: $_" -ForegroundColor Red
      exit 1
    }
    # 与 install-build-deps 的 BUILD_DEPS_HOST 一致：protoc 需 buildtools/protobuf + abseil 源码
    try {
      Install-PerfettoHostBuildtoolsWin -PerfettoDir $PerfettoDir
    } catch {
      Write-Host "Install-PerfettoHostBuildtoolsWin failed: $_" -ForegroundColor Red
      exit 1
    }
    # 默认不 gn clean：避免误伤 out/ui 产物与用户感知的「清干净重来」；仅在 -ForceGnClean 或 SMARTPERFETTO_FORCE_GN_CLEAN=1 时执行（不删除 buildtools 里已下载的编译工具链与源码包）。
    $outUiDir = Join-Path $PerfettoDir "out\ui"
    Ensure-WindowsUiBuildtoolsJunctions -PerfettoDir $PerfettoDir
    $wantGnClean = $ForceGnClean -or ($env:SMARTPERFETTO_FORCE_GN_CLEAN -eq "1")
    $argsGn = Join-Path $outUiDir "args.gn"
    if ($wantGnClean -and (Test-Path -LiteralPath $argsGn)) {
      Add-Content -LiteralPath $FrontendLog -Value "`n=== gn clean out\ui (-ForceGnClean / SMARTPERFETTO_FORCE_GN_CLEAN)`n" -Encoding utf8
      cmd /c "cd /d `"$PerfettoDir`" && py -3 tools\gn clean out\ui >> `"$FrontendLog`" 2>&1"
    }
  }

  if ($useWslUi) {
    Write-Host "Building Perfetto UI in WSL (WASM/emsdk; first run may run install-build-deps --ui)..."
    $wslRoot = ConvertTo-WslPath -WinPath $ProjectRoot
    $shWin = Join-Path $ProjectRoot "scripts\perfetto-ui-wsl-build-inner.sh"
    if (-not (Test-Path -LiteralPath $shWin)) { Write-Host "Missing $shWin" -ForegroundColor Red; exit 1 }
    $shU = ConvertTo-WslPath -WinPath $shWin
    Add-Content -LiteralPath $FrontendLog -Value "`n=== WSL: /bin/bash $shU $wslRoot`n" -Encoding utf8
    $ErrorActionPreferenceBak = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    $wslOut = & wsl -e /bin/bash $shU $wslRoot 2>&1
    $wslEx = $LASTEXITCODE
    $ErrorActionPreference = $ErrorActionPreferenceBak
    $wslOut | Add-Content -LiteralPath $FrontendLog
    if ($wslEx -ne 0) {
      Write-Host "WSL UI build failed. Log: $FrontendLog" -ForegroundColor Red
      exit $wslEx
    }
    $Script:UiBuildUsedWsl = $true
    try { Set-Content -LiteralPath $WslUiMarker -Value "WSL" -Encoding ascii } catch { }
  } else {
    Write-Host "Building Perfetto UI (node ui/build.js)..."
    $nodeBuild = Get-NodeForPerfettoBuild -PerfettoDir $PerfettoDir
    if ($env:OS -eq "Windows_NT") {
      Ensure-WindowsUiBuildtoolsJunctions -PerfettoDir $PerfettoDir
    }
    # build.js 会 scanDir buildtools/typefaces；若仅存 .stamp 或目录缺失则补拉一次（与 gn clean 无关，避免 ENOENT）
    $typefacesDir = Join-Path $PerfettoDir "buildtools\typefaces"
    $hasTypefaces = $false
    if (Test-Path -LiteralPath $typefacesDir) {
      $hasTypefaces = ($null -ne (Get-ChildItem -LiteralPath $typefacesDir -File -Recurse -ErrorAction SilentlyContinue |
          Where-Object { $_.Extension -eq ".woff2" } | Select-Object -First 1))
    }
    if (-not $hasTypefaces) {
      Write-Host "UI buildtools (typefaces) missing or empty; re-running fetch-perfetto-ui-buildtools..." -ForegroundColor Yellow
      Add-Content -LiteralPath $FrontendLog -Value "`n=== re-fetch UI buildtools (typefaces)`n" -Encoding utf8
      try {
        & (Join-Path $ProjectRoot "scripts\fetch-perfetto-ui-buildtools.ps1") -PerfettoDir $PerfettoDir 2>&1 |
          Add-Content -LiteralPath $FrontendLog
      } catch {
        Write-Host "fetch-perfetto-ui-buildtools failed: $_" -ForegroundColor Red
        exit 1
      }
      $hasTypefaces = ($null -ne (Get-ChildItem -LiteralPath $typefacesDir -File -Recurse -ErrorAction SilentlyContinue |
          Where-Object { $_.Extension -eq ".woff2" } | Select-Object -First 1))
      if (-not $hasTypefaces) {
        Write-Host "Still missing buildtools/typefaces (.woff2). Check network/GCS and $FrontendLog" -ForegroundColor Red
        exit 1
      }
    }
    # --no-depscheck：UI 依赖已由 pnpm 安装；install-build-deps 需有效 git HEAD，子模块/无 .git 时会失败
    $cleanUiOutFlag = ""
    if ($CleanUiOut -or ($env:SMARTPERFETTO_CLEAN_UI_OUT -eq "1")) { $cleanUiOutFlag = " --clean-out-ui" }
    cmd /c "cd /d `"$PerfettoDir`" && `"$nodeBuild`" ui\build.js --no-depscheck$cleanUiOutFlag >> `"$FrontendLog`" 2>&1"
    if ($LASTEXITCODE -ne 0) {
      Write-Host "Frontend build failed. Log: $FrontendLog" -ForegroundColor Red
      if ($env:OS -eq "Windows_NT") {
        Write-Host "需要：VS 2022 生成工具 + Windows 10/11 SDK、64 位 Python 3.10+、Git、Node；emsdk 在 buildtools\win64\emsdk；host deps（protobuf/abseil/zlib/sqlite/re2/llvm-project...）由 Start-Dev 内 Install-PerfettoHostBuildtoolsWin 拉取。或 WSL：npm run dev:win:wsl" -ForegroundColor DarkYellow
      }
      exit $LASTEXITCODE
    }
  }
} else {
  $distDir = Join-Path $ProjectRoot "backend\dist"
  $outUi = Join-Path $PerfettoDir "out\ui\ui\dist"
  if (-not (Test-Path $distDir)) { Write-Host "Quick mode: need backend\dist. Run a full build first (without -Quick)." -ForegroundColor Red; exit 1 }
  if (-not (Test-Path $outUi) -and -not (Test-Path (Join-Path $PerfettoDir "out\ui\dist"))) {
    Write-Host "Quick mode: need perfetto\out\ui build output. Run a full build first (without -Quick)." -ForegroundColor Red
    exit 1
  }
  if (-not (Test-Path $TpExe)) {
    & (Join-Path $ProjectRoot "scripts\fetch-trace-processor.ps1")
  }
}

# 启动后端：cmd 持久化运行 npm run dev
$cmdBack = if ($env:OS -eq "Windows_NT") {
  "set `"PATH=$Script:BackendBasePath`" && cd /d `"$BackendDir`" && npm run dev >> `"$BackendLog`" 2>&1"
} else {
  "cd /d `"$BackendDir`" && npm run dev >> `"$BackendLog`" 2>&1"
}
$PBack = Start-Process -FilePath "cmd.exe" -ArgumentList @("/c", $cmdBack) -PassThru -WindowStyle Hidden
$backendPidFile = Join-Path $ProjectRoot ".backend.pid"
[System.IO.File]::WriteAllText($backendPidFile, "$($PBack.Id)", [System.Text.UTF8Encoding]::new($false))
Write-Host "Backend started: cmd.exe PID $($PBack.Id) -> $backendPidFile"

Write-Host "Waiting for backend /health..."
$ready = $false
for ($i = 0; $i -lt 30; $i++) {
  try {
    $r = Invoke-WebRequest -Uri "http://localhost:3000/health" -UseBasicParsing -TimeoutSec 2
    if ($r.StatusCode -eq 200) { $ready = $true; Write-Host ('Backend ready (' + $i + 's)'); break }
  } catch { }
  Start-Sleep -Seconds 1
}
if (-not $ready) { Write-Warning "Backend health not OK after 30s  -  see $BackendLog" }

# 启动前端：仅当本会话在 WSL 内完成过 UI 构建时，在 WSL 里跑 watch（不依赖 .use-wsl 标记，以免纯本机构建被误切到 WSL）
$wslForFront = $false
if ($env:OS -eq "Windows_NT") {
  if ($Script:UiBuildUsedWsl) {
    if (Get-Command wsl -ErrorAction SilentlyContinue) { $wslForFront = $true }
  }
}
if ($wslForFront) {
  $wslP = ConvertTo-WslPath -WinPath $ProjectRoot
  $wslL = ConvertTo-WslPath -WinPath $FrontendLog
  $wslSh = ConvertTo-WslPath -WinPath (Join-Path $ProjectRoot "scripts\perfetto-ui-wsl-watch-inner.sh")
  if (-not (Test-Path (Join-Path $ProjectRoot "scripts\perfetto-ui-wsl-watch-inner.sh"))) { throw "Missing perfetto-ui-wsl-watch-inner.sh" }
  Write-Host "Starting Perfetto UI dev in WSL (port 10000)..."
  $PFront = Start-Process -FilePath "wsl" -ArgumentList @("-e", "/bin/bash", $wslSh, $wslP, $wslL) -PassThru -WindowStyle Hidden
} else {
  $nodeUi = Get-NodeForPerfettoUi -PerfettoDir $PerfettoDir
  # Quick 且已有 dist：watch 进程加 --no-build，避免再跑一轮 gn/ninja/tsc/rollup，显著缩短 :10000 首次就绪（牺牲该进程内 TS 热编译，改代码需全量 dev 或去掉 -Quick）。
  $quickNoBuild = if ($Quick) { " --no-build" } else { "" }
  $uiCmd = "cd /d `"$UiDir`" && `"$nodeUi`" build.js --no-depscheck --only-wasm-memory64 --serve --watch$quickNoBuild >> `"$FrontendLog`" 2>&1"
  $PFront = Start-Process -FilePath "cmd.exe" -ArgumentList @("/c", $uiCmd) -PassThru -WindowStyle Hidden
}
$frontendPidFile = Join-Path $ProjectRoot ".frontend.pid"
[System.IO.File]::WriteAllText($frontendPidFile, "$($PFront.Id)", [System.Text.UTF8Encoding]::new($false))
Write-Host "Frontend started: PID $($PFront.Id) -> $frontendPidFile"

Write-Host "Waiting for frontend (port 10000)..."
$feOk = $false
for ($i = 0; $i -lt 90; $i++) {
  try {
    $r = Invoke-WebRequest -Uri "http://localhost:10000/" -UseBasicParsing -TimeoutSec 3
    if ($r.StatusCode -eq 200) { $feOk = $true; Write-Host ('Frontend responded (' + $i + 's)'); break }
  } catch { }
  Start-Sleep -Seconds 1
}
if (-not $feOk) { Write-Warning "Frontend not ready after 90s  -  see $FrontendLog" }

Write-Host ""
Write-Host "=============================================="
Write-Host "  Perfetto UI: http://localhost:10000"
Write-Host "  Backend API: http://localhost:3000"
Write-Host "  Stop: scripts\stop-dev.bat  or  Stop-Process -Id $($PBack.Id),$($PFront.Id) -Force"
Write-Host "  PIDs: backend=$($PBack.Id) frontend=$($PFront.Id) (also in .backend.pid / .frontend.pid)"
Write-Host "=============================================="
Copy-Item -Force $BackendLog (Join-Path $LogsDir "backend_latest.log") -ErrorAction SilentlyContinue
Copy-Item -Force $FrontendLog (Join-Path $LogsDir "frontend_latest.log") -ErrorAction SilentlyContinue

exit 0
