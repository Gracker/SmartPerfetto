// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {randomUUID} from 'node:crypto';
import type {SceneEntryEvidenceInput} from './sceneEntryEvidence';
import {resolveAnalysisInvestigationRequirements} from './analysisInvestigationRequirements';
import {admitInvestigationEntryProducer} from '../agentv3/entrySkillPolicy';
import {evidenceHash, executePreparedSkillRun, prepareSkillRun,
  type PreparedSkillRun, type SkillRunOutcome} from '../agentv3/skillRunCore';
import {createDataEnvelope} from '../types/dataContract';
import type {AnalysisInvestigationEntryAcquisition} from '../types/analysisInvestigation';
import {captureRawSqlEvidence, capturedEvidenceTable, capturedNativeRow, evidenceTableFor,
  projectEvidenceCaptureMetadataForModel, projectEvidenceTableForModel,
  type EvidenceScalar} from '../services/evidence/evidenceCapture';
import {investigationMetricBindingForModel, type InvestigationEvidenceDeclaration} from '../services/evidence/investigationEvidenceLedger';
import {getConsumableProcessIdentitySelectors} from '../services/processIdentity/identityGate';
import {assertEffectiveProcessScope, verifiedIdentityForScope} from '../services/processIdentity/effectiveProcessScope';
import {AnalysisContextAuthorizationChangedError} from '../services/resolvedAnalysisContext';
import {runWithinRuntimeToolInvocation} from './runtimeToolInvocationContext';
import {withRunAuthorizationOnly, type SharedToolSpec} from './runtimeToolSpec';
import {createRuntimeToolResult} from './runtimeToolResult';

/** The collector supplies its existing timeout constant; this module has no runtime import of it. */
export type SelectedEvidenceFoundationInput = Omit<SceneEntryEvidenceInput, 'focusTarget' | 'timeoutMs'> & {
  timeoutMs: number;
};
type SelectionInput = Pick<SceneEntryEvidenceInput, 'turnIntent' | 'policy' | 'strategyRegistry' |
  'selectionContext' | 'referenceTraceId' | 'tracePairContext' | 'conversationTraceAttached'>;

type SelectedFoundationReason = 'target_not_selected' | 'unsupported_selection' | 'selection_mismatch' |
  'native_unavailable' | 'identity_unresolved' | 'producer_unavailable' | 'producer_ambiguous' |
  'binding_unsupported' | 'scope_unavailable' | 'cancelled' | 'authorization_revoked' | 'timeout' | 'failed';

interface SelectedFoundationCell {
  artifactId: string;
  evidenceRefId: string;
  rowIndex: number;
  column: string;
  value: EvidenceScalar;
  unit?: string;
  role: 'identity' | 'window' | 'status' | 'value' | 'coverage' | 'denominator';
}
interface SelectedFoundationArtifact {
  artifactId: string;
  evidenceRefId: string;
  stepId: string;
  rowCount: number;
  captureRows: 'available' | 'empty' | 'unavailable';
  metricBinding: 'present' | 'absent' | 'unknown';
}
export interface SelectedFoundationResult {
  kind: 'selected_foundation';
  native: {status: 'not_run' | 'failed'; reason: SelectedFoundationReason} | {
    status: 'captured'; evidenceRefId: string; sourceToolCallId: string; captureId: string; rowIndex: 0;
    row: {id: number; ts: number; dur: number; track_id: number};
    columnUnits: Readonly<Record<string, string>>;
  };
  metric: {
    status: 'not_run' | 'committed' | 'partial' | 'failed';
    reason?: SelectedFoundationReason;
    skillId?: string;
    metricId?: string;
    artifactCount: number;
    captureCount: number;
    artifacts: SelectedFoundationArtifact[];
    cells: SelectedFoundationCell[];
    omittedCellCount: number;
  };
  identity?: {upid: number; utid: number; startNs: number; endNs: number};
  durationMs: number;
}

const LOOKUP_MAX_BYTES = 4096;
const NATIVE_PRODUCER = 'runtime_selected_slice';
const safeInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value);
const positiveId = (value: unknown): value is number => safeInteger(value) && value > 0;

function selectedEntry(input: SelectionInput): AnalysisInvestigationEntryAcquisition | undefined {
  const intent = input.turnIntent;
  if (intent.status !== 'resolved' || intent.taskKind !== 'investigation' || intent.scope !== 'bounded_question' ||
      intent.targetUse !== 'current_selection' || intent.evidenceAccess !== 'read_new' ||
      input.policy.allowNewEvidence !== true || input.referenceTraceId !== undefined || input.tracePairContext !== undefined ||
      input.conversationTraceAttached === false) return;
  const selected = input.selectionContext;
  if (selected?.kind !== 'track_event' || selected.source !== 'track_event_selection' || selected.nativeTable !== 'slice' ||
      !safeInteger(selected.eventId) || selected.eventId < 0 || !safeInteger(selected.ts) ||
      !positiveId(selected.dur) || !safeInteger(selected.ts + selected.dur)) return;
  const requirements = resolveAnalysisInvestigationRequirements({intent, strategyRegistry: input.strategyRegistry});
  if (requirements.status !== 'resolved') return;
  const entries = requirements.requirements.filter(item => item.entryAcquisition !== undefined);
  if (entries.length !== 1 || !entries[0].evidenceMetrics?.includes(entries[0].entryAcquisition!.metricId)) return;
  return entries[0].entryAcquisition;
}

/** Pure early dispatch predicate. It grants neither native identity nor acquisition authority. */
export function shouldCollectSelectedEvidenceFoundation(input: SelectionInput): boolean {
  return selectedEntry(input) !== undefined;
}

class FoundationStopped extends Error {
  constructor(readonly reason: SelectedFoundationReason) {super(reason);}
}

function oneRow(value: {columns: string[]; rows: unknown[][]; error?: string}, columns: readonly string[]):
Record<string, unknown> | undefined {
  if (value.error || value.rows.length !== 1 || value.columns.length !== columns.length ||
      new Set(value.columns).size !== columns.length || columns.some(column => !value.columns.includes(column)) ||
      !Array.isArray(value.rows[0]) || value.rows[0].length !== columns.length) return;
  return Object.fromEntries(value.columns.map((column, index) => [column, value.rows[0][index]]));
}

function matchingParam(value: unknown, expected: number): boolean {
  return value === expected || value === String(expected);
}

function assertPreparedSelection(prepared: PreparedSkillRun, entry: AnalysisInvestigationEntryAcquisition,
  identity: NonNullable<SelectedFoundationResult['identity']>, traceId: string, userPackageName?: string): void {
  const scope = prepared.gate.processScope;
  if (!scope || scope.mode !== 'exact_upid' || scope.upid !== identity.upid || prepared.identityResolution?.status !== 'verified') {
    throw new FoundationStopped('identity_unresolved');
  }
  try {
    assertEffectiveProcessScope(scope, traceId, 'current');
    const verified = verifiedIdentityForScope(scope);
    if (!verified || verified.target.upid !== identity.upid || verified.resolution.status !== 'verified' ||
        verified.resolution.upids.length !== 1 || verified.resolution.upids[0] !== identity.upid ||
        userPackageName && verified.target.requestedName !== userPackageName) throw new Error('selected_scope_mismatch');
  } catch {throw new FoundationStopped('identity_unresolved');}
  const values = {selected_start: identity.startNs, selected_end: identity.endNs,
    selected_upid: identity.upid, selected_utid: identity.utid};
  for (const [name, binding] of Object.entries(entry.params)) {
    // The issued exact process scope can consume UPID instead of keeping it in public Skill params.
    if (binding === 'selected_upid' && prepared.effectiveParams[name] === undefined) continue;
    if (!matchingParam(prepared.effectiveParams[name], values[binding])) throw new FoundationStopped('binding_unsupported');
  }
}

function metricProjection(outcome: Extract<SkillRunOutcome, {status: 'committed'}>,
  declaration: InvestigationEvidenceDeclaration, metricId: string):
Pick<SelectedFoundationResult['metric'], 'artifacts' | 'cells' | 'omittedCellCount'> {
  const metric = declaration.metrics.find(item => item.metric_id === metricId)!;
  const columns = new Map<string, SelectedFoundationCell['role']>();
  Object.values(declaration.identity ?? {}).forEach(column => columns.set(column, 'identity'));
  Object.values(declaration.window).forEach(column => columns.set(column, 'window'));
  columns.set(metric.status, 'status'); columns.set(metric.value, 'value');
  if (metric.coverage) columns.set(metric.coverage, 'coverage');
  if (metric.denominator) columns.set(metric.denominator, 'denominator');
  const artifacts: SelectedFoundationArtifact[] = [], cells: SelectedFoundationCell[] = [];
  let omittedCellCount = 0;
  (outcome.result.displayResults ?? []).forEach((display, index) => {
    const artifactId = outcome.artifactIdsByDisplayIndex[index], evidenceRefId = outcome.evidenceRefIdsByDisplayIndex[index];
    if (!artifactId || !evidenceRefId) return;
    const projection = outcome.modelDisplayProjections[index];
    const data = projection?.data as {columns?: string[]; rows?: unknown[][]} | undefined;
    const witness = evidenceTableFor(display);
    const metadata = projectEvidenceCaptureMetadataForModel(projection?.data, witness);
    artifacts.push({artifactId, evidenceRefId, stepId: display.stepId,
      rowCount: data?.rows?.length ?? 0, captureRows: metadata.captureRows,
      metricBinding: investigationMetricBindingForModel(witness)});
    if (!projection || projection.modelProjection.status === 'unavailable' || metadata.captureRows === 'unavailable') return;
    const shortened = projection.modelProjection.status === 'truncated' ? projection.modelProjection : undefined;
    (data?.rows ?? []).forEach((row, rowIndex) => {
      for (const [column, role] of columns) {
        const position = data?.columns?.indexOf(column) ?? -1;
        if (position < 0) continue;
        const value = row[position];
        if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) {omittedCellCount++; continue;}
        if (typeof value === 'string' && shortened && (!shortened.truncatedCells || shortened.truncatedCellsOmitted ||
            shortened.truncatedCells.some(cell => cell.rowIndex === rowIndex && cell.column === column))) {
          omittedCellCount++; continue;
        }
        const unit = projection.columnUnits?.[column];
        cells.push({artifactId, evidenceRefId, rowIndex, column, value: value as EvidenceScalar, role,
          ...(unit ? {unit} : {})});
      }
    });
  });
  return {artifacts, cells, omittedCellCount};
}

/**
 * One product acquisition on the current run/processor, before any stateful prefetch.
 * An abort revokes future work/commit; this function still awaits the API work and auth cleanup it started.
 */
export async function acquireSelectedEvidenceFoundation(input: SelectedEvidenceFoundationInput): Promise<SelectedFoundationResult> {
  const startedAt = Date.now();
  const result: SelectedFoundationResult = {kind: 'selected_foundation',
    native: {status: 'not_run', reason: 'target_not_selected'},
    metric: {status: 'not_run', reason: 'target_not_selected', artifactCount: 0, captureCount: 0,
      artifacts: [], cells: [], omittedCellCount: 0}, durationMs: 0};
  const declaration = selectedEntry(input);
  if (!declaration) return result;
  // Copy the bounded request data before any asynchronous work. Neither JSON nor UI fields issue witnesses.
  const entry = structuredClone(declaration);
  const selection = input.selectionContext as Extract<NonNullable<SceneEntryEvidenceInput['selectionContext']>, {kind: 'track_event'}>;
  const selected = {id: selection.eventId, ts: selection.ts, dur: selection.dur!, end: selection.ts + selection.dur!};
  const runId = input.runId, traceId = input.traceId;
  const userPackageName = input.userPackageName?.trim() || undefined;
  result.metric.metricId = entry.metricId;
  const skip = (reason: SelectedFoundationReason) => {
    result.native = {status: 'not_run', reason}; result.metric.reason = reason; return result;
  };
  if (!runId || runId.trim() !== runId || !traceId || traceId.trim() !== traceId ||
      !input.executionLease || !input.runAuthorization || !input.canInvokeTool) return skip('scope_unavailable');
  if (!Number.isFinite(input.deadlineMs) || !Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0) return skip('scope_unavailable');
  const deadlineAt = Math.min(input.deadlineMs!, startedAt + input.timeoutMs);
  if (deadlineAt <= startedAt) return skip('timeout');
  const controller = new AbortController();
  let timedOut = false, nativeAttempted = false, metricStarted = false, observedTerminal = false;
  let authorizationFailure: {error: unknown} | undefined;
  let commitStop: SelectedFoundationReason | undefined;
  let metricCallId: string | undefined;
  const nativeCallId = `selected-native:${runId}:${randomUUID()}`;
  let phase: ReturnType<NonNullable<SceneEntryEvidenceInput['runtimePerformance']>['startPhase']> | undefined;
  let phaseOutcome: 'ok' | 'error' | 'cancelled' = 'ok';
  try {phase = input.runtimePerformance?.startPhase('scene_evidence');} catch { /* Observation only. */ }
  const expire = () => {timedOut = true; controller.abort();};
  const timer = setTimeout(expire, Math.max(0, deadlineAt - Date.now()));
  const onLeaseAbort = () => controller.abort(input.executionLease!.signal.reason);
  input.executionLease.signal.addEventListener('abort', onLeaseAbort, {once: true});
  if (input.executionLease.signal.aborted) onLeaseAbort();
  const authorization = {
    assertCurrentInTurn: () => {
      try {input.runAuthorization!.assertCurrentInTurn();}
      catch (error) {authorizationFailure = {error}; controller.abort(error); throw error;}
    },
    settled: () => input.runAuthorization!.settled(),
  };
  const guard = () => {
    if (authorizationFailure) throw authorizationFailure.error;
    if (input.executionLease!.signal.aborted) throw new FoundationStopped('cancelled');
    if (Date.now() >= deadlineAt) expire();
    if (controller.signal.aborted) throw new FoundationStopped(timedOut ? 'timeout' : 'cancelled');
    if (!input.canInvokeTool!()) {controller.abort(); throw new FoundationStopped('scope_unavailable');}
    authorization.assertCurrentInTurn();
  };
  const query = async (sql: string) => {
    guard();
    const response = await input.traceProcessorService.queryBounded(traceId, sql, {
      maxRows: 2, maxResponseBytes: LOOKUP_MAX_BYTES, timeoutMs: Math.max(1, deadlineAt - Date.now()), signal: controller.signal,
    });
    guard();
    return response;
  };
  const observe = (phaseName: 'started' | 'completed' | 'failed', success = false) => {
    const base = {toolCallId: metricCallId!, toolName: 'selected_evidence_foundation',
      params: {skillId: result.metric.skillId}, extra: {toolCallId: metricCallId}};
    input.artifactStore.observeInvestigationTool(phaseName === 'completed'
      ? {...base, phase: 'completed', result: createRuntimeToolResult({success})}
      : phaseName === 'failed' ? {...base, phase: 'failed', error: new Error('selected_evidence_foundation_failed')}
        : {...base, phase: 'started'}, runId);
    if (phaseName !== 'started') observedTerminal = true;
  };

  const acquire = async () => {
    guard(); nativeAttempted = true;
    const sql = `SELECT id, ts, dur, track_id FROM slice WHERE id = ${selected.id}`;
    const response = await query(sql);
    const row = oneRow(response, ['id', 'ts', 'dur', 'track_id']);
    if (!row || row.id !== selected.id || row.ts !== selected.ts || row.dur !== selected.dur ||
        !safeInteger(row.track_id) || row.track_id < 0) throw new FoundationStopped('selection_mismatch');
    // This must precede identity preparation, whose resolver can INCLUDE modules.
    const witness = captureRawSqlEvidence(response, {traceId, traceSide: 'current'});
    const table = capturedEvidenceTable(witness), nativeRow = capturedNativeRow(witness, 0);
    if (!table || table.unavailableReason || nativeRow?.relation !== 'slice' || nativeRow.idColumn !== 'id' ||
        nativeRow.outputColumn !== 'id' || nativeRow.id !== selected.id || nativeRow.traceId !== traceId ||
        nativeRow.traceSide !== 'current' || table.fields.dur?.origin.kind !== 'native_producer' ||
        table.fields.dur.unit !== 'ns' || !table.fields.dur.origin.definitionFingerprint) throw new FoundationStopped('native_unavailable');
    const projection = projectEvidenceTableForModel(response, witness);
    if (projection.modelProjection.status !== 'exact' || projection.columnUnits?.dur !== 'ns') throw new FoundationStopped('native_unavailable');
    const evidenceRefId = `data:selected_slice:current:${evidenceHash({runId, traceId, sql, nativeCallId})}`;
    const registerNative = () => {
      guard();
      const envelope = createDataEnvelope({columns: [...table.columns], rows: []}, {
        type: 'sql_result', source: NATIVE_PRODUCER, title: NATIVE_PRODUCER,
        layer: 'list', format: 'table', executionStatus: 'observed', traceId, traceSide: 'current',
        sourceToolCallId: nativeCallId, evidenceRefId, queryHash: table.fields.dur.origin.selectedSqlHash,
      });
      if (!input.artifactStore.registerStandaloneEvidenceCapture(witness,
        {meta: envelope.meta, display: envelope.display, originRunId: runId})) throw new FoundationStopped('native_unavailable');
      result.native = {status: 'captured', evidenceRefId, sourceToolCallId: nativeCallId,
        captureId: witness.captureId, rowIndex: 0,
        row: {id: selected.id, ts: selected.ts, dur: selected.dur, track_id: row.track_id as number},
        columnUnits: projection.columnUnits!};
    };
    if (!userPackageName) registerNative();
    const track = oneRow(await query(`SELECT id, utid FROM thread_track WHERE id = ${row.track_id}`), ['id', 'utid']);
    if (!track || track.id !== row.track_id || !positiveId(track.utid)) throw new FoundationStopped('identity_unresolved');
    const thread = oneRow(await query(`SELECT utid, upid FROM thread WHERE utid = ${track.utid}`), ['utid', 'upid']);
    if (!thread || thread.utid !== track.utid || !positiveId(thread.upid)) throw new FoundationStopped('identity_unresolved');
    const identity = {upid: thread.upid, utid: track.utid, startNs: selected.ts, endNs: selected.end};
    const definitions = new Map(input.skillRegistry.getAllSkills().map(skill => [skill.name, skill]));
    const admission = admitInvestigationEntryProducer(entry, definitions, input.skillRegistry.getFragmentCache());
    if (admission.status !== 'admitted') throw new FoundationStopped(admission.reason);
    const {skill} = admission;
    result.metric.skillId = skill.name;
    const values = {selected_start: identity.startNs, selected_end: identity.endNs,
      selected_upid: identity.upid, selected_utid: identity.utid};
    const params: Record<string, string> = Object.fromEntries(Object.entries(entry.params).map(([name, binding]) => [name, String(values[binding])]));
    if (userPackageName) {
      if (!getConsumableProcessIdentitySelectors(skill).has('package')) throw new FoundationStopped('binding_unsupported');
      params.package = userPackageName;
    }
    const deps = {traceId, traceProcessorService: input.traceProcessorService, skillExecutor: input.skillExecutor,
      artifactStore: input.artifactStore, outputLanguage: input.outputLanguage};
    guard();
    const preparation = await prepareSkillRun(deps, {skillId: skill.name, params,
      registry: input.skillRegistry, signal: controller.signal});
    guard();
    if (preparation.status !== 'ready') throw new FoundationStopped(preparation.refusal.kind === 'identity_gate'
      ? 'identity_unresolved' : 'binding_unsupported');
    const {prepared} = preparation;
    assertPreparedSelection(prepared, entry, identity, traceId, userPackageName);
    if (userPackageName) registerNative();
    result.identity = identity;
    metricCallId = `selected-metric:${skill.name}:${randomUUID()}`;
    guard(); assertPreparedSelection(prepared, entry, identity, traceId, userPackageName);
    observe('started'); metricStarted = true;
    const outcome = await runWithinRuntimeToolInvocation({toolCallId: metricCallId, runId}, () => executePreparedSkillRun(deps, prepared, {
      signal: controller.signal,
      producer: {sourceToolCallId: metricCallId, paramsHash: evidenceHash({params, identity}), planPhaseAttribution: 'none'},
      beforeCommit: () => {
        try {guard(); assertPreparedSelection(prepared, entry, identity, traceId, userPackageName);}
        catch (error) {
          commitStop = authorizationFailure ? 'authorization_revoked' : error instanceof FoundationStopped ? error.reason : 'failed';
          return authorizationFailure ? 'authorization_revoked' : 'cancelled';
        }
        return undefined;
      },
    }));
    if (outcome.status === 'commit_refused') throw new FoundationStopped(commitStop ?? 'cancelled');
    result.metric = {status: !outcome.result.success ? 'failed' : outcome.result.partial ? 'partial' : 'committed',
      ...(!outcome.result.success ? {reason: 'failed' as const} : {}), skillId: skill.name, metricId: entry.metricId,
      artifactCount: outcome.artifactIdsByDisplayIndex.filter(Boolean).length + (outcome.diagnosticsArtifactId ? 1 : 0) +
        (outcome.synthesizeArtifacts?.length ?? 0), captureCount: outcome.captureCount,
      ...metricProjection(outcome, admission.declaration, entry.metricId)};
    if (!outcome.result.success) phaseOutcome = 'error';
    observe('completed', outcome.result.success);
  };
  const spec: SharedToolSpec = {name: 'selected_evidence_foundation', description: 'Product selected evidence',
    exposure: 'internal', inputSchema: {}, handler: async () => {
      await runWithinRuntimeToolInvocation({toolCallId: nativeCallId, runId}, acquire);
      return createRuntimeToolResult({success: true});
    }};
  try {
    // No abort race: the guarded handler owns every started promise until its cleanup settles.
    await withRunAuthorizationOnly(spec, authorization).handler({}, {toolCallId: nativeCallId, signal: controller.signal});
  } catch (error) {
    const reason = authorizationFailure || error instanceof AnalysisContextAuthorizationChangedError ? 'authorization_revoked'
      : timedOut ? 'timeout' : input.executionLease.signal.aborted ? 'cancelled'
        : error instanceof FoundationStopped ? error.reason : 'failed';
    phaseOutcome = ['timeout', 'cancelled', 'authorization_revoked'].includes(reason) ? 'cancelled' : 'error';
    if (result.native.status !== 'captured') result.native = {
      status: nativeAttempted && ['selection_mismatch', 'native_unavailable', 'failed'].includes(reason) ? 'failed' : 'not_run', reason};
    if (result.metric.status === 'not_run') {
      if (metricStarted) result.metric.status = 'failed';
      result.metric.reason = reason;
    }
    if (metricStarted && !observedTerminal) {
      // An issued store may already reject writes after cancellation/revocation.
      // Keep the primary failure and the facts of any authorized core commit.
      try {observe('failed');} catch { /* Observation cannot replace the primary outcome. */ }
    }
    if (authorizationFailure) throw authorizationFailure.error;
    if (error instanceof AnalysisContextAuthorizationChangedError) throw error;
  } finally {
    clearTimeout(timer);
    input.executionLease.signal.removeEventListener('abort', onLeaseAbort);
    result.durationMs = Math.max(0, Date.now() - startedAt);
    try {phase?.end(phaseOutcome);} catch { /* Observation only. */ }
  }
  return result;
}
