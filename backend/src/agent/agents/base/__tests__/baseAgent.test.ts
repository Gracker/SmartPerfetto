import type { AgentConfig } from '../../../types/agentProtocol';
import type { SkillExecutionResult } from '../../../../services/skillEngine/types';
import type { Finding } from '../../../types';
import { BaseAgent } from '../baseAgent';

class TestAgent extends BaseAgent {
  protected buildUnderstandingPrompt(): string { return ''; }
  protected buildPlanningPrompt(): string { return ''; }
  protected buildReflectionPrompt(): string { return ''; }
  protected async generateHypotheses(): Promise<any[]> { return []; }
  protected getRecommendedTools(): string[] { return []; }
}

describe('BaseAgent - synthesize summary to findings', () => {
  const config: AgentConfig = {
    id: 'test_agent',
    name: 'Test Agent',
    domain: 'test',
    description: 'test',
    tools: [],
    maxIterations: 1,
    confidenceThreshold: 0.5,
    canDelegate: false,
  };

  test('extractFindingsFromResult emits finding from synthesize summary', () => {
    const agent = new TestAgent(config, {} as any);

    const result: SkillExecutionResult = {
      skillId: 'gc_analysis',
      skillName: 'GC 分析',
      success: true,
      displayResults: [
        {
          stepId: '__synthesize_summary__',
          title: '洞见摘要',
          level: 'key',
          layer: 'overview',
          format: 'summary',
          data: {
            summary: {
              title: '洞见摘要',
              content: '- GC 总耗时偏高\n- alloc GC 偏多',
              metrics: [
                { label: 'GC 总耗时', value: 512, unit: 'ms', severity: 'warning' },
              ],
            },
          },
        } as any,
      ],
      diagnostics: [],
      executionTimeMs: 1,
    };

    const findings = (agent as any).extractFindingsFromResult(result, result.skillId, 'memory') as Finding[];

    expect(findings.length).toBe(1);
    expect(findings[0].title).toContain('洞见摘要');
    expect(findings[0].severity).toBe('warning');
    expect((findings[0].details as any)?.metrics?.length).toBe(1);
  });

  test('severity is critical when any metric is critical', () => {
    const agent = new TestAgent(config, {} as any);

    const result: SkillExecutionResult = {
      skillId: 'cpu_analysis',
      skillName: 'CPU 分析',
      success: true,
      displayResults: [
        {
          stepId: '__synthesize_summary__',
          title: '洞见摘要',
          level: 'key',
          layer: 'overview',
          format: 'summary',
          data: {
            summary: {
              title: '洞见摘要',
              content: '- CPU 占用非常高',
              metrics: [
                { label: 'CPU Running', value: 98, unit: '%', severity: 'critical' },
              ],
            },
          },
        } as any,
      ],
      diagnostics: [],
      executionTimeMs: 1,
    };

    const findings = (agent as any).extractFindingsFromResult(result, result.skillId, 'cpu') as Finding[];
    expect(findings[0].severity).toBe('critical');
  });
});

describe('BaseAgent - focusTools constrained planning', () => {
  const config: AgentConfig = {
    id: 'test_agent',
    name: 'Test Agent',
    domain: 'test',
    description: 'test',
    tools: [
      {
        name: 'analyze_scrolling',
        description: 'Analyze scrolling',
        category: 'frame',
        execute: async () => ({ success: true, data: {} }),
      } as any,
      {
        name: 'game_fps_analysis',
        description: 'Analyze game fps',
        category: 'frame',
        execute: async () => ({ success: true, data: {} }),
      } as any,
    ],
    maxIterations: 1,
    confidenceThreshold: 0.5,
    canDelegate: false,
  };

  function createTask(additionalData: Record<string, any>): any {
    return {
      id: 'task-1',
      description: 'test task',
      priority: 'high',
      requiredCapabilities: [],
      context: {
        currentFindings: [],
        previousActions: [],
        timeRange: undefined,
        processInfo: undefined,
        additionalData,
      },
    };
  }

  test('filters LLM-planned tools to focusTools', async () => {
    const modelRouter = {
      callWithFallback: jest.fn().mockResolvedValue({
        response: JSON.stringify({
          steps: [
            { toolName: 'game_fps_analysis', purpose: 'wrong tool' },
            { toolName: 'analyze_scrolling', purpose: 'right tool' },
          ],
          expectedOutcomes: ['outcome'],
          estimatedTimeMs: 1000,
          confidence: 0.8,
        }),
      }),
    } as any;

    const agent = new TestAgent(config, modelRouter);
    const plan = await (agent as any).plan(
      {
        objective: 'analyze scrolling',
        questions: [],
        relevantAreas: ['frame'],
        recommendedTools: ['game_fps_analysis', 'analyze_scrolling'],
        constraints: [],
        confidence: 0.9,
      },
      createTask({ focusTools: ['analyze_scrolling'] })
    );

    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].toolName).toBe('analyze_scrolling');
  });

  test('falls back to focused tools when LLM plan contains only non-focused tools', async () => {
    const modelRouter = {
      callWithFallback: jest.fn().mockResolvedValue({
        response: JSON.stringify({
          steps: [{ toolName: 'game_fps_analysis', purpose: 'wrong tool' }],
          expectedOutcomes: ['outcome'],
          estimatedTimeMs: 1000,
          confidence: 0.8,
        }),
      }),
    } as any;

    const agent = new TestAgent(config, modelRouter);
    const plan = await (agent as any).plan(
      {
        objective: 'analyze scrolling',
        questions: [],
        relevantAreas: ['frame'],
        recommendedTools: ['game_fps_analysis'],
        constraints: [],
        confidence: 0.9,
      },
      createTask({ focusTools: ['analyze_scrolling'] })
    );

    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].toolName).toBe('analyze_scrolling');
  });
});

describe('BaseAgent - dynamic SQL error handling', () => {
  const config: AgentConfig = {
    id: 'test_agent',
    name: 'Test Agent',
    domain: 'test',
    description: 'test',
    tools: [],
    maxIterations: 1,
    confidenceThreshold: 0.5,
    canDelegate: false,
  };

  test('treats queryResult.error as execution failure', async () => {
    const agent = new TestAgent(config, {} as any);
    const query = jest.fn().mockResolvedValue({
      columns: ['value'],
      rows: [[1]],
      error: 'no such table: bad_table',
    });

    const ensureLimit = jest.fn((sql: string) => sql);
    const validate = jest.fn().mockReturnValue({ valid: true, errors: [] });
    const generateSQL = jest.fn().mockResolvedValue({
      success: true,
      sql: {
        sql: 'SELECT * FROM bad_table LIMIT 1',
        explanation: 'test',
        expectedColumns: ['value'],
        riskLevel: 'safe',
        riskFactors: [],
      },
    });
    const repairSQL = jest.fn().mockResolvedValue({
      success: false,
      error: 'cannot repair',
    });

    (agent as any).getSQLGenerator = jest.fn(async () => ({
      generateSQL,
      repairSQL,
    }));
    (agent as any).getSQLValidator = jest.fn(async () => ({
      ensureLimit,
      validate,
    }));
    (agent as any).getSQLLearningSystem = jest.fn(async () => ({
      fixSQL: jest.fn().mockResolvedValue({
        success: false,
        fixedSQL: 'SELECT * FROM bad_table LIMIT 1',
        appliedRules: [],
        method: 'basic_fix',
      }),
    }));

    const result = await (agent as any).generateAndExecuteSQL(
      'diagnose problem',
      {
        traceId: 'trace_1',
        traceProcessorService: { query },
      }
    );

    expect(query).toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(String(result.error || '')).toContain('cannot repair');
  });
});
