<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

## Summary

<!-- 1-3 bullet points: what changed and why. -->

-
-

## Linked Issue

<!-- Link a GitHub issue if applicable, e.g., Fixes #123 -->

## Change Type

<!-- Check all that apply -->

- [ ] feat (new capability)
- [ ] fix (bug fix, no API change)
- [ ] refactor (internal cleanup, no behavior change)
- [ ] docs (documentation only)
- [ ] chore (build, CI, tooling, dependency updates)
- [ ] skill / strategy (YAML skill or `.strategy.md` / `.template.md`)

## Affected Areas

<!-- Check all that apply — helps reviewers route attention -->

- [ ] `backend/src/agentv3/` (primary runtime: ClaudeRuntime, MCP server, verifier)
- [ ] `backend/skills/` (YAML skills)
- [ ] `backend/strategies/` (`*.strategy.md`, `*.template.md`, `knowledge-*`)
- [ ] `perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/` (frontend)
- [ ] `scripts/` / `backend/scripts/` (tooling, generators)
- [ ] `.github/workflows/` (CI)
- [ ] Tests only

## Done Conditions

<!-- All code changes must satisfy these. Check after running. -->

- [ ] `cd backend && npx tsc --noEmit` → 0 errors
- [ ] `cd backend && npm run test:scene-trace-regression` → all 6 canonical traces pass
- [ ] `cd backend && npm run test:core` → green (if tests were added / modified)
- [ ] `cd backend && npm run validate:skills` → passes (for YAML skill changes)
- [ ] `cd backend && npm run validate:strategies` → passes (for strategy changes)
- [ ] New `.ts` / `.yaml` / `.sh` / `.strategy.md` files carry SPDX AGPL v3 header

## Test Plan

<!-- How did you verify this change? What would a reviewer run? -->

-

## Risk / Rollback

<!-- What could break? How do we back this out if it ships wrong? -->

-

## Notes for Reviewers

<!-- Anything else: design decisions, tradeoffs considered, follow-up work -->

-
