<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2024-2026 Gracker (Chris)
This file is part of SmartPerfetto. See LICENSE for details.
-->

# 免安装包打包

[English](portable-packaging.en.md) | [中文](portable-packaging.md)

SmartPerfetto 的免安装包不是单文件二进制。启动器负责拉起包内 Node.js 24
runtime、后端、预构建 Perfetto UI、固定版本 `trace_processor_shell` 和签名的
Android Internals Knowledge Pack。

当前维护的 release asset：

- `smartperfetto-v<version>-windows-x64.zip`
- `smartperfetto-v<version>-macos-arm64.zip`
- `smartperfetto-v<version>-linux-x64.tar.gz`

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
npm run release:portable -- <version> --skip-build --no-draft
```

`package:portable` 会构建三平台包并校验 schema v2 manifest，其中包含
distribution、channel、target、commit 和 signing mode。`release:portable
--skip-build` 只复用刚刚为同一版本、同一 commit 构建出的包。

发布脚本始终先创建或复用 draft，上传后逐项校验 target commit、标题、asset
名称、大小和 GitHub `sha256:` digest，再把 draft 转为公开 release。
`--no-draft` 必须同时提供默认三个平台，不允许发布部分平台集合。已公开 release
是只读的：脚本只验证完整三平台集合，完全一致时幂等退出，不会 clobber、编辑或
替换任何 asset。没有刚构建过同版本同 commit 包时，不要使用 `--skip-build`。

仅发布某个平台：

```bash
npm run release:portable -- <version> --targets macos-arm64
npm run release:windows-exe -- <version>
```

公开发布不要使用 `--allow-dirty`。如果 npm 发布后发现大 bug，修复后必须发布
新的 patch 版本，不要复用已经发布到 npm 的旧版本号。

## macOS 签名和公证

未设置签名变量时，脚本会生成 ad-hoc signed app，避免 macOS 把 bundle 判定为
damaged；但 ad-hoc 签名不会通过 Gatekeeper 公证检查，只适合本地测试或需要用户
手动 Control-click → Open 的包。正式 macOS 包建议设置：

```bash
export SMARTPERFETTO_MACOS_SIGN_IDENTITY="Developer ID Application: ..."
export SMARTPERFETTO_MACOS_NOTARY_PROFILE="notarytool-keychain-profile"
npm run release:portable -- <version> --targets macos-arm64
```

设置签名身份后脚本会 `codesign --options runtime` 并做 strict verify；设置 notary
profile 后会通过 `xcrun notarytool submit --wait` 提交，并对 `.app` staple 后重新
生成 zip。

## 用户数据目录

- Windows：`%LOCALAPPDATA%\SmartPerfetto` 下的 `data/` 和 `logs/`。
- macOS：`~/Library/Application Support/SmartPerfetto` 和 `~/Library/Logs/SmartPerfetto`。
- Linux：`${XDG_DATA_HOME:-~/.local/share}/smartperfetto` 和
  `${XDG_STATE_HOME:-~/.local/state}/smartperfetto/logs`。

AI 分析推荐在 UI 里配置 Provider profile。需要 env 凭证时，在对应用户数据目录
创建 `env` 文件后重启启动器。

Windows 新包首次启动时，会自动发现符合版本目录命名的旧包，安全复制旧包的
package-local `data/` 到 `%LOCALAPPDATA%\SmartPerfetto`，写入迁移回执后原子切换；
旧目录保持不变。复制过程拒绝 symlink、reparse point 和非普通文件。无法自动
发现时使用：

```powershell
SmartPerfetto.exe --migrate-from C:\path\to\old-package
```

需要真正随包移动的数据时，显式设置 `SMARTPERFETTO_PORTABLE_MODE=1`；该模式继续
使用包内 `data/` / `logs/` 并禁用自动迁移。显式
`SMARTPERFETTO_BACKEND_DATA_DIR` 同样优先于默认目录并禁用自动迁移。

## 验证

脚本会校验包结构、版本、manifest、Node runtime、目标平台 native 依赖、
`trace_processor_shell` pin，以及 Knowledge Pack lock/manifest/database/license
的版本和哈希。真实发布前仍需要在目标平台做最小 smoke：

包内 launcher 优先使用后端端口 `3000`、前端端口 `10000`。如果默认端口已被占用，
launcher 会自动选择下一个可用端口，并打印实际访问 URL。只有需要固定端口时才设置
`SMARTPERFETTO_BACKEND_PORT` 或 `SMARTPERFETTO_FRONTEND_PORT`；显式配置的端口不可用时会快速失败。

1. 启动包内 launcher。
2. 打开 launcher 打印的前端 URL，通常是 [http://127.0.0.1:10000](http://127.0.0.1:10000)。
3. 检查 launcher 打印的后端 health URL，通常是 [http://127.0.0.1:3000/health](http://127.0.0.1:3000/health)。
4. 上传一条小 trace，确认后端日志中启动了对应平台的 `trace_processor_shell`。
5. 在包内 CLI 或后端运行 `smp knowledge-pack status --format json`，确认 bundled/active Pack 可解析且未撤回。
