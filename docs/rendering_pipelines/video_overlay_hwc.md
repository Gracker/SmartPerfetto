# Video Overlay Pipeline (MediaCodec direct to HWC)

这是 Android 乃至所有移动设备上**最省电、最高效**的视频播放方式。

## 1. 核心原理：Bypass GPU

在普通的渲染中，视频帧往往会被当作一个 Texture，用 GPU 画到屏幕上。
但在 Overlay 模式下，视频帧（Decode Output）直接通过 Hardware Composer (HWC) 作为一个独立的**硬件图层 (Hardware Plane/Layer)** 叠加在屏幕上。

### 路径对比

*   **GPU Path (TextureView)**:
    `Decoder` -> `SurfaceTexture` -> `GPU Shader (Sample)` -> `FrameBuffer` -> `Display`
    *   *缺点*: 占用 GPU 带宽，耗电。
*   **Overlay Path (SurfaceView + HWC)**:
    `Decoder` -> `Surface` -> `HWC Layer` -> `Display`
    *   *优点*: GPU 完全不参与，只消耗 Display Processor (DPU) 一点点带宽。

## 2. 也是 DRM (数字版权保护) 的唯一路径

对于 Netflix, Disney+ 等受保护的高清内容 (Widevine L1)，视频数据在解密后存储在 **Secure Memory** (TrustZone) 中。
*   GPU 根本无法读取 Secure Memory（防止录屏窃取）。
*   只有 HWC/DPU 能够读取并直接输出信号给屏幕面板。
*   因此，播放 DRM 视频**必须**使用 SurfaceView (Overlay) 模式。

## 3. 渲染流程详解

### 第一阶段：Configuration
1.  **MediaCodec**: 配置 Surface (来自 SurfaceView)。
2.  **Format**: 解码器输出通常是 YUV420 (NV12/P010)。HWC 原生支持 YUV 格式，**省去了 YUV 转 RGB 的开销**。

### 第二阶段：Streaming
1.  **Queue**: 解码器将 YUV Buffer 放入队列。
2.  **Transaction**: 驱动层封装 Transaction。
3.  **SurfaceFlinger Decision**:
    *   SF 检查 HWC 硬件能力：“你有空闲的硬件图层吗？”
    *   **Overlay Strategy**: 如果有，SF 将该 Buffer 直接标记为 `HWC_COMPOSITION`。
    *   **Fallback**: 如果硬件图层用完了（或者格式不支持），SF 会退化为 `GLES_COMPOSITION`，强行用 GPU 合成（此时无法播放 L1 DRM）。

## 3.5 Tunnel Mode (TV & Set-Top Box)

在 Android TV 或高端手机上，还存在一种极致的 **Tunnel Mode** (隧道模式)。

1.  **Sideband Stream**: 解码器输出的 Buffer 句柄直接传给 HWC/Display，**完全绕过 Framework** 的 BufferQueue 和 SurfaceFlinger 的常规合成逻辑。
2.  **Audio Sync**: HWC 直接根据 Audio DSP 的时钟来驱动视频帧的显示，实现硬件级的音画同步。
3.  **AOSP 16**: 进一步优化了 Tunnel Mode 下的帧率切换和 HDR 元数据传递。

## 4. 调试与验证

### dumpsys SurfaceFlinger
在 `adb shell dumpsys SurfaceFlinger` 输出中：
*   寻找你的 SurfaceView Layer。
*   查看 **Composition Type**:
    *   `DEVICE`: 成功使用 Overlay (HWC)。
    *   `CLIENT`: 失败，回退到 GPU (GLES)。

### Perfetto Trace
*   查看 **HWC** 相关的 Track。
*   GPU 负载应该非常低（接近 0%），仅 UI 线程有少量活动。

## 5. 常见坑点

*   **圆角/透明度**: 很多老旧的 HWC 不支持对 Overlay 图层做圆角裁剪或半透明混合。如果给 SurfaceView 设置了 `setAlpha(0.5)`，往往会导致强行回退到 GPU 合成，失去性能优势。
*   **Z-Order**: Overlay 图层通常需要位于最底层或特定的 Z 轴，复杂的 UI 遮挡可能破坏 Overlay 策略。
