# Local Development

[English](local-development.en.md) | [中文](local-development.md)

## Requirements

- Node.js 24 LTS
- Python 3
- Git submodule support
- `curl`, `lsof`, `pkill`
- Working Claude Code local config, Anthropic API key, or Anthropic-compatible proxy
- Optional C++ toolchain, only needed for `--build-from-source` trace processor builds

The repository includes `.nvmrc` and `.node-version`, and `.npmrc` enables `engine-strict=true`. Local scripts first try to switch to Node 24 through nvm or fnm. If `backend/node_modules` was installed under another Node ABI, the scripts reinstall backend dependencies before starting services.

## Start Development Services

```bash
./scripts/start-dev.sh
```

The script handles backend dependencies, Perfetto UI dependencies, `trace_processor_shell`, backend `tsx watch`, and Perfetto UI `build.js --watch`.

| Service | Address |
|---|---|
| Backend | `http://localhost:3000` |
| Frontend | `http://localhost:10000` |

## When to Restart

Default to refreshing the browser.

| Change | Action |
|---|---|
| `.ts` | Watcher recompiles automatically; refresh browser |
| `.yaml` Skill | Watcher reloads automatically; refresh browser |
| `backend/strategies/*.md` | Hot-loaded in DEV mode; refresh browser |
| `.env` | `./scripts/restart-backend.sh` |
| After `npm install` | `./scripts/restart-backend.sh` |
| Both services crashed | `./scripts/start-dev.sh` |

## Directory Boundaries

```text
backend/
  src/agentRuntime/  # SDK runtime selection
  src/agentv3/       # Claude Agent SDK runtime
  src/agentOpenAI/   # OpenAI Agents SDK runtime
  src/routes/        # Express routes
  src/services/      # trace, skill, report, session services
  skills/            # YAML Skill DSL
  strategies/        # Prompt strategy/template
  tests/             # Skill eval, regression, integration tests

perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/
  ai_panel.ts
  assistant_api_v1.ts
  sse_event_handlers.ts
  sql_result_table.ts
  generated/         # generated types; do not edit manually
```

## Prompt and Skill Rules

- Do not hardcode prompt content in TypeScript.
- Put scene strategies in `backend/strategies/*.strategy.md`.
- Put reusable prompts in `backend/strategies/*.template.md`.
- Put deterministic analysis logic in `backend/skills/**/*.skill.yaml`.

## Generated Files

Do not manually edit generated files such as `perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/generated/*.ts`, `dist/`, or any file marked `Generated` / `Auto-generated`.

Frontend type sync:

```bash
cd backend
npm run generate:frontend-types
```

## Perfetto Submodule

`perfetto/` is a forked Google Perfetto submodule. SmartPerfetto maintainers push Perfetto submodule commits to the `fork` remote, not upstream `origin`.
