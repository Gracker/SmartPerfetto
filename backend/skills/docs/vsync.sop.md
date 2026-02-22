# VSync Analysis SOP

## Scope
Procedure for stable VSync/refresh-rate inference and jank attribution consistency.

## Recommended Skill
- `vsync_period_detection` (shared atomic baseline)

## Workflow
1. Run `vsync_period_detection` with optional `start_ts/end_ts`.
2. Confirm detection quality:
   - `sample_count >= 10`
   - `confidence >= 0.7`
   - `detection_method` is `vsync_sf` or `frame_timeline`
3. Reuse detected `vsync_period_ns` across downstream frame/jank calculations.
4. For session analysis, scope VSync queries to session window to avoid idle/VRR noise.
5. Validate attribution consistency:
   - `app_jank`: buffer unavailable at VSync.
   - `sf_jank`: buffer available but display path missed.

## Failure Handling
- Missing VSync counters: fall back to `expected_frame_timeline_slice` durations.
- No reliable samples: use snapped default and mark low confidence.
