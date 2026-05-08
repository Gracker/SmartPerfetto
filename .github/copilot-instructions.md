# SmartPerfetto Copilot Instructions

Read `AGENTS.md` first. It is the canonical project-level guide for agentic
development in this repository. For area-specific details, read:

- `.claude/rules/backend.md`
- `.claude/rules/frontend.md`
- `.claude/rules/prompts.md`
- `.claude/rules/skills.md`
- `.claude/rules/testing.md`
- `.claude/rules/git.md`

Core rules:

- Use Node.js 24 LTS and TypeScript strict-mode patterns already present in the
  codebase.
- Do not hardcode prompt content in TypeScript. Put prompt content in
  `backend/strategies/*.strategy.md` or `backend/strategies/*.template.md`.
- Put deterministic trace-analysis logic in `backend/skills/**/*.skill.yaml`.
- Do not manually edit generated files; fix the generator/template and
  regenerate.
- `./start.sh` is the default local/user path and serves committed `frontend/`.
  Use `./scripts/start-dev.sh` only when modifying the Perfetto UI plugin.
- After changes under `perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/`,
  verify in dev mode and run `./scripts/update-frontend.sh`.
- Windows EXE releases must use the clean, versioned workflow in `AGENTS.md`
  and `.claude/rules/git.md`: commit the version bump first, build
  `smartperfetto-v<version>-windows-x64.zip`, verify its package manifest, and
  never use `--allow-dirty` for public releases.
- For runtime, MCP, memory, report, provider, or session changes, run
  `cd backend && npm run test:scene-trace-regression`.
- Before opening or landing a PR, run `npm run verify:pr` from the repository
  root.
