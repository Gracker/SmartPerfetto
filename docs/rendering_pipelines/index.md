# Android Rendering Pipelines Overview

本项目涵盖了 Android 系统中几乎所有的核心出图链路。理解这些链路对于性能调优至关重要。

> [!IMPORTANT]
> **文档版本**: 本文档已更新至 **Android 16 (Baklava)** 架构。以下为 Android 版本与渲染架构的对应关系。

## 版本与架构矩阵

| Android 版本 | 核心架构 | 关键特性 |
|:---|:---|:---|
| **Android 16** (API 36) | BLAST + ANGLE 默认 + VPA | Enhanced ARR, RuntimeColorFilter, GPU syscall filtering |
| **Android 15** (API 35) | BLAST + ANGLE 强制采用 | Vulkan Profiles (VPA), ANGLE 作为默认 GLES |
| **Android 14** (API 34) | BLAST + HardwareBufferRenderer | 现代软件渲染 API |
| **Android 12-13** (API 31-33) | BLAST 成熟期 | FrameTimeline, 完整 BLAST Sync |
| **Android 10-11** (API 29-30) | BLAST 引入期 | BLASTBufferQueue, SurfaceControl NDK |
| **Android 9 及以下** | Legacy BufferQueue | 传统 queueBuffer 模式 (已弃用) |

### Android 15/16 新特性快速索引

| 特性 | 适用版本 | 文档链接 |
|:---|:---|:---|
| ANGLE 强制采用 | Android 15+ | [ANGLE Pipeline](angle_gles_vulkan.md) |
| Vulkan Profiles (VPA) | Android 15+ | [Vulkan Native](vulkan_native.md) |
| Enhanced Adaptive Refresh Rate | Android 16 | [VRR Pipeline](variable_refresh_rate.md) |
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

## 详细链路文档

- [Android View (Standard) Pipeline](android_view_standard.md)
- **[Android View (Multi-Window) Pipeline](android_view_multi_window.md)**: 同一进程内双窗口（如 Dialog）导致的主线程/渲染线程串行争抢。
- [Android View (Software) Pipeline](android_view_software.md)
- **[Android View (Mixed) Pipeline](android_view_mixed.md)**: **[NEW]** 混合渲染模式 (Hybrid Composition)。
- [SurfaceView (Direct Producer) Pipeline](surfaceview.md)
- [TextureView (App-side Composition) Pipeline](textureview.md)
- **[Flutter Architecture (Impeller/Thread Merging)](flutter_architecture.md)**: 3.29+ 架构下的主线程合并与 Impeller 渲染。
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

## WebView Rendering Deep Dive

WebView 拥有最为复杂的渲染架构，根据场景不同分为 4 种模式。

### Process Architecture
```mermaid
graph TD
    subgraph "App Process"
        UI[UI Thread]
        RT[RenderThread]
        SV[SurfaceView (Wrapper)]
        TV[TextureView (Custom)]
    end
    
    subgraph "Chromium Process (Sandboxed)"
        Main[CrRendererMain]
        Comp[Compositor Thread]
        Tile[Raster Worker]
    end
    
    subgraph "GPU Process"
        GPU[Viz / GPU Main]
        SC[SurfaceControl (Direct)]
    end

    UI -->|IPC| Main
    Main -->|Commit| Comp
    Comp -->|Task| Tile
    Comp -->|CommandBuffer| GPU
    GPU -->|GL/Vulkan| RT
    GPU -.->|Buffer| SC
    UI -.->|Holder| SV
    GPU -.->|Frame| TV
```

### WebView Pipelines

| 模式 | 场景 | Buffer 生产者 | 关键特征 | 文档 |
| :--- | :--- | :--- | :--- | :--- |
| **1. GL Functor** | 普通新闻/H5 | **App RenderThread** | 此模式下 App 渲染线程会 Sync 等待 WebView | [文档](webview_gl_functor.md) |
| **2. SurfaceView Wrapper** | 全屏视频 | **App Player** | 视频直接上屏，WebView 仅负责占位 | [文档](webview_surfaceview_wrapper.md) |
| **3. SurfaceControl** | 现代 Vulkan | **Viz (GPU)** | 独立合成，App 侧挖洞 (Hole Punch) | [文档](webview_surface_control.md) |
| **4. Custom TextureView** | 国内定制内核 | **App RenderThread** | 渲染到 SurfaceTexture，主线程回调拷贝 | [文档](webview_textureview_custom.md) |

### 7. 专业架构 Review (高级性能工程师视角)
基于目前的测试桩架构，我认为尚有以下变体可以进一步细化，以逼近真实生产环境：

1.  **WebView SurfaceControl 深度模拟**: 目前项目中 GeckoView 对 SurfaceView 的使用接近 SurfaceControl，但建议增加一个专门模拟 `SurfaceControl.Transaction` 异步提交延迟的桩，这能更真实地反映现代浏览器内核与 SF 的交互瓶颈。
2.  **Flutter 3.29 负载对等测试**: 建议在 `switch-flutter` 中增加一个实验，模拟 UI 和 Platform 线程合并后，如果系统回调阻塞（如同步 Binder 调用）对 Dart 层帧率的影响。
3.  **Vulkan 路径覆盖**: 目前大多数模块侧重 GLES/Skia。在 Android 12+，Skia-Vulkan 已成为主流，增加对 Vulkan 渲染路径的统计（通过 `vkQueuePresentKHR`）将是该项目的顶层拼图。

## 如何根据链路进行分析？

1.  **确定生产者线程**: 是 UI 线程、RenderThread 还是开发者自定义线程？
2.  **查看 Vsync 挂钩点**: 是否绑定了 `Choreographer`？
3.  **观察 BufferQueue 深度**: 使用 `dumpsys SurfaceFlinger` 查看对应的 Buffer 层级。
4.  **监测渲染耗时**: 使用 Perfetto 追踪 `drawFrame` (RT) 或 `lockCanvas` (UI) 的频率。
