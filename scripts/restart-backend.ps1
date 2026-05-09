# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2024-2026 Gracker (Chris)
# This file is part of SmartPerfetto. See LICENSE for details.
# 仅重启后端（.env 或 npm install 变更时用），对应 restart-backend.sh

$ErrorActionPreference = "Stop"
$ScriptDir = $PSScriptRoot
if (-not $ScriptDir) { $ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path }
$ProjectRoot = (Resolve-Path (Join-Path $ScriptDir "..")).Path
$BackendDir = Join-Path $ProjectRoot "backend"
$LogsDir = Join-Path $ProjectRoot "logs"
$Timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
$BackendLog = Join-Path $LogsDir "backend_$Timestamp.log"
New-Item -ItemType Directory -Force -Path $LogsDir | Out-Null

# 结束 3000 端口上的进程
try {
  $c = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
  foreach ($x in $c) { Stop-Process -Id $x.OwningProcess -Force -ErrorAction SilentlyContinue }
} catch { }
if (Test-Path (Join-Path $ProjectRoot ".backend.pid")) {
  $old = Get-Content (Join-Path $ProjectRoot ".backend.pid") -ErrorAction SilentlyContinue
  if ($old) { try { Stop-Process -Id ([int]$old) -Force -ErrorAction SilentlyContinue } catch { } }
}

$cmdBack = "cd /d `"$BackendDir`" && npm run dev >> `"$BackendLog`" 2>&1"
$P = Start-Process -FilePath "cmd.exe" -ArgumentList @("/c", $cmdBack) -PassThru -WindowStyle Hidden
$P.Id | Out-File -FilePath (Join-Path $ProjectRoot ".backend.pid") -Encoding ascii
Copy-Item -Force $BackendLog (Join-Path $LogsDir "backend_latest.log") -ErrorAction SilentlyContinue

Write-Host "Backend starting - log: $BackendLog"
for ($i = 0; $i -lt 15; $i++) {
  try {
    $r = Invoke-WebRequest -Uri "http://localhost:3000/health" -UseBasicParsing -TimeoutSec 2
    if ($r.StatusCode -eq 200) { Write-Host "Ready (${i}s) PID: $($P.Id)"; exit 0 }
  } catch { }
  Start-Sleep -Seconds 1
}
Write-Warning "Backend not healthy after 15s. See: $BackendLog"
exit 1
