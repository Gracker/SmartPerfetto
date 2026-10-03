<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

---
scene: game
investigation_contract:
  schema_version: 1
  profiles:
    - {id: system_execution, version: 1}
    - {id: causal_reasoning, version: 1}
  requirements:
    - id: game_critical_path
      domain: critical_path
      description: "Identify actual engine/GameThread, render/raster and workload phases with deadline windows. Do not assume tid equals pid identifies the only critical thread; retain foreground, worker and system peer roles."
    - id: game_dependencies
      domain: dependency_chain
      description: "Connect CPU execution to GPU work, fences and presentation, with thermal and energy context when observed. Frame pacing, GPU saturation and CPU scheduling are distinct claims."
classification_description: "Game workload frame pacing, CPU/GPU performance and sustained rendering behavior."
priority: 4
effort: medium
required_capabilities:
  - cpu_scheduling
optional_capabilities:
  - gpu
  - thermal_throttling
  - surfaceflinger
  - gpu_work_period
  - power_rails
  - cpu_freq_idle
keywords:
  - 游戏
  - game
  - 帧率
  - 游戏卡顿
  - 游戏掉帧
  - unity
  - unreal
  - 游戏性能
  - game fps
  - game performance
  - godot
  - cocos

phase_hints:
  - id: game_loop_jank
    keywords: ['game', 'Unity', 'Unreal', 'Cocos', 'Godot', '主循环', 'Tick', 'PlayerLoop', 'GameThread', '帧率', '卡顿']
    constraints: '游戏/引擎场景必须先用 game_fps_analysis 看整体帧率，再用 game_main_loop_jank 检查引擎主循环/Tick 超预算切片。不要把缺 FrameTimeline 误判成没有掉帧。'
    critical_tools: ['game_fps_analysis', 'game_main_loop_jank']
    critical: true
  - id: game_gpu_power
    keywords: ['gpu', 'work period', 'mali', 'thermal', '功耗', '发热', '降频']
    constraints: 'GPU/功耗/发热问题按数据完整度补充 android_gpu_work_period_track、mali_gpu_power_state、thermal_throttling、wattson_thread_power_attribution；缺 capability 时标注证据等级。'
    critical_tools: ['android_gpu_work_period_track', 'mali_gpu_power_state', 'thermal_throttling', 'wattson_thread_power_attribution']
    critical: false

plan_template:
  mandatory_aspects:
    - id: fps_and_gpu
      match_keywords: ['game', 'fps', '游戏', 'gpu', 'frame', '帧率']
      suggestion: '游戏场景建议包含帧率分析和 GPU 状态检查阶段'
      required_expected_calls:
        - tool: invoke_skill
          skill_id: game_fps_analysis
    - id: engine_loop_jank
      match_keywords: ['Unity', 'Unreal', 'Cocos', 'Godot', 'GameThread', 'PlayerLoop', 'Tick', '主循环']
      suggestion: '游戏引擎场景建议包含 game_main_loop_jank 阶段，检查引擎自管帧循环'
      required_expected_calls:
        - tool: invoke_skill
          skill_id: game_main_loop_jank
---

#### game Core Strategy

**Route card**: 游戏 / game / 帧率 / 游戏卡顿 / 游戏掉帧 / unity / unreal / 游戏性能 / game fps / game performance

**Capabilities**: required=[cpu_scheduling], optional=[gpu, thermal_throttling, surfaceflinger, gpu_work_period, power_rails, cpu_freq_idle]

**Execution contract**
- 先 submit_plan；计划必须覆盖下列 frontmatter mandatory aspects，并在 expectedCalls 中声明关键 Skill/工具。
- 条件触发项只在 plan/证据命中对应 trigger 时强制；数据缺失时用 skipped+reason 或 waiver，不把缺失证据改写成通过。
- detail 是 informational：只指导如何执行，不能替代 invoke_skill / execute_sql / fetch_artifact 的 trace 证据。

**Mandatory aspects**
- fps_and_gpu: 游戏场景建议包含帧率分析和 GPU 状态检查阶段 (required: invoke_skill(game_fps_analysis))
- engine_loop_jank: 游戏引擎场景建议包含 game_main_loop_jank 阶段，检查引擎自管帧循环 (required: invoke_skill(game_main_loop_jank))

**Phase reminders**
- game_loop_jank: 游戏/引擎场景必须先用 game_fps_analysis 看整体帧率，再用 game_main_loop_jank 检查引擎主循环/Tick 超预算切片。不要把缺 FrameTimeline 误判成没有掉帧。 工具: game_fps_analysis, game_main_loop_jank
- game_gpu_power: GPU/功耗/发热问题按数据完整度补充 android_gpu_work_period_track、mali_gpu_power_state、thermal_throttling、wattson_thread_power_attribution；缺 capability 时标注证据等级。 工具: android_gpu_work_period_track, mali_gpu_power_state, thermal_throttling, wattson_thread_power_attribution

**Final report contract summary**
- 遵循通用输出契约。


**Detail ref**
- `game:full`: 游戏性能分析（用户提到 游戏、game、帧率、游戏卡顿） 的完整 phase recipe、SQL、fetch_artifact 表、决策树和边界说明。


<!-- strategy-detail id="full" title="game full strategy detail" keywords="game,游戏,game,帧率,游戏卡顿,游戏掉帧,unity,unreal,游戏性能,game fps,game performance,godot,cocos,游戏性能分析（用户提到 游戏、game、帧率、游戏卡顿）,detail,full" default="true" -->
#### 游戏性能分析（用户提到 游戏、game、帧率、游戏卡顿）

游戏渲染管线与标准 Android View 不同：没有 FrameTimeline，不使用 Choreographer/RenderThread 流程。
需要使用 `game_fps_analysis`（非 `scrolling_analysis`）作为入口。

#### 游戏场景关键 Stdlib 表

写 execute_sql 时优先使用（完整列表见方法论模板）：`android_gpu_frequency`、`cpu_utilization_per_second`、`cpu_frequency_counters`、`android_dvfs_counters`、`android_screen_state`

`android_gpu_frequency.gpu_freq` 是 gpufreq 计数器原值，单位随写入源是 kHz、Hz 或 MHz，0 表示 GPU 关闭；要 GPU 频率数值时读 `gpu_freq_in_range` / `gpu_analysis` 的 MHz 列，不要自己换算。

**Phase 1 — 游戏帧率分析（1 次调用）：**
```
invoke_skill("game_fps_analysis", { package: "<游戏包名>" })
```
返回：帧率统计、帧间隔分布、卡顿帧列表。

**Phase 1.5 — 引擎主循环 / Tick 深钻：**

```
invoke_skill("game_main_loop_jank", { process_name: "<游戏进程名>", start_ts: "<trace_start>", end_ts: "<trace_end>" })
```

检查 Unity `PlayerLoop` / `Camera.Render` / `Gfx.WaitForPresent`、Unreal `FrameGameThread` / `GameThread` / `RHIThread`、Cocos `Director::mainLoop`、Godot `Main::iteration` 等切片是否超过目标帧预算。该阶段补的是应用生产端节奏，不能用 FrameTimeline 缺失来证明游戏无卡顿。

**Phase 2 — GPU 深度分析（推荐）：**

游戏通常是 GPU-bound。调用 GPU 相关分析：
```
invoke_skill("gpu_analysis")
```
检查 GPU 频率/利用率、Fence 等待时间。

如果 Trace 数据完整度显示 `gpu_work_period` 可用，再补充：
```
invoke_skill("android_gpu_work_period_track")
invoke_skill("mali_gpu_power_state")
```
用于判断 GPU active region 是否连续、Mali power state 是否异常。无 `gpu_work_period` 时只能做 GPU 频率/帧间隔定性分析。

**Phase 3 — 系统级交叉分析：**

| 信号 | 检查工具 | 说明 |
|------|---------|------|
| CPU 频率下降 | `invoke_skill("thermal_throttling")`；要归因到触发源（谁限的频、限频前跑了什么）用 `invoke_skill("cpu_frequency_limit_attribution")` | 游戏长时间运行容易触发热节流；游戏/性能模式也会改限频，无 cooling/温度证据不能写成热降频 |
| 内存压力 | `invoke_skill("memory_analysis")` | 游戏内存占用大，可能触发 LMK |
| CPU 调度 | `invoke_skill("cpu_analysis")` | 游戏线程调度到小核会造成帧率波动 |
| 线程/进程 CPU 利用率 | `invoke_skill("cpu_thread_utilization_period")` / `invoke_skill("cpu_process_utilization_period")`；需要函数/slice 级热点时补 `invoke_skill("process_slice_cpu_hotspots", { process_name, start_ts, end_ts })` | 判断 UnityMain/GameThread/RenderThread 是否 CPU-bound，并用 Running CPU time 定位 named slice 热点 |
| 功耗归因 | `invoke_skill("wattson_thread_power_attribution")` | 仅在 power_rails + cpu_freq_idle 可用时做线程能耗归因 |
| 独立 GL swap 间隔 | `invoke_skill("gl_standalone_swap_jank")` | NativeActivity/GLSurfaceView 或引擎自管 swap 时检查生产端 present 节奏 |

**Phase 4 — 引擎特定分析：**

| 引擎 | 关键线程 | 关键 Slice |
|------|---------|-----------|
| Unity | UnityMain, UnityGfx | `PlayerLoop`, `Gfx.WaitForPresent`, `Camera.Render` |
| Unreal | GameThread, RHIThread, RenderThread | `FrameGameThread`, `RHIThread`, `RenderingThread` |
| Godot | GodotMain | `Main::iteration`, `physics_process` |

**输出结构：**

1. **帧率概览**：平均/P50/P90/P99 帧间隔、稳定性评级
2. **卡顿帧分析**：卡顿帧时间分布、帧间隔直方图
3. **GPU 状态**：频率、利用率、Fence 等待
4. **限频影响**：CPU/GPU 频率是否被限制（限频以 `cpu_throttling_in_range` 的限频证据为准；温控触发还需温度/散热设备证据）
5. **优化建议**：按 GPU-bound / CPU-bound / Thermal 分类
<!-- /strategy-detail -->
