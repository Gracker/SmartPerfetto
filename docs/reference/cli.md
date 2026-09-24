<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2024-2026 Gracker (Chris)
This file is part of SmartPerfetto. See LICENSE for details.
-->

# SmartPerfetto CLI

[English](cli.en.md) | [中文](cli.md)

SmartPerfetto CLI 是正式的终端入口。用户只需要 `smp` 或
`smartperfetto`，不启动 Web UI，也能完成配置诊断、trace 分析、多轮追问、
SQL 查询、Skill 运行、报告导出和本地历史管理。

## 安装

```bash
npm install -g @gracker/smartperfetto
```

要求 Node.js 24 LTS。npm CLI 包内置 Linux x64、macOS arm64 和 Windows x64
的固定版本 `trace_processor_shell`。如果当前平台没有内置 binary，CLI 会下载
固定版本；下载不可用时可以配置 `TRACE_PROCESSOR_PATH` 指向本机已有可执行文件。
CLI 包是独立终端产品，不启动也不包含 Web UI launcher；需要浏览器体验时使用
Docker 或 GitHub 免安装包。

## 全局选项

```text
Usage: smp [options] [command]

Options:
  -V, --version             output the version number
  -f, --file <trace>        trace file to analyze (shortcut for `analyze <trace>`)
  -p, --prompt <question>   analysis prompt (shortcut for --query)
  -q, --query <question>    analysis question (alias for --prompt)
  --session-dir <path>      override session storage root (default: ~/.smartperfetto)
  --env-file <path>         path to explicit .env file (skips default env chain)
  --verbose                 show verbose event stream
  --no-color                disable ANSI colors
  --resume <sessionId>      start the REPL with this session already loaded
  -h, --help                display help for command
```

并行回归可为每个任务传不同的 `--session-dir /tmp/smp-sessions/<case>`；
后续 `ask`、`list`、`report` 也要使用同一目录。共享 SQLite 已有 5 秒锁等待，
独立目录用于隔离测试状态，不能代替对持续锁冲突的排查。

会话标记：`✓` 已交付且核验通过或不适用；`~` 已交付但核验未完成或覆盖不全（例如结论声明无效、
语义复核超时），不能视为已核验结论；`!` 分析未完整结束，或断言与证据不符导致质量校验失败；
`✗` 失败。结论块下方的“断言核验”行分别给出引用匹配、命题证明、整体复核后已核验和矛盾的断言数；
正文含未声明断言这类整条答案的失败列在“另:”之后，语义复核未完成的原因在任何状态下都保留。
HTML 报告和回执的声明审计使用同一组计数。最终语义复核运行期间，`final_review` 进度行会显示
开始（含截止时间）和结果。没有 findings 时置信度只是固定基线，
文本输出不再显示。JSON/NDJSON 的 `complete` 事件带 `deliveryVerdict`
（`completed`/`unverified`/`partial`/`failed`）。

分析未完成时，CLI 显示终止原因及可用的具体诊断，并区分未生成正文与已有正文但
质量校验失败。JSON/NDJSON 同样保留 `terminationMessage` 和 `hasConclusion`。
`quality_gate_failed` 可能表示声明或证据绑定无效，不等同于缺少报告段落。
总轮次预算大于一时预留一次无工具总结；触顶后基于已有返回数据说明发现、不足及
下一步，仍标记 `partial` / `max_turns`。原截止时间、授权和显式费用预算继续生效。
OpenCode 按观察到的实际轮次停止，若已过冲到没有剩余额度则保留结果而不追加调用。
`smp ask` 把历史与新问题分开传递，保留历史完整性状态并允许按需回查更早正文；
Trace 重载后的旧证据仍标为历史，不冒充新 Trace 的已核验事实。

## 核心工作流

```bash
smp run trace.perfetto-trace "分析启动慢的原因"
smp ask <sessionId> "为什么 RenderThread 慢？"
smp repl --resume <sessionId>
```

兼容旧入口仍然可用：

```bash
smp analyze trace.perfetto-trace --query "分析启动慢的原因"
smp resume <sessionId> --query "继续追问"
smp list
smp show <sessionId>
smp report <sessionId> --open
smp rm <sessionId>
```

分析类命令支持机器可读输出：

```bash
smp run trace.perfetto-trace "分析启动慢的原因" --format json
smp resume <sessionId> --query "继续追问" --format ndjson
```

`--format` 可选值：`text`、`json`、`ndjson`。

## 应用更新

```bash
smp update check
smp update check --format json
```

该命令检查 npm stable 版本并返回当前 build identity、检查时间、状态和明确升级
命令。它只通知，不会自动安装、替换文件或修改当前进程。交互式 text 命令结束时
可能在 stderr 显示每日一次、按目标版本去重的提醒；CI、重定向输出、
`--format json` / `--json`、help、version 和 `update` 命令本身不会附加提醒。
设置 `SMARTPERFETTO_UPDATE_CHECK=off` 可完全禁用应用更新检查。

## 配置与 Provider

```bash
smp doctor --format text
smp doctor --format json
smp probe
smp config init
smp config init --force
smp provider list
smp provider list --format json
smp provider test system
smp provider test <providerId> --format json
```

`smp probe` 用当前被调用的构建（dist 或 tsx）加载策略注册表并打印
`strategies OK <N>`，失败时输出带文件与需求定位的解析错误。策略文件与解析器
版本错配会让每个分析会话在启动时崩溃；批量运行前用它对同一构建做门禁。

CLI 配置与 Web UI 配置默认彼此独立。CLI Provider store 位于
`<CLI home>/runtime/data/providers.json`，通常是
`~/.smartperfetto/runtime/data/providers.json`；源码 Web 后端默认使用
`backend/data/providers.json`。只有两个进程显式使用同一个
`SMARTPERFETTO_BACKEND_DATA_DIR` 时，网页 Provider 修改才会作用于 CLI。

第一次使用 CLI 时，推荐先运行 `smp config init`，然后编辑输出路径里的 env 文件，
通常是 `~/.smartperfetto/env`。没有显式传 `--env-file` 时，CLI 读取顺序是：

1. 包内或源码目录的 `backend/.env`。
2. `~/.smartperfetto/env`，覆盖前面的值。

如果传了 `--env-file /path/to/env`，CLI 只读取这个文件。首次配置只启用一个 CLI
provider 来源：当前 CLI store 中已有的 active profile、一个 Claude-compatible env
block，或一个 OpenAI-compatible env block。`smp provider list` 和
`smp provider test <providerId>` 只检查该 CLI store；CLI 当前不提供 profile 的
add、edit 或 activate 命令。

Runtime 判断按实际选择的 provider/runtime 执行：

- Claude Agent SDK：需要 API key/auth token 或 Bedrock/Vertex 配置；仅有代理地址或
  Claude Code 登录态时，运行前校验、doctor 和 system provider test 均不通过。
- OpenAI Agents SDK：需要 `OPENAI_API_KEY`，或本地
  `localhost` / `127.0.0.1` / `0.0.0.0` OpenAI-compatible endpoint。
- Ollama provider 默认走 OpenAI-compatible runtime。

设置 `SMARTPERFETTO_AI_ENABLED=false` 后，`smp doctor` 会显示 AI policy。
`smp analyze`、`smp resume`、`smp provider test` 和 `smp capture android --analyze`
会在 runtime/provider 检查前返回 `AI_DISABLED`；`smp query`、确定性 `smp skill`、
`smp batch skill`、`smp capture config`、不带 `--analyze` 的 capture，以及
`smp provider list` 仍可用。无效的 `SMARTPERFETTO_AI_ENABLED` 值会 fail closed，
并在 doctor JSON 的 `aiPolicy.env.valid=false` 中暴露。

第一轮 CLI 不提供 `provider add/edit`，涉及密钥写入的交互配置仍由 env 文件
或后续安全交互设计处理。

## Android Internals Knowledge Pack

```bash
smp knowledge-pack status
smp knowledge-pack status --format json
smp knowledge-pack update --check
smp knowledge-pack update
```

`status` 展示当前 active、包内 bundled snapshot 和签名 channel 状态。
`update --check` 只刷新并校验 TUF metadata，不安装内容；`update` 会在签名、
版本、哈希和撤回检查通过后原子安装 stable Pack。离线时仍可使用随 npm、Docker、
源码和 portable 产物一起分发的 bundled snapshot。分析引用只把出处、版本和
snippet hash 投影到日志/SSE，正文片段不会作为 trace 证据。

完整的许可证、更新和私有知识源边界见
[Android Internals 知识包与私有知识库](../getting-started/android-internals-knowledge.md)。

## Trace 查询与 Skill

```bash
smp query trace.perfetto-trace --sql "select count(*) as cnt from slice"
smp query trace.perfetto-trace --sql "select count(*) from slice" --format json

smp skill trace.perfetto-trace startup_slow_reasons
smp skill trace.perfetto-trace startup_slow_reasons --params '{"package":"com.example"}' --format json
```

`query` 和 `skill` 不需要启动 Web UI。`skill` 会加载 SmartPerfetto 内置
YAML Skills 和 SQL fragments。

## Batch Trace Skill

```bash
smp batch skill startup_analysis launch-a.pftrace launch-b.pftrace
smp batch skill startup_analysis \
  --trace-list traces.txt \
  --params '{"package":"com.example"}' \
  --concurrency 2 \
  --format json \
  --out batch-report.html \
  --json-out batch-result.json
```

`smp batch skill` 在本机对多条 trace 运行同一个确定性 YAML Skill，不需要配置或调用
LLM provider。CLI 输入是本机 trace 路径；`--trace-list` 文件按一行一个路径读取，
空行和 `#` 注释会跳过。路径解析为绝对路径后会去重。

输出格式支持 `text`、`json`、`ndjson`。`text` 和 `ndjson` 会为每条 trace 输出一个
progress/result 事件，最终输出完整 `BatchTraceRunV1`。没有显式传 `--out` 或
`--json-out` 时，CLI 会写入：

```text
~/.smartperfetto/
└── batch-runs/<runId>/
    ├── result.json
    └── report.html
```

默认最多 100 条 trace，默认并发为 2，本地 CLI 最大并发为 4；可通过
`SMARTPERFETTO_BATCH_TRACE_MAX_TRACES`、
`SMARTPERFETTO_BATCH_TRACE_DEFAULT_CONCURRENCY` 和
`SMARTPERFETTO_BATCH_TRACE_MAX_CLI_CONCURRENCY` 调整。标准 startup / scrolling
指标会提升为 analysis-result comparison 可用的 metric key；无法映射的数字指标只保留
为 batch-local metric，不会伪装成标准指标。

退出码：

| Code | 含义 |
|---|---|
| `0` | 所有 trace 完成 |
| `1` | 至少一个 trace 失败，或整个 batch 失败 |
| `2` | CLI 输入无效，例如没有 trace、`--params` 不是 JSON object、并发不是正整数 |

第一版不支持 raw batch SQL、远程 worker、浏览器 UI 执行或自动创建
analysis-result snapshot。需要把 batch 结果纳入多结果 comparison 时，使用
workspace Batch Trace API 的显式 snapshot promotion / comparison bridge。

## Code-Aware Analysis

先注册本机代码库，再在分析 session 中显式选择 code-aware 模式。注册不会自动附加源码，建立索引也是可选加速项：

```bash
smp codebase preview /path/to/app --kind app_source --path-filter app/src/main/ --exclude-glob '**/generated/**'
smp codebase register /path/to/app --kind app_source --name MyApp --path-filter app/src/main/ --exclude-glob '**/generated/**' --dry-run
smp codebase register /path/to/app --kind app_source --name MyApp --path-filter app/src/main/ --exclude-glob '**/generated/**'
smp codebase list
smp codebase list --format json

# 同时提供两类选项时，替换 pathFilters 和 excludeGlobs
smp codebase selection cb_xxx \
  --path-filter app/src/main/ \
  --exclude-glob '**/generated/**'

# provider-send 同意与当前范围/新语言授权
smp codebase consent cb_xxx --enable
smp codebase authorize-selection cb_xxx
smp codebase authorize-extensions cb_xxx

# 生命周期、精确 pending candidate 的 CAS 操作与删除
smp codebase audit cb_xxx --format json
smp codebase pending cb_xxx --accept --candidate generation_xxx
smp codebase pending cb_xxx --reject --candidate generation_xxx

# 可选：为语义/符号检索和 patch 工作流建立索引
smp codebase reindex cb_xxx
smp codebase symbols MainActivity --codebase-id cb_xxx

# 破坏性操作：退役注册项并删除所有索引代次
smp codebase delete cb_xxx --yes

smp run trace.perfetto-trace \
  --code-aware metadata_only \
  --codebase-id cb_xxx \
  "结合源码定位启动慢原因"
```

`metadata_only` 只把 `CodeRef` 元数据暴露给模型；源码正文不会进入 session、
报告或导出。`provider_send` 只有在注册 codebase 时使用 `--send-to-provider`
并且本次分析也选择 `--code-aware provider_send` 时才允许发送片段。只传
`--codebase-id` 会默认使用 `metadata_only`；`--code-aware off` 与 codebase ID
组合会被拒绝。未传任何 codebase/knowledge source ID 时才是 trace-only。
`--knowledge-source-id <id>` 可单独启用已授权的私有外部 RAG，也可与 codebase
叠加。源码、私有 RAG 或 reference trace 会把显式 `fast` 解析为 `full`，避免
轻量 runtime 静默丢失能力。
`preview` 和 `register --dry-run` 会输出实际使用的 `ripgrep → git → node-walk`
枚举后端、fidelity、完整性和截断原因；截断只表示有界预览，不再用非零退出码冒充
命令失败。portable 包不内置 ripgrep，缺失时按上述顺序安全降级。

`selection` 只替换显式提供的字段：`--path-filter` 替换 `pathFilters`，
`--exclude-glob` 替换 `excludeGlobs`；未提供的字段保留现有列表。两类选项都提供时才
会同时替换两个列表。有效变更会递增 selection revision、使旧 active index 失效，并可能使
provider grant 与当前范围不一致。`authorize-selection` 只授权当前路径范围；
`authorize-extensions` 只授权当前可用新语言，两者都不会替用户开启 provider-send。`pending`
必须传回 `list` / `audit` 中当前的精确 candidate ID。`delete` 必须显式传 `--yes`。

CLI `reindex` 只接受 codebase ID，没有 `pathPrefix` 选项。路径范围用 `selection --path-filter` 管理。注册时的 `--commit` 仍为旧调用方保留，但只是 caller-supplied 兼容元数据；每次索引都会自动读取真实 Git `HEAD`、工作区 dirty 状态和内容指纹，并在 `audit` 中作为索引来源权威值。

新管理命令的退出码是稳定机器契约：`0` 成功，`2` 输入/选择无效，`3` codebase 不存在，`4` 忙、授权不足或 pending CAS 冲突，`5` 其他管理失败。`register`、`reindex` 和 `symbols` 继续保留原有的 `0/1` 兼容语义。
完整说明见 [Code-Aware Analysis](../getting-started/code-aware-analysis.md)。

## 双 Trace 对比

```bash
smp compare baseline.perfetto-trace comparison.perfetto-trace --query "对比启动阶段差异"
smp compare baseline.perfetto-trace comparison.perfetto-trace --query "对比卡顿根因" --format ndjson
```

`compare` 会把第二个 trace 作为 reference trace 传给 AI runtime，启用双 trace
分析工具。CLI 和前端 Raw Trace Compare 共享同一套对比 identity、evidence pack、
报告 section 和 session snapshot 规则；不是 CLI 私有 Prompt。共享对比合约要求
报告包含指标矩阵、阶段/热点差异、阻塞与调度差异、系统因素排除、证据限制和
下一步建议，避免只输出耗时差值。共享确定性 SQL 证据至少覆盖 package、Perfetto
原始 startup_type、dur delta、启动窗口 top slices 和主线程状态分布。startup_type
是原始字段，不等同于二次判定；如果 cold/warm 口径与 trace 信号冲突，报告正文
必须列为证据限制。

## 报告与历史

```bash
smp list
smp list --json
smp list --format json
smp show <sessionId>
smp report <sessionId>
smp report <sessionId> --turn 1
smp report <sessionId> --open
smp report export <sessionId> --format html --out report.html
smp report export <sessionId> --turn 1 --format html --out turn-001.html
smp report export <sessionId> --format md --out report.md
smp report export <sessionId> --format json --out report.json
```

CLI 文件存储在：

```text
~/.smartperfetto/
├── index.json
├── traces/
└── sessions/<sessionId>/
    ├── config.json
    ├── conclusion.md
    ├── report.html
    ├── source-use-decision.json
    ├── source-claim-bindings.json
    ├── ui-action-proposals.json
    ├── transcript.jsonl
    ├── stream.jsonl
    └── turns/
        ├── 001.md
        ├── 001.source-use-decision.json
        ├── 001.source-claim-bindings.json
        ├── 001.ui-action-proposals.json
        └── 001.html
```

两组 source sidecar 只在本轮有 canonical safe source provenance 时生成。最新文件会随新 turn 替换；一次无源码 turn 会清除过期的“最新” sidecar，但不删除历史 turn 文件。这两组来源元数据只保留安全决策、相对 `CodeRef` 与 mechanism binding，不包含绝对 root、snippet、检索 query 或自由文本 binding reason。分析正文与正式声明可以保留 `provider_send` 已授权的源码摘录；密钥、私有 canary 和绝对 root 仍受输出投影保护。

`conclusion.md` 与 `turns/NNN.md` 保留正文记录。`analysis-evidence.json` 和 `turns/NNN.analysis-evidence.json` 独立保存与同一会话、回合及候选正文绑定的呈现数据。终端、`show` 和 Markdown 导出完整显示声明、引用、核验问题和源码关联；JSON/NDJSON 同时提供结构化详情。损坏或错配的证据包显示为不可用，不借用其他回合的验证结果。这些文件用于展示，不重新签发证据或执行验证。

`ui-action-proposals.json` 只保存证据回链和 UI 提案元数据，用于报告/后续轮次
追溯；CLI 不会自动执行跳转、打开表或固定证据。

## Android 采集

`smp capture` 用于从已连接 Android 设备录制系统 trace。实现方式遵循
Perfetto 的 Android/Linux system tracing 路线：Android Q/API 29 及以上优先使用
设备内置 `perfetto`，更老设备或显式 `--sideload` 才使用已打包或手动指定的
`tracebox`。

```bash
smp capture presets
smp capture suggest "debug startup jank" --app com.example.app --format json
smp capture suggest "分析滑动掉帧，先不要真的抓取" --app com.example.app
smp capture suggest "分析 Camera 打开到首帧预览延迟" --app com.example.camera
smp capture suggest "分析 Java 堆内存泄漏" --app com.example.app
smp capture config --preset startup --app com.example.app --duration 10 --out startup.pbtxt
smp capture config --preset camera --app com.example.camera --duration 20
smp capture config --preset cpu --app '*' --duration 30 --categories dalvikviktime my_custom_tag --out cpu-custom.pbtxt
smp capture config --preset power --app com.example.app --duration 60 --out power.pbtxt
smp capture config --preset memory-profile --app com.example.app --out memory-profile.pbtxt

smp capture android --preset startup --app com.example.app --duration 10 --out launch.perfetto-trace
smp capture android --preset scrolling --app com.example.app --duration 15 --serial <adbSerial> --out scroll.perfetto-trace
smp capture android --preset power --app com.example.app --duration 60 --out power.perfetto-trace
smp capture android --preset memory-profile --app com.example.app --duration 60 --out memory-profile.perfetto-trace
smp capture android --config startup.pbtxt --out launch.perfetto-trace
smp capture android --config template.pbtxt --duration 10 --categories my_custom_tag --out custom.perfetto-trace
smp capture android --preset overview --app com.example.app --duration 10 --kill-stale --out retry.perfetto-trace
smp capture android --preset game --app com.example.game --duration 20 --out game.perfetto-trace --analyze --query "分析启动和帧节奏问题" --mode fast
```

内置预设包括：`startup`、`scrolling`、`camera`、`anr`、`game`、`memory`、
`memory-profile`、`cpu`、`power`、`overview`、`full`。除 `memory-profile` 外的
所有系统级预设都会开启 `power/cpu_frequency` 与
`power/cpu_frequency_limits`，后者提供每个 CPU 的频率上下限，用来区分“负载低所以
频率低”和“被限频压住”。`cpu` 和 `power` 还会开启
`thermal/thermal_temperature` 与 `thermal/cdev_update`，让限频可以和同一时间窗内
的热区温度对应起来；这两个 tracepoint 依赖设备/内核支持，并非所有设备都暴露。
`power` 另外会开启 `android.power` 的 battery
counters、power rails、suspend/wakeup 相关 ftrace 和 `android.network_packets`。
`camera` 会采集 Camera/HAL/厂商 atrace 候选、Binder、scheduler、FrameTimeline，
以及 DMA-BUF 或旧版 ION 事件；这些 tracepoint 都是可选的，会随 Android 版本、
内核和厂商实现而变化。即使使用该预设，trace 仍可能缺少可移植的 Camera open、
request/result、buffer 或预览 presentation 锚点。SmartPerfetto 会把这种情况报告为
证据缺口，而不会编造“打开到首帧”耗时。

`memory-profile` 只剖析一个 app 进程，参照 Perfetto Memscope 的单进程配方：
`linux.process_stats` 每秒采一次内存计数；`android.packages_list` 记录 app 是否
profileable 或 debuggable；`android.heapprofd` 采 native 堆（32 KiB 采样间隔，
每 5 秒 dump 一次）；`android.java_hprof` 做 Java heap dump；另有一个小的
`linux.ftrace` buffer，包含 `ftrace/print` 以及 `dalvik`、`am`、`wm` atrace
category。它和系统级预设有以下区别：

- `--app` 必须是一个明确的包名或进程名（例如 `com.example.app` 或
  `com.example.app:remote`）；`--app '*'`、空值和通配模式会被 `capture config`、
  `capture android` 以及 renderer 本身拒绝。
- 设备必须是 Android 11（API 30）及以上，并使用设备内置 `perfetto`：heapprofd
  需要 API 29，`java_hprof` 需要 API 30。`capture android` 会先探测设备，在旧设备
  或使用 `--sideload` 时直接失败，不做任何设备侧操作，因为 tracebox 不提供平台侧
  profiler 守护进程。
- user 版本上 app 必须是 profileable 或 debuggable，否则 profiler 不会为它记录任何
  数据；每次 Java heap dump 都会在写堆期间暂停 app。这两点会作为 preflight 警告
  输出。
- 请先启动 app 再采集。Java heap dump 在 trace 开始时执行一次（基线），之后每隔
  `max(10 秒, (时长 - 10 秒) / 2)` 执行一次，因此默认 60 秒采集约在 0、25、50 秒
  得到 3 次 dump。时长至少 20 秒，保证基线之后还有第二次 dump。
- 配置使用 4 个 buffer，而不是一个按时长放大的 ring：process stats 与 packages
  list（RING，按每秒 64 KB 计算，8-128 MB）、heapprofd（RING，128 MB）、
  `java_hprof`（DISCARD，256 MB）、ftrace（RING，16 MB）。DISCARD 保证基线 dump
  不被覆盖；放不下的后期 dump 会被截断，heap graph 分析会把它标为不完整。buffer
  覆盖值（配置 API 的 `bufferSizeKb`）设置的是 `java_hprof` buffer，且不得小于
  256 MB。`--cuj` 对该预设无效。
- 配置不包含 Memscope 使用的 `java_hprof` `smaps_config`（需要 Android build
  ZP1A.260626.001 或更新）和 `process_stats` `record_process_age`，因为设备会拒绝
  其 perfetto 不认识的配置字段。

`smp capture suggest` 在请求涉及 heap dump、hprof、Java 堆、heap graph 或内存泄漏
且 `--app` 为明确包名时建议 `memory-profile`；没有 `--app` 时保留系统级 `memory`
预设，并在 rationale 中说明 heap dump 需要 `--app`。

`smp capture suggest` 是无副作用的采集建议入口：它只根据自然语言确定内置
preset，返回 rationale、warning、推荐命令和同一 renderer 生成的 textproto
预览；不会调用 LLM、ADB、tracebox，也不会录制设备。真正执行仍需要用户显式运行
`smp capture android ...`。
需要系统级 atrace category 而不是 app-scoped atrace tag
时，可以显式传 `--app '*'`。`--categories` 可以把额外 atrace tag 注入到生成
配置或已有 `ftrace_config` 中。生成配置会按 duration 自动放大主 buffer，规则约为
8 MB/s，并限制在 64 MB 到 512 MB 之间。`--config <pbtxt>` 保留旧
`record_android_trace -c ... -o ...` 的使用形态；普通配置原样传入，模板配置支持
`{duration_ms}` 和 `{buffer_size_kb}` 占位符，传 `--duration` 后会渲染。

抓取前会检查 stale `perfetto` / `simpleperf` / `traced` 进程和 SELinux
`Enforcing` 状态并给出提示。`--kill-stale` 会在抓取前清理残留 tracing 进程；它会杀
设备上的 tracing 服务，所以保持显式 opt-in。

源码 checkout 示例：

```bash
npm --prefix backend run cli:dev -- capture android \
  --config ~/tools/perfetto_shell/perfetto.config \
  --out ~/tools/perfetto_shell/trace/dut-game-launch.ptrace
```

传 `--analyze` 后会先录制 trace，再立即进入普通 CLI 分析 session。捕获到的
trace 路径、target、serial、preset/config、工具来源和 `--mode fast|full|auto`
会写入 session config，便于后续 resume 和审计。

抓取阶段不会现场下载工具。`adb` 按 `ADB_PATH`、已批准的包内 slot
`prebuilts/android-platform-tools/<host>/adb`、`PATH` 的顺序解析；Android SDK
Platform-Tools binary 不会被直接盲目再分发。需要 sideload 时，CLI 会按设备 ABI
查找 `prebuilts/perfetto-recording-tools/android-*/tracebox`，也可以通过
`--tracebox` 显式指定；缺失时会给出明确 override 提示。macOS、Windows、Linux
宿主机都可以抓 Android 设备；Linux 宿主机 system tracing 预留给后续
`smp capture linux` target。

当连接多个设备时必须传 `--serial`。

## REPL

```bash
smp repl
smp repl --resume <sessionId>
```

REPL 内部命令：

| 命令 | 作用 |
| --- | --- |
| `/load <trace>` | 加载 trace 并开始分析 |
| `/ask <query>` | 对当前 session 追问 |
| `/resume <sessionId>` | 切换到已有 session |
| `/report` | 打印最新 report 路径 |
| `/focus` | 显示当前 session 状态 |
| `/clear` | 清屏 |
| `/exit` | 退出 |

## 系统调查输出

CLI 将系统调查覆盖与系统证据覆盖分别输出；缺失的历史字段显示尚未核验。机器输出的结论记录包含 `investigationAssurance`，不改变原始 conclusion 或 native completion。每轮额外保存 `NNN.investigation-assessment.json` 和 `NNN.delivery-assurance.json`，保留维度状态与证据引用，HTML 报告显示相同调查范围。恢复历史结果不会自动补采证据。
