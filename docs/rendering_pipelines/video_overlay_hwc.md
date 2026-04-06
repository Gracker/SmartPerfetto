# Video Overlay Pipeline (MediaCodec direct to HWC)

这是 Android 上最高效的视频播放方式之一。在设备、内容格式、DRM 与 HWC 条件都满足时，它通常能实现更低功耗和更少 GPU 参与。

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

## 2. DRM (数字版权保护) 与安全播放

对于 Netflix, Disney+ 等受保护的高清内容 (Widevine L1)，视频数据会经过 TrustZone / secure path 解密，解密后的帧可能落在 **Secure Buffer** 中（通过 secure heap 分配，仅受保护硬件路径可访问）。
*   GPU 和 CPU 均无法读取 Secure Buffer（防止录屏窃取和内存 dump）。
*   HWC/DPU 的硬件通路通常是最稳妥的安全显示路径。
*   但“播放 DRM 视频必须使用 SurfaceView”过于绝对。Android 7.0 起系统已支持 secure texture video playback；是否要求 overlay、是否允许 GPU 后处理、是否能继续播放，仍取决于内容级别、provider 策略、设备能力和厂商实现。

## 3. 渲染流程详解

### 第一阶段：Configuration
1.  **MediaCodec**: 配置 Surface (来自 SurfaceView)。
2.  **Format**: 解码器输出通常是 YUV420 (NV12/P010)。HWC 原生支持 YUV 格式，**省去了 YUV 转 RGB 的开销**。

### 第二阶段：Streaming
1.  **Queue**: 解码器将 YUV Buffer 放入队列。
2.  **Transaction**: 驱动层封装 Transaction。
3.  **SurfaceFlinger Decision**:
    *   SF 检查 HWC 硬件能力：“你有空闲的硬件图层吗？”
    *   **Overlay Strategy**: 如果有，SF 将该 Layer 的 Composition Type 设为 `HWC2::Composition::DEVICE`（HWC 硬件合成）。
    *   **Fallback**: 如果硬件图层用完了（或者格式不支持），SF 可能退化为 `HWC2::Composition::CLIENT`（GPU/GLES 合成）。这通常意味着功耗和延迟变差；对受保护内容来说，是否还能继续播放要看设备是否支持 secure texture path，而不是一概等于“必然无法播放”。

## 3.5 Tunnel Mode (TV & Set-Top Box)

在 Android TV 或高端手机上，还存在一种极致的 **Tunnel Mode** (隧道模式)。

1.  **Sideband Stream**: 解码器输出的 Buffer 句柄直接传给 HWC/Display，**绕过 BufferQueue 的数据路径**（SurfaceFlinger 仍参与 Layer 管理和合成决策，但不经手 Buffer 数据本身）。
2.  **Audio Sync**: HWC 直接根据 Audio DSP 的时钟来驱动视频帧的显示，实现硬件级的音画同步。
3.  **AOSP 16**: 进一步优化了 Tunnel Mode 下的帧率切换和 HDR 元数据传递。

## 4. 调试与验证

### dumpsys SurfaceFlinger
在 `adb shell dumpsys SurfaceFlinger` 输出中：
*   寻找你的 SurfaceView Layer。
*   查看 **Composition Type**（HWC2 命名空间 `HWC2::Composition`）:
    *   `DEVICE`: 成功使用 HWC 硬件 Overlay 合成。
    *   `CLIENT`: 回退到 GPU (GLES) 合成——性能和功耗劣化。

### Perfetto Trace
*   查看 **HWC** 相关的 Track。
*   GPU 负载通常会比 TextureView / App-side composition 低很多，但未必接近 0%，因为宿主 UI、字幕、特效和其他 layer 仍可能使用 GPU。

## 5. 常见坑点

*   **圆角/透明度**: 很多老旧的 HWC 不支持对 Overlay 图层做圆角裁剪或半透明混合。如果给 SurfaceView 设置了 `setAlpha(0.5)`，往往会导致强行回退到 GPU 合成，失去性能优势。
*   **Z-Order**: Overlay 图层通常需要位于最底层或特定的 Z 轴，复杂的 UI 遮挡可能破坏 Overlay 策略。
