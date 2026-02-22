# Binder Analysis SOP

## Scope
Analyze IPC latency, blocking topology, and main-thread binder risk.

## Workflow
1. Run `binder_analysis` for interface and latency overview.
2. Drill down with `binder_detail` on heavy interfaces.
3. Correlate with frame/jank windows:
   - Main thread sync binder overlap
   - Blocking call durations and frequency
4. Validate server-side behavior:
   - Long server execution
   - Thread pool saturation
5. Classify impact:
   - High: sync binder on main thread overlaps jank window
   - Medium: async binder backlog with burst latency
   - Low: isolated long tail without UI impact

## Deliverable
- Top blocking interfaces
- Caller/callee path
- Actionable remediation (async split, batching, cache, timeout)
