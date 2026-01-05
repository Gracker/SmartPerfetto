# Scrolling Skill 分层架构设计 v3.0

## 设计目标

1. **清晰的分层**: L1 概览 → L2 区间列表 → L4 帧详情
2. **数据流一致**: 后端输出结构与前端期望完全匹配
3. **渐进式展示**: 用户从整体到局部逐步深入

## 三层架构

```
┌─────────────────────────────────────────────────────────────────┐
│                         L1: 全局概览                             │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  平均 FPS: 58.3    掉帧率: 3.2%    评级: 良好    总帧数: 1234  │   │
│  │  主要掉帧类型: App Deadline Missed (15), Buffer Stuffing (8)  │   │
│  └─────────────────────────────────────────────────────────┘   │
├─────────────────────────────────────────────────────────────────┤
│                       L2: 滑动区间列表                           │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  区间 ID │ 时长      │ 帧数 │ FPS  │ 掉帧率 │ 操作        │   │
│  │  1      │ 1234 ms  │ 72   │ 58.3 │ 2.8%  │ [展开 ▼]    │   │
│  │  2      │ 856 ms   │ 51   │ 59.6 │ 3.9%  │ [展开 ▼]    │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                  │
│  [展开区间 1 后]                                                  │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  该区间的掉帧帧 (3)                                         │   │
│  │  ├─ 帧 #12345 - App Deadline Missed (24.5ms) [展开 ▼]     │   │
│  │  ├─ 帧 #12350 - Buffer Stuffing (18.2ms)     [展开 ▼]     │   │
│  │  └─ 帧 #12358 - Self Jank (32.1ms)           [展开 ▼]     │   │
│  └─────────────────────────────────────────────────────────┘   │
├─────────────────────────────────────────────────────────────────┤
│                       L4: 帧详细分析                             │
│  [展开帧 #12345 后]                                              │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  诊断摘要: 主线程 Binder 调用耗时过长 (8.5ms)                  │   │
│  │                                                           │   │
│  │  四大象限:                                                  │   │
│  │  ┌─────────────────┬─────────────────┐                    │   │
│  │  │ Q1 大核: 45.2%  │ Q2 小核: 12.3%  │                    │   │
│  │  ├─────────────────┼─────────────────┤                    │   │
│  │  │ Q3 Runnable: 8.1%│ Q4 Sleep: 34.4% │                    │   │
│  │  └─────────────────┴─────────────────┘                    │   │
│  │                                                           │   │
│  │  Binder 调用: 3 次, 最大 8.5ms                              │   │
│  │  CPU 频率: 大核 2100MHz, 小核 1200MHz                       │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

## 数据结构定义

### LayeredResult 接口

```typescript
interface LayeredResult {
  layers: {
    L1: {
      // 只包含概览数据
      performance_summary: StepResult;  // 帧性能汇总
      jank_type_stats: StepResult;      // 掉帧类型统计
    };
    L2: {
      // 区间列表数据
      scroll_sessions: StepResult;      // 滑动区间列表
      session_jank: StepResult;         // 每个区间的掉帧统计
    };
    L4: {
      // 按 session_id 和 frame_id 组织的帧详情
      [sessionId: string]: {
        [frameId: string]: {
          stepId: string;
          data: {
            diagnosis_summary: string;
            full_analysis: {
              quadrants: {
                main_thread: { q1: number; q2: number; q3: number; q4: number };
                render_thread?: { q1: number; q2: number; q3: number; q4: number };
              };
              binder_calls: Array<{
                server_process: string;
                call_count: number;
                total_ms: number;
                max_ms: number;
              }>;
              cpu_frequency: {
                big_avg_mhz: number;
                little_avg_mhz: number;
              };
              main_thread_slices: Array<{
                name: string;
                dur_ms: number;
                count: number;
              }>;
            };
          };
          display: {
            title: string;
            level: string;
            layer: string;
          };
        };
      };
    };
  };
  defaultExpanded: ('L1' | 'L2')[];
  metadata: {
    skillName: string;
    version: string;
    executedAt: string;
  };
}
```

## YAML 步骤与 Layer 映射

### scrolling_analysis.skill.yaml

| Step ID | 用途 | Layer | 前端消费 |
|---------|------|-------|---------|
| `detect_environment` | 环境检测 | 内部使用 | 不展示 |
| `get_frames_from_stdlib` | 获取帧数据 | 内部使用 | 不展示 |
| `performance_summary` | **帧性能汇总** | **L1** | L1OverviewCard |
| `jank_type_stats` | **掉帧类型统计** | **L1** | L1OverviewCard |
| `scroll_sessions` | **滑动区间列表** | **L2** | L2SessionList |
| `session_jank` | **区间掉帧统计** | **L2** | L2SessionList |
| `get_app_jank_frames` | 获取应用掉帧帧 | 内部使用 | 作为 iterator source |
| `analyze_jank_frames` | **帧详细分析 (iterator)** | **L4** | L4FrameAnalysis |

### jank_frame_detail.skill.yaml

| Step ID | 用途 | 前端字段映射 |
|---------|------|-------------|
| `frame_info` | 帧基本信息 | 用于 title |
| `main_thread_slices` | 主线程耗时操作 | `full_analysis.main_thread_slices` |
| `binder_calls` | Binder 调用 | `full_analysis.binder_calls` |
| `cpu_core_analysis` | 大小核分析 | 用于 quadrants 计算 |
| `cpu_freq_analysis` | CPU 频率 | `full_analysis.cpu_frequency` |
| `quadrant_analysis` | 四大象限 | `full_analysis.quadrants` |
| `frame_diagnosis` | 帧诊断 | `diagnosis_summary` |

## 前端组件期望的数据

### L1OverviewCard

```typescript
// 期望从 result.layers.L1 获取:
const performanceSummary = data.performance_summary?.data?.[0];
// {
//   avg_fps: 58.3,
//   jank_rate: 3.2,
//   rating: '良好',
//   total_frames: 1234,
//   janky_frames: 40,
//   app_jank_rate: 2.1,
//   sf_jank_rate: 1.1,
// }

const jankStats = data.jank_type_stats?.data;
// [
//   { jank_type: 'App Deadline Missed', count: 15, total_dur_ms: 120.5 },
//   { jank_type: 'Buffer Stuffing', count: 8, total_dur_ms: 65.2 },
// ]
```

### L2SessionList

```typescript
// 期望从 result.layers.L2 获取:
const sessions = data.scroll_sessions?.data;
// [
//   { session_id: 1, duration_ms: 1234, frame_count: 72, avg_frame_ms: 17.1 },
//   { session_id: 2, duration_ms: 856, frame_count: 51, avg_frame_ms: 16.8 },
// ]

const sessionJank = data.session_jank?.data;
// [
//   { session_id: 1, janky_count: 2, jank_rate: 2.8, jank_types: 'App Deadline...' },
//   { session_id: 2, janky_count: 2, jank_rate: 3.9, jank_types: 'Buffer Stuffing' },
// ]
```

### L4FrameAnalysis

```typescript
// 期望从 result.layers.L4[sessionId][frameId].data 获取:
{
  diagnosis_summary: '主线程 Binder 调用耗时过长 (8.5ms)',
  full_analysis: {
    quadrants: {
      main_thread: { q1: 45.2, q2: 12.3, q3: 8.1, q4: 34.4 },
      render_thread: { q1: 52.1, q2: 8.5, q3: 5.2, q4: 34.2 },
    },
    binder_calls: [
      { server_process: 'system_server', call_count: 3, total_ms: 12.5, max_ms: 8.5 },
    ],
    cpu_frequency: {
      big_avg_mhz: 2100,
      little_avg_mhz: 1200,
    },
    main_thread_slices: [
      { name: 'Choreographer#doFrame', dur_ms: 18.5, count: 1 },
      { name: 'measure', dur_ms: 8.2, count: 3 },
    ],
  },
}
```

## 实现计划

1. **重写 scrolling_analysis.skill.yaml**
   - 精简步骤，明确每个步骤的 layer
   - 移除不必要的 display 配置
   - 统一 stepId 命名规范

2. **重写 jank_frame_detail.skill.yaml**
   - 确保输出结构可以被 transformL4FrameAnalysis 正确转换
   - stepId 必须与 transformL4FrameAnalysis 中的 case 匹配

3. **修复 skillExecutorV2.ts**
   - 修复 transformL4FrameAnalysis 函数中的 stepId 匹配
   - 确保 organizeByLayer 正确分组数据

4. **更新前端组件**
   - 更新数据键名以匹配新的 stepId
   - 添加必要的空值检查
