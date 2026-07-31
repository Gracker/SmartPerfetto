# Agent-Assisted GitHub Feedback

[English](agent-assisted-feedback.en.md) | [中文](agent-assisted-feedback.md)

<!-- i18n-headings: paired -->

After an analysis, users may see an uncertain claim, a Skill error, or a report
failure without knowing whether it is a SmartPerfetto problem, what to report,
or what they could contribute. M10 adds an independent feedback assistant next
to completed results. It turns persisted evidence into a reviewable GitHub
draft.

It never submits an issue, pull request, commit, or push automatically, and it
does not reinterpret thumbs feedback as a public complaint. A thumbs-down is
first stored through the existing fact path; after that succeeds, the UI only
exposes an explicit Agent-review action and leaves continuation to the user.

## User Flow

1. For a current or historical message with a V2 Analysis Receipt, the
   frontend reads its `runId`, `runManifestId`, and optional
   `resultSnapshotId`.
2. The backend reads only that run's persisted `analysis_completed` event,
   RunManifest, and matching snapshot. It detects unsupported or uncertain
   claims, partial gates, Skill errors or empty results, low scene confidence,
   unresolved identities, report-generation failures, and durable negative
   feedback for the same run.
3. When signals exist, the result shows their count and **Ask the Agent whether
   to report this**.
4. A separate, no-tool, single-turn triage Agent runs only after the user
   clicks. It returns at most three candidates and explains:
   - `report`, `needs_user_input`, `needs_verification`, or `not_reportable`;
   - whether ownership is analysis, Skill, Strategy, runtime, trace data, UI,
     or unknown;
   - whether the user can contribute a bug reproduction, Skill or Strategy
     improvement, runtime compatibility details, documentation/UI feedback,
     or a deidentified trace fixture;
   - missing evidence and questions the user should answer.
5. The backend creates a draft only for an eligible candidate after required
   answers and explicit sensitive-data review.
6. The last button opens a prefilled GitHub page in a new window. The user must
   still review it and click GitHub's submit button.

The repository also provides an
[Agent-Assisted Analysis Feedback Issue Form](https://github.com/Gracker/SmartPerfetto/issues/new?template=analysis_feedback.yml)
for manual entry or follow-up.

## Agent And Fallback Boundary

Triage reuses the provider and runtime pinned to the source run, not the
currently active provider:

- New RunManifests persist a non-secret `providerSnapshotHash`.
- Review resolves the same provider, runtime, and scope and compares the
  current snapshot hash.
- A removed provider, changed configuration or secret version, unavailable
  credentials, a legacy run without a pin, or an unsupported runtime never
  causes a silent model switch.
- Fallback output can only say `needs_verification` and identify missing
  information; it cannot pretend that an Agent recommended reporting.

Claude Agent SDK and OpenAI-compatible runtimes support live triage. M10 V1
uses an explicit safe fallback for Pi Agent Core, OpenCode, and Qoder. Triage
does not mutate the main analysis session, run, result, feedback, or
Self-Evolution state.

## Validation, Privacy, And Security

Agent output is not trusted as fact. The backend applies deterministic checks:

- strict schemas, enums, fields, counts, and byte limits;
- signal, claim, finding, evidence, and Skill ids must exist in the source run;
- a Skill must be built in or from an approved external pack;
- low-confidence or unreferenced candidates cannot use `report`;
- the server attaches a short-lived integrity attestation to every returned
  review; draft creation rechecks the source-run provider pin and rejects
  forged, altered, expired, or cross-user Agent/fallback reviews;
- prompt-control content is rejected, while emails, URLs, MAC addresses, phone
  numbers, absolute paths, package names, and common secret forms are redacted
  before the external triage Provider call and again at the public-draft
  boundary;
- private and code-aware analyses fail closed and cannot create public
  feedback;
- selecting “This may involve a security vulnerability” disables the public
  draft and routes the user to a
  [private Security Advisory](https://github.com/Gracker/SmartPerfetto/security/advisories/new).

Automatic redaction does not replace human review. Raw traces, private source,
company information, accounts, device identifiers, paths, provider
requests/responses, and secrets do not belong in a public issue.

## Relationship To Self-Evolution

M10 is an external-feedback assistant for regular users, not a new automatic
publication stage in the M0-M9 Self-Evolution control plane:

- thumbs feedback continues through the existing public/private fact and
  projection path; public negative feedback becomes only a
  `user_reported_inaccuracy` candidate signal and never invokes the Agent or
  creates a GitHub draft automatically;
- a GitHub draft does not create a feedback event, proposal, overlay, or
  contribution bundle automatically;
- M0-M9 gates, human acceptance, apply/revert, and reconciliation stay
  unchanged;
- the paths share only immutable source-run attribution and the neutral public
  artifact sanitizer.

## User Smoke Test

1. Use `./start.sh` or Docker to complete a public analysis with a detectable
   gap.
2. Confirm the result shows a signal count; a run without a gap should not show
   the feedback card.
   For a gap-free result, click thumbs-down and confirm an explicit “Ask the
   Agent what I should report or contribute” action appears after storage,
   without opening GitHub automatically.
3. Start Agent review and confirm candidates explain reportability, ownership,
   contribution type, and missing evidence.
4. Leave a required answer blank or skip sensitive-data review and confirm the
   draft action remains unavailable.
5. Answer and confirm review. Verify the UI shows a reviewable title, body,
   redaction list, and “not submitted” notice.
6. Open GitHub and confirm a prefilled draft opens without submitting an issue.
7. Repeat with a private/code-aware run and confirm public feedback is disabled.
8. Mark it security-sensitive and confirm only the private advisory path is
   offered.
9. Change or remove the source run's provider profile, then revisit the old
   result. Confirm explicit fallback with no switch to the current provider.

## Maintainer Verification

```bash
npm --prefix backend run test:external-issue-reporting
npm --prefix backend run typecheck
npm --prefix backend run validate:strategies
npm --prefix backend run verify:e2e:deepseek-external-issue

cd perfetto/ui
node build.mjs --typecheck
node build.mjs --run-unittests --no-build \
  --test-filter "external issue reporting UI contract"
```

For UI changes, also verify in a browser through `./scripts/start-dev.sh`, then
run `./scripts/update-frontend.sh` from the repository root. Run
`npm run verify:pr` before landing. The focused real-provider suite forces an
actionable source-run signal and proves `source=agent`. When the Agent allows
public reporting, it also verifies `notSubmitted=true` and an HTTPS GitHub
prefill URL; otherwise it verifies that the Agent explicitly blocks public
drafting. Neither branch writes to GitHub.
