# Git & Submodule Rules

## Perfetto submodule

- `perfetto/` is a submodule forked from Google's official `google/perfetto`
- Remotes: `origin` = Google upstream, `fork` = Gracker's fork (`git@github.com:Gracker/perfetto.git`)
- **ALWAYS push to `fork` remote**, NEVER to `origin` (Google upstream)
- `.git` file inside `perfetto/` points to `.git/modules/perfetto`

## Commit workflow

1. Code changes → run the matching verification tier. Use `cd backend && npm run test:scene-trace-regression` for agent/runtime/MCP/memory/report touchpoints.
2. Run `/simplify` to review changed code.
3. Commit with descriptive message.

## Perfetto submodule landing order

When a task changes the `perfetto/` submodule:

1. Commit inside `perfetto/` first.
2. Push that submodule commit to the `fork` remote first. Never push SmartPerfetto's `perfetto/` changes to upstream `origin`.
3. Return to the root repository.
4. If the change affects the AI Assistant plugin UI or generated Perfetto UI output, run `./scripts/update-frontend.sh` and stage the resulting `frontend/` changes.
5. Stage the root submodule pointer (`perfetto` gitlink) together with any required root files, such as `frontend/`, `scripts/trace-processor-pin.env`, docs, or Docker files.
6. Commit and push the root repository only after the referenced submodule commit is already reachable from `fork`.

Do not push a root commit that points at a local-only submodule commit. Docker Hub and user installs consume the root `frontend/` prebuild and the root gitlink; both must refer to committed, pushed artifacts.
