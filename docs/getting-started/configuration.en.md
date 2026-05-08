# Configuration Guide

[English](configuration.en.md) | [中文](configuration.md)

For local source runs, SmartPerfetto can use Claude Code's local authentication and configuration directly. If `claude` already works in the same terminal, you do not need to create `.env`. Use env files when you need explicit API keys, compatible proxies, or Docker runtime credentials.

The AI Assistant settings panel in Perfetto UI has two configuration areas: the `Connection` tab configures the SmartPerfetto backend connection, and the `Providers` tab configures model-provider profiles. The API Key field on the `Connection` tab maps only to backend auth (`SMARTPERFETTO_API_KEY`). It is not a model-provider key field. Model-provider credentials can come from Claude Code local config, from the backend/Docker env files below, or from Provider Manager profiles created in the frontend.

The preset Base URLs come from public provider information and public documentation. They are not guaranteed to be correct for every account, plan, region, or future provider change. If connection, streaming, or tool/function calling fails, first verify the Base URL, model ID, and protocol in your provider console.

For local source runs, backend configuration lives in `backend/.env`. Start from the template:

```bash
cp backend/.env.example backend/.env
```

## LLM Configuration

SmartPerfetto has two first-class SDK runtimes:

- `claude-agent-sdk`: the default runtime. Use it for Anthropic, Claude Code local auth, Bedrock, Vertex, and Anthropic/Claude Code-compatible providers.
- `openai-agents-sdk`: the OpenAI runtime. Use it for OpenAI Responses API, Ollama, and OpenAI-compatible gateways that support streaming function/tool calling.

Runtime selection priority is: request/session `providerId`, active Provider Manager profile, `SMARTPERFETTO_AGENT_RUNTIME`, then the default `claude-agent-sdk`. If `.env` contains both `ANTHROPIC_*` and `OPENAI_*` without `SMARTPERFETTO_AGENT_RUNTIME=openai-agents-sdk`, analysis still uses Claude Agent SDK.

Perfetto UI Provider Management can store both endpoint families for the same provider: `claudeBaseUrl` / `claudeApiKey` / `claudeAuthToken` for Claude Code SDK, and `openaiBaseUrl` / `openaiApiKey` / `openaiProtocol` for OpenAI SDK. The provider switcher beside the AI input shows the active SDK runtime.

Existing analysis sessions pin the credential source used at creation time. A session created with Provider A will try to resume with Provider A; a session created from `.env` fallback does not switch to a later active provider.

For direct Anthropic API access:

```bash
ANTHROPIC_API_KEY=your_anthropic_api_key_here
```

For third-party models that expose Claude Code / Anthropic-compatible endpoints, start from `backend/.env.example`. Usually you only replace the API key/token and keep SmartPerfetto's model variable names:

```bash
ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
ANTHROPIC_AUTH_TOKEN=sk-your-deepseek-key
CLAUDE_MODEL=deepseek-v4-pro
CLAUDE_LIGHT_MODEL=deepseek-v4-flash
```

Xiaomi MiMo Token Plan example:

```bash
# Anthropic-compatible / Claude SDK
ANTHROPIC_BASE_URL=https://token-plan-sgp.xiaomimimo.com/anthropic
ANTHROPIC_API_KEY=your_xiaomi_mimo_api_key_here
CLAUDE_MODEL=mimo-v2.5-pro
CLAUDE_LIGHT_MODEL=mimo-v2.5-pro

# OpenAI-compatible / OpenAI Agents SDK
SMARTPERFETTO_AGENT_RUNTIME=openai-agents-sdk
OPENAI_BASE_URL=https://token-plan-sgp.xiaomimimo.com/v1
OPENAI_API_KEY=your_xiaomi_mimo_api_key_here
OPENAI_AGENTS_PROTOCOL=chat_completions
OPENAI_MODEL=mimo-v2.5-pro
OPENAI_LIGHT_MODEL=mimo-v2.5-pro
```

Provider model catalogs, Base URLs, and plan permissions can change; if your account console lists a different model ID or dedicated domain, replace the corresponding fields.

| Provider | Claude / Anthropic-compatible Base URL | OpenAI-compatible Base URL | Recommended main model | Recommended light model |
|---|---|---|---|---|
| DeepSeek | `https://api.deepseek.com/anthropic` | `https://api.deepseek.com/v1` | `deepseek-v4-pro` | `deepseek-v4-flash` |
| GLM / Zhipu | `https://open.bigmodel.cn/api/anthropic` | `https://open.bigmodel.cn/api/paas/v4` | `glm-5.1` | `glm-4.5-air` |
| Qwen / Bailian pay-as-you-go | `https://dashscope.aliyuncs.com/apps/anthropic` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen3.6-plus` | `qwen3.6-flash` |
| Qwen Coding Plan | `https://coding-intl.dashscope.aliyuncs.com/apps/anthropic` | `https://coding-intl.dashscope.aliyuncs.com/v1` | `qwen3-coder-plus` | `qwen3-coder-plus` |
| Kimi Code membership | `https://api.kimi.com/coding/` | `https://api.kimi.com/coding/v1` | `kimi-for-coding` | `kimi-for-coding` |
| Kimi / Moonshot platform | `https://api.moonshot.cn/anthropic` | `https://api.moonshot.cn/v1` | `kimi-k2.5` | `kimi-k2.5` |
| Doubao / Volcano Ark Coding Plan | `https://ark.cn-beijing.volces.com/api/coding` | `https://ark.cn-beijing.volces.com/api/coding/v3` | `doubao-seed-2.0-code` | `doubao-seed-2.0-code` |
| MiniMax China | `https://api.minimaxi.com/anthropic` | `https://api.minimaxi.com/v1` | `MiniMax-M2.7` | `MiniMax-M2.7` |
| Xiaomi MiMo Token Plan | `https://token-plan-sgp.xiaomimimo.com/anthropic` | `https://token-plan-sgp.xiaomimimo.com/v1` | `mimo-v2.5-pro` | `mimo-v2.5-pro` |
| Tencent TokenHub Token Plan | `https://api.lkeap.cloud.tencent.com/plan/anthropic` | `https://api.lkeap.cloud.tencent.com/plan/v3` | `tc-code-latest` | `tc-code-latest` |
| Tencent TokenHub Coding Plan | `https://api.lkeap.cloud.tencent.com/coding/anthropic` | `https://api.lkeap.cloud.tencent.com/coding/v3` | `tc-code-latest` | `tc-code-latest` |
| Tencent Hunyuan legacy | `https://api.hunyuan.cloud.tencent.com/anthropic` | `https://api.hunyuan.cloud.tencent.com/v1` | `hunyuan-2.0-thinking-20251109` | `hunyuan-2.0-instruct-20251111` |
| Baidu Qianfan | `https://qianfan.baidubce.com/anthropic` | `https://qianfan.baidubce.com/v2` | `deepseek-v3.2` | `deepseek-v3.2` |
| StepFun Step Plan | `https://api.stepfun.com/step_plan` | `https://api.stepfun.com/step_plan/v1` | `step-3.5-flash-2603` | `step-3.5-flash` |
| SiliconFlow | `https://api.siliconflow.com/` | `https://api.siliconflow.com/v1` | `Qwen/Qwen3-235B-A22B-Thinking-2507` | `Qwen/Qwen3-30B-A3B-Instruct-2507` |
| Huawei Cloud ModelArts MaaS | `https://api.modelarts-maas.com/anthropic` | `https://api.modelarts-maas.com/v1` | `deepseek-v3.2` | `qwen3-32b` |

Provider docs may use `ANTHROPIC_MODEL` / `ANTHROPIC_DEFAULT_HAIKU_MODEL`, but SmartPerfetto uses `CLAUDE_MODEL` / `CLAUDE_LIGHT_MODEL`. Models must reliably support streaming output and tool/function calling.

OpenAI official API:

```bash
SMARTPERFETTO_AGENT_RUNTIME=openai-agents-sdk
OPENAI_API_KEY=sk-your-openai-key
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_AGENTS_PROTOCOL=responses
OPENAI_MODEL=gpt-5.5
OPENAI_LIGHT_MODEL=gpt-5.4-mini
```

Ollama or OpenAI-compatible gateways:

```bash
SMARTPERFETTO_AGENT_RUNTIME=openai-agents-sdk
OPENAI_BASE_URL=http://localhost:11434/v1
OPENAI_API_KEY=ollama
OPENAI_AGENTS_PROTOCOL=chat_completions
OPENAI_MODEL=qwen3:30b
OPENAI_LIGHT_MODEL=qwen3:30b
```

If a third-party provider exposes both endpoint families, fill both in Provider Manager and use `agentRuntime` or the frontend switcher to choose the active side. With `.env` only, one side is active at a time through `SMARTPERFETTO_AGENT_RUNTIME`.

## Runtime and Provider Diagnostics

SmartPerfetto does not read Codex CLI, Gemini CLI, or OpenCode login state; those tools manage their own config files.

Restart the backend after changing `.env`. Verify explicit env/proxy credentials with:

```bash
curl http://localhost:3000/health
```

`aiEngine.providerMode` can be:

| providerMode | Meaning |
|---|---|
| `anthropic_direct` | Uses `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` without a custom Base URL |
| `anthropic_compatible_proxy` | Uses `ANTHROPIC_BASE_URL` for a Claude Code / Anthropic-compatible provider or proxy |
| `aws_bedrock` | Uses AWS Bedrock |
| `openai_responses` | Uses OpenAI Agents SDK + Responses API |
| `openai_chat_completions_compatible` | Uses OpenAI Agents SDK + Chat Completions-compatible endpoint |
| `unconfigured` | No explicit env credentials; if local `claude` works, the SDK can still use Claude Code local auth/config during analysis |

## Budgets and Timeouts

Slow or local models usually need longer per-turn timeouts:

```bash
CLAUDE_FULL_PER_TURN_MS=60000
CLAUDE_QUICK_PER_TURN_MS=40000
CLAUDE_VERIFIER_TIMEOUT_MS=60000
CLAUDE_CLASSIFIER_TIMEOUT_MS=30000

OPENAI_FULL_PER_TURN_MS=60000
OPENAI_QUICK_PER_TURN_MS=40000
OPENAI_CLASSIFIER_TIMEOUT_MS=30000
```

| Mode | Behavior | Use case |
|---|---|---|
| `fast` | Default 10 turns, lightweight tools | Package, process, simple facts |
| `full` | Default 60 turns, full toolset | Startup, scrolling, ANR, complex root-cause analysis |
| `auto` | Keyword rules, hard rules, and lightweight classifier choose the mode | Default mode |

The frontend persists the selected mode in `localStorage['ai-analysis-mode']`.

## Service Configuration

```bash
PORT=3000
NODE_ENV=development
FRONTEND_URL=http://localhost:10000
```

Default local ports:

- Backend: `3000`
- Perfetto UI: `10000`
- trace_processor HTTP RPC pool: `9100-9900`

## API Authentication

If the backend is exposed to multiple users or a network, set:

```bash
SMARTPERFETTO_API_KEY=replace_with_a_strong_random_secret
```

Protected APIs then require:

```http
Authorization: Bearer <SMARTPERFETTO_API_KEY>
```

## Uploads and Trace Processor

```bash
MAX_FILE_SIZE=2147483648
UPLOAD_DIR=./uploads
TRACE_PROCESSOR_PATH=/path/to/trace_processor_shell
PERFETTO_PATH=/path/to/perfetto
```

`TRACE_PROCESSOR_PATH` usually does not need manual configuration. If download is blocked, use:

```bash
TRACE_PROCESSOR_PATH=/absolute/path/to/trace_processor_shell ./start.sh
TRACE_PROCESSOR_DOWNLOAD_BASE=https://your-mirror/perfetto-luci-artifacts ./start.sh
TRACE_PROCESSOR_DOWNLOAD_URL=https://your-mirror/trace_processor_shell ./start.sh
```

Mirror downloads are still checked against the SHA256 pinned in `scripts/trace-processor-pin.env`.

## Rate Limiting

```bash
SMARTPERFETTO_USAGE_MAX_REQUESTS=200
SMARTPERFETTO_USAGE_MAX_TRACE_REQUESTS=100
SMARTPERFETTO_USAGE_WINDOW_MS=86400000
```

Rate-limit state is lost after restart. For strict production quotas, add persistent rate limiting at the reverse proxy or API gateway layer.

## Runtime and Provider Boundary

`SMARTPERFETTO_AGENT_RUNTIME` only selects the backend orchestration SDK and only accepts `claude-agent-sdk` or `openai-agents-sdk`. Do not put provider names here.
