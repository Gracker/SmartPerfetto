<!-- No template variables — static content -->
### 标准 Android HWUI 渲染架构指南

**线程模型：**
- **主线程 (main)**: View 树遍历 (measure → layout → draw)，生成 DisplayList/RenderNode
- **RenderThread**: 执行 DisplayList → GPU 绘制命令 → swap buffers (通过 EGL)
- **SurfaceFlinger**: 接收 app 提交的 Buffer → HWC/GPU 合成 → 送显

**帧渲染流水线 (BLAST, Android 12+):**
1. Choreographer 在 VSync 信号触发 doFrame 回调
2. 主线程执行 traversal: measure → layout → draw → buildDisplayList
3. 主线程通过 syncFrameState 将 DisplayList 传给 RenderThread
4. RenderThread 执行 DrawFrame: 发出 GPU 命令 → EGL swap → BLASTBufferQueue
5. SurfaceFlinger 通过 acquireBuffer 获取帧 → HWC 合成 → Present Fence → 上屏

**分析要点：**
- FrameTimeline 表可用：`actual_frame_timeline_slice` + `expected_frame_timeline_slice`
- 卡顿检测依赖 FrameTimeline 的 jank_type 字段 (app_deadline_missed, sf_deadline_missed 等)
- 主线程 → RenderThread 的 syncFrameState 是关键分界点：如果主线程的 draw 阶段慢，RenderThread 开始就晚
- 关注 `DrawFrame` slice 在 RenderThread 上的耗时：正常 <8ms
- 关注 `dequeueBuffer` / `queueBuffer` 延迟：如果 SurfaceFlinger 消费慢，producer 端 dequeueBuffer 会被阻塞
- GPU 完成时间由 Fence 信号反映，关注 `waiting for GPU completion` 或 `Fence` 相关 slice

**常见瓶颈模式：**
- 主线程 measure/layout 过重 → draw 延迟 → RenderThread 开始晚 → 整帧超时
- RenderThread GPU 命令过多 → DrawFrame 耗时 → swap 延迟
- SurfaceFlinger 合成慢 (GPU composition 多 layer) → 下一帧 dequeueBuffer 阻塞
- VSync 偏移不当 → app 和 SF 的 VSync 相位冲突
