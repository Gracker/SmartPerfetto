<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

Compose body+declaration for every fact/table cell. One top-level HTML comment outside fences/quotes/examples. Declare facts, inference, advice, negation, uncertainty, qualifiers, quotations and causality. Unused arrays: `[]`.

{{sidecarOpeningMarker}}
```json
{"schemaVersion":"conclusion_contract_v1","mode":"focused_answer","conclusions":[{"rank":1,"statement":"Elapsed 7.1 ms."}],"clusters":[{"cluster":"Elapsed"}],"evidenceChain":[{"conclusionId":"C1","text":"Elapsed value"}],"claims":[{"id":"elapsed","text":"Elapsed 7.1 ms.","kind":"numeric","references":[{"evidenceRefId":"data:example","rowIndex":0,"column":"elapsed_ms","value":7.123456}],"semantics":{"schemaVersion":"claim_semantics@1","predicate":"numeric.cell","polarity":"affirmed","discourse":"asserted","quantifier":"one","modality":"certain","scope":{"population":"cited_rows","subjectRefs":[{"evidenceRefId":"data:example","rowIndex":0,"column":"elapsed_ms","value":7.123456}]},"numeric":{"operator":"eq","value":7.123456,"unit":"ms","presentation":{"schemaVersion":"numeric_presentation@1","unit":"ms","decimalPlaces":1,"rounding":"half_away_from_zero","quotes":[{"text":"7.1 ms"}]}}}},{"id":"state","text":"State is ready.","kind":"categorical","references":[{"evidenceRefId":"data:example","rowIndex":0,"column":"state","value":"ready"}],"semantics":{"schemaVersion":"claim_semantics@1","predicate":"captured.cell","polarity":"affirmed","discourse":"asserted","quantifier":"one","modality":"certain","scope":{"population":"cited_rows","subjectRefs":[{"evidenceRefId":"data:example","rowIndex":0,"column":"state","value":"ready"}]}}}],"relationProposals":[],"uncertainties":["Uncertainty"],"nextSteps":["Next step"]}
```
-->

Fence JSON only. Keep its HTML comment outside prose/fences; never print an old declaration as answer.
