# SmartPerfetto 待办事项

最后更新: 2025-12-28

---

## ✅ 已完成

### 核心架构
- [x] Perfetto UI AI 助手插件基础架构
- [x] 后端 API 服务框架
- [x] TraceProcessor WASM 集成
- [x] 前后端职责分离设计
- [x] SSE (Server-Sent Events) 实时通信
- [x] Singleton 模式确保服务实例唯一

### AI 分析功能
- [x] PerfettoSqlSkill - SQL 生成技能
- [x] PerfettoAnalysisOrchestrator - 多轮分析编排器
- [x] AnalysisSessionService - 会话管理与 SSE 推送
- [x] DeepSeek API 集成
- [x] AI 分析超时保护 (30s/60s/20s)
- [x] 懒加载服务初始化 (解决 dotenv.config 时序问题)
- [x] 中文进度提示消息

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

### 开发环境
- [x] Perfetto UI 构建修复
- [x] 开发服务器启动脚本
- [x] 后端热重载配置
- [x] 环境变量配置

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

#### 预定义分析命令
| 命令 | 描述 | 优先级 |
|------|------|--------|
| `/anr` | 快速检测 ANR 问题 | 高 |
| `/jank` | 快速检测掉帧 | 高 |
| `/memory` | 内存分配分析 | 中 |
| `/slow` | 慢函数检测 | 中 |

#### 分析结果展示
- [ ] SQL 查询结果表格展示
- [ ] 结果导出 (CSV/JSON)
- [ ] 查询结果与时间线关联

#### 会话管理
- [ ] 会话历史持久化
- [ ] 会话导出功能

### P1 - 用户体验

- [ ] 首次使用引导
- [ ] 快捷键支持
- [ ] 错误提示优化
- [ ] 加载状态优化

### P2 - 技术改进

#### 多 AI 模型支持
- [ ] OpenAI GPT-4 支持
- [ ] Claude API 支持
- [ ] 模型切换 UI

#### 分析能力增强
- [ ] 自定义分析模板
- [ ] 分析报告生成
- [ ] 批量分析任务

### P3 - 部署与运维

- [ ] Docker 部署方案
- [ ] 生产环境配置
- [ ] 监控告警
- [ ] CI/CD 流程

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

### 第三方依赖
- **DeepSeek API** - 需要稳定可靠的 API key
- **Perfetto UI** - 需要跟随上游更新

---

## 📚 相关文档

- [README.md](./README.md) - 项目文档
- [docs/plans/](./docs/plans/) - 设计文档
