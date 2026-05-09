# SPDX-License-Identifier: AGPL-3.0-or-later
# 拉取 ui/build.js 的 scanDir 所依赖的 buildtools/typefaces、buildtools/catapult_trace_viewer（GCS 包，与 install-build-deps 中定义一致，不在 git 中）

param(
  [Parameter(Mandatory = $true)]
  [string] $PerfettoDir
)

$ErrorActionPreference = "Stop"
$PerfettoDir = (Resolve-Path -LiteralPath $PerfettoDir).Path
$Ibd = Join-Path $PerfettoDir "tools\install-build-deps"
if (-not (Test-Path -LiteralPath $Ibd)) { throw "Missing $Ibd" }

$ib = Get-Content -LiteralPath $Ibd -Raw
if ($ib -notmatch "TYPEFACES_SHA256 = '([a-f0-9]{64})'") { throw "TYPEFACES_SHA256 not found in install-build-deps" }
$TypefacesHash = $Matches[1]
if ($ib -notmatch "CATAPULT_SHA256 = '([a-f0-9]{64})'") { throw "CATAPULT_SHA256 not found in install-build-deps" }
$CatapultHash = $Matches[1]

function Get-StoredStamp([string] $dir) {
  $s = Join-Path $dir ".stamp"
  if (Test-Path -LiteralPath $s) { return (Get-Content -LiteralPath $s -Raw).Trim() }
  return $null
}

# 与 install-build-deps: 下载 tgz -> 校验 -> 解压到去掉 .tgz 的目录 -> 若单根子目录则上移；写 .stamp；删 tgz
function Install-PerfettoBuildtoolsGcsTgz {
  param(
    [string] $TgzPathUnderPerfetto,
    [string] $Url,
    [string] $ExpectedSha256
  )
  $localTgz = Join-Path $PerfettoDir ($TgzPathUnderPerfetto -replace "/", [IO.Path]::DirectorySeparatorChar)
  if ($localTgz -notlike "*.tgz") { throw "not a .tgz: $TgzPathUnderPerfetto" }
  $outDir = $localTgz.Substring(0, $localTgz.Length - 4)
  # .stamp 匹配不代表目录未被清空；必须仍有实质内容才跳过下载
  if ((Test-Path -LiteralPath (Join-Path $outDir ".stamp")) -and ((Get-StoredStamp $outDir) -eq $ExpectedSha256)) {
    $nonStamp = Get-ChildItem -LiteralPath $outDir -Force -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -ne ".stamp" }
    if (($nonStamp | Measure-Object).Count -gt 0) { return }
  }
  $parent = Split-Path -Parent $localTgz
  if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
  $tmp = $localTgz + ".tmp"
  Write-Host "Downloading $(Split-Path $Url -Leaf)" -ForegroundColor Cyan
  $ProgressPreference = "SilentlyContinue"
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Invoke-WebRequest -Uri $Url -OutFile $tmp -UseBasicParsing
  $h = (Get-FileHash -Algorithm SHA256 -LiteralPath $tmp).Hash.ToLower()
  if ($h -ne $ExpectedSha256) {
    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
    throw "SHA256 mismatch: expected $ExpectedSha256, got $h"
  }
  if (-not (Test-Path -LiteralPath $tmp)) { throw "tmp missing" }
  Move-Item -LiteralPath $tmp -Destination $localTgz -Force
  if (Test-Path -LiteralPath $outDir) { Remove-Item -LiteralPath $outDir -Recurse -Force }
  New-Item -ItemType Directory -Path $outDir -Force | Out-Null
  $tgzFull = (Resolve-Path -LiteralPath $localTgz).Path
  Push-Location $outDir
  try { & tar -oxf $tgzFull; if ($LASTEXITCODE -ne 0) { throw "tar exit $LASTEXITCODE" } } finally { Pop-Location }
  $rootItems = Get-ChildItem -LiteralPath $outDir -Force
  if ($rootItems.Count -eq 1 -and $rootItems[0].PSIsContainer) {
    $up = $rootItems[0].FullName
    Get-ChildItem -LiteralPath $up | ForEach-Object { Move-Item -LiteralPath $_.FullName -Destination $outDir -Force }
    Remove-Item -LiteralPath $up -Recurse -Force
  }
  Set-Content -Path (Join-Path $outDir ".stamp") -Value $ExpectedSha256 -Encoding ascii -NoNewline
  Remove-Item -LiteralPath $localTgz -Force
  Write-Host "OK: $outDir" -ForegroundColor Green
}

Install-PerfettoBuildtoolsGcsTgz "buildtools/typefaces.tgz" `
  "https://storage.googleapis.com/perfetto/typefaces-$TypefacesHash.tar.gz" $TypefacesHash
Install-PerfettoBuildtoolsGcsTgz "buildtools/catapult_trace_viewer.tgz" `
  "https://storage.googleapis.com/perfetto/catapult_trace_viewer-$CatapultHash.tar.gz" $CatapultHash
# 成功勿 exit：由 start-dev.ps1 以 & 调用时，exit 会结束整个 PowerShell 会话
