// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {afterEach, describe, expect, it, jest} from '@jest/globals';
import path from 'path';
import fs from 'fs/promises';
import os from 'os';
import express from 'express';
import request from 'supertest';
import {createLoopbackServerFixture} from '../../../../tests/helpers/loopbackServer';
import {randomUUID} from 'crypto';
import {once} from 'events';
import {WorkingTraceProcessor, TraceProcessorFactory} from '../../workingTraceProcessor';
import {TraceProcessorService, setTraceProcessorServiceForTests} from '../../traceProcessorService';
import {getPortPool, resetPortPool} from '../../portPool';
import {getTraceProcessorLeaseStore, setTraceProcessorLeaseStoreForTests} from '../../traceProcessorLeaseStore';
import {prepareAnalysisRunTraceProcessorLeases, type AnalysisRunTraceProcessorLeases} from '../../analysisRunTraceProcessorLease';
import {DEFAULT_DEV_USER_ID, DEFAULT_TENANT_ID, DEFAULT_WORKSPACE_ID} from '../../../utils/localDevIdentity';
import {resolveRuntimeTurnPolicy} from '../../../agentRuntime/runtimeTurnPolicy';
import {probeTraceCompleteness} from '../../../agentv3/traceCompletenessProber';
import {detectFocusApps} from '../../../agentv3/focusAppDetector';
import {ENTERPRISE_FEATURE_FLAG_ENV} from '../../../config';
import traceRoutes from '../../../routes/simpleTraceRoutes';
import type {SkillExecutor} from '../../skillEngine/skillExecutor';
import type {DataEnvelope} from '../../../types/dataContract';
import {ArtifactStore} from '../../../agentv3/artifactStore';
import {createClaudeMcpServer} from '../../../agentv3/claudeMcpServer';
import {parseConclusionContractDeclaration, renderConclusionContractSidecar, type ConclusionContract} from '../../../agent/core/conclusionContract';
import type {AnalysisResult} from '../../../agent/core/orchestratorTypes';
import {attachFinalizationContext, takeFinalizationContext} from '../../../agentRuntime/analysisFinalizationContext';
import {buildStrategyRegistrySnapshotFromDefinitions} from '../../../agentv3/strategyLoader';
import {analysisDeliveryFingerprint} from '../../../types/analysisDelivery';
import {defaultDeliveryCallEstimateMs} from '../../runtimeCallStats';
import {finalizeSourceAwareAnalysisResultWithProjection} from '../../codebase/sourceClaimVerifier';
import {finalizeAnalysisResult} from '../../finalizeAnalysisResult';
import {canonicalizeAnalysisResult} from '../../canonicalAnalysisResult';
import {projectOwnerAnalysisResult, copyAnalysisResultForSnapshot} from '../../security/privateAnalysisProjection';
import {prepareClaimEvidence} from '../claimEvidencePreparation';
import {getCapturedAnchorFacts} from '../evidenceCapture';
import {readRawSqlCaptureMetadata} from '../rawSqlNativeProvenance';
import {runClaimVerification} from '../../verifier/claimVerificationRunner';
import type {EvidenceReadView} from '../evidenceReadView';

const loopbackServers = createLoopbackServerFixture();

jest.setTimeout(120_000);
const processors: WorkingTraceProcessor[] = [];
afterEach(() => {for (const processor of processors.splice(0)) processor.destroy();});

async function finalizeCapturedNativeResult(contract: ConclusionContract, evidenceReadView: EvidenceReadView,
  dataEnvelopes: DataEnvelope[], traceId: string, traceSide: 'current' | 'reference'): Promise<AnalysisResult> {
  const body = contract.claims![0].text;
  const result: AnalysisResult = {sessionId: `native-final-${randomUUID()}`, conclusion: `${body}\n${renderConclusionContractSidecar(contract)}`,
    success: true, confidence: 0.8, findings: [], hypotheses: [], rounds: 1, totalDurationMs: 1};
  const candidate = {runId: 'native-run', attemptId: 'native-attempt', candidateRef: 'native-candidate',
    conclusionFingerprint: analysisDeliveryFingerprint(result.conclusion)};
  const nativeDelivery = {entry: 'runtime_draft' as const, acceptedCandidate: candidate, outputOrigin: 'sdk_final' as const,
    completion: {...candidate, schemaVersion: 1 as const, runtimeKind: 'openai-agents-sdk' as const, status: 'completed' as const}};
  const projection = finalizeSourceAwareAnalysisResultWithProjection(result, undefined, {context: nativeDelivery});
  expect(projection.protocolProjection).toBeDefined();
  const semanticBody = canonicalizeAnalysisResult(result).result.conclusion;
  const registry = buildStrategyRegistrySnapshotFromDefinitions({definitions: [], overlayGeneration: 'native-final'});
  const controller = new AbortController();
  // The semantic review is budget-gated: a bounded-answer review is dispatched
  // only when the remaining deadline covers its estimate, so keep a budget
  // derived from the same default the gate falls back to without samples.
  const reviewBudgetMs = defaultDeliveryCallEstimateMs(undefined) + 30_000;
  attachFinalizationContext(result, {runId: candidate.runId, sessionId: result.sessionId, deadlineMs: Date.now() + reviewBudgetMs,
    strategyRegistry: registry, traceIdentity: {currentTraceId: traceSide === 'current' ? traceId : 'unused-current-trace',
      ...(traceSide === 'reference' ? {referenceTraceId: traceId} : {})}, protocolProjection: projection.protocolProjection,
    deliveryContext: projection.deliveryContext!, evidenceReadView,
    turnIntent: {schemaVersion: 1, status: 'resolved', source: 'semantic', registryFingerprint: registry.registryFingerprint,
      taskKind: 'fact', sceneId: 'general', scope: 'bounded_question', recommendedComplexity: 'quick', deliverable: 'answer', evidenceAccess: 'existing_only'},
    dispatchText: async () => ({status: 'ok', text: JSON.stringify({schemaVersion: 'final_semantic_response@1',
      bodyCoverage: {status: 'complete', reviewedSpans: [{start: 0, end: semanticBody.length}]},
      claims: [{claimId: contract.claims![0].id, consistency: 'consistent',
        contentLocations: [{start: semanticBody.indexOf(body), end: semanticBody.indexOf(body) + body.length, text: body}], issues: []}],
      omissions: [], requirements: []})})});
  const context = takeFinalizationContext(result)!;
  expect(context.getNativeDeclaration(result, controller.signal)).toBeDefined();
  const finalized = await finalizeAnalysisResult({result, context,
    owner: {runId: candidate.runId, signal: controller.signal, isCurrent: () => true, assertAuthorized: () => {}},
    query: 'What is the captured duration?', dataEnvelopes});
  expect(finalized.result.claimVerificationResult?.passed).toBe(true);
  expect(finalized.result.deliveryAssurance?.claims).toBe('passed');
  // The durable owner surface keeps the review trace and the verification it
  // produced; the raw projector without an owner audience is strict-only.
  const projected = projectOwnerAnalysisResult(result.sessionId, finalized.result, 'en');
  expect(projectOwnerAnalysisResult(result.sessionId, projected, 'en')).toEqual(projected);
  const exported = JSON.parse(JSON.stringify(copyAnalysisResultForSnapshot(projected))) as AnalysisResult;
  expect(exported.claimVerificationResult).toEqual(finalized.result.claimVerificationResult);
  expect(exported.deliveryAssurance?.claims).toBe('passed');
  return exported;
}

async function fixture(toolName: 'execute_sql' | 'execute_sql_on') {
  const traceId = `unit-capture-${randomUUID()}`;
  const processor = new WorkingTraceProcessor(traceId, path.resolve(process.cwd(),
    '../Trace/.generated/constructed/source-analysis-semantic/trace.pftrace'));
  processors.push(processor);
  await processor.initialize();
  const {execute} = captureFixture({query: async (id: string, sql: string, options: unknown) => {
    expect(id).toBe(traceId);
    return processor.query(sql, options as Parameters<WorkingTraceProcessor['query']>[1]);
  }} as unknown as TraceProcessorService, traceId, toolName);
  return {processor, execute};
}

function captureFixture(service: TraceProcessorService, traceId: string, toolName: 'execute_sql' | 'execute_sql_on') {
  const artifactStore = new ArtifactStore();
  const envelopes: DataEnvelope[] = [];
  const traceSide = toolName === 'execute_sql_on' ? 'reference' as const : 'current' as const;
  const mcp = createClaudeMcpServer({
    traceId: traceSide === 'current' ? traceId : 'unused-current-trace',
    ...(traceSide === 'reference' ? {referenceTraceId: traceId,
      comparisonContext: {referenceTraceId: traceId, commonCapabilities: ['slice']}} : {}),
    traceProcessorService: service,
    skillExecutor: {setRunManifestAttributionSink: () => {}} as unknown as SkillExecutor,
    artifactStore, analysisNotes: [], hypotheses: [], uncertaintyFlags: [],
    emitUpdate: update => {if (update.type === 'data' && Array.isArray(update.content)) {
      envelopes.push(...update.content as DataEnvelope[]);
    }},
  });
  const handler = mcp.toolDefinitions.find(tool => tool.name === toolName)!.shared.handler;
  async function execute(sql: string, column: string, expected: number, withExecutionIdentity = true, terminalProjection = false) {
    envelopes.length = 0;
    await handler({sql, ...(traceSide === 'reference' ? {trace: 'reference'} : {})}, {});
    expect(envelopes).toHaveLength(1);
    const envelope = envelopes[0];
    expect(envelope.meta.sourceToolCallId).toEqual(expect.any(String));
    const ref = {evidenceRefId: envelope.meta.evidenceRefId!, rowIndex: 0, column, value: expected,
      ...(withExecutionIdentity ? {sourceToolCallId: envelope.meta.sourceToolCallId} : {})};
    const contract = parseConclusionContractDeclaration({schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer',
      conclusions: [], clusters: [], evidenceChain: [], uncertainties: [], nextSteps: [],
      claims: [{id: 'duration', text: `The returned duration is ${expected} ns.`, kind: 'numeric', references: [ref],
        semantics: {schemaVersion: 'claim_semantics@1', predicate: 'numeric.cell', polarity: 'affirmed',
          discourse: 'asserted', quantifier: 'one', modality: 'certain',
          scope: {population: 'cited_rows', subjectRefs: [ref]}, numeric: {operator: 'eq', value: expected, unit: 'ns'}}}],
    }).contract!;
    const view = artifactStore.createEvidenceReadView({ownerKey: 'raw-sql-capture-test',
      allowedTraces: [{traceId, traceSide}]});
    const prepared = await prepareClaimEvidence({conclusionContract: contract, evidenceReadView: view,
      bindingEligibility: 'eligible'});
    const verified = runClaimVerification({conclusionContract: contract, dataEnvelopes: envelopes,
      preparedEvidence: prepared, bindingEligibility: 'eligible'});
    return {...verified, ...(terminalProjection ? {terminalResult: await finalizeCapturedNativeResult(contract, view,
      [...envelopes], traceId, traceSide)} : {})};
  }
  return {execute};
}

const filter = "WHERE name = 'StartupHooks.initializeOnMainThread#before-first-frame-sync-policy' LIMIT 1";
describe('pinned native raw SQL -> MCP capture -> numeric proof', () => {
  it('preserves later direct ID and duration proof after actual bounded scalar and IN subqueries', async () => {
    const {processor, execute} = await fixture('execute_sql');
    for (const predicate of [`t.id = (SELECT track_id FROM slice ${filter})`,
      `t.id IN (SELECT track_id FROM slice ${filter})`]) {
      const nested = await processor.query(`SELECT t.id AS track_id FROM track t WHERE ${predicate}`);
      expect(nested.error).toBeUndefined();
      expect(nested.rows).toHaveLength(1);
      expect(readRawSqlCaptureMetadata(nested)).toBeUndefined();
      expect(processor.getNativeProvenanceSnapshot().status).toBe('trusted');
      const direct = await execute(`SELECT id, dur FROM slice ${filter}`, 'dur', 42_000_000);
      expect(direct.claimVerificationResult.claimResults[0].deterministicProof).toMatchObject({status: 'proved',
        nativeRows: [{relation: 'slice', idColumn: 'id', traceId: processor.traceId}]});
      expect(getCapturedAnchorFacts(direct.claimSupport[0].anchors[0])?.fields.dur)
        .toMatchObject({unit: 'ns', origin: {kind: 'native_producer'}});
    }
    await processor.query("SELECT (SELECT run_metric('smartperfetto_nonexistent_subquery_probe.sql'))");
    expect(processor.getNativeProvenanceSnapshot().status).toBe('tainted');
    const later = await execute(`SELECT id, dur FROM slice ${filter}`, 'dur', 42_000_000);
    expect(later.claimVerificationResult.claimResults[0].deterministicProof).toMatchObject({status: 'candidate', reason: 'unit_authority_unknown'});
  });

  it.each(['execute_sql', 'execute_sql_on'] as const)('retains authoritative duration units through %s', async tool => {
    const {execute} = await fixture(tool);
    for (const [projection, column] of [['dur', 'dur'], ['s.dur AS duration_ns', 'duration_ns'], ['s.*', 'dur']]) {
      const result = await execute(`SELECT ${projection} FROM slice AS s ${filter}`, column, 42_000_000);
      expect(result.claimVerificationResult.claimResults[0].deterministicProof?.reason).toBe('numeric_operator_proved');
      expect(result.claimVerificationResult.claimResults[0].deterministicProof)
        .toMatchObject({kind: 'numeric_cell', status: 'proved'});
      const facts = getCapturedAnchorFacts(result.claimSupport[0].anchors[0]);
      expect(facts?.fields[column]).toMatchObject({unit: 'ns', origin: {kind: 'native_producer'}});
      expect(facts?.fields[column]).not.toHaveProperty('clock');
      expect(facts?.fields[column]).not.toHaveProperty('timeRole');
      expect(result.claimVerificationResult.passed).toBe(false); // Semantic join is still required.
    }
  });

  it('does not infer units from an expression alias or revive trust after a mutation', async () => {
    const {processor, execute} = await fixture('execute_sql');
    const expression = await execute(`SELECT dur / 1000000 AS dur FROM slice ${filter}`, 'dur', 42);
    expect(expression.claimVerificationResult.claimResults[0].deterministicProof?.status).not.toBe('proved');
    expect(expression.claimVerificationResult.claimResults[0].deterministicProof?.reason).toBe('unit_authority_unknown');
    await processor.query('CREATE PERFETTO TABLE unit_test_taint AS SELECT 1 AS value');
    await processor.query('DROP TABLE unit_test_taint');
    const after = await execute(`SELECT dur FROM slice ${filter}`, 'dur', 42_000_000);
    expect(after.claimVerificationResult.claimResults[0].deterministicProof?.reason).toBe('unit_authority_unknown');
  });

  it.each(['execute_sql', 'execute_sql_on'] as const)('retains actual canonical row identity through %s and ignores computed IDs', async tool => {
    const {processor, execute} = await fixture(tool);
    const expectedId = (await processor.query(`SELECT id FROM slice ${filter}`)).rows[0][0];
    expect(Number.isSafeInteger(expectedId)).toBe(true);
    expect(expectedId).toBeGreaterThanOrEqual(0);
    for (const projection of ['id, dur', 's.id AS event_id, dur, ts + dur AS end_ts', 's.*']) {
      const result = await execute(`SELECT ${projection} FROM slice s ${filter}`, 'dur', 42_000_000, true, true);
      const anchor = result.claimSupport[0].anchors[0];
      const proof = result.claimVerificationResult.claimResults[0].deterministicProof!;
      expect(proof).toMatchObject({status: 'proved', nativeRows: [{id: expectedId, relation: 'slice', idColumn: 'id',
        traceId: processor.traceId, traceSide: tool === 'execute_sql_on' ? 'reference' : 'current',
        anchorId: anchor.anchorId, evidenceRefId: anchor.evidenceRefId, captureId: anchor.context.captureId,
        schemaFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/)}]});
      expect(anchor.context.captureId).toEqual(getCapturedAnchorFacts(anchor)?.captureId);
      expect(result.claimVerificationResult.passed).toBe(false);
      const terminalProof = result.terminalResult!.claimVerificationResult!.claimResults[0].deterministicProof!;
      const terminalAnchor = result.terminalResult!.claimSupport![0].anchors[0];
      expect(terminalProof.nativeRows).toEqual(proof.nativeRows);
      expect(terminalProof.nativeRows![0].captureId).toBe(terminalAnchor.context.captureId);
    }
    for (const projection of [`${expectedId} AS id, dur`, 'id + 0 AS id, dur', 'dur']) {
      const result = await execute(`SELECT ${projection} FROM slice ${filter}`, 'dur', 42_000_000);
      const proof = result.claimVerificationResult.claimResults[0].deterministicProof!;
      expect(proof.status).toBe('proved'); // The duration is direct even when the companion is not.
      expect(proof.nativeRows).toBeUndefined();
    }
    await processor.query('CREATE PERFETTO TABLE row_identity_taint AS SELECT 1');
    const tainted = await execute(`SELECT id, dur FROM slice ${filter}`, 'dur', 42_000_000);
    expect(tainted.claimVerificationResult.claimResults[0].deterministicProof?.nativeRows).toBeUndefined();
  });

  it('preserves bounded-question units through real personal upload, private run and stats polling, then releases the private processor', async () => {
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'smartperfetto-personal-native-capture-'));
    const envKeys = [ENTERPRISE_FEATURE_FLAG_ENV, 'SMARTPERFETTO_ENTERPRISE_DB_PATH', 'SMARTPERFETTO_DATA_DIR', 'UPLOAD_DIR',
      'SMARTPERFETTO_API_KEY', 'SMARTPERFETTO_SSO_TRUSTED_HEADERS', 'SMARTPERFETTO_OIDC_ISSUER_URL',
      'SMARTPERFETTO_OIDC_CLIENT_ID', 'SMARTPERFETTO_OIDC_CLIENT_SECRET', 'SMARTPERFETTO_OIDC_REDIRECT_URI',
      'SMARTPERFETTO_ENTERPRISE_MIGRATION_PHASE', 'SMARTPERFETTO_ENTERPRISE_CUTOVER_CONFIRMED'];
    const previousEnv = new Map(envKeys.map(key => [key, process.env[key]]));
    let leases: AnalysisRunTraceProcessorLeases | undefined;
    let service: TraceProcessorService | undefined;
    try {
      for (const key of envKeys) delete process.env[key];
      process.env[ENTERPRISE_FEATURE_FLAG_ENV] = 'false';
      process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'false';
      process.env.SMARTPERFETTO_ENTERPRISE_DB_PATH = path.join(temporaryRoot, 'enterprise.sqlite');
      process.env.SMARTPERFETTO_DATA_DIR = path.join(temporaryRoot, 'data');
      process.env.UPLOAD_DIR = path.join(temporaryRoot, 'uploads');
      service = new TraceProcessorService(path.join(temporaryRoot, 'uploads', 'traces'));
      setTraceProcessorServiceForTests(service);
      const app = express();
      app.use(express.json());
      app.use('/api/traces', traceRoutes);
      const server = await loopbackServers.listen(app);
      const upload = await request(server).post('/api/traces/upload').attach('file', path.resolve(process.cwd(),
        '../Trace/.generated/constructed/source-analysis-semantic/trace.pftrace'));
      expect(upload.status).toBe(200);
      expect(upload.body.success).toBe(true);
      const traceId = upload.body.trace.id as string;
      const sharedPort = upload.body.trace.port as number;
      expect(sharedPort).toEqual(expect.any(Number));
      expect(service.getAnalysisRunProcessorPolicy(traceId)).toEqual({
        sourceKind: 'local_file', requiresIsolation: true, reason: 'shared_tainted',
      });
      const shared = TraceProcessorFactory.get(traceId);
      const scope = {tenantId: DEFAULT_TENANT_ID, workspaceId: DEFAULT_WORKSPACE_ID, userId: DEFAULT_DEV_USER_ID};
      const controller = new AbortController();
      leases = await prepareAnalysisRunTraceProcessorLeases({service, scope, runId: randomUUID(), sessionId: randomUUID(),
        currentTraceId: traceId, signal: controller.signal, assertCurrent: () => controller.signal.throwIfAborted()});
      expect(leases.entries).toHaveLength(1);
      const entry = leases.entries[0];
      expect(entry.privateProcessor).toBe(true);
      expect(entry.context.mode).toBe('isolated');
      const privateKey = `${traceId}:lease:${entry.lease.id}`;
      const privateProcessor = TraceProcessorFactory.get(privateKey) as WorkingTraceProcessor;
      expect(privateProcessor.analysisRunPrivate).toBe(true);
      expect(privateProcessor.httpPort).not.toBe(sharedPort);
      const {execute} = captureFixture(service, traceId, 'execute_sql');
      const boundedIntent = {schemaVersion: 1 as const, status: 'resolved' as const, source: 'semantic' as const,
        registryFingerprint: 'personal-native-test', taskKind: 'investigation' as const, sceneId: 'general',
        scope: 'bounded_question' as const, recommendedComplexity: 'full' as const,
        deliverable: 'answer' as const, evidenceAccess: 'read_new' as const};
      expect(resolveRuntimeTurnPolicy(boundedIntent, 'full').allowMemoryPrefetch).toBe(false);
      await leases.run(async () => {
        for (const phase of ['before_stats', 'after_stats']) {
          const proof = await execute(`SELECT id, dur FROM slice ${filter}`, 'dur', 42_000_000);
          expect({phase, reason: proof.claimVerificationResult.claimResults[0].deterministicProof?.reason})
            .toEqual({phase, reason: 'numeric_operator_proved'});
          expect(proof.claimVerificationResult.passed).toBe(false); // Does not bypass semantic verification.
          expect(proof.claimVerificationResult.claimResults[0].deterministicProof?.nativeRows)
            .toMatchObject([{traceId, traceSide: 'current', relation: 'slice', idColumn: 'id', id: expect.any(Number)}]);
          if (phase === 'before_stats') {
            const stats = await request(server).get('/api/traces/stats');
            expect(stats.status).toBe(200);
            expect(stats.body.stats.processors.count).toBe(2);
            expect(stats.body.stats.processors.items.map((item: {httpPort: number}) => item.httpPort)).toEqual([sharedPort]);
            expect(stats.body.stats.portPool.allocations.map((item: {port: number}) => item.port)).toEqual([sharedPort]);
          }
        }

        // Repeated SQL has a stable evidence ID but a different execution ID.
        // Omitting that discriminator must remain ambiguous, not select "latest".
        const ambiguous = await execute(`SELECT id, dur FROM slice ${filter}`, 'dur', 42_000_000, false);
        expect(ambiguous.claimVerificationResult.claimResults[0].deterministicProof?.reason).toBe('execution_capture_missing');
        expect(privateProcessor.getNativeProvenanceSnapshot().status).toBe('trusted');

        // Actual full-scene preparation starts with focus detection, whose
        // ordinary stdlib INCLUDE cannot preserve native-only provenance.
        expect(resolveRuntimeTurnPolicy({...boundedIntent, scope: 'scene_wide'}, 'full').allowMemoryPrefetch).toBe(true);
        await detectFocusApps(service!, traceId);
        expect(privateProcessor.getNativeProvenanceSnapshot().status).toBe('tainted');
        await probeTraceCompleteness(service!, traceId);
        const afterPrefetch = await execute(`SELECT dur FROM slice ${filter}`, 'dur', 42_000_000);
        expect(afterPrefetch.claimVerificationResult.claimResults[0].deterministicProof?.reason).toBe('unit_authority_unknown');
      });
      const portReleased = once(getPortPool(), 'released', {signal: AbortSignal.timeout(5000)});
      leases.release();
      const [releasedPort] = await portReleased;
      expect(releasedPort).toMatchObject({traceId: privateKey, port: privateProcessor.httpPort});
      const storedLease = getTraceProcessorLeaseStore().getLeaseById(scope, entry.lease.id);
      expect(storedLease?.holderCount).toBe(0);
      expect(storedLease?.state).toBe('released');
      expect(TraceProcessorFactory.get(privateKey)).toBeUndefined();
      expect(getPortPool().getStats().allocations.some(allocation => allocation.traceId === privateKey)).toBe(false);
      expect(TraceProcessorFactory.get(traceId)).toBe(shared);
      const viewer = await request(server).get(`/api/traces/${traceId}`);
      expect(viewer.status).toBe(200);
      expect(viewer.body.trace.port).toBe(sharedPort);
      const uiStatus = await fetch(`http://127.0.0.1:${sharedPort}/status`);
      expect(uiStatus.ok).toBe(true);
      expect((await uiStatus.arrayBuffer()).byteLength).toBeGreaterThan(0);
      expect((await service.query(traceId, `SELECT dur FROM slice ${filter}`)).rows).toEqual([[42_000_000]]);
    } finally {
      leases?.release();
      if (service) service.cleanupProcessorsForTraces(service.getAllTraces().map(trace => trace.id));
      TraceProcessorFactory.cleanup();
      resetPortPool();
      setTraceProcessorServiceForTests(null);
      getTraceProcessorLeaseStore().close();
      setTraceProcessorLeaseStoreForTests(null);
      await loopbackServers.close();
      for (const [key, value] of previousEnv) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      await fs.rm(temporaryRoot, {recursive: true, force: true});
    }
  });
});
