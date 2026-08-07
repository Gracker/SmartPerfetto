# Agent Orchestration Rules

Use this contract when a task needs more than one agent, a read-only reviewer,
or an explicit handoff between agents. It defines repository expectations, not a
specific model, plugin, tool schema, or local machine setup.

## Scope

Do not split simple, single-file, low-risk tasks only because multiple agents
are available. The primary agent may handle those directly and run the normal
project checks.

Use orchestration for non-trivial work when the problem has independent domains,
parallel read-only investigation would reduce risk, or an independent review is
needed before or after implementation. If a task starts simple but discovers
runtime, security, release, public-contract, generated-artifact, submodule, or
cross-surface risk, upgrade to this workflow.

## Authority

Current repository truth has priority: `AGENTS.md`, the relevant
`.claude/rules/` files, the user's current authorization, GitNexus rules, and
the project verification rules outrank memory, old reports, and agent
preference.

The primary agent owns:

- Requirement clarification and user-visible scope changes.
- Architecture, task decomposition, and ownership boundaries.
- Git, commit, push, branch, PR, release, and deployment authority.
- Real status and diff inspection before accepting any handoff.
- Staged change detection, project gate reruns, and final acceptance.

Sub-agents and reviewers provide candidate evidence. They do not change the
repository authority model.

## Gates

Before executing non-trivial work, follow the repository gate:

1. Plan the change, including touched files, order, dependencies, and risks.
2. Obtain an independent read-only review of the plan when a stable reviewer is
   available.
3. Revise the plan based on valid findings.
4. Execute within the accepted scope.

Simple tasks may skip this gate. If risk increases, pause implementation long
enough to run the gate from the new risk level.

After implementation, run a fresh read-only final review for multi-agent
implementation, code or runtime changes, security-sensitive work, release or
packaging changes, public contracts, or any other non-trivial high-risk diff.
The final review must be fresh: it cannot reuse a pre-implementation verdict.
Any later fix invalidates the old final verdict and requires a new review when
the risk class still applies.

If an independent reviewer times out twice or no stable reviewer exists, use the
fallback in `AGENTS.md`: structured self-review plus post-diff review. Record
that fallback plainly; do not call it a successful independent review.

## Baseline and Dirty Tree

Before delegation, record:

- Base ref or commit.
- `git status --short --branch`.
- Task-owned files, generated outputs, and symbols.
- Forbidden paths and symbols.
- Existing dirty or untracked changes that overlap the task.

Assume unrelated dirty-tree changes belong to the user or another process. Do
not revert, format, stage, or rewrite them.

At handoff and acceptance, recheck overlap against the live worktree. Stage only
the files owned by the current task. Run GitNexus `detect_changes` with staged
scope when code is changed. Use whole-tree or all-scope checks only when the
entire dirty tree is explicitly part of the task.

## Task Packet

Every delegated implementation or review task should include this packet:

- `OBJECTIVE`: the exact result expected.
- `FILES AND OWNERSHIP`: allowed files, owned symbols, generated outputs, and
  forbidden paths.
- `INTERFACES`: contracts, CLI/API surfaces, data schemas, docs, tests, or user
  flows that must remain compatible.
- `CONSTRAINTS`: repository rules, user authorization, no-go actions, language,
  style, licensing, and concurrency limits.
- `BASELINE`: base ref or commit, current status, and known overlapping changes.
- `VERIFICATION`: exact commands, scenario names, success conditions, and
  required evidence artifacts.
- `STRUCTURED RETURN`: required return fields and verdict format.

State explicitly that the worker is not alone in the repository. The worker must
preserve unrelated changes and adapt to concurrent changes instead of reverting
them.

## Parallelism

Read-only investigation can run in parallel when the questions are independent.

Implementation in a shared worktree is serial by default. Parallel
implementation is allowed only when the primary agent can show there is no
conflict in:

- Paths or symbols.
- Generated files.
- Lockfiles, package installation, or dependency graph changes.
- Submodules or gitlinks.
- `.git` operations.
- Ports, processes, daemons, and caches.
- Test output directories, evidence directories, and temporary artifacts.
- Build, test, release, or package dependency chains.

When conflict cannot be ruled out, use an isolated worktree or serialize the
work. Shared files and shared dependency stacks are serialized.

## Handoff and Acceptance

A sub-agent report is candidate evidence only. Before accepting it, the primary
agent checks the live repository status, actual diff, touched paths, generated
outputs, and forbidden-path boundaries. Then the primary agent reruns the
project gates that prove the accepted change.

Send fixes back to the original worker when its ownership and context are still
valid. If ownership changed, context expired, or the fix crosses boundaries, the
primary agent must reassign explicitly or repair directly within its authority.

Any correction after a final review invalidates that review verdict. Rerun the
final review when the remaining diff still meets the review gate.

## Reviewer Contract

Reviewers are fresh, read-only, and do not implement fixes. Give reviewers:

- Objective and allowed files.
- Complete diff, or base and head refs.
- Relevant constraints and forbidden paths.
- Verification already run by the primary session.
- Known residual risks and unavailable checks.

Reviewer verdict labels are repository labels, not tool schemas:

- `SHIP`: no blocking findings.
- `FIX_FIRST`: specific issues must be fixed before acceptance.
- `RETHINK`: the plan or architecture is likely wrong.

The reviewer should report findings, evidence, and residual risk. The primary
agent decides whether the change is accepted.

## Isolation Truth

Distinguish requested read-only behavior from enforced read-only isolation.
Record observable sandbox, permissions, write-tool availability, and any other
facts that show whether writes were technically prevented.

If enforcement cannot be proven, say the review was behaviorally read-only and
record the residual risk. If a reviewer modifies files, immediately terminate
that review and discard its verdict.

## Authority Boundaries

Sub-agents must not commit, push, open PRs, publish, deploy, create releases, or
change task scope unless the task packet explicitly grants that authority.

Creating new user-visible tasks requires explicit authorization from the user's
current request. Do not silently replace requested models, roles, plugins, or
tools; report the substitution and get permission when it changes the user's
requested workflow.

## Structured Return

Delegated agents return:

- `STATUS`: `complete`, `partial`, or `blocked`.
- `CHANGES`: files and behavior changed.
- `VERIFIED`: actual commands, scenarios, binary success observations, and
  evidence artifact paths.
- `JUDGMENT CALLS`: tradeoffs and non-obvious decisions.
- `GAPS`: skipped, unavailable, partial, or failed checks.
- `GIT/EXTERNAL ACTIONS`: staging, commits, pushes, PRs, releases, deploys, or
  external writes performed; normally this should be `none` unless explicitly
  authorized.
