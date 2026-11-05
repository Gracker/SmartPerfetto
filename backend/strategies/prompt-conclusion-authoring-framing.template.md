<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

Body + one top-level fence outside code/comments; all body claims/stances. Plain `json` fences stay prose.

{{authoringOpeningFence}}
{"authoringVersion":"conclusion_authoring@1","referenceDictionary":[{"evidenceRefId":"data:example","rowIndex":0,"column":"elapsed_ms","value":7.123456},{"evidenceRefId":"data:example","rowIndex":0,"column":"state","value":"ready"}],"contract":{"schemaVersion":"conclusion_contract_v1","mode":"focused_answer","conclusions":[{"rank":1,"statement":"Elapsed 7.1 ms."}],"clusters":[],"evidenceChain":[],"claims":[{"id":"elapsed","text":"Elapsed 7.1 ms.","kind":"numeric","references":[{"$ref":0}],"semantics":{"predicate":"numeric.cell","polarity":"affirmed","discourse":"asserted","quantifier":"one","modality":"certain","scope":{"population":"cited_rows","subjectRefs":[{"$ref":0}]},"numeric":{"operator":"eq","value":7.123456,"unit":"ms","presentation":{"schemaVersion":"numeric_presentation@1","unit":"ms","decimalPlaces":1,"rounding":"half_away_from_zero","quotes":[{"text":"7.1 ms"}]}}}},{"id":"state","text":"State is ready.","kind":"categorical","references":[{"$ref":1}],"semantics":{"predicate":"captured.cell","polarity":"affirmed","discourse":"asserted","quantifier":"one","modality":"certain","scope":{"population":"cited_rows","subjectRefs":[{"$ref":1}]}}}],"relationProposals":[],"uncertainties":[],"nextSteps":[]}}
```

`referenceDictionary`: full untrusted references. `{"$ref":i}` copies index i (0-based) only at `claims[].references[]`, `claims[].semantics.scope.{subjectRefs,objectRefs}[]`, `relationProposals[].{subject,object,proof}`; inline refs work. Self-contained per candidate; no nested refs.

Expanded: {{authoringMaxBytes}} UTF-8 bytes / {{authoringMaxNodes}} nodes / depth {{authoringMaxDepth}} (root=1); every use/inline ref counts. Never omit claims to fit. Full-v1 also works; one frame only.
