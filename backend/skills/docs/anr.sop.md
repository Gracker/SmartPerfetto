# ANR Analysis SOP

## Scope
Standard operating procedure for ANR diagnosis using `anr_analysis` and related atomic skills.

## Inputs
- Trace with `android_anrs` data when available
- Optional package name
- Optional time range around ANR timestamp

## Workflow
1. Run `anr_context_in_range` to establish event-level context.
2. Run `anr_analysis` for classification, freeze verdict, and process-level evidence.
3. Check `system_freeze_check` output:
   - `freeze_verdict = system_server_freeze`: prioritize system_server watchdog path.
   - `freeze_verdict = system_freeze`: verify broad app stall and scheduler/IO pressure.
   - `freeze_verdict = app_specific`: focus target app main thread blockers.
4. Correlate with binder/cpu/io skills:
   - `binder_blocking_in_range`
   - `main_thread_sched_latency_in_range`
   - `main_thread_file_io_in_range`
5. Produce root cause with confidence:
   - High: direct overlap evidence on blocking path.
   - Medium: strong correlation but missing one key signal.
   - Low: anomaly present but causal chain incomplete.

## Validation Checklist
- At least one ANR event identified (timestamp + type).
- Main thread state distribution covers pre-ANR timeout window.
- Freeze verdict includes system_server status.
- Recommendations map to verified bottlenecks (not generic).
