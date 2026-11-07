// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {parseStoredJson} from '../utils/storedData';
import {stableStringify} from '../utils/stableJson';
import {PRODUCTION_RUNTIME_KINDS} from '../agentRuntime/runtimeKinds';
import {RUNTIME_MODEL_CALL_PURPOSES, projectRuntimeFinalTransportObservation, parseRuntimeBenchmarkConfigCommitments,
  buildRuntimeConfigCommitments, runtimeConfigCommitmentsFingerprint, runtimeCandidateObservationKey, type RuntimeConfigFieldCommitment,
  type RuntimeFinalTransportEvent, type RuntimeExecutionProfileObservation} from '../agentRuntime/runtimePerformance';
import {canonicalContentHash} from '../services/selfEvolution/canonicalJson';
import {resolveModelExecutionProfile} from '../services/providerManager/modelExecutionProfile';
import {resolveOpenAITextRequestPurpose} from '../services/providerManager/openAiChatCompletionsCompat';
import {withOpenAITextPurposeOptions} from '../agentRuntime/engines/openai/openAiModelSettings';
import type {LlmPurposeContractsV1} from './preflightLlmExecutionTarget';
import {createOpenAiCandidateIdentity} from '../agentRuntime/openAiCandidateIdentity';
import type {OpenAiOutputImplementation} from '../agentRuntime/finalSubmissionImplementation';
import {adjudicateLlmSourceFacet, buildLlmExecutionQuality, compareLlmExecutionQuality, elapsedIntervalUnion, scoreLlmExecutionLatency,
  type LlmExecutionQuality, type LlmExecutionLatencyPair, type LlmMaterialChangeReview} from './llmExecutionBenchmark';

const {CELLS, SOURCE_FACET, TREATMENT_ID, MIXED_CONTENT_TREATMENT_ID, DUAL_CARRIER_TREATMENT_ID, treatmentOutputs, makeRepresentationTreatment,
  treatmentOutputImplementation, parsePreflightOutputImplementation, parsePurposeContracts, sourceFacetContext, validateSourceFacetCollection, assertExecutionTarget} = require('../../scripts/llm-execution-lifecycle.cjs') as {
  CELLS: readonly string[];
  TREATMENT_ID: string;
  MIXED_CONTENT_TREATMENT_ID: string;
  DUAL_CARRIER_TREATMENT_ID: string;
  treatmentOutputs(id: string): Record<'base' | 'candidate', {finalSubmission: string; declarationSyntax: string}>;
  makeRepresentationTreatment(base: unknown, candidate: unknown, id?: string): Record<string, unknown>;
  treatmentOutputImplementation(id: string, side: string): OpenAiOutputImplementation;
  parsePreflightOutputImplementation(result: unknown, id: string, side: string): OpenAiOutputImplementation | undefined;
  parsePurposeContracts(value: unknown): LlmPurposeContractsV1;
  SOURCE_FACET: {receiptFile: string; reviewSchema: string};
  sourceFacetContext(root: string): {contract: Record<string, unknown>; inputs: {sourceRoot: string};
    groundTruth: {relativeSourcePath: string; callChain: string[]}};
  validateSourceFacetCollection(input: {report: unknown; reportHash: string; receipt: unknown;
    request: Record<string, unknown>; lifecycle: unknown; repositoryRoot: string}): boolean;
  assertExecutionTarget(target: unknown, request: Record<string, unknown>, processId: number): void;
};
type RecordValue = Record<string, unknown>;
interface ValidatedTreatment {id: string; candidate: Extract<OpenAiOutputImplementation, {kind: 'typed'}>;
  outputs: ReturnType<typeof treatmentOutputs>}

const HASH = /^[a-f0-9]{64}$/;
const ID = /^[a-z0-9][a-z0-9_-]{0,100}$/;
const MAX_JSON_BYTES = 64 * 1024 * 1024;
const MAX_SAMPLES = 300;
const PHASES = ['classification', 'quick_evidence', 'focus', 'architecture', 'completeness', 'comparison',
  'skill_registry', 'knowledge', 'scene_evidence', 'sdk_start', 'provider', 'verification', 'correction', 'finalization'];
const object = (value: unknown): RecordValue | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : undefined;
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const validHash = (value: unknown): value is string => typeof value === 'string' && HASH.test(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const positiveInteger = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const textId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256;
function fail(code: string): never {throw new Error(code);}

/** Explicit input roots may resolve platform aliases (for example /tmp); descendants may not be symlinks. */
function scopedPath(root: string, relative: string, createParents = false): string {
  if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/).some(part => !part || part === '.' || part === '..')) {
    return fail('llm_score_path_invalid');
  }
  const parts = relative.split(/[\\/]/);
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || index < parts.length - 1 && !stat.isDirectory()) fail('llm_score_path_invalid');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (index < parts.length - 1) {
        if (!createParents) fail('llm_score_file_missing');
        fs.mkdirSync(current, {mode: 0o700});
      }
    }
  }
  return current;
}

function readJsonFile(filename: string, maximumBytes = MAX_JSON_BYTES): {value: unknown; sha256: string} {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size <= 0 || stat.size > maximumBytes) fail('llm_score_file_invalid');
    const bytes = fs.readFileSync(descriptor);
    if (bytes.length > maximumBytes) fail('llm_score_file_invalid');
    return {value: parseStoredJson(bytes.toString('utf8'), 'LLM benchmark artifact'), sha256: hash(bytes)};
  } catch {return fail('llm_score_file_unreadable');}
  finally {if (descriptor !== undefined) fs.closeSync(descriptor);}
}

function explicitInput(filename: string) {
  const absolute = path.resolve(filename);
  const root = fs.realpathSync(path.dirname(absolute));
  return {root, file: scopedPath(root, path.basename(absolute))};
}

/** Resolve only aliases above the admitted root; never erase a descendant symlink by realpathing the whole output. */
function outputWithinRoot(root: string, filename: string): string {
  const absolute = path.resolve(filename), suffix = [path.basename(absolute)];
  let ancestor = path.dirname(absolute);
  for (;;) {
    let stat: fs.Stats | undefined;
    try {stat = fs.lstatSync(ancestor);}
    catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') fail('llm_score_path_invalid');}
    if (stat) {
      if (!stat.isDirectory() && !stat.isSymbolicLink()) fail('llm_score_path_invalid');
      let canonical: string;
      try {canonical = fs.realpathSync(ancestor);} catch {return fail('llm_score_path_invalid');}
      if (stat.isSymbolicLink()) {
        const parent = fs.realpathSync(path.dirname(ancestor));
        const relativeParent = path.relative(root, parent);
        const parentInside = !relativeParent || !path.isAbsolute(relativeParent) &&
          relativeParent !== '..' && !relativeParent.startsWith(`..${path.sep}`);
        if (canonical !== root || parentInside) fail('llm_score_path_invalid');
      }
      if (canonical === root) return scopedPath(root, suffix.join(path.sep), true);
    }
    const parent = path.dirname(ancestor);
    if (parent === ancestor) return fail('llm_score_path_invalid');
    suffix.unshift(path.basename(ancestor));
    ancestor = parent;
  }
}

interface SavedReviews {
  materials: Map<string, LlmMaterialChangeReview>;
  sourceFacets: Map<string, {review: RecordValue; evidenceSha256: string}>;
  observers: Array<{baselineSourceFingerprint: string; candidateSourceFingerprint: string;
    coreFingerprint: string; evidenceSha256: string}>;
  issues: string[];
  indexHash?: string;
}

function independentReview(value: RecordValue): boolean {
  const reviewer = object(value.reviewer);
  return Boolean(reviewer && ['human', 'independent_agent'].includes(String(reviewer.kind)) && textId(reviewer.id) &&
    reviewer.independentOfImplementation === true && typeof value.rationale === 'string' && value.rationale.trim());
}

/** Provenance is an audit attestation, not a cryptographic signature or product authorization. */
function readReviews(filename?: string): SavedReviews {
  const result: SavedReviews = {materials: new Map(), sourceFacets: new Map(), observers: [], issues: []};
  if (!filename) return result;
  try {
    const input = explicitInput(filename), index = readJsonFile(input.file, 1024 * 1024);
    const value = object(index.value);
    if (!value || value.schemaVersion !== 'llm_execution_reviews@1') fail('llm_score_reviews_invalid');
    result.indexHash = index.sha256;
    for (const kind of ['materialReviews', 'observerReviews', 'sourceFacetReviews'] as const) {
      const entries = value[kind] === undefined ? [] : value[kind];
      if (!Array.isArray(entries) || entries.length > MAX_SAMPLES) fail('llm_score_reviews_invalid');
      for (const entry of entries) {
        const item = object(entry);
        if (!item || typeof item.evidencePath !== 'string' || !validHash(item.evidenceSha256)) fail('llm_score_reviews_invalid');
        const evidence = readJsonFile(scopedPath(input.root, item.evidencePath), 1024 * 1024);
        const review = object(evidence.value);
        if (evidence.sha256 !== item.evidenceSha256 || !review || !independentReview(review)) fail('llm_score_reviews_invalid');
        if (kind === 'materialReviews') {
          if (review.schemaVersion !== 'llm_execution_material_review@1' || !validHash(review.baselineFingerprint) ||
              !validHash(review.candidateFingerprint) || !validHash(review.baselineReportSha256) ||
              !validHash(review.candidateReportSha256) || !['equivalent_or_improved', 'regressed'].includes(String(review.verdict))) {
            fail('llm_score_reviews_invalid');
          }
          const key = `${review.baselineReportSha256}:${review.candidateReportSha256}:${review.baselineFingerprint}:${review.candidateFingerprint}`;
          if (result.materials.has(key)) fail('llm_score_reviews_ambiguous');
          result.materials.set(key, {schemaVersion: 'llm_execution_material_review@1',
            baselineFingerprint: review.baselineFingerprint, candidateFingerprint: review.candidateFingerprint,
            verdict: review.verdict as LlmMaterialChangeReview['verdict'], evidenceSha256: evidence.sha256});
        } else if (kind === 'sourceFacetReviews') {
          const bindings = object(review.bindings);
          if (review.schemaVersion !== SOURCE_FACET.reviewSchema || !validHash(bindings?.rawReportSha256)) fail('llm_score_reviews_invalid');
          if (result.sourceFacets.has(bindings.rawReportSha256)) fail('llm_score_reviews_ambiguous');
          result.sourceFacets.set(bindings.rawReportSha256, {review, evidenceSha256: evidence.sha256});
        } else {
          if (review.schemaVersion !== 'llm_execution_observer_review@1' || review.verdict !== 'equivalent' ||
              !validHash(review.baselineSourceFingerprint) || !validHash(review.candidateSourceFingerprint) ||
              !validHash(review.coreFingerprint)) fail('llm_score_reviews_invalid');
          result.observers.push({baselineSourceFingerprint: review.baselineSourceFingerprint,
            candidateSourceFingerprint: review.candidateSourceFingerprint, coreFingerprint: review.coreFingerprint,
            evidenceSha256: evidence.sha256});
        }
      }
    }
  } catch {
    result.materials.clear(); result.sourceFacets.clear(); result.observers = []; result.issues.push('review_evidence_invalid');
  }
  return result;
}

function costObservations(performance: RecordValue | undefined) {
  const requests = array(performance?.modelRequests).map(object);
  const truncated = object(performance?.truncated);
  const observed = requests.flatMap(request => {
    const body = object(request?.body);
    return body?.status === 'observed' && finite(body.bodyBytes) ? [body.bodyBytes] : [];
  });
  const calls = array(performance?.modelCalls).map(object);
  const usage = Object.fromEntries(['inputTokens', 'outputTokens', 'reasoningTokens', 'cachedInputTokens'].flatMap(key => {
    const values = calls.map(call => object(call?.usage)?.[key]);
    return values.length && !truncated?.modelCalls && values.every(finite)
      ? [[key, values.reduce((sum, value) => sum + value, 0)]] : [];
  }));
  const phases = array(performance?.phases).map(object);
  const phaseDurationsMs = Object.fromEntries(PHASES.flatMap(name => {
    const selected = phases.filter(phase => phase?.name === name);
    if (!selected.length || truncated?.phases || selected.some(phase => !finite(phase?.startOffsetMs) || !finite(phase?.durationMs))) return [];
    const elapsed = elapsedIntervalUnion(selected.map(phase => ({startOffsetMs: phase!.startOffsetMs as number,
      durationMs: phase!.durationMs as number})));
    return elapsed === undefined ? [] : [[name, elapsed]];
  }));
  return {requestBodyBytes: {status: !requests.length ? 'unavailable' : observed.length === requests.length && !truncated?.modelRequests ? 'complete' : 'partial',
    ...(observed.length ? {observedBytes: observed.reduce((sum, value) => sum + value, 0)} : {})},
    providerUsage: Object.keys(usage).length ? usage : undefined, costUsd: 'unavailable', phaseDurationsMs};
}

interface InspectedSample {
  pairId: string;
  cellId: string;
  repetition: number;
  side: 'base' | 'candidate';
  sourceFingerprint?: string;
  comparisonFingerprint?: string;
  purposeControls?: Record<string, string[]>;
  observerCore?: string;
  observerReviewHash?: string;
  origin?: string;
  dataRootHash?: string;
  reportHash?: string;
  runId?: string;
  sessionId?: string;
  issues: string[];
  quality: LlmExecutionQuality;
  sourceAdjudication?: ReturnType<typeof adjudicateLlmSourceFacet>;
  outcome: 'completed' | 'failed' | 'censored';
  totalMs?: number;
  costs?: ReturnType<typeof costObservations>;
}

type Fields = readonly RuntimeConfigFieldCommitment[];
const scalarCommitment = (value: string | number | boolean) => canonicalContentHash([
  typeof value, typeof value === 'number' ? String(value) : value]);
const fieldAt = (rows: Fields, path: string) => rows.find(row => row.field === path && row.presence === 'present');
function equalFields(left: Fields, right: Fields): boolean {return stableStringify(left) === stableStringify(right);}
function stripRootFields(rows: Fields, removed: readonly string[]): Fields {
  const selected = rows.filter(row => !removed.some(key => row.field === `/${key}` || row.field.startsWith(`/${key}/`)));
  const keys = selected.filter(row => row.presence === 'present' && /^\/[^/]+$/.test(row.field))
    .map(row => row.field.slice(1).replace(/~1/g, '/').replace(/~0/g, '~')).sort();
  return selected.map(row => row.field === '' ? {...row, valueCommitment: canonicalContentHash(['object', keys])} : row);
}
function knownConfigString(rows: Fields, field: string, allowed: readonly string[]): string | undefined {
  const row = fieldAt(rows, field);
  if (!row || row.type === 'undefined') return undefined;
  const value = allowed.find(value => row.type === 'string' && row.valueCommitment === scalarCommitment(value));
  if (value === undefined) fail('llm_score_control_value_unproven');
  return value;
}
function inspectPreflight(proofValue: unknown, sample: RecordValue, benchmark: RecordValue, root: string,
  configuration: NonNullable<ReturnType<typeof parseRuntimeBenchmarkConfigCommitments>>, sampleProbe: boolean, treatment: ValidatedTreatment) {
  const proof = object(proofValue), lifecycle = object(proof?.lifecycle);
  if (!proof || typeof proof.request !== 'string' || typeof proof.receipt !== 'string' || !validHash(proof.requestHash) ||
      !validHash(proof.receiptHash) || proof.side !== sample.side || proof.cellId !== sample.cellId ||
      !['auto', 'fast', 'full'].includes(String(proof.requestedMode)) || lifecycle?.outcome !== 'exited' || lifecycle.exitCode !== 0 ||
      lifecycle.signal !== null || lifecycle.censored !== false || lifecycle.cleanup !== 'confirmed' || !positiveInteger(lifecycle.processId) ||
      !finite(lifecycle.preparedAt) || !finite(lifecycle.settledAt) || lifecycle.settledAt < lifecycle.preparedAt ||
      !finite(object(sample.lifecycle)?.preparedAt) || lifecycle.settledAt > Number(object(sample.lifecycle)?.preparedAt)) fail('llm_score_preflight_lifecycle_unproven');
  const prefix = sampleProbe ? `${sample.pairId}/${sample.side}/preflight-` : `preflight/${sample.cellId}/${sample.side}/`;
  if (!proof.request.startsWith(prefix) || !proof.receipt.startsWith(prefix)) fail('llm_score_preflight_path_invalid');
  const requestRead = readJsonFile(scopedPath(root, proof.request), 1024 * 1024), resultRead = readJsonFile(scopedPath(root, proof.receipt), 1024 * 1024);
  const request = object(requestRead.value), result = object(resultRead.value), sdk = object(result?.sdk);
  if (requestRead.sha256 !== proof.requestHash || resultRead.sha256 !== proof.receiptHash ||
      request?.schemaVersion !== 'llm_target_preflight_request@1' || !result || !['llm_target_preflight@2', 'llm_target_preflight@3'].includes(String(result?.schemaVersion)) ||
      request.nonce !== benchmark.nonce || result.nonce !== benchmark.nonce || request.side !== sample.side || result.side !== sample.side ||
      request.cellId !== sample.cellId || result.cellId !== sample.cellId || request.requestedMode !== proof.requestedMode || result.requestedMode !== proof.requestedMode ||
      request.expectedSourceFingerprint !== sample.sourceFingerprint || result.observedSourceFingerprint !== sample.sourceFingerprint ||
      stableStringify(request.declaredConfig) !== stableStringify(configuration) || result.declaredConfigFingerprint !== configuration.fullFingerprint ||
      result.declaredControlsFingerprint !== configuration.controlsFingerprint || request.treatmentHash !== sample.treatmentHash ||
      result.declaredTreatmentHash !== sample.treatmentHash || result.status !== 'ready' ||
      stableStringify(result.capturedOutput) !== stableStringify(treatment.outputs[sample.side as 'base' | 'candidate']) ||
      sdk?.identity !== 'matched' || sdk.nodeVersion !== benchmark.nodeVersion || typeof sdk.agentsCoreVersion !== 'string' || typeof sdk.agentsOpenAiVersion !== 'string' ||
      !/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(sdk.agentsCoreVersion) || !/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(sdk.agentsOpenAiVersion) ||
      !runtimeConfigCommitmentsFingerprint(result.actualResolvedConfig as Fields)) fail('llm_score_preflight_binding_unproven');
  let outputImplementation: OpenAiOutputImplementation | undefined;
  try {outputImplementation = parsePreflightOutputImplementation(result, treatment.id, String(sample.side));}
  catch {fail('llm_score_preflight_implementation_unproven');}
  return {mode: proof.requestedMode as string, sdk, resolved: result.actualResolvedConfig as Fields,
    schemaVersion: result.schemaVersion, outputImplementation, purposeContracts: parsePurposeContracts(result.purposeContracts)};
}
function stageContract(dispatch: Extract<RuntimeFinalTransportEvent, {kind: 'main_dispatch' | 'stage_dispatch'}>,
  probe: ReturnType<typeof inspectPreflight>) {
  return dispatch.kind === 'stage_dispatch' && (dispatch.purpose === 'classification' || dispatch.purpose === 'review')
    ? probe.purposeContracts[dispatch.purpose] : undefined;
}
const EFFECTIVE_CONFIG_FIELDS: Record<string, string> = {maxOutputTokens: 'maxOutputTokens', maxTurns: 'maxTurns',
  quickMaxTurns: 'quickMaxTurns', quickTargetTurns: 'quickTargetTurns', fullPerTurnMs: 'fullPathPerTurnMs', quickPerTurnMs: 'quickPathPerTurnMs',
  fullRequestTimeoutMs: 'fullRequestTimeoutMs', streamIdleTimeoutMs: 'streamIdleTimeoutMs', maxRunTimeoutMs: 'maxRunTimeoutMs',
  classifierTimeoutMs: 'classifierTimeoutMs', maxHistoryBytes: 'maxHistoryBytes'};
/** Rebuild the public profile facts; numeric leaves stay commitments to the actual captured settings. */
function profileContractMatches(profile: RuntimeExecutionProfileObservation, dispatch: Extract<RuntimeFinalTransportEvent,
  {kind: 'main_dispatch' | 'stage_dispatch'}>, benchmark: RecordValue, probe: ReturnType<typeof inspectPreflight>, treatment: ValidatedTreatment): boolean {
  try {
    const controls = dispatch.controls, purpose = stageContract(dispatch, probe);
    const common = purpose?.commonConfig ?? stripRootFields(probe.resolved, ['outputConfig']);
    const model = dispatch.purpose === 'classification' ? String(benchmark.lightModel) : String(benchmark.model);
    if (profile.purpose !== dispatch.purpose || profile.modelHash !== hash(model)) return false;
    if (profile.role === 'typed_admission' && controls.requestedOutput.finalSubmission !== treatment.outputs.candidate.finalSubmission) return false;
    const baseUrl = knownConfigString(probe.resolved, '/baseURL', ['https://api.deepseek.com', 'https://api.deepseek.com/',
      'https://api.deepseek.com/v1', 'https://api.deepseek.com/v1/', 'https://open.bigmodel.cn/api/coding/paas/v4', 'https://open.bigmodel.cn/api/coding/paas/v4/']);
    if (!baseUrl) return false;
    const stage = profile.role === 'stage_policy', direct = dispatch.kind === 'stage_dispatch';
    const sdk = profile.role === 'typed_admission' ? {packageName: '@openai/agents-openai',
      version: String(probe.sdk.agentsOpenAiVersion), adapterContractVersion: treatment.candidate.admissionVersion}
      : stage && direct ? {packageName: 'node:fetch', version: String(probe.sdk.nodeVersion), adapterContractVersion: 'openai-text-http@1'}
        : {packageName: '@openai/agents-openai', version: 'unknown', adapterContractVersion: stage ? 'provider-data@1' : 'analysis-controls@1'};
    const effective: Record<string, unknown> = {};
    const replacements = new Map<string, string>();
    const numericFields = profile.role === 'main_controls' || stage && !direct ? ['maxOutputTokens'] : Object.keys(EFFECTIVE_CONFIG_FIELDS);
    for (const field of numericFields) {
      const actual = fieldAt(profile.fields, `/effective/${field}`), configured = fieldAt(common, `/${EFFECTIVE_CONFIG_FIELDS[field]}`);
      const limit = field === 'maxOutputTokens' ? purpose?.tokenLimit : undefined;
      const required = limit ? limit.status === 'explicit' : configured?.type === 'number';
      if (!required) {if (actual) return false; continue;}
      const expectedValue = limit?.status === 'explicit' ? limit.valueCommitment : configured?.valueCommitment;
      if (actual?.type !== 'number' || actual.valueCommitment !== expectedValue) return false;
      effective[field] = 1; replacements.set(`/effective/${field}`, expectedValue!);
    }
    if (profile.role === 'typed_admission') Object.assign(effective, controls.requestedOutput);
    if (!stage) {
      const effort = knownConfigString(common, '/analysisReasoningEffort', ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
      if (profile.role === 'main_controls' && !effort) return false;
      if (effort) effective.authoredReasoning = effort === 'none' ? {mode: 'disabled'} : {mode: 'enabled', effort};
    }
    const expected = resolveModelExecutionProfile({runtimeKind: 'openai-agents-sdk', protocol: 'chat_completions', modelId: model,
      baseUrl: direct ? new URL('chat/completions', baseUrl.replace(/\/?$/, '/')).href : baseUrl, sdk,
      sdkCapabilities: profile.role === 'typed_admission' ? {surface: 'none', thinking: 'unknown', reasoningRoundtrip: 'unknown', source: 'contract_test'}
        : {surface: 'openai_chat', thinking: 'optional', efforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
          reasoningRoundtrip: 'unknown', source: 'contract_test'}, effective: {}});
    // Public facts use the existing resolver; effective commitments are checked independently above.
    // This verifier does not activate candidate v2 eligibility on the default-only baseline.
    const {fingerprint: _fingerprint, ...publicFacts} = expected;
    const body = {...publicFacts, effective};
    const fields = buildRuntimeConfigCommitments(body)!.map(row => replacements.has(row.field) ? {...row, valueCommitment: replacements.get(row.field)!} : row);
    return equalFields(fields, profile.fields);
  } catch {return false;}
}
function purposeSettingsMatch(dispatch: Extract<RuntimeFinalTransportEvent, {kind: 'main_dispatch' | 'stage_dispatch'}>,
  benchmark: RecordValue, probe: ReturnType<typeof inspectPreflight>): boolean {
  if (dispatch.kind === 'main_dispatch' && dispatch.purpose === 'answer_turn') return true; // Paired exact comparison below.
  try {
    const policy = dispatch.controls.profiles.find(profile => profile.role === 'stage_policy');
    if (!policy) return dispatch.kind === 'main_dispatch' && dispatch.purpose === 'continuation';
    const baseUrl = knownConfigString(probe.resolved, '/baseURL', ['https://api.deepseek.com', 'https://api.deepseek.com/',
      'https://api.deepseek.com/v1', 'https://api.deepseek.com/v1/', 'https://open.bigmodel.cn/api/coding/paas/v4', 'https://open.bigmodel.cn/api/coding/paas/v4/']);
    if (!baseUrl) return false;
    const purpose = stageContract(dispatch, probe);
    const limit = purpose?.tokenLimit;
    const mainLimit = fieldAt(stripRootFields(probe.resolved, ['outputConfig']), '/maxOutputTokens');
    const cap = limit ? limit.status === 'explicit' ? {valueCommitment: limit.valueCommitment} : undefined
      : mainLimit?.type === 'number' ? mainLimit : undefined;
    const model = dispatch.purpose === 'classification' ? String(benchmark.lightModel) : String(benchmark.model);
    const direct = dispatch.kind === 'stage_dispatch';
    const execution = resolveOpenAITextRequestPurpose({requestUrl: new URL(direct ? 'chat/completions' : '', baseUrl.replace(/\/?$/, '/')),
      runtimeKind: 'openai-agents-sdk', protocol: 'chat_completions', model,
      purpose: dispatch.purpose === 'review' ? 'final_semantic' : dispatch.purpose === 'answer_turn' ? undefined : dispatch.purpose,
      outputOnly: true, effective: cap ? {maxOutputTokens: 1} : {},
      sdkIdentity: {packageName: direct ? 'node:fetch' : '@openai/agents-openai', version: direct ? String(probe.sdk.nodeVersion) : 'unknown',
        adapterContractVersion: direct ? 'openai-text-http@1' : 'provider-data@1'},
      sdkCapabilities: {surface: 'openai_chat', thinking: 'optional', efforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
        reasoningRoundtrip: 'unknown', source: 'contract_test'}});
    const tokenField = limit?.status === 'explicit' ? limit.field : 'max_tokens';
    const expected = direct ? {model, temperature: 0, stream: true, ...execution.options, ...(cap ? {[tokenField]: 1} : {})}
      : withOpenAITextPurposeOptions({...(cap ? {maxTokens: 1} : {}), parallelToolCalls: false, store: false,
        toolChoice: 'none'}, execution.options);
    const fields = buildRuntimeConfigCommitments(expected)!.map(row => cap && [`/${tokenField}`, '/maxTokens'].includes(row.field)
      ? {...row, valueCommitment: cap.valueCommitment} : row);
    return equalFields(fields, dispatch.controls.appliedSettings);
  } catch {return false;}
}
function inspectActualTransport(raw: RecordValue, benchmark: RecordValue, report: RecordValue,
  probe: ReturnType<typeof inspectPreflight>, treatment: ValidatedTreatment, require: (value: unknown, code: string) => void): Record<string, string[]> {
  const metrics = object(report.executionMetrics), performance = object(metrics?.performance);
  const observed = projectRuntimeFinalTransportObservation(performance?.finalTransportObservation);
  const side = raw.side as 'base' | 'candidate';
  require(observed && observed.truncated === 0, 'actual_transport_observation_unproven');
  require(stableStringify(metrics?.requestedOutputConfig) === stableStringify(treatment.outputs[side]), 'requested_treatment_mismatch');
  if (!observed) return {};
  const events = observed.events, byKey = new Map(events.map(event => [event.eventKey, event]));
  const dispatches = events.filter((event): event is Extract<RuntimeFinalTransportEvent, {kind: 'main_dispatch' | 'stage_dispatch'}> =>
    event.kind === 'main_dispatch' || event.kind === 'stage_dispatch');
  const main = dispatches.filter((event): event is Extract<RuntimeFinalTransportEvent, {kind: 'main_dispatch'}> => event.kind === 'main_dispatch');
  require(main.length > 0 && !events.some(event => event.kind === 'not_exercised'), 'treatment_not_exercised');
  const common = stripRootFields(probe.resolved, ['outputConfig']);
  const signatures: Record<string, Set<string>> = {};
  const logical = new Map<string, Extract<RuntimeFinalTransportEvent, {kind: 'main_dispatch'}>>();
  const stageCalls = new Map<string, Extract<RuntimeFinalTransportEvent, {kind: 'stage_dispatch'}>>();
  for (const dispatch of dispatches) {
    const controls = dispatch.controls;
    if (dispatch.kind === 'stage_dispatch') {
      const previous = stageCalls.get(dispatch.stageCallKey);
      require(!previous || previous.purpose === dispatch.purpose && previous.configuredModelHash === dispatch.configuredModelHash &&
        previous.providerOriginHash === dispatch.providerOriginHash && previous.controls.fullFingerprint === controls.fullFingerprint, 'stage_dispatch_identity_conflict');
      stageCalls.set(dispatch.stageCallKey, dispatch);
    }
    require(stableStringify(controls.requestedOutput) === stableStringify(treatment.outputs[side]), 'dispatch_requested_treatment_mismatch');
    require(dispatch.configuredModelHash === hash(String(dispatch.purpose === 'classification' ? benchmark.lightModel : benchmark.model)), 'dispatch_model_pin_mismatch');
    require(dispatch.providerOriginHash === hash(benchmark.provider === 'glm' ? 'https://open.bigmodel.cn' : 'https://api.deepseek.com'), 'dispatch_provider_mismatch');
    const purpose = stageContract(dispatch, probe);
    require(dispatch.kind === 'main_dispatch' ? equalFields(controls.commonConfig, common)
      : purpose && equalFields(controls.commonConfig, purpose.commonConfig), 'actual_common_controls_mismatch');
    const roles = new Set<string>();
    if (dispatch.kind === 'stage_dispatch') require(controls.profiles.some(profile => profile.role === 'stage_policy'), 'stage_profile_missing');
    for (const profile of controls.profiles) {
      const key = `${profile.role}:${profile.purpose}:${profile.modelHash}`;
      require(!roles.has(key) && profileContractMatches(profile, dispatch, benchmark, probe, treatment), 'actual_profile_contract_unproven'); roles.add(key);
      if (dispatch.kind === 'stage_dispatch' && profile.role === 'stage_policy') require(equalFields(
        controls.commonConfig.filter(row => row.field === '/sdk' || row.field.startsWith('/sdk/')),
        profile.fields.filter(row => row.field === '/sdk' || row.field.startsWith('/sdk/'))), 'stage_sdk_context_mismatch');
    }
    require(purposeSettingsMatch(dispatch, benchmark, probe), 'actual_stage_settings_unproven');
    if (dispatch.kind === 'main_dispatch' && dispatch.purpose === 'continuation' &&
        !controls.profiles.some(profile => profile.role === 'stage_policy')) {
      const original = main.find(event => event.purpose === 'answer_turn');
      const toolChoice = fieldAt(controls.appliedSettings, '/toolChoice');
      // The existing recovery clone adds exactly toolChoice:none. All other actual settings must survive.
      require(original && toolChoice?.type === 'string' && toolChoice.valueCommitment === scalarCommitment('none') &&
        equalFields(stripRootFields(original.controls.appliedSettings, ['toolChoice']),
          stripRootFields(controls.appliedSettings, ['toolChoice'])), 'continuation_controls_unproven');
    }
    if (dispatch.kind === 'main_dispatch') {
      const previous = logical.get(dispatch.logicalCallKey);
      require(!previous || previous.attemptKey === dispatch.attemptKey && previous.purpose === dispatch.purpose &&
        previous.controls.fullFingerprint === controls.fullFingerprint, 'logical_dispatch_identity_conflict');
      logical.set(dispatch.logicalCallKey, dispatch);
      if (side === 'candidate') require(controls.profiles.some(profile => profile.role === 'typed_admission'), 'typed_admission_profile_missing');
    }
    const signature = hash(stableStringify({common: controls.commonConfig, settings: controls.appliedSettings,
      profiles: controls.profiles.filter(profile => profile.role !== 'typed_admission').map(profile => ({role: profile.role, purpose: profile.purpose,
        modelHash: profile.modelHash, fields: profile.fields})).sort((a, b) => stableStringify(a).localeCompare(stableStringify(b)))}));
    const key = `${dispatch.kind}:${dispatch.purpose}`;
    (signatures[key] ??= new Set()).add(signature);
  }
  const terminalCalls = new Set<string>(), issuedCarriers = new Set<string>();
  for (const event of events) {
    // Monotonic offsets are rounded, while the manifest uses millisecond wall-clock ticks.
    require(event.offsetMs <= Number(metrics?.wallclockMs) + 1, 'transport_time_outside_run');
    if (event.kind !== 'native_terminal' && event.kind !== 'typed_issued_after_drain' && event.kind !== 'assistant_document_issued_after_drain') continue;
    if (event.kind !== 'native_terminal') {
      require(!issuedCarriers.has(event.logicalCallKey), 'duplicate_final_carrier'); issuedCarriers.add(event.logicalCallKey);
    }
    if (event.kind === 'assistant_document_issued_after_drain') require(side === 'candidate' && treatment.id === DUAL_CARRIER_TREATMENT_ID, 'assistant_carrier_not_selected');
    const key = `${event.kind}:${event.kind === 'native_terminal' ? event.fact.logicalCallKey : event.logicalCallKey}`;
    require(!terminalCalls.has(key), 'duplicate_logical_terminal'); terminalCalls.add(key);
  }
  const retained = events.filter((event): event is Extract<RuntimeFinalTransportEvent, {kind: 'candidate_retained'}> => event.kind === 'candidate_retained');
  const selected = events.filter((event): event is Extract<RuntimeFinalTransportEvent, {kind: 'finalizer_selected'}> => event.kind === 'finalizer_selected');
  require(retained.length === 1 && selected.length === 1, 'retained_selected_lineage_missing');
  if (retained.length !== 1 || selected.length !== 1) return Object.fromEntries(Object.entries(signatures).map(([key, values]) => [key, [...values].sort()]));
  const kept = retained[0], final = selected[0];
  const candidateCarrierAllowed = kept.carrier === 'model_tool_arguments' ||
    treatment.id === DUAL_CARRIER_TREATMENT_ID && kept.carrier === 'assistant_document';
  require((side === 'base' ? kept.carrier === 'assistant_text' : candidateCarrierAllowed) && kept.productStatus === 'completed' &&
    kept.declaredBody === 'present' && final.productStatus === 'completed' && final.sequence > kept.sequence && final.retainedEventKey === kept.eventKey &&
    final.nativeCandidateKey === kept.nativeCandidateKey && final.canonicalSourceCandidateKey === final.displayCandidateKey, 'retained_selected_lineage_mismatch');
  const roles = kept.authors.map(author => author.role).sort();
  require(stableStringify(roles) === stableStringify(kept.transform === 'native' ? ['body_and_declaration'] : ['body', 'declaration']), 'author_roles_incomplete');
  const completion = object(object(object(report.summary)?.terminalAnalysis)?.completion);
  const terminals = new Set<string>();
  for (const author of kept.authors) {
    const event = byKey.get(author.terminalEventKey);
    require(event && event.sequence < kept.sequence && !terminals.has(author.terminalEventKey), 'author_reference_invalid'); terminals.add(author.terminalEventKey);
    if (event?.kind === 'native_terminal') {
      const fact = event.fact, dispatched = logical.get(fact.logicalCallKey);
      require(side === 'base' && dispatched && dispatched.sequence < event.sequence && dispatched.attemptKey === fact.attemptKey &&
        fact.nativeStatus === 'completed' && fact.sdkStreamCompleted && fact.response.status === 'observed' && fact.rawMaterial.status === 'observed' &&
        fact.actualModel.status === 'observed' && fact.actualModel.hash === hash(String(benchmark.model)) && event.drainStatus === 'fulfilled', 'assistant_native_author_unproven');
    } else if (event?.kind === 'typed_issued_after_drain') {
      const dispatched = logical.get(event.logicalCallKey);
      require(side === 'candidate' && kept.carrier === 'model_tool_arguments' && dispatched && dispatched.sequence < event.sequence && dispatched.attemptKey === event.attemptKey &&
        event.actualModel.status === 'observed' && event.actualModel.hash === hash(String(benchmark.model)) &&
        event.representationVersion === treatment.candidate.representationVersion && event.compilerVersion === treatment.candidate.compilerVersion &&
        event.admissionVersion === treatment.candidate.admissionVersion &&
        (event.wireVersion === undefined ? treatment.id === TREATMENT_ID : event.wireVersion === treatment.candidate.wireVersion), 'typed_native_author_unproven');
    } else if (event?.kind === 'assistant_document_issued_after_drain') {
      const dispatched = logical.get(event.logicalCallKey), terminal = byKey.get(event.nativeTerminalEventKey);
      const expectedIdentity = textId(metrics?.runId) && textId(completion?.attemptId) ? createOpenAiCandidateIdentity({
        runId: metrics.runId, attemptId: completion.attemptId, conclusionFingerprint: event.compiledBodyHash}) : undefined;
      const fact = terminal?.kind === 'native_terminal' ? terminal.fact : undefined;
      require(side === 'candidate' && treatment.id === DUAL_CARRIER_TREATMENT_ID && kept.carrier === 'assistant_document' && kept.transform === 'native' &&
        dispatched && terminal?.kind === 'native_terminal' && dispatched.sequence < terminal.sequence && terminal.sequence < event.sequence &&
        dispatched.attemptKey === event.attemptKey && fact?.attemptKey === event.attemptKey && fact.logicalCallKey === event.logicalCallKey &&
        fact.nativeStatus === 'completed' && fact.finish === 'stop' && fact.sdkStreamCompleted && terminal.drainStatus === 'fulfilled' &&
        fact.response.status === 'observed' && fact.response.hash === event.responseKey && event.messageKey === event.responseKey &&
        fact.rawMaterial.status === 'observed' && fact.rawMaterial.hash === event.rawAssistantTextHash &&
        fact.actualModel.status === 'observed' && event.actualModel.status === 'observed' && fact.actualModel.hash === event.actualModel.hash &&
        event.actualModel.hash === hash(String(benchmark.model)) && event.representationVersion === treatment.candidate.representationVersion &&
        event.compilerVersion === treatment.candidate.compilerVersion && event.admissionVersion === treatment.candidate.admissionVersion &&
        event.wireVersion === treatment.candidate.wireVersion && event.nativeCandidateKey === kept.nativeCandidateKey &&
        event.nativeCandidateKey === final.nativeCandidateKey && expectedIdentity &&
        runtimeCandidateObservationKey(expectedIdentity) === event.nativeCandidateKey &&
        event.attemptKey === hash(JSON.stringify({runId: expectedIdentity.runId, attemptId: expectedIdentity.attemptId})), 'assistant_document_author_unproven');
    } else require(false, 'native_author_missing');
  }
  // This new kind is emitted only for the actually retained candidate, never for abandoned work.
  for (const event of events) if (event.kind === 'assistant_document_issued_after_drain') {
    require(terminals.has(event.eventKey), 'assistant_issuance_not_retained');
  }
  require(completion?.schemaVersion === 1 && completion.runId === metrics?.runId && completion.runtimeKind === metrics?.runtime &&
    completion.status === 'completed' && completion.reason === undefined && textId(completion.attemptId) && textId(completion.candidateRef) && validHash(completion.conclusionFingerprint), 'actual_completion_identity_unproven');
  if (completion) require(final.canonicalCandidateKey === hash(JSON.stringify({runId: completion.runId, attemptId: completion.attemptId,
    candidateRef: completion.candidateRef, conclusionFingerprint: completion.conclusionFingerprint})), 'selected_candidate_identity_mismatch');
  const calls = array(performance?.modelCalls).map(object);
  // One dispatchWithModelCallRecord span owns one no-tool transport invocation.
  // Its internal HTTP retries reuse stageCallKey; fetch ordinals are unrelated.
  for (const purpose of ['classification', 'review'] as const) {
    const observedCalls = new Set(dispatches.filter((event): event is Extract<RuntimeFinalTransportEvent, {kind: 'stage_dispatch'}> =>
      event.kind === 'stage_dispatch' && event.purpose === purpose).map(event => event.stageCallKey));
    require(observedCalls.size === calls.filter(call => call?.purpose === purpose).length, 'stage_controls_coverage_incomplete');
  }
  require(calls.filter(call => call?.purpose === 'classification' || call?.purpose === 'review').every(call => call?.modelSource === 'provider_reported'), 'stage_actual_model_source_unproven');
  return Object.fromEntries(Object.entries(signatures).map(([key, values]) => [key, [...values].sort()]));
}

function inspectSample(raw: RecordValue, benchmark: RecordValue, root: string, reviews: SavedReviews, treatment?: ValidatedTreatment): InspectedSample {
  const sample: InspectedSample = {pairId: raw.pairId as string, cellId: raw.cellId as string,
    repetition: raw.repetition as number, side: raw.side as 'base' | 'candidate',
    issues: [], quality: buildLlmExecutionQuality(undefined), outcome: 'censored'};
  const require = (condition: unknown, code: string) => {if (!condition) sample.issues.push(code);};
  try {
    const version2 = benchmark.schemaVersion === 'llm_execution_benchmark@2';
    require(raw.schemaVersion === (version2 ? 'llm_execution_sample@2' : 'llm_execution_sample@1') && raw.nonce === benchmark.nonce &&
      raw.measurementOrigin === 'real_provider' && benchmark.measurementOrigin === 'real_provider' &&
      raw.sampleKind === 'local-cold', 'sample_identity_unproven');
    const receiptFile = scopedPath(root, `${sample.pairId}/${sample.side}/receipt.json`);
    require(stableStringify(readJsonFile(receiptFile).value) === stableStringify(raw), 'sample_receipt_mismatch');
    const pin = object(raw.pin), observer = object(raw.observer), lifecycle = object(raw.lifecycle), reset = object(raw.reset);
    const expectedProvider = benchmark.provider === 'glm' ? 'zai-coding-cn' : 'deepseek';
    const expectedOrigin = benchmark.provider === 'glm' ? 'https://open.bigmodel.cn' : 'https://api.deepseek.com';
    require(pin?.provider === expectedProvider && pin.runtime === benchmark.runtime && pin.model === benchmark.model &&
      pin.lightModel === benchmark.lightModel && pin.origin === expectedOrigin, 'provider_pin_mismatch');
    require(validHash(raw.sourceFingerprint) && validHash(raw.configFingerprint) && validHash(raw.taskFingerprint), 'source_config_unproven');
    require(observer && validHash(observer.coreFingerprint) && validHash(observer.reviewedHookContractFingerprint) &&
      observer.fingerprint === hash(stableStringify({coreFingerprint: observer.coreFingerprint,
        reviewedHookContractFingerprint: observer.reviewedHookContractFingerprint})), 'observer_unproven');
    sample.sourceFingerprint = validHash(raw.sourceFingerprint) ? raw.sourceFingerprint : undefined;
    sample.observerCore = validHash(observer?.coreFingerprint) ? observer.coreFingerprint : undefined;
    sample.observerReviewHash = validHash(observer?.reviewedHookContractFingerprint) ? observer.reviewedHookContractFingerprint : undefined;
    const processCompleted = lifecycle?.outcome === 'exited' && lifecycle.exitCode === 0 &&
      lifecycle.censored === false && lifecycle.signal === null;
    require(raw.targetStatus === 'matched' && raw.failureCode === undefined && lifecycle?.cleanup === 'confirmed' &&
      positiveInteger(lifecycle.processId) && finite(lifecycle.preparedAt) && finite(lifecycle.settledAt) &&
      lifecycle.settledAt >= lifecycle.preparedAt, 'lifecycle_unconfirmed');
    require(reset?.schemaVersion === 'llm_execution_pair_reset@1' && reset.nonce === benchmark.nonce &&
      reset.pairId === raw.pairId && reset.cellId === raw.cellId && reset.side === raw.side && reset.repetition === raw.repetition &&
      reset.status === 'observed' && reset.sampleKind === 'local-cold' && validHash(reset.dataRootHash) &&
      finite(reset.preparedAt) && finite(reset.completedAt) && reset.completedAt >= reset.preparedAt &&
      ['created_fresh_data_root', 'spawned_process', 'awaited_process', 'confirmed_process_group_exit', 'confirmed_backend_port_release']
        .every(action => array(reset.actions).includes(action)), 'reset_unconfirmed');
    if (raw.reportStatus !== 'available' || typeof raw.report !== 'string' || !validHash(raw.reportHash)) fail('report_unavailable');
    const read = readJsonFile(scopedPath(root, raw.report));
    if (read.sha256 !== raw.reportHash) fail('report_hash_mismatch');
    sample.reportHash = read.sha256;
    const report = object(read.value);
    if (!report) fail('report_invalid');
    const target = object(report.executionTarget), metrics = object(report.executionMetrics), identity = object(report.runIdentity);
    const port = typeof target?.origin === 'string' ? new URL(target.origin).port : undefined;
    const targetRequest = {schemaVersion: version2 ? 'llm_execution_target_request@2' : 'llm_execution_target_request@1', nonce: benchmark.nonce, side: raw.side, pairId: raw.pairId, cellId: raw.cellId,
      repetition: raw.repetition, port: Number(port), expectedSourceFingerprint: raw.sourceFingerprint,
      observerFingerprint: observer?.fingerprint, configFingerprint: raw.configFingerprint,
      dataRootHash: reset?.dataRootHash,
      ...(version2 ? {configFullFingerprint: object(raw.configuration)?.fullFingerprint, configControlsFingerprint: object(raw.configuration)?.controlsFingerprint,
        treatmentHash: raw.treatmentHash, preflightFingerprint: hash(stableStringify(raw.preflights))} : {}), ...(raw.sourceFacet ? {sourceFacet: raw.sourceFacet} : {})};
    assertExecutionTarget(target, targetRequest, Number(lifecycle?.processId));
    require(target?.schemaVersion === (version2 ? 'llm_execution_target@2' : 'llm_execution_target@1') && Number(port) >= 1024 && Number(port) <= 65535,
      'target_invalid');
    sample.origin = target?.origin as string;
    sample.dataRootHash = validHash(reset?.dataRootHash) ? reset.dataRootHash : undefined;
    require(metrics?.schemaVersion === 'llm_execution_metrics_artifact@1' && metrics.status === 'sealed' &&
      metrics.runtime === benchmark.runtime && textId(metrics.runId) && textId(metrics.sessionId) &&
      metrics.runId === target?.runId && metrics.sessionId === target?.sessionId && metrics.sessionId === report.sessionId &&
      finite(metrics.sealedAt) && finite(metrics.wallclockMs) && metrics.wallclockMs > 0,
      'sealed_metrics_unproven');
    require(metrics && reset && lifecycle && finite(metrics.sealedAt) && finite(reset.preparedAt) && finite(lifecycle.settledAt) &&
      metrics.sealedAt >= reset.preparedAt && metrics.sealedAt <= lifecycle.settledAt, 'sealed_time_mismatch');
    const snapshotHash = typeof metrics?.providerSnapshotHash === 'string' ? metrics.providerSnapshotHash.replace(/^sha256:/, '') : undefined;
    require(validHash(snapshotHash), 'provider_snapshot_unavailable');
    require(metrics?.modelHash === hash(String(benchmark.model)), 'actual_model_mismatch');
    sample.runId = textId(metrics?.runId) ? metrics.runId : undefined;
    sample.sessionId = textId(metrics?.sessionId) ? metrics.sessionId : undefined;
    const performance = object(metrics?.performance), calls = array(performance?.modelCalls).map(object);
    const truncation = object(performance?.truncated);
    require(performance?.truncated === undefined || truncation &&
      (truncation.modelCalls === undefined || truncation.modelCalls === 0), 'model_call_coverage_incomplete');
    require(calls.length && calls.every(call => call && RUNTIME_MODEL_CALL_PURPOSES.includes(call.purpose as typeof RUNTIME_MODEL_CALL_PURPOSES[number]) &&
      ['ok', 'error', 'cancelled'].includes(String(call.outcome)) && call.modelHash === hash(String(
      call.purpose === 'classification' ? benchmark.lightModel : benchmark.model))), 'model_calls_unproven');
    // A known classifier cannot identify an unobserved answer/recovery call.
    require(calls.length > 0 && calls.every(call => call?.providerOriginHash === hash(expectedOrigin)), 'actual_provider_unproven');
    require(identity && identity.runtime === benchmark.runtime && validHash(identity.traceSha256) && validHash(identity.expectationHash) &&
      typeof identity.query === 'string' && identity.query.trim().length > 0 &&
      textId(identity.gateSchemaVersion) && textId(identity.verificationSchemaVersion) &&
      typeof identity.traceProcessorVersion === 'string' && /^(?:bundled|custom):[a-f0-9]{40,64}$/.test(identity.traceProcessorVersion) &&
      typeof identity.stdlibRevision === 'string' && /^[a-f0-9]{40,64}$/.test(identity.stdlibRevision), 'oracle_identity_unproven');
    let comparedConfig = raw.configFingerprint;
    let purposeContractFingerprint: string | undefined;
    if (version2) {
      if (!treatment) fail('representation_treatment_unproven');
      const configuration = parseRuntimeBenchmarkConfigCommitments(raw.configuration);
      require(configuration && configuration.legacyConfigFingerprint === raw.configFingerprint &&
        configuration.controlsFingerprint === object(benchmark.treatment)?.controlsFingerprint &&
        object(object(benchmark.treatment)?.sideFullFingerprints)?.[sample.side] === configuration.fullFingerprint &&
        raw.treatmentHash === hash(stableStringify(benchmark.treatment)), 'treatment_config_unproven');
      if (configuration) {
        const proofs = array(raw.preflights), initial = array(benchmark.preflights).filter(value => object(value)?.cellId === sample.cellId && object(value)?.side === sample.side);
        require(proofs.length > 0 && proofs.length === initial.length, 'preflight_coverage_incomplete');
        const current = proofs.map(proof => inspectPreflight(proof, raw, benchmark, root, configuration, true, treatment));
        const earlier = initial.map(proof => inspectPreflight(proof, raw, benchmark, root, configuration, false, treatment));
        require(stableStringify(current) === stableStringify(earlier) && new Set(current.map(item => item.mode)).size === current.length, 'preflight_changed');
        if (current.length) {
          require(current.every(item => stableStringify(item.purposeContracts) === stableStringify(current[0].purposeContracts) &&
            stableStringify(item.resolved) === stableStringify(current[0].resolved)), 'preflight_mode_controls_mismatch');
          purposeContractFingerprint = hash(stableStringify(current[0].purposeContracts));
          sample.purposeControls = inspectActualTransport(raw, benchmark, report, current[0], treatment, require);
        }
        comparedConfig = configuration.controlsFingerprint;
      }
    }
    sample.quality = buildLlmExecutionQuality(report);
    let pendingSourceCollected = false;
    if (sample.cellId === 'source') {
      const repositoryRoot = path.resolve(__dirname, '../../..');
      const context = sourceFacetContext(repositoryRoot), savedCollection = object(raw.sourceFacetCollection);
      const sourceIdentity = stableStringify(raw.sourceFacet) === stableStringify(context.contract) &&
        stableStringify(benchmark.sourceFacet) === stableStringify(context.contract) && benchmark.sourceFacetStatus === 'matched';
      require(sourceIdentity, 'source_facet_identity_unproven');
      let collectionHash: string | undefined;
      if (sourceIdentity && savedCollection?.path === `${sample.pairId}/${sample.side}/${SOURCE_FACET.receiptFile}` &&
          validHash(savedCollection.sha256)) {
        const collection = readJsonFile(scopedPath(root, savedCollection.path as string), 1024 * 1024);
        collectionHash = collection.sha256;
        pendingSourceCollected = collection.sha256 === savedCollection.sha256 &&
          validateSourceFacetCollection({report, reportHash: read.sha256, receipt: collection.value,
            request: targetRequest, lifecycle, repositoryRoot});
      }
      const savedReview = reviews.sourceFacets.get(read.sha256);
      const rawQuality = sample.quality;
      sample.sourceAdjudication = adjudicateLlmSourceFacet({report, collectionEligible: pendingSourceCollected,
        review: savedReview?.review, evidenceSha256: savedReview?.evidenceSha256,
        bindings: {rawReportSha256: read.sha256, collectionReceiptSha256: collectionHash,
          bodyFingerprint: rawQuality.fingerprints.body, contractFingerprint: rawQuality.fingerprints.contract,
          fullQualityFingerprint: rawQuality.fingerprints.full, runId: metrics?.runId, sessionId: metrics?.sessionId,
          provider: pin?.provider, providerSnapshotHash: snapshotHash, modelHash: metrics?.modelHash, runtime: metrics?.runtime,
          ...context.contract},
        sourceEvidence: {filePath: context.groundTruth.relativeSourcePath, symbols: context.groundTruth.callChain,
          lineCount: fs.readFileSync(path.join(context.inputs.sourceRoot, path.basename(context.groundTruth.relativeSourcePath)), 'utf8').split(/\r?\n/).length}});
      sample.quality = sample.sourceAdjudication.effectiveQuality;
      require(pendingSourceCollected, 'source_facet_collection_unproven');
    }
    require(processCompleted || pendingSourceCollected, 'lifecycle_unconfirmed');
    const completion = object(object(object(report.summary)?.terminalAnalysis)?.completion);
    const censored = lifecycle?.censored === true || ['observation_timeout', 'cancelled'].includes(String(lifecycle?.outcome)) ||
      typeof lifecycle?.signal === 'string' || report.errorCode === 'SSE_TIMEOUT' || completion?.status === 'cancelled' ||
      ['cancelled', 'timeout'].includes(String(completion?.reason));
    // A saved native answer does not erase a later verifier/process failure.
    sample.outcome = censored ? 'censored' : (processCompleted || pendingSourceCollected) && completion?.status === 'completed' ? 'completed' : 'failed';
    sample.totalMs = finite(metrics?.wallclockMs) ? metrics.wallclockMs : undefined;
    sample.costs = costObservations(performance);
    sample.comparisonFingerprint = hash(stableStringify({pin, configFingerprint: comparedConfig,
      ...(version2 ? {treatmentHash: raw.treatmentHash, purposeContractFingerprint} : {}),
      taskFingerprint: raw.taskFingerprint, observer: observer?.fingerprint, providerSnapshotHash: snapshotHash,
      runtime: identity?.runtime, traceSha256: identity?.traceSha256, expectationHash: identity?.expectationHash,
      gate: identity?.gateSchemaVersion, verificationSchema: identity?.verificationSchemaVersion,
      queryHash: hash(String(identity?.query)), processor: identity?.traceProcessorVersion, stdlib: identity?.stdlibRevision,
      ...(raw.sourceFacet ? {sourceFacet: raw.sourceFacet} : {})}));
  } catch (error) {
    const reason = error instanceof Error && /^(?:llm_score|report|benchmark_target)_[a-z_]+$/.test(error.message)
      ? error.message : 'sample_evidence_invalid';
    sample.issues.push(reason);
  }
  return sample;
}

export interface ScoreLlmExecutionBenchmarkOptions {input: string; reviews?: string; output: string}

/** Score saved collector evidence only. No provider calls, process launches or product writes. */
export function scoreLlmExecutionBenchmark(options: ScoreLlmExecutionBenchmarkOptions) {
  const input = explicitInput(options.input), saved = readJsonFile(input.file), benchmark = object(saved.value);
  if (!benchmark || !['llm_execution_benchmark@1', 'llm_execution_benchmark@2'].includes(String(benchmark.schemaVersion)) ||
      (benchmark.schemaVersion === 'llm_execution_benchmark@2' ? ![TREATMENT_ID, MIXED_CONTENT_TREATMENT_ID, DUAL_CARRIER_TREATMENT_ID].includes(String(benchmark.candidate)) : benchmark.candidate !== 'llm-execution-v1') ||
      typeof benchmark.nonce !== 'string' || !/^[a-f0-9]{32}$/.test(benchmark.nonce) ||
      !['glm', 'deepseek'].includes(String(benchmark.provider)) ||
      !PRODUCTION_RUNTIME_KINDS.includes(benchmark.runtime as typeof PRODUCTION_RUNTIME_KINDS[number]) ||
      !textId(benchmark.model) || !textId(benchmark.lightModel) || !Array.isArray(benchmark.samples) ||
      benchmark.samples.length > MAX_SAMPLES) fail('llm_score_benchmark_invalid');
  const coverage = object(benchmark.coverage);
  if (!coverage || !Array.isArray(coverage.cells) || !coverage.cells.length ||
      coverage.cells.some(cell => !CELLS.includes(String(cell))) || new Set(coverage.cells).size !== coverage.cells.length ||
      !positiveInteger(coverage.repetitions) || coverage.repetitions < 3 || coverage.repetitions > 30) fail('llm_score_coverage_invalid');
  const requested = coverage.cells as string[], repetitions = coverage.repetitions;
  const artifactIssues: string[] = [];
  let treatment: ValidatedTreatment | undefined;
  if (benchmark.schemaVersion === 'llm_execution_benchmark@2') {
    try {
      const base = benchmark.samples.map(object).find(sample => sample?.side === 'base');
      const candidate = benchmark.samples.map(object).find(sample => sample?.side === 'candidate');
      const described = makeRepresentationTreatment(base?.configuration, candidate?.configuration, String(benchmark.candidate));
      const implementation = treatmentOutputImplementation(String(described.id), 'candidate');
      if (benchmark.runtime !== 'openai-agents-sdk' || implementation.kind !== 'typed' ||
          typeof benchmark.nodeVersion !== 'string' || !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][a-zA-Z0-9.-]+)?$/.test(benchmark.nodeVersion) ||
          stableStringify(described) !== stableStringify(benchmark.treatment)) {
        artifactIssues.push('representation_treatment_unproven');
      } else treatment = {id: String(described.id), candidate: implementation, outputs: treatmentOutputs(String(described.id))};
    } catch {artifactIssues.push('representation_treatment_unproven');}
  }
  if (benchmark.schemaVersion === 'llm_execution_benchmark@2') {
    const starts = benchmark.samples.map(value => object(object(value)?.lifecycle)?.preparedAt);
    const firstPaid = starts.length && starts.every(finite) ? Math.min(...starts as number[]) : undefined;
    const initial = array(benchmark.preflights);
    // All initial gates must precede every paid sample, including the opposite side/another cell.
    if (firstPaid === undefined || !initial.length || initial.some(value => {
      const proof = object(value), process = object(proof?.lifecycle);
      return !proof || !requested.includes(String(proof.cellId)) || !['base', 'candidate'].includes(String(proof.side)) ||
        !finite(process?.settledAt) || process.settledAt > firstPaid;
    })) artifactIssues.push('initial_preflight_not_before_first_sample');
  }
  if (benchmark.measurementOrigin !== 'real_provider') artifactIssues.push('real_provider_origin_unproven');
  if (benchmark.sampleKind !== 'local-cold' || benchmark.lifecycle !== 'collected') artifactIssues.push('collection_incomplete');
  const expectedSamples = requested.length * repetitions * 2;
  if (coverage.scheduledSamples !== expectedSamples || coverage.observedSamples !== benchmark.samples.length ||
      benchmark.samples.length !== expectedSamples) artifactIssues.push('sample_coverage_incomplete');
  const reviews = readReviews(options.reviews);
  const samples: InspectedSample[] = [];
  const sampleKeys = new Set<string>(), sessions = new Set<string>(), runs = new Set<string>(), dataRoots = new Set<string>();
  const sideSources = new Map<string, string>(), sideOrigins = new Map<string, string>();
  for (const raw of benchmark.samples) {
    const value = object(raw);
    if (!value || typeof value.pairId !== 'string' || !ID.test(value.pairId) || !requested.includes(String(value.cellId)) ||
        !positiveInteger(value.repetition) || value.repetition > repetitions || !['base', 'candidate'].includes(String(value.side))) {
      artifactIssues.push('sample_shape_invalid'); continue;
    }
    const key = `${value.cellId}:${value.repetition}:${value.side}`;
    const sample = inspectSample(value, benchmark, input.root, reviews, treatment);
    if (sampleKeys.has(key)) sample.issues.push('duplicate_sample');
    sampleKeys.add(key);
    if (sample.sessionId && sessions.has(sample.sessionId) || sample.runId && runs.has(sample.runId)) sample.issues.push('session_not_fresh');
    if (sample.dataRootHash && dataRoots.has(sample.dataRootHash)) sample.issues.push('data_root_not_fresh');
    if (sample.sessionId) sessions.add(sample.sessionId);
    if (sample.runId) runs.add(sample.runId);
    if (sample.dataRootHash) dataRoots.add(sample.dataRootHash);
    for (const [value, seen, code] of [[sample.sourceFingerprint, sideSources, 'source_changed'],
      [sample.origin, sideOrigins, 'target_origin_changed']] as const) {
      if (!value) continue;
      if (seen.has(sample.side) && seen.get(sample.side) !== value) sample.issues.push(code);
      seen.set(sample.side, value);
    }
    samples.push(sample);
  }
  const cells = requested.map(cellId => {
    const selected = samples.filter(sample => sample.cellId === cellId);
    const pairs: LlmExecutionLatencyPair[] = [];
    const pairDetails: Array<{repetition: number; issues: string[]; quality?: ReturnType<typeof compareLlmExecutionQuality>}> = [];
    for (let repetition = 1; repetition <= repetitions; repetition++) {
      const candidates = selected.filter(sample => sample.repetition === repetition);
      const base = candidates.find(sample => sample.side === 'base'), candidate = candidates.find(sample => sample.side === 'candidate');
      if (!base || !candidate || candidates.length !== 2) {pairDetails.push({repetition, issues: ['pair_incomplete']}); continue;}
      const issues = [...base.issues, ...candidate.issues];
      if (base.pairId !== candidate.pairId || base.origin === candidate.origin || !base.comparisonFingerprint ||
          base.comparisonFingerprint !== candidate.comparisonFingerprint) issues.push('pair_identity_mismatch');
      if (benchmark.schemaVersion === 'llm_execution_benchmark@2') {
        const before = base.purposeControls ?? {}, after = candidate.purposeControls ?? {};
        for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
          if (before[key] && after[key] && stableStringify(before[key]) !== stableStringify(after[key])) issues.push('paired_actual_controls_mismatch');
          if ((!before[key] || !after[key]) && key === 'main_dispatch:answer_turn') issues.push('main_actual_controls_missing');
        }
      }
      if (!base.sourceFingerprint || !candidate.sourceFingerprint || base.sourceFingerprint === candidate.sourceFingerprint) issues.push('different_sources_unproven');
      const observerReview = reviews.observers.find(review => review.baselineSourceFingerprint === base.sourceFingerprint &&
        review.candidateSourceFingerprint === candidate.sourceFingerprint && review.coreFingerprint === base.observerCore &&
        review.coreFingerprint === candidate.observerCore && review.evidenceSha256 === base.observerReviewHash &&
        review.evidenceSha256 === candidate.observerReviewHash);
      if (!observerReview) issues.push('observer_review_required');
      const material = reviews.materials.get(`${base.reportHash}:${candidate.reportHash}:${base.quality.fingerprints.full}:${candidate.quality.fingerprints.full}`);
      const quality = compareLlmExecutionQuality(base.quality, candidate.quality, material);
      pairDetails.push({repetition, issues: [...new Set(issues)], quality});
      pairs.push({pairId: base.pairId, comparisonFingerprint: base.comparisonFingerprint ?? '',
        sampleKind: benchmark.measurementOrigin === 'real_provider' ? 'real_provider' : 'synthetic',
        lifecycle: issues.length || artifactIssues.length ? 'inconclusive' : 'matched', quality,
        baseline: {outcome: base.outcome, totalMs: base.totalMs}, candidate: {outcome: candidate.outcome, totalMs: candidate.totalMs}});
    }
    const performance = scoreLlmExecutionLatency(pairs.length === repetitions ? pairs
      : pairs.map(pair => ({...pair, lifecycle: 'inconclusive' as const})));
    const qualityAdmission = pairDetails.some(pair => pair.quality?.status === 'failed') ? 'failed'
      : pairDetails.length === repetitions && pairDetails.every(pair => !pair.issues.length && pair.quality?.status === 'passed') &&
        !artifactIssues.length ? 'passed' : 'inconclusive';
    return {cellId, qualityAdmission, performance, pairs: pairDetails,
      candidateAbsoluteAcceptance: {passed: selected.filter(sample => sample.side === 'candidate' && !sample.issues.length && sample.quality.status === 'passed').length,
        observed: selected.filter(sample => sample.side === 'candidate').length, required: repetitions},
      samples: selected.map(sample => ({side: sample.side, repetition: sample.repetition, issues: sample.issues,
        outcome: sample.outcome, quality: sample.quality.status, totalMs: sample.totalMs, costs: sample.costs,
        ...(sample.sourceAdjudication ? sample.sourceAdjudication : {})}))};
  });
  const completeCoverage = CELLS.every(cell => requested.includes(cell));
  const status = cells.some(cell => cell.qualityAdmission === 'failed' || cell.performance.status === 'failed') ? 'failed'
    : completeCoverage && !artifactIssues.length && cells.every(cell => cell.qualityAdmission === 'passed' && cell.performance.status === 'passed')
      ? 'passed' : 'inconclusive';
  const result = {schemaVersion: 'llm_execution_score@1', status, inputSha256: saved.sha256,
    ...(reviews.indexHash ? {reviewsSha256: reviews.indexHash} : {}),
    measurementOrigin: benchmark.measurementOrigin === 'real_provider' ? 'real_provider' : 'unproven',
    coverage: {selectedCells: requested, requiredCells: CELLS, complete: completeCoverage, repetitions},
    issues: [...new Set([...artifactIssues, ...reviews.issues])], cells,
    limitations: ['overall_latency_only_target_phase_not_predeclared', 'provider_cache_not_controlled',
      'review_provenance_is_local_attestation_not_cryptographic_authority', 'p95_inconclusive']};
  const output = outputWithinRoot(input.root, options.output);
  try {fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, {flag: 'wx', mode: 0o600});}
  catch {fail('llm_score_output_unavailable');}
  return result;
}

export function parseLlmExecutionScoreArgs(argv: readonly string[]): ScoreLlmExecutionBenchmarkOptions | {help: true} {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) return {help: true};
  const values: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index], value = argv[index + 1];
    if (!['--input', '--reviews', '--output'].includes(flag) || Object.prototype.hasOwnProperty.call(values, flag) || !value || value.startsWith('--')) {
      fail('llm_score_arguments_invalid');
    }
    values[flag] = value;
  }
  if (!values['--input'] || !values['--output']) fail('llm_score_arguments_invalid');
  return {input: values['--input'], output: values['--output'], ...(values['--reviews'] ? {reviews: values['--reviews']} : {})};
}

export const scoreLlmExecutionBenchmarkTesting = {purposeSettingsMatch};

if (require.main === module) {
  try {
    const options = parseLlmExecutionScoreArgs(process.argv.slice(2));
    if ('help' in options) console.log('Usage: scoreLlmExecutionBenchmark --input <benchmark.json> [--reviews <review-index.json>] --output <fresh file inside benchmark directory>');
    else {
      const result = scoreLlmExecutionBenchmark(options);
      console.log(JSON.stringify({schemaVersion: result.schemaVersion, status: result.status, cells: result.cells.length}));
      if (result.status !== 'passed') process.exitCode = 1;
    }
  } catch {
    console.error('LLM benchmark scoring failed: invalid, missing or unsafe local evidence.');
    process.exitCode = 2;
  }
}
