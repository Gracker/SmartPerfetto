# 快速开始

本页用于把 SmartPerfetto 跑起来。更多模型和代理参数见 [配置指南](configuration.md)。

## 1. 克隆仓库

普通使用不需要初始化 `perfetto/` submodule。仓库已经包含预构建 Perfetto UI。

```bash
git clone https://github.com/Gracker/SmartPerfetto.git
cd SmartPerfetto
```

只有修改 AI Assistant 前端插件代码时，才需要初始化 submodule 并使用开发脚本。

## 2. 准备模型配置

本地源码运行时，如果这个终端里的 Claude Code 已经能正常写代码，可以不配置 API key；这也包括 Claude Code 自己已经接入第三方模型的情况：

```bash
claude
```

显式 API key/proxy 场景再创建 env 文件：

```bash
cp backend/.env.example backend/.env
# 编辑 backend/.env：
# ANTHROPIC_API_KEY=your_anthropic_api_key_here
```

也可以通过 `ANTHROPIC_BASE_URL` 接入 one-api、new-api、LiteLLM 等 Anthropic 兼容代理。Docker Hub 镜像使用仓库根目录 `.env`：

```bash
cp backend/.env.example .env
```

## 3. Docker 运行

适合只想试用，不想配置本机开发工具链的场景。

```bash
docker compose -f docker-compose.hub.yml pull
docker compose -f docker-compose.hub.yml up -d
```

打开 [http://localhost:10000](http://localhost:10000)，加载 `.pftrace` 或 `.perfetto-trace` 文件，然后打开 AI Assistant 面板。

## 4. 本地开发运行

适合本地使用、调试后端、改策略/Skill 或提交 PR。

```bash
./start.sh
```

首次启动会安装依赖，并下载 version-pinned 的 `trace_processor_shell` 预编译产物。若当前网络无法访问 Google artifact bucket，优先改用 Docker 方式；或者设置 `TRACE_PROCESSOR_PATH` 指向已有 binary，设置 `TRACE_PROCESSOR_DOWNLOAD_BASE` / `TRACE_PROCESSOR_DOWNLOAD_URL` 指向可信镜像后再运行。服务地址：

| 服务 | 地址 |
|---|---|
| Perfetto UI | `http://localhost:10000` |
| Backend API | `http://localhost:3000` |
| Backend health | `http://localhost:3000/health` |

后端会自动启动，前端使用仓库内的预构建 UI。只有修改 AI Assistant 前端插件时，才需要 `git submodule update --init --recursive` 后运行 `./scripts/start-dev.sh`。

## 5. 第一次分析

1. 打开 `http://localhost:10000`。
2. 加载 Perfetto trace。
3. 打开 AI Assistant。
4. 输入问题：

```text
分析滑动卡顿
```

常用问题：

- `分析启动性能`
- `CPU 调度有没有问题？`
- `帮我看看这个 ANR`
- `这个 trace 的应用包名和主要进程是什么？`

## 6. 必要检查

开发改动后，至少运行：

```bash
cd backend
npm run test:scene-trace-regression
```

更多命令见 [测试与验证](../development/testing.md)。
