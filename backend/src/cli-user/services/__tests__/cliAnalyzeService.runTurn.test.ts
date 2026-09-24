// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { AnalysisResult, IOrchestrator } from '../../../agent/core/orchestratorTypes';
import type { StreamingUpdate } from '../../../agent/types';
import { createDataEnvelope } from '../../../types/dataContract';
import { CliAnalyzeService } from '../cliAnalyzeService';
import type {FinalizeAnalysisResultInput, FinalizedAnalysisResult} from '../../../services/finalizeAnalysisResult';
import * as finalizationContexts from '../../../agentRuntime/analysisFinalizationContext';
import type {RuntimeFinalizationContextInput} from '../../../agentRuntime/analysisFinalizationContext';
import {buildStrategyRegistrySnapshotFromDefinitions} from '../../../agentv3/strategyLoader';
import {analysisDeliveryFingerprint} from '../../../types/analysisDelivery';
import {createAnalysisHistoryReader, resolveAnalysisHistoryReader, toAnalysisHistoryTurn, type AnalysisHistoryReader} from '../../../agentRuntime/analysisHistory';
import {AnalysisHistoryStore} from '../../../services/analysisHistoryStore';
import {privateAnalysisQueryMessage} from '../../../services/security/privateAnalysisProjection';
import {parseOutputLanguage} from '../../../agentv3/outputLanguage';

const mockAnalyze = jest.fn<IOrchestrator['analyze']>();
const mockPersistAgentTurn = jest.fn();
const mockPersistAnalysisRunState = jest.fn();
const mockGenerateAgentDrivenHTML = jest.fn<(data: unknown) => string>(() => '<html></html>');
const mockAnnotateLatestCompletedTurn = jest.fn();
const mockFinalizeAnalysisResult = jest.fn<(input: FinalizeAnalysisResultInput) => Promise<FinalizedAnalysisResult>>();
const mockTraceSummary = jest.fn(async () => {throw new Error('summary unavailable');});
const mockSecurityCleanups: Array<(sessionId: string) => void> = [];
const mockCodebaseGet = jest.fn();
const mockKnowledgeSourceGet = jest.fn();
const mockPrepareSession = jest.fn();
const mockRunManifestLifecycles: any[] = [];
let mockLeaseGroupActive = false;
const mockReleaseTraceLeases = jest.fn();
const mockPrepareTraceLeases = jest.fn<(...args: any[]) => any>();
jest.mock('../../../services/analysisRunTraceProcessorLease', () => ({
  prepareAnalysisRunTraceProcessorLeases: (...args: unknown[]) => mockPrepareTraceLeases(...args),
}));
const capabilityManifest = {
  schemaVersion: 'capability_manifest_attribution@1',
  resolution: {
    status: 'ready',
    manifestId: `capability_manifest:${'a'.repeat(64)}`,
    contentHash: 'a'.repeat(64),
    manifestSchemaVersion: 'capability_manifest@1',
    traceFingerprintSha256: 'b'.repeat(64),
    traceProcessor: {source: 'bundled', gitRevision: 'd'.repeat(40)},
  },
  probeCache: {hits: 1, misses: 1, bypasses: 0},
} as const;

let mockPreparedSession: any;

jest.mock('../../../assistant/application/agentAnalyzeSessionService', () => ({
  AgentAnalyzeSessionService: jest.fn((options: {onSessionSecurityCleanup: (sessionId: string) => void}) => {
    mockSecurityCleanups.push(options.onSessionSecurityCleanup);
    return {prepareSession: (...args: unknown[]) => mockPrepareSession(...args)};
  }),
  buildAgentQueryWithContinuityNotice: (query: string) => query,
}));

function defaultPreparedSessionResult() {
  return {
      sessionId: 'cli-session-quality',
      session: mockPreparedSession,
      isNewSession: true,
  };
}

jest.mock('../../../services/sessionPersistenceService', () => ({
  SessionPersistenceService: {
    getInstance: jest.fn(() => ({})),
  },
}));

jest.mock('../../../services/persistAgentSession', () => ({
  persistAgentTurn: (...args: unknown[]) => mockPersistAgentTurn(...args),
}));

jest.mock('../../../services/analysisRunStore', () => ({
  persistAnalysisRunState: (...args: unknown[]) => mockPersistAnalysisRunState(...args),
}));

jest.mock('../../../services/htmlReportGenerator', () => ({
  getHTMLReportGenerator: () => ({
    generateAgentDrivenHTML: (data: unknown) => mockGenerateAgentDrivenHTML(data),
  }),
}));

jest.mock('../../../services/traceProcessorService', () => ({
  getTraceProcessorService: () => ({
    getTrace: jest.fn(() => undefined),
    cleanup: jest.fn(),
  }),
}));

jest.mock('../../../services/finalizeAnalysisResult', () => ({
  finalizeAnalysisResult: (input: FinalizeAnalysisResultInput) => mockFinalizeAnalysisResult(input),
}));

jest.mock('../../../services/managedTraceSummary', () => ({
  executeManagedTraceSummaryV1: () => mockTraceSummary(),
}));

jest.mock('../../../services/codebase/defaultCodebaseServices', () => ({
  getDefaultCodebaseRegistry: () => ({get: mockCodebaseGet}),
}));

jest.mock('../../../services/externalKnowledgeSourceRegistry', () => ({
  externalKnowledgeSourceHasActiveIndex: (source: {
    activeGeneration?: string;
    contentFingerprint?: string;
    indexedChunkCount?: number;
  }) => Boolean(
    source.activeGeneration && source.contentFingerprint && (source.indexedChunkCount ?? 0) > 0
  ),
  getDefaultExternalKnowledgeSourceRegistry: () => ({get: mockKnowledgeSourceGet}),
}));

jest.mock('../../../agent/context/enhancedSessionContext', () => ({
  sessionContextManager: {
    set: jest.fn(),
    remove: jest.fn(),
    get: jest.fn(() => ({
      annotateLatestCompletedTurn: mockAnnotateLatestCompletedTurn,
    })),
  },
}));

jest.mock('../../../agentRuntime/runtimeSelection', () => ({
  resolveAgentRuntimeSelection: jest.fn(() => ({ kind: 'openai-agents-sdk' })),
}));

jest.mock('../../../services/skillPacks/workspaceSkillRegistryProvider', () => ({
  getWorkspaceSkillRegistry: jest.fn(async () => ({registry: {}})),
}));

jest.mock('../../../services/selfEvolution/effectiveRuntimeRegistryProvider', () => ({
  getEffectiveRuntimeRegistrySnapshot: jest.fn(async ({scope}: any) => ({
    scope: {
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
    },
    overlayGeneration: 'builtin:registry-test',
    skillRegistry: {},
    strategyRegistry: {},
  })),
}));

jest.mock('../../../services/selfEvolution/skillFingerprint', () => ({
  buildSkillRegistryAttribution: jest.fn(() => ({
    registryFingerprint: 'registry-test',
    evolutionOverlayGeneration: 'builtin:registry-test',
    skills: [],
  })),
}));

jest.mock('../../../services/selfEvolution/runManifestLifecycle', () => ({
  createRunManifestLifecycle: jest.fn((input: any) => {
    const lifecycle: any = {
      state: 'collecting',
      builder: {
        identity: {
          runId: input.runId,
          sessionId: input.sessionId,
          scope: input.scope,
        },
      },
      sealOnceAndPersist: jest.fn(() => {
        lifecycle.state = 'persisted';
        return {
          runManifestId: 'manifest-cli-test',
          runId: input.runId,
          capabilityManifest,
        };
      }),
      dispose: jest.fn(() => {
        lifecycle.state = 'disposed';
      }),
    };
    mockRunManifestLifecycles.push(lifecycle);
    return lifecycle;
  }),
  withRunManifestLifecycle: (_lifecycle: unknown, callback: () => unknown) => callback(),
  currentRunManifestAttributionSink: () => undefined,
}));

const cliTurnBinding = {
  turn: 1,
  resolveCliTurnPath: (_sessionId: string, turn: number) => `/tmp/turns/${String(turn).padStart(3, '0')}.md`,
};

function makeSession(orchestrator: EventEmitter): any {
  return {
    sessionId: 'cli-session-quality',
    traceId: 'trace-cli',
    query: '分析启动慢',
    providerId: null,
    runtimeKind: 'openai-agents-sdk',
    providerSnapshotHash: null,
    orchestrator,
    hypotheses: [],
    agentDialogue: [],
    dataEnvelopes: [],
    claimSupport: [],
    identityResolutions: [],
    agentResponses: [],
    conversationSteps: [],
    runSequence: 0,
    queryHistory: [],
    conclusionHistory: [],
  };
}

const finalizationRegistry = buildStrategyRegistrySnapshotFromDefinitions({definitions: [], overlayGeneration: 'cli-finalization-test'});

function attachCliContext(result: AnalysisResult, runId: string,
  intent: Partial<RuntimeFinalizationContextInput['turnIntent']> = {}) {
  const candidate = {runId, attemptId: 'attempt', candidateRef: 'candidate', conclusionFingerprint: analysisDeliveryFingerprint(result.conclusion)};
  finalizationContexts.attachFinalizationContext(result, {runId, sessionId: result.sessionId, deadlineMs: Date.now() + 10_000,
    strategyRegistry: finalizationRegistry, traceIdentity: {currentTraceId: 'trace-cli'},
    turnIntent: {schemaVersion: 1, status: 'resolved', source: 'semantic', registryFingerprint: finalizationRegistry.registryFingerprint,
      taskKind: 'fact', sceneId: 'general', scope: 'bounded_question', recommendedComplexity: 'quick', deliverable: 'answer',
      evidenceAccess: 'existing_only', ...intent},
    deliveryContext: {entry: 'runtime_draft', acceptedCandidate: candidate, outputOrigin: 'sdk_final',
      completion: {...candidate, schemaVersion: 1, status: 'completed', runtimeKind: 'openai-agents-sdk'}}});
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(settle => {resolve = settle;});
  return {promise, resolve};
}

describe('CliAnalyzeService runTurn final quality gate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLeaseGroupActive = false;
    mockPrepareTraceLeases.mockReset();
    mockPrepareTraceLeases.mockImplementation(async () => ({entries: [], assertCurrent: jest.fn(),
      release: mockReleaseTraceLeases, run: async (fn: () => Promise<unknown>) => {
        mockLeaseGroupActive = true;
        try {return await fn();} finally {mockLeaseGroupActive = false;}
      }}));
    mockRunManifestLifecycles.length = 0;
    mockSecurityCleanups.length = 0;
    mockFinalizeAnalysisResult.mockReset();
    mockFinalizeAnalysisResult.mockImplementation(async input => {
      try {
        input.owner.signal.throwIfAborted();
        input.owner.assertAuthorized();
        return {result: input.result};
      } finally {input.context?.dispose();}
    });
    mockCodebaseGet.mockReset();
    mockKnowledgeSourceGet.mockReset();
    mockPrepareSession.mockImplementation(() => defaultPreparedSessionResult());
    const orchestrator = new EventEmitter() as EventEmitter & {
      analyze: typeof mockAnalyze;
      getSdkSessionId: () => string;
    };
    orchestrator.analyze = mockAnalyze;
    orchestrator.getSdkSessionId = () => 'sdk-cli-session-quality';
    mockPreparedSession = makeSession(orchestrator);
    mockAnalyze.mockReset();
    mockAnalyze.mockResolvedValue({
      sessionId: 'cli-session-quality',
      success: true,
      findings: [],
      hypotheses: [],
      conclusion: [
        '## 综合结论',
        '',
        '完成综合结论输出。',
        '',
        '## 分阶段证据摘要',
        '',
        '- 启动概览采集: 获取启动概览。',
      ].join('\n'),
      confidence: 0.92,
      rounds: 1,
      totalDurationMs: 1000,
    });
  });

  it('opens the run parent before the finalized turn is archived, then closes it', async () => {
    await new CliAnalyzeService().runTurn({...cliTurnBinding, traceId: 'trace-cli',
      query: 'Analyze startup', onEvent: jest.fn()});
    // `persistAgentTurn` writes finalized history, which fails closed unless an
    // owner-authorized run parent already exists. Ownership and identity must
    // match exactly, and the open must precede the archive write.
    const archived = mockPersistAgentTurn.mock.calls[0][0] as {sessionId: string; traceId: string; session: Record<string, string>};
    const [openScope, openStatus] = mockPersistAnalysisRunState.mock.calls[0] as [Record<string, string>, string];
    expect(openStatus).toBe('running');
    expect(openScope).toMatchObject({sessionId: archived.sessionId, traceId: archived.traceId,
      tenantId: archived.session.tenantId, workspaceId: archived.session.workspaceId, userId: archived.session.userId});
    expect(mockPersistAnalysisRunState.mock.invocationCallOrder[0])
      .toBeLessThan(mockPersistAgentTurn.mock.invocationCallOrder[0]);
    expect(mockPersistAnalysisRunState.mock.calls[1]).toEqual([openScope, 'completed', {error: undefined}]);
  });

  it('leaves no durable run row when the analysis never reaches the archive', async () => {
    // An open `running` row blocks trace deletion and holds a quota slot, and
    // nothing reconciles a CLI-owned row. A turn that fails before archiving
    // must therefore leave the run graph exactly as it found it.
    mockAnalyze.mockRejectedValueOnce(new Error('runtime unavailable'));
    await expect(new CliAnalyzeService().runTurn({...cliTurnBinding, traceId: 'trace-cli',
      query: 'Analyze startup', onEvent: jest.fn()})).rejects.toThrow('runtime unavailable');
    expect(mockPersistAnalysisRunState).not.toHaveBeenCalled();
  });

  it('supplies CLI history separately from the question and filters dormant source turns on reads', async () => {
    const stored = jest.spyOn(AnalysisHistoryStore.prototype, 'list').mockReturnValue([]);
    const originalAnalyze = mockAnalyze.getMockImplementation()!;
    const publicTurn = toAnalysisHistoryTurn({id: 'old-public-run', turnIndex: 0, query: 'Earlier question',
      traceId: 'old-trace', timestamp: 1, result: {conclusion: 'Limited answer', partial: true,
        terminationReason: 'max_turns', conclusionContract: {uncertainties: ['Cause unknown'], nextSteps: ['Read blocker']}}});
    const sourceTurn = {...publicTurn, id: 'old-source-run', turnIndex: 1, sourceDerived: true,
      query: 'PRIVATE_HISTORY_QUERY', answer: 'PRIVATE_HISTORY_ANSWER'};
    let capturedReader: AnalysisHistoryReader | undefined;
    mockAnalyze.mockImplementation(async (...args) => {
      expect(args[0]).toBe('Continue with the blocker');
      capturedReader = resolveAnalysisHistoryReader(args[3] ?? {}, createAnalysisHistoryReader({
        getTurns: () => [], assertActive: () => {},
      }));
      expect(capturedReader.getTurns()).toEqual([publicTurn]);
      expect(capturedReader.read({turnId: sourceTurn.id})).toMatchObject({success: false});
      return originalAnalyze(...args);
    });
    try {
      await new CliAnalyzeService().runTurn({...cliTurnBinding, traceId: 'trace-cli',
        query: 'Continue with the blocker', history: [publicTurn, sourceTurn], onEvent: jest.fn()});
      expect(() => capturedReader?.getTurns()).toThrow();
    } finally { stored.mockRestore(); }
  });

  it('owns one Trace lease group through runtime and finalization, then releases it', async () => {
    mockAnalyze.mockImplementationOnce(async () => {
      expect(mockLeaseGroupActive).toBe(true);
      return {sessionId: 'cli-session-quality', success: true, findings: [], hypotheses: [],
        conclusion: 'A scoped answer.', confidence: 0.8, rounds: 1, totalDurationMs: 1};
    });
    mockFinalizeAnalysisResult.mockImplementationOnce(async input => {
      expect(mockLeaseGroupActive).toBe(true);
      return {result: input.result};
    });
    await new CliAnalyzeService().runTurn({...cliTurnBinding, traceId: 'trace-cli', referenceTraceId: 'reference-cli',
      query: 'Read the captured data', onEvent: jest.fn()});
    expect(mockPrepareTraceLeases).toHaveBeenCalledTimes(1);
    expect(mockPrepareTraceLeases).toHaveBeenCalledWith(expect.objectContaining({currentTraceId: 'trace-cli',
      referenceTraceId: 'reference-cli', runId: expect.any(String), sessionId: 'cli-session-quality', signal: expect.any(AbortSignal)}));
    expect(mockReleaseTraceLeases).toHaveBeenCalledTimes(1);
    expect(mockLeaseGroupActive).toBe(false);
  });

  it('releases the run lease group when the runtime fails', async () => {
    mockAnalyze.mockRejectedValueOnce(new Error('synthetic runtime failure'));
    await expect(new CliAnalyzeService().runTurn({...cliTurnBinding, traceId: 'trace-cli',
      query: 'A bounded query', onEvent: jest.fn()})).rejects.toThrow('synthetic runtime failure');
    expect(mockReleaseTraceLeases).toHaveBeenCalledTimes(1);
    expect(mockFinalizeAnalysisResult).not.toHaveBeenCalled();
  });

  it('defaults codebase-only CLI analysis to private metadata mode', async () => {
    mockCodebaseGet.mockReturnValue({
      codebaseId: 'cb-cli',
      lifecycleState: 'active',
      rootRealpath: fs.realpathSync(process.cwd()),
      indexGeneration: 3,
      activeGeneration: 'codebase_3_test',
      contentFingerprint: 'a'.repeat(64),
      chunkCount: 1,
      consent: {sendToProvider: false, consentHash: 'consent'},
    });
    mockAnalyze.mockImplementationOnce(async () => {
      mockPreparedSession.orchestrator.emit('update', {
        type: 'finding',
        content: {message: 'Source location found; implementation has not been read.'},
        timestamp: Date.now(),
      } satisfies StreamingUpdate);
      return {
        sessionId: 'cli-session-quality',
        success: true,
        findings: [],
        hypotheses: [],
        conclusion: '## 综合结论\n\n已完成。',
        confidence: 0.9,
        rounds: 1,
        totalDurationMs: 1,
      };
    });
    const events: StreamingUpdate[] = [];

    const output = await new CliAnalyzeService().runTurn({
      ...cliTurnBinding,
      traceId: 'trace-cli',
      query: '分析源码',
      codebaseIds: ['cb-cli'],
      onEvent: event => events.push(event),
    });

    const analyzeCall = mockAnalyze.mock.calls[0] as unknown[];
    expect(analyzeCall[3]).toEqual(expect.objectContaining({
      codeAwareMode: 'metadata_only',
      codebaseIds: ['cb-cli'],
    }));
    expect(mockPreparedSession.codeAwareMode).toBe('metadata_only');
    expect(mockPrepareSession).toHaveBeenCalledWith(expect.objectContaining({
      options: expect.objectContaining({
        codeAwareMode: 'metadata_only',
        codebaseIds: ['cb-cli'],
      }),
    }));
    expect(output.codeAwareMode).toBe('metadata_only');
    // The run row is durable enterprise state; a private-knowledge question is
    // recorded as the projected message, never the user's own query.
    const [runScope] = mockPersistAnalysisRunState.mock.calls[0] as [{query?: string}];
    expect(runScope.query).toBe(privateAnalysisQueryMessage(
      parseOutputLanguage(process.env.SMARTPERFETTO_OUTPUT_LANGUAGE)));
    expect(output.result.analysisReceipt?.outputs.cliTurnPath).toBeUndefined();
    expect(events).toContainEqual(expect.objectContaining({
      type: 'finding', content: {message: 'Source location found; implementation has not been read.'},
    }));
  });

  it.each([
    ['source only', ['cb-cli'], undefined],
    ['RAG only', undefined, ['wiki-cli']],
    ['source and RAG', ['cb-cli'], ['wiki-cli']],
  ] as const)('preserves %s authorization across ordinary, explicit, and deep wording', async (
    _label,
    codebaseIds,
    knowledgeSourceIds,
  ) => {
    mockCodebaseGet.mockReturnValue({
      codebaseId: 'cb-cli',
      lifecycleState: 'active',
      rootRealpath: fs.realpathSync(process.cwd()),
      indexGeneration: 3,
      activeGeneration: 'codebase_3_test',
      contentFingerprint: 'a'.repeat(64),
      chunkCount: 1,
      consent: {sendToProvider: false, consentHash: 'consent'},
    });
    mockKnowledgeSourceGet.mockReturnValue({
      sourceId: 'wiki-cli',
      indexGeneration: 2,
      activeGeneration: 'knowledge_2_test',
      contentFingerprint: 'b'.repeat(64),
      indexedChunkCount: 1,
      rightsAcknowledged: true,
      sendToProvider: true,
      consentedAt: Date.now(),
    });

    const service = new CliAnalyzeService();
    for (const query of ['为什么启动慢？', '定位源码 Foo::bar', '完整审查整个源码']) {
      const output = await service.runTurn({
        ...cliTurnBinding, traceId: 'trace-cli', query, analysisMode: 'full',
        ...(codebaseIds ? {codebaseIds: [...codebaseIds]} : {}),
        ...(knowledgeSourceIds ? {knowledgeSourceIds: [...knowledgeSourceIds]} : {}),
        onEvent: jest.fn(),
      });
      const expectedOptions = {
        codeAwareMode: codebaseIds ? 'metadata_only' : 'off',
        ...(codebaseIds ? {codebaseIds: ['cb-cli']} : {}),
        ...(knowledgeSourceIds ? {knowledgeSourceIds: ['wiki-cli']} : {}),
      };
      expect(mockPrepareSession).toHaveBeenLastCalledWith(expect.objectContaining({
        query, options: expect.objectContaining(expectedOptions),
      }));
      expect(mockAnalyze).toHaveBeenLastCalledWith(expect.any(String), expect.any(String), 'trace-cli',
        expect.objectContaining({...expectedOptions, analysisContextFingerprint: mockPreparedSession.analysisContextFingerprint}));
      const runtimeOptions = mockAnalyze.mock.calls[mockAnalyze.mock.calls.length - 1][3];
      expect(runtimeOptions?.sourceUsePolicy).toBeUndefined();
      expect(output.privateKnowledge).toBe(true);
      expect(output.sourceSupplementTask).toBeUndefined();
    }
    expect(mockAnalyze).toHaveBeenCalledTimes(3);
  });

  it('rejects codebase ids when code-aware mode is explicitly off', async () => {
    await expect(new CliAnalyzeService().runTurn({
      ...cliTurnBinding,
      traceId: 'trace-cli',
      query: 'do not use source',
      codeAwareMode: 'off',
      codebaseIds: ['cb-disabled'],
      onEvent: jest.fn(),
    })).rejects.toThrow('CODEBASE_IDS_REQUIRE_CODE_AWARE_MODE');
    expect(mockAnalyze).not.toHaveBeenCalled();
  });

  it('allows a selected codebase without an index when its registered root is available', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-on-demand-source-'));
    const rootRealpath = fs.realpathSync(root);
    try {
      mockCodebaseGet.mockReturnValue({
        codebaseId: 'cb-unindexed',
        lifecycleState: 'active',
        rootRealpath,
        indexGeneration: 1,
        chunkCount: 0,
        consent: {sendToProvider: false, consentHash: 'consent'},
      });

      await expect(new CliAnalyzeService().runTurn({
        ...cliTurnBinding,
        traceId: 'trace-cli',
        query: 'analyze source',
        codebaseIds: ['cb-unindexed'],
        onEvent: jest.fn(),
      })).resolves.toEqual(expect.objectContaining({
        result: expect.objectContaining({success: true}),
      }));
      expect(mockAnalyze).toHaveBeenCalled();
    } finally {
      fs.rmSync(root, {recursive: true, force: true});
    }
  });

  it('rejects a selected codebase whose registered root is unavailable', async () => {
    mockCodebaseGet.mockReturnValue({
      codebaseId: 'cb-missing-root',
      lifecycleState: 'active',
      rootRealpath: '/definitely/missing/smartperfetto/source',
      indexGeneration: 1,
      chunkCount: 0,
      consent: {sendToProvider: false, consentHash: 'consent'},
    });

    await expect(new CliAnalyzeService().runTurn({
      ...cliTurnBinding,
      traceId: 'trace-cli',
      query: 'analyze source',
      codebaseIds: ['cb-missing-root'],
      onEvent: jest.fn(),
    })).rejects.toThrow('ANALYSIS_CONTEXT_CODEBASE_ROOT_UNAVAILABLE');
    expect(mockAnalyze).not.toHaveBeenCalled();
  });

  it('rejects an activated knowledge source whose generation contains no chunks', async () => {
    mockKnowledgeSourceGet.mockReturnValue({
      sourceId: 'wiki-empty',
      indexGeneration: 2,
      activeGeneration: 'knowledge_2_empty',
      contentFingerprint: 'b'.repeat(64),
      indexedChunkCount: 0,
      rightsAcknowledged: true,
      sendToProvider: true,
    });

    await expect(new CliAnalyzeService().runTurn({
      ...cliTurnBinding,
      traceId: 'trace-cli',
      query: 'analyze with private knowledge',
      knowledgeSourceIds: ['wiki-empty'],
      onEvent: jest.fn(),
    })).rejects.toThrow('未激活');
    expect(mockAnalyze).not.toHaveBeenCalled();
  });

  it('streams the final review start and finish to the CLI after the runtime handler detached', async () => {
    const deadlineAt = Date.now() + 5 * 60_000;
    mockFinalizeAnalysisResult.mockImplementationOnce(async input => {
      input.onProgress?.({stage: 'final_review_started', deadlineAt});
      input.onProgress?.({stage: 'final_review_finished', status: 'unavailable', reason: 'timeout'});
      return {result: input.result};
    });
    const events: StreamingUpdate[] = [];
    await new CliAnalyzeService().runTurn({...cliTurnBinding, traceId: 'trace-cli', query: '分析启动慢',
      onEvent: update => events.push(update)});
    const reviews = events.filter(event => event.type === 'progress' && (event.content as any)?.phase === 'final_review');
    expect(reviews.map(event => event.content)).toEqual([
      expect.objectContaining({stage: 'started', deadlineAt, message: expect.stringContaining('分钟')}),
      expect.objectContaining({stage: 'finished', outcome: 'unavailable', reason: 'timeout',
        message: '结论复核未完成：语义复核超出时间预算'}),
    ]);
  });

  it('preserves the shared finalizer partial verdict across CLI result, session, report, and events', async () => {
    mockFinalizeAnalysisResult.mockImplementationOnce(async input => ({
      result: {...input.result, partial: true, confidence: 0.55, terminationMessage: '最终结果质量闸门',
        claimVerificationResult: {schemaVersion: 'claim_verifier@2', policy: 'record_only', status: 'failed', passed: false,
          checkedClaimCount: 1, unsupportedClaimCount: 1,
          claimResults: [{claimId: 'claim-cli-contradiction', status: 'unsupported',
            referenceCells: [{evidenceRefId: 'data:cli', column: 'blocked_ms', status: 'value_mismatch'}],
            deterministicProof: {kind: 'numeric_cell', status: 'rejected', reason: 'numeric_operator_rejected',
              anchorIds: ['anchor-cli'], evidenceRefIds: ['data:cli']},
            propositionCoverage: {status: 'none', covered: [], uncovered: ['numeric_cell'], reason: 'numeric_operator_rejected'}}],
          issues: [{claimId: 'claim-cli-contradiction', severity: 'error', code: 'claim_reference_value_mismatch',
            message: 'The claimed value contradicts the captured value.'}]}},
      qualityIssue: {code: 'verifier_contradicted_claim', message: '最终结果质量闸门'},
    }));
    const service = new CliAnalyzeService();
    const events: StreamingUpdate[] = [];

    const output = await service.runTurn({
      ...cliTurnBinding,
      traceId: 'trace-cli',
      query: '分析启动慢',
      onEvent: update => events.push(update),
    });

    expect(output.result.partial).toBe(true);
    expect(output.result.analysisReceipt).toEqual(expect.objectContaining({
      schemaVersion: 2,
      runManifestId: 'manifest-cli-test',
      capabilityManifest,
      outputs: expect.objectContaining({
        cliTurnPath: '/tmp/turns/001.md',
      }),
    }));
    expect(output.result.confidence).toBe(0.55);
    expect(output.result.terminationMessage).toContain('最终结果质量闸门');
    expect(mockPreparedSession.result).toBe(output.result);
    expect(mockPreparedSession.traceSummary).toBeUndefined();
    expect(mockTraceSummary).not.toHaveBeenCalled();
    expect(mockPersistAgentTurn).toHaveBeenCalledWith(expect.objectContaining({
      result: expect.objectContaining({
        conclusion: expect.stringContaining('分阶段证据摘要'),
      }),
    }));
    expect(mockAnnotateLatestCompletedTurn).toHaveBeenCalledWith(expect.objectContaining({
      partial: true,
      confidence: 0.55,
      terminationMessage: expect.stringContaining('最终结果质量闸门'),
    }));
    expect(mockGenerateAgentDrivenHTML).toHaveBeenCalledWith(expect.objectContaining({
      result: expect.objectContaining({
        partial: true,
        terminationMessage: expect.stringContaining('最终结果质量闸门'),
      }),
    }));
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'degraded',
        content: expect.objectContaining({
          fallback: 'final_result_quality_gate',
          code: 'verifier_contradicted_claim',
          partial: true,
        }),
      }),
    ]));
    expect(mockRunManifestLifecycles[0]?.sealOnceAndPersist).toHaveBeenCalledWith({
      turnCount: 1,
    });
  });

  it('persists a zero-turn manifest before rethrowing a runtime failure', async () => {
    mockAnalyze.mockRejectedValueOnce(new Error('cli runtime failure canary'));

    const service = new CliAnalyzeService();
    await expect(service.runTurn({
      ...cliTurnBinding,
      traceId: 'trace-cli',
      query: '分析失败路径',
      onEvent: jest.fn(),
    })).rejects.toThrow('cli runtime failure canary');

    expect(mockRunManifestLifecycles[0]?.sealOnceAndPersist).toHaveBeenCalledWith({
      turnCount: 0,
      closePendingSkillInvocationsAsErrors: true,
    });
    expect(mockRunManifestLifecycles[0]?.dispose).toHaveBeenCalledTimes(1);
  });

  it('surfaces runtime metadata from canonical snapshot engineState', async () => {
    mockPreparedSession.providerId = 'provider-from-session';
    mockPreparedSession.providerSnapshotHash = 'hash-from-session';
    mockPersistAgentTurn.mockImplementationOnce((input: any) => {
      input.session._lastSnapshot = {
        version: 1,
        snapshotTimestamp: Date.now(),
        sessionId: 'cli-session-quality',
        traceId: 'trace-cli',
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
          kind: 'openai-agents-sdk',
          provider: {
            providerId: 'provider-from-engine',
            providerSnapshotHash: 'hash-from-engine',
          },
          openai: {
            lastResponseId: 'resp-cli',
          },
        },
        runSequence: 0,
        conversationOrdinal: 0,
      };
    });

    const service = new CliAnalyzeService();
    const output = await service.runTurn({
      ...cliTurnBinding,
      traceId: 'trace-cli',
      query: '分析启动慢',
      onEvent: jest.fn(),
    });

    expect(output.providerId).toBe('provider-from-engine');
    expect(output.agentRuntimeKind).toBe('openai-agents-sdk');
    expect(output.providerSnapshotHash).toBe('hash-from-engine');
  });

  it('persists the selected OpenAI-compatible model as CLI provenance', async () => {
    const previousModel = process.env.OPENAI_MODEL;
    process.env.OPENAI_MODEL = 'deepseek-provenance-test';
    try {
      const output = await new CliAnalyzeService().runTurn({
        ...cliTurnBinding,
        traceId: 'trace-cli',
        query: '分析启动慢',
        onEvent: jest.fn(),
      });

      expect(output.agentRuntimeKind).toBe('openai-agents-sdk');
      expect(output.model).toBe('deepseek-provenance-test');
    } finally {
      if (previousModel === undefined) delete process.env.OPENAI_MODEL;
      else process.env.OPENAI_MODEL = previousModel;
    }
  });

  it('passes prepared continuity agentQuery to the runtime while preserving the user query for persistence', async () => {
    mockPreparedSession.agentQuery = [
      'System context continuity notice:',
      'The provider SDK conversation context was reset before this turn.',
      '',
      'User query:',
      '分析启动慢',
    ].join('\n');

    const service = new CliAnalyzeService();
    await service.runTurn({
      ...cliTurnBinding,
      traceId: 'trace-cli',
      query: '分析启动慢',
      onEvent: jest.fn(),
    });

    const analyzeCall = mockAnalyze.mock.calls[0] as unknown[];
    expect(analyzeCall[0]).toBe(mockPreparedSession.agentQuery);
    expect(analyzeCall[1]).toBe('cli-session-quality');
    expect(analyzeCall[2]).toBe('trace-cli');
    expect(analyzeCall[3]).toEqual(expect.any(Object));
    expect(mockPersistAgentTurn).toHaveBeenCalledWith(expect.objectContaining({
      query: '分析启动慢',
    }));
  });

  it('attaches CLI degraded lineage to the backend session before persistence', async () => {
    const lineage = {
      previousBackendSessionId: 'backend-before-level3',
      reason: 'cli-level3-degraded' as const,
      at: 1_780_000_000_000,
    };

    const service = new CliAnalyzeService();
    await service.runTurn({
      ...cliTurnBinding,
      traceId: 'trace-cli',
      query: '继续分析',
      lineage,
      onEvent: jest.fn(),
    });

    expect(mockPreparedSession.lineage).toEqual(lineage);
    expect(mockPersistAgentTurn).toHaveBeenCalledWith(expect.objectContaining({
      session: expect.objectContaining({ lineage }),
    }));
  });

  it('keeps CLI-collected observations separate when the model supplied no claims', async () => {
    const envelope = createDataEnvelope({
      columns: ['package', 'startup_type', 'ttid_ms'],
      rows: [['com.example.launch.aosp.heavy', 'cold', 1912]],
    }, {
      type: 'skill_result',
      source: 'startup_analysis',
      title: '启动概览',
      layer: 'overview',
      format: 'table',
      evidenceRefId: 'data:skill:startup_analysis:startup_overview:current:test',
      sourceToolCallId: 'invoke_skill:startup_analysis:test',
      traceId: 'trace-cli',
      traceSide: 'current',
    });
    mockAnalyze.mockImplementationOnce(async () => {
      mockPreparedSession.orchestrator.emit('update', {
        type: 'data',
        content: [envelope],
        timestamp: Date.now(),
      } satisfies StreamingUpdate);
      return {
        sessionId: 'cli-session-quality',
        success: true,
        findings: [],
        hypotheses: [],
        conclusion: '# 启动性能分析报告\n\n## 综合结论\n\ncom.example.launch.aosp.heavy 是冷启动，TTID=1912ms。',
        confidence: 0.9,
        rounds: 1,
        totalDurationMs: 1000,
      };
    });

    const service = new CliAnalyzeService();
    const output = await service.runTurn({
      ...cliTurnBinding,
      traceId: 'trace-cli',
      query: '分析启动慢',
      onEvent: jest.fn(),
    });
    const finalizerInput = mockFinalizeAnalysisResult.mock.calls[0][0];

    expect(output.result.conclusionContract?.metadata?.derivedFromNarrativeEvidenceMatch).not.toBe(true);
    expect(finalizerInput.result.conclusionContract).toBeUndefined();
    expect(finalizerInput.dataEnvelopes).toContain(envelope);
    expect(output.result.conclusionContract).toBeUndefined();
  });

  it('keeps the shared finalizer failed claim result through persistence and report rendering', async () => {
    const claims = [{
      id: 'cli-wrong-ttid', text: 'TTID=9999ms', kind: 'numeric' as const,
      references: [{evidenceRefId: 'data:cli-ttid', rowIndex: 0, column: 'ttid_ms', value: 9999}],
    }];
    mockAnalyze.mockImplementationOnce(async () => {
      mockPreparedSession.orchestrator.emit('update', {
        type: 'data', timestamp: Date.now(),
        content: [createDataEnvelope({columns: ['ttid_ms'], rows: [[1912]]}, {
          type: 'skill_result', source: 'startup_analysis', title: '启动概览',
          evidenceRefId: 'data:cli-ttid', traceId: 'trace-cli', traceSide: 'current',
        })],
      } satisfies StreamingUpdate);
      return {
        sessionId: 'cli-session-quality', success: true, findings: [], hypotheses: [],
        conclusion: 'TTID=9999ms，事件计数1912次。', confidence: 0.9, rounds: 1, totalDurationMs: 1,
        conclusionContract: {
          schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer',
          conclusions: [{rank: 1, statement: 'TTID=9999ms'}], claims,
          clusters: [], evidenceChain: [], uncertainties: [], nextSteps: [],
        },
      };
    });
    mockFinalizeAnalysisResult.mockImplementationOnce(async input => ({result: {...input.result, partial: true,
      claimVerificationResult: {schemaVersion: 'claim_verifier@2', policy: 'record_only', status: 'failed', passed: false,
        checkedClaimCount: 1, unsupportedClaimCount: 1, claimResults: [{claimId: 'cli-wrong-ttid', status: 'unsupported'}], issues: []}}}));

    const output = await new CliAnalyzeService().runTurn({
      ...cliTurnBinding, traceId: 'trace-cli', query: '核对 TTID', onEvent: jest.fn(),
    });
    expect(output.result.conclusionContract?.claims).toEqual(claims);
    expect(output.result.claimVerificationResult).toMatchObject({status: 'failed', passed: false});
    expect(output.result.partial).toBe(true);
    expect(mockPersistAgentTurn).toHaveBeenCalledWith(expect.objectContaining({
      session: expect.objectContaining({
        result: expect.objectContaining({
          conclusionContract: expect.objectContaining({claims}),
          claimVerificationResult: expect.objectContaining({status: 'failed'}),
        }),
      }),
    }));
    expect(mockGenerateAgentDrivenHTML).toHaveBeenCalledWith(expect.objectContaining({
      result: expect.objectContaining({
        conclusionContract: expect.objectContaining({claims}),
        claimVerificationResult: expect.objectContaining({status: 'failed'}),
      }),
    }));
  });
  it('takes context from the exact runtime result and persists the complete final object without rewriting its body', async () => {
    let runtimeResult!: AnalysisResult;
    mockAnalyze.mockImplementationOnce(async (_query, sessionId, _traceId, options) => {
      runtimeResult = {sessionId, success: true, findings: [], hypotheses: [], conclusion: 'original body', confidence: 0.8, rounds: 1, totalDurationMs: 1};
      attachCliContext(runtimeResult, options!.runId!);
      return runtimeResult;
    });
    const body = '  Final body.\r\n\r\n';
    mockFinalizeAnalysisResult.mockImplementationOnce(async input => {
      try {
        expect(input.result).toBe(runtimeResult);
        expect(input.context?.runId).toBe(input.owner.runId);
        expect(finalizationContexts.takeFinalizationContext(runtimeResult)).toBeUndefined();
        return {result: {...input.result, conclusion: body, partial: true,
          claimVerificationResult: {schemaVersion: 'claim_verifier@2', policy: 'record_only', status: 'failed', passed: false,
            checkedClaimCount: 0, unsupportedClaimCount: 0, claimResults: [], issues: []}}};
      } finally {input.context?.dispose();}
    });
    const output = await new CliAnalyzeService().runTurn({...cliTurnBinding, traceId: 'trace-cli', query: 'question', onEvent: jest.fn()});
    expect(mockFinalizeAnalysisResult).toHaveBeenCalledTimes(1);
    expect(mockFinalizeAnalysisResult.mock.calls[0][0].comparisonIdentity).toBeUndefined();
    expect(output.result.conclusion).toBe(body);
    expect(mockPersistAgentTurn.mock.calls[0][0]).toMatchObject({result: {conclusion: body,
      claimVerificationResult: {schemaVersion: 'claim_verifier@2', status: 'failed'}}});
    expect(mockPreparedSession.result).toBe(output.result);
    expect(mockGenerateAgentDrivenHTML).toHaveBeenCalledWith(expect.objectContaining({result: expect.objectContaining({conclusion: body})}));
  });

  it('passes comparison identity only when a reference trace is actually attached', async () => {
    await new CliAnalyzeService().runTurn({...cliTurnBinding, traceId: 'trace-cli', referenceTraceId: 'trace-reference',
      query: 'Compare both traces', onEvent: jest.fn()});
    expect(mockFinalizeAnalysisResult.mock.calls[0][0].comparisonIdentity).toEqual({
      currentTraceId: 'trace-cli', referenceTraceId: 'trace-reference',
    });
    expect(mockAnalyze.mock.calls[0][3]?.referenceTraceId).toBe('trace-reference');
  });

  it.each(['existing_only', 'unavailable', 'bounded', 'allowed'] as const)('bounds post-run trace acquisition using the captured %s intent', async mode => {
    mockAnalyze.mockImplementationOnce(async (_query, sessionId, _traceId, options) => {
      const result: AnalysisResult = {sessionId, success: true, findings: [], hypotheses: [], conclusion: 'body', confidence: 0.8, rounds: 1, totalDurationMs: 1};
      attachCliContext(result, options!.runId!, {status: mode === 'unavailable' ? 'unavailable' : 'resolved',
        scope: mode === 'bounded' ? 'bounded_question' : 'scene_wide', evidenceAccess: mode === 'existing_only' ? 'existing_only' : 'read_new'});
      return result;
    });
    await new CliAnalyzeService().runTurn({...cliTurnBinding, traceId: 'trace-cli', query: 'question', onEvent: jest.fn()});
    expect(mockTraceSummary).toHaveBeenCalledTimes(mode === 'allowed' ? 1 : 0);
  });

  it('rejects a wrong-run context even while the product run token is current and disposes it', async () => {
    const take = finalizationContexts.takeFinalizationContext;
    let taken: ReturnType<typeof take>;
    const spy = jest.spyOn(finalizationContexts, 'takeFinalizationContext').mockImplementation(result => (taken = take(result)));
    try {
      mockAnalyze.mockImplementationOnce(async (_query, sessionId) => {
        const result: AnalysisResult = {sessionId, success: true, findings: [], hypotheses: [], conclusion: 'body', confidence: 0.8, rounds: 1, totalDurationMs: 1};
        attachCliContext(result, 'wrong-runtime-run');
        return result;
      });
      await expect(new CliAnalyzeService().runTurn({...cliTurnBinding, traceId: 'trace-cli', query: 'question', onEvent: jest.fn()}))
        .rejects.toThrow('finalization_run_identity_mismatch');
      expect(mockFinalizeAnalysisResult).not.toHaveBeenCalled();
      expect(mockPersistAgentTurn).not.toHaveBeenCalled();
      expect(() => taken!.runId).toThrow('finalization_context_disposed');
    } finally {spy.mockRestore();}
  });

  it.each(['caller', 'shutdown', 'security_cleanup'] as const)('prevents late finalizer results from committing after %s', async cancellation => {
    const started = deferred<FinalizeAnalysisResultInput>();
    const finish = deferred<FinalizedAnalysisResult>();
    mockFinalizeAnalysisResult.mockImplementationOnce(input => {
      started.resolve(input);
      return finish.promise.finally(() => input.context?.dispose());
    });
    const controller = new AbortController();
    const service = new CliAnalyzeService();
    const pending = service.runTurn({...cliTurnBinding, signal: controller.signal, traceId: 'trace-cli', query: 'question', onEvent: jest.fn()});
    const input = await started.promise;
    if (cancellation === 'caller') controller.abort(new DOMException('cancelled', 'AbortError'));
    else if (cancellation === 'shutdown') await service.shutdown();
    else mockSecurityCleanups[0]('cli-session-quality');
    expect(input.owner.signal.aborted).toBe(true);
    const before = mockPreparedSession.dataEnvelopes.length;
    mockPreparedSession.orchestrator.emit('update', {type: 'data', content: createDataEnvelope({columns: ['value'], rows: [[1]]}, {type: 'sql_result', source: 'execute_sql', title: 'late'}), timestamp: Date.now()});
    expect(mockPreparedSession.dataEnvelopes).toHaveLength(before);
    finish.resolve({result: input.result});
    await expect(pending).rejects.toThrow();
    expect(mockPersistAgentTurn).not.toHaveBeenCalled();
    expect(mockPreparedSession.result).toBeUndefined();
  });

  it('rechecks the actual authorization fingerprint after finalization before persistence', async () => {
    const source = {codebaseId: 'cb-cli', lifecycleState: 'active', rootRealpath: fs.realpathSync(process.cwd()),
      indexGeneration: 3, activeGeneration: 'codebase_3_test', contentFingerprint: 'a'.repeat(64), chunkCount: 1,
      consent: {sendToProvider: false, consentHash: 'original'}};
    mockCodebaseGet.mockReturnValue(source);
    const started = deferred<FinalizeAnalysisResultInput>();
    const finish = deferred<FinalizedAnalysisResult>();
    mockFinalizeAnalysisResult.mockImplementationOnce(input => {started.resolve(input); return finish.promise;});
    const pending = new CliAnalyzeService().runTurn({...cliTurnBinding, traceId: 'trace-cli', query: '分析源码', codebaseIds: ['cb-cli'], onEvent: jest.fn()});
    const input = await started.promise;
    source.consent.consentHash = 'revoked';
    finish.resolve({result: input.result});
    await expect(pending).rejects.toThrow('analysis_context_changed_restart_required');
    expect(mockPersistAgentTurn).not.toHaveBeenCalled();
  });

  it('does not let a prior finalizer overwrite the next turn in the same session', async () => {
    const started = deferred<FinalizeAnalysisResultInput>();
    const finish = deferred<FinalizedAnalysisResult>();
    mockFinalizeAnalysisResult.mockImplementationOnce(input => {started.resolve(input); return finish.promise;});
    const service = new CliAnalyzeService();
    const first = service.runTurn({...cliTurnBinding, traceId: 'trace-cli', query: 'first', onEvent: jest.fn()});
    const prior = await started.promise;
    await service.runTurn({...cliTurnBinding, turn: 2, traceId: 'trace-cli', query: 'second', onEvent: jest.fn()});
    expect(prior.owner.signal.aborted).toBe(true);
    finish.resolve({result: prior.result});
    await expect(first).rejects.toThrow();
    expect(mockPersistAgentTurn).toHaveBeenCalledTimes(1);
    expect(mockPersistAgentTurn.mock.calls[0][0]).toMatchObject({query: 'second'});
  });

  it('disposes a taken context when cancellation interrupts summary preparation before the finalizer', async () => {
    const summaryStarted = deferred<void>();
    mockTraceSummary.mockImplementationOnce(() => {summaryStarted.resolve(undefined); return new Promise<never>(() => {});});
    const take = finalizationContexts.takeFinalizationContext;
    let context: ReturnType<typeof take>;
    const spy = jest.spyOn(finalizationContexts, 'takeFinalizationContext').mockImplementation(result => (context = take(result)));
    try {
      mockAnalyze.mockImplementationOnce(async (_query, sessionId, _traceId, options) => {
        const result: AnalysisResult = {sessionId, success: true, findings: [], hypotheses: [], conclusion: 'body', confidence: 0.8, rounds: 1, totalDurationMs: 1};
        attachCliContext(result, options!.runId!, {scope: 'scene_wide', evidenceAccess: 'read_new'});
        return result;
      });
      const controller = new AbortController();
      const pending = new CliAnalyzeService().runTurn({...cliTurnBinding, signal: controller.signal, traceId: 'trace-cli', query: 'question', onEvent: jest.fn()});
      await summaryStarted.promise;
      controller.abort(new DOMException('cancelled', 'AbortError'));
      await expect(pending).rejects.toThrow();
      expect(mockFinalizeAnalysisResult).not.toHaveBeenCalled();
      expect(mockPersistAgentTurn).not.toHaveBeenCalled();
      expect(() => context!.runId).toThrow('finalization_context_disposed');
    } finally {spy.mockRestore();}
  });

});
