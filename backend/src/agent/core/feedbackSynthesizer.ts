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
import type { EnhancedSessionContext } from '../context/enhancedSessionContext';
import { isPlainObject, isStringArray, LlmJsonSchema, parseLlmJson } from '../../utils/llmJson';

type FeedbackSynthesisJsonPayload = {
  correlatedFindings?: string[];
  contradictions?: string[];
  hypothesisUpdates?: Array<{
    hypothesisId: string;
    action: 'support' | 'weaken' | 'reject';
    confidence_delta?: number;
    reason?: string;
  }>;
  informationGaps?: string[];
};

const FEEDBACK_SYNTHESIS_JSON_SCHEMA: LlmJsonSchema<FeedbackSynthesisJsonPayload> = {
  name: 'feedback_synthesis_json@1.0.0',
  validate: (value: unknown): value is FeedbackSynthesisJsonPayload => {
    if (!isPlainObject(value)) return false;

    const correlatedFindings = (value as any).correlatedFindings;
    if (correlatedFindings !== undefined && correlatedFindings !== null && !isStringArray(correlatedFindings)) {
      return false;
    }

    const contradictions = (value as any).contradictions;
    if (contradictions !== undefined && contradictions !== null && !isStringArray(contradictions)) {
      return false;
    }

    const informationGaps = (value as any).informationGaps;
    if (informationGaps !== undefined && informationGaps !== null && !isStringArray(informationGaps)) {
      return false;
    }

    const hypothesisUpdates = (value as any).hypothesisUpdates;
    if (hypothesisUpdates !== undefined && hypothesisUpdates !== null) {
      if (!Array.isArray(hypothesisUpdates)) return false;
      for (const item of hypothesisUpdates) {
        if (!isPlainObject(item)) return false;
        if (typeof (item as any).hypothesisId !== 'string') return false;
        if (!['support', 'weaken', 'reject'].includes(String((item as any).action))) return false;
        const delta = (item as any).confidence_delta;
        if (delta !== undefined && delta !== null && typeof delta !== 'number') return false;
        const reason = (item as any).reason;
        if (reason !== undefined && reason !== null && typeof reason !== 'string') return false;
      }
    }

    return true;
  },
};

/**
 * Format a finding briefly with key metrics for synthesis prompt.
 * Output: "title (metric1=val1, metric2=val2)"
 */
function formatFindingBrief(f: Finding): string {
  const evIds = (() => {
    if (!Array.isArray((f as any).evidence)) return [];
    const ids: string[] = [];
    for (const e of (f as any).evidence) {
      if (!e) continue;
      if (typeof e === 'string') {
        if (/^ev_[0-9a-f]{12}$/.test(e.trim())) ids.push(e.trim());
        continue;
      }
      if (typeof e === 'object') {
        const id = (e as any).evidenceId || (e as any).evidence_id;
        if (typeof id === 'string' && /^ev_[0-9a-f]{12}$/.test(id.trim())) ids.push(id.trim());
      }
    }
    // Dedupe while preserving order
    const seen = new Set<string>();
    return ids.filter(id => {
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  })();
  const evStr = evIds.length > 0 ? evIds.slice(0, 2).join('|') : '';

  if (!f.details || typeof f.details !== 'object' || Object.keys(f.details).length === 0) {
    return evStr ? `${f.title} (ev=${evStr})` : f.title;
  }
  const entries = Object.entries(f.details).slice(0, 4);
  const metrics = entries.map(([k, v]) => {
    const val = typeof v === 'object' ? JSON.stringify(v).slice(0, 50) : String(v);
    return `${k}=${val}`;
  }).join(', ');
  return `${f.title} (${metrics}${evStr ? `, ev=${evStr}` : ''})`;
}

function extractEvidenceIdsFromFinding(f: Finding): string[] {
  const ids: string[] = [];
  const ev = (f as any).evidence;
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

function extractSessionIdsFromFinding(f: Finding): number[] {
  const out = new Set<number>();
  const d = (f.details && typeof f.details === 'object') ? f.details as Record<string, any> : {};

  const addMaybeNumber = (v: unknown): void => {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) out.add(n);
  };

  addMaybeNumber(d.session_id);
  addMaybeNumber(d.sessionId);
  addMaybeNumber(d.scope?.session_id);
  addMaybeNumber(d.scope?.sessionId);

  const sessionIdArrays = [
    d.sourceWindow?.sessionIds,
    d.sourceWindow?.session_ids,
    d.scope?.sessionIds,
    d.scope?.session_ids,
  ];
  for (const arr of sessionIdArrays) {
    if (!Array.isArray(arr)) continue;
    for (const v of arr) addMaybeNumber(v);
  }

  const samples = Array.isArray(d.sample) ? d.sample : [];
  for (const s of samples) {
    if (!s || typeof s !== 'object') continue;
    addMaybeNumber((s as any).session_id);
    addMaybeNumber((s as any).sessionId);
  }

  const title = String(f.title || '');
  const titleMatch = title.match(/区间\s*(\d+)/);
  if (titleMatch) addMaybeNumber(titleMatch[1]);

  return Array.from(out);
}

function parseTsNs(value: unknown): bigint | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (!/^\d+$/.test(s)) return null;
  try {
    const n = BigInt(s);
    return n > 0n ? n : null;
  } catch {
    return null;
  }
}

function extractTimeRangeFromFinding(f: Finding): { start?: bigint; end?: bigint } {
  const d = (f.details && typeof f.details === 'object') ? f.details as Record<string, any> : {};

  let start = parseTsNs(d.start_ts) || parseTsNs(d.startTs) || parseTsNs(d.sourceWindow?.startTsNs) || parseTsNs(d.sourceWindow?.start_ts);
  let end = parseTsNs(d.end_ts) || parseTsNs(d.endTs) || parseTsNs(d.sourceWindow?.endTsNs) || parseTsNs(d.sourceWindow?.end_ts);

  const samples = Array.isArray(d.sample) ? d.sample : [];
  for (const s of samples) {
    if (!s || typeof s !== 'object') continue;
    const sStart = parseTsNs((s as any).start_ts) || parseTsNs((s as any).startTs);
    const sEnd = parseTsNs((s as any).end_ts) || parseTsNs((s as any).endTs);
    if (sStart && (!start || sStart < start)) start = sStart;
    if (sEnd && (!end || sEnd > end)) end = sEnd;
  }

  return {
    ...(start && { start }),
    ...(end && { end }),
  };
}

function findingsAreDifferentScope(a: Finding, b: Finding): boolean {
  const aSessions = extractSessionIdsFromFinding(a);
  const bSessions = extractSessionIdsFromFinding(b);
  if (aSessions.length > 0 && bSessions.length > 0) {
    const bSet = new Set(bSessions);
    const hasIntersection = aSessions.some(id => bSet.has(id));
    if (!hasIntersection) return true;
  }

  const aRange = extractTimeRangeFromFinding(a);
  const bRange = extractTimeRangeFromFinding(b);
  if (aRange.start !== undefined && aRange.end !== undefined &&
      bRange.start !== undefined && bRange.end !== undefined) {
    const overlap = aRange.start <= bRange.end && bRange.start <= aRange.end;
    if (!overlap) return true;
  }

  return false;
}

function buildEvidenceIdFindingIndex(findings: Finding[]): Map<string, Finding> {
  const index = new Map<string, Finding>();
  for (const f of findings) {
    for (const id of extractEvidenceIdsFromFinding(f)) {
      if (!index.has(id)) index.set(id, f);
    }
  }
  return index;
}

function filterScopeIncompatibleContradictions(
  contradictions: string[],
  findings: Finding[],
  emitter: ProgressEmitter
): string[] {
  if (!Array.isArray(contradictions) || contradictions.length === 0) return [];

  const evidenceIndex = buildEvidenceIdFindingIndex(findings);
  const filtered: string[] = [];

  for (const contradiction of contradictions) {
    const ids = Array.from(new Set(String(contradiction || '').match(/\bev_[0-9a-f]{12}\b/g) || []));
    if (ids.length < 2) {
      filtered.push(contradiction);
      continue;
    }

    const related: Finding[] = [];
    for (const id of ids) {
      const f = evidenceIndex.get(id);
      if (f && !related.includes(f)) related.push(f);
    }

    if (related.length < 2) {
      filtered.push(contradiction);
      continue;
    }

    let scopeIncompatible = false;
    for (let i = 0; i < related.length; i += 1) {
      for (let j = i + 1; j < related.length; j += 1) {
        if (findingsAreDifferentScope(related[i], related[j])) {
          scopeIncompatible = true;
          break;
        }
      }
      if (scopeIncompatible) break;
    }

    if (scopeIncompatible) {
      emitter.log(`[feedbackSynthesizer] Skip contradiction (different scope): ${contradiction}`);
      continue;
    }

    filtered.push(contradiction);
  }

  return filtered;
}

function contradictionMentionsFinding(contradiction: string, finding: Finding): boolean {
  const lower = String(contradiction || '').toLowerCase();
  const title = String(finding.title || '').toLowerCase();
  if (title && lower.includes(title)) return true;

  const evIds = extractEvidenceIdsFromFinding(finding);
  return evIds.some(id => lower.includes(id.toLowerCase()));
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
  messageBus?: AgentMessageBus,
  sessionContext?: EnhancedSessionContext
): Promise<SynthesisResult> {
  const allFindings: Finding[] = [];
  const newFindings: Finding[] = [];

  // Collect all findings from responses
  for (const response of responses) {
    allFindings.push(...response.findings);
  }

  // Semantic deduplication: group by category + severity, merge similar findings
  // This is more robust than simple title matching as it handles:
  // 1. Same issue reported with different wording
  // 2. Multiple agents supporting the same conclusion (boost confidence)
  const groupedFindings = new Map<string, Finding[]>();
  for (const finding of allFindings) {
    const groupKey = `${finding.category || 'unknown'}:${finding.severity}`;
    if (!groupedFindings.has(groupKey)) {
      groupedFindings.set(groupKey, []);
    }
    groupedFindings.get(groupKey)!.push(finding);
  }

  // For each group, keep the highest-confidence finding and merge evidence
  const seenTitles = new Set<string>();
  for (const [, group] of groupedFindings) {
    // Sort by confidence (descending)
    group.sort((a, b) => (b.confidence || 0.5) - (a.confidence || 0.5));
    const best = group[0];

    // Skip if we've already seen this exact title
    if (seenTitles.has(best.title)) {
      continue;
    }
    seenTitles.add(best.title);

    // Merge evidence from other findings in the same group
    for (let i = 1; i < group.length; i++) {
      const otherEvidence = group[i].evidence;
      if (otherEvidence && Array.isArray(otherEvidence)) {
        best.evidence = [...(best.evidence || []), ...otherEvidence];
      }
    }

    // Boost confidence when multiple agents support the same conclusion
    if (group.length > 1) {
      best.confidence = Math.min(1, (best.confidence || 0.5) + 0.1);
    }

    newFindings.push(best);
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
5. 若可能，请在矛盾描述中引用 evidence id（例如 ev_123...），便于后续追溯证据链。

矛盾判定约束（必须遵守）：
- 只有“同口径 + 同时间窗/同会话 + 同进程”下的数据冲突，才可标记为矛盾
- 不同区间（例如区间1 vs 区间2）的数值差异，属于区间差异，不是矛盾
- 如果无法确认同一时间窗，优先归类为“信息缺口”而不是“矛盾”

请以 JSON 返回：
{
  "correlatedFindings": ["相互印证的发现"],
  "contradictions": ["数据中的矛盾或不一致"],
  "hypothesisUpdates": [
    {
      "hypothesisId": "假设ID",
      "action": "support/weaken/reject",
      "confidence_delta": 0.1,
      "reason": "更新原因"
    }
  ],
  "informationGaps": ["已有数据中的不一致或异常"]
}

## 假设更新规则
- support: 发现支持该假设，增加置信度（+0.05 到 +0.2）
- weaken: 发现与该假设部分矛盾，降低置信度（-0.05 到 -0.2）但不否定
- reject: 发现明确否定该假设，将置信度设为 0 并标记为 rejected`;

  let informationGaps: string[] = [];

  try {
    const response = await modelRouter.callWithFallback(prompt, 'evaluation', {
      sessionId: sharedContext.sessionId,
      traceId: sharedContext.traceId,
      jsonMode: true,
      promptId: 'agent.feedbackSynthesizer',
      promptVersion: '1.0.0',
      contractVersion: 'feedback_synthesis_json@1.0.0',
    });
    const parsed = parseLlmJson<FeedbackSynthesisJsonPayload>(response.response, FEEDBACK_SYNTHESIS_JSON_SCHEMA);
    informationGaps = parsed.informationGaps || [];

    // Process contradictions - mark conflicting findings with reduced confidence
    // This prevents self-contradictory conclusions like "主线程耗时" vs "主线程阻塞 90%"
    const contradictions = filterScopeIncompatibleContradictions(
      parsed.contradictions || [],
      newFindings,
      emitter
    );
    if (contradictions.length > 0) {
      emitter.log(`[feedbackSynthesizer] Detected contradictions: ${contradictions.join('; ')}`);

      // Record contradictions into durable per-trace state (best-effort).
      for (const c of contradictions) {
        const evidenceIds = Array.from(new Set(
          String(c || '').match(/\bev_[0-9a-f]{12}\b/g) || []
        ));
        sessionContext?.recordTraceAgentContradiction({
          description: c,
          severity: 'major',
          ...(evidenceIds.length > 0 && { evidenceIds }),
        });
      }

      // Mark contradicted findings for downstream filtering
      for (const finding of newFindings) {
        const matchedReasons = contradictions.filter(c => contradictionMentionsFinding(c, finding));
        if (matchedReasons.length === 0) continue;

        // Reduce confidence once even if multiple contradiction entries mention the same finding.
        finding.confidence = Math.max(0.3, (finding.confidence || 0.7) - 0.3);
        finding.details = {
          ...finding.details,
          _contradicted: true,
          _contradictionReason: matchedReasons.join('；'),
        };
        emitter.log(`[feedbackSynthesizer] Marked finding "${finding.title}" as contradicted`);
      }

      // Also treat contradictions as top-priority gaps to drive next experiments.
      const cxGaps = contradictions.map(c => `矛盾: ${c}`);
      informationGaps = Array.from(new Set([...cxGaps, ...informationGaps]));
    }

    // Process hypothesis updates via messageBus (ensures broadcasts fire)
    if (parsed.hypothesisUpdates) {
      for (const update of parsed.hypothesisUpdates) {
        const hypothesis = sharedContext.hypotheses.get(update.hypothesisId);
        if (hypothesis) {
          const updated: Hypothesis = {
            ...hypothesis,
            updatedAt: Date.now(),
          };

          // Determine confidence adjustment
          // LLM can specify confidence_delta, otherwise use defaults
          const delta = typeof update.confidence_delta === 'number'
            ? Math.max(-0.3, Math.min(0.3, update.confidence_delta)) // Clamp to [-0.3, 0.3]
            : (update.action === 'support' ? 0.1 : -0.1);

          if (update.action === 'support') {
            // Support: increase confidence
            updated.confidence = Math.min(1, hypothesis.confidence + Math.abs(delta));
            // If confidence exceeds 0.85, mark as confirmed
            if (updated.confidence >= 0.85) {
              updated.status = 'confirmed';
            }
          } else if (update.action === 'weaken') {
            // Weaken: decrease confidence but don't reject
            updated.confidence = Math.max(0.1, hypothesis.confidence - Math.abs(delta));
            // Keep status as proposed or investigating
            if (updated.status === 'confirmed' && updated.confidence < 0.7) {
              updated.status = 'investigating';
            }
          } else if (update.action === 'reject') {
            // Reject: set confidence to 0 and mark as rejected
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
