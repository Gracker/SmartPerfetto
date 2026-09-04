<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2024-2026 Gracker (Chris)
This file is part of SmartPerfetto. See LICENSE for details.
-->

# 免安装包打包

[English](portable-packaging.en.md) | [中文](portable-packaging.md)

<!-- i18n-headings: paired -->

SmartPerfetto 的免安装包不是单文件二进制。启动器负责拉起包内 Node.js 24
runtime、后端、预构建 Perfetto UI、固定版本 `trace_processor_shell` 和签名的
Android Internals Knowledge Pack。

当前维护的 release asset：

- `smartperfetto-v<version>-windows-x64.zip`（Windows 10 / Windows Server 2016
  或以上 x64）
- `smartperfetto-v<version>-macos-arm64.zip`（macOS 13.5 或以上 Apple
  silicon 设备）
- `smartperfetto-v<version>-linux-x64.tar.gz`（glibc 2.34 或以上 x64
  Linux；不支持 Alpine Linux 等基于 musl 的发行版）

## 打包

```bash
npm run package:portable
```

单平台：

```bash
npm run package:windows-exe
npm run package:macos-app
npm run package:linux
```

输出：

```text
dist/portable/smartperfetto-v<version>-windows-x64.zip
dist/portable/smartperfetto-v<version>-macos-arm64.zip
dist/portable/smartperfetto-v<version>-linux-x64.tar.gz
```

兼容 Windows 旧命令仍输出到：

```text
dist/windows-exe/smartperfetto-v<version>-windows-x64.zip
```

## 发布

完整公开发布顺序见 [发布手册](release.md)。免安装包发布通常在 npm CLI
发布和 smoke 通过后执行。

正常公开发布中的 portable 步骤：

```bash
npm run version:set -- <version>
npm run version:sync -- --check
git add package.json package-lock.json backend/package.json backend/package-lock.json
git commit -m "chore: release v<version>"
git push origin main
npm --prefix backend run cli:pack-check
cd backend
npm publish --access public
cd ..
npm run package:portable
# 以下命令分别在归档匹配的 Windows x64、macOS arm64、Linux x64 上运行
node scripts/smoke-portable-archive.cjs --asset <final-archive> --target <target> \
  --version <version> --commit <commit> --public-release \
  --output-dir dist/portable/smoke-evidence/<target>
# 没有目标机器时，从默认分支对现有 draft 运行：
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
```

`package:portable` 会从 `scripts/node-runtime-pin.env` 读取明确的 Node.js
版本、三平台归档 SHA-256 和可执行内容摘要，而不是在构建时动态选择最新版本。
macOS 内容摘要只归一化受代码签名影响的 Mach-O 字段，因此 Developer ID
重新签名不能掩盖可执行内容变化；更新 Node runtime 必须评审并同步这些 pin。
脚本会构建三平台包并校验 schema v3 manifest，其中包含
distribution、channel、target、commit 和 signing mode。`traceProcessor`
同时记录上游固定文件的 `sourceSha256` 与签名后归档字节的 `sha256`，避免把
供应链来源校验和最终产物校验混为一谈。`release:portable --skip-build`
只复用刚刚为同一版本、同一 commit 构建出的包。公开 promotion 会逐 target
验证 smoke summary 的原生 host、归档文件名、size、SHA256、commit、health、
runtime probe 和生命周期收据；任一证据缺失或与待上传字节不一致都会停止发布。
每次 smoke 的 `--output-dir` 必须是尚不存在的新路径；成功只会原子写入
`smoke-summary.json`，失败另写 `smoke-failure.json`，因此重跑要换新目录，不能覆盖
先前证据。

hosted workflow 只接受包含当前 schema-v2 lifecycle smoke contract 的 release
commit，并按不可变 release ID/asset ID 下载。下载后和 smoke 后都会重新读取 GitHub
release；release commit 自带 verifier 和默认分支固定 SHA 的 verifier 会各验证一次。
`windows-linux` 或单平台 selection 只生成 partial 诊断证据，不能用于公开发布；
只有 `selection=all` 成功且 macOS 是 Developer ID 签名、公证、staple 后的 final zip，
combined artifact 中的 `promotion-evidence/` 才可能用于 promotion。必须按成功的
run ID 下载整个 combined artifact，并把其中的 `promotion-evidence/`、同级
`portable-smoke-attestation.json` 和该 run ID 一起传给发布命令；发布脚本会重新读取
Actions run/唯一 combined artifact，并用 GitHub artifact SHA-256 校验下载的 zip，
再逐字节绑定本地证据，不能手工拼接单个 job artifact。

发布脚本始终先创建或复用 draft，上传后逐项校验 target commit、标题、asset
名称、大小和 GitHub `sha256:` digest。`--no-draft` 是严格的 promotion-only 路径：
draft 和三份 asset 必须已经存在；它不会创建 release、编辑标题/target、上传或
`--clobber` asset，只会在发布前后比较 release ID 以及每个 asset 的 ID、状态、
名称、大小和 digest，然后改变 draft 标志。
如果 smoke/promotion gate 在 draft 构建后又有加固提交，可从更新后的 clean gate
checkout 运行，并增加 `--release-commit <draft-target-full-sha>`；脚本只接受 gate
commit 的祖先，包、证据和远端 target 仍全部绑定该 release SHA。
`--no-draft` 必须同时提供默认三个平台，不允许发布部分平台集合。已公开 release
是只读的：脚本只验证完整三平台集合，完全一致时幂等退出，不会 clobber、编辑或
替换任何 asset。没有刚构建过同版本同 commit 包时，不要使用 `--skip-build`。

仅构建/上传某个平台的 draft 候选（不能单独 promotion）：

```bash
npm run release:portable -- <version> --targets macos-arm64
npm run release:windows-exe -- <version>
```

公开发布不要使用 `--allow-dirty`。如果 npm 发布后发现大 bug，修复后必须发布
新的 patch 版本，不要复用已经发布到 npm 的旧版本号。

## macOS 签名和公证

未设置签名变量时，脚本会生成 ad-hoc signed app，避免 macOS 把 bundle 判定为
damaged；但 ad-hoc 签名不会通过 Gatekeeper 公证检查，只适合本地测试或需要用户
手动 Control-click → Open 的 draft 包。正式公开 macOS 包必须设置：

```bash
export SMARTPERFETTO_MACOS_SIGN_IDENTITY="Developer ID Application: ..."
export SMARTPERFETTO_MACOS_NOTARY_PROFILE="notarytool-keychain-profile"
npm run release:portable -- <version> --targets macos-arm64
```

设置签名身份后脚本会 `codesign --options runtime` 并做 strict verify；设置 notary
profile 后会通过 `xcrun notarytool submit --wait` 提交，并对 `.app` staple 后重新
生成 final zip。打包器还会用 `notarytool info` 复核同一 submission 为 `Accepted`，
并只把精简的 `NOTARIZATION-RECEIPT.json` 放入 final zip。notary profile 是保存在
本机钥匙串里的 `notarytool` 凭据别名，不是 provisioning profile；API 私钥不得
进入仓库或发布日志。

打包器按 Mach-O 文件头而不是扩展名/可执行位发现嵌套原生二进制并逐个签名。
重签已有上游签名的 Node/Claude runtime 时只保留原有 identifier 和 entitlements；
不能给任意未签 Mach-O 注入 JIT entitlement，也不能用 `codesign --force --deep`
代替 inside-out 签名。final zip 校验器会逐个验证 Mach-O 签名和 Node/Claude
必需的 runtime entitlement。

## 用户数据目录

Windows 用户操作以 [Windows 配置与运行指南](../getting-started/windows.md) 为准；
本节只定义打包与运维路径契约。

- Windows：仅当 `D:` 是本地固定磁盘且 `D:\SmartPerfettoData` 可写时，启动器才把它
  作为首选 data root；否则回退到 `%LOCALAPPDATA%\SmartPerfetto`。启动器打印的
  `Data directory` 是最终结果。该 root 直接包含 `backend/`、`providers/`、`uploads/`、
  `user/`、`logs/` 和 `env`，没有额外的 `data/` 层。
- macOS：`~/Library/Application Support/SmartPerfetto` 和 `~/Library/Logs/SmartPerfetto`。
- Linux：`${XDG_DATA_HOME:-~/.local/share}/smartperfetto` 和
  `${XDG_STATE_HOME:-~/.local/state}/smartperfetto/logs`。

AI 分析推荐在 UI 里配置 Provider profile。需要 env 凭证时，在对应用户数据目录
创建 `env` 文件后重启启动器。

便携包启动时会将可写的上传目录通过 `UPLOAD_DIR` 传给后端，并在用户数据根目录下
创建 `uploads/`。不要依赖包内的 `backend/uploads`；这可以避免 App 位于 macOS
`AppTranslocation` 临时路径或应用包不可写时，后端因上传目录不存在而无法通过 readiness
检查。若从下载目录启动出现 `AppTranslocation`，请将 App 移到 `/Applications` 后再打开；
可信的未公证包也可以移除隔离属性：

```bash
xattr -dr com.apple.quarantine /Applications/SmartPerfetto.app
```

Windows 新包选择 D 盘默认目录时，如果 `%LOCALAPPDATA%\SmartPerfetto` 非空而 D 盘
目标不存在或为空，会把 C 盘数据安全复制到 staging，写入迁移回执后原子切换；C 盘
原目录保持不变。D 盘目标非空时不合并、不覆盖。复制或激活失败会清理 staging、打印
警告并继续使用安全的 C 盘目录。

启动器还会自动发现符合版本目录命名的旧包，并用同一链路安全复制 package-local
`data/`。复制过程拒绝 symlink、reparse point 和非普通文件。无法自动发现时使用：

```powershell
SmartPerfetto.exe --migrate-from "C:\path\to\old-package"
```

显式迁移应在第一次标准启动、当前选中的目标目录不存在时运行。目标已存在时命令会报错，
不会合并或覆盖，来源和目标均保留。自动 sibling 发现只选择严格低于当前包版本的
最高版本；无法解析当前包版本时保守跳过。

需要真正随包移动的数据时，显式设置 `SMARTPERFETTO_PORTABLE_MODE=1`；该模式继续
使用包内 `data/` / `logs/` 并禁用自动和显式迁移。需要测试或运维覆盖整个 portable
data root 时使用 `SMARTPERFETTO_PORTABLE_DATA_DIR`；它同样禁用迁移。Launcher 会从
该 root 派生 backend、Provider、uploads 和 user 路径；不要用
`SMARTPERFETTO_BACKEND_DATA_DIR` 代替 portable root。该覆盖必须在启动 launcher 前
进入进程环境；data root 内的 `env` 文件在路径确定后才加载，不能用来选择 root。

## 验证

脚本会校验包结构、版本、manifest、Node runtime、目标平台 native 依赖、
`trace_processor_shell` pin，以及 Knowledge Pack lock/manifest/database/license
的版本和哈希。交叉编译、结构和静态签名校验不证明目标系统能启动。公开发布采用
build-once：在各目标平台解压即将上传的同一份最终归档做 smoke，通过后不再重新
构建；macOS 必须测试公证、staple 后重新生成的 final zip。当前兼容下限是 Windows
10 / Windows Server 2016 及以上 x64、macOS arm64 13.5+ 和 Linux x64 glibc
2.34+；static verifier 会扫描包内全部 Mach-O/ELF，拒绝任何高于 manifest/
Info.plist 声明的原生依赖。

在归档声明的匹配 OS/arch 上运行统一 smoke 命令：

```bash
node scripts/smoke-portable-archive.cjs \
  --asset "<final-archive>" \
  --target "<windows-x64|macos-arm64|linux-x64>" \
  --version "<version>" \
  --commit "<release-commit>" \
  --public-release \
  --output-dir "<evidence-dir>"
```

仅在提交前本机验证未提交代码时，可显式添加 `--allow-dirty`；它不能与
`--public-release` 组合，生成的结果也不能用于 promotion。公开发布仍必须从 exact
clean commit 重新 build once 并 smoke。

该命令先执行安全的归档路径/link 校验和 static verifier，再从同一归档启动 launcher。
它使用隔离数据和日志目录、显式 `127.0.0.1` health、包内 Node/Claude/OpenCode 与
最小 trace processor 查询，并通过 launcher 的 `--shutdown-file` 进行可审计的优雅
退出。`--lifecycle-receipt` 记录进程隔离方式、子进程 PID、退出码、是否强制升级和
端口释放；Windows 必须建立 kill-on-close Job Object，macOS/Linux 服务使用独立
进程组。失败时保留 launcher/backend/frontend 日志。它会拒绝在与 `--target`
不匹配的宿主上运行。
Windows smoke 还会实际加载 `better-sqlite3` 与 `sodium-native`，运行本地 Provider
Create/Activate/Get/Cleanup 生命周期，并用包内后端代码验证 DPAPI SecretStore 的
put/get/reopen；这些是默认 Provider 路径与 enterprise SecretStore 的两条独立证据。
`--public-release` 生成公开发布证据，并在 macOS 上额外验证 Developer ID、Gatekeeper、
notarization staple 与 `Accepted` notary receipt；仅验证草稿包时可以省略该参数。

包内 launcher 优先使用后端端口 `3000`、前端端口 `10000`。如果默认端口已被占用，
launcher 会自动选择下一个可用端口，并打印实际访问 URL。只有需要固定端口时才设置
`SMARTPERFETTO_BACKEND_PORT` 或 `SMARTPERFETTO_FRONTEND_PORT`；显式配置的端口不可用时会快速失败。

1. 启动包内 launcher。
2. 打开 launcher 打印的前端 URL，通常是 [http://127.0.0.1:10000](http://127.0.0.1:10000)。
3. 检查 launcher 打印的后端 health URL，通常是 [http://127.0.0.1:3000/health](http://127.0.0.1:3000/health)。
4. 上传一条小 trace，确认后端日志中启动了对应平台的 `trace_processor_shell`。
5. 在包内 CLI 或后端运行 `smp knowledge-pack status --format json`，确认 bundled/active Pack 可解析且未撤回。
6. 执行包内 Node、Claude 和 OpenCode 的版本命令（存在时）。
7. 正常停止 launcher，确认子进程退出且前后端端口已经释放。

Windows、macOS 或 Linux 任一最终归档缺少目标平台 smoke 时，GitHub release 应保持
draft。只有用户明确接受并在 release/交付说明中公开未测试平台时才允许降级发布，
且不能称为全平台验证完成。
