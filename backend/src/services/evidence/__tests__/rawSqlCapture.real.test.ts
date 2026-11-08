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
import {on} from 'events';
import {WorkingTraceProcessor, TraceProcessorFactory} from '../../workingTraceProcessor';
import {TraceProcessorService, setTraceProcessorServiceForTests} from '../../traceProcessorService';
import {getPortPool, resetPortPool} from '../../portPool';
import {getTraceProcessorLeaseStore, setTraceProcessorLeaseStoreForTests} from '../../traceProcessorLeaseStore';
import {prepareAnalysisRunTraceProcessorLeases, type AnalysisRunTraceProcessorLeases} from '../../analysisRunTraceProcessorLease';
import {DEFAULT_DEV_USER_ID, DEFAULT_TENANT_ID, DEFAULT_WORKSPACE_ID} from '../../../utils/localDevIdentity';
import {resolveRuntimeTurnPolicy} from '../../../agentRuntime/runtimeTurnPolicy';
import {RuntimeExecutionGuard, type RuntimeExecutionLease} from '../../../agentRuntime/runtimeExecutionGuard';
import {createRuntimeRunAuthorization} from '../../../agentRuntime/runAuthorizationFence';
import {buildAnalysisContextAuthorizationFingerprint} from '../../resolvedAnalysisContext';
import {getDefaultCodebaseRegistry, resetDefaultCodebaseRegistryForTests} from '../../codebase/defaultCodebaseServices';
import {probeTraceCompleteness} from '../../../agentv3/traceCompletenessProber';
import {detectFocusApps} from '../../../agentv3/focusAppDetector';
import {ENTERPRISE_FEATURE_FLAG_ENV} from '../../../config';
import traceRoutes from '../../../routes/simpleTraceRoutes';
import type {SkillExecutor} from '../../skillEngine/skillExecutor';
import {createSkillExecutor} from '../../skillEngine/skillExecutor';
import {ensureSkillRegistryInitialized, skillRegistry} from '../../skillEngine/skillLoader';
import {acquireSelectedEvidenceFoundation} from '../../../agentRuntime/selectedEvidenceFoundation';
import type {DataEnvelope} from '../../../types/dataContract';
import {ArtifactStore} from '../../../agentv3/artifactStore';
import {createClaudeMcpServer} from '../../../agentv3/claudeMcpServer';
import {parseConclusionContractDeclaration} from '../../../agent/core/conclusionContract';
import {buildStrategyRegistrySnapshotFromDefinitions, getRegisteredScenes} from '../../../agentv3/strategyLoader';
import {prepareClaimEvidence} from '../claimEvidencePreparation';
import {getCapturedAnchorFacts} from '../evidenceCapture';
import {readRawSqlCaptureMetadata} from '../rawSqlNativeProvenance';
import {runClaimVerification} from '../../verifier/claimVerificationRunner';

const loopbackServers = createLoopbackServerFixture();

jest.setTimeout(120_000);
const processors: WorkingTraceProcessor[] = [];
afterEach(() => {for (const processor of processors.splice(0)) processor.destroy();});

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

function captureFixture(service: TraceProcessorService, traceId: string, toolName: 'execute_sql' | 'execute_sql_on',
  run: Pick<Parameters<typeof createClaudeMcpServer>[0], 'runId' | 'sessionId' | 'runAuthorization' | 'canInvokeTool'> = {}) {
  const artifactStore = new ArtifactStore();
  const envelopes: DataEnvelope[] = [];
  const traceSide = toolName === 'execute_sql_on' ? 'reference' as const : 'current' as const;
  const mcp = createClaudeMcpServer({
    ...run,
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
  async function execute(sql: string, column: string, expected: number, withExecutionIdentity = true, unit = 'ns',
    executionContext?: 'working' | 'original_trace', signal?: AbortSignal) {
    envelopes.length = 0;
    await handler({sql, ...(traceSide === 'reference' ? {trace: 'reference'} : {}),
      ...(executionContext ? {executionContext} : {})}, signal ? {signal} : {});
    expect(envelopes).toHaveLength(1);
    const envelope = envelopes[0];
    expect(envelope.meta.sourceToolCallId).toEqual(expect.any(String));
    const ref = {evidenceRefId: envelope.meta.evidenceRefId!, rowIndex: 0, column, value: expected,
      ...(withExecutionIdentity ? {sourceToolCallId: envelope.meta.sourceToolCallId} : {})};
    const contract = parseConclusionContractDeclaration({schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer',
      conclusions: [], clusters: [], evidenceChain: [], uncertainties: [], nextSteps: [],
      claims: [{id: 'duration', text: `The returned quantity is ${expected} ${unit}.`, kind: 'numeric', references: [ref],
        semantics: {schemaVersion: 'claim_semantics@1', predicate: 'numeric.cell', polarity: 'affirmed',
          discourse: 'asserted', quantifier: 'one', modality: 'certain',
          scope: {population: 'cited_rows', subjectRefs: [ref]}, numeric: {operator: 'eq', value: expected, unit}}}],
    }).contract!;
    const view = artifactStore.createEvidenceReadView({ownerKey: 'raw-sql-capture-test',
      ...(run.runId ? {currentRunId: run.runId} : {}),
      allowedTraces: [{traceId, traceSide}]});
    const prepared = await prepareClaimEvidence({conclusionContract: contract, evidenceReadView: view,
      bindingEligibility: 'eligible'});
    const verified = runClaimVerification({conclusionContract: contract, dataEnvelopes: envelopes,
      preparedEvidence: prepared, bindingEligibility: 'eligible'});
    return {...verified, envelope};
  }
  return {execute};
}

const filter = "WHERE name = 'StartupHooks.initializeOnMainThread#before-first-frame-sync-policy' LIMIT 1";
// Exact SQL authored in R7 against the maintained system-scheduling fixture.
const r7ClipSql = `SELECT ts.ts, MAX(ts.ts, 506733859657456) AS win_start, MIN(ts.ts + ts.dur, 506733892657456) AS win_end,
       MIN(ts.ts + ts.dur, 506733892657456) - MAX(ts.ts, 506733859657456) AS clipped_dur,
       ts.state, ts.cpu, ts.io_wait, ts.blocked_function, ts.waker_utid
FROM thread_state ts
WHERE ts.utid = 12831
  AND ts.ts < 506733892657456
  AND ts.ts + ts.dur > 506733859657456
ORDER BY ts.ts`;
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

  it('derives a fixed native conversion without borrowing alias units or reviving mutated trust', async () => {
    const {processor, execute} = await fixture('execute_sql');
    for (const alias of ['dur', 'unrelated']) {
      const expression = await execute(`SELECT dur / 1000000 AS ${alias} FROM slice ${filter}`, alias, 42, true, 'ms');
      expect(expression.claimVerificationResult.claimResults[0].deterministicProof).toMatchObject({status: 'proved'});
      expect(getCapturedAnchorFacts(expression.claimSupport[0].anchors[0])?.fields[alias]).toMatchObject({unit: 'ms'});
    }
    const unknown = await execute(`SELECT 42 / 1000000 AS dur_ms FROM slice ${filter}`, 'dur_ms', 0, true, 'ms');
    expect(unknown.claimVerificationResult.claimResults[0].deterministicProof?.reason).toBe('unit_authority_unknown');
    await processor.query('CREATE PERFETTO TABLE unit_test_taint AS SELECT 1 AS value');
    await processor.query('DROP TABLE unit_test_taint');
    const after = await execute(`SELECT dur FROM slice ${filter}`, 'dur', 42_000_000);
    expect(after.claimVerificationResult.claimResults[0].deterministicProof?.reason).toBe('unit_authority_unknown');
  });

  it.each(['execute_sql', 'execute_sql_on'] as const)('retains native aggregate units through %s without manufacturing row identity', async tool => {
    const {processor, execute} = await fixture(tool);
    for (const expression of ['SUM(dur)', 'MIN(dur)', 'MAX(dur)', 'AVG(dur)']) {
      const result = await execute(`SELECT ${expression} AS total FROM slice ${filter}`, 'total', 42_000_000);
      expect(result.claimVerificationResult.claimResults[0].deterministicProof).toMatchObject({status: 'proved'});
      expect(result.claimVerificationResult.claimResults[0].deterministicProof?.nativeRows).toBeUndefined();
      expect(getCapturedAnchorFacts(result.claimSupport[0].anchors[0])?.nativeRow).toBeUndefined();
    }
    const count = await execute(`SELECT COUNT(*) AS n FROM slice ${filter}`, 'n', 1, true, 'count');
    expect(count.claimVerificationResult.claimResults[0].deterministicProof).toMatchObject({status: 'proved'});
    const frames = await execute(`SELECT COUNT(*) AS n FROM slice ${filter}`, 'n', 1, true, 'frames');
    expect(frames.claimVerificationResult.claimResults[0].deterministicProof).toMatchObject({status: 'rejected', reason: 'unit_dimension_mismatch'});
    const start = Number((await processor.query(`SELECT ts FROM slice ${filter}`)).rows[0][0]);
    const clipped = await execute(`SELECT SUM(MIN(ts + dur, ${start + 30_000_000}) - MAX(ts, ${start + 10_000_000})) AS clipped
      FROM slice ${filter}`, 'clipped', 20_000_000);
    expect(clipped.claimVerificationResult.claimResults[0].deterministicProof).toMatchObject({status: 'proved'});
    expect(getCapturedAnchorFacts(clipped.claimSupport[0].anchors[0])?.nativeRow).toBeUndefined();
  });

  it.each(['execute_sql', 'execute_sql_on'] as const)('retains actual canonical row identity through %s and ignores computed IDs', async tool => {
    const {processor, execute} = await fixture(tool);
    const expectedId = (await processor.query(`SELECT id FROM slice ${filter}`)).rows[0][0];
    expect(Number.isSafeInteger(expectedId)).toBe(true);
    expect(expectedId).toBeGreaterThanOrEqual(0);
    for (const projection of ['id, dur', 's.id AS event_id, dur, ts + dur AS end_ts', 's.*']) {
      const result = await execute(`SELECT ${projection} FROM slice s ${filter}`, 'dur', 42_000_000, true);
      const anchor = result.claimSupport[0].anchors[0];
      const proof = result.claimVerificationResult.claimResults[0].deterministicProof!;
      expect(proof).toMatchObject({status: 'proved', nativeRows: [{id: expectedId, relation: 'slice', idColumn: 'id',
        traceId: processor.traceId, traceSide: tool === 'execute_sql_on' ? 'reference' : 'current',
        anchorId: anchor.anchorId, evidenceRefId: anchor.evidenceRefId, captureId: anchor.context.captureId,
        schemaFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/)}]});
      expect(anchor.context.captureId).toEqual(getCapturedAnchorFacts(anchor)?.captureId);
      expect(result.claimVerificationResult.passed).toBe(false);
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

  it.each([
    {name: 'preserves bounded-question units through real personal upload, private run and stats polling',
      traceCase: 'source-analysis-semantic', filter, duration: 42_000_000, originalTrace: false},
    {name: 'retains original_trace clip proof after R7 identity, summary Skill and preflight preparation',
      traceCase: 'system-scheduling-evidence',
      filter: "WHERE name = 'SmartPerfetto::CASE::system-scheduling-evidence' LIMIT 1", duration: 33_000_000,
      originalTrace: true, initInterruption: 'unsupported'},
    {name: 'retains original_trace clip proof after R7 identity while a second waiter cancels during held initialization',
      traceCase: 'system-scheduling-evidence',
      filter: "WHERE name = 'SmartPerfetto::CASE::system-scheduling-evidence' LIMIT 1", duration: 33_000_000,
      originalTrace: true, initInterruption: 'cancelled_waiter'},
  ])('$name', async ({traceCase, filter, duration, originalTrace, initInterruption}) => {
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'smartperfetto-personal-native-capture-'));
    const envKeys = [ENTERPRISE_FEATURE_FLAG_ENV, 'SMARTPERFETTO_ENTERPRISE_DB_PATH', 'SMARTPERFETTO_DATA_DIR', 'UPLOAD_DIR',
      'SMARTPERFETTO_API_KEY', 'SMARTPERFETTO_SSO_TRUSTED_HEADERS', 'SMARTPERFETTO_OIDC_ISSUER_URL',
      'SMARTPERFETTO_OIDC_CLIENT_ID', 'SMARTPERFETTO_OIDC_CLIENT_SECRET', 'SMARTPERFETTO_OIDC_REDIRECT_URI',
      'SMARTPERFETTO_ENTERPRISE_MIGRATION_PHASE', 'SMARTPERFETTO_ENTERPRISE_CUTOVER_CONFIRMED', 'SMARTPERFETTO_BACKEND_LOG_DIR'];
    const previousEnv = new Map(envKeys.map(key => [key, process.env[key]]));
    let leases: AnalysisRunTraceProcessorLeases | undefined;
    let service: TraceProcessorService | undefined;
    let executionLease: RuntimeExecutionLease | undefined;
    try {
      for (const key of envKeys) delete process.env[key];
      process.env[ENTERPRISE_FEATURE_FLAG_ENV] = 'false';
      process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'false';
      process.env.SMARTPERFETTO_ENTERPRISE_DB_PATH = path.join(temporaryRoot, 'enterprise.sqlite');
      process.env.SMARTPERFETTO_DATA_DIR = path.join(temporaryRoot, 'data');
      process.env.UPLOAD_DIR = path.join(temporaryRoot, 'uploads');
      process.env.SMARTPERFETTO_BACKEND_LOG_DIR = path.join(temporaryRoot, 'logs');
      resetDefaultCodebaseRegistryForTests();
      service = new TraceProcessorService(path.join(temporaryRoot, 'uploads', 'traces'));
      setTraceProcessorServiceForTests(service);
      const app = express();
      app.use(express.json());
      app.use('/api/traces', traceRoutes);
      const server = await loopbackServers.listen(app);
      const upload = await request(server).post('/api/traces/upload').attach('file', path.resolve(process.cwd(),
        `../Trace/.generated/constructed/${traceCase}/trace.pftrace`));
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
      const runId = randomUUID();
      const sessionId = randomUUID();
      const controller = executionLease = new RuntimeExecutionGuard().begin({runtime: 'openai-agents-sdk', sessionId, runId});
      // The R7 run has no private selection. Its real factory fence is public;
      // enforced describes private context, not permission to read this Trace.
      let authorizationOptions: Parameters<typeof createRuntimeRunAuthorization>[0]['options'] = {};
      if (!originalTrace) {
        const sourceRoot = path.join(temporaryRoot, 'authorized-source');
        await fs.mkdir(sourceRoot);
        const source = getDefaultCodebaseRegistry().register({kind: 'app_source', displayName: 'Native capture fixture',
          rootPath: sourceRoot, sendToProvider: false});
        const selection = {codeAwareMode: 'metadata_only' as const, codebaseIds: [source.codebaseId]};
        authorizationOptions = {...selection,
          analysisContextFingerprint: buildAnalysisContextAuthorizationFingerprint(selection, scope)};
      }
      const authorization = createRuntimeRunAuthorization({executionLease: controller, options: authorizationOptions});
      expect(authorization.fence.enforced).toBe(!originalTrace);
      authorization.assertActive();
      leases = await prepareAnalysisRunTraceProcessorLeases({service, scope, runId, sessionId,
        currentTraceId: traceId, signal: controller.signal, assertCurrent: authorization.assertActive});
      expect(leases.entries).toHaveLength(1);
      const entry = leases.entries[0];
      expect(entry.privateProcessor).toBe(true);
      expect(entry.context.mode).toBe('isolated');
      const privateKey = `${traceId}:lease:${entry.lease.id}`;
      const privateProcessor = TraceProcessorFactory.get(privateKey) as WorkingTraceProcessor;
      expect(privateProcessor.analysisRunPrivate).toBe(true);
      expect(privateProcessor.httpPort).not.toBe(sharedPort);
      const {execute} = captureFixture(service, traceId, 'execute_sql', {runId, sessionId,
        runAuthorization: authorization.fence, canInvokeTool: () => !controller.signal.aborted});
      const boundedIntent = {schemaVersion: 1 as const, status: 'resolved' as const, source: 'semantic' as const,
        registryFingerprint: 'personal-native-test', taskKind: 'investigation' as const, sceneId: 'general',
        scope: 'bounded_question' as const, recommendedComplexity: 'full' as const,
        deliverable: 'answer' as const, evidenceAccess: 'read_new' as const};
      expect(resolveRuntimeTurnPolicy(boundedIntent, 'full').allowMemoryPrefetch).toBe(false);
      await leases.run(async () => {
        for (const phase of ['before_stats', 'after_stats']) {
          const proof = await execute(`SELECT id, dur FROM slice ${filter}`, 'dur', duration);
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
        const ambiguous = await execute(`SELECT id, dur FROM slice ${filter}`, 'dur', duration, false);
        expect(ambiguous.claimVerificationResult.claimResults[0].deterministicProof?.reason).toBe('execution_capture_missing');
        expect(privateProcessor.getNativeProvenanceSnapshot().status).toBe('trusted');
        const clipBefore = originalTrace ? await execute(r7ClipSql, 'clipped_dur', 1_000_000) : undefined;
        if (clipBefore) {
          expect(clipBefore.claimVerificationResult.claimResults[0].deterministicProof).toMatchObject({status: 'proved'});
          expect(getCapturedAnchorFacts(clipBefore.claimSupport[0].anchors[0])?.fields.clipped_dur).toMatchObject({unit: 'ns'});
          expect(clipBefore.envelope.data).toMatchObject({rows: [
            [506733856657456, 506733859657456, 506733860657456, 1_000_000, 'Running', 7, null, null, null],
            [506733860657456, 506733860657456, 506733864657456, 4_000_000, 'R+', null, null, null, null],
            [506733864657456, 506733864657456, 506733868657456, 4_000_000, 'Running', 7, null, null, null],
            [506733868657456, 506733868657456, 506733877657456, 9_000_000, 'R', null, null, null, null],
            [506733877657456, 506733877657456, 506733881657456, 4_000_000, 'Running', 8, null, null, null],
            [506733881657456, 506733881657456, 506733886657456, 5_000_000, 'D', null, null, null, null],
            [506733886657456, 506733886657456, 506733890657456, 4_000_000, 'R', null, null, null, 12832],
            [506733890657456, 506733890657456, 506733892657456, 2_000_000, 'Running', 8, null, null, null],
          ]});
        }

        // Actual current-run collector, on this same trusted private lease. No
        // synthetic signer, alternative processor or reconstructed native witness.
        await ensureSkillRegistryInitialized();
        const executor = createSkillExecutor(service!);
        executor.registerSkills(skillRegistry.getAllSkills()); executor.setFragmentRegistry(skillRegistry.getFragmentCache());
        const strategyRegistry = buildStrategyRegistrySnapshotFromDefinitions({definitions: getRegisteredScenes(), overlayGeneration: 'real-selected'});
        const [nativeSelection] = (await service!.query(traceId, `SELECT id, ts, dur, track_id FROM slice ${filter}`)).rows;
        const selectedStore = new ArtifactStore();
        const input = {runId, traceId, strategyRegistry, skillRegistry, skillExecutor: executor,
          traceProcessorService: service!, artifactStore: selectedStore,
          turnIntent: {...boundedIntent, registryFingerprint: strategyRegistry.registryFingerprint, targetUse: 'current_selection' as const},
          policy: {allowNewEvidence: true}, selectionContext: {kind: 'track_event' as const, source: 'track_event_selection' as const,
            nativeTable: 'slice' as const, eventId: Number(nativeSelection[0]), ts: Number(nativeSelection[1]), dur: Number(nativeSelection[2])},
          outputLanguage: 'en' as const, executionLease: controller, canInvokeTool: () => !controller.signal.aborted,
          runAuthorization: authorization.fence,
          deadlineMs: Date.now() + 20_000, timeoutMs: 20_000};
        const foundation = await acquireSelectedEvidenceFoundation(input);
        expect(foundation).toMatchObject({native: {status: 'captured'}, metric: {status: 'committed'}});
        expect(privateProcessor.getNativeProvenanceSnapshot().status).toBe('tainted');
        if (originalTrace) {
          expect(nativeSelection.slice(1, 3)).toEqual([506733859657456, 33_000_000]);
          expect(foundation.identity).toMatchObject({utid: 12831});
        }
        if (foundation.native.status !== 'captured') throw new Error('actual selected native capture missing');
        const nativeCapture = foundation.native;
        const selectedView = selectedStore.createEvidenceReadView({ownerKey: 'real-selected', currentRunId: runId,
          allowedTraces: [{traceId, traceSide: 'current'}]});
        expect(selectedView.investigationEvidence!().records).toEqual(expect.arrayContaining([expect.objectContaining({
          metricId: 'system.thread.state.duration', upid: foundation.identity!.upid, utid: foundation.identity!.utid})]));

        // Actual full-scene preparation starts with focus detection, whose
        // ordinary stdlib INCLUDE cannot preserve native-only provenance.
        expect(resolveRuntimeTurnPolicy({...boundedIntent, scope: 'scene_wide'}, 'full').allowMemoryPrefetch).toBe(true);
        await detectFocusApps(service!, traceId);
        expect(privateProcessor.getNativeProvenanceSnapshot().status).toBe('tainted');
        await probeTraceCompleteness(service!, traceId);
        const afterPrefetch = await execute(`SELECT dur FROM slice ${filter}`, 'dur', duration);
        expect(afterPrefetch.claimVerificationResult.claimResults[0].deterministicProof?.reason).toBe('unit_authority_unknown');
        const ref = {evidenceRefId: nativeCapture.evidenceRefId, sourceToolCallId: nativeCapture.sourceToolCallId,
          rowIndex: 0, column: 'dur', value: duration};
        const contract = parseConclusionContractDeclaration({schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer',
          conclusions: [], clusters: [], evidenceChain: [], uncertainties: [], nextSteps: [], claims: [{id: 'selected_duration',
            text: `The selected native duration is ${duration} ns.`, kind: 'numeric', references: [ref],
            semantics: {schemaVersion: 'claim_semantics@1', predicate: 'numeric.cell', polarity: 'affirmed', discourse: 'asserted',
              quantifier: 'one', modality: 'certain', scope: {population: 'cited_rows', subjectRefs: [ref]},
              numeric: {operator: 'eq', value: duration, unit: 'ns'}}}]}).contract!;
        const prepared = await prepareClaimEvidence({conclusionContract: contract, evidenceReadView: selectedView, bindingEligibility: 'eligible'});
        const retained = runClaimVerification({conclusionContract: contract, dataEnvelopes: [], preparedEvidence: prepared, bindingEligibility: 'eligible'});
        expect(retained.claimVerificationResult.claimResults[0].deterministicProof).toMatchObject({status: 'proved',
          nativeRows: [{id: nativeCapture.row.id, relation: 'slice', traceId, traceSide: 'current'}]});
        // Reversing the order must fail honestly, with no new store registration.
        const afterStore = new ArtifactStore();
        const register = jest.spyOn(afterStore, 'registerStandaloneEvidenceCapture');
        expect(await acquireSelectedEvidenceFoundation({...input, artifactStore: afterStore, deadlineMs: Date.now() + 20_000}))
          .toMatchObject({native: {status: 'failed', reason: 'native_unavailable'}, metric: {status: 'not_run'}});
        expect(register).not.toHaveBeenCalled(); expect(afterStore.size).toBe(0);

        if (clipBefore) {
          const rawAfter = await service!.query(traceId, r7ClipSql);
          expect(rawAfter.error).toBeUndefined();
          expect(rawAfter.rows).toHaveLength(8);
          expect(readRawSqlCaptureMetadata(rawAfter)).toBeUndefined();
          const workingClip = await execute(r7ClipSql, 'clipped_dur', 1_000_000);
          expect(workingClip.envelope.data).toEqual(clipBefore.envelope.data);
          expect(workingClip.claimVerificationResult.claimResults[0].deterministicProof)
            .toMatchObject({status: 'candidate', reason: 'unit_authority_unknown'});
          expect(getCapturedAnchorFacts(workingClip.claimSupport[0].anchors[0])?.fields.clipped_dur?.unit).toBeUndefined();

          // This is the actual existing MCP input path, not a call to a future
          // service API or a manually signed replacement for working rows.
          const firstCall = new AbortController();
          const concurrentCapture = captureFixture(service!, traceId, 'execute_sql', {runId, sessionId,
            runAuthorization: authorization.fence, canInvokeTool: () => !controller.signal.aborted});
          let initializeReturned!: () => void;
          let releaseInitialize!: () => void;
          let heldChildLeaseId: string | undefined;
          const initializeReturnedPromise = new Promise<void>(resolve => {initializeReturned = resolve;});
          const initializeDelivery = new Promise<void>(resolve => {releaseInitialize = resolve;});
          const actualCreate = TraceProcessorFactory.create.bind(TraceProcessorFactory);
          const heldCreate = jest.spyOn(TraceProcessorFactory, 'create').mockImplementation(async (...args) => {
            const processor = await actualCreate(...args);
            if (args[2]?.strictChildSlot) {
              heldChildLeaseId = args[2].leaseId;
              initializeReturned();
              await initializeDelivery;
            }
            return processor;
          });
          const legitimate = Promise.all([
            execute(r7ClipSql, 'clipped_dur', 1_000_000, true, 'ns', 'original_trace', firstCall.signal),
            concurrentCapture.execute(r7ClipSql, 'clipped_dur', 1_000_000, true, 'ns', 'original_trace', firstCall.signal),
          ]).then(values => ({values}), (error: unknown) => ({error}));
          try {
            await initializeReturnedPromise;
            expect(heldChildLeaseId).toEqual(expect.any(String));
            expect(getTraceProcessorLeaseStore().getLeaseById(scope, heldChildLeaseId!)?.state).toBe('starting');
            if (initInterruption === 'unsupported') {
              await expect(service!.queryOriginalTraceEvidence(traceId,
                'SELECT s.dur FROM slice s JOIN thread_state t ON s.ts = t.ts',
                {assertAuthorized: authorization.fence.assertCurrentInTurn}))
                .rejects.toMatchObject({executed: false, reason: 'unsupported_query'});
            } else {
              const secondWaiter = new AbortController();
              const rejected = service!.queryOriginalTraceEvidence(traceId, r7ClipSql,
                {signal: secondWaiter.signal, assertAuthorized: authorization.fence.assertCurrentInTurn});
              queueMicrotask(() => secondWaiter.abort(new DOMException('Second waiter cancelled', 'AbortError')));
              await expect(rejected).rejects.toMatchObject({name: 'AbortError'});
            }
            console.info('[R8 init owner]', JSON.stringify({initInterruption,
              stateAfterOtherCaller: getTraceProcessorLeaseStore().getLeaseById(scope, heldChildLeaseId!)?.state}));
            expect(heldCreate).toHaveBeenCalledTimes(1);
          } finally {releaseInitialize(); heldCreate.mockRestore();}
          const completed = await legitimate;
          if ('error' in completed) throw completed.error;
          const [originalClip, concurrentClip] = completed.values;
          expect(getTraceProcessorLeaseStore().getLeaseById(scope, heldChildLeaseId!)?.state).toBe('active');
          expect(concurrentClip.claimVerificationResult.claimResults[0].deterministicProof).toMatchObject({status: 'proved'});
          expect(originalClip.envelope.data).toEqual(clipBefore.envelope.data);
          expect(privateProcessor.getNativeProvenanceSnapshot().status).toBe('tainted');
          console.info('[R8 native lane RED]', JSON.stringify({
            beforePreparation: clipBefore.claimVerificationResult.claimResults[0].deterministicProof?.status,
            afterPreparation: privateProcessor.getNativeProvenanceSnapshot().status,
            earlyWitness: retained.claimVerificationResult.claimResults[0].deterministicProof?.status,
            workingClip: workingClip.claimVerificationResult.claimResults[0].deterministicProof,
            originalTraceClip: originalClip.claimVerificationResult.claimResults[0].deterministicProof,
            rowCount: rawAfter.rows.length,
          }));
          expect(originalClip.claimVerificationResult.claimResults[0].deterministicProof)
            .toMatchObject({status: 'proved', reason: 'numeric_operator_proved'});
          expect(getCapturedAnchorFacts(originalClip.claimSupport[0].anchors[0])?.fields.clipped_dur)
            .toMatchObject({unit: 'ns', origin: {kind: 'native_producer'}});
          // A completed tool's signal is not the run's source-pin lifetime.
          firstCall.abort(new DOMException('Completed tool cleaned up', 'AbortError'));
          const nextClip = await execute(r7ClipSql, 'clipped_dur', 1_000_000, true, 'ns', 'original_trace');
          expect(nextClip.claimVerificationResult.claimResults[0].deterministicProof).toMatchObject({status: 'proved'});

          const childKey = TraceProcessorFactory.getStats().processorKeys.find(key => {
            const processor = TraceProcessorFactory.get(key);
            return key !== privateKey && processor instanceof WorkingTraceProcessor &&
              processor.traceId === traceId && processor.analysisRunPrivate;
          });
          const child = childKey && TraceProcessorFactory.get(childKey);
          if (!(child instanceof WorkingTraceProcessor)) throw new Error('Actual native child missing');
          let nativeFinished!: () => void;
          let deliver!: () => void;
          const nativeFinishedPromise = new Promise<void>(resolve => {nativeFinished = resolve;});
          const deliveryGate = new Promise<void>(resolve => {deliver = resolve;});
          const actualQuery = child.query.bind(child);
          // Hold only delivery of a genuine native result; no row or seal is fabricated.
          const heldQuery = jest.spyOn(child, 'query').mockImplementationOnce(async (sql, options) => {
            const result = await actualQuery(sql, options);
            nativeFinished();
            await deliveryGate;
            return result;
          });
          try {
            const heldCall = new AbortController();
            const pending = service!.queryOriginalTraceEvidence(traceId, r7ClipSql,
              {signal: heldCall.signal, assertAuthorized: authorization.fence.assertCurrentInTurn});
            await nativeFinishedPromise;
            heldCall.abort(new DOMException('Caller cancelled before delivery', 'AbortError'));
            deliver();
            await expect(pending).rejects.toMatchObject({name: 'AbortError'});
          } finally {deliver(); heldQuery.mockRestore();}

          const selectionId = Number(nativeSelection[0]);
          const shadow = await service!.query(traceId, `CREATE TEMP TABLE slice AS
            SELECT id, dur FROM main.slice WHERE id = ${selectionId}; UPDATE temp.slice SET dur = 777;`);
          expect(shadow.error).toBeUndefined();
          const shadowSql = `SELECT id, dur FROM slice WHERE id = ${selectionId}`;
          const workingShadow = await execute(shadowSql, 'dur', 777);
          expect(workingShadow.envelope.data).toMatchObject({rows: [[selectionId, 777]]});
          expect(workingShadow.claimVerificationResult.claimResults[0].deterministicProof?.reason).toBe('unit_authority_unknown');
          const originalSlice = await execute(shadowSql, 'dur', duration, true, 'ns', 'original_trace');
          expect(originalSlice.envelope.data).toMatchObject({rows: [[selectionId, duration]]});
          expect(originalSlice.claimVerificationResult.claimResults[0].deterministicProof).toMatchObject({status: 'proved'});
          for (const unsupported of [
            'SELECT s.dur FROM slice s JOIN thread_state t ON s.ts = t.ts',
            'SELECT dur FROM slice WHERE id IN (SELECT id FROM slice)',
            'SELECT * FROM working_only_table',
            'INCLUDE PERFETTO MODULE android.process_metadata; SELECT dur FROM slice',
          ]) {
            await expect(service!.queryOriginalTraceEvidence(traceId, unsupported,
              {assertAuthorized: authorization.fence.assertCurrentInTurn}))
              .rejects.toMatchObject({executed: false, reason: 'unsupported_query'});
          }
        }
      });
      const ownedLeases = getTraceProcessorLeaseStore().listLeases(scope, {traceId}).filter(lease =>
        lease.holders.some(holder => holder.holderType === 'agent_run' && holder.metadata?.runId === runId));
      const expectedPorts = ownedLeases.map(lease => {
        const key = `${traceId}:lease:${lease.id}`;
        const processor = TraceProcessorFactory.get(key);
        if (!(processor instanceof WorkingTraceProcessor) || !processor.analysisRunPrivate) throw new Error('Run processor missing');
        return {traceId: key, port: processor.httpPort};
      });
      expect(expectedPorts).toHaveLength(originalTrace ? 2 : 1);
      expect(expectedPorts).toContainEqual({traceId: privateKey, port: privateProcessor.httpPort});
      // Collect every release, independent of child/parent completion order.
      const portEvents = on(getPortPool(), 'released', {signal: AbortSignal.timeout(5000)});
      const portReleased = (async () => {
        const pending = new Set(expectedPorts.map(item => item.traceId));
        const released: Array<{traceId: string; port: number}> = [];
        for await (const [event] of portEvents) {
          if (pending.delete(event.traceId)) released.push(event);
          if (!pending.size) break;
        }
        return released;
      })();
      if (originalTrace) {
        const child = expectedPorts.find(item => item.traceId !== privateKey)!;
        expect(TraceProcessorFactory.isPrivateAnalysisPort(child.port)).toBe(true);
        await expect(service.registerExternalRpc('forbidden-child-proxy', child.port, 'private'))
          .rejects.toThrow('Private analysis processor cannot accept external connections');
        TraceProcessorFactory.remove(child.traceId);
        const remainingKeys = TraceProcessorFactory.getStats().processorKeys;
        await leases.run(async () => {
          await expect(service!.queryOriginalTraceEvidence(traceId, r7ClipSql,
            {assertAuthorized: authorization.fence.assertCurrentInTurn}))
            .rejects.toMatchObject({executed: false, reason: 'processor_unavailable'});
        });
        expect(TraceProcessorFactory.getStats().processorKeys).toEqual(remainingKeys);

        // A separate real group reaches child admission with a valid source
        // pin, then exercises the synchronous store-refusal boundary.
        const rejectedRunId = randomUUID();
        const rejectedSessionId = randomUUID();
        const rejectedExecution = new RuntimeExecutionGuard().begin({runtime: 'openai-agents-sdk',
          sessionId: rejectedSessionId, runId: rejectedRunId});
        const rejectedAuthorization = createRuntimeRunAuthorization({options: {}, executionLease: rejectedExecution});
        const rejectedGroup = await prepareAnalysisRunTraceProcessorLeases({service, scope, runId: rejectedRunId,
          sessionId: rejectedSessionId, currentTraceId: traceId, signal: rejectedExecution.signal,
          assertCurrent: rejectedAuthorization.assertActive});
        const admittedKeys = TraceProcessorFactory.getStats().processorKeys;
        const acquire = jest.spyOn(getTraceProcessorLeaseStore(), 'acquireHolder');
        const create = jest.spyOn(TraceProcessorFactory, 'create');
        const markFailed = jest.spyOn(getTraceProcessorLeaseStore(), 'markFailed');
        const actualInitialize = WorkingTraceProcessor.prototype.initialize;
        const initialize = jest.spyOn(WorkingTraceProcessor.prototype, 'initialize');
        if (initInterruption === 'unsupported') {
          acquire.mockImplementationOnce(() => {throw new Error('PRIVATE_ADMISSION_CAUSE');});
        } else {
          initialize.mockImplementationOnce(async function(this: WorkingTraceProcessor) {
            await actualInitialize.call(this);
            // Actual initialized native process; Factory's real failure path
            // must retire it and the group must cache this one failed attempt.
            throw new Error('PRIVATE_INITIALIZATION_CAUSE');
          });
        }
        try {
          await rejectedGroup.run(async () => {
            for (let call = 0; call < 2; call++) {
              await expect(service!.queryOriginalTraceEvidence(traceId, r7ClipSql,
                {assertAuthorized: rejectedAuthorization.fence.assertCurrentInTurn}))
                .rejects.toMatchObject({message: 'original_trace_refused', executed: false, reason: 'processor_unavailable'});
            }
          });
          expect(acquire).toHaveBeenCalledTimes(1);
          expect(create).toHaveBeenCalledTimes(initInterruption === 'unsupported' ? 0 : 1);
          expect(initialize).toHaveBeenCalledTimes(initInterruption === 'unsupported' ? 0 : 1);
          expect(markFailed).toHaveBeenCalledTimes(initInterruption === 'unsupported' ? 0 : 1);
          expect(TraceProcessorFactory.getStats().processorKeys).toEqual(admittedKeys);
        } finally {
          acquire.mockRestore(); create.mockRestore(); initialize.mockRestore(); markFailed.mockRestore();
          rejectedGroup.release(); rejectedExecution.settle();
        }
        expect(getTraceProcessorLeaseStore().getLeaseById(scope, entry.lease.id)?.holderCount).toBe(1);
      }
      leases.release();
      expect(await portReleased).toEqual(expect.arrayContaining(expectedPorts));
      for (const lease of ownedLeases) {
        const key = `${traceId}:lease:${lease.id}`;
        const storedLease = getTraceProcessorLeaseStore().getLeaseById(scope, lease.id);
        expect(storedLease?.holderCount).toBe(0);
        expect(storedLease?.state).toBe('released');
        expect(TraceProcessorFactory.get(key)).toBeUndefined();
        expect(getPortPool().getStats().allocations.some(allocation => allocation.traceId === key)).toBe(false);
      }
      expect(TraceProcessorFactory.get(traceId)).toBe(shared);
      const viewer = await request(server).get(`/api/traces/${traceId}`);
      expect(viewer.status).toBe(200);
      expect(viewer.body.trace.port).toBe(sharedPort);
      const uiStatus = await fetch(`http://127.0.0.1:${sharedPort}/status`);
      expect(uiStatus.ok).toBe(true);
      expect((await uiStatus.arrayBuffer()).byteLength).toBeGreaterThan(0);
      expect((await service.query(traceId, `SELECT dur FROM slice ${filter}`)).rows).toEqual([[duration]]);
    } finally {
      leases?.release();
      executionLease?.settle();
      if (service) service.cleanupProcessorsForTraces(service.getAllTraces().map(trace => trace.id));
      TraceProcessorFactory.cleanup();
      resetPortPool();
      setTraceProcessorServiceForTests(null);
      getTraceProcessorLeaseStore().close();
      setTraceProcessorLeaseStoreForTests(null);
      await loopbackServers.close();
      resetDefaultCodebaseRegistryForTests();
      for (const [key, value] of previousEnv) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      await fs.rm(temporaryRoot, {recursive: true, force: true});
    }
  });
});
