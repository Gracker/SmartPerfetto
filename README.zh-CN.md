# SmartPerfetto

[English](README.md) | [中文](README.zh-CN.md)

[![License: AGPL-3.0-or-later](https://img.shields.io/github/license/Gracker/SmartPerfetto)](LICENSE)
[![Backend Regression Gate](https://github.com/Gracker/SmartPerfetto/actions/workflows/backend-agent-regression-gate.yml/badge.svg)](https://github.com/Gracker/SmartPerfetto/actions/workflows/backend-agent-regression-gate.yml)
[![Node.js 24 LTS](https://img.shields.io/badge/Node.js-24%20LTS-brightgreen)](package.json)
[![TypeScript strict](https://img.shields.io/badge/TypeScript-strict-3178c6)](backend/tsconfig.json)
[![Docker Compose](https://img.shields.io/badge/Docker-Compose-2496ed)](docker-compose.yml)
[![Perfetto UI fork](https://img.shields.io/badge/Perfetto-UI%20fork-4285f4)](https://perfetto.dev/)
[![赞助](https://img.shields.io/badge/赞助-微信%20553000664-f66f6f)](docs/sponsor.md)

> 基于 [Perfetto](https://perfetto.dev/) 的 AI Android 性能分析平台。

SmartPerfetto 在 Perfetto Trace 之上增加 AI 分析层。加载 Trace、用自然语言提问，
即可获得包含 SQL 结果、Skill 输出、根因推理和优化建议的证据化结论。

项目已开源并持续开发。Web UI、CLI、后端 Runtime 和 Skill 系统目前均可使用，
但公开 API 与内部契约仍可能演进。

<!-- android-performance-ecosystem:start -->
## Android 性能分析生态

[Android Performance Ecosystem](https://github.com/Gracker/android-performance-ecosystem) 通过导航 Hub 与七个核心项目，把可选插桩、采集、分析、系统知识与可复现案例连接成一套完整路径。

| 阶段 | 项目 | 作用 | 地址 |
| --- | --- | --- | --- |
| 导航 | [Android Performance Ecosystem](https://github.com/Gracker/android-performance-ecosystem) | 维护统一项目地图、交接元数据、README 导航区块与漂移检查。 | [GitHub](https://github.com/Gracker/android-performance-ecosystem) |
| 插桩 | [TraceFix](https://github.com/Gracker/TraceFix) | 在编译期注入 App 侧 android.os.Trace section，让方法执行在运行时 Trace 中可见。 | [GitHub](https://github.com/Gracker/TraceFix) |
| 采集与测量 | [Perfetto Tools](https://github.com/Gracker/perfetto-tools) | 抓取可复现的 Perfetto Trace，并采集 FPS 或 Simpleperf 测量结果。 | [GitHub](https://github.com/Gracker/perfetto-tools) |
| 分析 | [SmartPerfetto](https://github.com/Gracker/SmartPerfetto) | 通过 AI 辅助 Web UI、CLI、报告、会话、对比和证据工作流分析 Trace。 | [GitHub](https://github.com/Gracker/SmartPerfetto) |
| Agent 分析 | [Perfetto Skills](https://github.com/Gracker/Perfetto-Skills) | 为 Agent 提供可移植的 Android、Linux、Chromium Perfetto 分析 Skill，并通过固定版本流程同步选定资产。 | [GitHub](https://github.com/Gracker/Perfetto-Skills) |
| 学习 | [Android Performance Blog](https://github.com/Gracker/Gracker.github.io) | 通过文章、系统原理和案例复盘讲解 Perfetto 与 Systrace 分析。 | [AndroidPerformance.com](https://www.androidperformance.com/) · [GitHub](https://github.com/Gracker/Gracker.github.io) |
| 系统知识 | Android Internal Wiki | 处于 alpha 阶段的 Android 系统知识库，覆盖 App、Framework、Native 与 Kernel 机制。 | **Coming soon** |
| 复现 | [Trace for Blog (SystraceForBlog)](https://github.com/Gracker/SystraceForBlog) | 提供文章使用的 Perfetto、Systrace 及相关案例文件，支持动手复现。 | [GitHub](https://github.com/Gracker/SystraceForBlog) |
<!-- android-performance-ecosystem:end -->

## 项目能力

- 分析 Android Perfetto Trace 中的滑动卡顿、启动、ANR、交互延迟、内存、游戏和
  渲染流程问题。
- 保留 Perfetto 时间线和 SQL 工作流，并通过 AI Assistant 提供证据化结论、连续追问、
  对比和报告。
- 使用确定性的 YAML Skill 与 Markdown 策略，将事实证据、模型解释和报告来源分开。
- 支持浏览器 UI、`smp` CLI 和 HTTP/SSE 接入；完整范围见
  [功能总览](docs/getting-started/features.md)。

## 快速开始

### 1. 选择运行方式

- **Windows 桌面**：从
  [最新 Release](https://github.com/Gracker/SmartPerfetto/releases/latest)
  下载 `windows-x64` 压缩包，完整解压后运行 `SmartPerfetto.exe`。完整步骤见
  [Windows 指南](docs/getting-started/windows.md)。
- **macOS 或 Linux 桌面**：下载匹配平台的免安装包；包内已包含 Node.js、后端、
  预构建 UI 和 Trace Processor。
- **Docker**：克隆仓库后运行：

  ```bash
  docker compose -f docker-compose.hub.yml up -d
  ```

- **源码运行**：需要 Node.js 24 LTS。克隆仓库后运行：

  ```bash
  ./start.sh
  ```

- **终端或自动化**：使用 Node.js 24 安装独立 CLI：

  ```bash
  npm install -g @gracker/smartperfetto
  smp doctor
  ```

完整前置条件与运行方式见 [快速开始](docs/getting-started/quick-start.md)。

### 2. 配置一个 AI Provider

Web UI 启动后，打开 **AI Assistant 设置 → Providers**，添加一个 Provider，依次保存、
测试并激活。本地源码运行也可以直接复用同一终端中已有的 Claude Code 登录态。
第一次启动不需要配置所有 Runtime；只选一条 Provider 路径，按
[配置指南](docs/getting-started/configuration.md)操作即可。

### 3. 完成第一次分析

1. 打开启动器打印的 `Open:` 地址；Docker 或源码默认地址为
   [http://localhost:10000](http://localhost:10000)。
2. 加载 `.pftrace` 或 `.perfetto-trace` 文件。
3. 打开 AI Assistant 面板。
4. 输入 `分析滑动卡顿`、`为什么启动慢？` 或 `分析这个 Trace 中的 ANR` 等问题。

CLI 用法：

```bash
smp run trace.pftrace "分析滑动卡顿"
```

## 文档

- 入门：[文档中心](docs/README.md)、[快速开始](docs/getting-started/quick-start.md)和
  [基本使用](docs/getting-started/usage.md)
- 产品配置：[Windows 指南](docs/getting-started/windows.md)、
  [配置指南](docs/getting-started/configuration.md)、
  [应用更新](docs/getting-started/application-updates.md)和
  [故障排查](docs/operations/troubleshooting.md)
- 集成：[CLI](docs/reference/cli.md)、[HTTP/SSE API](docs/reference/api.md)和
  [MCP 工具](docs/reference/mcp-tools.md)
- 内部原理：[架构总览](docs/architecture/overview.md)、
  [技术架构](docs/architecture/technical-architecture.md)和
  [Skill 系统](docs/reference/skill-system.md)

## 贡献与支持

提交 Pull Request 前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。Bug 和功能建议请使用
[GitHub Issues](https://github.com/Gracker/SmartPerfetto/issues)；安全问题请通过
[私有安全公告](https://github.com/Gracker/SmartPerfetto/security/advisories/new)
或 `smartperfetto@gracker.dev` 报告。赞助与商业支持见
[docs/sponsor.md](docs/sponsor.md)。

## 许可证

SmartPerfetto 核心代码使用 [AGPL-3.0-or-later](LICENSE)；`perfetto/` submodule 继续使用
[Apache-2.0](https://github.com/google/perfetto/blob/main/LICENSE)。如需不受 AGPL 约束的
商业授权，请通过微信 `553000664` 联系维护者。
