// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {parseStoredJson} from '../utils/storedData';
import {stableStringify} from '../utils/stableJson';
import {PRODUCTION_RUNTIME_KINDS} from '../agentRuntime/runtimeKinds';
import {RUNTIME_MODEL_CALL_PURPOSES} from '../agentRuntime/runtimePerformance';
import {adjudicateLlmSourceFacet, buildLlmExecutionQuality, compareLlmExecutionQuality, elapsedIntervalUnion, scoreLlmExecutionLatency,
  type LlmExecutionQuality, type LlmExecutionLatencyPair, type LlmMaterialChangeReview} from './llmExecutionBenchmark';

const {CELLS, SOURCE_FACET, sourceFacetContext, validateSourceFacetCollection, assertExecutionTarget} = require('../../scripts/llm-execution-lifecycle.cjs') as {
  CELLS: readonly string[];
  SOURCE_FACET: {receiptFile: string; reviewSchema: string};
  sourceFacetContext(root: string): {contract: Record<string, unknown>; inputs: {sourceRoot: string};
    groundTruth: {relativeSourcePath: string; callChain: string[]}};
  validateSourceFacetCollection(input: {report: unknown; reportHash: string; receipt: unknown;
    request: Record<string, unknown>; lifecycle: unknown; repositoryRoot: string}): boolean;
  assertExecutionTarget(target: unknown, request: Record<string, unknown>, processId: number): void;
};
type RecordValue = Record<string, unknown>;
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

function inspectSample(raw: RecordValue, benchmark: RecordValue, root: string, reviews: SavedReviews): InspectedSample {
  const sample: InspectedSample = {pairId: raw.pairId as string, cellId: raw.cellId as string,
    repetition: raw.repetition as number, side: raw.side as 'base' | 'candidate',
    issues: [], quality: buildLlmExecutionQuality(undefined), outcome: 'censored'};
  const require = (condition: unknown, code: string) => {if (!condition) sample.issues.push(code);};
  try {
    require(raw.schemaVersion === 'llm_execution_sample@1' && raw.nonce === benchmark.nonce &&
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
    const targetRequest = {nonce: benchmark.nonce, side: raw.side, pairId: raw.pairId, cellId: raw.cellId,
      repetition: raw.repetition, port: Number(port), expectedSourceFingerprint: raw.sourceFingerprint,
      observerFingerprint: observer?.fingerprint, configFingerprint: raw.configFingerprint,
      dataRootHash: reset?.dataRootHash, ...(raw.sourceFacet ? {sourceFacet: raw.sourceFacet} : {})};
    assertExecutionTarget(target, targetRequest, Number(lifecycle?.processId));
    require(target?.schemaVersion === 'llm_execution_target@1' && Number(port) >= 1024 && Number(port) <= 65535,
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
    sample.comparisonFingerprint = hash(stableStringify({pin, configFingerprint: raw.configFingerprint,
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
  if (!benchmark || benchmark.schemaVersion !== 'llm_execution_benchmark@1' || benchmark.candidate !== 'llm-execution-v1' ||
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
    const sample = inspectSample(value, benchmark, input.root, reviews);
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
