# API 参考

[English](api.en.md) | [中文](api.md)

默认后端地址是 `http://localhost:3000`。如果设置了 `SMARTPERFETTO_API_KEY`，受保护接口需要：

```http
Authorization: Bearer <token>
```

## 健康检查

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/health` | 后端状态、运行时、模型配置、鉴权状态 |
| `GET` | `/debug` | 开发调试信息，包含 legacy API 使用快照 |

## Trace 管理

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/traces/health` | trace 服务健康状态 |
| `POST` | `/api/traces/upload` | 上传 trace 文件，字段名 `file` |
| `GET` | `/api/traces` | 列出已知 trace |
| `GET` | `/api/traces/stats` | trace 统计 |
| `POST` | `/api/traces/cleanup` | 清理 trace |
| `POST` | `/api/traces/register-rpc` | 注册外部 trace_processor RPC |
| `GET` | `/api/traces/:id` | trace 信息 |
| `DELETE` | `/api/traces/:id` | 删除 trace |
| `GET` | `/api/traces/:id/file` | 下载 trace 文件 |

上传示例：

```bash
curl -F "file=@trace.pftrace" http://localhost:3000/api/traces/upload
```

## Agent v1 主路径

Base path: `/api/agent/v1`

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/analyze` | 启动分析 |
| `GET` | `/:sessionId/stream` | SSE 流 |
| `GET` | `/:sessionId/status` | 查询状态 |
| `GET` | `/:sessionId/turns` | 获取多轮历史 |
| `GET` | `/:sessionId/turns/:turnId` | 获取单轮详情 |
| `POST` | `/resume` | 恢复已有 session |
| `POST` | `/:sessionId/respond` | 继续或终止 awaiting_user 会话 |
| `POST` | `/:sessionId/intervene` | 用户干预接口，agentv3 当前会优雅拒绝不支持的 runtime 能力 |
| `POST` | `/:sessionId/cancel` | 取消分析 |
| `POST` | `/:sessionId/interaction` | 记录 UI 交互 |
| `GET` | `/:sessionId/focus` | 查询 focus 状态 |
| `GET` | `/:sessionId/report` | 获取分析报告 |
| `DELETE` | `/:sessionId` | 删除 session |
| `POST` | `/:sessionId/feedback` | 提交反馈，进入 self-improving 链路 |
| `POST` | `/scene-detect-quick` | 快速场景检测 |
| `POST` | `/teaching/pipeline` | 渲染管线教学 |
| `GET` | `/sessions` | session catalog |
| `GET` | `/logs` | agent logs，受 feature flag 控制 |

启动分析：

```bash
curl -X POST http://localhost:3000/api/agent/v1/analyze \
  -H "Content-Type: application/json" \
  -d '{
    "traceId": "trace-id",
    "query": "分析滑动卡顿",
    "options": {
      "analysisMode": "auto"
    }
  }'
```

响应会返回 `sessionId`。随后订阅：

```bash
curl -N http://localhost:3000/api/agent/v1/<sessionId>/stream
```

支持的 `selectionContext`：

```json
{
  "selectionContext": {
    "kind": "area",
    "startNs": 1000000000,
    "endNs": 2000000000
  }
}
```

```json
{
  "selectionContext": {
    "kind": "track_event",
    "eventId": 123,
    "ts": 1000000000
  }
}
```

双 trace 对比需要传 `referenceTraceId`，且不能与 `traceId` 相同。

## Scene Reconstruction

Base path: `/api/agent/v1`

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/scene-reconstruct/preview` | 缓存检查与成本预估，不启动重任务 |
| `GET` | `/scene-reconstruct/report/:reportId` | 获取持久化 SceneReport |
| `POST` | `/scene-reconstruct` | 启动场景还原 |
| `GET` | `/scene-reconstruct/:analysisId/stream` | 场景还原 SSE |
| `GET` | `/scene-reconstruct/:analysisId/tracks` | 获取 tracks |
| `GET` | `/scene-reconstruct/:analysisId/status` | 查询状态 |
| `POST` | `/scene-reconstruct/:analysisId/deep-dive` | 对某个场景深挖 |
| `POST` | `/scene-reconstruct/:analysisId/cancel` | 取消 |
| `DELETE` | `/scene-reconstruct/:analysisId` | 删除 |

该能力受 `FEATURE_AGENT_SCENE_RECONSTRUCT` 控制。

## Skill API

Base path: `/api/skills`

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/` | 列出 Skill |
| `GET` | `/:skillId` | Skill 详情 |
| `POST` | `/execute/:skillId` | 执行指定 Skill |
| `POST` | `/analyze` | 自动检测并执行 Skill |
| `POST` | `/detect-intent` | 意图检测 |
| `POST` | `/detect-vendor` | 厂商检测 |

Admin path: `/api/admin`

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/skills` | 管理端 Skill 列表 |
| `POST` | `/skills` | 创建 Skill |
| `PUT` | `/skills/:skillId` | 更新 Skill |
| `DELETE` | `/skills/:skillId` | 删除 Skill |
| `POST` | `/skills/validate` | 校验 Skill |
| `POST` | `/skills/reload` | 重新加载 Skill |
| `POST` | `/strategies/reload` | 重新加载策略 |
| `GET` | `/self-improve/metrics` | 自改进指标 |

## 报告与导出

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/reports/:reportId` | 获取报告 |
| `DELETE` | `/api/reports/:reportId` | 删除报告 |
| `POST` | `/api/export/result` | 导出单个结果 |
| `POST` | `/api/export/session` | 导出 session |
| `POST` | `/api/export/analysis` | 导出分析 |
| `GET` | `/api/export/formats` | 支持格式 |

## Legacy 与兼容接口

以下接口仍存在，但新集成应优先使用 `/api/agent/v1/*`：

- `/api/perfetto-sql/*`
- `/api/template-analysis/*`
- `/api/advanced-ai/*`
- `/api/auto-analysis/*`
- `/api/agent/v1/llm/*`

legacy agent API base 会被 `rejectLegacyAgentApi` 拒绝，避免外部继续接入废弃路径。
