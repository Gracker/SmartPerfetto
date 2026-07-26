<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2024-2026 Gracker (Chris)
This file is part of SmartPerfetto. See LICENSE for details.
-->

# 发布手册

[English](release.en.md) | [中文](release.md)

本文是维护者发布 SmartPerfetto 的用户可读手册。LLM/Agent 执行发布前还必须先读
根目录的 [AGENTS.md](../../AGENTS.md)、[`.claude/rules/release.md`](../../.claude/rules/release.md)、
[`.claude/rules/product-surface.md`](../../.claude/rules/product-surface.md)、
[`.claude/rules/git.md`](../../.claude/rules/git.md) 和
[`.claude/rules/testing.md`](../../.claude/rules/testing.md)。

## 发布形态

| 形态 | 产物 | 用户入口 | 关键边界 |
|---|---|---|---|
| npm CLI | `@gracker/smartperfetto` | `smp` / `smartperfetto` | 需要用户本机 Node.js `>=24 <25`；包含 Skills/Strategies/SQL/trace processor/签名 Knowledge Pack，不包含 Web UI launcher |
| GitHub 免安装包 | `smartperfetto-v<version>-windows-x64.zip`、`smartperfetto-v<version>-macos-arm64.zip`、`smartperfetto-v<version>-linux-x64.tar.gz` | 包内 launcher | 自带 Node.js 24、原生依赖、预构建 `frontend/`、固定 `trace_processor_shell` 和签名 Knowledge Pack |
| Docker Hub | workflow 从 `main` 构建的 Linux 镜像 | `docker compose -f docker-compose.hub.yml up -d` | 不读取宿主机 Claude Code 登录态 |
| 源码 checkout | Git 仓库 | `./start.sh` | 普通使用读提交的 `frontend/`；只改 UI 插件时才需要 `perfetto/` submodule |

## 正常公开发布

从干净、最新的 `main` 开始。先确认现有 npm 版本和 GitHub release 状态：

```bash
git status --short --branch
git fetch --tags origin
npm view @gracker/smartperfetto version --json
```

同步版本并提交：

```bash
npm run version:set -- <version>
npm run version:sync -- --check
git add package.json package-lock.json backend/package.json backend/package-lock.json
git commit -m "chore: release v<version>"
git push origin main
```

发布 npm CLI：

```bash
npm whoami
npm --prefix backend run cli:pack-check
cd backend
npm publish --access public
cd ..
npm view @gracker/smartperfetto version --json
```

npm 发布成功后，在空目录做真实安装 smoke：

```bash
npm install @gracker/smartperfetto@<version>
./node_modules/.bin/smp --version
./node_modules/.bin/smartperfetto --help
./node_modules/.bin/smp doctor --format json
./node_modules/.bin/smp knowledge-pack status --format json
```

发布 GitHub 免安装包：

```bash
npm run package:portable
# 在目标系统解压并 smoke 这三份最终归档；macOS 使用公证并 staple 后的 final zip
npm run release:portable -- <version> --skip-build --no-draft
gh release view v<version> --json tagName,isDraft,assets
```

免安装包必须 build once：测试并上传同一份最终归档字节，通过 smoke 后不得重新构建。
交叉编译、manifest/结构检查和静态签名校验不等于目标系统真实启动。Windows、macOS
和 Linux 都要验证 `127.0.0.1` 前后端 health、包内 runtime、最小 trace processor
操作、优雅退出和端口释放。缺少目标 runner 时保持 draft；如果用户明确接受缺口，
必须在 release/交付说明里写明未测试平台，不能称为全平台验证完成。

`release:portable` 始终 draft-first：先上传并验证 target commit、标题和三平台
asset 的名称、大小、GitHub digest，全部成立后 `--no-draft` 才公开。公开 release
和 asset 不可变；重复执行只做严格只读验证，一致则幂等成功，不一致则失败。

最后确认没有把生成产物提交进仓库：

```bash
git status --short --branch
```

## 必须保持的发布不变量

- 根目录 `package.json` 是版本源；`npm run version:set -- <version>` 必须同步四个版本文件。
- npm 包名是 `@gracker/smartperfetto`，必须同时提供 `smp` 和 `smartperfetto` 两个 bin。
- npm 已发布版本不可变；如果发现包内容或运行时 bug，修复后发布下一个 patch 版本。
- 公开 portable release 不允许 `--allow-dirty`。
- `--skip-build` 只能用于刚刚在同一版本、同一 commit 上构建出的包。
- `--no-draft` 只能发布默认三个平台的完整集合；不能公开单平台或部分平台集合。
- 公开 macOS 包必须使用 Developer ID、Hardened Runtime、Apple 公证和 stapled
  ticket；ad-hoc 仅用于本地或 draft 测试。
- 已公开 GitHub release 只读且 asset 集合不可变；不得 clobber、替换或改写。
- `dist/portable/`、`dist/windows-exe/`、`.cache/smartperfetto-portable/` 都是生成产物，不进 git。
- `frontend/` 是 Docker、`./start.sh` 和免安装包的用户路径依赖；AI Assistant 插件 UI 变更必须运行 `./scripts/update-frontend.sh`。
- 如果 root commit 指向 `perfetto/` submodule 新提交，该 submodule commit 必须已经 push 到 Gracker fork。
- 不提交、不记录、不回显 npm token、provider key 或 GitHub token。

## 发布后验证

- npm：`npm view @gracker/smartperfetto version --json` 等于新版本；空目录安装后 `smp doctor --format json` 和 `smp knowledge-pack status --format json` 可运行。
- GitHub：`gh release view v<version>` 返回非 draft release；三个平台 asset 的
  名称、大小、target commit 和远端 `sha256:` digest 与本地已 smoke 归档一致。
- Docker：稳定版 tag 同时存在 immutable SemVer 和 `latest`；`nightly` 只由
  `main` 的 schedule/manual workflow 更新，稳定用户不会默认跟随 nightly。
- 文档：README、CLI、portable、release 文档里的安装命令、版本边界和用户入口与真实产物一致。
- 如果发布后发现大 bug：停止推广旧版本，修复、补测试、发布新的 patch 版本，并在 release notes 中说明 supersede 关系。
