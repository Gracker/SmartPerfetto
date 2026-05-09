# Contributing to SmartPerfetto

Thanks for your interest in contributing! This guide covers development setup, testing, and the PR process.

## Prerequisites

- **Node.js** 24 LTS (`node -v`)
  - The repo includes `.nvmrc` / `.node-version`; `./start.sh`, `./scripts/start-dev.sh`, and `./scripts/restart-backend.sh` auto-activate Node 24 when nvm or fnm is available.
  - npm uses `engine-strict=true`; Node 20 and Node 25 are rejected for local installs.
- **Python 3** (required by Perfetto's build tools)
- **C++ toolchain** (for `better-sqlite3` native module)
  - macOS: `xcode-select --install`
  - Linux: `sudo apt-get install build-essential python3`
- **Git** with submodule support
- **macOS or Linux** — 或使用 **本机 Windows**：见 [docs/build-windows.md](docs/build-windows.md)（PowerShell 脚本 + MSVC 用于 `npm install`）；或仍可选用 Docker / WSL2（见 README）

## Development Setup

```bash
# 1. Clone with submodules
git clone --recursive https://github.com/Gracker/SmartPerfetto.git
cd SmartPerfetto

# Optional but recommended if you use nvm/fnm.
nvm install
nvm use

# 2. Configure environment
cp backend/.env.example backend/.env
# Edit backend/.env — minimum: set ANTHROPIC_API_KEY

# 3. Start everything (builds trace_processor_shell on first run, ~3-5 min)
./scripts/start-dev.sh

# 4. Open http://localhost:10000
```

### Hot Reload

Both backend and frontend auto-rebuild on file save:

- **Backend** (`tsx watch`): TypeScript changes take effect immediately
- **Frontend** (`build.js --watch`): UI changes take effect on browser refresh
- **Skills/Strategies** (`.yaml` / `.md`): Take effect on browser refresh

You only need to restart if you change `.env` or run `npm install`:
```bash
./scripts/restart-backend.sh
```

## Project Structure

```
backend/
├── src/agentv3/          # AI runtime (Claude Agent SDK)
├── src/services/         # Core services (trace processor, skill engine)
├── skills/               # YAML analysis skills (atomic/composite/pipeline/deep)
├── strategies/           # Scene strategies + prompt templates (.md)
└── __tests__/            # Unit tests

perfetto/                 # Forked Perfetto UI (submodule)
└── ui/src/plugins/com.smartperfetto.AIAssistant/  # AI panel plugin
```

## Testing (Mandatory)

Every code change must pass the PR gate before submitting a PR:

```bash
# From the repository root. Requires root and backend dependencies installed:
#   npm ci
#   cd backend && npm ci
npm run verify:pr
```

`verify:pr` runs root quality checks, backend skill/strategy validation, typecheck,
build, CLI package checks, core tests, and the 6 canonical trace regression. It
also downloads the pinned `trace_processor_shell` automatically when needed.

Useful targeted commands while iterating:

```bash
cd backend

# Required when changes touch mcp / memory / report / agent runtime; also
# included in `npm run verify:pr`. Contract-only and CRUD-only changes can run
# narrower tiers (`npx tsc --noEmit` + relevant unit tests). See README.md
# "Required checks" for the full tier table.
npm run test:scene-trace-regression

# Validate skill YAML syntax and contracts
npm run validate:skills

# Validate strategy markdown frontmatter
npm run validate:strategies

# Extended diagnostic suite. This includes legacy evals that require extra trace
# fixtures, so it is not the default PR gate.
npm test
```

### What the Regression Tests Cover

6 canonical traces (2 startup + 4 scrolling) are tested against all skills to catch regressions:

| Scene | Trace |
|-------|-------|
| Heavy launch | `lacunh_heavy.pftrace` |
| Light launch | `launch_light.pftrace` |
| Standard scroll | `scroll_Standard-AOSP-App-Without-PreAnimation.pftrace` |
| Customer scroll | `scroll-demo-customer-scroll.pftrace` |
| Flutter TextureView | `Scroll-Flutter-327-TextureView.pftrace` |
| Flutter SurfaceView | `Scroll-Flutter-SurfaceView-Wechat-Wenyiwen.pftrace` |

## Contributing Skills

Skills are YAML-based analysis pipelines. See [Skill System Guide](docs/reference/skill-system.md) for the full DSL reference.

```yaml
# backend/skills/atomic/example_skill.skill.yaml
id: example_skill
display_name: "Example Skill"
description: "What this skill detects"
steps:
  - id: query_data
    type: sql
    query: |
      SELECT ts, dur, name FROM slice WHERE name LIKE '%example%'
display:
  level: overview
```

After adding or modifying skills:
```bash
npm run validate:skills
npm run test:scene-trace-regression
```

## Contributing Strategies

Strategies are scene-specific analysis playbooks in Markdown with YAML frontmatter. They live in `backend/strategies/`.

- `*.strategy.md` — Scene strategies (scrolling, startup, ANR, ...)
- `*.template.md` — Reusable prompt templates (role, methodology, knowledge)

After modifying strategies:
```bash
npm run validate:strategies
npm run test:scene-trace-regression
```

## Pull Request Process

1. **Fork** the repository
2. **Create a branch** from `main`: `git checkout -b feat/my-feature`
3. **Make changes** and ensure all tests pass
4. **Commit** with a descriptive message:
   ```
   feat(skills): add memory pressure detection skill
   fix(agentv3): prevent duplicate hypothesis submission
   ```
5. **Push** and open a PR against `main`

### PR Checklist

- [ ] `npm run verify:pr` passes from the repository root
- [ ] Extra targeted tests for the changed area are listed in the PR test plan
- [ ] No hardcoded prompt content in TypeScript — use `.strategy.md` / `.template.md`
- [ ] No new secrets or API keys in committed files

### Commit Convention

```
type(scope): description

Types: feat, fix, refactor, docs, test, chore
Scopes: skills, agentv3, frontend, strategies, ci
```

## Key Rules

1. **Never hardcode prompts in TypeScript** — all prompt content lives in `*.strategy.md` and `*.template.md` files
2. **Never push perfetto submodule to `origin`** — always push to `fork` remote
3. **Check Perfetto stdlib first** — before writing new SQL, check if `android.*` or `linux.*` stdlib modules already provide the data
4. **Skills use `${param|default}` syntax** for parameters, templates use `{{variable}}` syntax

## Getting Help

- Open an [Issue](https://github.com/Gracker/SmartPerfetto/issues) for bugs or feature requests
- Start from the [Documentation Center](docs/README.md)
- Check [Technical Architecture](docs/architecture/technical-architecture.md) for deep dives
- Check [MCP Tools Reference](docs/reference/mcp-tools.md) for tool documentation

## Versioning

SmartPerfetto follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
The **single source of truth for the project version** is the `version` field in
[`backend/package.json`](backend/package.json). The root `package.json` exists as
a workspace entry point; keep its `version` in sync but treat it as a mirror, not
the primary. Release tags follow `vX.Y.Z` format.

When cutting a release, update `backend/package.json`, then [CHANGELOG.md](CHANGELOG.md),
then the root `package.json` to match, in that order.

## License

By contributing, you agree that your contributions will be licensed under the [GNU Affero General Public License v3.0](LICENSE).
