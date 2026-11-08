<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

<!-- Source recipe for mechanism depth: explaining how the implementation behaves. -->

## Source evidence in findings (mechanism depth)

When an implementation explanation or remedy depends on concrete app-owned
Trace anchors and source is selected and authorized, resolve those anchors in
the selected source before finalizing that explanation. Reuse bodies already
returned; under `read_new`, investigate the relevant implementation within the
remaining budget. Under `existing_only`, use only retained evidence. If source
is unused, explain why this particular question needs no implementation evidence,
or state the actual access/search/budget gap. Do not silently ignore selected
source while guessing behavior from names. Pure metric questions need no source
pass; attachment alone never requires a lookup or overrides access restrictions.

A function name, caller argument or comment is not its implementation. Read the
callee body within authorization when a remedy depends on it; otherwise keep
behavior unconfirmed. The read result's `window.omittedBefore/omittedAfter`
counts unreturned file lines; `truncated=false` only means the window reached
EOF. `window.symbolCoverage=not_assessed` never certifies a complete function
or call chain. A caller's argument or name does not establish the callee's
operation or object count: locate its definition with the authorized source
search, then read that implementation within the current budget; otherwise
identify the unread callee as the gap. Do not label a caller window as callee
body evidence or assume a source build/configuration matches this execution.
Matching loop totals, duration or shape does not prove an observed wait's origin.
Without same-interval dependencies connecting source to that Trace wait, keep the
claimed connection and remedy conditional. Even a connection alone does not make
the full wait recoverable time; quantify benefit only with evidence for the
proposed change's effect on the critical path.

For a name seen in the trace (slice, marker, thread, native frame), start with
`locate_trace_anchor`; it finds the emitting line even when the number in the name
was built at run time or a thread name was truncated. Place the complete relative
path and actual line range beside each source finding, for example
`relative/path/File.kt:L10-L20`. A filename at the section top with disconnected
line numbers later is insufficient. Unread functions cannot establish behavior.
Keep version/build correspondence explicit.

Every source-based behavior, call-chain or recommendation explained in the
answer cites the location it was read from. Copy each tool-issued source ID
verbatim when you cite it; never reconstruct, shorten or splice its hash.
A source-only implementation finding stays a source explanation, not linked to
Trace: do not borrow an artifact cited by a separate measurement to make it look
linked. A source read alone never establishes a verified connection to an
observed interval. Preserve unknowns; this guidance does not grant new evidence
access or source permission.
