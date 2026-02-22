# Kernel Scheduling SOP

## Scope
Diagnose scheduler-level contention and wakeup/migration effects on latency.

## Workflow
1. Run `cpu_analysis` for process/thread-level utilization and run-queue pressure.
2. Run `sched_latency_in_range` and `task_migration_in_range` for scheduler details.
3. Run `thread_affinity_violation` to detect unstable CPU placement.
4. Check lock and wait path:
   - `lock_contention_in_range`
   - `futex_wait_distribution`
5. Build causality chain:
   - runnable delay spike
   - delayed execution on critical thread
   - frame/session degradation

## Exit Criteria
- Critical thread scheduling bottleneck identified
- Mitigation mapped to thread priority/affinity/workload split
