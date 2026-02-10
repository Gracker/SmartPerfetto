# 2026-02-10 Domain Extensibility Refactor Tasks

> 目标：消除新增分析场景时的多点硬编码，建立 manifest/registry 驱动的可扩展架构。
> 参考方案：`docs/architecture-analysis/07-domain-extensibility-refactor.md`

## Task Checklist

- [x] E1 输出详细架构重构蓝图（阶段、数据模型、风险、DoD）
- [x] E2 Phase A：Domain Manifest 基础实现（策略执行偏好 + 证据映射）
- [x] E3 Phase A：Orchestrator 接入 Manifest，移除硬编码白名单和本地 evidence map
- [x] E4 Phase A：补充/更新单元测试（Orchestrator 行为回归）
- [x] E5 Phase B 设计落盘：sceneType -> skill 可配置路由细化方案
- [x] E6 执行第一轮架构 review（可扩展性/可维护性）
- [x] E7 执行代码 review（风险点与兼容性）
- [x] E8 执行测试（targeted + broader），记录结果

## Architecture Review (E6) - 2026-02-10

### 已解决的刚性点

1. `scene_reconstruction` Stage2 的 startup vs non-startup 二分硬编码已移除，改为 manifest 路由规则驱动。
2. 路由规则新增 `sceneTypeGroups: ['all']` wildcard 行为，避免新增未知 sceneType 时漏路由。
3. drill-down `entity -> skill` 映射抽取为共享 registry，resolver/executor 复用同一入口。

### 仍需后续阶段处理的点（Phase C/D/E）

1. `followUpHandler` 的实体参数映射仍是本地常量（`ENTITY_PARAM_KEYS`），尚未完全 registry 化。
2. `EntityStore` 对 startup 的候选/已分析泛化未完全打通（frame/session 仍是主通道）。
3. `drillDownResolver` 的 frame/session 多路 enrichment SQL 仍在本地实现，后续需与 registry/adapter 进一步统一。

## Code Review (E7) - 2026-02-10

1. 检查 manifest 路由过滤逻辑时发现 “all 仅覆盖已知场景” 风险，已修复为 wildcard（除 `excludeSceneTypes` 外全部匹配）。
2. 检查 drill-down 路径时发现 resolver/executor 映射分叉风险，已通过 `drillDownRegistry` 收敛并补齐 resolver 的 startup 支持。
3. 验证 fallback：manifest 路由为空时回退 legacy startup/non-startup 任务构造逻辑，避免配置异常导致完全失效。

## Test Result (E8) - 2026-02-10

### Targeted

1. `npm test -- src/agent/config/__tests__/domainManifest.test.ts src/agent/strategies/__tests__/sceneReconstructionStrategy.test.ts src/agent/core/__tests__/drillDownResolver.test.ts src/agent/core/executors/__tests__/directDrillDownExecutor.test.ts`
2. `npm test -- src/agent/core/__tests__/agentDrivenOrchestrator.test.ts`

结果：全部通过（含 scene route / startup drill-down / orchestrator 回归）。

### Broader

1. `npm test -- src/agent/config/__tests__ src/agent/core/__tests__ src/agent/strategies/__tests__`

结果：`21 suites / 319 tests` 全通过。  
备注：存在既有 `console.warn` 与 Jest open handles 提示，不影响通过结论。

## Progress Log

- 2026-02-10: 初始化任务文档，完成 E1（输出重构蓝图并拆分 Phase A-E）。
- 2026-02-10: 开始执行 E2（落地 Domain Manifest 基础实现）。
- 2026-02-10: 完成 E2（新增 `backend/src/agent/config/domainManifest.ts`，集中管理策略执行偏好与证据映射）。
- 2026-02-10: 完成 E3（`AgentDrivenOrchestrator` 接入 manifest helper，替换策略白名单判断与本地 `aspectEvidenceMap` 常量）。
- 2026-02-10: 完成 E4（新增 `domainManifest` 单测并回归 `agentDrivenOrchestrator` 单测，2 suites / 53 tests 通过）。
- 2026-02-10: 完成 E5（`07-domain-extensibility-refactor.md` 已落盘 scene 路由可配置化目标架构、数据模型与阶段计划）。
- 2026-02-10: 完成 Phase B 修复（`scene_reconstruction` Stage2 改为 `DomainManifest.sceneReconstructionRoutes` 驱动）。
- 2026-02-10: 完成全量路由兼容修复（`all` route group 改为 wildcard，避免未知 sceneType 漏路由）。
- 2026-02-10: 完成 drill-down registry 收敛（新增 `drillDownRegistry`，executor/resolver 共享映射，resolver 补齐 startup enrichment）。
- 2026-02-10: 完成 E6/E7/E8（架构 review、代码 review 与 targeted+broader 测试记录）。
