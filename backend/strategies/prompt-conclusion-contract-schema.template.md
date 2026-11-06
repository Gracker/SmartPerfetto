<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

No fixed headings/length/plan/calls; stay scoped. {{ackDeclarationRule}} `need_input`: empty claims only without facts.
Abnormality needs metric/scope/threshold, not latency/share/rows alone. ACK is not display. Check ns/1e6=ms, 1000/ms=fps; cite operands. Missing=unknown. Prefer quantities once. Prefer Skill units; unknown SQL units cannot certify.
{{declarationDelivery}}
`mode`: `initial_report|focused_answer|need_input`. Every `evidenceChain` item requires string `conclusionId` and `text`; conclusions: finite `rank`, string `statement`. No authored status/`parseIssues`/`bindingEligibility`/`verified`/completion receipts/`raw*`.
Claims require unique `id`, faithful `text`, `kind`, `references`, `semantics`; optional: `conclusionId`, `artifactRefs`, `relationRefs`. Kinds: `numeric`, `categorical`, `time_range`, `identity`, `causal`, `comparison`, `inference`, `recommendation`.
`check_conclusion_draft`: advisory, no coverage/pass gate; fix mistakes, keep uncertainty, deliver.
One proposition/claim: separate values/types/classifications/qualifiers. Cell predicates: one subject, not grouped rows. Aggregates: one value, not `all` members. Never disguise observations as possible inferences.
References: evidenceRefId/sourceToolCallId/sourceRef/artifactId/sourceArtifactId/rowIndex/rowSelector/column/value. Issued IDs, raw JSON types/full precision; numbers unquoted. Executions may share evidenceRefId. rowIndex: printed index, not page position (unindexed: 0). rowSelector: unique column map. Cells need locators; totalRows is metadata. Missing: `[]`, unknown. For successful empty results, cite only their emitted IDs; omit rowIndex/rowSelector/column/value (no row 0).
`sourceRef`: Trace alias, not code. `source.*`/`codebase` population/source locations require `sourceClaimBindings` `{claimId,sourceReferenceIds,traceEvidenceRefIds}` with issued IDs. Unique `claimId`; nonempty `traceEvidenceRefIds` require that same claim to own the Trace reference, else `[]`. No authored `sourceUseDecision`/status. Bindings prove no execution/causality; server checks use.
`semantics`: meaning, not proof:
- `schemaVersion`: `claim_semantics@1`; `predicate`: rule ID (unknown/unverified allowed).
- `polarity`: `affirmed|negated|undetermined`; `discourse`: `asserted|hypothetical|quoted|rejected_quote`.
- `quantifier`: `one|some|all|only`; `modality`: `certain|possible|undetermined`; `conditions`?: strings.
- `scope.population`: `cited_rows|selected_interval|process_instance|trace|codebase`; `subjectRefs/objectRefs`: arrays, omitted only if rule permits. `timeRangeNs`?: ordered decimal-ns strings `{start,end}`.
- `numeric` (required by `numeric.cell`): `{operator,value,unit,presentation?}`; `eq|ne|lt|lte|gt|gte`, finite number/decimal-string value, unit; independent of cited cell.

`numeric.cell/captured.cell`: `affirmed/asserted/one/certain`, `cited_rows`; no conditions/timeRangeNs. Select exactly one original `scope.subjectRefs` cell (locator/column/raw value); `references` cannot replace it.
- `numeric.cell`: independent `numeric`; References retain exact raw cell values and native row IDs; preserve producer units. 195000000 ns = 195 ms, not 195000000 ms. Exact equivalents only; never round declarations or references. `eq` binds body literals with `presentation`; otherwise exact values or an explicitly marked fixed-decimal approximation (`约/about/≈`). No causal/advice proof. Totals/means: one captured aggregate cell matching population/window/units, never components.
- `captured.cell`: `identity/categorical`; no numeric proposition/objectRefs. Subject `value`: string/boolean/null. Strict equality, no coercion/normalization/execution/process resolution/causality. Numbers use `numeric.cell`.
Allowed unit conversions only: `ns/us/µs/μs/ms/s` (us=µs=μs; factor 1000); `Hz/kHz/MHz/GHz` (1000); `B/bytes/KiB/MiB/GiB` (B=bytes; 1024); `ratio/%/percent` (1=100%=100 percent). Aliases: frame/frames, event/events, fps/frames/s (frame rate, not Hz/count). `count` accepts frames/events 1:1, never conversely; other units must match verbatim. No cross-family conversion, inferred authority, tolerance, exponents, significant-figure rounding, ranges or ±.
Quotes: exact body/table number+unit substrings; omit `occurrence` only if unique. Repeated text: separate quotes at `occurrence:0`, `occurrence:1`, etc. Bind all occurrences, max 16/claim; decimals 0–18. Integral counts; never round IDs. Formatting proves no meaning/status.
Numeric table cells need units; `numeric` retains captured unit/value. Only presentation converts/rounds; no float loss.
Never reshape claims for rules; unknown rules/missing proof stay unverified.
```json
{{supportedProofRules}}
```
`relationProposals`: `schemaVersion:"evidence_relation_candidate@1"`, unique `proposal:` id; kind `overlap|wakeup|blocking_state|binder_peer|lock_owner|comparison_delta|derived`; direction `subject_to_object|object_to_subject|symmetric`; subject reference; optional object/proof references, proofBindings, metricColumn, value, unit, deltaDirection `current_minus_reference`. Keep meanings; claims use relationRefs. Matches prove no causality/verification.
Compact JSON keeps all fields/claims/values; losslessly escape `<`/`>`/`&` as `\u003c`/`\u003e`/`\u0026` and string newlines/quotes; no comments/ellipses.
