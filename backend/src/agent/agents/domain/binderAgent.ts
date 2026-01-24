/**
 * SmartPerfetto Binder Agent
 *
 * Phase 2.4: AI Agent for Binder IPC analysis
 *
 * Skills wrapped as tools (lazy-loaded at executeTask time):
 * - binder_analysis
 * - binder_detail
 * - binder_in_range
 * - lock_contention_analysis
 * - lock_contention_in_range
 */

import { BaseAgent, SkillDefinitionForAgent, TaskUnderstanding, ExecutionResult } from '../base/baseAgent';
import {
  AgentTask,
  AgentTaskContext,
  Hypothesis,
} from '../../types/agentProtocol';
import { Finding } from '../../types';
import { ModelRouter } from '../../core/modelRouter';

// =============================================================================
// Binder Agent Configuration
// =============================================================================

const BINDER_SKILLS: SkillDefinitionForAgent[] = [
  { skillId: 'binder_analysis', toolName: 'analyze_binder_overview', description: '分析 Binder IPC 通信概况，找出慢调用', category: 'binder' },
  { skillId: 'binder_detail', toolName: 'get_binder_detail', description: '获取单个 Binder 调用的详细信息', category: 'binder' },
  { skillId: 'binder_in_range', toolName: 'analyze_binder_range', description: '分析指定时间范围内的 Binder 调用', category: 'binder' },
  { skillId: 'lock_contention_analysis', toolName: 'analyze_lock_contention', description: '分析锁竞争情况', category: 'binder' },
  { skillId: 'lock_contention_in_range', toolName: 'analyze_lock_range', description: '分析指定时间范围内的锁竞争', category: 'binder' },
];

// =============================================================================
// Binder Agent Implementation
// =============================================================================

export class BinderAgent extends BaseAgent {
  constructor(modelRouter: ModelRouter) {
    super(
      {
        id: 'binder_agent',
        name: 'Binder Analysis Agent',
        domain: 'binder',
        description: 'AI agent specialized in Binder IPC and lock contention analysis',
        tools: [], // Loaded lazily via ensureToolsLoaded()
        maxIterations: 3,
        confidenceThreshold: 0.7,
        canDelegate: true,
        delegateTo: ['cpu_agent', 'frame_agent'],
      },
      modelRouter,
      BINDER_SKILLS
    );
  }

  protected buildUnderstandingPrompt(task: AgentTask): string {
    return `你是一个 Binder IPC 分析专家 Agent，负责分析 Android 系统的进程间通信问题。

## 任务
${task.description}

## 上下文
- 用户查询: ${task.context.query}
${task.context.hypothesis ? `- 当前假设: ${task.context.hypothesis.description}` : ''}
${this.formatTaskContext(task)}

${this.getToolSectionForPrompt()}

请以 JSON 格式返回：{"objective":"","questions":[],"relevantAreas":[],"recommendedTools":[],"constraints":[],"confidence":0.7}`;
  }

  protected buildPlanningPrompt(understanding: TaskUnderstanding, task: AgentTask): string {
    return `规划 Binder 分析：
目标: ${understanding.objective}

${this.getToolSectionForPrompt()}

请以 JSON 返回：{"steps":[{"toolName":"","params":{},"purpose":""}],"expectedOutcomes":[],"estimatedTimeMs":30000,"confidence":0.7}`;
  }

  protected buildReflectionPrompt(result: ExecutionResult, task: AgentTask): string {
    return `反思 Binder 分析结果：
发现: ${result.findings.map(f => f.title).join(', ') || '无'}

请以 JSON 返回：{"insights":[],"objectivesMet":${result.success},"findingsConfidence":0.7,"gaps":[],"nextSteps":[],"hypothesisUpdates":[],"questionsForOthers":[]}`;
  }

  protected async generateHypotheses(findings: Finding[]): Promise<Hypothesis[]> {
    const hypotheses: Hypothesis[] = [];
    const binderFindings = findings.filter(f => f.title.includes('Binder') || f.title.includes('锁'));

    if (binderFindings.length > 0) {
      hypotheses.push(this.createHypothesis(
        'Binder 调用或锁竞争导致阻塞',
        0.6,
        binderFindings.map(f => ({ id: f.id, description: f.title, source: 'binder_agent', type: 'finding' as const, strength: 0.7 }))
      ));
    }

    return hypotheses;
  }

  protected getRecommendedTools(context: AgentTaskContext): string[] {
    const query = context.query?.toLowerCase() || '';
    const hasTimeRange = !!context.timeRange;
    const tools: string[] = [];

    // Prefer in-range binder analysis when time range is provided (e.g. jank interval).
    tools.push(hasTimeRange ? 'analyze_binder_range' : 'analyze_binder_overview');

    const evidenceText = (context.evidenceNeeded || []).join(' ').toLowerCase();
    if (
      query.includes('锁') ||
      query.includes('lock') ||
      query.includes('contention') ||
      evidenceText.includes('lock') ||
      evidenceText.includes('contention') ||
      evidenceText.includes('锁')
    ) {
      tools.push(hasTimeRange ? 'analyze_lock_range' : 'analyze_lock_contention');
    }

    return [...new Set(tools)];
  }
}

export function createBinderAgent(modelRouter: ModelRouter): BinderAgent {
  return new BinderAgent(modelRouter);
}

export default BinderAgent;
