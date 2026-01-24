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

/**
 * Format a finding with its evidence data for LLM consumption.
 * Includes title, description, and key data entries from details.
 */
function formatFindingWithEvidence(f: Finding): string {
  let result = `- [${f.severity}] ${f.title}`;
  if (f.description) {
    result += `\n  描述: ${f.description}`;
  }
  if (f.details && typeof f.details === 'object' && Object.keys(f.details).length > 0) {
    const entries = Object.entries(f.details).slice(0, 8);
    const formatted = entries.map(([k, v]) => {
      const val = typeof v === 'object' ? JSON.stringify(v).slice(0, 100) : String(v);
      return `${k}: ${val}`;
    }).join(', ');
    result += `\n  数据: { ${formatted} }`;
  }
  if (f.evidence && Array.isArray(f.evidence) && f.evidence.length > 0) {
    const evidenceStr = f.evidence.slice(0, 5).map(e =>
      typeof e === 'object' ? JSON.stringify(e).slice(0, 120) : String(e)
    ).join('; ');
    result += `\n  证据: ${evidenceStr}`;
  }
  return result;
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
  stopReason?: string
): Promise<string> {
  const confirmedHypotheses = Array.from(sharedContext.hypotheses.values())
    .filter(h => h.status === 'confirmed' || h.confidence >= 0.85);

  const prompt = `基于以下分析结果生成诊断结论：

用户目标: ${intent.primaryGoal}
${stopReason ? `提前终止原因: ${stopReason}` : ''}

已确认的假设:
${confirmedHypotheses.map(h => `- ${h.description} (confidence: ${h.confidence.toFixed(2)})`).join('\n') || '无'}

发现的问题（含数据证据）:
${allFindings.map(f => formatFindingWithEvidence(f)).join('\n\n') || '无'}

调查路径:
${sharedContext.investigationPath.map(s => `${s.stepNumber}. [${s.agentId}] ${s.summary}`).join('\n')}

请生成:
1. 根因分析（最可能的原因）
2. 证据支撑（每个结论的依据）
3. 置信度评估

重要约束：
- 只基于上述提供的数据和证据得出结论，不要推测未提供的信息
- 如果数据不足以得出某个结论，明确标注"证据不足"
- 每个结论必须引用具体的数据来源（Finding 的标题或数据值）
- 不要给出优化建议，只需要指出问题所在`;

  try {
    const response = await modelRouter.callWithFallback(prompt, 'synthesis');
    return response.response;
  } catch (error) {
    emitter.log(`Failed to generate conclusion: ${error}`);
    emitter.emitUpdate('degraded', { module: 'conclusionGenerator', fallback: 'rule-based summary' });
  }

  return generateSimpleConclusion(allFindings, stopReason);
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
