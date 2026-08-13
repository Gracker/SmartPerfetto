# Configuration Guide

[English](configuration.en.md) | [中文](configuration.md)

For local source runs, SmartPerfetto can use Claude Code's local authentication and configuration directly. If `claude` already works in the same terminal, you do not need to create `.env`. Use env files when you need explicit API keys, compatible proxies, or Docker runtime credentials.

Windows portable users should complete download, extraction, and startup through the
[Windows guide](windows.en.md), then use the Provider fields on this page. Do not copy Unix
source commands into the ordinary Windows portable path.

## First Answer: Which Runtime Do I Configure?

Claude Code, OpenAI Agents SDK, Pi Agent Core, OpenCode, and Qoder Agent SDK are alternative runtime paths, not a checklist of required setup steps. Pick one source for your first setup:

| What you have | Recommended path | What to configure |
|---|---|---|
| You do not want to edit env files, or you use Docker/portable packages | UI Provider Manager | Add the provider key on the `Providers` tab, test it, then activate it |
| Local source run where `claude` already works in the same terminal | Local Claude Code config | No `.env`, no `OPENAI_*` variables |
| Anthropic API key or a Claude/Anthropic-compatible provider | Claude Agent SDK | `ANTHROPIC_*` + `CLAUDE_*` |
| OpenAI API key, Ollama, or an OpenAI-compatible provider | OpenAI Agents SDK | `SMARTPERFETTO_AGENT_RUNTIME=openai-agents-sdk` + `OPENAI_*` |
| Pi Agent Core model configuration | Pi Agent Core | Custom Provider Manager profile or `SMARTPERFETTO_AGENT_RUNTIME=pi-agent-core` + `SMARTPERFETTO_PI_AGENT_CORE_MODEL_JSON` |
| OpenCode model configuration | OpenCode | Custom Provider Manager profile or `SMARTPERFETTO_AGENT_RUNTIME=opencode` + OpenAI-compatible fields or `SMARTPERFETTO_OPENCODE_MODEL_JSON` |
| Qoder CLI login or PAT | Qoder Agent SDK | Explicitly installed Qoder SDK plus a custom Provider Manager profile or `SMARTPERFETTO_AGENT_RUNTIME=qoder-agent-sdk` |

If a third-party provider exposes both Claude-compatible and OpenAI-compatible endpoints, the UI can store both endpoints and one shared key, but only one side is active at runtime. With `.env` only, uncomment either the Claude-compatible block or the OpenAI-compatible block; do not enable both just to be "complete."

The AI Assistant settings panel in Perfetto UI contains `Connection`,
`Providers`, `Codebases`, and `Evolution`. The first two configure the
SmartPerfetto backend and model-provider profiles; Codebases manages code-aware
sources; Evolution operates the controlled Self-Evolution workflow on the
currently saved backend. The advanced backend auth token on the `Connection`
tab is optional; fill it only when the backend was started with
`SMARTPERFETTO_API_KEY`. It is not a model-provider key field. Model-provider
credentials can come from Claude Code local config, from the backend/Docker env
files below, or from Provider Manager profiles created in the frontend.

For beginners, the UI path is the least ambiguous:

1. Start SmartPerfetto; portable packages use the actual `Open:` URL printed by the launcher, while Docker defaults to `http://localhost:10000`.
2. Open **AI Assistant Settings → Providers → Add Provider**.
3. Choose the provider type, paste the **Provider API Key**, then check the preset Base URLs and SDK Runtime.
4. Click **Create Provider**. This only saves the profile.
5. Back in the provider list, click the plug icon to test the connection, then click the provider row or choose it in the provider switcher to activate it.
6. Verify with authenticated `/api/runtime-health`. `aiEngine.credentialSource=provider-manager` means the UI provider is active; `env-or-default` means SmartPerfetto is using env or local Claude Code fallback. Public `/health` is liveness-only.

An active Provider Manager profile overrides `.env`. To make `.env` changes take effect again, choose `System Default` in the provider switcher or deactivate the active provider.

The preset Base URLs come from public provider information and public documentation. They are not guaranteed to be correct for every account, plan, region, or future provider change. If connection, streaming, or tool/function calling fails, first verify the Base URL, model ID, and protocol in your provider console.

If you choose the local source env-file path, the backend reads `backend/.env`. Start from the template:

```bash
cp backend/.env.example backend/.env
```

If you choose the Docker env-file path, both Docker Hub images and local source Docker builds read the repository-root `.env`:

```bash
cp .env.example .env
```

## Self-Evolution (off by default)

Existing feedback or a configured provider never enables Self-Evolution
automatically. The source currently reads only these two
Self-Evolution-specific switches:

```bash
# Allow humans to explicitly curate public feedback, run fixed paired
# evaluation, and review proposals.
SELF_EVOLUTION_ENABLED=true

# Allow human apply/revert; the root switch above is also required.
SELF_EVOLUTION_APPLY=true
```

Both default to `false`. Enabling only `SELF_EVOLUTION_ENABLED` allows
curation, gate execution, accept/reject, and observation, but not apply/revert.
`SELF_EVOLUTION_APPLY=true` additionally requires the general user data root to
be writable, outside the package, and valid for the current distribution. If
that persistence check fails, startup downgrades effective apply to off and the
API returns `503`; it never falls back to a package-local temporary directory.

Restart the backend after changing these values, then inspect requested and
effective state under **AI Assistant Settings → Evolution**. Operations use
separate `self_evolution:read`, `curate`, `export`, `apply`, and `revert`
permissions. Private feedback never enters curation; contribution bundles are
local-only and are never uploaded automatically. No external L2 judge is
configured and there is no additional environment variable for one; any future
integration requires per-use explicit consent.
See [Self-Evolution Usage And Acceptance](self-evolution.en.md) for the complete
default-off, apply/revert, restart-reconciliation, and fail-closed checks.

Agent-assisted GitHub feedback does not require either `SELF_EVOLUTION_*`
switch. It creates an unsubmitted draft at
`https://github.com/Gracker/SmartPerfetto/issues/new` by default. A self-hosted
fork may point it to its own HTTPS issue-new endpoint:

```bash
SMARTPERFETTO_EXTERNAL_ISSUE_URL=https://github.example.com/org/repo/issues/new
```

This is not a GitHub API token and never enables automatic submission. Agent
review reuses only the source run's pinned provider/runtime and falls back
explicitly when that pin is absent or changed. See
[Agent-Assisted GitHub Feedback](agent-assisted-feedback.en.md).

npm CLI does not use the Web UI `Connection` settings. For first-time CLI setup, run:

```bash
smp config init
```

It creates `~/.smartperfetto/env`. When `--env-file` is not passed, the CLI loads package/source `backend/.env` first, then `~/.smartperfetto/env`, with the user file taking priority. If you pass `--env-file /path/to/env`, the CLI reads only that file. CLI configuration follows the same rule: choose one runtime block, not every block.

## LLM Configuration

SmartPerfetto has these runtime paths:

- `claude-agent-sdk`: the default runtime. Use it for Anthropic, Claude Code local auth, Bedrock, Vertex, and Anthropic/Claude Code-compatible providers.
- `openai-agents-sdk`: the OpenAI runtime. Use it for OpenAI Responses API, Ollama, and OpenAI-compatible gateways that support streaming function/tool calling.
- `pi-agent-core`: optional public runtime. With a real model config it reuses SmartPerfetto's shared prompt, SQL/Skill, planning/hypothesis, and report/claim-verification pipeline. It dynamically loads `@earendil-works/pi-agent-core` and does not enable `.pi` project discovery, package extensions, shell tools, or file tools.
- `opencode`: optional public runtime. It runs a hardened isolated OpenCode server, feeds it explicit OpenAI-compatible or OpenCode model configuration, and exposes only request-scoped SmartPerfetto MCP tools. It does not read the user's OpenCode CLI login, project config, extensions, or built-in file/shell/web/edit tools.
- `qoder-agent-sdk`: optional public runtime. It exposes only request-scoped SmartPerfetto MCP tools, supports a local `qodercli` login or PAT, and keeps private-knowledge runs out of provider session resume and durable opaque state. Its SDK/CLI terms are separate, so the SDK is an opt-in optional peer and is not installed by default.

These runtimes are mutually selected backend orchestration paths. OpenAI runtime setup does not require installing or logging in to Claude Code; local Claude Code setup does not require an OpenAI key. Pi Agent Core, OpenCode, and Qoder setup are separate from both. Real-model analysis quality should be verified with startup/scrolling E2E; fake-stream is smoke/test-only and does not represent parity.

Runtime selection priority is: request/session `providerId`, active Provider Manager profile, `SMARTPERFETTO_AGENT_RUNTIME`, then the default `claude-agent-sdk`. Do not enable both `ANTHROPIC_*` and `OPENAI_*` for first setup; if an advanced deployment does contain both without `SMARTPERFETTO_AGENT_RUNTIME=openai-agents-sdk`, analysis still uses Claude Agent SDK. An active Provider Manager profile overrides `.env` fallback; confirm the current source with `aiEngine.credentialSource` and `aiEngine.providerOverridesEnv` from authenticated `/api/runtime-health`.

Perfetto UI Provider Management can store both endpoint families for the same provider: `claudeBaseUrl` / `claudeApiKey` / `claudeAuthToken` for Claude Code SDK, and `openaiBaseUrl` / `openaiApiKey` / `openaiProtocol` for OpenAI SDK. Custom providers can also select `pi-agent-core` with `piAgentCoreModelJson` and an optional module path/system prompt, `opencode` with `openCodeModelJson` / `openCodeSdkModulePath` / `openCodeSystemPrompt`, or `qoder-agent-sdk` with `qoderAccessToken` / `qoderCliPath` and optional model/system prompt fields. The provider switcher beside the AI input shows the active runtime.

In enterprise mode, remote Provider Manager endpoints must use public HTTPS by
default, including DNS-result validation, and redirects must remain same-origin.
For an audited private Ollama instance or gateway, set
`SMARTPERFETTO_PROVIDER_PRIVATE_ENDPOINT_ALLOWLIST` to exact origins (scheme,
host, and port), separated by commas. Wildcards, URL paths, and broad private
network ranges are intentionally unsupported.

For dual-surface providers such as DeepSeek, Qwen, Kimi, MiMo, TokenHub, MiniMax, StepFun, SiliconFlow, and custom gateways, the UI shows a shared Provider API Key plus optional runtime-specific key overrides. If the provider uses one key for both endpoint families, fill only the shared key. Change the runtime selector only when you intentionally want to switch between the Claude-compatible URL and the OpenAI-compatible URL.

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

Xiaomi MiMo Token Plan example. The two blocks below are alternatives; do not paste both into the same env file.

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

Provider model catalogs, Base URLs, and plan permissions can change; if your account console lists a different model ID or dedicated domain, replace the corresponding fields.

The table below is a manual-env and troubleshooting reference, not a checklist you must fully configure.

| Provider | Claude / Anthropic-compatible Base URL | OpenAI-compatible Base URL | Recommended main model | Recommended light model |
|---|---|---|---|---|
| DeepSeek | `https://api.deepseek.com/anthropic` | `https://api.deepseek.com/v1` | `deepseek-v4-pro` | `deepseek-v4-flash` |
| GLM / Zhipu | `https://open.bigmodel.cn/api/anthropic` | `https://open.bigmodel.cn/api/paas/v4` | `glm-5-turbo` | `glm-4.7-flashx` |
| Qwen / Bailian pay-as-you-go | `https://dashscope.aliyuncs.com/apps/anthropic` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen3.7-plus` | `qwen3.6-flash` |
| Qwen Coding Plan | `https://coding-intl.dashscope.aliyuncs.com/apps/anthropic` | `https://coding-intl.dashscope.aliyuncs.com/v1` | `qwen3-coder-plus` | `qwen3-coder-plus` |
| Kimi Code membership | `https://api.kimi.com/coding/` | `https://api.kimi.com/coding/v1` | `kimi-for-coding` | `kimi-for-coding` |
| Kimi / Moonshot platform | `https://api.moonshot.cn/anthropic` | `https://api.moonshot.cn/v1` | `kimi-k2.7-code-highspeed` | `kimi-k2.7-code-highspeed` |
| Doubao / Volcano Ark Coding Plan | `https://ark.cn-beijing.volces.com/api/coding` | `https://ark.cn-beijing.volces.com/api/coding/v3` | `doubao-seed-2.0-code` | `doubao-seed-2.0-code` |
| MiniMax China | `https://api.minimaxi.com/anthropic` | `https://api.minimaxi.com/v1` | `MiniMax-M3` | `MiniMax-M3` |
| Xiaomi MiMo Token Plan | `https://token-plan-sgp.xiaomimimo.com/anthropic` | `https://token-plan-sgp.xiaomimimo.com/v1` | `mimo-v2.5-pro` | `mimo-v2.5` |
| Tencent TokenHub Token Plan | `https://api.lkeap.cloud.tencent.com/plan/anthropic` | `https://api.lkeap.cloud.tencent.com/plan/v3` | `tc-code-latest` | `tc-code-latest` |
| Tencent TokenHub Coding Plan | `https://api.lkeap.cloud.tencent.com/coding/anthropic` | `https://api.lkeap.cloud.tencent.com/coding/v3` | `tc-code-latest` | `tc-code-latest` |
| Tencent Hunyuan legacy | `https://api.hunyuan.cloud.tencent.com/anthropic` | `https://api.hunyuan.cloud.tencent.com/v1` | `hunyuan-2.0-thinking-20251109` | `hunyuan-2.0-instruct-20251111` |
| Baidu Qianfan | `https://qianfan.baidubce.com/anthropic` | `https://qianfan.baidubce.com/v2` | `deepseek-v3.2` | `deepseek-v3.2` |
| StepFun Step Plan | `https://api.stepfun.com/step_plan` | `https://api.stepfun.com/step_plan/v1` | `step-3.7-flash` | `step-3.5-flash` |
| SiliconFlow | `https://api.siliconflow.com/` | `https://api.siliconflow.com/v1` | `Qwen/Qwen3-235B-A22B-Instruct-2507` | `Qwen/Qwen3-30B-A3B-Instruct-2507` |
| Huawei Cloud ModelArts MaaS | `https://api.modelarts-maas.com/anthropic` | `https://api.modelarts-maas.com/v1` | `deepseek-v4-pro` | `deepseek-v4-flash` |

Provider docs may use `ANTHROPIC_MODEL` / `ANTHROPIC_DEFAULT_HAIKU_MODEL`, but SmartPerfetto uses `CLAUDE_MODEL` / `CLAUDE_LIGHT_MODEL`. Models must reliably support streaming output and tool/function calling.

OpenAI official API:

```bash
SMARTPERFETTO_AGENT_RUNTIME=openai-agents-sdk
OPENAI_API_KEY=sk-your-openai-key
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_AGENTS_PROTOCOL=responses
OPENAI_MODEL=gpt-5.4-mini
OPENAI_LIGHT_MODEL=gpt-5.4-mini
```

Keep official OpenAI direct connections on `OPENAI_AGENTS_PROTOCOL=responses`. `chat_completions` is a compatibility fallback for gateways, not the recommended official OpenAI path; switching to it disables Responses-side session continuation such as the `previousResponseId` used by the SmartPerfetto OpenAI runtime.

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

Pi Agent Core:

```bash
SMARTPERFETTO_AGENT_RUNTIME=pi-agent-core
SMARTPERFETTO_PI_AGENT_CORE_MODEL_JSON='{"id":"your-model-id","name":"Your Model","api":"openai-responses","provider":"openai","baseUrl":"https://api.openai.com/v1","reasoning":false,"input":["text"],"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0},"contextWindow":128000,"maxTokens":4096,"apiKeyEnv":"OPENAI_API_KEY"}'
# Optional local checkout or unpacked package:
# SMARTPERFETTO_PI_AGENT_CORE_MODULE_PATH=/absolute/path/to/@earendil-works/pi-agent-core/dist/index.js
# Optional runtime-level prompt; SmartPerfetto analysis contracts still come from strategies:
# SMARTPERFETTO_PI_AGENT_CORE_SYSTEM_PROMPT=
```

`SMARTPERFETTO_PI_AGENT_CORE_MODEL_JSON` should use the
`@earendil-works/pi-ai` Model object shape. SmartPerfetto creates private Pi
`Models`, provider, and credential-store state for each runtime instance and
passes `models.streamSimple.bind(models)` explicitly to `Agent`; it does not set
a process-global default stream function. `apiKey`, `apiKeyEnv`, `credential`, `transport`,
`thinkingLevel`, `thinkingBudgets`, and `maxRetryDelayMs` may live in the same
JSON as SmartPerfetto runtime options; `apiKey` and `credential` are stripped
before the model is passed into Pi Agent Core state so they do not enter
snapshots or reports. Authentication precedence is JSON `credential` or
`apiKey`, JSON `apiKeyEnv`, the current Provider Manager runtime's isolated
environment, then the Pi provider's conventional environment variables. OAuth
uses `credential:{"type":"oauth","refresh":"...","access":"...","expires":...}`
and is accepted only for a Pi built-in provider that declares OAuth support.
SmartPerfetto does not start an interactive login during an analysis request;
near-expiry credentials are refreshed serially through that provider's Pi OAuth
contract in the instance-private credential store. The real model path uses
SmartPerfetto's shared prompt, SQL/Skill,
planning/hypothesis, and report/claim-verification pipeline.
`SMARTPERFETTO_PI_AGENT_CORE_FAKE_STREAM=1` is smoke/test-only and does not
represent real analysis quality.

The `openai-responses` example above targets the official OpenAI Responses API.
For OpenAI-compatible gateways that only expose chat/completions, set
`"api":"openai-completions"` in the JSON and use that gateway's `baseUrl`, model
id, and key.
Unknown APIs fail before Agent construction. The supported Pi text APIs are
`anthropic-messages`, `azure-openai-responses`, `bedrock-converse-stream`,
`google-generative-ai`, `google-vertex`, `mistral-conversations`,
`openai-codex-responses`, `openai-completions`, `openai-responses`, and
`pi-messages`.
For a managed custom provider, place provider-specific values such as
`DEEPSEEK_API_KEY`, `OPENROUTER_API_KEY`, `AWS_*`, `GOOGLE_*`, or
`AZURE_OPENAI_*` in that profile's custom environment overrides. SmartPerfetto
clears credentials from other profiles before constructing the runtime and
passes only the selected runtime's provider-scoped cloud environment to Pi.
To prevent the AWS SDK default credential chain from re-reading process-wide
state, Bedrock accepts only a runtime-scoped `AWS_BEARER_TOKEN_BEDROCK`, or
explicit `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` credentials (optionally
with `AWS_SESSION_TOKEN`). `AWS_PROFILE`, ECS container credentials, web
identity, and shared config/credentials files fail closed. Vertex service
accounts check only the exact file explicitly selected through
`GOOGLE_APPLICATION_CREDENTIALS`; SmartPerfetto does not probe user-home ADC.

Pi Agent Core is custom-only in Provider Manager. Removing the custom provider
or switching `SMARTPERFETTO_AGENT_RUNTIME` back to `claude-agent-sdk` /
`openai-agents-sdk` is the rollback path.

OpenCode:

```bash
SMARTPERFETTO_AGENT_RUNTIME=opencode
# Recommended when you want OpenCode-specific provider/model wiring:
SMARTPERFETTO_OPENCODE_MODEL_JSON='{"providerID":"smartperfetto","modelID":"your-model-id","baseUrl":"https://api.openai.com/v1","apiKeyEnv":"OPENAI_API_KEY","smallModel":"your-light-model"}'
OPENAI_API_KEY=sk-your-provider-key
# Optional local checkout or unpacked package:
# SMARTPERFETTO_OPENCODE_SDK_MODULE_PATH=/absolute/path/to/@opencode-ai/sdk/dist/index.js
# Optional isolated project directory; otherwise SmartPerfetto creates a temp directory:
# SMARTPERFETTO_OPENCODE_PROJECT_DIR=/absolute/path/to/empty/project
# Optional runtime-level prompt; SmartPerfetto analysis contracts still come from strategies:
# SMARTPERFETTO_OPENCODE_SYSTEM_PROMPT=
```

Alternatively, omit `SMARTPERFETTO_OPENCODE_MODEL_JSON` and configure OpenCode
through OpenAI-compatible fields:

```bash
SMARTPERFETTO_AGENT_RUNTIME=opencode
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_API_KEY=sk-your-provider-key
OPENAI_MODEL=your-model-id
OPENAI_LIGHT_MODEL=your-light-model
```

OpenCode is custom-only in Provider Manager. SmartPerfetto starts OpenCode with
isolated HOME/config/project state, disabled built-in file/shell/web/edit tools,
and a request-scoped MCP bridge for SmartPerfetto trace tools. It does not read
your personal OpenCode login or project extensions. Removing the custom provider
or switching `SMARTPERFETTO_AGENT_RUNTIME` back to `claude-agent-sdk` /
`openai-agents-sdk` is the rollback path.

## Runtime and Provider Diagnostics

SmartPerfetto does not read Codex CLI, Gemini CLI, or personal OpenCode login state; those tools manage their own config files. The `opencode` runtime is configured explicitly through Provider Manager or env. Qoder is an explicit runtime integration: after installing its optional SDK, `qoder-agent-sdk` can use the local `qodercli` login or an explicit PAT.

Qoder Agent SDK:

```bash
# Review and accept the Qoder SDK/CLI terms before this opt-in install.
# Set QODER_SKIP_DOWNLOAD=1 first when using a pre-installed compatible CLI.
npm --prefix backend install --no-save @qoder-ai/qoder-agent-sdk
SMARTPERFETTO_AGENT_RUNTIME=qoder-agent-sdk
# Optional PAT; omit it to use the local qodercli login.
# QODER_PERSONAL_ACCESS_TOKEN=your_qoder_pat
# Optional pre-installed executable override.
# QODERCLI_PATH=/absolute/path/to/qodercli
```

For the global npm CLI, install the peer beside SmartPerfetto with
`npm install -g @gracker/smartperfetto @qoder-ai/qoder-agent-sdk`.

The default Docker and portable artifacts do not install the Qoder SDK. To use
this runtime there, build a deployment that explicitly installs the optional
peer after accepting its terms. Provider Manager restricts Qoder to custom
profiles and requires either `qoderAccessToken` or `qoderCliPath`; env mode can
fall back to the local `qodercli` login.

Restart the backend after changing `.env`. Saving or activating a Provider Manager profile in the UI usually does not require a backend restart, but existing analysis sessions keep the provider source they were created with. Verify explicit env/proxy credentials with:

```bash
curl -H "Authorization: Bearer <backend-token>" http://localhost:3000/api/runtime-health
```

Read these `/api/runtime-health` fields before debugging provider complaints:

| Field | What to check |
|---|---|
| `aiEngine.credentialSource` | `provider-manager` means UI profile is active; `env-or-default` means `.env` or Claude Code fallback |
| `aiEngine.providerOverridesEnv` | `true` means `.env` changes will not affect analysis until the active provider is disabled |
| `aiEngine.runtime` | Must be `claude-agent-sdk`, `openai-agents-sdk`, `pi-agent-core`, `opencode`, or `qoder-agent-sdk`, not a provider name |
| `aiEngine.providerMode` | Shows the effective connection family, such as `anthropic_compatible_proxy` or `openai_chat_completions_compatible` |
| `aiPolicy.aiEnabled` / `aiEngine.aiEnabled` | `false` means model-backed analysis is disabled; `aiPolicy.disabledReason` explains the source |

`aiEngine.providerMode` can be:

| providerMode | Meaning |
|---|---|
| `anthropic_direct` | Uses `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` without a custom Base URL |
| `anthropic_compatible_proxy` | Uses `ANTHROPIC_BASE_URL` for a Claude Code / Anthropic-compatible provider or proxy |
| `aws_bedrock` | Uses AWS Bedrock |
| `google_vertex` | Uses Google Vertex AI |
| `openai_responses` | Uses OpenAI Agents SDK + Responses API |
| `openai_chat_completions_compatible` | Uses OpenAI Agents SDK + Chat Completions-compatible endpoint |
| `pi-agent-core` | Uses Pi Agent Core custom model JSON through the shared SmartPerfetto analysis pipeline |
| `opencode` | Uses OpenCode custom model JSON or OpenAI-compatible fields through the shared SmartPerfetto analysis pipeline |
| `qoder` | Uses the opt-in Qoder Agent SDK through a local `qodercli` login, PAT, or explicit CLI path |
| `unconfigured` | No explicit env credentials; if local `claude` works, the SDK can still use Claude Code local auth/config during analysis |

### Temporarily Disable Model-Backed Analysis

To keep trace reads, SQL, reports, Provider configuration, and deterministic
Skills available while blocking all model calls, set:

```bash
SMARTPERFETTO_AI_ENABLED=false
```

When the variable is absent, AI is enabled by default. Explicit values accept
`1/0`, `true/false`, `yes/no`, `on/off`, and `enabled/disabled`; invalid values
fail closed and are reported through authenticated `/api/runtime-health` as `aiPolicy.env.valid=false` and
`smp doctor`.

Still available while disabled: trace upload/read, SQL queries, capture config
proposals, Android capture without `--analyze`, report reads, Provider profile
list/edit/activate/runtime switching, and deterministic Skills that do not call
an LLM. Blocked: agent analyze/resume, cold scene reconstruction start,
Provider connection tests, `smp provider test`, `smp capture android --analyze`,
and LLM Skill steps. Blocked responses include `code: "AI_DISABLED"` and
`retryable: false`.

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
| `fast` | Default 50 turns (`AGENT_QUICK_MAX_TURNS` or a runtime-specific quick override), request-shaped lightweight tools | Package, process, simple facts |
| `full` | Default 100 turns (`AGENT_MAX_TURNS` or a runtime-specific override), capability-shaped full tools | Startup, scrolling, ANR, complex root-cause analysis |
| `auto` | Keyword rules, hard rules, and lightweight classifier choose the mode | Default mode |

The frontend persists the selected mode in `localStorage['ai-analysis-mode']`.

## Service Configuration

```bash
SMARTPERFETTO_BACKEND_PORT=3000
SMARTPERFETTO_FRONTEND_PORT=10000
PORT=3000
NODE_ENV=development
# Set only when the browser-visible origin differs from the local port:
# FRONTEND_URL=https://smartperfetto.example.com
# For reverse proxies, HTTPS, or custom Docker host ports:
# SMARTPERFETTO_BACKEND_PUBLIC_URL=http://localhost:3000
# Optional HTTPS issue-new endpoint for a self-hosted fork; never auto-submits.
# SMARTPERFETTO_EXTERNAL_ISSUE_URL=https://github.example.com/org/repo/issues/new
# Only when an operator confirms RFC 2544 fake-IP DNS from a local TUN:
# SMARTPERFETTO_TRACE_URL_TRUSTED_FAKE_IP_HOSTS=storage.googleapis.com
```

Default local ports:

- Backend: `3000`
- Perfetto UI: `10000`
- trace_processor HTTP RPC pool: `9100-9900`

Use `SMARTPERFETTO_BACKEND_PORT` for the backend port. `PORT` remains a
compatibility fallback for Node/Docker/PaaS environments. Use
`SMARTPERFETTO_FRONTEND_PORT` for the Perfetto UI server. Source launchers
derive the local `FRONTEND_URL` from that port, so it does not need to be
configured twice. Set `FRONTEND_URL` only when the browser-visible frontend
origin differs, such as HTTPS or a reverse proxy. When the browser cannot infer
the backend address, set `SMARTPERFETTO_BACKEND_PUBLIC_URL`.

URL Trace downloads reject private, reserved, and RFC 2544 `198.18.0.0/15`
addresses by default. If a local TUN maps a trusted public hostname to fake IP,
the deployment operator may list exact comma-separated hostnames in
`SMARTPERFETTO_TRACE_URL_TRUSTED_FAKE_IP_HOSTS`. Do not use wildcards, IPs, or
domains you do not control. This is a server-side SSRF trust boundary and
cannot be widened by an ordinary request.

## API Authentication

If the backend is exposed to multiple users or a network, set:

```bash
# Leave unset for local single-user runs.
SMARTPERFETTO_API_KEY=replace_with_a_strong_random_secret
```

This is the deployment-operator credential and has administration authority in
local/non-enterprise mode. Do not distribute it to ordinary users; enterprise
deployments should issue durable API keys with explicit roles and scopes.

Protected APIs then require:

```http
Authorization: Bearer <SMARTPERFETTO_API_KEY>
```

## OIDC Browser Login

OIDC mode turns the Web UI into an authentication gate. Startup first requests
`GET /api/auth/session`; the Perfetto application bundle loads only when the
session is `ready`. Otherwise the page shows only the OIDC login state. The
backend exchanges the authorization code, validates state, PKCE, nonce, JWT
signature, issuer, and audience, writes an `HttpOnly` session cookie, and
redirects to `FRONTEND_URL`. Browser API requests include the cookie, and
mutations also send the CSRF token returned by the session endpoint.

Without OIDC configuration, this gate is disabled and the frontend does not
probe an authentication session before starting Perfetto. The original
local/static startup behavior remains available even when the AI backend is
temporarily unavailable.

```bash
SMARTPERFETTO_OIDC_ISSUER_URL=https://idp.example.com/application/o/smartperfetto/
SMARTPERFETTO_OIDC_CLIENT_ID=smartperfetto
SMARTPERFETTO_OIDC_CLIENT_SECRET=replace_with_oidc_client_secret
SMARTPERFETTO_OIDC_REDIRECT_URI=https://smartperfetto.example.com/api/auth/oidc/callback
SMARTPERFETTO_SERVER_SECRET=replace_with_at_least_32_random_bytes
FRONTEND_URL=https://smartperfetto.example.com
```

Supplying any of the four OIDC values enables OIDC mode. A partial set makes
startup fail closed instead of falling back to a local identity.
`SMARTPERFETTO_SERVER_SECRET` is a separate server-side signing root of at
least 32 bytes and must not reuse the OIDC client secret. Sessions are fixed at
eight hours with `SameSite=Lax`; HTTPS automatically enables Secure cookies,
and scopes are fixed at `openid email profile`.

For local split-port testing through `./start.sh` or `./scripts/start-dev.sh`,
set only `SMARTPERFETTO_FRONTEND_PORT`; the launcher derives `FRONTEND_URL`.
The explicit `FRONTEND_URL` above is for domain or reverse-proxy deployments,
not a second copy of the local port setting.

For one issuer, the backend creates exactly one managed personal workspace per
OIDC subject. Different users may have the same workspace display name, but
their user IDs, workspace IDs, memberships, and data scopes remain separate.
The OIDC frontend does not let users change the workspace, backend URL, or API
key. Tenant identity is derived only from the normalized issuer and cannot be
overridden by a user claim. Built-in OIDC cannot be combined with
`SMARTPERFETTO_SSO_TRUSTED_HEADERS=true` or the legacy
`SMARTPERFETTO_API_KEY`.
OIDC automatically uses the scoped database as the only read and write
authority. No enterprise migration phase is required, and OIDC rejects the
`legacy` and `dual-write` modes that do not preserve user-level isolation.

Production mode requires HTTPS for the issuer, callback, and frontend URL and
uses Secure cookies by default. Only controlled test deployments may explicitly
set `SMARTPERFETTO_OIDC_ALLOW_INSECURE_HTTP=true`; this permits plaintext HTTP
and disables Secure cookies by default, so it must not be used on an untrusted
network. `FRONTEND_URL` must be the browser-visible frontend origin, and
must not be a container-internal address. The frontend URL and OIDC callback
must use the same scheme and hostname; their ports may differ. By default the
frontend derives the backend address from the callback origin, so
`SMARTPERFETTO_BACKEND_PUBLIC_URL` is not required. Set it only when a reverse
proxy exposes the backend under a path prefix or another base URL that cannot
be derived from the origin; its scheme, hostname, and path prefix must match
the callback. This supports split frontend and backend ports on one server
while ensuring the browser sends the `SameSite=Lax` session cookie. OIDC
deployments must use SmartPerfetto's dynamic frontend server or an equivalent
reverse proxy that injects runtime config; do not publish `frontend/` as a
backend-unaware static directory.

## Uploads and Trace Processor

```bash
MAX_FILE_SIZE=2147483648
UPLOAD_DIR=./uploads
TRACE_PROCESSOR_PATH=/path/to/trace_processor_shell
PERFETTO_PATH=/path/to/perfetto
```

`TRACE_PROCESSOR_PATH` usually does not need manual configuration.
`./start.sh` and `./scripts/start-dev.sh` prefer SHA256-pinned prebuilts. An
explicit `TRACE_PROCESSOR_PATH` is a user-owned override: launchers and backend
`predev` check only that it exists, is executable, and passes `--version`.
They never chmod it, replace it with the pinned binary, or download into it.

When changing Perfetto C++ or intentionally building the shell locally, use:

```bash
./scripts/start-dev.sh --build-from-source
```

This always runs the incremental `gn` / `ninja` source-build path for the
current Perfetto checkout and selects
`perfetto/out/ui/trace_processor_shell`, even when a prebuilt is present.

If download is blocked, use:

```bash
TRACE_PROCESSOR_PATH=/absolute/path/to/trace_processor_shell ./start.sh
TRACE_PROCESSOR_DOWNLOAD_BASE=https://your-mirror/perfetto-luci-artifacts ./start.sh
TRACE_PROCESSOR_DOWNLOAD_URL=https://your-mirror/trace_processor_shell ./start.sh
```

Mirror downloads are still checked against the SHA256 pinned in `scripts/trace-processor-pin.env`.

## Optional Android Internals Knowledge

External Wiki paths are denied by default. `SMARTPERFETTO_KNOWLEDGE_ROOTS`
only establishes the path allowlist; an operator must still acknowledge usage
rights, grant provider-send consent, build the index through the API, and select
the source in each analysis `knowledgeSourceIds` list. See
[Android Internals External Knowledge](android-internals-knowledge.en.md).

## Rate Limiting

```bash
SMARTPERFETTO_USAGE_MAX_REQUESTS=200
SMARTPERFETTO_USAGE_MAX_TRACE_REQUESTS=100
SMARTPERFETTO_USAGE_WINDOW_MS=86400000
```

Rate-limit state is lost after restart. For strict production quotas, add persistent rate limiting at the reverse proxy or API gateway layer.

## Runtime and Provider Boundary

`SMARTPERFETTO_AGENT_RUNTIME` only selects the backend orchestration runtime and only accepts `claude-agent-sdk`, `openai-agents-sdk`, `pi-agent-core`, `opencode`, or `qoder-agent-sdk`. Do not put provider names here.
