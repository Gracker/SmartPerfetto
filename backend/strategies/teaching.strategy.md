<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

---
scene: teaching
investigation_contract:
  schema_version: 1
  profiles:
    - {id: system_execution, version: 1}
    - {id: causal_reasoning, version: 1}
  requirements:
    - id: teaching_critical_path
      domain: critical_path
      description: "Distinguish conceptual explanation from a question about why an actual trace task is slow. Concepts need no collection; a concrete trace investigation follows the selected task/window and relevant system evidence."
    - id: teaching_dependencies
      domain: dependency_chain
      description: "Keep implementation/source explanations separate from proof that an event occurred in this trace. Do not widen a bounded teaching question or collect evidence forbidden by existing_only."
classification_description: "Explaining a trace concept, component role or mechanism using available context."
priority: 3
effort: medium
required_capabilities: []
optional_capabilities: []
keywords:
  - 教学
  - 是什么
  - 什么意思
  - 怎么工作
  - 怎么运作
  - explain
  - how does
  - what is
  - thread role
  - mechanism
  - 原理
  - 线程角色
  - 关键slice
  - mermaid
  - 源码
  - source code
  - 这个slice

---

#### teaching Core Strategy

**Route card**: 教学 / 是什么 / 什么意思 / 怎么工作 / 怎么运作 / explain / how does / what is / thread role / mechanism

**Capabilities**: required=[none], optional=[none]

**Execution contract**
- 先 submit_plan；计划必须覆盖下列 frontmatter mandatory aspects，并在 expectedCalls 中声明关键 Skill/工具。
- 条件触发项只在 plan/证据命中对应 trigger 时强制；数据缺失时用 skipped+reason 或 waiver，不把缺失证据改写成通过。
- detail 是 informational：只指导如何执行，不能替代 invoke_skill / execute_sql / fetch_artifact 的 trace 证据。

**Mandatory aspects**
- architecture_detection: 教学场景建议包含架构检测阶段 (detect_architecture) (required: detect_architecture)
- pipeline_teaching: 教学场景建议包含管线教学内容获取阶段 (invoke_skill with pipeline skill) (requires one of: invoke_skill(rendering_pipeline_detection), invoke_skill(scene_reconstruction))

**Phase reminders**
- 无额外 phase hint。

**Final report contract summary**
- 遵循通用输出契约。


**Detail ref**
- `teaching:full`: 教学/概念解释分析（用户提到 是什么、什么意思、怎么工作、explain、what is、pipeline、thread role） 的完整 phase recipe、SQL、fetch_artifact 表、决策树和边界说明。


<!-- strategy-detail id="full" title="teaching full strategy detail" keywords="teaching,教学,是什么,什么意思,怎么工作,怎么运作,explain,how does,what is,thread role,mechanism,原理,线程角色,教学/概念解释分析（用户提到 是什么、什么意思、怎么工作、explain、what is、pipeline、thread role）,detail,full" default="true" -->
#### 教学/概念解释分析（用户提到 是什么、什么意思、怎么工作、explain、what is、pipeline、thread role）

**核心目标：** 帮助用户理解 trace 中的组件、线程、Slice 和渲染管线的工作原理，先教后诊、分层递进。

**Phase 1 — 识别用户关注对象：**

根据用户输入判断教学方向：

| 用户关注对象 | 判断方式 | 教学路径 |
|------------|---------|---------|
| 选中的 Slice | 用户提到"这个slice"、"这个是什么" + 有 selection context | 解释 Slice 含义 → 所属管线 → 正常范围 |
| 特定线程 | 用户提到线程名（RenderThread、1.ui、CrRendererMain 等） | 解释线程角色 → 在渲染管线中的位置 |
| 渲染架构/管线 | 用户提到"管线"、"pipeline"、"渲染架构" | 先检测架构 → 加载对应管线教学 |
| 通用概念 | 用户提到"VSync"、"Choreographer"、"SurfaceFlinger" 等术语 | 概念解释 → 在管线中的位置 → 与 trace 的关联 |

**Phase 2 — 架构检测与 observed-flow 教学：**
```
invoke_skill('rendering_pipeline_detection', { package: <package hint> })
# 读取 pipeline_bundle: detection + teachingContent + pinInstructions + activeRenderingProcesses
# 再基于 selection / visible window / package hint 查询 observedFlow.lanes/events
# 对关键 rendering event 追加 bounded scheduler 事实：
#   - 唤醒行（Running 行之前、或睡眠之后的第一条 R/R+ 行）上的 waker_id -> direct_wakeup / wakes_to
#     （Running 行本身不带 waker；前一条 R/R+ 没有 waker 表示被抢占而不是被唤醒）
#   - sched.thread_executing_span_with_slice._critical_path_stack 合并后的其他线程段 -> critical_path_segment / critical_path_to
```
- 先展示当前 trace 中真实观测到的 lanes/events，再展示 Mermaid
- `primary_pipeline_id` 只是入口，不是最终单选结论
- 如果 candidates/features 暗示 WebView/Flutter/RN/GL/TextureView/SurfaceView 等混合出图，先分开展示 host HWUI 与 producer 链路
- 如果 trace 具备 sched/thread_state 信号，展示 Critical task / Wakeup 关系；如果缺少 `sched_wakeup` 或官方 critical path 为空，明确标成采集缺口
- 解释关键线程角色（main thread、RenderThread、producer、SurfaceFlinger、HWC/present）
- 列出关键 Slice 及其含义，并标注哪些在当前 trace 中真实命中、哪些缺失
- 如果用户有 selection context，优先关联选区；否则使用 visible window，再退回 package/process hint 或活跃渲染进程 fallback

**Phase 3 — 上下文关联教学：**

**3a. 异常关联（教 + 诊）：**
- 如果用户选中的 Slice/线程存在明显异常 → 先解释正常行为，再指出偏差
- 例如："DrawFrame 正常耗时 4-8ms，当前帧耗时 35ms，超出帧预算"

**3b. 源码位置（按需）：**
注意：AOSP 源码路径可能因 Android 版本不同而变化。如果引用源码位置，标注
适用版本。渲染教学以固定上游 S01-S14 为准：平台锚点
`android-17.0.0_r1`，kernel 锚点 `android17-6.18-2026-06_r6`，并明确
Android 12—17 差异。框架/engine/provider 版本必须单独记录。

如果用户问到源码位置，提供 AOSP 源码路径 + 关键函数名：

| Slice 名称 | AOSP 源码文件 | 关键函数 |
|-----------|-------------|---------|
| DrawFrame | android/view/ViewRootImpl.java | performTraversals() |
| Choreographer#doFrame | android/view/Choreographer.java | doFrame() |
| RenderThread::draw | libs/hwui/renderthread/RenderThread.cpp | draw() |
| dequeueBuffer | frameworks/native/libs/gui/Surface.cpp | dequeueBuffer() |
| onMessageReceived | frameworks/native/services/surfaceflinger/SurfaceFlinger.cpp | onMessageReceived() |
| bindApplication | android/app/ActivityThread.java | handleBindApplication() |
| performCreate | android/app/Instrumentation.java | callActivityOnCreate() |
| inflate | android/view/LayoutInflater.java | inflate() |
| measure / layout / draw | android/view/View.java | measure(), layout(), draw() |
| Choreographer#doCallbacks | android/view/Choreographer.java | doCallbacks() |
| eglSwapBuffers | frameworks/native/opengl/libs/EGL/eglApi.cpp | eglSwapBuffersWithDamageKHR() |
| queueBuffer | frameworks/native/libs/gui/Surface.cpp | queueBuffer() |

**3c. Perfetto 表/视图查询：**
如果用户问到 Perfetto 的特定表或视图：
```
lookup_sql_schema("<table_or_view_name>")
```
返回表的 schema、列定义和用途说明。

**Phase 4 — 教学输出格式：**

### 输出结构必须遵循：

1. **概念说明**：这个组件/Slice/线程是什么（1-2 句话，用中文通俗解释）
   - 术语首次出现时给出中英文对照，如：VSync（垂直同步信号）

2. **在渲染管线中的位置**：它在帧渲染流程中处于什么阶段（如有 Mermaid 图则展示）
   - 标注当前关注对象在 Mermaid 图中的位置

3. **关键线程角色**：
   ```
   | 线程名 | 职责 | 对应的 Trace 标签 |
   |-------|------|----------------|
   | main | UI 布局和绘制 | Choreographer#doFrame, measure, layout, draw |
   | RenderThread | GPU 命令提交 | DrawFrame, syncFrameState, flush commands |
   | SurfaceFlinger | 合成与显示 | onMessageReceived, INVALIDATE, REFRESH |
   ```

4. **关键 Slice 说明**：
   ```
   | Slice 名称 | 说明 | 正常耗时范围 |
   |-----------|------|------------|
   | Choreographer#doFrame | VSync 触发的帧回调入口 | 2-8ms |
   | DrawFrame | RenderThread 绘制入口 | 2-6ms |
   | dequeueBuffer | 从 BufferQueue 获取缓冲区 | <1ms |
   ```

5. **AOSP 源码位置**（仅在用户明确问到时提供）：
   - 源码文件路径 + 关键函数名

6. **与当前 Trace 的关联**：
   - 必须区分“trace 中实际观测到的事实”和“文档/YAML 中的机制解释”
   - 如果用户选中了特定内容，将教学与选区关联
   - 没有 selection 时说明使用 visible window、package/process hint 还是 fallback
   - 如有异常，指出偏差并简要说明可能原因
   - 如果缺少 SurfaceFlinger/HWC/present/fence 等采集信号，明确说明不能伪造这一段链路

7. **常见问题**：
   - 该组件相关的常见性能问题（2-3 条）
   - 每条包含：问题表现、典型原因、排查方向

**Phase 5 — 时间线可视化（可选）：**

当你完成管线教学内容后，如果已检测到管线类型并获取了关键 Slice 列表，调用以下 skill 将关键 Slice 高亮为 Perfetto 时间线 overlay，帮助用户对照理论管线图与实际 trace。这个 overlay 结果应进入 observed-flow 语义：命中的 slice 是事实，未命中的 slice 是 warning，不是静态模板事实。

```
invoke_skill('pipeline_key_slices_overlay', {
  slice_names: "'Choreographer#doFrame','DrawFrame','syncFrameState',...",
  package: <package hint>,
  start_ts: <分析区间起始>,
  end_ts: <分析区间结束>
})
```

注意：`slice_names` 参数使用 SQL IN 列表格式，每个名称用单引号包裹、逗号分隔。从管线教学的 `key_slices` 列表中提取名称。

**教学原则：**
- **先教后诊**：先解释正常行为，再指出异常
- **事实先于模板**：真实 slice/thread/process/layer/ts/dur/present 证据优先；Mermaid 和文档只解释已观测链路
- **混合链路分开看**：HWUI host 与 WebView/Flutter/RN/GL/TextureView/SurfaceView producer 先分开展示，再在有 dependency/overlap 证据时合并
- **分层教学**：第一轮给概览，用户追问再深入
- **关联实践**：始终结合当前 trace 中的实际数据
- **不假设知识**：首次使用技术术语时用中文解释含义
- **鼓励探索**：在结尾建议用户可以进一步询问的方向
<!-- /strategy-detail -->
