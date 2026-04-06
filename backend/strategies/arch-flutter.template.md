<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

<!-- No template variables — static content -->
### Flutter 分析注意事项
- **线程模型**：Flutter 使用 `N.ui` (UI/Dart)  和 `N.raster` (GPU raster) 线程替代标准 Android MainThread/RenderThread
- **帧渲染**：观察 `N.raster` 线程上的 `Rasterizer::DrawToSurfaces` slice，它是每帧 GPU 耗时的关键指标
- **Engine 差异**：Skia 引擎看 `SkCanvas*` slice；Impeller 引擎看 `Impeller*` slice
- **SurfaceView vs TextureView**：SurfaceView 模式帧走 BufferQueue 独立 Layer；TextureView 模式帧嵌入 View 层级
- **Jank 判断**：需同时看 `N.ui` (Dart 逻辑耗时) 和 `N.raster` (GPU raster 耗时)，任一超帧预算都会导致掉帧