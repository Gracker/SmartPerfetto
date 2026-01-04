# 滑动分析分层输出设计

**日期**: 2025-01-04
**状态**: 设计已确认
**优先级**: 高

## 背景

当前 `scrolling_analysis` skill 的输出包含 12 个步骤，信息过于密集，用户难以快速定位问题。需要实现分层展示，让用户从宏观到微观渐进式地深入了解性能问题。

## 设计目标

1. **层次清晰**：从整体 FPS → 区间统计 → 区间详情 → 逐帧分析
2. **按需展开**：默认显示概要，用户点击展开详情
3. **数据完整**：后端返回完整数据，前端控制显示层级

## 四层结构

### L1 - 概览层（默认展开）
- 整体 FPS、掉帧率、评级（优秀/良好/一般/较差）
- 总帧数、掉帧数
- 应用掉帧 vs SF 掉帧的比例
- 最严重的掉帧类型 Top 3
- 滑动区间数量

### L2 - 区间层（默认展开）
- 每个滑动区间一行：区间 ID、时长、帧数、FPS、掉帧率、评级
- 可折叠/展开操作入口
- 用颜色/图标标识问题区间（红色=掉帧>15%，黄色=掉帧>5%）

### L3 - 区间详情层（默认折叠）
- **touch_fling**：整体统计（包含按压滑动和 fling）
- **fling_only**：纯 fling 部分统计
- 该区间掉帧帧列表（按严重程度排序，仅显示诊断摘要）

### L4 - 帧分析层（默认折叠）
- 每个掉帧帧的一行摘要：帧序号、耗时、一句话诊断
- 点击展开后显示完整的四大象限、Binder、CPU 等详细数据

## Display Level 映射

| 当前语义 | 新语义 | 层级 |
|---------|--------|------|
| `summary` | 概览 | L1 |
| `key` | 区间 | L2 |
| `detail` | 详情 | L3 + L4 |

### 步骤与层级的对应关系

**L1（概览层）**
- `environment` - 刷新率、帧数据状态
- `performance_summary` - 整体 FPS、掉帧率、评级
- `jank_type_stats` - 掉帧类型分布
- `global_summary` - AI 总结

**L2（区间层）**
- `scroll_sessions` - 滑动区间列表
- `session_jank_analysis` - 每个区间的掉帧统计

**L3（区间详情层）**
- `fps_metrics` - 返回两个维度：touch_fling 和 fling_only
- `jank_frames` - 该区间的掉帧帧列表（仅诊断摘要）

**L4（帧分析层）**
- `analyze_jank_frames` - iterator 调用 jank_frame_detail
  - 始终返回完整数据（摘要 + 详细分析）
  - 前端默认只显示诊断摘要

## 数据结构

### 新返回结构
```json
{
  "layers": {
    "L1": {
      "performance_summary": { "data": [...] },
      "global_summary": { "data": "..." }
    },
    "L2": {
      "scroll_sessions": { "data": [...] }
    },
    "L3": {
      "session_0": {
        "fps_metrics": { "data": [...] },
        "jank_frames": { "data": [...] }
      }
    },
    "L4": {
      "session_0": {
        "frame_42": {
          "diagnosis_summary": "主线程被锁阻塞 45ms",
          "full_analysis": { /* 四大象限等 */ }
        }
      }
    }
  },
  "defaultExpanded": ["L1", "L2"]
}
```

### 前端折叠状态
```typescript
interface LayerState {
  L1: boolean;      // 始终 true
  L2: boolean;      // 默认 true
  L3: Record<sessionId, boolean>;  // 默认 false
  L4: Record<frameId, boolean>;    // 默认 false
}
```

## 实施计划

### Phase 1：后端基础改动（低风险）
- [ ] 在 `scrolling_analysis.skill.yaml` 中为每个 step 添加 `display.layer` 字段
- [ ] 修改 `skillExecutorV2.ts` 解析并传递 `layer` 信息
- [ ] 保持现有返回格式不变，只增加 `layer` 字段
- [ ] 验证现有功能不受影响

### Phase 2：前端折叠组件（中风险）
- [ ] 创建 `LayeredResultView.tsx` 组件
- [ ] 实现基础的折叠/展开逻辑
- [ ] 验证新组件可以正确显示和折叠

### Phase 3：L4 摘要优化（中风险）
- [ ] 确保 `jank_frame_detail` 返回清晰的诊断摘要
- [ ] 前端默认只显示摘要，完整数据折叠

### Phase 4：数据结构重组（高风险）
- [ ] 后端按 layer 组织数据
- [ ] 前端适配新的数据格式
- [ ] 完整流程测试

### Phase 5：用户体验优化
- [ ] 添加展开/折叠动画
- [ ] 添加"全部展开"/"全部折叠"按钮
- [ ] 添加区间高亮
- [ ] 添加帧间导航

## 建议实施顺序

从 **Phase 1 + Phase 2** 开始：
- 后端改动最小（只加字段）
- 前端新建组件，不影响现有功能
- 快速验证分层展示的效果
