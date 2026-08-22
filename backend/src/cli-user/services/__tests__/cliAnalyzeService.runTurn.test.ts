// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { AnalysisResult } from '../../../agent/core/orchestratorTypes';
import type { StreamingUpdate } from '../../../agent/types';
import { createDataEnvelope } from '../../../types/dataContract';
import { CliAnalyzeService } from '../cliAnalyzeService';

const mockAnalyze = jest.fn<() => Promise<AnalysisResult>>();
const mockPersistAgentTurn = jest.fn();
const mockGenerateAgentDrivenHTML = jest.fn<(data: unknown) => string>(() => '<html></html>');
const mockAnnotateLatestCompletedTurn = jest.fn();
const mockRunClaimVerification = jest.fn((_input: unknown): any => ({
  claimSupport: [],
  claimVerificationResult: {
    schemaVersion: 'claim_verifier@1',
    status: 'not_checked',
    policy: 'record_only',
    notCheckedReason: 'test',
    passed: false,
    checkedClaimCount: 0,
    unsupportedClaimCount: 0,
    claimResults: [],
    issues: [],
  },
  identityResolutions: [],
}));
const mockCodebaseGet = jest.fn();
const mockKnowledgeSourceGet = jest.fn();
const mockPrepareSession = jest.fn();
const mockRunManifestLifecycles: any[] = [];
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
  AgentAnalyzeSessionService: jest.fn().mockImplementation(() => ({
    prepareSession: (...args: unknown[]) => mockPrepareSession(...args),
  })),
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

jest.mock('../../../services/verifier/claimVerificationRunner', () => ({
  runClaimVerification: (input: unknown) => mockRunClaimVerification(input),
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

describe('CliAnalyzeService runTurn final quality gate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRunManifestLifecycles.length = 0;
    mockRunClaimVerification.mockReturnValue({
      claimSupport: [],
      claimVerificationResult: {
        schemaVersion: 'claim_verifier@1',
        status: 'not_checked',
        policy: 'record_only',
        notCheckedReason: 'test',
        passed: false,
        checkedClaimCount: 0,
        unsupportedClaimCount: 0,
        claimResults: [],
        issues: [],
      },
      identityResolutions: [],
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
        content: {message: 'CLI_PRIVATE_STREAM_CANARY'},
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
    expect(output.result.analysisReceipt?.outputs.cliTurnPath).toBeUndefined();
    expect(JSON.stringify(events)).not.toContain('CLI_PRIVATE_STREAM_CANARY');
  });

  it.each([
    ['source only', ['cb-cli'], undefined],
    ['RAG only', undefined, ['wiki-cli']],
    ['source and RAG', ['cb-cli'], ['wiki-cli']],
  ] as const)('marks %s private before session preparation logs the query', async (
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

    await new CliAnalyzeService().runTurn({
      ...cliTurnBinding,
      traceId: 'trace-cli',
      query: 'PRIVATE_PREPARE_QUERY_CANARY',
      ...(codebaseIds ? {codebaseIds: [...codebaseIds]} : {}),
      ...(knowledgeSourceIds ? {knowledgeSourceIds: [...knowledgeSourceIds]} : {}),
      onEvent: jest.fn(),
    });

    expect(mockPrepareSession).toHaveBeenCalledWith(expect.objectContaining({
      query: 'PRIVATE_PREPARE_QUERY_CANARY',
      options: expect.objectContaining({
        ...(codebaseIds ? {
          codeAwareMode: 'metadata_only',
          codebaseIds: ['cb-cli'],
        } : {codeAwareMode: 'off'}),
        ...(knowledgeSourceIds ? {knowledgeSourceIds: ['wiki-cli']} : {}),
      }),
    }));
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

  it('marks phase-summary runtime output partial across CLI result, session, report, and event stream', async () => {
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
          code: 'plan_summary_fallback',
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

  it('derives verifier-ready contracts from CLI-collected DataEnvelopes before verification', async () => {
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
    mockRunClaimVerification.mockReturnValueOnce({
      claimSupport: [],
      claimVerificationResult: {
        schemaVersion: 'claim_verifier@1',
        status: 'passed',
        policy: 'record_only',
        notCheckedReason: undefined,
        passed: true,
        checkedClaimCount: 1,
        unsupportedClaimCount: 0,
        claimResults: [],
        issues: [],
      },
      identityResolutions: [],
    });

    const service = new CliAnalyzeService();
    const output = await service.runTurn({
      ...cliTurnBinding,
      traceId: 'trace-cli',
      query: '分析启动慢',
      onEvent: jest.fn(),
    });
    const verifierInput = mockRunClaimVerification.mock.calls[0]?.[0] as any;

    expect(output.result.conclusionContract?.metadata?.derivedFromNarrativeEvidenceMatch).toBe(true);
    expect(verifierInput.conclusionContract?.claims?.some((claim: any) =>
      claim.references?.some((ref: any) => ref.column === 'ttid_ms' && ref.value === 1912),
    )).toBe(true);
    expect(output.result.claimVerificationResult?.status).toBe('passed');
  });
});
