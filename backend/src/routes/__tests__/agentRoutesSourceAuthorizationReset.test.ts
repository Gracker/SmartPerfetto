// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * A source authorization change ends the HTTP session it happened in.
 *
 * The authorization fingerprint covers mode, selection, each selected
 * codebase's lifecycle, selection policy and consent, and each knowledge
 * source. These tests drive the real analyze, resume and session services
 * with a real codebase registry; only the provider call is simulated. Its
 * first turn reads a registered file through the real on-demand source tool
 * and quotes it. After a change the next turn must run in a new session whose
 * query, history preview and history reads carry none of that quotation, and
 * whose run cannot reach a deselected or narrowed-out file. An identical
 * resubmission keeps the session and its history (the control).
 */

import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';

import agentRoutes, {agentRoutesCancellationTestSeam} from '../agentRoutes';
import {ENTERPRISE_FEATURE_FLAG_ENV} from '../../config';
import {sessionContextManager} from '../../agent/context/enhancedSessionContext';
import {ENTERPRISE_DB_PATH_ENV} from '../../services/enterpriseDb';
import {ENTERPRISE_DATA_DIR_ENV, writeTraceMetadata} from '../../services/traceMetadataStore';
import {resetAgentEventStoreForTests} from '../../services/agentEventStore';
import {getAnalysisRunLifecycle, resetAnalysisRunStoreForTests} from '../../services/analysisRunStore';
import {setTraceProcessorLeaseStoreForTests} from '../../services/traceProcessorLeaseStore';
import {SessionPersistenceService} from '../../services/sessionPersistenceService';
import {clearRunManifestLifecyclesForTests} from '../../services/selfEvolution/runManifestLifecycle';
import {resetRunManifestStoreForTests} from '../../services/selfEvolution/runManifestStore';
import {TraceProcessorService, setTraceProcessorServiceForTests} from '../../services/traceProcessorService';
import {resetProviderService} from '../../services/providerManager';
import {ClaudeRuntime} from '../../agentRuntime/engines/claude/claudeRuntime';
import type {AnalysisOptions, AnalysisResult} from '../../agent/core/orchestratorTypes';
import * as defaultCodebaseServices from '../../services/codebase/defaultCodebaseServices';
import {CodebaseRegistry} from '../../services/codebase/codebaseRegistry';
import * as externalKnowledgeServices from '../../services/externalKnowledgeSourceRegistry';
import {ExternalKnowledgeSourceRegistry} from '../../services/externalKnowledgeSourceRegistry';
import * as documentCollectionStores from '../../services/knowledge/documentCollectionStore';
import {DocumentCollectionStore} from '../../services/knowledge/documentCollectionStore';
import {DocumentCollectionIngester} from '../../services/knowledge/documentCollectionIngester';
import {clearCodeAwareOutputGuards} from '../../services/security/codeAwareOutputRegistry';
import {buildAnalysisContextAuthorizationFingerprint} from '../../services/resolvedAnalysisContext';
import * as ragStores from '../../services/ragStore';
import {RagStore} from '../../services/ragStore';
import {CodeLookupLedger} from '../../services/codebase/codeLookupLedger';
import {PatchProposer} from '../../services/codebase/patchProposer';
import {runtimeSourceDepth} from '../../services/codebase/sourceDepthPolicy';
import {getDefaultAndroidInternalsPackResolver} from '../../services/androidInternalsPack/androidInternalsPackResolver';
import * as skillFingerprint from '../../services/selfEvolution/skillFingerprint';
import {createRunMcpServer} from '../../../tests/helpers/runMcpServerFixture';
import {
  expectCleanTurn,
  observeModelInput,
  recordRuntimeTurn,
  type ObservedModelInput,
} from '../../../tests/helpers/sourceAuthorizationGate';

const buildRealSkillRegistryAttribution = skillFingerprint.buildSkillRegistryAttribution;
const skillRegistryAttributions = new WeakMap<object, ReturnType<typeof buildRealSkillRegistryAttribution>>();

/** Text that exists only inside the registered file turn 1 reads. */
const SOURCE_CANARY = 'P9A_SOURCE_AUTHORIZATION_CANARY';
/** Text only a public (source-free) turn produces. */
const PUBLIC_MARKER = 'P9A_PUBLIC_HISTORY_MARKER';
const KNOWLEDGE_TERM = 'XRenderCompositorWorker';
const scope = {tenantId: 'tenant-a', workspaceId: 'workspace-a', userId: 'analyst-user'};
const traceId = 'trace-source-authorization-reset';
const SOURCE_TOOLS = ['find_codebase_files', 'list_codebases', 'locate_trace_anchor', 'read_codebase_file', 'search_codebase'];
const ENV_KEYS = ['SMARTPERFETTO_API_KEY', 'SMARTPERFETTO_SSO_TRUSTED_HEADERS', ENTERPRISE_FEATURE_FLAG_ENV,
  ENTERPRISE_DB_PATH_ENV, ENTERPRISE_DATA_DIR_ENV, 'UPLOAD_DIR', 'SMARTPERFETTO_AGENT_RUNTIME',
  'SMARTPERFETTO_CODE_AWARE', 'SMARTPERFETTO_OUTPUT_LANGUAGE', 'PROVIDER_DATA_DIR_OVERRIDE',
  'SMARTPERFETTO_CODEBASE_ROOTS', 'SMARTPERFETTO_KNOWLEDGE_ROOTS', 'CLAUDE_FULL_PER_TURN_MS',
  'SMARTPERFETTO_BACKEND_LOG_DIR'];
/** The indexed chunk turn 1 looks up in App B, the old context a later patch may try to reuse. */
const INDEXED_CHUNK_ID = 'p9a-indexed-hooks-chunk';
/** propose_patch for context whose codebase the run no longer selects. */
const PATCH_TARGET_NOT_SELECTED = {success: false, action_required: 'continue_without_patch',
  unsupportedReason: 'patch_target_not_selected'};
/** A run's answer to a source call naming a codebase outside its selection. */
const DESELECTED_CODEBASE_REFUSAL = {success: false, action_required: 'list_codebases',
  unsupportedReason: 'whitelisted_codebase_id_required'};

interface TurnPlan {
  /** Read this registered file (codebase key, relative path) and quote it in the answer. */
  read?: {codebase: 'A' | 'B'; filePath: string};
  /** Look the query up in the run's active indexes, which records the hits in the session's ledger. */
  lookup?: string;
  /** Propose a patch from the indexed chunk turn 1 looked up. */
  patch?: boolean;
  /** Answer text for a turn that reads nothing. */
  answer?: string;
}

interface ObservedTurn extends ObservedModelInput {
  tools: string[];
  sourceRead?: Record<string, any>;
  probeRead?: Record<string, any>;
  knowledgeSearch?: Record<string, any>;
  lookup?: Record<string, any>;
  patch?: Record<string, any>;
}

let tmpDir: string;
let registry: CodebaseRegistry;
let ids: {A: string; B: string};
let knowledge: {registry: ExternalKnowledgeSourceRegistry; store: DocumentCollectionStore; sourceId: string} | undefined;
let traceService: TraceProcessorService;
let observed: ObservedTurn[];
let plans: TurnPlan[];
/** Run after a turn's observations, before its answer: a file the run must not reach. */
let probe: {codebase: 'A' | 'B'; filePath: string} | undefined;
const savedEnv = new Map<string, string | undefined>();
const sessionsToClean = new Set<string>();

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api/agent/v1', agentRoutes);
  return app;
}

function analyst(req: request.Test): request.Test {
  return req
    .set('X-SmartPerfetto-SSO-User-Id', scope.userId)
    .set('X-SmartPerfetto-SSO-Email', 'analyst@example.test')
    .set('X-SmartPerfetto-SSO-Tenant-Id', scope.tenantId)
    .set('X-SmartPerfetto-SSO-Workspace-Id', scope.workspaceId)
    .set('X-SmartPerfetto-SSO-Roles', 'analyst')
    .set('X-SmartPerfetto-SSO-Scopes', 'trace:read,trace:write,agent:run,report:read,codebase:read');
}

function writeSource(root: string, relativePath: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(root, relativePath)), {recursive: true});
  fs.writeFileSync(path.join(root, relativePath), content);
}

/** The run's MCP server as a runtime builds it from the run options, over the default registries and ledger. */
function runServer(options: AnalysisOptions, sessionId: string, runTraceId: string) {
  return createRunMcpServer({
    sessionId, traceId: runTraceId, runId: options.runId,
    knowledgeScope: {tenantId: options.tenantId!, workspaceId: options.workspaceId!, userId: options.userId},
    codeAwareMode: options.codeAwareMode, codebaseIds: options.codebaseIds, knowledgeSourceIds: options.knowledgeSourceIds,
    analysisContextFingerprint: options.analysisContextFingerprint,
    sourceDepthDecision: runtimeSourceDepth({budgetMode: options.analysisMode === 'full' ? 'full' : 'quick'}, options),
  });
}

/** The simulated provider call: what a runtime would hand the model, then a scripted answer. */
async function simulatedRun(query: string, sessionId: string, runTraceId: string,
  options: AnalysisOptions = {}): Promise<AnalysisResult> {
  sessionsToClean.add(sessionId);
  const plan = plans.shift() ?? {answer: 'No source was needed.'};
  const server = runServer(options, sessionId, runTraceId);
  const turn: ObservedTurn = {...observeModelInput(query, sessionId, runTraceId, options), tools: server.names};
  if (probe) turn.probeRead = await server.invoke('read_codebase_file',
    {codebase_id: ids[probe.codebase], file_path: probe.filePath, start_line: 1, max_lines: 5});
  if (knowledge) turn.knowledgeSearch = await server.invoke('search_knowledge', {query: KNOWLEDGE_TERM});
  if (plan.lookup) turn.lookup = await server.invoke('lookup_app_source', {query: plan.lookup});
  if (plan.patch) turn.patch = await server.invoke('propose_patch', {context_chunk_ids: [INDEXED_CHUNK_ID],
    problem: 'Move the hook installation out of startup.', patch_sketch: 'Install the hooks lazily.'});
  let conclusion = plan.answer ?? 'No source was needed.';
  if (plan.read) {
    turn.sourceRead = await server.invoke('read_codebase_file',
      {codebase_id: ids[plan.read.codebase], file_path: plan.read.filePath, start_line: 1, max_lines: 5});
    if (!JSON.stringify(turn.sourceRead).includes(SOURCE_CANARY)) throw new Error('turn 1 could not read its source');
    conclusion = `The registered file says ${SOURCE_CANARY}.`;
  }
  observed.push(turn);
  recordRuntimeTurn(query, sessionId, runTraceId, options, conclusion);
  return {sessionId, success: true, findings: [], hypotheses: [], conclusion, confidence: 0.8, rounds: 1, totalDurationMs: 1};
}

async function waitForCompleted(runId: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (getAnalysisRunLifecycle(scope, runId)?.status !== 'completed' && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  expect(getAnalysisRunLifecycle(scope, runId)?.status).toBe('completed');
}

type Selection = {codeAwareMode?: AnalysisOptions['codeAwareMode']; codebases?: Array<'A' | 'B'>; knowledge?: boolean;
  sourceDepth?: AnalysisOptions['sourceDepth']};

function selectionOptions(selection: Selection): Record<string, unknown> {
  return {
    analysisMode: 'fast',
    ...(selection.sourceDepth ? {sourceDepth: selection.sourceDepth} : {}),
    ...(selection.codeAwareMode ? {codeAwareMode: selection.codeAwareMode} : {}),
    ...(selection.codebases ? {codebaseIds: selection.codebases.map(key => ids[key])} : {}),
    ...(selection.knowledge && knowledge ? {knowledgeSourceIds: [knowledge.sourceId]} : {}),
  };
}

async function analyze(app: express.Express, input: {query: string; sessionId?: string} & Selection,
  plan?: TurnPlan): Promise<request.Response> {
  if (plan) plans.push(plan);
  const response = await analyst(request(app).post('/api/agent/v1/analyze')).send({
    traceId, query: input.query, ...(input.sessionId ? {sessionId: input.sessionId} : {}),
    options: selectionOptions(input),
  });
  if (response.status === 200) {
    sessionsToClean.add(response.body.sessionId);
    await waitForCompleted(response.body.runId);
  } else if (plan) {
    plans.splice(plans.indexOf(plan), 1);
  }
  return response;
}

/** Turn 1: a private run that reads one registered file and quotes it. */
async function sourceTurn(app: express.Express, selection: Selection, read: TurnPlan['read']) {
  const first = await analyze(app, {query: 'What does the startup hook say?', ...selection}, {read});
  expect(first.status).toBe(200);
  expect(lastTurn().sourceRead).toBeDefined();
  return first.body.sessionId as string;
}

function lastTurn(): ObservedTurn {
  return observed[observed.length - 1];
}

function restartBackend(sessionId: string): void {
  agentRoutesCancellationTestSeam.deleteSession(sessionId);
  sessionContextManager.remove(sessionId);
}

beforeEach(async () => {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'source-authorization-reset-')));
  const roots = path.join(tmpDir, 'roots');
  delete process.env.SMARTPERFETTO_API_KEY;
  delete process.env.SMARTPERFETTO_CODE_AWARE;
  delete process.env.CLAUDE_FULL_PER_TURN_MS;
  process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'true';
  process.env[ENTERPRISE_FEATURE_FLAG_ENV] = 'true';
  process.env[ENTERPRISE_DB_PATH_ENV] = path.join(tmpDir, 'enterprise.sqlite');
  process.env[ENTERPRISE_DATA_DIR_ENV] = path.join(tmpDir, 'data');
  process.env.UPLOAD_DIR = path.join(tmpDir, 'uploads');
  process.env.PROVIDER_DATA_DIR_OVERRIDE = path.join(tmpDir, 'providers');
  process.env.SMARTPERFETTO_AGENT_RUNTIME = 'claude-agent-sdk';
  process.env.SMARTPERFETTO_OUTPUT_LANGUAGE = 'en';
  process.env.SMARTPERFETTO_CODEBASE_ROOTS = roots;
  process.env.SMARTPERFETTO_BACKEND_LOG_DIR = path.join(tmpDir, 'logs');
  SessionPersistenceService.resetForTests();
  // Admission work these tests do not exercise: the pack resolver reads the pack from disk on every
  // run, and the Skill fingerprint hashes the same pinned registry each time (the registry snapshot
  // itself is cached and stays real, since the run's MCP server reads it).
  jest.spyOn(getDefaultAndroidInternalsPackResolver(), 'resolve').mockReturnValue(undefined);
  jest.spyOn(skillFingerprint, 'buildSkillRegistryAttribution').mockImplementation(registryToFingerprint => {
    const cached = skillRegistryAttributions.get(registryToFingerprint);
    if (cached) return cached;
    const attribution = buildRealSkillRegistryAttribution(registryToFingerprint);
    skillRegistryAttributions.set(registryToFingerprint, attribution);
    return attribution;
  });
  resetProviderService();

  const tracePath = path.join(tmpDir, `${traceId}.trace`);
  fs.writeFileSync(tracePath, 'trace bytes');
  await writeTraceMetadata({id: traceId, filename: `${traceId}.trace`, size: 11,
    uploadedAt: new Date().toISOString(), status: 'ready', path: tracePath, ...scope});
  traceService = new TraceProcessorService(process.env.UPLOAD_DIR);
  traceService.registerStoredTrace({id: traceId, filename: `${traceId}.trace`, size: 11, filePath: tracePath});
  jest.spyOn(traceService, 'getOrLoadTrace').mockImplementation(async id => traceService.getTrace(id) ?? null as any);
  jest.spyOn(traceService, 'ensureProcessorForLease').mockImplementation(async id => ({
    id: `processor-${id}`, traceId: id, status: 'ready', activeQueries: 0,
    query: jest.fn(async () => ({columns: [], rows: [], durationMs: 1})),
    queryRaw: jest.fn(async () => Buffer.alloc(0)), destroy: jest.fn(),
  }) as any);
  jest.spyOn(traceService, 'query').mockResolvedValue({columns: [], rows: [], durationMs: 1});
  setTraceProcessorServiceForTests(traceService);

  const rootA = path.join(roots, 'app-a');
  const rootB = path.join(roots, 'app-b');
  writeSource(rootA, 'src/feature/Startup.kt', 'object Startup { fun installHooks() = Unit }\n');
  writeSource(rootA, 'src/internal/Hidden.kt', `object Hidden { val marker = "${SOURCE_CANARY}" }\n`);
  writeSource(rootB, 'src/Hooks.kt', `object Hooks { val marker = "${SOURCE_CANARY}" }\n`);
  registry = new CodebaseRegistry(path.join(tmpDir, 'codebases.json'));
  ids = {
    A: registry.register({kind: 'app_source', displayName: 'App A', rootPath: rootA, pathFilters: ['src'],
      sendToProvider: true, ...scope}).codebaseId,
    B: registry.register({kind: 'app_source', displayName: 'App B', rootPath: rootB, pathFilters: ['src'],
      sendToProvider: true, ...scope}).codebaseId,
  };
  jest.spyOn(defaultCodebaseServices, 'getDefaultCodebaseRegistry').mockReturnValue(registry);
  knowledge = undefined;
  observed = [];
  plans = [];
  probe = undefined;
  jest.spyOn(ClaudeRuntime.prototype, 'analyze').mockImplementation(async function (query, sessionId, runTraceId, options) {
    return simulatedRun(query, sessionId, runTraceId, options);
  });
});

afterEach(() => {
  for (const sessionId of sessionsToClean) {
    agentRoutesCancellationTestSeam.deleteSession(sessionId);
    sessionContextManager.remove(sessionId);
    clearCodeAwareOutputGuards(sessionId);
  }
  sessionsToClean.clear();
  jest.restoreAllMocks();
  setTraceProcessorServiceForTests(null);
  setTraceProcessorLeaseStoreForTests(null);
  SessionPersistenceService.resetForTests();
  resetAgentEventStoreForTests();
  resetAnalysisRunStoreForTests();
  clearRunManifestLifecyclesForTests();
  resetRunManifestStoreForTests();
  resetProviderService();
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(tmpDir, {recursive: true, force: true});
});

describe('HTTP: a source authorization change replaces the session (G1)', () => {
  it.each(['off', 'metadata_only'] as const)('provider_send then %s on the same session id', async mode => {
    const app = makeApp();
    const cleanup = jest.spyOn(ClaudeRuntime.prototype, 'cleanupSession');
    const firstSessionId = await sourceTurn(app, {codeAwareMode: 'provider_send', codebases: ['A', 'B']},
      {codebase: 'B', filePath: 'src/Hooks.kt'});
    probe = {codebase: 'B', filePath: 'src/Hooks.kt'};
    const reads = jest.spyOn(registry, 'get');
    reads.mockClear();

    const second = await analyze(app, {query: 'Continue', sessionId: firstSessionId, codeAwareMode: mode,
      codebases: ['A', 'B']});

    expect(second.status).toBe(200);
    expect(second.body.sessionId).not.toBe(firstSessionId);
    expect(cleanup).toHaveBeenCalledWith(firstSessionId);
    expect(agentRoutesCancellationTestSeam.getSession(firstSessionId)).toBeUndefined();
    const turn = lastTurn();
    expect(turn.sessionId).toBe(second.body.sessionId);
    expectCleanTurn(turn, 'Continue', SOURCE_CANARY);
    if (mode === 'off') {
      // Codebase ids under off authorize nothing: no source tool, no registry read, no file access.
      expect(turn.options.codebaseIds).toBeUndefined();
      expect(turn.tools.filter((name: string) => SOURCE_TOOLS.includes(name))).toEqual([]);
      expect(turn.probeRead).toEqual({notRegistered: 'read_codebase_file'});
      expect(reads).not.toHaveBeenCalled();
    } else {
      // Metadata only still locates, never returns the body.
      expect(turn.tools).toEqual(expect.arrayContaining(SOURCE_TOOLS));
      expect(JSON.stringify(turn.probeRead)).not.toContain(SOURCE_CANARY);
    }
  });
});

describe('HTTP: narrowing a selection replaces the session (G2)', () => {
  it('deselecting a codebase', async () => {
    const app = makeApp();
    const firstSessionId = await sourceTurn(app, {codeAwareMode: 'provider_send', codebases: ['A', 'B']},
      {codebase: 'B', filePath: 'src/Hooks.kt'});
    probe = {codebase: 'B', filePath: 'src/Hooks.kt'};
    const second = await analyze(app, {query: 'Only App A now', sessionId: firstSessionId,
      codeAwareMode: 'provider_send', codebases: ['A']});
    expect(second.status).toBe(200);
    expect(second.body.sessionId).not.toBe(firstSessionId);
    expectCleanTurn(lastTurn(), 'Only App A now', SOURCE_CANARY);
    expect(lastTurn().probeRead).toEqual(DESELECTED_CODEBASE_REFUSAL);
  });

  it('narrowing the path filters of the same registration', async () => {
    const app = makeApp();
    const firstSessionId = await sourceTurn(app, {codeAwareMode: 'provider_send', codebases: ['A']},
      {codebase: 'A', filePath: 'src/internal/Hidden.kt'});
    // Provably inside the grant: the narrowed selection becomes the grant, consent stays.
    const narrowed = registry.updateSelectionPolicy(ids.A, scope, {pathFilters: ['src/feature']});
    expect(narrowed.consent.sendToProvider).toBe(true);
    probe = {codebase: 'A', filePath: 'src/internal/Hidden.kt'};
    const second = await analyze(app, {query: 'Look at the feature code', sessionId: firstSessionId,
      codeAwareMode: 'provider_send', codebases: ['A']});
    expect(second.status).toBe(200);
    expect(second.body.sessionId).not.toBe(firstSessionId);
    expectCleanTurn(lastTurn(), 'Look at the feature code', SOURCE_CANARY);
    expect(lastTurn().probeRead).toMatchObject({success: false});
  });

  it('revoking provider consent', async () => {
    const app = makeApp();
    const firstSessionId = await sourceTurn(app, {codeAwareMode: 'provider_send', codebases: ['A', 'B']},
      {codebase: 'B', filePath: 'src/Hooks.kt'});
    const metadataBefore = buildAnalysisContextAuthorizationFingerprint(
      {codeAwareMode: 'metadata_only', codebaseIds: [ids.A, ids.B]}, scope);
    registry.setProviderConsent(ids.B, scope, false, scope.userId);
    // The consent change alone moves the fingerprint of an otherwise identical selection.
    expect(buildAnalysisContextAuthorizationFingerprint(
      {codeAwareMode: 'metadata_only', codebaseIds: [ids.A, ids.B]}, scope)).not.toBe(metadataBefore);

    const refused = await analyze(app, {query: 'Send it again', sessionId: firstSessionId,
      codeAwareMode: 'provider_send', codebases: ['A', 'B']});
    expect(refused.status).toBe(409);
    expect(observed).toHaveLength(1);

    probe = {codebase: 'B', filePath: 'src/Hooks.kt'};
    const second = await analyze(app, {query: 'Locate only', sessionId: firstSessionId,
      codeAwareMode: 'metadata_only', codebases: ['A', 'B']});
    expect(second.status).toBe(200);
    expect(second.body.sessionId).not.toBe(firstSessionId);
    expectCleanTurn(lastTurn(), 'Locate only', SOURCE_CANARY);
  });

  it('deleting a selected codebase', async () => {
    const app = makeApp();
    const firstSessionId = await sourceTurn(app, {codeAwareMode: 'provider_send', codebases: ['A', 'B']},
      {codebase: 'B', filePath: 'src/Hooks.kt'});
    await registry.withIngestLease(ids.B, scope, lease => {
      lease.beginDeletion(scope.userId);
      return lease.deleteRegistration();
    }, 'delete');

    const refused = await analyze(app, {query: 'Both again', sessionId: firstSessionId,
      codeAwareMode: 'provider_send', codebases: ['A', 'B']});
    // The start gate refuses a deleted selection as not found, before any analysis is dispatched.
    expect(refused.status).toBe(404);
    expect(refused.body).toMatchObject({success: false, code: 'ANALYSIS_CONTEXT_CODEBASE_NOT_FOUND'});
    expect(observed).toHaveLength(1);

    probe = {codebase: 'B', filePath: 'src/Hooks.kt'};
    const second = await analyze(app, {query: 'Only App A', sessionId: firstSessionId,
      codeAwareMode: 'provider_send', codebases: ['A']});
    expect(second.status).toBe(200);
    expect(second.body.sessionId).not.toBe(firstSessionId);
    expectCleanTurn(lastTurn(), 'Only App A', SOURCE_CANARY);
    // The deleted codebase is no longer selectable: an explicit policy refusal, not a tool failure.
    expect(lastTurn().probeRead).toEqual(DESELECTED_CODEBASE_REFUSAL);
  });

  it('keeps the session and its history for an identical or equivalent resubmission (control)', async () => {
    const app = makeApp();
    const cleanup = jest.spyOn(ClaudeRuntime.prototype, 'cleanupSession');
    const firstSessionId = await sourceTurn(app, {codeAwareMode: 'provider_send', codebases: ['A']},
      {codebase: 'A', filePath: 'src/internal/Hidden.kt'});
    // Repeating the current consent and an equivalent selection changes no authorization.
    registry.setProviderConsent(ids.A, scope, true, scope.userId);
    registry.updateSelectionPolicy(ids.A, scope, {pathFilters: ['src/']});

    const second = await analyze(app, {query: 'And then?', sessionId: firstSessionId,
      codeAwareMode: 'provider_send', codebases: ['A']});
    expect(second.status).toBe(200);
    expect(second.body.sessionId).toBe(firstSessionId);
    expect(cleanup).not.toHaveBeenCalledWith(firstSessionId);
    const turn = lastTurn();
    expect(turn.preview).toContain(SOURCE_CANARY);
    expect(turn.historyIndex).toMatchObject({totalTurns: 1});
    expect(JSON.stringify(turn.historyTurns)).toContain(SOURCE_CANARY);
  });
});

describe('HTTP: an earlier indexed lookup grants no patch after narrowing (G2 ledger)', () => {
  /**
   * Both codebases' chunks are stored; each codebase in `active` gets an active index. App B's
   * single chunk is the one turn 1 looks up.
   */
  function indexBothCodebases(active: ReadonlyArray<'A' | 'B'> = ['A', 'B']): RagStore {
    const ragStore = new RagStore(path.join(tmpDir, 'rag.json'));
    for (const [key, chunkId, filePath, snippet] of [
      ['A', 'p9a-indexed-startup-chunk', 'src/feature/Startup.kt', 'object Startup { fun warmUp() = Unit }'],
      ['B', INDEXED_CHUNK_ID, 'src/Hooks.kt', 'object Hooks'],
    ] as const) {
      const ref = registry.get(ids[key], scope)!;
      const generation = `p9a-generation-${key}`;
      if (active.includes(key)) registry.activateIndexGeneration(ids[key], scope, ref.indexGeneration,
        {lastIngestStatus: 'ok', activeGeneration: generation, contentFingerprint: 'a'.repeat(64), chunkCount: 1});
      ragStore.addChunk({chunkId, kind: 'app_source', registryOrigin: 'codebase_registry', codebaseId: ids[key],
        sourceGeneration: generation, uri: `codebase://${ids[key]}/${filePath}`, filePath, lineRange: {start: 1, end: 1},
        symbol: snippet.split(' ')[1], snippet, indexedAt: Date.now()}, scope);
    }
    jest.spyOn(ragStores, 'getDefaultRagStore').mockReturnValue(ragStore);
    return ragStore;
  }

  const ledgerOf = (sessionId: string): Array<Record<string, any>> => {
    const file = path.join(tmpDir, 'logs', 'sessions', `${sessionId}.codeLookupLedger.jsonl`);
    return fs.existsSync(file)
      ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  };
  const mechanism = {codeAwareMode: 'provider_send' as const, sourceDepth: 'mechanism' as const};

  /** Watches what a refused patch call must never reach: a chunk body, the ledger, the proposer. */
  function watchPatchReads() {
    return {
      bodies: jest.spyOn(RagStore.prototype, 'getChunk'),
      ledger: jest.spyOn(CodeLookupLedger.prototype, 'priorLookupOf'),
      proposer: jest.spyOn(PatchProposer.prototype, 'propose'),
    };
  }
  function expectNothingRead(reads: ReturnType<typeof watchPatchReads>): void {
    expect(reads.bodies).not.toHaveBeenCalled();
    expect(reads.ledger).not.toHaveBeenCalled();
    expect(reads.proposer).not.toHaveBeenCalled();
  }

  /** Turn 1: a real indexed lookup of App B, written to the session's ledger. */
  async function lookupTurn(app: express.Express): Promise<string> {
    const first = await analyze(app, {query: 'Where are the hooks installed?', ...mechanism, codebases: ['A', 'B']},
      {lookup: 'Hooks'});
    expect(first.status).toBe(200);
    expect(lastTurn().tools).toEqual(expect.arrayContaining(['lookup_app_source', 'propose_patch']));
    expect(JSON.stringify(lastTurn().lookup)).toContain(INDEXED_CHUNK_ID);
    expect(ledgerOf(first.body.sessionId)).toEqual([expect.objectContaining({toolName: 'lookup_app_source',
      codebaseId: ids.B, chunkIds: [INDEXED_CHUNK_ID], outcome: 'success'})]);
    return first.body.sessionId;
  }

  it('admits a patch from that context in a later run under the same authorization (control)', async () => {
    indexBothCodebases();
    const app = makeApp();
    const sessionId = await lookupTurn(app);
    const control = await analyze(app, {query: 'Propose the fix', sessionId, ...mechanism, codebases: ['A', 'B']},
      {patch: true});
    expect(control.body.sessionId).toBe(sessionId);
    expect(lastTurn().patch).toMatchObject({success: true, result: {patchStatus: 'sketch',
      targetFiles: [{codebaseId: ids.B, path: 'src/Hooks.kt'}]}});
    expect(ledgerOf(sessionId).map(entry => [entry.toolName, entry.outcome])).toEqual([
      ['lookup_app_source', 'success'], ['propose_patch', 'patch_sketch']]);
  });

  it('refuses a patch from that context once the selection is narrowed', async () => {
    indexBothCodebases();
    const app = makeApp();
    const sessionId = await lookupTurn(app);
    const reads = watchPatchReads();
    const narrowed = await analyze(app, {query: 'Propose the fix', sessionId, ...mechanism, codebases: ['A']},
      {patch: true});
    expect(narrowed.status).toBe(200);
    expectNothingRead(reads);
    expect(narrowed.body.sessionId).not.toBe(sessionId);
    const turn = lastTurn();
    expectCleanTurn(turn, 'Propose the fix', SOURCE_CANARY);
    // The narrowed run can propose patches, but not for a codebase it no longer selects.
    expect(turn.tools).toContain('propose_patch');
    expect(turn.patch).toEqual(PATCH_TARGET_NOT_SELECTED);
    expect(ledgerOf(narrowed.body.sessionId).filter(entry => entry.outcome === 'patch_sketch')).toEqual([]);
  });

  it('refuses a deselected target by selection even when the ledger would admit it', async () => {
    indexBothCodebases();
    const app = makeApp();
    const sessionId = await lookupTurn(app);
    // Defence in depth: the ledger check is bypassed, so only the selection check stands.
    const bypass = jest.spyOn(CodeLookupLedger.prototype, 'hasPriorLookupOf').mockReturnValue(true);
    const reads = watchPatchReads();
    const narrowed = await analyze(app, {query: 'Propose the fix', sessionId, ...mechanism, codebases: ['A']},
      {patch: true});
    expect(narrowed.status).toBe(200);
    expectNothingRead(reads);
    expect(bypass).not.toHaveBeenCalled();
    expect(lastTurn().patch).toEqual(PATCH_TARGET_NOT_SELECTED);
    expect(JSON.stringify(lastTurn().patch)).not.toContain(ids.B);
  });

  it('refuses context a rebuild collected as missing, after narrowing, without echoing it', async () => {
    const ragStore = indexBothCodebases();
    const app = makeApp();
    const sessionId = await lookupTurn(app);
    // A rebuild of App B collects the chunk turn 1 looked up.
    expect(ragStore.removeChunk(INDEXED_CHUNK_ID, scope)).toBe(true);
    const narrowed = await analyze(app, {query: 'Propose the fix', sessionId, ...mechanism, codebases: ['A']},
      {patch: true});
    expect(narrowed.status).toBe(200);
    const patch = lastTurn().patch!;
    // No owner is left to judge, so the selection check passes it on; the proposer refuses missing context.
    expect(patch).toMatchObject({success: false, action_required: 'lookup_source_before_patch',
      result: {patchStatus: 'unverified', targetFiles: [], unsupportedReason: 'missing_context_chunk'}});
    const text = JSON.stringify(patch);
    for (const forbidden of ['object Hooks', 'src/', ids.B, '---', '+++', '@@']) expect(text).not.toContain(forbidden);
    expect(patch.result).not.toHaveProperty('diff');
    expect(patch.result).not.toHaveProperty('proposedDiff');
  });

  it('refuses a selected target whose codebase has no active index', async () => {
    indexBothCodebases(['A']);
    jest.spyOn(CodeLookupLedger.prototype, 'hasPriorLookupOf').mockReturnValue(true);
    const reads = watchPatchReads();
    const app = makeApp();
    const first = await analyze(app, {query: 'Propose the fix', ...mechanism, codebases: ['A', 'B']}, {patch: true});
    expect(first.status).toBe(200);
    expectNothingRead(reads);
    expect(lastTurn().tools).toContain('propose_patch');
    expect(lastTurn().patch).toEqual({success: false, action_required: expect.any(String), codebaseId: ids.B,
      unsupportedReason: 'codebase_index_unavailable'});
    expect(JSON.stringify(lastTurn().patch)).not.toContain('src/');
  });
});

describe('HTTP: knowledge selection is independent of the codebase change (G4)', () => {
  it('keeps the selected knowledge base usable in the new session', async () => {
    const docsRoot = path.join(tmpDir, 'docs');
    writeSource(docsRoot, 'render/compositor.md', [
      '# Render framework', '', `## ${KNOWLEDGE_TERM}`, '',
      `${KNOWLEDGE_TERM} composes every frame for the team render framework.`,
    ].join('\n'));
    process.env.SMARTPERFETTO_KNOWLEDGE_ROOTS = docsRoot;
    const knowledgeRegistry = new ExternalKnowledgeSourceRegistry(path.join(tmpDir, 'knowledge.json'));
    const store = new DocumentCollectionStore(path.join(tmpDir, 'knowledge-index'));
    const source = knowledgeRegistry.register({kind: 'document_collection', displayName: 'Team render docs',
      rootRealpath: docsRoot, revision: 'initial', contentFingerprint: 'initial', dirty: false,
      rightsAcknowledged: true, sendToProvider: true, consentedBy: scope.userId, scope});
    await new DocumentCollectionIngester(knowledgeRegistry, store).ingest(source.sourceId, scope);
    jest.spyOn(externalKnowledgeServices, 'getDefaultExternalKnowledgeSourceRegistry').mockReturnValue(knowledgeRegistry);
    jest.spyOn(documentCollectionStores, 'getDefaultDocumentCollectionStore').mockReturnValue(store);
    knowledge = {registry: knowledgeRegistry, store, sourceId: source.sourceId};

    const app = makeApp();
    const firstSessionId = await sourceTurn(app, {codeAwareMode: 'provider_send', codebases: ['A'], knowledge: true},
      {codebase: 'A', filePath: 'src/internal/Hidden.kt'});
    const second = await analyze(app, {query: 'What does the render worker do?', sessionId: firstSessionId,
      codeAwareMode: 'off', codebases: ['A'], knowledge: true});

    expect(second.status).toBe(200);
    expect(second.body.sessionId).not.toBe(firstSessionId);
    const turn = lastTurn();
    expectCleanTurn(turn, 'What does the render worker do?', SOURCE_CANARY);
    expect(turn.options.knowledgeSourceIds).toEqual([source.sourceId]);
    expect(turn.tools).toEqual(expect.arrayContaining(['search_knowledge', 'read_knowledge_section']));
    expect(turn.tools.filter((name: string) => SOURCE_TOOLS.includes(name))).toEqual([]);
    expect(turn.knowledgeSearch).toMatchObject({success: true});
    expect(JSON.stringify(turn.knowledgeSearch)).toContain(KNOWLEDGE_TERM);
  });
});

describe('HTTP: restore paths keep authorization (G5)', () => {
  it.each(['off', 'provider_send'] as const)('never restores a private session after a restart (next turn %s)', async mode => {
    const app = makeApp();
    const firstSessionId = await sourceTurn(app, {codeAwareMode: 'provider_send', codebases: ['A']},
      {codebase: 'A', filePath: 'src/internal/Hidden.kt'});
    restartBackend(firstSessionId);

    const resumed = await analyst(request(app).post('/api/agent/v1/resume')).send({sessionId: firstSessionId, traceId});
    expect(resumed.status).toBe(404);
    expect(agentRoutesCancellationTestSeam.getSession(firstSessionId)).toBeUndefined();

    const second = await analyze(app, {query: 'After restart', sessionId: firstSessionId, codeAwareMode: mode,
      codebases: ['A']});
    expect(second.status).toBe(200);
    expect(second.body.sessionId).not.toBe(firstSessionId);
    expectCleanTurn(lastTurn(), 'After restart', SOURCE_CANARY);
  });

  it('keeps public history through /resume when only the provider snapshot changed', async () => {
    const app = makeApp();
    const first = await analyze(app, {query: 'Public question'}, {answer: `Public answer ${PUBLIC_MARKER}.`});
    expect(first.status).toBe(200);
    const sessionId = first.body.sessionId as string;
    restartBackend(sessionId);
    process.env.CLAUDE_FULL_PER_TURN_MS = '123456';

    const resumed = await analyst(request(app).post('/api/agent/v1/resume')).send({sessionId, traceId});
    expect(resumed.status).toBe(200);
    expect(resumed.body).toMatchObject({sessionId, restored: true, providerSnapshotChanged: true});
    const second = await analyze(app, {query: 'Public follow-up', sessionId});
    expect(second.status).toBe(200);
    expect(second.body.sessionId).toBe(sessionId);
    expect(lastTurn().preview).toContain(PUBLIC_MARKER);
  });

  it('restores public history directly through analyze, but not under a new authorization', async () => {
    const app = makeApp();
    const first = await analyze(app, {query: 'Public question'}, {answer: `Public answer ${PUBLIC_MARKER}.`});
    const sessionId = first.body.sessionId as string;
    restartBackend(sessionId);
    const same = await analyze(app, {query: 'Same selection', sessionId});
    expect(same.body.sessionId).toBe(sessionId);
    expect(lastTurn().preview).toContain(PUBLIC_MARKER);

    restartBackend(sessionId);
    const widened = await analyze(app, {query: 'Now with source', sessionId, codeAwareMode: 'provider_send',
      codebases: ['A']});
    expect(widened.status).toBe(200);
    expect(widened.body.sessionId).not.toBe(sessionId);
    expect(lastTurn().preview).toBe('');
    expect(lastTurn().historyIndex).toMatchObject({totalTurns: 0});
  });

  it('compares a resumed session with the current authorization on its next analysis', async () => {
    const app = makeApp();
    const first = await analyze(app, {query: 'Public question'}, {answer: `Public answer ${PUBLIC_MARKER}.`});
    const sessionId = first.body.sessionId as string;
    restartBackend(sessionId);
    const resumed = await analyst(request(app).post('/api/agent/v1/resume')).send({sessionId, traceId});
    expect(resumed.status).toBe(200);
    const cleanup = jest.spyOn(ClaudeRuntime.prototype, 'cleanupSession');

    const second = await analyze(app, {query: 'Now with source', sessionId, codeAwareMode: 'metadata_only',
      codebases: ['A']});
    expect(second.status).toBe(200);
    expect(second.body.sessionId).not.toBe(sessionId);
    expect(cleanup).toHaveBeenCalledWith(sessionId);
    expect(lastTurn().historyIndex).toMatchObject({totalTurns: 0});
  });

  it('restores nothing when the trace cannot be reloaded, then falls back by fingerprint', async () => {
    const app = makeApp();
    const first = await analyze(app, {query: 'Public question'}, {answer: `Public answer ${PUBLIC_MARKER}.`});
    const sessionId = first.body.sessionId as string;
    restartBackend(sessionId);
    jest.mocked(traceService.getOrLoadTrace).mockResolvedValueOnce(null as any);

    const resumed = await analyst(request(app).post('/api/agent/v1/resume')).send({sessionId, traceId});
    expect(resumed.status).toBe(404);
    expect(resumed.body.code).toBe('TRACE_NOT_UPLOADED');
    expect(agentRoutesCancellationTestSeam.getSession(sessionId)).toBeUndefined();

    const second = await analyze(app, {query: 'Now with source', sessionId, codeAwareMode: 'provider_send',
      codebases: ['A']});
    expect(second.status).toBe(200);
    expect(second.body.sessionId).not.toBe(sessionId);
    expect(lastTurn().historyIndex).toMatchObject({totalTurns: 0});
  });
});
