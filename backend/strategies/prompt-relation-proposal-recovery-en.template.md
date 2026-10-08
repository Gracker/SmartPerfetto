<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

Repair `relationProposals` with this exact format. The collection is an array. Each item is an object with only `schemaVersion`, `id`, `kind`, `direction`, `subject`, `object`, `proof`, `proofBindings`, `metricColumn`, `value`, `unit`, and `deltaDirection`. Required fields are `schemaVersion: "evidence_relation_candidate@1"`, an `id` matching `^proposal:[A-Za-z0-9][A-Za-z0-9_.:-]*$`, one listed `kind`, one listed `direction`, and `subject`. Kinds are `overlap`, `wakeup`, `blocking_state`, `binder_peer`, `lock_owner`, `comparison_delta`, or `derived`; directions are `subject_to_object`, `object_to_subject`, or `symmetric`.

`subject`, optional `object`, and optional `proof` each use only `evidenceRefId`, `sourceRef`, `sourceToolCallId`, `artifactId`, `sourceArtifactId`, `rowIndex`, `rowSelector`, `column`, and `value`. Each endpoint needs at least one nonempty identifier. Optional identifiers and `column` are nonempty strings; `rowIndex` is a nonnegative safe integer; `rowSelector` is a nonempty object with nonempty keys and string, finite-number, or boolean values. Endpoint `value` may also be null.

Optional proposal `value` is a string, finite number, or boolean and cannot be null. Optional `metricColumn` and `unit` are nonempty strings. Optional `deltaDirection` is exactly `current_minus_reference`. If `proofBindings` is present, it contains exactly both `subject` and `object`; each contains exactly nonempty string `endpointColumn` and `proofColumn`.

Keep every proposal, its valid ID, meaning and issued references unchanged; never delete or swap proposals to pass validation. This format creates candidates only; it grants no evidence, verification, relation, or causal authority.
