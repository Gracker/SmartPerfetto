# Product Surface Rules

Identify affected consumers before feature/bug/refactor/runtime/provider/package
work. Use [Architecture Overview](../../docs/architecture/overview.md),
[Agent Runtime](../../docs/architecture/agent-runtime.md) and
[API Reference](../../docs/reference/api.md) for ownership, routes and matrices.

## Entry Points and Content

| Surface | Entry/ownership | Boundary |
| --- | --- | --- |
| Source Web UI | `./start.sh` | IPv4 loopback; committed frontend, no UI source build for users |
| UI development | `./scripts/start-dev.sh` | Forked Perfetto plugin; regenerate shipped prebuild |
| npm CLI/capture | `smp`, `smartperfetto` | Host Node24; trace presets, optional analysis and local turn artifacts |
| Docker | `docker-compose.hub.yml` | Committed frontend/bundled processor, no host Claude login |
| Portable | Versioned Windows/macOS/Linux archives | Bundled runtimes/native modules, launcher and external user data |
| HTTP/SSE/conversation | Workspace-scoped API | Auth/scope/replay and generated contracts; preserve legacy migration behavior |
| Reports/snapshots/comparison | HTML/CLI exports and result APIs | Durable provenance; raw-trace and persisted-result comparison are distinct |
| Agent issue feedback | Per-message source-run-pinned triage | Facts/review/confirmation/draft separate; no automatic GitHub write |
| Self-Evolution | Admin settings/control plane | Default-off RBAC, fixed replay/human gate, persistence, reconciliation/revert |
| Critical path/flamegraph | Deterministic engine plus optional AI summary | Trace ownership; unavailable AI degrades explicitly, never grants permissions |

Runtime-read content includes `backend/skills/`, `backend/strategies/`, SQL/schema
indexes, rendering pipeline docs and pinned processor assets. Fix their generators
and references when changing them. Source/Docker/portable consume committed
`frontend/`; use [frontend](frontend.md) and [perfetto-sync](perfetto-sync.md).

## Runtime and Output Boundaries

Discover runtime/provider families/capabilities from the registry and architecture,
not a second hardcoded matrix. Provider Manager, env/default and recovered session
pins keep their explicit precedence. Every runtime uses fresh native context per
turn; only authorized typed history crosses turns. Source history requires the
original exact authorization fingerprint. Explicit SDK/env credentials establish
readiness; host login or a Base URL alone does not.

Live drafts/provisional/final answers, HTML reports, CLI turn artifacts, analysis
snapshots, issue drafts and generated types are separate contracts. Readability
must not remove evidence/identity/claim/source provenance or conflate native
completion with verification. Raw comparison shares trace identity/evidence/session/
report sections across CLI and UI; persisted-result comparison preserves its own
workspace/RBAC/matrix. Avoid a private CLI-only prompt/appendix.

## Change and Acceptance Checklist

Check affected surfaces, selected runtime/provider pins, scope/authorization,
current-run ownership, live/durable projections, privacy/units/evidence and
shared Skill/public export impact before choosing [testing](testing.md) tiers.

## Portable Impact Triggers

Portable impact includes startup/readiness/loopback/browser URL/shutdown/port
release; package-relative paths, external user data, layout/manifests/upgrades;
bundled runtimes/processors/native modules and signatures; macOS signing/
entitlements/notarization/staple/Gatekeeper. It is cross-platform even when the
reported issue occurs on one OS. Development uses focused contracts/package
verification. Exact-native archives are a public release gate, not a requirement for every intermediate
code edit.

Update current user/reference/architecture docs where behavior changes, including
bilingual counterparts. Self-Evolution and issue feedback need their acceptance,
config/API/privacy guides aligned. Runtime-read docs require code/Skill references
updated before moving/deleting. Avoid dated reports/plans in tracked documentation.
