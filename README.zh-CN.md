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
| 系统知识 | [Android Internals 知识](docs/getting-started/android-internals-knowledge.md) | 把公开的 Android Internals Wiki（或你自己的团队文档）注册为文档知识库，分析时按需检索并附出处引用。 | [使用指南](docs/getting-started/android-internals-knowledge.md) |
| 复现 | [Trace for Blog (SystraceForBlog)](https://github.com/Gracker/SystraceForBlog) | 提供文章使用的 Perfetto、Systrace 及相关案例文件，支持动手复现。 | [GitHub](https://github.com/Gracker/SystraceForBlog) |
<!-- android-performance-ecosystem:end -->

## 项目能力

- 分析 Android Perfetto Trace 中的滑动卡顿、启动、ANR、交互延迟、内存、游戏和
  渲染流程问题。
- 沿滑动和窗口动画期间的主线程连续时间线，追查 doFrame 之间的任务、执行/等待
  和来源线索；FrameTimeline 用于核对出帧结果，缺少帧数据仍可分析主线程工作。
- 保留 Perfetto 时间线和 SQL 工作流，并通过 AI Assistant 提供证据化结论、连续追问、
  对比和报告。达到分析轮次上限后，会基于已有证据交付结论并列出不足；同一会话
  的追问可继承已授权的历史，重新打开或后端重启后也可恢复。
- 使用确定性的 YAML Skill 与 Markdown 策略，将事实证据、模型解释和报告来源分开。
- 按问题关联关键任务、CPU 频率、系统负载、线程状态、核运行分布和调度证据。
  整场景调查在 Trace 和进程条件满足时先运行策略声明的入口 Skill，缺少的证据明确说明。
- 按每次请求显式选择已注册的本机源码，无需索引也能有界按需检索，并在
  Web、报告、CLI、snapshot 和 API 的安全来源中区分 trace 发生证据与
  `CodeRef` 机制证据。通过“选择文件夹 → 添加并用于分析”即可开始，排除路径和
  可选索引设置见[源码分析指南](docs/getting-started/code-aware-analysis.md)。相关片段会发送给
  当前配置的 AI 服务，源码检索会增加分析耗时。结果和源码引用可随本地历史、报告保存；
  AI 服务的内容留存取决于该服务的配置与政策。
- 可按轮选用已注册的文档知识库（如 Android Internals Wiki 或团队文档），按需检索并带出处引用；
  知识库只作背景，不替代当前 trace 的证据。见
  [Android Internals 知识](docs/getting-started/android-internals-knowledge.md)。
- 先交付、后核验：Claude 与 OpenAI runtime 边生成边显示回答草稿；回答完成后可立即阅读，
  满足审核条件和预算时再做一次无工具复核。停止核验会保留回答；完整停止和强制停止有各自语义。
- 在选中的 `thread_state` 上打开 Critical path 等待链抽屉，或在火焰图页查看 CPU 调用栈热点，
  均带规则兜底的 AI 总结。见 [Critical path 与火焰图](docs/getting-started/critical-path-and-flamegraph.md)。
- 用 `smp capture` 从连接的 Android 设备按预置或自定义配置抓 trace，可选抓完直接分析。
- UI 选区只传身份与时间边界；名称等描述性事实由后端重新查询，`/anr` 与 `/jank`
  也进入同一套证据和验证管线。
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

如果 npm 提示依赖安装脚本被 blocked 或 skipped，先审查对应脚本，再仅为所需依赖
授权并重装：

```bash
npm install -g @gracker/smartperfetto --allow-scripts=better-sqlite3,opencode-ai
```

`better-sqlite3` 提供 CLI 核心命令使用的原生 SQLite 绑定；选择 OpenCode 运行时时
需要运行 `opencode-ai` 的安装脚本。发布包里的脚本审批不会替使用者授权。项目内
安装的审批方式，以及 doctor 和真实 query 检查，见
[CLI 安装说明](docs/reference/cli.md#npm-阻止安装脚本时)和
[npm 官方安装策略](https://docs.npmjs.com/cli/install/)。

完整前置条件与运行方式见 [快速开始](docs/getting-started/quick-start.md)。

### 2. 配置一个 AI Provider

Web UI 启动后，打开 **AI Assistant 设置 → Providers**，添加一个 Provider，依次保存、
测试并激活。本地源码运行也可在 `backend/.env` 配置凭据；Claude Code 登录态不能作为 SDK 已配置的依据。
第一次启动不需要配置所有 Runtime；只选一条 Provider 路径，按
[配置指南](docs/getting-started/configuration.md)操作即可。Qoder 高级用户也可以按文档
配置 BYOK 模型路由；Qoder PAT 或 `qodercli` 认证仍是独立且必需的。已保存 Provider
会通过受控缓存刷新供应商支持的模型建议；目录不支持或不可用时继续使用内置预置。

Pi 用户可在 model JSON 中配置推理设置；provider 默认、显式关闭和强度映射见 [Pi 配置说明](docs/getting-started/configuration.md#llm-配置)。

### 3. 完成第一次分析

1. 打开启动器打印的 `Open:` 地址；Docker 或源码默认地址为
   [http://localhost:10000](http://localhost:10000)。
2. 加载 `.pftrace` 或 `.perfetto-trace` 文件。
3. 打开 AI Assistant 面板。
4. 输入 `分析滑动卡顿`、`为什么启动慢？` 或 `分析这个 Trace 中的 ANR` 等问题。

每一轮先展示本轮分析过程和步骤，最后展示本轮结论；下一轮问题接在该结论之后。
服务器核验详情默认折叠，点击可查看完整记录；核验警告仍直接显示。
Web、CLI 和导出报告保留每条断言的证据与核验状态；某条声明格式错误时，其他有效声明仍可核验。
证据不足与断言被证据反驳分别显示。
最终结论保留问题范围内所有重要发现、支持证据与限制，即使中间表格折叠也能独立阅读；不会只为缩短篇幅而删减发现或引用声明。
结论中的多项指标、阶段耗时和 Trace 差异优先用紧凑表格呈现，配合机制解释与证据引用；单个数值或不适合表格的问题仍可直接用文字回答。

CLI 用法：

```bash
smp run trace.pftrace "分析滑动卡顿"
```

CLI 未完成时会显示终止原因和具体诊断；已有报告正文也可能未通过证据或声明
校验。详见 [CLI 结果说明](docs/reference/cli.md#全局选项)。

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
