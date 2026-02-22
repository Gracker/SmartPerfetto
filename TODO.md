# SmartPerfetto 待办事项

最后更新: 2026-02-22

---

## ✅ 已完成

### AI Agent 架构专项修复（2026-02-22）
- [x] `/chat` AI 代理路由接入统一鉴权与用量检查（移除显式跳过鉴权）
- [x] `execute_sql` 工具接入 SQL 安全校验（SELECT 限制、表白名单、LIMIT 强制、行数裁剪）
- [x] LLM 适配层补齐超时/重试/退避策略，避免外部模型抖动导致流程卡死
- [x] 打通任务超时链路（`AgentTask.timeout` → `AgentMessageBus` 强制执行）
- [x] 修复 `blockedStrategyIds` 契约（路由参数透传 + runtime 匹配后强制过滤）
- [x] 领域 Agent 技能映射集中到统一 catalog，工具描述从 skill registry 派生并对缺失技能 fail-fast
- [x] 补齐关键配置模板与文档一致性（新增 `backend/.env.example`）
- [x] 补充并发/超时与任务图执行的直接测试覆盖（MessageBus / TaskGraph / Runtime parity）

### 核心架构
- [x] Perfetto UI AI 助手插件基础架构
- [x] 后端 API 服务框架
- [x] TraceProcessor WASM 集成
- [x] 前后端职责分离设计
- [x] SSE (Server-Sent Events) 实时通信
- [x] Singleton 模式确保服务实例唯一
- [x] HTTP RPC 共享架构 (前后端共享 trace_processor 实例)
- [x] Session 与资源管理 (PortPool, 进程生命周期)
- [x] 优雅关闭与资源清理 (SIGTERM/SIGINT)

### AI 分析功能
- [x] PerfettoSqlSkill - SQL 生成技能
- [x] PerfettoAnalysisOrchestrator - 多轮分析编排器
- [x] AnalysisSessionService - 会话管理与 SSE 推送
- [x] DeepSeek API 集成
- [x] AI 分析超时保护 (30s/60s/20s)
- [x] 懒加载服务初始化 (解决 dotenv.config 时序问题)
- [x] 中文进度提示消息
- [x] 动态 AI 模型切换（根据问题复杂度自动选择 deepseek-chat 或 deepseek-reasoner）
- [x] 空结果智能诊断（自动分析 trace 内容帮助 AI 调整查询策略）

### Skill Engine V2 (YAML 驱动)
- [x] 86 个分析 Skills (32 atomic + 27 composite + 25 pipeline + 2 deep)
- [x] 8 种步骤类型 (atomic, skill, iterator, parallel, diagnostic, ai_decision, ai_summary, conditional)
- [x] 滑动分析 Skill (Expert Edition v3.1) - 分层递进式分析
- [x] 启动分析、ANR、内存、CPU、GPU、GC、LMK、Binder 等分析 Skills
- [x] 厂商定制支持 (oppo, vivo, xiaomi, honor, mtk, qualcomm)
- [x] CLI 工具 (`npm run skill:list/validate/test`)
- [x] 管理 API (`/api/admin/skills`)
- [x] 自动意图检测和厂商识别

### Agent 架构 (v3.0)
- [x] 三层架构：Tool Layer → Expert Agent Layer → Orchestrator Agent
- [x] LLM 驱动的 Think-Act 循环
- [x] 支持多专家协作分析
- [x] 完整的 Trace 记录和 Eval 系统
- [x] 前端 Skill/Agent 模式切换
- [x] Agent API 端点 (`/api/agent/analyze`, `/api/agent/:id/stream`)
- [x] Agent 分析 HTML 报告生成

### 场景还原功能 (v3.2)
- [x] 一键还原场景按钮 (AI 面板)
- [x] scene_reconstruction.skill.yaml (Composite Skill)
- [x] SceneTimeline 可视化组件 (时间线 + 事件列表)
- [x] 多数据源聚合 (屏幕状态、手势、App 切换、启动、系统事件、掉帧)
- [x] AI 场景摘要生成
- [x] 事件点击跳转到 Timeline

### 文件上传
- [x] Trace 文件上传 API
- [x] Trace ID 一致性处理 (initializeUploadWithId)
- [x] 文件大小限制配置

### 前端功能
- [x] AI 面板 UI 组件
- [x] 命令解析器 (`/help`, `/sql`, `/settings`, `/goto`, `/clear`)
- [x] SSE 事件监听与解析
- [x] 进度消息显示与替换
- [x] Markdown 渲染
- [x] 会话历史管理
- [x] 上传 Trace 到后端功能
- [x] SQL 结果表格优化（时间戳跳转、bigint 支持、显示限制 50 行）
- [x] 结果导出 (CSV/JSON)
- [x] 分层结果展示 (L1/L2/L4)

### 预定义分析命令
- [x] `/anr` - 快速检测 ANR 问题
- [x] `/jank` - 快速检测掉帧
- [x] `/memory` - 内存分配分析
- [x] `/slow` - 慢函数检测
- [x] `/analyze` - 分析当前选中区域
- [x] `/export [csv|json]` - 导出查询结果

### 开发环境
- [x] Perfetto UI 构建修复
- [x] 开发服务器启动脚本 (`./scripts/start-dev.sh`)
- [x] 后端热重载配置
- [x] 环境变量配置
- [x] 便捷脚本 (`push-all.sh`, `sync-perfetto-upstream.sh`)

### 项目清理
- [x] 删除过时的测试文件和脚本
- [x] 删除重复的 perfetto 目录
- [x] 合并文档 (README.md + QUICK_START.md)
- [x] 清理父目录过时文件

---

## 🚧 进行中

### Skill 相关 SOP 完善
- [ ] 完善 PerfettoSqlSkill 的标准操作流程
- [ ] 添加更多预定义分析模式
- [ ] 优化 Prompt 工程模板

---

## 📋 待实现

### P0 - 核心功能增强

#### 分析结果的可视化增强
- [ ] 帧时序图表 (Frame Timeline Chart)
- [ ] CPU/内存使用趋势图
- [ ] 卡顿热力图

#### Analysis in Trace
- [ ] 把分析结果重新展示在 Trace 里面
- [ ] 在合适的地方加上分析的结果注释
- [ ] 重新打包 Trace 供分享

### P1 - 用户体验

- [ ] 首次使用引导
- [ ] 快捷键支持
- [ ] 错误提示优化
- [ ] 加载状态优化
- [ ] 会话历史持久化 (跨浏览器/设备)
- [ ] 分析报告导出（PDF/HTML）
- [ ] 自定义 AI 模型配置界面
- [ ] Skill Web 管理界面（前端）

### P2 - 技术改进

#### 多 AI 模型支持
- [ ] OpenAI GPT-4 支持
- [ ] Claude API 支持
- [ ] 模型切换 UI

#### 分析能力增强
- [ ] 自定义分析模板
- [ ] 批量分析任务
- [ ] 对比分析（两个 Trace 的场景差异）
- [ ] 异常检测（自动标注异常操作）

### P3 - 部署与运维

- [ ] Docker 部署方案
- [ ] 生产环境配置
- [ ] 监控告警
- [ ] CI/CD 流程
- [ ] 多用户支持（用户认证 + Session 隔离）

---

## 🐛 已知问题

| 问题 | 影响 | 优先级 |
|------|------|--------|
| 无 | - | - |

---

## 📝 备注

### 技术债务
- 需要重构 PerfettoAnalysisOrchestrator 的错误处理
- 需要完善单元测试覆盖率
- 需要添加集成测试
- 考虑进程池优化（进程复用 + LRU 淘汰）
- 考虑健康检查（心跳检测 + 自动重启）

### 第三方依赖
- **DeepSeek API** - 需要稳定可靠的 API key
- **Perfetto UI** - 需要跟随上游更新（建议每月同步一次）

---

## 📚 相关文档

- [README.md](./README.md) - 项目文档
- [CLAUDE.md](./CLAUDE.md) - AI Agent 开发指南
- [docs/plans/](./docs/plans/) - 设计文档
- [backend/skills/README.md](./backend/skills/README.md) - Skill 开发指南
