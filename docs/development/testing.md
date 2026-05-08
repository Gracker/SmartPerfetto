# 测试与验证

[English](testing.en.md) | [中文](testing.md)

SmartPerfetto 的默认团队协作标准是：提 PR 前跑同一个入口，CI 也跑同一个入口。

```bash
# 仓库根目录。首次运行前先安装 root 和 backend 依赖：
# npm ci
# cd backend && npm ci
npm run verify:pr
```

`verify:pr` 会执行 root 质量检查、backend Skill/Strategy 校验、类型检查、构建、CLI package 检查、核心单测，以及 6 条 canonical trace 回归。它会在缺少 `trace_processor_shell` 时自动下载固定版本的预编译产物。

日常开发按改动类型分层执行（详见下方"改动类型与必须验证"表）：

- contract / 纯类型改动（例如 `backend/src/types/sparkContracts.ts`）：`cd backend && npx tsc --noEmit` + 相关 `__tests__/sparkContracts.test.ts`
- CRUD-only service（仅文件 IO，未触 agent 路径）：该 service 的单测
- 触 mcp / memory / report / agent runtime：`cd backend && npm run test:scene-trace-regression`
- PR landing：`npm run verify:pr` 全量

```bash
# 触 agent runtime 的典型回归命令：
cd backend
npm run test:scene-trace-regression
```

## 核心命令

| 场景 | 命令 |
|---|---|
| TypeScript build | `cd backend && npm run build` |
| 类型检查 | `cd backend && npm run typecheck` |
| 核心单测 | `cd backend && npm run test:core` |
| 场景 trace 回归 | `cd backend && npm run test:scene-trace-regression` |
| Skill 校验 | `cd backend && npm run validate:skills` |
| Strategy 校验 | `cd backend && npm run validate:strategies` |
| 默认 gate | `cd backend && npm run test:gate` |
| PR 前完整入口 | `npm run verify:pr` |

## 改动类型与必须验证

| 改动 | 必跑 |
|---|---|
| 提 PR 前 | `npm run verify:pr` |
| Contract / 纯类型（例如 `backend/src/types/sparkContracts.ts`） | `cd backend && npx tsc --noEmit` + 相关 `__tests__/sparkContracts.test.ts` |
| CRUD-only service（仅文件 IO，未触 agent 路径） | 该 service 的 `__tests__/<name>.test.ts` |
| 触 mcp / memory / report / agent runtime 的 TypeScript | `npm run test:scene-trace-regression` |
| Build/type 修复 | `npm run typecheck` + 触类别对应回归 |
| Skill YAML | `npm run validate:skills` + 回归 |
| Strategy/template Markdown | `npm run validate:strategies` + 回归 |
| 前端生成类型相关 | `npm run generate:frontend-types` + 相关前端测试 |
| 渲染管线文档且影响 Skill doc_path | `npm run validate:skills` + 回归 |

## Canonical traces

`test:scene-trace-regression` 使用 6 条 canonical traces：

| 场景 | Trace |
|---|---|
| Heavy launch | `lacunh_heavy.pftrace` |
| Light launch | `launch_light.pftrace` |
| Standard scrolling | `scroll_Standard-AOSP-App-Without-PreAnimation.pftrace` |
| Customer scrolling | `scroll-demo-customer-scroll.pftrace` |
| Flutter TextureView | `Scroll-Flutter-327-TextureView.pftrace` |
| Flutter SurfaceView | `Scroll-Flutter-SurfaceView-Wechat-Wenyiwen.pftrace` |

## E2E Agent 验证

当改动影响 startup、scrolling、Flutter、system prompt、verifier、MCP 工具或关键 Skill 时，只跑 Skill 回归不够，需要跑 Agent SSE 验证。

启动性能：

```bash
cd backend
npx tsx src/scripts/verifyAgentSseScrolling.ts \
  --trace ../test-traces/lacunh_heavy.pftrace \
  --query "分析启动性能" \
  --output test-output/e2e-startup.json \
  --keep-session
```

滑动性能：

```bash
cd backend
npx tsx src/scripts/verifyAgentSseScrolling.ts \
  --trace ../test-traces/scroll-demo-customer-scroll.pftrace \
  --query "分析滑动性能" \
  --output test-output/e2e-scrolling.json \
  --keep-session
```

fast/full 模式：

```bash
cd backend
npx tsx src/scripts/verifyAgentSseScrolling.ts \
  --mode fast \
  --trace ../test-traces/scroll-demo-customer-scroll.pftrace \
  --query "这个 trace 的应用包名和主要进程是什么？" \
  --output test-output/e2e-fast.json
```

```bash
cd backend
npx tsx src/scripts/verifyAgentSseScrolling.ts \
  --mode full \
  --trace ../test-traces/scroll-demo-customer-scroll.pftrace \
  --query "分析滑动性能" \
  --output test-output/e2e-full.json
```

## 验证输出

E2E 完成后检查：

- `test-output/e2e-*.json` 是否有 terminal event 和错误事件。
- `backend/logs/sessions/session_*.jsonl` 中 phase 是否完整。
- 结论是否覆盖场景策略的强制检查项。
- Skill 表格和最终结论是否能互相支撑。

## 文档-only 改动

普通说明文档不一定需要跑完整回归，但如果文档被运行时读取，或改动同时触碰 `.ts`、`.yaml`、`backend/strategies/*.md`，按上表执行。

## 全量 Jest 的定位

`cd backend && npm test` / `npm run test:full` 是扩展诊断入口，不是当前默认 PR gate。它会包含一些历史 skill-eval 用例，这些用例依赖未随仓库发布的旧 trace fixture（例如 `app_aosp_scrolling_heavy_jank.pftrace`、`app_aosp_scrolling_light.pftrace`、`app_start_heavy.pftrace`）。恢复这些 fixture 或把用例迁移到现有 6 条 canonical trace 后，才能把全量 Jest 提升为强制门禁。
