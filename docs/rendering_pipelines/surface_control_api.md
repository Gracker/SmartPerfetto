# SurfaceControl API Deep Dive (NDK)

在 Android NDK 开发中，`ASurfaceControl` (Android 10/Q 引入, API 29) 是与 SurfaceFlinger 进行低级交互的核心接口。它赋予了 App 像 WindowManager 一样的能力来操控图层。

## 1. 核心概念

*   **ASurfaceControl**: 代表 SurfaceFlinger 中的一个 Layer（图层）。它可以是一个 Buffer 容器（显示内容），也可以是一个纯容器（Color Layer / Container Layer）。
*   **ASurfaceTransaction**: 代表一组原子操作。你可以一次性修改多个 SurfaceControl 的属性（位置、大小、Buffer、Z-Order），然后 commit。

## 2. 也是 "BLAST"

NDK 的 SurfaceControl API 实际上就是 BLAST 协议的直接体现。

*   **Atomicity**: `ASurfaceTransaction_apply()` 保证了在这个 Transaction 内的所有修改，要么全生效，要么全不生效。
*   **Sync**: 可以通过 `ASurfaceTransaction_setBuffer` 绑定 Buffer，确保画面内容和窗口属性同步更新。

## 3. 典型使用流程

### 步骤 1: 创建 SurfaceControl
你需要一个父 SurfaceControl（通常来自 `SurfaceView.getSurfaceControl()`）或者直接挂载到 Display。

```c
ASurfaceControl* child = ASurfaceControl_create(
    parent, "MyOverlay", "ASurfaceControl", width, height, format, ...
);
```

### 步骤 2: 配置 Transaction
创建并配置一个事务：

```c
ASurfaceTransaction* transaction = ASurfaceTransaction_create();

// 设置 Buffer (来自 AHardwareBuffer)
ASurfaceTransaction_setBuffer(transaction, child, hardwareBuffer, fence);

// 设置位置
ASurfaceTransaction_setPosition(transaction, child, x, y);

// 设置层级
ASurfaceTransaction_setZOrder(transaction, child, 10);

// 设置可见性
ASurfaceTransaction_setVisibility(transaction, child, ASURFACE_TRANSACTION_VISIBILITY_SHOW);
```

### 步骤 3: 提交 Transaction
```c
ASurfaceTransaction_apply(transaction);
```
这一步会将打包好的数据发送给 SurfaceFlinger。

## 4. 关键 API 详解

### Buffer Management
*   `ASurfaceTransaction_setBuffer(..., ASurfaceTransaction_ASurfaceControl* sc, AHardwareBuffer* buffer, int fence_fd)`
    *   这是最核心的 API。你必须自己管理 `AHardwareBuffer` 的生命周期。
    *   `fence_fd`: 一个 acquire fence。SF 会等待这个 fence signal 后才去读 buffer。

### Hierarchy Management
*   `ASurfaceTransaction_reparent(...)`
    *   动态改变图层树结构。例如将一个图层从 SurfaceView 移到 Activity 顶层（实现画中画动画）。

## 5. 优势与场景

*   **WebView Out-of-process Rasterization**: 浏览器在独立进程合成页面，直接通过 SurfaceControl 发给 SF，不经过 App 主线程。
*   **Custom Video Player**: 可以实现极其复杂的视频弹幕融合效果。
*   **Dynamic UI**: 如 Flutter 这种自绘引擎，利用 SurfaceControl 实现高效的 PlatformView 嵌入。

## 6. 注意事项

*   **生命周期**: `ASurfaceControl` 是内核资源，必须及时 Release。
*   **Fence Leak**: 必须正确处理 Fence FD，否则会导致系统挂起。传递给 API 后，FD 的所有权通常会转移给系统（Close on exec）。

## 7. Frame Timeline API (Android 11+)

从 Android R 开始，SurfaceControl API 新增了 **Frame Timeline** 系列接口，用于精准控制帧的着陆时间。

### 7.1 核心 API

```c
// 获取下一帧的预期 VSync 时间 (Android 11+)
int64_t vsyncId;
int64_t expectedPresentTime;
ASurfaceTransaction_getNextFrameInfo(transaction, &vsyncId, &expectedPresentTime);

// 设置目标帧时间线 (Android 12+)
ASurfaceTransaction_setFrameTimeline(
    transaction,
    vsyncId   // 告诉 SF：这帧打算在这个 VSync 着陆
);
```

### 7.2 工作原理

```mermaid
sequenceDiagram
    participant App
    participant BBQ as BLAST Adapter
    participant SF as SurfaceFlinger

    App->>BBQ: getNextFrameInfo() -> vsyncId=42
    App->>App: Draw (耗时 8ms)
    App->>BBQ: setFrameTimeline(vsyncId=42)
    App->>BBQ: apply()
    
    BBQ->>SF: Transaction (vsyncId=42)
    SF->>SF: 收到，但当前是 vsync 41
    SF->>SF: 等待 vsync 42...
    SF->>SF: vsync 42 到达，Latch & Composite
```

### 7.3 性能优势

1.  **消除掉帧误判**: SF 知道这帧是故意"迟到"的（因为帧率设定），不会错误标记为 Jank。
2.  **支持动态帧率**: 配合 VRR 屏幕，App 可以精准控制 30/60/90/120fps 切换。
3.  **Perfetto 可视化**: 在 FrameTimeline Track 中可以看到 Expected vs Actual Present Time。

### 7.4 使用场景

*   **视频播放器**: 24fps/30fps 视频在 60Hz 屏幕上避免 3:2 pulldown 抖动。
*   **游戏引擎**: 在 GPU 负载高时主动降频，而非被动掉帧。
*   **省电模式**: 低功耗场景主动请求 30fps 渲染。

