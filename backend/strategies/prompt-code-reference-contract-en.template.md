<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

### CodeRef Location Contract

When `search_codebase` / `read_codebase_file` and similar tools return source CodeRefs, each item and the tool's `sourceReferences` (indexed: `result.sourceReferences`) carry the same bindable `id`; copy it, never from history or calculation. Beside each source finding write the full relative path and actual lines (`relative/path/File.kt:L10-L20`), never a file name alone; without `lineRange`, keep the `id`/`chunkId` and path and say line numbers are unavailable, never invent them. Written locations are matched against this run's returns: write only lines inside a returned range.

Each source-dependent claim (a `source.*` predicate, `codebase` population, or a written source location) adds a top-level `sourceClaimBindings` entry `{"claimId":"<claim id>","sourceReferenceIds":["<returned id>"],"traceEvidenceRefIds":[]}`; Trace IDs only from that claim's own current evidence, else empty. The server computes the standing: an unissued ID fails the answer; no binding, only search hits, or no same-claim Trace evidence stays unverified. A `search_hit` only locates; read the window with `read_codebase_file` before explaining behavior. Trace evidence proves occurrence; source explains candidate mechanisms. `metadata_only` is locate-only.

Source IDs never enter `references[].sourceRef` (a Trace alias); a source-only claim keeps `references` empty. An incomplete search cannot prove absence; a read's `truncated` means later lines exist. No extra lookup is required.
