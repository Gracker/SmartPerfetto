# Contributing to SmartPerfetto

## Setup

Use Node.js 24 (`>=24 <25`), npm, Git, Python3 and a native C++ toolchain for
`better-sqlite3`. The repository pins Node through `.nvmrc`, `.node-version`
and Volta; supported launchers activate it when a manager is available.
Use macOS/Linux or Windows WSL2 for source development. Native Windows users
can use portable/Docker distributions.

```bash
git clone https://github.com/Gracker/SmartPerfetto.git
cd SmartPerfetto
npm ci
npm --prefix backend ci
cp backend/.env.example backend/.env
./start.sh
```

Configure a supported provider through Provider Manager or ignored `backend/.env`.
For UI/plugin work only, initialize the fork and start dev mode:

```bash
git submodule update --init --recursive
./scripts/start-dev.sh
```

Backend TypeScript and UI source reload in dev mode. Restart after environment/
dependency changes with `./scripts/restart-backend.sh`. Before shipping plugin
changes follow [frontend rules](.claude/rules/frontend.md) to produce and refresh
the committed prebuild. Normal source/Docker/portable users consume that bundle.

## Development Verification

Run the changed area's owning test tier while iterating. For combined fast root
and backend checks:

```bash
npm run verify:dev
```

This runs existing root/backend `verify:ci` checks (governance/docs/assets/quality,
validation/types/build/CLI and core lifecycle/auth/privacy/output contracts).
It does not run the full runtime, accuracy, SQL or performance suite and is not
full acceptance. Reuse passing evidence only while its files/dependencies/config/
environment remain unchanged; preserve unique assertions when sharing fixtures.

Before opening or landing a PR:

```bash
npm run verify:pr
```

The complete local gate retains all registered backend tiers, Rust and Trace/SQL
regression. Use [testing rules](.claude/rules/testing.md) for additional affected
browser/real-provider/native gates. Test tier edits must preserve suite reachability
and preparation; `npm run check:test-registration` verifies registration.

Hosted Actions uses root/backend `verify:ci` plus path-scoped Rust/native/Docker
checks. Manual `backend-agent-regression-gate.yml` with `full=true` reproduces
full hosted backend/Trace acceptance. Local passing evidence does not prove other
OS/environment behavior. Public release workflows separately check exact artifacts.
See [verification ownership](.claude/rules/testing.md#hosted-ci-and-local-verification).

## Skills, Strategies and Feedback

Skills live in `backend/skills/` and collect deterministic trace evidence;
strategies/templates live in `backend/strategies/` and own model instructions.
Do not hardcode prompts in TypeScript or analysis SQL in UI. Read the
[Skill System](docs/reference/skill-system.md), [Skill rules](.claude/rules/skills.md)
and [prompt rules](.claude/rules/prompts.md) before changing these contracts.

Run backend `validate:skills` or `validate:strategies` and scene trace regression
for affected assets; SQL changes also require SQL regression and paired
Perfetto-Skills impact review. Corpus fixtures are maintained by `Trace/catalog.json`,
not optional downloads. Keep producer units, identity and provenance across outputs.

Agent-assisted feedback reviews persisted source-run facts before opening an
unsubmitted GitHub draft. Use the
[feedback guide](docs/getting-started/agent-assisted-feedback.en.md); distinguish
facts, model assessment and user confirmation. Share only authorized sanitized
reproducers, never keys/private source/absolute paths/sensitive identities. Report
security findings through a [private advisory](https://github.com/Gracker/SmartPerfetto/security/advisories/new).

## Pull Requests and Releases

Work from main on a descriptive branch, preserve unrelated changes, commit owned
files and open a PR with the problem/result and actual verification/gaps. Check:

- Complete `verify:pr` and applicable changed-surface checks.
- No secrets, leaked private material or hand-edited generated output.
- Updated current user/architecture/API docs where behavior changes.
- Shared Skills/SQL/evidence changes include paired impact evidence.
- Perfetto submodule changes are pushed to `fork`, never Google `origin`, and
  anchored on `fork/main` before the root gitlink; see [Git rules](.claude/rules/git.md).

Use conventional descriptive commits such as `fix(agentv3): preserve run ownership`.
Versions follow SemVer; root package version is synchronized with backend and both
lockfiles using `npm run version:set -- <version>`, then checked with
`npm run version:sync -- --check`. Public release uses the
[release rules](.claude/rules/release.md) and [runbook](docs/reference/release.md).
A passing source test is distinct from registry/native/archive acceptance.

See [Documentation Center](docs/README.md),
[Architecture](docs/architecture/overview.md) and
[MCP Reference](docs/reference/mcp-tools.md) for current ownership and contracts.
Contributions are licensed under [AGPLv3](LICENSE).
