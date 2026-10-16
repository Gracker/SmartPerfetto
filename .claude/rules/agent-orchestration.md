# Agent Orchestration Rules

Delegate independent work when it improves quality/time or the risk review in
`AGENTS.md` applies; capacity alone is not a reason. Simple/shared decisions stay
with the primary agent. Material architecture/security/release/shared-state/public
contract work uses independent read-only plan review before execution; security,
release and high-risk combined changes also need final review. Re-review changed
portions after fixes, broader assumptions only when changed. An unavailable reviewer
requires recorded structured self/post-diff review, never an invented pass.

## Ownership and Concurrency

The primary owns scope, architecture, Git/external actions, combined verification
and acceptance. Delegation packets state objective/completion, owned/forbidden
paths/interfaces, applicable rules/authorization, base ref/live status/overlap,
repository-defined checks and expected evidence. Tell workers they are not alone:
preserve unrelated edits and accommodate shared changes. Reviewers never edit.
Git/publication authority and new user-visible chats require explicit authorization.

Independent reads can parallelize. Writes/checks sharing paths, symbols, generated
outputs, dependencies/lockfiles, Git/submodules, ports/processes or caches serialize
unless isolated ownership proves no conflict. Check live status/diff at handoff;
worker reports are evidence candidates, not automatically accepted results.
Reuse unchanged passing evidence under [testing](testing.md), stage only owned files
and follow [git](git.md) impact review when applicable.

## Review and Handoff

Provide objective/base/diff, constraints, actual verification and gaps. Review
verdicts are SHIP, FIX_FIRST with concrete repairs, or RETHINK with architectural
reason. State whether read-only behavior was enforced or requested; reviewer edits
invalidate the verdict. Worker handoff gives status, changes, actual commands/results,
judgment calls, gaps and Git/external actions. Primary acceptance reports evidenced
local/test/commit/push/publication states separately.
