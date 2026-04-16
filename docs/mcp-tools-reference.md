# SmartPerfetto MCP Tools Reference

> 20 个 MCP 工具的完整参考文档。Claude 通过这些工具与 trace 数据交互。

---

## 概览

SmartPerfetto 通过 MCP (Model Context Protocol) 向 Claude 暴露最多 20 个工具，分为四类：

| 类别 | 数量 | 说明 | Plan 门控 |
|------|------|------|-----------|
| **核心数据访问** | 8 | 始终可用 | execute_sql / invoke_skill 需先 submit_plan |
| **规划与假设** | 8 | 按需启用 (enableAgentDefinitions) | — |
| **记忆与模式** | 1 | 始终可用 | — |
| **对比模式** | 3 | 双 trace 对比时启用 (referenceTraceId) | — |

**注意：** 非全分析模式（Lightweight Mode）下仅提供 3 个工具：execute_sql、invoke_skill、lookup_sql_schema，所有规划/假设/笔记工具不可用。

### 工具调用生命周期

```
Claude 想调用工具
    │
    ├─ submit_plan 了吗?
    │   ├─ 否 → execute_sql / invoke_skill 被阻止, 其他工具正常
    │   └─ 是 → 所有工具可用
    │
    ├─ Claude 调用 MCP 工具
    │   └─ claudeMcpServer 处理 → 返回结构化结果
    │
    └─ 结果附带 ReAct 推理提示 (~20 tokens)
        → Claude 继续推理
```

---

## 核心数据访问工具 (8 个)

### 1. execute_sql

执行 Perfetto SQL 查询。

| 字段 | 值 |
|------|-----|
| **用途** | 对 trace_processor 执行原始 SQL |
| **使用时机** | 没有匹配 Skill 时的补充查询 |
| **门控** | 需先 submit_plan |

**参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `sql` | string | 是 | Perfetto SQL 查询 |
| `summary` | boolean | 否 | `true` 返回统计摘要而非全量数据 (默认 false) |

**返回值：**

```typescript
// 正常模式
{ success, columns, rows, totalRows, truncated, durationMs }
// rows 最多 200 行，超出 truncated=true

// 摘要模式 (summary=true)
{ success, mode: 'summary', totalRows, columns,
  columnStats: [{ min, max, avg, p50, p90, p95, p99, nullCount }],
  sampleRows,  // 10 个最有代表性的行
  durationMs }
```

**行为特点：**
- SQL 执行错误会被记录，后续成功的相似查询自动匹配为"错误-修复对"（Jaccard 相似度 >30%）
- 错误-修复对持久化到 `logs/sql_learning/error_fix_pairs.json`（30 天 TTL，最多 200 对）
- 结果超 200 行自动截断

---

### 2. invoke_skill

执行 YAML Skill 分析管线。

| 字段 | 值 |
|------|-----|
| **用途** | 运行预定义的分析流水线，返回分层结果 |
| **使用时机** | 大多数分析场景的首选工具 |
| **门控** | 需先 submit_plan |

**参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `skillId` | string | 是 | Skill 标识符 (如 `scrolling_analysis`) |
| `params` | Record<string, any> | 否 | 传入参数: process_name, start_ts, end_ts, max_frames_per_session 等 |

**返回值：**

```typescript
// Artifact 模式 (默认)
{
  success, skillId, skillName,
  artifacts: [{
    artifactId: "art-1",
    summary: "487 rows, columns: [frame_id, duration_ms, reason]"
  }],
  diagnosticsArtifactId?,
  synthesizeArtifacts?,
  hint: "Use fetch_artifact(artifactId='art-1') to page through"
}

// 非 Artifact 模式 (向后兼容)
{
  success, skillId, skillName,
  displayResults: [{ stepId, title, layer, data }],
  diagnostics, synthesizeData
}
```

**行为特点：**
- `process_name` 未提供时自动填充当前 packageName
- `process_name` 和 `package` 双向同步（YAML 兼容性）
- 检测到厂商覆盖时附带 `vendorOverrideHint`
- Artifact 存储有 LRU 上限（50 个），超出自动淘汰最旧条目
- 通过 SSE 实时发送 DataEnvelope 到前端

---

### 3. list_skills

列出所有可用 Skill。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `category` | string | 否 | 按类别过滤 (scrolling/startup/cpu/memory/...) |

**返回值：**

```typescript
[{
  id: "scrolling_analysis",
  displayName: "滑动性能分析",
  description: "...",
  type: "composite",
  keywords: ["滑动", "卡顿", "jank", "fps", "scroll"]  // top 5
}]
```

---

### 4. detect_architecture

检测当前 trace 的渲染架构。

**无参数。**

**返回值：**

```typescript
{
  type: "FLUTTER",           // STANDARD | FLUTTER | COMPOSE | WEBVIEW | ...
  confidence: 0.92,
  evidence: [{ source, type, weight }],
  flutter?: { engine, renderMode },
  compose?: { recompositionDetected },
  webview?: { engine },
  cached?: true              // 如果使用缓存结果
}
```

**使用建议：** 在分析早期调用，结果会影响策略选择和架构模板注入。

---

### 5. lookup_sql_schema

搜索 Perfetto SQL stdlib 索引。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `keyword` | string | 是 | 搜索关键词 (如 "jank", "slice", "android_frames") |

**返回值：**

```typescript
{
  totalMatches: 15,
  entries: [{
    name: "android_jank_cuj",
    type: "view",           // view | table | function | macro
    category: "android",
    description: "...",
    columns?: [...],        // 列定义
    params?: [...]          // 函数参数
  }]
}
```

**匹配算法：** Token 级模糊匹配 — 关键词拆分后独立匹配，精确子串匹配得 10 分，token 前缀匹配得 0.5 分/token。返回 top 30。

---

### 6. query_perfetto_source

搜索 Perfetto stdlib 源码。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `keyword` | string | 是 | 表名、函数名、列名或 SQL 模式 |
| `max_results` | number | 否 | 最多返回文件数 (默认 5) |

**返回值：**

```typescript
{
  success: true,
  keyword: "android_jank_cuj",
  matchedFiles: 3,
  results: [{
    file: "perfetto/src/.../android/jank/cuj.sql",
    matchCount: 5,
    matches: [
      "-- line before",
      "CREATE PERFETTO VIEW android_jank_cuj AS ...",  // 匹配行
      "-- line after"
    ]
  }]
}
```

**搜索范围：** `perfetto/src/trace_processor/perfetto_sql/stdlib/**/*.sql`，每个文件最多 8 个匹配。

---

### 7. list_stdlib_modules

列出 Perfetto stdlib 模块。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `namespace` | string | 否 | 命名空间前缀过滤 (如 "android", "sched") |

**返回值：**

```typescript
// 无过滤: 按命名空间汇总 (节省 ~1500 tokens)
{ totalModules: 240, namespaces: ["android", "sched", ...],
  modules: { "android": 45, "sched": 12, ... } }

// 有过滤: 完整模块列表
{ totalModules: 45, modules: ["android.frames.timeline", "android.binder", ...] }
```

**预加载模块（trace 启动时自动加载）：** `android.frames.*`, `android.binder*`, `android.startup.*`, `sched.*`, `android.surfaceflinger`, `android.gpu.frequency`

---

### 8. lookup_knowledge

加载性能分析背景知识。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `topic` | string | 是 | 知识主题 |

**可用主题：**

| Topic | 内容 |
|-------|------|
| `rendering-pipeline` | Android 渲染管线：HWUI/Skia/Vulkan + SurfaceFlinger 合成 |
| `binder-ipc` | Binder IPC 机制：同步/异步调用、阻塞模式、线程池 |
| `gc-dynamics` | GC 机制：Concurrent Copying、暂停模式、堆压力 |
| `cpu-scheduler` | CPU 调度：CFS、EAS、大小核、Runnable 排队 |
| `thermal-throttling` | 温控：频率限制、功率预算、thermal zone |
| `lock-contention` | 锁竞争：futex、mutex、Monitor、优先级反转 |

**来源：** `backend/strategies/knowledge-{topic}.template.md`

---

## 规划与假设工具 (8 个)

### 9. submit_plan

提交分析计划。**必须在 execute_sql / invoke_skill 之前调用。**

**参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `phases` | array | 是 | 分析阶段列表 |
| `phases[].id` | string | 是 | 阶段 ID (如 "p1") |
| `phases[].name` | string | 是 | 阶段名称 |
| `phases[].goal` | string | 是 | 该阶段目标 |
| `phases[].expectedTools` | string[] | 是 | 预期使用的工具列表 |
| `successCriteria` | string | 是 | 整体成功标准 |

**场景模板验证（hard-gate）：** 提交后会检查计划是否覆盖当前场景的必查项：

| 场景 | 必查项 |
|------|--------|
| scrolling | frame/jank/scroll 分析 + 根因诊断 |
| startup | 启动时间 + 阶段分解 + 启动类型验证 |
| anr | ANR 原因定位 |
| teaching | 架构检测 + 管线教学 |
| pipeline | 架构检测 + 管线展示 |
| scroll_response | 输入事件定位 + 延迟分解 |
| memory | 内存使用趋势/GC 分析 |
| game | 帧率分析/GPU 状态 |
| overview | 场景检测 + 深钻 |
| touch-tracking | 逐帧 Input-to-Display 延迟 |

**行为：** 第 1 次提交缺少必查项 → 返回 `success: false` + `missingAspects`（hard-gate 拒绝）。第 2 次提交无论如何接受（防止死循环）。

---

### 10. update_plan_phase

更新阶段状态。**同时执行 Restatement 注入**——当存在下一个 pending 阶段时，response 会携带该阶段的关键约束和推荐工具（从 strategy frontmatter 的 `phase_hints` 加载），利用 tool response 在上下文末尾的高注意力位置重申策略约束。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `phaseId` | string | 是 | 阶段 ID |
| `status` | enum | 是 | `in_progress` / `completed` / `skipped` |
| `summary` | string | 否* | 完成/跳过时**必填**：关键证据或原因 |

*summary 不足 15 字时返回质量警告。

**Restatement 响应字段（自动注入）：**

| 字段 | 说明 |
|------|------|
| `next_phase_reminder.constraints` | 下一阶段的关键约束（从 strategy `phase_hints` 匹配） |
| `next_phase_reminder.criticalTools` | 下一阶段推荐的核心工具 |
| `next.expectedTools` | 无 hint 匹配时的 fallback：phase 自身声明的预期工具 |

匹配逻辑：先按 `phase_hints[].keywords` 关键词匹配 → 匹配失败时 unconditional fallback 到下一个 `critical: true` 的未覆盖 hint。

---

### 11. revise_plan

中途修订计划。保留已完成阶段和审计轨迹。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `reason` | string | 是 | 为什么需要修订 |
| `updatedPhases` | array | 是 | 更新后的阶段列表（已完成的必须保留） |
| `updatedSuccessCriteria` | string | 否 | 更新后的成功标准 |

**约束：** 原计划中已 completed 的阶段必须保留，否则报错。修订记录包含 `previousPhases` + `revisedAt`。

---

### 12. submit_hypothesis

提交可验证的假设。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `statement` | string | 是 | 假设陈述 (如 "RenderThread 被 Binder 阻塞导致掉帧") |
| `basis` | string | 否 | 提出依据 (如 "观察到 3 帧 RenderThread 处于 sleeping") |

返回 `hypothesisId`（如 "h1"），用于后续 `resolve_hypothesis`。

---

### 13. resolve_hypothesis

确认或否定假设。**结论前所有假设必须 resolve。**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `hypothesisId` | string | 是 | 假设 ID (如 "h1") |
| `status` | enum | 是 | `confirmed` / `rejected` |
| `evidence` | string | 是 | 支持该结论的证据 |

---

### 14. write_analysis_note

写入分析笔记。抗 context compression — 在 SDK 自动压缩上下文时仍然保留。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `section` | enum | 是 | `hypothesis` / `finding` / `observation` / `next_step` |
| `content` | string | 是 | 笔记内容 |
| `priority` | enum | 否 | `high` / `medium` / `low` (默认 medium) |

**淘汰策略（超 20 条时）：** 优先淘汰 `next_step`（短期） → `low` 优先级（最旧） → `medium`（最旧） → `high`（最旧）

---

### 15. fetch_artifact

分级获取 Skill 结果数据。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `artifactId` | string | 是 | Artifact ID (如 "art-1") |
| `detail` | enum | 否 | `summary` / `rows` / `full` (默认 summary) |
| `offset` | number | 否 | 分页偏移 (仅 rows 模式) |
| `limit` | number | 否 | 分页大小 (仅 rows 模式，默认 50，最大 200) |

**Detail 级别：**

| 级别 | 返回内容 | Token 消耗 |
|------|---------|-----------|
| `summary` | 行数 + 列名 + 首行 + 统计 | ~440 |
| `rows` | 分页数据行 (offset/limit) | ~50/行 |
| `full` | 完整原始数据 (最多 500 行) | 较高 |

---

### 16. flag_uncertainty

标记不确定性。**非阻塞** — 分析继续进行，用户实时看到标记。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `topic` | string | 是 | 不确定的方面 |
| `assumption` | string | 是 | 采用的假设 |
| `question` | string | 是 | 希望问用户的问题 |

通过 SSE 实时推送到前端（带 ⚠️ 标记），用户可在下一轮对话中澄清。

---

## 记忆与模式工具 (1 个)

### 17. recall_patterns

查询跨会话分析模式记忆。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `architectureType` | string | 否 | 架构类型 (如 "flutter_surfaceview") |
| `sceneType` | string | 否 | 场景类型 (如 "scrolling") |
| `keywords` | string[] | 否 | 领域关键词 (如 ["jank", "binder"]) |

**返回值：**

```typescript
{
  positivePatterns: [{
    sceneType, architectureType,
    score: 85,            // 匹配度 0-100
    insights: ["...", "...", "..."],  // top 3 洞察
    matchCount: 5
  }],
  negativePatterns: [{
    type: "sql_error",
    approach: "...",
    reason: "...",
    workaround: "..."
  }],
  learnedMisdiagnosis: [{     // 自动学习的误诊模式
    keywords: ["thermal"],
    message: "thermal throttling often misdiagnosed when...",
    occurrences: 3
  }]
}
```

**记忆来源：**
- 正面模式：来自成功分析 (200 条上限, 60 天 TTL, 频率加权)
- 负面模式：来自失败的 SQL/工具/策略/验证 (30 天 TTL)
- 误诊模式：自动从验证失败中提取 (≥2 次出现, 60 天 TTL)

---

---

## 对比模式工具 (3 个)

> 仅在双 trace 对比模式下可用（请求中提供了 `referenceTraceId`）。

### 18. execute_sql_on

对指定 trace 执行 SQL 查询（当前 trace 或参考 trace）。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `trace` | enum | 是 | `'current'` 或 `'reference'` — 指定在哪个 trace 上执行 |
| `sql` | string | 是 | Perfetto SQL 查询 |
| `summary` | boolean | 否 | `true` 返回统计摘要 (默认 false) |

**使用时机：** 需要单独查询某一侧 trace 的数据，而非通过 `compare_skill` 批量对比。

---

### 19. compare_skill

对当前 trace 和参考 trace 并行执行同一 Skill，返回并排对比结果。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `skillId` | string | 是 | 要执行的 Skill ID |
| `params` | Record<string, any> | 否 | Skill 参数 |

**返回值：**

```typescript
{
  success: true,
  current: { /* 当前 trace 的 Skill 结果 */ },
  reference: { /* 参考 trace 的 Skill 结果 */ },
  schemaAligned: true  // 两侧结果的列结构是否对齐
}
```

**使用时机：** 对比两个 trace 的同一指标（如滑动帧率、启动耗时），是对比分析的首选工具。

---

### 20. get_comparison_context

获取两个 trace 的元数据对比信息。

**无参数。**

**返回值：**

```typescript
{
  current: { traceId, device, duration, ... },
  reference: { traceId, device, duration, ... },
  diff: { /* 元数据差异摘要 */ }
}
```

**使用时机：** 对比分析开始时，先了解两个 trace 的基本信息差异（设备、时长、采集配置等）。

---

## 自动学习机制

非显式工具，而是内置在 execute_sql 和 verify 流程中的自动学习机制：

- **SQL 错误-修复对**：execute_sql 失败 → 记录错误 → 后续成功查询匹配 → 持久化到 `logs/sql_learning/error_fix_pairs.json`（30 天 TTL，最多 200 对）
- **误诊模式提取**：验证发现 issue → 提取关键词 → 出现 ≥2 次 → 加入启发式检查
- **模式记忆保存**：分析完成且 confidence > 0.3 → 保存为正面模式

---

## 工具使用优先级

Claude 在 system prompt 中收到的工具优先级指导：

```
invoke_skill > lookup_sql_schema > execute_sql > list_skills > detect_architecture
```

1. **优先用 invoke_skill** — 预定义管线，结果更丰富、更稳定
2. **不确定表名时用 lookup_sql_schema** — 发现可用的 stdlib 表/视图
3. **Skill 不覆盖时用 execute_sql** — 补充查询，但需注意 SQL 正确性
4. **用 list_skills 发现能力** — 按 category 过滤，找到匹配的 Skill
5. **用 detect_architecture 确定方向** — 不同架构的分析路径不同
