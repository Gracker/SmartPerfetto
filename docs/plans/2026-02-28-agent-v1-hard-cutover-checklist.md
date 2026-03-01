# Agent API v1 Hard Cutover Checklist (2026-02-28)

## Goal

Freeze product surface to `/api/agent/v1/*`, keep legacy `/api/agent/*` only as temporary compatibility alias, then remove it after migration window.

## Completed in this round

- Server now mounts:
  - primary: `/api/agent/v1` and `/api/agent/v1/llm`
  - legacy alias: `/api/agent` and `/api/agent/llm` (with deprecation headers)
- Frontend plugin and assistant shell switched to `/api/agent/v1`.
- Backend tests/scripts switched to `/api/agent/v1`.
- Repository-wide scan confirms no remaining old-call sites except explicit legacy constants in `backend/src/index.ts`.
- `agentRoutes.ts` modularization started by extracting logs endpoints to `backend/src/routes/agentLogsRoutes.ts`.
- Legacy API telemetry added (`backend/src/services/legacyApiTelemetry.ts`) and wired into legacy API middleware.
- Quick scene detection endpoint extracted from `agentRoutes.ts` into `backend/src/routes/agentQuickSceneRoutes.ts`.
- Session catalog endpoint extracted into `backend/src/routes/agentSessionCatalogRoutes.ts`.
- Report endpoint extracted into `backend/src/routes/agentReportRoutes.ts`.
- Resume endpoint extracted into `backend/src/routes/agentResumeRoutes.ts`.
- Legacy `/api/agent/*` alias has been hard-cut:
  - no longer proxies to runtime routes
  - now returns `410 Gone` + migration payload + deprecation headers
- Legacy API telemetry now includes `auth-subject` dimension (user id / hashed bearer / hashed api-key).

## Remaining work after legacy alias hard-cut

1. Add contract tests:
   - `/api/agent/v1/*` should not regress event schema and status codes
   - legacy endpoint should keep `Deprecation`/`Sunset`/`Link` headers on `410` response
2. Announce removal + migration date in release notes and internal docs.
3. After legacy `410` traffic reaches near-zero for agreed window:
   - decide whether to keep explicit `410` migration response or return generic `404`.

## Current intentional legacy references

- `backend/src/index.ts`
  - `LEGACY_AGENT_API_BASE = '/api/agent'` (explicit 410 migration handler)
