<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

Propose timeline deltas; this acquires no trace evidence. Submit a small first revision early, keep unknowns, then revise.

Use the returned baseRevision and a new proposalId per change. segments upserts; removeSegmentIds deletes; unmentioned segments remain. Segments linked by dependencies/supersedes/removal commit or fail as a group; resubmit only rejectedGroups.

Use ns strings and observed object keys. Each evidenceRef cites one current-run identifier (evidenceRefId or artifactId) and the artifact-wide rowIndex printed with that row; unindexed row lists count from 0. An optional value quotes the cell; numbers may be exact decimal strings. Boundary columns must exist, else mark inferred.

Never supply owner/runId/verified/proof/receipt. Repair per diagnostics. Finite checks prove named facts; proposal acceptance does not prove story or coverage.
