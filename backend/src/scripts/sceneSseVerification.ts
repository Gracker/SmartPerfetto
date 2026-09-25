// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {TERMINAL_SSE_EVENT_TYPES} from '../assistant/stream/sessionSseReplay';
import {analysisDeliveryFingerprint} from '../types/analysisDelivery';
import type {SceneTimelineView, SceneReportReference} from '../types/sceneTimeline';

const object = (value: unknown): Record<string, any> | undefined => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, any> : undefined;
const ns = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value) && value.length <= 40;
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
/** Run terminals as the product defines them; `end` only closes the stream after one. */
export const SCENE_RUN_TERMINAL_EVENTS: ReadonlySet<string> = new Set([...TERMINAL_SSE_EVENT_TYPES].filter(type => type !== 'end'));
export interface SceneVerificationScope {sessionId: string; runId: string; traceId: string}
export interface SceneSseObservation {
  events: number; acquisitions: number; acquisitionIds: string[]; proposalCalls: number; issues: string[];
  revisions: Array<{revision: number; event: number; acquisitions: number; fingerprint: string}>;
  terminals: Array<{event: string; eventIndex: number}>;
  latestCandidate?: SceneTimelineView; finalTimeline?: SceneTimelineView; reportRef?: SceneReportReference;
  cancelRequestedAt?: number; cancelConfirmed?: boolean; finalSuccess?: boolean; finalPartial?: boolean;
}
export function createSceneSseObservation(): SceneSseObservation {
  return {events: 0, acquisitions: 0, acquisitionIds: [], proposalCalls: 0, issues: [], revisions: [], terminals: []};
}
function timeline(value: unknown): SceneTimelineView | undefined {
  const data = object(value);
  if (!data || data.schemaVersion !== 'scene_timeline@1' || !id(data.runId) || !id(data.sessionId) || !id(data.traceId) ||
      !Number.isSafeInteger(data.revision) || data.revision < 0 || !Array.isArray(data.segments) || data.segments.length > 2000 ||
      !Array.isArray(data.unresolved) || !Array.isArray(data.diagnostics) || !object(data.coverage)) return undefined;
  if (!data.segments.every((entry: unknown) => {
    const assessment = object(entry), segment = object(assessment?.segment);
    return segment && id(segment.id) && ns(segment.startNs) && ns(segment.endNs) &&
      BigInt(segment.startNs) <= BigInt(segment.endNs) && object(segment.object) && id(segment.object.kind) && id(segment.object.key) &&
      ['userAction', 'deviceState', 'appResponse'].every(key => typeof segment[key] === 'string') &&
      Array.isArray(segment.evidenceRefs) && segment.evidenceRefs.every((ref: any) => object(ref) &&
        Number.isSafeInteger(ref.rowIndex) && ref.rowIndex >= 0 && [ref.artifactId, ref.evidenceRefId, ref.sourceToolCallId].some(id)) &&
      Array.isArray(assessment!.diagnostics) && assessment!.diagnostics.every((diagnostic: any) => object(diagnostic) && id(diagnostic.code)) &&
      Array.isArray(assessment!.checks) && assessment!.checks.every((check: any) => object(check) &&
        id(check.predicate) && ['passed', 'contradicted', 'unknown'].includes(check.status));
  })) return undefined;
  if (new Set(data.segments.map((item: any) => item.segment.id)).size !== data.segments.length) return undefined;
  return data as SceneTimelineView;
}
/** Compare the visible story, excluding receipt versions, locators and display ordering. */
function sceneContentFingerprint(value: SceneTimelineView): string {
  return analysisDeliveryFingerprint(value.segments.map(({segment}) => analysisDeliveryFingerprint({
    startNs: segment.startNs, endNs: segment.endNs, object: segment.object,
    userAction: segment.userAction, deviceState: segment.deviceState, appResponse: segment.appResponse,
  })).sort());
}
export function recordSceneSseEvent(state: SceneSseObservation, event: string, payload: unknown, scope: SceneVerificationScope): void {
  state.events++;
  const data = object(payload);
  const issue = (code: string) => {if (!state.issues.includes(code) && state.issues.length < 64) state.issues.push(code);};
  if (event === 'agent_task_dispatched') {
    const tool = typeof data?.toolName === 'string' ? data.toolName.replace(/^mcp__[^_]+__/, '') : '';
    if (tool === 'propose_scene_timeline') state.proposalCalls++;
  }
  // Completed fact output, not a model-authored plan or a pending tool dispatch.
  if (event === 'data' || event === 'data_envelope') {
    const candidates = [payload, data?.envelope, data?.data, object(data?.data)?.envelope, object(data?.data)?.data, data?.content, object(data?.content)?.data].flatMap(value => Array.isArray(value) ? value : [value]);
    for (const candidate of candidates) {
      const meta = object(object(candidate)?.meta);
      if (!meta || meta.traceId !== scope.traceId || meta.traceSide !== 'current' || !id(meta.sourceToolCallId) ||
          ['unavailable', 'optional_error', 'skipped'].includes(meta.executionStatus)) continue;
      const key = String(meta.evidenceRefId || meta.artifactId || meta.sourceToolCallId);
      if (state.acquisitionIds.includes(key)) continue;
      if (state.acquisitionIds.length >= 4096) {issue('scene_acquisition_observation_budget_exhausted'); break;}
      state.acquisitionIds.push(key); state.acquisitions++;
    }
  }
  if (SCENE_RUN_TERMINAL_EVENTS.has(event)) {
    if (state.terminals.length < 8) state.terminals.push({event, eventIndex: state.events});
    else issue('terminal_event_budget_exhausted');
  }
  if (event !== 'scene_timeline_updated' && event !== 'analysis_completed') return;
  if (JSON.stringify(payload).length > 4_194_304) {issue('scene_observation_size_exhausted'); return;}
  const current = timeline(event === 'scene_timeline_updated' ? data?.sceneTimeline ?? data : data?.sceneTimeline);
  if (!current) {issue('scene_timeline_missing_or_malformed'); return;}
  if (current.runId !== scope.runId || current.sessionId !== scope.sessionId || current.traceId !== scope.traceId) issue('scene_scope_mismatch');
  if (event === 'scene_timeline_updated') {
    if (state.terminals.length || state.cancelConfirmed) issue('scene_revision_after_terminal_or_cancel');
    const previous = state.revisions[state.revisions.length - 1];
    if (previous && current.revision <= previous.revision) issue('scene_revision_not_increasing');
    if (state.revisions.length >= 64) {issue('scene_revision_observation_budget_exhausted'); return;}
    state.revisions.push({revision: current.revision, event: state.events, acquisitions: state.acquisitions,
      fingerprint: sceneContentFingerprint(current)});
    state.latestCandidate = current;
  } else {
    state.finalTimeline = current;
    state.finalSuccess = data?.success;
    state.finalPartial = data?.partial;
    const ref = object(data?.sceneReport);
    if (ref?.schemaVersion === 'scene_report_ref@1' && id(ref.reportId) && typeof ref.manifestSha256 === 'string' && /^[a-f0-9]{64}$/.test(ref.manifestSha256) &&
        id(ref.traceId) && id(ref.sessionId) && id(ref.runId) && Number.isSafeInteger(ref.revision)) state.reportRef = ref as SceneReportReference;
  }
}

export function evaluateSceneSseVerification(input: {observation: SceneSseObservation; replay: SceneSseObservation;
  scope: SceneVerificationScope; status: unknown; report?: unknown; start: unknown;
  bounds: {startNs: string; endNs: string}; scenario: 'complete' | 'partial' | 'cancel'; minRevision: number;
  runtime: string; providerId?: string | null; observationMs: number}): {
    checks: Record<string, boolean>; passed: boolean; uncoveredFacets: string[];
  } {
  const {observation: state, replay, scope} = input;
  const status = object(input.status), result = object(status?.result), start = object(input.start);
  const checks: Record<string, boolean> = {
    sceneEntryReturnedOwnedRun: start?.sessionId === scope.sessionId && start?.runId === scope.runId && start?.analysisId === scope.sessionId,
    sceneObservationsValid: state.issues.length === 0 && replay.issues.length === 0,
    sceneProposalToolObserved: state.proposalCalls > 0,
    sceneFactAcquisitionObserved: state.acquisitions > 0,
    sceneCandidateObserved: state.revisions.length > 0,
    sceneOneTerminal: state.terminals.length === 1,
    sceneReplayOneTerminal: replay.terminals.length === 1,
    sceneStatusOwned: status?.sessionId === scope.sessionId && status?.traceId === scope.traceId,
  };
  if (input.scenario === 'cancel') {
    checks.sceneCancelConfirmed = state.cancelConfirmed === true;
    checks.sceneTerminalCancelled = state.terminals[0]?.event === 'analysis_cancelled' && replay.terminals[0]?.event === 'analysis_cancelled';
    checks.sceneRootStatusCancelled = status?.status === 'cancelled';
    checks.sceneNoCancelledReport = !result?.sceneReport && !state.reportRef && !replay.reportRef && !state.finalTimeline && !replay.finalTimeline;
    checks.sceneNoLateRevision = (replay.latestCandidate?.revision ?? 0) <= (state.latestCandidate?.revision ?? 0);
  } else {
    const final = state.finalTimeline, candidate = state.latestCandidate, ref = state.reportRef;
    const report = object(object(input.report)?.report), statusTimeline = timeline(result?.sceneTimeline);
    const reportTimeline = timeline(report?.sceneTimeline), replayTimeline = replay.finalTimeline;
    checks.sceneRootStatusCompleted = status?.status === 'completed' || (input.scenario === 'partial' && status?.status === 'failed');
    checks.sceneRuntimeCompleted = state.terminals[0]?.event === 'analysis_completed' && (input.scenario === 'partial'
      ? typeof state.finalSuccess === 'boolean' && state.finalPartial === true && result?.partial === true
      : state.finalSuccess === true);
    checks.sceneCanonicalLastRevision = Boolean(final && candidate && final.revision === candidate.revision &&
      analysisDeliveryFingerprint(final.segments) === analysisDeliveryFingerprint(candidate.segments));
    checks.sceneMinimumRevision = Boolean(final && final.revision >= input.minRevision);
    checks.sceneStatusCanonical = Boolean(final && statusTimeline && analysisDeliveryFingerprint(statusTimeline) === analysisDeliveryFingerprint(final));
    checks.sceneReplayCanonical = Boolean(final && replayTimeline && analysisDeliveryFingerprint(replayTimeline) === analysisDeliveryFingerprint(final));
    checks.sceneReplayTerminalConsistent = replay.terminals[0]?.event === 'analysis_completed' &&
      replay.finalSuccess === state.finalSuccess && replay.finalPartial === state.finalPartial;
    checks.sceneReplayReportReferenceBound = Boolean(ref && replay.reportRef &&
      analysisDeliveryFingerprint(replay.reportRef) === analysisDeliveryFingerprint(ref));
    checks.sceneReportReferenceBound = Boolean(ref && final && ref.traceId === scope.traceId && ref.sessionId === scope.sessionId &&
      ref.runId === scope.runId && ref.revision === final.revision && analysisDeliveryFingerprint(result?.sceneReport) === analysisDeliveryFingerprint(ref));
    checks.sceneReportReadableAndCanonical = Boolean(report?.cachePolicy === 'evidence_archive' && report?.generatedBy?.pipelineVersion === 'v3' && ref && report.reportId === ref.reportId && report.traceId === scope.traceId &&
      report.runId === scope.runId && report.sessionId === scope.sessionId && reportTimeline && final &&
      analysisDeliveryFingerprint(reportTimeline) === analysisDeliveryFingerprint(final));
    checks.sceneProviderPin = Boolean(report?.generatedBy?.runtimeKind === input.runtime &&
      (input.providerId === undefined || report.generatedBy.providerId === input.providerId));
    checks.sceneEvidenceBound = Boolean(final?.segments.length && final.segments.every(segment =>
      (segment.referencesResolved === true && segment.segment.evidenceRefs.length > 0) ||
      (segment.semanticStatus === 'unverified' && segment.diagnostics.some(diagnostic =>
        ['no_segment_evidence', 'evidence_read_incomplete'].includes(diagnostic.code)))) &&
      final.segments.some(segment => segment.referencesResolved && segment.segment.evidenceRefs.length > 0));
    checks.sceneExactTraceBounds = Boolean(final?.segments.every(item => BigInt(item.segment.startNs) >= BigInt(input.bounds.startNs) &&
      BigInt(item.segment.endNs) <= BigInt(input.bounds.endNs)));
    checks.sceneUncertaintyHonest = Boolean(final && final.status === 'partial' && final.coverage.captureStatus === 'unknown' &&
      final.segments.every(segment => segment.semanticStatus === 'unverified'));
    if (input.minRevision >= 2) checks.sceneRevisionAfterNewAcquisition = state.revisions.some((revision, index) => index > 0 &&
      revision.acquisitions > state.revisions[index - 1].acquisitions && revision.fingerprint !== state.revisions[index - 1].fingerprint);
  }
  return {checks, passed: Object.values(checks).every(Boolean), uncoveredFacets: [
    'scene_action_and_device_semantics_not_independently_scored', 'raw_archive_authority_not_accessed_by_verifier',
    ...(input.minRevision < 2 ? ['multi_revision_correction_not_required_by_this_case'] : []),
    `late_event_observation_bounded_to_${input.observationMs}ms`,
  ]};
}

/** Authored verifier inputs only. Never populate this from the model's timeline or tool output. */
export interface SceneOracleSpec {
  id: string; sql: string; startColumn: string; endColumn: string;
  objectKind?: string; objectKeyColumn?: string; minMatchedRows: number; toleranceNs: string;
}
export interface SceneOracleObservation {
  id: string; minMatchedRows: number; toleranceNs: string;
  rows: Array<{startNs: string; endNs: string; objectKind?: string; objectKey?: string}>;
}
export function parseSceneOracleSpecs(value: unknown): SceneOracleSpec[] {
  if (!Array.isArray(value) || !value.length || value.length > 16) throw new Error('Invalid scene oracle list');
  const allowed = ['id', 'sql', 'startColumn', 'endColumn', 'objectKind', 'objectKeyColumn', 'minMatchedRows', 'toleranceNs'];
  const ids = new Set<string>();
  return value.map(item => {
    const data = object(item);
    if (!data || Object.keys(data).some(key => !allowed.includes(key)) ||
        !['id', 'sql', 'startColumn', 'endColumn'].every(key => id(data[key]) && data[key].length <= (key === 'sql' ? 65536 : 256)) ||
        ids.has(data.id) || (data.objectKind === undefined) !== (data.objectKeyColumn === undefined) ||
        (data.objectKind !== undefined && (!id(data.objectKind) || !id(data.objectKeyColumn))) ||
        !Number.isSafeInteger(data.minMatchedRows ?? 1) || (data.minMatchedRows ?? 1) < 1 || (data.minMatchedRows ?? 1) > 4096 ||
        !ns(data.toleranceNs ?? '0')) throw new Error('Invalid scene oracle specification');
    ids.add(data.id);
    return {...data, minMatchedRows: data.minMatchedRows ?? 1, toleranceNs: data.toleranceNs ?? '0'} as SceneOracleSpec;
  });
}
export async function collectSceneOracleRows(specs: readonly SceneOracleSpec[], query: (sql: string) => Promise<{
  columns: string[]; rows: unknown[][]; error?: string;
}>): Promise<SceneOracleObservation[]> {
  const result: SceneOracleObservation[] = [];
  let total = 0;
  for (const spec of specs) {
    const response = await query(spec.sql);
    if (response.error || ![spec.startColumn, spec.endColumn, ...(spec.objectKeyColumn ? [spec.objectKeyColumn] : [])]
      .every(column => response.columns.includes(column)) || new Set(response.columns).size !== response.columns.length ||
      response.rows.length > 4096 || (total += response.rows.length) > 4096) throw new Error('SCENE_ORACLE_ROWS_UNAVAILABLE_OR_UNBOUNDED');
    const rows = response.rows.map(row => {
      const exact = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : value;
      const start = exact(row[response.columns.indexOf(spec.startColumn)]), end = exact(row[response.columns.indexOf(spec.endColumn)]);
      const key = spec.objectKeyColumn ? exact(row[response.columns.indexOf(spec.objectKeyColumn)]) : undefined;
      if (!ns(start) || !ns(end) || BigInt(start) > BigInt(end) || (spec.objectKeyColumn && !id(key))) throw new Error('SCENE_ORACLE_NONEXACT_ROW');
      return {startNs: start, endNs: end, ...(spec.objectKind ? {objectKind: spec.objectKind, objectKey: key as string} : {})};
    });
    result.push({id: spec.id, minMatchedRows: spec.minMatchedRows, toleranceNs: spec.toleranceNs, rows});
  }
  return result;
}
export function evaluateSceneOracleRows(final: SceneTimelineView | undefined, oracles: readonly SceneOracleObservation[]): Record<string, boolean> {
  const abs = (value: bigint) => value < 0n ? -value : value;
  return Object.fromEntries(oracles.map(oracle => {
    const used = new Set<number>();
    let matched = 0;
    for (const row of oracle.rows) {
      const index = final?.segments.findIndex(({segment, referencesResolved}, candidateIndex) => !used.has(candidateIndex) && referencesResolved &&
        abs(BigInt(segment.startNs) - BigInt(row.startNs)) <= BigInt(oracle.toleranceNs) &&
        abs(BigInt(segment.endNs) - BigInt(row.endNs)) <= BigInt(oracle.toleranceNs) &&
        (!row.objectKind || (segment.object.kind === row.objectKind && segment.object.key === row.objectKey))) ?? -1;
      if (index >= 0) {used.add(index); matched++;}
    }
    return [`sceneOracle:${oracle.id}`, matched >= oracle.minMatchedRows];
  }));
}
