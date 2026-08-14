<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2024-2026 Gracker (Chris)
This file is part of SmartPerfetto. See LICENSE for details.
-->

# Windows EXE 打包

[English](windows-exe.en.md) | [中文](windows-exe.md)

<!-- i18n-headings: paired -->

> 当前 Windows 命令是跨平台免安装打包流程的兼容入口。完整三平台流程见
> [免安装包打包](portable-packaging.md)。

SmartPerfetto 的 Windows 包不是单文件二进制。`SmartPerfetto.exe` 是启动器，
同目录还包含 Windows Node.js 24 runtime、Windows 原生 `node_modules`、
预构建 Perfetto UI、后端运行时代码、固定版本的 `trace_processor_shell.exe` 和
签名 Android Internals Knowledge Pack。
用户只需要解压并双击 `SmartPerfetto.exe`，不需要安装 Docker 或 Node.js。

## 维护者打包流程

版本号以根目录 `package.json` 为源头。`backend/package.json` 和两个
`package-lock.json` 通过脚本同步，不要手工改其中一个。

前置条件：

- macOS、Linux 或 WSL2 构建环境。
- Node.js 24 LTS；脚本会通过仓库的 `scripts/node-env.sh` 尝试用 nvm/fnm 自动切换。
- Go toolchain，用来交叉编译 Windows 启动器。
- `curl`、`rsync`、`unzip`、`zip`。
- 可以访问 npm registry、nodejs.org 和 Perfetto LUCI artifact bucket，或配置等价镜像。

打包命令：

```bash
npm run package:windows-exe
```

输出位置：

```text
dist/windows-exe/smartperfetto-v<version>-windows-x64/SmartPerfetto.exe
dist/windows-exe/smartperfetto-v<version>-windows-x64.zip
```

脚本会执行这些步骤：

1. 切到 Node.js 24，并安装/校验当前平台的 backend 依赖。
2. 运行 `cd backend && npm run build`。
3. 复制 `backend/dist`、`backend/skills`、`backend/strategies`、`backend/sql`、
   `backend/data`、`backend/knowledge`、`backend/public` 和根目录 `frontend/`
   预构建包。
4. 在发布目录里用 `npm ci --omit=dev --include=optional --os=win32 --cpu=x64` 安装 Windows x64 production 依赖。
5. 校验 Windows 版 `better-sqlite3` native module 和 `@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe` 已存在。
6. 下载并校验 Node.js 24 Windows x64 zip。
7. 按 `scripts/trace-processor-pin.env` 下载并校验 Windows
   `trace_processor_shell.exe`，不在文档中复制版本号。
8. 用 Go 交叉编译 `SmartPerfetto.exe` 启动器。
9. 写入 `PACKAGE-MANIFEST.json`，记录版本、zip 顶层目录、git commit、
   dirty 状态、Node runtime、trace processor pin 和 Knowledge Pack。
10. 生成 zip 包并校验文件名、顶层目录、包内版本、Knowledge Pack 哈希和 manifest。

## 发布流程

当前公开发布优先使用三平台 [免安装包打包](portable-packaging.md) 和
[发布手册](release.md)。`release:windows-exe` 只是兼容入口，用于生成或上传
Windows x64 **draft 候选资产**；公开发布不允许单独重发或替换 Windows asset。

正式发布前先同步并提交版本号：

```bash
npm run version:set -- <version>
npm run version:sync -- --check
git add package.json package-lock.json backend/package.json backend/package-lock.json
git commit -m "chore: release v<version>"
```

然后发布：

```bash
npm run release:windows-exe -- <version>
```

脚本会：

1. 校验版本号已经同步到根 `package.json`、根 `package-lock.json`、
   `backend/package.json` 和 `backend/package-lock.json`。
2. 拒绝从 dirty worktree 上传 release 包，除非显式传 `--allow-dirty`。
3. 重新打包 Windows x64 zip。
4. 校验 zip 文件名、顶层目录、包内版本、manifest commit 和 dirty 状态。
5. 生成 release notes，包含 zip 的 SHA256、大小和目标 commit。
6. 创建或更新 GitHub Release `v<version>`，并把 release tag target 指向目标 commit。
7. 上传带版本号的文件名，例如 `smartperfetto-v<version>-windows-x64.zip`，
   方便用户区分不同版本的离线包。

默认创建 draft release。不要在 GitHub UI 中直接发布单平台 draft，也不要运行
`release:windows-exe --no-draft`：当前 promotion 契约要求 Windows、macOS、Linux
三个最终资产都完成 exact-archive smoke，并通过 [发布手册](release.md) 中的
`release:portable --skip-build --no-draft` 提升同一个不可变 draft。

上传 release 包默认要求 git worktree 干净，避免 release tag 指向的源码版本和
zip 内版本不一致。只做 draft/test 上传且已经确认可以接受本地未提交状态时，
可显式加 `--allow-dirty`。

只同步版本号但不发布：

```bash
npm run version:set -- <version>
npm run version:sync -- --check
```

## 用户运行流程

用户下载、校验、完整解压、Provider 配置、更新迁移和排障统一见
[Windows 配置与运行指南](../getting-started/windows.md)。下面只保留启动器契约摘要。

1. 解压 `smartperfetto-v<version>-windows-x64.zip` 到普通本地目录，例如 `C:\SmartPerfetto`。
2. 双击 `SmartPerfetto.exe`。
3. 浏览器通常会自动打开；如果没有，按启动器打印的 `Frontend: http://127.0.0.1:<port>` 地址打开（默认端口被占用时，启动器会选择其他端口）。
4. 启动器仅在 D: 是本地固定磁盘且可写时优先使用 `D:\SmartPerfettoData`，否则回退 `%LOCALAPPDATA%\SmartPerfetto`；以打印的 `Data directory` 为准。
5. AI 分析需要在 UI 里配置 Provider profile；如需 env 凭证，在 `<Data directory>\env` 写入 provider 配置，然后重启 `SmartPerfetto.exe`。不要把持久凭证写入解压目录，也不要尝试在该文件里配置数据根目录。
6. 使用时保持启动器窗口打开；按 `Ctrl+C` 会停止后端、前端和 trace processor 子进程。

## 验证

跨平台构建机能验证包结构、后端 typecheck/build 和依赖完整性，但不能执行
Windows 原生 smoke。常规 Windows CI 会运行 portable launcher Go test/build 与
DPAPI SecretStore 测试；公开发布还必须在 Windows x64 runner 上执行最终归档 smoke：

```powershell
Expand-Archive .\smartperfetto-v<version>-windows-x64.zip -DestinationPath C:\SmartPerfettoSmoke
C:\SmartPerfettoSmoke\smartperfetto-v<version>-windows-x64\SmartPerfetto.exe
```

然后检查：

- 启动器输出的 `http://127.0.0.1:<port>` 能打开 Perfetto UI。
- 启动器输出的后端 `http://127.0.0.1:<port>/health` 返回 `status: "OK"`。
- 上传一条小 trace 后，后端日志里能看到 `trace_processor_shell.exe` 启动。
- 包内 CLI 的 `smp knowledge-pack status --format json` 能解析 bundled/active Pack。

launcher 优先使用后端端口 `3000`、前端端口 `10000`，默认端口被占用时会自动选择其他可用端口。
以 launcher 打印的 URL 为准。只有需要固定端口时才设置 `SMARTPERFETTO_BACKEND_PORT`
或 `SMARTPERFETTO_FRONTEND_PORT`；显式配置的端口不可用时会快速失败。

## 限制

- 当前只产出 Windows x64 包。
- 这是解压即用目录，不是单文件 portable exe；不要只分发 `SmartPerfetto.exe` 一个文件。
- 当前脚本不做 Authenticode 签名。正确接入顺序必须是：签名并加时间戳 → 生成最终 zip
  → 对最终字节运行 exact-archive smoke → 发布。不能在 zip 或 smoke 之后修改 EXE，
  否则 digest 和验收证据失效。
