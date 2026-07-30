# Self-Evolution 使用与验收

[English](self-evolution.en.md) | [中文](self-evolution.md)

<!-- i18n-headings: paired -->

Self-Evolution 是面向维护者和 workspace 管理员的受控改进闭环。它把有效的公开反馈
转成可审阅提案，在固定环境中比较 baseline 与 candidate，通过门控和人工确认后，
才允许把最小 overlay 应用到后续分析。它不会训练模型，也不会自动提交代码、创建
PR、推送远端或改写 TypeScript。

普通分析用户无需启用此功能。所有专用开关默认关闭；关闭时，既有 AI 分析、报告、
CLI 和 feedback 入口保持原样。

## 当前闭环

```text
一次分析
  -> 不可变 RunManifest
  -> public/private feedback 事件与可逆投影
  -> 显式 public feedback 策展
  -> 单个有界提案
  -> 固定 validation + holdout 配对回放
  -> 人工 accept 或 reject
  -> 可选本地去标识贡献包
  -> 显式 apply
  -> 不可变 overlay + 新 generation
  -> 新 run 使用固定 snapshot
  -> 启动/升级对账或显式 revert
```

关键边界：

- 一个 run 固定 runtime、provider、model、配置、工具、Skill/Strategy 指纹和
  overlay generation；运行中的分析不会被新 generation 替换。
- feedback 先进入 append-only 事实日志，再生成可重建投影。private feedback
  写入独立本地路径，永不进入策展或贡献包。
- 在线反馈只形成 `hypothesis_only` 提案，不能替代固定 paired evaluation。
- gate 同时要求 validation 与 holdout，并把候选物化、环境证明、预算、并发和
  replay 结果绑定到同一输入指纹；任一侧失败都不会取得 apply 资格。
- overlay 是带内容哈希的不可变 artifact。apply/revert 需要唯一 `actionId`；
  重试不会重复发布同一个动作。
- 启动和升级会先对账再发布。孤儿、base fingerprint drift、解析/验证失败或发布
  失败都会被隔离并写入 reconciliation report。
- 当前外部 L2 judge 固定为 `not_configured`。系统没有对应环境变量，也不会发起
  外部 judge 调用；未来接入仍需要逐次明确授权。

更细的数据契约、overlay 操作和 legacy 边界见
[Self-Improving 运行契约](../architecture/self-improving-design.md)。

## 真正影响谁

| 用户 | 当前影响 |
|---|---|
| 普通分析用户 | 默认无行为变化。完成分析后仍可点勾/叉；反馈可被更正，private 分析的反馈只保存在本地私有路径 |
| Analyst | 具备 `self_evolution:read` 时可查看当前状态、提案、overlay 和对账，不能据此 apply |
| Workspace/Org Admin | 在部署者启用功能后，可显式策展、gate、接受/拒绝、导出、apply 和 revert |
| 部署者 | 必须决定是否启用两个开关，并为 apply 提供可写、包外、可跨升级保留的数据目录 |
| Skill/Strategy 维护者 | 可以审查结构化最小 delta 和配对证据；仓库 patch 与贡献包仍是本地产物，不会自动进入 Git |

这不是“系统会自己越来越好”的承诺。对普通用户最直接的变化是反馈归因和可撤销性
更可靠；对管理员最直接的变化是多了一个可观察、可拒绝、可回滚的控制面。

## 启用与权限

只启用策展、gate 和提案审阅：

```bash
SELF_EVOLUTION_ENABLED=true
```

再允许显式 apply/revert：

```bash
SELF_EVOLUTION_ENABLED=true
SELF_EVOLUTION_APPLY=true
SMARTPERFETTO_BACKEND_DATA_DIR=/absolute/persistent/path/outside/package
```

`SMARTPERFETTO_BACKEND_DATA_DIR` 必须显式配置、可写并位于程序包之外。Docker 下还
必须是真实持久化挂载。探测失败时，requested apply 仍可见，但 effective apply
会 fail-closed 关闭；API 返回 `503`，不会回落到包内临时目录。

修改环境变量后重启后端，再打开 **AI Assistant Settings → 自进化 / Evolution**。
本地未配置鉴权时，开发身份拥有管理员权限；生产部署应使用明确授予以下权限的
SSO/API 身份：

| 权限 | 能力 |
|---|---|
| `self_evolution:read` | overview、提案、overlay、对账 |
| `self_evolution:curate` | 策展、SSE、gate、accept/reject |
| `self_evolution:export` | 生成本地去标识贡献包 |
| `self_evolution:apply` | 应用已接受且仍满足 gate 绑定的提案 |
| `self_evolution:revert` | 回滚已应用提案 |

`SMARTPERFETTO_API_KEY` 是部署运维者的 bootstrap 凭据，默认拥有
`org_admin` 和 `*`；它不是普通终端用户或企业 API key。企业 API key、SSO 和其他
生产身份应从持久化绑定解析最小 roles/scopes。看到 `403` 时，应修复该身份的授权，
而不是关闭 RBAC。

## 用户冒烟测试

### 1. 默认关闭

1. 不设置任何 `SELF_EVOLUTION_*` 变量，运行 `./start.sh`。
2. 打开 `http://127.0.0.1:10000`。
3. 进入 **AI Assistant Settings → 自进化 / Evolution**。
4. 确认页面显示“默认关闭”，`requested/effective enabled` 都为关闭。
5. 确认 L2 显示未配置，且没有外部授权或调用提示。
6. 完成一次普通 trace 分析，确认聊天、报告和勾/叉反馈仍正常。

### 2. 只启用策展

1. 设置 `SELF_EVOLUTION_ENABLED=true` 后重启后端。
2. 确认控制台允许刷新、查看状态和启动策展，但 apply/revert 保持关闭。
3. 对一个公开分析结果提交勾或叉；这只能证明 feedback capture 成功。单条反馈
   可能不满足策展条件，控制台返回“无提案”是合法结果。
4. 若已有足够的有效公开反馈，点击策展并观察 SSE 从 queued/progress 到
   completed 或 failed；失败必须显示明确错误，不能伪装成提案。

### 3. 完整 apply/revert

只在可丢弃测试数据目录和管理员身份下执行：

1. 同时设置两个开关和包外 `SMARTPERFETTO_BACKEND_DATA_DIR`，重启后确认
   `persistence=available`、effective apply 已开启。
2. 对已有提案依次执行 gate、检查 before/after 与证据、accept、apply。
3. 记录 generation 和生效 overlay 数；正在运行的分析应继续使用旧 snapshot，
   新分析才使用新 generation。
4. 使用同一个数据目录重启后端，确认 generation 仍存在，最近 reconciliation
   没有静默丢弃或错误启用 overlay。
5. 点击 revert 并确认生成新 generation；再次启动新分析，确认已回到不含该
   overlay 的有效 registry。
6. 可选执行 export，确认只生成本地去标识 artifact；Git 状态和远端仓库不应因此
   发生变化。

### 4. Fail-Closed 与隔离

- 把数据目录设在程序包内，确认 apply/revert 被禁用并显示
  `data_root_inside_package`。
- Docker 未挂载持久化目录时，确认显示 `docker_data_root_not_mounted`。
- 用 Analyst 身份确认 overview 可读、变更操作返回 `403`。
- 用 private knowledge 会话提交 feedback，确认策展不读取该反馈。
- 修改 provider/model/config 或 registry 后，确认旧 evaluation proof 不会被当作
  当前 apply 资格。

## 维护者自动化验证

从仓库根目录运行文档与中英文契约：

```bash
npm run verify:docs
npm run verify:i18n
```

运行 Self-Evolution 专项测试：

```bash
npm --prefix backend run test:self-evolution
npm --prefix backend run typecheck
npm --prefix backend run test:scene-trace-regression
```

合入前运行总门禁：

```bash
npm run verify:pr
```

`test:self-evolution` 覆盖配置依赖、持久化探测、RunManifest、反馈迁移/投影、
eval corpus、paired replay、门控、overlay、apply/revert、升级对账、RBAC/scope
和管理 API。它证明代码契约，不替代上述真实启动、浏览器、持久化重启和权限测试。

如果修改了 Self-Evolution UI 源码，还必须在 `./scripts/start-dev.sh` 中完成浏览器
验证、运行相关 Perfetto UI tests/typecheck，并执行 `./scripts/update-frontend.sh`
更新提交的预构建 UI。完整变更类型矩阵见
[测试规则](../../.claude/rules/testing.md)。

## 结果判定与清理

通过标准：

- 默认关闭时普通分析没有回归；
- 未满足开关、权限、持久化或 gate 绑定时，没有任何隐式 apply；
- apply/revert 只改变新 run 的 generation，重启后状态可恢复并可对账；
- private feedback、路径、凭据和原始 provider 内容不进入公共提案或贡献包；
- 控制台、API、metrics 和持久化事实对同一状态给出一致解释。

测试结束后先停止当前 checkout 的服务，再删除你显式创建的可丢弃测试数据目录。
不要删除生产 `SMARTPERFETTO_BACKEND_DATA_DIR`，也不要用 `docker compose down -v`
清理包含真实数据的 volume。
