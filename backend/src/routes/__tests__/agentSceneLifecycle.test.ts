// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';
import express from 'express';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import request from 'supertest';
import {SceneEvidenceArchive} from '../../services/sceneReport/sceneEvidenceArchive';

// The route captures this port at import time; all operations still use the real
// archive implementation, with a fresh private directory for each HTTP test.
let mockArchive: SceneEvidenceArchive;
jest.mock('../../services/sceneReport/sceneEvidenceArchiveService', () => ({
  getSceneEvidenceArchive: () => new Proxy({}, {get: (_target, key) => (...args: unknown[]) =>
    (mockArchive as any)[key](...args)}),
  invalidateSceneEvidenceForTrace: (traceId: string) => mockArchive.invalidateTrace({traceId}),
}));
import agentRoutes, {agentRoutesCancellationTestSeam} from '../agentRoutes';
import {ClaudeRuntime} from '../../agentRuntime/engines/claude/claudeRuntime';
import type {AnalysisOptions, AnalysisResult} from '../../agent/core/orchestratorTypes';
import {activateSceneRuntime, resolveSceneProductScope, sceneRunOwnerKey} from '../../agent/scene/sceneRuntimeBinding';
import {proposeSceneTimeline} from '../../agent/scene/sceneTimelineProposal';
import {resolveRuntimeEvidenceStore} from '../../agentRuntime/runtimeEvidenceContext';
import {captureEvidenceTable} from '../../services/evidence/evidenceCapture';
import {buildTraceProcessorQueryProvenance} from '../../services/traceProcessorConnectionModel';
import {TraceProcessorService, setTraceProcessorServiceForTests} from '../../services/traceProcessorService';
import {setTraceProcessorLeaseStoreForTests} from '../../services/traceProcessorLeaseStore';
import {deleteTraceMetadata, writeTraceMetadata} from '../../services/traceMetadataStore';
import {resetAgentEventStoreForTests} from '../../services/agentEventStore';
import {resetAnalysisRunStoreForTests} from '../../services/analysisRunStore';
import {SessionPersistenceService} from '../../services/sessionPersistenceService';
import {clearRunManifestLifecyclesForTests} from '../../services/selfEvolution/runManifestLifecycle';
import {resetRunManifestStoreForTests} from '../../services/selfEvolution/runManifestStore';
import {getProviderService, resetProviderService} from '../../services/providerManager';
import {EnhancedSessionContext, sessionContextManager} from '../../agent/context/enhancedSessionContext';
import {AssistantApplicationService} from '../../assistant/application/assistantApplicationService';
import {SkillExecutor} from '../../services/skillEngine/skillExecutor';
import * as reportRoutes from '../reportRoutes';
import {createLoopbackServerFixture} from '../../../tests/helpers/loopbackServer';

const loopbackServers = createLoopbackServerFixture();

const owner = {tenantId: 'tenant-a', workspaceId: 'workspace-a', userId: 'scene-owner'};
const traceId = 'scene-http-trace';
const prefix = '/api/agent/v1';
const envKeys = ['SMARTPERFETTO_API_KEY', 'SMARTPERFETTO_SSO_TRUSTED_HEADERS', 'SMARTPERFETTO_ENTERPRISE',
  'SMARTPERFETTO_ENTERPRISE_DB_PATH', 'SMARTPERFETTO_DATA_DIR', 'UPLOAD_DIR',
  'SMARTPERFETTO_AGENT_RUNTIME', 'SMARTPERFETTO_AI_ENABLED', 'SMARTPERFETTO_CODE_AWARE',
  'SMARTPERFETTO_BACKEND_DATA_DIR', 'SMARTPERFETTO_BACKEND_LOG_DIR', 'PROVIDER_DATA_DIR_OVERRIDE'];
const originalEnv = new Map(envKeys.map(key => [key, process.env[key]]));
let dir: string;
let app: express.Express;
let server: Awaited<ReturnType<typeof loopbackServers.listen>>;
let service: TraceProcessorService;
let providerId: string;
let runtime: ClaudeRuntime;
let receivedOptions: AnalysisOptions;
let sessions: string[] = [];
let holdRuntime: (() => Promise<void>) | undefined;
let releaseRuntime: (() => void) | undefined;
let runtimeStarted: Promise<void>;
let markRuntimeStarted: () => void;

function auth(test: request.Test, userId = owner.userId, workspaceId = owner.workspaceId): request.Test {
  return test.set('X-SmartPerfetto-SSO-User-Id', userId)
    .set('X-SmartPerfetto-SSO-Email', `${userId}@example.test`)
    .set('X-SmartPerfetto-SSO-Tenant-Id', owner.tenantId)
    .set('X-SmartPerfetto-SSO-Workspace-Id', workspaceId)
    .set('X-SmartPerfetto-SSO-Roles', 'analyst')
    .set('X-SmartPerfetto-SSO-Scopes', 'trace:read,trace:write,agent:run,report:read');
}
function events(text: string): Array<{type: string; payload: any}> {
  return text.split(/\n\n/).flatMap(block => {
    const type = block.match(/^event: (.+)$/m)?.[1];
    const data = block.match(/^data: (.+)$/m)?.[1];
    return type && data ? [{type, payload: JSON.parse(data)}] : [];
  });
}
async function start() {
  const response = await auth(request(server).post(`${prefix}/scene-reconstruct`))
    .send({traceId, providerId, options: {outputLanguage: 'en'}});
  expect(response.status).toBe(200);
  const receipt = response.body as {sessionId: string; analysisId: string; runId: string};
  sessions.push(receipt.sessionId);
  expect(receipt.analysisId).toBe(receipt.sessionId);
  await runtimeStarted;
  return receipt;
}
async function stream(receipt: {sessionId: string; runId: string}, compat = false) {
  const deadline = Date.now() + 5000;
  while (true) {
    const status = await auth(request(server).get(`${prefix}/${receipt.sessionId}/status`));
    expect(status.status).toBe(200);
    if (['completed', 'failed', 'cancelled'].includes(status.body.status)) break;
    if (Date.now() >= deadline) throw new Error('scene HTTP run did not settle');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return auth(request(server).get(`${prefix}/${compat ? 'scene-reconstruct/' : ''}${receipt.sessionId}/stream?runId=${receipt.runId}`))
    .timeout({response: 5000, deadline: 10000});
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scene-http-lifecycle-'));
  process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'true';
  process.env.SMARTPERFETTO_ENTERPRISE = 'true';
  process.env.SMARTPERFETTO_ENTERPRISE_DB_PATH = path.join(dir, 'enterprise.sqlite');
  process.env.SMARTPERFETTO_DATA_DIR = path.join(dir, 'enterprise');
  process.env.SMARTPERFETTO_BACKEND_DATA_DIR = path.join(dir, 'data');
  process.env.SMARTPERFETTO_BACKEND_LOG_DIR = path.join(dir, 'logs');
  process.env.UPLOAD_DIR = path.join(dir, 'uploads');
  process.env.PROVIDER_DATA_DIR_OVERRIDE = path.join(dir, 'providers');
  process.env.SMARTPERFETTO_AGENT_RUNTIME = 'claude-agent-sdk';
  process.env.SMARTPERFETTO_AI_ENABLED = 'true';
  delete process.env.SMARTPERFETTO_API_KEY;
  resetProviderService();
  mockArchive = new SceneEvidenceArchive(path.join(dir, 'scene-archive'));
  // Generic HTML report publication is outside this archive contract. Avoid the
  // module's import-time shared reports path while exercising real v3 archival.
  jest.spyOn(reportRoutes, 'persistReport').mockImplementation(() => {});
  const tracePath = path.join(dir, 'input.trace');
  await fs.writeFile(tracePath, 'HTTP fixture trace');
  await writeTraceMetadata({...owner, id: traceId, filename: 'input.trace', size: 18,
    uploadedAt: new Date().toISOString(), status: 'ready', path: tracePath});
  service = new TraceProcessorService(process.env.UPLOAD_DIR);
  service.registerStoredTrace({id: traceId, filename: 'input.trace', size: 18, filePath: tracePath});
  jest.spyOn(service, 'getOrLoadTrace').mockImplementation(async id => service.getTrace(id)!);
  jest.spyOn(service, 'runWithLeases'); // Keep the actual AsyncLocalStorage lease boundary.
  jest.spyOn(service, 'ensureProcessorForLease').mockImplementation(async id => ({
    id: `processor-${id}`, traceId: id, status: 'ready', activeQueries: 0,
    query: jest.fn(async () => ({columns: [], rows: [], durationMs: 1})),
    queryRaw: jest.fn(async () => Buffer.alloc(0)), destroy: jest.fn(),
  }));
  jest.spyOn(service, 'query').mockImplementation(async (_id, sql) => sql.includes('FROM trace_bounds')
    ? {columns: ['start_ns', 'end_ns'], rows: [['9007199254740992', '9007199254741992']], durationMs: 1}
    : {columns: [], rows: [], durationMs: 1});
  setTraceProcessorServiceForTests(service);
  const providers = getProviderService();
  const create = (name: string) => providers.create({name, category: 'official', type: 'deepseek',
    models: {primary: 'deepseek-chat', light: 'deepseek-chat'},
    connection: {apiKey: 'test-only', agentRuntime: 'claude-agent-sdk',
      claudeBaseUrl: 'https://api.deepseek.com/anthropic', openaiBaseUrl: 'https://api.deepseek.com/v1'}}, owner);
  providerId = create('explicit-scene-provider').id;
  providers.activate(create('other-active-provider').id, owner);
  runtimeStarted = new Promise(resolve => {markRuntimeStarted = resolve;});
  jest.spyOn(ClaudeRuntime.prototype, 'analyze').mockImplementation(async function (
    this: ClaudeRuntime, _query, sessionId, currentTraceId, options = {},
  ): Promise<AnalysisResult> {
    runtime = this; receivedOptions = options;
    const scope = {sessionId, traceId: currentTraceId, runId: options.runId!};
    expect(resolveSceneProductScope(options, scope)).toEqual({...scope, ownerKey: sceneRunOwnerKey(owner)});
    expect(resolveSceneProductScope(JSON.parse(JSON.stringify(options, (key, value) => key === 'traceProcessorService' ? undefined : value)), scope)).toBeUndefined();
    const store = resolveRuntimeEvidenceStore(options, scope, () => {throw new Error('opaque binding missing');});
    const context = await activateSceneRuntime(options, {...scope, artifactStore: store,
      traceProcessorService: service, deadlineMs: Date.now() + 60000});
    expect(context).toBeDefined();
    const data = {columns: ['start_ns', 'end_ns', 'upid'], rows: [['9007199254740992', '9007199254740993', '7']]};
    const origin = {kind: 'skill_literal' as const, definitionFingerprint: 'scene-http@1', skillId: 'http_fixture', stepId: 'facts'};
    const artifactId = store.store({skillId: 'http_fixture', stepId: 'facts', data,
      traceProvenance: buildTraceProcessorQueryProvenance({traceId: currentTraceId, traceSide: 'current'})});
    store.registerEvidenceCapture(artifactId, captureEvidenceTable(data, {
      start_ns: {origin, timeRole: 'start', clock: 'trace_monotonic', unit: 'ns'},
      end_ns: {origin, timeRole: 'end', clock: 'trace_monotonic', unit: 'ns'}, upid: {origin, identityRole: 'upid'},
    }), {evidenceRefId: 'http-evidence', originRunId: scope.runId});
    const proposed = await proposeSceneTimeline(context!, {baseRevision: 0, proposalId: 'http-proposal', unresolved: [],
      segments: [{id: 'http-segment', startNs: data.rows[0][0], endNs: data.rows[0][1],
        object: {kind: 'upid', key: '7'}, userAction: 'Input unknown', deviceState: 'State unknown', appResponse: 'Observed interval',
        evidenceRefs: [{artifactId, rowIndex: 0}], dependencies: [], supersedes: [],
        boundaries: {start: {source: 'evidence', evidenceIndex: 0, column: 'start_ns'},
          end: {source: 'evidence', evidenceIndex: 0, column: 'end_ns'}}}]});
    expect(proposed).toMatchObject({accepted: true, revision: 1});
    markRuntimeStarted();
    if (holdRuntime) await holdRuntime();
    this.emit('update', {type: 'error', content: {message: 'fixture provider stopped after proposal'}, timestamp: Date.now()});
    return {sessionId, success: false, partial: true, findings: [], hypotheses: [],
      conclusion: 'Partial scene observation.', confidence: 0, rounds: 1, totalDurationMs: 1};
  });
  app = express(); app.use(express.json()); app.use(prefix, agentRoutes);
  server = await loopbackServers.listen(app);
});

afterEach(async () => {
  releaseRuntime?.();
  await new Promise(resolve => setTimeout(resolve, 20));
  for (const sessionId of sessions) {
    agentRoutesCancellationTestSeam.deleteSession(sessionId);
    sessionContextManager.remove(sessionId);
  }
  sessions = []; holdRuntime = undefined; releaseRuntime = undefined;
  await loopbackServers.close();
  jest.restoreAllMocks();
  setTraceProcessorServiceForTests(null); setTraceProcessorLeaseStoreForTests(null);
  SessionPersistenceService.resetForTests(); resetAgentEventStoreForTests(); resetAnalysisRunStoreForTests();
  clearRunManifestLifecyclesForTests(); resetRunManifestStoreForTests(); resetProviderService();
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await fs.rm(dir, {recursive: true, force: true});
});

describe('scene HTTP shared lifecycle', () => {
  it('pins provider and opaque evidence authority, then emits exactly one canonical partial terminal despite runtime error', async () => {
    const receipt = await start();
    const response = await stream(receipt);
    expect(response.status).toBe(200);
    expect(receivedOptions.providerId).toBe(providerId);
    expect(receivedOptions.traceProcessorService).toBe(service);
    expect(service.runWithLeases).toHaveBeenCalledWith([expect.objectContaining({traceId,
      leaseId: expect.any(String), leaseScope: owner})], expect.any(Function));
    const emitted = events(response.text);
    expect(emitted.filter(event => ['analysis_completed', 'analysis_cancelled', 'error'].includes(event.type)).map(event => event.type))
      .toEqual(['analysis_completed']);
    expect(emitted.some(event => event.type === 'degraded')).toBe(true);
    const final = emitted.find(event => event.type === 'analysis_completed')!.payload.data;
    expect(final.partial).toBe(true);
    expect(final.sceneTimeline).toMatchObject({schemaVersion: 'scene_timeline@1', traceId,
      sessionId: receipt.sessionId, runId: receipt.runId, revision: 1, status: 'partial'});
    expect(final.sceneTimeline.segments[0].segment.id).toBe('http-segment');
    expect(final.sceneTimeline.segments[0].semanticStatus).toBe('unverified');
    expect(final.sceneReport).toMatchObject({traceId, sessionId: receipt.sessionId, runId: receipt.runId, revision: 1});
    const ordinary = await auth(request(server).get(`${prefix}/${receipt.sessionId}/status`));
    const compat = await auth(request(server).get(`${prefix}/scene-reconstruct/${receipt.sessionId}/status`));
    expect(ordinary.status).toBe(200); expect(compat.status).toBe(200);
    expect(ordinary.body.result.sceneTimeline).toEqual(final.sceneTimeline);
    expect(compat.body.result.sceneTimeline).toEqual(final.sceneTimeline);
    const tracks = await auth(request(server).get(`${prefix}/scene-reconstruct/${receipt.sessionId}/tracks`));
    expect(tracks.status).toBe(200); expect(tracks.body.sceneTimeline).toEqual(final.sceneTimeline);
    const archived = await auth(request(server).get(`${prefix}/scene-reconstruct/report/${final.sceneReport.reportId}`));
    expect(archived.status).toBe(200);
    expect(archived.body.report.sceneTimeline).toEqual(final.sceneTimeline);
  });

  it.each(['metadata_deleted', 'archive_expired'] as const)('rejects ordinary and compatibility history after %s, including owner aliases', async kind => {
    const receipt = await start(); await stream(receipt);
    const status = await auth(request(server).get(`${prefix}/${receipt.sessionId}/status`));
    const ref = status.body.result.sceneReport;
    expect(ref).toBeDefined();
    if (kind === 'metadata_deleted') await deleteTraceMetadata(traceId);
    else await mockArchive.cleanupExpired(ref.expiresAt + 1);
    for (const route of [`/${receipt.sessionId}/status`, `/${receipt.sessionId}/stream?runId=${receipt.runId}`,
      `/runs/${receipt.runId}/stream`, `/scene-reconstruct/${receipt.sessionId}/status`,
      `/scene-reconstruct/${receipt.sessionId}/tracks`, `/scene-reconstruct/${receipt.sessionId}/stream?runId=${receipt.runId}`,
      `/scene-reconstruct/report/${ref.reportId}`]) {
      const response = await auth(request(server).get(`${prefix}${route}`).timeout({deadline: 5000}));
      expect({route, status: response.status}).toEqual({route, status: 404});
    }
  });

  it('hides scene histories from another owner/workspace and refuses direct v3 Skill deep dives', async () => {
    const receipt = await start(); await stream(receipt);
    for (const [user, workspace] of [['other-owner', owner.workspaceId], [owner.userId, 'other-workspace']]) {
      for (const route of [`/${receipt.sessionId}/status`, `/${receipt.sessionId}/stream?runId=${receipt.runId}`,
        `/scene-reconstruct/${receipt.sessionId}/status`, `/scene-reconstruct/${receipt.sessionId}/tracks`,
        `/scene-reconstruct/${receipt.sessionId}/stream?runId=${receipt.runId}`]) {
        const hidden = await auth(request(server).get(`${prefix}${route}`), user, workspace);
        expect({route, status: hidden.status}).toEqual({route, status: 404});
      }
    }
    const execute = jest.spyOn(SkillExecutor.prototype, 'execute');
    const dive = await auth(request(server).post(`${prefix}/scene-reconstruct/${receipt.sessionId}/deep-dive`))
      .send({eventId: 'http-segment', eventType: 'scroll', startTs: '1', endTs: '2'});
    expect(dive.status).toBe(409); expect(dive.body.code).toBe('SCENE_INVESTIGATION_REQUIRED');
    expect(execute).not.toHaveBeenCalled();
  });

  it('requires the active runId for cancellation and drops late runtime updates after the one terminal', async () => {
    const held = new Promise<void>(resolve => {releaseRuntime = resolve;}); holdRuntime = () => held;
    const receipt = await start();
    const missing = await auth(request(server).post(`${prefix}/scene-reconstruct/${receipt.sessionId}/cancel`)).send({});
    expect(missing.status).toBe(400); expect(missing.body.code).toBe('RUN_ID_REQUIRED');
    const wrong = await auth(request(server).post(`${prefix}/scene-reconstruct/${receipt.sessionId}/cancel`)).send({runId: 'wrong-run'});
    expect(wrong.status).toBe(404); expect(wrong.body.code).toBe('RUN_NOT_FOUND');
    const status = await auth(request(server).get(`${prefix}/${receipt.sessionId}/status`));
    expect(status.body.status).toBe('running');
    const cancelled = await auth(request(server).post(`${prefix}/scene-reconstruct/${receipt.sessionId}/cancel`)).send({runId: receipt.runId});
    expect(cancelled.status).toBe(200); expect(cancelled.body.status).toBe('cancelled');
    releaseRuntime!();
    const response = await stream(receipt, true);
    expect(events(response.text).filter(event => ['analysis_completed', 'analysis_cancelled', 'error'].includes(event.type)).map(event => event.type))
      .toEqual(['analysis_cancelled']);
    runtime.emit('update', {type: 'error', content: 'late error', timestamp: Date.now()});
    runtime.emit('update', {type: 'scene_timeline_updated', content: {revision: 99}, timestamp: Date.now()});
    const replay = await stream(receipt);
    expect(events(replay.text).filter(event => ['analysis_completed', 'analysis_cancelled', 'error'].includes(event.type)).map(event => event.type))
      .toEqual(['analysis_cancelled']);
    expect(replay.text).not.toContain('late error'); expect(replay.text).not.toContain('"revision":99');
  });

  it('keeps a persisted scene session closed to admission throughout DELETE cleanup and never deletes a replacement', async () => {
    const receipt = await start(); await stream(receipt);
    const persistence = SessionPersistenceService.getInstance();
    const context = new EnhancedSessionContext(receipt.sessionId, traceId);
    context.addTurn('Persisted scene investigation', {primaryGoal: 'scene_reconstruction', aspects: [],
      expectedOutputType: 'diagnosis', complexity: 'moderate'});
    expect(persistence.saveSessionContext(receipt.sessionId, context)).toBe(true);
    expect(persistence.loadSessionContext(receipt.sessionId)).not.toBeNull();
    const reads = jest.spyOn(AssistantApplicationService.prototype, 'getSession');
    await auth(request(server).get(`${prefix}/${receipt.sessionId}/status`));
    const original = reads.mock.results.find(result => result.type === 'return' && result.value?.sessionId === receipt.sessionId)!.value as any;
    let resolveCleanup!: () => void;
    let entered!: () => void;
    const cleaning = new Promise<void>(resolve => {entered = resolve;});
    const cleanup = new Promise<void>(resolve => {resolveCleanup = resolve;});
    jest.spyOn(runtime, 'cleanupSession').mockImplementationOnce(async () => {entered(); await cleanup;});
    const deletion = auth(request(server).delete(`${prefix}/scene-reconstruct/${receipt.sessionId}`)).then(response => response);
    await cleaning;
    expect(original.sceneExecutionInFlightRunId).toBe(`delete:${receipt.sessionId}`);
    for (const route of ['/analyze', `/sessions/${receipt.sessionId}/runs`]) {
      const refused = await auth(request(server).post(`${prefix}${route}`))
        .send({sessionId: receipt.sessionId, traceId, query: 'A new analysis during deletion', providerId});
      expect(refused.status).toBe(409); expect(refused.body.code).toBe('RUN_ALREADY_ACTIVE');
    }
    const replacement = {...original, sceneExecutionInFlightRunId: undefined};
    agentRoutesCancellationTestSeam.setSession(receipt.sessionId, replacement);
    resolveCleanup();
    expect((await deletion).status).toBe(200);
    expect(original.sceneExecutionInFlightRunId).toBeUndefined();
    expect((await auth(request(server).get(`${prefix}/${receipt.sessionId}/status`))).status).toBe(200);
    expect(reads.mock.results.some(result => result.type === 'return' && result.value === replacement)).toBe(true);
  });

  it('keeps the original session retryable when DELETE runtime cleanup rejects', async () => {
    const receipt = await start(); await stream(receipt);
    const cleanup = jest.spyOn(runtime, 'cleanupSession').mockImplementationOnce(async () => {throw new Error('fixture cleanup failure');})
      .mockImplementationOnce(() => {});
    const failed = await auth(request(server).delete(`${prefix}/scene-reconstruct/${receipt.sessionId}`));
    expect(failed.status).toBe(500);
    expect((await auth(request(server).get(`${prefix}/${receipt.sessionId}/status`))).status).toBe(200);
    const retried = await auth(request(server).delete(`${prefix}/scene-reconstruct/${receipt.sessionId}`));
    expect(retried.status).toBe(200); expect(cleanup).toHaveBeenCalledTimes(2);
  });
});
