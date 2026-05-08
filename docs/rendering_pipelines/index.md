# Android Rendering Pipelines Overview

[English](index.en.md) | [中文](index.md)

本项目涵盖了 Android 系统中几乎所有的核心出图链路。理解这些链路对于性能调优至关重要。

> [!IMPORTANT]
> **阅读方式**: 下面的矩阵描述的是 AOSP / 官方文档中的主流方向与常见能力，不代表所有设备、OEM ROM 或 GMS 配置都完全一致。涉及 ANGLE、VRR、AVP/AVP、SurfaceControl 等能力时，请以具体设备和 trace 为准。

## 版本与架构矩阵

| Android 版本 | 常见主链路 | 关键特性 |
|:---|:---|:---|
| **Android 16** (API 36) | BLAST + 持续演进的 FrameTimeline / ARR / AVP 能力 | ARR API 继续演进，部分图形 API 和着色器能力增强 |
| **Android 15** (API 35) | BLAST + Vulkan 作为主低层图形 API + ANGLE 可选层 | Android Vulkan Profile (AVP) / ANGLE adoption trend |
| **Android 14** (API 34) | BLAST + HardwareBufferRenderer 等现代接口 | 现代软件渲染 API、SurfaceControl/Transaction 能力继续完善 |
| **Android 12-13** (API 31-33) | BLAST 成熟期 | FrameTimeline、Transaction/合成可观测性增强 |
| **Android 10-11** (API 29-30) | 过渡期：Legacy BufferQueue 与 BLAST/SurfaceControl 共存 | BLASTBufferQueue、SurfaceControl NDK 引入 |
| **Android 9 及以下** | Legacy BufferQueue | 传统 queueBuffer 模式 |

### Android 15/16 新特性快速索引

| 特性 | 适用版本 | 文档链接 |
|:---|:---|:---|
| ANGLE 可选层 / 采用趋势 | Android 15+ | [ANGLE Pipeline](angle_gles_vulkan.md) |
| Android Vulkan Profile (AVP) | Android 15+ | [Vulkan Native](vulkan_native.md) |
| Adaptive Refresh Rate / VRR 能力演进 | Android 15-16 | [VRR Pipeline](variable_refresh_rate.md) |
| RuntimeColorFilter / RuntimeXfermode | Android 16 | [Standard Pipeline](android_view_standard.md) |
| HardwareBufferRenderer | Android 14+ | [Hardware Buffer Renderer](hardware_buffer_renderer.md) |

---

## 典型模式对比

| 模式 | 核心组件 | 生产者 (Producer) | 消费者 (Consumer) | 特点 | 对应模块 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Android View (Standard)** | RecyclerView | UI Thread + RenderThread | SurfaceFlinger | 标准链，最通用 | `scrolling-aosp-performance` |
| **Android View (Software)** | Canvas | UI Thread (CPU) | SurfaceFlinger | 绕过 GPU，测试 CPU 极限 | `scrolling-aosp-softwarerender` |
| **Android View (Mixed)** | Recycler+Surface | UI + Producer Thread | SurfaceFlinger | 混合渲染，视频流场景 | `scrolling-aosp-mixedrender` |
| **SurfaceView** | SurfaceView/EGL | Dedicated Thread | SurfaceFlinger | 独立 Surface，减少 App 侧合成 | `scrolling-aosp-purerenderthread` |
| **TextureView** | SurfaceTexture | Dedicated Thread | App RenderThread | 灵活性高，但有多余拷贝/同步 | `scrolling-webview-texture` |
| **OpenGL ES** | EGL/GLES | GL Thread | SurfaceFlinger | 高频指令流，适合地图/游戏 | `scrolling-gl-map` |
| **Jetpack Compose** | Compose + HWUI | Main + RenderThread | SurfaceFlinger | Recomposition / Layout / DisplayList 驱动 | `pipeline_compose_standard` |
| **Chrome Browser Viz** | Chromium Viz | Renderer + Viz/GPU | SurfaceFlinger | 独立 Chrome 多进程合成 | `pipeline_chrome_browser_viz` |
| **ImageReader** | BufferQueue consumer | Camera/GPU/Codec | App ImageReader | 帧获取、ML、录制、二次处理 | `pipeline_imagereader_pipeline` |
| **Software Compositing** | SurfaceFlinger client composition | App producers | SurfaceFlinger CPU | HWC/GPU 不可用时的降级路径 | `pipeline_software_compositing` |

## 详细链路文档

- [Android View (Standard) Pipeline](android_view_standard.md)
- **[Jetpack Compose Standard Pipeline](compose_standard.md)**: Compose + HWUI 标准链路，重点关注 Recomposition、Layout 和 RenderThread 交界。
- **[Android View (Multi-Window) Pipeline](android_view_multi_window.md)**: 同一进程内双窗口（如 Dialog）导致的主线程/渲染线程串行争抢。
- [Android View (Software) Pipeline](android_view_software.md)
- **[Android View (Mixed) Pipeline](android_view_mixed.md)**: **[NEW]** 混合渲染模式 (Hybrid Composition)。
- [SurfaceView (Direct Producer) Pipeline](surfaceview.md)
- [TextureView (App-side Composition) Pipeline](textureview.md)
- **[Flutter Architecture (Impeller / Merged Threads / Render Modes)](flutter_architecture.md)**: Flutter Android 上的线程模型、render mode 与 Platform Views 组合关系。
    *   [Flutter SurfaceView (Direct)](flutter_surfaceview.md)
    *   [Flutter TextureView (Copy)](flutter_textureview.md)
- [OpenGL ES (GL Thread) Pipeline](opengl_es.md)
- **[Vulkan Native Pipeline](vulkan_native.md)**: **[NEW]** 纯 Vulkan 渲染与 BLAST 交互。
- **[SurfaceControl API Deep Dive](surface_control_api.md)**: NDK 级别的图层控制。
- **[PIP & Freeform Window](android_pip_freeform.md)**: 画中画与多窗口渲染。
- **[Video Overlay (HWC)](video_overlay_hwc.md)**: 极致性能的纯硬件视频合成。
- **[Camera Rendering Pipeline](camera_pipeline.md)**: **[NEW]** Camera2 API、HAL3 多流并发与 ZSL 机制。
- **[Hardware Buffer Renderer](hardware_buffer_renderer.md)**: **[NEW]** Android 14+ 现代软件渲染 API。
- **[ANGLE (GLES-over-Vulkan)](angle_gles_vulkan.md)**: **[NEW]** OpenGL ES 到 Vulkan 翻译层。
- **[Variable Refresh Rate (VRR)](variable_refresh_rate.md)**: **[NEW]** 动态刷新率渲染管线。
- **[Chrome Browser Viz Pipeline](chrome_browser_viz.md)**: 独立 Chrome Browser / Renderer / GPU-Viz 多进程渲染。
- **[ImageReader Pipeline](imagereader_pipeline.md)**: ImageReader 作为 BufferQueue consumer 获取帧，用于 ML、录制、后处理等场景。
- **[Software Compositing Pipeline](software_compositing.md)**: SurfaceFlinger client composition / CPU 合成回退路径。

## WebView Rendering Deep Dive

WebView 拥有最为复杂的渲染架构，根据场景不同分为 4 种模式。

### Process Architecture
```mermaid
graph TD
    subgraph "App Process"
        UI[UI Thread]
        RT[RenderThread]
        Browser[Chromium Browser Code]
        Services[GPU / Network / Utility Services<br/>通常 in-process]
        SV[SurfaceView (Wrapper)]
        TV[TextureView (Custom)]
    end
    
    subgraph "Optional Renderer Process (Sandboxed)"
        Main[CrRendererMain]
        Comp[Compositor Thread]
        Tile[Raster Worker]
    end

    UI --> Browser
    Browser -->|IPC| Main
    Main -->|Commit| Comp
    Comp -->|Task| Tile
    Browser --> Services
    Comp -->|CommandBuffer / Shared Context / SurfaceControl| Services
    Services -->|GL / Vulkan / Buffer| RT
    UI -.->|Holder| SV
    Comp -.->|SurfaceTexture| TV
```

### WebView Pipelines

| 模式 | 场景 | 常见 Buffer 生产者 | 关键特征 | 文档 |
| :--- | :--- | :--- | :--- | :--- |
| **1. GL Functor** | 普通新闻/H5 | **宿主 RenderThread + Chromium 回调协作** | App RenderThread 内联执行 WebView 绘制，可能被网页绘制拖慢 | [文档](webview_gl_functor.md) |
| **2. SurfaceView Wrapper** | 全屏视频 / `onShowCustomView()` | **App Player / MediaCodec** | App 托管 SurfaceView，WebView 主要负责信令和容器 | [文档](webview_surfaceview_wrapper.md) |
| **3. SurfaceControl** | 条件满足时的现代独立合成 | **Chromium 合成线程 / 服务线程** | 独立 child layer 合成，是否启用取决于 Chromium feature、设备和版本 | [文档](webview_surface_control.md) |
| **4. Custom TextureView** | 国内定制内核 | **SDK Kernel / SurfaceTexture producer** | 渲染到 SurfaceTexture，宿主侧再采样合成 | [文档](webview_textureview_custom.md) |

### 专业架构 Review (高级性能工程师视角)
基于目前的测试桩架构，我认为尚有以下变体可以进一步细化，以逼近真实生产环境：

1.  **WebView SurfaceControl 深度模拟**: 目前项目中 GeckoView 对 SurfaceView 的使用接近 SurfaceControl，但建议增加一个专门模拟 `SurfaceControl.Transaction` 异步提交延迟的桩，这能更真实地反映现代浏览器内核与 SF 的交互瓶颈。
2.  **Flutter 3.29 负载对等测试**: 建议在 `switch-flutter` 中增加一个实验，模拟 UI 和 Platform 线程合并后，如果系统回调阻塞（如同步 Binder 调用）对 Dart 层帧率的影响。
3.  **Vulkan 路径覆盖**: 目前大多数模块侧重 GLES/Skia。在 Android 12+，Skia-Vulkan 已成为主流，增加对 Vulkan 渲染路径的统计（通过 `vkQueuePresentKHR`）将是该项目的顶层拼图。

## 如何根据链路进行分析？

1.  **确定生产者线程**: 是 UI 线程、RenderThread 还是开发者自定义线程？
2.  **查看 Vsync 挂钩点**: 是否绑定了 `Choreographer`？
3.  **观察 BufferQueue 深度**: 使用 `dumpsys SurfaceFlinger` 查看对应的 Buffer 层级。
4.  **监测渲染耗时**: 使用 Perfetto 追踪 `drawFrame` (RT) 或 `lockCanvas` (UI) 的频率。
