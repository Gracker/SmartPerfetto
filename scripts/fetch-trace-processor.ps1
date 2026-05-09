# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2024-2026 Gracker (Chris)
# This file is part of SmartPerfetto. See LICENSE for details.
# 下載 Windows 预编译 trace_processor_shell（与 get.perfetto.dev 的 amalgam 清单版本对齐）

$ErrorActionPreference = "Stop"
$Version = "v54.0"
# 与 https://get.perfetto.dev/trace_processor 中 TRACE_PROCESSOR_SHELL_MANIFEST 的 windows-amd64 项一致
$SourceUrl = "https://commondatastorage.googleapis.com/perfetto-luci-artifacts/${Version}/windows-amd64/trace_processor_shell.exe"
$ExpectedSha256 = "7138e6f97c562fa063e1ceab1a0221c1c211328a304060aa8899363b07c7e2ab"

$ScriptDir = $PSScriptRoot
if (-not $ScriptDir) { $ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path }
$ProjectRoot = (Resolve-Path (Join-Path $ScriptDir "..")).Path
$OutDir = Join-Path $ProjectRoot "perfetto\out\ui"
$OutFile = Join-Path $OutDir "trace_processor_shell.exe"

if (Test-Path $OutFile) {
  Write-Host "Found existing $OutFile"
  $h = (Get-FileHash -Algorithm SHA256 -Path $OutFile).Hash.ToLower()
  if ($h -eq $ExpectedSha256.ToLower()) { Write-Host "SHA256 OK - skipping download."; exit 0 }
  Write-Warning "Hash mismatch, re-downloading..."
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$Tmp = "$OutFile.part"
Write-Host "Downloading $SourceUrl`n  -> $OutFile"
$ProgressPreference = "SilentlyContinue" # 加速 Invoke-WebRequest
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
try {
  Invoke-WebRequest -Uri $SourceUrl -OutFile $Tmp -UseBasicParsing
} catch {
  Write-Error "Download failed: $_"
  exit 1
}

$actual = (Get-FileHash -Algorithm SHA256 -Path $Tmp).Hash.ToLower()
if ($actual -ne $ExpectedSha256.ToLower()) {
  Remove-Item -Force $Tmp -ErrorAction SilentlyContinue
  Write-Error "SHA256 mismatch. Expected: $ExpectedSha256 Got: $actual"
  exit 1
}
Move-Item -Force $Tmp $OutFile
Write-Host "trace_processor_shell.exe ready: $OutFile"
exit 0
