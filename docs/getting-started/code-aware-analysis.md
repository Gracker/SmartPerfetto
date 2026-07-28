# Code-Aware Analysis

[English](code-aware-analysis.en.md) | [中文](code-aware-analysis.md)

Code-Aware Analysis 让 SmartPerfetto 在分析 trace 时按需引用本机代码库，把调用栈、native frame 或 kernel symbol 映射到 `CodeRef`。默认输出只展示 `chunkId`、相对路径、行号和 symbol；源码正文只通过受 RBAC 保护的 excerpt endpoint 临时读取，不写入 session、报告或导出。

## 启用方式

1. 启动后端：`./start.sh`。
2. 在 Perfetto UI 打开 AI Assistant settings，进入 `Codebases`。
3. 添加代码库时优先点击“选择文件夹”，再运行 preview。显示名称可留空，默认使用文件夹名。
4. 注册后执行 reindex。
5. 分析时使用 code-aware 模式，或在 CLI 传入 `--code-aware metadata_only|provider_send` 和 `--codebase-id <id>`。

CLI 示例：

```bash
cd backend
npm run cli:dev -- codebase register /path/to/app \
  --name MyApp \
  --kind app_source \
  --path-filter app/src/main/ \
  --dry-run

npm run cli:dev -- codebase register /path/to/app \
  --name MyApp \
  --kind app_source \
  --path-filter app/src/main/

npm run cli:dev -- codebase reindex cb_xxx
npm run cli:dev -- codebase symbols MainActivity --codebase-id cb_xxx

npm run cli:dev -- run --format json \
  --code-aware metadata_only \
  --codebase-id cb_xxx \
  ../Trace/real/android-startup-heavy/trace.pftrace \
  "结合源码定位启动慢原因"
```

已注册的 codebase 或知识源不会自动暴露给 session。实际组合规则如下：

| 本次选择 | 有效行为 |
|---|---|
| 不传任何 ID | 普通 trace-only；`fast` 可以保持轻量路径 |
| 只传 `--codebase-id` | 默认 `metadata_only`，并切换到完整分析 runtime |
| `--code-aware metadata_only` + codebase ID | 只使用 `CodeRef` 元数据，完整分析 runtime |
| `--code-aware provider_send` + codebase ID | 仅双重授权通过时发送筛选后的片段，完整分析 runtime |
| `--code-aware off` + codebase ID | 输入无效，直接拒绝，不静默忽略源码配置 |
| 只传 `--knowledge-source-id` | 使用已授权的私有外部 RAG，完整分析 runtime |
| codebase ID + knowledge source ID | 源码与外部 RAG 同时参与，同一隐私投影和完整分析 runtime |

这里的“完整分析 runtime”意味着即使显式请求 `--analysis-mode fast`，只要选择了源码、私有 RAG 或 reference trace，系统也会解析为 `full`，避免在轻量路径里静默丢失能力。`provider_send` 需要两层授权：注册 codebase 时启用 `--send-to-provider`，且本次分析显式选择 `--code-aware provider_send`。

## 支持的代码库

| kind | 用途 | 必要信息 |
|---|---|---|
| `app_source` | App Java/Kotlin/R8 反查 | 源码文件夹；build ID 与路径范围可选 |
| `aosp` | AOSP framework/native 热路径 | 源码文件夹、`licenseTag`；build ID 与路径范围可选 |
| `kernel_source` | binder/scheduler/mm/io 等 kernel 根因 | 源码文件夹、`vendor`、`path-filter`（CLI 重建也可传 `pathPrefix`）；license tag 可选 |
| `oem_sdk` | OEM / chipset SDK 资料 | 源码文件夹、`vendor`、`licenseTag`；build ID 与路径范围可选 |

提交版本不需要手动填写。每次建立索引时，SmartPerfetto 会从实际 checkout 自动读取
Git `HEAD`，并单独记录工作区是否包含未提交或未跟踪修改；非 Git 目录使用内容指纹。

本机 source checkout 和 portable app 在 loopback 模式下可由后端打开 macOS、Windows
或 Linux 的系统文件夹选择器。选择结果会生成一个 5 分钟有效、绑定当前
tenant/workspace/user 且只能消费一次的授权；它只授权该次注册及这个注册项后续的
reindex，不会扩大进程全局 allowlist。注册项的 list/audit 元数据会标明路径授权来自
系统选择器还是配置的 allowlist；删除注册项会同时撤销这项持久授权。Docker、远程/共享后端、无图形会话或没有
受支持选择器的平台会保留手动输入，此时必须填写后端实际可访问且已通过
`SMARTPERFETTO_CODEBASE_ROOTS` 授权的路径。

## 安全边界

- `metadata_only`：模型只看到 `CodeRef` 元数据，不看到源码片段。
- `provider_send`：只有注册时同意 `sendToProvider` 的代码库才允许把筛选后的片段发给模型。
- 系统文件夹选择器的变更请求必须同时具有 loopback Host、socket 与 Origin；只读能力探测可省略 Origin。选择器在 Docker、enterprise 或非 loopback 监听模式下关闭；目录绝对路径不会出现在 codebase list/detail 响应中。
- 私有源码/知识分析的原始 query、中间推理、工具参数和检索正文不写入 session、日志、报告或导出；Claude 本地 transcript 与 OpenAI Responses 存储会关闭，也不会读写跨会话 pattern、verifier 或 SQL 修复学习。最终结论与确定性 trace 证据会经过统一隐私投影；多轮连续性仅由当前进程内的受限会话上下文提供。
- 旧 RAG chunk 不受 code-aware 规则破坏；`app_source`、`kernel_source` 或 `registryOrigin=codebase_registry` 的 chunk 缺少 codebase metadata 时会 fail-closed。
- 旧 `/api/rag/chunks/:id` 和 `/api/rag/search` 对 code-aware chunk 返回 hash/长度等 sanitized 信息，不返回源码正文。
- Web UI 的“删除源码库”会先撤销检索与 provider 授权，再清理当前 scope 内的全部索引代际；删除中断时可安全重试。已经发送给 provider 的历史内容无法由本地删除操作撤回。
- Patch 只分三态：`verified`、`sketch`、`unverified`。`sketch` 和 `unverified` 不给 copyable diff。

## 验证

常用验证命令：

```bash
cd backend
npm run verify:codebase-aware
```

本机完整 E2E 会使用：

- `Trace/real/android-startup-heavy/trace.pftrace`
- `Trace/real/android-startup-light/trace.pftrace`
- `/Users/chris/Code/HighPerformanceFriendsCircle`

E2E 覆盖两条路径：

- 未给 session 配置 codebase：Light trace 正常完成，报告不出现 `CodeRef` / code-aware section。
- 给 session 配置 HighPerformanceFriendsCircle：Heavy/Light trace 正常完成，报告和导出里出现 `CodeRef`，例如 `MainActivity.kt`、`LoadSimulator.kt` 的相对路径与行号；报告不得出现绝对 root path 或源码正文。

缺少本机资产时可用环境变量覆盖：

```bash
SMARTPERFETTO_E2E_HEAVY_TRACE=/path/heavy.pftrace \
SMARTPERFETTO_E2E_LIGHT_TRACE=/path/light.pftrace \
SMARTPERFETTO_E2E_APP_REPO=/path/HighPerformanceFriendsCircle \
npm --prefix backend run verify:codebase-aware
```
