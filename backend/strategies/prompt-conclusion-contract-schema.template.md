<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

No imposed headings/length/plan/calls; stay in scope. Typed ACK: no declaration. `need_input`: empty claims only without facts.

Judge abnormality by metric/scope/threshold, not latency, largest share or rows alone. ACK is not display. Check arithmetic: ns/1e6=ms; 1000/ms=fps. Cite operands; missing evidence is unknown.
Prefer quantities once; refer back. Authored Skill units preferred; unknown SQL units cannot certify.

Compose body+declaration for every fact/table cell. One top-level HTML comment outside fences/quotes/examples. Declare facts, inference, advice, negation, uncertainty, qualifiers, quotations and causality. Unused arrays: `[]`.

{{sidecarOpeningMarker}}
```json
{"schemaVersion":"conclusion_contract_v1","mode":"focused_answer","conclusions":[{"rank":1,"statement":"Elapsed 7.1 ms."}],"clusters":[{"cluster":"Elapsed"}],"evidenceChain":[{"conclusionId":"C1","text":"Elapsed value"}],"claims":[{"id":"elapsed","text":"Elapsed 7.1 ms.","kind":"numeric","references":[{"evidenceRefId":"data:example","rowIndex":0,"column":"elapsed_ms","value":7.123456}],"semantics":{"schemaVersion":"claim_semantics@1","predicate":"numeric.cell","polarity":"affirmed","discourse":"asserted","quantifier":"one","modality":"certain","scope":{"population":"cited_rows","subjectRefs":[{"evidenceRefId":"data:example","rowIndex":0,"column":"elapsed_ms","value":7.123456}]},"numeric":{"operator":"eq","value":7.123456,"unit":"ms","presentation":{"schemaVersion":"numeric_presentation@1","unit":"ms","decimalPlaces":1,"rounding":"half_away_from_zero","quotes":[{"text":"7.1 ms"}]}}}},{"id":"state","text":"State is ready.","kind":"categorical","references":[{"evidenceRefId":"data:example","rowIndex":0,"column":"state","value":"ready"}],"semantics":{"schemaVersion":"claim_semantics@1","predicate":"captured.cell","polarity":"affirmed","discourse":"asserted","quantifier":"one","modality":"certain","scope":{"population":"cited_rows","subjectRefs":[{"evidenceRefId":"data:example","rowIndex":0,"column":"state","value":"ready"}]}}}],"relationProposals":[],"uncertainties":["Uncertainty"],"nextSteps":["Next step"]}
```
-->

Fence JSON only. Keep its HTML comment outside prose/fences; never print an old declaration as answer.

`mode`: `initial_report|focused_answer|need_input`. Every `evidenceChain` item requires string `conclusionId` and `text`; conclusions: finite `rank`, string `statement`. Never author status, `parseIssues`, `bindingEligibility`, `verified`, completion receipts or `raw*` fields.

Every claim requires unique `id`, faithful `text`, `kind`, `references`, `semantics`; optional: `conclusionId`, `artifactRefs`, `relationRefs`. Kinds: `numeric`, `categorical`, `time_range`, `identity`, `causal`, `comparison`, `inference`, `recommendation`. Choose each stance.
`check_conclusion_draft`: advisory; fix real mistakes, retain uncertainty, deliver. No pass-chasing or coverage check.
One proposition/claim; separate values, types, classifications and qualifiers. Cell predicates select one subject, no grouped row. Aggregates are one value, not `all` members. Never disguise observations as possible inferences.

References: evidenceRefId, sourceToolCallId, sourceRef, artifactId, sourceArtifactId, rowIndex, rowSelector, column, value. Use issued IDs, raw JSON types/full precision; unquoted numbers. Executions may share evidenceRefId. rowIndex: printed index, not page position (unindexed: 0). rowSelector: unique column map, e.g. {"dump_id":1,"c":83}. Cells need locators; totalRows is metadata. Missing: `[]`, uncertainty. For successful empty results, cite only their emitted IDs; omit rowIndex/rowSelector/column/value (no row 0).

`sourceRef`: Trace alias, not code. `source.*`, `codebase` population or source locations require `sourceClaimBindings` `{claimId,sourceReferenceIds,traceEvidenceRefIds}` with issued IDs. Unique `claimId`; nonempty `traceEvidenceRefIds` require that same claim to own the Trace reference, else `[]`. Never author `sourceUseDecision`/status. Bindings prove no execution/causality; server checks use.

`semantics` declares meaning, not proof:

- `schemaVersion`: `claim_semantics@1`; `predicate`: rule ID (unknown/unverified allowed).
- `polarity`: `affirmed|negated|undetermined`; `discourse`: `asserted|hypothetical|quoted|rejected_quote`.
- `quantifier`: `one|some|all|only`; `modality`: `certain|possible|undetermined`; `conditions`?: strings.
- `scope.population`: `cited_rows|selected_interval|process_instance|trace|codebase`; `subjectRefs/objectRefs`: arrays; omit only if the rule permits. Optional `timeRangeNs`: ordered decimal-ns strings `{start,end}`.
- `numeric` (`numeric.cell` requires it): `{operator,value,unit,presentation?}`; `eq|ne|lt|lte|gt|gte`, finite number or decimal-string value, unit; independent of the cited cell.

Rule boundaries:

`numeric.cell/captured.cell`: `affirmed/asserted/one/certain`, `cited_rows`; no conditions/timeRangeNs. MUST select exactly one original `scope.subjectRefs` cell (locator/column/raw value); `references` cannot replace it.

- `numeric.cell`: independent `numeric`; References retain exact raw cell values and native row IDs; preserve producer units. 195000000 ns = 195 ms, not 195000000 ms. Exact equivalents only; never round declarations or references. `eq` binds body literals with `presentation`; otherwise exact values or an explicitly marked fixed-decimal approximation (`约/about/≈`). No causal/advice proof. Totals/means cite one captured aggregate cell matching population/window/units, never components.
- `captured.cell`: `identity/categorical`; no numeric proposition/objectRefs. Subject `value`: string/boolean/null. Strict equality, no coercion/normalization/execution/process resolution/causality. Numbers use `numeric.cell`.

Allowed unit conversions only: time `ns/us/µs/μs/ms/s` (us = µs = μs; 1000 per step); `Hz/kHz/MHz/GHz` (1000); `B/bytes/KiB/MiB/GiB` (B = bytes; 1024); `ratio/%/percent` (1 ratio = 100% = 100 percent). Aliases: frame/frames, event/events, fps/frames/s (frame rate, never Hz/count). `count` accepts frames/events 1:1, never conversely; other units must match verbatim. No cross-family conversion, inferred authority, tolerance, exponents, significant-figure rounding, ranges or ±.

Quotes: exact number+unit substrings across body/tables; omit `occurrence` only if unique. Two `7.1 ms` matches need `quotes:[{"text":"7.1 ms","occurrence":0},{"text":"7.1 ms","occurrence":1}]`. Bind every occurrence, max 16 per claim; decimals 0–18. Counts integral; IDs never round. Formatting proves no meaning/status.
Units in numeric table cells; `numeric` keeps captured unit/value. Only presentation converts/rounds; no floating-point loss.

Never reshape claims for a rule; unknown rules/missing proof stay unverified.

```json
{{supportedProofRules}}
```

`relationProposals`: `schemaVersion:"evidence_relation_candidate@1"`, unique `proposal:` id; kind `overlap|wakeup|blocking_state|binder_peer|lock_owner|comparison_delta|derived`; direction `subject_to_object|object_to_subject|symmetric`; subject reference; optional object/proof references, proofBindings, metricColumn, value, unit, deltaDirection `current_minus_reference`. Preserve meanings; link claims via relationRefs. Matches prove no causality/verification.

Compact JSON, preserving all fields/claims/values. Escape `<`, `>`, `&` as `\u003c`, `\u003e`, `\u0026` and string newlines/quotes losslessly; no comments or ellipses.
