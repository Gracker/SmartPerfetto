/**
 * SmartPerfetto Frame Agent
 *
 * Phase 2.2: AI Agent for frame and scrolling performance analysis
 *
 * This agent specializes in:
 * - Detecting jank frames
 * - Analyzing scrolling performance
 * - Frame production/consumption timing
 * - Present fence analysis
 *
 * Skills wrapped as tools:
 * - janky_frame_analysis
 * - jank_frame_detail
 * - scrolling_analysis
 * - consumer_jank_detection
 * - sf_frame_consumption
 * - app_frame_production
 * - present_fence_timing
 */

import {
  BaseAgent,
  SkillDefinitionForAgent,
  TaskUnderstanding,
  ExecutionPlan,
  ExecutionResult,
} from '../base/baseAgent';
import {
  AgentConfig,
  AgentTask,
  AgentTaskContext,
  Hypothesis,
  Evidence,
} from '../../types/agentProtocol';
import { Finding } from '../../types';
import { ModelRouter } from '../../core/modelRouter';
import { SkillExecutionResult } from '../../../services/skillEngine';

// =============================================================================
// Frame Agent Configuration
// =============================================================================

/**
 * Skills that FrameAgent wraps as tools (lazy-loaded at executeTask time)
 */
const FRAME_SKILLS: SkillDefinitionForAgent[] = [
  {
    skillId: 'jank_frame_detail',
    toolName: 'get_frame_detail',
    description: '获取单帧详细信息，包括每个阶段的耗时',
    category: 'frame',
  },
  {
    skillId: 'scrolling_analysis',
    toolName: 'analyze_scrolling',
    description: '分析滑动性能，包括会话检测、FPS、掉帧率',
    category: 'frame',
  },
  {
    skillId: 'consumer_jank_detection',
    toolName: 'detect_consumer_jank',
    description: '检测 Consumer 侧卡顿，分析 GPU/合成层问题',
    category: 'frame',
  },
  {
    skillId: 'sf_frame_consumption',
    toolName: 'analyze_sf_frames',
    description: '分析 SurfaceFlinger 帧消费情况',
    category: 'frame',
  },
  {
    skillId: 'app_frame_production',
    toolName: 'analyze_app_frames',
    description: '分析应用帧生产情况，包括 Choreographer 回调',
    category: 'frame',
  },
  {
    skillId: 'present_fence_timing',
    toolName: 'analyze_present_fence',
    description: '分析 Present Fence 时序，检测显示延迟',
    category: 'frame',
  },
];

function toNumber(value: any): number {
  if (value === null || value === undefined || value === '') return 0;
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function extractSummaryRow(rawResults: Record<string, any>, keys: string[]): Record<string, any> | null {
  for (const key of keys) {
    const step = rawResults[key] as any;
    if (step && Array.isArray(step.data) && step.data.length > 0) {
      return step.data[0] as Record<string, any>;
    }
  }
  return null;
}

function extractListRows(rawResults: Record<string, any>, keys: string[]): any[] | null {
  for (const key of keys) {
    const step = rawResults[key] as any;
    if (step && Array.isArray(step.data) && step.data.length > 0) {
      return step.data as any[];
    }
  }
  return null;
}

function buildJankFinding(
  skillId: string,
  titlePrefix: string,
  jankCount: number,
  jankRate: number,
  details: Record<string, any>
): Finding {
  const rate = jankRate > 0 ? jankRate : (jankCount > 0 ? (jankCount / Math.max(details.total_frames || 1, 1)) * 100 : 0);
  let severity: Finding['severity'] = 'info';
  if (rate >= 15 || jankCount >= 30) severity = 'critical';
  else if (rate >= 5 || jankCount >= 10) severity = 'warning';

  return {
    id: `${skillId}_${Date.now()}`,
    category: 'frame',
    type: 'issue',
    severity,
    title: `${titlePrefix}: ${jankCount} 帧 (${rate.toFixed(1)}%)`,
    description: '滑动存在明显掉帧',
    source: skillId,
    confidence: 0.75,
    details: { jankCount, jankRate: rate, summary: details },
  };
}

// =============================================================================
// Frame Agent Implementation
// =============================================================================

/**
 * Frame Agent - AI agent for frame and scrolling analysis
 */
export class FrameAgent extends BaseAgent {
  constructor(modelRouter: ModelRouter) {
    super(
      {
        id: 'frame_agent',
        name: 'Frame Analysis Agent',
        domain: 'frame',
        description: 'AI agent specialized in frame timing, jank detection, and scrolling performance analysis',
        tools: [], // Loaded lazily via ensureToolsLoaded()
        maxIterations: 3,
        confidenceThreshold: 0.7,
        canDelegate: true,
        delegateTo: ['cpu_agent', 'binder_agent', 'memory_agent'],
      },
      modelRouter,
      FRAME_SKILLS
    );
  }

  // ==========================================================================
  // Domain-Specific Finding Extraction (Override)
  // ==========================================================================

  /**
   * Frame agent extracts additional findings from raw results beyond diagnostics,
   * including jank summaries, consumer jank, and jank frame lists.
   */
  protected extractFindingsFromResult(result: SkillExecutionResult, skillId: string, category: string): Finding[] {
    // Start with base diagnostic findings
    const findings = super.extractFindingsFromResult(result, skillId, category);

    // Add domain-specific extraction from raw results
    const rawResults = result.rawResults || {};
    const perfSummary = extractSummaryRow(rawResults, ['performance_summary', 'perf_summary']);
    const consumerSummary = extractSummaryRow(rawResults, ['consumer_jank_summary']);
    const jankList = extractListRows(rawResults, ['get_app_jank_frames', 'app_jank_frames', 'consumer_jank_frames']);

    if (perfSummary) {
      const jankCount = toNumber(perfSummary.janky_frames ?? perfSummary.jank_frames ?? perfSummary.jank_count);
      const jankRate = toNumber(perfSummary.jank_rate ?? perfSummary.consumer_jank_rate ?? perfSummary.app_jank_rate);
      if (jankCount > 0 || jankRate > 0) {
        findings.push(buildJankFinding(skillId, '滑动卡顿检测', jankCount, jankRate, perfSummary));
      }
    }

    if (consumerSummary) {
      const jankCount = toNumber(consumerSummary.consumer_jank_frames ?? consumerSummary.jank_frames);
      const jankRate = toNumber(consumerSummary.consumer_jank_rate);
      if (jankCount > 0 || jankRate > 0) {
        findings.push(buildJankFinding(skillId, 'Consumer 侧掉帧', jankCount, jankRate, consumerSummary));
      }
    }

    if (jankList && jankList.length > 0) {
      findings.push({
        id: `${skillId}_${Date.now()}_${findings.length}`,
        category: 'frame',
        type: 'issue',
        severity: jankList.length > 20 ? 'critical' : 'warning',
        title: `检测到 ${jankList.length} 个卡顿帧`,
        description: '存在明显掉帧，建议进一步查看帧级详细分析',
        source: skillId,
        confidence: 0.7,
        details: { sample: jankList.slice(0, 5) },
      });
    }

    return findings;
  }

  // ==========================================================================
  // Abstract Method Implementations
  // ==========================================================================

  protected buildUnderstandingPrompt(task: AgentTask): string {
    return `你是一个帧性能分析专家 Agent，负责分析 Android 应用的帧渲染和滑动性能问题。

## 任务
${task.description}

## 上下文
- 用户查询: ${task.context.query}
${task.context.hypothesis ? `- 当前假设: ${task.context.hypothesis.description}` : ''}
${task.context.relevantFindings?.length ? `- 相关发现: ${task.context.relevantFindings.map(f => f.title).join(', ')}` : ''}
${this.formatTaskContext(task)}

## 可用工具（只能使用以下工具）
${this.getToolDescriptionsForLLM()}

重要：你只能使用上面列出的工具，不要使用任何其他工具名称。

## 任务
分析这个任务，返回你的理解：

请以 JSON 格式返回：
{
  "objective": "任务的主要目标",
  "questions": ["需要回答的关键问题1", "问题2"],
  "relevantAreas": ["相关分析领域"],
  "recommendedTools": ["建议使用的工具名称"],
  "constraints": ["分析约束或限制"],
  "confidence": 0.0-1.0
}`;
  }

  protected buildPlanningPrompt(understanding: TaskUnderstanding, task: AgentTask): string {
    return `你是一个帧性能分析专家 Agent，需要规划执行步骤。

## 目标
${understanding.objective}

## 关键问题
${understanding.questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}

## 可用工具（只能使用以下工具）
${this.getToolDescriptionsForLLM()}

重要：你只能使用上面列出的工具，不要使用任何其他工具名称。

## 推荐工具
${understanding.recommendedTools.join(', ')}

## 任务
创建分析执行计划。

请以 JSON 格式返回：
{
  "steps": [
    {
      "toolName": "工具名称（必须是上方列出的工具之一）",
      "params": {},
      "purpose": "这一步的目的"
    }
  ],
  "expectedOutcomes": ["预期结果1", "预期结果2"],
  "estimatedTimeMs": 预计执行时间毫秒,
  "confidence": 0.0-1.0
}

注意：每个步骤独立执行，不需要指定步骤依赖。`;
  }

  protected buildReflectionPrompt(result: ExecutionResult, task: AgentTask): string {
    const findings = result.findings.map(f => `- [${f.severity}] ${f.title}`).join('\n');
    const steps = result.steps.map(s =>
      `- ${s.toolName}: ${s.result.success ? '成功' : '失败'} - ${s.observations.join(', ')}`
    ).join('\n');

    return `你是一个帧性能分析专家 Agent，需要反思分析结果。

## 原始任务
${task.description}

## 执行结果
${steps}

## 发现的问题
${findings || '无'}

## 任务
反思分析结果，评估是否达成目标，识别差距。

请以 JSON 格式返回：
{
  "insights": ["分析洞察1", "洞察2"],
  "objectivesMet": true/false,
  "findingsConfidence": 0.0-1.0,
  "gaps": ["分析差距1", "差距2"],
  "nextSteps": ["建议的后续步骤"],
  "hypothesisUpdates": [
    {
      "hypothesisId": "假设ID（如果有的话）",
      "action": "support/contradict/confirm/reject",
      "reason": "原因"
    }
  ],
  "questionsForOthers": [
    {
      "toAgent": "其他Agent ID",
      "question": "需要问的问题",
      "priority": 1-10
    }
  ]
}`;
  }

  protected async generateHypotheses(findings: Finding[], task: AgentTask): Promise<Hypothesis[]> {
    const hypotheses: Hypothesis[] = [];

    if (findings.length === 0) {
      return hypotheses;
    }

    // Generate hypotheses based on findings
    const criticalFindings = findings.filter(f => f.severity === 'critical');
    const jankFindings = findings.filter(f => f.title.toLowerCase().includes('jank') || f.title.includes('掉帧'));

    if (jankFindings.length > 0) {
      // Check for patterns in jank
      const hasMainThreadBlocking = findings.some(f =>
        f.title.includes('主线程') || f.title.includes('UI 线程') || f.title.includes('main thread')
      );
      const hasRenderThreadIssue = findings.some(f =>
        f.title.includes('渲染线程') || f.title.includes('RenderThread')
      );
      const hasGPUIssue = findings.some(f =>
        f.title.includes('GPU') || f.title.includes('合成')
      );

      if (hasMainThreadBlocking) {
        hypotheses.push(this.createHypothesis(
          '主线程阻塞导致帧超时',
          0.7,
          jankFindings.map(f => ({
            id: f.id,
            description: f.title,
            source: 'frame_agent',
            type: 'finding' as const,
            strength: 0.8,
          }))
        ));
      }

      if (hasRenderThreadIssue) {
        hypotheses.push(this.createHypothesis(
          'RenderThread 渲染耗时过长',
          0.6,
          jankFindings.map(f => ({
            id: f.id,
            description: f.title,
            source: 'frame_agent',
            type: 'finding' as const,
            strength: 0.7,
          }))
        ));
      }

      if (hasGPUIssue) {
        hypotheses.push(this.createHypothesis(
          'GPU/合成层存在性能瓶颈',
          0.5,
          jankFindings.map(f => ({
            id: f.id,
            description: f.title,
            source: 'frame_agent',
            type: 'finding' as const,
            strength: 0.6,
          }))
        ));
      }
    }

    // Generate hypothesis from critical findings
    for (const finding of criticalFindings) {
      hypotheses.push(this.createHypothesis(
        `${finding.title} 是主要性能瓶颈`,
        finding.confidence || 0.7,
        [{
          id: finding.id,
          description: finding.title,
          source: 'frame_agent',
          type: 'finding',
          strength: finding.confidence || 0.8,
        }]
      ));
    }

    return hypotheses;
  }

  protected getRecommendedTools(context: AgentTaskContext): string[] {
    const query = context.query?.toLowerCase() || '';
    const tools: string[] = [];

    // Always start with overview analysis
    tools.push('analyze_scrolling');

    // Add specific tools based on query
    if (query.includes('卡顿') || query.includes('jank') || query.includes('掉帧')) {
      tools.push('detect_consumer_jank');
    }

    if (query.includes('帧') || query.includes('frame')) {
      tools.push('analyze_app_frames');
      tools.push('analyze_sf_frames');
    }

    if (query.includes('滑动') || query.includes('scroll') || query.includes('列表')) {
      tools.push('analyze_scrolling');
      tools.push('detect_consumer_jank');
    }

    if (query.includes('vsync') || query.includes('fence') || query.includes('延迟')) {
      tools.push('analyze_present_fence');
    }

    // Default: use scrolling analysis
    if (tools.length === 0) {
      tools.push('analyze_scrolling');
    }

    // Remove duplicates
    return [...new Set(tools)];
  }
}

/**
 * Factory function to create FrameAgent
 */
export function createFrameAgent(modelRouter: ModelRouter): FrameAgent {
  return new FrameAgent(modelRouter);
}

export default FrameAgent;
