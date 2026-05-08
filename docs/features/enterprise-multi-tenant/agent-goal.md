# Agent Goal: SmartPerfetto 企业级多租户落地

> 这是一份 **self-contained 的 agent 目标 prompt**。任何 AI session 拿到本文件都应能从零开始接手，
> 按下面流程把 [`README.md`](./README.md) §0 的 TODO 推到全部打勾。
> 完成前不要主动停下；只在 §6 列出的明确人类决策节点才暂停。

---

## 1. 角色与目标

你是 SmartPerfetto 项目的 senior engineer。**唯一目标**：把仓库从"本地单机分析工具"演进成 [`README.md`](./README.md) 描述的"100 人企业版多租户系统"。

**终态判定**（三条必须同时成立，缺一条都不能宣告完成）：

1. [`README.md`](./README.md) §0 中所有 `[ ]` 已变成 `[x]`。
2. §0.8 §19 总验收 11 项全部由实测/压测证明（不是口头确认）。
3. §0.7 D1-D10 反证用例全部由自动化测试通过。

未达成时只能宣告"阶段性进展 + 下一步"，不可宣告"完成"。

## 2. 不可违背的硬约束（写死，不再决策）

| 约束 | 内容 |
|---|---|
| 分支 | 所有改动在 `feature/enterprise-multi-tenant`；不存在则先创建并推到远端；**绝不**直接对 `main` 提交 |
| 测试同步 | 每个工程项的 PR 必须**同时**包含代码 + 测试；不允许"代码先合、测试后补" |
| TODO 单点真相 | 完成一项立刻把 §0 对应行 `[ ]` → `[x]`，并在同一 PR 内提交；不要在别处维护另一份 |
| 文档登记 | 新增/引用任何文档（ADR / 设计 / runbook / 外部参考 / Codex review）都追加到 §0.9，对应工程项完成后才打勾，**只追加不重排** |
| 工作流 | 非平凡任务一律 Plan → Codex review (read-only) → Revise → Execute（CLAUDE.md 强约束） |
| 提交前 | 跑 `/simplify` 整理改动 |
| PR 前 | `npm run verify:pr` 通过 |
| 子模块 | 涉及 `perfetto/` 时先在子模块 commit + 推 `fork`，再回主仓 + `./scripts/update-frontend.sh` + 提交 |
| 不引入组件 | v1 不引入 Redis / NATS / Vault / Postgres HA / 独立 API Gateway / 独立 SSE Gateway |
| 输出语言 | 用户面向文本默认 zh-CN（遵循 `SMARTPERFETTO_OUTPUT_LANGUAGE`） |
| 红线 | 任何"绕开 lease / owner guard / queue 才能跑"的实现一律停下请示，绝不为通过测试而绕开（§23 反证循环红线） |

## 3. 启动流程（第一轮必做，且只做一次）

1. 读 `CLAUDE.md` 与 `.claude/rules/{backend,frontend,prompts,skills,testing,git}.md`，以及 [`README.md`](./README.md) §0、§6-§17 设计正文、§19、§23。
2. 搜索过往记忆：`/Users/chris/.claude/projects/-Users-chris-Code-SmartPerfetto-SmartPerfetto/memory/MEMORY.md`，确认是否有同 feature 的前序工作。**有则先问用户**：是重新审查还是在已有结果上扩展（CLAUDE.md 第 6 条）。
3. `git status --short --branch` 确认无脏区。
4. 切到（或创建）`feature/enterprise-multi-tenant` 分支并 push 设置 upstream。
5. 跑 baseline：`cd backend && npm run typecheck && npm run test:scene-trace-regression`；把耗时和 PASS/FAIL 写入 `docs/features/enterprise-multi-tenant/baseline.md`，并登记到 §0.9。

## 4. 主循环（每一轮 8 步）

```
loop {
  1. 读 README §0，找下一个未打勾项（顺序见 §5）
  2. Plan：写出"要改哪些文件、改哪些测试、走什么验证"
  3. 非平凡？→ 调用 codex 做 read-only review；LGTM 或吸收反馈后才进入 4
  4. 实施改动（小步、可测）
  5. 写/补对应测试 → 跑通；scene-trace-regression 不退化
  6. /simplify 整理改动
  7. 把 §0 对应行 [ ] → [x]；如新增文档则追加到 §0.9
  8. commit + push + 开 PR；PR 描述显式引用 §0.x.y
}
```

每完成一个**主线段**（例如 §0.1 全部、§0.4 全部）输出一次 status report（格式见 §7）。

## 5. 任务选取顺序（除非用户改写）

1. §0.0 工程准备（一次性）
2. §0.1 第一里程碑 8 项
3. §0.4.1 §11.10 第一批最小改动 6 子项（与 §0.1 重叠部分合并做，最早胜利）
4. §0.2 主线 A 全部
5. §0.3 主线 B 全部
6. §0.4 主线 C 剩余
7. §0.5 主线 D 全部
8. §0.6 测试矩阵补缺
9. §0.7 D1-D10 反证用例
10. §0.8 §19 总验收压测
11. §0.10 PR 收尾

## 6. 必须暂停并请示用户的场景（其它一律自主推进）

- **架构选型**：SQLite WAL vs 单 Postgres（§0.3.1）；OIDC IdP 选型；SecretStore master key 存放策略
- **破坏性 / 不可逆操作**：删除生产数据、force push、改 main 分支保护、撤销 PR
- **TODO 范围扩张**：发现需要 §0 之外的新主线时，先写设计提案让用户拍板
- **测试持续失败 ≥ 3 次**：连续修 3 次仍 FAIL，停下排查根因，不乱试
- **Codex 明确反对且你不认同**：把分歧报告给用户决策
- **进入 §0.8 压测**：50 用户压测需要环境准备，先确认环境
- **MEMORY.md 命中前序工作**：先问用户重审还是扩展（CLAUDE.md 第 6 条）

## 7. 报告格式

每个 PR 完成时输出（中文）：

```
### [§0.x.y 标题] 完成
- 改动摘要：…
- 新增/修改测试：…
- 触发的回归命令：…（贴关键 PASS/FAIL 与耗时）
- TODO 状态：§0.x.y → [x]；本 PR 内同时打勾的子项：…
- 新增文档：…（已登记 §0.9）
- 风险 / 未决：…
- 下一项：§0.a.b
```

每完成一个**主线**（A/B/C/D 任一）输出阶段总结：累计 PR 列表 + 测试覆盖增量 + 剩余风险 + 下一主线 ETA 估计。

## 8. 失败处理决策树

| 现象 | 处理 |
|---|---|
| 测试 FAIL | 先看是不是新代码退化；不是则查 §0 是否漏了前置项 |
| Codex review FAIL | 吸收反馈、改方案、再 review；连续 2 轮无法收敛上报用户 |
| 子模块 push 失败 | 确认推到 `fork` 而非 upstream `origin` |
| `verify:pr` 失败 | 分别跑 `validate:skills` / `validate:strategies` / `typecheck` / `build` / `test:core` / `test:scene-trace-regression` 定位 |
| 想绕开 lease / owner guard / queue | **立即停下**，写入 §0.9 风险登记，向用户请示（§23 红线） |
| RSS / OOM | 跑 §0.4.3 RSS benchmark 并记录到 baseline.md，再调 admission factor |
| `frontend/` 与 `perfetto/` 不一致 | 跑 `./scripts/update-frontend.sh` 后重新 commit |

## 9. 终态产出（达到 §1 三条件后必须交付）

1. `feature/enterprise-multi-tenant` 分支已合入 `main`，或处于 ready-to-merge + `verify:pr` 通过状态。
2. [`README.md`](./README.md) §0 全部 `[x]`。
3. `docs/features/enterprise-multi-tenant/release-notes.md`：
   - 4 条主线交付物清单（A 身份 / B 存储 / C 运行时 / D 控制面）
   - D1-D10 测试结果汇总（链接到具体测试文件）
   - §19 11 项验收证据（指向压测报告 / 截图 / 日志）
   - 已知限制与未来工作（appendix-ha.md 中哪些项被解锁）
4. `docs/features/enterprise-multi-tenant/load-test-report.md`：覆盖 50 在线 / 5-15 running run / RSS / queue length / LLM cost / p50 / p95 / 错误率。

只有这 4 件齐全才能宣告"事实层面 100% 完成"（§23.3 定义）。

## 10. 环境与命令速查

| 项 | 值 |
|---|---|
| 项目根 | `/Users/chris/Code/SmartPerfetto/SmartPerfetto` |
| 主仓 | `Gracker/SmartPerfetto`（私有） |
| 子模块 | `perfetto/` → fork 远端 |
| Node / TS | Node 24 LTS / TypeScript strict |
| 主要测试 | `cd backend && npm run test:scene-trace-regression` |
| PR Gate | `npm run verify:pr` |
| 启动 | `./start.sh`（用户）/ `./scripts/start-dev.sh`（UI dev） |
| 前端重建 | `./scripts/update-frontend.sh` |
| 默认输出语言 | zh-CN |

## 11. 绝不能做的事

- 跳过测试；推迟到"统一补"
- 直接对 `main` 提交；force push 到任何分支
- 把 prompt 内容硬编码进 TypeScript（违反 `.claude/rules/prompts.md`）
- 手改生成文件（`generated/` / `dist/` / checked-in bundle）
- 为通过测试而绕过 owner guard / lease / queue
- 重排 §0.9 文档登记区
- 在没有用户确认下做 §6 列出的架构选型
- 跨主线串改动（每个 PR 只属于一个主线段）
- 用 Bash `cat`/`echo` 替代 Read/Write 工具

---

## 调用方式

启动新会话时，把本文件路径连同一句指令喂给 AI：

```
请阅读 docs/features/enterprise-multi-tenant/agent-goal.md，按其中流程接手企业级多租户落地工作。
当前状态以 README.md §0 的 [x]/[ ] 为准。
```

AI 应自行从 §3 启动流程开始，沿 §4 主循环推进，直到 §1 三条件全部成立，再输出 §9 终态产出。
