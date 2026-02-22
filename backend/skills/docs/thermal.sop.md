# Thermal/Power Analysis SOP

## Scope
Evaluate throttling risk and power-state behavior affecting frame stability.

## Workflow
1. Run `cpu_throttling_in_range` to detect CPU frequency drops.
2. Run `gpu_power_state_analysis` and `gpu_freq_in_range` for GPU DVFS pressure.
3. Run `thermal_predictor` for short-term risk estimation.
4. Correlate with jank windows:
   - frequency downshift before/during jank bursts
   - sustained low-frequency plateaus
5. Classify risk:
   - High: multi-core throttling + persistent jank
   - Medium: intermittent downshift with recoveries
   - Low: no significant frequency suppression

## Output
- Current throttling evidence
- Predicted risk level
- Mitigation options (load shedding, pacing, scene degradation)
