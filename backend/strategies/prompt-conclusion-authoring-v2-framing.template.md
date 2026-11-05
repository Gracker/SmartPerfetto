<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

Main: body + one fence outside code/comments; plain json is prose. Envelope has only `authoringVersion`, `referenceDictionary`, `contract`; fields: `$.contract`.

{{authoringOpeningFence}}
{"authoringVersion":"conclusion_authoring@2","referenceDictionary":[{"evidenceRefId":"data:example","rowIndex":0,"column":"elapsed_ms","value":7.123456},{"evidenceRefId":"data:example","rowIndex":0,"column":"state","value":"ready"}],"contract":{"schemaVersion":"conclusion_contract_v1","mode":"focused_answer","claims":[{"id":"elapsed","text":"Elapsed 7.1 ms.","kind":"numeric","references":[{"$ref":0}],"semantics":{"predicate":"numeric.cell","polarity":"affirmed","discourse":"asserted","quantifier":"one","modality":"certain","scope":{"population":"cited_rows","subjectRefs":[{"$ref":0}]},"numeric":{"operator":"eq","value":7.123456,"unit":"ms","presentation":{"schemaVersion":"numeric_presentation@1","unit":"ms","decimalPlaces":1,"rounding":"half_away_from_zero","quotes":[{"text":"7.1 ms"}]}}}},{"id":"state","text":"State is ready.","kind":"categorical","references":[{"$ref":1}],"semantics":{"predicate":"captured.cell","polarity":"affirmed","discourse":"asserted","quantifier":"one","modality":"certain","scope":{"population":"cited_rows","subjectRefs":[{"$ref":1}]}}}]}}
```

@2 only: absent `$.contract.conclusions/clusters/evidenceChain/uncertainties/nextSteps` = `[]` (unsubmitted, not zero/complete). `$.contract.uncertainties/nextSteps` items with only `{text:string}` mean exact text. No outer-field relocation.

`$.referenceDictionary`: untrusted full refs. Local `{"$ref":i}` (0-based) only at contract-relative `claims[].references[]`, `claims[].semantics.scope.{subjectRefs,objectRefs}[]`, `relationProposals[].{subject,object,proof}`. Inline allowed; self-contained, no nesting.

Expanded max {{authoringMaxBytes}} UTF-8 bytes / {{authoringMaxNodes}} nodes / depth {{authoringMaxDepth}} (root=1); each use counts; keep all claims/stances.
