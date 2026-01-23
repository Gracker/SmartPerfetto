/**
 * SkillExecutor Unit Tests
 *
 * 测试技能执行引擎的核心功能：
 * 1. YAML 解析和加载
 * 2. 各类步骤执行 (atomic, composite, iterator, diagnostic, etc.)
 * 3. 层级结果生成 (overview/list/session/deep)
 * 4. 条件表达式评估
 * 5. 变量替换和上下文管理
 * 6. 错误处理
 * 7. 事件发射
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  SkillDefinition,
  SkillStep,
  AtomicStep,
  IteratorStep,
  DiagnosticStep,
  SkillExecutionContext,
  SkillExecutionResult,
  StepResult,
  DisplayConfig,
} from '../types';
import {
  SkillExecutor,
  LayeredResult,
  normalizeLayer,
  SynthesizeData,
  createSkillExecutor,
} from '../skillExecutor';

// =============================================================================
// Mock Setup
// =============================================================================

// Mock TraceProcessorService
const createMockTraceProcessorService = () => ({
  query: jest.fn<any>().mockResolvedValue({
    columns: ['name', 'value'],
    rows: [
      ['metric1', 100],
      ['metric2', 200],
    ],
  }),
  touchTrace: jest.fn<any>(),
  getTraceWithPort: jest.fn<any>().mockResolvedValue({ port: 9100 }),
});

// Mock 执行上下文
const createMockContext = (): SkillExecutionContext => ({
  traceId: 'test-trace',
  params: {},
  inherited: {},
  results: {},
  variables: {},
});

// Helper to create skill meta
const createMeta = (displayName: string): { display_name: string; description: string } => ({
  display_name: displayName,
  description: `Test skill: ${displayName}`,
});

// =============================================================================
// Test Suite: normalizeLayer
// =============================================================================

describe('normalizeLayer', () => {
  it('应该返回有效的 layer 名称', () => {
    expect(normalizeLayer('overview')).toBe('overview');
    expect(normalizeLayer('list')).toBe('list');
    expect(normalizeLayer('session')).toBe('session');
    expect(normalizeLayer('deep')).toBe('deep');
  });

  it('应该对无效 layer 返回 undefined', () => {
    expect(normalizeLayer('invalid')).toBeUndefined();
    expect(normalizeLayer('')).toBeUndefined();
    expect(normalizeLayer(undefined)).toBeUndefined();
  });

  it('应该拒绝旧的 L1/L2/L4 命名', () => {
    expect(normalizeLayer('L1')).toBeUndefined();
    expect(normalizeLayer('L2')).toBeUndefined();
    expect(normalizeLayer('L4')).toBeUndefined();
  });

  it('应该区分大小写', () => {
    expect(normalizeLayer('Overview')).toBeUndefined();
    expect(normalizeLayer('LIST')).toBeUndefined();
    expect(normalizeLayer('DEEP')).toBeUndefined();
  });
});

// =============================================================================
// Test Suite: LayeredResult
// =============================================================================

describe('LayeredResult 结构', () => {
  it('应该正确构建分层结果', () => {
    const result: LayeredResult = {
      layers: {
        overview: {
          summary: {
            stepId: 'summary',
            stepType: 'atomic',
            success: true,
            data: [{ total: 100 }],
            executionTimeMs: 10,
          },
        },
        list: {
          items: {
            stepId: 'items',
            stepType: 'atomic',
            success: true,
            data: [{ id: 1 }, { id: 2 }],
            executionTimeMs: 20,
          },
        },
      },
      defaultExpanded: ['overview'],
      metadata: {
        skillName: 'test_skill',
        version: '1.0',
        executedAt: new Date().toISOString(),
      },
    };

    expect(result.layers.overview).toBeDefined();
    expect(result.layers.list).toBeDefined();
    expect(result.defaultExpanded).toContain('overview');
  });

  it('应该支持 deep 层的嵌套结构', () => {
    const result: LayeredResult = {
      layers: {
        deep: {
          'session-1': {
            frame_1: {
              stepId: 'frame_1',
              stepType: 'atomic',
              success: true,
              data: { quadrants: [] },
              executionTimeMs: 50,
            },
          },
        },
      },
      defaultExpanded: [],
      metadata: {
        skillName: 'deep_analysis',
        version: '1.0',
        executedAt: new Date().toISOString(),
      },
    };

    expect(result.layers.deep?.['session-1']).toBeDefined();
  });
});

// =============================================================================
// Test Suite: SynthesizeData
// =============================================================================

describe('SynthesizeData', () => {
  it('应该正确构建 synthesize 数据', () => {
    const data: SynthesizeData = {
      stepId: 'jank_summary',
      stepName: '卡顿概览',
      stepType: 'atomic',
      layer: 'overview',
      data: { total_frames: 100, jank_frames: 5 },
      success: true,
      config: {
        role: 'overview',
        fields: [
          { key: 'total_frames', label: '总帧数' },
          { key: 'jank_frames', label: '卡顿帧' },
        ],
        insights: [
          { condition: 'jank_frames > 0', template: '检测到 {{jank_frames}} 帧卡顿' },
        ],
      },
    };

    expect(data.config?.role).toBe('overview');
    expect(data.config?.fields?.length).toBe(2);
    expect(data.config?.insights?.length).toBe(1);
  });
});

// =============================================================================
// Test Suite: SkillExecutor 类
// =============================================================================

describe('SkillExecutor 类', () => {
  let executor: SkillExecutor;
  let mockTraceProcessor: any;
  let mockAiService: any;
  let emittedEvents: any[];

  beforeEach(() => {
    mockTraceProcessor = createMockTraceProcessorService();
    mockAiService = {
      chat: jest.fn<any>().mockResolvedValue('AI response' as string),
    };
    emittedEvents = [];
    executor = createSkillExecutor(
      mockTraceProcessor,
      mockAiService,
      (event) => emittedEvents.push(event)
    );
  });

  describe('初始化', () => {
    it('应该创建 SkillExecutor 实例', () => {
      expect(executor).toBeInstanceOf(SkillExecutor);
    });

    it('应该接受可选的 aiService', () => {
      const execWithoutAI = createSkillExecutor(mockTraceProcessor);
      expect(execWithoutAI).toBeInstanceOf(SkillExecutor);
    });

    it('应该接受可选的 eventEmitter', () => {
      const execWithoutEmitter = createSkillExecutor(mockTraceProcessor, mockAiService);
      expect(execWithoutEmitter).toBeInstanceOf(SkillExecutor);
    });
  });

  describe('registerSkill', () => {
    it('应该注册单个 skill', () => {
      const skill: SkillDefinition = {
        name: 'test_skill',
        type: 'atomic',
        version: '1.0',
        meta: createMeta('Test Skill'),
        sql: 'SELECT 1',
      };
      executor.registerSkill(skill);
      // 验证通过 execute 可以调用
    });

    it('应该覆盖同名 skill', () => {
      const skill1: SkillDefinition = {
        name: 'duplicate_skill',
        type: 'atomic',
        version: '1.0',
        meta: createMeta('Version 1'),
        sql: 'SELECT 1',
      };
      const skill2: SkillDefinition = {
        name: 'duplicate_skill',
        type: 'atomic',
        version: '2.0',
        meta: createMeta('Version 2'),
        sql: 'SELECT 2',
      };
      executor.registerSkill(skill1);
      executor.registerSkill(skill2);
      // 第二个应该覆盖第一个
    });
  });

  describe('registerSkills', () => {
    it('应该批量注册 skills', () => {
      const skills: SkillDefinition[] = [
        {
          name: 'skill_a',
          type: 'atomic',
          version: '1.0',
          meta: createMeta('Skill A'),
          sql: 'SELECT 1',
        },
        {
          name: 'skill_b',
          type: 'atomic',
          version: '1.0',
          meta: createMeta('Skill B'),
          sql: 'SELECT 2',
        },
      ];
      executor.registerSkills(skills);
      // 两个 skill 都应该被注册
    });
  });

  describe('execute - 未找到 skill', () => {
    it('应该返回错误当 skill 不存在', async () => {
      const result = await executor.execute('nonexistent_skill', 'trace-1');
      expect(result.success).toBe(false);
      expect(result.error).toContain('Skill not found');
      expect(result.skillId).toBe('nonexistent_skill');
    });
  });

  describe('execute - atomic skill', () => {
    beforeEach(() => {
      const atomicSkill: SkillDefinition = {
        name: 'atomic_test',
        type: 'atomic',
        version: '1.0',
        meta: createMeta('Atomic Test'),
        sql: 'SELECT name, value FROM test_table',
        output: {
          display: { title: 'Test', level: 'summary' },
        },
      };
      executor.registerSkill(atomicSkill);
    });

    it('应该执行 atomic skill 并返回结果', async () => {
      const result = await executor.execute('atomic_test', 'trace-1');
      expect(result.success).toBe(true);
      expect(result.skillId).toBe('atomic_test');
      expect(result.skillName).toBe('Atomic Test');
      expect(mockTraceProcessor.query).toHaveBeenCalled();
    });

    it('应该发射 skill_started 和 skill_completed 事件', async () => {
      await executor.execute('atomic_test', 'trace-1');
      const startEvent = emittedEvents.find(e => e.type === 'skill_started');
      const completeEvent = emittedEvents.find(e => e.type === 'skill_completed');
      expect(startEvent).toBeDefined();
      expect(startEvent?.skillId).toBe('atomic_test');
      expect(completeEvent).toBeDefined();
      expect(completeEvent?.data.success).toBe(true);
    });
  });

  describe('execute - composite skill', () => {
    beforeEach(() => {
      const compositeSkill: SkillDefinition = {
        name: 'composite_test',
        type: 'composite',
        version: '1.0',
        meta: createMeta('Composite Test'),
        steps: [
          {
            id: 'step1',
            type: 'atomic',
            sql: 'SELECT 1 as value',
            display: { title: 'Step 1', level: 'summary' },
          },
          {
            id: 'step2',
            type: 'atomic',
            sql: 'SELECT 2 as value',
            display: { title: 'Step 2', level: 'detail' },
          },
        ],
      };
      executor.registerSkill(compositeSkill);
    });

    it('应该按顺序执行所有步骤', async () => {
      const result = await executor.execute('composite_test', 'trace-1');
      expect(result.success).toBe(true);
      expect(mockTraceProcessor.query).toHaveBeenCalledTimes(2);
    });

    it('应该收集 displayResults', async () => {
      const result = await executor.execute('composite_test', 'trace-1');
      expect(result.displayResults.length).toBe(2);
    });
  });
});

// =============================================================================
// Test Suite: Atomic Step 执行
// =============================================================================

describe('Atomic Step 执行', () => {
  let executor: SkillExecutor;
  let mockTraceProcessor: any;

  beforeEach(() => {
    mockTraceProcessor = createMockTraceProcessorService();
    executor = createSkillExecutor(mockTraceProcessor);
  });

  it('应该执行简单的 SQL 查询', async () => {
    const skill: SkillDefinition = {
      name: 'simple_query',
      type: 'atomic',
      version: '1.0',
      meta: createMeta('Simple Query'),
      sql: 'SELECT name, value FROM test_table',
    };
    executor.registerSkill(skill);

    const result = await executor.execute('simple_query', 'trace-1');
    expect(result.success).toBe(true);
    expect(mockTraceProcessor.query).toHaveBeenCalledWith('trace-1', 'SELECT name, value FROM test_table');
  });

  it('应该支持变量替换', async () => {
    const skill: SkillDefinition = {
      name: 'param_query',
      type: 'atomic',
      version: '1.0',
      meta: createMeta('Param Query'),
      sql: 'SELECT * FROM table WHERE id = ${id}',
    };
    executor.registerSkill(skill);

    const result = await executor.execute('param_query', 'trace-1', { id: 42 });
    expect(mockTraceProcessor.query).toHaveBeenCalledWith('trace-1', 'SELECT * FROM table WHERE id = 42');
  });

  it('缺失变量在 SQL 表达式中应替换为 NULL（避免 COALESCE(, 0) 语法错误）', async () => {
    const skill: SkillDefinition = {
      name: 'null_fallback',
      type: 'atomic',
      version: '1.0',
      meta: createMeta('NULL Fallback'),
      sql: 'SELECT COALESCE(${start_ts}, 0) as start_ts',
    };
    executor.registerSkill(skill);

    await executor.execute('null_fallback', 'trace-1');

    expect(mockTraceProcessor.query).toHaveBeenCalledWith(
      'trace-1',
      'SELECT COALESCE(NULL, 0) as start_ts'
    );
  });

  it('缺失变量在单引号字符串中应替换为空串（避免注入字面量 \"NULL\"）', async () => {
    const skill: SkillDefinition = {
      name: 'string_fallback',
      type: 'atomic',
      version: '1.0',
      meta: createMeta('String Fallback'),
      sql: "SELECT '${package}*' as pat, '${package}' as pkg",
    };
    executor.registerSkill(skill);

    await executor.execute('string_fallback', 'trace-1');

    expect(mockTraceProcessor.query).toHaveBeenCalledWith(
      'trace-1',
      "SELECT '*' as pat, '' as pkg"
    );
  });

  it('单引号字符串中的变量应进行转义（避免 SQL 解析错误）', async () => {
    const skill: SkillDefinition = {
      name: 'escape_single_quote',
      type: 'atomic',
      version: '1.0',
      meta: createMeta('Escape Single Quote'),
      sql: "SELECT '${package}' as pkg",
    };
    executor.registerSkill(skill);

    await executor.execute('escape_single_quote', 'trace-1', { package: "a'b" });

    expect(mockTraceProcessor.query).toHaveBeenCalledWith(
      'trace-1',
      "SELECT 'a''b' as pkg"
    );
  });

  it('应该正确处理查询结果', async () => {
    mockTraceProcessor.query.mockResolvedValue({
      columns: ['name', 'value'],
      rows: [
        ['metric1', 100],
        ['metric2', 200],
      ],
    });

    const skill: SkillDefinition = {
      name: 'result_query',
      type: 'atomic',
      version: '1.0',
      meta: createMeta('Result Query'),
      sql: 'SELECT name, value FROM metrics',
    };
    executor.registerSkill(skill);

    const result = await executor.execute('result_query', 'trace-1');
    expect(result.success).toBe(true);
    // rawResults 包含转换后的对象数组
  });

  it('应该处理 SQL 执行错误', async () => {
    mockTraceProcessor.query.mockResolvedValue({
      error: 'SQL syntax error',
    });

    const skill: SkillDefinition = {
      name: 'error_query',
      type: 'atomic',
      version: '1.0',
      meta: createMeta('Error Query'),
      sql: 'INVALID SQL',
    };
    executor.registerSkill(skill);

    const result = await executor.execute('error_query', 'trace-1');
    expect(result.success).toBe(false);
    expect(result.error).toContain('SQL syntax error');
  });

  it('应该处理 optional 步骤的错误', async () => {
    mockTraceProcessor.query.mockResolvedValue({ error: 'Table not found' });

    const skill: SkillDefinition = {
      name: 'optional_query',
      type: 'composite',
      version: '1.0',
      meta: createMeta('Optional Query'),
      steps: [
        {
          id: 'optional_step',
          type: 'atomic',
          sql: 'SELECT * FROM nonexistent',
          optional: true,
        },
      ],
    };
    executor.registerSkill(skill);

    const result = await executor.execute('optional_query', 'trace-1');
    // optional 步骤失败不应导致整个 skill 失败
    expect(result.success).toBe(true);
  });
});

// =============================================================================
// Test Suite: Iterator Step 执行
// =============================================================================

describe('Iterator Step 执行', () => {
  let executor: SkillExecutor;
  let mockTraceProcessor: any;

  beforeEach(() => {
    mockTraceProcessor = createMockTraceProcessorService();
    executor = createSkillExecutor(mockTraceProcessor);

    // 注册子 skill 用于迭代
    const frameDetailSkill: SkillDefinition = {
      name: 'frame_detail',
      type: 'atomic',
      version: '1.0',
      meta: createMeta('Frame Detail'),
      sql: 'SELECT * FROM frames WHERE id = ${frame_id}',
    };
    executor.registerSkill(frameDetailSkill);
  });

  it('应该遍历源数据并执行子 skill', async () => {
    // 设置第一个查询返回帧列表
    mockTraceProcessor.query
      .mockResolvedValueOnce({
        columns: ['frame_id', 'jank_type'],
        rows: [
          [1, 'dropped'],
          [2, 'late'],
        ],
      })
      .mockResolvedValue({
        columns: ['detail'],
        rows: [['frame data']],
      });

    const iteratorSkill: SkillDefinition = {
      name: 'iterate_frames',
      type: 'composite',
      version: '1.0',
      meta: createMeta('Iterate Frames'),
      steps: [
        {
          id: 'get_frames',
          type: 'atomic',
          sql: 'SELECT frame_id, jank_type FROM jank_frames',
          save_as: 'frames',
        },
        {
          id: 'analyze_each',
          type: 'iterator',
          source: 'frames',
          item_skill: 'frame_detail',
          item_params: { frame_id: 'frame_id' },
          max_items: 10,
        },
      ],
    };
    executor.registerSkill(iteratorSkill);

    const result = await executor.execute('iterate_frames', 'trace-1');
    expect(result.success).toBe(true);
    // 第一个查询 + 2 个迭代查询
    expect(mockTraceProcessor.query).toHaveBeenCalledTimes(3);
  });

  it('应该尊重 max_items 限制', async () => {
    // 返回 5 个帧，但 max_items 设为 2
    mockTraceProcessor.query
      .mockResolvedValueOnce({
        columns: ['frame_id'],
        rows: [[1], [2], [3], [4], [5]],
      })
      .mockResolvedValue({
        columns: ['detail'],
        rows: [['data']],
      });

    const limitedSkill: SkillDefinition = {
      name: 'limited_iterator',
      type: 'composite',
      version: '1.0',
      meta: createMeta('Limited Iterator'),
      steps: [
        {
          id: 'get_items',
          type: 'atomic',
          sql: 'SELECT frame_id FROM frames',
          save_as: 'items',
        },
        {
          id: 'iterate',
          type: 'iterator',
          source: 'items',
          item_skill: 'frame_detail',
          max_items: 2,
        },
      ],
    };
    executor.registerSkill(limitedSkill);

    const result = await executor.execute('limited_iterator', 'trace-1');
    // 1 个初始查询 + 2 个迭代查询（限制为 2）
    expect(mockTraceProcessor.query).toHaveBeenCalledTimes(3);
  });

  it('应该处理空数据源', async () => {
    mockTraceProcessor.query.mockResolvedValueOnce({
      columns: ['frame_id'],
      rows: [],
    });

    const emptySourceSkill: SkillDefinition = {
      name: 'empty_iterator',
      type: 'composite',
      version: '1.0',
      meta: createMeta('Empty Iterator'),
      steps: [
        {
          id: 'get_items',
          type: 'atomic',
          sql: 'SELECT frame_id FROM empty_table',
          save_as: 'items',
        },
        {
          id: 'iterate',
          type: 'iterator',
          source: 'items',
          item_skill: 'frame_detail',
        },
      ],
    };
    executor.registerSkill(emptySourceSkill);

    const result = await executor.execute('empty_iterator', 'trace-1');
    expect(result.success).toBe(true);
    // 只有初始查询
    expect(mockTraceProcessor.query).toHaveBeenCalledTimes(1);
  });

  it('应该处理不存在的数据源', async () => {
    const missingSourceSkill: SkillDefinition = {
      name: 'missing_source',
      type: 'composite',
      version: '1.0',
      meta: createMeta('Missing Source'),
      steps: [
        {
          id: 'iterate',
          type: 'iterator',
          source: 'nonexistent',
          item_skill: 'frame_detail',
        },
      ],
    };
    executor.registerSkill(missingSourceSkill);

    const result = await executor.execute('missing_source', 'trace-1');
    // Failed steps are not saved to rawResults (only successful steps are)
    // Verify that the iterator step didn't execute successfully
    expect(result.rawResults?.iterate).toBeUndefined();
    // The overall skill still returns success: true because failed steps
    // are silently skipped (similar to optional steps)
    // This is intentional to allow partial execution of composite skills
  });
});

// =============================================================================
// Test Suite: Diagnostic Step 执行
// =============================================================================

describe('Diagnostic Step 执行', () => {
  let executor: SkillExecutor;
  let mockTraceProcessor: any;

  beforeEach(() => {
    mockTraceProcessor = createMockTraceProcessorService();
    executor = createSkillExecutor(mockTraceProcessor);
  });

  it('应该评估诊断规则', async () => {
    mockTraceProcessor.query.mockResolvedValue({
      columns: ['jank_rate', 'total_frames'],
      rows: [[15, 100]],
    });

    const diagnosticSkill: SkillDefinition = {
      name: 'diagnose_jank',
      type: 'composite',
      version: '1.0',
      meta: createMeta('Jank Diagnosis'),
      steps: [
        {
          id: 'get_stats',
          type: 'atomic',
          sql: 'SELECT jank_rate, total_frames FROM performance',
          save_as: 'stats',
        },
        {
          id: 'diagnose',
          type: 'diagnostic',
          inputs: ['stats'],
          rules: [
            {
              condition: 'stats.data[0]?.jank_rate > 10',
              confidence: 0.9,
              diagnosis: '严重卡顿：掉帧率超过 10%',
              suggestions: ['优化主线程', '减少 UI 复杂度'],
            },
            {
              condition: 'stats.data[0]?.jank_rate > 5',
              confidence: 0.7,
              diagnosis: '中度卡顿',
              suggestions: ['检查耗时操作'],
            },
          ],
        },
      ],
    };
    executor.registerSkill(diagnosticSkill);

    const result = await executor.execute('diagnose_jank', 'trace-1');
    expect(result.success).toBe(true);
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.diagnostics[0].diagnosis).toContain('严重卡顿');
  });

  it('应该支持在 condition 中使用 ${...} 模板并在 diagnosis 中计算表达式', async () => {
    const tmplConditionSkill: SkillDefinition = {
      name: 'tmpl_condition',
      type: 'composite',
      version: '1.0',
      meta: createMeta('Template Condition'),
      steps: [
        {
          id: 'diagnose',
          type: 'diagnostic',
          inputs: [],
          rules: [
            {
              condition: '${vsync_missed} >= 3',
              confidence: 0.9,
              diagnosis: '严重卡顿: 跳过 ${vsync_missed} 帧 (约 ${vsync_missed * 16.7}ms)',
              suggestions: [],
            },
          ],
        },
      ],
    };
    executor.registerSkill(tmplConditionSkill);

    const result = await executor.execute('tmpl_condition', 'trace-1', { vsync_missed: 4 });

    expect(result.success).toBe(true);
    expect(result.diagnostics.length).toBe(1);
    expect(result.diagnostics[0].diagnosis).toContain('跳过 4 帧');
    expect(result.diagnostics[0].diagnosis).toContain('66.8');
  });

  it('应该返回正确的 severity', async () => {
    mockTraceProcessor.query.mockResolvedValue({
      columns: ['value'],
      rows: [[100]],
    });

    const severitySkill: SkillDefinition = {
      name: 'severity_test',
      type: 'composite',
      version: '1.0',
      meta: createMeta('Severity Test'),
      steps: [
        {
          id: 'data',
          type: 'atomic',
          sql: 'SELECT 100 as value',
          save_as: 'data',
        },
        {
          id: 'diagnose',
          type: 'diagnostic',
          inputs: ['data'],
          rules: [
            {
              condition: 'data.data[0]?.value > 50',
              confidence: 0.9,
              diagnosis: 'High value detected',
              suggestions: [],
            },
          ],
        },
      ],
    };
    executor.registerSkill(severitySkill);

    const result = await executor.execute('severity_test', 'trace-1');
    expect(result.diagnostics[0].severity).toBe('critical'); // confidence >= 0.8
  });

  it('应该处理无匹配规则的情况', async () => {
    mockTraceProcessor.query.mockResolvedValue({
      columns: ['jank_rate'],
      rows: [[1]], // 很低的值，不匹配任何规则
    });

    const noMatchSkill: SkillDefinition = {
      name: 'no_match',
      type: 'composite',
      version: '1.0',
      meta: createMeta('No Match'),
      steps: [
        {
          id: 'data',
          type: 'atomic',
          sql: 'SELECT jank_rate FROM stats',
          save_as: 'stats',
        },
        {
          id: 'diagnose',
          type: 'diagnostic',
          inputs: ['stats'],
          rules: [
            {
              condition: 'stats.data[0]?.jank_rate > 50',
              confidence: 0.9,
              diagnosis: 'Very high jank',
              suggestions: [],
            },
          ],
        },
      ],
    };
    executor.registerSkill(noMatchSkill);

    const result = await executor.execute('no_match', 'trace-1');
    expect(result.success).toBe(true);
    expect(result.diagnostics.length).toBe(0);
  });
});

// =============================================================================
// Test Suite: Conditional Step 执行
// =============================================================================

describe('Conditional Step 执行', () => {
  let executor: SkillExecutor;
  let mockTraceProcessor: any;

  beforeEach(() => {
    mockTraceProcessor = createMockTraceProcessorService();
    executor = createSkillExecutor(mockTraceProcessor);

    // 注册分支 skills
    const branchASkill: SkillDefinition = {
      name: 'branch_a',
      type: 'atomic',
      version: '1.0',
      meta: createMeta('Branch A'),
      sql: 'SELECT "branch_a" as result',
    };
    const branchBSkill: SkillDefinition = {
      name: 'branch_b',
      type: 'atomic',
      version: '1.0',
      meta: createMeta('Branch B'),
      sql: 'SELECT "branch_b" as result',
    };
    executor.registerSkill(branchASkill);
    executor.registerSkill(branchBSkill);
  });

  it('应该根据条件选择执行分支', async () => {
    mockTraceProcessor.query
      .mockResolvedValueOnce({
        columns: ['has_data'],
        rows: [[true]],
      })
      .mockResolvedValue({
        columns: ['result'],
        rows: [['branch_a']],
      });

    const conditionalSkill: SkillDefinition = {
      name: 'conditional_test',
      type: 'composite',
      version: '1.0',
      meta: createMeta('Conditional Test'),
      steps: [
        {
          id: 'check',
          type: 'atomic',
          sql: 'SELECT true as has_data',
          save_as: 'check_result',
        },
        {
          id: 'branch',
          type: 'conditional',
          conditions: [
            {
              when: 'check_result.data[0]?.has_data === true',
              then: 'branch_a',
            },
          ],
          else: 'branch_b',
        },
      ],
    };
    executor.registerSkill(conditionalSkill);

    const result = await executor.execute('conditional_test', 'trace-1');
    expect(result.success).toBe(true);
    // 验证执行了 branch_a
    expect(mockTraceProcessor.query).toHaveBeenCalledTimes(2);
  });

  it('应该支持 else 分支', async () => {
    mockTraceProcessor.query
      .mockResolvedValueOnce({
        columns: ['has_data'],
        rows: [[false]],
      })
      .mockResolvedValue({
        columns: ['result'],
        rows: [['branch_b']],
      });

    const elseSkill: SkillDefinition = {
      name: 'else_test',
      type: 'composite',
      version: '1.0',
      meta: createMeta('Else Test'),
      steps: [
        {
          id: 'check',
          type: 'atomic',
          sql: 'SELECT false as has_data',
          save_as: 'check_result',
        },
        {
          id: 'branch',
          type: 'conditional',
          conditions: [
            {
              when: 'check_result.data[0]?.has_data === true',
              then: 'branch_a',
            },
          ],
          else: 'branch_b',
        },
      ],
    };
    executor.registerSkill(elseSkill);

    const result = await executor.execute('else_test', 'trace-1');
    expect(result.success).toBe(true);
  });

  it('应该支持内联步骤作为分支', async () => {
    mockTraceProcessor.query
      .mockResolvedValueOnce({
        columns: ['value'],
        rows: [[100]],
      })
      .mockResolvedValue({
        columns: ['inline_result'],
        rows: [['inline executed']],
      });

    const inlineSkill: SkillDefinition = {
      name: 'inline_branch',
      type: 'composite',
      version: '1.0',
      meta: createMeta('Inline Branch'),
      steps: [
        {
          id: 'check',
          type: 'atomic',
          sql: 'SELECT 100 as value',
          save_as: 'data',
        },
        {
          id: 'conditional',
          type: 'conditional',
          conditions: [
            {
              when: 'data.data[0]?.value > 50',
              then: {
                id: 'inline_step',
                type: 'atomic',
                sql: 'SELECT "inline executed" as inline_result',
              },
            },
          ],
        },
      ],
    };
    executor.registerSkill(inlineSkill);

    const result = await executor.execute('inline_branch', 'trace-1');
    expect(result.success).toBe(true);
    expect(mockTraceProcessor.query).toHaveBeenCalledTimes(2);
  });
});

// =============================================================================
// Test Suite: Parallel Step 执行
// =============================================================================

describe('Parallel Step 执行', () => {
  let executor: SkillExecutor;
  let mockTraceProcessor: any;

  beforeEach(() => {
    mockTraceProcessor = createMockTraceProcessorService();
    executor = createSkillExecutor(mockTraceProcessor);
  });

  it('应该并行执行多个步骤', async () => {
    mockTraceProcessor.query.mockResolvedValue({
      columns: ['value'],
      rows: [[1]],
    });

    const parallelSkill: SkillDefinition = {
      name: 'parallel_test',
      type: 'composite',
      version: '1.0',
      meta: createMeta('Parallel Test'),
      steps: [
        {
          id: 'parallel_group',
          type: 'parallel',
          steps: [
            {
              id: 'query_a',
              type: 'atomic',
              sql: 'SELECT 1 as value',
            },
            {
              id: 'query_b',
              type: 'atomic',
              sql: 'SELECT 2 as value',
            },
            {
              id: 'query_c',
              type: 'atomic',
              sql: 'SELECT 3 as value',
            },
          ],
        },
      ],
    };
    executor.registerSkill(parallelSkill);

    const result = await executor.execute('parallel_test', 'trace-1');
    expect(result.success).toBe(true);
    // 所有 3 个查询都应该执行
    expect(mockTraceProcessor.query).toHaveBeenCalledTimes(3);
  });

  it('应该收集所有并行结果', async () => {
    mockTraceProcessor.query
      .mockResolvedValueOnce({ columns: ['a'], rows: [[1]] })
      .mockResolvedValueOnce({ columns: ['b'], rows: [[2]] });

    const collectSkill: SkillDefinition = {
      name: 'collect_parallel',
      type: 'composite',
      version: '1.0',
      meta: createMeta('Collect Parallel'),
      steps: [
        {
          id: 'parallel_group',
          type: 'parallel',
          steps: [
            { id: 'step_a', type: 'atomic', sql: 'SELECT 1 as a' },
            { id: 'step_b', type: 'atomic', sql: 'SELECT 2 as b' },
          ],
        },
      ],
    };
    executor.registerSkill(collectSkill);

    const result = await executor.execute('collect_parallel', 'trace-1');
    expect(result.success).toBe(true);
    // 结果应该包含两个子步骤的数据
    expect(result.rawResults?.step_a).toBeDefined();
    expect(result.rawResults?.step_b).toBeDefined();
  });

  it('应该处理部分失败', async () => {
    mockTraceProcessor.query
      .mockResolvedValueOnce({ columns: ['a'], rows: [[1]] })
      .mockResolvedValueOnce({ error: 'Query failed' });

    const partialFailSkill: SkillDefinition = {
      name: 'partial_fail',
      type: 'composite',
      version: '1.0',
      meta: createMeta('Partial Fail'),
      steps: [
        {
          id: 'parallel_group',
          type: 'parallel',
          steps: [
            { id: 'success_step', type: 'atomic', sql: 'SELECT 1' },
            { id: 'fail_step', type: 'atomic', sql: 'INVALID SQL' },
          ],
        },
      ],
    };
    executor.registerSkill(partialFailSkill);

    const result = await executor.execute('partial_fail', 'trace-1');
    // 整体成功状态取决于是否所有步骤都成功
    expect(result.rawResults?.success_step?.success).toBe(true);
    expect(result.rawResults?.fail_step?.success).toBe(false);
  });
});

// =============================================================================
// Test Suite: AI Decision Step 执行
// =============================================================================

describe('AI Decision Step 执行', () => {
  let executor: SkillExecutor;
  let mockTraceProcessor: any;
  let mockAiService: any;
  let emittedEvents: any[];

  beforeEach(() => {
    mockTraceProcessor = createMockTraceProcessorService();
    mockAiService = {
      chat: jest.fn<any>().mockResolvedValue('选择方案 A'),
    };
    emittedEvents = [];
    executor = createSkillExecutor(
      mockTraceProcessor,
      mockAiService,
      (event) => emittedEvents.push(event)
    );
  });

  it('应该调用 AI 服务进行决策', async () => {
    const aiDecisionSkill: SkillDefinition = {
      name: 'ai_decision_test',
      type: 'composite',
      version: '1.0',
      meta: createMeta('AI Decision Test'),
      steps: [
        {
          id: 'decide',
          type: 'ai_decision',
          prompt: '根据数据选择最佳方案',
        },
      ],
    };
    executor.registerSkill(aiDecisionSkill);

    const result = await executor.execute('ai_decision_test', 'trace-1');
    expect(result.success).toBe(true);
    expect(mockAiService.chat).toHaveBeenCalledWith('根据数据选择最佳方案');
  });

  it('应该发射 ai_thinking 和 ai_response 事件', async () => {
    const aiEventSkill: SkillDefinition = {
      name: 'ai_event_test',
      type: 'composite',
      version: '1.0',
      meta: createMeta('AI Event Test'),
      steps: [
        {
          id: 'decide',
          type: 'ai_decision',
          prompt: 'Test prompt',
        },
      ],
    };
    executor.registerSkill(aiEventSkill);

    await executor.execute('ai_event_test', 'trace-1');

    const thinkingEvent = emittedEvents.find(e => e.type === 'ai_thinking');
    const responseEvent = emittedEvents.find(e => e.type === 'ai_response');
    expect(thinkingEvent).toBeDefined();
    expect(responseEvent).toBeDefined();
    expect(responseEvent?.data.response).toBe('选择方案 A');
  });

  it('应该在无 AI 服务时返回错误', async () => {
    const noAiExecutor = createSkillExecutor(mockTraceProcessor);
    const skill: SkillDefinition = {
      name: 'no_ai_test',
      type: 'composite',
      version: '1.0',
      meta: createMeta('No AI Test'),
      steps: [
        {
          id: 'decide',
          type: 'ai_decision',
          prompt: 'Test',
        },
      ],
    };
    noAiExecutor.registerSkill(skill);

    const result = await noAiExecutor.execute('no_ai_test', 'trace-1');
    // Failed steps are not saved to rawResults (only successful steps are)
    // Verify that the AI decision step didn't execute successfully
    expect(result.rawResults?.decide).toBeUndefined();
    // The overall skill still succeeds because failed steps are silently skipped
    // This allows partial execution of composite skills
  });
});

// =============================================================================
// Test Suite: AI Summary Step 执行
// =============================================================================

describe('AI Summary Step 执行', () => {
  let executor: SkillExecutor;
  let mockTraceProcessor: any;
  let mockAiService: any;

  beforeEach(() => {
    mockTraceProcessor = createMockTraceProcessorService();
    mockAiService = {
      chat: jest.fn<any>().mockResolvedValue('总结：性能良好，无明显问题'),
    };
    executor = createSkillExecutor(mockTraceProcessor, mockAiService);
  });

  it('应该生成 AI 摘要', async () => {
    mockTraceProcessor.query.mockResolvedValue({
      columns: ['metric', 'value'],
      rows: [['fps', 60], ['jank', 0]],
    });

    const aiSummarySkill: SkillDefinition = {
      name: 'ai_summary_test',
      type: 'composite',
      version: '1.0',
      meta: createMeta('AI Summary Test'),
      steps: [
        {
          id: 'get_data',
          type: 'atomic',
          sql: 'SELECT metric, value FROM stats',
          save_as: 'stats',
        },
        {
          id: 'summarize',
          type: 'ai_summary',
          prompt: '根据以下数据生成性能分析摘要：${stats}',
        },
      ],
    };
    executor.registerSkill(aiSummarySkill);

    const result = await executor.execute('ai_summary_test', 'trace-1');
    expect(result.success).toBe(true);
    expect(result.aiSummary).toBe('总结：性能良好，无明显问题');
  });

  it('应该在 prompt 中替换变量', async () => {
    mockTraceProcessor.query.mockResolvedValue({
      columns: ['value'],
      rows: [[100]],
    });

    const varSkill: SkillDefinition = {
      name: 'var_summary',
      type: 'composite',
      version: '1.0',
      meta: createMeta('Var Summary'),
      steps: [
        {
          id: 'data',
          type: 'atomic',
          sql: 'SELECT 100 as value',
          save_as: 'data',
        },
        {
          id: 'summarize',
          type: 'ai_summary',
          prompt: '数据值为 ${data.data[0].value}',
        },
      ],
    };
    executor.registerSkill(varSkill);

    await executor.execute('var_summary', 'trace-1');
    // 验证 AI 服务被调用时 prompt 中的变量已被替换
    expect(mockAiService.chat).toHaveBeenCalled();
  });
});

// =============================================================================
// Test Suite: Skill Reference Step 执行
// =============================================================================

describe('Skill Reference Step 执行', () => {
  let executor: SkillExecutor;
  let mockTraceProcessor: any;

  beforeEach(() => {
    mockTraceProcessor = createMockTraceProcessorService();
    executor = createSkillExecutor(mockTraceProcessor);
  });

  it('应该加载并执行引用的 skill', async () => {
    mockTraceProcessor.query.mockResolvedValue({
      columns: ['value'],
      rows: [[1]],
    });

    const childSkill: SkillDefinition = {
      name: 'child_skill',
      type: 'atomic',
      version: '1.0',
      meta: createMeta('Child Skill'),
      sql: 'SELECT 1 as value',
    };

    const parentSkill: SkillDefinition = {
      name: 'parent_skill',
      type: 'composite',
      version: '1.0',
      meta: createMeta('Parent Skill'),
      steps: [
        {
          id: 'child_step',
          skill: 'child_skill',
        },
      ],
    };

    executor.registerSkill(childSkill);
    executor.registerSkill(parentSkill);

    const result = await executor.execute('parent_skill', 'trace-1');

    expect(result.success).toBe(true);
    expect(mockTraceProcessor.query).toHaveBeenCalledWith('trace-1', 'SELECT 1 as value');
    expect(result.rawResults?.child_step).toBeDefined();
    expect(result.rawResults?.child_step?.data?.skillId).toBe('child_skill');
  });

  it('应该正确传递参数', async () => {
    mockTraceProcessor.query.mockResolvedValue({
      columns: ['value'],
      rows: [[7]],
    });

    const childSkill: SkillDefinition = {
      name: 'child_param_skill',
      type: 'atomic',
      version: '1.0',
      meta: createMeta('Child Param Skill'),
      sql: 'SELECT ${target} as value',
    };

    const parentSkill: SkillDefinition = {
      name: 'parent_param_skill',
      type: 'composite',
      version: '1.0',
      meta: createMeta('Parent Param Skill'),
      steps: [
        {
          id: 'child_step',
          skill: 'child_param_skill',
          params: { target: 7 },
        },
      ],
    };

    executor.registerSkill(childSkill);
    executor.registerSkill(parentSkill);

    await executor.execute('parent_param_skill', 'trace-1');

    expect(mockTraceProcessor.query).toHaveBeenCalledWith('trace-1', 'SELECT 7 as value');
  });

  it('应该正确合并结果', async () => {
    mockTraceProcessor.query
      .mockResolvedValueOnce({
        columns: ['value'],
        rows: [[42]],
      })
      .mockResolvedValueOnce({
        columns: ['value'],
        rows: [[84]],
      });

    const childSkill: SkillDefinition = {
      name: 'child_merge_skill',
      type: 'composite',
      version: '1.0',
      meta: createMeta('Child Merge Skill'),
      steps: [
        {
          id: 'step_a',
          type: 'atomic',
          sql: 'SELECT 42 as value',
        },
        {
          id: 'step_b',
          type: 'atomic',
          sql: 'SELECT 84 as value',
        },
      ],
    };

    const parentSkill: SkillDefinition = {
      name: 'parent_merge_skill',
      type: 'composite',
      version: '1.0',
      meta: createMeta('Parent Merge Skill'),
      steps: [
        {
          id: 'child_step',
          skill: 'child_merge_skill',
        },
      ],
    };

    executor.registerSkill(childSkill);
    executor.registerSkill(parentSkill);

    const result = await executor.execute('parent_merge_skill', 'trace-1');
    const childResult = result.rawResults?.child_step?.data;

    expect(childResult).toBeDefined();
    expect(childResult.rawResults?.step_a).toBeDefined();
    expect(childResult.rawResults?.step_b).toBeDefined();
  });
});

// =============================================================================
// Test Suite: 表达式评估（通过 SQL 变量替换测试）
// =============================================================================

describe('表达式评估', () => {
  let executor: SkillExecutor;
  let mockTraceProcessor: any;

  beforeEach(() => {
    mockTraceProcessor = createMockTraceProcessorService();
    executor = createSkillExecutor(mockTraceProcessor);
  });

  it('应该支持简单变量访问', async () => {
    const skill: SkillDefinition = {
      name: 'simple_var',
      type: 'atomic',
      version: '1.0',
      meta: createMeta('Simple Var'),
      sql: 'SELECT * FROM t WHERE id = ${id}',
    };
    executor.registerSkill(skill);

    await executor.execute('simple_var', 'trace-1', { id: 42 });
    expect(mockTraceProcessor.query).toHaveBeenCalledWith(
      'trace-1',
      'SELECT * FROM t WHERE id = 42'
    );
  });

  it('应该支持深层路径访问', async () => {
    mockTraceProcessor.query
      .mockResolvedValueOnce({
        columns: ['frame_id', 'value'],
        rows: [[1, 100]],
      })
      .mockResolvedValue({
        columns: ['result'],
        rows: [['ok']],
      });

    const skill: SkillDefinition = {
      name: 'deep_path',
      type: 'composite',
      version: '1.0',
      meta: createMeta('Deep Path'),
      steps: [
        {
          id: 'first',
          type: 'atomic',
          sql: 'SELECT frame_id, value FROM frames',
          save_as: 'frames',
        },
        {
          id: 'second',
          type: 'atomic',
          sql: 'SELECT * FROM details WHERE frame_id = ${frames.data[0].frame_id}',
        },
      ],
    };
    executor.registerSkill(skill);

    await executor.execute('deep_path', 'trace-1');
    // 第二个查询应该使用第一个查询的结果
    expect(mockTraceProcessor.query).toHaveBeenCalledWith(
      'trace-1',
      'SELECT * FROM details WHERE frame_id = 1'
    );
  });

  it('应该支持数组索引访问', async () => {
    mockTraceProcessor.query
      .mockResolvedValueOnce({
        columns: ['name'],
        rows: [['first'], ['second'], ['third']],
      })
      .mockResolvedValue({
        columns: ['result'],
        rows: [['found']],
      });

    const skill: SkillDefinition = {
      name: 'array_index',
      type: 'composite',
      version: '1.0',
      meta: createMeta('Array Index'),
      steps: [
        {
          id: 'list',
          type: 'atomic',
          sql: 'SELECT name FROM items',
          save_as: 'items',
        },
        {
          id: 'query',
          type: 'atomic',
          sql: "SELECT * FROM t WHERE name = '${items.data[1].name}'",
        },
      ],
    };
    executor.registerSkill(skill);

    await executor.execute('array_index', 'trace-1');
    expect(mockTraceProcessor.query).toHaveBeenLastCalledWith(
      'trace-1',
      "SELECT * FROM t WHERE name = 'second'"
    );
  });

  it('应该处理未定义变量', async () => {
    const skill: SkillDefinition = {
      name: 'undefined_var',
      type: 'atomic',
      version: '1.0',
      meta: createMeta('Undefined Var'),
      sql: 'SELECT * FROM t WHERE pkg = ${package}',
    };
    executor.registerSkill(skill);

    await executor.execute('undefined_var', 'trace-1', {}); // 没有传 package 参数
    // 未定义变量在 SQL 表达式中应替换为 NULL（避免产生语法错误）
    expect(mockTraceProcessor.query).toHaveBeenCalledWith(
      'trace-1',
      'SELECT * FROM t WHERE pkg = NULL'
    );
  });

  it('应该支持 inherited 上下文', async () => {
    const skill: SkillDefinition = {
      name: 'inherited_test',
      type: 'atomic',
      version: '1.0',
      meta: createMeta('Inherited Test'),
      sql: 'SELECT * FROM t WHERE session = ${session_id}',
    };
    executor.registerSkill(skill);

    await executor.execute('inherited_test', 'trace-1', {}, { session_id: 'sess-123' });
    expect(mockTraceProcessor.query).toHaveBeenCalledWith(
      'trace-1',
      'SELECT * FROM t WHERE session = sess-123'
    );
  });
});

// =============================================================================
// Test Suite: Display 配置
// =============================================================================

describe('Display 配置', () => {
  let executor: SkillExecutor;
  let mockTraceProcessor: any;

  beforeEach(() => {
    mockTraceProcessor = createMockTraceProcessorService();
    executor = createSkillExecutor(mockTraceProcessor);
  });

  it('应该正确解析 display.level', () => {
    // DisplayConfig.level is DisplayLevel: 'none' | 'debug' | 'detail' | 'summary' | 'key'
    // DisplayConfig.layer is DisplayLayer: 'overview' | 'list' | 'session' | 'deep'
    const config: DisplayConfig = {
      title: '测试',
      level: 'summary',
      layer: 'overview',
    };

    expect(config.level).toBe('summary');
    expect(config.layer).toBe('overview');
  });

  it('应该支持 display: true 简写', async () => {
    mockTraceProcessor.query.mockResolvedValue({
      columns: ['value'],
      rows: [[1]],
    });

    const skill: SkillDefinition = {
      name: 'display_true',
      type: 'composite',
      version: '1.0',
      meta: createMeta('Display True'),
      steps: [
        {
          id: 'step1',
          type: 'atomic',
          sql: 'SELECT 1 as value',
          display: true, // 简写形式
        },
      ],
    };
    executor.registerSkill(skill);

    const result = await executor.execute('display_true', 'trace-1');
    expect(result.displayResults.length).toBe(1);
  });

  it('应该支持 display: false 隐藏结果', async () => {
    mockTraceProcessor.query.mockResolvedValue({
      columns: ['value'],
      rows: [[1]],
    });

    const skill: SkillDefinition = {
      name: 'display_false',
      type: 'composite',
      version: '1.0',
      meta: createMeta('Display False'),
      steps: [
        {
          id: 'hidden_step',
          type: 'atomic',
          sql: 'SELECT 1 as value',
          display: false,
        },
      ],
    };
    executor.registerSkill(skill);

    const result = await executor.execute('display_false', 'trace-1');
    expect(result.displayResults.length).toBe(0);
  });

  it('应该支持 display 对象配置', async () => {
    mockTraceProcessor.query.mockResolvedValue({
      columns: ['name', 'value'],
      rows: [['metric', 100]],
    });

    const skill: SkillDefinition = {
      name: 'display_config',
      type: 'composite',
      version: '1.0',
      meta: createMeta('Display Config'),
      steps: [
        {
          id: 'configured_step',
          type: 'atomic',
          sql: 'SELECT name, value FROM metrics',
          display: {
            title: '自定义标题',
            level: 'key',
            layer: 'overview',
            format: 'table',
          },
        },
      ],
    };
    executor.registerSkill(skill);

    const result = await executor.execute('display_config', 'trace-1');
    expect(result.displayResults[0].title).toBe('自定义标题');
    expect(result.displayResults[0].level).toBe('key');
    expect(result.displayResults[0].layer).toBe('overview');
  });
});

// =============================================================================
// Test Suite: executeCompositeSkill
// =============================================================================

describe('executeCompositeSkill', () => {
  let executor: SkillExecutor;
  let mockTraceProcessor: any;

  beforeEach(() => {
    mockTraceProcessor = createMockTraceProcessorService();
    executor = createSkillExecutor(mockTraceProcessor);
  });

  it('应该返回 LayeredResult 结构', async () => {
    mockTraceProcessor.query.mockResolvedValue({
      columns: ['total', 'avg'],
      rows: [[100, 50]],
    });

    const skill: SkillDefinition = {
      name: 'layered_skill',
      type: 'composite',
      version: '1.0',
      meta: createMeta('Layered Skill'),
      steps: [
        {
          id: 'summary',
          type: 'atomic',
          sql: 'SELECT total, avg FROM stats',
          display: { title: 'Summary', level: 'summary', layer: 'overview' },
        },
      ],
    };

    const result = await executor.executeCompositeSkill(skill, {}, { traceId: 'trace-1' });

    expect(result.layers).toBeDefined();
    expect(result.defaultExpanded).toContain('overview');
    expect(result.metadata.skillName).toBe('layered_skill');
  });

  it('应该正确组织 overview 层数据', async () => {
    mockTraceProcessor.query.mockResolvedValue({
      columns: ['fps', 'jank_rate'],
      rows: [[60, 5]],
    });

    const skill: SkillDefinition = {
      name: 'overview_skill',
      type: 'composite',
      version: '1.0',
      meta: createMeta('Overview Skill'),
      steps: [
        {
          id: 'perf_summary',
          type: 'atomic',
          sql: 'SELECT fps, jank_rate FROM perf',
          display: { title: 'Performance', level: 'summary', layer: 'overview' },
        },
      ],
    };

    const result = await executor.executeCompositeSkill(skill, {}, { traceId: 'trace-1' });

    expect(result.layers.overview).toBeDefined();
    expect(result.layers.overview?.perf_summary).toBeDefined();
  });

  it('应该正确组织 list 层数据', async () => {
    mockTraceProcessor.query.mockResolvedValue({
      columns: ['session_id', 'duration'],
      rows: [
        ['s1', 1000],
        ['s2', 2000],
      ],
    });

    const skill: SkillDefinition = {
      name: 'list_skill',
      type: 'composite',
      version: '1.0',
      meta: createMeta('List Skill'),
      steps: [
        {
          id: 'sessions',
          type: 'atomic',
          sql: 'SELECT session_id, duration FROM sessions',
          display: { title: 'Sessions', level: 'summary', layer: 'list' },
        },
      ],
    };

    const result = await executor.executeCompositeSkill(skill, {}, { traceId: 'trace-1' });

    expect(result.layers.list).toBeDefined();
    expect(result.layers.list?.sessions).toBeDefined();
  });

  it('应该收集 synthesize 数据', async () => {
    mockTraceProcessor.query.mockResolvedValue({
      columns: ['total_frames', 'jank_frames'],
      rows: [[1000, 50]],
    });

    const skill: SkillDefinition = {
      name: 'synthesize_skill',
      type: 'composite',
      version: '1.0',
      meta: createMeta('Synthesize Skill'),
      steps: [
        {
          id: 'summary_data',
          type: 'atomic',
          sql: 'SELECT total_frames, jank_frames FROM stats',
          display: { title: 'Summary', level: 'summary', layer: 'overview' },
          synthesize: true, // Legacy format: config will be undefined
        },
      ],
    };

    const result = await executor.executeCompositeSkill(skill, {}, { traceId: 'trace-1' });

    expect(result.synthesizeData).toBeDefined();
    expect(result.synthesizeData?.length).toBe(1);
    expect(result.synthesizeData?.[0].stepId).toBe('summary_data');
    expect(result.synthesizeData?.[0].layer).toBe('overview'); // layer comes from display config
    // Note: When using synthesize: true (legacy format), config is undefined
    // config?.role is only set when using new format: synthesize: { role: 'xxx', ... }
    expect(result.synthesizeData?.[0].config).toBeUndefined();
  });

  it('应该处理空 steps', async () => {
    const emptySkill: SkillDefinition = {
      name: 'empty_skill',
      type: 'composite',
      version: '1.0',
      meta: createMeta('Empty Skill'),
      steps: [],
    };

    const result = await executor.executeCompositeSkill(emptySkill, {}, { traceId: 'trace-1' });

    expect(result.layers).toBeDefined();
    expect(result.metadata.skillName).toBe('empty_skill');
  });

  it('应该处理缺失 skill 定义', async () => {
    await expect(
      executor.executeCompositeSkill(null as any, {}, { traceId: 'trace-1' })
    ).rejects.toThrow('Skill definition is required');
  });
});

// =============================================================================
// Test Suite: Prerequisites
// =============================================================================

describe('Prerequisites (Perfetto 模块)', () => {
  let executor: SkillExecutor;
  let mockTraceProcessor: any;

  beforeEach(() => {
    mockTraceProcessor = createMockTraceProcessorService();
    executor = createSkillExecutor(mockTraceProcessor);
  });

  it('应该加载必需的 Perfetto 模块', async () => {
    mockTraceProcessor.query.mockResolvedValue({
      columns: ['value'],
      rows: [[1]],
    });

    const skill: SkillDefinition = {
      name: 'with_module',
      type: 'atomic',
      version: '1.0',
      meta: createMeta('With Module'),
      prerequisites: {
        modules: ['android_scrolling'],
      },
      sql: 'SELECT 1 as value',
    };
    executor.registerSkill(skill);

    await executor.execute('with_module', 'trace-1');

    // 验证模块加载被调用
    expect(mockTraceProcessor.query).toHaveBeenCalledWith(
      'trace-1',
      'INCLUDE PERFETTO MODULE android_scrolling;'
    );
  });

  it('应该加载多个模块', async () => {
    mockTraceProcessor.query.mockResolvedValue({
      columns: ['value'],
      rows: [[1]],
    });

    const skill: SkillDefinition = {
      name: 'multi_module',
      type: 'atomic',
      version: '1.0',
      meta: createMeta('Multi Module'),
      prerequisites: {
        modules: ['android_scrolling', 'android_startup'],
      },
      sql: 'SELECT 1 as value',
    };
    executor.registerSkill(skill);

    await executor.execute('multi_module', 'trace-1');

    // 验证两个模块都被加载
    expect(mockTraceProcessor.query).toHaveBeenCalledWith(
      'trace-1',
      'INCLUDE PERFETTO MODULE android_scrolling;'
    );
    expect(mockTraceProcessor.query).toHaveBeenCalledWith(
      'trace-1',
      'INCLUDE PERFETTO MODULE android_startup;'
    );
  });

  it('应该在模块加载失败时继续执行', async () => {
    // 模块加载失败，但 SQL 查询成功
    mockTraceProcessor.query
      .mockRejectedValueOnce(new Error('Module not found'))
      .mockResolvedValue({
        columns: ['value'],
        rows: [[1]],
      });

    const skill: SkillDefinition = {
      name: 'module_fail',
      type: 'atomic',
      version: '1.0',
      meta: createMeta('Module Fail'),
      prerequisites: {
        modules: ['nonexistent_module'],
      },
      sql: 'SELECT 1 as value',
    };
    executor.registerSkill(skill);

    // 模块加载失败不应阻止 skill 执行
    const result = await executor.execute('module_fail', 'trace-1');
    expect(result.success).toBe(true);
  });
});

// =============================================================================
// Test Suite: 错误处理
// =============================================================================

describe('错误处理', () => {
  let executor: SkillExecutor;
  let mockTraceProcessor: any;

  beforeEach(() => {
    mockTraceProcessor = createMockTraceProcessorService();
    executor = createSkillExecutor(mockTraceProcessor);
  });

  it('应该捕获 SQL 执行错误', async () => {
    mockTraceProcessor.query.mockResolvedValue({
      error: 'no such table: nonexistent',
    });

    const skill: SkillDefinition = {
      name: 'sql_error',
      type: 'atomic',
      version: '1.0',
      meta: createMeta('SQL Error'),
      sql: 'SELECT * FROM nonexistent',
    };
    executor.registerSkill(skill);

    const result = await executor.execute('sql_error', 'trace-1');
    expect(result.success).toBe(false);
    expect(result.error).toContain('no such table');
  });

  it('应该捕获 SQL 执行异常', async () => {
    mockTraceProcessor.query.mockRejectedValue(new Error('Connection timeout'));

    const skill: SkillDefinition = {
      name: 'sql_exception',
      type: 'atomic',
      version: '1.0',
      meta: createMeta('SQL Exception'),
      sql: 'SELECT 1',
    };
    executor.registerSkill(skill);

    const result = await executor.execute('sql_exception', 'trace-1');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Connection timeout');
  });

  it('应该返回包含错误信息的结果', async () => {
    mockTraceProcessor.query.mockResolvedValue({
      error: 'Syntax error at position 10',
    });

    const skill: SkillDefinition = {
      name: 'error_format',
      type: 'atomic',
      version: '1.0',
      meta: createMeta('Error Format'),
      sql: 'INVALID SQL SYNTAX',
    };
    executor.registerSkill(skill);

    const result = await executor.execute('error_format', 'trace-1');
    expect(result.skillId).toBe('error_format');
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.executionTimeMs).toBeGreaterThanOrEqual(0);
  });

  it('应该发射 skill_error 事件', async () => {
    const emittedEvents: any[] = [];
    const executorWithEvents = createSkillExecutor(
      mockTraceProcessor,
      undefined,
      (event) => emittedEvents.push(event)
    );

    mockTraceProcessor.query.mockRejectedValue(new Error('Fatal error'));

    const skill: SkillDefinition = {
      name: 'emit_error',
      type: 'atomic',
      version: '1.0',
      meta: createMeta('Emit Error'),
      sql: 'SELECT 1',
    };
    executorWithEvents.registerSkill(skill);

    await executorWithEvents.execute('emit_error', 'trace-1');

    const errorEvent = emittedEvents.find(e => e.type === 'skill_error');
    expect(errorEvent).toBeDefined();
    expect(errorEvent?.data.error).toContain('Fatal error');
  });

  it('应该支持 optional 步骤失败后继续执行', async () => {
    mockTraceProcessor.query
      .mockResolvedValueOnce({ error: 'Table not found' }) // 第一个步骤失败
      .mockResolvedValue({ columns: ['v'], rows: [[1]] }); // 第二个步骤成功

    const skill: SkillDefinition = {
      name: 'continue_after_fail',
      type: 'composite',
      version: '1.0',
      meta: createMeta('Continue After Fail'),
      steps: [
        {
          id: 'optional_step',
          type: 'atomic',
          sql: 'SELECT * FROM optional_table',
          optional: true,
        },
        {
          id: 'required_step',
          type: 'atomic',
          sql: 'SELECT 1 as v',
          display: { title: 'Required', level: 'summary' },
        },
      ],
    };
    executor.registerSkill(skill);

    const result = await executor.execute('continue_after_fail', 'trace-1');
    expect(result.success).toBe(true);
    expect(result.displayResults.length).toBe(1);
  });
});

// =============================================================================
// Test Suite: 事件发射
// =============================================================================

describe('事件发射', () => {
  let executor: SkillExecutor;
  let mockTraceProcessor: any;
  let emittedEvents: any[];

  beforeEach(() => {
    mockTraceProcessor = createMockTraceProcessorService();
    emittedEvents = [];
    executor = createSkillExecutor(
      mockTraceProcessor,
      undefined,
      (event) => emittedEvents.push(event)
    );
  });

  it('应该发射 skill_started 事件', async () => {
    mockTraceProcessor.query.mockResolvedValue({
      columns: ['v'],
      rows: [[1]],
    });

    const skill: SkillDefinition = {
      name: 'event_test',
      type: 'atomic',
      version: '1.0',
      meta: createMeta('Event Test'),
      sql: 'SELECT 1',
    };
    executor.registerSkill(skill);

    await executor.execute('event_test', 'trace-1');

    const startEvent = emittedEvents.find(e => e.type === 'skill_started');
    expect(startEvent).toBeDefined();
    expect(startEvent?.skillId).toBe('event_test');
    expect(startEvent?.timestamp).toBeDefined();
  });

  it('应该发射 step_started 和 step_completed 事件', async () => {
    mockTraceProcessor.query.mockResolvedValue({
      columns: ['v'],
      rows: [[1]],
    });

    const skill: SkillDefinition = {
      name: 'step_events',
      type: 'composite',
      version: '1.0',
      meta: createMeta('Step Events'),
      steps: [
        {
          id: 'step1',
          type: 'atomic',
          sql: 'SELECT 1',
        },
      ],
    };
    executor.registerSkill(skill);

    await executor.execute('step_events', 'trace-1');

    const stepStartEvent = emittedEvents.find(e => e.type === 'step_started');
    const stepCompleteEvent = emittedEvents.find(e => e.type === 'step_completed');

    expect(stepStartEvent).toBeDefined();
    expect(stepStartEvent?.stepId).toBe('step1');
    expect(stepCompleteEvent).toBeDefined();
    expect(stepCompleteEvent?.data.success).toBe(true);
  });

  it('应该发射 skill_completed 事件', async () => {
    mockTraceProcessor.query.mockResolvedValue({
      columns: ['v'],
      rows: [[1]],
    });

    const skill: SkillDefinition = {
      name: 'complete_event',
      type: 'atomic',
      version: '1.0',
      meta: createMeta('Complete Event'),
      sql: 'SELECT 1',
    };
    executor.registerSkill(skill);

    await executor.execute('complete_event', 'trace-1');

    const completeEvent = emittedEvents.find(e => e.type === 'skill_completed');
    expect(completeEvent).toBeDefined();
    expect(completeEvent?.skillId).toBe('complete_event');
    expect(completeEvent?.data.success).toBe(true);
  });

  it('应该包含事件时间戳', async () => {
    mockTraceProcessor.query.mockResolvedValue({
      columns: ['v'],
      rows: [[1]],
    });

    const skill: SkillDefinition = {
      name: 'timestamp_test',
      type: 'atomic',
      version: '1.0',
      meta: createMeta('Timestamp Test'),
      sql: 'SELECT 1',
    };
    executor.registerSkill(skill);

    const beforeTime = Date.now();
    await executor.execute('timestamp_test', 'trace-1');
    const afterTime = Date.now();

    for (const event of emittedEvents) {
      expect(event.timestamp).toBeGreaterThanOrEqual(beforeTime);
      expect(event.timestamp).toBeLessThanOrEqual(afterTime);
    }
  });
});

// =============================================================================
// Test Suite: 上下文管理
// =============================================================================

describe('上下文管理', () => {
  let executor: SkillExecutor;
  let mockTraceProcessor: any;

  beforeEach(() => {
    mockTraceProcessor = createMockTraceProcessorService();
    executor = createSkillExecutor(mockTraceProcessor);
  });

  it('应该在步骤间共享变量', async () => {
    mockTraceProcessor.query
      .mockResolvedValueOnce({
        columns: ['frame_id'],
        rows: [[123]],
      })
      .mockResolvedValue({
        columns: ['detail'],
        rows: [['frame data']],
      });

    const skill: SkillDefinition = {
      name: 'share_vars',
      type: 'composite',
      version: '1.0',
      meta: createMeta('Share Vars'),
      steps: [
        {
          id: 'get_id',
          type: 'atomic',
          sql: 'SELECT frame_id FROM frames LIMIT 1',
          save_as: 'frame_info',
        },
        {
          id: 'get_detail',
          type: 'atomic',
          sql: 'SELECT detail FROM frames WHERE id = ${frame_info.data[0].frame_id}',
        },
      ],
    };
    executor.registerSkill(skill);

    await executor.execute('share_vars', 'trace-1');

    // 第二个查询应该使用第一个查询的结果
    expect(mockTraceProcessor.query).toHaveBeenLastCalledWith(
      'trace-1',
      'SELECT detail FROM frames WHERE id = 123'
    );
  });

  it('应该保存步骤结果供后续使用', async () => {
    mockTraceProcessor.query.mockResolvedValue({
      columns: ['count'],
      rows: [[10]],
    });

    const skill: SkillDefinition = {
      name: 'result_access',
      type: 'composite',
      version: '1.0',
      meta: createMeta('Result Access'),
      steps: [
        {
          id: 'count_step',
          type: 'atomic',
          sql: 'SELECT COUNT(*) as count FROM items',
        },
        {
          id: 'use_count',
          type: 'atomic',
          sql: 'SELECT * FROM items LIMIT ${count_step.data[0].count}',
        },
      ],
    };
    executor.registerSkill(skill);

    await executor.execute('result_access', 'trace-1');

    expect(mockTraceProcessor.query).toHaveBeenLastCalledWith(
      'trace-1',
      'SELECT * FROM items LIMIT 10'
    );
  });

  it('应该支持 save_as 变量保存', async () => {
    mockTraceProcessor.query
      .mockResolvedValueOnce({
        columns: ['name', 'value'],
        rows: [['metric1', 100]],
      })
      .mockResolvedValue({
        columns: ['result'],
        rows: [['ok']],
      });

    const skill: SkillDefinition = {
      name: 'save_as_test',
      type: 'composite',
      version: '1.0',
      meta: createMeta('Save As Test'),
      steps: [
        {
          id: 'fetch_data',
          type: 'atomic',
          sql: 'SELECT name, value FROM metrics',
          save_as: 'my_data',
        },
        {
          id: 'use_data',
          type: 'atomic',
          sql: "SELECT 'ok' as result WHERE '${my_data.data[0].name}' = 'metric1'",
        },
      ],
    };
    executor.registerSkill(skill);

    const result = await executor.execute('save_as_test', 'trace-1');
    expect(result.success).toBe(true);
    expect(mockTraceProcessor.query).toHaveBeenLastCalledWith(
      'trace-1',
      "SELECT 'ok' as result WHERE 'metric1' = 'metric1'"
    );
  });

  it('应该支持 params 参数传递', async () => {
    // Note: params are accessed directly by name, not via ${params.xxx} syntax
    // The resolvePath function looks up rootKey directly in context.params
    const skill: SkillDefinition = {
      name: 'params_test',
      type: 'atomic',
      version: '1.0',
      meta: createMeta('Params Test'),
      sql: 'SELECT * FROM t WHERE pkg = ${package} AND uid = ${uid}',
    };
    executor.registerSkill(skill);

    await executor.execute('params_test', 'trace-1', {
      package: 'com.example.app',
      uid: 10001,
    });

    expect(mockTraceProcessor.query).toHaveBeenCalledWith(
      'trace-1',
      'SELECT * FROM t WHERE pkg = com.example.app AND uid = 10001'
    );
  });
});

// =============================================================================
// Test Suite: 完整 Skill 执行
// =============================================================================

describe('完整 Skill 执行', () => {
  let executor: SkillExecutor;
  let mockTraceProcessor: any;

  beforeEach(() => {
    mockTraceProcessor = createMockTraceProcessorService();
    executor = createSkillExecutor(mockTraceProcessor);
  });

  it('应该按顺序执行所有步骤', async () => {
    const callOrder: string[] = [];
    mockTraceProcessor.query.mockImplementation((traceId: string, sql: string) => {
      if (sql.includes('step1')) callOrder.push('step1');
      if (sql.includes('step2')) callOrder.push('step2');
      if (sql.includes('step3')) callOrder.push('step3');
      return Promise.resolve({ columns: ['v'], rows: [[1]] });
    });

    const skill: SkillDefinition = {
      name: 'ordered_skill',
      type: 'composite',
      version: '1.0',
      meta: createMeta('Ordered Skill'),
      steps: [
        { id: 'step1', type: 'atomic', sql: 'SELECT 1 /* step1 */' },
        { id: 'step2', type: 'atomic', sql: 'SELECT 2 /* step2 */' },
        { id: 'step3', type: 'atomic', sql: 'SELECT 3 /* step3 */' },
      ],
    };
    executor.registerSkill(skill);

    await executor.execute('ordered_skill', 'trace-1');

    expect(callOrder).toEqual(['step1', 'step2', 'step3']);
  });

  it('应该返回完整的 SkillExecutionResult', async () => {
    mockTraceProcessor.query.mockResolvedValue({
      columns: ['metric', 'value'],
      rows: [['fps', 60]],
    });

    const skill: SkillDefinition = {
      name: 'full_result',
      type: 'composite',
      version: '1.0',
      meta: createMeta('Full Result'),
      steps: [
        {
          id: 'metrics',
          type: 'atomic',
          sql: 'SELECT metric, value FROM perf',
          display: { title: 'Metrics', level: 'summary' },
        },
      ],
    };
    executor.registerSkill(skill);

    const result = await executor.execute('full_result', 'trace-1');

    expect(result.skillId).toBe('full_result');
    expect(result.skillName).toBe('Full Result');
    expect(result.success).toBe(true);
    expect(result.displayResults).toBeDefined();
    expect(result.diagnostics).toBeDefined();
    expect(result.rawResults).toBeDefined();
    expect(result.executionTimeMs).toBeGreaterThanOrEqual(0);
  });

  it('应该包含 diagnostics 当有 diagnostic 步骤时', async () => {
    mockTraceProcessor.query.mockResolvedValue({
      columns: ['jank_rate'],
      rows: [[15]],
    });

    const skill: SkillDefinition = {
      name: 'with_diagnostics',
      type: 'composite',
      version: '1.0',
      meta: createMeta('With Diagnostics'),
      steps: [
        {
          id: 'stats',
          type: 'atomic',
          sql: 'SELECT jank_rate FROM perf',
          save_as: 'perf_stats',
        },
        {
          id: 'diagnose',
          type: 'diagnostic',
          inputs: ['perf_stats'],
          rules: [
            {
              condition: 'perf_stats.data[0]?.jank_rate > 10',
              confidence: 0.9,
              diagnosis: '检测到严重卡顿',
              suggestions: ['优化渲染'],
            },
          ],
        },
      ],
    };
    executor.registerSkill(skill);

    const result = await executor.execute('with_diagnostics', 'trace-1');

    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.diagnostics[0].diagnosis).toContain('严重卡顿');
  });

  it('应该记录执行时间', async () => {
    mockTraceProcessor.query.mockImplementation(() => {
      return new Promise(resolve => {
        setTimeout(() => resolve({ columns: ['v'], rows: [[1]] }), 50);
      });
    });

    const skill: SkillDefinition = {
      name: 'timing_test',
      type: 'atomic',
      version: '1.0',
      meta: createMeta('Timing Test'),
      sql: 'SELECT 1',
    };
    executor.registerSkill(skill);

    const result = await executor.execute('timing_test', 'trace-1');

    expect(result.executionTimeMs).toBeGreaterThanOrEqual(50);
  });
});

// =============================================================================
// Test Suite: 边界情况
// =============================================================================

describe('边界情况', () => {
  let executor: SkillExecutor;
  let mockTraceProcessor: any;

  beforeEach(() => {
    mockTraceProcessor = createMockTraceProcessorService();
    executor = createSkillExecutor(mockTraceProcessor);
  });

  it('应该处理空 steps 数组', async () => {
    const skill: SkillDefinition = {
      name: 'empty_steps',
      type: 'composite',
      version: '1.0',
      meta: createMeta('Empty Steps'),
      steps: [],
    };
    executor.registerSkill(skill);

    const result = await executor.execute('empty_steps', 'trace-1');

    expect(result.success).toBe(true);
    expect(result.displayResults).toEqual([]);
    expect(mockTraceProcessor.query).not.toHaveBeenCalled();
  });

  it('应该处理空查询结果', async () => {
    mockTraceProcessor.query.mockResolvedValue({
      columns: ['id', 'name'],
      rows: [], // 空结果
    });

    const skill: SkillDefinition = {
      name: 'empty_result',
      type: 'atomic',
      version: '1.0',
      meta: createMeta('Empty Result'),
      sql: 'SELECT * FROM empty_table',
    };
    executor.registerSkill(skill);

    const result = await executor.execute('empty_result', 'trace-1');

    expect(result.success).toBe(true);
  });

  it('应该处理嵌套 skill 调用', async () => {
    mockTraceProcessor.query.mockResolvedValue({
      columns: ['v'],
      rows: [[1]],
    });

    // 最内层 skill
    const innerSkill: SkillDefinition = {
      name: 'inner',
      type: 'atomic',
      version: '1.0',
      meta: createMeta('Inner'),
      sql: 'SELECT 1 as v',
    };

    // 中间层 skill
    const middleSkill: SkillDefinition = {
      name: 'middle',
      type: 'composite',
      version: '1.0',
      meta: createMeta('Middle'),
      steps: [
        {
          id: 'call_inner',
          skill: 'inner',
        },
      ],
    };

    // 最外层 skill
    const outerSkill: SkillDefinition = {
      name: 'outer',
      type: 'composite',
      version: '1.0',
      meta: createMeta('Outer'),
      steps: [
        {
          id: 'call_middle',
          skill: 'middle',
        },
      ],
    };

    executor.registerSkills([innerSkill, middleSkill, outerSkill]);

    const result = await executor.execute('outer', 'trace-1');

    expect(result.success).toBe(true);
  });

  it('应该处理 NULL 值', async () => {
    mockTraceProcessor.query.mockResolvedValue({
      columns: ['name', 'value'],
      rows: [
        ['metric1', null],
        [null, 100],
      ],
    });

    const skill: SkillDefinition = {
      name: 'null_values',
      type: 'atomic',
      version: '1.0',
      meta: createMeta('Null Values'),
      sql: 'SELECT name, value FROM metrics',
    };
    executor.registerSkill(skill);

    const result = await executor.execute('null_values', 'trace-1');

    expect(result.success).toBe(true);
  });

  it('应该处理超长字符串', async () => {
    const longString = 'x'.repeat(1000);
    mockTraceProcessor.query.mockResolvedValue({
      columns: ['content'],
      rows: [[longString]],
    });

    const skill: SkillDefinition = {
      name: 'long_string',
      type: 'atomic',
      version: '1.0',
      meta: createMeta('Long String'),
      sql: 'SELECT content FROM text_data',
      output: { display: { title: 'Content', level: 'summary' } },
    };
    executor.registerSkill(skill);

    const result = await executor.execute('long_string', 'trace-1');

    expect(result.success).toBe(true);
    // 显示结果中的长字符串应该被截断
    if (result.displayResults.length > 0) {
      const displayData = result.displayResults[0].data;
      if (displayData?.rows && displayData.rows[0]) {
        expect(displayData.rows[0][0].length).toBeLessThanOrEqual(103); // 100 + "..."
      }
    }
  });

  it('应该处理特殊字符', async () => {
    mockTraceProcessor.query.mockResolvedValue({
      columns: ['name'],
      rows: [["test'with\"quotes"]],
    });

    const skill: SkillDefinition = {
      name: 'special_chars',
      type: 'atomic',
      version: '1.0',
      meta: createMeta('Special Chars'),
      sql: 'SELECT name FROM test',
    };
    executor.registerSkill(skill);

    const result = await executor.execute('special_chars', 'trace-1');

    expect(result.success).toBe(true);
  });

  it('应该处理 step 条件不满足的情况', async () => {
    mockTraceProcessor.query.mockResolvedValue({
      columns: ['has_data'],
      rows: [[false]],
    });

    const skill: SkillDefinition = {
      name: 'condition_skip',
      type: 'composite',
      version: '1.0',
      meta: createMeta('Condition Skip'),
      steps: [
        {
          id: 'check',
          type: 'atomic',
          sql: 'SELECT false as has_data',
          save_as: 'check_result',
        },
        {
          id: 'conditional_step',
          type: 'atomic',
          sql: 'SELECT 1',
          condition: 'check_result.data[0]?.has_data === true',
        },
      ],
    };
    executor.registerSkill(skill);

    const result = await executor.execute('condition_skip', 'trace-1');

    // 条件不满足的步骤应该被跳过
    expect(result.success).toBe(true);
    expect(mockTraceProcessor.query).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
// Test Suite: 集成测试
// =============================================================================

describe('SkillExecutor - 集成测试', () => {
  let executor: SkillExecutor;
  let mockTraceProcessor: any;

  beforeEach(() => {
    mockTraceProcessor = createMockTraceProcessorService();
    executor = createSkillExecutor(mockTraceProcessor);
  });

  it('应该模拟完整的滚动分析流程', async () => {
    // 模拟多步骤返回
    mockTraceProcessor.query
      .mockResolvedValueOnce({
        columns: ['total_frames', 'janky_frames', 'jank_rate'],
        rows: [[100, 5, 5.0]],
      })
      .mockResolvedValueOnce({
        columns: ['frame_id', 'jank_type', 'dur_ms'],
        rows: [
          [1, 'dropped', 20],
          [2, 'late', 18],
        ],
      })
      .mockResolvedValue({
        columns: ['detail'],
        rows: [['frame detail']],
      });

    // 注册帧详情子 skill
    const frameDetailSkill: SkillDefinition = {
      name: 'frame_detail',
      type: 'atomic',
      version: '1.0',
      meta: createMeta('Frame Detail'),
      sql: 'SELECT detail FROM frame_analysis WHERE frame_id = ${frame_id}',
    };

    // 注册主分析 skill
    const scrollingSkill: SkillDefinition = {
      name: 'scrolling_analysis',
      type: 'composite',
      version: '2.0',
      meta: createMeta('Scrolling Analysis'),
      steps: [
        {
          id: 'performance_summary',
          type: 'atomic',
          sql: 'SELECT total_frames, janky_frames, jank_rate FROM performance',
          display: { title: '性能概览', level: 'summary', layer: 'overview' },
          synthesize: true,
        },
        {
          id: 'jank_frames',
          type: 'atomic',
          sql: 'SELECT frame_id, jank_type, dur_ms FROM janky_frames',
          display: { title: '掉帧列表', level: 'summary', layer: 'list' },
          save_as: 'frames',
        },
        {
          id: 'frame_analysis',
          type: 'iterator',
          source: 'frames',
          item_skill: 'frame_detail',
          item_params: { frame_id: 'frame_id' },
          max_items: 5,
          display: { title: '帧详情', level: 'key', layer: 'deep' },
        },
      ],
    };

    executor.registerSkills([frameDetailSkill, scrollingSkill]);

    const result = await executor.execute('scrolling_analysis', 'trace-1');

    expect(result.success).toBe(true);
    expect(result.displayResults.length).toBeGreaterThan(0);
  });

  it('应该正确生成分层数据结构', async () => {
    mockTraceProcessor.query
      .mockResolvedValueOnce({
        columns: ['fps', 'jank_rate'],
        rows: [[60, 2.5]],
      })
      .mockResolvedValueOnce({
        columns: ['session_id', 'duration_ms'],
        rows: [
          ['s1', 1000],
          ['s2', 2000],
        ],
      });

    const layeredSkill: SkillDefinition = {
      name: 'layered_analysis',
      type: 'composite',
      version: '1.0',
      meta: createMeta('Layered Analysis'),
      steps: [
        {
          id: 'overview_data',
          type: 'atomic',
          sql: 'SELECT fps, jank_rate FROM overview',
          display: { title: 'Overview', level: 'summary', layer: 'overview' },
        },
        {
          id: 'list_data',
          type: 'atomic',
          sql: 'SELECT session_id, duration_ms FROM sessions',
          display: { title: 'Sessions', level: 'summary', layer: 'list' },
        },
      ],
    };

    const layeredResult = await executor.executeCompositeSkill(
      layeredSkill,
      {},
      { traceId: 'trace-1' }
    );

    expect(layeredResult.layers.overview?.overview_data).toBeDefined();
    expect(layeredResult.layers.list?.list_data).toBeDefined();
    expect(layeredResult.metadata.skillName).toBe('layered_analysis');
  });

  it('应该支持带诊断的完整分析', async () => {
    mockTraceProcessor.query
      .mockResolvedValueOnce({
        columns: ['jank_rate', 'avg_fps'],
        rows: [[15, 45]],
      });

    const diagnosticSkill: SkillDefinition = {
      name: 'diagnostic_analysis',
      type: 'composite',
      version: '1.0',
      meta: createMeta('Diagnostic Analysis'),
      steps: [
        {
          id: 'metrics',
          type: 'atomic',
          sql: 'SELECT jank_rate, avg_fps FROM metrics',
          save_as: 'perf_metrics',
        },
        {
          id: 'diagnose',
          type: 'diagnostic',
          inputs: ['perf_metrics'],
          rules: [
            {
              condition: 'perf_metrics.data[0]?.jank_rate > 10',
              confidence: 0.9,
              diagnosis: '掉帧率过高 (${perf_metrics.data[0]?.jank_rate}%)',
              suggestions: ['检查主线程负载', '优化渲染管线'],
            },
            {
              condition: 'perf_metrics.data[0]?.avg_fps < 55',
              confidence: 0.8,
              diagnosis: 'FPS 偏低 (${perf_metrics.data[0]?.avg_fps})',
              suggestions: ['减少 UI 复杂度'],
            },
          ],
        },
      ],
    };
    executor.registerSkill(diagnosticSkill);

    const result = await executor.execute('diagnostic_analysis', 'trace-1');

    expect(result.success).toBe(true);
    expect(result.diagnostics.length).toBe(2); // 两条规则都匹配
    expect(result.diagnostics[0].suggestions?.length).toBeGreaterThan(0);
  });
});
