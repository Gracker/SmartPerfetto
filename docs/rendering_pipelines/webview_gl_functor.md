# WebView GL Functor Pipeline (Standard/Shared)

在普通的 App 页面中嵌入 WebView（如新闻详情页）时，**GL Functor / in-process draw callback** 是最常见的经典路径之一，但是否命中这条路径仍取决于 WebView 版本、特性开关和设备条件。

## 0. 初始化与桥接 (WebViewFactory)

在进入渲染流程前，理解 Android Framework 如何加载 WebView 内核至关重要。这解释了为什么 App process 里会有 Chromium 的代码。

### 核心工厂模式
Android 系统通过 `WebViewFactory` 类动态加载 WebView 实现（通常是 Google WebView 或 Chrome）。
1.  **WebViewFactory.getProvider()**:
    *   这是 Framework 的入口。
    *   它会 `dlopen` WebView 实现对应的 Native 库（如 `libmonochrome.so` 或 `libwebviewchromium.so`，取决于 Trichrome/Monochrome 架构）。
    *   实例化 `WebViewChromiumFactoryProvider`。
2.  **AwContents**:
    *   这是 Chromium 侧与 Android `WebView` 类对应的一对一核心对象。
    *   所有的 `loadUrl`, `onDraw` 调用最终都会委托给 AwContents。
3.  **DrawGL Functor 注册**:
    *   在初始化时，AwContents 会通过 JNI 向 App 的 `RenderThread` 注册一个 Functor。
    *   这就是为什么 App 的 RenderThread 能够“认识”并回调 Chromium 的渲染代码。

---

## 1. 共享上下文流程详解 (Deep Execution Flow)

此模式的核心特点是：WebView **蹭车**。它没有独立的 Surface，而是把自己的绘制指令注入到 App 的 `RenderThread` 中执行。

### 第一阶段：Chromium 渲染侧
1.  **Parse/Style/Layout**: 解析 HTML/CSS，计算页面布局。
2.  **Paint**: 生成 DisplayItemList。
3.  **Commit**: 提交给 Compositor Thread。
4.  **Tiling**: Compositor Thread 将图层切分为 Tile。
5.  **Raster**: Raster Worker 将 Tile 光栅化；WebView 的 browser code、GPU / network 等服务通常仍在宿主 app 进程内，renderer 进程是否独立取决于当前 multiprocess 配置。
6.  **Invalidate**: 通过 IPC / 回调通知宿主进程：“我准备好了，你重绘一下”。

### 第二阶段：App UI Thread (主线程)
1.  **onDraw**: View 树遍历到 WebView。
2.  **Record**: WebView 往 Canvas 里写一个特殊的 `DrawFunctorOp`。这是一个占位符，相当于告诉 RenderThread：“到这儿的时候，去调一下 WebView 的原生代码”。

### 第三阶段：App RenderThread (渲染线程)
1.  **Sync**: 获取 DrawFunctorOp。
2.  **Invoke Functor**: 执行到占位符时，调用 WebView 提供的 C++ 回调 (`DrawGL`)。
    *   **Context Switch**: 此时 OpenGL 上下文仍然是 App 的，但执行权交给了 Chromium 的代码。
3.  **Execute GL**: Chromium 用 App 的 EGLContext 执行它的 GL 指令（画网页内容）。
    *   *风险*: 如果网页太复杂，画得太慢，会直接拖慢 App 的 `DrawFrame` 总耗时，导致 App 掉帧。

---

## 2. 渲染时序图

注意 `Invoke Functor` 这一步，它是在 App 的渲染循环中同步执行的。

```mermaid
sequenceDiagram
    participant HW as Hardware VSync
    participant UI as App UI Thread
    participant RT as App RenderThread
    participant WP as Chromium Code (in RT)
    participant SF as SurfaceFlinger
    participant HWC as HWC

    %% 1. VSync
    Note over HW, UI: 1. VSync-App Arrival
    HW->>UI: Signal
    
    %% 2. App Process
    rect rgb(240, 240, 250)
        Note over UI, RT: 2. App Rendering
        activate UI
        UI->>UI: Build DisplayList (Op: DrawFunctor)
        UI->>RT: SyncFrameState
        deactivate UI
        
        activate RT
        RT->>RT: DrawFrame
        RT->>WP: Invoke Functor (DrawGL, in-process callback)
        
        activate WP
        WP->>WP: Execute GL Commands (Shared Context)
        WP->>RT: Return
        deactivate WP
        
        RT->>SF: queueBuffer (App Window)
        deactivate RT
    end

    %% 3. Composition
    Note over HW, SF: 3. Composition (VSync-SF)
    HW->>SF: VSync-SF Signal
    activate SF
    SF->>SF: latchBuffer
    SF->>HWC: Composite
    deactivate SF

    %% 4. Display
    rect rgb(250, 230, 230)
        Note over HWC: 4. Scanout
        HWC->>HWC: Display Panel
    end
```

## 3. 线程角色详情 (Thread Roles)

| 线程名称 | 关键职责 | 常见 Trace 标签 |
|:---|:---|:---|
| **main** (App) | View 构建, WebView.onDraw 记录 DrawFunctor | `Choreographer#doFrame` |
| **RenderThread** (App) | GPU 渲染, **同步调用 WebView draw callback** | 常见 `DrawFrame`；`DrawFunctor` / `DrawGL` 仅在部分 trace 中可见 |
| **CrRendererMain** | Blink 主线程, HTML/CSS 解析布局 | `ThreadControllerImpl::RunTask` |
| **Compositor** | CC 合成, 生成 DrawQuad | `Scheduler::BeginFrame` |
| **VizCompositorThread** | 条件触发的独立合成模式下可能出现 | 仅在特定模式 / tracing 下可见 |
| **SurfaceFlinger** | 合成最终画面 | 常见 `latchBuffer` / FrameTimeline / SF 主循环片段 |

---

## 4. Hardware Draw Functor API (Android 10+)

从 Android Q 开始，Framework 引入了 **Hardware Draw Functor API**，作为传统 GL Functor 的演进版本。

### 4.1 与传统 GL Functor 的区别

| 特性 | Legacy GL Functor | Hardware Draw Functor |
|:---|:---|:---|
| **Fence / 提交模型** | 较偏隐式 | 更现代，但仍受 Framework / provider 私有接口约束 |
| **同步模式** | 以同步 draw callback 为主 | 能力更灵活，但未必完全异步 |
| **Vulkan 支持** | 传统上偏 GLES | 现代实现可能接入 Vulkan |
| **线程安全** | 依赖具体 provider 实现 | 不宜直接写成“完全线程安全” |

### 4.2 核心 API (Native)

```c
// Hardware Draw Functor 使用私有接口 (draw_fn.h)
// 核心回调结构（非公开 NDK API，属于 WebView provider 与 Framework 的私有接口）：
// - AwDrawFn_DrawGL: GL 模式的绘制回调
// - AwDrawFn_DrawVk: Vulkan 模式的绘制回调
// App 的 RenderThread 通过函数指针回调执行 Chromium 的渲染代码
```

### 4.3 性能优势

1.  **Fence-based GPU Sync**: 引入更现代的 fence / 提交控制后，CPU 等待方式可能减少，但 RenderThread 是否仍受 WebView 绘制阶段拖累，要以实际 trace 为准。
2.  **Vulkan Path**: 现代浏览器内核可以走 Vulkan 路径，但是否启用与是否暴露到系统 trace 是两件事。
3.  **Trace 可见性**: `HardwareDrawFunctor`、`DrawFn_DrawGL`、`DrawFn_DrawVk` 等名称都可能出现在特定 build / tracing 配置中，不应被当作稳定 contract。

### 4.4 兼容性说明

*   **Android 10 (Q)**: 引入基础 API。
*   **Android 11 (R)**: 完善异步模式。
*   **Android 12 (S)**: 与 BLAST 深度整合。
