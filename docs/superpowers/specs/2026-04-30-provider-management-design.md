# Provider Management System Design

## Overview

Centralized LLM provider management for SmartPerfetto. Users can add, configure, and switch providers through a UI instead of manually editing `.env` files.

## Key Decisions

| Decision | Choice |
|----------|--------|
| Switching granularity | Global default + per-session override |
| Management entry | Full frontend UI (Settings Tab + quick dropdown) |
| Provider scope | All: Anthropic, Bedrock, Vertex, DeepSeek, OpenAI, Ollama, Custom |
| Credential storage | Server-side JSON file, no encryption (matches .env security posture) |
| Relation to .env | Coexist, provider manager takes priority; .env as fallback |
| In-flight switch behavior | New session takes effect; running analysis unaffected |

## Data Model

### ProviderConfig (stored per provider)

```typescript
interface ProviderConfig {
  id: string;                    // uuid
  name: string;                  // user-defined display name
  category: 'official' | 'custom';
  type: string;                  // official: template type; custom: user-defined identifier

  isActive: boolean;             // global active (only one true at a time)
  createdAt: string;             // ISO timestamp
  updatedAt: string;

  models: {
    primary: string;             // main analysis model
    light: string;               // verifier / classifier / summarizer
    subAgent?: string;           // sub-agent delegation model
  };

  connection: {
    baseUrl?: string;
    apiKey?: string;
    // Bedrock
    awsBearerToken?: string;
    awsAccessKeyId?: string;
    awsSecretAccessKey?: string;
    awsSessionToken?: string;
    awsProfile?: string;
    awsRegion?: string;
    // Vertex
    gcpProjectId?: string;
    gcpRegion?: string;
  };

  tuning?: {
    maxTurns?: number;
    maxBudgetUsd?: number;
    effort?: 'low' | 'medium' | 'high' | 'max';
    fullPerTurnMs?: number;
    quickPerTurnMs?: number;
    verifierTimeoutMs?: number;
    classifierTimeoutMs?: number;
    enableSubAgents?: boolean;
    enableVerification?: boolean;
  };

  custom?: {
    headers?: Record<string, string>;   // reserved for future direct-HTTP provider support
    envOverrides?: Record<string, string>;
  };
}
```

### OfficialProviderTemplate (system built-in)

```typescript
interface OfficialProviderTemplate {
  type: 'anthropic' | 'bedrock' | 'vertex' | 'deepseek' | 'openai' | 'ollama';
  displayName: string;
  requiredFields: string[];
  defaultValues: Partial<ProviderConfig>;
  availableModels: ModelOption[];
}

interface ModelOption {
  id: string;         // actual model ID sent to API
  name: string;       // display name
  tier: 'primary' | 'light';
}
```

### Official vs Custom

| | Official | Custom |
|---|---|---|
| Creation | From preset template, few required fields | Fully manual |
| Config UI | Minimal: key + region/url + model dropdown | Full: all fields editable |
| Model selection | Dropdown from preset list | Manual input |
| Connection fields | Only relevant ones shown | All shown |
| Tuning | Optional "advanced" section | Always expanded |
| Example | "Anthropic" just needs API key | Enterprise internal gateway |

### Official Template Definitions

| Type | Required Fields | Default Models |
|------|----------------|----------------|
| Anthropic | apiKey | claude-opus-4-6, claude-sonnet-4-6, claude-haiku-4-5 |
| Bedrock | awsRegion + auth method | same |
| Vertex | gcpProjectId, gcpRegion | same |
| DeepSeek | apiKey | deepseek-v4-pro, deepseek-v4-flash |
| OpenAI | apiKey | gpt-5.5, gpt-5.4-mini |
| Ollama | baseUrl | user-typed (local models) |

## Backend Architecture

### File Structure

```
backend/src/services/providerManager/
├── types.ts              # ProviderConfig, OfficialProviderTemplate, ModelOption
├── templates.ts          # Built-in official provider templates
├── providerStore.ts      # JSON file read/write + in-memory Map (singleton)
├── providerService.ts    # Business logic: CRUD, activate, validate, getEffectiveEnv
└── index.ts              # Exports

backend/src/routes/
└── providerRoutes.ts     # REST API routes
```

### Module Responsibilities

**providerStore (persistence layer):**
- Load from `backend/data/providers.json` into memory Map on startup
- Write operations: update Map → atomic write JSON (write `.tmp` then rename)
- File permissions `0600`
- Empty file or first startup initializes to `[]`

**providerService (business layer):**
- `listProviders()` — return list with credentials masked
- `getProvider(id)` — single detail (masked)
- `createProvider(input)` — validate required fields, generate id/timestamps
- `updateProvider(id, patch)` — partial update; credential fields with mask value retain original
- `deleteProvider(id)` — disallow deleting active provider
- `activateProvider(id)` — set as global active, deactivate others
- `testConnection(id)` — lightweight LLM call to verify connectivity
- `getEffectiveEnv()` — returns env vars map from active provider, or null (fallback to process.env)
- `getEnvForProvider(id)` — env vars for a specific provider (for session override)
- `getTemplates()` — return all official templates (for frontend form rendering)

### REST API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/providers` | List (masked credentials) |
| GET | `/api/v1/providers/templates` | Official template list |
| GET | `/api/v1/providers/:id` | Single provider detail |
| POST | `/api/v1/providers` | Create |
| PATCH | `/api/v1/providers/:id` | Update |
| DELETE | `/api/v1/providers/:id` | Delete |
| POST | `/api/v1/providers/:id/activate` | Set as active |
| POST | `/api/v1/providers/:id/test` | Test connectivity |
| GET | `/api/v1/providers/effective` | Current effective config (source annotated) |

## Integration: ProviderConfig → Env Vars Mapping

```typescript
function toEnvVars(provider: ProviderConfig): Record<string, string> {
  const env: Record<string, string> = {};

  switch (provider.type) {
    case 'anthropic':
      env.ANTHROPIC_API_KEY = provider.connection.apiKey!;
      if (provider.connection.baseUrl) env.ANTHROPIC_BASE_URL = provider.connection.baseUrl;
      break;

    case 'bedrock':
      env.CLAUDE_CODE_USE_BEDROCK = '1';
      if (provider.connection.awsRegion) env.AWS_REGION = provider.connection.awsRegion;
      if (provider.connection.baseUrl) env.ANTHROPIC_BEDROCK_BASE_URL = provider.connection.baseUrl;
      if (provider.connection.awsBearerToken) env.AWS_BEARER_TOKEN_BEDROCK = provider.connection.awsBearerToken;
      if (provider.connection.awsAccessKeyId) env.AWS_ACCESS_KEY_ID = provider.connection.awsAccessKeyId;
      if (provider.connection.awsSecretAccessKey) env.AWS_SECRET_ACCESS_KEY = provider.connection.awsSecretAccessKey;
      if (provider.connection.awsSessionToken) env.AWS_SESSION_TOKEN = provider.connection.awsSessionToken;
      if (provider.connection.awsProfile) env.AWS_PROFILE = provider.connection.awsProfile;
      break;

    case 'vertex':
      env.CLAUDE_CODE_USE_VERTEX = '1';
      if (provider.connection.gcpProjectId) env.ANTHROPIC_VERTEX_PROJECT_ID = provider.connection.gcpProjectId;
      if (provider.connection.gcpRegion) env.CLOUD_ML_REGION = provider.connection.gcpRegion;
      break;

    case 'deepseek':
      env.ANTHROPIC_BASE_URL = provider.connection.baseUrl || 'https://api.deepseek.com';
      env.ANTHROPIC_API_KEY = provider.connection.apiKey!;
      break;

    case 'openai':
      env.ANTHROPIC_BASE_URL = provider.connection.baseUrl || 'https://api.openai.com/v1';
      env.ANTHROPIC_API_KEY = provider.connection.apiKey!;
      break;

    case 'ollama':
      env.ANTHROPIC_BASE_URL = provider.connection.baseUrl || 'http://localhost:11434/v1';
      env.ANTHROPIC_API_KEY = 'ollama';
      break;

    case 'custom':
      if (provider.connection.apiKey) env.ANTHROPIC_API_KEY = provider.connection.apiKey;
      if (provider.connection.baseUrl) env.ANTHROPIC_BASE_URL = provider.connection.baseUrl;
      if (provider.custom?.envOverrides) Object.assign(env, provider.custom.envOverrides);
      break;
  }

  // Model config
  env.CLAUDE_MODEL = provider.models.primary;
  env.CLAUDE_LIGHT_MODEL = provider.models.light;
  if (provider.models.subAgent) env.CLAUDE_SUB_AGENT_MODEL = provider.models.subAgent;

  // Tuning overrides
  if (provider.tuning?.maxTurns) env.CLAUDE_MAX_TURNS = String(provider.tuning.maxTurns);
  if (provider.tuning?.effort) env.CLAUDE_EFFORT = provider.tuning.effort;
  if (provider.tuning?.maxBudgetUsd) env.CLAUDE_MAX_BUDGET_USD = String(provider.tuning.maxBudgetUsd);
  if (provider.tuning?.fullPerTurnMs) env.CLAUDE_FULL_PER_TURN_MS = String(provider.tuning.fullPerTurnMs);
  if (provider.tuning?.quickPerTurnMs) env.CLAUDE_QUICK_PER_TURN_MS = String(provider.tuning.quickPerTurnMs);
  if (provider.tuning?.verifierTimeoutMs) env.CLAUDE_VERIFIER_TIMEOUT_MS = String(provider.tuning.verifierTimeoutMs);
  if (provider.tuning?.classifierTimeoutMs) env.CLAUDE_CLASSIFIER_TIMEOUT_MS = String(provider.tuning.classifierTimeoutMs);

  return env;
}
```

## Fallback Priority Chain (high to low)

1. **Session-level override** — per-session, from quick dropdown; stored in session memory
2. **Active provider** — `isActive: true` in providerManager
3. **process.env** — `.env` file + system environment variables

### createSdkEnv Integration

```typescript
export function createSdkEnv(sessionOverrideProviderId?: string): Record<string, string | undefined> {
  const env = { ...process.env };

  const providerEnv = sessionOverrideProviderId
    ? providerService.getEnvForProvider(sessionOverrideProviderId)
    : providerService.getEffectiveEnv();

  if (providerEnv) Object.assign(env, providerEnv);

  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  delete env.CLAUDE_CODE_SESSION_ACCESS_TOKEN;
  return env;
}
```

### Session-level Override Lifecycle

- User switches in quick dropdown → frontend records `selectedProviderId` in memory
- Next analysis request body includes `providerId` field
- Backend agentRoutes passes to ClaudeRuntime → createSdkEnv(providerId)
- Override persists until user switches again or closes page

## Frontend UI

### Quick Dropdown (message input area)

- Position: beside or above the input box, compact dropdown
- Display: active provider name + model (`Bedrock · claude-sonnet-4.6`)
- Dropdown list: all configured providers, click to switch active
- Running analysis: toast "已切换，下次分析生效"
- Bottom shortcuts: "+ Add Provider" / "⚙ Manage" → navigate to Settings Tab
- Env fallback display: `env · claude-sonnet-4.6` (italic/grey)

### Settings Tab (inside AI Assistant panel)

**1. Official Providers section:**
- Card grid, one per official type
- Unconfigured: grey card, click opens minimal config form (template's requiredFields only)
- Configured: colored card, shows status (active / inactive / error), click to edit
- Model selection: dropdown from template's availableModels

**2. Custom Providers section:**
- List layout, one row per custom provider
- "+ New Custom Provider" button
- Edit form: full fields, grouped and collapsible (Connection / Models / Tuning / Advanced)

### Common Interactions

- "Test Connection" button after create/edit, calls `/api/v1/providers/:id/test`
- Delete requires confirmation
- Active badge: green "Active" indicator on card/row
- Sensitive fields: password input type; after save show masked value; empty on edit means no change

## Test Connection

### Implementation

- Per provider type, send minimal request to verify connectivity
- Anthropic / Bedrock / Vertex / Proxy: 1-token completion (`messages: [{role:"user", content:"hi"}], max_tokens: 1`)
- Ollama: call `/api/tags` to check reachability + model existence
- Timeout: 10 seconds

### Response

```typescript
interface TestResult {
  success: boolean;
  latencyMs: number;
  error?: string;           // auth error / timeout / model not found / network error
  modelVerified?: boolean;  // whether model ID is valid
}
```

### Error Classification

| Error Type | User Message | Suggested Action |
|------------|-------------|------------------|
| Auth (401/403) | "认证失败" | Check API key / token |
| Model not found | "模型不可用" | Change model ID |
| Network / timeout | "无法连接" | Check URL / network |
| Rate limit (429) | "连接成功，触发限流" | Treat as success, show warning |
| 5xx | "服务端错误" | Retry later |

## Runtime Error Handling

- No automatic fallback during analysis (preserves result consistency)
- On error: frontend shows error message + "Switch Provider and Retry" button
- Error message includes current provider name and type

## Data Security

- `providers.json` file permissions `0600`
- API responses always mask credentials (`"sk-****last4"`)
- API only accepts requests from `localhost` / `CORS_ORIGINS` (existing middleware)
- Delete provider clears in-memory credential references
- No audit log (keep simple; can add later)

## Health Check Enhancement

```json
{
  "aiEngine": {
    "runtime": "agentv3",
    "configured": true,
    "source": "provider-manager",
    "activeProvider": {
      "id": "uuid",
      "name": "公司 Bedrock",
      "type": "bedrock",
      "model": "claude-sonnet-4-6"
    }
  }
}
```

## Startup Logging

With active provider:
```
[ProviderManager] Loaded 3 providers from data/providers.json
[ProviderManager] Active: "公司 Bedrock" (bedrock, claude-sonnet-4-6)
```

Env fallback:
```
[ProviderManager] No active provider configured, using env fallback
[ProviderManager] Env fallback: ANTHROPIC_API_KEY=set, CLAUDE_MODEL=claude-sonnet-4-6
```
