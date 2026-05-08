# SmartPerfetto 文档中心

[English](README.en.md) | [中文](README.md)

SmartPerfetto 是基于 Perfetto 的 Android 性能分析平台。本文档中心面向开源使用者、贡献者和维护者，按“先跑起来、再理解、再扩展”的顺序组织。

## 推荐阅读路径

| 读者 | 从这里开始 | 继续阅读 |
|---|---|---|
| 第一次运行项目 | [快速开始](getting-started/quick-start.md) | [配置指南](getting-started/configuration.md), [基本使用](getting-started/usage.md) |
| 想接入后端 API | [API 参考](reference/api.md) | [MCP 工具参考](reference/mcp-tools.md) |
| 想用命令行或脚本分析 trace | [CLI 参考](reference/cli.md) | [API 参考](reference/api.md) |
| 想贡献代码 | [本地开发](development/local-development.md) | [测试与验证](development/testing.md), [贡献指南](../CONTRIBUTING.md) |
| 想新增 Skill | [Skill 系统指南](reference/skill-system.md) | [MCP 工具参考](reference/mcp-tools.md), [测试与验证](development/testing.md) |
| 想理解架构 | [架构总览](architecture/overview.md) | [agentv3 运行时](architecture/agent-runtime.md), [技术架构深潜](architecture/technical-architecture.md) |
| 想排查部署问题 | [故障排查](operations/troubleshooting.md) | [配置指南](getting-started/configuration.md) |

## 文档结构

```text
docs/
├── README.md                         # 文档入口
├── getting-started/                  # 安装、配置、使用
├── architecture/                     # 当前架构与权威设计
├── features/                         # 独立 feature 开发文档
├── reference/                        # API、CLI、MCP、Skill DSL
├── development/                      # 开发、测试、文档维护
├── operations/                       # 运行与故障排查
├── rendering_pipelines/              # Android 渲染管线知识库，运行时会读取
├── product/                          # 项目定位与外部介绍
├── archive/                          # 历史方案、spike、决策记录
└── images/                           # 文档图片资源
```

## 权威文档

- 当前系统入口与运行方式以 [快速开始](getting-started/quick-start.md) 和 [本地开发](development/local-development.md) 为准。
- 当前后端 API 以 [API 参考](reference/api.md) 为准。
- agentv3 与分析模式以 [agentv3 运行时](architecture/agent-runtime.md) 为准。
- Skill DSL 与分层结果以 [Skill 系统指南](reference/skill-system.md) 为准。
- DataEnvelope 与前后端数据 contract 以 [Data Contract](../backend/docs/DATA_CONTRACT_DESIGN.md) 为准。
- 自改进系统以 [Self-Improving 设计](architecture/self-improving-design.md) 为准。
- `archive/` 下文档只保留历史背景，不代表当前推荐实现。

## 运行时依赖的文档

`docs/rendering_pipelines/` 不只是普通说明文档。渲染管线检测、教学模式和部分 Skill 结果会通过 `doc_path: rendering_pipelines/*.md` 引用这些 Markdown。移动或重命名这里的文件时，需要同步更新：

- `backend/skills/pipelines/*.skill.yaml`
- `backend/skills/atomic/rendering_pipeline_detection.skill.yaml`
- `backend/src/services/pipelineDocService.ts`
- `backend/src/config/teaching.config.ts`

改动后至少运行：

```bash
cd backend
npm run validate:skills
npm run test:scene-trace-regression
```
