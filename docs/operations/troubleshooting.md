# 故障排查

[English](troubleshooting.en.md) | [中文](troubleshooting.md)

## AI backend not connected

检查后端是否运行：

```bash
curl http://localhost:3000/health
```

如果没有响应：

```bash
./scripts/start-dev.sh
```

如果只有后端配置变更或 watcher 卡住：

```bash
./scripts/restart-backend.sh
```

## trace 上传后没有数据

常见原因：

- trace 没有成功注册到后端。
- `trace_processor_shell` 进程退出。
- 查询依赖的 Perfetto stdlib 表不存在。
- Skill 的 stepId 与 YAML 输出不一致。

检查：

```bash
curl http://localhost:3000/api/traces
curl http://localhost:3000/api/traces/stats
```

## trace_processor_shell 下载失败

如果启动时出现 `trace_processor_shell not found`，随后卡在 `commondatastorage.googleapis.com` 或 `Failed to connect`，说明本机网络无法访问 Perfetto 的 Google artifact bucket。最省事的用户路径是直接运行 Docker Hub 镜像，镜像内已经带固定版本的 `trace_processor_shell`：

```bash
docker compose -f docker-compose.hub.yml pull
docker compose -f docker-compose.hub.yml up -d
```

本地脚本运行也可以跳过 Google 下载：

```bash
# 使用已有 binary
TRACE_PROCESSOR_PATH=/absolute/path/to/trace_processor_shell ./start.sh

# 使用保持相同目录结构的可信镜像
TRACE_PROCESSOR_DOWNLOAD_BASE=https://your-mirror/perfetto-luci-artifacts ./start.sh

# 使用当前平台的精确 binary URL
TRACE_PROCESSOR_DOWNLOAD_URL=https://your-mirror/trace_processor_shell ./start.sh
```

镜像或 URL 下载的内容仍会按 `scripts/trace-processor-pin.env` 中的固定 SHA256 校验。不要随意使用来源不明且校验不匹配的 binary。

## macOS 拦截 trace_processor_shell

如果 macOS 提示 `trace_processor_shell` 来自身份不明的开发者、终端只显示 `killed`，或脚本提示 `--version smoke test failed`，说明系统安全策略拦截了这个下载的可执行文件。

处理方式：

1. 打开 **系统设置 → 隐私与安全性 → 安全性**。
2. 找到 `trace_processor_shell`，点击 **仍要打开 / Allow Anyway**。
3. 重新运行 `./start.sh`，如果 macOS 再弹窗，选择 **打开**。

如果你确认 binary 来源可信，也可以在终端移除隔离属性：

```bash
xattr -dr com.apple.quarantine /absolute/path/to/trace_processor_shell
chmod +x /absolute/path/to/trace_processor_shell
```

## 端口冲突

默认端口：

- Backend: `3000`
- Frontend: `10000`
- trace_processor RPC: `9100-9900`

清理 trace processor：

```bash
pkill -f trace_processor_shell
```

如果 backend 端口被占用，先确认是否已有 SmartPerfetto 实例在跑，再决定是否停止旧进程。

## LLM 调用慢或失败

慢模型、代理模型、本地模型通常需要更长超时：

```bash
CLAUDE_FULL_PER_TURN_MS=120000
CLAUDE_QUICK_PER_TURN_MS=80000
CLAUDE_VERIFIER_TIMEOUT_MS=120000
CLAUDE_CLASSIFIER_TIMEOUT_MS=60000
```

如果 fast 模式分析重型问题失败，改用 full：

```json
{
  "options": {
    "analysisMode": "full"
  }
}
```

## 401 或鉴权失败

如果设置了 `SMARTPERFETTO_API_KEY`，请求需要：

```http
Authorization: Bearer <token>
```

本地开发没有设置该变量时，默认不要求 bearer token。

## SSE 断开

SSE 断开通常由浏览器刷新、网络中断或请求超时触发。后端支持 `Last-Event-ID` / `lastEventId` replay ring buffer，前端会尽量恢复缺失事件。

如果 session 已完成，重新连接 `/api/agent/v1/:sessionId/stream` 会尝试恢复结果并发送终态事件。

## Scene reconstruction 被禁用

`/api/agent/v1/scene-reconstruct/*` 受 feature flag 控制。接口返回：

```json
{
  "code": "FEATURE_DISABLED"
}
```

说明当前环境未启用 `FEATURE_AGENT_SCENE_RECONSTRUCT`。

## Docker 启动失败

检查：

- `backend/.env` 是否存在。
- 是否配置了 `ANTHROPIC_API_KEY`，或 `ANTHROPIC_BASE_URL` 加 `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY`。
- `perfetto/` submodule 是否存在。
- Docker 可用内存和磁盘是否足够。

本地开发排查更容易时，可以先运行：

```bash
./scripts/start-dev.sh
```

确认代码路径正常后再回到 Docker。

## Skill 校验失败

运行：

```bash
cd backend
npm run validate:skills
```

常见问题：

- YAML 缩进错误。
- step `id` 重复。
- `doc_path` 指向不存在的渲染管线文档。
- `display.columns` 字段名与 SQL 结果列不一致。
- `${param|default}` 拼写错误。

## Strategy 校验失败

运行：

```bash
cd backend
npm run validate:strategies
```

常见问题：

- frontmatter 不是合法 YAML。
- scene 名称与运行时枚举不一致。
- `phase_hints` 结构错误。
- Prompt 模板变量漏填。
