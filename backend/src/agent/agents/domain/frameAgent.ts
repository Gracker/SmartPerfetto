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
 * - jank_frame_detail (comprehensive per-frame analysis)
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
import { getAdbAgentTools } from '../tools/adbTools';
import {
  DEFAULT_JANK_THRESHOLDS,
  JANK_LIST_CRITICAL_THRESHOLD,
  DEFAULT_RAW_FINDING_CONFIDENCE,
  JankSeverityThresholds,
} from '../../../config/thresholds';

// =============================================================================
// Frame Agent Configuration
// =============================================================================

/**
 * Skills that FrameAgent wraps as tools (lazy-loaded at executeTask time)
 *
 * Each skill description includes:
 * - What it does
 * - When to use it
 * - What output to expect
 */
const FRAME_SKILLS: SkillDefinitionForAgent[] = [
  {
    skillId: 'jank_frame_detail',
    toolName: 'get_frame_detail',
    description: '【深度分析单帧】获取指定帧的完整诊断信息，包括四象限分析、Binder调用、CPU频率、主线程/RenderThread耗时操作、锁竞争、GC影响、IO阻塞等。适用于：已知帧ID/时间范围后的深度分析。输出：根因诊断+详细数据表格',
    category: 'frame',
  },
  {
    skillId: 'scrolling_analysis',
    toolName: 'analyze_scrolling',
    description: '【滑动概览分析】检测滑动会话、统计FPS和掉帧率、识别卡顿帧列表。适用于：首次分析滑动性能、获取会话列表。输出：会话列表+掉帧统计+卡顿帧列表',
    category: 'frame',
  },
  {
    skillId: 'consumer_jank_detection',
    toolName: 'detect_consumer_jank',
    description: '【消费端卡顿检测】分析SurfaceFlinger合成和GPU渲染延迟导致的掉帧。适用于：App侧正常但仍有掉帧、怀疑SF/GPU问题。输出：消费端掉帧列表+原因分类',
    category: 'frame',
  },
  {
    skillId: 'sf_frame_consumption',
    toolName: 'analyze_sf_frames',
    description: '【SF帧消费分析】分析SurfaceFlinger对App帧的处理情况，包括帧到达时序、合成延迟。适用于：分析系统合成层瓶颈。输出：SF处理时序数据',
    category: 'frame',
  },
  {
    skillId: 'app_frame_production',
    toolName: 'analyze_app_frames',
    description: '【App帧生产分析】分析应用帧生产流程，包括Choreographer回调时序、VSYNC对齐。适用于：分析App帧生产节奏问题。输出：帧生产时序+VSYNC对齐情况',
    category: 'frame',
  },
  {
    skillId: 'present_fence_timing',
    toolName: 'analyze_present_fence',
    description: '【显示时序分析】分析Present Fence等待时间和显示延迟。适用于：怀疑显示端问题、GPU Fence阻塞。输出：Fence等待时序数据',
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

function parseTsNs(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim().replace(/^0+/, '');
  if (!/^\d+$/.test(s) || s === '') return null;
  return s;
}

function compareTsNs(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function buildWindowScope(rawResults: Record<string, any>, appJankList: any[] | null, consumerJankList: any[] | null): {
  sessionIds: number[];
  startTsNs?: string;
  endTsNs?: string;
} {
  const sessionIds = new Set<number>();
  let startTs: string | null = null;
  let endTs: string | null = null;

  const addSession = (v: unknown): void => {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) sessionIds.add(n);
  };

  const addTs = (s: string | null, kind: 'start' | 'end'): void => {
    if (!s) return;
    if (kind === 'start') {
      if (startTs === null || compareTsNs(s, startTs) < 0) startTs = s;
      return;
    }
    if (endTs === null || compareTsNs(s, endTs) > 0) endTs = s;
  };

  const collectFromRows = (rows: any[] | null): void => {
    if (!Array.isArray(rows)) return;
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      addSession((row as any).session_id);
      addSession((row as any).sessionId);
      addTs(parseTsNs((row as any).start_ts) || parseTsNs((row as any).startTs), 'start');
      addTs(parseTsNs((row as any).end_ts) || parseTsNs((row as any).endTs) || parseTsNs((row as any).ts), 'end');
    }
  };

  collectFromRows(appJankList);
  collectFromRows(consumerJankList);
  collectFromRows(extractListRows(rawResults, ['session_jank']));
  collectFromRows(extractListRows(rawResults, ['scroll_sessions']));

  const scope: { sessionIds: number[]; startTsNs?: string; endTsNs?: string } = {
    sessionIds: Array.from(sessionIds).sort((a, b) => a - b),
  };
  if (startTs !== null) scope.startTsNs = startTs;
  if (endTs !== null) scope.endTsNs = endTs;
  return scope;
}

/**
 * Build a finding for jank detection results.
 *
 * Severity classification uses configurable thresholds:
 * - Critical: rate >= criticalRate OR count >= criticalCount
 * - Warning: rate >= warningRate OR count >= warningCount
 * - Info: below warning thresholds
 *
 * @param skillId - Source skill identifier
 * @param titlePrefix - Prefix for finding title
 * @param jankCount - Number of jank frames
 * @param jankRate - Jank rate as percentage
 * @param details - Additional details to include
 * @param thresholds - Optional custom thresholds (defaults to DEFAULT_JANK_THRESHOLDS)
 */
function buildJankFinding(
  skillId: string,
  titlePrefix: string,
  jankCount: number,
  jankRate: number,
  details: Record<string, any>,
  thresholds: JankSeverityThresholds = DEFAULT_JANK_THRESHOLDS
): Finding {
  const rate = jankRate > 0 ? jankRate : (jankCount > 0 ? (jankCount / Math.max(details.total_frames || 1, 1)) * 100 : 0);
  let severity: Finding['severity'] = 'info';

  // Use configurable thresholds for severity classification
  if (rate >= thresholds.criticalRate || jankCount >= thresholds.criticalCount) {
    severity = 'critical';
  } else if (rate >= thresholds.warningRate || jankCount >= thresholds.warningCount) {
    severity = 'warning';
  }

  return {
    id: `${skillId}_${Date.now()}`,
    category: 'frame',
    type: 'issue',
    severity,
    title: `${titlePrefix}: ${jankCount} 帧 (${rate.toFixed(1)}%)`,
    description: '滑动存在明显掉帧',
    source: skillId,
    confidence: DEFAULT_RAW_FINDING_CONFIDENCE,
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
        tools: [...getAdbAgentTools()],
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
   *
   * Key design: Merge jank statistics from multiple sources into a single Finding
   * to avoid duplicate/conflicting reports (e.g., "13 frames" vs "39 frames" vs "25 frames").
   *
   * Priority order for data source selection (default for user-facing jank analysis):
   * 1. Scrolling skill frame list (get_app_jank_frames/app_jank_frames) - concrete per-frame data
   * 2. Scrolling skill summary (performance_summary) - same detection logic aggregate
   * 3. Consumer-side detection (consumerSummary) - supplemental perspective (SF/HWC layer)
   *
   * IMPORTANT trade-off notes for Android performance experts:
   * - 默认以 scrolling_analysis 定义的“真实掉帧”作为主口径，避免跨技能口径混淆
   * - consumer_jank_detection 保留为补充证据，用于定位 SF/HWC/GPU 层问题
   * - All sources are preserved in evidence[] for expert review
   */
  protected extractFindingsFromResult(result: SkillExecutionResult, skillId: string, category: string): Finding[] {
    // Start with base diagnostic findings
    const findings = super.extractFindingsFromResult(result, skillId, category);

    // Add domain-specific extraction from raw results
    const rawResults = result.rawResults || {};
    const perfSummary = extractSummaryRow(rawResults, ['performance_summary', 'perf_summary']);
    const consumerSummary = extractSummaryRow(rawResults, ['consumer_jank_summary']);
    const appJankList = extractListRows(rawResults, ['get_app_jank_frames', 'app_jank_frames']);
    const consumerJankList = extractListRows(rawResults, ['consumer_jank_frames']);
    const windowScope = buildWindowScope(rawResults, appJankList, consumerJankList);

    // Collect all available jank data sources
    const perfJankCount = perfSummary
      ? toNumber(perfSummary.janky_frames ?? perfSummary.jank_frames ?? perfSummary.jank_count)
      : 0;
    const perfJankRate = perfSummary ? toNumber(perfSummary.jank_rate ?? perfSummary.app_jank_rate) : 0;
    const consumerJankCount = consumerSummary
      ? toNumber(consumerSummary.consumer_jank_frames ?? consumerSummary.jank_frames)
      : 0;
    const consumerJankRate = consumerSummary
      ? toNumber(consumerSummary.consumer_jank_rate)
      : 0;
    const appListJankCount = appJankList?.length ?? 0;
    const consumerListJankCount = consumerJankList?.length ?? 0;

    // Select the most reliable data source
    // Priority: scrolling frame list > scrolling summary > consumer summary/list
    let primaryJankCount = 0;
    let primaryJankRate = 0;
    let dataSource = '';
    const evidenceSources: string[] = [];

    if (appListJankCount > 0) {
      primaryJankCount = appListJankCount;
      // Estimate rate if we have total frames from perfSummary
      const totalFrames = perfSummary ? toNumber(perfSummary.total_frames) : 0;
      primaryJankRate = totalFrames > 0 ? (appListJankCount / totalFrames) * 100 : 0;
      dataSource = 'Scrolling 帧列表';
    } else if (perfJankCount > 0 || perfJankRate > 0) {
      primaryJankCount = perfJankCount;
      primaryJankRate = perfJankRate;
      dataSource = 'Scrolling 概览';
    } else if (consumerJankCount > 0 || consumerJankRate > 0 || consumerListJankCount > 0) {
      primaryJankCount = consumerJankCount > 0 ? consumerJankCount : consumerListJankCount;
      primaryJankRate = consumerJankRate;
      dataSource = '消费端检测(补充)';
    }

    // Build evidence list showing all data sources for transparency
    if (appListJankCount > 0) {
      evidenceSources.push(`Scrolling 帧列表: ${appListJankCount} 帧`);
    }
    if (perfJankCount > 0 || perfJankRate > 0) {
      evidenceSources.push(`Scrolling 概览: ${perfJankCount} 帧 (${perfJankRate.toFixed(1)}%)`);
    }
    if (consumerJankCount > 0 || consumerJankRate > 0) {
      evidenceSources.push(`消费端: ${consumerJankCount} 帧 (${consumerJankRate.toFixed(1)}%)`);
    }
    if (consumerListJankCount > 0) {
      evidenceSources.push(`消费端帧列表: ${consumerListJankCount} 帧`);
    }

    // Generate a single consolidated Finding for jank detection
    if (primaryJankCount > 0 || primaryJankRate > 0) {
      const titlePrefix = windowScope.sessionIds.length === 1
        ? `区间${windowScope.sessionIds[0]} 滑动卡顿检测`
        : '滑动卡顿检测';
      const scopeParts: string[] = [];
      if (windowScope.sessionIds.length > 0) {
        scopeParts.push(`session=${windowScope.sessionIds.join(',')}`);
      }
      if (windowScope.startTsNs && windowScope.endTsNs) {
        scopeParts.push(`时间窗=${windowScope.startTsNs}~${windowScope.endTsNs}`);
      }

      const severity: Finding['severity'] =
        primaryJankRate >= DEFAULT_JANK_THRESHOLDS.criticalRate ||
        primaryJankCount >= DEFAULT_JANK_THRESHOLDS.criticalCount
          ? 'critical'
          : primaryJankRate >= DEFAULT_JANK_THRESHOLDS.warningRate ||
            primaryJankCount >= DEFAULT_JANK_THRESHOLDS.warningCount
            ? 'warning'
            : 'info';

      findings.push({
        id: `${skillId}_jank_consolidated_${Date.now()}`,
        category: 'frame',
        type: 'issue',
        severity,
        title: `${titlePrefix}: ${primaryJankCount} 帧 (${primaryJankRate.toFixed(1)}%)`,
        description: `数据来源: ${dataSource}${scopeParts.length > 0 ? `；范围: ${scopeParts.join('，')}` : ''}`,
        source: skillId,
        confidence: DEFAULT_RAW_FINDING_CONFIDENCE,
        details: {
          jankCount: primaryJankCount,
          jankRate: primaryJankRate,
          dataSource,
          sourceWindow: {
            sessionIds: windowScope.sessionIds,
            ...(windowScope.startTsNs && { startTsNs: windowScope.startTsNs }),
            ...(windowScope.endTsNs && { endTsNs: windowScope.endTsNs }),
          },
          // Include all sources for debugging/comparison
          allSources: {
            scrollingList: appListJankCount > 0 ? { count: appListJankCount } : null,
            scrollingSummary: perfJankCount > 0 ? { count: perfJankCount, rate: perfJankRate } : null,
            consumer: consumerJankCount > 0 ? { count: consumerJankCount, rate: consumerJankRate } : null,
            consumerList: consumerListJankCount > 0 ? { count: consumerListJankCount } : null,
          },
          sample: (appJankList?.slice(0, 5) ?? consumerJankList?.slice(0, 5)) || [],
        },
        evidence: evidenceSources,
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

${this.getToolSectionForPrompt()}

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

${this.getToolSectionForPrompt()}

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
    const needsConsumerPerspective =
      query.includes('surfaceflinger') ||
      query.includes('sf') ||
      query.includes('消费端') ||
      query.includes('合成') ||
      query.includes('hwc') ||
      query.includes('gpu') ||
      query.includes('renderthread') ||
      query.includes('display') ||
      query.includes('呈现') ||
      query.includes('fence');

    // Always start with overview analysis
    tools.push('analyze_scrolling');

    if (query.includes('帧') || query.includes('frame')) {
      tools.push('analyze_app_frames');
      tools.push('analyze_sf_frames');
    }

    if (query.includes('滑动') || query.includes('scroll') || query.includes('列表')) {
      tools.push('analyze_scrolling');
    }

    if (query.includes('vsync') || query.includes('fence') || query.includes('延迟')) {
      tools.push('analyze_present_fence');
    }

    if (needsConsumerPerspective) {
      tools.push('detect_consumer_jank');
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
