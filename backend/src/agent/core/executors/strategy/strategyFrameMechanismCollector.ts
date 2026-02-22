import type { AgentResponse } from '../../../types/agentProtocol';
import type { FrameMechanismRecord } from '../../../types/jankCause';

export class StrategyFrameMechanismCollector {
  collectFromResponses(responses: AgentResponse[]): FrameMechanismRecord[] {
    const records: FrameMechanismRecord[] = [];

    for (const response of responses) {
      const toolResults = response.toolResults || [];
      for (const toolResult of toolResults) {
        const candidate = toolResult?.metadata && typeof toolResult.metadata === 'object'
          ? (toolResult.metadata as Record<string, any>).frameMechanismRecord
          : null;
        if (!candidate || typeof candidate !== 'object') {
          continue;
        }

        const normalized = this.normalizeFrameMechanismRecord(candidate);
        if (normalized) {
          records.push(normalized);
        }
      }
    }

    return records;
  }

  dedupe(records: FrameMechanismRecord[]): FrameMechanismRecord[] {
    const seen = new Set<string>();
    const deduped: FrameMechanismRecord[] = [];

    for (const record of records) {
      const key = this.buildRecordKey(record);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      deduped.push(record);
    }

    return deduped;
  }

  private normalizeFrameMechanismRecord(candidate: any): FrameMechanismRecord | null {
    const frameIdRaw = candidate.frameId ?? candidate.frame_id;
    const startTsRaw = candidate.startTs ?? candidate.start_ts;
    const endTsRaw = candidate.endTs ?? candidate.end_ts;
    const causeTypeRaw = candidate.causeType ?? candidate.cause_type;

    const sourceStep: 'root_cause' | 'root_cause_summary' =
      candidate.sourceStep === 'root_cause_summary' ? 'root_cause_summary' : 'root_cause';

    if (frameIdRaw === undefined || startTsRaw === undefined || endTsRaw === undefined) {
      return null;
    }
    if (typeof causeTypeRaw !== 'string' || causeTypeRaw.trim().length === 0) {
      return null;
    }

    const normalized: FrameMechanismRecord = {
      frameId: String(frameIdRaw),
      startTs: String(startTsRaw),
      endTs: String(endTsRaw),
      scopeLabel: typeof candidate.scopeLabel === 'string' && candidate.scopeLabel.trim().length > 0
        ? candidate.scopeLabel
        : 'unknown_scope',
      causeType: causeTypeRaw.trim(),
      sourceStep,
    };

    if (candidate.sessionId !== undefined || candidate.session_id !== undefined) {
      normalized.sessionId = String(candidate.sessionId ?? candidate.session_id);
    }
    if (candidate.frameIndex !== undefined) {
      const frameIndex = Number(candidate.frameIndex);
      if (Number.isFinite(frameIndex)) normalized.frameIndex = frameIndex;
    }
    if (typeof candidate.processName === 'string' && candidate.processName.length > 0) {
      normalized.processName = candidate.processName;
    }
    if (candidate.pid !== undefined) {
      const pid = Number(candidate.pid);
      if (Number.isFinite(pid)) normalized.pid = pid;
    }
    if (typeof candidate.primaryCause === 'string' && candidate.primaryCause.length > 0) {
      normalized.primaryCause = candidate.primaryCause;
    }
    if (typeof candidate.secondaryInfo === 'string' && candidate.secondaryInfo.length > 0) {
      normalized.secondaryInfo = candidate.secondaryInfo;
    }
    if (typeof candidate.confidenceLevel === 'number' || typeof candidate.confidenceLevel === 'string') {
      normalized.confidenceLevel = candidate.confidenceLevel;
    }
    if (candidate.frameDurMs !== undefined) {
      const frameDurMs = Number(candidate.frameDurMs);
      if (Number.isFinite(frameDurMs)) normalized.frameDurMs = frameDurMs;
    }
    if (typeof candidate.jankType === 'string' && candidate.jankType.length > 0) {
      normalized.jankType = candidate.jankType;
    }

    const mechanismGroup = candidate.mechanismGroup ?? candidate.mechanism_group;
    if (typeof mechanismGroup === 'string' && mechanismGroup.length > 0) {
      normalized.mechanismGroup = mechanismGroup;
    }

    const supplyConstraint = candidate.supplyConstraint ?? candidate.supply_constraint;
    if (typeof supplyConstraint === 'string' && supplyConstraint.length > 0) {
      normalized.supplyConstraint = supplyConstraint;
    }

    const triggerLayer = candidate.triggerLayer ?? candidate.trigger_layer;
    if (typeof triggerLayer === 'string' && triggerLayer.length > 0) {
      normalized.triggerLayer = triggerLayer;
    }

    const amplificationPath = candidate.amplificationPath ?? candidate.amplification_path;
    if (typeof amplificationPath === 'string' && amplificationPath.length > 0) {
      normalized.amplificationPath = amplificationPath;
    }

    return normalized;
  }

  private buildRecordKey(record: FrameMechanismRecord): string {
    return [
      record.sessionId || 'nosession',
      record.frameId,
      record.startTs,
      record.causeType,
    ].join('|');
  }
}
