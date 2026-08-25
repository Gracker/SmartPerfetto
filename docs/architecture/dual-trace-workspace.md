# 双 Trace 工作区操作模型

[English](dual-trace-workspace.en.md) | [中文](dual-trace-workspace.md)

本文定义 Web UI Raw Trace Compare 的双窗操作模型。它补充
[架构总览](overview.md)中的对比模式说明，重点覆盖用户操作、AI Panel
上下文、前后端协同和边界条件。Analysis Result Compare 仍走
workspace comparison API，不属于本文范围。

## 产品原则

- 默认仍是单窗。用户打开普通 Trace 后只看到一个 Perfetto timeline 和 AI Panel。
- 无 Trace 的 AI Assistant 首页也提供“双 Trace”入口。用户可以先打开两个空 pane，再分别把两份本地 Trace 上传到基线侧和对比侧。
- AI Panel header 提供一个直达的“打开双窗”按钮。点击后立即打开双窗壳：左/上窗口把当前页面 Trace 作为初始基线，右/下窗口为空，等待用户选择对比 Trace；不需要先进入 trace picker。
- 空 pane 提供“上传 Trace”，已有内容的 pane 提供“替换”。两侧上传状态和错误相互独立，可以并行上传；active run 或 stop pending 时两侧都锁定。
- 两个物理窗口都有 Trace selector。左/上稳定代表基线，右/下稳定代表对比；两个 selector 都可以从当前 workspace 任意选择 Trace。
- 历史 Trace 的可见名称以 `filename` 为主，上传时间和大小只作为次要信息；Trace id 只用于身份识别，不作为用户需要理解的主标签。
- 当前页面 Trace 只保存在 `pageTrace` 中作为首次默认值和宿主生命周期边界，不强制参与 pair；支持任意“历史 A + 历史 B”。兼容请求角色 `current/reference` 分别表示基线/对比。
- 选择另一侧已经显示的 Trace 或点击“交换”时，基线/对比原子互换；不会产生重复 Trace 或中间同侧身份。
- 布局切换、最大化、最小化以及 AI Panel 的隐藏/再次显示只改变展示状态，不销毁或重新加载已经存在的 iframe。
- 双窗 header 常驻明确的“AI 助手”按钮，作为工作区内收起/恢复对话面板的入口；它不会改变 workspace controller、iframe 身份、当前 run 或 SSE owner。
- 分析运行中或正在等待停止确认时，`baseline + comparison + agent session/run`
  组成同一个运行身份。此时 selector、新建 pair、退出对比、切换会话、New Chat、
  Provider、workspace、backend URL 和 backend access token 都不能改变该身份；
  左右/上下、拖拽、最大化、最小化、AI Panel 隐藏/恢复，以及为相同 pair 重新打开
  视觉双窗仍然可用。只有显式 Stop 进入后端取消协议。
- AI Panel 收起采用视觉折叠并保留同一个 Panel 与 SSE owner；即使 `/analyze` 尚未返回
  session id，展开后也仍能停止同一个请求。分析期间会改变 Panel 挂载点的 Pop Out/Dock
  操作延后到终态，避免把请求所有权留在已卸载实例中。
- 显式退出双窗、当前页面 Trace unload 或 workspace 切换才销毁双窗 iframe。退出双窗只关闭视觉工作区；已有 pair 和 AI 对比上下文仍可保留。退出对比则进一步清掉 pair、对比上下文和对比 agent session。
- 双窗 iframe 不拥有新的 AI session，也不重复上传 Trace。它们只作为完整 Perfetto timeline 视图使用。
- 本地/API-key 模式把 pair、布局、split 和双窗开关持久化到当前 backend/workspace 作用域；刷新页面或正常重启后端后，只要后端仍保留 Trace 和完成态分析记录，就直接恢复。未完成的 run 不伪装成继续运行，而是显示为已中断。

## 状态机

| 状态 | UI 表现 | 后端对比能力 | 进入条件 | 退出条件 |
| --- | --- | --- | --- | --- |
| Dual workspace empty | 两个空 pane，各自可上传 Trace | 无 Trace 工具 | 无 Trace 的 AI Assistant 首页点击“双 Trace” | 上传第一份 Trace、显式退出或切换 workspace |
| Single trace | 单 timeline + AI Panel | 单 Trace 工具 | 打开普通 Trace、退出对比、切换 workspace、新 Trace reset | 点击“打开双窗” |
| Dual workspace draft | 一个 timeline + 一个可上传/选择的空窗口 | 仍是单 Trace 工具 | 上传第一份 Trace，或在普通 Trace 页点击“打开双窗” | 上传/选择第二份 Trace、显式退出、切换 Trace/workspace |
| Dual workspace paired | 同页两个完整 timeline，每个窗口都有任意 Trace selector | `traceId/referenceTraceId` 分别绑定基线/对比，comparison tools 可用，并带视觉布局状态 | 第二个 selector 选择不同 Trace | 显式退出双窗、退出对比、切换 Trace/workspace |
| Comparison context | 单 timeline + 对比栏 | `referenceTraceId` 和 comparison tools 仍可用 | 已配对时显式退出双窗 | 再次打开双窗、退出对比、切换 Trace/workspace |
| Pane minimized | 一个 live iframe + 一个最小化 rail | 两侧仍可分析，最小化侧标记为 `context_only` | 点击 pane 最小化 | 点击 rail 还原、重置、最大化另一侧、退出 |
| Pane maximized | 一个 iframe 占满工作区 | 最大化侧 `live`，另一侧 `context_only` | 点击 pane 最大化 | 再点恢复、重置、退出 |

## 加载与打开流程

### 1. 无 Trace 时直接打开双窗

1. 用户在无 Trace 的 AI Assistant 首页点击“双 Trace”。
2. Conversation Page 创建一个没有 `pageTrace` 的 workspace controller，立即显示两个空 pane。
3. 用户在左/上和右/下分别选择本地文件。每个 pane 独立调用现有 backend uploader，上传成功后把返回的 workspace Trace 绑定到该侧；两侧可以并行。
4. 第一份成功后进入 draft，第二份不同 Trace 成功后进入 paired；某一侧失败只在该侧显示错误，不清掉另一侧已完成的上传。
5. pair 完整后，父页面通过 `smartperfettoWorkspaceTraceId` 打开基线 Trace 的主 Viewer。主 Viewer 从同一 workspace 的持久化快照恢复 controller、两侧 iframe 和 AI comparison context。

OIDC 模式仍是 page-local trace 所有权，不能让父页面从 backend workspace URL
重新打开任意上传 Trace，因此无 Trace 双窗入口禁用并明确解释。本节只适用于本地/API-key
模式。

### 2. 普通 Trace 加载

1. 用户通过 Perfetto UI 打开 trace。
2. 前端后台上传 trace 到 `/api/traces/upload` 或使用已有 HTTP RPC target。
3. `backendTraceId` ready 后，AI Panel 显示可分析状态。
4. 此时 `referenceTraceId = null`，双窗工作区尚未打开。

如果后台 trace 尚未 ready，对比入口不展示或不可用；双窗不能在缺少 current
backend trace id 的状态打开。

### 3. 从普通 Trace 直达打开双窗

1. 用户点击 AI Panel header 的“打开双窗”按钮。
2. 前端只要求 current `backendTraceId` 已 ready，不要求预先存在 `referenceTraceId`。
3. Trace 作用域的 workspace controller 立即打开 `ai-trace-pair-workspace`：默认第一个窗口显示页面 Trace 作为基线，第二个窗口显示“请选择对比 Trace”的空态。
4. 前端同时读取当前 workspace 的完整 Trace 列表，并把页面 Trace 与 catalog 去重合并为两侧候选。
5. 每条历史记录以 `filename` 为主标签；只有同名记录需要区分时才追加本地化上传时间和文件大小。相同 filename 的不同记录仍分别保留，由 id 区分。

此时用户已经进入可操作的双窗壳，但在选择对比 Trace 之前仍是单 Trace AI
上下文，不发送 `referenceTraceId`，也不启用 comparison tools。

### 4. 在任一窗口选择或上传 Trace

1. 两个窗口的 selector 都列出页面 Trace 和所有可用历史 Trace。
2. first（左/上）选择器直接更新基线；second（右/下）选择器直接更新对比。
3. 任一侧选择另一侧已显示的 Trace 时，前端原子交换基线/对比；显式“交换”按钮执行相同操作。
4. pair 完整后，前端把基线保存为 `tracePairBaselineBackendTraceId`，并继续用 `referenceTraceId/referenceTraceName` 保存对比侧，以兼容现有会话/API。
5. 两侧必须是不同 Trace，但允许形成“历史 A + 历史 B”。
6. 空侧可直接上传；已有内容的一侧可用“替换”上传新 Trace。成功后沿用同一选择转移和 session 失效规则。

更换一侧只更新该侧 iframe 的 URL；显式交换会复用同一 pair 的两个 Trace 文件，但反转
`traceId/referenceTraceId` 和 delta 方向。任何 pair 身份或方向变化都会废弃不兼容的
Agent continuation。

### 5. iframe 加载

双窗打开后，已有 Trace 的 pane 创建 same-origin iframe：

- `hideSidebar=true`
- `mode=embedded`
- `smartperfettoDualTrace=true`
- `smartperfettoPane=current|reference`
- `url=/api/workspaces/:workspaceId/traces/:traceId/file`

`load_trace.ts` 看到 `smartperfettoDualTrace=true` 后跳过 AI backend upload。每个
iframe 使用 Perfetto UI 自己的 WASM engine 加载完整 timeline。空对比窗口不
创建 iframe，直到用户选择第二份 Trace。

双窗 iframe 是完整 Perfetto timeline，用户可以在每一侧独立搜索、缩放、
选择、展开 track 和查询。主 AI Panel 仍然是唯一对话入口。

## 双窗内操作

| 操作 | 用户入口 | 状态变化 | AI 上下文影响 |
| --- | --- | --- | --- |
| 上传/替换 Trace | pane 的上传控件 | 只更新目标 pane；两侧进度/错误独立；上传成功后加入 catalog 并执行该侧选择 | pair 完整前不启用 comparison tools；pair 身份变化会重置不兼容 session |
| 为窗口选择 Trace | 两个 pane 的 selector | first 更新基线，second 更新对比；选择另一侧已有 Trace 时交换 | `primarySide/referenceSide` 固定映射 first/second；任一 pair 身份变化会重置不兼容的 comparison session |
| 交换基线/对比 | Workspace toolbar | 原子交换两个 Trace 身份并保留布局 | 反转 `traceId/referenceTraceId` 与 delta 方向，重置不兼容 session |
| 左右/上下切换 | 工作区右上工具按钮 | `tracePairLayout = horizontal|vertical`，取消最大化；保留两个 iframe 节点 | `primarySide/referenceSide` 从 left/right 切到 top/bottom |
| 拖拽 splitter | 中间分割线 | `tracePairSplitPercent` 更新，限制在 18 到 82 | `splitPercent` 进入 `tracePairContext` |
| 最大化一侧 | pane toolbar | `tracePairMaximizedTraceSide = current|reference`，清空 minimized；iframe 仍挂载 | 最大化侧 `live`，另一侧 `context_only` |
| 最小化一侧 | pane toolbar | `tracePairMinimizedTraceSides = {side}`，取消最大化；iframe 仍挂载 | 最小化侧 `context_only`，另一侧 `live` |
| 还原最小化 | minimized rail | 从 minimized set 删除该侧；复用原 iframe | 该侧恢复 `live` |
| 在新标签页打开 | pane toolbar | 不改变当前对比状态 | 只是辅助查看；新标签页仍是 embedded trace URL |
| 隐藏/再次显示 AI Panel | AI Panel 入口 | 只切换对话面板；双窗 host、controller 和 iframe 保持 | 无变化 |
| 退出双窗 | 工作区 header | 关闭视觉工作区并销毁其 iframe，清掉 max/min | 已有对比上下文保留，workspaceOpen 变 false |
| 退出对比 | 对比栏退出按钮 | 无 active run 时清掉 pair、agent session、双窗状态；运行中禁用 | 后续请求回到单 Trace |

双窗 host 属于当前 Trace 生命周期，与 AI Panel 的 Right/Bottom/浮窗/隐藏状态平级。
布局切换、最大化、最小化以及 AI Panel hide/show 都复用相同的语义 iframe 节点和
`src`。只有显式退出双窗、page Trace unload 或 workspace 切换会销毁这些 iframe；
再次打开时才重新创建。选择新的基线或对比 Trace 只重新加载对应一侧。

## AI Panel 上下文契约

前端发送分析请求时，如果 `referenceTraceId` 存在：

```json
{
  "traceId": "baseline-trace-id",
  "referenceTraceId": "comparison-trace-id",
  "options": {
    "tracePairContext": {
      "schemaVersion": 1,
      "layout": "horizontal",
      "primarySide": "left",
      "referenceSide": "right",
      "activeSide": "right",
      "workspaceOpen": true,
      "splitPercent": 50,
      "panes": [
        {
          "side": "left",
          "traceSide": "current",
          "traceId": "baseline-trace-id",
          "traceName": "baseline.perfetto-trace",
          "active": false,
          "visualState": "live"
        },
        {
          "side": "right",
          "traceSide": "reference",
          "traceId": "comparison-trace-id",
          "traceName": "comparison.perfetto-trace",
          "active": true,
          "visualState": "live"
        }
      ],
      "aliases": {
        "左侧": "current",
        "右侧": "reference",
        "上方": "current",
        "下方": "reference",
        "基线": "current",
        "对比": "reference",
        "当前": "current",
        "参考": "reference"
      }
    }
  }
}
```

规则：

- 请求顶层 `traceId` 是 first 窗口选择的基线；`referenceTraceId` 是 second 窗口选择的对比 Trace。它们都可以是历史 Trace。
- `current` 与 `reference` 仅是 API/工具兼容角色，分别代表基线/对比。`primarySide/referenceSide`、`panes[].side` 和位置 aliases 固定映射到 first/second。
- 任一侧选择另一侧已有 Trace 时，前端必须原子交换两个身份，不能短暂构造重复 Trace。
- 交换或更换任一 Trace 都会改变比较方向或 pair 身份，必须断开不兼容的旧 comparison session。
- `activeSide` 由用户最近 hover/focus 的 pane 决定；双窗未打开时默认 current。
- `visualState=live` 表示该 pane 当前可见；`context_only` 表示它仍可分析，但不是当前可见窗口。
- 后端 normalize 会丢弃非法 side、非法 layout、重复 minimized side，并把 split 限制在 18 到 82。
- System prompt 中只注入结构化映射，不把双窗 UI 文案当作 durable prompt 内容。

## 前后端协同

| 层 | 责任 |
| --- | --- |
| 无 Trace Conversation Page | 提供零起点双窗入口、两个 pane 的 backend upload，并在 pair 完整后把基线交给主 Viewer |
| Perfetto UI 主页面 | 打开 page Trace；恢复持久化 pair；在页面 Trace 生命周期内持有 workspace controller、上传 handler 和双窗 host，使其不依赖 AI Panel 是否挂载 |
| AI Panel | 提供直达“打开双窗”入口、加载 workspace 目录、构造 `tracePairContext`、发送基线 `traceId` 与对比 `referenceTraceId` |
| 双窗 pane 控件 | 以 filename 为主显示 page/history Trace，上传或替换目标侧，并维护稳定的基线/对比选择和原子交换 |
| 双窗 iframe | 用 workspace trace file URL 加载完整 Perfetto timeline；展示状态变化时保持节点和 `src`，不创建新的对比 session |
| `load_trace.ts` | 识别 `smartperfettoDualTrace=true` 并跳过后台 AI upload；主 Viewer handoff 时保留 workspace Trace launch 参数 |
| Workspace persistence | 按 backend URL/workspace 保存双窗开关、pair、布局和 split；只在本地/API-key 模式恢复 |
| Backend analyze route | 校验/normalize `tracePairContext`，把 `referenceTraceId` 传给 runtime |
| MCP registry | 只有存在 `referenceTraceId` 时暴露 comparison tools |
| Agent runtime | 使用 shared comparison methodology，按基线/对比或 left/right/top/bottom 取证；工具层兼容 current/reference |
| Report/snapshot | 保留 raw trace comparison 的 evidence/report/session snapshot 合约，和 CLI `smp compare` 对齐 |

## 边界条件

### 当前 trace 尚未 ready

普通 Trace 页的入口依赖 `isInRpcMode && hasBackendTrace`；尚未 ready 时不能把该 Trace
作为初始基线。无 Trace 首页是另一条合法入口：它可以创建两个空 pane，并由 pane upload
建立 backend Trace 身份。

### 没有可用对比 Trace

双窗仍会立即打开：可以是默认基线 + 空对比窗口，也可以是两个空 pane。空 pane 提供
上传入口；两个 selector 使用去重后的同一候选目录，状态机拒绝自对比。

### 刷新页面或后端重启

本地/API-key 模式按 backend URL 和 workspace 恢复最后一次双窗开关、pair、布局与 split。
Trace 文件、完成态 session、report 和 snapshot 继续由现有 backend workspace 存储负责；
只要后端没有退出并清理这些资源，刷新或正常重启后仍可重新打开。前端不把 active run
的连接状态写成可续跑状态；恢复时，后端已标记的中断/失败/完成终态按记录展示。

### 任一 pair Trace 文件不可读

双窗 iframe 会在对应 pane 内表现为 Perfetto 加载失败；AI 分析请求仍会由后端
trace service/SQL 工具报错。UI 不应静默把失败侧换成其他 trace。

### 用户切换新 Trace

新 Trace reset 必须回到 Single trace：

- 清空基线/对比 pair 身份
- 关闭双窗并销毁已有 iframe
- 清空 max/min 状态
- 清空旧 comparison session bridge
- 创建或恢复新 Trace 自己的单 Trace session

这样避免旧 pair 被误套到新 page Trace。

### 用户切换 workspace

workspace 切换会销毁双窗 iframe，并清掉 Trace 列表、pair、双窗状态和 agent session。
新的 trace file URL 必须使用新 workspace 的
`/api/workspaces/:workspaceId/traces/:traceId/file`。

### 用户退出双窗后继续对话

`referenceTraceId` 仍然存在，所以后续问题仍是双 Trace raw comparison。模型会看到
`workspaceOpen=false`，应理解为“视觉双窗已退出并释放 iframe，但 reference Trace 仍可分析”。
再次点击“打开双窗”会为相同 pair 重新创建 iframe。

### 用户退出对比后继续对话

退出会清掉 `referenceTraceId` 和对比 agent session。后续请求不注册 comparison tools，
也不携带 `tracePairContext`。

### 最小化/最大化后继续对话

AI 不应把隐藏侧当作不存在。隐藏侧仍可通过 SQL/Skill 分析，只是在回答中标注它是
context-only。最大化、最小化、还原和布局切换只使用 CSS/状态改变可见性，两个已加载
iframe 的 DOM 节点和 `src` 保持不变。只有 Trace 加载或 backend 查询失败，才算该侧不可用。

### AI Panel 隐藏或位置切换

AI Panel 的隐藏/再次显示以及 Right/Bottom/浮窗位置只影响对话面板，不卸载双窗，
不改变基线/对比语义，也不重新加载 iframe。双窗 host 是 Trace 页面级视图。

### 用户通过 selector 调整窗口内容

first 更新基线，second 更新对比；任一侧都可以选择 page Trace 或历史 Trace。选择另一侧
已有 Trace 或点击“交换”会原子交换两侧。选择新的 Trace 只加载对应 iframe；允许形成
任意“历史 A vs 历史 B”的 pair。

### 多轮 session

进入对比会断开不兼容的单 Trace agent session。退出对比也会断开 comparison session。
Provider/runtime pinning 继续遵守普通 session 规则，不能因为对比模式静默切换 provider。

## 完成标准

双 Trace 工作区相关改动完成前，需要至少证明：

- 普通打开 Trace 时默认是单窗。
- 无 Trace 的 AI Assistant 首页可以打开两个空 pane，并把两份新本地 Trace 并行上传到指定侧。
- 已有 pane 可以独立替换 Trace；单侧失败不影响另一侧，active run/stop pending 时上传与替换锁定。
- 点击 AI Panel header 的“打开双窗”后，立即出现默认基线 + 空对比窗的双窗壳，无需先选历史 Trace。
- 两个窗口的 selector 都可用；支持任意两个不同 workspace Trace，并在选择对侧已有 Trace 时原子交换。
- 历史项以 filename 为主、时间和大小为辅，相同 filename 的不同 id 仍可分别选择。
- 选择对比 Trace 后同页出现两个完整 Perfetto timeline；当前页面 Trace 不必留在 pair 中。
- 左右/上下、拖拽、最小化、最大化和 AI Panel hide/show 不会替换或重新加载已有 iframe。
- 分析运行中 selector 和所有会话身份切换入口保持锁定，但布局操作、AI Panel
  hide/show 和相同 pair 的视觉重开不会停止或替换当前 run。
- 运行中 Settings、workspace、backend URL/access token 和 Provider 写操作保持锁定；
  pre-session hide/show 保留同一个 Stop owner，已建立的 SSE 也不会因折叠而重连。
- 显式退出双窗、Trace unload 和 workspace switch 会销毁 iframe；退出对比会额外清掉 pair 和 comparison session。
- 双窗 iframe 不会新增后台 trace 上传。
- 双窗 iframe 只保留时间线与父窗重绘桥，不注册 AI Panel、状态入口或独立 session owner。
- 完整 pair 从无 Trace 页面交接到主 Viewer 后，基线、对比、布局和 AI context 保持一致。
- 页面刷新和正常后端重启后可恢复最后的本地/API-key pair 与布局；未完成 run 明确显示为中断而不是伪续跑。
- Stop 请求携带当前回执的精确 `runId`；同一 session 的新 run 要等旧 runtime 真正退出后才可启动，
  因而旧 run 的迟到清理不能中止或污染新 run。
- `tracePairContext` 在任意基线/对比组合、显式交换、双窗打开/退出、上下布局、max/min 状态下都符合契约。
- Backend normalize 和 system prompt 能稳定处理非法/缺失字段。
- `frontend/` 预构建已刷新，`./start.sh` 路径能拿到相同行为。
