# SmartPerfetto Gemini Guide

Use `AGENTS.md` as the canonical project-level instruction file. Read it before
making code changes, then read the relevant detailed file under `.claude/rules/`
for the area you are touching.

High-priority reminders:

- This project requires Node.js 24 LTS and TypeScript strict mode.
- Default startup is `./start.sh`; Perfetto UI plugin development uses
  `./scripts/start-dev.sh`.
- Do not hardcode prompt content in TypeScript. Use `backend/strategies/` for
  strategy/template text and `backend/skills/` for deterministic Skill logic.
- Do not hardcode MCP tool lists, Skill counts, scene lists, or AI output
  sections. Use the registry, strategy frontmatter, and reference docs.
- Keep final conclusions, evidence/claim verification, identity resolution,
  reports, snapshots, CLI output, and frontend chat projection as separate
  surfaces; do not make chat readability fixes by deleting provenance.
- For non-trivial tasks, follow the independent review gate in `AGENTS.md`.
- For non-trivial delegated work, also read
  `.claude/rules/agent-orchestration.md`.
- Do not hand-edit generated files.
- After AI Assistant plugin UI changes, run `./scripts/update-frontend.sh` so
  committed `frontend/` stays usable for Docker and `./start.sh` users.
- Portable releases must follow the clean, versioned workflow in
  `AGENTS.md` and `.claude/rules/git.md`: commit the version bump, build the
  Windows/macOS/Linux assets, verify package manifests, and do not use
  `--allow-dirty` for public releases.
- Use the verification matrix in `AGENTS.md`; before PR, run
  `npm run verify:pr`.
