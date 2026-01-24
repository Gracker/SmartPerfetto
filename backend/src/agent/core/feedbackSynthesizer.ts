/**
 * Feedback Synthesizer
 *
 * Synthesizes findings from multiple agent responses using LLM.
 * Deduplicates findings, correlates evidence, updates hypotheses,
 * and identifies remaining information gaps.
 */

import { Finding } from '../types';
import {
  AgentResponse,
  Hypothesis,
  SharedAgentContext,
} from '../types/agentProtocol';
import { AgentMessageBus } from '../communication';
import { ModelRouter } from './modelRouter';
import { ProgressEmitter } from './orchestratorTypes';

/**
 * Format a finding briefly with key metrics for synthesis prompt.
 * Output: "title (metric1=val1, metric2=val2)"
 */
function formatFindingBrief(f: Finding): string {
  if (!f.details || typeof f.details !== 'object' || Object.keys(f.details).length === 0) {
    return f.title;
  }
  const entries = Object.entries(f.details).slice(0, 4);
  const metrics = entries.map(([k, v]) => {
    const val = typeof v === 'object' ? JSON.stringify(v).slice(0, 50) : String(v);
    return `${k}=${val}`;
  }).join(', ');
  return `${f.title} (${metrics})`;
}

export interface SynthesisResult {
  newFindings: Finding[];
  confirmedFindings: Finding[];
  updatedHypotheses: Hypothesis[];
  informationGaps: string[];
}

/**
 * Synthesize feedback from multiple agent responses.
 * Uses LLM to correlate findings and update hypothesis confidence.
 *
 * Hypothesis updates are routed through messageBus to ensure
 * broadcast events fire and other agents get notified.
 */
export async function synthesizeFeedback(
  responses: AgentResponse[],
  sharedContext: SharedAgentContext,
  modelRouter: ModelRouter,
  emitter: ProgressEmitter,
  messageBus?: AgentMessageBus
): Promise<SynthesisResult> {
  const allFindings: Finding[] = [];
  const newFindings: Finding[] = [];

  // Collect all findings from responses
  for (const response of responses) {
    allFindings.push(...response.findings);
  }

  // Deduplicate by title
  const seenTitles = new Set<string>();
  for (const finding of allFindings) {
    if (!seenTitles.has(finding.title)) {
      seenTitles.add(finding.title);
      newFindings.push(finding);
    }
  }

  // Use LLM to synthesize correlations and gaps
  const prompt = `综合以下 Agent 反馈：

${responses.map(r => `[${r.agentId}]:
- 发现: ${r.findings.map(f => formatFindingBrief(f)).join('\n  ') || '无'}
- 置信度: ${r.confidence.toFixed(2)}
- 建议: ${r.suggestions?.join('; ') || '无'}`).join('\n\n')}

当前假设:
${Array.from(sharedContext.hypotheses.values()).map(h => `- ${h.description} (${h.status})`).join('\n')}

请基于实际发现分析：
1. 哪些发现相互印证？（引用具体数据）
2. 是否存在数据矛盾？
3. 哪些假设得到数据支持或被否定？
4. 当前数据是否存在不一致或异常？

请以 JSON 返回：
{
  "correlatedFindings": ["相互印证的发现"],
  "contradictions": ["矛盾"],
  "hypothesisUpdates": [{"hypothesisId": "id", "action": "support/reject", "reason": "原因"}],
  "informationGaps": ["已有数据中的不一致或异常"]
}`;

  let informationGaps: string[] = [];

  try {
    const response = await modelRouter.callWithFallback(prompt, 'evaluation');
    const jsonMatch = response.response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      informationGaps = parsed.informationGaps || [];

      // Process hypothesis updates via messageBus (ensures broadcasts fire)
      if (parsed.hypothesisUpdates) {
        for (const update of parsed.hypothesisUpdates) {
          const hypothesis = sharedContext.hypotheses.get(update.hypothesisId);
          if (hypothesis) {
            const updated: Hypothesis = {
              ...hypothesis,
              updatedAt: Date.now(),
            };
            if (update.action === 'support') {
              updated.confidence = Math.min(1, hypothesis.confidence + 0.1);
            } else if (update.action === 'reject') {
              updated.status = 'rejected';
              updated.confidence = 0;
            }

            if (messageBus) {
              messageBus.updateHypothesis(updated);
            } else {
              // Fallback: direct mutation (legacy callers without messageBus)
              sharedContext.hypotheses.set(updated.id, updated);
            }
          }
        }
      }
    }
  } catch (error) {
    emitter.log(`Failed to synthesize feedback: ${error}`);
    emitter.emitUpdate('degraded', { module: 'feedbackSynthesizer', fallback: 'passthrough findings' });
  }

  return {
    newFindings,
    confirmedFindings: sharedContext.confirmedFindings,
    updatedHypotheses: Array.from(sharedContext.hypotheses.values()),
    informationGaps,
  };
}
