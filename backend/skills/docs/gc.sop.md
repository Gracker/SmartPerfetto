# GC Analysis SOP

## Scope
Identify GC pauses and allocation pressure contributing to frame drops.

## Workflow
1. Run `memory_analysis` for high-level memory/GC indicators.
2. Run `gc_analysis` or `gc_events_in_range` for pause-level details.
3. Correlate GC pause windows with frame/jank timeline.
4. Separate root causes:
   - allocation burst driven
   - retention/leak driven
   - background collector interaction
5. Recommend actions:
   - allocation rate reduction
   - object pooling where justified
   - hot-path allocation cleanup

## Validation
- Pause durations and counts are explicit
- Correlation window is shown (timestamp alignment)
