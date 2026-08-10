# 故障排查

[English](troubleshooting.en.md) | [中文](troubleshooting.md)

## Windows 免安装包

Windows 用户先看完整的 [Windows 配置与运行指南](../getting-started/windows.md)。
不要从本页照抄 Unix 命令：在解压目录用 PowerShell 运行
`.\SmartPerfetto.exe`，并始终使用窗口打印的实际 `Open:` 地址。

查看日志：

```powershell
Get-Content "$env:LOCALAPPDATA\SmartPerfetto\logs\backend.log" -Tail 200
Get-Content "$env:LOCALAPPDATA\SmartPerfetto\logs\frontend.log" -Tail 200
```

当前 Windows 包未做 Authenticode 签名；SmartScreen/Defender 拦截时先核对官方
Release 和 SHA256，不要关闭 Defender。Provider 保存后还必须测试并激活。显式迁移
提示目标已存在是防覆盖行为，先备份，不要直接删除数据目录。

## AI backend not connected

检查后端是否运行：

```bash
curl http://localhost:3000/health
```

如果没有响应：

```bash
./start.sh
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

源码启动脚本只会停止 PID 元数据能够证明属于当前 checkout 的旧实例；如果端口由其他进程或另一个 checkout 占用，脚本会打印 `lsof` owner 并非零退出，不会直接杀掉它。

先检查并停止当前 checkout 记录的服务：

```bash
./scripts/stop-dev.sh
```

只有在确认打印出的端口 owner 都应该被停止后，才使用显式强制入口：

```bash
./scripts/stop-dev.sh --force
```

`--force` 只针对当前配置的 backend/frontend 监听端口；不会按模糊进程名全局清理 watcher 或 `trace_processor_shell`。

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

## Knowledge Pack 状态或更新失败

先用 JSON 状态区分 bundled、active 和 signed channel：

```bash
smp knowledge-pack status --format json
smp knowledge-pack update --check --format json
```

- 离线或 metadata channel 暂时不可达时，未撤回且校验通过的 bundled/active Pack
  仍可作为 fallback。
- 签名、版本、哈希、license 或撤回检查失败时，不能用手工覆盖 active pointer 的方式
  绕过；修复镜像 URL/网络/时钟后重试。
- `SMARTPERFETTO_AIW_PACK_PIN` 只能固定已经安装且未撤回的版本。
- Pack 只能作为 background knowledge；报告缺少当前 trace 证据时，不要把 Pack 引用
  当成分析功能已通过。

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

- Docker 运行时仓库根目录 `.env` 是否存在；本地源码运行时 `backend/.env` 是否存在。
- 是否配置了 `ANTHROPIC_API_KEY`，或 `ANTHROPIC_BASE_URL` 加 `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY`。
- 带鉴权的 `/api/runtime-health` 里的 `aiEngine.credentialSource` 是否为预期来源；如果是 `provider-manager`，active provider 会覆盖 `.env`。公开 `/health` 不返回凭证诊断。
- Docker 可用内存和磁盘是否足够。

Docker Hub 和普通 source Docker build 都消费提交的 `frontend/`，不要求初始化
`perfetto/` submodule。只有 UI plugin 开发路径才需要 submodule。

本地开发排查更容易时，可以先运行：

```bash
./start.sh
```

确认普通源码路径正常后再回到 Docker；只有修改 Perfetto UI plugin 时才使用 `./scripts/start-dev.sh`。

## Self-Evolution 不可用或没有提案

先进入 **AI Assistant Settings → 自进化 / Evolution**，区分 requested config、
effective config、权限和持久化状态：

- 页面显示默认关闭：部署环境没有设置 `SELF_EVOLUTION_ENABLED=true`。已有 feedback
  或 provider 不会自动打开它。
- 策展可用但 apply/revert 关闭：确认同时设置
  `SELF_EVOLUTION_APPLY=true`，并重启后端。
- API 返回 `503`：查看 persistence reason。`external_data_dir_not_configured`
  表示没有显式配置 `SMARTPERFETTO_BACKEND_DATA_DIR`；
  `data_root_inside_package` 表示目录仍在程序包内；
  `docker_data_root_not_mounted` 表示 Docker 路径不是持久化挂载。
- API 返回 `403`：当前身份缺少对应的 `self_evolution:*` 权限。Analyst 只能 read；
  企业 API key、SSO 和其他生产身份应检查持久化 roles/scopes 绑定。部署运维者的
  `SMARTPERFETTO_API_KEY` 是例外：它是默认拥有 `org_admin` 与 `*` 的 bootstrap
  凭据，不应分发给终端用户。
- 策展完成但没有提案：只有 effective public feedback 会进入策展，单条反馈或
  private feedback 不保证产生提案。这不是运行失败。
- gate 变为 inconclusive/pending：provider、model、config、registry、case split、
  budget 或 materialized treatment 已变化，旧 proof 不能复用；在固定环境中重新 gate。
- apply 后新分析未使用 overlay：检查 generation、overlay validation/activation 和
  reconciliation report。已有 run 固定旧 snapshot，只有新 run 读取新 generation。

外部 L2 judge 当前应显示
`not_configured / explicit_external_judge_consent_required`；这表示没有外部调用，
不是 provider 配置错误。完整流程与验收矩阵见
[Self-Evolution 使用与验收](../getting-started/self-evolution.md)。

## Agent 辅助 GitHub 反馈不可用

先确认源消息已经收到 `analysis_completed`。M10 只基于持久化完成事件、
RunManifest 和可选 result snapshot 工作，不会读取仍在运行的聊天状态。

- 显示“当前分析不需要反馈”：确定性检测没有发现 evidence/claim gate、Skill、
  scene confidence、identity 或 report 输出异常；仍可从 GitHub Issue Form 手工反馈。
- 显示 private/code-aware 不可导出：这是 fail-closed 隐私边界，不能用关闭脱敏或复制
  私有结果绕过。安全问题请改走 GitHub private advisory。
- 历史 run 缺少 provider pin，或 active provider snapshot 已变化：旧 run 不会改用
  当前 provider。重新运行一次分析以生成完整 pin；不要把 fallback 当作同一模型复核。
- 显示 Agent fallback：源 runtime 暂不支持独立 triage、固定 provider 的凭据不可用，
  或模型输出没有通过严格 JSON/evidence 校验。界面仍会给保守的确定性建议，但不会把
  它伪装成 Agent 结论。
- “生成 GitHub 草稿”仍禁用：回答所有必答问题，并勾选敏感信息复核。安全敏感候选
  不能生成公开草稿，只会返回 private advisory 入口。
- 打开 GitHub 后没有 Issue：这是预期行为。SmartPerfetto 只预填页面，不持有 token、
  不调用 GitHub API，也不会替用户点击提交。

完整字段、状态和人工验收步骤见
[Agent 辅助 GitHub 反馈](../getting-started/agent-assisted-feedback.md)。

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
