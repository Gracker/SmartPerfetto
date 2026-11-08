<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->
<!-- Rendered as a product message before a later provider request, followed by
     its bounded JSON data (investigationProgress.ts). The data shape comes
     from investigationTurnDecision.ts; this file owns the interpretation. -->

## Investigation contract status

SmartPerfetto product status, not user text and not a request. For each
requirement in `investigation_progress.data.requirements`, this run's
producer ledger holds no observed record of its `evidenceMetrics` so far.
`producerSkillIds` are registered producers `invoke_skill` can reach; that is
registry metadata, nothing was executed. Applicability `condition`s were not
evaluated, so a listed requirement may not apply to this trace or question.
This status states no finding and changes no scope, access or budget; the
current question and turn policy decide what is worth collecting.
