// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * The structured core of one current-trace Skill run, shared by the model's
 * `invoke_skill` and the product's scene entry evidence: parameter
 * normalization, the process identity gate, execution, and the artifact,
 * evidence capture and query review writes. It returns structured, unlocalized
 * results; previews, localization, notes, vendor hints and SSE envelopes stay
 * with each caller. Both callers produce the same evidence locators, artifacts,
 * captures and query reviews for the same Skill, parameters and producer hash.
 */

import {createHash} from 'crypto';

import {findDrillDownSkillConfig} from '../agent/config/drillDownRegistry';
import {
  resolveRegisteredDrillDownSkillParams,
  type DrillDownSkillParamResolution,
} from '../agent/core/drillDownEntityResolver';
import {packageProvenance, type FocusAppTarget} from '../agentRuntime/focusAppTarget';
import {captureEvidenceTable, evidenceTableFor, projectEvidenceTableForModel} from '../services/evidence/evidenceCapture';
import {buildIdentityResolutionFromProcessGate} from '../services/processIdentity/identityContractMapper';
import type {IdentityGateResult} from '../services/processIdentity/identityGate';
import {getConsumableProcessIdentitySelectors} from '../services/processIdentity/identityGate';
import {hasProcessIdentitySelector, PROCESS_IDENTITY_SELECTORS} from '../services/processIdentity/types';
import {buildSkillQueryReview} from '../services/queryReview/skillQueryReviewBuilder';
import type {SkillRegistryView} from '../services/skillEngine/skillAnalysisAdapter';
import type {SkillExecutor} from '../services/skillEngine/skillExecutor';
import type {DisplayResult as SkillDisplayResult, SkillDefinition, SkillExecutionResult} from '../services/skillEngine/types';
import {
  buildTraceProcessorQueryProvenance,
  type TraceProcessorPaneSide,
  type TraceProcessorQueryProvenance,
} from '../services/traceProcessorConnectionModel';
import type {TraceProcessorService} from '../services/traceProcessorService';
import type {DataEnvelopeMeta} from '../types/dataContract';
import {
  identityForScopeEvidence,
  mergeScopeProvenance,
  type EvidenceScopeProvenanceV1,
  type IdentityResolutionV1,
} from '../types/identityContract';
import type {QueryReviewV1} from '../types/queryReviewContract';
import type {ArtifactStore} from './artifactStore';
import {skillRequiresProcessSelector} from './entrySkillPolicy';
import type {OutputLanguage} from './outputLanguage';

export {skillRequiresProcessSelector} from './entrySkillPolicy';

/** Who produced a piece of evidence: the call, its parameters and its plan attribution. */
export interface EvidenceProducerContext {
  sourceToolCallId?: string;
  paramsHash?: string;
  planPhaseId?: string;
  planPhaseTitle?: string;
  planPhaseGoal?: string;
  planPhaseAttribution?: 'active' | 'inferred' | 'missing' | 'ambiguous' | 'unexpected_tool' | 'none';
  planPhaseWarning?: string;
  toolNarration?: string;
  producerReason?: string;
}

export function evidenceHash(input: unknown): string {
  const text = typeof input === 'string'
    ? input
    : JSON.stringify(input, (_key, value) => typeof value === 'bigint' ? value.toString() : value);
  return createHash('sha256').update(text || '').digest('hex').slice(0, 12);
}

export function evidencePart(value: unknown, fallback = 'unknown'): string {
  const text = String(value ?? fallback)
    .trim()
    .replace(/[^a-zA-Z0-9_.-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
  return text || fallback;
}

export function evidenceTracePart(traceProvenance?: TraceProcessorQueryProvenance): string {
  if (!traceProvenance) return 'trace_unknown';
  const side = evidencePart(traceProvenance.traceSide || 'current', 'current');
  const trace = evidenceHash(traceProvenance.traceId);
  return `${side}:${trace}`;
}

export function stableSkillEvidenceRefId(
  skillId: string,
  stepId: string | undefined,
  title: string | undefined,
  data: unknown,
  traceProvenance?: TraceProcessorQueryProvenance,
  producer?: EvidenceProducerContext,
  scopeProvenance?: EvidenceScopeProvenanceV1,
): string {
  const dataHash = evidenceHash({
    title,
    data,
    scopeProvenance,
  });
  const toolPart = evidencePart(producer?.paramsHash || 'tool', 'tool');
  return `data:skill:${evidencePart(skillId, 'skill')}:${evidencePart(stepId || title, 'step')}:${evidenceTracePart(traceProvenance)}:${dataHash}:${toolPart}`;
}

/**
 * Normalize synthesizeData entries into columnar format for artifact storage.
 *
 * synthesizeData entries can be:
 *   - Array of objects: [{ col1: val1, col2: val2 }, ...]
 *   - Already columnar: { columns: [...], rows: [[...], ...] }
 *   - Iterator results: [{ itemIndex, item, result: { ... } }]
 *   - Single object: { key: value, ... }
 * All are normalized to { columns: string[], rows: any[][] } for ArtifactStore.
 */
export function normalizeSynthesizeDataForStorage(data: any): { columns: string[]; rows: any[][] } {
  if (!data) return { columns: [], rows: [] };

  // Already columnar format
  if (data.columns && Array.isArray(data.rows)) {
    return { columns: data.columns, rows: data.rows };
  }

  // An empty array is zero rows, not a single empty object row.
  if (Array.isArray(data) && data.length === 0) return { columns: [], rows: [] };

  // Array of objects
  if (Array.isArray(data)) {
    const first = data[0];
    // Iterator format: flatten item + result
    if (first && typeof first === 'object' && 'itemIndex' in first && 'result' in first) {
      const allKeys = new Set<string>();
      const flatRows = data.map((entry: any) => {
        const flat: Record<string, any> = { itemIndex: entry.itemIndex };
        // Merge item fields
        if (entry.item && typeof entry.item === 'object') {
          for (const [k, v] of Object.entries(entry.item)) {
            flat[k] = v;
            allKeys.add(k);
          }
        }
        // Merge result fields (top-level scalars only, skip nested objects)
        if (entry.result && typeof entry.result === 'object') {
          for (const [k, v] of Object.entries(entry.result)) {
            if (typeof v !== 'object' || v === null) {
              flat[`result_${k}`] = v;
              allKeys.add(`result_${k}`);
            }
          }
        }
        allKeys.add('itemIndex');
        return flat;
      });
      const columns = ['itemIndex', ...Array.from(allKeys).filter(k => k !== 'itemIndex')];
      const rows = flatRows.map((row: Record<string, any>) => columns.map(c => row[c] ?? null));
      return { columns, rows };
    }

    // Plain array of objects
    if (typeof first === 'object' && first !== null) {
      const columns = Object.keys(first);
      const rows = data.map((row: Record<string, any>) => columns.map(c => row[c] ?? null));
      return { columns, rows };
    }

    // Array of primitives — single column
    return { columns: ['value'], rows: data.map((v: any) => [v]) };
  }

  // Single object → single row
  if (typeof data === 'object' && data !== null) {
    const columns = Object.keys(data);
    const rows = [columns.map(c => data[c] ?? null)];
    return { columns, rows };
  }

  // Scalar
  return { columns: ['value'], rows: [[data]] };
}

const TIMESTAMP_EXPRESSION_PARAM_KEYS = new Set([
  'ts',
  'start_ts',
  'end_ts',
  'frame_ts',
  'startTs',
  'endTs',
  'frameTs',
]);

function normalizeTimestampExpression(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  const match = trimmed.match(/^(\d{6,})([+-])(\d{1,15})$/);
  if (!match) return value;
  try {
    const left = BigInt(match[1]);
    const right = BigInt(match[3]);
    const result = match[2] === '+' ? left + right : left - right;
    return result.toString();
  } catch {
    return value;
  }
}

export function skillAcceptsProcessIdentity(skill?: SkillDefinition): boolean {
  return !skill || [...getConsumableProcessIdentitySelectors(skill)]
    .some(key => key === 'process_name' || key === 'package');
}

/** Normalize skill params while respecting the target Skill's declared inputs. */
export function normalizeSkillRunParams(
  params: Record<string, any> | undefined,
  defaultPackage?: string,
  skill?: SkillDefinition,
): Record<string, any> {
  const p = { ...params };
  for (const key of Object.keys(p)) {
    if (TIMESTAMP_EXPRESSION_PARAM_KEYS.has(key)) {
      p[key] = normalizeTimestampExpression(p[key]);
    }
  }
  const declaredNames = new Set((skill?.inputs ?? []).map(input => input.name));
  const acceptsProcessIdentity = skillAcceptsProcessIdentity(skill);
  if (acceptsProcessIdentity && defaultPackage && !hasProcessIdentitySelector(p)) {
    p[declaredNames.has('process_name') && !declaredNames.has('package') ? 'process_name' : 'package'] = defaultPackage;
  }
  return p;
}

export function undeclaredSkillRunParams(
  skill: SkillDefinition,
  params: Record<string, any> | undefined,
  beforeEnrichment = false,
): string[] {
  if (!params) return [];
  const reserved = Object.keys(params).filter(key => key === '__process_scope' || key.startsWith('__process_scope.'));
  const selectors = getConsumableProcessIdentitySelectors(skill);
  const allowed = new Set([...(skill.inputs || []).map(input => input.name), ...selectors]);
  if (beforeEnrichment) {
    const registered = findDrillDownSkillConfig(skill.name);
    if (registered?.dropEntityParamAfterResolution) {
      for (const [key, source] of Object.entries(registered.paramMapping)) {
        if (source === `${registered.entityType}Id`) allowed.add(key);
      }
    }
  }
  // Legacy definitions without input schemas remain open for ordinary params,
  // but identity selectors still need a declared consumer.
  return [...new Set([...reserved, ...Object.keys(params).filter(key =>
    !allowed.has(key) && (Boolean(skill.inputs) || PROCESS_IDENTITY_SELECTORS.includes(key)))])].sort();
}

export type AppliedDefaultProcessField =
  {appliedDefaultProcess?: {packageName: string; source: string; confidence?: string} | null};

/**
 * How the process scope of a Skill call was chosen, reported with its result
 * so an unscoped or default-scoped run is never read as user-targeted:
 * the injected effective package with its provenance, or null when the Skill
 * accepts a process but runs unscoped. A caller-supplied selector needs no note.
 */
export function appliedDefaultProcessField(
  params: Record<string, any> | undefined,
  normalized: Record<string, any>,
  skill: SkillDefinition | undefined,
  packageName: string | undefined,
  focusTarget: FocusAppTarget | undefined,
): AppliedDefaultProcessField {
  if (!skillAcceptsProcessIdentity(skill) || hasProcessIdentitySelector(params)) return {};
  if (!hasProcessIdentitySelector(normalized) || !packageName) return {appliedDefaultProcess: null};
  const {source = 'user', confidence} = packageProvenance(packageName, focusTarget);
  return {appliedDefaultProcess: {packageName, source, ...(confidence ? {confidence} : {})}};
}

/** What one run's current trace supplies to a Skill run. */
export interface SkillRunDeps {
  traceId: string;
  traceProcessorService: TraceProcessorService;
  skillExecutor: SkillExecutor;
  artifactStore?: ArtifactStore;
  outputLanguage: OutputLanguage;
  /** The run's effective package, injected when the call names no process. */
  packageName?: string;
  focusTarget?: FocusAppTarget;
  /** Comparison pane of the current trace, when the run has one. */
  paneSide?: TraceProcessorPaneSide;
}

/** Why the core refused before running anything; each caller renders its own response. */
export type SkillRunRefusal =
  | {kind: 'unavailable'}
  | {kind: 'metadata_only'; skillType: 'pipeline_definition' | 'comparison'}
  | {kind: 'undeclared_params'; invalidParams: string[]}
  | {kind: 'process_selector_required'}
  | {kind: 'identity_gate'; error?: string; gate: IdentityGateResult; identityResolution?: IdentityResolutionV1}
  | {kind: 'undeclared_params_after_resolution'; invalidParams: string[]};

export interface PreparedSkillRun {
  skillId: string;
  skillDef: SkillDefinition;
  /** Parameters the Skill runs with: normalized, gate-rewritten and drill-down resolved. */
  effectiveParams: Record<string, any>;
  gate: IdentityGateResult;
  /** The gate's identity decision; undefined when the Skill names no process. */
  identityResolution?: IdentityResolutionV1;
  paramResolution: DrillDownSkillParamResolution;
  defaultProcessField: AppliedDefaultProcessField;
}

export type SkillRunPreparation =
  | {status: 'refused'; refusal: SkillRunRefusal}
  | {status: 'ready'; prepared: PreparedSkillRun};

/**
 * Resolve the Skill and its parameters through the same checks and identity
 * gate a model call passes. Nothing runs and nothing is written here.
 */
export async function prepareSkillRun(
  deps: SkillRunDeps,
  input: {skillId: string; params?: Record<string, any>; registry: SkillRegistryView; signal?: AbortSignal},
): Promise<SkillRunPreparation> {
  const {skillId, params, signal} = input;
  const skillDef = input.registry.getSkill(skillId);
  if (!skillDef) return {status: 'refused', refusal: {kind: 'unavailable'}};
  if (skillDef.type === 'pipeline_definition' || skillDef.type === 'comparison') {
    return {status: 'refused', refusal: {kind: 'metadata_only', skillType: skillDef.type}};
  }
  const normalizedParams = normalizeSkillRunParams(params, deps.packageName, skillDef);
  const explicitInvalidParams = undeclaredSkillRunParams(skillDef, params, true);
  if (explicitInvalidParams.length) {
    return {status: 'refused', refusal: {kind: 'undeclared_params', invalidParams: explicitInvalidParams}};
  }
  // No package is in effect (none named, focus ambiguous or undetected): a
  // Skill that must name its process gets candidates instead of a guess.
  if (skillRequiresProcessSelector(skillDef) && !hasProcessIdentitySelector(normalizedParams)) {
    return {status: 'refused', refusal: {kind: 'process_selector_required'}};
  }
  const defaultProcessField = appliedDefaultProcessField(params, normalizedParams, skillDef, deps.packageName, deps.focusTarget);
  const gate = await deps.skillExecutor.prepareInvocation(skillId, deps.traceId, normalizedParams,
    {__traceSide: 'current', __outputLanguage: deps.outputLanguage, signal});
  const identityResolution = buildIdentityResolutionFromProcessGate({
    traceId: deps.traceId, traceSide: 'current', target: gate.target, resolution: gate.resolution,
  });
  if (!gate.allowed) {
    return {status: 'refused', refusal: {kind: 'identity_gate', error: gate.error, gate,
      ...(identityResolution ? {identityResolution} : {})}};
  }
  const paramResolution = await resolveRegisteredDrillDownSkillParams({
    skillId,
    params: gate.params,
    processScope: gate.processScope,
    traceId: deps.traceId,
    traceProcessorService: deps.traceProcessorService,
    signal,
  });
  const invalidParams = undeclaredSkillRunParams(skillDef, paramResolution.params);
  if (invalidParams.length > 0) {
    return {status: 'refused', refusal: {kind: 'undeclared_params_after_resolution', invalidParams}};
  }
  return {status: 'ready', prepared: {
    skillId, skillDef, effectiveParams: paramResolution.params, gate,
    ...(identityResolution ? {identityResolution} : {}),
    paramResolution, defaultProcessField,
  }};
}

export interface SkillRunSynthesizeArtifact {
  artifactId: string;
  stepId: string;
  rowCount: number;
  columns: string[];
  executionStatus?: DataEnvelopeMeta['executionStatus'];
}

export interface StoredDisplayArtifact {
  displayIndex: number;
  artifactId: string;
  evidenceRefId: string;
  modelProjection: ReturnType<typeof projectEvidenceTableForModel>;
}

/** Why a run that executed wrote nothing: checked after the Skill returned, before the first write. */
export type SkillRunCommitRefusal = 'cancelled' | 'authorization_revoked';

export interface SkillRunExecution {
  result: SkillExecutionResult;
  durationMs: number;
  traceProvenance: TraceProcessorQueryProvenance;
  modelDisplayProjections: ReturnType<typeof projectEvidenceTableForModel>[];
}

export type SkillRunOutcome =
  | (SkillRunExecution & {status: 'commit_refused'; reason: SkillRunCommitRefusal})
  | (SkillRunExecution & {
    status: 'committed';
    artifactIdsByDisplayIndex: Array<string | undefined>;
    evidenceRefIdsByDisplayIndex: Array<string | undefined>;
    queryReviewsByDisplayIndex: Array<QueryReviewV1 | undefined>;
    diagnosticsArtifactId?: string;
    synthesizeArtifacts?: SkillRunSynthesizeArtifact[];
    /** Captures this run registered (display and synthesize witnesses). */
    captureCount: number;
  });

/**
 * Run a prepared Skill on the current trace and record its results. The
 * `beforeCommit` check runs after the Skill returned and before the first
 * artifact, capture or query review is written; a refusal there writes none of
 * them. Everything after it is synchronous, so a cancel that lands later
 * cannot interleave a partial commit.
 */
export async function executePreparedSkillRun(
  deps: SkillRunDeps,
  prepared: PreparedSkillRun,
  options: {
    producer: EvidenceProducerContext;
    signal?: AbortSignal;
    afterExecute?: (durationMs: number) => void;
    beforeCommit?: () => SkillRunCommitRefusal | undefined;
    onDisplayArtifactStored?: (stored: StoredDisplayArtifact) => void;
  },
): Promise<SkillRunOutcome> {
  const {skillId, effectiveParams, gate} = prepared;
  const {producer, signal} = options;
  const {artifactStore, outputLanguage} = deps;
  const skillTraceProvenance = buildTraceProcessorQueryProvenance({
    traceId: deps.traceId, traceSide: 'current', paneSide: deps.paneSide,
  });
  const skillStart = Date.now();
  const executionContext = {
    ...(deps.paneSide ? { __paneSide: deps.paneSide } : {}),
    __outputLanguage: outputLanguage, __traceSide: 'current', signal,
  };
  const result = gate.processScope
    ? await deps.skillExecutor.execute(skillId, deps.traceId, effectiveParams, executionContext, gate.processScope)
    : await deps.skillExecutor.execute(skillId, deps.traceId, effectiveParams, executionContext);
  const durationMs = Date.now() - skillStart;
  options.afterExecute?.(durationMs);
  const modelDisplayProjections = (result.displayResults || []).map(dr =>
    projectEvidenceTableForModel(dr.data, evidenceTableFor(dr)));
  const execution: SkillRunExecution = {result, durationMs, traceProvenance: skillTraceProvenance, modelDisplayProjections};
  const refusal = options.beforeCommit?.();
  if (refusal) return {...execution, status: 'commit_refused', reason: refusal};

  // Artifact mode stores displayResults before any envelope is emitted so
  // evidence meta can carry the same artifact ids that the model sees.
  let captureCount = 0;
  let diagnosticsArtifactId: string | undefined;
  let synthesizeArtifacts: SkillRunSynthesizeArtifact[] | undefined;
  const artifactIdsByDisplayIndex: Array<string | undefined> = [];
  const evidenceRefIdsByDisplayIndex: Array<string | undefined> = [];
  const queryReviewsByDisplayIndex: Array<QueryReviewV1 | undefined> = [];
  if (artifactStore && result.displayResults?.length) {
    result.displayResults.forEach((dr, displayIndex) => {
      const modelProjection = modelDisplayProjections[displayIndex];
      const evidenceRefId = stableSkillEvidenceRefId(
        result.skillId || skillId,
        dr.stepId,
        dr.title,
        dr.data,
        skillTraceProvenance,
        producer,
        dr.scopeProvenance,
      );
      const artId = artifactStore.store({
        skillId: result.skillId || skillId,
        stepId: dr.stepId,
        layer: dr.layer,
        title: dr.title,
        data: modelProjection.data,
        modelProjection: modelProjection.modelProjection,
        executionStatus: dr.executionStatus,
        executionMessage: dr.executionMessage,
        executionError: dr.executionError,
        diagnostics: undefined,
        planPhaseId: producer.planPhaseId,
        planPhaseTitle: producer.planPhaseTitle,
        planPhaseGoal: producer.planPhaseGoal,
        sourceToolCallId: producer.sourceToolCallId,
        paramsHash: producer.paramsHash,
        identityResolution: identityForScopeEvidence(dr.scopeProvenance, result.identityResolution),
        scopeProvenance: dr.scopeProvenance,
        traceProvenance: skillTraceProvenance,
      });
      const witness = evidenceTableFor(dr) || captureEvidenceTable(undefined, {}, 'display_transformation_unmapped');
      if (artifactStore.registerEvidenceCapture?.(artId, witness, {evidenceRefId,
        ...(dr.sql ? {queryHash: evidenceHash(dr.sql)} : {})})) captureCount++;
      const queryReview = buildSkillQueryReview({
        skillId: result.skillId || skillId,
        displayResult: dr as SkillDisplayResult,
        traceProvenance: skillTraceProvenance,
        producer,
        artifactId: artId,
        evidenceRefId,
        outputLanguage,
      });
      if (queryReview) {
        artifactStore.updateQueryReview(artId, queryReview);
        queryReviewsByDisplayIndex[displayIndex] = queryReview;
      }
      artifactIdsByDisplayIndex[displayIndex] = artId;
      evidenceRefIdsByDisplayIndex[displayIndex] = evidenceRefId;
      options.onDisplayArtifactStored?.({displayIndex, artifactId: artId, evidenceRefId, modelProjection});
    });
  }

  // Store diagnostics as a separate artifact if present, even for
  // diagnostics-only skill results that do not emit displayResults.
  if (artifactStore && result.diagnostics && Array.isArray(result.diagnostics) && result.diagnostics.length > 0) {
    diagnosticsArtifactId = artifactStore.store({
      skillId: result.skillId || skillId,
      stepId: '_diagnostics',
      layer: 'diagnosis',
      title: `${skillId} diagnostics`,
      data: { columns: ['diagnostic'], rows: result.diagnostics.map((d: any) => [d]) },
      diagnostics: result.diagnostics,
      planPhaseId: producer.planPhaseId,
      planPhaseTitle: producer.planPhaseTitle,
      planPhaseGoal: producer.planPhaseGoal,
      sourceToolCallId: producer.sourceToolCallId,
      paramsHash: producer.paramsHash,
      identityResolution: identityForScopeEvidence(mergeScopeProvenance(result.diagnostics.map(diagnostic => diagnostic.scopeProvenance)), result.identityResolution),
      scopeProvenance: mergeScopeProvenance(result.diagnostics.map(diagnostic => diagnostic.scopeProvenance)),
      traceProvenance: skillTraceProvenance,
    });
  }

  // Store synthesizeData entries as artifacts too — these contain the
  // raw step data that would otherwise overflow token limits.
  if (artifactStore && result.synthesizeData && Array.isArray(result.synthesizeData) && result.synthesizeData.length > 0) {
    synthesizeArtifacts = result.synthesizeData
      .filter((sd: any) => sd.data && sd.success !== false)
      .map((sd: any) => {
        const normalizedData = normalizeSynthesizeDataForStorage(sd.data);
        const artId = artifactStore.store({
          skillId: result.skillId || skillId,
          stepId: sd.stepId,
          layer: sd.layer || 'synthesize',
          title: sd.stepName || sd.stepId,
          data: normalizedData,
          executionStatus: sd.executionStatus,
          executionMessage: sd.executionMessage,
          executionError: sd.executionError,
          planPhaseId: producer.planPhaseId,
          planPhaseTitle: producer.planPhaseTitle,
          planPhaseGoal: producer.planPhaseGoal,
          sourceToolCallId: producer.sourceToolCallId,
          paramsHash: producer.paramsHash,
          identityResolution: identityForScopeEvidence(sd.scopeProvenance, result.identityResolution),
          scopeProvenance: sd.scopeProvenance,
          traceProvenance: skillTraceProvenance,
        });
        // A display and synthesize artifact may expose the same SQL step.
        // Keep their locators distinct without changing existing display IDs.
        const evidenceRefId = `${stableSkillEvidenceRefId(result.skillId || skillId, sd.stepId,
          sd.stepName || sd.stepId, normalizedData, skillTraceProvenance, producer, sd.scopeProvenance)}:artifact:${artId}`;
        // The normalizer flattens iterator-shaped rows and drops the columns
        // of an empty array. Only its plain object-row branch preserves this table.
        const firstRow = Array.isArray(sd.data) ? sd.data[0] : undefined;
        const directRows = firstRow && typeof firstRow === 'object' &&
          !('itemIndex' in firstRow && 'result' in firstRow);
        const witness = (directRows && evidenceTableFor(sd)) || captureEvidenceTable(undefined, {},
          sd.executionStatus === 'skipped' ? 'execution_skipped' : 'synthesize_transformation_unmapped');
        if (artifactStore.registerEvidenceCapture?.(artId, witness, {evidenceRefId})) captureCount++;
        return {
          artifactId: artId,
          stepId: sd.stepId,
          rowCount: normalizedData.rows?.length ?? 0,
          columns: normalizedData.columns ?? [],
          // rowCount 0 alone would read as an empty result for a step that never ran.
          ...(sd.executionStatus === 'skipped' ? { executionStatus: sd.executionStatus } : {}),
        };
      });
  }

  return {
    ...execution,
    status: 'committed',
    artifactIdsByDisplayIndex,
    evidenceRefIdsByDisplayIndex,
    queryReviewsByDisplayIndex,
    ...(diagnosticsArtifactId ? {diagnosticsArtifactId} : {}),
    ...(synthesizeArtifacts ? {synthesizeArtifacts} : {}),
    captureCount,
  };
}
