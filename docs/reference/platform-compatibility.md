# 平台兼容与验证边界

[English](platform-compatibility.en.md) | [中文](platform-compatibility.md)

<!-- i18n-headings: paired -->

SmartPerfetto 有四种分发 / runtime 家族；产品内部仍有更多具体入口。宿主系统、实际
运行系统和发布证据不能混为一谈：
例如 macOS 上的 Docker Desktop 仍运行 Linux container，交叉构建出的 Windows 归档也
不等于已经在 Windows 上启动验证。

| 入口 | 推荐宿主 / target | CPU 架构边界 | runtime 是否随产物提供 | 更新路径 | 当前证据类别 |
|---|---|---|---|---|---|
| Source Web (`./start.sh`) | macOS、Linux；原生 Windows 开发使用 WSL2 | 由 Node.js 24、Go 和当前原生依赖共同约束 | 否；使用宿主 Node.js，并准备固定 trace processor | Git 同步后重新启动 | source build、readiness 和项目门禁 |
| npm CLI (`smp`) | 支持 Node.js 24 的 macOS、Linux、Windows shell | Linux x64、macOS arm64、Windows x64 随包提供 trace processor；其他 host 按固定版本下载且可能不受支持 | CLI runtime 随 npm 包；不包含 Web launcher | npm 安装新的明确版本 | npm pack contract + 空目录真实安装 smoke |
| Docker image | 任意可运行兼容 Linux container 的 Docker host；实际 runtime 是 Linux | 发布镜像为 `linux/amd64`、`linux/arm64` | 是；镜像包含 Node、后端、提交版 UI 和固定 trace processor | 拉取明确 tag 后重建 container | image build/health + 已发布 tag/manifest 验收 |
| Portable archive | Windows 10 / Windows Server 2016 及以上 x64、macOS arm64 13.5+、Linux x64 glibc 2.34+；必须在匹配 target 上运行，不支持 Alpine 等 musl 系统 | 每个归档只支持文件名和 manifest 声明的单一 target；Windows、macOS 最低系统版本写入 manifest，macOS 同时以包内 `LSMinimumSystemVersion` 为准 | 是；包含 launcher、Node、原生依赖、后端、提交版 UI 和固定 trace processor | 下载新归档并按平台说明迁移/保留数据 | static package contract + 全 payload ELF/Mach-O 最低版本审计 + 匹配 target 的 exact-archive runtime smoke + GitHub release 验收 |

## 证据类别

1. **Packaged/static contract**：验证版本、target、manifest、目录、固定依赖和静态签名。
   这能发现错误归档，但不能证明目标系统能启动。
2. **Target-native runtime smoke**：在归档声明的 OS/arch 上运行同一份最终字节，检查
   `127.0.0.1` health、包内 runtime、最小 trace processor 查询、受控退出和端口释放。
3. **Published-surface acceptance**：在对应分发面核对不可变版本、远端 digest、tag/
   manifest 或空目录安装等公开状态。它不能由本地构建结果替代。

任一层缺少证据时，只报告已完成的层级；Windows/Linux 交叉构建不能写成 Windows/Linux
runtime smoke，Docker host 的操作系统也不能写成 container target。

Windows 用户操作以 [Windows 指南](../getting-started/windows.md) 为准。当前公开 v1.4.0
的 Windows x64 最终归档已在 Windows Server 2025 runner 验证包内 runtime、health、
最小 trace processor 查询、退出和端口释放；这不等于 Windows 10/11 桌面、SmartScreen
或 Provider UI 已人工验收。后续归档门禁还要求实际加载 SQLite/sodium、运行本地 Provider
生命周期和 Windows DPAPI SecretStore probe；只有对应最终归档执行成功后才能计为证据。

## 网络绑定边界

Source Web 默认把前后端监听到 IPv4 loopback `127.0.0.1`。若维护者确实需要暴露源码
前端，可显式设置 `SMARTPERFETTO_FRONTEND_BIND_HOST`；这会改变本机安全边界，不能仅
因为日志或访问 URL 仍使用 loopback 就假定服务未对外监听。Portable launcher 为避免把
本机 Provider 与 trace 数据意外暴露到网络，会把前后端监听固定为 `127.0.0.1`，不继承
ambient bind-host 变量。Docker 内部则显式使用 `0.0.0.0`，宿主暴露范围由 compose 的
publish host 控制，默认仍只发布到宿主 `127.0.0.1`。

## 事实所有权

- 安装和首次运行：[快速开始](../getting-started/quick-start.md)
- Windows 下载、配置、更新与排障：[Windows 指南](../getting-started/windows.md)
- Node、Provider 和部署配置：[配置指南](../getting-started/configuration.md)
- npm CLI 平台与 fallback：[CLI](cli.md)
- portable target、数据目录和迁移：[免安装包](portable-packaging.md)
- 发布顺序和 published-surface 验收：[发布流程](release.md)
- Agent/维护者验证门禁：[测试规则](../../.claude/rules/testing.md)
- UI/CLI 更新提示和各分发更新动作：[应用更新](../getting-started/application-updates.md)

应用更新检查只报告可用版本和推荐动作，不会替换正在运行的源码、npm 包、Docker
container 或 portable 目录。
