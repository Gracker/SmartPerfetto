# Agent Orchestration Rules

Use this contract for bounded delegation, independent review or an agent
handoff. It does not require a particular model, plugin or machine setup.

## When to Delegate

Keep simple work and shared decisions with the primary agent. Delegate when an
independent workstream improves quality or saves time, or when the risk-based
review in `AGENTS.md` applies. Capacity alone is not a reason to split work.

For material architecture, security, release, shared-state or public-contract
risk, use Plan -> independent read-only review -> Revise -> Execute. A fresh
final review is also required for security, release/packaging, material public
or shared-state contracts and high-risk combined diffs. Review changed portions
after fixes; reopen the whole review only when its assumptions changed.

If no stable reviewer is available, record structured self-review and post-diff
review as the fallback. Retry only a plausibly transient failure. A timeout or
an unavailable result is not a successful independent review.

## Ownership and Task Packet

The primary agent owns scope, architecture, shared state, Git/external actions,
combined-diff inspection, verification and final acceptance. Sub-agent evidence
is a candidate result until checked against the live worktree.

Before delegation, record the base ref, `git status --short --branch` and
existing overlapping edits. Each task packet states:

- Objective and completion criteria.
- Owned files/symbols/outputs, forbidden paths and relevant interfaces.
- Applicable rules, authorization and concurrency constraints.
- Baseline and existing changes.
- Repository-defined verification and expected evidence.

Tell workers they are not alone: preserve unrelated edits and accommodate
concurrent changes. Reviewers must not edit files. Do not delegate scope, commit,
push, PR, release, publication or deployment authority unless expressly granted.
New user-visible chats require the user's explicit authorization.

## Shared Workspace

Independent reads may run in parallel. Shared-worktree implementation is serial
unless ownership excludes conflicts in paths, symbols, generated output,
lockfiles/dependencies, submodules/Git, processes/ports/caches and test/build
outputs. Otherwise isolate the work or serialize it.

At handoff, inspect actual status/diff and ownership overlap, then validate the
combined result with `.claude/rules/testing.md`. Reuse a passing check only while
its files, dependencies, configuration and environment are unchanged. Stage only
task-owned files; use staged GitNexus change detection when `.claude/rules/git.md`
requires it. Prefer returning fixes to the original owner while that ownership
remains valid.

## Reviewer and Handoff Results

Give reviewers the objective, diff or base/head refs, constraints, completed
verification and residual risks. Verdicts:

- `SHIP`: no blocking findings.
- `FIX_FIRST`: specific issues require repair.
- `RETHINK`: the plan or architecture needs revision.

Report whether read-only behavior is technically enforced or only requested;
if a reviewer writes files, stop the review and discard its verdict.

Workers return `STATUS` (complete/partial/blocked), `CHANGES`, `VERIFIED` (actual
commands/scenarios/results), `JUDGMENT CALLS`, `GAPS`, and `GIT/EXTERNAL ACTIONS`.
The primary agent decides acceptance and reports evidenced delivery state.
