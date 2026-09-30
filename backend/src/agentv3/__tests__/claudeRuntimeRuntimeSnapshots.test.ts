// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { ENTERPRISE_FEATURE_FLAG_ENV } from '../../config';
import { sessionContextManager } from '../../agent/context/enhancedSessionContext';
import { ENTERPRISE_DB_PATH_ENV, openEnterpriseDb } from '../../services/enterpriseDb';
import {
  ENTERPRISE_MIGRATION_CUTOVER_CONFIRMED_ENV,
  ENTERPRISE_MIGRATION_PHASE_ENV,
} from '../../services/enterpriseMigration';
import { getProviderService, resetProviderService } from '../../services/providerManager';
import {SECRET_STORE_MASTER_KEY_ENV} from '../../services/providerManager/localSecretStore';
import { saveClaudeSessionMapToRuntimeSnapshots } from '../../services/runtimeSnapshotStore';
import * as runtimePromptContext from '../../agentRuntime/runtimePromptContext';
import {createRuntimePerformanceRecorder, createRuntimePerformanceRun} from '../../agentRuntime/runtimePerformance';
import {evaluationRuntimeCapabilities} from '../../services/selfEvolution/evaluationRuntimeCapabilities';
import * as sqlKnowledgeBase from '../../services/sqlKnowledgeBase';
import * as skillLoader from '../../services/skillEngine/skillLoader';
import {expectRuntimeVendorHintParity} from '../../agentRuntime/__tests__/vendorHintParityFixture';
import {TRACE_VENDOR_METADATA_SQL} from '../../services/traceVendor/traceVendorResolver';
import {
  withEffectiveRuntimeRegistrySnapshot,
  type EffectiveRuntimeRegistrySnapshot,
} from '../../services/selfEvolution/effectiveRuntimeRegistryContext';
import {
  clearCodeAwareOutputGuards,
  registerCodeAwareCanary,
  revokeCodeAwareOutputGuards,
  sanitizeCodeAwareStructuredTextWithReceipt,
} from '../../services/security/codeAwareOutputRegistry';
import * as focusAppDetector from '../focusAppDetector';
import * as architectureDetector from '../../agent/detectors/architectureDetector';
import * as traceCompletenessProber from '../traceCompletenessProber';
import {
  snapshotEvaluationUsageReceipt,
  withEvaluationTelemetry,
} from '../../services/selfEvolution/evaluationTelemetry';
import { ClaudeRuntime, __testing } from '../claudeRuntime';
import {buildStrategyRegistrySnapshotFromDefinitions, getRegisteredScenes} from '../strategyLoader';
import type {AnalysisTurnIntentDecision} from '../../agentRuntime/analysisTurnIntent';
import {resolveRuntimeTurnPolicy} from '../../agentRuntime/runtimeTurnPolicy';
import {analysisDeliveryFingerprint} from '../../types/analysisDelivery';
import {takeFinalizationContext} from '../../agentRuntime/analysisFinalizationContext';
import type {AnalysisOptions} from '../../agent/core/orchestratorTypes';
import {buildAnalysisContextAuthorizationFingerprint} from '../../services/resolvedAnalysisContext';
import * as contextAuthorization from '../../services/resolvedAnalysisContext';
import {resolveKnowledgeScope} from '../../services/scopedKnowledgeStore';
import {ArtifactStore} from '../artifactStore';
import * as claudeMcpServer from '../claudeMcpServer';
import * as claudeSystemPrompt from '../claudeSystemPrompt';
import * as sourceClaimVerifier from '../../services/codebase/sourceClaimVerifier';
import * as analysisPatternMemory from '../analysisPatternMemory';
import {
  createRuntimeSourceFinalizationFixture,
  SOURCE_FINALIZATION_CANARY,
  SOURCE_FINALIZATION_RAW_SOURCE,
} from '../../agentRuntime/__tests__/sourceFinalizationFixture';
import {resolveFocusPackageCell} from '../../agentRuntime/__tests__/focusEvidenceFixture';
import type {RunManifestAttributionSink} from '../../types/selfEvolution';
import {renderConclusionContractSidecar} from '../../agent/core/conclusionContract';
import {inspectCandidateProtocol} from '../../services/canonicalAnalysisResult';
import {createSceneRuntimeMatrixFixture} from '../../../tests/helpers/sceneRuntimeMatrixFixture';
import {candidateWithPopulation, declaredCandidateWithClaims, declaredClaim} from '../../../tests/helpers/conclusionDeclarationFixture';

function declaredCandidate(body: string): string {
  return `${body}\n${renderConclusionContractSidecar({schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer',
    conclusions: [], clusters: [], evidenceChain: [], claims: [], relationProposals: [], uncertainties: [], nextSteps: []})}`;
}

const mockClaudeVerifierVerifyConclusion = jest.fn();
jest.mock('../../agentRuntime/engines/claude/claudeVerifier', () => {
  const actual = jest.requireActual('../../agentRuntime/engines/claude/claudeVerifier') as any;
  return {
    ...actual,
    verifyConclusion: (...args: unknown[]) => mockClaudeVerifierVerifyConclusion(...args),
  };
});

const rawClaudeSdkMock = require('@anthropic-ai/claude-agent-sdk') as {
  __setQueryImplementation: (impl: (params: any) => AsyncIterable<any>) => void;
  __getQueryCalls: () => any[];
  __resetQueryMock: () => void;
};
const defaultIntent: AnalysisTurnIntentDecision = {
  schemaVersion: 1, taskKind: 'investigation', sceneId: 'startup', scope: 'scene_wide',
  recommendedComplexity: 'full', deliverable: 'report', evidenceAccess: 'read_new',
};
let intentDecision: AnalysisTurnIntentDecision = {...defaultIntent};
let classifierResult: Record<string, unknown> | undefined;
const isClassifierCall = (params: any) => params.options?.permissionMode === 'dontAsk'
  && params.options?.maxTurns === 1 && params.options?.systemPrompt === '';
const claudeSdkMock = {
  __setQueryImplementation(implementation: (params: any) => AsyncIterable<any>) {
    rawClaudeSdkMock.__setQueryImplementation(async function* (params: any) {
      if (isClassifierCall(params)) {
        yield classifierResult ?? {type: 'result', subtype: 'success', is_error: false,
          stop_reason: null, result: JSON.stringify(intentDecision)};
        return;
      }
      for await (const message of implementation(params)) {
        yield message.type === 'result' && message.subtype === 'success'
          ? {is_error: false, ...message} : message;
      }
    });
  },
  __getQueryCalls: () => rawClaudeSdkMock.__getQueryCalls().filter(call => !isClassifierCall(call)),
  __resetQueryMock: () => rawClaudeSdkMock.__resetQueryMock(),
};
function typedPreparation() {
  const strategyRegistry = buildStrategyRegistrySnapshotFromDefinitions({definitions: getRegisteredScenes(), overlayGeneration: 'builtin'});
  const turnIntent = {...intentDecision, status: 'resolved' as const, source: 'semantic' as const,
    registryFingerprint: strategyRegistry.registryFingerprint};
  return {turnIntent, strategyRegistry, turnPolicy: resolveRuntimeTurnPolicy(turnIntent)};
}

const originalEnv = {
  enterprise: process.env[ENTERPRISE_FEATURE_FLAG_ENV],
  enterpriseDbPath: process.env[ENTERPRISE_DB_PATH_ENV],
  migrationPhase: process.env[ENTERPRISE_MIGRATION_PHASE_ENV],
  cutoverConfirmed: process.env[ENTERPRISE_MIGRATION_CUTOVER_CONFIRMED_ENV],
  providerDataDirOverride: process.env.PROVIDER_DATA_DIR_OVERRIDE,
  secretStoreMasterKey: process.env[SECRET_STORE_MASTER_KEY_ENV],
  precompactThreshold: process.env.CLAUDE_PRECOMPACT_THRESHOLD,
  precompactWarnEnabled: process.env.CLAUDE_PRECOMPACT_WARN_ENABLED,
  admittedRuntimeCandidates: process.env.SMARTPERFETTO_ADMITTED_RUNTIME_CANDIDATES,
};

let tmpDir: string | undefined;
let dbPath: string;

function restoreEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

function runtimeSnapshotCount(): number {
  const db = openEnterpriseDb(dbPath);
  try {
    const row = db.prepare<unknown[], { count: number }>(
      'SELECT COUNT(*) AS count FROM runtime_snapshots',
    ).get();
    return row?.count ?? 0;
  } finally {
    db.close();
  }
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createNoopAttributionSink(
  runtimePerformanceRecorder = createRuntimePerformanceRecorder(),
): RunManifestAttributionSink {
  return {
    identity: {
      runId: 'run-claude-test',
      sessionId: 'session-claude',
      scope: {
        tenantId: 'tenant-test',
        workspaceId: 'workspace-test',
      },
    },
    runtimePerformanceRecorder,
    recordScene: jest.fn(),
    recordRuntime: jest.fn(),
    recordMode: jest.fn(),
    recordAdaptiveRouting: jest.fn(),
    recordCapabilityManifest: jest.fn(),
    recordSkillRegistry: jest.fn(),
    startSkillInvocation: jest.fn(() => 'skill-invocation-test'),
    finishSkillInvocation: jest.fn(),
    recordUnknownSkillInvocation: jest.fn(),
    recordSqlStatement: jest.fn(),
    recordPromptTemplate: jest.fn(),
    recordInjection: jest.fn(),
    recordToolAllowlist: jest.fn(),
    recordTurn: jest.fn(),
  };
}

function createEffectiveRuntimeRegistrySnapshot(): EffectiveRuntimeRegistrySnapshot {
  const skillRegistry = {
    registryFingerprint: 'registry-test',
    overlayGeneration: 'overlay-test',
    isInitialized: () => true as const,
    getSkill: () => undefined,
    getAllSkills: () => [],
    getFragmentCache: () => new Map<string, string>(),
    getSkillOrigin: () => undefined,
    getAppliedOverlayIds: () => [],
    getVendorOverride: () => undefined,
    hasVendorOverrides: () => false,
    getVendorOverridesForSkill: () => [],
    getVendorOverrideLoadIssues: () => [],
    findMatchingSkill: () => undefined,
  };
  return {
    scope: {tenantId: 'tenant-test', workspaceId: 'workspace-test'},
    baseSkillRegistryFingerprint: 'base-skills-test',
    baseStrategyRegistryFingerprint: 'base-strategies-test',
    overlayGeneration: 'overlay-test',
    skillRegistry,
    strategyRegistry: buildStrategyRegistrySnapshotFromDefinitions({
      definitions: getRegisteredScenes(), overlayGeneration: 'overlay-test',
    }),
    skillNotes: {
      registryFingerprint: 'skill-notes-test',
      getSkillNotes: () => [],
      getSkillIds: () => [],
    },
  };
}

beforeEach(async () => {
  intentDecision = {...defaultIntent};
  classifierResult = undefined;
  claudeSdkMock.__setQueryImplementation(async function* () {});
  const actualVerifier = jest.requireActual('../../agentRuntime/engines/claude/claudeVerifier') as any;
  mockClaudeVerifierVerifyConclusion.mockReset();
  mockClaudeVerifierVerifyConclusion.mockImplementation((...args: unknown[]) => (
    actualVerifier.verifyConclusion(...args)
  ));
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smartperfetto-claude-runtime-snapshot-'));
  dbPath = path.join(tmpDir, 'enterprise.sqlite');
  process.env[ENTERPRISE_FEATURE_FLAG_ENV] = 'true';
  process.env[ENTERPRISE_DB_PATH_ENV] = dbPath;
  process.env[ENTERPRISE_MIGRATION_PHASE_ENV] = 'cutover';
  process.env[ENTERPRISE_MIGRATION_CUTOVER_CONFIRMED_ENV] = 'true';
  process.env.PROVIDER_DATA_DIR_OVERRIDE = tmpDir;
  process.env[SECRET_STORE_MASTER_KEY_ENV] = Buffer.alloc(32, 17).toString('base64');
  resetProviderService();
});

afterEach(async () => {
  claudeSdkMock.__resetQueryMock();
  clearCodeAwareOutputGuards('session-private-stream-recovery');
  sessionContextManager.remove('session-a');
  sessionContextManager.remove('session-quick');
  sessionContextManager.remove('session-language-quick');
  sessionContextManager.remove('session-language-full');
  sessionContextManager.remove('session-provider');
  restoreEnvValue(ENTERPRISE_FEATURE_FLAG_ENV, originalEnv.enterprise);
  restoreEnvValue(ENTERPRISE_DB_PATH_ENV, originalEnv.enterpriseDbPath);
  restoreEnvValue(ENTERPRISE_MIGRATION_PHASE_ENV, originalEnv.migrationPhase);
  restoreEnvValue(ENTERPRISE_MIGRATION_CUTOVER_CONFIRMED_ENV, originalEnv.cutoverConfirmed);
  restoreEnvValue('PROVIDER_DATA_DIR_OVERRIDE', originalEnv.providerDataDirOverride);
  restoreEnvValue(SECRET_STORE_MASTER_KEY_ENV, originalEnv.secretStoreMasterKey);
  restoreEnvValue('CLAUDE_PRECOMPACT_THRESHOLD', originalEnv.precompactThreshold);
  restoreEnvValue('CLAUDE_PRECOMPACT_WARN_ENABLED', originalEnv.precompactWarnEnabled);
  restoreEnvValue(
    'SMARTPERFETTO_ADMITTED_RUNTIME_CANDIDATES',
    originalEnv.admittedRuntimeCandidates,
  );
  resetProviderService();
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

describe('ClaudeRuntime enterprise runtime_snapshots session map', () => {
  it('scene runtime matrix: runs the pinned Claude provider through shared proposal and private seal', async () => {
    const f = createSceneRuntimeMatrixFixture('claude');
    const runtime = new ClaudeRuntime(f.traceProcessorService, {model: 'scene-pinned-claude',
      enableVerification: false, enableSubAgents: false});
    let tool: any;
    let response: any;
    claudeSdkMock.__setQueryImplementation(async function* (params: any) {
      tool = params.options.mcpServers.smartperfetto.instance.tools.find((item: any) => item.name === 'propose_scene_timeline');
      expect(params.options.model).toBe('scene-pinned-claude');
      response = await tool.handler(f.proposal(), {});
      yield {type: 'result', subtype: 'success', num_turns: 1, result: 'Scene candidates submitted.'};
    });
    try {
      const result = await runtime.analyze('Reconstruct this trace', f.scope.sessionId, f.scope.traceId, f.options);
      expect(result.turnIntent).toMatchObject({source: 'product', sceneId: 'scene_reconstruction'});
      expect(rawClaudeSdkMock.__getQueryCalls().some(isClassifierCall)).toBe(false);
      expect(response.structuredContent).toMatchObject({accepted: true, revision: 1});
      expect(f.boundsQueries).toEqual([f.scope.traceId]);
      const snapshot = f.seal();
      expect(snapshot).toMatchObject({runId: f.scope.runId, sessionId: f.scope.sessionId, traceId: f.scope.traceId, revision: 1});
      expect(snapshot.segments[0].evidence[0].source.originRunId).toBe(f.scope.runId);
      f.controller.abort();
      const late = await tool.handler(f.proposal(), {}).catch((error: Error) => ({error: error.message}));
      expect(late.structuredContent?.accepted).not.toBe(true);
    } finally {runtime.cleanupSession(f.scope.sessionId); f.binding.release();}
    expect((runtime as any).artifactStores.has(f.scope.sessionId)).toBe(false);
  });
  it('scene runtime: extends a producing scene run past its base request budget', async () => {
    const f = createSceneRuntimeMatrixFixture('claude-deadline');
    // The fixed cap alone would cancel this run at 300 ms; tool results keep arriving every 150 ms.
    const runtime = new ClaudeRuntime(f.traceProcessorService, {model: 'scene-deadline-claude',
      enableVerification: false, enableSubAgents: false, maxTurns: 3, fullPathPerTurnMs: 100,
      fullRequestTimeoutMs: 300, maxRunTimeoutMs: 6_000, streamIdleTimeoutMs: 60_000});
    const outcomes: unknown[] = [];
    claudeSdkMock.__setQueryImplementation(async function* (params: any) {
      const tools = params.options.mcpServers.smartperfetto.instance.tools;
      const propose = tools.find((item: any) => item.name === 'propose_scene_timeline');
      const sql = tools.find((item: any) => item.name === 'execute_sql');
      outcomes.push((await propose.handler(f.proposal(), {})).structuredContent?.accepted);
      for (let index = 0; index < 6; index++) {
        await new Promise(resolve => setTimeout(resolve, 150));
        outcomes.push((await sql.handler({sql: 'SELECT 1'}, {})).structuredContent?.success);
      }
      yield {type: 'result', subtype: 'success', num_turns: 3, result: 'Scene timeline submitted.'};
    });
    const updates: any[] = [];
    runtime.on('update', update => updates.push(update));
    const startedAt = Date.now();
    try {
      const result = await runtime.analyze('Reconstruct this trace', f.scope.sessionId, f.scope.traceId, f.options);
      expect(outcomes).toEqual([true, true, true, true, true, true, true]);
      expect(result.terminationReason).not.toBe('timeout');
      expect(updates.some(update => update.content?.fallback === 'partial_result_after_timeout')).toBe(false);
      expect(f.seal().revision).toBe(1);
      // The completed report will make its semantic review, so finalization keeps the budget up to hard.
      expect(result.turnIntent).toMatchObject({status: 'resolved', deliverable: 'report'});
      const context = takeFinalizationContext(result);
      try {
        expect(context!.deadlineMs).toBeGreaterThanOrEqual(startedAt + 6_000);
        expect(context!.deadlineMs).toBeLessThanOrEqual(Date.now() + 6_000);
      } finally {context?.dispose();}
    } finally {runtime.cleanupSession(f.scope.sessionId); f.binding.release();}
  });
  it.each([
    [{type: 'result', subtype: 'success', is_error: false, stop_reason: null}, 'completed', undefined],
    [{type: 'result', subtype: 'success', is_error: false}, 'completed', undefined],
    [{type: 'result', subtype: 'success', is_error: true}, 'failed', 'provider_error'],
    [{type: 'result', subtype: 'success'}, 'failed', 'provider_error'],
    [{type: 'result', subtype: 'success', is_error: false, stop_reason: 'max_tokens'}, 'incomplete', 'output_limit'],
    [{type: 'result', subtype: 'error_max_turns'}, 'incomplete', 'turn_limit'],
    [{type: 'result', subtype: 'error_max_budget_usd'}, 'incomplete', 'budget_limit'],
    [{type: 'assistant'}, 'unknown', undefined],
  ])('reads completion exclusively from SDK terminal facts %#', (message, status, reason) => {
    expect(__testing.claudeTerminalState(message)).toMatchObject({status});
    expect(__testing.claudeTerminalState(message).reason).toBe(reason);
  });

  it('retries structured provider failures without interpreting error prose', () => {
    expect(__testing.isRetryableError(Object.assign(new Error('any wording'), {status: 503}))).toBe(true);
    expect(__testing.isRetryableError(Object.assign(new Error('any wording'), {code: 'ECONNRESET'}))).toBe(true);
    expect(__testing.isRetryableError(new Error('503 appeared in a trace event'))).toBe(false);
  });

  it.each(['ECONNRESET occurred 12 times', 'done', '## Arbitrary heading', '我来分析这句引文']) (
    'accepts the exact terminal candidate independent of wording: %s', finalResult => {
      expect(__testing.chooseClaudeConclusionText({finalResult,
        accumulatedAnswer: '# Final Report\n' + 'long preliminary reasoning '.repeat(200)})).toBe(finalResult);
    },
  );
  it('does not certify streamed text when the terminal candidate is empty', () => {
    expect(__testing.chooseClaudeConclusionText({finalResult: '', accumulatedAnswer: 'previous prose'})).toBe('');
    expect(__testing.chooseClaudeConclusionText({accumulatedAnswer: 'interrupted prose'})).toBe('interrupted prose');
  });

  it('recognizes missing SDK conversations from object-shaped result errors', () => {
    const message = __testing.getSdkResultErrorMessage({
      type: 'result',
      subtype: 'error_during_execution',
      errors: [{ message: 'No conversation found with session ID: sdk-session-a' }],
    });

    expect(message).toBe('Claude analysis error (error_during_execution): No conversation found with session ID: sdk-session-a');
    expect(__testing.isMissingSdkConversationError(message!)).toBe(true);
  });

  it('loads SDK session mappings from runtime_snapshots on construction', () => {
    const now = Date.now();
    saveClaudeSessionMapToRuntimeSnapshots({
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
      userId: 'user-a',
      sessionId: 'session-a',
      runId: 'run-a',
      traceId: 'trace-a',
    }, 'session-a', {
      sdkSessionId: 'sdk-session-a',
      updatedAt: now,
      mode: 'full',
    });

    const runtime = new ClaudeRuntime({} as any, {
      enableVerification: false,
      enableSubAgents: false,
    });

    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      expect(runtime.getSdkSessionId('session-a')).toBe('sdk-session-a');
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('does not expose stale SDK session mappings for persistence', () => {
    const now = 1_700_000_000_000;
    saveClaudeSessionMapToRuntimeSnapshots({
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
      userId: 'user-a',
      sessionId: 'session-a',
      runId: 'run-a',
      traceId: 'trace-a',
    }, 'session-a', {
      sdkSessionId: 'sdk-session-a',
      updatedAt: now - (5 * 60 * 60 * 1000),
      mode: 'full',
    });

    const runtime = new ClaudeRuntime({} as any, {
      enableVerification: false,
      enableSubAgents: false,
    });

    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      expect(runtime.getSdkSessionId('session-a')).toBeUndefined();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('removes enterprise runtime_snapshots rows during session cleanup', () => {
    saveClaudeSessionMapToRuntimeSnapshots({
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
      userId: 'user-a',
      sessionId: 'session-a',
      runId: 'run-a',
      traceId: 'trace-a',
    }, 'session-a', {
      sdkSessionId: 'sdk-session-a',
      updatedAt: Date.now(),
      mode: 'full',
    });
    expect(runtimeSnapshotCount()).toBe(1);

    const runtime = new ClaudeRuntime({} as any, {
      enableVerification: false,
      enableSubAgents: false,
    });

    runtime.removeSession('session-a');
    expect(runtimeSnapshotCount()).toBe(0);
  });

  it('starts fresh without deleting saved provider metadata for this session or its comparison', async () => {
    saveClaudeSessionMapToRuntimeSnapshots({
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
      userId: 'user-a',
      sessionId: 'session-a',
      runId: 'run-a',
      traceId: 'trace-a',
    }, 'session-a', {
      sdkSessionId: 'sdk-session-a',
      updatedAt: Date.now(),
      mode: 'full',
    });
    saveClaudeSessionMapToRuntimeSnapshots({
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
      userId: 'user-a',
      sessionId: 'session-a',
      runId: 'run-a',
      traceId: 'trace-a',
    }, 'session-a:ref:trace-b', {
      sdkSessionId: 'sdk-session-b',
      updatedAt: Date.now(),
      mode: 'full',
    });
    expect(runtimeSnapshotCount()).toBe(2);

    intentDecision = {...defaultIntent, taskKind: 'fact', scope: 'bounded_question', deliverable: 'answer', evidenceAccess: 'existing_only'};
    const runtime = new ClaudeRuntime({query: async () => ({columns: [], rows: []}), getTrace: () => undefined} as any, {
      enableVerification: false,
      enableSubAgents: false,
    });

    claudeSdkMock.__setQueryImplementation(async function* () {
      yield {type: 'result', subtype: 'success', num_turns: 1, result: 'Fresh provider answer.'};
    });
    try {
      const result = await runtime.analyze('Question', 'session-a', 'trace-a', {analysisMode: 'full',
        tenantId: 'tenant-a', workspaceId: 'workspace-a', userId: 'user-a'});
      expect(result.success).toBe(true);
      const calls = claudeSdkMock.__getQueryCalls();
      expect(calls).toHaveLength(2);
      expect(calls[0].options.resume).toBeUndefined();
      expect(runtime.getSdkSessionId('session-a')).toBe('sdk-session-a');
      expect(runtime.getSdkSessionId('session-a', 'trace-b')).toBe('sdk-session-b');
      expect(runtimeSnapshotCount()).toBe(2);
    } finally {sessionContextManager.remove('session-a');}
  });

  it('restores full-mode snapshot SDK mappings with the snapshot timestamp', () => {
    const runtime = new ClaudeRuntime({} as any, {
      enableVerification: false,
      enableSubAgents: false,
    });
    const snapshotTimestamp = Date.now() - (5 * 60 * 60 * 1000);

    runtime.restoreFromSnapshot('session-a', 'trace-a', {
      version: 1,
      snapshotTimestamp,
      sessionId: 'session-a',
      traceId: 'trace-a',
      conversationSteps: [],
      queryHistory: [],
      conclusionHistory: [],
      agentDialogue: [],
      agentResponses: [],
      dataEnvelopes: [],
      hypotheses: [],
      analysisNotes: [],
      analysisPlan: null,
      planHistory: [],
      uncertaintyFlags: [],
      engineState: {
        kind: 'claude-agent-sdk',
        provider: { providerId: null, providerSnapshotHash: null },
        claude: {
          sdkSessionId: 'sdk-session-a',
          sdkSessionMode: 'full',
        },
      },
      runSequence: 0,
      conversationOrdinal: 0,
    });

    expect((runtime as any).sessionMap.get('session-a')).toEqual(expect.objectContaining({
      sdkSessionId: 'sdk-session-a',
      updatedAt: snapshotTimestamp,
      mode: 'full',
    }));
  });

  it('restores full-mode comparison snapshot SDK mappings under the comparison key', () => {
    const runtime = new ClaudeRuntime({} as any, {
      enableVerification: false,
      enableSubAgents: false,
    });
    const snapshotTimestamp = Date.now() - (30 * 60 * 1000);

    runtime.restoreFromSnapshot('session-a', 'trace-a', {
      version: 1,
      snapshotTimestamp,
      sessionId: 'session-a',
      traceId: 'trace-a',
      referenceTraceId: 'trace-b',
      comparisonSource: 'raw_trace_pair',
      conversationSteps: [],
      queryHistory: [],
      conclusionHistory: [],
      agentDialogue: [],
      agentResponses: [],
      dataEnvelopes: [],
      hypotheses: [],
      analysisNotes: [],
      analysisPlan: null,
      planHistory: [],
      uncertaintyFlags: [],
      sdkSessionId: 'sdk-session-compare',
      sdkSessionMode: 'full',
      runSequence: 0,
      conversationOrdinal: 0,
    });

    expect((runtime as any).sessionMap.get('session-a')).toBeUndefined();
    expect((runtime as any).sessionMap.get('session-a:ref:trace-b')).toEqual(expect.objectContaining({
      sdkSessionId: 'sdk-session-compare',
      updatedAt: snapshotTimestamp,
      mode: 'full',
    }));
    expect(runtime.getSdkSessionId('session-a', 'trace-b')).toBe('sdk-session-compare');
  });


  it('does not restore legacy unmarked SDK mappings from snapshots', () => {
    const runtime = new ClaudeRuntime({} as any, {
      enableVerification: false,
      enableSubAgents: false,
    });

    runtime.restoreFromSnapshot('session-a', 'trace-a', {
      version: 1,
      snapshotTimestamp: Date.now(),
      sessionId: 'session-a',
      traceId: 'trace-a',
      conversationSteps: [],
      queryHistory: [],
      conclusionHistory: [],
      agentDialogue: [],
      agentResponses: [],
      dataEnvelopes: [],
      hypotheses: [],
      analysisNotes: [],
      analysisPlan: null,
      planHistory: [],
      uncertaintyFlags: [],
      sdkSessionId: 'legacy-sdk-session',
      runSequence: 0,
      conversationOrdinal: 0,
    });

    expect((runtime as any).sessionMap.get('session-a')).toBeUndefined();
  });

  it('does not persist stale SDK session mappings into snapshots', () => {
    const now = 1_700_000_000_000;
    const runtime = new ClaudeRuntime({} as any, {
      enableVerification: false,
      enableSubAgents: false,
    });
    (runtime as any).sessionMap.set('session-a', {
      sdkSessionId: 'sdk-session-stale',
      updatedAt: now - (5 * 60 * 60 * 1000),
      mode: 'full',
    });

    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const snapshot = runtime.takeSnapshot('session-a', 'trace-a', {
        conversationSteps: [],
        queryHistory: [],
        conclusionHistory: [],
        agentDialogue: [],
        agentResponses: [],
        dataEnvelopes: [],
        hypotheses: [],
        runSequence: 0,
        conversationOrdinal: 0,
      });

      expect(snapshot.sdkSessionId).toBeUndefined();
      expect(snapshot.engineState).toMatchObject({
        kind: 'claude-agent-sdk',
        claude: {
          sdkSessionId: undefined,
        },
      });
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('persists fresh SDK session mappings into snapshots', () => {
    const now = 1_700_000_000_000;
    const runtime = new ClaudeRuntime({} as any, {
      enableVerification: false,
      enableSubAgents: false,
    });
    (runtime as any).sessionMap.set('session-a', {
      sdkSessionId: 'sdk-session-fresh',
      updatedAt: now - (30 * 60 * 1000),
      mode: 'full',
    });

    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const snapshot = runtime.takeSnapshot('session-a', 'trace-a', {
        conversationSteps: [],
        queryHistory: [],
        conclusionHistory: [],
        agentDialogue: [],
        agentResponses: [],
        dataEnvelopes: [],
        hypotheses: [],
        runSequence: 0,
        conversationOrdinal: 0,
      });

      expect(snapshot.sdkSessionId).toBe('sdk-session-fresh');
      expect(snapshot.sdkSessionMode).toBe('full');
      expect(snapshot.engineState).toEqual(expect.objectContaining({
        kind: 'claude-agent-sdk',
        provider: {
          providerId: null,
          providerSnapshotHash: null,
        },
        claude: {
          sdkSessionId: 'sdk-session-fresh',
          sdkSessionMode: 'full',
        },
      }));
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('does not persist provider resume or intermediate model state for private source sessions', () => {
    const now = 1_700_000_000_000;
    const runtime = new ClaudeRuntime({} as any, {
      enableVerification: false,
      enableSubAgents: false,
    });
    (runtime as any).sessionMap.set('session-private', {
      sdkSessionId: 'PRIVATE_PROVIDER_SESSION_CANARY',
      updatedAt: now,
      mode: 'full',
    });
    (runtime as any).sessionNotes.set('session-private', [{content: 'PRIVATE_NOTE_CANARY'}]);
    (runtime as any).sessionPlans.set('session-private', {
      current: {
        phases: [],
        successCriteria: 'PRIVATE_PLAN_CANARY',
        submittedAt: now,
        toolCallLog: [{
          toolName: 'submit_hypothesis',
          timestamp: now,
          inputSummary: 'PRIVATE_TOOL_ARGUMENT_CANARY',
        }],
      },
      history: [],
    });
    (runtime as any).sessionHypotheses.set('session-private', [{statement: 'PRIVATE_TITLE_ONLY_CANARY'}]);

    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const snapshot = runtime.takeSnapshot('session-private', 'trace-a', {
        codeAwareMode: 'provider_send',
        codebaseIds: ['private-app'],
        conversationSteps: [{content: {text: 'PRIVATE_STEP_CANARY'}}] as any,
        queryHistory: [],
        conclusionHistory: [],
        agentDialogue: [{content: 'PRIVATE_DIALOGUE_CANARY'}] as any,
        agentResponses: [{response: 'PRIVATE_RESPONSE_CANARY'}] as any,
        dataEnvelopes: [],
        hypotheses: [{description: 'PRIVATE_HYPOTHESIS_CANARY'}],
        runSequence: 0,
        conversationOrdinal: 0,
      });

      expect(snapshot.sdkSessionId).toBeUndefined();
      expect(snapshot.analysisNotes).toEqual([]);
      expect(snapshot.analysisPlan).toBeNull();
      expect(snapshot.planHistory).toEqual([]);
      expect(snapshot.claudeHypotheses).toBeUndefined();
      expect(snapshot.artifacts).toBeUndefined();
      expect(JSON.stringify(snapshot)).not.toContain('PRIVATE_');
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('persists fresh comparison SDK session mappings into snapshots', () => {
    const now = 1_700_000_000_000;
    const runtime = new ClaudeRuntime({} as any, {
      enableVerification: false,
      enableSubAgents: false,
    });
    (runtime as any).sessionMap.set('session-a:ref:trace-b', {
      sdkSessionId: 'sdk-session-compare',
      updatedAt: now - (30 * 60 * 1000),
      mode: 'full',
    });

    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const snapshot = runtime.takeSnapshot('session-a', 'trace-a', {
        referenceTraceId: 'trace-b',
        comparisonSource: 'raw_trace_pair',
        conversationSteps: [],
        queryHistory: [],
        conclusionHistory: [],
        agentDialogue: [],
        agentResponses: [],
        dataEnvelopes: [],
        hypotheses: [],
        runSequence: 0,
        conversationOrdinal: 0,
      });

      expect(snapshot.referenceTraceId).toBe('trace-b');
      expect(snapshot.comparisonSource).toBe('raw_trace_pair');
      expect(snapshot.sdkSessionId).toBe('sdk-session-compare');
      expect(snapshot.sdkSessionMode).toBe('full');
      expect(snapshot.engineState).toMatchObject({
        kind: 'claude-agent-sdk',
        claude: {
          sdkSessionId: 'sdk-session-compare',
        },
      });
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('does not expose fresh legacy session-map entries without full-mode ownership', () => {
    const now = 1_700_000_000_000;
    const runtime = new ClaudeRuntime({} as any, {
      enableVerification: false,
      enableSubAgents: false,
    });
    (runtime as any).sessionMap.set('session-a', {
      sdkSessionId: 'legacy-sdk-session',
      updatedAt: now,
    });

    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      expect(runtime.getSdkSessionId('session-a')).toBeUndefined();
      const snapshot = runtime.takeSnapshot('session-a', 'trace-a', {
        conversationSteps: [],
        queryHistory: [],
        conclusionHistory: [],
        agentDialogue: [],
        agentResponses: [],
        dataEnvelopes: [],
        hypotheses: [],
        runSequence: 0,
        conversationOrdinal: 0,
      });
      expect(snapshot.sdkSessionId).toBeUndefined();
      expect(snapshot.engineState).toMatchObject({
        kind: 'claude-agent-sdk',
        claude: {
          sdkSessionId: undefined,
        },
      });
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('inherits product history across budget changes without resuming provider history', async () => {
    const runtime = new ClaudeRuntime({
      query: async () => ({ columns: ['cnt'], rows: [[0]] }),
    } as any, {
      enableVerification: false,
      enableSubAgents: false,
    });
    const now = Date.now();
    (runtime as any).sessionMap.set('session-quick', {
      sdkSessionId: 'full-sdk-session',
      updatedAt: now,
      mode: 'full',
    });
    (runtime as any).architectureCache.set('trace-quick', {
      type: 'STANDARD',
      confidence: 0.9,
      evidence: [],
    });
    sessionContextManager.getOrCreate('session-quick', 'trace-quick').addTurn(
      '上一轮查到的包名是什么？',
      {
        primaryGoal: '上一轮查到的包名是什么？',
        aspects: [],
        expectedOutputType: 'summary',
        complexity: 'simple',
        followUpType: 'initial',
      },
      {
        agentId: 'claude-agent',
        success: true,
        findings: [],
        confidence: 0.8,
        message: '上一轮回答：主要包名是 com.example.app。',
      },
      [],
    );
    claudeSdkMock.__setQueryImplementation(async function* () {
      yield {
        type: 'result',
        subtype: 'success',
        session_id: 'quick-sdk-session',
        num_turns: 1,
        result: '当前仍然是 com.example.app。',
      };
    });

    await runtime.analyze('继续回答刚才的问题', 'session-quick', 'trace-quick', {
      analysisMode: 'fast',
      packageName: 'com.example.app',
    });

    const calls = claudeSdkMock.__getQueryCalls();
    expect(calls).toHaveLength(2);
    expect(calls[0].options.resume).toBeUndefined();
    expect(calls[0].prompt).toContain('上一轮回答：主要包名是 com.example.app。');
    expect(calls[0].options.persistSession).toBe(true);
    expect(calls[0].options.allowedTools).toContain('mcp__smartperfetto__fetch_artifact');
    expect(calls[0].prompt).toContain('继续回答刚才的问题');
    expect((runtime as any).sessionMap.get('session-quick')).toEqual(expect.objectContaining({
      sdkSessionId: 'quick-sdk-session',
      mode: 'full',
    }));
  });

  it('passes the active code-aware mode and selected codebases into the Claude quick prompt', async () => {
    const runtime = new ClaudeRuntime({
      query: async () => ({columns: [], rows: []}),
    } as any, {
      enableVerification: false,
      enableSubAgents: false,
    });
    claudeSdkMock.__setQueryImplementation(async function* () {
      yield {
        type: 'result',
        subtype: 'success',
        session_id: 'quick-source-sdk-session',
        num_turns: 1,
        result: 'done',
      };
    });

    await runtime.analyze(
      '快速结合源码定位候选机制',
      'session-claude-source-quick',
      'trace-claude-source-quick',
      {
        analysisMode: 'fast',
        assistantSurface: 'conversation',
        conversationTraceAttached: true,
        codeAwareMode: 'metadata_only',
        codebaseIds: ['cb-claude-quick'],
      },
    );

    const call = claudeSdkMock.__getQueryCalls()[0];
    expect(JSON.stringify(call.options.systemPrompt)).toContain('cb-claude-quick');
    expect(JSON.stringify(call.options.systemPrompt)).toContain('metadata_only');
    expect(JSON.stringify(call.options.systemPrompt)).toContain('源码使用决策契约');
  });

  it('does not run trace preflight for a no-trace conversation turn', async () => {
    const traceProcessor = {
      query: jest.fn(async () => {
        throw new Error('no trace processor exists for conversation');
      }),
    };
    const runtime = new ClaudeRuntime(traceProcessor as any, {
      enableVerification: false,
      enableSubAgents: false,
    });
    claudeSdkMock.__setQueryImplementation(async function* () {
      yield {
        type: 'result',
        subtype: 'success',
        session_id: 'sdk-conversation-no-trace',
        num_turns: 1,
        result: '对话模式可用。',
      };
    });

    await runtime.analyze(
      '只回复：对话模式可用。',
      'session-conversation-no-trace',
      'conversation-no-trace:session-conversation-no-trace',
      {
        analysisMode: 'fast',
        assistantSurface: 'conversation',
        conversationTraceAttached: false,
      },
    );

    expect(traceProcessor.query).not.toHaveBeenCalled();
    expect(claudeSdkMock.__getQueryCalls()).toHaveLength(2);
  });

  it('enables and auto-allows the Agent tool only when sub-agents are defined', () => {
    expect(__testing.buildClaudeSdkToolOptions(
      ['mcp__smartperfetto__execute_sql'],
      {'frame-expert': {}},
    )).toEqual({
      tools: ['Agent'],
      allowedTools: ['mcp__smartperfetto__execute_sql', 'Agent'],
    });
    expect(__testing.buildClaudeSdkToolOptions(
      ['mcp__smartperfetto__execute_sql'],
    )).toEqual({
      tools: [],
      allowedTools: ['mcp__smartperfetto__execute_sql'],
    });
  });

  it('keeps a terminal SDK success when iterator cleanup throws afterward', async () => {
    const runtime = new ClaudeRuntime({
      query: jest.fn(async () => {
        throw new Error('no trace processor exists for conversation');
      }),
    } as any, {
      enableVerification: false,
      enableSubAgents: false,
    });
    claudeSdkMock.__setQueryImplementation(async function* () {
      yield {
        type: 'result',
        subtype: 'success',
        session_id: 'sdk-conversation-terminal-success',
        num_turns: 1,
        result: '对话模式可用。',
      };
      throw new Error('Not logged in · Please run /login');
    });

    const result = await runtime.analyze(
      '只回复：对话模式可用。',
      'session-conversation-terminal-success',
      'conversation-no-trace:session-conversation-terminal-success',
      {
        analysisMode: 'fast',
        assistantSurface: 'conversation',
        conversationTraceAttached: false,
      },
    );

    expect(result.success).toBe(true);
    expect(result.conclusion).toContain('对话模式可用');
  });

  it('uses the request language throughout the quick path without mutating runtime defaults', async () => {
    const runtime = new ClaudeRuntime({
      query: async () => ({columns: ['cnt'], rows: [[0]]}),
    } as any, {
      outputLanguage: 'zh-CN',
      enableVerification: false,
      enableSubAgents: false,
    });
    (runtime as any).architectureCache.set('trace-language-quick', {
      type: 'STANDARD',
      confidence: 0.9,
      evidence: [],
    });
    const promptBuilder = jest.spyOn(claudeSystemPrompt, 'buildSystemPromptParts');
    claudeSdkMock.__setQueryImplementation(async function* () {
      yield {
        type: 'result',
        subtype: 'success',
        session_id: 'sdk-language-quick',
        num_turns: 1,
        result: 'The current app is com.example.app.',
      };
    });

    await runtime.analyze(
      'Explain the current app briefly',
      'session-language-quick',
      'trace-language-quick',
      {analysisMode: 'fast', outputLanguage: 'en', packageName: 'com.example.app'},
    );

    const [call] = claudeSdkMock.__getQueryCalls();
    expect(JSON.stringify(call.options.systemPrompt)).toContain('English');
    const promptCalls = promptBuilder.mock.calls;
    const promptLanguage = promptCalls[promptCalls.length - 1]?.[0].outputLanguage;
    promptBuilder.mockRestore();
    expect(promptLanguage).toBe('en');
    expect((runtime as any).config.outputLanguage).toBe('zh-CN');
  });

  it.each(['full', 'fast'] as const)('uses a single intent and on-demand MCP for %s bounded answers', async analysisMode => {
    intentDecision = {...defaultIntent, sceneId: 'general', taskKind: 'fact', scope: 'bounded_question',
      recommendedComplexity: 'quick', deliverable: 'answer'};
    const traceProcessor = {query: jest.fn(async () => ({columns: [], rows: []})), getTrace: () => undefined};
    const focus = jest.spyOn(focusAppDetector, 'detectFocusApps');
    const architecture = jest.spyOn(architectureDetector, 'createArchitectureDetector');
    const knowledge = jest.spyOn(sqlKnowledgeBase, 'getExtendedKnowledgeBase');
    const runtime = new ClaudeRuntime(traceProcessor as any, {enableVerification: false, enableSubAgents: false});
    claudeSdkMock.__setQueryImplementation(async function* () {
      yield {type: 'result', subtype: 'success', is_error: false, stop_reason: null,
        session_id: `sdk-bounded-${analysisMode}`, num_turns: 1, result: 'ECONNRESET 是这段记录中的事件名称'};
    });
    try {
      const result = await runtime.analyze('A scoped question', `bounded-${analysisMode}`, 'bounded-trace', {analysisMode});
      expect(result.conclusion).toBe('ECONNRESET 是这段记录中的事件名称');
      expect(result.completion).toMatchObject({status: 'completed', conclusionFingerprint: analysisDeliveryFingerprint(result.conclusion)});
      expect(result.turnIntent).toMatchObject({scope: 'bounded_question', deliverable: 'answer'});
      expect(rawClaudeSdkMock.__getQueryCalls().filter(isClassifierCall)).toHaveLength(1);
      expect(claudeSdkMock.__getQueryCalls()).toHaveLength(2);
      // A bounded question still gets the trace facts: which app is in focus
      // and what it renders with. What it skips is the scene-wide memory tier.
      expect(focus).toHaveBeenCalled(); expect(architecture).toHaveBeenCalled();
      expect(knowledge).not.toHaveBeenCalled();
      const tools = claudeSdkMock.__getQueryCalls()[0].options.allowedTools;
      expect(tools).toContain('mcp__smartperfetto__fetch_artifact');
      expect(tools).toContain('mcp__smartperfetto__submit_plan');
    } finally {focus.mockRestore(); architecture.mockRestore(); knowledge.mockRestore();}
  });

  it('acquires nothing at all for an existing_only bounded answer', async () => {
    intentDecision = {...defaultIntent, sceneId: 'general', taskKind: 'fact', scope: 'bounded_question',
      recommendedComplexity: 'quick', deliverable: 'answer', evidenceAccess: 'existing_only'};
    const traceProcessor = {query: jest.fn(async () => ({columns: [], rows: []})), getTrace: () => undefined};
    const focus = jest.spyOn(focusAppDetector, 'detectFocusApps');
    const architecture = jest.spyOn(architectureDetector, 'createArchitectureDetector');
    const knowledge = jest.spyOn(sqlKnowledgeBase, 'getExtendedKnowledgeBase');
    const runtime = new ClaudeRuntime(traceProcessor as any, {enableVerification: false, enableSubAgents: false});
    claudeSdkMock.__setQueryImplementation(async function* () {
      yield {type: 'result', subtype: 'success', is_error: false, stop_reason: null,
        session_id: 'sdk-existing-only', num_turns: 1, result: '之前的证据已经够回答这个问题'};
    });
    try {
      const result = await runtime.analyze('A scoped question', 'bounded-existing-only', 'bounded-trace', {analysisMode: 'full'});
      expect(result.turnIntent).toMatchObject({scope: 'bounded_question', evidenceAccess: 'existing_only'});
      expect(focus).not.toHaveBeenCalled(); expect(architecture).not.toHaveBeenCalled();
      expect(knowledge).not.toHaveBeenCalled(); expect(traceProcessor.query).not.toHaveBeenCalled();
    } finally {focus.mockRestore(); architecture.mockRestore(); knowledge.mockRestore();}
  });

  it('keeps comparison identity and prior artifacts with existing-only evidence in a fast budget', async () => {
    intentDecision = {...defaultIntent, taskKind: 'comparison', scope: 'bounded_question', deliverable: 'answer', evidenceAccess: 'existing_only'};
    const traceProcessor = {query: jest.fn(async () => ({columns: [], rows: []})), getTrace: () => undefined};
    const runtime = new ClaudeRuntime(traceProcessor as any, {enableVerification: false, enableSubAgents: false});
    const mcp = jest.spyOn(claudeMcpServer, 'createClaudeMcpServer');
    claudeSdkMock.__setQueryImplementation(async function* () {
      yield {type: 'result', subtype: 'success', num_turns: 1, result: 'The earlier evidence is sufficient.'};
    });
    try {
      const result = await runtime.analyze('Use prior evidence', 'existing-only', 'current', {
        analysisMode: 'fast', referenceTraceId: 'reference', knowledgeSourceIds: ['knowledge-selected'],
      });
      expect(result.turnIntent?.evidenceAccess).toBe('existing_only');
      expect(mcp).toHaveBeenCalledWith(expect.objectContaining({allowNewEvidence: false,
        referenceTraceId: 'reference', comparisonContext: expect.objectContaining({referenceTraceId: 'reference', capabilityProbeStatus: 'not_checked'})}));
      expect(traceProcessor.query).not.toHaveBeenCalled();
      expect(claudeSdkMock.__getQueryCalls()).toHaveLength(2);
      expect(claudeSdkMock.__getQueryCalls()[0].options.allowedTools).toContain('mcp__smartperfetto__fetch_artifact');
    } finally {mcp.mockRestore();}
  });

  it('gives invoke_skill the shared best-effort vendor hint without a vendor preflight', async () => {
    const traceProcessor = {query: jest.fn(async () => ({columns: [], rows: []})), getTrace: () => undefined};
    const runtime = new ClaudeRuntime(traceProcessor as any, {enableVerification: false, enableSubAgents: false});
    const mcp = jest.spyOn(claudeMcpServer, 'createClaudeMcpServer');
    claudeSdkMock.__setQueryImplementation(async function* () {
      yield {type: 'result', subtype: 'success', num_turns: 1, result: '启动分析完成'};
    });
    let runtimeOptions: Parameters<typeof claudeMcpServer.createClaudeMcpServer>[0];
    try {
      await runtime.analyze('分析启动性能', 'claude-vendor-hint', 'trace', {analysisMode: 'full'});
      runtimeOptions = mcp.mock.calls[0][0];
    } finally {mcp.mockRestore();}
    expect(traceProcessor.query.mock.calls.some(call =>
      String((call as unknown[])[1]).includes(TRACE_VENDOR_METADATA_SQL))).toBe(false);
    await expectRuntimeVendorHintParity({
      createMcpServer: claudeMcpServer.createClaudeMcpServer, runtimeOptions});
  });

  // A failed classifier is the turn that knows least about the trace, so it
  // keeps the trace-fact preflight; what it loses is the scene, and with it
  // the scene-wide memory tier.
  it('uses the pinned primary model after classifier failure without memory prefetch or repeated classification', async () => {
    classifierResult = {type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['light model missing']};
    const traceProcessor = {query: jest.fn(async () => ({columns: [], rows: []})), getTrace: () => undefined};
    const knowledge = jest.spyOn(sqlKnowledgeBase, 'getExtendedKnowledgeBase');
    const runtime = new ClaudeRuntime(traceProcessor as any, {
      model: 'pinned-primary', lightModel: 'broken-light', enableSubAgents: false,
    });
    claudeSdkMock.__setQueryImplementation(async function* () {
      yield {type: 'result', subtype: 'success', num_turns: 1, result: 'short answer'};
    });
    try {
      const result = await runtime.analyze('A question', 'classifier-unavailable', 'trace', {analysisMode: 'fast'});
      expect(result.turnIntent?.status).toBe('unavailable');
      expect(claudeSdkMock.__getQueryCalls()[0].options.model).toBe('pinned-primary');
      expect(rawClaudeSdkMock.__getQueryCalls().filter(isClassifierCall)).toHaveLength(1);
      expect(traceProcessor.query).toHaveBeenCalled();
      expect(knowledge).not.toHaveBeenCalled();
    } finally {knowledge.mockRestore();}
  });

  it('cancels native intent classification before any main SDK or trace work', async () => {
    const started = createDeferred<void>();
    const release = createDeferred<void>();
    const traceProcessor = {query: jest.fn(async () => ({columns: [], rows: []})), getTrace: () => undefined};
    const runtime = new ClaudeRuntime(traceProcessor as any, {enableSubAgents: false});
    rawClaudeSdkMock.__setQueryImplementation(async function* () {
      started.resolve(); await release.promise;
      yield {type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(defaultIntent)};
    });
    const pending = runtime.analyze('Question', 'cancel-intent', 'trace', {analysisMode: 'full'});
    await started.promise;
    runtime.abortSession('cancel-intent');
    const result = await pending;
    release.resolve();
    expect(result.completion).toMatchObject({status: 'cancelled', reason: 'cancelled'});
    expect(takeFinalizationContext(result)).toBeUndefined();
    expect(rawClaudeSdkMock.__getQueryCalls()).toHaveLength(1);
    expect(traceProcessor.query).not.toHaveBeenCalled();
  });

  it('enforces the actual quick wall budget and ignores a terminal message released afterward', async () => {
    intentDecision = {...defaultIntent, taskKind: 'fact', scope: 'bounded_question', deliverable: 'answer'};
    jest.useFakeTimers({doNotFake: ['nextTick', 'setImmediate']});
    const previousMaxTurns = process.env.CLAUDE_QUICK_MAX_TURNS;
    process.env.CLAUDE_QUICK_MAX_TURNS = '1';
    const release = createDeferred<void>();
    const started = createDeferred<void>();
    const runtime = new ClaudeRuntime({query: async () => ({columns: [], rows: []}), getTrace: () => undefined} as any,
      {quickPathPerTurnMs: 20, streamIdleTimeoutMs: 1000, enableSubAgents: false});
    claudeSdkMock.__setQueryImplementation(async function* () {
      yield {type: 'assistant', message: {content: [{type: 'text', text: 'available draft'}]}};
      started.resolve();
      await release.promise;
      yield {type: 'result', subtype: 'success', is_error: false, result: 'late result', num_turns: 1};
    });
    try {
      const pending = runtime.analyze('Question', 'budget-timeout', 'trace', {analysisMode: 'fast'});
      await started.promise;
      await jest.advanceTimersByTimeAsync(20);
      const result = await pending;
      expect(result.completion).toMatchObject({status: 'incomplete', reason: 'timeout'});
      expect(result.quickRun).toMatchObject({hardCapTurns: 1, enforcement: 'turn_cap', stopReason: 'timeout'});
      const snapshot = JSON.stringify(result);
      release.resolve(); await Promise.resolve(); await Promise.resolve();
      expect(JSON.stringify(result)).toBe(snapshot);
      expect(result.conclusion).not.toBe('late result');
    } finally {release.resolve(); restoreEnvValue('CLAUDE_QUICK_MAX_TURNS', previousMaxTurns); jest.useRealTimers();}
  });

  it('reports the chosen quick budget when preparation consumes the original deadline before SDK dispatch', async () => {
    intentDecision = {...defaultIntent, taskKind: 'fact', scope: 'bounded_question', deliverable: 'answer'};
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
    const previousMaxTurns = process.env.CLAUDE_QUICK_MAX_TURNS;
    process.env.CLAUDE_QUICK_MAX_TURNS = '1';
    const runtime = new ClaudeRuntime({query: async () => ({columns: [], rows: []}), getTrace: () => undefined} as any,
      {quickPathPerTurnMs: 20, enableSubAgents: false});
    const prepare = (runtime as any).prepareAnalysisContext.bind(runtime);
    jest.spyOn(runtime as any, 'prepareAnalysisContext').mockImplementation(async (...args: unknown[]) => {
      const context = await prepare(...args);
      clock.mockReturnValue(now + 21);
      return context;
    });
    claudeSdkMock.__setQueryImplementation(async function* () {
      throw new Error('The main SDK must not start after the original deadline');
    });
    try {
      const result = await runtime.analyze('Question', 'preparation-budget-timeout', 'trace', {analysisMode: 'fast'});
      expect(claudeSdkMock.__getQueryCalls()).toHaveLength(0);
      expect(result).toMatchObject({success: false, rounds: 0, terminationReason: 'timeout',
        quickRun: {actualTurns: 0, elapsedMs: 21, hardCapTurns: 1, stopReason: 'timeout'}});
      expect(takeFinalizationContext(result)).toBeUndefined();
    } finally {clock.mockRestore(); restoreEnvValue('CLAUDE_QUICK_MAX_TURNS', previousMaxTurns);}
  });

  it.each([
    {language: 'zh-CN' as const, body: '这是一段原生回答 PRIVATE_CLAUDE_PROJECTION_CANARY'},
    {language: 'en' as const, body: 'A native answer PRIVATE_CLAUDE_PROJECTION_CANARY'},
  ])('consumes actual replacement state after successful SDK completion ($language)', async ({language, body}) => {
    intentDecision = {...defaultIntent, taskKind: 'fact', scope: 'bounded_question', deliverable: 'answer'};
    const sessionId = `claude-projection-replaced-${language}`;
    revokeCodeAwareOutputGuards(sessionId);
    const projection = jest.spyOn(sourceClaimVerifier, 'finalizeOwnerSourceAwareAnalysisResultWithProjection');
    const runtime = new ClaudeRuntime({query: async () => ({columns: [], rows: []}), getTrace: () => undefined} as any,
      {enableSubAgents: false});
    mockClaudeVerifierVerifyConclusion.mockResolvedValue({passed: true, heuristicIssues: [], durationMs: 0});
    claudeSdkMock.__setQueryImplementation(async function* () {
      yield {type: 'result', subtype: 'success', num_turns: 1, result: body};
    });
    try {
      const result = await runtime.analyze('Question', sessionId, 'trace', {analysisMode: 'fast', outputLanguage: language});
      const projected = projection.mock.results[0].value;
      expect(projected.conclusionProjection.disposition).toBe('replaced');
      expect(result).toMatchObject({success: false, partial: true, outputOrigin: 'runtime_fallback',
        completion: {status: 'unknown', conclusionFingerprint: analysisDeliveryFingerprint(result.conclusion)}});
      expect(result.completion).toEqual(projected.deliveryContext.completion);
      expect(mockClaudeVerifierVerifyConclusion.mock.calls[0][2].deliveryContext).toEqual(projected.deliveryContext);
      expect(JSON.stringify(result)).not.toContain('PRIVATE_CLAUDE_PROJECTION_CANARY');
      expect(JSON.stringify(result)).not.toContain(analysisDeliveryFingerprint(body));
    } finally {projection.mockRestore(); clearCodeAwareOutputGuards(sessionId); sessionContextManager.remove(sessionId);}
  });

  it('preserves native completion for the same words when the guard did not replace them', async () => {
    intentDecision = {...defaultIntent, taskKind: 'fact', scope: 'bounded_question', deliverable: 'answer'};
    const sessionId = 'claude-projection-literal';
    revokeCodeAwareOutputGuards(sessionId);
    const generatedExplanation = sanitizeCodeAwareStructuredTextWithReceipt(sessionId, 'native content').text;
    clearCodeAwareOutputGuards(sessionId);
    const projection = jest.spyOn(sourceClaimVerifier, 'finalizeOwnerSourceAwareAnalysisResultWithProjection');
    const runtime = new ClaudeRuntime({query: async () => ({columns: [], rows: []}), getTrace: () => undefined} as any,
      {enableSubAgents: false});
    mockClaudeVerifierVerifyConclusion.mockResolvedValue({passed: true, heuristicIssues: [], durationMs: 0});
    claudeSdkMock.__setQueryImplementation(async function* () {
      yield {type: 'result', subtype: 'success', num_turns: 1, result: generatedExplanation};
    });
    try {
      const result = await runtime.analyze('Question', sessionId, 'trace', {analysisMode: 'fast'});
      expect(projection.mock.results[0].value.conclusionProjection.disposition).toBe('preserved');
      expect(result).toMatchObject({success: true, outputOrigin: 'sdk_final', completion: {status: 'completed'}});
      expect(result.conclusion).toBe(generatedExplanation);
    } finally {projection.mockRestore(); clearCodeAwareOutputGuards(sessionId); sessionContextManager.remove(sessionId);}
  });

  it.each(['sdk_final', 'assistant_stream'] as const)('transfers only the matching %s candidate through actual redaction', async origin => {
    intentDecision = {...defaultIntent, taskKind: 'fact', scope: 'bounded_question', deliverable: 'answer'};
    const sessionId = `claude-projection-redacted-${origin}`;
    const body = 'Before PRIVATE_CLAUDE_REDACTION_CANARY after';
    registerCodeAwareCanary(sessionId, 'PRIVATE_CLAUDE_REDACTION_CANARY');
    const projection = jest.spyOn(sourceClaimVerifier, 'finalizeOwnerSourceAwareAnalysisResultWithProjection');
    const runtime = new ClaudeRuntime({query: async () => ({columns: [], rows: []}), getTrace: () => undefined} as any,
      {enableSubAgents: false});
    mockClaudeVerifierVerifyConclusion.mockResolvedValue({passed: true, heuristicIssues: [], durationMs: 0});
    claudeSdkMock.__setQueryImplementation(async function* () {
      if (origin === 'assistant_stream') {
        yield {type: 'assistant', message: {content: [{type: 'text', text: body}]}};
        throw new Error('Native stream ended before terminal completion');
      }
      yield {type: 'result', subtype: 'success', num_turns: 1, result: body};
    });
    try {
      const result = await runtime.analyze('Question', sessionId, 'trace', {analysisMode: 'fast'});
      const projected = projection.mock.results[0].value;
      const nativeContext = projection.mock.calls[0][2]?.context;
      expect(projected.conclusionProjection.disposition).toBe('redacted');
      expect(result.outputOrigin).toBe(origin);
      expect(result.completion).toMatchObject({status: origin === 'sdk_final' ? 'completed' : 'failed',
        conclusionFingerprint: analysisDeliveryFingerprint(result.conclusion)});
      expect(result.completion).toEqual(projected.deliveryContext.completion);
      expect(result.completion?.candidateRef).not.toBe(nativeContext?.entry !== 'historical_restore' ? nativeContext?.acceptedCandidate?.candidateRef : undefined);
      expect(JSON.stringify(result)).not.toContain('PRIVATE_CLAUDE_REDACTION_CANARY');
      expect(JSON.stringify(result)).not.toContain(analysisDeliveryFingerprint(body));
    } finally {projection.mockRestore(); clearCodeAwareOutputGuards(sessionId); sessionContextManager.remove(sessionId);}
  });

  it('keeps an empty native answer ineligible after a revoked-session replacement', async () => {
    intentDecision = {...defaultIntent, taskKind: 'fact', scope: 'bounded_question', deliverable: 'answer'};
    const sessionId = 'claude-projection-native-empty';
    revokeCodeAwareOutputGuards(sessionId);
    const projection = jest.spyOn(sourceClaimVerifier, 'finalizeOwnerSourceAwareAnalysisResultWithProjection');
    const runtime = new ClaudeRuntime({query: async () => ({columns: [], rows: []}), getTrace: () => undefined} as any,
      {enableSubAgents: false});
    claudeSdkMock.__setQueryImplementation(async function* () {
      yield {type: 'result', subtype: 'success', num_turns: 1, result: ''};
    });
    try {
      const result = await runtime.analyze('Question', sessionId, 'trace', {analysisMode: 'fast'});
      expect(projection.mock.results[0].value.conclusionProjection.disposition).toBe('replaced');
      expect(result).toMatchObject({success: false, partial: true, outputOrigin: 'runtime_fallback', completion: {status: 'unknown'}});
    } finally {projection.mockRestore(); clearCodeAwareOutputGuards(sessionId); sessionContextManager.remove(sessionId);}
  });

  it('does not infer insights or save a pattern from a runtime-only verification pass', async () => {
    intentDecision = {...defaultIntent, taskKind: 'fact', scope: 'bounded_question', deliverable: 'answer'};
    const sessionId = 'claude-runtime-pass-not-learning';
    const runtime = new ClaudeRuntime({query: async () => ({columns: [], rows: []}), getTrace: () => undefined} as any,
      {enableSubAgents: false});
    const note = {section: 'next_step', content: 'Retain the scoped follow-up', priority: 'high', timestamp: Date.now()};
    (runtime as any).sessionNotes.set(sessionId, [note]);
    const insights = jest.spyOn(analysisPatternMemory, 'extractKeyInsights').mockReturnValue(['unreviewed insight']);
    const savePattern = jest.spyOn(analysisPatternMemory, 'saveAnalysisPattern').mockResolvedValue(undefined);
    mockClaudeVerifierVerifyConclusion.mockResolvedValue({passed: true, heuristicIssues: [], llmIssues: [], durationMs: 0});
    const nativeBody = '[HIGH] Candidate finding\nThis observation still needs shared final evidence verification.';
    claudeSdkMock.__setQueryImplementation(async function* () {
      yield {type: 'result', subtype: 'success', num_turns: 1, result: nativeBody};
    });
    let context: ReturnType<typeof takeFinalizationContext>;
    try {
      const result = await runtime.analyze('A bounded question', sessionId, 'trace', {analysisMode: 'full'});
      expect(result).toMatchObject({success: true, completion: {status: 'completed'}});
      expect(result.partial).not.toBe(true);
      expect(result.findings.length).toBeGreaterThan(0);
      expect(mockClaudeVerifierVerifyConclusion).toHaveBeenCalled();
      expect(insights).not.toHaveBeenCalled();
      expect(savePattern).not.toHaveBeenCalled();
      expect(runtime.getSessionNotes(sessionId)).toEqual([note]);
      const turns = sessionContextManager.getOrCreate(sessionId, 'trace').getAllTurns();
      expect(turns).toHaveLength(1);
      expect(turns[0].result?.message).toBe(result.conclusion);
      expect(claudeSdkMock.__getQueryCalls()).toHaveLength(2);
      context = takeFinalizationContext(result);
      expect(context?.deliveryContext).toMatchObject({entry: 'runtime_draft', completion: result.completion});
      expect(context?.sourceScope).toMatchObject({codeAwareMode: 'metadata_only', selectedCodebaseIds: [], hasCodebaseAccess: false});
    } finally {context?.dispose(); insights.mockRestore(); savePattern.mockRestore(); sessionContextManager.remove(sessionId);}
  });

  it.each([undefined, '32768'])('attaches a pinned primary review with only the captured explicit output cap %s and the actual store view', async outputLimit => {
    intentDecision = {...defaultIntent, taskKind: 'fact', scope: 'bounded_question', deliverable: 'answer'};
    const sessionId = 'claude-finalization-context';
    const outputBudgetBefore = process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS;
    restoreEnvValue('CLAUDE_CODE_MAX_OUTPUT_TOKENS', outputLimit);
    const traceProcessor = {query: jest.fn(async () => ({columns: [], rows: []})), getTrace: () => undefined};
    const runtime = new ClaudeRuntime(traceProcessor as any,
      {model: 'pinned-primary-review', lightModel: 'pinned-light-answer', enableSubAgents: false});
    const readView = jest.spyOn(ArtifactStore.prototype, 'createEvidenceReadView');
    mockClaudeVerifierVerifyConclusion.mockResolvedValue({passed: true, heuristicIssues: [], durationMs: 0});
    let reviewDirectory: string | undefined;
    const reviewBody = 'x'.repeat(12_000);
    claudeSdkMock.__setQueryImplementation(async function* (params: any) {
      const finalReview = params.options.permissionMode === 'dontAsk';
      if (finalReview) {
        reviewDirectory = params.options.cwd;
        expect((await fs.stat(reviewDirectory!)).isDirectory()).toBe(true);
      }
      yield {type: 'result', subtype: 'success', num_turns: 1, result: finalReview ? reviewBody : 'native answer'};
    });
    let context: ReturnType<typeof takeFinalizationContext>;
    try {
      const options: AnalysisOptions = {
        analysisMode: 'fast' as const, runId: 'actual-run', referenceTraceId: 'reference-trace',
        selectionContext: {kind: 'track_event', eventId: 7, ts: 42},
        tenantId: 'tenant-test', workspaceId: 'workspace-test', userId: 'user-test',
      };
      const pinnedFingerprint = buildAnalysisContextAuthorizationFingerprint(options, resolveKnowledgeScope(options));
      options.analysisContextFingerprint = pinnedFingerprint;
      const result = await runtime.analyze('Question', sessionId, 'current-trace', options);
      // Trace-fact preflight already ran inside the turn; finalization reads
      // retained captures and must add nothing to that count.
      const preflightQueries = traceProcessor.query.mock.calls.length;
      context = takeFinalizationContext(result);
      expect(context).toBeDefined();
      options.analysisContextFingerprint = 'later-auth-context';
      const providerQuery = context!.getProviderQuery(new AbortController().signal);
      expect(providerQuery).toEqual({text: 'Question', analysisContextFingerprint: pinnedFingerprint});
      expect(Object.isFrozen(providerQuery)).toBe(true);
      expect(context!.getSelection(new AbortController().signal)).toEqual({present: true, kind: 'track_event',
        context: options.selectionContext, sideResolution: {status: 'unknown'}});
      expect(JSON.stringify(result)).not.toContain('"providerQuery"');
      expect(takeFinalizationContext(result)).toBeUndefined();
      expect(takeFinalizationContext({...result})).toBeUndefined();
      expect(context!.deliveryContext).toMatchObject({completion: result.completion});
      expect(context!.runId).toBe('actual-run');
      expect(context!.traceIdentity).toEqual({currentTraceId: 'current-trace', referenceTraceId: 'reference-trace'});
      expect(readView).toHaveBeenCalledTimes(1);
      expect(readView.mock.calls[0][0].currentRunId).toBe(context!.runId);
      expect(readView.mock.contexts[0]).toBe((runtime as any).artifactStores.get(sessionId));
      expect(readView.mock.calls[0][0]).toMatchObject({allowedTraces: [
        {traceId: 'current-trace', traceSide: 'current'}, {traceId: 'reference-trace', traceSide: 'reference'},
      ], ownerKey: expect.any(String)});
      const reads = await context!.resolveReferences([{key: 'missing-ref', reference: {artifactId: 'not-captured'}, requiredColumns: ['dur']}], new AbortController().signal);
      expect(reads).toEqual([{key: 'missing-ref', status: 'missing', reason: 'evidence_not_retained'}]);
      expect(traceProcessor.query.mock.calls).toHaveLength(preflightQueries);
      const originalDeadline = context!.deadlineMs;
      process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = '2048';
      const review = await context!.dispatchText({prompt: 'Review current claim semantics', systemPrompt: 'Semantic review',
        signal: new AbortController().signal, deadlineMs: originalDeadline + 60_000, outputByteLimit: 64 * 1024});
      expect(review).toMatchObject({status: 'ok', text: reviewBody});
      expect(context!.deadlineMs).toBe(originalDeadline);
      const sdkCalls = claudeSdkMock.__getQueryCalls();
      expect(sdkCalls).toHaveLength(3);
      expect(sdkCalls[2].options).toMatchObject({model: 'pinned-primary-review', maxTurns: 1,
        tools: [], allowedTools: [], mcpServers: {}, persistSession: false});
      expect(sdkCalls[2].options.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe(outputLimit);
      expect(sdkCalls[2].options.resume).toBeUndefined();
      expect(sdkCalls[2].options.cwd).not.toBe(sdkCalls[0].options.cwd);
      await expect(fs.stat(reviewDirectory!)).rejects.toMatchObject({code: 'ENOENT'});
      expect(process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe('2048');
    } finally {
      restoreEnvValue('CLAUDE_CODE_MAX_OUTPUT_TOKENS', outputBudgetBefore);
      context?.dispose(); readView.mockRestore(); sessionContextManager.remove(sessionId);
    }
  });

  it('retains the projected cancelled candidate without a new semantic dispatch', async () => {
    intentDecision = {...defaultIntent, taskKind: 'fact', scope: 'bounded_question', deliverable: 'answer'};
    const sessionId = 'claude-finalization-cancelled';
    registerCodeAwareCanary(sessionId, 'CANCELLED_PRIVATE_CANARY');
    const started = createDeferred<void>();
    const release = createDeferred<void>();
    const runtime = new ClaudeRuntime({query: async () => ({columns: [], rows: []}), getTrace: () => undefined} as any,
      {enableSubAgents: false});
    claudeSdkMock.__setQueryImplementation(async function* () {
      yield {type: 'assistant', message: {content: [{type: 'text', text: 'Before CANCELLED_PRIVATE_CANARY after'}]}};
      started.resolve(); await release.promise;
    });
    let context: ReturnType<typeof takeFinalizationContext>;
    try {
      const pending = runtime.analyze('Question', sessionId, 'trace', {analysisMode: 'fast'});
      await started.promise; runtime.abortSession(sessionId);
      const result = await pending;
      context = takeFinalizationContext(result);
      expect(context).toBeDefined();
      expect(context!.hasSemanticTransport).toBe(false);
      expect(result).toMatchObject({success: false, partial: true, outputOrigin: 'assistant_stream',
        completion: {status: 'cancelled', reason: 'cancelled'}});
      expect(context!.deliveryContext).toMatchObject({completion: result.completion});
      expect(JSON.stringify(result)).not.toContain('CANCELLED_PRIVATE_CANARY');
      expect(await context!.dispatchText({prompt: 'review', systemPrompt: '', signal: new AbortController().signal,
        deadlineMs: context!.deadlineMs, outputByteLimit: 4096})).toMatchObject({status: 'unavailable'});
      expect(claudeSdkMock.__getQueryCalls()).toHaveLength(1);
    } finally {release.resolve(); context?.dispose(); clearCodeAwareOutputGuards(sessionId); sessionContextManager.remove(sessionId);}
  });

  it('records Claude performance receipt from actual provider output and finalization', async () => {
    const traceId = 'trace-claude-performance';
    const traceProcessor = {
      query: jest.fn(async () => ({ columns: ['cnt'], rows: [[0]], durationMs: 1 })),
      getTrace: jest.fn(() => ({
        id: traceId,
        filename: 'trace.pftrace',
        size: 1,
        uploadTime: new Date(),
        status: 'ready',
        traceOs: 'android',
        traceFormat: 'perfetto_protobuf',
      })),
    };
    const runtime = new ClaudeRuntime(traceProcessor as any, {
      enableVerification: false,
      enableSubAgents: false,
    });
    (runtime as any).architectureCache.set(traceId, {
      type: 'STANDARD',
      confidence: 0.9,
      evidence: [],
    });
    claudeSdkMock.__setQueryImplementation(async function* () {
      yield {
        type: 'assistant',
        message: {
          content: [{type: 'text', text: '## 综合结论\nClaude provider output.'}],
        },
      };
      yield {
        type: 'result',
        subtype: 'success',
        session_id: 'sdk-claude-performance',
        num_turns: 1,
        result: '## 综合结论\nClaude provider output.',
      };
    });

    const runtimePerformanceRecorder = createRuntimePerformanceRecorder();
    await expect(withEffectiveRuntimeRegistrySnapshot(
      createEffectiveRuntimeRegistrySnapshot(),
      () => runtime.analyze('分析启动性能', 'session-claude-performance', traceId, {
        analysisMode: 'full',
        packageName: 'com.example.app',
        runManifestAttributionSink: createNoopAttributionSink(runtimePerformanceRecorder),
      }),
    )).resolves.toMatchObject({sessionId: 'session-claude-performance'});

    const receipt = runtimePerformanceRecorder.seal();
    expect(receipt.firstOutputMs).toEqual(expect.any(Number));
    const finalizationPhases = receipt.phases.filter(phase => phase.name === 'finalization');
    expect(finalizationPhases).toHaveLength(1);
    expect(finalizationPhases[0]).toEqual(expect.objectContaining({outcome: 'ok'}));
    expect(receipt.phases).toEqual(expect.arrayContaining([
      expect.objectContaining({name: 'provider', outcome: 'ok'}),
      expect.objectContaining({name: 'finalization', outcome: 'ok'}),
    ]));
  });

  it('starts Claude full comparison, registry, and SQL knowledge before current architecture settles and records preflight phases once', async () => {
    process.env.SMARTPERFETTO_ADMITTED_RUNTIME_CANDIDATES = 'task6';
    const traceId = 'trace-claude-overlap-current';
    const referenceTraceId = 'trace-claude-overlap-reference';
    const sessionId = 'session-claude-overlap-preflight';
    const traceProcessor = {
      query: jest.fn(async () => ({ columns: [], rows: [], durationMs: 1 })),
      getTrace: jest.fn(() => ({
        id: traceId,
        filename: 'trace.pftrace',
        size: 1,
        uploadTime: new Date(),
        status: 'ready',
        traceOs: 'android',
        traceFormat: 'perfetto_protobuf',
      })),
    };
    const runtime = new ClaudeRuntime(traceProcessor as any, {
      enableVerification: false,
      enableSubAgents: false,
    });

    const architectureStarted = createDeferred<void>();
    const releaseArchitecture = createDeferred<any>();
    const releaseCompleteness = createDeferred<any>();
    const releaseRegistry = createDeferred<void>();
    const releaseKnowledge = createDeferred<{ getContextForAI: () => string }>();
    const releaseComparison = createDeferred<any>();
    const runtimePerformanceRecorder = createRuntimePerformanceRecorder();
    const runtimePerformance = createRuntimePerformanceRun(createNoopAttributionSink(runtimePerformanceRecorder));
    const architectureSpy = jest.spyOn(architectureDetector, 'createArchitectureDetector')
      .mockReturnValue({
        detect: jest.fn(async ({traceId: requestedTraceId}: {traceId: string}) => {
          if (requestedTraceId === traceId) {
            architectureStarted.resolve();
            return releaseArchitecture.promise;
          }
          return { type: 'STANDARD', confidence: 0.8, evidence: [] };
        }),
      } as any);
    const completenessSpy = jest.spyOn(traceCompletenessProber, 'probeTraceCompleteness')
      .mockImplementation(async () => releaseCompleteness.promise);
    const registrySpy = jest.spyOn(skillLoader, 'ensureSkillRegistryInitialized')
      .mockImplementation(async () => releaseRegistry.promise);
    const knowledgeSpy = jest.spyOn(sqlKnowledgeBase, 'getExtendedKnowledgeBase')
      .mockImplementation(async () => releaseKnowledge.promise as any);
    const comparisonSpy = jest.spyOn(runtimePromptContext, 'buildRuntimeTracePairComparisonContext')
      .mockImplementation(async () => releaseComparison.promise);

    const preparePromise = (runtime as any).prepareAnalysisContext(
      '分析两条 trace 的启动差异',
      sessionId,
      traceId,
      {
        analysisMode: 'full',
        packageName: 'com.current.app',
        referenceTraceId,
      },
      {
        ...typedPreparation(),
        focusResult: {
          apps: [],
          primaryApp: undefined,
          method: 'none',
        },
        previousTurns: [],
        sceneType: 'startup',
        runtimePerformance,
      },
    );

    try {
      await architectureStarted.promise;
      await Promise.resolve();
      await Promise.resolve();

      expect(registrySpy).toHaveBeenCalledTimes(1);
      expect(knowledgeSpy).toHaveBeenCalledTimes(1);
      expect(comparisonSpy).toHaveBeenCalledTimes(1);
      expect(completenessSpy).not.toHaveBeenCalled();
    } finally {
      releaseArchitecture.resolve({ type: 'STANDARD', confidence: 0.9, evidence: [] });
      releaseCompleteness.resolve(undefined);
      releaseRegistry.resolve();
      releaseKnowledge.resolve({ getContextForAI: () => 'SQL knowledge overlap context' });
      releaseComparison.resolve({
        currentPackageName: 'com.current.app',
        referencePackageName: 'com.reference.app',
        commonCapabilities: [],
        capabilityDiff: { currentOnly: [], referenceOnly: [] },
      });
      await preparePromise;
      const phases = runtimePerformanceRecorder.seal().phases;
      for (const phaseName of ['architecture', 'completeness', 'comparison', 'skill_registry', 'knowledge']) {
        expect(phases.filter(phase => phase.name === phaseName)).toHaveLength(1);
      }
      expect(phases).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'architecture', outcome: 'ok' }),
        expect.objectContaining({ name: 'completeness', outcome: 'ok' }),
        expect.objectContaining({ name: 'comparison', outcome: 'ok' }),
        expect.objectContaining({ name: 'skill_registry', outcome: 'ok' }),
        expect.objectContaining({ name: 'knowledge', outcome: 'ok' }),
      ]));
      architectureSpy.mockRestore();
      completenessSpy.mockRestore();
      registrySpy.mockRestore();
      knowledgeSpy.mockRestore();
      comparisonSpy.mockRestore();
      sessionContextManager.remove(sessionId);
    }
  });

  it('registers a confident focus detection as citable current-run evidence and renders its locator', async () => {
    const traceId = 'trace-claude-focus-evidence';
    const sessionId = 'session-claude-focus-evidence';
    const traceProcessor = {query: jest.fn(async () => ({columns: [], rows: [], durationMs: 1})), getTrace: jest.fn(() => undefined)};
    const runtime = new ClaudeRuntime(traceProcessor as any, {enableVerification: false, enableSubAgents: false});
    const spies = [
      jest.spyOn(skillLoader, 'ensureSkillRegistryInitialized').mockResolvedValue(undefined),
      jest.spyOn(sqlKnowledgeBase, 'getExtendedKnowledgeBase').mockResolvedValue({getContextForAI: () => undefined} as any),
      jest.spyOn(architectureDetector, 'createArchitectureDetector')
        .mockReturnValue({detect: jest.fn(async () => undefined)} as any),
      jest.spyOn(traceCompletenessProber, 'probeTraceCompleteness').mockResolvedValue(undefined as any),
    ];
    try {
      const prepared = await (runtime as any).prepareAnalysisContext('分析启动性能', sessionId, traceId,
        {analysisMode: 'full', runId: 'run-claude-focus'}, {
          ...typedPreparation(),
          focusResult: {method: 'oom_adj', confidence: 'high', primaryApp: 'com.example.focus',
            apps: [{packageName: 'com.example.focus', totalDurationNs: 10, switchCount: 1, score: 40}]},
          previousTurns: [], sceneType: 'startup',
        });
      expect(prepared.systemPrompt).toContain('focusApp.evidence');
      const resolution = await resolveFocusPackageCell((runtime as any).artifactStores.get(sessionId),
        prepared.systemPrompt, traceId, 'run-claude-focus');
      expect(resolution).toMatchObject({status: 'resolved', row: {package_name: 'com.example.focus'},
        record: {meta: {traceSide: 'current', traceId}}});
    } finally {
      spies.forEach(spy => spy.mockRestore());
      sessionContextManager.remove(sessionId);
    }
  });

  it('runs the widened Claude preflight operations sequentially by default', async () => {
    delete process.env.SMARTPERFETTO_ADMITTED_RUNTIME_CANDIDATES;
    const traceId = 'trace-claude-serial-preflight';
    const sessionId = 'session-claude-serial-preflight';
    const traceProcessor = {
      query: jest.fn(async () => ({columns: [], rows: [], durationMs: 1})),
      getTrace: jest.fn(() => ({
        id: traceId,
        filename: 'trace.pftrace',
        size: 1,
        uploadTime: new Date(),
        status: 'ready',
      })),
    };
    const runtime = new ClaudeRuntime(traceProcessor as any, {
      enableVerification: false,
      enableSubAgents: false,
    });
    const releaseRegistry = createDeferred<void>();
    const registrySpy = jest.spyOn(skillLoader, 'ensureSkillRegistryInitialized')
      .mockImplementation(async () => releaseRegistry.promise);
    const knowledgeSpy = jest.spyOn(sqlKnowledgeBase, 'getExtendedKnowledgeBase')
      .mockResolvedValue({getContextForAI: () => 'serial knowledge'} as any);
    const architectureDetect = jest.fn(async () => ({type: 'STANDARD', confidence: 0.9, evidence: []}));
    const architectureSpy = jest.spyOn(architectureDetector, 'createArchitectureDetector')
      .mockReturnValue({detect: architectureDetect} as any);
    const completenessSpy = jest.spyOn(traceCompletenessProber, 'probeTraceCompleteness')
      .mockResolvedValue(undefined as any);

    const pending = (runtime as any).prepareAnalysisContext(
      '分析启动性能',
      sessionId,
      traceId,
      {analysisMode: 'full', packageName: 'com.example.app'},
      {
        ...typedPreparation(),
        focusResult: {apps: [], primaryApp: undefined, method: 'none'},
        previousTurns: [],
        sceneType: 'startup',
      },
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(registrySpy).toHaveBeenCalledTimes(1);
    expect(knowledgeSpy).not.toHaveBeenCalled();
    expect(architectureDetect).not.toHaveBeenCalled();

    releaseRegistry.resolve();
    await pending;
    expect(knowledgeSpy).toHaveBeenCalledTimes(1);
    expect(architectureDetect).toHaveBeenCalledTimes(1);
    expect(completenessSpy).toHaveBeenCalledTimes(1);
    expect(registrySpy.mock.invocationCallOrder[0]).toBeLessThan(knowledgeSpy.mock.invocationCallOrder[0]);
    expect(knowledgeSpy.mock.invocationCallOrder[0]).toBeLessThan(architectureDetect.mock.invocationCallOrder[0]);

    architectureSpy.mockRestore();
    completenessSpy.mockRestore();
    registrySpy.mockRestore();
    knowledgeSpy.mockRestore();
    sessionContextManager.remove(sessionId);
  });

  it('settles Claude overlapped full preflights before cancellation returns without session state writes', async () => {
    process.env.SMARTPERFETTO_ADMITTED_RUNTIME_CANDIDATES = 'task6';
    const traceId = 'trace-claude-cancel-current';
    const referenceTraceId = 'trace-claude-cancel-reference';
    const sessionId = 'session-claude-cancel-preflight';
    const traceProcessor = {
      query: jest.fn(async () => ({ columns: [], rows: [], durationMs: 1 })),
      getTrace: jest.fn(() => ({
        id: traceId,
        filename: 'trace.pftrace',
        size: 1,
        uploadTime: new Date(),
        status: 'ready',
        traceOs: 'android',
        traceFormat: 'perfetto_protobuf',
      })),
    };
    const runtime = new ClaudeRuntime(traceProcessor as any, {
      enableVerification: false,
      enableSubAgents: false,
    });
    const abortController = new AbortController();
    const abortError = new Error('cancelled by Claude preflight barrier test');
    const executionLease = {
      key: { runtime: 'claude-agent', sessionId, referenceTraceId },
      signal: abortController.signal,
      throwIfAborted: () => {
        if (abortController.signal.aborted) throw abortError;
      },
      settle: jest.fn(),
    };
    const architectureStarted = createDeferred<void>();
    const comparisonStarted = createDeferred<void>();
    const releaseArchitecture = createDeferred<any>();
    const releaseCompleteness = createDeferred<any>();
    const releaseRegistry = createDeferred<void>();
    const releaseKnowledge = createDeferred<{ getContextForAI: () => string }>();
    const releaseComparison = createDeferred<any>();
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.on('unhandledRejection', onUnhandledRejection);
    const architectureSpy = jest.spyOn(architectureDetector, 'createArchitectureDetector')
      .mockReturnValue({
        detect: jest.fn(async ({traceId: requestedTraceId}: {traceId: string}) => {
          if (requestedTraceId === traceId) {
            architectureStarted.resolve();
            return releaseArchitecture.promise;
          }
          return { type: 'STANDARD', confidence: 0.8, evidence: [] };
        }),
      } as any);
    const completenessSpy = jest.spyOn(traceCompletenessProber, 'probeTraceCompleteness')
      .mockImplementation(async () => releaseCompleteness.promise);
    const registrySpy = jest.spyOn(skillLoader, 'ensureSkillRegistryInitialized')
      .mockImplementation(async () => releaseRegistry.promise);
    const knowledgeSpy = jest.spyOn(sqlKnowledgeBase, 'getExtendedKnowledgeBase')
      .mockImplementation(async () => releaseKnowledge.promise as any);
    const comparisonSpy = jest.spyOn(runtimePromptContext, 'buildRuntimeTracePairComparisonContext')
      .mockImplementation(async () => {
        comparisonStarted.resolve();
        return releaseComparison.promise;
      });

    const preparePromise = (runtime as any).prepareAnalysisContext(
      '取消前的两条 trace 启动差异',
      sessionId,
      traceId,
      {
        analysisMode: 'full',
        packageName: 'com.current.app',
        referenceTraceId,
      },
      {
        ...typedPreparation(),
        focusResult: {
          apps: [],
          primaryApp: undefined,
          method: 'none',
        },
        previousTurns: [],
        sceneType: 'startup',
        executionLease,
      },
    );

    try {
      await Promise.all([architectureStarted.promise, comparisonStarted.promise]);
      abortController.abort(abortError);
      releaseRegistry.reject(new Error('registry rejected after cancellation'));
      releaseKnowledge.reject(new Error('knowledge rejected after cancellation'));
      releaseComparison.reject(new Error('comparison rejected after cancellation'));
      releaseArchitecture.resolve({ type: 'STANDARD', confidence: 0.9, evidence: [] });
      await Promise.resolve();
      releaseCompleteness.resolve(undefined);

      await expect(preparePromise).rejects.toThrow(abortError.message);
      await new Promise(resolve => setImmediate(resolve));
      expect(unhandledRejections).toHaveLength(0);
      expect(registrySpy).toHaveBeenCalledTimes(1);
      expect(knowledgeSpy).toHaveBeenCalledTimes(1);
      expect(comparisonSpy).toHaveBeenCalledTimes(1);
      expect(completenessSpy).toHaveBeenCalledTimes(1);
      expect((runtime as any).artifactStores.has(sessionId)).toBe(false);
      expect((runtime as any).sessionPlans.has(sessionId)).toBe(false);
      expect((runtime as any).sessionNotes.has(sessionId)).toBe(false);
      expect((runtime as any).sessionHypotheses.has(sessionId)).toBe(false);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
      architectureSpy.mockRestore();
      completenessSpy.mockRestore();
      registrySpy.mockRestore();
      knowledgeSpy.mockRestore();
      comparisonSpy.mockRestore();
      sessionContextManager.remove(sessionId);
    }
  });

  it('records focus:error when Claude focus detection unexpectedly rejects and provider policy remains graceful', async () => {
    const sessionId = 'session-claude-focus-rejection';
    const traceId = 'trace-claude-focus-rejection';
    const focusSpy = jest.spyOn(focusAppDetector, 'detectFocusApps')
      .mockRejectedValueOnce(new Error('synthetic unexpected focus rejection'));
    const traceProcessor = {
      query: jest.fn(async () => ({ columns: ['cnt'], rows: [[0]], durationMs: 1 })),
      getTrace: jest.fn(() => ({
        id: traceId,
        filename: 'trace.pftrace',
        size: 1,
        uploadTime: new Date(),
        status: 'ready',
        traceOs: 'android',
        traceFormat: 'perfetto_protobuf',
      })),
    };
    const runtime = new ClaudeRuntime(traceProcessor as any, {
      enableVerification: false,
      enableSubAgents: false,
    });
    (runtime as any).architectureCache.set(traceId, {
      type: 'STANDARD',
      confidence: 0.9,
      evidence: [],
    });
    claudeSdkMock.__setQueryImplementation(async function* () {
      yield {
        type: 'result',
        subtype: 'success',
        session_id: 'sdk-claude-focus-rejection',
        num_turns: 1,
        result: '## 综合结论\nProvider still runs after focus detection degrades gracefully.',
      };
    });
    const runtimePerformanceRecorder = createRuntimePerformanceRecorder();

    try {
      const result = await withEffectiveRuntimeRegistrySnapshot(
        createEffectiveRuntimeRegistrySnapshot(),
        () => runtime.analyze('分析启动性能', sessionId, traceId, {
          analysisMode: 'full',
          runManifestAttributionSink: createNoopAttributionSink(runtimePerformanceRecorder),
        }),
      );

      expect(result.success).toBe(true);
      expect(focusSpy).toHaveBeenCalledTimes(1);
      expect(claudeSdkMock.__getQueryCalls()).toHaveLength(2);
      const receipt = runtimePerformanceRecorder.seal();
      const focusPhases = receipt.phases.filter(phase => phase.name === 'focus');
      const providerPhases = receipt.phases.filter(phase => phase.name === 'provider');
      const finalizationPhases = receipt.phases.filter(phase => phase.name === 'finalization');
      expect(focusPhases).toHaveLength(1);
      expect(focusPhases[0]).toEqual(expect.objectContaining({outcome: 'error'}));
      expect(providerPhases).toHaveLength(2);
      expect(providerPhases).toEqual(expect.arrayContaining([
        expect.objectContaining({outcome: 'ok'}), expect.objectContaining({outcome: 'ok'}),
      ]));
      expect(finalizationPhases).toHaveLength(1);
      expect(finalizationPhases[0]).toEqual(expect.objectContaining({outcome: 'ok'}));
    } finally {
      focusSpy.mockRestore();
      sessionContextManager.remove(sessionId);
    }
  });

  it('records focus:cancelled and publishes no Claude state when cancellation arrives while focus is active', async () => {
    const sessionId = 'session-claude-focus-live-cancel';
    const traceId = 'trace-claude-focus-live-cancel';
    const focusStarted = createDeferred<void>();
    const releaseFocus = createDeferred<focusAppDetector.FocusAppDetectionResult>();
    const focusSpy = jest.spyOn(focusAppDetector, 'detectFocusApps')
      .mockImplementationOnce(async () => {
        focusStarted.resolve();
        return releaseFocus.promise;
      });
    const runtime = new ClaudeRuntime({
      query: jest.fn(async () => ({ columns: ['cnt'], rows: [[0]], durationMs: 1 })),
      getTrace: jest.fn(() => ({
        id: traceId,
        filename: 'trace.pftrace',
        size: 1,
        uploadTime: new Date(),
        status: 'ready',
        traceOs: 'android',
        traceFormat: 'perfetto_protobuf',
      })),
    } as any, {
      enableVerification: false,
      enableSubAgents: false,
    });
    (runtime as any).architectureCache.set(traceId, {
      type: 'STANDARD',
      confidence: 0.9,
      evidence: [],
    });
    claudeSdkMock.__setQueryImplementation(async function* () {
      throw new Error('provider must not start after focus cancellation');
    });
    const runtimePerformanceRecorder = createRuntimePerformanceRecorder();

    try {
      const analysis = withEffectiveRuntimeRegistrySnapshot(
        createEffectiveRuntimeRegistrySnapshot(),
        () => runtime.analyze('分析启动性能', sessionId, traceId, {
          analysisMode: 'full',
          runManifestAttributionSink: createNoopAttributionSink(runtimePerformanceRecorder),
        }),
      );
      await focusStarted.promise;
      runtime.abortSession(sessionId);
      releaseFocus.resolve({ apps: [], method: 'none' });

      const result = await analysis;
      expect(result.success).toBe(false);
      expect(result.terminationMessage).toMatch(/aborted|cancelled/i);
      expect(focusSpy).toHaveBeenCalledTimes(1);
      expect(claudeSdkMock.__getQueryCalls()).toHaveLength(0);
      const turns = sessionContextManager.getOrCreate(sessionId, traceId).getAllTurns?.() ?? [];
      expect(turns).toHaveLength(0);
      expect((runtime as any).sessionMap.get(sessionId)).toBeUndefined();
      expect(runtimeSnapshotCount()).toBe(0);
      const receipt = runtimePerformanceRecorder.seal();
      expect(receipt.phases.filter(phase => phase.name === 'focus')).toEqual([
        expect.objectContaining({outcome: 'cancelled'}),
      ]);
      expect(receipt.phases.filter(phase => phase.name === 'provider')).toHaveLength(0);
      expect(receipt.phases.filter(phase => phase.name === 'finalization')).toEqual([
        expect.objectContaining({outcome: 'cancelled'}),
      ]);
    } finally {
      focusSpy.mockRestore();
      sessionContextManager.remove(sessionId);
    }
  });

  it('passes stable and volatile full-mode prompt blocks through the Claude cache boundary', async () => {
    const runtime = new ClaudeRuntime({
      query: async () => ({ columns: ['cnt'], rows: [[0]] }),
      getTrace: () => ({ traceOs: 'android', traceFormat: 'perfetto' }),
    } as any, {
      enableVerification: false,
      enableSubAgents: false,
    });
    (runtime as any).architectureCache.set('trace-cache-boundary', {
      type: 'STANDARD',
      confidence: 0.9,
      evidence: [],
    });
    claudeSdkMock.__setQueryImplementation(async function* () {
      yield {
        type: 'result',
        subtype: 'success',
        session_id: 'sdk-cache-boundary',
        num_turns: 1,
        result: [
          '## 综合结论',
          'Full-mode prompt cache boundary was applied.',
          '',
          '## 关键证据链',
          '- Selection context stayed in the volatile suffix.',
          '',
          '## 优化建议',
          '- Keep stable prompt sections cacheable.',
        ].join('\n'),
      };
    });

    const result = await runtime.analyze('分析选区内的掉帧', 'session-cache-boundary', 'trace-cache-boundary', {
      analysisMode: 'full',
      packageName: 'com.example.app',
      selectionContext: { kind: 'area', startNs: 100, endNs: 200 } as any,
    });

    expect(result.success).toBe(true);
    const [call] = claudeSdkMock.__getQueryCalls();
    expect(Array.isArray(call.options.systemPrompt)).toBe(true);
    const blocks = call.options.systemPrompt as string[];
    const boundaryIndex = blocks.indexOf('__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__');
    expect(boundaryIndex).toBeGreaterThan(0);
    expect(blocks.slice(0, boundaryIndex).join('\n\n')).toContain('SmartPerfetto');
    const parseContextRecords = (parts: string[]) => parts.flatMap(part => part.split('\n\n'))
      .flatMap(part => {try {return [JSON.parse(part)];} catch {return [];}});
    expect(parseContextRecords(blocks.slice(boundaryIndex + 1))).toContainEqual({
      context: 'selection_context', data: {kind: 'area', startNs: 100, endNs: 200},
    });
    expect(parseContextRecords(blocks.slice(0, boundaryIndex)).some(record => record.context === 'selection_context')).toBe(false);
    expect(call.options.persistSession).toBe(true);
  });

  it('rejects same-session direct overlap even when run and reference ids differ', async () => {
    const runtime = new ClaudeRuntime({
      query: async () => ({ columns: ['cnt'], rows: [[0]] }),
      getTrace: () => ({ traceOs: 'android', traceFormat: 'perfetto' }),
    } as any, {
      enableVerification: false,
      enableSubAgents: false,
    });
    (runtime as any).architectureCache.set('trace-claude-overlap', {
      type: 'STANDARD',
      confidence: 0.9,
      evidence: [],
    });
    const releaseSdk = createDeferred<void>();
    claudeSdkMock.__setQueryImplementation(async function* () {
      await releaseSdk.promise;
      yield {
        type: 'result',
        subtype: 'success',
        session_id: 'sdk-claude-overlap',
        num_turns: 1,
        result: [
          '## 综合结论',
          '',
          'Claude overlap first run completed.',
          '',
          '## 关键证据链',
          '',
          '- The first run held the runtime session lease.',
          '',
          '## 优化建议',
          '',
          '- Reject overlapping direct callers.',
        ].join('\n'),
      };
    });

    const first = runtime.analyze('first', 'session-claude-overlap', 'trace-claude-overlap', {
      analysisMode: 'full',
      packageName: 'com.example.app',
      runId: 'run-1',
      referenceTraceId: 'ref-1',
    });
    await Promise.resolve();
    const second = runtime.analyze('second', 'session-claude-overlap', 'trace-claude-overlap', {
      analysisMode: 'full',
      packageName: 'com.example.app',
      runId: 'run-2',
      referenceTraceId: 'ref-2',
    });

    await expect(second).rejects.toThrow(/already in progress/i);
    releaseSdk.resolve();
    await expect(first).resolves.toMatchObject({ success: true });
  });

  it('allows different sessions to run independently', async () => {
    const runtime = new ClaudeRuntime({
      query: async () => ({ columns: ['cnt'], rows: [[0]] }),
      getTrace: () => ({ traceOs: 'android', traceFormat: 'perfetto' }),
    } as any, {
      enableVerification: false,
      enableSubAgents: false,
    });
    (runtime as any).architectureCache.set('trace-claude-isolated', {
      type: 'STANDARD',
      confidence: 0.9,
      evidence: [],
    });
    claudeSdkMock.__setQueryImplementation(async function* () {
      yield {
        type: 'result',
        subtype: 'success',
        session_id: `sdk-claude-${Math.random().toString(36).slice(2)}`,
        num_turns: 1,
        result: [
          '## 综合结论',
          '',
          'Claude isolated session completed.',
          '',
          '## 关键证据链',
          '',
          '- Different logical sessions use independent leases.',
          '',
          '## 优化建议',
          '',
          '- Keep concurrent sessions independent.',
        ].join('\n'),
      };
    });

    await expect(Promise.all([
      runtime.analyze('first', 'session-claude-isolated-1', 'trace-claude-isolated', {
        analysisMode: 'full',
        packageName: 'com.example.app',
      }),
      runtime.analyze('second', 'session-claude-isolated-2', 'trace-claude-isolated', {
        analysisMode: 'full',
        packageName: 'com.example.app',
      }),
    ])).resolves.toEqual([
      expect.objectContaining({ success: true }),
      expect.objectContaining({ success: true }),
    ]);
  });

  it('starts fresh despite a saved provider session and does not retry missing-session errors', async () => {
    intentDecision = {...defaultIntent, taskKind: 'fact', scope: 'bounded_question', deliverable: 'answer'};
    const sessionId = 'session-claude-missing-saved';
    const runtime = new ClaudeRuntime({query: async () => ({columns: [], rows: []}), getTrace: () => undefined} as any,
      {enableSubAgents: false});
    (runtime as any).sessionMap.set(sessionId, {sdkSessionId: 'sdk-missing', updatedAt: Date.now(), mode: 'full'});
    claudeSdkMock.__setQueryImplementation(async function* () {
      yield {type: 'result', subtype: 'error_during_execution', num_turns: 1,
        errors: [{message: 'No conversation found with session ID: sdk-missing'}]};
    });
    try {
      const result = await runtime.analyze('Question', sessionId, 'trace', {analysisMode: 'fast'});
      expect(result).toMatchObject({success: false, rounds: 1, completion: {status: 'failed', reason: 'provider_error'}});
      const calls = claudeSdkMock.__getQueryCalls();
      expect(calls).toHaveLength(1);
      expect(calls[0].options.resume).toBeUndefined();
    } finally {sessionContextManager.remove(sessionId);}
  });

  it.each([true, false])('reserves one isolated summary and keeps turn-limit provenance (summary succeeds: %p)', async summarySucceeds => {
    const sessionId = `claude-turn-closeout-${summarySucceeds}`;
    const runtime = new ClaudeRuntime({query: async () => ({columns: [], rows: []}), getTrace: () => undefined} as any,
      {enableSubAgents: false, maxTurns: 3, model: 'pinned-main', maxBudgetUsd: 1});
    const mcpSpy = jest.spyOn(claudeMcpServer, 'createClaudeMcpServer');
    let calls = 0;
    claudeSdkMock.__setQueryImplementation(async function* (params) {
      calls++;
      if (calls === 1) {
        expect(params.options.maxTurns).toBe(2);
        const mcp = mcpSpy.mock.calls.slice(-1)[0]![0];
        await mcp.toolObserver?.({phase: 'started', toolCallId: 'query-1', toolName: 'execute_sql', params: {}, extra: {}});
        await mcp.toolObserver?.({phase: 'completed', toolCallId: 'query-1', toolName: 'execute_sql', params: {}, extra: {},
          result: {content: [{type: 'text', text: JSON.stringify({columns: ['dur_ms'], rows: [[42]]})}]}});
        yield {type: 'assistant', message: {content: [{type: 'text', text: 'Observed duration is 42 ms; cause is unresolved.'}]}};
        yield {type: 'result', subtype: 'error_max_turns', num_turns: 2, total_cost_usd: 0.25};
      } else {
        expect(params.options).toMatchObject({model: 'pinned-main', maxTurns: 1,
          tools: [], allowedTools: [], mcpServers: {}, persistSession: false, maxBudgetUsd: 0.75});
        expect(params.options.resume).toBeUndefined();
        expect(params.prompt).toContain('42');
        expect(params.prompt).toContain('execute_sql');
        expect(mcpSpy.mock.calls.slice(-1)[0]![0].canInvokeTool?.()).toBe(false);
        yield summarySucceeds
          ? {type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn',
            result: 'Duration is 42 ms. Cause remains unresolved; next ask for the main-thread interval.'}
          : {type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['summary failed']};
      }
    });
    try {
      const result = await runtime.analyze('Investigate duration', sessionId, 'trace', {analysisMode: 'full'});
      expect(calls).toBe(2);
      expect(result).toMatchObject({partial: true, rounds: 3, terminationReason: 'max_turns',
        completion: {status: 'incomplete', reason: 'turn_limit'}});
      expect(result.conclusion).toBe(summarySucceeds
        ? 'Duration is 42 ms. Cause remains unresolved; next ask for the main-thread interval.'
        : 'Observed duration is 42 ms; cause is unresolved.');
      expect(result.completion?.attemptId).toContain(summarySucceeds ? 'turn-closeout:1' : ':main:');
      const lastTurn = sessionContextManager.getOrCreate(sessionId, 'trace').getAllTurns().slice(-1)[0]!;
      expect(lastTurn.result).toMatchObject({partial: true, completion: {status: 'incomplete', reason: 'turn_limit'}});
    } finally {mcpSpy.mockRestore(); sessionContextManager.remove(sessionId);}
  });

  it('does not exceed a configured dollar budget when the native cost receipt is missing', async () => {
    const sessionId = 'claude-cost-unknown';
    const runtime = new ClaudeRuntime({query: async () => ({columns: [], rows: []}), getTrace: () => undefined} as any,
      {enableSubAgents: false, maxTurns: 3, maxBudgetUsd: 1});
    claudeSdkMock.__setQueryImplementation(async function* () {
      yield {type: 'result', subtype: 'error_max_turns', num_turns: 2};
    });
    try {
      const result = await runtime.analyze('Investigate duration', sessionId, 'trace', {analysisMode: 'full'});
      expect(claudeSdkMock.__getQueryCalls()).toHaveLength(1);
      expect(result).toMatchObject({partial: true, rounds: 2, completion: {reason: 'turn_limit'}});
    } finally {sessionContextManager.remove(sessionId);}
  });

  it.each([{maxTurns: 1, reportedTurns: 1}, {maxTurns: 3, reportedTurns: 3}])(
    'does not add a summary when the total budget has no room: %p', async ({maxTurns, reportedTurns}) => {
      const sessionId = 'claude-no-summary-room';
      const runtime = new ClaudeRuntime({query: async () => ({columns: [], rows: []}), getTrace: () => undefined} as any,
        {enableSubAgents: false, maxTurns});
      claudeSdkMock.__setQueryImplementation(async function* () {
        yield {type: 'assistant', message: {content: [{type: 'text', text: 'Only a partial observation.'}]}};
        yield {type: 'result', subtype: 'error_max_turns', num_turns: reportedTurns};
      });
      try {
        const result = await runtime.analyze('Investigate duration', sessionId, 'trace', {analysisMode: 'full'});
        expect(claudeSdkMock.__getQueryCalls()).toHaveLength(1);
        expect(result).toMatchObject({partial: true, rounds: reportedTurns, completion: {reason: 'turn_limit'}});
      } finally {sessionContextManager.remove(sessionId);}
    },
  );

  it('counts a cancelled closeout and retains the original acquired answer', async () => {
    const sessionId = 'claude-cancel-closeout';
    const summaryStarted = createDeferred<void>();
    const summaryAborted = createDeferred<void>();
    const runtime = new ClaudeRuntime({query: async () => ({columns: [], rows: []}), getTrace: () => undefined} as any,
      {enableSubAgents: false, maxTurns: 3});
    let calls = 0;
    claudeSdkMock.__setQueryImplementation(async function* (params) {
      if (++calls === 1) {
        yield {type: 'assistant', message: {content: [{type: 'text', text: 'Acquired answer before cancellation.'}]}};
        yield {type: 'result', subtype: 'error_max_turns', num_turns: 2};
        return;
      }
      params.options.abortController.signal.addEventListener('abort', () => summaryAborted.resolve(), {once: true});
      summaryStarted.resolve();
      await summaryAborted.promise;
      yield {type: 'result', subtype: 'success', is_error: false, result: 'Late summary must not win.'};
    });
    const analysis = runtime.analyze('Investigate duration', sessionId, 'trace', {analysisMode: 'full'});
    await summaryStarted.promise;
    await runtime.abortSession(sessionId);
    const result = await analysis;
    expect(result).toMatchObject({success: false, partial: true, rounds: 3,
      conclusion: 'Acquired answer before cancellation.', completion: {status: 'cancelled', reason: 'cancelled'}});
    expect(calls).toBe(2);
    sessionContextManager.remove(sessionId);
  });

  it('does not publish a Claude turn or correction when cancelled during final verification', async () => {
    const sessionId = 'session-claude-verification-cancel';
    const traceId = 'trace-claude-verification-cancel';
    const verificationStarted = createDeferred<void>();
    const releaseVerification = createDeferred<void>();
    mockClaudeVerifierVerifyConclusion.mockImplementationOnce(async () => {
      verificationStarted.resolve();
      await releaseVerification.promise;
      return {
        passed: true,
        heuristicIssues: [],
        llmIssues: [],
        durationMs: 1,
      };
    });
    const runtime = new ClaudeRuntime({
      query: async () => ({ columns: ['cnt'], rows: [[0]] }),
      getTrace: () => ({ traceOs: 'android', traceFormat: 'perfetto' }),
    } as any, {
      enableVerification: true,
      enableSubAgents: false,
    });
    (runtime as any).architectureCache.set(traceId, {
      type: 'STANDARD',
      confidence: 0.9,
      evidence: [],
    });
    claudeSdkMock.__setQueryImplementation(async function* () {
      yield {
        type: 'result',
        subtype: 'success',
        session_id: 'sdk-claude-verification-cancel',
        num_turns: 1,
        result: [
          '## 综合结论',
          '',
          'Claude verification cancellation should not publish a durable turn.',
          '',
          '## 关键证据链',
          '',
          '- Verification is paused by the test before publication.',
          '',
          '## 优化建议',
          '',
          '- Do not publish after cancellation.',
        ].join('\n'),
      };
    });

    const runtimePerformanceRecorder = createRuntimePerformanceRecorder();
    const analysis = withEffectiveRuntimeRegistrySnapshot(
      createEffectiveRuntimeRegistrySnapshot(),
      () => runtime.analyze('分析启动性能', sessionId, traceId, {
        analysisMode: 'full',
        packageName: 'com.example.app',
        runManifestAttributionSink: createNoopAttributionSink(runtimePerformanceRecorder),
      }),
    );
    await verificationStarted.promise;
    runtime.abortSession(sessionId);
    releaseVerification.resolve();

    const result = await analysis;
    expect(result.success).toBe(false);
    expect(result.terminationMessage).toMatch(/aborted|cancelled/i);
    expect(claudeSdkMock.__getQueryCalls()).toHaveLength(1);
    const turns = sessionContextManager.getOrCreate(sessionId, traceId).getAllTurns?.() ?? [];
    expect(turns).toHaveLength(0);
    const receipt = runtimePerformanceRecorder.seal();
    const finalizationPhases = receipt.phases.filter(phase => phase.name === 'finalization');
    expect(finalizationPhases).toHaveLength(1);
    expect(finalizationPhases[0]).toEqual(expect.objectContaining({outcome: 'cancelled'}));
    sessionContextManager.remove(sessionId);
  });

  it('does not mutate Claude plan, notes, or snapshot state when cancelled after provider loop closes', async () => {
    const sessionId = 'session-claude-post-loop-cancel';
    const traceId = 'trace-claude-post-loop-cancel';
    const runtime = new ClaudeRuntime({
      query: async () => ({ columns: ['cnt'], rows: [[0]] }),
      getTrace: () => ({ traceOs: 'android', traceFormat: 'perfetto' }),
    } as any, {
      enableVerification: false,
      enableSubAgents: false,
    });
    (runtime as any).architectureCache.set(traceId, {
      type: 'STANDARD',
      confidence: 0.9,
      evidence: [],
    });
    const plan = {
      phases: [{
        id: 'final',
        name: '综合结论',
        goal: '输出最终报告',
        expectedTools: [],
        status: 'pending',
      }],
      successCriteria: '输出最终报告',
      submittedAt: Date.now(),
      toolCallLog: [],
    };
    const originalPrepare = (runtime as any).prepareAnalysisContext.bind(runtime);
    jest.spyOn(runtime as any, 'prepareAnalysisContext').mockImplementation(async (...args: unknown[]) => {
      const ctx = await originalPrepare(...args);
      ctx.analysisPlan.current = plan;
      (runtime as any).sessionPlans.set(sessionId, ctx.analysisPlan);
      (runtime as any).sessionNotes.set(sessionId, []);
      return ctx;
    });
    claudeSdkMock.__setQueryImplementation(async function* () {
      try {
      yield { type: 'system', subtype: 'compact_boundary' };
      yield {
        type: 'result',
        subtype: 'success',
        session_id: 'sdk-claude-post-loop-cancel',
        num_turns: 1,
        result: [
          '## 综合结论',
          '',
          'Claude post-loop cancellation should not mutate plan or recovery notes.',
          '',
          '## 关键证据链',
          '',
          '- Provider loop completed before cancellation.',
          '',
          '## 优化建议',
          '',
          '- Stop before durable post-loop state mutation.',
        ].join('\n'),
      };
      } finally {
        runtime.abortSession(sessionId);
      }
    });

    const result = await runtime.analyze('分析启动性能', sessionId, traceId, {
      analysisMode: 'full',
      packageName: 'com.example.app',
    });

    expect(result.success).toBe(false);
    expect(result.completion).toMatchObject({status: 'cancelled', reason: 'cancelled'});
    expect(result.outputOrigin).toBe('sdk_final');
    expect(result.conclusion).toContain('Claude post-loop cancellation should not mutate plan or recovery notes.');
    expect((runtime.getSessionPlan(sessionId)?.phases[0] as any)?.status).toBe('pending');
    expect(runtime.getSessionNotes(sessionId)).toHaveLength(0);
    const snapshot = runtime.takeSnapshot(sessionId, traceId, {
      conversationSteps: [],
      queryHistory: [],
      conclusionHistory: [],
      agentDialogue: [],
      agentResponses: [],
      dataEnvelopes: [],
      runSequence: 0,
      conversationOrdinal: 0,
    } as any);
    expect((snapshot.analysisPlan?.phases[0] as any)?.status).toBe('pending');
    expect(snapshot.analysisNotes).toEqual([]);
    sessionContextManager.remove(sessionId);
  });

  it('uses the request language throughout the full path without mutating runtime defaults', async () => {
    const runtime = new ClaudeRuntime({
      query: async () => ({columns: ['cnt'], rows: [[0]]}),
      getTrace: () => ({traceOs: 'android', traceFormat: 'perfetto'}),
    } as any, {
      outputLanguage: 'zh-CN',
      enableVerification: false,
      enableSubAgents: false,
    });
    (runtime as any).architectureCache.set('trace-language-full', {
      type: 'STANDARD',
      confidence: 0.9,
      evidence: [],
    });
    const updates: any[] = [];
    runtime.on('update', update => updates.push(update));
    claudeSdkMock.__setQueryImplementation(async function* () {
      yield {
        type: 'result',
        subtype: 'success',
        session_id: 'sdk-language-full',
        num_turns: 1,
        result: [
          '# Performance Analysis Report',
          '',
          '## Overall Conclusion',
          '',
          'The selected interval is stable based on the collected evidence.',
          '',
          '## Key Evidence Chain',
          '',
          '- The trace query completed successfully.',
          '',
          '## Recommendations',
          '',
          '- Continue monitoring the selected interval.',
        ].join('\n'),
      };
    });

    await runtime.analyze(
      'Analyze the selected interval',
      'session-language-full',
      'trace-language-full',
      {
        analysisMode: 'full',
        outputLanguage: 'en',
        packageName: 'com.example.app',
        selectionContext: {kind: 'area', startNs: 100, endNs: 200} as any,
      },
    );

    const [call] = claudeSdkMock.__getQueryCalls();
    expect(JSON.stringify(call.options.systemPrompt)).toContain(
      'All user-facing answers, reports, phase summaries',
    );
    const progress = updates.filter(update => update.type === 'progress')
      .map(update => String(update.content?.message ?? '')).join('\n');
    expect(progress).toContain('Starting analysis with');
    expect(progress).not.toContain('开始分析');
    expect((runtime as any).config.outputLanguage).toBe('zh-CN');
  });

  it('keeps private full-mode Claude transcripts ephemeral and out of resume maps', async () => {
    const sessionId = 'session-private-sdk';
    const runtime = new ClaudeRuntime({
      query: async () => ({columns: ['cnt'], rows: [[0]]}),
      getTrace: () => ({traceOs: 'android', traceFormat: 'perfetto'}),
    } as any, {
      enableVerification: false,
      enableSubAgents: false,
    });
    (runtime as any).architectureCache.set('trace-private-sdk', {
      type: 'STANDARD',
      confidence: 0.9,
      evidence: [],
    });
    sessionContextManager.getOrCreate(sessionId, 'trace-private-sdk').addTurn(
      '上一轮私有问题',
      {
        primaryGoal: '上一轮私有问题',
        aspects: [],
        expectedOutputType: 'diagnosis',
        complexity: 'complex',
        followUpType: 'initial',
      },
      {
        agentId: 'claude-agent',
        success: true,
        findings: [],
        confidence: 0.8,
        message: 'PRIVATE_LOCAL_CONTINUITY_CANARY',
      },
      [],
    );
    claudeSdkMock.__setQueryImplementation(async function* () {
      yield {
        type: 'result',
        subtype: 'success',
        session_id: 'sdk-private-session-canary',
        num_turns: 1,
        result: [
          '## 综合结论',
          '私有源码分析已完成。',
          '',
          '## 关键证据链',
          '- 仅使用本轮授权上下文。',
          '',
          '## 优化建议',
          '- 修正私有源码中的热点路径。',
        ].join('\n'),
      };
    });

    try {
      const result = await runtime.analyze('分析私有源码热点', sessionId, 'trace-private-sdk', {
        analysisMode: 'full',
        codeAwareMode: 'metadata_only',
        codebaseIds: ['private-app'],
        tenantId: 'tenant-private',
        workspaceId: 'workspace-private',
        userId: 'user-private',
      });

      expect(result).toMatchObject({
        success: true,
        completion: {status: 'completed'},
        sourceUseDecision: expect.objectContaining({status: 'pending'}),
      });
      expect(result.partial).toBeUndefined();
      expect(result.terminationReason).toBeUndefined();
      expect(result.completion?.conclusionFingerprint).toBe(analysisDeliveryFingerprint(result.conclusion));
      const [call] = claudeSdkMock.__getQueryCalls();
      expect(call.options.persistSession).toBe(false);
      expect(call.options.resume).toBeUndefined();
      expect(call.prompt).toContain('PRIVATE_LOCAL_CONTINUITY_CANARY');
      expect(runtime.getSdkSessionId(sessionId)).toBeUndefined();
      expect(JSON.stringify(Array.from((runtime as any).sessionMap.values())))
        .not.toContain('sdk-private-session-canary');
    } finally {
      sessionContextManager.remove(sessionId);
    }
  });

  it.each(['full', 'fast'] as const)(
    'preserves native Claude %s completion while recording pending source access',
    async analysisMode => {
      const sessionId = `session-claude-pending-${analysisMode}`;
      const traceId = `trace-claude-pending-${analysisMode}`;
      const originalCreateMcp = claudeMcpServer.createClaudeMcpServer;
      const fixture = createRuntimeSourceFinalizationFixture({
        createMcpServer: originalCreateMcp,
        sessionId,
      });
      const createMcpSpy = jest.spyOn(claudeMcpServer, 'createClaudeMcpServer')
        .mockReturnValue(fixture.mcp);
      const runtime = new ClaudeRuntime({
        query: async () => ({columns: ['cnt'], rows: [[0]]}),
        getTrace: () => ({traceOs: 'android', traceFormat: 'perfetto'}),
      } as any, {
        enableVerification: false,
        enableSubAgents: false,
      });
      (runtime as any).architectureCache.set(traceId, {
        type: 'STANDARD',
        confidence: 0.9,
        evidence: [],
      });
      claudeSdkMock.__setQueryImplementation(async function* () {
        yield {
          type: 'result',
          subtype: 'success',
          session_id: `sdk-pending-${analysisMode}`,
          num_turns: 1,
          result: '## Final Report\nTask 7 pending source answer',
        };
      });

      try {
        const result = await runtime.analyze('source pending run', sessionId, traceId, {
          analysisMode,
          assistantSurface: analysisMode === 'fast' ? 'conversation' : undefined,
          conversationTraceAttached: analysisMode === 'fast' ? true : undefined,
          codeAwareMode: 'provider_send',
          codebaseIds: [fixture.codebaseId],
        });

        expect(result).toMatchObject({
          success: true,
          completion: {status: 'completed'},
          sourceUseDecision: expect.objectContaining({status: 'pending'}),
          sourceReferences: [],
        });
        expect(result.partial).toBeUndefined();
        expect(result.terminationReason).toBeUndefined();
        expect(result.conclusion).toBe('## Final Report\nTask 7 pending source answer');
        expect(result.completion?.conclusionFingerprint).toBe(analysisDeliveryFingerprint(result.conclusion));
      } finally {
        createMcpSpy.mockRestore();
        fixture.cleanup();
        sessionContextManager.remove(sessionId);
      }
    },
  );

  it('finalizes a failed Claude quick result with the actual source accessor and echo guard', async () => {
    const sessionId = 'session-claude-quick-error-finalization';
    const traceId = 'trace-claude-quick-error-finalization';
    const originalCreateMcp = claudeMcpServer.createClaudeMcpServer;
    const fixture = createRuntimeSourceFinalizationFixture({
      createMcpServer: originalCreateMcp,
      sessionId,
    });
    const createMcpSpy = jest.spyOn(claudeMcpServer, 'createClaudeMcpServer')
      .mockReturnValue(fixture.mcp);
    const runtime = new ClaudeRuntime({
      query: async () => ({columns: ['cnt'], rows: [[0]]}),
      getTrace: () => ({traceOs: 'android', traceFormat: 'perfetto'}),
    } as any, {
      enableVerification: false,
      enableSubAgents: false,
    });
    (runtime as any).architectureCache.set(traceId, {
      type: 'STANDARD',
      confidence: 0.9,
      evidence: [],
    });
    claudeSdkMock.__setQueryImplementation(async function* () {
      yield {
        type: 'result',
        subtype: 'error_during_execution',
        errors: [SOURCE_FINALIZATION_RAW_SOURCE],
      };
    });

    try {
      const {decision} = await fixture.executeProviderSourceLookup();
      const result = await runtime.analyze('source quick error run', sessionId, traceId, {
        analysisMode: 'fast',
        assistantSurface: 'conversation',
        conversationTraceAttached: true,
        codeAwareMode: 'provider_send',
        codebaseIds: [fixture.codebaseId],
      });

      expect(result.success).toBe(false);
      expect(result.terminationReason).toBe('execution_error');
      expect(result.terminationMessage).toBeDefined();
      expect(result.sourceUseDecision).toEqual(decision);
      expect(result.sourceReferences).toEqual(decision.references);
      expect(JSON.stringify(result)).toContain(SOURCE_FINALIZATION_CANARY);
    } finally {
      createMcpSpy.mockRestore();
      fixture.cleanup();
      sessionContextManager.remove(sessionId);
    }
  });

  it('returns real MCP source refs and starts the next Claude run without stale source state', async () => {
    const sessionId = 'session-claude-source-finalization';
    const traceId = 'trace-claude-source-finalization';
    const originalCreateMcp = claudeMcpServer.createClaudeMcpServer;
    const fixture = createRuntimeSourceFinalizationFixture({
      createMcpServer: originalCreateMcp,
      sessionId,
    });
    const createMcpSpy = jest.spyOn(claudeMcpServer, 'createClaudeMcpServer')
      .mockImplementation((options: any) => options.codeAwareMode === 'provider_send'
        ? fixture.mcp
        : originalCreateMcp(options));
    const runtime = new ClaudeRuntime({
      query: async () => ({columns: ['cnt'], rows: [[0]]}),
      getTrace: () => ({traceOs: 'android', traceFormat: 'perfetto'}),
    } as any, {
      enableVerification: false,
      enableSubAgents: false,
    });
    (runtime as any).architectureCache.set(traceId, {
      type: 'STANDARD',
      confidence: 0.9,
      evidence: [],
    });
    claudeSdkMock.__setQueryImplementation(async function* ({prompt}: any) {
      const sourceRun = String(prompt).includes('source terminal run');
      yield {
        type: 'result',
        subtype: 'success',
        session_id: sourceRun ? 'sdk-source-terminal' : 'sdk-source-off',
        num_turns: 1,
        result: sourceRun ? SOURCE_FINALIZATION_RAW_SOURCE : 'public second run',
      };
    });

    try {
      const {decision} = await fixture.executeProviderSourceLookup();
      const terminal = await runtime.analyze('source terminal run', sessionId, traceId, {
        analysisMode: 'fast',
        assistantSurface: 'conversation',
        conversationTraceAttached: true,
        codeAwareMode: 'provider_send',
        codebaseIds: [fixture.codebaseId],
      });
      const context = takeFinalizationContext(terminal)!;
      try {
        expect(context.getNativeDeclaration(terminal, new AbortController().signal)?.raw).toBe(SOURCE_FINALIZATION_RAW_SOURCE);
        expect(JSON.stringify(terminal)).not.toContain('conclusion_protocol_projection');
      } finally {context.dispose();}
      const next = await runtime.analyze('public second run', sessionId, traceId, {
        analysisMode: 'fast',
        codeAwareMode: 'off',
      });

      expect(terminal.success).toBe(true);
      expect(terminal.sourceUseDecision).toEqual(decision);
      expect(terminal.sourceReferences).toEqual(decision.references);
      expect(JSON.stringify(terminal)).toContain(SOURCE_FINALIZATION_CANARY);
      expect(next.sourceUseDecision).toBeUndefined();
      expect(next.sourceReferences).toBeUndefined();
    } finally {
      createMcpSpy.mockRestore();
      fixture.cleanup();
      sessionContextManager.remove(sessionId);
    }
  });

  it('keeps generic SDK execution errors failed after an evidence-backed streamed answer', async () => {
    const sessionId = 'session-generic-stream-failure';
    const runtime = new ClaudeRuntime({
      query: async () => ({columns: ['cnt'], rows: [[0]]}),
      getTrace: () => ({traceOs: 'android', traceFormat: 'perfetto'}),
    } as any, {
      enableVerification: false,
      enableSubAgents: false,
    });
    (runtime as any).architectureCache.set('trace-generic-stream-failure', {
      type: 'STANDARD',
      confidence: 0.9,
      evidence: [],
    });
    const updates: Array<{type?: string; content?: Record<string, unknown>}> = [];
    runtime.on('update', update => updates.push(update as any));
    claudeSdkMock.__setQueryImplementation(async function* () {
      yield {
        type: 'assistant',
        session_id: 'sdk-generic-stream-failure',
        message: {
          content: [{
            type: 'text',
            text: [
              '# 启动性能分析报告',
              '',
              '## 综合结论',
              '',
              '冷启动 TTID=1912ms，证据来自 art-1。',
              '',
              '## 关键证据链',
              '',
              '- art-1: 主线程热点 568.8ms。',
              '',
              '## 优化建议',
              '',
              '- 拆分主线程同步初始化。',
            ].join('\n'),
          }],
        },
      };
      yield {
        type: 'result',
        subtype: 'error_during_execution',
        session_id: 'sdk-generic-stream-failure',
        num_turns: 2,
        errors: ['Claude analysis error after tool execution'],
      };
    });

    const runtimePerformanceRecorder = createRuntimePerformanceRecorder();
    try {
      const result = await withEffectiveRuntimeRegistrySnapshot(
        createEffectiveRuntimeRegistrySnapshot(),
        () => runtime.analyze(
          '分析启动性能',
          sessionId,
          'trace-generic-stream-failure',
          {
            analysisMode: 'full',
            runManifestAttributionSink: createNoopAttributionSink(runtimePerformanceRecorder),
          },
        ),
      );

      expect(result).toMatchObject({
        success: false,
        terminationReason: 'execution_error',
      });
      expect(result.partial).toBe(true);
      expect(result.completion).toMatchObject({status: 'failed', reason: 'provider_error'});
      expect(result.conclusion).toContain('TTID=1912ms');
      expect(updates).not.toContainEqual(expect.objectContaining({
        type: 'degraded',
        content: expect.objectContaining({
          fallback: 'partial_result_after_stream_termination',
        }),
      }));
      const receipt = runtimePerformanceRecorder.seal();
      const finalizationPhases = receipt.phases.filter(phase => phase.name === 'finalization');
      expect(finalizationPhases).toHaveLength(1);
      expect(finalizationPhases[0]).toEqual(expect.objectContaining({outcome: 'error'}));
      expect(receipt.phases).toEqual(expect.arrayContaining([
        expect.objectContaining({name: 'provider', outcome: 'error'}),
      ]));
    } finally {
      sessionContextManager.remove(sessionId);
    }
  });

  it.each([
    {
      name: 'stream execution failure',
      subtype: 'error_during_execution',
      errors: ['stream terminated before completion'],
      terminationReason: 'execution_error',
    },
    {
      name: 'maximum-turn termination',
      subtype: 'error_max_turns',
      errors: ['maximum turns reached'],
      terminationReason: 'max_turns',
    },
  ])('sanitizes a private streamed report before returning after $name', async ({
    subtype,
    errors,
    terminationReason,
  }) => {
    const sessionId = 'session-private-stream-recovery';
    const privateCanary = 'PRIVATE_STREAM_RECOVERY_CANARY';
    registerCodeAwareCanary(sessionId, privateCanary);
    const runtime = new ClaudeRuntime({
      query: async () => ({columns: ['cnt'], rows: [[0]]}),
      getTrace: () => ({traceOs: 'android', traceFormat: 'perfetto'}),
    } as any, {
      enableVerification: false,
      enableSubAgents: false,
    });
    (runtime as any).architectureCache.set('trace-private-stream-recovery', {
      type: 'STANDARD',
      confidence: 0.9,
      evidence: [],
    });
    const updates: Array<{type?: string; content?: Record<string, unknown>}> = [];
    runtime.on('update', update => updates.push(update as any));
    claudeSdkMock.__setQueryImplementation(async function* () {
      yield {
        type: 'assistant',
        session_id: 'sdk-private-stream-recovery',
        message: {
          content: [{
            type: 'text',
            text: [
              '# 启动性能分析报告',
              '',
              '## 综合结论',
              '',
              `冷启动 TTID=1912ms，证据来自 art-1。${privateCanary}`,
              '',
              '## 关键证据链',
              '',
              '- art-1: 主线程热点 568.8ms。',
              '',
              '## 优化建议',
              '',
              '- 拆分主线程同步初始化。',
            ].join('\n'),
          }],
        },
      };
      yield {
        type: 'result',
        subtype,
        session_id: 'sdk-private-stream-recovery',
        num_turns: 2,
        errors,
      };
    });

    try {
      const result = await runtime.analyze(
        '分析私有源码启动热点',
        sessionId,
        'trace-private-stream-recovery',
        {
          analysisMode: 'full',
          codeAwareMode: 'metadata_only',
          codebaseIds: ['private-app'],
          tenantId: 'tenant-private',
          workspaceId: 'workspace-private',
          userId: 'user-private',
        },
      );

      expect(result).toMatchObject({
        success: subtype === 'error_max_turns',
        partial: true,
        terminationReason,
        sourceUseDecision: expect.objectContaining({status: 'pending'}),
      });
      expect(result.conclusion).toContain('TTID=1912ms');
      expect(JSON.stringify(result)).not.toContain(privateCanary);
      expect(result.completion).toMatchObject({
        status: subtype === 'error_max_turns' ? 'incomplete' : 'failed',
        reason: subtype === 'error_max_turns' ? 'turn_limit' : 'provider_error',
      });
    } finally {
      sessionContextManager.remove(sessionId);
    }
  });

  it('keeps unsupported runtime prompt cache capabilities on the full system prompt string', () => {
    const sdkPrompt = __testing.buildClaudeSdkSystemPrompt({
      fullPrompt: 'stable\n\nvolatile',
      stablePrefix: 'stable',
      volatileSuffix: 'volatile',
    }, {
      kind: 'unsupported-runtime',
      displayName: 'Unsupported Runtime',
      production: false,
      publicRuntime: false,
      promptCache: { systemPromptDynamicBoundary: false },
      draftAnswerStreaming: false,
    });

    expect(sdkPrompt).toBe('stable\n\nvolatile');
  });

  it('keeps monitor-only context pressure warnings out of user-facing progress updates', async () => {
    process.env.CLAUDE_PRECOMPACT_THRESHOLD = '0.6';
    const runtime = new ClaudeRuntime({
      query: async () => ({ columns: [], rows: [] }),
      getTrace: () => ({ traceOs: 'android', traceFormat: 'perfetto' }),
    } as any, {
      enableVerification: false,
      enableSubAgents: false,
    });
    (runtime as any).architectureCache.set('trace-context-pressure', {
      type: 'STANDARD',
      confidence: 0.9,
      evidence: [],
    });
    const updates: any[] = [];
    runtime.on('update', update => updates.push(update));
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    claudeSdkMock.__setQueryImplementation(async function* () {
      yield {
        type: 'assistant',
        session_id: 'sdk-context-pressure',
        message: { content: [] },
      };
      yield {
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: {
            usage: {
              input_tokens: 130_000,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
          },
        },
      };
      yield {
        type: 'result',
        subtype: 'success',
        session_id: 'sdk-context-pressure',
        num_turns: 1,
        result: [
          '# 启动性能分析报告',
          '',
          '## 综合结论',
          '',
          '冷启动 TTID=1912ms，主因是 ChaosTask，证据来自 data:art-1。',
          '',
          '## 关键证据链',
          '',
          '- data:art-1: startup_analysis 显示冷启动。',
          '',
          '## 优化建议',
          '',
          '- 减少主线程模拟负载。',
        ].join('\n'),
      };
    });

    try {
      const result = await runtime.analyze('分析启动性能', 'session-context-pressure', 'trace-context-pressure', {
        analysisMode: 'full',
        packageName: 'com.example.launch.aosp.heavy',
      });

      expect(result.success).toBe(true);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('pre-rot threshold crossed'));
      const progressText = updates
        .filter(update => update.type === 'progress')
        .map(update => JSON.stringify(update.content))
        .join('\n');
      expect(progressText).not.toContain('接近上下文上限');
      expect(progressText).not.toContain('Context window is close to its limit');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('records authoritative first-turn Claude result usage including cache tokens', async () => {
    const runtime = new ClaudeRuntime({
      query: async () => ({columns: [], rows: []}),
      getTrace: () => ({traceOs: 'android', traceFormat: 'perfetto'}),
    } as any, {
      enableVerification: false,
      enableSubAgents: false,
    });
    (runtime as any).architectureCache.set('trace-evaluation-usage', {
      type: 'STANDARD',
      confidence: 0.9,
      evidence: [],
    });
    claudeSdkMock.__setQueryImplementation(async function* () {
      yield {
        type: 'assistant',
        session_id: 'sdk-evaluation-usage',
        message: {content: []},
      };
      yield {
        type: 'result',
        subtype: 'success',
        session_id: 'sdk-evaluation-usage',
        num_turns: 1,
        usage: {
          input_tokens: 10,
          output_tokens: 3,
          cache_read_input_tokens: 7,
          cache_creation_input_tokens: 2,
        },
        result: [
          '# 启动性能分析报告',
          '',
          '## 综合结论',
          '',
          '启动分析完成，证据来自 data:art-usage。',
          '',
          '## 关键证据链',
          '',
          '- data:art-usage: 启动路径证据。',
          '',
          '## 优化建议',
          '',
          '- 缩短主线程初始化。',
        ].join('\n'),
      };
    });

    const receipt = await withEvaluationTelemetry({
      limits: {
        schemaVersion: 1,
        maxTokens: 100,
        maxToolCalls: 100,
        maxWallclockMs: 30_000,
        maxTraceProcessorCpuMs: 30_000,
      },
      capabilities: evaluationRuntimeCapabilities({
        runtime: 'claude-agent-sdk',
      }),
      signal: new AbortController().signal,
      isAuthoritative: () => true,
    }, async () => {
      const result = await runtime.analyze(
        '分析启动性能',
        'session-evaluation-usage',
        'trace-evaluation-usage',
        {
          analysisMode: 'full',
          packageName: 'com.example.app',
        },
      );
      expect(result.success).toBe(true);
      return snapshotEvaluationUsageReceipt();
    });

    expect(receipt.tokens).toMatchObject({
      used: 22,
      guarantee: 'soft_observed',
    });
    sessionContextManager.remove('session-evaluation-usage');
  });

  it('returns a terminal partial result after the full provider stream becomes idle', async () => {
    jest.useFakeTimers({doNotFake: ['nextTick', 'setImmediate']});
    const started = createDeferred<void>();
    const release = createDeferred<void>();
    const sessionId = 'session-full-stream-idle-timeout';
    const traceId = 'trace-full-stream-idle-timeout';
    const runtime = new ClaudeRuntime({
      query: async () => ({columns: ['cnt'], rows: [[0]]}),
      getTrace: () => ({traceOs: 'android', traceFormat: 'perfetto'}),
    } as any, {
      enableVerification: false,
      enableSubAgents: false,
      maxTurns: 1,
      fullPathPerTurnMs: 100,
      fullRequestTimeoutMs: 1_000,
      streamIdleTimeoutMs: 15,
    });
    (runtime as any).architectureCache.set(traceId, {
      type: 'STANDARD',
      confidence: 0.9,
      evidence: [],
    });
    const updates: Array<{type?: string; content?: Record<string, unknown>}> = [];
    runtime.on('update', update => updates.push(update as any));
    claudeSdkMock.__setQueryImplementation(async function* () {
      yield {
        type: 'assistant',
        session_id: 'sdk-full-stream-idle-timeout',
        message: {content: [{
          type: 'text',
          text: [
            '# 启动性能分析报告',
            '',
            '## 综合结论',
            '',
            '已收集到可交付的部分证据，art-1 显示主线程存在阻塞。',
            '',
            '## 关键证据链',
            '',
            '- art-1: 主线程阻塞 568.8ms。',
            '',
            '## 优化建议',
            '',
            '- 拆分同步初始化。',
          ].join('\n'),
        }]},
      };
      started.resolve();
      await release.promise;
    });

    try {
      const pending = runtime.analyze(
        '分析启动性能',
        sessionId,
        traceId,
        {analysisMode: 'full'},
      );
      await started.promise;
      await jest.advanceTimersByTimeAsync(15);
      const result = await pending;

      expect(result).toMatchObject({
        success: true,
        partial: true,
        terminationReason: 'timeout',
      });
      expect(result.conclusion).toContain('art-1');
      expect(updates).toContainEqual(expect.objectContaining({
        type: 'degraded',
        content: expect.objectContaining({
          fallback: 'partial_result_after_timeout',
          partial: true,
          terminationReason: 'timeout',
          timeoutKind: 'stream_idle',
        }),
      }));
    } finally {
      release.resolve();
      jest.useRealTimers();
      sessionContextManager.remove(sessionId);
    }
  });

  it('uses the same delivery turn to repair a rejected declaration, keeping the body and every claim', async () => {
    const body = 'Frame 12 missed its deadline.';
    const runtime = new ClaudeRuntime({
      query: async () => ({columns: [], rows: []}),
      getTrace: () => ({traceOs: 'android', traceFormat: 'perfetto'}),
    } as any, {enableVerification: false, enableSubAgents: false, maxTurns: 4, maxBudgetUsd: 1});
    (runtime as any).architectureCache.set('trace-invalid-declaration', {type: 'STANDARD', confidence: 0.9, evidence: []});
    mockClaudeVerifierVerifyConclusion.mockResolvedValue({passed: true, heuristicIssues: [], llmIssues: [], durationMs: 1});
    let sdkCallCount = 0;
    claudeSdkMock.__setQueryImplementation(async function* () {
      sdkCallCount += 1;
      yield {type: 'result', subtype: 'success', session_id: 'sdk-invalid-declaration', num_turns: 1,
        total_cost_usd: 0.1, result: candidateWithPopulation(body, sdkCallCount === 1 ? 'everywhere' : 'cited_rows', 'miss')};
    });
    const result = await runtime.analyze('分析当前证据', 'session-invalid-declaration', 'trace-invalid-declaration', {
      analysisMode: 'full', runId: 'claude-invalid-declaration', packageName: 'com.example.app',
    });
    const calls = claudeSdkMock.__getQueryCalls();
    expect(calls).toHaveLength(2);
    expect(calls[1].options).toMatchObject({maxTurns: 1, tools: [], allowedTools: []});
    expect(calls[1].prompt).toContain('invalid_declaration');
    expect(calls[1].prompt).toContain('"field":"semantics.scope.population"');
    expect(inspectCandidateProtocol(result.conclusion).status).toBe('valid');
    expect(result.completion).toMatchObject({status: 'completed', attemptId: expect.stringContaining(':correction:1')});
    takeFinalizationContext(result)?.dispose();
  });

  it('keeps the issue-based correction when a rejected declaration is too large to repair', async () => {
    const body = `${'Frame 12 missed its deadline. '.repeat(4700)}`.trimEnd();
    expect(Buffer.byteLength(body, 'utf8')).toBeGreaterThan(128 * 1024);
    const invalid = declaredCandidateWithClaims(body, [declaredClaim('miss', {semantics: {schemaVersion: 'other'}})]);
    const runtime = new ClaudeRuntime({
      query: async () => ({columns: [], rows: []}),
      getTrace: () => ({traceOs: 'android', traceFormat: 'perfetto'}),
    } as any, {enableVerification: false, enableSubAgents: false, maxTurns: 4, maxBudgetUsd: 1});
    (runtime as any).architectureCache.set('trace-oversized-declaration', {type: 'STANDARD', confidence: 0.9, evidence: []});
    mockClaudeVerifierVerifyConclusion.mockResolvedValue({passed: false, durationMs: 1, llmIssues: [], heuristicIssues: [
      {type: 'missing_evidence', severity: 'error', message: 'Needs evidence', recoveryKind: 'correct_evidence'}]});
    claudeSdkMock.__setQueryImplementation(async function* () {
      yield {type: 'result', subtype: 'success', session_id: 'sdk-oversized-declaration', num_turns: 1,
        total_cost_usd: 0.1, result: invalid};
    });
    const result = await runtime.analyze('分析当前证据', 'session-oversized-declaration', 'trace-oversized-declaration', {
      analysisMode: 'full', runId: 'claude-oversized-declaration', packageName: 'com.example.app',
    });
    const calls = claudeSdkMock.__getQueryCalls();
    expect(calls).toHaveLength(2);
    expect(calls[1].prompt).not.toContain('invalid_declaration');
    takeFinalizationContext(result)?.dispose();
  });

  it('uses one no-tools delivery turn to attach declarations without truncating the native body', async () => {
    const body = `${'启动正文保持完整。'.repeat(850)}\n${'Native body remains unchanged. '.repeat(170)}`.trimEnd();
    expect(Buffer.byteLength(body, 'utf8')).toBeGreaterThan(8 * 1024);
    const runtime = new ClaudeRuntime({
      query: async () => ({columns: [], rows: []}),
      getTrace: () => ({traceOs: 'android', traceFormat: 'perfetto'}),
    } as any, {enableVerification: false, enableSubAgents: false, maxTurns: 4, maxBudgetUsd: 1});
    (runtime as any).architectureCache.set('trace-missing-declaration', {
      type: 'STANDARD', confidence: 0.9, evidence: [],
    });
    mockClaudeVerifierVerifyConclusion.mockResolvedValue({
      passed: true, heuristicIssues: [], llmIssues: [], durationMs: 1,
    });
    let sdkCallCount = 0;
    claudeSdkMock.__setQueryImplementation(async function* () {
      sdkCallCount += 1;
      yield {type: 'result', subtype: 'success', session_id: 'sdk-missing-declaration', num_turns: 1,
        total_cost_usd: sdkCallCount === 1 ? 0.25 : 0.1,
        result: sdkCallCount === 1 ? body : declaredCandidate(body)};
    });

    const result = await runtime.analyze('分析当前证据', 'session-missing-declaration', 'trace-missing-declaration', {
      analysisMode: 'full', runId: 'claude-missing-declaration', packageName: 'com.example.app',
    });

    const calls = claudeSdkMock.__getQueryCalls();
    expect(calls).toHaveLength(2);
    expect(calls[1].options).toMatchObject({maxTurns: 1, maxBudgetUsd: 0.75, tools: [], allowedTools: []});
    expect(calls[1].prompt).toContain('missing_declaration');
    const candidateLine = calls[1].prompt.split('\n').find((line: string) => line.startsWith('{"schemaVersion":1,"kind":"original_native_candidate"'));
    expect(JSON.parse(candidateLine ?? '{}')).toEqual({schemaVersion: 1, kind: 'original_native_candidate', body});
    expect(inspectCandidateProtocol(result.conclusion).canonicalBody.trim()).toBe(body);
    expect(result.completion).toMatchObject({status: 'completed', attemptId: expect.stringContaining(':correction:1')});
  });

  it.each([
    {name: 'exhausted cost budget', body: 'Completed candidate without declaration.', maxBudgetUsd: 1, totalCostUsd: 1},
    {name: '128 KiB output cap', body: 'x'.repeat(128 * 1024), maxBudgetUsd: undefined, totalCostUsd: undefined},
  ])('does not dispatch declaration completion past the $name', async ({body, maxBudgetUsd, totalCostUsd}) => {
    const runtime = new ClaudeRuntime({query: async () => ({columns: [], rows: []}), getTrace: () => undefined} as any,
      {enableVerification: false, enableSubAgents: false, maxTurns: 4, ...(maxBudgetUsd === undefined ? {} : {maxBudgetUsd})});
    mockClaudeVerifierVerifyConclusion.mockResolvedValue({passed: true, heuristicIssues: [], llmIssues: [], durationMs: 1});
    claudeSdkMock.__setQueryImplementation(async function* () {
      yield {type: 'result', subtype: 'success', session_id: 'sdk-declaration-no-dispatch', num_turns: 1,
        ...(totalCostUsd === undefined ? {} : {total_cost_usd: totalCostUsd}), result: body};
    });
    const result = await runtime.analyze('分析当前证据', `session-${maxBudgetUsd ?? 'cap'}`, 'trace-no-declaration-dispatch', {
      analysisMode: 'full', packageName: 'com.example.app',
    });
    expect(claudeSdkMock.__getQueryCalls()).toHaveLength(1);
    expect(result.conclusion).toBe(body);
    expect(result.completion).toMatchObject({status: 'completed'});
  });

  it('rejects an unchanged Claude repair when the declaration pushes the candidate over the output cap', async () => {
    const body = 'x'.repeat(128 * 1024 - 100);
    const repaired = declaredCandidate(body);
    expect(Buffer.byteLength(body, 'utf8')).toBeLessThan(128 * 1024);
    expect(Buffer.byteLength(repaired, 'utf8')).toBeGreaterThan(128 * 1024);
    const runtime = new ClaudeRuntime({query: async () => ({columns: [], rows: []}), getTrace: () => undefined} as any,
      {enableVerification: false, enableSubAgents: false, maxTurns: 4});
    mockClaudeVerifierVerifyConclusion.mockResolvedValue({passed: true, heuristicIssues: [], llmIssues: [], durationMs: 1});
    let sdkCallCount = 0;
    claudeSdkMock.__setQueryImplementation(async function* () {
      sdkCallCount += 1;
      yield {type: 'result', subtype: 'success', session_id: 'sdk-declaration-overflow', num_turns: 1,
        result: sdkCallCount === 1 ? body : repaired};
    });
    const result = await runtime.analyze('分析当前证据', 'session-claude-declaration-overflow', 'trace-declaration-overflow', {
      analysisMode: 'full', packageName: 'com.example.app',
    });
    expect(claudeSdkMock.__getQueryCalls()).toHaveLength(2);
    expect(result.conclusion).toBe(body);
    expect(result.completion?.attemptId).not.toContain(':correction:1');
  });

  it('retains the original Claude attempt when a dispatched declaration completion changes the body', async () => {
    const body = 'Original bounded answer.';
    const changed = declaredCandidate('Changed bounded answer.');
    const runtime = new ClaudeRuntime({query: async () => ({columns: [], rows: []}), getTrace: () => undefined} as any,
      {enableVerification: false, enableSubAgents: false, maxTurns: 4});
    mockClaudeVerifierVerifyConclusion.mockResolvedValue({passed: true, heuristicIssues: [], llmIssues: [], durationMs: 1});
    let sdkCallCount = 0;
    claudeSdkMock.__setQueryImplementation(async function* () {
      sdkCallCount += 1;
      yield {type: 'result', subtype: 'success', session_id: 'sdk-declaration-changed-body', num_turns: 1,
        result: sdkCallCount === 1 ? body : changed};
    });
    const updates: unknown[] = [];
    runtime.on('update', update => updates.push(update));

    const result = await runtime.analyze('分析当前证据', 'session-claude-declaration-changed-body',
      'trace-declaration-changed-body', {analysisMode: 'full', runId: 'claude-declaration-changed-body',
        packageName: 'com.example.app'});

    expect(claudeSdkMock.__getQueryCalls()).toHaveLength(2);
    expect(result.conclusion).toBe(body);
    expect(result.completion).toMatchObject({status: 'completed', runId: 'claude-declaration-changed-body',
      conclusionFingerprint: analysisDeliveryFingerprint(body)});
    expect(result.completion?.attemptId).not.toContain(':correction:1');
    expect(JSON.stringify(updates)).not.toContain('Changed bounded answer');
  });

  it('rejects a Claude declaration returned after authorization changes without replacing the first candidate', async () => {
    const body = 'Authorized candidate body.';
    const repaired = declaredCandidate(body);
    const runtime = new ClaudeRuntime({query: async () => ({columns: [], rows: []}), getTrace: () => undefined} as any,
      {enableVerification: false, enableSubAgents: false, maxTurns: 4});
    mockClaudeVerifierVerifyConclusion.mockResolvedValue({passed: true, heuristicIssues: [], llmIssues: [], durationMs: 1});
    let sdkCallCount = 0;
    let revoked = false;
    claudeSdkMock.__setQueryImplementation(async function* () {
      sdkCallCount += 1;
      if (sdkCallCount === 2) revoked = true;
      yield {type: 'result', subtype: 'success', session_id: 'sdk-declaration-authorization-change', num_turns: 1,
        result: sdkCallCount === 1 ? body : repaired};
    });
    const realAuthorization = contextAuthorization.assertCurrentAnalysisContextAuthorization;
    const authorization = jest.spyOn(contextAuthorization, 'assertCurrentAnalysisContextAuthorization').mockImplementation((...args) => {
      if (revoked) throw new contextAuthorization.AnalysisContextAuthorizationChangedError();
      return realAuthorization(...args);
    });
    try {
      const result = await runtime.analyze('分析当前证据', 'session-claude-declaration-authorization-change',
        'trace-declaration-authorization-change', {analysisMode: 'full', packageName: 'com.example.app'});
      expect(claudeSdkMock.__getQueryCalls()).toHaveLength(2);
      expect(result.conclusion).toBe(body);
      expect(result.completion?.attemptId).not.toContain(':correction:1');
    } finally {authorization.mockRestore();}
  });

  it('uses scoped Claude provider tuning when preparing full SDK options', async () => {
    const original = {
      anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL,
      anthropicApiKey: process.env.ANTHROPIC_API_KEY,
      claudeModel: process.env.CLAUDE_MODEL,
      claudeLightModel: process.env.CLAUDE_LIGHT_MODEL,
      claudeBinaryPath: process.env.CLAUDE_BINARY_PATH,
    };
    process.env.ANTHROPIC_BASE_URL = 'https://global-main.example/v1';
    process.env.ANTHROPIC_API_KEY = 'sk-global-main';
    process.env.CLAUDE_MODEL = 'global-claude-main';
    process.env.CLAUDE_LIGHT_MODEL = 'global-claude-light';
    process.env.CLAUDE_BINARY_PATH = '/tmp/global-main-claude';
    try {
      const svc = getProviderService();
      const provider = svc.create({
        name: 'Scoped Claude Provider',
        category: 'official',
        type: 'anthropic',
        models: {
          primary: 'provider-claude-main',
          light: 'provider-claude-light',
          subAgent: 'provider-claude-subagent',
        },
        connection: {
          agentRuntime: 'claude-agent-sdk',
          claudeBaseUrl: 'https://provider-main.example/v1',
          claudeApiKey: 'sk-provider-claude',
        },
        tuning: {
          maxTurns: 4,
          fullPerTurnMs: 10000,
          effort: 'max',
          enableSubAgents: true,
          enableVerification: false,
        },
      });
      svc.activate(provider.id);

      const runtime = new ClaudeRuntime({
        query: async () => ({ columns: [], rows: [] }),
        getTrace: () => ({ traceOs: 'android', traceFormat: 'perfetto' }),
      } as any, {
        enableVerification: false,
        enableSubAgents: false,
        model: 'base-claude-main',
        maxTurns: 60,
        effort: 'low',
      });
      (runtime as any).architectureCache.set('trace-provider', {
        type: 'STANDARD',
        confidence: 0.9,
        evidence: [],
      });
      claudeSdkMock.__setQueryImplementation(async function* () {
        yield {
          type: 'result',
          subtype: 'success',
          session_id: 'sdk-provider-session',
          num_turns: 1,
          result: [
            '## 综合结论',
            'Scoped provider tuning was applied to the Claude full analysis path.',
            '',
            '## 证据',
            '- Provider-specific model, effort, maxTurns, and sub-agent config were used.',
          ].join('\n'),
        };
      });

      const result = await runtime.analyze('分析 UI 卡顿', 'session-provider', 'trace-provider', {
        analysisMode: 'full',
        packageName: 'com.example.app',
      });

      expect(result.success).toBe(true);
      const [call] = claudeSdkMock.__getQueryCalls();
      expect(call.options.model).toBe('provider-claude-main');
      expect(call.options.maxTurns).toBe(3);
      expect(call.options.effort).toBe('max');
      expect(call.options.pathToClaudeCodeExecutable).toBe('/tmp/global-main-claude');
      expect(call.options.env.CLAUDE_MODEL).toBe('provider-claude-main');
      expect(call.options.env.CLAUDE_LIGHT_MODEL).toBe('provider-claude-light');
      expect(call.options.env.ANTHROPIC_BASE_URL).toBe('https://provider-main.example/v1');
      expect(call.options.env.ANTHROPIC_API_KEY).toBe('sk-provider-claude');
      expect(call.options.agents).toBeDefined();
      expect(call.options.tools).toEqual(['Agent']);
      expect(call.options.allowedTools).toContain('Agent');
      expect(JSON.stringify(call.options.agents)).toContain('provider-claude-subagent');
      expect(process.env.ANTHROPIC_BASE_URL).toBe('https://global-main.example/v1');
      expect(process.env.ANTHROPIC_API_KEY).toBe('sk-global-main');
      expect(process.env.CLAUDE_MODEL).toBe('global-claude-main');
      expect(process.env.CLAUDE_LIGHT_MODEL).toBe('global-claude-light');
      expect(process.env.CLAUDE_BINARY_PATH).toBe('/tmp/global-main-claude');
    } finally {
      restoreEnvValue('ANTHROPIC_BASE_URL', original.anthropicBaseUrl);
      restoreEnvValue('ANTHROPIC_API_KEY', original.anthropicApiKey);
      restoreEnvValue('CLAUDE_MODEL', original.claudeModel);
      restoreEnvValue('CLAUDE_LIGHT_MODEL', original.claudeLightModel);
      restoreEnvValue('CLAUDE_BINARY_PATH', original.claudeBinaryPath);
    }
  });

  it('uses scoped Claude provider tuning for SDK correction retries without mutating process.env', async () => {
    const original = {
      anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL,
      anthropicApiKey: process.env.ANTHROPIC_API_KEY,
      claudeModel: process.env.CLAUDE_MODEL,
      claudeLightModel: process.env.CLAUDE_LIGHT_MODEL,
      claudeBinaryPath: process.env.CLAUDE_BINARY_PATH,
    };
    process.env.ANTHROPIC_BASE_URL = 'https://global-correction.example/v1';
    process.env.ANTHROPIC_API_KEY = 'sk-global-correction';
    process.env.CLAUDE_MODEL = 'global-claude-main';
    process.env.CLAUDE_LIGHT_MODEL = 'global-claude-light';
    process.env.CLAUDE_BINARY_PATH = '/tmp/global-correction-claude';
    try {
      const svc = getProviderService();
      const provider = svc.create({
        name: 'Scoped Claude Correction Provider',
        category: 'official',
        type: 'anthropic',
        models: {
          primary: 'provider-claude-correction-main',
          light: 'provider-claude-correction-light',
        },
        connection: {
          agentRuntime: 'claude-agent-sdk',
          claudeBaseUrl: 'https://provider-correction.example/v1',
          claudeApiKey: 'sk-provider-correction',
        },
        tuning: {
          maxTurns: 4,
          fullPerTurnMs: 10000,
          effort: 'max',
          enableVerification: true,
          enableSubAgents: false,
        },
      });
      svc.activate(provider.id);

      const runtime = new ClaudeRuntime({
        query: async () => ({ columns: [], rows: [] }),
        getTrace: () => ({ traceOs: 'android', traceFormat: 'perfetto' }),
      } as any, {
        enableVerification: true,
        enableSubAgents: false,
        model: 'base-claude-main',
        maxTurns: 60,
        effort: 'low',
      });
      (runtime as any).architectureCache.set('trace-provider-correction', {
        type: 'STANDARD',
        confidence: 0.9,
        evidence: [],
      });
      let sdkCallCount = 0;
      claudeSdkMock.__setQueryImplementation(async function* () {
        sdkCallCount += 1;
        yield {
          type: 'result',
          subtype: 'success',
          session_id: 'sdk-provider-correction-session',
          num_turns: 1,
          result: declaredCandidate(sdkCallCount === 1
            ? '## 综合结论\nInitial provider conclusion requires correction.'
            : [
                '## 综合结论',
                'Corrected provider conclusion.',
                '',
                '## 证据',
                '- Correction retry used the pinned provider SDK options.',
              ].join('\n')),
        };
      });
      mockClaudeVerifierVerifyConclusion
        .mockResolvedValueOnce({
          passed: false,
          heuristicIssues: [{
            type: 'final_report_contract',
            severity: 'error',
            message: 'missing required final report evidence',
            recoveryKind: 'complete_report_content',
            missingSections: [{id: 'measured_evidence', label: 'Measured evidence'}],
          }],
          llmIssues: [],
          durationMs: 1,
        })
        .mockResolvedValueOnce({
          passed: true,
          heuristicIssues: [],
          llmIssues: [],
          durationMs: 1,
        });

      const result = await runtime.analyze(
        '分析 UI 卡顿并补齐报告',
        'session-provider-correction',
        'trace-provider-correction',
        {
          analysisMode: 'full',
          packageName: 'com.example.app',
        },
      );

      expect(result.success).toBe(true);
      const calls = claudeSdkMock.__getQueryCalls();
      expect(calls).toHaveLength(2);
      expect(result.completion).toMatchObject({status: 'completed',
        attemptId: expect.stringContaining(':correction:1'),
        conclusionFingerprint: analysisDeliveryFingerprint(result.conclusion)});
      const correctionCall = calls[1];
      expect(correctionCall.options.model).toBe('provider-claude-correction-main');
      expect(correctionCall.options.pathToClaudeCodeExecutable).toBe('/tmp/global-correction-claude');
      expect(correctionCall.options.env.CLAUDE_MODEL).toBe('provider-claude-correction-main');
      expect(correctionCall.options.env.CLAUDE_LIGHT_MODEL).toBe('provider-claude-correction-light');
      expect(correctionCall.options.env.ANTHROPIC_BASE_URL).toBe('https://provider-correction.example/v1');
      expect(correctionCall.options.env.ANTHROPIC_API_KEY).toBe('sk-provider-correction');
      expect(process.env.ANTHROPIC_BASE_URL).toBe('https://global-correction.example/v1');
      expect(process.env.ANTHROPIC_API_KEY).toBe('sk-global-correction');
      expect(process.env.CLAUDE_MODEL).toBe('global-claude-main');
      expect(process.env.CLAUDE_LIGHT_MODEL).toBe('global-claude-light');
      expect(process.env.CLAUDE_BINARY_PATH).toBe('/tmp/global-correction-claude');
    } finally {
      restoreEnvValue('ANTHROPIC_BASE_URL', original.anthropicBaseUrl);
      restoreEnvValue('ANTHROPIC_API_KEY', original.anthropicApiKey);
      restoreEnvValue('CLAUDE_MODEL', original.claudeModel);
      restoreEnvValue('CLAUDE_LIGHT_MODEL', original.claudeLightModel);
      restoreEnvValue('CLAUDE_BINARY_PATH', original.claudeBinaryPath);
    }
  });

  it.each([
    {name: 'partial assistant', message: {type: 'assistant', message: {content: [{type: 'text', text: 'draft'}]}}},
    {name: 'partial model stream', message: {type: 'stream_event', event: {type: 'message_start', message: {id: 'partial-model'}}}},
    {name: 'tool dispatch', message: {type: 'assistant', message: {content: [{type: 'tool_use', id: 'tool-started', name: 'mcp__smartperfetto__execute_sql', input: {sql: 'SELECT 1'}}]}}},
    {name: 'tool progress', message: {type: 'tool_progress', tool_use_id: 'tool-started', elapsed_time_seconds: 1}},
  ])('does not reset the quick turn budget by retrying after $name', async ({message}) => {
    intentDecision = {...defaultIntent, taskKind: 'fact', scope: 'bounded_question', deliverable: 'answer'};
    const previousMaxTurns = process.env.CLAUDE_QUICK_MAX_TURNS;
    process.env.CLAUDE_QUICK_MAX_TURNS = '1';
    const runtime = new ClaudeRuntime({query: async () => ({columns: [], rows: []}), getTrace: () => undefined} as any,
      {enableSubAgents: false});
    let attempts = 0;
    claudeSdkMock.__setQueryImplementation(async function* () {
      attempts++;
      yield message;
      throw Object.assign(new Error('Native transport failure'), {status: 503, code: 'ECONNRESET'});
    });
    try {
      const result = await runtime.analyze('A scoped fact', 'retry-after-work', 'trace', {analysisMode: 'fast'});
      expect(attempts).toBe(1);
      expect(claudeSdkMock.__getQueryCalls()).toHaveLength(1);
      expect(result).toMatchObject({success: false, rounds: 1,
        completion: {status: 'failed', reason: 'provider_error'}});
    } finally {
      restoreEnvValue('CLAUDE_QUICK_MAX_TURNS', previousMaxTurns);
      sessionContextManager.remove('retry-after-work');
    }
  });

  it.each(['fast', 'full'] as const)('retries a pre-work provider failure without resetting the %s work budget or preflight', async analysisMode => {
    const sessionId = 'session-claude-provider-retry-phases';
    const traceId = 'trace-claude-provider-retry-phases';
    const referenceTraceId = 'trace-claude-provider-retry-reference';
    const traceProcessor = {
      query: jest.fn(async () => ({ columns: [], rows: [], durationMs: 1 })),
      getTrace: jest.fn(() => ({
        id: traceId,
        filename: 'trace.pftrace',
        size: 1,
        uploadTime: new Date(),
        status: 'ready',
        traceOs: 'android',
        traceFormat: 'perfetto_protobuf',
      })),
    };
    const runtime = new ClaudeRuntime(traceProcessor as any, {
      enableVerification: false,
      enableSubAgents: false,
    });
    const focusSpy = jest.spyOn(focusAppDetector, 'detectFocusApps')
      .mockResolvedValue({
        apps: [{ packageName: 'com.example.app', processName: 'com.example.app', score: 1 }],
        primaryApp: 'com.example.app',
        method: 'process_track',
      } as any);
    const architectureSpy = jest.spyOn(architectureDetector, 'createArchitectureDetector')
      .mockReturnValue({
        detect: jest.fn(async () => ({ type: 'STANDARD', confidence: 0.9, evidence: [] })),
      } as any);
    const completenessSpy = jest.spyOn(traceCompletenessProber, 'probeTraceCompleteness')
      .mockResolvedValue(undefined as any);
    const registrySpy = jest.spyOn(skillLoader, 'ensureSkillRegistryInitialized')
      .mockResolvedValue(undefined);
    const knowledgeSpy = jest.spyOn(sqlKnowledgeBase, 'getExtendedKnowledgeBase')
      .mockResolvedValue({ getContextForAI: () => 'SQL knowledge retry context' } as any);
    const comparisonSpy = jest.spyOn(runtimePromptContext, 'buildRuntimeTracePairComparisonContext')
      .mockResolvedValue({
        currentPackageName: 'com.example.app',
        referencePackageName: 'com.example.reference',
        commonCapabilities: [],
        capabilityDiff: { currentOnly: [], referenceOnly: [] },
      } as any);
    let providerAttempts = 0;
    claudeSdkMock.__setQueryImplementation(async function* () {
      providerAttempts += 1;
      if (providerAttempts === 1) {
        yield {type: 'system', subtype: 'init', session_id: 'sdk-prework-init'};
        throw Object.assign(new Error('Provider temporarily unavailable'), {status: 503});
      }
      yield {
        type: 'result',
        subtype: 'success',
        session_id: 'sdk-provider-retry-phases',
        num_turns: 1,
        result: '## 综合结论\nClaude provider retry recovered.\n\n## 证据\n- Retry path preserved preflight receipt phases.',
      };
    });
    const runtimePerformanceRecorder = createRuntimePerformanceRecorder();

    try {
      const result = await withEffectiveRuntimeRegistrySnapshot(
        createEffectiveRuntimeRegistrySnapshot(),
        () => runtime.analyze(
          '对比两条 trace 的启动差异',
          sessionId,
          traceId,
          {
            analysisMode,
            packageName: 'com.example.app',
            referenceTraceId,
            runManifestAttributionSink: createNoopAttributionSink(runtimePerformanceRecorder),
          },
        ),
      );
      expect(result).toMatchObject({success: true, rounds: 2});
      if (analysisMode === 'fast') {
        expect(result.quickRun).toMatchObject({actualTurns: 2, enforcement: 'turn_cap'});
      }

      expect(providerAttempts).toBe(3);
      expect(claudeSdkMock.__getQueryCalls()).toHaveLength(3);
      expect(focusSpy).toHaveBeenCalledTimes(1);
      expect(architectureSpy).toHaveBeenCalledTimes(1);
      expect(completenessSpy).toHaveBeenCalledTimes(1);
      expect(registrySpy).toHaveBeenCalledTimes(1);
      expect(knowledgeSpy).toHaveBeenCalledTimes(1);
      expect(comparisonSpy).toHaveBeenCalledTimes(1);

      const phases = runtimePerformanceRecorder.seal().phases;
      for (const phaseName of [
        'classification',
        'focus',
        'architecture',
        'completeness',
        'comparison',
        'skill_registry',
        'knowledge',
        'sdk_start',
        'finalization',
      ]) {
        expect(phases.filter(phase => phase.name === phaseName)).toHaveLength(1);
      }
      expect(phases.filter(phase => phase.name === 'provider')).toEqual([
        expect.objectContaining({ name: 'provider', outcome: 'error' }),
        expect.objectContaining({ name: 'provider', outcome: 'ok' }),
        expect.objectContaining({ name: 'provider', outcome: 'ok' }),
      ]);
      expect(phases).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'classification', outcome: 'ok' }),
        expect.objectContaining({ name: 'focus', outcome: 'ok' }),
        expect.objectContaining({ name: 'architecture', outcome: 'ok' }),
        expect.objectContaining({ name: 'completeness', outcome: 'ok' }),
        expect.objectContaining({ name: 'comparison', outcome: 'ok' }),
        expect.objectContaining({ name: 'skill_registry', outcome: 'ok' }),
        expect.objectContaining({ name: 'knowledge', outcome: 'ok' }),
        expect.objectContaining({ name: 'finalization', outcome: 'ok' }),
      ]));
    } finally {
      focusSpy.mockRestore();
      architectureSpy.mockRestore();
      completenessSpy.mockRestore();
      registrySpy.mockRestore();
      knowledgeSpy.mockRestore();
      comparisonSpy.mockRestore();
      sessionContextManager.remove(sessionId);
    }
  });
});
