<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2024-2026 Gracker (Chris)
This file is part of SmartPerfetto. See LICENSE for details.
-->

# 发布手册

[English](release.en.md) | [中文](release.md)

<!-- i18n-headings: paired -->

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

在公开 release 前预检 npm CLI；这里不接触发布凭证：

```bash
npm --prefix backend run cli:pack-check
npm --prefix backend run cli:e2e
```

正常 npm 发布由 `.github/workflows/npm-publish.yml` 的 OIDC Trusted Publisher
完成，不使用 `NPM_TOKEN`。workflow 会从精确 release tag 重跑版本、pack 和 CLI
门禁，在无 OIDC 的 job 中构建 tarball，再由独立发布 job 只消费哈希绑定的 tarball。

发布 GitHub 免安装包：

```bash
npm run package:portable
# 在每个匹配目标系统运行；macOS 的 asset 必须是公证并 staple 后的 final zip
node scripts/smoke-portable-archive.cjs \
  --asset "<final-archive>" \
  --target "<windows-x64|macos-arm64|linux-x64>" \
  --version "<version>" \
  --commit "<release-commit>" \
  --public-release \
  --output-dir "dist/portable/smoke-evidence/<target>"
# 没有目标机器时，从默认分支对现有 draft 运行；只有 all 可作为 promotion 候选：
gh workflow run portable-exact-archive-smoke.yml \
  -f release_id=<numeric-release-id> -f selection=all
gh run download <run-id> \
  --name portable-smoke-evidence-release-<numeric-release-id> \
  --dir <download-dir>
npm run release:portable -- <version> --skip-build --no-draft \
  --release-commit <draft-target-full-sha> \
  --smoke-evidence-dir <download-dir>/promotion-evidence \
  --smoke-attestation <download-dir>/portable-smoke-attestation.json \
  --smoke-run-id <run-id>
gh release view v<version> --json tagName,isDraft,assets
```

GitHub Release 公开后会自动触发 npm Trusted Publishing。等待 workflow 并验证
registry；如果 release event 未送达，可从默认分支按同一公开 release ID 幂等恢复：

```bash
gh run list --workflow npm-publish.yml --limit 5
gh run watch <run-id> --exit-status
# recovery only
gh workflow run npm-publish.yml --ref main -f release_id=<numeric-release-id>
npm view @gracker/smartperfetto@<version> version dist.integrity --json
```

workflow 只接受 public、非 prerelease、完整 target SHA 的稳定 SemVer release；tag、
target、四个版本字段和 `main` 祖先关系必须一致。已有版本只有 registry
`dist.integrity` 与本次 tarball 完全一致时才会幂等跳过。最后在空目录、Node.js 24
下做无凭证真实安装 smoke：

```bash
npm install @gracker/smartperfetto@<version>
./node_modules/.bin/smp --version
./node_modules/.bin/smartperfetto --help
./node_modules/.bin/smp doctor --format json
./node_modules/.bin/smp knowledge-pack status --format json
```

本地 `npm publish` 只作应急回退；它会要求 WebAuthn。必须从 `backend/` 执行
`npm publish --access public`，不能从根目录通过 `--prefix` 形式调用 publish，
否则可能误命中 private 根包。

免安装包必须 build once：测试并上传同一份最终归档字节，通过 smoke 后不得重新构建。
交叉编译、manifest/结构检查和静态签名校验不等于目标系统真实启动。Windows、macOS
和 Linux 都要验证 `127.0.0.1` 前后端 health、包内 runtime、最小 trace processor
操作、优雅退出和端口释放。缺少目标 runner 时保持 draft；如果用户明确接受缺口，
必须在 release/交付说明里写明未测试平台，不能称为全平台验证完成。
每个目标的 schema-v2 smoke summary 还会绑定最终归档的名称、字节数和 SHA-256；
公开前会重新计算归档哈希，旧证据或被替换的产物不能通过。
`--output-dir` 必须指向尚不存在的新目录；成功摘要原子写入，失败使用独立
`smoke-failure.json`，重跑不得覆盖既有发布证据。

hosted workflow 会按 release ID 和 asset ID 下载 exact bytes，在下载后和 smoke
后重新核对 release，并由 release commit 与默认分支固定 SHA 的 verifier 双重验证。
`windows-linux`/单平台运行明确是 partial；只有包含已签名、公证、staple 的 macOS
final zip 的 `all` 运行才可能成为 promotion 证据。必须按成功 run ID 下载整个
combined artifact，并将其中的 `promotion-evidence/`、同级 attestation 和 run ID
一起交给 promotion；脚本会校验真实 Actions run 和 GitHub artifact digest，不能
手工拼接单 job 证据。

`release:portable` 始终 draft-first：先上传并验证 target commit、标题和三平台
asset 的名称、大小、GitHub digest。`--no-draft` 只允许提升现有 draft，不会创建
release、修改标题/target、上传或 clobber asset；它在改变 draft 标志前后逐项比较
release ID 和 asset ID/状态/名称/大小/digest。公开 release
和 asset 不可变；重复执行只做严格只读验证，一致则幂等成功，不一致则失败。
如果 gate 代码比 draft bytes 更新，增加
`--release-commit <draft-target-full-sha>`；只接受当前 gate commit 的祖先。

最后确认没有把生成产物提交进仓库：

```bash
git status --short --branch
```

## 必须保持的发布不变量

- 根目录 `package.json` 是版本源；`npm run version:set -- <version>` 必须同步四个版本文件。
- npm 包名是 `@gracker/smartperfetto`，必须同时提供 `smp` 和 `smartperfetto` 两个 bin。
- npmjs.com 的 Trusted Publisher 必须精确绑定 `Gracker/SmartPerfetto` 和
  `npm-publish.yml`；只有 publish job 拥有 `id-token: write`，且该 job 不 checkout
  或执行 release 源码。
- `workflow_dispatch` 仅用于默认分支恢复，输入 numeric public release ID；公开版本
  的幂等 skip 必须校验 registry `dist.integrity`，不能只比较版本号。
- npm 已发布版本不可变；如果发现包内容或运行时 bug，修复后发布下一个 patch 版本。
- 公开 portable release 不允许 `--allow-dirty`。
- `--skip-build` 只能用于刚刚在同一版本、同一 commit 上构建出的包。
- `--no-draft` 只能发布默认三个平台的完整集合；不能公开单平台或部分平台集合。
- `--no-draft` 必须复用已经完成 exact-asset smoke 的现有 draft，不能上传或替换资产。
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
