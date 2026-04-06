# Contributing to SmartPerfetto

Thanks for your interest in contributing! This guide covers development setup, testing, and the PR process.

## Prerequisites

- **Node.js** 18+ (`node -v`)
- **Python 3** (required by Perfetto's build tools)
- **C++ toolchain** (for `better-sqlite3` native module)
  - macOS: `xcode-select --install`
  - Linux: `sudo apt-get install build-essential python3`
- **Git** with submodule support
- **macOS or Linux** (Windows users: use Docker — see README)

## Development Setup

```bash
# 1. Clone with submodules
git clone --recursive https://github.com/Gracker/SmartPerfetto.git
cd SmartPerfetto

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

Every code change must pass the regression suite before submitting a PR:

```bash
cd backend

# Mandatory — run after EVERY change
npm run test:scene-trace-regression

# Validate skill YAML syntax and contracts
npm run validate:skills

# Validate strategy markdown frontmatter
npm run validate:strategies

# Full test suite (~8 min)
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

Skills are YAML-based analysis pipelines. See [Skill System Guide](docs/skill-system-guide.md) for the full DSL reference.

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

- [ ] `npm run test:scene-trace-regression` passes (all 6 traces)
- [ ] `npm run validate:skills` passes (if skills changed)
- [ ] `npm run validate:strategies` passes (if strategies changed)
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
- Check [Technical Architecture](docs/technical-architecture.md) for deep dives
- Check [MCP Tools Reference](docs/mcp-tools-reference.md) for tool documentation

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
