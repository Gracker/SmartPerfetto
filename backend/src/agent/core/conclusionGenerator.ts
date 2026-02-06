/**
 * Conclusion Generator
 *
 * Generates analysis conclusions from accumulated findings and hypotheses.
 * Uses LLM for intelligent root-cause synthesis, with markdown fallback.
 */

import { Intent, Finding } from '../types';
import { SharedAgentContext } from '../types/agentProtocol';
import { ModelRouter } from './modelRouter';
import { ProgressEmitter } from './orchestratorTypes';
import { formatJankSummaryForPrompt } from './jankCauseSummarizer';

export interface ConclusionGenerationOptions {
  /**
   * Number of previous turns in this session (0-based).
   * Example: 0 means this is the first user query of the session.
   */
  turnCount?: number;
  /**
   * Optional multi-turn context summary (compact, prompt-friendly).
   */
  historyContext?: string;
}

type ConclusionOutputMode = 'initial_report' | 'focused_answer' | 'need_input';

function isInsightConclusionEnabled(options: ConclusionGenerationOptions): boolean {
  // Default ON (per user request). Allow disabling for rollback.
  const override =
    process.env.SMARTPERFETTO_CONCLUSION_V2 ??
    process.env.SMARTPERFETTO_INSIGHT_CONCLUSION;

  if (override === undefined || override === null || String(override).trim() === '') {
    return true;
  }

  const v = String(override).trim().toLowerCase();
  if (['0', 'false', 'off', 'no'].includes(v)) return false;
  if (['1', 'true', 'on', 'yes'].includes(v)) return true;
  return true;
}

function selectConclusionOutputMode(params: {
  turnCount: number;
  intent: Intent;
  findingsCount: number;
  confirmedHypothesesCount: number;
  hasJankSummary: boolean;
}): ConclusionOutputMode {
  const isFollowUp = params.turnCount >= 1 || (params.intent.followUpType && params.intent.followUpType !== 'initial');
  const hasAnyEvidence = params.findingsCount > 0 || params.confirmedHypothesesCount > 0 || params.hasJankSummary;

  if (!hasAnyEvidence) {
    return 'need_input';
  }

  if (!isFollowUp) {
    return 'initial_report';
  }

  return 'focused_answer';
}

/**
 * Format a finding with its evidence data for LLM consumption.
 * Includes title, description, and key data entries from details.
 *
 * Key design decisions:
 * - Priority fields (root_cause, primary_cause, cause_type) are preserved fully
 * - Other details are truncated to manage token usage
 * - Evidence is preserved with reasonable limits
 */
function formatFindingWithEvidence(f: Finding): string {
  let result = `- [${f.severity}] ${f.title}`;
  if (f.description) {
    result += `\n  描述: ${f.description}`;
  }

  if (f.details && typeof f.details === 'object' && Object.keys(f.details).length > 0) {
    // Priority fields that should be preserved in full
    const priorityFields = ['root_cause', 'primary_cause', 'cause_type', 'confidence', 'jank_type'];
    const details = f.details as Record<string, any>;

    // First, output priority fields without truncation
    const priorityEntries: string[] = [];
    for (const field of priorityFields) {
      if (details[field] !== undefined) {
        const val = typeof details[field] === 'object'
          ? JSON.stringify(details[field]).slice(0, 200) // Allow more for structured data
          : String(details[field]);
        priorityEntries.push(`${field}: ${val}`);
      }
    }

    // Then, output other fields with truncation (up to 12 fields, 150 chars each)
    const otherEntries = Object.entries(details)
      .filter(([k]) => !priorityFields.includes(k))
      .slice(0, 12)
      .map(([k, v]) => {
        const val = typeof v === 'object' ? JSON.stringify(v).slice(0, 150) : String(v);
        return `${k}: ${val}`;
      });

    const allEntries = [...priorityEntries, ...otherEntries];
    if (allEntries.length > 0) {
      result += `\n  数据: { ${allEntries.join(', ')} }`;
    }
  }

  // Preserve evidence with reasonable limits (8 items, 200 chars each)
  if (f.evidence && Array.isArray(f.evidence) && f.evidence.length > 0) {
    const evidenceStr = f.evidence.slice(0, 8).map(e =>
      typeof e === 'object' ? JSON.stringify(e).slice(0, 200) : String(e)
    ).join('; ');
    result += `\n  证据: ${evidenceStr}`;
  }

  return result;
}

function deriveAttributionSignals(findings: Finding[]): {
  sfDominant: boolean;
  appJankZero: boolean;
} {
  let sfDominant = false;
  let appJankZero = false;

  for (const f of findings) {
    const title = String(f.title || '');
    const description = String(f.description || '');
    const text = `${title}\n${description}`;

    if (/责任归属分布:\s*SF\s+\d+\s*\(100%\)/i.test(text)) {
      sfDominant = true;
    }

    const d = (f.details && typeof f.details === 'object') ? f.details as Record<string, any> : {};
    const appCount = Number(
      d.app_janky_count ??
      d.appJankyCount ??
      d.summary?.app_janky_count ??
      d.summary?.appJankyCount
    );
    const appRate = Number(
      d.app_jank_rate ??
      d.appJankRate ??
      d.summary?.app_jank_rate ??
      d.summary?.appJankRate
    );

    if ((Number.isFinite(appCount) && appCount === 0) ||
        (Number.isFinite(appRate) && appRate === 0)) {
      appJankZero = true;
    }
  }

  return { sfDominant, appJankZero };
}

/**
 * Generate an AI-powered conclusion from analysis results.
 * Falls back to a simple markdown summary if LLM fails.
 */
export async function generateConclusion(
  sharedContext: SharedAgentContext,
  allFindings: Finding[],
  intent: Intent,
  modelRouter: ModelRouter,
  emitter: ProgressEmitter,
  stopReason?: string,
  options: ConclusionGenerationOptions = {}
): Promise<string> {
  const confirmedHypotheses = Array.from(sharedContext.hypotheses.values())
    .filter(h => h.status === 'confirmed' || h.confidence >= 0.85);

  const turnCount = Number.isFinite(options.turnCount) ? Number(options.turnCount) : 0;
  const historyContext = options.historyContext || '';

  // Collect contradicted findings for explicit mention in prompt
  // Instead of filtering them out, we let LLM resolve contradictions with guidance
  const contradictedFindings = allFindings.filter(f => f.details?._contradicted);
  const contradictionReasons = contradictedFindings
    .map(f => f.details?._contradictionReason)
    .filter((r): r is string => typeof r === 'string');

  // Sort findings by confidence (highest first) for better LLM processing
  const sortedFindings = [...allFindings].sort((a, b) => (b.confidence || 0.5) - (a.confidence || 0.5));

  // Filter out contradicted findings to prevent LLM from generating conflicting conclusions
  const findingsForPrompt = sortedFindings.filter(f => !f.details?._contradicted);
  // If all findings were filtered, keep top 5 by confidence as fallback
  const finalFindings = findingsForPrompt.length > 0
    ? findingsForPrompt
    : sortedFindings.slice(0, 5);

  const insightEnabled = isInsightConclusionEnabled(options);
  const outputMode: ConclusionOutputMode = insightEnabled
    ? selectConclusionOutputMode({
        turnCount,
        intent,
        findingsCount: sortedFindings.length,
        confirmedHypothesesCount: confirmedHypotheses.length,
        hasJankSummary: !!(sharedContext.jankCauseSummary && sharedContext.jankCauseSummary.totalJankFrames > 0),
      })
    : (turnCount >= 1 ? 'focused_answer' : 'initial_report');

  // Build contradiction section for prompt if any exist
  const contradictionSection = contradictionReasons.length > 0
    ? `\n⚠️ 数据矛盾提示:\n${contradictionReasons.map(r => `- ${r}`).join('\n')}\n`
    : '';

  // Build structured jank summary section (from per-frame analysis)
  const jankSummarySection = formatJankSummaryForPrompt(sharedContext.jankCauseSummary);

  // Debug: Log whether jank summary is being included
  if (sharedContext.jankCauseSummary) {
    console.log(`[ConclusionGenerator] Using jankCauseSummary: ${sharedContext.jankCauseSummary.totalJankFrames} frames, primary=${sharedContext.jankCauseSummary.primaryCause?.label}`);
  } else {
    console.log(`[ConclusionGenerator] No jankCauseSummary available in sharedContext`);
  }

  const prompt = insightEnabled
    ? buildInsightFirstPrompt({
        mode: outputMode,
        turnCount,
        historyContext,
        intent,
        stopReason,
        confirmedHypotheses: confirmedHypotheses.map(h => ({
          description: h.description,
          confidence: h.confidence,
          status: h.status,
        })),
        findings: finalFindings,
        allFindingsSorted: sortedFindings,
        contradictionSection,
        jankSummary: sharedContext.jankCauseSummary,
        traceConfig: sharedContext.traceConfig,
        investigationPath: sharedContext.investigationPath,
      })
    : `基于以下分析结果生成诊断结论：

用户目标: ${intent.primaryGoal}
${stopReason ? `提前终止原因: ${stopReason}` : ''}
${jankSummarySection}
已确认的假设:
${confirmedHypotheses.map(h => `- ${h.description} (confidence: ${h.confidence.toFixed(2)})`).join('\n') || '无'}

发现的问题（含数据证据）:
${finalFindings.map(f => formatFindingWithEvidence(f)).join('\n\n') || '无'}
${contradictionSection}
调查路径:
${sharedContext.investigationPath.map(s => `${s.stepNumber}. [${s.agentId}] ${s.summary}`).join('\n')}

请生成:
1. 根因分析（最可能的原因）
2. 证据支撑（每个结论的依据）
3. 置信度评估
4. 下一步最有信息增益的分析动作（不是优化建议）

重要约束：
- 只基于上述提供的数据和证据得出结论，不要推测未提供的信息
- 如果数据不足以得出某个结论，明确标注"证据不足"
- 每个结论必须引用具体的数据来源（Finding 的标题或数据值）
- 不要给出优化建议，只需要指出问题所在

## 刷新率与帧预算
${sharedContext.traceConfig ? (sharedContext.traceConfig.isVRR
  ? `- **VRR/LTPO 模式: ${sharedContext.traceConfig.vrrMode}**
- **主导刷新率: ${sharedContext.traceConfig.refreshRateHz}Hz**（用于大部分帧的判断）
- **帧预算范围: ${sharedContext.traceConfig.minFrameBudgetMs || sharedContext.traceConfig.vsyncPeriodMs}ms - ${sharedContext.traceConfig.maxFrameBudgetMs || sharedContext.traceConfig.vsyncPeriodMs}ms**
- ⚠️ VRR 设备帧预算动态变化，使用最严格标准（${sharedContext.traceConfig.minFrameBudgetMs || sharedContext.traceConfig.vsyncPeriodMs}ms）判断 jank`
  : `- **检测到的刷新率: ${sharedContext.traceConfig.refreshRateHz}Hz**
- **帧预算: ${sharedContext.traceConfig.vsyncPeriodMs}ms**
- 数据来源: ${sharedContext.traceConfig.vsyncSource}`)
: `- 刷新率未检测到，默认使用 120Hz（8.33ms）作为帧预算`}

## 矛盾数据处理规则
如果发现多个 findings 之间存在矛盾，请按以下规则处理：

1. **Q4（休眠/阻塞）占比高** vs **主线程耗时操作**：
   - 需要同时满足两个条件才判定为"阻塞/等待"问题：
     a) Q4 占比 > 30%
     b) Q4 绝对耗时 > 帧预算的 50%（如 120Hz 下 > 4ms）
   - 如果 Q4 占比高但绝对耗时很短（如 2ms），可能只是正常的 Binder/IPC 开销
   - 只有当 Q1+Q2（Running 状态）耗时超过帧预算时，才判定为"主线程耗时操作"

2. **RenderThread 阻塞** vs **GPU 瓶颈**：
   - RenderThread 的 Q4 高可能是等待 GPU Fence 信号，而非 CPU 阻塞
   - 如果同时存在 GPU 频率/负载数据，应综合判断是 GPU 能力不足还是 CPU 等待
   - GPU Fence > 3ms 通常表示 GPU 瓶颈

3. **App 侧正常** vs **消费端掉帧**：
   - App 帧生产正常但消费端掉帧，说明问题在 SurfaceFlinger/HWC 层
   - 此时不应归因于 App，而应指出系统合成层的瓶颈
   - 常见原因：SF 合成延迟、HWC 提交延迟、GPU 合成耗时

4. **掉帧数量不一致**（如 "25 个卡顿帧" vs "38 个卡顿帧"）：
   - 不同统计口径可能导致数量差异：
     - App 报告：App 自己统计的掉帧（可能漏报消费端问题）
     - 消费端检测：用户实际感知的掉帧（包含系统层问题）
     - 帧列表：逐帧分析的结果
   - 如果来自不同 session_id 或不同时间窗（例如区间1 vs 区间2），属于区间差异，不应判定为矛盾
   - 仅当“同口径 + 同时间窗 + 同进程”下出现冲突，才标记为矛盾
   - 应说明使用的是哪个口径，并引用具体 Finding 来源

5. **CPU 频率低** vs **主线程耗时**：
   - 大核频率 < 1.2GHz 时，耗时问题可能是功耗策略导致
   - 此时应指出"CPU 调度/频率不足"而非"代码耗时"

6. **优先采信置信度更高的 Finding**，但必须说明理由

## 输出格式要求（必须严格遵守）
- **只输出 Markdown 格式的纯文本**，方便人类阅读
- **禁止输出 JSON**，不要用 {} 或 [] 包装内容
- **禁止输出代码块**，不要用 \`\`\` 包装
- 使用 ## 作为标题，使用 - 作为列表项
- 示例格式：
  ## 根因分析
  主要问题是 XXX，置信度 85%。

	  ## 证据支撑
	  - 发现1：XXX
	  - 发现2：XXX`;

  try {
    const response = await modelRouter.callWithFallback(prompt, 'synthesis', {
      sessionId: sharedContext.sessionId,
      traceId: sharedContext.traceId,
      promptId: insightEnabled
        ? `agent.conclusionGenerator.insight.${outputMode}`
        : (turnCount >= 1 ? 'agent.conclusionGenerator.dialogue' : 'agent.conclusionGenerator'),
      promptVersion: '2.0.0',
      contractVersion: insightEnabled
        ? 'conclusion_insight_text@2.0.0'
        : (turnCount >= 1 ? 'conclusion_dialogue_text@1.0.0' : 'conclusion_text@1.0.0'),
    });

    let conclusion = response.response;

    // Detect if LLM returned JSON/code-block despite format instructions
    const trimmed = conclusion.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed.startsWith('```')) {
      emitter.log('[conclusionGenerator] LLM returned JSON/code-block, converting to Markdown');
      conclusion = convertJsonToMarkdown(conclusion);
    }

    // Ensure evidence IDs appear in the evidence-chain section when available.
    // This makes the output auditable even if the LLM forgets to cite.
    conclusion = injectPerConclusionEvidenceMapping(conclusion, finalFindings);
    conclusion = injectEvidenceIndexIntoEvidenceChain(conclusion, finalFindings);

    return conclusion;
  } catch (error) {
    emitter.log(`Failed to generate conclusion: ${error}`);
    emitter.emitUpdate('degraded', {
      module: 'conclusionGenerator',
      fallback: insightEnabled ? `rule-based insight (${outputMode})` : (turnCount >= 1 ? 'rule-based dialogue' : 'rule-based summary'),
    });
  }

  if (insightEnabled) {
    const fallback = generateInsightFallback(
      outputMode,
      sortedFindings,
      confirmedHypotheses.map(h => h.description),
      intent,
      stopReason,
      historyContext,
      contradictionReasons
    );
    const withPerConclusion = injectPerConclusionEvidenceMapping(fallback, sortedFindings);
    return injectEvidenceIndexIntoEvidenceChain(withPerConclusion, sortedFindings);
  }

  return turnCount >= 1
    ? generateDialogueFallback(sortedFindings, intent, stopReason, historyContext)
    : generateSimpleConclusion(sortedFindings, stopReason);
}

/**
 * Generate a simple markdown-formatted conclusion without LLM.
 */
export function generateSimpleConclusion(findings: Finding[], stopReason?: string): string {
  const critical = findings.filter(f => f.severity === 'critical');
  const warnings = findings.filter(f => f.severity === 'warning');

  let conclusion = '## 分析结论\n\n';

  if (critical.length > 0) {
    conclusion += `### 严重问题 (${critical.length})\n`;
    for (const f of critical) {
      conclusion += `- **${f.title}**\n`;
    }
    conclusion += '\n';
  }

  if (warnings.length > 0) {
    conclusion += `### 需要关注 (${warnings.length})\n`;
    for (const f of warnings) {
      conclusion += `- ${f.title}\n`;
    }
    conclusion += '\n';
  }

  if (findings.length === 0) {
    conclusion += '未发现明显的性能问题。\n';
  }

  if (stopReason) {
    conclusion += `\n> 备注：分析提前结束（${stopReason}）。\n`;
  }

  return conclusion;
}

function buildInsightFirstPrompt(params: {
  mode: ConclusionOutputMode;
  turnCount: number;
  historyContext: string;
  intent: Intent;
  stopReason?: string;
  confirmedHypotheses: Array<{ description: string; confidence: number; status: string }>;
  findings: Finding[];
  allFindingsSorted: Finding[];
  contradictionSection: string;
  jankSummary?: import('./jankCauseSummarizer').JankCauseSummary;
  traceConfig?: any;
  investigationPath: Array<{ stepNumber: number; agentId: string; summary: string }>;
}): string {
  const parts: string[] = [];

  parts.push(`你是 SmartPerfetto 的 AI 性能分析助手，正在进行多轮对话（当前第 ${params.turnCount + 1} 轮）。`);
  parts.push('你的目标：给出“洞见优先”的结论，而不是套模板。');
  parts.push('');

  parts.push('## 用户本轮输入');
  parts.push(params.intent.primaryGoal);
  parts.push('');

  if (params.intent.followUpType && params.intent.followUpType !== 'initial') {
    parts.push(`Follow-up 类型: ${params.intent.followUpType}`);
    if (params.intent.referencedEntities && params.intent.referencedEntities.length > 0) {
      parts.push(`引用实体: ${params.intent.referencedEntities.map(e => `${e.type}:${String(e.value ?? e.id)}`).join(', ')}`);
    }
    parts.push('');
  }

  if (params.stopReason) {
    parts.push('## 本轮停止原因');
    parts.push(params.stopReason);
    parts.push('');
  }

  if (params.historyContext) {
    parts.push('## 对话历史摘要（用于承接上下文）');
    parts.push(params.historyContext);
    parts.push('');
  }

  // Trace config summary (keep short)
  if (params.traceConfig) {
    try {
      const hz = params.traceConfig.refreshRateHz;
      const vsync = params.traceConfig.vsyncPeriodMs;
      const isVRR = params.traceConfig.isVRR;
      parts.push('## Trace 配置摘要');
      if (hz) parts.push(`- 刷新率: ${hz}Hz`);
      if (vsync) parts.push(`- 帧预算: ${vsync}ms`);
      if (typeof isVRR === 'boolean') parts.push(`- VRR: ${isVRR ? '是' : '否'}`);
      parts.push('');
    } catch {
      // best-effort only
    }
  }

  // Include jank cause summary if available
  if (params.jankSummary && params.jankSummary.totalJankFrames > 0) {
    parts.push(formatJankSummaryForPrompt(params.jankSummary));
    parts.push('');
  }

  if (params.confirmedHypotheses.length > 0) {
    parts.push('## 已确认假设（摘要）');
    for (const h of params.confirmedHypotheses.slice(0, 5)) {
      parts.push(`- ${h.description} (confidence: ${Number(h.confidence).toFixed(2)}, status: ${h.status})`);
    }
    parts.push('');
  }

  parts.push('## 关键发现（含数据证据）');
  if (params.findings.length === 0) {
    parts.push('无可用 findings。');
  } else {
    parts.push(params.findings.slice(0, 12).map(f => formatFindingWithEvidence(f)).join('\n\n'));
  }
  parts.push('');

  // Keep investigation path short for token efficiency
  if (Array.isArray(params.investigationPath) && params.investigationPath.length > 0) {
    parts.push('## 调查路径（摘要）');
    const tail = params.investigationPath.slice(-8);
    parts.push(tail.map(s => `${s.stepNumber}. [${s.agentId}] ${s.summary}`).join('\n'));
    parts.push('');
  }

  if (params.contradictionSection) {
    parts.push(params.contradictionSection.trim());
    parts.push('');
  }

  const attributionSignals = deriveAttributionSignals(
    params.allFindingsSorted.length > 0 ? params.allFindingsSorted : params.findings
  );
  if (attributionSignals.sfDominant || attributionSignals.appJankZero) {
    parts.push('## 归因护栏');
    if (attributionSignals.sfDominant) {
      parts.push('- 当前证据显示 SF/消费端责任占主导（含 SF 100% 责任分布信号）。');
    }
    if (attributionSignals.appJankZero) {
      parts.push('- 当前口径存在 app_janky_count 或 app_jank_rate 为 0 的信号。');
    }
    parts.push('- 在该前提下，不要直接给出“主线程/Choreographer 是主要根因”的高置信度结论。');
    parts.push('- 若判定 App 主因，必须引用同一时间窗/同一帧的直接证据链（App Deadline Missed + 主线程耗时切片）。');
    parts.push('');
  }

  parts.push('## 输出要求（必须严格遵守）');
  parts.push('- 只输出 Markdown 纯文本；禁止输出 JSON；禁止代码块；不要输出 SQL。');
  parts.push('- 只基于已提供的数据与证据；不允许编造未提供的数据。');
  parts.push('- 允许给出“下一步分析动作/要补充的数据”，但不要给出“优化代码/改架构”的建议。');
  parts.push('- 必须包含以下 4 个模块（标题必须一致）：');
  parts.push('  1) ## 结论（按可能性排序）');
  parts.push('  2) ## 证据链（对应上述结论）');
  parts.push('  3) ## 不确定性与反例');
  parts.push('  4) ## 下一步（最高信息增益）');
  parts.push('- 结论最多列 3 条，每条给出置信度百分比（例如：85%）。');
  parts.push('- “证据链”必须按 C1/C2/C3 对齐（C1=结论1）：每行以 "- C1:"/"- C2:"/"- C3:" 开头，并包含至少 1 个 evidence id（ev_xxxxxxxxxxxx）；同一行补充对应 Finding 标题/关键数据。');

  if (params.mode === 'focused_answer') {
    parts.push('- 本轮是 follow-up：优先直接回答用户本轮焦点，不要复述历史长文；总长度尽量控制在 25 行以内。');
    parts.push('- 如果证据不足以回答本轮问题：在“不确定性与反例”里说明缺口，并在“下一步”里给出 1-2 个最关键的问题或动作。');
  } else if (params.mode === 'need_input') {
    parts.push('- 当前证据不足：可以给出低置信度的方向，但必须明确“证据不足”。');
    parts.push('- 在“下一步”里给出最多 2 个必须回答的问题（每行以 "Q:" 开头），并给出 2-3 个可选动作（以 "A."/"B."/"C." 开头）。');
  } else {
    parts.push('- 首轮报告：允许更完整，但避免无关的长篇背景科普；引用具体 findings 数据。');
  }

  parts.push('- 全部中文。');

  return parts.join('\n');
}

function generateInsightFallback(
  mode: ConclusionOutputMode,
  findings: Finding[],
  hypothesisDescriptions: string[],
  intent: Intent,
  stopReason?: string,
  historyContext?: string,
  contradictionReasons?: string[]
): string {
  const lines: string[] = [];

  const topFindings = findings.slice(0, 5);
  const topFindingTitles = topFindings
    .filter(f => typeof f.title === 'string' && f.title.trim().length > 0)
    .map(f => `[${f.severity}] ${f.title}`);

  lines.push('## 结论（按可能性排序）');
  if (topFindingTitles.length > 0) {
    lines.push(`1. 最可能的问题与本轮证据一致（置信度: 60%）。`);
    lines.push(`2. 仍存在其他可能方向需要排除（置信度: 40%）。`);
  } else if (hypothesisDescriptions.length > 0) {
    lines.push(`1. 当前仅有假设线索，尚缺少直接证据（置信度: 40%）。`);
  } else {
    lines.push('1. 当前证据不足，无法给出可靠诊断结论（置信度: 20%）。');
  }
  lines.push('');

  lines.push('## 证据链（对应上述结论）');
  if (topFindingTitles.length > 0) {
    const conclusionCount = 2;
    for (let i = 0; i < Math.min(conclusionCount, 3); i += 1) {
      const f = topFindings[i] || topFindings[0];
      const evIds = extractEvidenceIdsFromFinding(f).slice(0, 2);
      const evStr = evIds.length > 0 ? ` (${evIds.join('|')})` : '';
      lines.push(`- C${i + 1}: [${f.severity}] ${f.title}${evStr}`.trim());
    }
  } else if (hypothesisDescriptions.length > 0) {
    const combined = hypothesisDescriptions.slice(0, 2).join('；');
    lines.push(`- C1: 假设线索（证据不足，无 ev_ id）：${combined}`);
  } else if (historyContext) {
    lines.push('- C1: 可用上下文来自对话历史摘要，但缺少结构化证据（findings/ev_）。');
  } else {
    lines.push('- C1: 暂无可引用的 findings/hypotheses。');
  }
  lines.push('');

  lines.push('## 不确定性与反例');
  if (Array.isArray(contradictionReasons) && contradictionReasons.length > 0) {
    lines.push(`- 当前存在数据矛盾：${contradictionReasons.slice(0, 2).join('；')}`);
  } else {
    lines.push('- 缺少关键证据或时间范围/实体引用，结论可能被后续数据推翻。');
  }
  if (stopReason) {
    lines.push(`- 备注：本轮提前结束（${stopReason}）。`);
  }
  lines.push('');

  lines.push('## 下一步（最高信息增益）');
  if (mode === 'need_input') {
    lines.push('Q: 你希望我聚焦在哪个对象？（frame_id / session_id / 时间范围 / 进程名 任选其一即可）');
    lines.push('A. 指定一个卡顿帧（例如：frame_id=123）');
    lines.push('B. 指定一个滑动会话（例如：session_id=2）');
    lines.push('C. 指定一个时间范围（例如：1.2s~1.5s）');
  } else {
    lines.push('- 指定一个可 drill-down 的实体或时间范围（frame_id / session_id / 时间范围），我将只对该范围补证据并更新结论。');
    lines.push('- 如果你想“比较”，请同时给出两个实体（例如：frame_id=123 vs frame_id=456）。');
  }

  return lines.join('\n');
}

function extractEvidenceIdsFromFinding(f: Finding): string[] {
  const ids: string[] = [];
  const ev = (f as any)?.evidence;
  const arr = Array.isArray(ev) ? ev : (ev ? [ev] : []);
  for (const e of arr) {
    if (!e) continue;
    if (typeof e === 'string') {
      const s = e.trim();
      if (/^ev_[0-9a-f]{12}$/.test(s)) ids.push(s);
      continue;
    }
    if (typeof e === 'object') {
      const id = (e as any).evidenceId || (e as any).evidence_id;
      if (typeof id === 'string' && /^ev_[0-9a-f]{12}$/.test(id.trim())) {
        ids.push(id.trim());
      }
    }
  }
  const seen = new Set<string>();
  return ids.filter(id => {
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function extractEvidenceRefsFromFindings(findings: Finding[]): Array<{ evidenceId: string; title?: string; kind?: string }> {
  const out: Array<{ evidenceId: string; title?: string; kind?: string }> = [];
  const seen = new Set<string>();

  for (const f of findings) {
    const ev = (f as any)?.evidence;
    const arr = Array.isArray(ev) ? ev : (ev ? [ev] : []);
    for (const e of arr) {
      if (!e) continue;
      if (typeof e === 'object') {
        const id = (e as any).evidenceId || (e as any).evidence_id;
        if (typeof id === 'string' && /^ev_[0-9a-f]{12}$/.test(id.trim())) {
          const evidenceId = id.trim();
          if (seen.has(evidenceId)) continue;
          seen.add(evidenceId);
          out.push({
            evidenceId,
            title: typeof (e as any).title === 'string' ? String((e as any).title) : undefined,
            kind: typeof (e as any).kind === 'string' ? String((e as any).kind) : undefined,
          });
        }
      } else if (typeof e === 'string') {
        const s = e.trim();
        if (/^ev_[0-9a-f]{12}$/.test(s) && !seen.has(s)) {
          seen.add(s);
          out.push({ evidenceId: s });
        }
      }
    }
  }

  return out;
}

function findMarkdownSection(
  text: string,
  headerRe: RegExp
): null | { headerStart: number; headerEnd: number; bodyStart: number; bodyEnd: number; body: string } {
  const m = headerRe.exec(text);
  if (!m) return null;

  const headerStart = m.index;
  const headerEnd = headerStart + m[0].length;

  let bodyStart = headerEnd;
  if (text[bodyStart] === '\r' && text[bodyStart + 1] === '\n') bodyStart += 2;
  else if (text[bodyStart] === '\n') bodyStart += 1;

  const nextHeaderRe = /^##\s+/gm;
  nextHeaderRe.lastIndex = bodyStart;
  const next = nextHeaderRe.exec(text);
  const bodyEnd = next ? next.index : text.length;
  const body = text.slice(bodyStart, bodyEnd);

  return { headerStart, headerEnd, bodyStart, bodyEnd, body };
}

function extractConclusionItemsFromSection(sectionBody: string): Array<{ index: number; text: string }> {
  const lines = String(sectionBody || '').split(/\r?\n/);
  const items: Array<{ index: number; text: string }> = [];

  let autoIndex = 1;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const mNum = /^([1-3])\s*[.)、]\s*(.+)$/.exec(line);
    if (mNum) {
      const idx = Number(mNum[1]);
      const text = mNum[2].trim();
      if (text) items.push({ index: idx, text });
      continue;
    }

    const mC = /^C([1-3])\s*[:：]\s*(.+)$/.exec(line);
    if (mC) {
      const idx = Number(mC[1]);
      const text = mC[2].trim();
      if (text) items.push({ index: idx, text });
      continue;
    }

    const mBullet = /^-\s+(.+)$/.exec(line);
    if (mBullet && autoIndex <= 3) {
      const text = mBullet[1].trim();
      if (text) items.push({ index: autoIndex, text });
      autoIndex += 1;
    }
  }

  // Ensure order by index and keep at most 3.
  const byIndex = new Map<number, string>();
  for (const it of items) {
    if (it.index < 1 || it.index > 3) continue;
    if (!byIndex.has(it.index)) byIndex.set(it.index, it.text);
  }

  const out: Array<{ index: number; text: string }> = [];
  for (const i of [1, 2, 3]) {
    const t = byIndex.get(i);
    if (t) out.push({ index: i, text: t });
  }
  return out;
}

function scoreConclusionToFinding(conclusionText: string, f: Finding): number {
  const c = String(conclusionText || '').toLowerCase();
  const t = String(f.title || '').toLowerCase();
  const d = String(f.description || '').toLowerCase();
  const hay = `${t}\n${d}`;

  if (!c.trim() || !hay.trim()) return 0;

  // Lightweight keyword overlap for CN/EN mixed strings (no tokenization needed).
  const keywords = [
    'jank', 'fps', 'frame', 'vsync', 'budget', 'refresh',
    'gpu', 'renderthread', 'surfaceflinger', 'sf', 'hwc',
    'cpu', 'sched', 'freq', 'cluster',
    'binder', 'ipc',
    'io', 'block', 'irq',
    'lmk', 'oom',
    'gc', 'thermal', 'throttle', 'vrr', 'ltpo',
    '主线程', 'ui', '渲染', '合成', '掉帧', '卡顿', '滑动', '启动', '交互', 'anr',
  ];

  let score = 0;
  for (const k of keywords) {
    const kk = k.toLowerCase();
    if (c.includes(kk) && hay.includes(kk)) score += 3;
  }

  // Bonus for direct substring hints.
  if (t && c.includes(t)) score += 6;
  if (t && t.includes(c)) score += 4;

  // Severity / confidence as a soft prior.
  const sevBoost = f.severity === 'critical' ? 3 : (f.severity === 'warning' ? 2 : 1);
  score += sevBoost;
  score += Math.round(((f.confidence ?? 0.5) * 10));

  return score;
}

function injectPerConclusionEvidenceMapping(markdown: string, findings: Finding[]): string {
  const text = String(markdown || '');
  if (!text.trim()) return text;

  const conclusionSection = findMarkdownSection(text, /^##\s*结论[（(]按可能性排序[）)]\s*$/m);
  const evidenceSection = findMarkdownSection(text, /^##\s*证据链[（(]对应上述结论[）)]\s*$/m);
  if (!evidenceSection) return text;

  const conclusions = conclusionSection
    ? extractConclusionItemsFromSection(conclusionSection.body).slice(0, 3)
    : [];
  const conclusionCount = conclusions.length > 0 ? conclusions.length : 1;

  const body = evidenceSection.body;
  const missing: number[] = [];
  for (let i = 1; i <= conclusionCount; i += 1) {
    const hasLineWithEv = new RegExp(`^\\s*-?\\s*C${i}\\b.*\\bev_[0-9a-f]{12}\\b`, 'm').test(body);
    if (!hasLineWithEv) missing.push(i);
  }
  if (missing.length === 0) return text;

  const usableFindings = findings.filter(f => !f.details?._contradicted);
  const candidates = usableFindings
    .map(f => ({ finding: f, evIds: extractEvidenceIdsFromFinding(f) }))
    .filter(c => c.evIds.length > 0);
  if (candidates.length === 0) return text;

  const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
  const usedEv = new Set<string>();
  const usedFindingIds = new Set<string>();

  const injectedLines: string[] = [];
  for (const idx of missing.slice(0, 3)) {
    const conclusionText = conclusions.find(c => c.index === idx)?.text || '';

    // Pick best matching finding; fall back to highest confidence.
    const scored = candidates
      .filter(c => !usedFindingIds.has(String(c.finding.id || '')))
      .map(c => ({ ...c, score: scoreConclusionToFinding(conclusionText, c.finding) }))
      .sort((a, b) => b.score - a.score);

    const picked = scored[0] || candidates[0];
    if (!picked) continue;

    const evIds = picked.evIds.filter(id => !usedEv.has(id)).slice(0, 2);
    const finalEvIds = evIds.length > 0 ? evIds : picked.evIds.slice(0, 1);
    for (const id of finalEvIds) usedEv.add(id);
    if (picked.finding.id) usedFindingIds.add(String(picked.finding.id));

    const evStr = finalEvIds.length > 0 ? `(${finalEvIds.join('|')})` : '';
    const cStr = conclusionText ? truncate(conclusionText, 56) : `对应结论 ${idx}`;
    const fStr = truncate(String(picked.finding.title || picked.finding.description || ''), 56);
    injectedLines.push(`- C${idx}（自动补全）: ${cStr} ← ${evStr} ${fStr}`.trim());
  }

  if (injectedLines.length === 0) return text;

  return `${text.slice(0, evidenceSection.bodyStart)}${injectedLines.join('\n')}\n${text.slice(evidenceSection.bodyStart)}`;
}

function injectEvidenceIndexIntoEvidenceChain(markdown: string, findings: Finding[]): string {
  const text = String(markdown || '');
  if (!text.trim()) return text;

  const refs = extractEvidenceRefsFromFindings(findings).slice(0, 4);
  if (refs.length === 0) return text;

  const headerRe = /^##\s*证据链（对应上述结论）\s*$/m;
  const headerMatch = headerRe.exec(text);
  if (!headerMatch) return text;

  const headerIdx = headerMatch.index;
  const afterHeaderIdx = headerIdx + headerMatch[0].length;

  // Find next "##" heading after evidence section header.
  const nextHeaderRe = /^##\s+/gm;
  nextHeaderRe.lastIndex = afterHeaderIdx;
  const next = nextHeaderRe.exec(text);
  const sectionEnd = next ? next.index : text.length;

  const sectionBody = text.slice(afterHeaderIdx, sectionEnd);
  if (/\bev_[0-9a-f]{12}\b/.test(sectionBody)) return text;

  const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
  const items = refs
    .map(r => `(${r.evidenceId}) ${truncate(String(r.title || r.kind || ''), 48)}`.trim())
    .join('；');
  const line = `- 证据索引（自动补全）: ${items}`;

  return `${text.slice(0, sectionEnd).trimEnd()}\n${line}\n${text.slice(sectionEnd).trimStart()}`;
}

function buildDialogueModePrompt(params: {
  turnCount: number;
  historyContext: string;
  intent: Intent;
  stopReason?: string;
  confirmedHypotheses: Array<{ description: string; confidence: number; status: string }>;
  findings: Finding[];
  jankSummary?: import('./jankCauseSummarizer').JankCauseSummary;
}): string {
  const parts: string[] = [];

  parts.push(`你是 SmartPerfetto 的 AI 性能分析助手，正在进行多轮对话（当前第 ${params.turnCount + 1} 轮）。`);
  parts.push('你的目标：充分理解用户本轮输入，在不重复长篇报告的前提下，用最小输出推进到"用户满意"。');
  parts.push('');

  parts.push('## 用户本轮输入');
  parts.push(params.intent.primaryGoal);
  parts.push('');

  if (params.stopReason) {
    parts.push('## 本轮停止原因');
    parts.push(params.stopReason);
    parts.push('');
  }

  if (params.historyContext) {
    parts.push('## 对话历史摘要（用于承接上下文）');
    parts.push(params.historyContext);
    parts.push('');
  }

  // Include jank cause summary if available (from per-frame analysis)
  if (params.jankSummary && params.jankSummary.totalJankFrames > 0) {
    parts.push(formatJankSummaryForPrompt(params.jankSummary));
    parts.push('');
  }

  if (params.confirmedHypotheses.length > 0) {
    parts.push('## 已确认假设（摘要）');
    for (const h of params.confirmedHypotheses.slice(0, 5)) {
      parts.push(`- ${h.description} (confidence: ${Number(h.confidence).toFixed(2)})`);
    }
    parts.push('');
  }

  parts.push('## 本轮新增证据（findings 摘要）');
  if (params.findings.length === 0) {
    parts.push('无新增 findings。');
  } else {
    parts.push(params.findings.slice(0, 8).map(f => formatFindingWithEvidence(f)).join('\n\n'));
  }
  parts.push('');

  parts.push('## 输出要求（必须严格遵守）');
  parts.push('- 输出尽量短：总长度不超过 12 行（含空行）');
  parts.push('- 先回答用户本轮问题（如果可直接回答，用 1-3 句话；不要复述历史长文）');
  parts.push('- 然后提出最多 3 个澄清问题（每行以 "Q:" 开头），问题必须是决定下一步分析方向的关键信息');
  parts.push('- 结尾给出 2-3 个可选下一步（以 "A."/"B."/"C." 开头），让用户选择');
  parts.push('- 不要输出 SQL、不要代码块、不要编造未提供的数据');
  parts.push('- 全部中文');

  return parts.join('\n');
}

function generateDialogueFallback(
  findings: Finding[],
  intent: Intent,
  stopReason?: string,
  historyContext?: string
): string {
  const lines: string[] = [];

  // 1) Minimal acknowledgement of the user request
  lines.push(`我理解你想继续推进：${intent.primaryGoal}`);

  // 2) Keep it short: surface what we have (if any)
  const topTitles = findings
    .filter(f => typeof f.title === 'string' && f.title.trim().length > 0)
    .slice(0, 3)
    .map(f => f.title.trim());
  if (topTitles.length > 0) {
    lines.push(`目前可承接的线索：${topTitles.join('；')}`);
  } else if (historyContext) {
    lines.push('目前我会基于已有对话上下文继续推进。');
  }

  if (stopReason) {
    lines.push(`备注：本轮提前结束（${stopReason}）。`);
  }

  // 3) Ask the minimal next question(s)
  lines.push('Q: 你希望我下一步聚焦在哪里？（给出 frame_id / session_id / 时间范围 / 进程名之一即可）');
  lines.push('A. 深入某个卡顿帧（例如：frame_id=123）');
  lines.push('B. 深入某个滑动会话（例如：session_id=2）');
  lines.push('C. 重新指定一个时间范围（例如：1.2s~1.5s）');

  return lines.join('\n');
}

/**
 * Convert JSON response to Markdown when LLM ignores format instructions.
 * This is a fallback to ensure human-readable output.
 */
function convertJsonToMarkdown(jsonStr: string): string {
  // 1. Remove code block markers if present
  let cleaned = jsonStr
    .replace(/^```(?:json)?\s*\n?/, '')
    .replace(/\n?```$/, '')
    .trim();

  // 2. Try to parse as JSON
  try {
    const parsed = JSON.parse(cleaned);
    const lines: string[] = [];

    // Extract root cause analysis
    if (parsed.rootCauseAnalysis && Array.isArray(parsed.rootCauseAnalysis)) {
      lines.push('## 根因分析\n');
      for (const item of parsed.rootCauseAnalysis) {
        const conclusion = item.conclusion || item.title || '结论';
        const confidence = item.confidence ? ` (置信度: ${item.confidence})` : '';
        lines.push(`### ${conclusion}${confidence}\n`);

        if (item.evidence && Array.isArray(item.evidence)) {
          lines.push('**证据:**');
          for (const e of item.evidence) {
            lines.push(`- ${typeof e === 'object' ? JSON.stringify(e) : e}`);
          }
          lines.push('');
        }
      }
    }

    // Extract conclusion field if present
    if (parsed.conclusion && typeof parsed.conclusion === 'string') {
      if (lines.length === 0) {
        lines.push('## 分析结论\n');
      }
      lines.push(parsed.conclusion);
      lines.push('');
    }

    // Extract summary if present
    if (parsed.summary && typeof parsed.summary === 'string') {
      lines.push('## 总结\n');
      lines.push(parsed.summary);
      lines.push('');
    }

    // Extract findings array if present
    if (parsed.findings && Array.isArray(parsed.findings)) {
      lines.push('## 发现\n');
      for (const f of parsed.findings) {
        const title = f.title || f.name || '发现';
        const severity = f.severity ? `[${f.severity}] ` : '';
        lines.push(`- ${severity}${title}`);
        if (f.description) {
          lines.push(`  ${f.description}`);
        }
      }
      lines.push('');
    }

    // If we extracted anything, return it
    if (lines.length > 0) {
      return lines.join('\n');
    }

    // Otherwise, format the entire object as a simple list
    return formatObjectAsMarkdown(parsed);
  } catch {
    // JSON parse failed, return cleaned string as-is
    return cleaned;
  }
}

/**
 * Format an arbitrary object as Markdown list.
 */
function formatObjectAsMarkdown(obj: Record<string, any>, indent = ''): string {
  const lines: string[] = [];

  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) continue;

    if (Array.isArray(value)) {
      lines.push(`${indent}**${key}:**`);
      for (const item of value) {
        if (typeof item === 'object') {
          lines.push(`${indent}- ${JSON.stringify(item).slice(0, 200)}`);
        } else {
          lines.push(`${indent}- ${item}`);
        }
      }
    } else if (typeof value === 'object') {
      lines.push(`${indent}**${key}:**`);
      lines.push(formatObjectAsMarkdown(value, indent + '  '));
    } else {
      lines.push(`${indent}- **${key}:** ${value}`);
    }
  }

  return lines.join('\n');
}
