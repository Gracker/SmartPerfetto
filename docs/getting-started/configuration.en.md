# Configuration Guide

[English](configuration.en.md) | [中文](configuration.md)

Analysis runs on Pi Agent Core, which requires explicit provider credentials through the Provider Manager attached to the running instance or through env in every run mode. Claude Code login and a Base URL alone do not configure a model.

Windows portable users should complete download, extraction, and startup through the
[Windows guide](windows.en.md), then use the Provider fields on this page. Do not copy Unix
source commands into the ordinary Windows portable path.

## First Answer: Which Runtime Do I Configure?

Pi Agent Core is the only analysis runtime. What you configure is the **model endpoint**: Pi
calls that endpoint's API (Anthropic Messages, OpenAI Responses/Chat Completions, Bedrock, or
Vertex) with its model ID and credential form. Pick one source for your first setup:

| What you have | Recommended path | What to configure |
|---|---|---|
| You do not want to edit env files, or you use Docker/portable packages | UI Provider Manager | Add the provider key on the `Providers` tab, test it, then activate it |
| Anthropic API key or a Claude/Anthropic-compatible provider | Anthropic-compatible endpoint | `ANTHROPIC_*` + `CLAUDE_*` |
| OpenAI API key, Ollama, or an OpenAI-compatible provider | OpenAI-compatible endpoint | `OPENAI_*` (`OPENAI_AGENTS_PROTOCOL` selects `responses` or `chat_completions`) |
| AWS Bedrock or Google Vertex | Cloud endpoint | A Bedrock/Vertex Provider Manager profile, or `CLAUDE_CODE_USE_BEDROCK` / `CLAUDE_CODE_USE_VERTEX` env |
| A complete Pi model configuration | Explicit Pi model | `piAgentCoreModelJson` on a custom Provider Manager profile, or `SMARTPERFETTO_PI_AGENT_CORE_MODEL_JSON` |

### Migrating from a retired runtime

Claude Agent SDK and OpenAI Agents SDK are no longer selectable, and the OpenCode and Qoder
Agent SDK engines are removed. Existing configuration migrates automatically; nothing needs
editing by hand:

- **Provider profiles**: on read, a retired `agentRuntime` maps to `pi-agent-core` and records
  the endpoint the old runtime used (`apiSurface`: `claude` or `openai`). Pi keeps calling the
  same Base URL with the same model ID and the same credential form: `claudeApiKey` and
  Anthropic's own key send `x-api-key`; a dual-surface provider's shared key and
  `claudeAuthToken` send `Authorization: Bearer`; OpenAI-compatible keys send Bearer. The
  migration changes only the runtime field and drops OpenCode/Qoder-only fields; it never
  stores a synthesized model JSON, and the next normal save writes it back. An explicit
  `piAgentCoreModelJson` remains the highest-priority override.
- **`.env`**: old `SMARTPERFETTO_AGENT_RUNTIME` values (`claude-agent-sdk`,
  `openai-agents-sdk`, `opencode`, `qoder-agent-sdk`) are still accepted, all map to Pi, and log
  one deprecation warning (also shown by `smp doctor`); remove the variable. `ANTHROPIC_*`,
  `OPENAI_*`, Bedrock, and Vertex env become a Pi model.
- **Existing sessions**: on recovery, when the provider configuration, request origin, model,
  and authorization fingerprint are all unchanged, the session is rebound to Pi with a
  continuity note; any change keeps the existing "start a new session" outcome.
- **Model metadata**: the installed pi-ai catalog supplies the model when it serves that ID with
  the same API on the same host; otherwise the model is synthesized on the old API with a
  128000-token context, a 32000-token output cap for Anthropic/Bedrock/Vertex or 16384 for
  OpenAI APIs, and zero cost (display only, never a gate).

The few cases that need attention:

- An OpenCode model JSON without an OpenAI-compatible `baseURL`, or a Qoder profile (Qoder's
  own service): Pi cannot translate it and reports it explicitly; fill in the Base URL, key,
  and model in Providers and save.
- Bedrock and Vertex credentials come from the same sources the Claude runtime used. Bedrock
  takes a bearer token, then `AWS_PROFILE`, then explicit access keys; an `.env`-only setup that
  names none uses the host's AWS SDK default chain. A Bedrock Provider Manager profile must name
  one of those credentials and never falls back to the server's own AWS identity. Vertex uses
  `GOOGLE_APPLICATION_CREDENTIALS` when set and Google ADC otherwise; without `CLOUD_ML_REGION` it
  defaults to `us-east5` as Claude Code did, and it honours the `us`/`eu` multi-regions and
  `ANTHROPIC_VERTEX_BASE_URL`. A per-model `VERTEX_REGION_*` variable is reported explicitly; set
  `CLOUD_ML_REGION` instead. Credentials are resolved in-process into explicit keys before Pi
  receives them, and an ambient AWS credential-chain variable that is not part of the selected
  configuration fails explicitly.
- A Pi model JSON you write yourself cannot name an AWS profile or credential chain; name the
  profile on a Bedrock profile instead.
- Claude-only tuning (effort, budget, sub-agents) no longer applies.

If a third-party provider exposes both Claude-compatible and OpenAI-compatible endpoints, the UI can store both endpoints and one shared key, but only one side is active at runtime. With `.env` only, uncomment either the Claude-compatible block or the OpenAI-compatible block; do not enable both just to be "complete."

The AI Assistant settings panel in Perfetto UI contains `Connection`,
`Providers`, `Codebases`, and `Evolution`. The first two configure the
SmartPerfetto backend and model-provider profiles; Codebases manages code-aware
sources; Evolution operates the controlled Self-Evolution workflow on the
currently saved backend. The advanced backend auth token on the `Connection`
tab is optional; fill it only when the backend was started with
`SMARTPERFETTO_API_KEY`. It is not a model-provider key field. Model-provider
credentials can come from the backend/Docker env
files below, or from Provider Manager profiles created in the frontend.

For beginners, the UI path is the least ambiguous:

1. Start SmartPerfetto; portable packages use the actual `Open:` URL printed by the launcher, while Docker defaults to `http://localhost:10000`.
2. Open **AI Assistant Settings → Providers → Add Provider**.
3. Choose a provider and paste the **API Key**. The name, official connection URLs, and models are prefilled. Save directly, or choose a model suggestion or enter a model ID.
4. Click **Create Provider**. This only saves the profile.
5. Back in the provider list, click the plug icon to test the connection, then click the provider row or choose it in the provider switcher to activate it.
6. Verify with authenticated `/api/runtime-health`. `aiEngine.credentialSource=provider-manager` means the UI provider is active; `env-or-default` means SmartPerfetto is using env/default configuration; inspect `aiEngine.configured` to determine whether credentials are configured. Public `/health` is liveness-only.

If a key is missing, expired, or rejected, first open **AI Assistant Settings → Providers** on the current backend. Update the provider-specific credentials, URL, and model, then save, test, and activate it; Bedrock/Vertex use their respective cloud authentication fields. Configuration files for the run modes below are the fallback. Restart the backend, container, or CLI after file changes, and start a new analysis session after switching configuration.

An active Provider Manager profile overrides `.env`. To make `.env` changes take effect again, choose `System Default` in the provider switcher or deactivate the active provider.

### Built-in model options

Model inputs in **Providers** use the backend catalog as suggestions. Clear the
field to search and choose an option, or enter a newly released model ID directly
without switching to Custom Provider. Reopening a saved profile preserves its ID.
Light and sub-agent models also accept direct input. IDs keep their case; only
leading and trailing whitespace is trimmed. The provider determines availability.

The common form shows the provider, API key, and primary model. **Advanced settings**
contains the display name, light and sub-agent models, connection overrides,
and tuning. It starts collapsed; toggling it does not clear saved values. Custom,
Bedrock, and Vertex connections still expose the fields needed to configure them.

New profiles use template defaults, favoring current general-purpose, lightweight,
or automatic-routing options. Primary and light models can be the same; Custom
profiles use the primary model when no light model is specified. Pi has one
model, so light-model settings have no effect on it. Reopen settings
after updating the backend to load new options and new-profile defaults. Editing
or cloning a profile does not replace its saved values with template defaults or
change session pins. Save your selection and test the connection. Suggestions
come from public catalogs; access depends on your account, plan, and region. Experimental and
Preview labels identify experimental or preview releases.

When you edit or clone a saved **Provider**, the backend uses that provider's own
credential to try its OpenAI-compatible `/models`, Anthropic `/v1/models`, or
Ollama `/api/tags` catalog. Results are isolated by workspace, provider ID,
endpoint, protocol, and credential fingerprint, cached for six hours, and merged
only into that provider's suggestions. Unsupported catalogs, timeouts, and
authentication failures fall back silently without changing provider health. A
new, unsaved profile has no backend credential that can be reused safely, so its
first save still uses the static preset or a manually entered ID; edit it after
saving to receive live options. Bedrock and Vertex continue to use documented
static choices because they do not expose these common HTTP catalog contracts.

Model IDs differ across endpoints. Kimi Platform uses `kimi-k3`, while Kimi Code
uses `k3` / `k3-256k`. International Qwen Coding Plan has its own allowlist and
does not inherit the general API's Qwen 3.8 models. See the official
[Kimi Code model configuration](https://www.kimi.com/code/docs/en/kimi-code/models.html)
and [international Qwen Coding Plan](https://www.alibabacloud.com/help/en/model-studio/coding-plan).

Legacy options may remain for existing profiles even after provider retirement.
For example, Kimi Platform's `kimi-k2.5` has retired; select a newer model manually
using the [Kimi model catalog](https://platform.kimi.ai/docs/models). Plan catalogs
can also change, so check current plan support when a connection fails.

New Huawei MaaS profiles use `https://api.modelarts-maas.com/openai/v1` for the
OpenAI runtime. If a saved profile still uses the old `/v1` URL, edit its Base URL
in Providers manually; that legacy endpoint does not receive new models. The
Claude runtime's `/anthropic` URL is unchanged. See the official
[Huawei OpenAI-compatible API](https://support.huaweicloud.com/model-call-maas/model-call-021.html).

Maintainers update the shared catalog in
`backend/src/services/providerManager/templates.ts`, checking each template's
endpoint, region, and plan against official API IDs and keeping source links by
the corresponding entries. Options cover text analysis and tool calling; image
generation, speech, and embedding APIs are separate products. Default changes
apply only to new profiles; run template and Provider API tests. Catalog
verification does not establish a successful real-provider Agent run. The weekly
`Provider Model Catalog` GitHub Actions workflow uses configured provider secrets
to find newly visible catalog candidates. Providers without a repository secret
are reported as skipped; candidates create or update an issue and never write
external catalog data directly to `main`. A preset that is not visible to the
current credential is recorded as account, plan, region, or gateway visibility,
not treated as evidence that the model was retired.

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

npm CLI does not use the Web UI `Connection` settings. Its Provider store defaults
to `~/.smartperfetto/runtime/data/providers.json`, while a source Web backend
defaults to `backend/data/providers.json`. A Web Provider profile affects the CLI
only when both processes explicitly use the same `SMARTPERFETTO_BACKEND_DATA_DIR`.
If a hand edit leaves `providers.json` not a valid provider array (a JSON syntax
error, a missing or repeated `id`, and so on), the backend still starts but never
overwrites the file with an empty list: the Providers page and `smp provider list`
report that the file cannot be read, and every create, update, activate,
deactivate, and delete returns `provider_store_unreadable`. Analyses that follow
the active provider, or are pinned to a profile, are refused with the same code
(HTTP 409) instead of falling back to `.env`, because the file may name a
different gateway or account: the active provider is unknown, not absent.
`/health` and `smp doctor` report AI as unconfigured. A request or session that
explicitly chooses the system default (`providerId: null`) still runs on `.env`.
Repair or move the file and refresh; no restart is needed.
For first-time CLI setup, run:

```bash
smp config init
```

It creates `~/.smartperfetto/env`. When `--env-file` is not passed, the CLI loads package/source `backend/.env` first, then `~/.smartperfetto/env`, with the user file taking priority. If you pass `--env-file /path/to/env`, the CLI reads only that file. The CLI data directory (sessions, trace copies, `env`) defaults to `~/.smartperfetto`; move it with `--session-dir <path>` or the `SMARTPERFETTO_HOME` environment variable, the flag taking priority. CLI configuration follows the same rule: choose one runtime block, not every block. Use `smp provider list` and `smp provider test <providerId>` only to inspect a profile already present in the current CLI store; the CLI does not currently add, edit, or activate Provider profiles.

## Codebase Selection And Provider Authorization

Registrations under **Settings → Codebases** never attach to analysis
automatically. Each turn explicitly selects codebases and the `Locate only`
(`metadata_only`) / `Send text` (`provider_send`) mode in the composer's
"Analysis context for this turn" popover; the CLI uses `--codebase-id` and
`--code-aware`. A reachable registered live root supports bounded search without
an index; building an index is optional acceleration.

`metadata_only` can locate only relative files, line ranges, and reference
`id`s. `provider_send` requires the codebase to hold a source-text grant, and
the target file must be inside the granted scope. Registration itself cannot
grant: `POST /api/rag/codebases/register` with `sendToProvider: true` answers
400 `CODEBASE_CONSENT_DISCLOSURE_REQUIRED`. Source text is granted only after
reviewing the server-reported disclosure (include paths, exclude globs,
languages): on the Web, **Allow source text** → **Allow** ("Add and use for
analysis" goes straight to this step after registering); in the CLI,
`smp codebase authorize-content <id>` prints the disclosure and its token, and `--confirm <token>`
grants it. Widening the path scope or adding languages later never widens the
grant automatically; review and confirm again.

Operations that change a selected codebase's authorization (granting or
revoking source text, saving its scope, deleting it) change the analysis
context's authorization fingerprint: the next analysis uses a new backend
session, and conversation mode asks you to start a new conversation, so old and
new authorization cannot mix. Rebuilding an index, accepting an index
candidate, changes to unselected codebases, and identical resubmissions reset
nothing. Revoking authorization while a run is in progress ends that run.

Deployers can set `SMARTPERFETTO_CODE_AWARE=off` to disable source analysis
entirely: source tools are no longer registered, requests with `codebaseIds`
answer 409 `FEATURE_DISABLED`, and the Web context popover shows that source
analysis is disabled on the backend. See
[Code-Aware Analysis](code-aware-analysis.en.md) for management, receipts, and
evidence semantics.

## LLM Configuration

SmartPerfetto has one runtime, `pi-agent-core`. It reuses the shared prompt, SQL/Skill,
planning/hypothesis, and finalization/report pipeline, loads `@earendil-works/pi-agent-core`
on demand, and does not enable `.pi` project discovery, package extensions, shell tools, or file
tools. The model endpoint comes from a Provider Manager profile, the Anthropic/OpenAI/Bedrock/
Vertex variables in `.env`, or an explicit Pi model JSON.

An OpenAI-compatible endpoint does not require installing or logging in to Claude Code; an Anthropic endpoint does not require an OpenAI key, and a local Claude Code login does not replace explicit credentials. Real-model analysis quality should be verified with startup/scrolling E2E; fake-stream is smoke/test-only and does not represent parity.

The model source priority is: request/session `providerId`, active Provider Manager profile, then `.env`. With `.env` only, when both Anthropic and OpenAI variables exist the old rule picks the side: `SMARTPERFETTO_AGENT_RUNTIME=openai-agents-sdk` (deprecated but still read) picks OpenAI; otherwise an Anthropic key/token, Bedrock, or Vertex picks Anthropic; otherwise `OPENAI_*` is used. Do not enable both `ANTHROPIC_*` and `OPENAI_*` for first setup. An active Provider Manager profile overrides `.env` fallback; confirm the current source with `aiEngine.credentialSource` and `aiEngine.providerOverridesEnv` from authenticated `/api/runtime-health`.

Perfetto UI Provider Management can store both endpoint families for the same provider: `claudeBaseUrl` / `claudeApiKey` / `claudeAuthToken` for the Anthropic-compatible API, and `openaiBaseUrl` / `openaiApiKey` / `openaiProtocol` for the OpenAI-compatible API; `apiSurface` (`claude` or `openai`) records which side Pi calls, defaulting to the type's former default (the Anthropic side for dual-surface providers). The API returns `supportedRuntimes: ["pi-agent-core"]` for every provider; writing a retired runtime value logs a warning and lands on Pi through the migration above. Custom providers can also set `piAgentCoreModelJson` with an optional module path/system prompt as an explicit override.

Moving a provider's `apiSurface` to a different host, or changing an endpoint's
origin, requires re-entering or clearing that provider's credential; the save is
rejected otherwise, so a stored key is never sent to another host.

In enterprise mode, remote Provider Manager endpoints must use public HTTPS by
default, including DNS-result validation, and redirects must remain same-origin.
For an audited private Ollama instance or gateway, set
`SMARTPERFETTO_PROVIDER_PRIVATE_ENDPOINT_ALLOWLIST` to exact origins (scheme,
host, and port), separated by commas. Wildcards, URL paths, and broad private
network ranges are intentionally unsupported.

For dual-surface providers such as DeepSeek, Qwen, Kimi, MiMo, TokenHub, MiniMax, StepFun, SiliconFlow, and custom gateways, the UI shows a shared Provider API Key plus optional runtime-specific key overrides. If the provider uses one key for both endpoint families, fill only the shared key. `apiSurface` decides whether Pi calls the Claude-compatible URL or the OpenAI-compatible URL.

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
CLAUDE_LIGHT_MODEL=deepseek-flash
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
# OpenAI-compatible / OpenAI Responses or Chat Completions
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
| DeepSeek | `https://api.deepseek.com/anthropic` | `https://api.deepseek.com/v1` | `deepseek-v4-pro` | `deepseek-flash` |
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
OPENAI_API_KEY=sk-your-openai-key
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_AGENTS_PROTOCOL=responses
OPENAI_MODEL=gpt-5.4-mini
OPENAI_LIGHT_MODEL=gpt-5.4-mini
```

Keep official OpenAI direct connections on `OPENAI_AGENTS_PROTOCOL=responses`. `chat_completions` is a compatibility fallback for gateways, not the recommended official OpenAI path. Neither protocol resumes an earlier provider response: every question starts from fresh model context plus SmartPerfetto's bounded typed history.

Optionally set `OPENAI_ANALYSIS_REASONING_EFFORT=low` for main analysis; omitting it preserves provider defaults. Accepted configuration values are `none/minimal/low/medium/high/xhigh/max`; legal combinations depend on the selected model, API and current SDK. GLM 5.3 Flash requires thinking and rejects `none`; recognized DeepSeek Chat maps `none` to disabled thinking. This adapter currently supports explicit `max` only on recognized supported Chat interfaces; `max` on unknown gateways or Responses is not yet supported by this adapter. The variable applies only to main analysis and ordinary continuation, leaving classification and timeout closeout purpose policies intact. Start a new session after changing it; active Provider Manager isolation takes precedence over ambient env. Lower effort may change accuracy and needs workload validation; a Flash model name does not establish latency.

Ollama or OpenAI-compatible gateways:

```bash
OPENAI_BASE_URL=http://localhost:11434/v1
OPENAI_API_KEY=ollama
OPENAI_AGENTS_PROTOCOL=chat_completions
OPENAI_MODEL=qwen3:30b
OPENAI_LIGHT_MODEL=qwen3:30b
```

If a third-party provider exposes both endpoint families, fill both in Provider Manager; `apiSurface` decides which side Pi calls. With `.env` only, enable one side at a time.

Pi Agent Core:

```bash
SMARTPERFETTO_PI_AGENT_CORE_MODEL_JSON='{"id":"your-model-id","name":"Your Model","api":"openai-responses","provider":"openai","baseUrl":"https://api.openai.com/v1","reasoning":false,"input":["text"],"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0},"contextWindow":128000,"maxTokens":4096,"apiKeyEnv":"OPENAI_API_KEY"}'
# Optional local checkout or unpacked package:
# SMARTPERFETTO_PI_AGENT_CORE_MODULE_PATH=/absolute/path/to/@earendil-works/pi-agent-core/dist/index.js
# Optional runtime-level prompt; SmartPerfetto analysis contracts still come from strategies:
# SMARTPERFETTO_PI_AGENT_CORE_SYSTEM_PROMPT=
```

`SMARTPERFETTO_PI_AGENT_CORE_MODEL_JSON` should use the
`@earendil-works/pi-ai` Model object shape. SmartPerfetto creates private Pi
`Models`, provider, and credential-store state for each runtime instance and
passes an instance-private stream function with a per-purpose policy to `Agent`; it does not set
a process-global default stream function. `apiKey`, `apiKeyEnv`, `credential`, `transport`,
`thinkingLevel`, `thinkingBudgets`, and `maxRetryDelayMs` may live in the same
JSON as SmartPerfetto runtime options; `apiKey` and `credential` are stripped
before the model is passed into Pi Agent Core state so they do not enter
snapshots or reports. Authentication precedence is JSON `credential` or
`apiKey`, JSON `apiKeyEnv`, the current Provider Manager runtime's isolated
environment, then the Pi provider's conventional environment variables.

Omitting `thinkingLevel` keeps official GLM main calls on provider defaults; explicit `off` requests disabled thinking. Unsupported levels are rejected rather than silently remapped. For GLM models confirmed to support `reasoning_effort`, set model `compat:{"supportsReasoningEffort":true}` and use provider-supported `thinkingLevelMap` mappings. Classification uses its own low or off request without changing main settings; an unsupported combination is unavailable. See [runtime architecture](../architecture/agent-runtime.en.md) for the complete boundary.

OAuth
uses `credential:{"type":"oauth","refresh":"...","access":"...","expires":...}`
and is accepted only for a Pi built-in provider that declares OAuth support.
SmartPerfetto does not start an interactive login during an analysis request;
near-expiry credentials are refreshed serially through that provider's Pi OAuth
contract in the instance-private credential store. The real model path uses
SmartPerfetto's shared prompt, SQL/Skill,
planning/hypothesis, and finalization/report pipeline.
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
Bedrock credentials are resolved in-process into explicit keys before Pi
receives them, so Pi's AWS client never re-reads process-wide state: a
runtime-scoped `AWS_BEARER_TOKEN_BEDROCK`, an AWS profile (read strictly from
that profile's shared config/credentials files on each request), or explicit
`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` (optionally with
`AWS_SESSION_TOKEN`). When Bedrock is enabled without naming any credential, the
AWS SDK default chain applies (shared files, SSO, web identity, container or
instance role). That chain reads the process env, so an ambient AWS
credential-chain variable that is not part of the selected configuration fails
closed. Vertex uses the file the configuration names in
`GOOGLE_APPLICATION_CREDENTIALS`, and Google ADC otherwise.

Every Provider Manager profile runs on Pi; an explicit model JSON is needed only to override the automatic mapping.

The OpenCode and Qoder engines are removed: `SMARTPERFETTO_AGENT_RUNTIME=opencode|qoder-agent-sdk`
maps to Pi. An OpenCode configuration's OpenAI-compatible fields (or the `baseURL` / `modelID` /
`apiKey` in its model JSON) become a Pi Chat Completions model; Qoder used its own service and
cannot be translated, so switch it to an Anthropic- or OpenAI-compatible endpoint.

### Runtime and Provider Diagnostics

SmartPerfetto does not read Codex CLI, Gemini CLI, OpenCode, or Qoder login state; those tools manage their own config files.

Restart the backend after changing `.env`. Saving or activating a Provider Manager profile in the UI usually does not require a backend restart, but existing analysis sessions keep the provider source they were created with. Verify explicit env/proxy credentials with:

```bash
curl -H "Authorization: Bearer <backend-token>" http://localhost:3000/api/runtime-health
```

Read these `/api/runtime-health` fields before debugging provider complaints:

| Field | What to check |
|---|---|
| `aiEngine.credentialSource` | `provider-manager` means UI profile is active; `env-or-default` means env/default configuration, not proof of configured credentials |
| `aiEngine.providerOverridesEnv` | `true` means `.env` changes will not affect analysis until the active provider is disabled |
| `aiEngine.runtime` | Normally `pi-agent-core`, not a provider name; `aiEngine.diagnostics.modelUnavailableReason` says why an old configuration cannot be translated |
| `aiEngine.providerMode` | Shows the effective connection family, such as `anthropic_compatible_proxy` or `openai_chat_completions_compatible` |
| `aiPolicy.aiEnabled` / `aiEngine.aiEnabled` | `false` means model-backed analysis is disabled; `aiPolicy.disabledReason` explains the source |

`aiEngine.providerMode` can be:

| providerMode | Meaning |
|---|---|
| `anthropic_direct` | Uses `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` without a custom Base URL |
| `anthropic_compatible_proxy` | Uses `ANTHROPIC_BASE_URL` for a Claude Code / Anthropic-compatible provider or proxy |
| `aws_bedrock` | Uses AWS Bedrock |
| `google_vertex` | Uses Google Vertex AI |
| `openai_responses` | Uses the OpenAI Responses API |
| `openai_chat_completions_compatible` | Uses a Chat Completions-compatible endpoint |
| `pi-agent-core` | Uses Pi Agent Core (a model from the provider, env, or an explicit model JSON) through the shared SmartPerfetto analysis pipeline |
| `unconfigured` | No explicit provider credentials. Configure an API key/auth token or a supported cloud provider before analysis |

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
list/edit/activate, and Skills (no Skill step calls a model).
Blocked: agent analyze/resume, cold scene reconstruction start, Provider
connection tests, `smp provider test`, and `smp capture android --analyze`. Blocked responses include `code: "AI_DISABLED"` and
`retryable: false`. Degraded rather than blocked: the Critical path wait-chain
analysis still returns, and its AI summary (feature `critical_path_ai_summary`)
falls back to the deterministic rule summary, reported through
`aiSummary.fallbackReason: "ai_disabled"` and `aiSummary.warnings`.

The three auxiliary AI summaries degrade rather than block, and all run the same
isolated one-shot model call (no tools, no MCP servers, no user settings, no
persisted session) under the caller's Provider Manager profile:

| Feature | Entry point | When AI is unavailable |
| --- | --- | --- |
| `critical_path_ai_summary` | `POST /api/workspaces/:workspaceId/critical-path/:traceId/analyze` | Rule summary, `aiSummary.fallbackReason` + `warnings` |
| `flamegraph_ai_summary` | `POST /api/flamegraph/:traceId/analyze` | Rule summary, `aiSummary.fallbackReason` + `warnings` |
| `comparison_ai_conclusion` | AI conclusion of analysis-result comparison | Deterministic conclusion, reason in `uncertainty` |

Besides the AI switch, a model call also needs the caller's `agent:run`
permission (a viewer with only `trace:read` gets
`fallbackReason: "permission_denied"`; the comparison conclusion keeps the
`comparison:create` permission its route already requires), a provider that resolves
to a Pi model, and configured credentials. `SMARTPERFETTO_COMPARISON_AI_DISABLED=true` turns off
only the comparison conclusion and applies alongside the global switch.
Timeouts: `CRITICAL_PATH_AI_TIMEOUT_MS` and `FLAMEGRAPH_AI_TIMEOUT_MS`
(default 60000). Flamegraph hotspot analysis prefers the Rust analyzer
(`FLAMEGRAPH_ANALYZER_BIN` selects an executable; `FLAMEGRAPH_ANALYZER_TIMEOUT_MS`
defaults to 60000) and falls back to the TypeScript implementation when it is
unavailable; see [Critical Path And Flamegraph](critical-path-and-flamegraph.en.md).

## Budgets and Timeouts

Slow or local models usually need longer per-turn timeouts:

```bash
AGENT_FULL_REQUEST_TIMEOUT_MS=1200000
AGENT_STREAM_IDLE_TIMEOUT_MS=300000
AGENT_MAX_RUN_TIMEOUT_MS=3600000
AGENT_MAX_HISTORY_BYTES=4194304

CLAUDE_FULL_PER_TURN_MS=60000
CLAUDE_FULL_REQUEST_TIMEOUT_MS=1200000
CLAUDE_STREAM_IDLE_TIMEOUT_MS=300000
CLAUDE_QUICK_PER_TURN_MS=40000
CLAUDE_CLASSIFIER_TIMEOUT_MS=30000

OPENAI_FULL_PER_TURN_MS=60000
OPENAI_FULL_REQUEST_TIMEOUT_MS=1200000
OPENAI_STREAM_IDLE_TIMEOUT_MS=300000
OPENAI_MAX_RUN_TIMEOUT_MS=3600000
OPENAI_MAX_HISTORY_BYTES=4194304
OPENAI_QUICK_PER_TURN_MS=40000
OPENAI_CLASSIFIER_TIMEOUT_MS=30000
```

The shared `AGENT_*` safety limits apply to active Provider profiles;
runtime-specific values can override them on direct environment-provider paths.
`*_FULL_REQUEST_TIMEOUT_MS` is the absolute wall-clock cap for a full analysis
(20 minutes by default), even when `maxTurns × per-turn timeout` is larger.
`*_STREAM_IDLE_TIMEOUT_MS` limits how long a provider may emit no stream events
(5 minutes by default); on expiry the backend cancels the SDK and active tool
work, then completes the normal terminal event path with a `partial` result.
In the OpenAI runtime, `maxTurns × per-turn timeout` (capped by the full-mode limit above)
is only the initial deadline: each returned tool result moves it forward by the
slowest of the recent rounds, and a deadline that arrives while the provider is
still emitting text, reasoning or tool arguments is extended one per-turn step at a
time. `AGENT_MAX_RUN_TIMEOUT_MS` / `OPENAI_MAX_RUN_TIMEOUT_MS` (60 minutes by default)
bound the extended run and hold a fixed reserve for one no-tool delivery call; a
value below the initial budget is treated as the initial budget, so it limits
extensions and never shortens the original budget. When investigation still times
out after data has returned, that reserved call gives a limited conclusion from the
returned data, marked `partial` / `timeout`; with no returned data, or if the delivery
call also times out, the run ends without a deliverable conclusion.
`AGENT_MAX_HISTORY_BYTES` / `OPENAI_MAX_HISTORY_BYTES` default to 4 MiB and only bound the current-run
transcript a recovery or continuation call may resend; a larger transcript is never resent in full. It does not truncate Artifacts,
DataEnvelopes, reports, or evidence provenance.

`SMARTPERFETTO_REVIEW_STOP_WATCHDOG_MS`, `SMARTPERFETTO_FINAL_SUBMISSION` and
`SMARTPERFETTO_CONCLUSION_AUTHORING` are obsolete. Analyses deliver the plain
assistant answer with no review step after it, and Stop cancels the run. The
watchdog value is no longer read; a final-submission or declaration-syntax value
logs one warning and falls back to `assistant_text`. None of them fails startup
or a run; remove them from `.env`.

| Mode | Behavior | Use case |
|---|---|---|
| `fast` | Default 50 turns (`AGENT_QUICK_MAX_TURNS` or a runtime-specific quick override), request-shaped lightweight tools | Package, process, simple facts |
| `full` | Default 100 turns (`AGENT_MAX_TURNS` or a runtime-specific override), capability-shaped full tools | Startup, scrolling, ANR, complex root-cause analysis |
| `auto` | Shared semantic intent selects complexity; an explicit fallback applies when unavailable | Default mode |

100/50 are safety budgets for one investigation, not targets to fill. A budget
above one reserves one no-tool summary of findings, missing evidence and next steps;
the result remains partial. Closeout cannot bypass cancellation, timeouts, permissions
or cost limits. See [Turn Budgets And Closeout](../architecture/agent-runtime.en.md#turn-budgets-and-closeout).

Follow-up questions receive bounded history and can retrieve older turns on demand.
History does not widen source, owner or trace permissions, and full older answers
do not need to be sent to the model on every turn.

The frontend persists the selected mode in `localStorage['ai-analysis-mode']`.

### Evidence Retention Budget

Every claim in a conclusion has to lead back to the execution it cites, so the
runtime retains execution witnesses. They are measured in cells (columns x rows):
a witness holds every row its query returned, so a 40-column result costs forty
times a single-column one of the same length — counting captures says nothing
about memory, and counting rows says nothing about width. The default is roughly
tens of MB per session store:

```bash
SMARTPERFETTO_EVIDENCE_RETENTION_CELLS=1000000
```

Raise it when analysing wider or larger traces; a non-positive-integer value
falls back to the default. Over budget, the oldest witness goes first, and a
single oversized witness is kept rather than evicting itself. A separate capture
ceiling absorbs the fixed per-record overhead of many tiny witnesses; it is never
below the number of references one conclusion may resolve, or a conclusion would
necessarily cite evidence the product had already discarded.

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
# JSON / form request body limit (default 50mb; trace uploads use MAX_FILE_SIZE):
# BODY_LIMIT=50mb
# Scene reconstruction report disk retention (default 7 days):
# SCENE_REPORT_TTL_MS=604800000
```

Default local ports:

- Backend: `3000`
- Perfetto UI: `10000`
- trace_processor HTTP RPC pool: `9100-9900` (`TP_PORT_MIN` / `TP_PORT_MAX`)

Use `SMARTPERFETTO_BACKEND_PORT` for the backend port. `PORT` remains a
compatibility fallback for Node/Docker/PaaS environments. Use
`SMARTPERFETTO_FRONTEND_PORT` for the Perfetto UI server. Source launchers
derive the local `FRONTEND_URL` from that port, so it does not need to be
configured twice. Set `FRONTEND_URL` only when the browser-visible frontend
origin differs, such as HTTPS or a reverse proxy. When the browser cannot infer
the backend address, set `SMARTPERFETTO_BACKEND_PUBLIC_URL`.

By default the backend admits browser origins on `localhost` / `127.0.0.1` at the
frontend port (plus the 8080, 5173 and 5174 development ports) and
`FRONTEND_URL`; `CORS_ORIGINS` (comma-separated) replaces that list. A Trace
Processor WebSocket authenticated by a session cookie, trusted SSO headers, or
the keyless local identity accepts only those origins too: a page anywhere else,
including a same-site sibling subdomain or another local port, gets 403. A
session-cookie connection must also send an Origin. A connection authenticated
by a credential the page itself holds (an enterprise API key, a Bearer session
token, or the Trace Processor capability protocol) is not Origin-checked, but a
request that carries the session cookie and no `Authorization: Bearer` header
(for example, the cookie plus a capability) follows the cookie rule. A reverse proxy
must not strip the browser's `Origin` header, or trusted-SSO-header mode loses
this check.

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

In every auth mode, server-side signing (browser sessions, Trace Processor
WebSocket capabilities, external-issue review attestations, and under OIDC the
Provider secret-store encryption key) derives from one root per purpose: the
first of `SMARTPERFETTO_TP_PROXY_CAPABILITY_SECRET` (WebSocket capabilities
only), `SMARTPERFETTO_SERVER_SECRET`, `SMARTPERFETTO_SSO_COOKIE_SECRET` and
`SMARTPERFETTO_API_KEY` whose trimmed value is long enough in UTF-8 bytes (32
for capabilities and the secret store, 16 otherwise); shorter values are
skipped. OIDC is stricter at startup: if the first non-empty
`SMARTPERFETTO_SERVER_SECRET` / `SMARTPERFETTO_SSO_COOKIE_SECRET` is shorter
than 32 bytes, the backend refuses to start instead of skipping it. Enterprise
mode refuses to sign when none qualifies; other modes fall back to a random
per-process root, so sessions, WebSocket capabilities and review attestations
stop verifying after a restart. Set a `SMARTPERFETTO_SERVER_SECRET` of at least
32 bytes so every purpose shares the same root.

For local split-port testing through `./start.sh` or `./scripts/start-dev.sh`,
set only `SMARTPERFETTO_FRONTEND_PORT`; the launcher derives `FRONTEND_URL`.
The explicit `FRONTEND_URL` above is for domain or reverse-proxy deployments,
not a second copy of the local port setting.

For one issuer, the backend creates exactly one managed personal workspace per
OIDC subject. Different users may have the same workspace display name, but
their user IDs, workspace IDs, memberships, and data scopes remain separate.
The OIDC frontend does not let users change the workspace, backend URL, or API
key. Tenant identity is derived only from the normalized issuer and cannot be
overridden by a user claim. Built-in OIDC cannot be combined with an enabled
`SMARTPERFETTO_SSO_TRUSTED_HEADERS` (any of `true`, `1`, `yes`, `on`,
`enabled`) or the legacy `SMARTPERFETTO_API_KEY`; under OIDC neither HTTP
requests nor the Trace Processor WebSocket accept trusted SSO headers or
enterprise API keys.
OIDC automatically uses the scoped database as the only read and write
authority. No enterprise migration phase is required, and OIDC rejects the
`legacy` and `dual-write` modes that do not preserve user-level isolation.

Production mode requires HTTPS for the issuer, callback, and frontend URL and
uses Secure cookies by default. Only controlled test deployments may explicitly
set `SMARTPERFETTO_OIDC_ALLOW_INSECURE_HTTP=true` (any of `true`, `1`, `yes`,
`on`, `enabled`, like the other switches); this permits plaintext HTTP
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
TP_IDLE_TIMEOUT_MS=120000
```

After the last holder is released or its heartbeat expires, the backend retains a shared trace processor
for at most `TP_IDLE_TIMEOUT_MS` milliseconds (default 2 minutes; invalid or nonpositive integers fall
back to the default), then reclaims its process and port in the 30-second lease sweep. Active holders,
queries, initialization and recovery prevent reclamation. Background windows keep their existing
visibility-specific heartbeat grace. Processor reclamation does not delete uploaded files. If closing
a window does not explicitly release its holder, its heartbeat TTL must expire first. An isolated
processor can be reclaimed as soon as its last holder expires.

A trace processor waits for HTTP readiness for the larger of
`TP_STARTUP_TIMEOUT_MS` (default 30000) and the trace size ×
`TP_STARTUP_TIMEOUT_PER_GIB_MS` (default 120000 per GiB), capped at
`TP_STARTUP_TIMEOUT_MAX_MS` (default 900000). Raise them when very large traces
time out while starting on slow disks.

`UPLOAD_DIR` is the upload root; a relative path resolves against the backend
process's working directory. Uploaded trace files and their metadata live in
`${UPLOAD_DIR}/traces`, and the upload routes, the metadata, and reloading a
trace by id after a backend restart all use that one directory. Set
`SMARTPERFETTO_TRACE_UPLOAD_DIR` only to move the trace directory elsewhere; it
overrides all three together (the npm CLI uses it to keep trace copies under
its own home).

The backend never serves the upload directory as static files. Trace files are
downloaded only through the authenticated, ownership-checked trace download API
(`GET /api/traces/:id/file`, or its workspace-scoped form).

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

A mirror must keep the `<PERFETTO_ARTIFACT_VERSION>/<platform>/trace_processor_shell` layout. `PERFETTO_ARTIFACT_VERSION` in `scripts/trace-processor-pin.env` is either a release tag (e.g. `v58.2`) or the full commit SHA of a Google CI build of upstream main. The repository commits binaries only for Linux x64, macOS arm64 and Windows x64; other platforms (e.g. linux-arm64, mac-amd64), the npm CLI and Docker builds download from that directory, and Google does not promise to retain commit directories, so keep your own mirror for long-lived offline deployments. Mirror downloads are still checked against the SHA256 pinned in that file.

## Optional Document Knowledge Bases

Knowledge folders are denied by default. The local Web UI can authorize one
folder through the folder picker; server deployments set
`SMARTPERFETTO_KNOWLEDGE_ROOTS` as the path allowlist (separate several folders
with the platform path delimiter). The owner must still acknowledge usage
rights, grant provider-send consent, build the index, and select the source in
each analysis `knowledgeSourceIds` list. The Android Internals Wiki joins the
same way; see
[Using The Android Internals Wiki As A Knowledge Base](android-internals-knowledge.en.md).

## Rate Limiting

SmartPerfetto has no built-in request rate limiting and does not read the
`SMARTPERFETTO_USAGE_MAX_REQUESTS`, `SMARTPERFETTO_USAGE_MAX_TRACE_REQUESTS` or
`SMARTPERFETTO_USAGE_WINDOW_MS` settings that earlier docs listed; setting them
has no effect.

For a public or shared deployment, enable [OIDC Browser Login](#oidc-browser-login)
(or at least set `SMARTPERFETTO_API_KEY`) and rate-limit at the reverse proxy or
API gateway. Enterprise workspace quotas on trace size, concurrent runs and
monthly runs bound analysis resources; they are not per-request rate limits.

## Runtime and Provider Boundary

The backend orchestration runtime is always Pi Agent Core; a provider decides only the endpoint, model, and credentials. `SMARTPERFETTO_AGENT_RUNTIME` is deprecated: it accepts only runtime names that were once valid (`claude-agent-sdk`, `openai-agents-sdk`, `pi-agent-core`, `opencode`, `qoder-agent-sdk`), maps them all to Pi with one deprecation warning, and still rejects unknown values such as a provider name like `deepseek`.

## Pi Analysis Switches

The defaults suit most deployments; change these only for troubleshooting or rollout:

| Variable | Default | Effect |
|---|---|---|
| `SMARTPERFETTO_RUN_SUPPLEMENT` | On | Accept user supplements during a running analysis; `false` turns it off |
| `SMARTPERFETTO_EVIDENCE_FIRST` | Off | With `true`, a scene that declares `evidence_first` runs its entry Skill first; only the ANR scene declares it |
| `SMARTPERFETTO_INVESTIGATION_ACQUISITION_STATUS` | On | The first request's investigation requirements carry acquisition status; `false` turns it off |
| `SMARTPERFETTO_SKILL_RESULT_FACTS` | On | Skill results carry column notes and rule facts; `false` turns them off |

## Runtime Concurrency Candidate Admission

Shipped configuration admits no performance-concurrency candidate by default.
Only maintainers who have completed the candidate's deterministic and real-
provider A/B gates may set the following on the target backend process:

```bash
SMARTPERFETTO_ADMITTED_RUNTIME_CANDIDATES=task4,task7
```

The value accepts only a comma-separated list of `task4`, `task5`, `task6`, and
`task7`; `task8` and `task9`, retired with the OpenCode and Qoder engines, are
unknown items. Leading, trailing, or item whitespace, duplicate
items, empty items, unknown items, or any malformed value invalidate the whole
setting and admit nothing. This is a maintainer deployment boundary, not a
Provider Manager, UI, or provider-credential env option. Benchmark artifacts
never edit or activate it automatically.

- `task4`: reuse quick-evidence/focus preflight across every runtime.
- `task5`: permit bounded overlap for marked commutative reads across every runtime; other tools stay exclusive.
- `task6`: overlap independent Claude/OpenAI preflights (not applicable to Pi).
- `task7`: load independent Pi SDK/provider startup concurrently and enable quick parallel-batch scheduling; descriptor/tool gates still serialize exclusive work.

Once `task5` is admitted, safe read concurrency is on by default. The following
setting can only roll it back to exclusive execution; it cannot enable the
branch without `task5` admission:

```bash
SMARTPERFETTO_SAFE_TOOL_CONCURRENCY=false
```

Current shipped defaults remain serial because genuine deterministic admission
for every adapter is `NOT CONFIGURED`, bounded real-provider base/candidate
A/B has not run, and the admission conclusion is `INCONCLUSIVE`. Correctness
and observability fixes such as the execution guard, processor-creation
single-flight, failed-cache retry, cancellation cleanup, and internal
performance receipts remain active independently of candidate admission.

### Scoped Local Benchmark

The benchmark accepts only two distinct explicit loopback HTTP origins with
ports and never connects to remote hosts. First use an independent lifecycle
controller to start base/candidate targets and produce a receipt that binds
both target identities/config/source, distinct fresh data roots and sessions,
per-pair cache reset, the cold/warm protocol, candidate fingerprint, and output
nonce. Then run exactly one candidate:

```bash
cd backend
npm run benchmark:agent-latency -- \
  --base-url http://127.0.0.1:10000 \
  --candidate-url http://127.0.0.1:10001 \
  --runtime pi-agent-core \
  --candidate task7 \
  --candidate-config-fingerprint <lowercase-hex-fingerprint> \
  --output-run-nonce <lowercase-hex-nonce> \
  --output-dir test-output/runtime-concurrency/<fresh-run> \
  --lifecycle-receipt /absolute/path/to/lifecycle-receipt.json
```

`--candidate` must match the runtime and appear together with its candidate
fingerprint. An admissible real run requires a validated, fresh lifecycle
receipt; a result without one can only remain serial/inconclusive.
`--output-dir` must be a previously nonexistent path under
`backend/test-output/runtime-concurrency/`. That tree is Git-ignored, and old
output must never be reused.

To inspect local credential/binary availability and the harness output boundary
only, omit `--candidate`, candidate fingerprint, nonce, and lifecycle receipt.
This diagnostic still requires both loopback URLs, a runtime, and a fresh output
path, but it makes no target calls, produces no admission, and exits with a
non-success admission status:

```bash
cd backend
npm run benchmark:agent-latency -- \
  --base-url http://127.0.0.1:10000 \
  --candidate-url http://127.0.0.1:10001 \
  --runtime pi-agent-core \
  --output-dir test-output/runtime-concurrency/<fresh-diagnostic>
```

The RunManifest `RuntimePerformance` receipt is internal evidence. Public SSE
does not include admission-grade model, provider snapshot, provider usage, or
performance fields. Deterministic gates are not real-provider proof either:
record unavailable credentials, SDKs, or local login state precisely as
`NOT AVAILABLE` or `NOT CONFIGURED`.
