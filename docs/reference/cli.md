<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2024-2026 Gracker (Chris)
This file is part of SmartPerfetto. See LICENSE for details.
-->

# SmartPerfetto CLI

终端化的 agentv3 分析入口。不启动 Perfetto 前端、不启动 HTTP 服务器，
直接通过本地进程跑 Claude Agent SDK 驱动的 trace 分析、生成 HTML 报告，
并支持多轮 resume。

---

## 1. 架构

### 1.1 与主后端的关系

CLI 是 `@gracker/smartperfetto` npm 包的终端入口，**复用 agentv3
的所有核心模块**（orchestrator、skill 引擎、HTML 报告生成器、SQLite
持久化），但不共用 Express 路由层。

```
┌─────────────────────────────────────────────────────────────────┐
│ 主后端运行时                                                    │
│                                                                 │
│ ┌────────────┐   ┌────────────┐   ┌────────────────────────┐    │
│ │ Perfetto   │──▶│ Express    │──▶│ agentv3 services       │    │
│ │ frontend   │SSE│ @ :3000    │   │ (ClaudeRuntime + ...)  │    │
│ │ @ :10000   │   │ routes     │   └────────────────────────┘    │
│ └────────────┘   └────────────┘                ▲                │
│                                                │                │
│ ┌────────────┐                                 │                │
│ │ smartperfetto CLI                            │                │
│ │ backend/src/cli-user/                        │                │
│ └──────────────────────────────────────────────┘                │
│            直接 import，不走 HTTP                               │
└─────────────────────────────────────────────────────────────────┘
```

CLI 和 Express 路由是 agentv3 的**两个对等前端**。两者都通过
`AgentAnalyzeSessionService.prepareSession()` 入场，通过
`ClaudeRuntime.analyze()` 跑分析，通过 `getHTMLReportGenerator()` 生成
报告，通过 `SessionPersistenceService` 写 SQLite —— **唯一的差别是
CLI 用终端渲染 + 本地文件夹，Express 用 SSE + `/api/reports/` 端点**。

### 1.2 CLI 内部模块分层

```
backend/src/cli-user/
│
├── bin.ts                       shebang 入口、commander argv 分发
├── bootstrap.ts                 env 加载 + 凭证校验 + 路径初始化
├── constants.ts                 DEFAULT_ANALYSIS_QUERY 等常量
├── types.ts                     CliSessionConfig / CliTranscriptTurn schema
│
├── commands/                    每个子命令一个文件（thin wrappers）
│   ├── analyze.ts               ─┐
│   ├── resume.ts                 ├─ 调 turnRunner
│   ├── list.ts                   │
│   ├── show.ts                   ├─ 纯本地 FS，不需要 LLM 凭证
│   ├── report.ts                 │
│   └── rm.ts                    ─┘
│
├── repl/                        REPL 专属逻辑
│   ├── index.ts                 主循环 + readline + Ctrl+C 状态机
│   ├── slashCommands.ts         /load /ask /resume /report /focus /clear /exit 解析
│   └── renderer.ts              StreamingUpdate → 终端（打字机 + 框）
│
├── services/                    CLI 业务逻辑，和 agentv3 的粘合层
│   ├── cliAnalyzeService.ts     CliAnalyzeService facade:
│   │                              • prepareSession + orchestrator.analyze()
│   │                              • persistTurnToBackend (写 SQLite)
│   │                              • buildReportHtml (via 共享 builder)
│   ├── turnRunner.ts            startSession / continueSession:
│   │                              • 被 analyze / resume / REPL 三方共用
│   │                              • 负责 trace (re)load + runTurn + commit
│   └── turnPersistence.ts       commitTurnOutputs:
│                                  • 一次性写 conclusion / turn MD /
│                                    report HTML / config / transcript / index
│
└── io/                          本地文件系统抽象
    ├── paths.ts                 ~/.smartperfetto/ 路径解析
    ├── sessionStore.ts          读写 session 文件夹（config/conclusion/...）
    ├── indexJson.ts             全局 index.json 原子更新
    ├── transcriptWriter.ts      transcript.jsonl / stream.jsonl 追加写
    └── openFile.ts              跨平台 open（macOS open / Linux xdg-open）
```

**关键设计约束**：
- `commands/` 里**没有业务逻辑**，只做参数解析 + 生命周期（`new
  CliAnalyzeService` / `service.shutdown()`）+ 调 `turnRunner`。
- `services/turnRunner.ts` 是**三个入口（analyze / resume / REPL）共用
  的唯一 turn 主流程**。任何新 feature（比如未来的 scenes 或
  report rebuild）都应该从这里扩。
- `io/` 只干 FS 动作，不含 orchestrator 或 LLM 概念。

### 1.3 数据流 —— analyze（新建 session）

```
smp -f <trace> -p "..."
# 等价高级命令：
smartperfetto analyze <trace> --query "..."
       │
       ▼
commands/analyze.ts         bootstrap() + new CliAnalyzeService()
       │
       ▼
services/turnRunner.ts      startSession({tracePath, query})
       │
       ├──▶ CliAnalyzeService.loadTrace(path)
       │         │
       │         └──▶ TraceProcessorService.loadTraceFromFilePath()
       │              → copy 到 uploads/traces/<traceId>.trace
       │              → spawn trace_processor_shell (9100-9900 port pool)
       │              → returns traceId
       │
       ├──▶ CliAnalyzeService.runTurn({ traceId, query, onEvent })
       │         │
       │         ├──▶ AgentAnalyzeSessionService.prepareSession()
       │         │         → 生成 sessionId
       │         │         → 构造 ClaudeRuntime
       │         │
       │         ├──▶ onSessionReady(sessionId)  ◀──── CLI 早拿 sessionId
       │         │                                     → 创建 session 文件夹
       │         │                                     → stream.jsonl 开写
       │         │
       │         ├──▶ orchestrator.analyze(query, sessionId, traceId)
       │         │         │
       │         │         └─▶ Claude Agent SDK
       │         │              事件 ──▶ onEvent ──▶ renderer + stream.jsonl
       │         │
       │         ├──▶ persistTurnToBackend():
       │         │      orchestrator.takeSnapshot()
       │         │      → SessionPersistenceService.saveSessionStateSnapshot()
       │         │      → appendMessages (user + assistant)
       │         │      → session._lastSnapshot = snapshot
       │         │
       │         └──▶ buildAgentDrivenReportData + generateAgentDrivenHTML
       │                                                    │
       │                                       ┌────────────┘
       ▼                                       ▼
services/turnPersistence.ts commitTurnOutputs():
       │                      • writeConclusion(sp, result.conclusion)
       │                      • writeTurnMarkdown(sp, 1, markdown)
       │                      • writeReportHtml(sp, html)
       │                      • writeConfig(sp, {sessionId, sdkSessionId,...})
       │                      • appendTranscriptTurn(sp.transcript, turn)
       │                      • upsertSession(paths, indexEntry)
       │                      • renderer.printConclusion + printCompletion
       │
       ▼
exit 0
```

### 1.4 数据流 —— resume（继续已有 session）

```
smartperfetto resume <sessionId> --query "follow-up"
       │
       ▼
commands/resume.ts + services/turnRunner.ts.continueSession()
       │
       ├──▶ loadSession(paths, sessionId)
       │      → 读 ~/.smartperfetto/sessions/<id>/config.json
       │      → 取出 traceId / tracePath / sdkSessionId / turnCount
       │
       ├──▶ CliAnalyzeService.reloadTraceById(oldTraceId)
       │      │
       │      └─▶ TraceProcessorService.getOrLoadTrace(oldTraceId)
       │          • 在 uploads/traces/ 找 trace 文件
       │          • 找到：以**原 traceId**重建 processor   ───┐
       │          • 找不到：返回 undefined                 ───┼─▶ 降级分支
       │                                                    │
       ├──▶ 分支 A (Level 1/2)：                            │
       │      service.runTurn({                             │
       │        traceId: oldTraceId,                        │
       │        query: userQuery,                           │
       │        sessionId: userSessionId   ◀── 让 prepareSession 命中 SQLite
       │      })                                            │
       │                                                    │
       │    prepareSession 走 restore 路径：                │
       │      ① SQLite 里 SELECT sessions WHERE id = ?      │
       │      ② loadSessionContext() 恢复 EntityStore       │
       │      ③ 构造新 ClaudeRuntime                        │
       │         → 构造函数 loadPersistedSessionMap()       │
       │         → 找到 sdkSessionId → resume: <sdk>        │
       │      ④ Claude SDK 收到 resume 参数继续对话         │
       │                                                    │
       └──▶ 分支 B (Level 3)：                    ◀─────────┘
              service.loadTrace(tracePath)  // 重新读原路径
              → 得到**新** traceId
              buildPreambleQuery()
              → 把 conclusion.md 截断到 ~1.5KB 作为前缀注入
              service.runTurn({
                traceId: newTraceId,
                query: preambleWrappedQuery,
                sessionId: undefined        ◀── 故意不传，让后端建新 session
              })
              （CLI 仍然写入同一个 session 文件夹，turnCount++）
```

**关键不变式**：

1. CLI 视角的 `sessionId`（文件夹名、index 项）**跨 resume 永远稳定**。
   即便 Level 3 降级，后端创建的新 backend sessionId 也只作为内部细节，
   不暴露到用户视图。
2. `config.json` 的 `sdkSessionId` 在 Level 1/2 resume 后**保持不变**；
   Level 3 会更新为新 SDK session 的 id（因为 SDK context 本来就丢了）。
3. trace_processor RPC 端口（9100-9900）**总是本地占用，和"零 HTTP"不冲突**
   —— 零 HTTP 的承诺是"不起 :3000 / :10000 / 任何用户可见的 HTTP 服务"，
   而不是"不用任何 TCP socket"。

### 1.5 持久化分工

```
~/.smartperfetto/                  CLI 独占 — 可整体备份 / 迁移
├── index.json                     全局 session 目录（list 读这里）
└── sessions/<id>/
    ├── config.json                sessionId ↔ traceId ↔ sdkSessionId 映射
    ├── conclusion.md              最新一轮 Markdown（cat 友好）
    ├── turns/NNN.md               每轮完整答复
    ├── transcript.jsonl           每轮 {question, confidence, duration...}
    ├── stream.jsonl               StreamingUpdate 原始流（debug 用）
    └── report.html                最新 HTML 报告副本

backend/data/sessions/sessions.db  ← SQLite，后端主管
  ├─ sessions                      id, trace_id, question, created_at, metadata
  └─ messages                      id, session_id, role, content, timestamp

backend/logs/
  ├─ claude_session_map.json       SmartPerfetto sessionId → SDK sessionId
  ├─ sessions/*.jsonl              agentv3 内部事件日志
  └─ reports/                      HTTP 路由生成的 report HTML
     （CLI 不写这里，直接写到 ~/.smartperfetto/sessions/<id>/report.html）
```

CLI 的 `~/.smartperfetto/` 只存"用户视角指针"（sessionId + 三大便捷文件），
**真身仍在后端 SQLite**。这就是为什么 resume 跨进程还能恢复 SDK context ——
`sdkSessionId` 通过 `claude_session_map.json` + `sessions` 表两处共同落盘。

### 1.6 与 HTTP 路由共享的模块

被 CLI 和 Express 路由**同时使用**的 agentv3 组件（本次 CLI 引入的
refactor 也把这个名单扩大了）：

| 模块 | 作用 |
|---|---|
| `AgentAnalyzeSessionService` | `prepareSession` 创建 / 恢复 session，构造 orchestrator |
| `ClaudeRuntime` (agentv3) | `analyze()` 入口、EventEmitter 事件流 |
| `SessionPersistenceService` | SQLite 写入 |
| `sessionContextManager` | 单例，内存多轮 context |
| `TraceProcessorService` | trace 加载 / RPC |
| `getHTMLReportGenerator()` | HTML 报告 |
| **`buildAgentDrivenReportData`** | 报告数据组装（HTTP + CLI 共用） |
| **`atomicWriteFileSync` / `atomicWriteFile`** | 原子写入（去重了 3 处复制） |

---

## 2. 安装

正式用户安装：

```bash
# 需要 Node.js 24 LTS
npm install -g @gracker/smartperfetto
smp --help
smp -f trace.pftrace -p "分析启动性能"
```

`smp` 是推荐短命令，`smartperfetto` 是同一个 CLI 的长命令名。第一次分析时，
如果没有 `TRACE_PROCESSOR_PATH` 且本机缺少 binary，CLI 会自动下载固定版本的
`trace_processor_shell` 到 `~/.smartperfetto/bin/trace_processor_shell`。
如果网络无法访问 Google artifact bucket，可以设置 `TRACE_PROCESSOR_PATH` 指向已有
binary，或设置 `TRACE_PROCESSOR_DOWNLOAD_BASE` / `TRACE_PROCESSOR_DOWNLOAD_URL`
指向可信镜像；下载内容仍会按固定 SHA256 校验。
macOS 如果拦截该 binary，在 **系统设置 → 隐私与安全性 → 安全性** 中对
`trace_processor_shell` 点 **仍要打开 / Allow Anyway**，重新运行命令并在弹窗里选择
**打开**；确认来源可信时也可以执行 `xattr -dr com.apple.quarantine /path/to/trace_processor_shell`。

当前源码 checkout 的本地安装方式（发布前验证用）：

```bash
npm install -g ./backend
smp --help
```

也可以手动 build + link：

```bash
cd backend
npm install
npm run build
npm link          # 把 `smp` / `smartperfetto` 放到 PATH 上
```

面向真实用户的正式入口应该始终是安装后的 `smp` / `smartperfetto` 可执行命令，
不是仓库里的 debug 脚本。debug 脚本只给维护者确认 CLI 编译产物或源码路径：

```bash
# 先编译，再运行 dist/cli-user/bin.js；最接近用户安装后的行为
cd backend
npm run cli:build-run -- --help
npm run cli:build-run -- analyze <trace> --query "分析滑动卡顿"
# cli:debug 是同义别名

# 直接用 tsx 跑源码，只用于快速迭代，不验证 dist 产物
npm run cli:dev -- --help
./backend/scripts/smartperfetto-dev analyze <trace>
```

凭证来源，按优先级：

1. `--env-file <path>` 命令行参数
2. `backend/.env`（默认，自动向上找 5 层）
3. `~/.smartperfetto/env`

Claude runtime 需要 `ANTHROPIC_API_KEY`，或 `ANTHROPIC_BASE_URL` 加 `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY`（Claude Code 兼容 provider / API proxy 场景）。OpenAI runtime 使用 `SMARTPERFETTO_AGENT_RUNTIME=openai-agents-sdk`、`OPENAI_API_KEY`、`OPENAI_BASE_URL` 和 `OPENAI_AGENTS_PROTOCOL`。

---

## 3. 使用

### 3.1 REPL（Claude Code 风格的交互模式）

无参数启动：
```bash
smp
smp --resume <sessionId>     # REPL 启动时预加载 session
smartperfetto
smartperfetto --resume <sessionId>     # REPL 启动时预加载 session
```

| 输入 | 说明 |
|---|---|
| `/load <trace>` | 加载 trace + 跑第一轮分析（用内置默认 query） |
| `/ask <question>` | 当前 session 上追问一轮 |
| `<question>`（不带 `/`） | `/ask` 的简写 |
| `/resume <id>` | 切换到另一个已有 session |
| `/report` | 打印当前 session 的 HTML 报告路径 |
| `/report --open` | 顺带用默认浏览器打开 |
| `/focus` | 打印当前 session 元数据（id / trace / turns / 目录） |
| `/clear` | 清屏 + scrollback |
| `/help` | slash 命令参考 |
| `/exit`（或 `/quit`） | 退出 |

**多行输入**：行尾 `\` 表示续行，下一行 `...` prompt 继续接；只输入
一个裸 `\` 取消续行状态。

**Ctrl+C 语义**：
- 空闲时按一次：提示"再按 Ctrl+C 退出"，清掉任何未完成续行
- 空闲时 1.5s 内按第二次：退出进程
- Turn 正在跑：第一次按提示"turn 进行中，再按强退"；第二次按 exit 130（注意：
  Claude Agent SDK 子进程可能成为孤儿，按 `pkill -f trace_processor_shell`
  清理）

### 3.2 One-shot 子命令（脚本 / CI 用）

```bash
# 推荐短命令
smp -f <trace> -p "question"
smp -f <trace> --prompt "question"

# 新建 session
smartperfetto analyze <trace> [-q "question"]

# 追问
smartperfetto resume <sessionId> -q "follow-up question"

# 历史
smartperfetto list [--json] [--limit N] [--since <date>]

# 查看
smartperfetto show <sessionId> [--open]
smartperfetto report <sessionId> [--open]

# 删除（本地文件夹 + index，不动后端 SQLite）
smartperfetto rm <sessionId> [--yes]
```

### 3.3 全局 flags

| Flag | 默认 | 用途 |
|---|---|---|
| `-f, --file <trace>` | 无 | 顶层 one-shot 分析入口，等价于 `analyze <trace>` |
| `-p, --prompt <question>` | 默认分析问题 | 顶层 one-shot prompt |
| `-q, --query <question>` | 默认分析问题 | `--prompt` 的兼容别名 |
| `--session-dir <path>` | `~/.smartperfetto` | 覆盖 session 存储根目录 |
| `--env-file <path>` | 自动搜 | 指定 `.env` 文件 |
| `--verbose` | off | 显示 tool_dispatched / agent_response 明细 |
| `--no-color` | off | 关闭 ANSI 颜色（或设 `NO_COLOR=1`） |

### 3.4 典型工作流示例

```bash
# 第一次分析
smartperfetto analyze test-traces/lacunh_heavy.pftrace \
  --query "分析启动慢的根因"
# ✓ session agent-1776414160887-73z8z38c
#   dir:    ~/.smartperfetto/sessions/agent-1776414160887-73z8z38c
#   report: ~/.smartperfetto/sessions/.../report.html

# 查看历史
smartperfetto list
# SESSION                       LAST TURN  STATUS     TURNS  TRACE              QUERY
# agent-1776414160887-73z8z38c  1m ago     completed  1      lacunh_heavy...    分析启动慢的根因

# 多轮追问
smartperfetto resume agent-1776414160887-73z8z38c \
  --query "Phase 2.6 的 JIT 热点函数是哪些？"

# 把报告丢给浏览器
smartperfetto report agent-1776414160887-73z8z38c --open
```

---

## 4. Resume 语义（三级降级）

以 plan §G.3 为准；运行行为：

| 情况 | 判断依据 | CLI 行为 |
|---|---|---|
| **Level 1** 完整 resume | `backend/uploads/traces/<traceId>.trace` 存在 + SDK context 未过期 | 保持 traceId + sdkSessionId，`prepareSession` 走 restore 分支；SDK 收到 `resume: <sdkSessionId>` 继续同一对话 |
| **Level 2** SDK 上下文过期 | trace 还在但 SDK 内部 session 已清 | 和 Level 1 同路径，SDK 侧静默起新 session；CLI 检测不到也不追究 |
| **Level 3** Trace 被驱逐 | `uploads/traces/` 里找不到 `<traceId>.trace` | 从 `config.json` 里的原 `tracePath` 重新 load（得新 traceId），query 前缀注入上一轮 conclusion（截断到 ~1.5 KB），作为新 backend session 跑；CLI 文件夹仍用原 sessionId |

如果 `tracePath` 本身也失效（比如被移走），resume 报错并要求
`smartperfetto analyze <新路径>`。

---

## 5. CI / 非 TTY 用法

- `list` / `show` / `report` / `rm` 不需要 LLM provider 凭证，CI 里
  只做结果查询安全。
- `rm` 在非 TTY stdin 下拒绝运行（避免挂在确认 prompt），脚本里必须加
  `--yes`。
- `list --json` 输出纯 JSON（dotenv 的 tip 行已通过 `quiet: true` 抑制），
  可以直接管道给 `jq`。

---

## 6. Crash semantics

CLI 写入跨三个存储位置（`~/.smartperfetto/sessions/<id>/` + `backend/data/sessions/sessions.db`
+ `backend/logs/claude_session_map.json`）。如果进程在写入中途 crash，下一次 `resume`
能否正常继续取决于失败时机：

| 失败时机 | 后果 | 下次 `resume` 行为 |
|---|---|---|
| `analyze()` 进行中 crash | session.db 无 row、map 无 entry、CLI 文件夹只有部分 stream.jsonl | `resume` 报 "no session found"；用户可重跑 `analyze` |
| `persistAgentTurn` 失败 | snapshot 已 stash 在内存，未落盘到 SQLite；CLI 文件夹后续步骤继续写 | `resume` 报 "no session found"（SQLite 没记录）；conclusion.md 是孤儿 |
| `persistAgentTurn` 成功，但 `commitTurnOutputs` 中途 crash | SQLite + map 完整；CLI 文件夹可能缺 conclusion.md / report.html / config.json | 取决于 config.json 是否写入：写了就能 resume，没写就要从 SQLite 手动恢复 |
| 全部成功后 crash | 一致状态 | 正常 resume |

`config.json` 用 atomic write（tmp + rename），所以它要么是新内容要么是上一轮内容，永远不会半写。
`conclusion.md` / `turns/NNN.md` / `report.html` 不是 atomic 写的（它们是便利副本，权威信息在
`transcript.jsonl` 和 SQLite 里），crash 窗口内可能是空文件或半写。

**实操建议**：如果一个 session 看起来"卡住"了（list 里能看到但 show 报错），先检查
`~/.smartperfetto/sessions/<id>/config.json` 是否存在且是合法 JSON；不存在就 `rm <id>` 重来。

---

## 7. 已知限制

- **Windows 未支持**：`--open` 依赖 `open` (macOS) / `xdg-open` (Linux)。
- **`report --rebuild` 未实现**：从 `stream.jsonl` 重放生成报告需要
  把事件流翻译回 `AnalyzeManagedSession` 的中间字段，非 trivial。目前
  重新生成报告的方式是 `smartperfetto resume <id> -q <相同问题>`。
- **强退孤儿进程**：双 Ctrl+C `process.exit(130)` 会跳过 finally 的
  `service.shutdown()`，Claude SDK 启动的子进程可能需要手动清理
  （`pkill -f trace_processor_shell`）。

---

## 8. 参考

- Plan：历史内部 plan 已不随开源仓库发布，可参考提交记录里的 `feat(cli)` 系列
- E2E 验证过程：见提交 `525f9942` commit message 和 PR 描述
- 上游 agentv3 架构：`.claude/rules/backend.md` 里的模块索引
- git push 规则：`.claude/rules/git.md`（perfetto 子模块 fork 规则仍适用）
