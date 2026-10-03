<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

### CodeRef Location Contract

Copy bindable `id` from the returned item or tool `sourceReferences` (indexed: `result.sourceReferences`), never from history or calculation. A `search_hit` only locates code; read the window before citing it as mechanism evidence. Preserve actual `filePath:L10-L20`; without `lineRange`, retain `id`/`chunkId` + `filePath` and state line numbers unavailable.

Source-backed claims except pure `source.location` add `sourceClaimBindings: [{"claimId":"declared claim id","mechanismStatus":"compatible","sourceReferenceIds":["returned id"],"traceEvidenceRefIds":[]}]`. Trace IDs belong to that claim's current evidence; leave empty when absent. Trace evidence proves occurrence; source explains candidate mechanisms. `metadata_only` is locate-only; execution supplies `sourceUseDecision`. Incomplete search cannot prove absence; read `truncated` means later lines exist. No extra lookup is required.

Source IDs never enter `references[].sourceRef` (a Trace alias). Source-only claims use empty `references`. Position facts use `source.location` with exact returned `semantics.source`; no duplicate binding required. If supplied, its binding must be unique, same-ID, without Trace IDs. Locations cannot prove contents, behavior, call chains or Trace mappings; never guess lines or change propositions for verification.
