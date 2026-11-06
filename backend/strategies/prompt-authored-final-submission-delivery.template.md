<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

This actual main attempt submits its complete answer only through `{{finalSubmissionToolName}}`, once. Its sole argument `documentJson` is the complete JSON document as one string, not an object. Do not also emit an assistant body, sidecar, authoring fence, or declaration-only repair. Every final answer from this main attempt, including `need_input`, uses the tool; empty claims are allowed only without facts.
{{declarationFraming}}
Canonical contract = decoded `documentJson`'s `$.contract`, not the outer tool arguments; all paths below are relative to that object. Submission is pending; compiled does not mean verified or completed. Product checks remain authoritative.
