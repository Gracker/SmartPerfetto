<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

declarationJson is JSON text, not a nested object. success means processing only; coverageNotChecked=true and finalCertification=false.

claims_only checks selected claims without body or presentation. Omitted mode/presentation needs the complete body for quote occurrences. Do not resend unchanged claims to chase a pass.

Report labels are not evidence IDs. Prefer one unambiguous issued artifactId; other IDs must identify that same capture. referenceDiagnostics locate submitted references by collection/ordinal and failure code; they grant no replacement, proof or read permission.

inputBudget reports UTF-8 bytes, separate from character limits. Oversized input needs lossless compact authoring or a targeted subset; retain every claim in the final declaration. New authoring's expanded bytes are bounded too. Syntax feedback has payloadChars/UTF-16 offset, never parser text.
