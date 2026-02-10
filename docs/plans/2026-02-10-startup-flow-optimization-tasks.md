# 2026-02-10 Startup Flow Optimization Tasks

> 目标：对齐 scrolling 的 staged strategy 能力，完成 startup（冷/温/热）分析链路优化。
> 要求：每个步骤完成后更新本任务清单；全部完成后执行架构 review、代码 review 与测试。

## Task Checklist

- [x] T1 设计并确认实现清单（策略、路由、drill-down、测试、review、测试回归）
- [x] T2 新增 `startupStrategy`（Stage0/Stage1/Stage2）并接入注册表
- [x] T3 改造 `scene_reconstruction` Stage2：按场景类型分流 startup/scroll 分析
- [x] T4 增强 `DirectDrillDownExecutor`：支持 `startup` 实体直达 `startup_detail`
- [x] T5 补充/更新单元测试与策略测试
- [x] T6 完成整体架构 review（实现与文档一致性）
- [x] T7 完成代码 review（风险点、回归点、可维护性）
- [x] T8 执行测试（targeted + broader），修复问题并记录结果

## Progress Log

- 2026-02-10: 初始化任务文档并完成 T1，实现任务拆解与执行顺序确认。
- 2026-02-10: 开始执行 T2（新增 startup staged strategy 并接入注册表）。
- 2026-02-10: 完成 T2（新增 `startupStrategy`、注册表接入、`startup_analysis` 轻量模式参数扩展）。
- 2026-02-10: 开始执行 T3（scene reconstruction 二阶段按 startup/scroll 分流）。
- 2026-02-10: 完成 T3（新增 per-interval filter 能力，scene stage2 分流到 `startup_detail` / `scrolling_analysis`）。
- 2026-02-10: 完成 T4（intent/follow-up/drill-down 支持 `startup_id`，`DirectDrillDownExecutor` 新增 startup 映射与 enrichment）。
- 2026-02-10: 开始执行 T5（补充并修复相关单元测试与策略测试）。
- 2026-02-10: 完成 T5（新增 `startupStrategy` 测试、startup drill-down 测试与 startup intent 解析测试；相关 targeted tests 全部通过）。
- 2026-02-10: 开始执行 T6（整体架构与文档一致性 review）。
- 2026-02-10: 完成 T6（修正 `docs/ARCHITECTURE.md`、`docs/architecture-analysis/README.md`、`docs/architecture-analysis/04-strategy-system.md` 与 `docs/architecture-analysis/06-scrolling-startup-optimization.md`，架构图与实现一致）。
- 2026-02-10: 完成 T7（代码 review 发现并修复 `followUpHandler` 中 startup minimal interval 的 `sourceEntityType` 错误标注，补充 `followUpHandler` 单测覆盖 startup drill-down 参数分支）。
- 2026-02-10: 完成 T8（执行 targeted+broader 测试：targeted 6 suites/97 tests 通过；broader 19 suites/308 tests 通过）。
