# Skill 类型契约系统设计

## 问题

前端后端数据格式不一致导致显示问题反复出现。根因是两边各自定义数据结构，没有单一数据源。

典型症状：前端显示"无详细数据"，实际是后端返回了数据但格式不匹配。

## 解决方案

**从 Skill YAML 自动生成 TypeScript 类型**，实现单一数据源。

```
Skill YAML (权威定义)
       ↓
代码生成器 (generate-skill-types.ts)
       ↓
shared/types/generated/*.ts (TypeScript 类型 + Zod Schema)
       ↓
┌──────────────┬──────────────┐
│   后端       │    前端      │
│ 输出时验证   │  输入时验证  │
└──────────────┴──────────────┘
```

## 设计详情

### 1. 增强 Skill YAML Schema

在每个 step 中添加 `output_schema` 字段：

```yaml
# backend/skills/composite/jank_frame_detail.skill.yaml

- id: quadrant_analysis
  type: atomic
  sql: |
    SELECT quadrant, dur_ms, percentage FROM ...
  save_as: quadrant_data
  output_schema:
    type: array
    items:
      quadrant: { type: string, description: "象限名称" }
      dur_ms: { type: number, description: "持续时间(ms)" }
      percentage: { type: number, description: "百分比" }
```

### 2. 目录结构

```
SmartPerfetto/
├── shared/
│   └── types/
│       └── generated/
│           ├── scrolling_analysis.types.ts
│           ├── jank_frame_detail.types.ts
│           └── index.ts
├── scripts/
│   ├── generate-skill-types.ts      # YAML → TypeScript 生成器
│   └── sync-types-to-frontend.ts    # 复制到前端目录
├── backend/
│   └── skills/
│       └── composite/*.skill.yaml   # 数据源
└── perfetto/ui/
    └── src/plugins/com.smartperfetto.AIAssistant/
        └── generated/               # 从 shared 复制过来
```

### 3. 生成的类型文件

```typescript
// shared/types/generated/jank_frame_detail.types.ts

import { z } from 'zod';

// ===== quadrant_analysis =====
export interface QuadrantAnalysisItem {
  quadrant: string;
  dur_ms: number;
  percentage: number;
}

export const QuadrantAnalysisItemSchema = z.object({
  quadrant: z.string(),
  dur_ms: z.number(),
  percentage: z.number(),
});

// ===== binder_calls =====
export interface BinderCallItem {
  interface: string;
  count: number;
  dur_ms: number;
  max_ms: number;
  sync_count: number;
}

export const BinderCallItemSchema = z.object({
  interface: z.string(),
  count: z.number(),
  dur_ms: z.number(),
  max_ms: z.number(),
  sync_count: z.number(),
});

// ===== 完整结果类型 =====
export interface JankFrameDetailResult {
  quadrant_data: QuadrantAnalysisItem[];
  binder_data: BinderCallItem[];
  freq_data: CpuFrequencyItem[];
  main_slices: MainThreadSliceItem[];
  render_slices: RenderThreadSliceItem[];
  // ...
}

export const JankFrameDetailResultSchema = z.object({
  quadrant_data: z.array(QuadrantAnalysisItemSchema),
  binder_data: z.array(BinderCallItemSchema).optional(),
  // ...
});
```

### 4. 后端集成

```typescript
// backend/src/services/skillEngine/skillExecutor.ts

import { getSchemaForStep } from 'shared/types/generated';

private validateStepOutput(stepId: string, skillId: string, data: unknown): void {
  const schema = getSchemaForStep(skillId, stepId);
  if (!schema) return; // 未定义 schema 的 step 跳过验证

  const result = schema.safeParse(data);

  if (!result.success) {
    const errorDetails = result.error.issues
      .map(i => `${i.path.join('.')}: ${i.message}`)
      .join(', ');

    console.error(
      `[SkillExecutor] Output validation failed for ${skillId}.${stepId}:`,
      errorDetails
    );

    if (process.env.NODE_ENV === 'development') {
      throw new Error(`Schema validation failed: ${errorDetails}`);
    }
  }
}
```

### 5. 前端集成

```typescript
// perfetto/ui/.../ai_panel.ts

import {
  JankFrameDetailResultSchema,
  type JankFrameDetailResult
} from './generated';

private convertToExpandableSections(data: unknown): Record<string, any> {
  const parsed = JankFrameDetailResultSchema.safeParse(data);

  if (!parsed.success) {
    const errors = parsed.error.issues
      .map(i => `${i.path.join('.')}: ${i.message}`)
      .join('\n');

    console.warn('[AIPanel] Data validation failed:', errors);

    // 开发模式：显示具体错误，而非静默失败
    return {
      _validation_error: {
        title: '⚠️ 数据格式错误',
        data: parsed.error.issues.map(i => ({
          field: i.path.join('.'),
          error: i.message,
          received: i.received,
        })),
      },
    };
  }

  // 类型安全地处理数据
  const result: JankFrameDetailResult = parsed.data;
  return this.transformToSections(result);
}
```

### 6. 开发流程整合

**scripts/start-dev.sh：**

```bash
#!/bin/bash
# scripts/start-dev.sh

echo "=== SmartPerfetto Dev Server ==="

# 1. 生成类型
echo "📝 Generating types from Skill YAML..."
cd backend && npm run types
cd ..

# 2. 启动后端
echo "🚀 Starting backend..."
cd backend && npm run dev &
BACKEND_PID=$!

# 3. 启动前端
echo "🎨 Starting frontend..."
cd perfetto/ui && ./run-dev-server &
FRONTEND_PID=$!

wait $BACKEND_PID $FRONTEND_PID
```

**backend/package.json：**

```json
{
  "scripts": {
    "generate-types": "ts-node ../scripts/generate-skill-types.ts",
    "sync-types": "ts-node ../scripts/sync-types-to-frontend.ts",
    "types": "npm run generate-types && npm run sync-types",
    "types:watch": "chokidar 'skills/**/*.yaml' -c 'npm run types'"
  }
}
```

### 7. CI 检查

```yaml
# .github/workflows/ci.yml

- name: Check generated types are up to date
  run: |
    npm run types --prefix backend
    git diff --exit-code shared/types/generated/
    if [ $? -ne 0 ]; then
      echo "Generated types are out of date. Run 'npm run types' and commit."
      exit 1
    fi
```

## 实施步骤

1. **Phase 1：基础设施**
   - 创建 `shared/types/` 目录结构
   - 编写 `generate-skill-types.ts` 生成器（基础版）
   - 编写 `sync-types-to-frontend.ts`
   - 整合到 `start-dev.sh`

2. **Phase 2：改造 jank_frame_detail.skill.yaml**
   - 为所有 step 添加 `output_schema`
   - 生成类型文件
   - 后端添加验证逻辑
   - 前端使用生成的类型

3. **Phase 3：推广到其他 Skill**
   - 改造 `scrolling_analysis.skill.yaml`
   - 改造其他常用 skill

4. **Phase 4：CI 集成**
   - 添加类型一致性检查
   - 文档更新

## 预期收益

| 指标 | 改进前 | 改进后 |
|------|--------|--------|
| 发现格式问题 | 运行时静默失败 | 编译时/启动时立即报错 |
| 错误信息 | "无详细数据" | "field X: expected number, got string" |
| 修复成本 | 需要调试定位 | 错误信息直接指出问题 |
| 新增 Skill | 容易忘记同步类型 | YAML 就是类型定义 |
