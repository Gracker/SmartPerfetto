<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

Pass body and declarationJson as strings; declarationJson is JSON text, not a nested object. success means diagnostic processing only, never certification (coverageNotChecked=true; finalCertification=false).

Report labels are not issued evidence IDs. Prefer one unambiguous issued artifactId when provided; add other identifiers only for that same capture. referenceDiagnostics locate submitted references by collection/ordinal and known failure codes or identifier field names; they do not resolve replacements or authorize reads.

For input_budget_or_body_invalid, inputBudget locates the oversized input or empty body. Preserve the full body: compact JSON or diagnose claim batches against that same body, retaining every claim in the final declaration. Syntax feedback has payloadChars and an optional UTF-16 offset, never parser text.
