# Android Rendering Pipelines Overview

[English](index.en.md) | [中文](index.md)

SmartPerfetto covers the core Android rendering paths used in performance investigations. Understanding these paths matters because the producer thread, buffer boundary, SurfaceFlinger path, and hardware composer behavior determine what trace evidence is meaningful.

> [!IMPORTANT]
> This matrix describes mainstream AOSP and public-documentation behavior. OEM ROMs, device capabilities, graphics drivers, and app implementations can differ. Always verify against the concrete device and trace.

## Version and Architecture Matrix

| Android version | Common main path | Key features |
|---|---|---|
| Android 16 (API 36) | BLAST plus evolving FrameTimeline / ARR / AVP capabilities | ARR API evolution, graphics API and shader improvements |
| Android 15 (API 35) | BLAST plus Vulkan as a primary low-level graphics API, with optional ANGLE layer | Android Vulkan Profile and ANGLE adoption trend |
| Android 14 (API 34) | BLAST plus modern APIs such as HardwareBufferRenderer | Modern software rendering APIs, SurfaceControl/Transaction improvements |
| Android 12-13 (API 31-33) | Mature BLAST era | Better FrameTimeline and transaction/composition observability |
| Android 10-11 (API 29-30) | Transition era with legacy BufferQueue and BLAST/SurfaceControl coexisting | BLASTBufferQueue and SurfaceControl NDK introduction |
| Android 9 and earlier | Legacy BufferQueue | Traditional queueBuffer path |

## Typical Pattern Comparison

| Pattern | Core components | Producer | Consumer | Characteristics | Module |
|---|---|---|---|---|---|
| Android View (Standard) | RecyclerView | UI Thread + RenderThread | SurfaceFlinger | General-purpose standard path | `scrolling-aosp-performance` |
| Android View (Software) | Canvas | UI Thread (CPU) | SurfaceFlinger | Bypasses GPU, useful for CPU stress | `scrolling-aosp-softwarerender` |
| Android View (Mixed) | Recycler + Surface | UI + producer thread | SurfaceFlinger | Hybrid rendering, common in video/stream scenes | `scrolling-aosp-mixedrender` |
| SurfaceView | SurfaceView/EGL | Dedicated thread | SurfaceFlinger | Independent Surface, reduces app-side composition | `scrolling-aosp-purerenderthread` |
| TextureView | SurfaceTexture | Dedicated thread | App RenderThread | Flexible but adds extra copy/synchronization | `scrolling-webview-texture` |
| OpenGL ES | EGL/GLES | GL thread | SurfaceFlinger | High-frequency command stream, maps/games | `scrolling-gl-map` |
| Jetpack Compose | Compose + HWUI | Main + RenderThread | SurfaceFlinger | Recomposition, layout, DisplayList driven | `pipeline_compose_standard` |
| Chrome Browser Viz | Chromium Viz | Renderer + Viz/GPU | SurfaceFlinger | Independent Chrome multi-process composition | `pipeline_chrome_browser_viz` |
| ImageReader | BufferQueue consumer | Camera/GPU/Codec | App ImageReader | Frame acquisition for ML, recording, post-processing | `pipeline_imagereader_pipeline` |
| Software Compositing | SurfaceFlinger client composition | App producers | SurfaceFlinger CPU | Fallback when HWC/GPU path is unavailable | `pipeline_software_compositing` |

## WebView Rendering Modes

| Mode | Scene | Common producer | Key trait |
|---|---|---|---|
| GL Functor | Normal news/H5 pages | Host RenderThread + Chromium callback cooperation | WebView drawing runs inline with App RenderThread and can slow host rendering |
| SurfaceView Wrapper | Full-screen video / `onShowCustomView()` | App player / MediaCodec | App owns SurfaceView; WebView mainly controls signaling/container behavior |
| SurfaceControl | Modern independent composition when enabled | Chromium compositor/service thread | Child layer composition depends on Chromium features, device, and Android version |
| Custom TextureView | Customized WebView kernels | SDK kernel / SurfaceTexture producer | Renders into SurfaceTexture, then host samples/composes it |

## How to Analyze by Pipeline

1. Identify the producer thread: UI thread, RenderThread, or an app-defined thread.
2. Check the VSync hook: whether it is bound to `Choreographer`.
3. Inspect BufferQueue depth and SurfaceFlinger layers.
4. Measure rendering cost through trace slices such as `drawFrame`, `lockCanvas`, GL/Vulkan present, or SurfaceControl transactions.
5. Separate app-side production delays from SurfaceFlinger/composition delays before assigning root cause.
