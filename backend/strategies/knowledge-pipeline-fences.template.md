<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

# Android 17 Fence 证据边界

报告必须明确 fence 的对象、
方向、粒度和 trace 来源，不能只写“fence 慢”。

| Fence | 典型方向/粒度 | 可以回答 | 不能单独证明 |
|---|---|---|---|
| acquire | Producer → Consumer，per buffer | buffer 何时可安全读取 | 该内容已被 SF 采纳或显示 |
| release | Consumer/HWC → Producer，per layer/buffer | buffer 何时可复用、dequeue 是否受背压 | 当前 display 已完成光学输出 |
| present | display stack feedback，per display/frame | Android 显示栈本轮 present 时间锚点 | panel 像素完全稳定、光学响应完成或用户已感知 |

## 必须区分的路径

- TextureView/Flutter texture 路径有中间 image fence 与宿主 App Window fence；
- SurfaceView、多窗口、PlatformView、Camera 多流会有多个 layer/buffer 生命周期；
- software producer 可以没有 GPU acquire fence，但仍可能受 release/backpressure；
- tunneled/protected video 的同步证据可能位于 codec/HAL/HWC，App trace 不完整；
- Android 13+ latch-unsignaled 只改变等待位置，不取消安全边界。

## HWC 与 present

Android 17 必须根据 trace/源码分支描述 `presentOrValidate`。`PresentSucceeded`
快路径已经执行 present，不能再假设后面必然重复 validate/present。没有对应
HWC/driver trace 时，只能描述系统侧候选等待，不能断言 panel 或硬件根因。

## 诊断流程

1. 用 buffer/layer/frame token 关联 producer 与 consumer；
2. 比较提交、fence signal、SF 采纳、composition/present 的实际时间；
3. 对 dequeue 等待回查 release/backpressure，对 SF 读取等待回查 acquire；
4. 将 present fence 作为显示栈锚点，同时显式保留 panel/用户感知的不确定性；
5. 缺少 fence tracepoint 时报告缺口并给出补采建议，不用 slice 名猜结果。
