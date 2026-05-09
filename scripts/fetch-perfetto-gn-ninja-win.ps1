# SPDX-License-Identifier: AGPL-3.0-or-later
# 下载与 install-build-deps 中一致的 third_party/gn.exe 与 third_party/ninja.exe（供 tools/gn|ninja Python 调 run_buildtools_binary 使用）
param(
  [Parameter(Mandatory = $true)]
  [string] $PerfettoDir
)
$ErrorActionPreference = "Stop"
$PerfettoDir = (Resolve-Path -LiteralPath $PerfettoDir).Path
# 来自 tools/install-build-deps 中 gn.exe / ninja.exe 的 Windows x64 项
$gnUrl = "https://storage.googleapis.com/perfetto/gn-win-1968-0725d782"
$gnSha = "001f777f023c7a6959c778fb3a6b6cfc63f6baef953410ecdeaec350fb12285b"
$njUrl = "https://storage.googleapis.com/perfetto/ninja-win-182"
$njSha = "09ced0fcd1a4dec7d1b798a2cf9ce5d20e5d2fbc2337343827f192ce47d0f491"

function Install-One {
  param([string]$Rel, [string]$Url, [string] $Expected, [string]$Label)
  $dst = Join-Path $PerfettoDir ($Rel -replace "/", [IO.Path]::DirectorySeparatorChar)
  if (Test-Path -LiteralPath $dst) {
    $h = (Get-FileHash -Algorithm SHA256 -LiteralPath $dst).Hash.ToLower()
    if ($h -eq $Expected) { return }
  }
  $dir = Split-Path -Parent $dst
  if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  $tmp = $dst + ".part"
  Write-Host "Downloading $Label" -ForegroundColor Cyan
  $ProgressPreference = "SilentlyContinue"
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Invoke-WebRequest -Uri $Url -OutFile $tmp -UseBasicParsing
  $h2 = (Get-FileHash -Algorithm SHA256 -LiteralPath $tmp).Hash.ToLower()
  if ($h2 -ne $Expected) { Remove-Item -LiteralPath $tmp -Force; throw "SHA256 mismatch for $Label" }
  Move-Item -LiteralPath $tmp -Destination $dst -Force
  Write-Host "OK $Label" -ForegroundColor Green
}
Install-One "third_party/gn/gn.exe" $gnUrl $gnSha "gn.exe"
Install-One "third_party/ninja/ninja.exe" $njUrl $njSha "ninja.exe"
