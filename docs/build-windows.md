# 在 Windows 10/11 上原生构建与开发

**环境与 fork 改动总览（搭建步骤 + Perfetto 修改点）** 见：[windows-dev-setup-and-fork-changes.md](./windows-dev-setup-and-fork-changes.md)。

本页说明在 **不依赖 WSL、不依赖 Docker** 的情况下，用 **PowerShell** 与 **Node / Python / Visual Studio 构建工具** 跑通 SmartPerfetto 开发环境。流程与 `scripts/start-dev.sh` 对齐：拉取 `trace_processor_shell`、编译后端、安装并构建 Perfetto UI、启动前后端。

## 前置条件

| 工具 | 说明 |
|------|------|
| [Node.js](https://nodejs.org/) 18+ | `node` / `npm` 在 PATH 中 |
| [Python](https://www.python.org/) 3 **64 位** 3.10+ | **仅**在需要跑 `perfetto/tools/install-build-deps`（非 `--ui`）或 `node-gyp` 时使用；**本仓库在 Windows 上已用** `start-dev.ps1` 内联的 `npx pnpm@8`（或手動 `scripts/install-perfetto-ui-win.cmd`）**替代** `install-build-deps --ui`（上游在 Windows 上直接报 *Building the UI on Windows is unsupported*）。**勿用 32 位** Python 配 64 位 Node。 |
| [Git](https://git-scm.com/) | 需已 `git submodule update --init --recursive` 拉取 `perfetto/` |
| **C++ 构建环境** | **必装**（见下）：`better-sqlite3` 会优先下载预编译二进制；若本机未装 VS，且 `prebuild` 未命中，会回退到 `node-gyp` 从源码编译，此时必须 [Visual Studio 2022 Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) 并勾选 **「使用 C++ 的桌面开发」**（含 MSVC、Windows SDK）。仅装「.NET」或单组件往往不够。 |

首次在 `backend` 执行 `npm install` 时，若 `better-sqlite3` 处失败，请对照下方「`npm install` 在 better-sqlite3 失败」。

## 一次性配置

1. 克隆并初始化子模块（**不要**用 GitHub ZIP）：

   ```text
   git clone --recurse-submodules <仓库 URL>
   cd SmartPerfetto
   ```

2. 复制环境变量文件并填写 API Key（或代理）：

   ```text
   copy backend\.env.example backend\.env
   ```

3. 安装 **backend** 依赖（**先安装下文的 Visual Studio C++ 工作负载** 可显著减少错误）：

   ```text
   cd backend
   npm install
   ```

   或在项目根目录：

   ```text
   npm run install:backend:win
   ```

## 启动（推荐）

在项目根目录执行：

```text
npm run dev:win
```

等价于：

```text
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-dev.ps1
```

首次「完整构建」会：

- 将 `trace_processor_shell.exe` 下载到 `perfetto\out\ui\`（与 [get.perfetto.dev](https://get.perfetto.dev/trace_processor) 中 Windows 清单版本一致，目前脚本内为 v54.0；升级时可改 `scripts/fetch-trace-processor.ps1` 中的版本与 SHA256）
- 在 `backend` 执行 `npm run generate:frontend-types` 与 `npm run build`
- 在 `perfetto\ui` 下用 `npx pnpm@8` 安装依赖（不跑受限制的 `install-build-deps --ui`）并 `node ui\build.js`
- 在 **本机**（不启用 `-WslUi`）时：下载 `third_party` 的 `gn.exe`/`ninja.exe`；**首次**运行 **`bootstrap-perfetto-emsdk-win.ps1`**；**`Install-PerfettoHostBuildtoolsWin`** 会调用 `tools/install-build-deps`（不带 `--ui`）并按 `--filter` 批量补齐 host 依赖：`protobuf` / `abseil-cpp` / `zlib` / `sqlite` / `sqlite_src` / `re2` / `pcre2` / `linenoise` / `llvm-project` / `expat` / `lzma` / `zstd`；`emsdk` 同前
- 启动后端 `http://localhost:3000` 与 Perfetto UI `http://localhost:10000`

仅重启进程、不再编译：

```text
.\scripts\start-dev.ps1 -Quick
```

仅下載 / 更新 trace processor 二进制（可单独运行）：

```text
.\scripts\fetch-trace-processor.ps1
```

## 只构建、不启服务

```text
cd backend
npm install
npm run build
cd ..\perfetto
py -3 tools\install-build-deps --ui
# 从 perfetto 根目录，使用 hermetic 或 系统 node：
tools\node ui\build.js
```

（若本机没有 `perfetto\tools\node*`，且 `ui` 下无 `node`，可用 PATH 中的 `node` 构建，与上游 Perfetto 文档中「勿混用外置 pnpm」的要求一致。）

## 与 Linux/macOS 脚本差异

- 端口与进程清理通过 `Get-NetTCPConnection` / `taskkill` 实现，无需 `lsof` / `pkill`。
- 日志不合并到「一条 tee 到 combined」的流式实现，而分别写入 `logs\` 下带时间戳的文件，并复制一份 `backend_latest.log` / `frontend_latest.log`。
- 若 `tools\install-build-deps` 在极老分支上必须 bash，可在该步骤改用 **Git Bash** 手動执行同一条命令。

## 仅重启后端

改 `.env` 或 `npm install` 之后：

```text
npm run restart-backend:win
```

## 回归测试（与 bash 下环境变量等效）

在 **PowerShell** 中：

```text
$env:TP_PORT_MIN = "9800"
$env:TP_PORT_MAX = "9899"
cd backend
npx tsx tests\skill-eval\scene_trace_regression.ts
```

## 故障排查

| 现象 | 处理 |
|------|------|
| `'tsx' 不是内部或外部命令` | 先在 `backend` 执行 `npm install` 确保已安装 `tsx`；脚本已改为 `node node_modules/tsx/dist/cli.mjs ...`，避免在 `cmd /c` 下找不到 `node_modules\\.bin`。 |
| `'tsc' 不是内部或外部命令` | `npm run build` 已改为 `node node_modules/typescript/lib/tsc.js`（同上，避免 `cmd` 下无 `tsc`）。若仍报错，确认已安装 `typescript` 且存在 `node_modules\typescript\lib\tsc.js`。 |
| 日志里 **`Building the UI on Windows is unsupported`** | 不要跑 `python tools\install-build-deps --ui`；用 `npm run dev:win`（在 `start-dev.ps1` 中安装 UI 依赖）或手動 `scripts\install-perfetto-ui-win.cmd`（传入 `perfetto` 根目录）。 |
| **`DotSourceNotSupported`（对 `install-perfetto-ui-*.ps1`）** | 部分组策略/语言模式会拒绝 **嵌套** 的 `powershell -File` 子脚本；`start-dev.ps1` 已改为在**当前会话**里用 `cmd` 直跑 `npx`（不再为 UI 安装单独开 `-File` 子 PowerShell）。若仍因 `& npx` 报错，同样只通过 `cmd /c` 调用。 |
| **`ENOENT` / `lstat` ... `AppData\Roaming\npm`** | 某些账号从未装过全局 npm 包，缺目录会导致 `npx` 失败。`start-dev.ps1` 会在跑 `npx` 前自动创建；或手動：`mkdir` 该路径。 |
| **`tools\node` 不是内部或外部命令** | 上游 `perfetto/tools/node` 在 Windows 上常为 **非 exe** 的 hermetic 包装/脚本。`start-dev.ps1` 在 Windows 上**不会**用该路径，会改用 **PATH 中的 `node`**（需本机已装 Node 18+）。 |
| **`python3` ... `write_version_header.py` ... 9009** | `ui/build.js` 固定调用 `python3`，Windows 上需 **64 位 Python 3.10+**；`start-dev.ps1` 会合并注册表中的 **用户/系统 PATH**（`npm run` 子进程里路径常被截断），并前置 `scripts/win-python3-shim` 将 `python3` 转发到 `py -3` / `python`。本机可 `python -V` 仍失败时，在**同一终端**里先执行 `Get-Command python` 或检查「环境变量」里用户 PATH 是否含 Python 目录。 |
| 终端里 **`python3 -V` 无输出** / 无版本 | 多为 **Microsoft Store 应用别名** `…\AppData\Local\Microsoft\WindowsApps\python3.exe` 在 PATH 里更靠前（占位、常无正常输出）。处理：系统设置 → 应用 → **应用执行别名**（或「应用高级设置」）中 **关闭** `python3` / `python` 的别名；或把本仓库的 `scripts\win-python3-shim` 加到**用户** PATH 的**最前**；日常请用 `py -3 -V` 或 `python -V`。`npm run dev:win` 已在子进程里把该 shim 放在 PATH 最前，不依赖你终端里 `python3` 是否正常。 |
| 日志里 **`HEAD` unknown** / `install-build-deps` ... `failed` | `ui/build.js` 默认会跑依赖检查，需完整 **git 工作树**；`perfetto` 子模块若未带 `.git` 或浅克隆会无 `HEAD`。`start-dev.ps1` 已对 `build.js` 传 **`--no-depscheck`**（UI 依赖已由 pnpm 安装）。 |
| **`scandir` ... `buildtools\typefaces`** 或 **catapult_trace_viewer** | 这两个目录**不在 git 里**，由 **GCS 压缩包**解压（与 `install-build-deps` 中 `UI_DEPS` 一致）。`start-dev.ps1` 在构建前会跑 **`scripts/fetch-perfetto-ui-buildtools.ps1`** 下载并校验 SHA256；需能访问 `storage.googleapis.com`（如公司网络需放行）。 |
| 日志里 **`Cannot find module '...\tsx\dist\cli.mjs'`** | 说明 `backend\node_modules` 不完整（常见：之前 `npm install` 在 `better-sqlite3` 处中断）。`start-dev.ps1` 会检测缺少的 `tsx` 并自动再执行一次 `npm install`；若仍失败，需先按上表装好 **VS C++** 并解决 `better-sqlite3` 后再装依赖。 |
| **`tsc` / `Fatal process out of memory: Zone`**（`backend_*.log` 里 V8 崩溃） | 大型项目下默认 Node 堆不够。`backend` 的 **`npm run build`** 已带 **`--max-old-space-size=8192`**；若机器内存不足，可暂时关掉其它占内存程序，或在本机把该值改为 `4096` 再试。 |
| **`npm install` 在 `better-sqlite3` 失败**（`prebuild-install` 不是内部或外部命令 / `Could not find any Visual Studio`） | **推荐先试自动回退**（`npm run dev:win` 或 `npm run install:backend:win` 在标准 `npm install` 失败后会跑 `scripts/complete-backend-native-win.ps1`）：先 `npm install --ignore-scripts`，再对 `better-sqlite3` 用 `node` 显式执行 `prebuild-install\bin.js` 拉预编译，通常**无需**本机 VS。若仍失败：1）安装 **VS 2022 Build Tools** 与 **「使用 C++ 的桌面开发」**，**新开**终端后再 `cd backend && npm install`；2）`npm config set python` 指向 **64 位** Python 3.10+（勿用 `Python38-32`）。 |
| **`npm WARN cleanup` / `EPERM`** | 先关掉可能占用 `node_modules` 的 IDE、终端里跑的 `node`，或暂时排除杀毒软件实时扫描，再删 `backend\node_modules` 后重装。 |
| `better-sqlite3` / `node-gyp` 其它编译错误 | 参考 [node-gyp on Windows](https://github.com/nodejs/node-gyp#on-windows) |
| 找不到 `perfetto\out\ui\trace_processor_shell.exe` | 运行 `.\scripts\fetch-trace-processor.ps1`，或设 `TRACE_PROCESSOR_PATH` 指向本机可执行文件 |
| UI 无法打开 | 查看 `logs\frontend_*.log`；确认 10000 端口无占用 |
| 策略提示「无法执行脚本」 | 以当前用户执行：`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` |
| 日志里 **`gn gen` ... 失败** / **`win_find_msvc` / `TypeError: ... NoneType`** / **`msvc.gni`** | 安装 [VS 2022 生成工具](https://visualstudio.microsoft.com/zh-hans/downloads/) 并选 **“使用 C++ 的桌面开发”**，并安装 [Windows 11/10 SDK](https://developer.microsoft.com/zh-cn/windows/downloads/windows-sdk/)。请使用 **64 位 Python 3.10+**（`py -3-64`），勿用 32 位。 |
| 日志里 **ninja: error: unknown target 'traceconv_wasm'**（gn 已成功） | 上游默认在 **Windows** 上 **`enable_perfetto_ui=false`**（`gn/perfetto.gni`），不会生成任何 UI/WASM 目标。本仓库在 **`ui/build.js`** 里对 `win32` 的 `gn gen` 追加 **`enable_perfetto_ui=true`**；请**重新跑一次完整前端构建**（会重新 `gn gen`）。若仍用旧 `out\ui` 可删掉 `perfetto\out\ui` 后重试。 |
| **`main.cc' ... buildtools/protobuf`** / **protoc** / **missing and no known rule** | `buildtools/*` 未随仓库提交；`start-dev.ps1` 会调用 **`tools/install-build-deps --filter ...`** 统一补齐（函数 **`Install-PerfettoHostBuildtoolsWin`**）。若网络受限导致 clone/download 中断，重试 `npm run dev:win` 即可续跑。 |
| **`fasttable.cc`** / **`upb_generator/minitable`** missing（ninja） | 多为 **`protobuf` 目录是旧版或不完整 clone**（仅有 `compiler/main.cc` 等）。删掉 **`perfetto\buildtools\protobuf`** 后 **`npm run dev:win`**；脚本以 **`upb_generator/minitable/fasttable.cc`** 校验提交 **`74211c0…`**。 |
| **`buildtools/zlib/cpu_features.c`** / `adler32.c` missing（ninja / WASM） | 需 Chromium 的 **`third_party/zlib`**（`install-build-deps` 钉死提交）。`start-dev.ps1` 会从 **`chromium.googlesource.com`** clone；若超时请代理/VPN，或手動 clone 到 **`perfetto\buildtools\zlib`** 后 **`git checkout 6f9b4e6…`**。 |
| **`buildtools/sqlite/sqlite3.c`** 或 **`buildtools/sqlite_src/...`** missing（ninja / WASM） | 需同时具备 SQLite **amalgamation**（`sqlite/sqlite3.c`）与 full source（`sqlite_src`）。`start-dev.ps1` 会调用 `python3 tools/install-build-deps --no-toolchain --no-dev-tools --filter buildtools/sqlite --filter buildtools/sqlite_src` 自动补齐。 |
| **`buildtools/re2/re2/bitmap256.cc`** missing（ninja / WASM） | 说明 `re2` 目录未拉到位。`start-dev.ps1` 现会在每次全量构建都执行一次 `tools/install-build-deps --filter ...`（含 `buildtools/re2`），避免“关键文件检查提前返回”导致漏依赖。 |
| **`buildtools/llvm-project/llvm/lib/Demangle/DLangDemangle.cpp`** missing（ninja / WASM） | 说明 `llvm-project.tgz` 未解压到位。`start-dev.ps1` 的 filter 已包含 `buildtools/llvm-project`；重跑 `npm run dev:win` 可自动补齐。 |
| 依赖已补齐但仍报 `missing and no known rule`（同一路径反复） | 多为 `out/ui` 持有旧的 gn/ninja 状态。`start-dev.ps1` 在本机 full build 下已自动执行一次 `py -3 tools/gn clean out/ui`（日志里可见），然后再跑 `ui/build.js`。 |
| 文件实际存在但 ninja 仍报 `missing and no known rule`（尤其 `../../buildtools/...`） | 某些 Windows 环境下相对路径基准在 `wasm*.ninja` 子目录解析异常。`start-dev.ps1` 已在 `out/ui` 下自动创建 `buildtools` / `wasm/buildtools` / `wasm_memory64/buildtools` 到 `perfetto/buildtools` 的 junction 兜底。 |
| `install-build-deps` 末尾报 `tools/test_data download` / `curl` 失败（但你只是在构建 UI） | `install-build-deps` 会额外同步 `test/data`；在受限网络里常失败。`start-dev.ps1` 已改为：即使该步骤返回非 0，也会先校验核心 `buildtools/*` 是否齐全；若齐全则继续 UI/WASM 构建，不再被 test_data 卡住。 |
| **`abseil-cpp/.../internal/throw_delegate.cc` missing**（ninja） | 多为 **`abseil-cpp` 不是钉死提交**（例如曾 clone **`master`**）。删掉 **`perfetto\buildtools\abseil-cpp`** 后 **`npm run dev:win`**，脚本会 checkout **`76bb24329…`**（与 **`install-build-deps`** 一致）。 |
| 日志里 **Emscripten (emsdk)**、**WASM 编译**、或 **`buildtools\linux64\emsdk`** 相关错误 | 纯本机路径由 **`scripts/bootstrap-perfetto-emsdk-win.ps1`** 把官方 **4.0.8** 装到 **`perfetto\buildtools\win64\emsdk`**，需本机有 **git** 与能访问 emsdk 的下载源。如仍要最小折腾，可改用 WSL：`npm run dev:win:wsl`（`start-dev.ps1 -WslUi`），仅 WSL 会话内用 `wsl` 跑前端 `watch`（仅当**本次**用 `-WslUi` 建 UI 时）。 |

## 与 Docker / WSL 的取舍

- **Docker**：仍是一键、环境可复现的首选（见根目录 `README`）。
- **WSL2**：可继续使用 `scripts/start-dev.sh`；在 **只装 Windows 终端** 时，也可用 **`npm run dev:win:wsl`** 让 `start-dev.ps1` 在 WSL 内完成 Perfetto UI 的 `build.js` 与 `watch`（与上方「WASM 与 gn」表一致）。
- **本机 Windows**：适合希望调试原生 Node/浏览器、与 Shell 解耦的开发者；trace processor 已改为支持 `trace_processor_shell.exe` 路径与 Windows 上清理孤儿进程（见 `backend/src/services/traceProcessorPath.ts`）。**完整** Perfetto UI WASM 构建若在本机仍失败，优先用 **WSL2 UI** 路径而非强行对齐上游 Linux 脚本到每一处 Windows 限制。
