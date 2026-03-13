---
scene: pipeline
priority: 4
effort: medium
keywords:
  - 管线识别
  - pipeline识别
  - 渲染路径
  - 渲染管线检测
  - 管线类型
  - pipeline detection
  - rendering pipeline
  - render path
  - architecture detection
  - 渲染架构检测
  - 帧渲染路径
  - frame path
compound_patterns:
  - "什么.*管线"
  - "什么.*pipeline"
  - "识别.*渲染"
  - "检测.*管线"
  - "渲染.*路径"
  - "pipeline.*type"
---

#### 渲染管线识别与教学分析（用户提到 管线识别、pipeline 检测、渲染路径、渲染架构检测）

**核心目标：** 识别 trace 中应用使用的渲染管线类型，展示管线架构图，并路由到对应的分析策略。

**Phase 1 — 自动检测：**
```
detect_architecture()
```
- 返回：architectureType（Standard/Flutter/Compose/WebView/Game 等）、confidence、metadata（engine、surfaceType 等）
- 如果 confidence < 0.5：标注不确定性，进入 Phase 3 手动验证
- 如果 confidence >= 0.5：直接进入 Phase 2

**Phase 2 — 管线匹配与教学：**
```
list_skills(type="pipeline")
invoke_skill("<matched_pipeline_skill>")
```

根据检测到的架构类型匹配对应的 Pipeline Skill：

| 架构类型 | Pipeline Skill | 说明 |
|---------|---------------|------|
| Standard BLAST | android_view_standard_blast | Android 13+ 默认管线，BLASTBufferQueue |
| Standard Legacy | android_view_standard_legacy | Android 12- 传统 BufferQueue |
| Software Rendering | android_view_software | 软件渲染（无 RenderThread） |
| Compose | compose_standard | Jetpack Compose 渲染管线 |
| Flutter SurfaceView (Skia) | flutter_surfaceview_skia | Flutter Skia 引擎 + SurfaceView |
| Flutter SurfaceView (Impeller) | flutter_surfaceview_impeller | Flutter Impeller 引擎 + SurfaceView |
| Flutter TextureView | flutter_textureview | Flutter TextureView 模式 |
| WebView GL Functor | webview_gl_functor | WebView 默认渲染路径 |
| WebView SurfaceControl | webview_surface_control | WebView 独立 Surface 模式 |
| SurfaceView | surfaceview_blast | SurfaceView 独立渲染 |
| TextureView | textureview_standard | TextureView 渲染 |
| Game Engine | game_engine | 游戏引擎（Unity/Unreal 等） |
| OpenGL ES | opengl_es | 原生 OpenGL ES 渲染 |
| Vulkan | vulkan_native | 原生 Vulkan 渲染 |
| Camera | camera_pipeline | 相机预览管线 |
| Video Overlay | video_overlay_hwc | 视频 HWC Overlay |

展示教学内容：
- **Mermaid 时序图**：帧从生产到消费的完整流程
- **线程角色表**：关键线程名、职责、对应的 trace 标签
- **关键 Slice 列表**：Slice 名称、说明、正常耗时范围

**Phase 3 — 管线验证（当 confidence < 0.5 时执行）：**

通过手动查询关键 Slice 模式来确认/修正管线类型：
```sql
-- 检查 HWUI 标准管线特征
SELECT name, COUNT(*) as cnt
FROM slice
WHERE name IN ('DrawFrame', 'syncFrameState', 'Choreographer#doFrame', 'dequeueBuffer', 'queueBuffer')
GROUP BY name
ORDER BY cnt DESC
```

```sql
-- 检查 Flutter 特征
SELECT t.name AS thread_name, COUNT(*) as slice_cnt
FROM slice s
JOIN thread t ON s.track_id = t.utid
WHERE t.name IN ('1.ui', '1.raster', '1.io', 'io.flutter.1.ui', 'io.flutter.1.raster')
GROUP BY t.name
```

```sql
-- 检查 WebView 特征
SELECT name, COUNT(*) as cnt
FROM slice
WHERE name GLOB '*CrRendererMain*'
   OR name GLOB '*WebViewChromium*'
   OR name GLOB '*GLFunctor*'
   OR name GLOB '*viz::*'
GROUP BY name
ORDER BY cnt DESC
LIMIT 10
```

```sql
-- 检查 Game Engine 特征
SELECT name, COUNT(*) as cnt
FROM slice
WHERE name GLOB '*UnityMain*'
   OR name GLOB '*UnityGfx*'
   OR name GLOB '*UE4*'
   OR name GLOB '*GameThread*'
   OR name GLOB '*RHIThread*'
GROUP BY name
ORDER BY cnt DESC
LIMIT 10
```

根据查询结果向用户展示证据：
"发现 DrawFrame 共 180 次、BLASTBufferQueue 相关 Slice 共 160 次 → 确认为 Standard BLAST 管线"

**Phase 4 — 管线特有分析路由：**

检测完管线后，引导用户进行对应的性能分析：

| 管线族 | 推荐分析 Skill | 注意事项 |
|-------|--------------|---------|
| **HWUI Standard** | scrolling_analysis, jank_frame_detail | FrameTimeline 可用，jank_type 直接可查 |
| **Flutter** | flutter_scrolling_analysis | 使用 1.ui/1.raster 线程，非标准 RenderThread |
| **Compose** | scrolling_analysis | 关注 Recomposition 开销，FrameTimeline 可用 |
| **WebView** | scrolling_analysis + 手动分析 CrRendererMain | Web 内容无直接 FrameTimeline |
| **Game Engine** | game_fps_analysis, gpu_analysis | 无 FrameTimeline，通常 GPU-bound |
| **Camera/Video** | gpu_analysis, surfaceflinger_analysis | HWC Overlay 分析，关注 layer 合成策略 |
| **SurfaceView** | surfaceflinger_analysis | 独立 Surface，需查看 SF 合成时序 |
| **TextureView** | scrolling_analysis | 共享 App Surface，可能有 GPU 纹理上传开销 |

**Phase 5 — 多管线共存检测：**

某些应用同时使用多种渲染管线（如 WebView 嵌入 View、Flutter PlatformView、视频播放叠加 UI）：

```sql
-- 检测多 Surface 共存
SELECT
  layer_name,
  COUNT(*) as frame_cnt
FROM actual_frame_timeline_slice
GROUP BY layer_name
ORDER BY frame_cnt DESC
LIMIT 10
```

```sql
-- 检测多 RenderThread
SELECT t.name, t.tid, COUNT(s.id) as slice_cnt
FROM slice s
JOIN thread t ON s.track_id = t.utid
WHERE t.name GLOB 'RenderThread*'
   OR t.name GLOB '1.raster*'
   OR t.name GLOB 'CrRendererMain*'
   OR t.name GLOB 'GLThread*'
GROUP BY t.name, t.tid
ORDER BY slice_cnt DESC
```

如果检测到多管线共存：
- 说明哪些管线共存以及各自的帧数占比
- 解释管线之间的交互方式（如 PlatformView 通过 TextureView 桥接）
- 指出可能的性能影响（如额外的 GPU 纹理拷贝、合成复杂度增加）

### 输出结构必须遵循：

1. **检测结果**：
   - 渲染管线类型 + 置信度
   - 如有多管线共存，分别列出

2. **管线架构图**（Mermaid 时序图，来自 Pipeline Skill 教学内容）

3. **关键线程角色表**：
   ```
   | 线程名 | 职责 | Trace 标签 |
   |-------|------|-----------|
   | main | UI 布局和事件处理 | Choreographer#doFrame, measure, layout |
   | RenderThread | GPU 命令提交 | DrawFrame, syncFrameState |
   | ... | ... | ... |
   ```

4. **管线特有性能注意事项**：
   - 该管线常见的性能瓶颈点
   - 需要特别关注的指标

5. **推荐后续分析路径**：
   - 基于检测到的管线类型，建议用户可以进一步分析的方向
   - 例如："检测到 Flutter SurfaceView (Impeller) 管线，可以问'分析滑动卡顿'查看 Flutter 帧渲染性能"
