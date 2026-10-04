// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * CLI continuation after a source authorization change (G3).
 *
 * A CLI session has two identities: its directory (config, transcript,
 * turns), which stays the same for the user, and the backend session it runs
 * on. A first turn under a provider-send selection answers from a registered
 * file and the transcript keeps that answer. When the registration's selection
 * is narrowed before the next REPL turn, the backend session is replaced, and
 * neither the backend history nor the directory transcript may put the earlier
 * answer into the next turn's model input. The real CLI service, session
 * service and codebase registry run; only the provider call and the report and
 * persistence side channels are simulated.
 */

import {EventEmitter} from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';

import * as agentRuntime from '../../../agentRuntime';
import type {AnalysisOptions, AnalysisResult} from '../../../agent/core/orchestratorTypes';
import {CliAnalyzeService} from '../cliAnalyzeService';
import {continueSession, startSession} from '../turnRunner';
import {sessionPaths, type CliPaths} from '../../io/paths';
import type {Renderer} from '../../repl/renderer';
import {sessionContextManager} from '../../../agent/context/enhancedSessionContext';
import {
  expectCleanTurn,
  observeModelInput,
  recordRuntimeTurn,
  type ObservedModelInput,
} from '../../../../tests/helpers/sourceAuthorizationGate';
import {clearCodeAwareOutputGuards} from '../../../services/security/codeAwareOutputRegistry';
import * as defaultCodebaseServices from '../../../services/codebase/defaultCodebaseServices';
import {CodebaseRegistry, resolveCodebaseScope} from '../../../services/codebase/codebaseRegistry';
import {SessionPersistenceService} from '../../../services/sessionPersistenceService';
import {ENTERPRISE_DB_PATH_ENV} from '../../../services/enterpriseDb';
import {resetProviderService} from '../../../services/providerManager';
import type {FinalizeAnalysisResultInput, FinalizedAnalysisResult} from '../../../services/finalizeAnalysisResult';

jest.mock('../../../services/analysisRunTraceProcessorLease', () => ({
  prepareAnalysisRunTraceProcessorLeases: async () => ({entries: [], assertCurrent: () => undefined,
    release: () => undefined, run: async (fn: () => Promise<unknown>) => fn()}),
}));
jest.mock('../../../services/persistAgentSession', () => ({persistAgentTurn: () => undefined}));
jest.mock('../../../services/analysisRunStore', () => ({persistAnalysisRunState: () => undefined}));
jest.mock('../../../services/htmlReportGenerator', () => ({
  getHTMLReportGenerator: () => ({generateAgentDrivenHTML: () => '<html></html>'}),
}));
jest.mock('../../../services/finalizeAnalysisResult', () => ({
  finalizeAnalysisResult: async (input: FinalizeAnalysisResultInput): Promise<FinalizedAnalysisResult> => {
    try {
      input.owner.assertAuthorized();
      return {result: input.result};
    } finally {input.context?.dispose();}
  },
}));
jest.mock('../../../services/managedTraceSummary', () => ({
  executeManagedTraceSummaryV1: async () => {throw new Error('summary unavailable');},
}));
jest.mock('../../../services/traceProcessorService', () => ({
  getTraceProcessorService: () => ({getTrace: () => undefined, cleanup: () => undefined}),
}));
type CliRunTurnMocks = typeof import('../../../../tests/helpers/cliRunTurnMocks');
jest.mock('../../../services/skillPacks/workspaceSkillRegistryProvider', () =>
  jest.requireActual<CliRunTurnMocks>('../../../../tests/helpers/cliRunTurnMocks').workspaceSkillRegistryProviderModule());
jest.mock('../../../services/selfEvolution/effectiveRuntimeRegistryProvider', () =>
  jest.requireActual<CliRunTurnMocks>('../../../../tests/helpers/cliRunTurnMocks').effectiveRuntimeRegistryProviderModule());
jest.mock('../../../services/selfEvolution/skillFingerprint', () =>
  jest.requireActual<CliRunTurnMocks>('../../../../tests/helpers/cliRunTurnMocks').skillFingerprintModule());
jest.mock('../../../services/selfEvolution/runManifestLifecycle', () =>
  jest.requireActual<CliRunTurnMocks>('../../../../tests/helpers/cliRunTurnMocks').runManifestLifecycleModule());

const SOURCE_CANARY = 'P9A_CLI_SOURCE_ANSWER_CANARY';
const TRACE_ID = 'trace-cli-source-gate';


let tmpDir: string;
let paths: CliPaths;
let registry: CodebaseRegistry;
let codebaseId: string;
let observed: ObservedModelInput[];
let orchestrators: Array<EventEmitter & {cleanupSession: jest.Mock; abortSession: jest.Mock}>;
const savedEnv = new Map<string, string | undefined>();
const ENV_KEYS = [ENTERPRISE_DB_PATH_ENV, 'PROVIDER_DATA_DIR_OVERRIDE', 'SMARTPERFETTO_AGENT_RUNTIME',
  'SMARTPERFETTO_OUTPUT_LANGUAGE', 'SMARTPERFETTO_CODE_AWARE'];

function renderer(): Renderer {
  return {format: 'json', onEvent: jest.fn(), printConclusion: jest.fn(), printError: jest.fn(), printCompletion: jest.fn()};
}

/** The simulated provider call: the model input a runtime would build, then a scripted answer. */
function simulatedOrchestrator() {
  const orchestrator = Object.assign(new EventEmitter(), {
    cleanupSession: jest.fn(), abortSession: jest.fn(),
    analyze: jest.fn(async (query: string, sessionId: string, traceId: string,
      options: AnalysisOptions = {}): Promise<AnalysisResult> => {
      observed.push(observeModelInput(query, sessionId, traceId, options));
      const conclusion = observed.length === 1
        ? `The registered hook says ${SOURCE_CANARY}.` : 'No earlier source was needed.';
      recordRuntimeTurn(query, sessionId, traceId, options, conclusion);
      return {sessionId, success: true, findings: [], hypotheses: [], conclusion, confidence: 0.8,
        rounds: 1, totalDurationMs: 1};
    }),
  });
  orchestrators.push(orchestrator);
  return orchestrator;
}

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cli-source-gate-')));
  process.env[ENTERPRISE_DB_PATH_ENV] = path.join(tmpDir, 'sessions.sqlite');
  process.env.PROVIDER_DATA_DIR_OVERRIDE = path.join(tmpDir, 'providers');
  process.env.SMARTPERFETTO_AGENT_RUNTIME = 'openai-agents-sdk';
  process.env.SMARTPERFETTO_OUTPUT_LANGUAGE = 'en';
  delete process.env.SMARTPERFETTO_CODE_AWARE;
  SessionPersistenceService.resetForTests();
  resetProviderService();
  paths = {home: tmpDir, sessionsRoot: path.join(tmpDir, 'sessions'), tracesRoot: path.join(tmpDir, 'traces'),
    indexFile: path.join(tmpDir, 'index.json')};
  fs.writeFileSync(path.join(tmpDir, 'trace.pftrace'), 'trace bytes');
  const root = path.join(tmpDir, 'app');
  fs.mkdirSync(path.join(root, 'src', 'feature'), {recursive: true});
  fs.mkdirSync(path.join(root, 'src', 'internal'), {recursive: true});
  fs.writeFileSync(path.join(root, 'src', 'feature', 'Startup.kt'), 'object Startup\n');
  fs.writeFileSync(path.join(root, 'src', 'internal', 'Hooks.kt'), 'object Hooks\n');
  registry = new CodebaseRegistry(path.join(tmpDir, 'codebases.json'));
  codebaseId = registry.register({kind: 'app_source', displayName: 'CLI App', rootPath: root,
    rootAuthorization: 'local_cli', pathFilters: ['src'], sendToProvider: true, ...resolveCodebaseScope()}).codebaseId;
  jest.spyOn(defaultCodebaseServices, 'getDefaultCodebaseRegistry').mockReturnValue(registry);
  observed = [];
  orchestrators = [];
  jest.spyOn(agentRuntime, 'createAgentOrchestrator').mockImplementation(() => simulatedOrchestrator() as any);
});

afterEach(() => {
  for (const turn of observed) {
    sessionContextManager.remove(turn.sessionId);
    clearCodeAwareOutputGuards(turn.sessionId);
  }
  jest.restoreAllMocks();
  SessionPersistenceService.resetForTests();
  resetProviderService();
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(tmpDir, {recursive: true, force: true});
});

async function firstTurn(service: CliAnalyzeService) {
  jest.spyOn(service, 'loadTrace').mockResolvedValue(TRACE_ID);
  const started = await startSession({paths, service, renderer: renderer()}, {
    tracePath: path.join(tmpDir, 'trace.pftrace'), query: 'What does the hook do?',
    codeAwareMode: 'provider_send', codebaseIds: [codebaseId],
  });
  const sp = sessionPaths(paths, started.sessionId);
  const transcript = fs.readFileSync(sp.transcript, 'utf8');
  // The directory transcript keeps the private answer, bound to its authorization.
  expect(transcript).toContain(SOURCE_CANARY);
  expect(JSON.parse(transcript.trim().split('\n')[0]).history).toMatchObject({sourceDerived: true,
    analysisContextFingerprint: expect.stringMatching(/^acf2:/)});
  return {cliSessionId: started.sessionId, sp, backendSessionId: observed[0].sessionId};
}


describe('CLI continuation after a source authorization change (G3)', () => {
  it('replaces the backend session and keeps the directory transcript answer out of the model input', async () => {
    const service = new CliAnalyzeService();
    const first = await firstTurn(service);
    registry.updateSelectionPolicy(codebaseId, resolveCodebaseScope(), {pathFilters: ['src/feature']});
    jest.spyOn(service, 'reloadTraceById').mockResolvedValue(true);

    const continued = await continueSession({paths, service, renderer: renderer()},
      {sessionId: first.cliSessionId, query: 'Keep going'});

    expect(continued.sessionId).toBe(first.cliSessionId);
    const turn = observed[1];
    expect(turn.sessionId).not.toBe(first.backendSessionId);
    expect(orchestrators[0].cleanupSession).toHaveBeenCalledWith(first.backendSessionId);
    expectCleanTurn(turn, 'Keep going', SOURCE_CANARY);
    const config = JSON.parse(fs.readFileSync(first.sp.config, 'utf8'));
    expect(config).toMatchObject({sessionId: first.cliSessionId, backendSessionId: turn.sessionId});
  });

  it('keeps the transcript answer out after a trace reload failure too (degraded fresh backend)', async () => {
    const service = new CliAnalyzeService();
    const first = await firstTurn(service);
    registry.updateSelectionPolicy(codebaseId, resolveCodebaseScope(), {pathFilters: ['src/feature']});
    jest.spyOn(service, 'reloadTraceById').mockResolvedValue(false);

    const continued = await continueSession({paths, service, renderer: renderer()},
      {sessionId: first.cliSessionId, query: 'Keep going'});

    expect(continued).toMatchObject({sessionId: first.cliSessionId, degraded: true});
    expect(observed[1].sessionId).not.toBe(first.backendSessionId);
    expectCleanTurn(observed[1], 'Keep going', SOURCE_CANARY);
  });

  it('reads the transcript answer into a fresh backend under the same authorization (transcript control)', async () => {
    const service = new CliAnalyzeService();
    const first = await firstTurn(service);
    jest.spyOn(service, 'reloadTraceById').mockResolvedValue(false);

    await continueSession({paths, service, renderer: renderer()}, {sessionId: first.cliSessionId, query: 'Keep going'});

    // A new backend session has no history of its own: the answer comes from the directory transcript.
    expect(observed[1].sessionId).not.toBe(first.backendSessionId);
    expect(observed[1].preview).toContain(SOURCE_CANARY);
  });

  it('continues the same backend session with its history when nothing changed (control)', async () => {
    const service = new CliAnalyzeService();
    const first = await firstTurn(service);
    jest.spyOn(service, 'reloadTraceById').mockResolvedValue(true);

    await continueSession({paths, service, renderer: renderer()}, {sessionId: first.cliSessionId, query: 'Keep going'});

    const turn = observed[1];
    expect(turn.sessionId).toBe(first.backendSessionId);
    expect(orchestrators[0].cleanupSession).not.toHaveBeenCalled();
    expect(turn.preview).toContain(SOURCE_CANARY);
    expect(JSON.stringify(turn.historyTurns)).toContain(SOURCE_CANARY);
  });
});
