# IO/Storage Analysis SOP

## Scope
Diagnose file IO impact on UI latency and startup/interaction regressions.

## Workflow
1. Run `main_thread_file_io_in_range` for UI-thread IO hotspots.
2. Run `io_load`/ANR IO evidence in suspected timeout windows.
3. Check wait-state signals:
   - `thread_state = D`
   - long blocking slice overlap with target frame/session
4. Segment by pattern:
   - cold-read burst
   - sync write/fsync burst
   - metadata traversal hotspots
5. Recommend fixes:
   - move IO off main thread
   - prefetch/cache
   - reduce sync flush frequency

## Validation
- IO events are within target window
- Main-thread overlap is confirmed before claiming causality
