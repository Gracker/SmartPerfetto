# Multi-Trace Analysis Result Comparison

[English](multi-trace-result-comparison.en.md) | [中文](multi-trace-result-comparison.md)

This is one SmartPerfetto feature guide. For the full feature map, see [Feature Overview](features.en.md).

Multi-trace analysis result comparison compares completed AI analysis results. It does not require two traces to stay open in the same Perfetto UI window. Use it for A/B testing, release regression checks, startup comparison, FPS/Jank comparison, and team workflows where multiple users analyze traces in the same workspace.

## What It Solves

Dual-trace comparison is a live mode: choose any baseline/comparison pair from the same workspace and the AI queries both raw traces during one conversation. Result comparison instead reuses completed analysis outputs. After each AI analysis finishes, SmartPerfetto stores comparable metrics, evidence references, and report links as an analysis result snapshot. Later, you can select 2 or more snapshots and compare them side by side.

This means:

- The other Perfetto UI window does not need to stay open.
- Two trace processors do not need to stay active at the same time.
- Multiple analysis results from the same trace can be compared.
- Workspace-visible results from teammates can participate in the comparison.

## When To Use It

Use analysis result comparison for:

- Startup comparison between two APK versions.
- FPS, Jank, and root-cause comparison between two scrolling captures.
- A/B/C test runs.
- Comparing multiple analysis runs from the same trace.
- Comparing your current result with a teammate's completed result in the same workspace.

If you only need a temporary reference trace inside the current AI conversation, use the toolbar's `compare_arrows` entry. The new result comparison entry uses the `fact_check` icon.

## Prerequisites

1. SmartPerfetto backend is running and the AI provider works.
2. At least two AI analyses have completed, or the current workspace already contains readable results.
3. For cross-user comparison, the other result must be workspace-visible. Results are private by default.

After an AI analysis finishes, the AI Assistant header shows `Ready result` or `Partial result`. That means the latest analysis in the current window has produced a snapshot that can be used in future comparisons.

## How To Use It

### Option 1: Type A Comparison Request

Each completed AI analysis shows a `Result ID` next to the result title, such as `AR-1234abcd`. This ID is a short reference to the current analysis result snapshot. You can copy or type it in any AI Assistant window in the same workspace.

Common prompts:

```text
Compare with the other result
Compare AR-1234abcd
Compare AR-11111111 and AR-22222222
```

Rules:

- `Compare with the other result`: when the current window has a latest result and there is exactly one clear other candidate in the same workspace, SmartPerfetto uses the current result as the baseline and the other result as the candidate.
- `Compare AR-1234abcd`: SmartPerfetto uses the current window's latest result as the baseline and the specified `Result ID` as the candidate.
- `Compare AR-11111111 and AR-22222222`: the first `Result ID` is the baseline; later IDs are candidates.
- If several results could match "the other result", or an ID cannot be matched uniquely, SmartPerfetto asks you to choose instead of guessing.

This still compares persisted analysis result snapshots. The other Perfetto UI window does not need to stay open. If it is still open, SmartPerfetto only uses its latest result as a clearer candidate signal.

### Option 2: Use The Result Picker

1. Open the first trace and complete an AI analysis, for example "Analyze startup performance".
2. Open the second trace and complete another AI analysis, for example "Analyze startup performance" or "Analyze scrolling FPS".
3. Return to any window and click the AI Assistant toolbar's `fact_check` icon. Its title is "Analysis result comparison...".
4. In the "Select analysis results" panel, choose one `Baseline` and one or more `Candidate` results.
5. If a result is private and should be reusable by teammates in the workspace, click `Share` on that result.
6. Optional: type a focus question in the AI input box, such as "Focus on startup time and FPS", then click `Start comparison`.
7. Wait for SmartPerfetto to return the comparison result.

The result picker shows each result's scene, original question, trace metadata, creation time, owner, metric count, evidence reference count, and visibility. The current window's latest result is marked `Current`; results from still-open windows are marked `Open`.

If you are unsure which historical result to inspect, click the row-level
`travel_explore` similarity button first. SmartPerfetto shows similar snapshots
or case-library hints marked as `navigation_hint_only`. These hints only help
you choose what to inspect or compare next; they are not diagnostic evidence
for the current trace.

## What The Output Contains

After the comparison finishes, AI Assistant appends an "analysis result comparison completed" message with:

- Comparison ID.
- Baseline and candidates.
- Significant change count.
- Baseline values, candidate values, and deltas for standard metrics such as startup, FPS, and Jank.
- A link to export the complete HTML report.

The complete HTML report includes more metrics, input snapshots, significant changes, and the AI conclusion. The chat message only expands the first important rows; use the report as the full output.

## Supported Metrics

The current version prioritizes standardized metrics, especially:

- Startup metrics such as startup duration.
- Scrolling and frame metrics such as average FPS, Jank, and slow frames.
- Other standard metrics extracted from the analysis result or backfilled from the original trace.

If a snapshot lacks a requested standard metric, the backend can try to backfill it from the original trace. If backfill fails, the comparison still completes and records the missing reason instead of inventing unsupported numbers.

## Permissions And Sharing

Analysis results are private by default. Clicking `Share` makes a snapshot workspace-visible, so authorized users in the same workspace can read and compare it.

Results from other workspaces do not appear in the result picker. When you switch workspaces, the current result, candidate list, and comparison state are reset for that workspace.

## FAQ

### Why is the result picker empty?

Usually the current workspace has no completed AI analysis yet, or other users' results are still private. Run an AI analysis first, wait for `Ready result` or `Partial result`, then open the result picker again.

### What is the difference between `Ready result` and `Partial result`?

`Ready result` means the snapshot already has standardized comparable metrics. `Partial result` means the analysis was saved, but metric coverage is incomplete. Partial results can still be compared, but some metrics may be missing or require backfill.

### How is this different from the old trace comparison mode?

The `compare_arrows` entry is live trace comparison. It lets the AI query any baseline/comparison trace pair from the same workspace in one conversation.

The new `fact_check` entry is analysis result comparison. It is designed for multiple windows, multiple users, and completed analysis results. It relies on backend-persisted snapshots and does not require another Perfetto UI window to stay alive.

### Can it compare more than two traces?

Yes. Choose one baseline and multiple candidates to produce a multi-result matrix.

### What if a `Result ID` is missing or matches multiple results?

Check that the ID belongs to the same workspace and that you have read access to the result. `AR-...` is a short reference and only needs to match uniquely. If it is ambiguous, use a longer `Result ID` or open the `fact_check` result picker and choose manually.

### Can it show only significant changes?

The comparison API supports a significant-only view. The UI message currently shows the significant change count and the first key metric rows; report and UI filtering will continue to improve.
