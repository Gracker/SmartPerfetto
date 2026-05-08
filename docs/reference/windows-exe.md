<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2024-2026 Gracker (Chris)
This file is part of SmartPerfetto. See LICENSE for details.
-->

# Windows EXE 打包

[English](windows-exe.en.md) | [中文](windows-exe.md)

SmartPerfetto 的 Windows 包不是单文件二进制。`SmartPerfetto.exe` 是启动器，
同目录还包含 Windows Node.js 24 runtime、Windows 原生 `node_modules`、
预构建 Perfetto UI、后端运行时代码和固定版本的 `trace_processor_shell.exe`。
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
dist/windows-exe/smartperfetto-v1.0.1-windows-x64/SmartPerfetto.exe
dist/windows-exe/smartperfetto-v1.0.1-windows-x64.zip
```

脚本会执行这些步骤：

1. 切到 Node.js 24，并安装/校验当前平台的 backend 依赖。
2. 运行 `cd backend && npm run build`。
3. 复制 `backend/dist`、`backend/skills`、`backend/strategies`、`backend/sql`、`backend/data`、`backend/public` 和根目录 `frontend/` 预构建包。
4. 在发布目录里用 `npm ci --omit=dev --include=optional --os=win32 --cpu=x64` 安装 Windows x64 production 依赖。
5. 校验 Windows 版 `better-sqlite3` native module 和 `@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe` 已存在。
6. 下载并校验 Node.js 24 Windows x64 zip。
7. 下载并校验 `v54.0/windows-amd64/trace_processor_shell.exe`。
8. 用 Go 交叉编译 `SmartPerfetto.exe` 启动器。
9. 写入 `PACKAGE-MANIFEST.json`，记录版本、zip 顶层目录、git commit、
   dirty 状态、Node runtime 和 trace processor pin。
10. 生成 zip 包并校验文件名、顶层目录、包内版本和 manifest。

## 发布流程

正式发布前先同步并提交版本号：

```bash
npm run version:set -- 1.0.1
git add package.json package-lock.json backend/package.json backend/package-lock.json
git commit -m "chore: release v1.0.1"
```

然后发布：

```bash
npm run release:windows-exe -- 1.0.1
```

脚本会：

1. 校验版本号已经同步到根 `package.json`、根 `package-lock.json`、
   `backend/package.json` 和 `backend/package-lock.json`。
2. 拒绝从 dirty worktree 上传 release 包，除非显式传 `--allow-dirty`。
3. 重新打包 Windows x64 zip。
4. 校验 zip 文件名、顶层目录、包内版本、manifest commit 和 dirty 状态。
5. 生成 release notes，包含 zip 的 SHA256、大小和目标 commit。
6. 创建或更新 GitHub Release `v1.0.1`，并把 release tag target 指向目标 commit。
7. 上传带版本号的文件名，例如 `smartperfetto-v1.0.1-windows-x64.zip`，
   方便用户区分不同版本的离线包。

默认创建 draft release。确认 Windows 真机 smoke 后，可以在 GitHub UI 里发布；
如果要直接发布，运行：

```bash
npm run release:windows-exe -- 1.0.1 --no-draft
```

上传 release 包默认要求 git worktree 干净，避免 release tag 指向的源码版本和
zip 内版本不一致。只做 draft/test 上传且已经确认可以接受本地未提交状态时，
可显式加 `--allow-dirty`。

只同步版本号但不发布：

```bash
npm run version:set -- 1.0.1
npm run version:sync -- --check
```

## 用户运行流程

1. 解压 `smartperfetto-v1.0.1-windows-x64.zip` 到普通本地目录，例如 `C:\SmartPerfetto`。
2. 双击 `SmartPerfetto.exe`。
3. 浏览器通常会自动打开；如果没有，手动打开 [http://localhost:10000](http://localhost:10000)。
4. AI 分析需要在 UI 里配置 Provider profile，或复制 `backend\.env.example` 为 `backend\.env` 并填写一个 provider block，然后重启 `SmartPerfetto.exe`。
5. 使用时保持启动器窗口打开；按 `Ctrl+C` 会停止后端、前端和 trace processor 子进程。

## 验证

跨平台构建机能验证包结构、后端 typecheck/build 和依赖完整性，但不能执行
Windows 原生 smoke。发布前应在真实 Windows x64 机器上做一次最小验证：

```powershell
Expand-Archive .\smartperfetto-v1.0.1-windows-x64.zip -DestinationPath C:\SmartPerfettoSmoke
C:\SmartPerfettoSmoke\smartperfetto-v1.0.1-windows-x64\SmartPerfetto.exe
```

然后检查：

- [http://localhost:10000](http://localhost:10000) 能打开 Perfetto UI。
- [http://localhost:3000/health](http://localhost:3000/health) 返回 `status: "OK"`。
- 上传一条小 trace 后，后端日志里能看到 `trace_processor_shell.exe` 启动。

## 限制

- 当前只产出 Windows x64 包。
- 这是解压即用目录，不是单文件 portable exe；不要只分发 `SmartPerfetto.exe` 一个文件。
- 当前脚本不做代码签名。公开发布前如需要降低 Windows SmartScreen 干扰，应在 zip 生成后追加签名流程。
