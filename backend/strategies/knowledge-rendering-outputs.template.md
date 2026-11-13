<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

# 显示、媒体双出口、前缓冲与系统动画的证据边界

下述是产品的按需机制知识，
当前 Trace 的事实必须由实际 SQL、对象身份及采集覆盖建立。

## 先画资源和完成边界

内容 Producer、SurfaceView/TextureView 承载、独立 layer/宿主采样、Window/Display
是不同维度；Camera→Flutter texture→Flutter SurfaceView 可以同时成立。
按 `(upid, layer/queue, frame number/token, display)` 关联。slot、GraphicBuffer id、
BQ frame number、surface/display token 与业务帧号不能按数值相同连接。
时间接近、同进程或 slice 嵌套本身不证明跨 Producer 的同一帧交接。

| 观测 | 可说明 | 不能据此说明 |
|---|---|---|
| queueBuffer 返回 | Producer 交回内容引用 | 写入完成、SF 收到或已显示 |
| BLAST acquire | App 内 Consumer 获得 BufferItem | fence signal、同步 transaction 已 apply |
| SF BufferTX 上升/下降 | server 收到 / latch 或 drop pending update | ready 库存、新画面显示数 |
| latch | 选入合成输入；受限条件下可 unsignaled | GPU 已完成、HWC 已呈现 |
| release / FREE slot | 引用或持有权归还，仍受 fence 约束 | 曾被显示、内存可立即覆盖 |
| present feedback | 指定 Display 的显示栈时间锚点 | panel 光学完成、某笔输入已可见 |

缺 FrameTimeline 先检查配置、App tracing 可见性与独立 Producer 覆盖。
零条完整帧是观测缺口。SF actual 包含 Composer/DisplayHAL，不能全归 SF CPU。
App expected/actual 应保留 upid/layer，冲突 expected 不能按 token 强行 join 放大行数。

## Camera、视频与低 cadence

metadata/result/callback、HAL buffer completion fence 与最终显示分别记录。
SENSOR_TIMESTAMP、PTS 和系统 monotonic 时间先确认同域/映射；乘单位不建立时钟映射。
24/30 fps 内容在 60/120 Hz 沿用旧 buffer 可以正常；按内容目标时间、PTS、
实际 buffer 与模式判断，不能按每次硬件 VSync 无新 buffer 计卡顿。
SurfaceView 不证明 overlay；需该视频 layer 的逐帧 DEVICE/CLIENT 证据。
RenderEngine 活动也可能只画其他层。Tunneled sideband 可能没有逐帧 BQ/BufferTX。
ImageReader acquired 未 close 才占持有额度；acquireLatestImage 不会回收已持有 Image，
丢旧还需至少两个可用获取额度。增加队列容量不能修复持续消费过慢。

## Chromium 浏览器

Browser、Renderer 与 Viz/GPU 按进程/线程角色关联；Android 可使用
`:privileged_process0` 和截断的 `VizCompositorTh`，不能固定 `:gpu_process`。
Graphics.Pipeline 同名步骤需查 track/args；没有 Chromium 内部 category 时，
这些事件可能全不可见。Viz 或 SurfaceAggregator 名称不能单独证明独立输出、
CPU 耗时或物理 present。确认本次经 BQ/BLAST 还是直接 SurfaceControl。

## 媒体 GPU 加工与双出口

输入 I、效果纹理 T、预览 P、编码输入 E、压缩样本 O 各有身份、完成与回收。
共享 FBO 不是 BufferQueue，P/E 不能共享一个可任意 queue 的 slot。
T 两个 GPU 读者结束后可复用；P 等显示消费者释放，E 等 codec 消费。
preview swap 正常但 encoder swap 阻塞，仍可拖慢共享 GL 线程下一次预览。
长 swap 需拆 slot、GPU、调度与 drain，不能直接归“编码慢”。
预览终点关联目标 display present；录像终点关联 sample/PTS/muxer 写入及结束流程，
编码 Surface 不要求物理 FrameTimeline。各池 pending 不能相加成延迟帧数。

## 低延迟与 Front-buffer

固定库可直接管理 HardwareBuffer/SurfaceControl；不是每个笔点一轮 swap/BQ。
同 handle 持续局部更新、BufferTX 很少都可能正常。frame-rate hint 不证明面板频率。
缺新 fence 要核对 usage、可见状态和具体路径，不能直接判同步错误。
输入年龄、GL 排队、抬笔 commit 交接、光学延迟分开测量；宿主 FrameTimeline
和单个 present fence 不覆盖每个笔点。commit 后清除/复用仍须遵守旧读者 release。

## 虚拟显示与捕获

SF 是 App layer 的消费者，也可以是捕获输出的生产者；物理和虚拟输出资源分开。
虚拟 present fence 表示输出可读，物理 present 表示开始显示，互不替代。
drain 被文件/网络阻塞可沿 codec output→input→sink 形成回压。
录屏 sample 数、FPS 和完整性用编码输出验证，不从物理屏幕 FPS 推导。
源码分支的引用搬运或 fence 构造不能直接证明目标设备采用该实现或存在故障。

## Window 属性动画与系统转场

内容生产、leash/属性 runner、DisplayFrame 是三条进度。旧 buffer 经属性变换
可连续显示；App 无 doFrame/BufferTX 不证明静止。SF present 按时但 runner
重复位置后跳跃，仍可能视觉卡顿。追实际动画执行方和属性连续性。
FrameTimeline buffer 标识用 `EXTRACT_ARG(arg_set_id, 'Is Buffer?')`，
可能为 Yes/No/Unspecified/NULL；No 是非新 buffer 更新，不能算新 buffer 数。
WM transition finish、starting window 移除、finishT 生效与目标 present 各不相同。

跨平台职责对照不能作为跨平台设备性能排名。Android/OEM/框架版本、
feature flag、采集可见性分别记录；demo 的 Media.*、ink.*、Capture.* 为自加标记，
不能成为所有应用必带的正证据或缺失判定。
