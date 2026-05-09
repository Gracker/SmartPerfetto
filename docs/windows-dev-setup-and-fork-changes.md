# Windows 编译环境搭建与本仓库改动说明

本文汇总 **SmartPerfetto 在 Windows 上原生开发** 的环境要求、推荐启动方式，以及相对上游 **Perfetto 子模块** 与 **脚本层** 的主要改动，便于新成员搭环境与合并上游时对照。

更长的排障表仍见：[build-windows.md](./build-windows.md)。

---

## 一、环境要求（摘要）

| 组件 | 要求 |
|------|------|
| **OS** | Windows 10/11 x64 |
| **Node.js** | 18+，在 PATH 中（`node` / `npm`） |
| **Python** | **64 位** 3.10+；建议可用 `py -3-64`。勿用 32 位 Python 跑 gn/MSVC 相关脚本。 |
| **Git** | 已执行 `git submodule update --init --recursive`，`perfetto/` 完整 |
| **Visual Studio 2022** | **使用 C++ 的桌面开发** + **Windows 10/11 SDK**（`better-sqlite3` / `node-gyp` 回退编译时需要） |
| **网络** | 可访问 npm、GCS（typefaces 等）、部分步骤需 git clone（emsdk、install-build-deps 等） |

可选：`winget` 安装 VS Build Tools 可参考仓库内 `scripts/install-vs-build-tools.ps1`。

---

## 二、一次性初始化

1. 克隆（**勿用** GitHub ZIP，否则子模块无 `.git`）：
   ```bat
   git clone --recurse-submodules <repo-url>
   cd SmartPerfetto
   ```
2. 配置后端环境变量：复制 `backend\.env.example` → `backend\.env`，填写 API Key 等。
3. 安装后端依赖（需 C++ 环境时先装好 VS）：
   ```bat
   cd backend
   npm install
   ```
   或根目录：`npm run install:backend:win`（失败时会尝试 `complete-backend-native-win.ps1`）。

---

## 三、日常启动与停止

| 场景 | 命令 |
|------|------|
| **完整构建 + 启动**（首次或改 WASM/GN） | `npm run dev:win` 或 `powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-dev.ps1` |
| **仅启动**（需已有 `backend\dist` 与 `perfetto\out\ui` 产物） | `.\scripts\start-dev.ps1 -Quick` |
| **BAT 快捷方式** | `scripts\start-dev.bat`（**默认带 `-Quick`**；全量请直接调 `start-dev.ps1` 且不要 `-Quick`） |
| **停止** | `scripts\stop-dev.bat`（纯 **cmd**：`for /f` 读 PID + `netstat`/`taskkill` 清端口；**不**用 PowerShell 读 PID 文件，避免组策略 **Constrained Language** 下禁止 `[System.IO.File]::ReadAllText` 等 .NET 调用） |

日志目录：`logs\backend_*.log`、`logs\frontend_*.log`，并会复制为 `backend_latest.log` / `frontend_latest.log`。

**PID 文件**：`start-dev.ps1` 在仓库根写入 **UTF-8 无 BOM** 的 `.backend.pid`、`.frontend.pid`（内容为 `cmd.exe` / `wsl.exe` 包装进程 PID），供 `stop-dev.bat` 使用。

---

## 四、`start-dev.ps1` 行为要点（Windows）

- **端口**：启动前对 **3000 / 10000** 做监听进程清理；结束时尝试结束 `trace_processor_shell.exe`。
- **PATH**：合并 Machine/User `Path`；在 `%TEMP%` 生成 `python3.cmd` 转发到 `py -3-64`，供 `ui/build.js` 子进程使用。
- **Perfetto UI 依赖**：在 `perfetto\ui` 用 `npx pnpm@8` 安装，**不**跑上游 `install-build-deps --ui`（Windows 上会报 unsupported）。
- **Host buildtools**：`Install-PerfettoHostBuildtoolsWin` 对 `tools/install-build-deps` 使用 `--filter` 批量拉 protobuf/abseil/zlib/sqlite 等；失败时按关键文件校验决定是否继续。
- **gn / ninja / emsdk**：`fetch-perfetto-gn-ninja-win.ps1`、`bootstrap-perfetto-emsdk-win.ps1`；`out\ui` 下 **buildtools junction** 修复 wasm ninja 相对路径问题。
- **前端构建**：本机 Node 调 `perfetto\ui\build.js --no-depscheck`；可选 `-ForceGnClean`、`-CleanUiOut`、`-WslUi`。
- **Quick + 本机前端 watch**：对 `build.js` 追加 **`--no-build`**，在已有 `dist` 时跳过 watch 进程内首轮全量构建，加快 `:10000` 就绪（该进程内不做 TS/rollup 热编；改 UI 需全量 dev 或不用 Quick）。

---

## 五、Perfetto 子模块内改动（相对上游）

以下路径均相对于 **`perfetto/`** 子模块根目录。合并上游 Perfetto 时建议重点做三方 diff。

### 5.1 `ui/build.js`

- **GN / Ninja（Windows）**：`tools/gn`、`tools/ninja` 通过 **`py -3-64`** 调用；`ninja` 增加 **`-d nostatcache`**，缓解 Windows 下 stat 缓存与相对路径导致的 “missing file”。
- **`enable_perfetto_ui=true`**：`win32` 上 `gn gen` 追加，否则缺 `traceconv_wasm` 等目标。
- **`--clean-out-ui`**：默认**不再**每次构建删除 `out/ui/ui`；仅显式传参或 `PERFETTO_UI_CLEAN_OUT_UI` 时全量清 UI 输出，缩短增量时间。
- **Node 工具链**：`execModule` 使用 **`resolveNodeBin`**（Windows 上识别 `pbjs.CMD` 等）；`pbjs`/`pbts` 回退为 **`node …/protobufjs-cli/bin/...`**，避免 `.bin` 下 Unix 桩在 Windows 上 `ENOENT`。
- **`gen_stdlib_docs_json.py`**：Windows 上通过 **`py -3-64`** 调用，避免直接执行 `.py` 报 `UNKNOWN`。
- **`scanFile`**：`path.relative` 结果 **`/` 规范化**，使 RULES 与 `ui/src/...` 正则匹配，从而生成 **`perfetto.css`**（修复 `isDistComplete` 无限等待）。
- **`fs.watch`**：递归监听时 **`filename == null`** 直接忽略，避免 `path.join` 抛错导致 watch 进程退出。
- **`parseArgs` / python**：与 Windows 下 `python3` 解析一致（与 shim 配合）。

### 5.2 `tools/gen_ui_imports`

- 生成 TS/SCSS 的 import 路径时，将 **`os.path.relpath` 的反斜杠改为正斜杠**，避免 Windows 下字符串里 `\p` 等被当作转义，导致 **`all_plugins.ts` 模块路径损坏**。

### 5.3 `gn/write_buildflag_header.py`

- 增加 **`from __future__ import annotations`**，兼容被 MSVC 规则调起的 **Python 3.8**（`list[Flag]` 等注解）。

### 5.4 `buildtools/BUILD.gn`

- **zlib**：`X86_WINDOWS` 仅在 **`is_win && !is_wasm`** 时定义，避免 WASM 交叉编译包含 `windows.h`。
- **Abseil / protobuf**：同类 Windows专用源或 MSVC 开关加 **`&& !is_wasm`**；protobuf 的 **`configs -= win32_lean_and_mean`** 仅在非 WASM 时执行，避免 GN “item not in list”。

### 5.5 `gn/standalone/BUILD.gn`、`BUILDCONFIG.gn`、`buildtools` 等

- 大量 **`is_win && !is_wasm`** 区分 **本机 MSVC** 与 **WASM 工具链**（`is_win` 在宿主 Windows 上仍为 true）。
- **hermetic clang-cl**：`win_msvc_inc_dirs` 等为 Windows 非 WASM 场景补 MSVC STL/SDK 头路径（视具体提交而定）。

### 5.6 `gn/standalone/toolchain/BUILD.gn`

- WASM 工具链使用 **`emcc.bat` / `em++.bat`** 等；可选 **`use_win_wasm_gn_include_fixup`** 在编译命令前插入 **`win_wasm_gn_argfix.py`**（将 GN 的 **`/I`** 转为 emcc 可接受的 **`-I`**）。若你本地缺少该 `.py`，需与 fork 分支保持一致或从本仓库历史恢复。

### 5.7 `gn/standalone/.emscripten`

- **Windows** 使用 **`buildtools_os = 'win64'`** 等与 emsdk 布局一致的路径；**`NODE_JS`** 解析 hermetic node 或 PATH 中的 `node`。

### 5.8 其它

- 可能还有 **`wasm_vars.gni` / `perfetto.gni`** 等与 `is_wasm` 相关的条件（以子模块内实际 diff 为准）。

---

## 六、SmartPerfetto 仓库脚本（非子模块）

| 脚本 | 作用 |
|------|------|
| `scripts/start-dev.ps1` | Windows 主入口：依赖、UI 安装、可选全量构建、起后端/前端、写 PID、等待健康检查 |
| `scripts/start-dev.bat` | 调用上述 ps1；**仅 ASCII REM**（避免 cmd 代码页把 UTF-8 注释当命令）；默认 `-Quick` |
| `scripts/stop-dev.bat` | 纯 cmd：读 PID、清端口（兼容 PowerShell 受限语言模式） |
| `scripts/stop-dev.sh` | Linux/macOS 停止逻辑 |
| `scripts/fetch-trace-processor.ps1` | 下载 `trace_processor_shell.exe` 等到 `perfetto\out\ui\` |
| `scripts/fetch-perfetto-gn-ninja-win.ps1` | Windows 下 hermetic gn/ninja |
| `scripts/fetch-perfetto-ui-buildtools.ps1` | typefaces、catapult_trace_viewer 等 |
| `scripts/bootstrap-perfetto-emsdk-win.ps1` | 本机 emsdk 安装与 `buildtools\win64\emsdk` 衔接 |
| `scripts/install-backend-win.ps1` / `complete-backend-native-win.ps1` | 后端安装与 native 回退 |
| `scripts/install-vs-build-tools.ps1` | 可选：winget 安装 VS Build Tools |
| `scripts/win-python3-shim/python3.cmd` | 可选 PATH 转发 `python3` |

根目录 **`package.json`**：`dev:win`、`dev:win:wsl`、`restart-backend:win`、`install:backend:win` 等 npm 脚本指向上述 PowerShell。

---

## 七、维护建议

1. **升级 Perfetto 子模块**后：按第五节逐项回归 **Windows 全量 UI 构建** 与 **Quick + watch**。
2. **上游合并冲突**优先出现在：`ui/build.js`、`gn/standalone/**`、`buildtools/BUILD.gn`、`tools/gen_ui_imports`。
3. 排障仍以 **`logs/frontend_*.log`** 与 **`logs/backend_*.log`** 为准；大表见 [build-windows.md](./build-windows.md)。

---

## 八、文档与规范

- 仓库级 AI/开发说明：`AGENTS.md`、`CLAUDE.md`。
- 本文件仅覆盖 **Windows 环境与 fork 差异**；产品架构与其它文档见 `docs/` 下其余 Markdown。
