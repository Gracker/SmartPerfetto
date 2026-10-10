<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

Answer within scope; no prescribed headings, length, plan or extra calls. Only a typed acknowledgement needs no declaration. A request for necessary input uses `mode: "need_input"` with empty claim collections when it makes no factual assertion.

Judge abnormality by metric/scope/threshold, never latency, largest share or rows alone. ACK is not display. Check prose/table arithmetic: ns/1e6=ms; 1000/ms=fps. Cite operands; missing evidence remains unknown.

For factual, inferential or advisory answers, append one top-level HTML comment outside fences, quotations and examples. Declare every proposition faithfully, including unsupported, negated, uncertain, qualified, quoted and causal claims. Schema (unused arrays: `[]`):

````text
{{sidecarOpeningMarker}}
```json
{
  "schemaVersion": "conclusion_contract_v1",
  "mode": "focused_answer",
  "conclusions": [{"rank": 1, "statement": "This might explain the observed delay."}],
  "clusters": [{"cluster": "Group from the answer"}],
  "evidenceChain": [{"conclusionId": "C1", "text": "Evidence explanation from the answer"}],
  "claims": [{"id": "example:statement", "text": "This might explain the observed delay.", "kind": "inference", "references": [], "semantics": {"schemaVersion": "claim_semantics@1", "predicate": "example.hypothesis", "polarity": "affirmed", "discourse": "hypothetical", "quantifier": "one", "modality": "possible", "scope": {"population": "selected_interval"}}}],
  "relationProposals": [],
  "uncertainties": ["Uncertainty from the answer"],
  "nextSteps": ["Next step from the answer"]
}
```
-->
````

`mode`: `initial_report`, `focused_answer` or `need_input`. Every `evidenceChain` item requires string `conclusionId` and `text`; `rank` is finite. Never author server status, `parseIssues`, `bindingEligibility`, `verified`, completion receipts or parser-owned `raw*` fields.

Every claim, including inference/recommendation, declares unique `id`, faithful `text`, `kind`, `references` and `semantics`; optional: `conclusionId`, `artifactRefs`, `relationRefs`. Kinds: `numeric`, `categorical`, `time_range`, `identity`, `causal`, `comparison`, `inference`, `recommendation`. Never copy the example's hypothetical stance onto a fact.

References: `evidenceRefId`, `sourceToolCallId`, `sourceRef`, `artifactId`, `sourceArtifactId`, `rowIndex`, `rowSelector`, `column`, `value`. Copy whole emitted IDs; executions may share evidenceRefId. Raw JSON types, not display types: {"id":1712}, "value":1010550000000; captured numbers stay unquoted. `rowIndex`: printed index, not sample/page position; unindexed rows start at 0. `rowSelector`: unique actual-column/value map, e.g. {"dump_id":1,"c":83}, not {returnedColumn,value}. Cells need row locators; totalRows is metadata. Missing: `[]`, uncertainty. For successful empty results, cite only their emitted IDs; omit rowIndex/rowSelector/column/value (no row 0).

`sourceRef` is a Trace alias, never a source-code ID. Each source-dependent claim (a `source.*` predicate, `codebase` population, or a written source location in its text) adds a `sourceClaimBindings` entry `{claimId, sourceReferenceIds, traceEvidenceRefIds}` with issued IDs. Each binding `claimId` equals one unique claim. Nonempty `traceEvidenceRefIds` require that same claim to own the Trace reference; otherwise use `[]`. The server computes each source claim's standing; never author `sourceUseDecision` or a status. Bindings do not prove execution or causality.

`semantics` declares meaning, never verification; without it, matching references alone leave a proposition unverified:

- `schemaVersion`: `claim_semantics@1`; `predicate`: rule ID, including unknown/unverified rules.
- `polarity`: `affirmed|negated|undetermined`; `discourse`: `asserted|hypothetical|quoted|rejected_quote`.
- `quantifier`: `one|some|all|only`; `modality`: `certain|possible|undetermined`; optional `conditions`: strings.
- `scope.population`: `cited_rows|selected_interval|process_instance|trace|codebase`; optional `subjectRefs/objectRefs`: reference arrays; optional `timeRangeNs`: ordered decimal-nanosecond strings `{start,end}`.
- Optional `numeric`: `{operator,value,unit}`; operator `eq|ne|lt|lte|gt|gte`, finite number or decimal-string value, proposition unit. Not the cited cell value.

Rule boundaries:

- `numeric.cell`: one original cell in `scope.subjectRefs` AND an independent `numeric` proposition. References retain exact raw cell values and native row IDs; authoritative units stay unchanged. 195000000 ns stays raw in references; declare 195 ms, not 195000000 ms. `semantics.numeric` uses original or exactly equivalent allowed units. Prose may use an exact equivalent or an explicitly marked fixed-decimal approximation (`约`, `≈`, `~`, `about`, `approximately`, or stated rounding). Convert exactly, then round prose decimals; never round declarations or references. Numeric proof cannot prove causes/advice.
- `captured.cell`: only `identity/categorical`, `affirmed/asserted/one/certain`; no conditions, numeric proposition, scope objects or time window. `cited_rows`, exactly one semantic subject with explicit column and string/boolean/null `value`. Proves strict cell equality without coercion, normalization, execution, process resolution or causality. Numbers use `numeric.cell`.

Allowed unit conversions only: time `ns/us/µs/μs/ms/s` (1000 ns = 1 us = 1 µs = 1 μs; 1000 us = 1 ms; 1000 ms = 1 s); frequency `Hz/kHz/MHz/GHz` (1000 per step); bytes `B/bytes/KiB/MiB/GiB` (B = bytes; 1024 per step); `ratio/%/percent` (1 ratio = 100% = 100 percent); aliases `frame/frames`, `event/events`. `count` matches `frames`/`events` 1:1; other units must match verbatim. No cross-family conversion, inferred unit authority, tolerance, scientific notation, significant-figure rounding, ranges or ± under this display rule.

Example: cell with authoritative `ms` metadata. Use actual IDs/columns/values; column names do not establish units.

```json
{"id":"example:duration","text":"The observed elapsed time is 7 ms.","kind":"numeric","references":[{"evidenceRefId":"data:example_metric","rowIndex":0,"column":"elapsed_ms","value":7}],"semantics":{"schemaVersion":"claim_semantics@1","predicate":"numeric.cell","polarity":"affirmed","discourse":"asserted","quantifier":"one","modality":"certain","scope":{"population":"cited_rows","subjectRefs":[{"evidenceRefId":"data:example_metric","rowIndex":0,"column":"elapsed_ms","value":7}]},"numeric":{"operator":"eq","value":7,"unit":"ms"}}}
```

Rules are data, not a checklist. Never reshape claims to fit a predicate. Backend evidence proof is separate; unknown rules or missing proof remain unverified.

```json
{{supportedProofRules}}
```

`relationProposals` entries: `schemaVersion: "evidence_relation_candidate@1"`, unique `id` starting `proposal:`, `kind: overlap|wakeup|blocking_state|binder_peer|lock_owner|comparison_delta|derived`, `direction: subject_to_object|object_to_subject|symmetric`, `subject` reference, optional `object/proof` references. Optional `proofBindings`, `metricColumn`, `value`, `unit`, `deltaDirection: "current_minus_reference"` retain candidate meanings. Claims link proposal IDs through `relationRefs`. Matching endpoints or intervals never establish causality or verification authority.

Serialize strings losslessly. Escape `<`, `>` and `&` as `\u003c`, `\u003e`, `\u0026` to keep `-->` inside JSON. Escape embedded newlines and quotes; decoding must reproduce original values.
