#Requires -RunAsAdministrator
# 安装 SmartPerfetto / Perfetto 原生 Windows UI 所需的 MSVC + Windows SDK（供 clang-cl / protoc 等 host 构建）。
# 用法：右键 PowerShell → 以管理员身份运行，然后执行：
#   Set-Location D:\SmartPerfetto
#   .\scripts\install-vs-build-tools.ps1

$ErrorActionPreference = 'Stop'

if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
  throw '未找到 winget。请安装「应用安装程序」或从 Microsoft Store 更新 App Installer。'
}

Write-Host '正在通过 winget 安装 Visual Studio 2022 Build Tools（C++ 工作负载 + 推荐项，含 Windows SDK）...' -ForegroundColor Cyan
Write-Host '下载与安装可能需 15–40 分钟，请保持网络畅通。' -ForegroundColor DarkYellow

# --source winget：避免 msstore 源的交互式协议确认
# VCTools + includeRecommended：MSVC v143、Windows SDK 等
$override = '--passive --wait --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended'
winget install -e --id Microsoft.VisualStudio.2022.BuildTools --source winget `
  --accept-package-agreements --accept-source-agreements `
  --override $override

if ($LASTEXITCODE -ne 0) {
  throw "winget 安装退出码: $LASTEXITCODE"
}

Write-Host "`n安装程序已结束。请验证 Perfetto 探测脚本（应输出 3 行路径，第 2、3 行非空）：" -ForegroundColor Green
$perfetto = Join-Path $PSScriptRoot '..\perfetto\gn\standalone\toolchain\win_find_msvc.py'
if (Test-Path $perfetto) {
  py -3-64 $perfetto
} else {
  Write-Host "未找到 $perfetto ，请从仓库根目录运行。" -ForegroundColor Yellow
}

Write-Host "`n完成后请重新打开终端，再运行 SmartPerfetto 的 start-dev / 前端构建。" -ForegroundColor Green
