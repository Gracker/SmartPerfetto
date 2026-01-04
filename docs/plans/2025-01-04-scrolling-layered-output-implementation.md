# 滑动分析分层输出 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 实现滑动性能分析的四层分层展示，让用户从宏观到微观渐进式深入了解性能问题。

**Architecture:** 在现有 skill engine 基础上扩展 display.layer 字段，后端按层级组织数据，前端通过折叠/展开控制显示。

**Tech Stack:** TypeScript, YAML, React, skillEngine v2

---

## Task 1: 添加 display.layer 字段到 scrolling_analysis skill

**Files:**
- Modify: `backend/skills/v2/composite/scrolling_analysis.skill.yaml`

**Step 1: 为每个 step 添加 layer 字段**

在每个 step 的 display 中添加 layer 字段，明确指定层级：

```yaml
steps:
  # L1 - 概览层
  - id: detect_environment
    type: atomic
    name: "检测环境"
    display:
      level: summary
      layer: L1
      title: "环境信息"
    # ... 保持其他内容不变

  - id: frame_performance_summary
    type: atomic
    name: "帧性能汇总"
    display:
      level: key
      layer: L1
      title: "帧性能汇总"
    # ... 保持其他内容不变

  - id: global_summary
    type: ai_summary
    name: "分析总结"
    display:
      level: key
      layer: L1
      title: "滑动分析总结"
    # ... 保持其他内容不变

  # L2 - 区间层
  - id: scroll_sessions
    type: atomic
    name: "识别滑动区间"
    display:
      level: summary
      layer: L2
      title: "滑动区间"
    # ... 保持其他内容不变

  - id: session_jank_analysis
    type: atomic
    name: "区间掉帧分析"
    display:
      level: detail
      layer: L2
      title: "各区间掉帧分析"
    # ... 保持其他内容不变

  # L3 - 区间详情层
  - id: calculate_fps_by_phase
    type: atomic
    name: "计算 FPS"
    display:
      level: key
      layer: L3
      title: "FPS 指标（SurfaceFlinger 消费端）"
    # ... 保持其他内容不变

  - id: get_jank_frames
    type: atomic
    name: "获取掉帧信息"
    display:
      level: key
      layer: L3
      title: "掉帧详情（基于 FrameTimeline）"
    # ... 保持其他内容不变

  - id: jank_type_stats
    type: atomic
    name: "掉帧类型统计"
    display:
      level: key
      layer: L3
      title: "掉帧类型分布"
    # ... 保持其他内容不变

  # L4 - 帧分析层
  - id: get_app_jank_frames
    type: atomic
    name: "获取应用掉帧帧"
    display:
      level: detail
      layer: L4
      title: "应用掉帧帧列表"
    # ... 保持其他内容不变

  - id: analyze_jank_frames
    type: iterator
    name: "逐帧详细分析"
    display:
      level: key
      layer: L4
      title: "掉帧帧详细分析"
    # ... 保持其他内容不变
```

**Step 2: 验证 YAML 语法**

Run: `python -c "import yaml; yaml.safe_load(open('backend/skills/v2/composite/scrolling_analysis.skill.yaml'))"`
Expected: No errors

**Step 3: 提交**

```bash
git add backend/skills/v2/composite/scrolling_analysis.skill.yaml
git commit -m "feat: add display.layer field to scrolling_analysis skill"
```

---

## Task 2: 扩展 SkillExecutor 解析 layer 字段

**Files:**
- Modify: `backend/src/services/skillEngine/skillExecutorV2.ts`

**Step 1: 定义 Layer 类型**

在文件顶部的类型定义区域添加：

```typescript
export type DisplayLayer = 'L1' | 'L2' | 'L3' | 'L4';

export interface StepDisplayConfig {
  level: 'summary' | 'key' | 'detail';
  layer?: DisplayLayer;  // 新增
  title?: string;
  format?: string;
}
```

**Step 2: 修改 parseStepDisplay 函数**

找到 `parseStepDisplay` 函数（如果不存在则创建），添加对 layer 的解析：

```typescript
function parseStepDisplay(step: any): StepDisplayConfig {
  const display = step.display || {};
  return {
    level: display.level || 'detail',
    layer: display.layer || undefined,  // 新增
    title: display.title || step.name || '',
    format: display.format || 'table'
  };
}
```

**Step 3: 在 executeStep 中传递 layer 信息**

修改 `executeStep` 函数，确保 layer 信息被传递到结果中：

```typescript
async executeStep(
  step: SkillStep,
  context: ExecutionContext
): Promise<StepResult> {
  const display = parseStepDisplay(step);

  // ... 执行逻辑 ...

  return {
    stepId: step.id,
    data: result,
    display: {
      level: display.level,
      layer: display.layer,  // 确保返回
      title: display.title,
      format: display.format
    }
  };
}
```

**Step 4: 添加 TypeScript 编译检查**

Run: `cd backend && npm run build`
Expected: No type errors

**Step 5: 提交**

```bash
git add backend/src/services/skillEngine/skillExecutorV2.ts
git commit -m "feat: parse and return display.layer in skill executor"
```

---

## Task 3: 后端按 layer 组织返回数据

**Files:**
- Modify: `backend/src/services/skillEngine/skillExecutorV2.ts`
- Modify: `backend/src/services/skillEngine/skillAnalysisAdapterV2.ts`

**Step 1: 定义分层结果结构**

在 `skillExecutorV2.ts` 中添加新的类型：

```typescript
export interface LayeredResult {
  layers: {
    L1?: Record<string, StepResult>;
    L2?: Record<string, StepResult>;
    L3?: Record<string, Record<string, StepResult>>;
    L4?: Record<string, Record<string, StepResult>>;
  };
  defaultExpanded: ('L1' | 'L2' | 'L3' | 'L4')[];
  metadata: {
    skillName: string;
    version: string;
    executedAt: string;
  };
}
```

**Step 2: 添加 organizeByLayer 函数**

在 `skillExecutorV2.ts` 中添加数据组织函数：

```typescript
function organizeByLayer(steps: StepResult[]): LayeredResult['layers'] {
  const layers: LayeredResult['layers'] = {
    L1: {},
    L2: {},
    L3: {},
    L4: {}
  };

  for (const step of steps) {
    const layer = step.display.layer;
    if (!layer) continue;

    switch (layer) {
      case 'L1':
      case 'L2':
        layers[layer][step.stepId] = step;
        break;
      case 'L3':
        // L3 数据需要按 session_id 组织
        // 从 step.data 中提取 session_id
        const sessionId3 = extractSessionId(step);
        if (!layers.L3![sessionId3]) {
          layers.L3![sessionId3] = {};
        }
        layers.L3![sessionId3][step.stepId] = step;
        break;
      case 'L4':
        // L4 数据需要按 session_id 和 frame_id 组织
        const sessionId4 = extractSessionId(step);
        const frameId = extractFrameId(step);
        if (!layers.L4![sessionId4]) {
          layers.L4![sessionId4] = {};
        }
        layers.L4![sessionId4][frameId] = step;
        break;
    }
  }

  return layers;
}

function extractSessionId(step: StepResult): string {
  // 尝试从 step.data 中提取 session_id
  if (Array.isArray(step.data) && step.data.length > 0) {
    return `session_${step.data[0].session_id ?? 0}`;
  }
  return 'session_0';
}

function extractFrameId(step: StepResult): string {
  // 尝试从 step 中提取 frame_id
  if (step.stepId.startsWith('frame_')) {
    return step.stepId;
  }
  if (Array.isArray(step.data) && step.data.length > 0) {
    return `frame_${step.data[0].frame_index ?? step.data[0].frame_id ?? 0}`;
  }
  return 'frame_0';
}
```

**Step 3: 修改 executeCompositeSkill 返回分层结果**

修改 `executeCompositeSkill` 函数的返回部分：

```typescript
async executeCompositeSkill(
  skill: CompositeSkill,
  inputs: Record<string, any>,
  context: ExecutionContext
): Promise<LayeredResult> {
  // ... 执行所有 step ...

  const stepResults = await Promise.all(/* ... */);

  // 返回分层结构
  return {
    layers: organizeByLayer(stepResults),
    defaultExpanded: ['L1', 'L2'],
    metadata: {
      skillName: skill.name,
      version: skill.version,
      executedAt: new Date().toISOString()
    }
  };
}
```

**Step 4: 更新 adapter 处理新格式**

在 `skillAnalysisAdapterV2.ts` 中更新 adapter 函数：

```typescript
async adaptSkillResult(result: LayeredResult): Promise<AdaptedResult> {
  // 处理新的分层格式
  return {
    format: 'layered',
    layers: result.layers,
    defaultExpanded: result.defaultExpanded,
    metadata: result.metadata
  };
}
```

**Step 5: 添加 TypeScript 编译检查**

Run: `cd backend && npm run build`
Expected: No type errors

**Step 6: 提交**

```bash
git add backend/src/services/skillEngine/skillExecutorV2.ts backend/src/services/skillEngine/skillAnalysisAdapterV2.ts
git commit -m "feat: organize skill output by layer (L1/L2/L3/L4)"
```

---

## Task 4: 前端创建分层结果组件

**Files:**
- Create: `frontend/src/components/skill/LayeredResultView.tsx`
- Create: `frontend/src/components/skill/L1OverviewCard.tsx`
- Create: `frontend/src/components/skill/L2SessionList.tsx`
- Create: `frontend/src/components/skill/L3SessionDetail.tsx`
- Create: `frontend/src/components/skill/L4FrameAnalysis.tsx`

**Step 1: 创建 LayeredResultView 主组件**

创建 `frontend/src/components/skill/LayeredResultView.tsx`：

```typescript
import React, { useState } from 'react';
import { Collapse } from 'antd';
import L1OverviewCard from './L1OverviewCard';
import L2SessionList from './L2SessionList';
import L3SessionDetail from './L3SessionDetail';
import L4FrameAnalysis from './L4FrameAnalysis';

const { Panel } = Collapse;

interface LayeredResult {
  layers: {
    L1?: Record<string, any>;
    L2?: Record<string, any>;
    L3?: Record<string, Record<string, any>>;
    L4?: Record<string, Record<string, any>>;
  };
  defaultExpanded: ('L1' | 'L2' | 'L3' | 'L4')[];
  metadata: {
    skillName: string;
    version: string;
    executedAt: string;
  };
}

interface Props {
  result: LayeredResult;
}

const LayeredResultView: React.FC<Props> = ({ result }) => {
  const [expandedLayers, setExpandedLayers] = useState<Set<string>>(
    new Set(result.defaultExpanded)
  );

  const [expandedSessions, setExpandedSessions] = useState<Set<string>>(new Set());
  const [expandedFrames, setExpandedFrames] = useState<Set<string>>(new Set());

  const toggleLayer = (layer: string) => {
    const newExpanded = new Set(expandedLayers);
    if (newExpanded.has(layer)) {
      newExpanded.delete(layer);
    } else {
      newExpanded.add(layer);
    }
    setExpandedLayers(newExpanded);
  };

  const toggleSession = (sessionId: string) => {
    const newExpanded = new Set(expandedSessions);
    if (newExpanded.has(sessionId)) {
      newExpanded.delete(sessionId);
    } else {
      newExpanded.add(sessionId);
    }
    setExpandedSessions(newExpanded);
  };

  const toggleFrame = (frameId: string) => {
    const newExpanded = new Set(expandedFrames);
    if (newExpanded.has(frameId)) {
      newExpanded.delete(frameId);
    } else {
      newExpanded.add(frameId);
    }
    setExpandedFrames(newExpanded);
  };

  return (
    <div className="layered-result-view">
      {/* L1 - 概览层 */}
      {result.layers.L1 && expandedLayers.has('L1') && (
        <L1OverviewCard data={result.layers.L1} />
      )}

      {/* L2 - 区间层 */}
      {result.layers.L2 && expandedLayers.has('L2') && (
        <L2SessionList
          data={result.layers.L2}
          expandedSessions={expandedSessions}
          onToggleSession={toggleSession}
        />
      )}

      {/* L3 - 区间详情层 */}
      {result.layers.L3 && expandedSessions.size > 0 && (
        <Collapse ghost>
          {Array.from(expandedSessions).map(sessionId => (
            <Panel
              header={`区间 ${sessionId} 详情`}
              key={sessionId}
              forceRender
            >
              <L3SessionDetail
                data={result.layers.L3![sessionId] || {}}
                expandedFrames={expandedFrames}
                onToggleFrame={toggleFrame}
              />
            </Panel>
          ))}
        </Collapse>
      )}

      {/* L4 - 帧分析层 */}
      {result.layers.L4 && expandedFrames.size > 0 && (
        <Collapse ghost>
          {Array.from(expandedFrames).map(frameId => (
            <Panel
              header={`帧 ${frameId} 分析`}
              key={frameId}
              forceRender
            >
              <L4FrameAnalysis data={result.layers.L4![frameId]} />
            </Panel>
          ))}
        </Collapse>
      )}
    </div>
  );
};

export default LayeredResultView;
```

**Step 2: 创建 L1OverviewCard 组件**

创建 `frontend/src/components/skill/L1OverviewCard.tsx`：

```typescript
import React from 'react';
import { Card, Statistic, Row, Col, Tag } from 'antd';

interface Props {
  data: Record<string, any>;
}

const L1OverviewCard: React.FC<Props> = ({ data }) => {
  const performanceSummary = data.performance_summary?.data?.[0];
  const jankStats = data.jank_type_stats?.data || [];

  const getRatingColor = (rating: string) => {
    switch (rating) {
      case '优秀': return 'success';
      case '良好': return 'processing';
      case '一般': return 'warning';
      case '较差': return 'error';
      default: return 'default';
    }
  };

  return (
    <Card title="滑动性能概览" className="mb-4">
      <Row gutter={16}>
        <Col span={6}>
          <Statistic
            title="平均 FPS"
            value={performanceSummary?.avg_fps || 0}
            precision={1}
            suffix="fps"
          />
        </Col>
        <Col span={6}>
          <Statistic
            title="掉帧率"
            value={performanceSummary?.jank_rate || 0}
            precision={2}
            suffix="%"
          />
        </Col>
        <Col span={6}>
          <Statistic
            title="评级"
            value={performanceSummary?.rating || '-'}
            valueStyle={{ fontSize: 24 }}
          />
        </Col>
        <Col span={6}>
          <Statistic
            title="总帧数"
            value={performanceSummary?.total_frames || 0}
          />
        </Col>
      </Row>

      {/* 掉帧类型 Top 3 */}
      <div className="mt-4">
        <div className="text-gray-500 mb-2">主要掉帧类型</div>
        {jankStats.slice(0, 3).map((stat: any, idx: number) => (
          <Tag key={idx} color="orange" className="mr-2 mb-2">
            {stat.jank_type}: {stat.count} 次
          </Tag>
        ))}
      </div>
    </Card>
  );
};

export default L1OverviewCard;
```

**Step 3: 创建 L2SessionList 组件**

创建 `frontend/src/components/skill/L2SessionList.tsx`：

```typescript
import React from 'react';
import { Table, Tag } from 'antd';

interface Props {
  data: Record<string, any>;
  expandedSessions: Set<string>;
  onToggleSession: (sessionId: string) => void;
}

const L2SessionList: React.FC<Props> = ({ data, expandedSessions, onToggleSession }) => {
  const sessions = data.scroll_sessions?.data || [];
  const sessionJank = data.session_jank_analysis?.data || [];

  const getJankRateColor = (rate: number) => {
    if (rate > 15) return 'red';
    if (rate > 5) return 'orange';
    return 'green';
  };

  const columns = [
    {
      title: '区间 ID',
      dataIndex: 'session_id',
      key: 'session_id',
      width: 100,
    },
    {
      title: '时长',
      dataIndex: 'duration_ms',
      key: 'duration_ms',
      width: 100,
      render: (val: number) => `${val.toFixed(0)} ms`,
    },
    {
      title: '帧数',
      dataIndex: 'frame_count',
      key: 'frame_count',
      width: 80,
    },
    {
      title: 'FPS',
      dataIndex: 'avg_fps',
      key: 'avg_fps',
      width: 80,
      render: (_: any, record: any) => {
        const fps = 1000 / (record.avg_frame_ms || 16.67);
        return fps.toFixed(1);
      },
    },
    {
      title: '掉帧率',
      dataIndex: 'jank_rate',
      key: 'jank_rate',
      width: 100,
      render: (rate: number) => (
        <Tag color={getJankRateColor(rate)}>{rate.toFixed(1)}%</Tag>
      ),
    },
    {
      title: '操作',
      key: 'action',
      width: 80,
      render: (_: any, record: any) => {
        const sessionId = `session_${record.session_id}`;
        const isExpanded = expandedSessions.has(sessionId);
        return (
          <a onClick={() => onToggleSession(sessionId)}>
            {isExpanded ? '收起' : '展开'}
          </a>
        );
      },
    },
  ];

  // 合并数据
  const dataSource = sessions.map((session: any) => {
    const jankData = sessionJank.find((j: any) => j.session_id === session.session_id);
    return {
      ...session,
      jank_rate: jankData?.jank_rate || 0,
    };
  });

  return (
    <div className="mb-4">
      <h3 className="text-lg font-semibold mb-2">滑动区间</h3>
      <Table
        columns={columns}
        dataSource={dataSource}
        rowKey="session_id"
        size="small"
        pagination={false}
      />
    </div>
  );
};

export default L2SessionList;
```

**Step 4: 创建 L3SessionDetail 组件**

创建 `frontend/src/components/skill/L3SessionDetail.tsx`：

```typescript
import React from 'react';
import { Descriptions, Table, Tag } from 'antd';

interface Props {
  data: Record<string, any>;
  expandedFrames: Set<string>;
  onToggleFrame: (frameId: string) => void;
}

const L3SessionDetail: React.FC<Props> = ({ data, expandedFrames, onToggleFrame }) => {
  const fpsMetrics = data.fps_metrics?.data || [];
  const jankFrames = data.jank_frames?.data || [];

  // 处理 FPS 指标
  const touchFling = fpsMetrics.find((m: any) => m.phase === 'touch_fling');
  const flingOnly = fpsMetrics.find((m: any) => m.phase === 'fling_only');

  const columns = [
    {
      title: '帧序号',
      dataIndex: 'frame_number',
      key: 'frame_number',
      width: 80,
    },
    {
      title: '阶段',
      dataIndex: 'phase',
      key: 'phase',
      width: 80,
    },
    {
      title: '耗时',
      dataIndex: 'dur_ms',
      key: 'dur_ms',
      width: 80,
      render: (val: number) => `${val.toFixed(1)} ms`,
    },
    {
      title: '诊断',
      dataIndex: 'diagnosis',
      key: 'diagnosis',
      ellipsis: true,
    },
    {
      title: '操作',
      key: 'action',
      width: 80,
      render: (_: any, record: any) => {
        const frameId = `frame_${record.frame_number}`;
        const isExpanded = expandedFrames.has(frameId);
        return (
          <a onClick={() => onToggleFrame(frameId)}>
            {isExpanded ? '收起' : '详情'}
          </a>
        );
      },
    },
  ];

  return (
    <div>
      {/* FPS 指标 */}
      <Descriptions title="FPS 指标" bordered size="small" column={2}>
        <Descriptions.Item label="整体 FPS">
          <Tag color="blue">{touchFling?.fps?.toFixed(1) || '-'} fps</Tag>
          <span className="ml-2 text-gray-500">(包含 touch + fling)</span>
        </Descriptions.Item>
        <Descriptions.Item label="Fling FPS">
          <Tag color="purple">{flingOnly?.fps?.toFixed(1) || '-'} fps</Tag>
          <span className="ml-2 text-gray-500">(纯惯性阶段)</span>
        </Descriptions.Item>
      </Descriptions>

      {/* 掉帧帧列表 */}
      <h4 className="mt-4 mb-2">掉帧帧列表</h4>
      <Table
        columns={columns}
        dataSource={jankFrames}
        rowKey="frame_number"
        size="small"
        pagination={false}
      />
    </div>
  );
};

export default L3SessionDetail;
```

**Step 5: 创建 L4FrameAnalysis 组件**

创建 `frontend/src/components/skill/L4FrameAnalysis.tsx`：

```typescript
import React from 'react';
import { Descriptions, Card, Alert } from 'antd';

interface Props {
  data: any;
}

const L4FrameAnalysis: React.FC<Props> = ({ data }) => {
  const diagnosisSummary = data.diagnosis_summary || '暂无诊断';
  const fullAnalysis = data.full_analysis || {};

  // 四大象限数据
  const quadrants = fullAnalysis.quadrants || {};

  return (
    <div>
      {/* 诊断摘要 */}
      <Alert
        message="诊断摘要"
        description={diagnosisSummary}
        type="info"
        showIcon
        className="mb-4"
      />

      {/* 完整分析 */}
      <Card title="详细分析" size="small">
        {/* 四大象限 */}
        {quadrants.main_thread && (
          <Descriptions title="主线程四大象限" bordered size="small" column={2}>
            <Descriptions.Item label="Q1 (大核运行)">
              {quadrants.main_thread.q1?.toFixed(1) || 0}%
            </Descriptions.Item>
            <Descriptions.Item label="Q2 (小核运行)">
              {quadrants.main_thread.q2?.toFixed(1) || 0}%
            </Descriptions.Item>
            <Descriptions.Item label="Q3 (Runnable)">
              {quadrants.main_thread.q3?.toFixed(1) || 0}%
            </Descriptions.Item>
            <Descriptions.Item label="Q4 (Sleeping)">
              {quadrants.main_thread.q4?.toFixed(1) || 0}%
            </Descriptions.Item>
          </Descriptions>
        )}

        {/* Binder 调用 */}
        {fullAnalysis.binder_calls && fullAnalysis.binder_calls.length > 0 && (
          <Descriptions title="Binder 调用" bordered size="small" className="mt-4">
            <Descriptions.Item label="同步调用次数">
              {fullAnalysis.binder_calls.filter((c: any) => c.is_sync).length}
            </Descriptions.Item>
            <Descriptions.Item label="最大耗时">
              {Math.max(...fullAnalysis.binder_calls.map((c: any) => c.dur_ms)).toFixed(1)} ms
            </Descriptions.Item>
          </Descriptions>
        )}

        {/* CPU 频率 */}
        {fullAnalysis.cpu_frequency && (
          <Descriptions title="CPU 频率" bordered size="small" className="mt-4">
            <Descriptions.Item label="大核平均频率">
              {fullAnalysis.cpu_frequency.big_avg_mhz || 0} MHz
            </Descriptions.Item>
            <Descriptions.Item label="小核平均频率">
              {fullAnalysis.cpu_frequency.little_avg_mhz || 0} MHz
            </Descriptions.Item>
          </Descriptions>
        )}
      </Card>
    </div>
  );
};

export default L4FrameAnalysis;
```

**Step 6: 提交**

```bash
git add frontend/src/components/skill/
git commit -m "feat: add layered result view components (L1/L2/L3/L4)"
```

---

## Task 5: 集成到主结果展示组件

**Files:**
- Modify: `frontend/src/components/AnalysisResult.tsx` (或相应的结果展示组件)

**Step 1: 导入 LayeredResultView**

在主结果组件中添加：

```typescript
import LayeredResultView from './skill/LayeredResultView';
```

**Step 2: 检测结果格式并渲染**

修改渲染逻辑：

```typescript
const AnalysisResult: React.FC<Props> = ({ result }) => {
  // 检测是否为分层格式
  if (result.format === 'layered') {
    return <LayeredResultView result={result} />;
  }

  // 原有的渲染逻辑
  return <OldResultView result={result} />;
};
```

**Step 3: 提交**

```bash
git add frontend/src/components/AnalysisResult.tsx
git commit -m "feat: integrate layered result view into main display"
```

---

## Task 6: 测试与验证

**Files:**
- Test: 手动测试或创建测试文件

**Step 1: 启动后端**

Run: `cd backend && npm run dev`

**Step 2: 启动前端**

Run: `cd frontend && npm run dev`

**Step 3: 上传包含滑动数据的 trace 文件**

- 使用包含滑动操作的 Perfetto trace
- 触发 scrolling_analysis skill

**Step 4: 验证分层显示**

检查：
- [ ] L1 概览层正确显示整体 FPS、掉帧率
- [ ] L2 区间层默认展开，显示所有区间
- [ ] 点击区间后 L3 正确展开，显示 touch_fling 和 fling_only FPS
- [ ] 点击掉帧帧后 L4 正确展开，显示诊断摘要
- [ ] 再次点击后显示完整四大象限等数据

**Step 5: 提交**

```bash
git add .
git commit -m "test: verify layered output works correctly"
```

---

## Task 7: 添加用户体验优化

**Files:**
- Modify: `frontend/src/components/skill/LayeredResultView.tsx`

**Step 1: 添加"全部展开"/"全部折叠"按钮**

```typescript
const LayeredResultView: React.FC<Props> = ({ result }) => {
  // ... existing code ...

  const expandAll = () => {
    setExpandedLayers(new Set(['L1', 'L2', 'L3', 'L4']));
    const allSessions = Object.keys(result.layers.L3 || {});
    const allFrames = Object.keys(result.layers.L4 || {});
    setExpandedSessions(new Set(allSessions));
    setExpandedFrames(new Set(allFrames));
  };

  const collapseAll = () => {
    setExpandedLayers(new Set(['L1', 'L2']));
    setExpandedSessions(new Set());
    setExpandedFrames(new Set());
  };

  return (
    <div className="layered-result-view">
      <div className="mb-2">
        <Button size="small" onClick={expandAll} className="mr-2">
          全部展开
        </Button>
        <Button size="small" onClick={collapseAll}>
          全部折叠
        </Button>
      </div>
      {/* ... rest of component ... */}
    </div>
  );
};
```

**Step 2: 添加区间高亮**

修改 L2SessionList：

```typescript
const L2SessionList: React.FC<Props> = ({ data, expandedSessions, onToggleSession }) => {
  // ... existing code ...

  return (
    <div className="mb-4">
      <h3 className="text-lg font-semibold mb-2">滑动区间</h3>
      <Table
        columns={columns}
        dataSource={dataSource}
        rowKey="session_id"
        size="small"
        pagination={false}
        rowClassName={(record) => {
          const sessionId = `session_${record.session_id}`;
          return expandedSessions.has(sessionId) ? 'bg-blue-50' : '';
        }}
      />
    </div>
  );
};
```

**Step 3: 提交**

```bash
git add frontend/src/components/skill/LayeredResultView.tsx frontend/src/components/skill/L2SessionList.tsx
git commit -m "feat: add UX enhancements (expand/collapse all, highlight active session)"
```

---

## Task 8: 编写文档

**Files:**
- Create: `docs/features/layered-skill-output.md`

**Step 1: 创建功能文档**

```markdown
# 分层 Skill 输出

## 概述

Skill 输出支持分层展示，帮助用户从宏观到微观渐进式了解分析结果。

## 层级结构

- **L1 - 概览层**：整体指标、评级
- **L2 - 区间层**：各区间概览
- **L3 - 区间详情层**：单个区间的详细统计
- **L4 - 帧分析层**：逐帧深度分析

## 使用方式

在 skill 定义中添加 `display.layer` 字段：

```yaml
steps:
  - id: my_step
    display:
      level: summary
      layer: L1  # 指定层级
      title: "我的步骤"
```

## 前端渲染

使用 `LayeredResultView` 组件渲染分层结果：

```tsx
import LayeredResultView from './components/skill/LayeredResultView';

<LayeredResultView result={layeredResult} />
```
```

**Step 2: 提交**

```bash
git add docs/features/layered-skill-output.md
git commit -m "docs: add layered skill output documentation"
```

---

## Summary

完成以上所有任务后，滑动分析 skill 将支持四层分层展示：

1. ✅ 后端扩展 display.layer 字段
2. ✅ 数据按层级组织
3. ✅ 前端支持折叠/展开
4. ✅ 用户体验优化

用户可以先看到整体 FPS 和关键问题，然后逐步展开查看区间详情和逐帧分析。
