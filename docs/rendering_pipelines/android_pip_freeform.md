# PIP & Freeform Window Rendering

Android 的多窗口模式（Split Screen, Freeform, Picture-in-Picture）在渲染层面上并没有太多魔法，但理解其窗口组织形式对于性能分析很有帮助。

## 1. 窗口组织架构 (Window Hierarchy)

在 SurfaceFlinger 侧，所有的窗口都是 Layer Tree 的一部分。

*   **Task Layer**: 在多窗口模式下，系统会为每个 Task 创建一个根容器 Layer。
*   **Activity Layer**: Task 下面挂载各个 Activity 的 SurfaceControl。
*   **App Surface**: Activity 下面才是我们熟悉的 App Window Surface。

```mermaid
graph TD
    Display[Display Root]
    Stack[Stack / Task Container]
    WinA[Window A (Main App)]
    WinB[Window B (PIP / Freeform)]
    
    Display --> Stack
    Stack --> WinA
    Stack --> WinB
```

## 2. PIP (画中画) 渲染流程

### 2.1 进入 PIP
1.  **Enter**: App 调用 `enterPictureInPictureMode()`。
2.  **Animation**: WindowManagerSystem (WMS) 接管窗口动画。
    *   WMS 使用 SurfaceControl 动画 API，将 App 的 Surface 缩小并移动到角落。
    *   *注意*: 在动画过程中，App 仍然在全分辨率渲染（或者根据 configuration change 变为小分辨率）。

### 2.2 持续渲染
在 PIP 模式下，App 的渲染循环与全屏模式**完全一致**：
1.  **Vsync**: 照常接收 Vsync-App。
2.  **Draw**: 照常绘制。
3.  **Submit**: 提交 Buffer。
4.  **Composite**: SF 将其作为一个小 Layer 合成到屏幕上。

### 2.3 性能考量
*   **Overdraw**: PIP 窗口悬浮在桌面或其他 App 之上，这一定会带来 Overdraw。
*   **Touch Input**: 输入事件会被分发给 PIP 窗口，App 需要处理小窗口下的点击逻辑。
*   **Resource Budget**: 系统通常会限制 PIP 窗口的 CPU/GPU 优先级，确保主前台应用（Background Task）流畅。

## 3. Freeform (自由窗口 / 桌面模式)

这在折叠屏和平板电脑上越来越常见。

*   **Multiple Resizing**: 用户可以随意拉伸窗口。
*   **Latency**: 窗口边框的拖拽通常由 SystemUI 渲染（作为一个独立的 Layer），而 App 内容跟随 resize。
    *   如果 App 响应慢，会出现“黑边”或“内容拉伸”。
    *   **BLAST Sync** 极其关键：WMS 会将“窗口边框大小”和“App 内容 Buffer”同步提交，消除这些瑕疵。

## 4. Trace 分析特征

在 System Trace 中：
1.  **BufferQueue**: 每个独立窗口都有自己的 BufferQueue。
2.  **Vsync-App**: 所有可见窗口都会收到 Vsync。
3.  **Composition**: SurfaceFlinger 的 `handleMessageRefresh` 处理所有可见 Layer 的合成。如果只有 PIP 窗口更新，背景不动，HWC 可能可以直接复用背景 Layer 的 Cache。

## 5. Freeform Resize 同步竞态 (Deep Dive)

在 Freeform 窗口拖拽调整大小时，存在一个经典的**竞态条件**，理解它对于分析"黑边"和"内容拉伸"问题至关重要。

### 5.1 竞态流程

```mermaid
sequenceDiagram
    participant User as User Drag
    participant WMS as WindowManager
    participant App as App Process
    participant SF as SurfaceFlinger

    User->>WMS: Resize Start (边框拖动)
    WMS->>App: Configuration Change (新尺寸)
    WMS->>SF: Transaction (Window Bounds = 新尺寸)
    
    Note over App: App 还在重新 Layout...
    App->>App: Measure -> Layout -> Draw
    
    Note over SF: SF 等不及了!
    SF->>SF: Composite (旧内容 + 新边框)
    Note right of SF: 💥 黑边/拉伸!
    
    App->>SF: queueBuffer (新内容)
    SF->>SF: Composite (同步)
```

### 5.2 BLAST Sync 解决方案

Android 12+ 通过 **BLAST Sync** 解决此问题：

1.  **Sync Token**: WMS 为这次 resize 生成一个 Token。
2.  **App Barrier**: App 完成新尺寸的渲染后，带着同一个 Token 提交 Buffer。
3.  **SF 等待**: SF 收到 Window Bounds Transaction 时，会**等待**对应 Token 的 Buffer 到达。
4.  **原子应用**: 两者同时生效，无撕裂。

### 5.3 Trace 定位

在 Perfetto 中查找：
*   `WMS.resizeTask`: 标记 resize 开始。
*   `Transaction.apply`: 查看是否带有 `SyncId`。
*   `SurfaceFlinger.waitForSync`: 如果这个 Slice 很长，说明 App 响应慢。

### 5.4 优化建议

1.  **减少 Configuration Change 开销**: 避免在 `onConfigurationChanged` 中做重计算。
2.  **预渲染策略**: 如 Chrome 会预渲染几个常见尺寸的 Bitmap Cache。
3.  **Skeleton UI**: 在 resize 过程中显示骨架屏而非空白。

