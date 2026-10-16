<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

# CPU Frequency Limits and Thermal Throttling

## What the trace actually records

A frequency **limit** and the **actual frequency** are different facts. The kernel publishes the
cap it applies to a cpufreq policy; the actual frequency reflects that cap *and* the demand. A low
actual frequency alone proves nothing — an idle device runs slow on purpose.

| `counter_track.type` | Track name | Unit | Source |
|---|---|---|---|
| `cpu_max_frequency_limit` / `cpu_min_frequency_limit` | `Cpu N Max Freq Limit` / `Cpu N Min Freq Limit` | kHz | ftrace `power/cpu_frequency_limits`. N is the policy leader CPU, and the limit covers the whole policy, not that one core |
| `thermal_temperature` | `<zone> Temperature` | milli-degrees C | ftrace `thermal/thermal_temperature` |
| `cooling_device_counter` | `<cdev> Cooling Device` | cooling state | ftrace `thermal/cdev_update`; state 0 means no limiting |

Actual frequency stays where it always was: `cpufreq` counters on `cpu_counter_track`.

## Reading a limit track without over-claiming

- **The reference is the observed maximum limit in this trace, not the hardware maximum.** A device
  spec sheet is not evidence about this trace; "dropped 40% from 3.0 GHz" is fabricated if 3.0 GHz
  never appears.
- **The first sample on a limit track is the first *change*, not the start of limiting.** Everything
  before it is unknown state. A trace that begins already capped has an unknown onset, and the
  honest statement is "capped from the start of data", never "throttling began at t=0".
- **Read the capped state as debounced episodes.** A PID-style governor (Pixel) re-writes the cap
  every ~60 ms while it regulates; that is one episode of limiting, not dozens of throttle events.
  Merge adjacent capped intervals across short gaps before counting anything.
- **Limits are also raised.** A boost, a game mode, or a governor releasing an earlier cap all move
  the same track. `cpu_min_frequency_limit` movement is equally a policy action.
- **Hysteresis delays both edges.** Throttling that engages at T1 releases only below a lower T2, so
  onset lags the hot workload and recovery lags the cool-down. Expect the limited window to outlast
  the workload that caused it.

## Evidence ladder for "who capped the frequency"

Rank the answer by what the trace can actually support. Each rung down is a weaker claim, not a
worse device.

1. **Limit write applied by a tied cooling device** — strongest. The `cpu_max_frequency_limit` value
   drops within 1 ms AFTER a tightening `cdev` transition, and that cooling device is tied to the
   same policy by timing (most of its transitions are followed by that policy's limit changes). The
   device name never establishes the tie. Report the device and the temperature context.
2. **Userspace thermal daemon active shortly before the limit change** — a *candidate*, never a
   confirmation. On platforms where the daemon writes sysfs directly there is no kernel event to
   correlate, so proximity is all there is.
3. **Cooling activity that did not apply this write** — a tied device merely active, or only
   devices not tied to this policy active. Concurrent mitigation, not the actor.
4. **Limit changed with no thermal evidence** — the trigger is unidentified. PowerHAL and vendor perf
   services, game/battery/power-saving modes, and OEM policy daemons all move the same cap, but
   absence of observed thermal evidence is not proof of a non-thermal trigger — and when the trace
   captured no cooling transitions at all, thermal evidence was simply not recorded.
5. **Onset not observed** — the limit was already in force at the first sample (or right after an
   invalid sample). Report duration and impact only.
6. **Only a cpufreq ceiling observed, no valid max-limit sample** — an observation, not an
   attribution. The capability is missing; ask for the ftrace events rather than inferring a cause.

Every limit write is judged on its own: an episode can hold confirmed tightenings and unexplained
ones, and a relaxation is never a cause. A claim of *thermal* throttling requires rung 1, or rung 2
worded as a candidate, plus temperature context. Rungs 3–6 must never be written as thermal.

## Platform differences

The same question yields different evidence depending on who owns the thermal policy.

- **Kernel thermal management** (Pixel, and GKI-based MTK devices in most cases) emits cooling
  device transitions, so limit changes can be matched to a named cooling device directly. Rung 1 is
  reachable.
- **Userspace thermal daemons** (Qualcomm `thermal-engine`, `android.hardware.thermal-service.qti`)
  write limits through sysfs. The limit track moves with **no cooling-device event at all**, and
  temperature sampling is sparse — a few points per minute. Rung 2 is the ceiling, and a sparse
  temperature curve is background context, not causal evidence.
- **Vendor signals are hints, not a catalog.** Names observed in real traces include the Pixel
  thermal HAL atrace counters `VIRTUAL-SKIN-CPU-GPU-thermal-cpufreq-2-pid_request` and
  `...-cdev_ceiling`, `H:THERMAL_VIRTUAL-SKIN-HINT_*`, slices `ThermalHelper::readThermalSensor -
  <zone>`, and the kernel thread `thermal_BIG`; on Qualcomm and OEM builds, processes such as
  `thermal-engine-v2`, `android.hardware.thermal-service.qti`,
  `vendor.bytedance.thermalextservice.service` and `perfservice`, plus the system_server slice
  `ThermalAtomicEventMonitor$ThermalHandler`. MTK has not been characterised here. Treat every one
  of these as a name to *investigate*: query the values and check whether its transitions line up
  with the limit changes before using it as evidence. A counter's name never defines its semantics.

## What ran before the limit

Attribution of the cap is only half the question; the other half is what produced the heat. Look at
a window ending at the limit change (a few seconds is usually enough) and separate:

- **Freq-weighted CPU work** per actor: sum of running duration × frequency, in MHz·ms. This is a
  *work proxy*, not energy — it has no voltage term and no idle/leakage term. Group it by actor
  class (target app, other apps, system services, kernel threads) so App-generated load is visible
  next to everything else.
- **Anomalous thread patterns** in the same window: a thread running sustained without blocking, a
  spin-like pattern with high CPU and no wakeups, a kernel daemon consuming disproportionate CPU,
  or a wakeup storm where one thread repeatedly wakes many others.
- **Non-CPU heat sources.** Skin and battery zones are *not* CPU junction temperatures. Charging,
  modem activity, display brightness, GPU load and the camera all raise skin temperature, and a
  skin-driven cap can occur while the CPU is comparatively idle. An analysis that only looks at CPU
  work will blame the app for a cap that charging caused.

## Remedies, split by owner

Separate what the app team can change from what it cannot. Mixing them produces advice nobody can
act on.

**App side** — reduce the sustained load this app contributes before the cap:
- Cut sustained CPU/GPU work: fewer redundant recompositions, simpler shaders, less overdraw.
- Pace work evenly instead of in bursts; bursty frames reach higher peak temperatures for the same
  average load.
- Eliminate spin-waits and polling loops — maximum heat, no useful work.
- Move non-essential background work out of scroll/animation/startup windows.
- Spread computation across cores rather than saturating one big core.
- If the heat is not CPU-bound, look at the app's own camera, video encode, network and screen-on
  behaviour before the cap.

**System / vendor side** — record these as findings, not as app action items:
- Thermal policy thresholds, cooling-device mapping and governor tuning.
- Other apps, system services or kernel daemons contributing the measured load.
- Non-thermal limiters: PowerHAL and vendor perf services, game/battery modes, OEM policy.
- Charging, modem or display heat that the app does not control.

## When the evidence is missing

An empty limit track means this trace did not record limit events; it does not mean the device was
never capped. Ask for the ftrace events `power/cpu_frequency_limits`, `thermal/thermal_temperature`,
`thermal/cdev_update` and `power/cpu_frequency`, plus the vendor thermal HAL atrace category for
that device.

## Related Skills

`cpu_frequency_limit_attribution` is the entry point for "who capped it, what ran before, which
threads were anomalous"; it composes `cpu_freq_limit_timeline`, `thermal_cooling_device_timeline`,
`cpu_workload_attribution_in_range` and `cpu_anomalous_threads_in_range`, and surfaces vendor signal
candidates to inspect. `thermal_throttling` observes temperature and frequency, `cpu_throttling_in_range`
scopes that to a window, and `thermal_throttling_chain` walks the full chain.
`lookup_knowledge("data-sources")` covers capture configuration.
