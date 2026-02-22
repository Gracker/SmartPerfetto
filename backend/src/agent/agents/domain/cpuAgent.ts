/**
 * SmartPerfetto CPU Agent
 *
 * Phase 2.3: AI Agent for CPU performance analysis
 *
 * This agent specializes in:
 * - CPU scheduling analysis
 * - CPU frequency monitoring
 * - CPU load analysis
 * - Callstack profiling
 *
 * Skills wrapped as tools (lazy-loaded at executeTask time):
 * - cpu_analysis
 * - scheduling_analysis
 * - cpu_freq_timeline
 * - cpu_load_in_range
 * - cpu_slice_analysis
 * - cpu_profiling
 * - callstack_analysis
 */

import { BaseAgent, TaskUnderstanding, ExecutionResult } from '../base/baseAgent';
import {
  AgentTask,
  AgentTaskContext,
  Hypothesis,
} from '../../types/agentProtocol';
import { Finding } from '../../types';
import { ModelRouter } from '../../core/modelRouter';
import { getAdbAgentTools } from '../tools/adbTools';
import { CPU_SKILLS } from './skillCatalog';

// =============================================================================
// CPU Agent Implementation
// =============================================================================

export class CPUAgent extends BaseAgent {
  constructor(modelRouter: ModelRouter) {
    super(
      {
        id: 'cpu_agent',
        name: 'CPU Analysis Agent',
        domain: 'cpu',
        description: 'AI agent specialized in CPU scheduling, frequency, and load analysis',
        tools: [...getAdbAgentTools()],
        maxIterations: 3,
        confidenceThreshold: 0.7,
        canDelegate: true,
        delegateTo: ['frame_agent', 'binder_agent'],
      },
      modelRouter,
      CPU_SKILLS
    );
  }

  protected buildUnderstandingPrompt(task: AgentTask): string {
    return `你是一个 CPU 性能分析专家 Agent，负责分析 Android 系统的 CPU 调度和负载问题。

## 任务
${task.description}

## 上下文
- 用户查询: ${task.context.query}
${task.context.hypothesis ? `- 当前假设: ${task.context.hypothesis.description}` : ''}
${this.formatTaskContext(task)}

${this.getToolSectionForPrompt()}

请以 JSON 格式返回你的理解：
{
  "objective": "任务的主要目标",
  "questions": ["需要回答的关键问题"],
  "relevantAreas": ["相关分析领域"],
  "recommendedTools": ["建议使用的工具"],
  "constraints": ["约束"],
  "confidence": 0.0-1.0
}`;
  }

  protected buildPlanningPrompt(understanding: TaskUnderstanding, task: AgentTask): string {
    return `你是一个 CPU 性能分析专家 Agent，需要规划执行步骤。

## 目标
${understanding.objective}

${this.getToolSectionForPrompt()}

请以 JSON 格式返回执行计划：
{
  "steps": [
    { "toolName": "工具名称", "params": {}, "purpose": "目的" }
  ],
  "expectedOutcomes": ["预期结果"],
  "estimatedTimeMs": 30000,
  "confidence": 0.7
}`;
  }

  protected buildReflectionPrompt(result: ExecutionResult, task: AgentTask): string {
    const findings = result.findings.map(f => `- [${f.severity}] ${f.title}`).join('\n');
    return `反思 CPU 分析结果：

## 发现
${findings || '无'}

请以 JSON 格式返回反思：
{
  "insights": ["洞察"],
  "objectivesMet": true/false,
  "findingsConfidence": 0.7,
  "gaps": ["差距"],
  "nextSteps": ["建议"],
  "hypothesisUpdates": [],
  "questionsForOthers": []
}`;
  }

  protected async generateHypotheses(findings: Finding[], task: AgentTask): Promise<Hypothesis[]> {
    const hypotheses: Hypothesis[] = [];

    const cpuHighFindings = findings.filter(f =>
      f.title.includes('CPU') || f.title.includes('负载') || f.title.includes('调度')
    );

    if (cpuHighFindings.length > 0) {
      hypotheses.push(this.createHypothesis(
        'CPU 负载过高导致性能问题',
        0.6,
        cpuHighFindings.map(f => ({
          id: f.id,
          description: f.title,
          source: 'cpu_agent',
          type: 'finding' as const,
          strength: 0.7,
        }))
      ));
    }

    return hypotheses;
  }

  protected getRecommendedTools(context: AgentTaskContext): string[] {
    const query = context.query?.toLowerCase() || '';
    const hasTimeRange = !!context.timeRange;
    const wantsGlobalOverview =
      query.includes('整体') ||
      query.includes('全局') ||
      query.includes('整个') ||
      query.includes('overall') ||
      query.includes('global') ||
      query.includes('whole trace') ||
      query.includes('full trace');

    const tools: string[] = [];

    // Prefer in-range analysis when a focus time range exists (e.g. scrolling jank interval).
    if (hasTimeRange && !wantsGlobalOverview) {
      tools.push('analyze_cpu_load');
      tools.push('analyze_scheduling');
      tools.push('get_cpu_freq_timeline');
      tools.push('analyze_cpu_slices');
    } else {
      tools.push('analyze_cpu_overview');
    }

    if (query.includes('调度') || query.includes('schedule')) {
      tools.push('analyze_scheduling');
    }
    if (query.includes('频率') || query.includes('freq') || query.includes('降频')) {
      tools.push('get_cpu_freq_timeline');
    }
    if (query.includes('负载') || query.includes('load')) {
      tools.push('analyze_cpu_load');
    }
    if (query.includes('热点') || query.includes('hotspot') || query.includes('profile')) {
      tools.push('profile_cpu_hotspots');
      tools.push('analyze_callstacks');
    }

    return [...new Set(tools)];
  }
}

export function createCPUAgent(modelRouter: ModelRouter): CPUAgent {
  return new CPUAgent(modelRouter);
}

export default CPUAgent;
