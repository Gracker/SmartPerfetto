# Context Engineering 改进 — Review 文档

> **日期**: 2026-04-15
> **来源**: 两篇 AI Agent 生产级工程实践文章（Kieran Zhang 的 4 个坑 + 数字黑魔法的 Restatement 机制）
> **Review**: 3 轮专家 review（Codex 架构审查 + LLM 注意力专家 + 生产稳健性专家）
> **状态**: 代码已实现，6/6 regression 通过，待人工 review

---

## 核心问题

SmartPerfetto 的 agentv3 在"给 LLM 什么信息"上做得很好（策略系统、skill 体系、4 层验证），但在"什么时候给"和"放在哪里"上有提升空间：

1. **策略内容一次性注入**: system prompt 中注入场景策略后，随着 8-15 turn 的 tool result 堆积，策略内容离上下文末尾越来越远，注意力权重下降
2. **Plan 缺失阶段只在事后发现**: `submit_plan` 接受任何计划，`verifyPlanAdherence` 要到结论后才检查——所有 token 已经花完
3. **Compact 后策略失忆**: SDK auto-compact 压缩历史后，recovery note 只恢复 findings，丢失 plan 进度和策略上下文
4. **Haiku 分类调用浪费**: 多数非 general 场景本不需要 LLM 判断复杂度

---

## 改动总览

| # | 改动 | 文件 | 新增行 | 核心机制 |
|---|------|------|--------|----------|
| 1 | Bugfix + DETERMINISTIC_SCENES 扩展 | `queryComplexityClassifier.ts` | ~7 | 修复 `scroll-response` → `scroll_response` bug；添加 teaching/pipeline |
| 2 | Strategy frontmatter `phase_hints` | 3 个 `.strategy.md` + `strategyLoader.ts` | ~73 | 在 YAML frontmatter 中定义 per-phase 约束和关键工具 |
| 3 | Restatement 注入 | `claudeMcpServer.ts` | ~52 | `update_plan_phase` response 中注入下一阶段约束 |
| 4 | submit_plan hard-gate | `claudeMcpServer.ts` | ~47 | 首次提交缺少必查项 → 拒绝；第 2 次放行 |
| 5 | Compact recovery 增强 | `claudeRuntime.ts` | ~58 | 优先级逐段构建：plan progress > next phase > findings > entity |

**总计**: ~237 行新增, ~15 行修改, 跨 7 个文件

---

## 详细改动说明

### 改动 1: Bugfix + DETERMINISTIC_SCENES 扩展

**文件**: `backend/src/agentv3/queryComplexityClassifier.ts`

**修复的 bug**: `DETERMINISTIC_SCENES` 中写的是 `'scroll-response'`（连字符），但 `sceneClassifier.ts`、`SCENE_PLAN_TEMPLATES`、`verifySceneCompleteness` 等所有其他地方用的是 `'scroll_response'`（下划线）。导致滑动响应场景一直在走 Haiku fallback 而非确定性路由。

**扩展**: 添加 `teaching` 和 `pipeline`（两者有多阶段策略，不可能是 quick factual lookup）。

**故意不添加**: `memory`/`game`/`overview`/`touch-tracking` — 这些场景有合法的 quick query（如 "内存多少？"、"帧率多少？"），强制走 full 分析会浪费 token。

```typescript
// Before (有 bug)
const DETERMINISTIC_SCENES = new Set(['scrolling', 'startup', 'anr', 'interaction', 'scroll-response']);

// After
const DETERMINISTIC_SCENES = new Set([
  'scrolling', 'startup', 'anr', 'interaction', 'scroll_response',
  'teaching', 'pipeline',
]);
```

**风险**: 极低

---

### 改动 2: Strategy Frontmatter `phase_hints`

**文件**: `backend/strategies/{scrolling,startup,anr}.strategy.md` + `backend/src/agentv3/strategyLoader.ts`

**动机**: 原方案将 phase hints 硬编码在 TypeScript 中（`SCENE_PHASE_HINTS`），生产专家 review 指出这违反 `prompts.md` 规则（"NEVER hardcode prompt content in TypeScript"）。改为放在 strategy frontmatter 中，通过 `strategyLoader.ts` 加载。

**数据结构**:

```yaml
# 在 strategy.md 的 YAML frontmatter 中
phase_hints:
  - id: root_cause_drill          # 唯一标识
    keywords: ['根因', 'root cause', '深钻', 'deep', 'drill']  # 中英文双语匹配
    constraints: '对占比 >15% 的 reason_code，必须选最严重帧执行深钻...'  # 约束文本
    critical_tools: ['jank_frame_detail', 'blocking_chain_analysis']  # 推荐工具
    critical: true                 # 匹配失败时作为 unconditional fallback
```

**TypeScript 侧**:

```typescript
// strategyLoader.ts 新增
export interface PhaseHint {
  id: string;
  keywords: string[];
  constraints: string;
  criticalTools: string[];
  critical: boolean;
}

export function getPhaseHints(scene: string): PhaseHint[] {
  return loadStrategies().get(scene)?.phaseHints || [];
}
```

**覆盖范围**:

| 场景 | Phase Hints 数量 | Critical Hints |
|------|-----------------|----------------|
| scrolling | 3 (overview, root_cause_drill, conclusion) | 1 (root_cause_drill) |
| startup | 4 (detail, artifacts, slow_reasons, conclusion) | 2 (artifacts, slow_reasons) |
| anr | 1 (freeze_verdict) | 1 (freeze_verdict) |
| 其他 9 场景 | 0 | 0 |

**风险**: 低。phase_hints 是可选字段，无 hints 的场景不受影响。

---

### 改动 3: Restatement 注入

**文件**: `backend/src/agentv3/claudeMcpServer.ts` — `update_plan_phase` handler

**核心机制**: 当 agent 调用 `update_plan_phase` 标记阶段完成时，tool response 不再只返回 `{success: true}`，而是额外携带下一阶段的关键约束。利用 MCP tool response 天然处于上下文末尾（LLM 注意力最强位置）的特点。

**匹配逻辑（两级）**:

```
1. 关键词匹配: nextPhase.name + nextPhase.goal → phase_hints[].keywords
   ↓ 失败
2. Unconditional fallback: 找到下一个 critical=true 且未被已完成阶段覆盖的 hint
```

**为什么需要 unconditional fallback**: LLM 注意力专家 review 指出关键词匹配的 miss rate 约 50%（agent 自命名 phase，可能用 "Deep Drill Analysis" 而非 "根因分析"）。Critical 阶段（如 scrolling Phase 1.9、startup Phase 2.6）太重要，不能因为命名不匹配而跳过提醒。

**响应示例**:

```json
{
  "success": true,
  "next_phase_reminder": {
    "phaseId": "p2",
    "name": "根因分析",
    "constraints": "对占比 >15% 且绝对帧数 >3 的 reason_code，必须选最严重帧执行深钻...",
    "criticalTools": ["jank_frame_detail", "blocking_chain_analysis", "lookup_knowledge"]
  }
}
```

**Token 成本**: ~50-80 token/次 × 3-6 次阶段转换/分析 = ~150-480 token/分析（对比总分析量 ~150K token，占 0.1-0.3%）

**风险**: 低。response 是 additive JSON，agent 忽略它也不影响现有行为。

---

### 改动 4: submit_plan Hard-Gate

**文件**: `backend/src/agentv3/claudeMcpServer.ts` — `submit_plan` handler

**Before**: 缺少必查项 → 返回 `success: true` + `sceneWarnings`（agent 可能忽略）
**After**: 缺少必查项 → 第 1 次返回 `success: false`（hard-gate 拒绝，不写入 plan）→ 第 2 次无论如何接受

**关键实现细节**:
- `planSubmitAttempts` 计数器在 `createClaudeMcpServer` 闭包中声明，per-analyze() 生命周期
- 第 1 次拒绝时**不写入** `analysisPlanRef.current`（Codex review 指出：否则第 2 次会走 "already submitted" 分支被直接拒绝）
- `revise_plan` 调用时重置 `planSubmitAttempts = 0`
- phases schema 增加 `.min(1)` 防止空数组

**新增场景模板**: memory, game, overview, touch-tracking（补全 SCENE_PLAN_TEMPLATES 从 6 → 10 场景）

**风险**: 中。hard-gate 拒绝消耗 1 个额外 SDK turn（~500 token + ~2s），但避免了事后发现遗漏 phase 导致的 correction retry（5-10 turns, ~10-20K token）。

---

### 改动 5: Compact Recovery Note 增强

**文件**: `backend/src/agentv3/claudeRuntime.ts`

**Before**: 只恢复 top-5 findings 的 severity + title
**After**: 优先级逐段构建：plan progress → next phase → findings → entity context

**Budget 机制**: `tryAdd(section)` — 每段构建后检查 800 字符上限，整段包含或整段跳过，不做 mid-section truncation。

**Section 优先级**:
1. `[上下文压缩恢复]` 标头（始终包含）
2. Plan progress — 各阶段状态 + 摘要（最高优先级）
3. Next phase — 当前/下一阶段的 goal 和预期工具
4. Key findings — confidence ≥ 0.5 的 top-5 发现
5. Entity context — 已知进程/线程名（最低优先级，可能被 budget 截断）

**Note section**: 从 `observation` 改为 `next_step`（在 system prompt 注入时按 priority 排序更靠前）

**风险**: 低。只在 SDK auto-compact 时触发（非常规路径），有 800 字符上限保护。

---

## 放弃的提案

### 1. Tier 4 动态内容迁出 System Prompt（KV Cache 优化）

**放弃原因**: SDK `systemPrompt` 是单一字符串，resume 时 prompt 是 user message，不适合塞 context。Tier 1-3 已形成 ~3000 token 稳定前缀，Tier 4 变化只影响 ~500-1000 token 尾部。收益 ~$0.001-0.003/turn，不值得架构重构。

### 2. LLM Verifier 改为 opt-in

**放弃原因**: `canSkipLLM` 已在 happy path 自动跳过。`learnFromVerificationResults` 是自我进化机制（LLM 发现的误诊模式回馈到启发式规则库）。Correction retry 恰恰最需要独立 LLM 验证。

### 3. 策略分层压缩（骨架 + 按需详细指引）

**放弃原因**: 策略核心价值在决策表（reason_code 分支路由、freeze_verdict 路由等），占 40-60% token 但不可省略。骨架化后 agent 可以正确排序 phase 但无法正确选择分支。Restatement 注入是更好的解法——不削弱策略内容，而是在关键时刻重申约束。

---

## 三方 Review 关键反馈

### Codex 架构审查
- LGTM with 3 concerns
- **Concern 1**: DETERMINISTIC_SCENES 建议用 `sceneType !== 'general'` → 未采纳（memory/game 等有 quick path）
- **Concern 2**: phaseKeywords 需中英文双语 → 已采纳（所有 keywords 都包含中英文）
- **Concern 3**: submit_plan 第 1 次拒绝不能写入 plan → 已采纳

### LLM 注意力专家
- Tool response 是最优注入位置 ✓
- 关键词匹配 miss rate ~50%，需要 unconditional fallback → 已采纳（`critical: true` 机制）
- constraints 应使用 strategy 原文（非改写）→ 已采纳（放在 frontmatter 中）
- 建议 `[策略提醒]` 前缀 → 部分采纳（在 JSON key 命名为 `next_phase_reminder`）

### 生产稳健性专家
- **发现预存 bug**: `scroll-response` 连字符 → 已修复
- **部分否决全面扩展**: memory/game/overview/touch-tracking 有合法 quick query → 已采纳
- **prompts.md 规则冲突**: phase hints 不能硬编码在 TS → 已采纳（改为 frontmatter）
- phases schema 需 `.min(1)` → 已采纳
- compact recovery 需优先级感知构建 → 已采纳（tryAdd budget 机制）
- 需要可观测性日志 → 已采纳（`[MCP] Phase hint injected/not found`、`[ClaudeRuntime] Compact recovery note`）

---

## 验证状态

| 检查项 | 状态 |
|--------|------|
| `npx tsc --noEmit` | PASS |
| `npm run validate:strategies` | 12/12 PASS |
| `npm run test:scene-trace-regression` (6 traces) | 6/6 PASS |
| `/simplify` code review | 1 fix (`<= 1` → `=== 1`) |

---

## 观察计划

这些改动上线后需要关注：

1. **Restatement 命中率**: 监控 `[MCP] Phase hint injected` vs `[MCP] Phase hint not found` 的比例。如果 not found 占比 >40%，说明 keywords 覆盖不够，需要扩充。
2. **submit_plan 拒绝率**: 如果大量分析的第 1 次 plan 被拒绝，说明 SCENE_PLAN_TEMPLATES 的 keywords 太严格，需要放宽。
3. **Compact recovery 触发频率**: 如果 compact 几乎不触发，Step 5 的改动价值有限但无害。
4. **跳过策略阶段的频率**: 通过 `verifyPlanAdherence` 和 `verifySceneCompleteness` 的 error 率来衡量改进效果。
