# 本地开发

[English](local-development.en.md) | [中文](local-development.md)

## 环境要求

- Node.js 24 LTS
- Python 3
- Git submodule
- `curl`, `lsof`, `pkill`
- 可用的 Claude Code 本地配置、Anthropic API key，或 Anthropic 兼容代理
- 可选 C++ 工具链：只有 `--build-from-source` 编译 trace processor 时需要

仓库包含 `.nvmrc` 和 `.node-version`，并通过 `.npmrc` 开启 `engine-strict=true`。本地脚本会优先使用 nvm 或 fnm 切到 Node 24；如果检测到 `backend/node_modules` 是在其他 Node ABI 下安装的，会先自动重装后端依赖，再启动服务。

## 启动开发服务

```bash
./scripts/start-dev.sh
```

脚本会处理：

- 安装 backend 依赖。
- 安装 Perfetto UI 依赖。
- 下载或构建 `trace_processor_shell`。
- 启动 backend `tsx watch`。
- 启动 Perfetto UI `build.js --watch`。

服务地址：

| 服务 | 地址 |
|---|---|
| Backend | `http://localhost:3000` |
| Frontend | `http://localhost:10000` |

## 什么时候需要重启

默认只刷新浏览器。

| 改动 | 操作 |
|---|---|
| `.ts` | watcher 自动重编译，刷新浏览器 |
| `.yaml` Skill | watcher 自动生效，刷新浏览器 |
| `backend/strategies/*.md` | DEV 模式热加载，刷新浏览器 |
| `.env` | `./scripts/restart-backend.sh` |
| `npm install` 后 | `./scripts/restart-backend.sh` |
| 两个服务都崩了 | `./scripts/start-dev.sh` |

## 目录边界

```text
backend/
  src/agentv3/       # 主 Agent 运行时
  src/routes/        # Express 路由
  src/services/      # trace、skill、report、session 服务
  skills/            # YAML Skill DSL
  strategies/        # Prompt strategy/template
  tests/             # Skill eval、回归和集成测试

perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/
  ai_panel.ts
  assistant_api_v1.ts
  sse_event_handlers.ts
  sql_result_table.ts
  generated/         # 自动生成类型，不要手改

docs/
  rendering_pipelines/  # 运行时教学文档
  architecture/         # 当前架构和权威设计
  reference/            # API/CLI/MCP/Skill 参考
```

## Prompt 与 Skill 规则

- 不要在 TypeScript 中硬编码 Prompt 内容。
- 场景策略放在 `backend/strategies/*.strategy.md`。
- 可复用 Prompt 放在 `backend/strategies/*.template.md`。
- 确定性分析逻辑放在 `backend/skills/**/*.skill.yaml`。
- Skill 参数使用 `${param|default}`。
- Prompt template 变量使用 `{{variable}}`。

## 生成文件

不要手动编辑：

- `perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/generated/*.ts`
- `dist/`
- 任何带 `Generated` 或 `Auto-generated` 标记的文件

前端类型同步：

```bash
cd backend
npm run generate:frontend-types
```

## Perfetto submodule

`perfetto/` 是 fork 后的 Google Perfetto submodule。修改 submodule 后，推送规则与主仓库不同；维护者内部流程要求 Perfetto submodule 推到 `fork` remote，而不是 upstream `origin`。
