<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

Decoded document example; JSON-escape the whole document into `documentJson`. `bodyParts` concatenate literal strings and `{"claimText":"id"}` references to exact claim text, with no inserted separators. Cover every body/table proposition; retain all findings and limits. Assertions, references and units remain independent authored fields: no capture hydration, dictionaries or aliases.

```json
{"representationVersion":"authored_claim_document@1","contract":{"schemaVersion":"conclusion_contract_v1","mode":"focused_answer","conclusions":[],"clusters":[],"evidenceChain":[],"claims":[{"id":"elapsed","text":"Elapsed 7.1 ms.","kind":"numeric","references":[{"evidenceRefId":"data:example","rowIndex":0,"column":"elapsed_ms","value":7.123456}],"semantics":{"schemaVersion":"claim_semantics@1","predicate":"numeric.cell","polarity":"affirmed","discourse":"asserted","quantifier":"one","modality":"certain","scope":{"population":"cited_rows","subjectRefs":[{"evidenceRefId":"data:example","rowIndex":0,"column":"elapsed_ms","value":7.123456}]},"numeric":{"operator":"eq","value":7.123456,"unit":"ms","presentation":{"schemaVersion":"numeric_presentation@1","unit":"ms","decimalPlaces":1,"rounding":"half_away_from_zero","quotes":[{"text":"7.1 ms"}]}}}}],"relationProposals":[],"uncertainties":[],"nextSteps":[]},"bodyParts":["## Findings\n\n",{"claimText":"elapsed"}]}
```
