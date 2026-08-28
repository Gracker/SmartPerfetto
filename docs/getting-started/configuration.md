# 配置指南

[English](configuration.en.md) | [中文](configuration.md)

SmartPerfetto 本地源码运行时可以直接使用 Claude Code 的本地认证/配置；如果这个终端里的 `claude` 已经能正常写代码，可以不创建 `.env`。这既包括 Claude Code 官方订阅，也包括 Claude Code 已经配置好的第三方 base URL + API key。需要显式配置 API key、代理或 Docker 运行时，再使用 env 文件。

Windows 免安装包用户先按 [Windows 配置与运行指南](windows.md) 完成下载、解压和启动，
再使用本页的 Provider 字段。不要为普通 Windows 使用流程照抄 Unix 源码命令。

## 先回答：应该配置哪个 Runtime？

Claude Code、OpenAI Agents SDK、Pi Agent Core、OpenCode 和 Qoder Agent SDK 是互斥可选的运行路径，不是都要完成的配置清单。第一次配置只选一个来源：

| 你现在有什么 | 推荐选择 | 需要配置 |
|---|---|---|
| 不想碰 env、正在用 Docker 或免安装包 | UI Provider Manager | 在 `Providers` 页填写 provider key，测试后激活 |
| 本地源码运行，且同一终端里的 `claude` 已经可用 | Claude Code 本地配置 | 不需要 `.env`，也不需要 `OPENAI_*` |
| Anthropic API key 或 Claude/Anthropic-compatible provider | Claude Agent SDK | `ANTHROPIC_*` + `CLAUDE_*` |
| OpenAI API key、Ollama 或 OpenAI-compatible provider | OpenAI Agents SDK | `SMARTPERFETTO_AGENT_RUNTIME=openai-agents-sdk` + `OPENAI_*` |
| Pi Agent Core model 配置 | Pi Agent Core | custom Provider Manager profile，或 `SMARTPERFETTO_AGENT_RUNTIME=pi-agent-core` + `SMARTPERFETTO_PI_AGENT_CORE_MODEL_JSON` |
| OpenCode model 配置 | OpenCode | custom Provider Manager profile，或 `SMARTPERFETTO_AGENT_RUNTIME=opencode` + OpenAI-compatible 字段或 `SMARTPERFETTO_OPENCODE_MODEL_JSON` |
| Qoder CLI 登录态或 PAT | Qoder Agent SDK | 显式安装 Qoder SDK 后，使用 custom Provider Manager profile 或 `SMARTPERFETTO_AGENT_RUNTIME=qoder-agent-sdk` |

如果一个第三方 provider 同时给了 Claude-compatible 和 OpenAI-compatible 两组 endpoint，UI 里可以保存两组地址和同一个共享 key，但运行时仍只会激活其中一侧。只用 `.env` 时，解注释 Claude-compatible block 或 OpenAI-compatible block 其中一个；不要为了“更完整”把两边都打开。

Perfetto UI 的 AI Assistant 设置面板包含 `Connection`、`Providers`、`Codebases` 和
`自进化 / Evolution`。前两页分别配置 SmartPerfetto 后端和模型 provider profile；
Codebases 管理 code-aware 数据源；自进化页只操作当前已保存后端的受控
Self-Evolution 工作流。`Connection` 页里的高级 backend auth token 是可选项，只在后端
启动时设置了 `SMARTPERFETTO_API_KEY` 才需要填写；它不是第三方大模型 provider key。
模型 provider 凭证可以来自 Claude Code 本地配置、下面的后端/Docker env 文件，也可以
通过前端 `Providers` 页写入后端 Provider Manager。

初学者优先走 UI，最不容易混淆：

1. 启动 SmartPerfetto；免安装包使用启动器打印的实际 `Open:` 地址，Docker 默认打开 `http://localhost:10000`。
2. 打开 **AI Assistant Settings → Providers → Add Provider**。
3. 选择 provider 类型，填写 **Provider API Key**，核对预置 Base URL 和 SDK Runtime。
4. 点击 **Create Provider**。这一步只是保存 profile。
5. 回到 provider 列表，先点插头图标测试连接，再点击 provider 行或在输入框旁的 provider switcher 里选择它来激活。
6. 用带鉴权的 `/api/runtime-health` 验证。`aiEngine.credentialSource=provider-manager` 表示 UI provider 已经生效；`env-or-default` 表示仍在使用 env 或本机 Claude Code fallback。公开 `/health` 只用于存活检查。

active Provider Manager profile 会覆盖 `.env`。如果希望 `.env` 修改重新生效，在 provider switcher 里选择 `System Default`，或在设置里停用 active provider。

预置的 Base URL 来自 provider 公开信息和公开文档，不保证对所有账号、套餐、地区长期正确。很多 provider 的入口会按地区、申请国家、套餐或专属控制台域名变化，例如新加坡区、国内区、国际区可能不同。如果连接、流式输出或 tool/function calling 出错，先到 provider 控制台核对 Base URL、模型 ID 和协议类型；确认是公开 preset 错误后，建议提交 issue 或 PR 修正。

如果选择本地源码的 env 文件路径，后端读取 `backend/.env`。推荐从模板开始：

```bash
cp backend/.env.example backend/.env
```

如果选择 Docker 的 env 文件路径，Docker Hub 镜像和本地 source Docker build 都读取仓库根目录 `.env`：

```bash
cp .env.example .env
```

## Self-Evolution（默认关闭）

Self-Evolution 不会因为已有反馈或已配置 provider 自动启用。源码当前只读取下面两个
Self-Evolution 专用开关：

```bash
# 允许人工显式触发 public feedback 策展、固定 paired evaluation 和提案审阅。
SELF_EVOLUTION_ENABLED=true

# 允许人工 apply/revert；必须同时启用上面的总开关。
SELF_EVOLUTION_APPLY=true
```

两个开关默认都是 `false`。只启用 `SELF_EVOLUTION_ENABLED` 可以策展、运行 gate、
接受/拒绝与查看结果，但不能 apply/revert。`SELF_EVOLUTION_APPLY=true` 还要求通用
user data root 可写、位于程序包之外并满足当前分发方式的持久化检查；否则启动会把
effective apply 降为关闭，API 返回 `503`，不会退回包内临时目录。

设置后重启后端，在 **AI Assistant Settings → 自进化 / Evolution** 查看 requested /
effective 状态。操作权限独立使用 `self_evolution:read`、`curate`、`export`、`apply`
和 `revert`。private feedback 永远不进入策展；贡献包只写本地且不会自动上传。
外部 L2 judge 当前未配置，也没有额外环境变量；未来接入必须逐次明确授权。
从默认关闭到 apply/revert、重启对账和 fail-closed 的完整验收步骤见
[Self-Evolution 使用与验收](self-evolution.md)。

Agent 辅助 GitHub 反馈不需要 `SELF_EVOLUTION_*` 开关。它默认使用
`https://github.com/Gracker/SmartPerfetto/issues/new` 生成未提交草稿。自托管 fork
可以把下面变量设为自己的 HTTPS Issue 新建地址：

```bash
SMARTPERFETTO_EXTERNAL_ISSUE_URL=https://github.example.com/org/repo/issues/new
```

该变量不是 GitHub API token，也不会启用自动提交。Agent review 只复用源 run
固定的 provider/runtime；provider pin 缺失或变化时明确降级。完整边界见
[Agent 辅助 GitHub 反馈](agent-assisted-feedback.md)。

npm CLI 不使用 Web UI 的 `Connection` 配置。第一次用 CLI 时，推荐运行：

```bash
smp config init
```

它会创建 `~/.smartperfetto/env`。没有显式传 `--env-file` 时，CLI 先读取包内/源码目录的 `backend/.env`，再读取 `~/.smartperfetto/env`，后者覆盖前者；如果传了 `--env-file /path/to/env`，CLI 只读取这个文件。CLI 配置方式仍然遵守同一条规则：选择一个 runtime block，不要把所有 block 都打开。

## Codebase 选择与 Provider 授权

`Codebases` 页中的注册项不会自动附加到分析。用户必须在当前请求显式选择 codebase 和
`metadata_only` / `provider_send` 模式。注册且仍可访问的 live root 无需索引就能有界搜索；
reindex 是可选加速。

`metadata_only` 只允许定位相对文件、行号和 `referenceId`。`provider_send` 要求注册时
`sendToProvider` 已开启，并且目标路径同时位于当前 selection 与 consent grant 的交集内。
放宽 path filter、exclude glob 或新增语言不会自动扩大 provider 授权；使用
**授权当前范围** / **授权新语言** 显式更新 grant。

成功的 selection、consent、授权、激活、reindex 或删除如果改变当前可用内容，Web UI 会退役
旧 Agent session 并重置对话，防止新旧权限混用。详细管理、回执与证据语义见
[Code-Aware Analysis](code-aware-analysis.md)。

## LLM 配置

SmartPerfetto 后端支持这些 runtime path：

- `claude-agent-sdk`：默认 runtime。适合 Anthropic、Claude Code 本地认证、Bedrock、Vertex，以及 Anthropic/Claude Code-compatible provider。
- `openai-agents-sdk`：OpenAI runtime。适合 OpenAI Responses API、Ollama 和支持流式 function/tool calling 的 OpenAI-compatible gateway。
- `pi-agent-core`：可选 public runtime。真实模型配置下复用 SmartPerfetto 共享 prompt、SQL/Skill、plan/hypothesis 和 report/claim-verification 管线；后端只在选择这个 runtime 时动态加载 `@earendil-works/pi-agent-core`，不会启用 `.pi` project discovery、package extension、shell tool 或 file tool。
- `opencode`：可选 public runtime。它会启动加固隔离的 OpenCode server，使用显式 OpenAI-compatible 或 OpenCode model 配置，只暴露 request-scoped SmartPerfetto MCP 工具；不会读取用户自己的 OpenCode CLI 登录态、project config、extension，也不会启用内建 file/shell/web/edit tools。
- `qoder-agent-sdk`：可选 public runtime。它只暴露 request-scoped SmartPerfetto MCP 工具，支持本机 `qodercli` 登录态或 PAT，并禁止私有知识分析复用 provider session 或持久化 opaque state。SDK/CLI 有独立条款，因此 SDK 是显式启用的 optional peer，默认不会安装。

这些 runtime 是互斥选择的后端编排路径。配置 OpenAI runtime 时不需要先安装或登录 Claude Code；使用本机 Claude Code 时也不需要配置 OpenAI key。Pi Agent Core、OpenCode 和 Qoder 与两者独立。真实模型路径应通过启动/滑动 E2E 验证分析质量；fake-stream 只用于 smoke/test，不能代表等价分析效果。

运行时选择不会根据“哪个 key 存在”自动猜。优先级是：请求/会话里的 `providerId`、Provider Manager 当前 active provider、`SMARTPERFETTO_AGENT_RUNTIME`、最后默认 `claude-agent-sdk`。首次配置不要同时启用 `ANTHROPIC_*` 和 `OPENAI_*`；如果高级部署确实同时写了两类 env，但没有设置 `SMARTPERFETTO_AGENT_RUNTIME=openai-agents-sdk`，实际仍会走 Claude Agent SDK。active Provider Manager profile 会覆盖 `.env` fallback；当前来源可通过带鉴权的 `/api/runtime-health` 中的 `aiEngine.credentialSource` 和 `aiEngine.providerOverridesEnv` 确认。

Perfetto UI 的 Provider Management 支持把同一个 provider 的两组端点一起保存：`claudeBaseUrl` / `claudeApiKey` / `claudeAuthToken` 对应 Claude Code SDK，`openaiBaseUrl` / `openaiApiKey` / `openaiProtocol` 对应 OpenAI SDK。custom provider 也可以选择 `pi-agent-core`，并填写 `piAgentCoreModelJson` 以及可选 module path / system prompt；选择 `opencode`，填写 `openCodeModelJson` / `openCodeSdkModulePath` / `openCodeSystemPrompt`；或选择 `qoder-agent-sdk`，填写 `qoderAccessToken` / `qoderCliPath` 和可选 model/system prompt 字段。AI 输入框旁的 provider switcher 会显示当前 runtime；对 DeepSeek、Qwen、Kimi、MiMo、TokenHub 或 custom 这类双端点 provider，可以在同一个下拉菜单里显式切换 runtime。切换 provider 或 runtime 会开启新的 SDK/server session。

Enterprise 模式下，Provider Manager 的远端端点默认必须是公网 HTTPS，并会校验 DNS
解析结果；重定向也必须保持同源。确实需要访问经过审计的内网 Ollama/网关时，使用
`SMARTPERFETTO_PROVIDER_PRIVATE_ENDPOINT_ALLOWLIST` 配置精确 origin（协议、主机、端口），
多个 origin 用逗号分隔。该配置不接受 wildcard 或 URL path，也不应扩大为整个私网网段。

DeepSeek、Qwen、Kimi、MiMo、TokenHub、MiniMax、StepFun、SiliconFlow 和 custom gateway 这类双端点 provider，在 UI 里会显示共享 Provider API Key 和可选的 runtime 专用 key override。如果同一个 key 两边都能用，只填共享 key。只有明确要在 Claude-compatible URL 和 OpenAI-compatible URL 之间切换时，才改 SDK Runtime。

已创建的分析 session 会固定当时使用的 credential source。也就是说，一个用 Provider A 创建的 session 恢复后仍尝试使用 Provider A；一个用 `.env` fallback 创建的 session 恢复后不会因为后来设置了 active provider 就改用该 provider。

本机 Claude Code 已经可用时，可以依赖 Claude Code 的本地认证/配置；如果要显式直连 Anthropic API，则配置：

```bash
ANTHROPIC_API_KEY=your_anthropic_api_key_here
```

已经提供 Claude Code / Anthropic 兼容端点的第三方模型，可以从 `backend/.env.example` 里的预置 provider block 开始配置。通常只需要替换 API key/token，并保留 SmartPerfetto 的模型变量名；如果你的账号控制台给出不同 Base URL，以控制台为准：

```bash
ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
ANTHROPIC_AUTH_TOKEN=sk-your-deepseek-key
CLAUDE_MODEL=deepseek-v4-pro
CLAUDE_LIGHT_MODEL=deepseek-v4-flash
```

小米 MiMo Token Plan 示例。下面两段是二选一，不要同时复制到同一个 env 文件里。

```bash
# Anthropic-compatible / Claude SDK
ANTHROPIC_BASE_URL=https://token-plan-sgp.xiaomimimo.com/anthropic
ANTHROPIC_API_KEY=your_xiaomi_mimo_api_key_here
CLAUDE_MODEL=mimo-v2.5-pro
CLAUDE_LIGHT_MODEL=mimo-v2.5
```

```bash
# OpenAI-compatible / OpenAI Agents SDK
SMARTPERFETTO_AGENT_RUNTIME=openai-agents-sdk
OPENAI_BASE_URL=https://token-plan-sgp.xiaomimimo.com/v1
OPENAI_API_KEY=your_xiaomi_mimo_api_key_here
OPENAI_AGENTS_PROTOCOL=chat_completions
OPENAI_MODEL=mimo-v2.5-pro
OPENAI_LIGHT_MODEL=mimo-v2.5
```

当前模板内置的国内主流 Anthropic-compatible / Claude Code-compatible 和 OpenAI-compatible 入口只是公共信息 preset。Provider 模型目录、Base URL 和套餐权限会变化；如果你的账号控制台列出的模型 ID 或专属域名不同，以控制台为准替换对应字段。

下面的表是手动 env 配置和排障参考，不是需要逐项配置的清单。Provider Manager 中可以把同一个 provider 的 Anthropic-compatible URL、OpenAI-compatible URL 和共享 API key 一起预置；用户运行时通过界面选择 SDK Runtime，选择 Claude SDK 就使用 Anthropic-compatible URL，选择 OpenAI Agents SDK 就使用 OpenAI-compatible URL。

| Provider | Claude / Anthropic-compatible Base URL | OpenAI-compatible Base URL | 推荐主模型 | 推荐轻模型 |
|---|---|---|---|---|
| DeepSeek | `https://api.deepseek.com/anthropic` | `https://api.deepseek.com/v1` | `deepseek-v4-pro` | `deepseek-v4-flash` |
| GLM / 智谱 | `https://open.bigmodel.cn/api/anthropic` | `https://open.bigmodel.cn/api/paas/v4` | `glm-5-turbo` | `glm-4.7-flashx` |
| Qwen / 百炼按量 | `https://dashscope.aliyuncs.com/apps/anthropic` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen3.7-plus` | `qwen3.6-flash` |
| Qwen Coding Plan | `https://coding-intl.dashscope.aliyuncs.com/apps/anthropic` | `https://coding-intl.dashscope.aliyuncs.com/v1` | `qwen3-coder-plus` | `qwen3-coder-plus` |
| Kimi Code 会员 | `https://api.kimi.com/coding/` | `https://api.kimi.com/coding/v1` | `kimi-for-coding` | `kimi-for-coding` |
| Kimi / Moonshot 平台 | `https://api.moonshot.cn/anthropic` | `https://api.moonshot.cn/v1` | `kimi-k2.7-code-highspeed` | `kimi-k2.7-code-highspeed` |
| Doubao / 火山方舟 Coding Plan | `https://ark.cn-beijing.volces.com/api/coding` | `https://ark.cn-beijing.volces.com/api/coding/v3` | `doubao-seed-2.0-code` | `doubao-seed-2.0-code` |
| MiniMax 国内 | `https://api.minimaxi.com/anthropic` | `https://api.minimaxi.com/v1` | `MiniMax-M3` | `MiniMax-M3` |
| 小米 MiMo Token Plan | `https://token-plan-sgp.xiaomimimo.com/anthropic` | `https://token-plan-sgp.xiaomimimo.com/v1` | `mimo-v2.5-pro` | `mimo-v2.5` |
| 腾讯 TokenHub Token Plan | `https://api.lkeap.cloud.tencent.com/plan/anthropic` | `https://api.lkeap.cloud.tencent.com/plan/v3` | `tc-code-latest` | `tc-code-latest` |
| 腾讯 TokenHub Coding Plan | `https://api.lkeap.cloud.tencent.com/coding/anthropic` | `https://api.lkeap.cloud.tencent.com/coding/v3` | `tc-code-latest` | `tc-code-latest` |
| 腾讯混元 legacy | `https://api.hunyuan.cloud.tencent.com/anthropic` | `https://api.hunyuan.cloud.tencent.com/v1` | `hunyuan-2.0-thinking-20251109` | `hunyuan-2.0-instruct-20251111` |
| 百度千帆 | `https://qianfan.baidubce.com/anthropic` | `https://qianfan.baidubce.com/v2` | `deepseek-v3.2` | `deepseek-v3.2` |
| 阶跃星辰 Step Plan | `https://api.stepfun.com/step_plan` | `https://api.stepfun.com/step_plan/v1` | `step-3.7-flash` | `step-3.5-flash` |
| 硅基流动 | `https://api.siliconflow.com/` | `https://api.siliconflow.com/v1` | `Qwen/Qwen3-235B-A22B-Instruct-2507` | `Qwen/Qwen3-30B-A3B-Instruct-2507` |
| 华为云 ModelArts MaaS | `https://api.modelarts-maas.com/anthropic` | `https://api.modelarts-maas.com/v1` | `deepseek-v4-pro` | `deepseek-v4-flash` |

Provider 官方文档可能写 `ANTHROPIC_MODEL` / `ANTHROPIC_DEFAULT_HAIKU_MODEL`，但 SmartPerfetto 后端使用 `CLAUDE_MODEL` / `CLAUDE_LIGHT_MODEL`。模型必须稳定支持流式输出和 tool/function calling。
如果百度千帆的自定义应用要求额外 `appid` header，请使用千帆默认 appid，或在前面加一层自定义网关；SmartPerfetto env 文件目前不会注入任意 provider header。

OpenAI 官方 API 不需要伪装成 Anthropic 代理，直接走 OpenAI Agents SDK：

```bash
SMARTPERFETTO_AGENT_RUNTIME=openai-agents-sdk
OPENAI_API_KEY=sk-your-openai-key
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_AGENTS_PROTOCOL=responses
OPENAI_MODEL=gpt-5.4-mini
OPENAI_LIGHT_MODEL=gpt-5.4-mini
```

官方 OpenAI 直连应保持 `OPENAI_AGENTS_PROTOCOL=responses`。`chat_completions` 是兼容网关兜底，不是官方 OpenAI 的推荐路径；切到它会失去 Responses 侧的会话续接能力，例如 SmartPerfetto OpenAI runtime 使用的 `previousResponseId`。

Ollama 或 OpenAI-compatible gateway 走 Chat Completions 协议：

```bash
SMARTPERFETTO_AGENT_RUNTIME=openai-agents-sdk
OPENAI_BASE_URL=http://localhost:11434/v1
OPENAI_API_KEY=ollama
OPENAI_AGENTS_PROTOCOL=chat_completions
OPENAI_MODEL=qwen3:30b
OPENAI_LIGHT_MODEL=qwen3:30b
```

如果第三方 provider 同时提供 Anthropic-compatible 和 OpenAI-compatible endpoint，Provider Manager 里应同时填写两组 Base URL，再用 `agentRuntime` 或前端 switcher 选择当前使用哪一侧。只用 `.env` 时，同一时刻只能通过 `SMARTPERFETTO_AGENT_RUNTIME` 选择一侧：Claude-compatible 走 `ANTHROPIC_*` + `CLAUDE_*` 变量；OpenAI-compatible 走 `OPENAI_*` 变量。

Pi Agent Core：

```bash
SMARTPERFETTO_AGENT_RUNTIME=pi-agent-core
SMARTPERFETTO_PI_AGENT_CORE_MODEL_JSON='{"id":"your-model-id","name":"Your Model","api":"openai-responses","provider":"openai","baseUrl":"https://api.openai.com/v1","reasoning":false,"input":["text"],"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0},"contextWindow":128000,"maxTokens":4096,"apiKeyEnv":"OPENAI_API_KEY"}'
# 可选：本地 checkout 或解包后的 npm package
# SMARTPERFETTO_PI_AGENT_CORE_MODULE_PATH=/absolute/path/to/@earendil-works/pi-agent-core/dist/index.js
# 可选 runtime-level prompt；SmartPerfetto 分析契约仍来自 strategies
# SMARTPERFETTO_PI_AGENT_CORE_SYSTEM_PROMPT=
```

`SMARTPERFETTO_PI_AGENT_CORE_MODEL_JSON` 应是 `@earendil-works/pi-ai` 的 Model
对象形状。SmartPerfetto 会为每个 runtime 实例创建私有的 Pi `Models` / provider /
credential store，并把 `models.streamSimple.bind(models)` 显式传给 `Agent`，不会设置
进程级默认 stream function。`apiKey` / `apiKeyEnv` / `credential` / `transport` / `thinkingLevel` /
`thinkingBudgets` / `maxRetryDelayMs` 可以放在同一个 JSON 里作为 SmartPerfetto
runtime 选项；`apiKey` 和 `credential` 会在传给 Pi Agent Core 的 model state 前剥离，
避免进入 snapshot 或 report。认证优先级为 JSON `credential` 或 `apiKey`、JSON
`apiKeyEnv`、当前 Provider Manager runtime 的隔离环境、Pi provider 的常规环境变量。
OAuth 使用 `credential:{"type":"oauth","refresh":"...","access":"...","expires":...}`，
只对 Pi 内建且声明 OAuth 的 provider 生效；SmartPerfetto 不在分析请求中启动交互式登录，
临近过期时由该 provider 的 Pi OAuth refresh 契约在实例私有 credential store 中串行刷新。
真实模型路径会使用 SmartPerfetto 共享 prompt、SQL/Skill、
plan/hypothesis 和 report/claim-verification 管线。`SMARTPERFETTO_PI_AGENT_CORE_FAKE_STREAM=1`
仅用于 smoke/test，不能代表真实分析效果。

上面的 `openai-responses` 示例适合官方 OpenAI Responses API。接入只兼容
chat/completions 的 OpenAI-compatible gateway 时，把 JSON 里的 `api` 改成
`openai-completions`，并使用对应 gateway 的 `baseUrl`、model id 和 key。
未知 `api` 会在创建 Agent 前失败；当前支持 Pi 的十种文本 API：
`anthropic-messages`、`azure-openai-responses`、`bedrock-converse-stream`、
`google-generative-ai`、`google-vertex`、`mistral-conversations`、
`openai-codex-responses`、`openai-completions`、`openai-responses` 和
`pi-messages`。
使用受管 custom provider 时，应把 `DEEPSEEK_API_KEY`、`OPENROUTER_API_KEY`、
`AWS_*`、`GOOGLE_*` 或 `AZURE_OPENAI_*` 等 provider 专用变量放在该 profile 的
custom 环境覆盖中。SmartPerfetto 会在创建 runtime 前清除其他 profile 的凭证，并只把
当前选中 runtime 的 provider-scoped 云环境传给 Pi。
Bedrock 为避免 AWS SDK 的默认凭证链重新读取进程环境，只接受 runtime 内显式的
`AWS_BEARER_TOKEN_BEDROCK`，或 `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`
（可带 `AWS_SESSION_TOKEN`）；`AWS_PROFILE`、ECS container credential、web identity
和共享 config/credentials 文件模式会 fail closed。Vertex service-account 只检查当前
profile 通过 `GOOGLE_APPLICATION_CREDENTIALS` 明确指定的精确文件，不探测用户目录 ADC。

Provider Manager 里 Pi Agent Core 只对 custom provider 开放。删除 custom
provider，或把 `SMARTPERFETTO_AGENT_RUNTIME` 切回 `claude-agent-sdk` /
`openai-agents-sdk`，就是回滚路径。

OpenCode：

```bash
SMARTPERFETTO_AGENT_RUNTIME=opencode
# 推荐：需要 OpenCode-specific provider/model wiring 时使用
SMARTPERFETTO_OPENCODE_MODEL_JSON='{"providerID":"smartperfetto","modelID":"your-model-id","baseUrl":"https://api.openai.com/v1","apiKeyEnv":"OPENAI_API_KEY","smallModel":"your-light-model"}'
OPENAI_API_KEY=sk-your-provider-key
# 可选：本地 checkout 或解包后的 npm package
# SMARTPERFETTO_OPENCODE_SDK_MODULE_PATH=/absolute/path/to/@opencode-ai/sdk/dist/index.js
# 可选：隔离 project 目录；不设置时 SmartPerfetto 会创建临时目录
# SMARTPERFETTO_OPENCODE_PROJECT_DIR=/absolute/path/to/empty/project
# 可选 runtime-level prompt；SmartPerfetto 分析契约仍来自 strategies
# SMARTPERFETTO_OPENCODE_SYSTEM_PROMPT=
```

也可以不设置 `SMARTPERFETTO_OPENCODE_MODEL_JSON`，直接用 OpenAI-compatible
字段配置 OpenCode：

```bash
SMARTPERFETTO_AGENT_RUNTIME=opencode
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_API_KEY=sk-your-provider-key
OPENAI_MODEL=your-model-id
OPENAI_LIGHT_MODEL=your-light-model
```

Provider Manager 里 OpenCode 只对 custom provider 开放。SmartPerfetto 会用隔离
HOME/config/project state 启动 OpenCode，禁用内建 file/shell/web/edit tools，并
通过 request-scoped MCP bridge 暴露 SmartPerfetto trace tools。它不会读取你的个人
OpenCode 登录态或 project extension。删除 custom provider，或把
`SMARTPERFETTO_AGENT_RUNTIME` 切回 `claude-agent-sdk` / `openai-agents-sdk`，
就是回滚路径。

### 运行时与 Provider 诊断

Claude Code 自己的本地认证/配置是 Claude Agent SDK 的原生认证路径，不管它背后是 Anthropic 订阅还是 Claude Code 里配置好的第三方 endpoint。SmartPerfetto 不会自动读取 Codex CLI、Gemini CLI 或个人 OpenCode 登录态；那些工具管理的是各自 CLI 的配置文件。`opencode` runtime 只通过 Provider Manager 或 env 显式配置。Qoder 是显式 runtime 集成：安装可选 SDK 后，`qoder-agent-sdk` 可使用本机 `qodercli` 登录态或显式 PAT。

Qoder Agent SDK：

```bash
# 显式安装前先审阅并接受 Qoder SDK/CLI 条款。
# 使用预装兼容 CLI 时，可先设置 QODER_SKIP_DOWNLOAD=1。
npm --prefix backend run qoder:install -- --accept-terms
SMARTPERFETTO_AGENT_RUNTIME=qoder-agent-sdk
# 可选 PAT；不设置时使用本机 qodercli 登录态。
# QODER_PERSONAL_ACCESS_TOKEN=your_qoder_pat
# 可选预装 executable 路径。
# QODERCLI_PATH=/absolute/path/to/qodercli
# 可选：从绝对路径加载兼容 SDK entry。
# SMARTPERFETTO_QODER_SDK_MODULE_PATH=/absolute/path/to/qoder-sdk/dist/index.js
# 可选 BYOK：三项必须一起配置；base URL、style 和 light model 可省略。
# BYOK 只配置模型 provider，不替代上面的 Qoder PAT/qodercli 认证。
# QODER_MODEL=deepseek-chat
# QODER_LIGHT_MODEL=deepseek-chat
# QODER_BYOK_API_KEY=your_model_provider_api_key
# QODER_BYOK_PROVIDER=deepseek
# QODER_BYOK_BASE_URL=https://api.deepseek.com/v1
# QODER_BYOK_STYLE=openai
```

全局 npm CLI 需要把 peer 与 SmartPerfetto 一起安装：
`npm install -g @gracker/smartperfetto @qoder-ai/qoder-agent-sdk`。

默认 Docker 和 portable 产物不会安装 Qoder SDK。若要在这些部署形态中
使用，需要在接受条款后构建显式安装 optional peer 的自定义产物。Provider
Manager 只允许 custom profile 选择 Qoder，并要求 `qoderAccessToken` 或
`qoderCliPath`；env 模式可以回退到本机 `qodercli` 登录态。custom Qoder
profile 还可以通过 `custom.envOverrides` 设置 `QODER_BYOK_API_KEY`、
`QODER_BYOK_PROVIDER`、`QODER_BYOK_BASE_URL` 和 `QODER_BYOK_STYLE`；这些键
不会被其他 runtime 接受，CLI/module/worker path 也不能经此入口覆盖。

接入 Gemini 等 provider 时，如果账号只提供 OpenAI-compatible API，可以直接使用 `openai-agents-sdk`；如果该接口的 streaming tool call 不稳定，再让代理层暴露 Anthropic Messages 兼容接口，然后配置：

```bash
ANTHROPIC_BASE_URL=http://localhost:3000
ANTHROPIC_AUTH_TOKEN=sk-proxy-xxx
CLAUDE_MODEL=your-provider-main-model
CLAUDE_LIGHT_MODEL=your-provider-light-model
```

修改 `.env` 后需要重启后端；在 UI 里保存或激活 Provider Manager profile 通常不需要重启，但已有分析 session 会继续使用创建时固定的 provider 来源。显式 env/proxy 凭证可通过健康检查确认当前配置：

```bash
curl -H "Authorization: Bearer <backend-token>" http://localhost:3000/api/runtime-health
```

排查 provider 配置时先看这些 `/api/runtime-health` 字段：

| 字段 | 如何判断 |
|---|---|
| `aiEngine.credentialSource` | `provider-manager` 表示 UI provider 正在生效；`env-or-default` 表示使用 `.env` 或 Claude Code fallback |
| `aiEngine.providerOverridesEnv` | `true` 表示 `.env` 修改不会影响当前分析，除非停用 active provider |
| `aiEngine.runtime` | 只能是 `claude-agent-sdk`、`openai-agents-sdk`、`pi-agent-core`、`opencode` 或 `qoder-agent-sdk`，不是 provider 名称 |
| `aiEngine.providerMode` | 显示实际连接族，例如 `anthropic_compatible_proxy` 或 `openai_chat_completions_compatible` |
| `aiPolicy.aiEnabled` / `aiEngine.aiEnabled` | `false` 表示后端禁止模型分析；`aiPolicy.disabledReason` 会说明来源 |

响应中的 `aiEngine.providerMode` 会显示：

| providerMode | 含义 |
|---|---|
| `anthropic_direct` | 使用 `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` 且未设置自定义 Base URL |
| `anthropic_compatible_proxy` | 使用 `ANTHROPIC_BASE_URL` 接入 Claude Code / Anthropic 兼容 provider 或代理 |
| `aws_bedrock` | 使用 AWS Bedrock |
| `google_vertex` | 使用 Google Vertex AI |
| `openai_responses` | 使用 OpenAI Agents SDK + Responses API |
| `openai_chat_completions_compatible` | 使用 OpenAI Agents SDK + Chat Completions-compatible endpoint |
| `pi-agent-core` | 使用 Pi Agent Core custom model JSON 和共享 SmartPerfetto 分析管线 |
| `opencode` | 使用 OpenCode custom model JSON 或 OpenAI-compatible 字段，并复用共享 SmartPerfetto 分析管线 |
| `qoder` | 通过本机 `qodercli` 登录态、PAT 或显式 CLI path 使用 opt-in Qoder Agent SDK |
| `unconfigured` | 没有显式 env 凭证；如果本机 `claude` 已经能正常请求，SDK 仍可在分析时走 Claude Code 本地 auth/config 路径 |

### 临时禁用模型分析

需要保留 trace 读取、SQL、报告、Provider 配置和确定性 Skill，但禁止所有模型调用时，设置：

```bash
SMARTPERFETTO_AI_ENABLED=false
```

未设置该变量时默认启用 AI。显式值接受 `1/0`、`true/false`、`yes/no`、`on/off`、`enabled/disabled`；无效值会 fail closed，也就是按禁用处理，并在 `/api/runtime-health` 的 `aiPolicy.env.valid=false`（需鉴权）和 `smp doctor` 中暴露原因。

禁用后仍可用：trace 上传/读取、SQL 查询、capture config proposal、Android capture（不带 `--analyze`）、报告读取、Provider profile 列表/编辑/激活/runtime 切换，以及不调用 LLM 的确定性 Skill。会被阻断：agent analyze/resume、场景还原冷启动、Provider connection test、`smp provider test`、`smp capture android --analyze`、LLM Skill step。阻断响应统一包含 `code: "AI_DISABLED"` 和 `retryable: false`。

## 分析预算与超时

慢模型或本地模型通常需要更长的 per-turn timeout：

```bash
AGENT_FULL_REQUEST_TIMEOUT_MS=1200000
AGENT_STREAM_IDLE_TIMEOUT_MS=300000
AGENT_MAX_HISTORY_BYTES=4194304

CLAUDE_FULL_PER_TURN_MS=60000
CLAUDE_FULL_REQUEST_TIMEOUT_MS=1200000
CLAUDE_STREAM_IDLE_TIMEOUT_MS=300000
CLAUDE_QUICK_PER_TURN_MS=40000
CLAUDE_VERIFIER_TIMEOUT_MS=60000
CLAUDE_CLASSIFIER_TIMEOUT_MS=30000

OPENAI_FULL_PER_TURN_MS=60000
OPENAI_FULL_REQUEST_TIMEOUT_MS=1200000
OPENAI_STREAM_IDLE_TIMEOUT_MS=300000
OPENAI_MAX_HISTORY_BYTES=4194304
OPENAI_QUICK_PER_TURN_MS=40000
OPENAI_CLASSIFIER_TIMEOUT_MS=30000
```

共享的 `AGENT_*` 安全上限适用于激活的 Provider profile；runtime-specific 值可在
直接 env provider 路径中覆盖。`*_FULL_REQUEST_TIMEOUT_MS` 是 full 分析的绝对墙钟上限，默认 20 分钟；即使
`maxTurns × per-turn timeout` 更大也不会超过它。`*_STREAM_IDLE_TIMEOUT_MS`
限制 provider 连续无流事件的时间，默认 5 分钟；触发时后端会取消 SDK 与当前
工具调用，并把已收集证据作为 `partial` 结果正常走完终态事件。OpenAI 的
`AGENT_MAX_HISTORY_BYTES` / `OPENAI_MAX_HISTORY_BYTES` 默认 4 MiB，只限制跨 continuation/session 持有的
provider history；Artifact、DataEnvelope、报告和证据来源不会因此被截断。

分析模式由请求体 `options.analysisMode` 控制：

| 模式 | 行为 | 适用场景 |
|---|---|---|
| `fast` | 默认 50 turns（`AGENT_QUICK_MAX_TURNS` 或 runtime-specific quick 配置可调），按请求注册轻量工具面 | 包名、进程、简单事实查询 |
| `full` | 默认 100 turns（`AGENT_MAX_TURNS` 或 runtime-specific 配置可调），按能力注册完整工具面 | 启动、滑动、ANR、复杂根因分析 |
| `auto` | 关键词规则、硬规则和轻量分类器自动选择 | 默认模式 |

前端会把选择持久化到 `localStorage['ai-analysis-mode']`。中途切换模式会清空当前 `agentSessionId`，让后端开启新的 SDK session。

## 服务配置

```bash
SMARTPERFETTO_BACKEND_PORT=3000
SMARTPERFETTO_FRONTEND_PORT=10000
PORT=3000
NODE_ENV=development
# 仅当浏览器实际访问地址与本地端口推导结果不同时设置：
# FRONTEND_URL=https://smartperfetto.example.com
# 反向代理、HTTPS 或 Docker 宿主端口不等于容器端口时设置：
# SMARTPERFETTO_BACKEND_PUBLIC_URL=http://localhost:3000
# 可选：自托管 fork 的 HTTPS Issue 新建地址；不会自动提交。
# SMARTPERFETTO_EXTERNAL_ISSUE_URL=https://github.example.com/org/repo/issues/new
# 仅当部署管理员确认本机 TUN 使用 RFC 2544 fake-IP 时，精确列出可信 Trace 主机：
# SMARTPERFETTO_TRACE_URL_TRUSTED_FAKE_IP_HOSTS=storage.googleapis.com
```

本地开发默认端口：

- Backend: `3000`
- Perfetto UI: `10000`
- trace_processor HTTP RPC pool: `9100-9900`

后端端口优先使用 `SMARTPERFETTO_BACKEND_PORT`；`PORT` 仍保留为
Node/Docker/PaaS 兼容 fallback。Perfetto UI 端口使用
`SMARTPERFETTO_FRONTEND_PORT`。源码启动脚本会由这个端口推导本地
`FRONTEND_URL`，不用重复配置。只有浏览器实际访问的前端 Origin 不同（例如 HTTPS
域名或反向代理）时才显式设置 `FRONTEND_URL`。浏览器无法安全推导后端地址时，显式设置
`SMARTPERFETTO_BACKEND_PUBLIC_URL`。

URL Trace 下载默认拒绝所有私有、保留和 RFC 2544 `198.18.0.0/15` 地址。若本机
TUN 代理把可信公网域名解析为 fake-IP，部署管理员可以通过
`SMARTPERFETTO_TRACE_URL_TRUSTED_FAKE_IP_HOSTS` 以逗号分隔精确主机名；不要配置
通配符、IP 或不受你控制的域名。该配置是服务端 SSRF 信任边界，普通用户请求不能修改。

## API 鉴权

如果后端暴露给多人或外网，设置：

```bash
# 本地单人使用可以不设置。
SMARTPERFETTO_API_KEY=replace_with_a_strong_random_secret
```

这是部署运维凭证，在本地/非企业模式下拥有管理权限，不应分发给普通用户。企业部署应为
用户签发具有明确角色和 scope 的持久化 API key。

受保护接口需要请求头：

```http
Authorization: Bearer <SMARTPERFETTO_API_KEY>
```

## OIDC 浏览器登录

OIDC 模式会把 Web UI 改成登录门禁：前端启动时先请求
`GET /api/auth/session`，只有 Session 为 `ready` 才加载 Perfetto 主程序；未登录时只显示
OIDC 登录页。授权码回调由后端换取 Token、校验 `state`、PKCE、`nonce`、JWT 签名、
issuer 和 audience，再写入 `HttpOnly` Session Cookie 并跳回 `FRONTEND_URL`。浏览器
业务请求统一携带 Cookie，写请求同时发送 Session 返回的 CSRF Token。

没有配置 OIDC 时不启用这道门禁，也不在 Perfetto 启动前探测认证 Session；前端继续按
原来的本地/静态方式加载，即使 AI 后端暂时不可用也不会把普通用户挡在登录页外。

```bash
SMARTPERFETTO_OIDC_ISSUER_URL=https://idp.example.com/application/o/smartperfetto/
SMARTPERFETTO_OIDC_CLIENT_ID=smartperfetto
SMARTPERFETTO_OIDC_CLIENT_SECRET=replace_with_oidc_client_secret
SMARTPERFETTO_OIDC_REDIRECT_URI=https://smartperfetto.example.com/api/auth/oidc/callback
SMARTPERFETTO_SERVER_SECRET=replace_with_at_least_32_random_bytes
FRONTEND_URL=https://smartperfetto.example.com
```

四个 OIDC 参数中只要出现任意一个，后端就进入 OIDC 模式；缺少其余参数时会拒绝启动，
不会悄悄退回本地身份。`SMARTPERFETTO_SERVER_SECRET` 是独立的服务端签名根，至少 32
字节，不能复用 OIDC Client Secret。Session 固定为 8 小时、`SameSite=Lax`，Secure
Cookie 根据 HTTPS 地址自动启用，OIDC Scope 固定为 `openid email profile`。

使用 `./start.sh` 或 `./scripts/start-dev.sh` 做本地分端口联调时，只设置
`SMARTPERFETTO_FRONTEND_PORT` 即可，脚本会生成对应的 `FRONTEND_URL`。上面的
`FRONTEND_URL` 是域名/反向代理部署示例，不需要和本地端口重复填写。

同一个 Issuer 下，每个 OIDC Subject 只创建一个由后端管理的个人工作区。不同用户的
工作区显示名称可以相同，但内部 User ID、Workspace ID、成员关系和所有数据范围都不同；
OIDC 前端不会允许用户修改工作区、后端地址或 API Key。租户 ID 只由标准化 Issuer
稳定派生，不接受用户 Claim 覆盖。内置 OIDC 不能和
`SMARTPERFETTO_SSO_TRUSTED_HEADERS=true` 或旧的 `SMARTPERFETTO_API_KEY` 同时启用。
OIDC 会自动使用数据库作为分区数据的唯一读写来源，不需要再配置企业迁移阶段，也不允许
回退到会忽略用户范围的 `legacy` 或 `dual-write` 模式。

生产模式默认要求 Issuer、回调和前端 URL 全部使用 HTTPS，并使用 Secure Cookie。
只有受控联调环境才能显式设置 `SMARTPERFETTO_OIDC_ALLOW_INSECURE_HTTP=true`；该开关会
允许明文 HTTP 并默认关闭 Secure Cookie，不能用于不可信网络。`FRONTEND_URL` 必须是
浏览器实际访问的前端 Origin，不能填写容器内部地址。前端 URL 与 OIDC 回调必须使用相同
协议和主机，端口可以不同；前端默认直接从回调地址的 Origin 推导后端地址，不需要再填写
`SMARTPERFETTO_BACKEND_PUBLIC_URL`。只有后端公开地址带路径前缀等无法从 Origin 推导的
代理场景才设置该变量，并且它必须与回调地址的协议、主机和路径前缀一致。这既支持同一
服务器上的前后端分端口部署，也保证 `SameSite=Lax` Session Cookie 能被浏览器业务请求
携带。OIDC 部署必须使用项目的动态前端服务器或等价的反向代理注入运行时配置，不能把
`frontend/` 当成不知道后端地址的纯静态目录直接发布。

## 上传与 trace processor

```bash
MAX_FILE_SIZE=2147483648
UPLOAD_DIR=./uploads
TRACE_PROCESSOR_PATH=/path/to/trace_processor_shell
PERFETTO_PATH=/path/to/perfetto
```

默认不需要手动设置 `TRACE_PROCESSOR_PATH`。普通 `./start.sh` 和开发模式 `./scripts/start-dev.sh` 都优先使用经过固定 SHA256 校验的 prebuilt。显式的 `TRACE_PROCESSOR_PATH` 是用户拥有的覆盖路径：启动和 backend `predev` 只检查文件存在、可执行以及 `--version`，不会改权限、按固定 SHA 替换或向该路径下载。

只有在修改 Perfetto C++ 或需要自编译时才使用：

```bash
./scripts/start-dev.sh --build-from-source
```

该参数会对当前 Perfetto checkout 执行 `gn` / `ninja` 增量源码构建并使用 `perfetto/out/ui/trace_processor_shell`，不会因为仓库里已有 prebuilt 而跳过。

如果下载卡在 `commondatastorage.googleapis.com` 或 Google artifact bucket 无法访问，有三种出口：

```bash
# 1. 使用已有 binary，脚本会跳过下载
TRACE_PROCESSOR_PATH=/absolute/path/to/trace_processor_shell ./start.sh

# 2. 使用保持相同目录结构的可信镜像
TRACE_PROCESSOR_DOWNLOAD_BASE=https://your-mirror/perfetto-luci-artifacts ./start.sh

# 3. 使用当前平台的精确 binary URL
TRACE_PROCESSOR_DOWNLOAD_URL=https://your-mirror/trace_processor_shell ./start.sh
```

镜像下载仍会按 `scripts/trace-processor-pin.env` 中固定的 SHA256 校验；如果只是想快速使用，优先选择 Docker Hub 镜像，因为镜像内已经包含固定版本的 `trace_processor_shell`。

macOS 如果拦截 `trace_processor_shell`，可能会看到 `cannot be opened because the developer cannot be verified`、终端输出 `killed`，或脚本提示 `--version smoke test failed`。打开 **系统设置 → 隐私与安全性 → 安全性**，对 `trace_processor_shell` 点 **仍要打开 / Allow Anyway**，重新运行脚本并在弹窗里选择 **打开**。如果你确认 binary 来源可信，也可以：

```bash
xattr -dr com.apple.quarantine /absolute/path/to/trace_processor_shell
chmod +x /absolute/path/to/trace_processor_shell
```

## 可选 Android Internals 外部知识

外部 Wiki 路径默认拒绝。配置 `SMARTPERFETTO_KNOWLEDGE_ROOTS` 只建立路径
allowlist；仍需通过 API 独立确认使用权、provider-send 同意、建立索引，并在每次
分析的 `knowledgeSourceIds` 中显式选择。完整流程见
[Android Internals 外部知识库](android-internals-knowledge.md)。

## 请求限流

内存级限流，适合公开试用环境的基础保护：

```bash
SMARTPERFETTO_USAGE_MAX_REQUESTS=200
SMARTPERFETTO_USAGE_MAX_TRACE_REQUESTS=100
SMARTPERFETTO_USAGE_WINDOW_MS=86400000
```

重启后限流状态会丢失；生产部署如果需要严格配额，应在反向代理或 API 网关层增加持久化限流。

## Runtime 与 Provider 的边界

`SMARTPERFETTO_AGENT_RUNTIME` 只表示后端编排 runtime，只接受 `claude-agent-sdk`、`openai-agents-sdk`、`pi-agent-core`、`opencode` 或 `qoder-agent-sdk`。Provider 名称不能写在这里：例如 DeepSeek 应配置为 Claude/Anthropic-compatible provider，OpenAI/Ollama 应配置为 OpenAI Agents SDK provider，Pi Agent Core/OpenCode/Qoder 应配置为 custom provider 或对应 env block。
