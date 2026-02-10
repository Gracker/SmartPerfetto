# SmartPerfetto 数据契约设计文档

## 问题陈述

当前系统的数据流存在以下问题：

1. **类型定义分散** - 后端有 `DisplayResult`、`LayeredResult`，前端有 `SqlQueryResult`，两边定义不一致
2. **字段名硬编码** - 前端写死了 `layer_name`、`process_name` 等字段名
3. **事件类型混乱** - `skill_data` 在前端被转换成 `skill_layered_result`
4. **缺少验证** - YAML 中的配置没有在运行时验证
5. **扩展困难** - 新增数据类型需要修改多处代码

## 完整数据流

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              数据流全景图                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌───────────┐  │
│  │ Skill YAML  │ ──► │ SkillLoader │ ──► │SkillExecutor│ ──► │ SSE Stream│  │
│  │ (定义层)    │     │ (加载验证)   │     │ (执行转换)  │     │ (传输层)  │  │
│  └─────────────┘     └─────────────┘     └─────────────┘     └───────────┘  │
│        │                                        │                    │       │
│        │                                        │                    │       │
│        ▼                                        ▼                    ▼       │
│  ┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌───────────┐  │
│  │ AI Service  │ ──► │ AI Response │ ──► │ Normalizer  │ ──► │ Frontend  │  │
│  │ (多轮对话)  │     │ (原始响应)   │     │ (标准化)    │     │ (消费层)  │  │
│  └─────────────┘     └─────────────┘     └─────────────┘     └───────────┘  │
│        │                                        │                    │       │
│        │                                        ▼                    │       │
│        │                                  ┌─────────────┐            │       │
│        └────────────────────────────────► │HTML Report  │ ◄──────────┘       │
│                                           │ (输出层)    │                    │
│                                           └─────────────┘                    │
└─────────────────────────────────────────────────────────────────────────────┘
```

## 设计目标

1. **Single Source of Truth** - 所有类型定义来自一个地方
2. **Schema-Driven** - 从 Schema 自动生成类型和验证
3. **Backward Compatible** - 新增字段不破坏现有功能
4. **Self-Describing** - 数据自带元信息，前端无需硬编码

## 2026-02-11 落地补充（与当前实现对齐）

以下补充反映当前代码中的真实实现，而不是理想化设计：

1. **Layered skill 结果会先解包再渲染**
   - 在 `strategy/layered` 流程中，`stepType: 'skill'` 可能包裹真实 `displayResults`。
   - `backend/src/services/skillEngine/skillAnalysisAdapter.ts` 会先解包嵌套结果，再做统一 `DisplayResult` 转换。

2. **列定义透传以 `columnDefinitions` 为准**
   - backend 从 `display.columns` 提取列定义并传入 sections。
   - frontend 在 `skill_layered_result` 路径归一化后继续按 `columnDefinitions` 渲染，不再依赖“从数据猜列”。

3. **时间单位双轨契约**
   - 展示层：统一 `ms`（`type: duration` + `format: duration_ms` + `unit: ms`）。
   - 跳转链路：保留 `ns`（`timestamp/duration` 原始字段仍标注 `unit: ns`），用于精确 range 定位。

4. **点击跳转的依赖列不可误删**
   - 当 `clickAction: navigate_range` 且存在 `durationColumn` 依赖时，即便该列默认隐藏，前端也必须保留其值用于跳转。
   - 位置：`perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/sse_event_handlers.ts`

```text
LayeredResult
  -> skillAnalysisAdapter.extractLayerStepData
  -> extractColumnDefinitions(display.columns)
  -> sections(columnDefinitions)
  -> SSE skill_layered_result
  -> frontend normalizeColumnDefinitions
  -> SqlResultTable format(ms) + navigate_range(ns)
```

## 核心设计：Universal Data Envelope

### 设计理念

所有数据都包装在一个「信封」(Envelope) 中传输，信封包含：
- **meta**: 元信息（类型、版本、来源）
- **data**: 实际数据
- **display**: 显示配置（前端如何渲染）

```typescript
/**
 * Universal Data Envelope - 所有数据的统一包装
 *
 * 设计原则：
 * 1. 自描述 - 包含渲染所需的所有信息
 * 2. 可扩展 - 新增字段通过 meta.version 控制
 * 3. 可验证 - runtime 可以验证结构
 */
interface DataEnvelope<T = any> {
  // ===== 元信息 =====
  meta: {
    /** 数据类型标识 */
    type: DataType;
    /** Schema 版本，用于兼容性检查 */
    version: string;
    /** 数据来源 */
    source: DataSource;
    /** 生成时间戳 */
    timestamp: number;
    /** 可选：关联的 Skill ID */
    skillId?: string;
    /** 可选：关联的 Session ID */
    sessionId?: string;
  };

  // ===== 实际数据 =====
  data: T;

  // ===== 显示配置（自描述） =====
  display: {
    /** UI 层级 */
    layer: DisplayLayer;
    /** 显示格式 */
    format: DisplayFormat;
    /** 标题 */
    title: string;
    /** 列定义（用于 table 格式） */
    columns?: ColumnDefinition[];
    /** 元数据字段（显示在表头而非列中） */
    metadataFields?: string[];
    /** 高亮规则 */
    highlights?: HighlightRule[];
    /** 是否可展开 */
    expandable?: boolean;
  };
}
```

### 数据类型枚举

```typescript
/**
 * 数据类型 - 标识数据的语义类型
 */
type DataType =
  | 'skill_result'      // Skill 执行结果
  | 'sql_result'        // SQL 查询结果
  | 'ai_response'       // AI 响应
  | 'diagnostic'        // 诊断发现
  | 'summary'           // 摘要
  | 'metric'            // 指标
  | 'timeline'          // 时间线
  | 'chart'             // 图表
  | 'error'             // 错误
  ;

/**
 * 数据来源 - 标识数据的产生者
 */
type DataSource =
  | 'skill_executor'    // Skill 执行器
  | 'ai_service'        // AI 服务
  | 'trace_processor'   // Trace 处理器
  | 'cross_domain'      // 跨领域专家
  | 'user_input'        // 用户输入
  ;

/**
 * 显示层级
 */
type DisplayLayer = 'overview' | 'list' | 'session' | 'deep';

/**
 * 显示格式
 */
type DisplayFormat = 'table' | 'text' | 'chart' | 'timeline' | 'metric' | 'summary';
```

### 列定义（自描述）

```typescript
/**
 * 列定义 - 前端根据这个配置渲染表格
 *
 * 关键：前端不再硬编码列名，而是根据这个定义动态渲染
 */
interface ColumnDefinition {
  /** 字段名（对应 data 中的 key） */
  field: string;
  /** 显示名称 */
  label: string;
  /** 数据类型（用于格式化） */
  type: ColumnType;
  /** 是否可排序 */
  sortable?: boolean;
  /** 是否可点击（如时间戳列可跳转） */
  clickable?: boolean;
  /** 点击动作类型 */
  clickAction?: 'navigate_time' | 'expand_detail' | 'open_link';
  /** 宽度（可选） */
  width?: string;
  /** 对齐方式 */
  align?: 'left' | 'center' | 'right';
  /** 格式化配置 */
  format?: {
    /** 数字精度 */
    precision?: number;
    /** 单位 */
    unit?: string;
    /** 数字格式化（如千分位） */
    style?: 'number' | 'percent' | 'duration' | 'bytes';
  };
}

type ColumnType =
  | 'string'
  | 'number'
  | 'timestamp'    // 纳秒时间戳，可点击跳转
  | 'duration'     // 时间长度
  | 'percent'
  | 'boolean'
  | 'severity'     // info/warning/critical
  | 'json'         // 可展开的 JSON
  ;
```

## 数据流转设计

### 1. Skill YAML → DataEnvelope

Skill YAML 中定义 display 配置：

```yaml
# scrolling_analysis.skill.yaml
steps:
  - id: frame_summary
    sql: "SELECT ..."
    display:
      layer: overview
      format: metric
      title: "帧统计概览"
      # 列定义（自描述）
      columns:
        - field: total_frames
          label: "总帧数"
          type: number
        - field: jank_rate
          label: "掉帧率"
          type: percent
          format:
            precision: 1
            unit: "%"
        - field: avg_frame_time
          label: "平均帧时间"
          type: duration
          format:
            unit: "ms"
      # 元数据字段（显示在表头）
      metadataFields:
        - layer_name
        - process_name
```

SkillExecutor 转换为 DataEnvelope：

```typescript
// SkillExecutor.ts
function convertStepResultToEnvelope(
  stepResult: StepResult,
  stepConfig: SkillStep,
  skillId: string
): DataEnvelope<TableData> {
  return {
    meta: {
      type: 'skill_result',
      version: '1.0',
      source: 'skill_executor',
      timestamp: Date.now(),
      skillId,
    },
    data: {
      columns: stepResult.columns,
      rows: stepResult.rows,
    },
    display: {
      layer: stepConfig.display?.layer || 'list',
      format: stepConfig.display?.format || 'table',
      title: stepConfig.display?.title || stepConfig.id,
      columns: stepConfig.display?.columns,
      metadataFields: stepConfig.display?.metadataFields,
      highlights: stepConfig.display?.highlights,
    },
  };
}
```

### 2. SQL 查询结果 → DataEnvelope

```typescript
// TraceProcessor 返回原始数据
interface RawQueryResult {
  columns: string[];
  rows: any[][];
}

// Normalizer 转换为 DataEnvelope
function wrapQueryResult(
  raw: RawQueryResult,
  displayConfig: DisplayConfig
): DataEnvelope<TableData> {
  return {
    meta: {
      type: 'sql_result',
      version: '1.0',
      source: 'trace_processor',
      timestamp: Date.now(),
    },
    data: {
      columns: raw.columns,
      rows: raw.rows,
    },
    display: displayConfig,
  };
}
```

### 3. AI 响应 → DataEnvelope

```typescript
// AI 服务返回
interface AIResponse {
  content: string;
  toolCalls?: ToolCall[];
  usage?: TokenUsage;
}

// 多轮对话中的 AI 响应
function wrapAIResponse(
  response: AIResponse,
  sessionId: string,
  turnNumber: number
): DataEnvelope<AIResponseData> {
  return {
    meta: {
      type: 'ai_response',
      version: '1.0',
      source: 'ai_service',
      timestamp: Date.now(),
      sessionId,
    },
    data: {
      content: response.content,
      toolCalls: response.toolCalls,
      turnNumber,
    },
    display: {
      layer: 'list',
      format: 'text',
      title: 'AI 分析',
    },
  };
}
```

### 4. 诊断发现 → DataEnvelope

```typescript
function wrapDiagnostic(
  diagnostic: DiagnosticResult,
  skillId: string
): DataEnvelope<DiagnosticData> {
  return {
    meta: {
      type: 'diagnostic',
      version: '1.0',
      source: 'skill_executor',
      timestamp: Date.now(),
      skillId,
    },
    data: {
      id: diagnostic.id,
      severity: diagnostic.severity,
      title: diagnostic.diagnosis,
      evidence: diagnostic.evidence,
      suggestions: diagnostic.suggestions,
      confidence: diagnostic.confidence,
    },
    display: {
      layer: 'overview',
      format: 'summary',
      title: diagnostic.diagnosis,
      highlights: [{
        condition: 'true',
        severity: diagnostic.severity,
      }],
    },
  };
}
```

## SSE 传输设计

### 统一的 SSE 事件格式

```typescript
/**
 * SSE 事件 - 所有事件都使用这个格式
 */
interface SSEEvent {
  /** 事件类型 */
  event: SSEEventType;
  /** 事件 ID（用于去重） */
  id: string;
  /** 数据（DataEnvelope 或 DataEnvelope 数组） */
  data: DataEnvelope | DataEnvelope[];
}

type SSEEventType =
  | 'data'          // 数据事件（通用）
  | 'progress'      // 进度事件
  | 'error'         // 错误事件
  | 'complete'      // 完成事件
  ;
```

### 批量数据传输

```typescript
/**
 * 批量数据包 - 一次传输多个 DataEnvelope
 */
interface BatchDataPacket {
  /** 批次 ID */
  batchId: string;
  /** Skill ID */
  skillId: string;
  /** 数据包列表（按层级组织） */
  envelopes: {
    overview: DataEnvelope[];
    list: DataEnvelope[];
    deep: DataEnvelope[];
  };
}
```

## 前端消费设计

### 通用渲染器

```typescript
// Frontend: DataRenderer.ts

/**
 * 根据 DataEnvelope 自动渲染
 * 前端不再硬编码任何字段名或格式
 */
function renderDataEnvelope(envelope: DataEnvelope): VNode {
  const { meta, data, display } = envelope;

  switch (display.format) {
    case 'table':
      return renderTable(data, display);
    case 'metric':
      return renderMetric(data, display);
    case 'chart':
      return renderChart(data, display);
    case 'text':
      return renderText(data, display);
    case 'summary':
      return renderSummary(data, display);
    case 'timeline':
      return renderTimeline(data, display);
    default:
      return renderFallback(data, display);
  }
}

/**
 * 渲染表格 - 完全由 display.columns 驱动
 */
function renderTable(data: TableData, display: DisplayConfig): VNode {
  // 从 display.columns 获取列定义
  const columns = display.columns || inferColumnsFromData(data);

  // 提取元数据（显示在表头）
  const metadata = extractMetadata(data.rows[0], display.metadataFields);

  // 渲染
  return m('div.data-table', [
    // 表头：标题 + 元数据
    m('div.table-header', [
      m('h3', display.title),
      renderMetadata(metadata),
    ]),
    // 表格主体
    m('table', [
      m('thead', renderTableHeader(columns)),
      m('tbody', data.rows.map(row => renderTableRow(row, columns))),
    ]),
  ]);
}

/**
 * 渲染表格行 - 根据列定义格式化
 */
function renderTableRow(row: any[], columns: ColumnDefinition[]): VNode {
  return m('tr', columns.map((col, idx) => {
    const value = row[idx];
    return m('td', {
      class: col.clickable ? 'clickable' : '',
      onclick: col.clickable ? () => handleColumnClick(col, value) : undefined,
    }, formatValue(value, col));
  }));
}

/**
 * 格式化值 - 根据列类型
 */
function formatValue(value: any, col: ColumnDefinition): string {
  switch (col.type) {
    case 'timestamp':
      return formatTimestamp(value);
    case 'duration':
      return formatDuration(value, col.format?.unit);
    case 'percent':
      return formatPercent(value, col.format?.precision);
    case 'number':
      return formatNumber(value, col.format);
    case 'severity':
      return renderSeverityBadge(value);
    default:
      return String(value);
  }
}
```

## HTML 报告设计

### 报告使用相同的 DataEnvelope

```typescript
// HTMLReportGenerator.ts

interface ReportInput {
  query: string;
  envelopes: DataEnvelope[];
  diagnostics: DataEnvelope[];
  summary: string;
}

function generateReport(input: ReportInput): string {
  const sections: string[] = [];

  // 按层级组织
  const byLayer = groupByLayer(input.envelopes);

  // 渲染 Overview 层
  if (byLayer.overview.length > 0) {
    sections.push(renderOverviewSection(byLayer.overview));
  }

  // 渲染 List 层
  if (byLayer.list.length > 0) {
    sections.push(renderListSection(byLayer.list));
  }

  // 渲染 Deep 层
  if (byLayer.deep.length > 0) {
    sections.push(renderDeepSection(byLayer.deep));
  }

  // 渲染诊断发现
  sections.push(renderDiagnosticsSection(input.diagnostics));

  return buildHTML(input.query, input.summary, sections);
}

/**
 * 渲染单个 DataEnvelope 为 HTML
 * 与前端使用相同的列定义
 */
function renderEnvelopeToHTML(envelope: DataEnvelope): string {
  const { data, display } = envelope;

  switch (display.format) {
    case 'table':
      return renderHTMLTable(data, display);
    case 'metric':
      return renderHTMLMetric(data, display);
    // ... 其他格式
  }
}
```

## 实现路径

### Phase 1: 定义核心类型 (dataContract.ts)

```
backend/src/types/dataContract.ts
├── DataEnvelope<T>        # 核心信封类型
├── DisplayConfig          # 显示配置
├── ColumnDefinition       # 列定义
├── DataType / DataSource  # 枚举
└── 验证函数               # validateEnvelope()
```

### Phase 2: 更新 Skill 系统

```
backend/src/services/skillEngine/
├── types.ts              # 引用 dataContract
├── skillLoader.ts        # 验证 display 配置
├── skillExecutor.ts      # 输出 DataEnvelope
└── normalizer.ts         # NEW: 统一转换层
```

### Phase 3: 更新 SSE 传输

```
backend/src/routes/agentRoutes.ts
└── 统一使用 DataEnvelope 格式
```

### Phase 4: 更新前端

```
perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/
├── types/dataContract.ts  # 从后端复制或共享
├── renderers/             # NEW: 通用渲染器
│   ├── TableRenderer.ts
│   ├── MetricRenderer.ts
│   └── ...
├── ai_panel.ts           # 使用 DataRenderer
└── sql_result_table.ts   # 重构为通用表格
```

### Phase 5: 更新 HTML 报告

```
backend/src/services/htmlReportGenerator.ts
└── 使用 DataEnvelope 生成报告
```

## 迁移策略

1. **向后兼容** - 新旧格式并行，逐步迁移
2. **Feature Flag** - 可配置使用新/旧数据格式
3. **渐进式** - 一个 Skill 一个 Skill 迁移

## 验证清单

- [ ] YAML 加载时验证 display 配置
- [ ] SkillExecutor 输出 DataEnvelope
- [ ] SSE 传输 DataEnvelope
- [ ] 前端正确解析 DataEnvelope
- [ ] HTML 报告正确渲染
- [ ] 多轮对话数据正确流转
- [ ] 新增字段无需修改前端代码

## 类型自动生成方案

### 目录结构

```
SmartPerfetto/
├── shared/                          # NEW: 共享类型包
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts                 # 导出所有类型
│       ├── dataContract.ts          # 核心数据契约
│       ├── display.ts               # 显示相关类型
│       ├── events.ts                # SSE 事件类型
│       └── validation.ts            # 运行时验证
│
├── backend/
│   ├── package.json                 # 依赖 @smartperfetto/shared
│   └── src/
│       └── ...
│
└── perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/
    ├── package.json                 # 依赖 @smartperfetto/shared
    └── types/
        └── index.ts                 # re-export from shared
```

### 自动生成流程

```bash
# 1. 定义类型 (shared/src/dataContract.ts)
# 2. 构建共享包
cd shared && npm run build

# 3. 自动生成前端类型
npm run generate:frontend-types

# 4. 后端引用
# backend/package.json: "@smartperfetto/shared": "file:../shared"

# 5. 前端引用（通过符号链接或构建时复制）
```

### 类型生成工具

```typescript
// scripts/generateFrontendTypes.ts
import * as ts from 'typescript';
import * as fs from 'fs';
import * as path from 'path';

/**
 * 从 shared/src 生成前端可用的类型文件
 *
 * 1. 读取 shared/src/*.ts
 * 2. 移除 Node.js 特定代码
 * 3. 输出到 perfetto/ui/src/plugins/.../types/
 */
function generateFrontendTypes() {
  const sharedDir = path.join(__dirname, '../shared/src');
  const outputDir = path.join(__dirname, '../perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/types/generated');

  // 确保输出目录存在
  fs.mkdirSync(outputDir, { recursive: true });

  // 复制类型文件（过滤掉 Node.js 特定代码）
  const files = ['dataContract.ts', 'display.ts', 'events.ts'];

  for (const file of files) {
    const content = fs.readFileSync(path.join(sharedDir, file), 'utf-8');
    const filtered = filterNodeSpecificCode(content);
    fs.writeFileSync(path.join(outputDir, file), filtered);
  }

  // 生成 index.ts
  const indexContent = files.map(f => `export * from './${f.replace('.ts', '')}';`).join('\n');
  fs.writeFileSync(path.join(outputDir, 'index.ts'), indexContent);

  console.log(`Generated frontend types in ${outputDir}`);
}

function filterNodeSpecificCode(content: string): string {
  // 移除 Node.js 特定的 import
  // 移除运行时验证代码（前端不需要）
  // 保留纯类型定义
  return content
    .replace(/import .* from ['"]fs['"];?\n?/g, '')
    .replace(/import .* from ['"]path['"];?\n?/g, '');
}
```

### npm scripts

```json
// package.json (root)
{
  "scripts": {
    "types:build": "cd shared && npm run build",
    "types:generate": "ts-node scripts/generateFrontendTypes.ts",
    "types:sync": "npm run types:build && npm run types:generate",
    "predev": "npm run types:sync"
  }
}
```

## 完整实现计划

### Phase 0: 创建 shared 包 (Day 1)

```
1. 创建 shared/ 目录结构
2. 定义核心类型 (DataEnvelope, DisplayConfig, ColumnDefinition)
3. 定义 SSE 事件类型
4. 定义验证函数
5. 配置构建和发布
```

### Phase 1: 后端改造 (Day 2-3)

```
1. SkillLoader 改造
   - 验证 display 配置
   - 解析列定义

2. SkillExecutor 改造
   - 输出 DataEnvelope
   - 统一所有数据源

3. MasterOrchestrator 改造
   - 使用 DataEnvelope
   - 统一 SSE 事件格式

4. AI Service 改造
   - AI 响应包装为 DataEnvelope
   - 多轮对话数据标准化
```

### Phase 2: SSE 传输改造 (Day 4)

```
1. 定义统一的 SSE 事件格式
2. 移除旧的事件类型 (skill_layered_result 等)
3. 实现批量传输
4. 添加事件去重
```

### Phase 3: 前端改造 (Day 5-6)

```
1. 集成 shared 类型
2. 实现通用渲染器
   - TableRenderer
   - MetricRenderer
   - ChartRenderer
   - TextRenderer
3. 移除硬编码字段名
4. 重构 sql_result_table.ts
5. 更新 ai_panel.ts
```

### Phase 4: HTML 报告改造 (Day 7)

```
1. 使用 DataEnvelope 生成报告
2. 复用前端渲染逻辑
3. 支持所有显示格式
```

### Phase 5: 迁移现有 Skills (Day 8-10)

```
1. 更新所有 YAML 文件
   - 添加 columns 定义
   - 添加 metadataFields
2. 测试每个 Skill
3. 验证前端显示
4. 验证 HTML 报告
```

## 验证清单

### 功能验证
- [ ] YAML display 配置完整解析
- [ ] DataEnvelope 正确生成
- [ ] SSE 正确传输
- [ ] 前端正确渲染 table 格式
- [ ] 前端正确渲染 metric 格式
- [ ] 前端正确渲染 chart 格式
- [ ] 元数据字段正确提取
- [ ] 高亮规则正确应用
- [ ] 时间戳列可点击跳转
- [ ] HTML 报告正确生成

### 兼容性验证
- [ ] 旧 Skill 格式仍可工作
- [ ] 前端无硬编码字段名
- [ ] 新增字段无需改代码

## 结论

通过 **DataEnvelope** 统一数据格式：
1. **后端** - 所有输出都包装成 DataEnvelope
2. **传输** - SSE 传输 DataEnvelope
3. **前端** - 根据 display 配置自动渲染
4. **报告** - 使用相同配置生成 HTML

**核心优势：**
- 前端不再硬编码任何字段名
- 新增字段只需修改 YAML
- display 配置即文档
- 类型自动同步，不会遗漏
