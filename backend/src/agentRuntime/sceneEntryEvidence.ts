// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Product-owned scene entry evidence. A resolved scene-wide investigation
 * whose strategy declares an `entry_skill` has that Skill run by the product,
 * under a verified process identity, before the model's first turn; the model
 * reads its overview cells in the `scene_evidence` prompt segment and cites
 * them like any Skill result.
 *
 * It is not a model tool call. It never passes the MCP registry, so it never
 * appears in RunManifest `toolResults`, the registry tool observer, acquisition
 * pacing, tool timing or plan tool-call records. The guards the registry would
 * apply are applied here, in order: the request scope, `canInvokeTool`, the
 * run's lease and deadline, the run authorization fence (auth-only, untimed),
 * and a check after the Skill returned, inside the core, before anything is
 * written. It settles, or gives up at its own deadline, before any runtime
 * creates its acquisition-capable MCP server, so no model tool call can run
 * beside it. Captures join the investigation ledger through a product call id,
 * observed as started and then completed or failed.
 */

import {isToolAllowedForScope} from '../agentv3/mcpToolRegistry';
import type {ArtifactStore} from '../agentv3/artifactStore';
import {entrySkillExecutabilityErrors} from '../agentv3/entrySkillPolicy';
import type {OutputLanguage} from '../agentv3/outputLanguage';
import {localize} from '../agentv3/outputLanguage';
import {
  evidenceHash,
  executePreparedSkillRun,
  prepareSkillRun,
  type SkillRunCommitRefusal,
  type SkillRunOutcome,
  type SkillRunRefusal,
} from '../agentv3/skillRunCore';
import {summarizeToolCallInput} from '../agentv3/toolCallSummary';
import type {SelectionContext} from '../agentv3/types';
import type {ReadonlyStrategyRegistrySnapshot} from '../services/selfEvolution/effectiveRuntimeRegistryContext';
import {AnalysisContextAuthorizationChangedError} from '../services/resolvedAnalysisContext';
import type {SkillRegistryView} from '../services/skillEngine/skillAnalysisAdapter';
import type {SkillExecutor} from '../services/skillEngine/skillExecutor';
import type {TraceProcessorService} from '../services/traceProcessorService';
import type {ProcessIdentityResolution} from '../services/processIdentity/types';
import type {IdentityResolutionV1} from '../types/identityContract';
import {
  ENTRY_SKILL_END_BINDINGS,
  ENTRY_SKILL_PROCESS_BINDINGS,
  ENTRY_SKILL_START_BINDINGS,
  type EntrySkillBinding,
  type SceneEntryNotRunReason,
  type StrategyEntrySkill,
} from '../types/sceneEntryEvidence';
import type {AnalysisTurnIntent} from './analysisTurnIntent';
import type {FocusAppTarget} from './focusAppTarget';
import type {RunAuthorizationCheck} from './runAuthorizationFence';
import type {RuntimePerformanceRecorder, RuntimePerformanceRun} from './runtimePerformance';
import {runWithinRuntimeToolInvocation} from './runtimeToolInvocationContext';
import {createRuntimeToolResult} from './runtimeToolResult';
import {withRunAuthorizationOnly, type RuntimeToolResult, type SharedToolSpec} from './runtimeToolSpec';
import type {RuntimeTurnPolicy} from './runtimeTurnPolicy';

/** Total hard limit of one attempt, from its start to settling. */
export const SCENE_ENTRY_TIMEOUT_MS = 20_000;
/** Overview cells in the prompt segment, key cells first. */
export const SCENE_EVIDENCE_MAX_CELLS = 24;
/** UTF-8 bytes of the segment's JSON data. */
export const SCENE_EVIDENCE_MAX_BYTES = 2048;
const MAX_CANDIDATES = 5;

/** `invoke_skill`'s registration: the request scope must admit it for the product to acquire. */
export const ENTRY_SKILL_TOOL_ACCESS = {exposure: 'public', evidenceEffect: 'acquire'} as const;

export interface SceneEntryEvidenceInput {
  /** The run id the MCP registry would bind; observations and captures join under it. */
  runId?: string;
  traceId: string;
  turnIntent: AnalysisTurnIntent;
  policy: Pick<RuntimeTurnPolicy, 'allowNewEvidence'>;
  strategyRegistry: ReadonlyStrategyRegistrySnapshot;
  skillRegistry: SkillRegistryView;
  skillExecutor: SkillExecutor;
  traceProcessorService: TraceProcessorService;
  artifactStore: ArtifactStore;
  focusTarget: FocusAppTarget;
  /** The package the user named for this run, if any. */
  userPackageName?: string;
  selectionContext?: SelectionContext;
  outputLanguage: OutputLanguage;
  canInvokeTool?: () => boolean;
  executionLease?: {readonly signal: AbortSignal};
  runAuthorization?: Pick<RunAuthorizationCheck, 'assertCurrentInTurn' | 'settled'>;
  runtimePerformance?: Pick<RuntimePerformanceRun, 'startPhase' | 'recordSceneEvidence'>;
  /** Absolute run deadline (epoch ms), when the runtime has one. */
  deadlineMs?: number;
  timeoutMs?: number;
}

export interface SceneEvidenceCandidate {
  processName?: string;
  packageName?: string;
  upid?: number;
  confidence?: number;
}

export interface SceneEvidenceArtifact {
  artifactId: string;
  evidenceRefId: string;
  stepId: string;
  rowCount: number;
}

export interface SceneEvidenceCell {
  artifactId: string;
  rowIndex: number;
  column: string;
  value: unknown;
  unit?: string;
}

export interface SceneEntryEvidenceOutcome {
  status: 'ran' | 'not_run';
  reason?: SceneEntryNotRunReason;
  skillId?: string;
  /** The verified target the Skill ran for. */
  identity?: {packageName?: string; processName?: string; upid?: number};
  candidates?: SceneEvidenceCandidate[];
  /** Overview artifacts, in display order. */
  artifacts: SceneEvidenceArtifact[];
  /** Every artifact the run wrote; ids are contiguous because the commit is synchronous. */
  artifactIdRange?: {first: string; last: string};
  keyCells: SceneEvidenceCell[];
  summaryCells: SceneEvidenceCell[];
  artifactCount: number;
  captureCount: number;
  durationMs: number;
}

/** What the `scene_evidence` segment carries; JSON, at most SCENE_EVIDENCE_MAX_BYTES. */
export interface SceneEvidencePromptData {
  status: 'ran' | 'not_run';
  skillId: string;
  reason?: SceneEntryNotRunReason;
  identity?: SceneEntryEvidenceOutcome['identity'];
  candidates?: SceneEvidenceCandidate[];
  artifactIdRange?: {first: string; last: string};
  artifacts?: SceneEvidenceArtifact[];
  omittedArtifactCount?: number;
  /** Cells as tuples in `fields` order; `key` cells before `summary` cells. */
  cells?: {fields: typeof SCENE_EVIDENCE_CELL_FIELDS; key: SceneEvidenceCellTuple[]; summary: SceneEvidenceCellTuple[]};
  omittedCellCount?: number;
}

export const SCENE_EVIDENCE_CELL_FIELDS = ['artifactId', 'rowIndex', 'column', 'value', 'unit'] as const;
export type SceneEvidenceCellTuple = [string, number, string, unknown, string | null];

/** Reasons the model never needs to hear about: nothing was declared or asked for. */
const SILENT_REASONS: ReadonlySet<SceneEntryNotRunReason> =
  new Set(['no_entry_skill', 'not_scene_wide', 'comparison_turn', 'existing_only']);

function emptyOutcome(status: 'ran' | 'not_run', extra: Partial<SceneEntryEvidenceOutcome> = {}): SceneEntryEvidenceOutcome {
  return {status, artifacts: [], keyCells: [], summaryCells: [], artifactCount: 0,
    captureCount: 0, durationMs: 0, ...extra};
}

function candidatesOf(resolution: ProcessIdentityResolution | undefined): SceneEvidenceCandidate[] | undefined {
  const candidates = (resolution?.candidates ?? []).slice(0, MAX_CANDIDATES).map(candidate => ({
    ...(candidate.processName ? {processName: candidate.processName} : {}),
    ...(candidate.canonicalPackageName ?? candidate.packageName
      ? {packageName: candidate.canonicalPackageName ?? candidate.packageName} : {}),
    ...(candidate.upid !== undefined ? {upid: candidate.upid} : {}),
    ...(Number.isFinite(candidate.confidenceScore) ? {confidence: candidate.confidenceScore} : {}),
  }));
  return candidates.length ? candidates : undefined;
}

/**
 * The gate's decision as one of the closed reasons, or undefined when the run
 * may proceed. A bound process runs only once the gate verified it; an unbound
 * Skill the gate had nothing to check runs as the model's call would.
 */
function identityRefusal(identity: IdentityResolutionV1 | undefined, processBound: boolean): SceneEntryNotRunReason | undefined {
  if (identity?.status === 'verified') return undefined;
  if (!identity || identity.status === 'not_required') return processBound ? 'target_unresolved' : undefined;
  return identity.status === 'ambiguous' || identity.status === 'weak' ? 'identity_ambiguous' : 'target_unresolved';
}

/** Resolve the declared bindings for this run; undefined means the target is unknown. */
function boundParams(entry: StrategyEntrySkill, input: SceneEntryEvidenceInput):
  {params: Record<string, string>; processBound: boolean} | undefined {
  const params: Record<string, string> = {};
  let processBound = false;
  const area = input.selectionContext?.kind === 'area' ? input.selectionContext : undefined;
  for (const [name, binding] of Object.entries(entry.params) as Array<[string, EntrySkillBinding]>) {
    if (ENTRY_SKILL_PROCESS_BINDINGS.includes(binding)) {
      const target = input.focusTarget;
      const packageName = binding === 'user_target'
        ? input.userPackageName?.trim()
        // The same threshold that makes a detection citable (registerFocusAppEvidence).
        : target.packageName && (target.source === 'user' || target.confidence === 'high' || target.confidence === 'medium')
          ? target.packageName : undefined;
      if (!packageName) return undefined;
      params[name] = packageName;
      processBound = true;
    } else if (ENTRY_SKILL_START_BINDINGS.includes(binding)) {
      // A trace bound is the Skill's own default; a selection bound needs an area selection.
      if (binding === 'selection_start' && area) params[name] = String(area.startNs);
    } else if (ENTRY_SKILL_END_BINDINGS.includes(binding)) {
      if (binding === 'selection_end' && area) params[name] = String(area.endNs);
    }
  }
  return {params, processBound};
}

function refusalReason(refusal: SkillRunRefusal): SceneEntryNotRunReason {
  switch (refusal.kind) {
    case 'process_selector_required': return 'target_unresolved';
    case 'identity_gate': return identityRefusal(refusal.identityResolution, false) ?? 'capability_missing';
    default: return 'capability_missing';
  }
}

type AttemptResult =
  | {kind: 'not_run'; reason: SceneEntryNotRunReason; candidates?: SceneEvidenceCandidate[]}
  | {kind: 'executed'; outcome: SkillRunOutcome; identity?: IdentityResolutionV1};

/** Overview locators and cells of a committed run, in display order. */
function collectOverview(outcome: Extract<SkillRunOutcome, {status: 'committed'}>):
  Pick<SceneEntryEvidenceOutcome, 'artifacts' | 'artifactIdRange' | 'keyCells' | 'summaryCells'> {
  const artifacts: SceneEvidenceArtifact[] = [];
  const keyCells: SceneEvidenceCell[] = [];
  const summaryCells: SceneEvidenceCell[] = [];
  const written = [...outcome.artifactIdsByDisplayIndex, outcome.diagnosticsArtifactId,
    ...(outcome.synthesizeArtifacts ?? []).map(artifact => artifact.artifactId)]
    .filter((id): id is string => typeof id === 'string')
    .map(id => ({id, ordinal: Number(/^art-(\d+)$/.exec(id)?.[1])}))
    .filter(entry => Number.isSafeInteger(entry.ordinal))
    .sort((left, right) => left.ordinal - right.ordinal);
  (outcome.result.displayResults ?? []).forEach((display, index) => {
    const artifactId = outcome.artifactIdsByDisplayIndex[index];
    const evidenceRefId = outcome.evidenceRefIdsByDisplayIndex[index];
    if (!artifactId || !evidenceRefId) return;
    if (display.layer !== 'overview') return;
    const projection = outcome.modelDisplayProjections[index];
    const data = projection?.data as {columns?: unknown; rows?: unknown} | undefined;
    const columns = Array.isArray(data?.columns) ? data!.columns as unknown[] : [];
    const rows = Array.isArray(data?.rows) && (data!.rows as unknown[]).every(Array.isArray) ? data!.rows as unknown[][] : [];
    artifacts.push({artifactId, evidenceRefId, stepId: display.stepId, rowCount: rows.length});
    const target = display.level === 'key' ? keyCells : display.level === 'summary' ? summaryCells : undefined;
    if (!target || projection?.modelProjection.status === 'unavailable') return;
    rows.forEach((row, rowIndex) => columns.forEach((column, columnIndex) => {
      if (typeof column !== 'string') return;
      const unit = projection?.columnUnits?.[column];
      target.push({artifactId, rowIndex, column, value: row[columnIndex] ?? null, ...(unit ? {unit} : {})});
    }));
  });
  return {artifacts, keyCells, summaryCells,
    ...(written.length ? {artifactIdRange: {first: written[0].id, last: written[written.length - 1].id}} : {})};
}

/**
 * Run the strategy's entry Skill for a scene-wide investigation, or say why
 * not. Throws only `AnalysisContextAuthorizationChangedError`, after recording
 * the receipt, so a revoked run ends with the fence's own error.
 */
export async function acquireSceneEntryEvidence(input: SceneEntryEvidenceInput): Promise<SceneEntryEvidenceOutcome> {
  const intent = input.turnIntent;
  const entry = intent.status === 'resolved' ? input.strategyRegistry.getStrategy(intent.sceneId)?.entrySkill : undefined;
  if (!entry) return emptyOutcome('not_run', {reason: 'no_entry_skill'});
  const startedAt = Date.now();
  const finish = (outcome: SceneEntryEvidenceOutcome): SceneEntryEvidenceOutcome => {
    const final = {...outcome, skillId: entry.id, durationMs: Date.now() - startedAt};
    input.runtimePerformance?.recordSceneEvidence({
      skillId: entry.id, status: final.status, ...(final.status === 'not_run' ? {reason: final.reason} : {}),
      durationMs: final.durationMs, artifactCount: final.artifactCount, captureCount: final.captureCount,
    });
    return final;
  };
  const notRun = (reason: SceneEntryNotRunReason, extra: Partial<SceneEntryEvidenceOutcome> = {}) =>
    finish(emptyOutcome('not_run', {reason, ...extra}));

  // 1. Request scope, decided as the registry decides it for invoke_skill.
  if (intent.scope !== 'scene_wide') return notRun('not_scene_wide');
  // The entry Skill reads the current trace only; a comparison reads both sides
  // through its own tools, and its prompt has no budget for one-sided overview cells.
  if (intent.taskKind === 'comparison') return notRun('comparison_turn');
  if (intent.evidenceAccess !== 'read_new' || !isToolAllowedForScope(ENTRY_SKILL_TOOL_ACCESS,
    {sessionId: '', hasCodebaseAccess: false, allowNewEvidence: input.policy.allowNewEvidence})) {
    return notRun('existing_only');
  }
  const phase = input.runtimePerformance?.startPhase('scene_evidence');
  let phaseOutcome: 'ok' | 'error' | 'cancelled' = 'ok';
  try {
    // 2. A closed run acquires nothing.
    let open: boolean;
    try { open = input.canInvokeTool?.() !== false; } catch { open = false; }
    if (!open) return notRun('acquisition_closed');
    // 3. The run's lease and deadline.
    // A runtime without a run deadline passes none (or 0); only a real epoch time bounds it.
    const remainingMs = input.deadlineMs && input.deadlineMs > 0 ? input.deadlineMs - Date.now() : Infinity;
    if (input.executionLease?.signal.aborted || remainingMs <= 0) {
      phaseOutcome = 'cancelled';
      return notRun('cancelled');
    }
    if (entrySkillExecutabilityErrors(entry, input.skillRegistry.getSkill(entry.id)).length) {
      return notRun('capability_missing');
    }
    const bound = boundParams(entry, input);
    if (!bound) return notRun('target_unresolved');

    const deps = {
      traceId: input.traceId, traceProcessorService: input.traceProcessorService, skillExecutor: input.skillExecutor,
      artifactStore: input.artifactStore, outputLanguage: input.outputLanguage,
      packageName: input.focusTarget.packageName, focusTarget: input.focusTarget,
    };
    const requested = {skillId: entry.id, params: bound.params};
    const toolCallId = `scene-entry:${entry.id}:${summarizeToolCallInput('invoke_skill', requested).paramsHash || evidenceHash(requested)}`;
    // One deadline for the attempt: the run's lease, the run deadline and the hard limit.
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); },
      Math.max(0, Math.min(input.timeoutMs ?? SCENE_ENTRY_TIMEOUT_MS, remainingMs)));
    const onLeaseAbort = () => controller.abort();
    input.executionLease?.signal.addEventListener('abort', onLeaseAbort, {once: true});
    let observed = false;
    let revokedError: AnalysisContextAuthorizationChangedError | undefined;
    const observe = (phaseName: 'started' | 'completed' | 'failed', result?: RuntimeToolResult) => {
      const base = {toolCallId, toolName: 'scene_entry_evidence', params: requested, extra: {toolCallId}};
      input.artifactStore.observeInvestigationTool(
        phaseName === 'completed' ? {...base, phase: 'completed', result: result!}
          : phaseName === 'failed' ? {...base, phase: 'failed', error: new Error('scene_entry_evidence_failed')}
            : {...base, phase: 'started'},
        input.runId);
    };
    // 6. Checked inside the core after the Skill returned and before any write.
    const beforeCommit = (): SkillRunCommitRefusal | undefined => {
      if (controller.signal.aborted) return 'cancelled';
      try {
        input.runAuthorization?.assertCurrentInTurn();
      } catch (error) {
        if (error instanceof AnalysisContextAuthorizationChangedError) revokedError = error;
        return 'authorization_revoked';
      }
      return undefined;
    };
    let attempt: AttemptResult | undefined;
    const attemptSpec: SharedToolSpec = {
      name: 'scene_entry_evidence', description: 'scene entry evidence', exposure: 'internal', inputSchema: {},
      handler: async () => {
        attempt = await runWithinRuntimeToolInvocation({toolCallId, ...(input.runId ? {runId: input.runId} : {})}, async () => {
          const preparation = await prepareSkillRun(deps,
            {skillId: entry.id, params: bound.params, registry: input.skillRegistry, signal: controller.signal});
          if (preparation.status === 'refused') {
            const gate = preparation.refusal.kind === 'identity_gate' ? preparation.refusal.gate : undefined;
            return {kind: 'not_run', reason: refusalReason(preparation.refusal), candidates: candidatesOf(gate?.resolution)};
          }
          const {prepared} = preparation;
          const identityReason = identityRefusal(prepared.identityResolution, bound.processBound);
          if (identityReason) return {kind: 'not_run', reason: identityReason, candidates: candidatesOf(prepared.gate.resolution)};
          if (controller.signal.aborted) return {kind: 'not_run', reason: timedOut ? 'timeout' : 'cancelled'};
          const paramsHash = summarizeToolCallInput('invoke_skill', {skillId: entry.id, params: prepared.effectiveParams,
            ...(prepared.paramResolution.audit ? {drillDownResolution: prepared.paramResolution.audit} : {})}).paramsHash;
          observe('started');
          observed = true;
          const outcome = await executePreparedSkillRun(deps, prepared, {
            signal: controller.signal, beforeCommit,
            producer: {
              sourceToolCallId: toolCallId, paramsHash, planPhaseAttribution: 'none',
              producerReason: localize(input.outputLanguage,
                `场景入口 Skill ${entry.id}：模型首轮前由产品采集的场景证据。`,
                `Scene entry Skill ${entry.id}: scene evidence the product collected before the model's first turn.`),
            },
          });
          return {kind: 'executed', outcome, identity: prepared.identityResolution};
        });
        return createRuntimeToolResult({success: true});
      },
    };
    // 4. The run authorization fence, auth-only: no tool timing, no tool record.
    const guarded = input.runAuthorization ? withRunAuthorizationOnly(attemptSpec, input.runAuthorization) : attemptSpec;
    const work = guarded.handler({}, {toolCallId}).then(() => 'settled' as const);
    work.catch(() => undefined);
    // 5. Settle within the attempt's deadline; a late Skill finds the signal aborted and writes nothing.
    const aborted = new Promise<'aborted'>(resolve => {
      if (controller.signal.aborted) resolve('aborted');
      else controller.signal.addEventListener('abort', () => resolve('aborted'), {once: true});
    });
    let settled: 'settled' | 'aborted';
    try {
      settled = await Promise.race([work, aborted]);
    } catch (error) {
      if (observed) observe('failed');
      if (error instanceof AnalysisContextAuthorizationChangedError || revokedError) {
        notRun('authorization_revoked');
        phaseOutcome = 'cancelled';
        throw revokedError ?? error;
      }
      phaseOutcome = controller.signal.aborted ? 'cancelled' : 'error';
      return notRun(timedOut ? 'timeout' : controller.signal.aborted ? 'cancelled' : 'failed');
    } finally {
      clearTimeout(timer);
      input.executionLease?.signal.removeEventListener('abort', onLeaseAbort);
    }
    const result = attempt as AttemptResult | undefined;
    if (settled === 'aborted' && result?.kind !== 'executed' || !result) {
      if (observed) observe('failed');
      phaseOutcome = 'cancelled';
      return notRun(timedOut ? 'timeout' : 'cancelled');
    }
    if (result.kind === 'not_run') {
      if (observed) observe('failed');
      return notRun(result.reason, result.candidates ? {candidates: result.candidates} : {});
    }
    const {outcome} = result;
    if (outcome.status === 'commit_refused') {
      observe('failed');
      phaseOutcome = 'cancelled';
      if (revokedError) {
        notRun('authorization_revoked');
        throw revokedError;
      }
      return notRun(outcome.reason === 'authorization_revoked' ? 'authorization_revoked' : timedOut ? 'timeout' : 'cancelled');
    }
    observe('completed', createRuntimeToolResult({success: outcome.result.success}));
    const artifactCount = outcome.artifactIdsByDisplayIndex.filter(Boolean).length
      + (outcome.diagnosticsArtifactId ? 1 : 0) + (outcome.synthesizeArtifacts?.length ?? 0);
    const counts = {artifactCount, captureCount: outcome.captureCount};
    if (!outcome.result.success) {
      phaseOutcome = 'error';
      return notRun('failed', counts);
    }
    const target = result.identity?.target;
    const process = result.identity?.processes?.[0];
    return finish({
      ...emptyOutcome('ran'),
      ...collectOverview(outcome),
      ...counts,
      ...(result.identity ? {identity: {
        ...(target?.packageName ? {packageName: target.packageName} : {}),
        ...(target?.processName ? {processName: target.processName} : {}),
        ...(process?.upid !== undefined ? {upid: process.upid} : {}),
      }} : {}),
    });
  } finally {
    phase?.end(phaseOutcome);
  }
}

function byteLength(data: SceneEvidencePromptData): number {
  return Buffer.byteLength(JSON.stringify({context: 'scene_evidence', data}), 'utf8');
}

/**
 * The prompt segment's data: ① status (and candidates), ② overview artifact
 * locators, ③ `key` cells, ④ `summary` cells. Bounded to SCENE_EVIDENCE_MAX_CELLS
 * cells and SCENE_EVIDENCE_MAX_BYTES; over either it drops ④ then ③ from the
 * end, keeping ① and ②, and only then the trailing locators. Undefined when the
 * run declared nothing or asked for nothing the model needs to know about.
 */
export function buildSceneEvidencePromptData(outcome: SceneEntryEvidenceOutcome | undefined): SceneEvidencePromptData | undefined {
  if (!outcome?.skillId || (outcome.reason && SILENT_REASONS.has(outcome.reason))) return undefined;
  if (outcome.status === 'not_run') {
    return {status: 'not_run', skillId: outcome.skillId, reason: outcome.reason,
      ...(outcome.candidates?.length ? {candidates: outcome.candidates} : {})};
  }
  const tuple = (cell: SceneEvidenceCell): SceneEvidenceCellTuple =>
    [cell.artifactId, cell.rowIndex, cell.column, cell.value, cell.unit ?? null];
  const total = outcome.keyCells.length + outcome.summaryCells.length;
  let key = outcome.keyCells.slice(0, SCENE_EVIDENCE_MAX_CELLS).map(tuple);
  let summary = outcome.summaryCells.slice(0, SCENE_EVIDENCE_MAX_CELLS - key.length).map(tuple);
  let artifacts = [...outcome.artifacts];
  const build = (): SceneEvidencePromptData => ({
    status: 'ran', skillId: outcome.skillId!,
    ...(outcome.identity ? {identity: outcome.identity} : {}),
    ...(outcome.artifactIdRange ? {artifactIdRange: outcome.artifactIdRange} : {}),
    artifacts,
    ...(outcome.artifacts.length > artifacts.length ? {omittedArtifactCount: outcome.artifacts.length - artifacts.length} : {}),
    ...(key.length + summary.length ? {cells: {fields: SCENE_EVIDENCE_CELL_FIELDS, key, summary}} : {}),
    ...(total > key.length + summary.length ? {omittedCellCount: total - key.length - summary.length} : {}),
  });
  while (summary.length && byteLength(build()) > SCENE_EVIDENCE_MAX_BYTES) summary = summary.slice(0, -1);
  while (key.length && byteLength(build()) > SCENE_EVIDENCE_MAX_BYTES) key = key.slice(0, -1);
  while (artifacts.length && byteLength(build()) > SCENE_EVIDENCE_MAX_BYTES) artifacts = artifacts.slice(0, -1);
  return build();
}

/** The run's scene evidence, as each runtime's preflight hands it to its prompt. */
export async function collectSceneEvidenceForPrompt(
  input: SceneEntryEvidenceInput,
): Promise<SceneEvidencePromptData | undefined> {
  return buildSceneEvidencePromptData(await acquireSceneEntryEvidence(input));
}

/**
 * Phase and receipt recording straight on the run's recorder, for a runtime
 * whose preparation holds the attribution sink but not its RuntimePerformanceRun.
 * Observability never throws into the run.
 */
export function scenePerformanceFromSink(
  sink: {readonly runtimePerformanceRecorder?: RuntimePerformanceRecorder} | undefined,
): SceneEntryEvidenceInput['runtimePerformance'] {
  const recorder = sink?.runtimePerformanceRecorder;
  if (!recorder) return undefined;
  return {
    startPhase: name => {
      try {
        const span = recorder.startPhase(name);
        return {end: outcome => { try { span.end(outcome); } catch { /* Internal observability only. */ } }};
      } catch {
        return {end: () => undefined};
      }
    },
    recordSceneEvidence: receipt => {
      try { recorder.recordSceneEvidence(receipt); } catch { /* Internal observability only. */ }
    },
  };
}
