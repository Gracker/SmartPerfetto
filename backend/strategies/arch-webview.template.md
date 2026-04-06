<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

<!-- No template variables — static content -->
### WebView 分析注意事项
- **渲染线程**：GL Functor 模式下 WebView 的 DrawGL 在 App RenderThread 中执行（是帧耗时的重要组成部分）；SurfaceControl 模式下有独立的 Viz Compositor 线程，不经过 RenderThread
- **Surface 类型**：GLFunctor (传统) vs SurfaceControl (现代)，后者性能更好
- **JS 执行**：观察 V8 相关 slice（`v8.run`, `v8.compile`）来定位 JS 瓶颈
- **帧渲染**：WebView 帧不走 Choreographer 路径，需通过 SurfaceFlinger 消费端判断掉帧