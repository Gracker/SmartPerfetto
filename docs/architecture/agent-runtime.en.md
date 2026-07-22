# Agent Runtime Architecture

[English](agent-runtime.en.md) | [中文](agent-runtime.md)

SmartPerfetto separates model SDK mechanics from Perfetto analysis capability.
The HTTP and CLI session layers depend on the shared `IOrchestrator` contract;
the concrete runtime is selected from the request provider, Provider Manager,
or environment.

| Runtime | SDK | Provider family | Notes |
|---|---|---|---|
| `claude-agent-sdk` | Claude Agent SDK | Anthropic, Bedrock, Vertex, DeepSeek, Anthropic-compatible gateways | Default runtime; supports local Claude Code auth fallback for source runs, MCP server, verifier, and sub-agent behavior |
| `openai-agents-sdk` | OpenAI Agents SDK | OpenAI, Ollama, OpenAI-compatible gateways | Native OpenAI runtime; adapts the same SmartPerfetto tools as function tools |
| `pi-agent-core` | Pi Agent Core | custom only | Optional public runtime; real model configurations reuse the shared SmartPerfetto prompt/tool/report pipeline, while fake-stream remains smoke-only; does not enable `.pi` discovery, package extensions, shell tools, or file tools |
| `opencode` | OpenCode server / SDK | custom only | Optional public runtime; uses explicit OpenAI-compatible or OpenCode model configuration, request-scoped SmartPerfetto MCP tools, and a hardened isolated OpenCode server; does not read local OpenCode login/project state or enable built-in file/shell/web/edit tools |
| `qoder-agent-sdk` | Qoder Agent SDK / `qodercli` | custom only or env | Optional public runtime; SDK is an opt-in optional peer, uses a local Qoder CLI login or PAT, exposes request-scoped SmartPerfetto MCP tools, and isolates private-knowledge streams/sessions/snapshots |

## Entry Points

HTTP analysis:

```text
POST /api/agent/v1/analyze
  -> AgentAnalyzeSessionService.prepareSession()
  -> createAgentOrchestrator()
  -> ClaudeRuntime.analyze() | OpenAIRuntime.analyze() | PiAgentCoreRuntime.analyze() | OpenCodeRuntime.analyze() | QoderRuntime.analyze()
```

Resume and scene reconstruction use the same runtime factory:

```text
POST /api/agent/v1/resume
POST /api/agent/v1/scene-reconstruct
  -> createAgentOrchestrator()
```

The npm CLI is a standalone terminal product exposed as `smp` /
`smartperfetto`. It does not start the Web UI, but it reuses the same runtime,
MCP tools, Skills, reports, and session snapshots.

## Runtime Selection

Priority, highest first:

1. `providerId` from the request or session.
2. The Provider Manager active provider.
3. `SMARTPERFETTO_AGENT_RUNTIME`.
4. Default `claude-agent-sdk`.

`SMARTPERFETTO_AGENT_RUNTIME` only accepts `claude-agent-sdk`,
`openai-agents-sdk`, `pi-agent-core`, `opencode`, or `qoder-agent-sdk`. Provider names such as
`deepseek` or `openai` are not valid runtime values. Provider Manager active profiles
override env fallback, and a resumed session keeps the provider/runtime it was
created with.

Provider mapping:

| Provider type | Runtime | Protocol |
|---|---|---|
| `anthropic` / `bedrock` / `vertex` / `deepseek` | `claude-agent-sdk` | Claude/Anthropic |
| `openai` | `openai-agents-sdk` | OpenAI Responses |
| `ollama` | `openai-agents-sdk` | OpenAI-compatible Chat Completions |
| `custom` | selected by `connection.agentRuntime` or `connection.openaiProtocol` | explicit configuration; Pi Agent Core, OpenCode, and Qoder are custom-only |

Provider connection fields map to runtime-specific env:

| Fields | Runtime | Env |
|---|---|---|
| `claudeBaseUrl` / `claudeApiKey` / `claudeAuthToken` | `claude-agent-sdk` | `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` |
| `openaiBaseUrl` / `openaiApiKey` / `openaiProtocol` | `openai-agents-sdk` | `OPENAI_BASE_URL` / `OPENAI_API_KEY` / `OPENAI_AGENTS_PROTOCOL` |
| `piAgentCoreModulePath` / `piAgentCoreModelJson` / `piAgentCoreSystemPrompt` | `pi-agent-core` | `SMARTPERFETTO_PI_AGENT_CORE_MODULE_PATH` / `SMARTPERFETTO_PI_AGENT_CORE_MODEL_JSON` / `SMARTPERFETTO_PI_AGENT_CORE_SYSTEM_PROMPT` |
| `openCodeSdkModulePath` / `openCodeModelJson` / `openCodeSystemPrompt` plus OpenAI-compatible endpoint fields | `opencode` | `SMARTPERFETTO_OPENCODE_SDK_MODULE_PATH` / `SMARTPERFETTO_OPENCODE_MODEL_JSON` / `SMARTPERFETTO_OPENCODE_SYSTEM_PROMPT` plus `OPENAI_BASE_URL` / `OPENAI_API_KEY` / `OPENAI_MODEL` when model JSON is omitted |
| `qoderAccessToken` / `qoderCliPath` / `qoderModel` / `qoderSystemPrompt` | `qoder-agent-sdk` | `QODER_PERSONAL_ACCESS_TOKEN` / `QODERCLI_PATH` / `QODER_MODEL` / `SMARTPERFETTO_QODER_SYSTEM_PROMPT` |

## Tool Layer

SmartPerfetto analysis capability is registered through
`createClaudeMcpServer()` and described through `McpToolRegistry`: SQL
execution, Skill invocation, SQL schema lookup, planning/hypothesis tools,
artifacts, memory, code-aware lookup, baselines, and comparison tools.

Claude runtime exposes these tools as an in-process MCP server. OpenAI runtime
does not duplicate tool logic; it reads the same `McpToolRegistry` and adapts
tool descriptors into OpenAI Agents SDK function tools. Pi Agent Core uses
request-scoped native tools built from the same shared descriptors, the shared
system prompt, planning/hypothesis tools, and the same route-owned
finalization/claim-verification/report pipeline without turning SmartPerfetto
into a Pi coding-agent harness. OpenCode runs a hardened isolated server and
bridges request-scoped SmartPerfetto tools through a per-analysis MCP bridge;
its built-in project discovery, file, shell, web, and edit tools are disabled
or denied. Qoder uses the SDK's in-process MCP bridge with built-in SDK tools
disabled and projects every answer token through the shared private-output
guard before SSE emission. Runtime outputs normalize into the same SSE events,
`AnalysisResult`, and HTML report contract, although their SDK/server resume
and streaming mechanics differ.

The tool surface is not a fixed-size list. Quick/full mode, artifact store
availability, codebase permission, `referenceTraceId`, comparison context, and
runtime allowlists shape the request-visible set.

The Pi Agent Core real-model path reuses SmartPerfetto scene strategies, system
prompt assembly, SQL/Skill tools, planning/hypothesis tools, artifacts, and the
route-owned quality/finalization/report pipeline. It does not read `.pi`
project configuration, package extensions, shell tools, or file tools. Provider
Manager only exposes it for `custom` providers with explicit Pi model JSON or
equivalent env configuration. `SMARTPERFETTO_PI_AGENT_CORE_FAKE_STREAM=1` is
smoke/test-only and must stay labeled capability-limited.

The OpenCode path is also custom-only. It can use `SMARTPERFETTO_OPENCODE_MODEL_JSON`
with `providerID` / `modelID` / `baseUrl` / `apiKey` fields, or fall back to
OpenAI-compatible `OPENAI_*` env/provider fields. SmartPerfetto does not reuse
the user's OpenCode CLI login, config, or project extensions; rollback is
switching the custom provider or `SMARTPERFETTO_AGENT_RUNTIME` back to
`claude-agent-sdk` / `openai-agents-sdk`.

The Qoder path is custom-only in Provider Manager and also supports an explicit
env selection. The SDK is not installed by default; users must review its terms
and opt in. Public sessions may resume by Qoder SDK session id. A run authorized
for private codebase or external knowledge never resumes or stores that opaque
provider session, and its intermediate state is excluded from durable snapshots.

## Final Result And Quality Artifacts

All runtimes normalize their raw output into a shared `AnalysisResult`, then
run through the same quality and persistence chain:

```text
runtime result
  -> agentResultNormalizer
  -> finalReportContractGate
  -> evidence contract / claim verification / identity resolutions
  -> HTML report / CLI turn files / analysis-result snapshot
  -> frontend visible projection
```

`final_report_contract` comes from strategy frontmatter. Known verifier
misdiagnosis rules also come from strategy frontmatter through
`verifier_misdiagnosis_patterns`: runtime loads scene-aware patterns, global
patterns can be shared across scenes, regexes must compile under
`validate:strategies`, and severity is limited to `warning` or `info`. Claim
verification and identity resolution depend on structured Skill/DataEnvelope
evidence. The frontend may filter noise from the visible chat conclusion, but
it must not remove provenance needed by reports, CLI artifacts, or snapshots.

## Sessions And Resume

The route layer calls `orchestrator.takeSnapshot()` and restores with
`restoreFromSnapshot()`.

Claude runtime persists the Claude SDK session id. OpenAI runtime persists
OpenAI history, the last response id, and reserved run state. Responses API can
resume with `previousResponseId`; Chat Completions-compatible providers resume
from full history.

Pi Agent Core, OpenCode, and Qoder store runtime-specific opaque state only where the
adapter supports it. They still preserve provider/runtime identity so resume,
reports, and snapshots do not silently switch to another engine.

Snapshots also carry final-result quality fields such as conclusion contracts,
claim verification results, and identity resolutions so resume, report export,
and analysis-result comparison can reuse them.

Raw trace comparison sessions must also persist `referenceTraceId`,
`comparisonSource`, and `comparisonReportSection`. A comparison session cannot
silently downgrade to single-trace mode or switch to a different reference
trace. Claude/OpenAI SDK session keys must be read and written with the
comparison identity, and Pi/OpenCode/Qoder runtime state must preserve the same
provider/runtime identity.

## Platform Boundaries

- Source runs and the npm CLI require Node.js `>=24 <25`.
- Portable packages bundle Node.js 24, backend runtime files, committed
  `frontend/`, and the pinned trace processor.
- Docker does not read host Claude Code local auth; use Provider Manager or env
  provider configuration.
- Qoder is absent from default Docker/portable/npm installs until the optional
  SDK peer is explicitly installed after its terms are accepted.
- Runtime/provider/session changes must be checked against Web UI, CLI, API,
  reports, Docker, and portable packages. See
  [`../../.claude/rules/product-surface.md`](../../.claude/rules/product-surface.md).

## Health Check

Authenticated `GET /api/runtime-health` exposes the selected runtime. Public
`GET /health` returns only liveness and version:

```json
{
  "aiEngine": {
    "runtime": "openai-agents-sdk",
    "providerMode": "openai_responses",
    "diagnostics": {
      "protocol": "responses",
      "model": "gpt-5.4-mini"
    }
  }
}
```

This distinguishes provider connectivity from the runtime that will actually
execute analysis.
