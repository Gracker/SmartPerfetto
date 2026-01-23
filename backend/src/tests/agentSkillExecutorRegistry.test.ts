import { describe, it, expect } from '@jest/globals';
import {
  BaseAgent,
  SkillDefinitionForAgent,
  TaskUnderstanding,
  ExecutionResult,
} from '../agent/agents/base/baseAgent';
import { AgentTask, AgentTaskContext, Hypothesis } from '../agent/types/agentProtocol';
import { Finding } from '../agent/types';

class MockModelRouter {
  async callWithFallback(_prompt: string, taskType: string): Promise<{ response: string }> {
    if (taskType === 'intent_understanding') {
      return {
        response: JSON.stringify({
          objective: 'test',
          questions: [],
          relevantAreas: ['frame'],
          recommendedTools: ['run_cpu_analysis'],
          constraints: [],
          confidence: 0.9,
        }),
      };
    }
    if (taskType === 'planning') {
      return {
        response: JSON.stringify({
          steps: [{ toolName: 'run_cpu_analysis', params: {}, purpose: 'test' }],
          expectedOutcomes: [],
          estimatedTimeMs: 1,
          confidence: 0.9,
        }),
      };
    }
    if (taskType === 'evaluation') {
      return {
        response: JSON.stringify({
          insights: [],
          objectivesMet: true,
          findingsConfidence: 0.9,
          gaps: [],
          nextSteps: [],
          hypothesisUpdates: [],
          questionsForOthers: [],
        }),
      };
    }
    return { response: '{}' };
  }
}

const TEST_SKILLS: SkillDefinitionForAgent[] = [
  {
    skillId: 'cpu_analysis',
    toolName: 'run_cpu_analysis',
    description: 'Test tool wrapping cpu_analysis skill',
    category: 'cpu',
  },
];

class TestAgent extends BaseAgent {
  constructor() {
    super(
      {
        id: 'test_agent',
        name: 'Test Agent',
        domain: 'frame',
        description: 'Test agent',
        tools: [],
        maxIterations: 1,
        confidenceThreshold: 0.5,
        canDelegate: false,
        delegateTo: [],
      },
      new MockModelRouter() as any,
      TEST_SKILLS
    );
  }

  protected buildUnderstandingPrompt(_task: AgentTask): string {
    return '';
  }
  protected buildPlanningPrompt(_understanding: TaskUnderstanding, _task: AgentTask): string {
    return '';
  }
  protected buildReflectionPrompt(_result: ExecutionResult, _task: AgentTask): string {
    return '';
  }
  protected async generateHypotheses(_findings: Finding[], _task: AgentTask): Promise<Hypothesis[]> {
    return [];
  }
  protected getRecommendedTools(_context: AgentTaskContext): string[] {
    return ['run_cpu_analysis'];
  }
}

describe('BaseAgent SkillExecutor registry', () => {
  it('registers skills so tool execution does not fail with \"Skill not found\"', async () => {
    const mockTraceProcessor = {
      async query(_traceId: string, sql: string): Promise<any> {
        // Prerequisite checks query sqlite_master table presence.
        if (sql.includes('FROM sqlite_master')) {
          return { columns: ['name'], rows: [['process']], durationMs: 0 };
        }

        // Return a generic single-row result for all atomic steps
        return {
          columns: ['dummy'],
          rows: [[1]],
          durationMs: 0,
        };
      },
    };

    const agent = new TestAgent();

    const sharedContext = {
      sessionId: 'test-session',
      traceId: 'test-trace',
      hypotheses: new Map(),
      confirmedFindings: [],
      investigationPath: [],
    };

    const task: AgentTask = {
      id: 't1',
      description: 'test',
      targetAgentId: 'test_agent',
      priority: 1,
      context: {
        query: 'test',
        additionalData: { traceProcessorService: mockTraceProcessor },
      },
      dependencies: [],
      createdAt: Date.now(),
    };

    const res = await agent.executeTask(task, sharedContext as any);

    expect(res.success).toBe(true);
    expect(res.toolResults?.[0]?.success).toBe(true);
    expect(res.toolResults?.[0]?.error).toBeUndefined();
  });
});
