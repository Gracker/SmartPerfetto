// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { afterEach, describe, expect, it, jest } from '@jest/globals';
import {
  buildCaseEvolutionSnapshotPath,
  captureCaseCandidatesAfterQualityArtifacts,
  resolveCaseEvolutionArchitectureType,
} from '../agentRoutes';
import { buildTraceContextDataEnvelopes } from '../../agentRuntime/traceContextEvidence';

afterEach(() => {
  jest.restoreAllMocks();
});

describe('agentRoutes case evolution capture seam', () => {
  it('builds stable session-persistence snapshot references', () => {
    expect(buildCaseEvolutionSnapshotPath('session-abc')).toBe(
      'session-persistence://sessions/session-abc/metadata/sessionStateSnapshot',
    );
  });

  it('resolves architecture type from the orchestrator cache with unknown fallback', () => {
    expect(
      resolveCaseEvolutionArchitectureType({
        orchestrator: {
          getCachedArchitecture: jest.fn(() => ({ type: 'android' })),
        },
      } as any, 'trace-1'),
    ).toBe('android');

    expect(
      resolveCaseEvolutionArchitectureType({
        orchestrator: {
          getCachedArchitecture: jest.fn(() => ({ name: 'missing-type' })),
        },
      } as any, 'trace-1'),
    ).toBe('unknown');

    expect(resolveCaseEvolutionArchitectureType({ orchestrator: {} } as any, 'trace-1')).toBe('unknown');
  });

  it('passes verified artifacts and live session envelopes to saveCaseCandidates', async () => {
    const dataEnvelope = {
      schemaVersion: 'data-envelope@1',
      data: { columns: [], rows: [] },
      meta: { skillId: 'scrolling_analysis', stepId: 'batch_frame_root_cause' },
    };
    const claimVerificationResult = {
      status: 'passed',
      summary: { checkedClaims: 1, unsupportedClaims: 0 },
    };
    const result = {
      sessionId: 'session-1',
      success: true,
      findings: [],
      hypotheses: [],
      conclusion: 'Verified conclusion',
      confidence: 0.91,
      rounds: 2,
      totalDurationMs: 1250,
      claimVerificationResult,
    };
    const session = {
      activeRun: { sequence: 3 },
      dataEnvelopes: [dataEnvelope],
      orchestrator: {
        getCachedArchitecture: jest.fn(() => ({ type: 'android' })),
      },
    };
    const saveCandidates = jest.fn<(input: any) => Promise<{ captured: number }>>(
      async () => ({ captured: 1 }),
    );
    const computeTraceHash = jest.fn<(traceId: string) => Promise<string>>(
      async () => 'trace-hash-1',
    );
    const logger = {
      warn: jest.fn<(component: string, message: string, metadata?: Record<string, unknown>) => void>(),
      info: jest.fn<(component: string, message: string, metadata?: Record<string, unknown>) => void>(),
    };

    await captureCaseCandidatesAfterQualityArtifacts({
      sessionId: 'session-1',
      traceId: 'trace-1',
      session: session as any,
      result: result as any,
      normalizedConclusionContract: { schemaVersion: 'conclusion-contract@1' } as any,
      sceneIdHint: 'scrolling',
      runIdForAnalysis: 'run-1',
      knowledgeScope: { tenantId: 'tenant-1', workspaceId: 'workspace-1', userId: 'user-1' },
      caseEvolutionConfig: {captureEnabled: true} as any,
      computeTraceHash,
      saveCandidates,
      logger: logger as any,
    });

    expect(computeTraceHash).toHaveBeenCalledWith('trace-1');
    expect(saveCandidates).toHaveBeenCalledWith(expect.objectContaining({
      result,
      conclusionContract: { schemaVersion: 'conclusion-contract@1' },
      claimVerificationResult,
      dataEnvelopes: [dataEnvelope],
      sceneType: 'scrolling',
      architectureType: 'android',
      knowledgeScope: { tenantId: 'tenant-1', workspaceId: 'workspace-1', userId: 'user-1' },
      snapshotPath: 'session-persistence://sessions/session-1/metadata/sessionStateSnapshot',
      provenance: expect.objectContaining({
        sessionId: 'session-1',
        runId: 'run-1',
        turnIndex: 3,
        engine: 'claude',
        traceContentHash: 'trace-hash-1',
      }),
    }));
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('freezes turn provenance before asynchronous trace hashing completes', async () => {
    let resolveHash!: (hash: string) => void;
    const hashReady = new Promise<string>(resolve => {
      resolveHash = resolve;
    });
    const originalEnvelope = {
      schemaVersion: 'data-envelope@1',
      data: {columns: ['value'], rows: [['original-turn']]},
      meta: {skillId: 'scrolling_analysis', stepId: 'original-turn'},
    };
    const session = {
      runtimeKind: 'openai-agents-sdk',
      activeRun: {sequence: 4},
      dataEnvelopes: [originalEnvelope],
      orchestrator: {
        getCachedArchitecture: jest.fn(() => ({type: 'android-original'})),
      },
    };
    const saveCandidates = jest.fn<(input: any) => Promise<{captured: number}>>(
      async () => ({captured: 1}),
    );
    const capture = captureCaseCandidatesAfterQualityArtifacts({
      sessionId: 'session-race',
      traceId: 'trace-race',
      session: session as any,
      result: {
        sessionId: 'session-race',
        success: true,
        findings: [],
        hypotheses: [],
        conclusion: 'Verified conclusion',
        confidence: 0.91,
        rounds: 2,
        totalDurationMs: 100,
      } as any,
      sceneIdHint: 'scrolling',
      runIdForAnalysis: 'run-race',
      caseEvolutionConfig: {captureEnabled: true} as any,
      computeTraceHash: jest.fn(() => hashReady),
      saveCandidates,
      logger: {info: jest.fn(), warn: jest.fn()} as any,
    });

    session.activeRun.sequence = 5;
    originalEnvelope.data.rows[0][0] = 'mutated-next-turn';
    session.dataEnvelopes = [{
      ...originalEnvelope,
      meta: {...originalEnvelope.meta, stepId: 'next-turn'},
    }];
    session.orchestrator.getCachedArchitecture.mockReturnValue({type: 'android-next'});
    resolveHash('trace-hash-race');
    await capture;

    expect(saveCandidates).toHaveBeenCalledWith(expect.objectContaining({
      dataEnvelopes: [expect.objectContaining({
        data: {columns: ['value'], rows: [['original-turn']]},
        meta: expect.objectContaining({stepId: 'original-turn'}),
      })],
      architectureType: 'android-original',
      provenance: expect.objectContaining({
        turnIndex: 4,
        engine: 'openai',
        traceContentHash: 'trace-hash-race',
      }),
    }));
  });

  it('does not touch trace hashing or persistence when capture is disabled', async () => {
    const computeTraceHash = jest.fn<(traceId: string) => Promise<string>>(
      async () => {
        throw new Error('should not hash');
      },
    );
    const saveCandidates = jest.fn<(input: any) => Promise<{ captured: number }>>(
      async () => ({ captured: 1 }),
    );
    const logger = {
      warn: jest.fn<(component: string, message: string, metadata?: Record<string, unknown>) => void>(),
      info: jest.fn<(component: string, message: string, metadata?: Record<string, unknown>) => void>(),
    };

    await captureCaseCandidatesAfterQualityArtifacts({
      sessionId: 'session-1',
      traceId: 'trace-1',
      session: {
        activeRun: { sequence: 1 },
        dataEnvelopes: [],
        orchestrator: {},
      } as any,
      result: {
        sessionId: 'session-1',
        success: true,
        findings: [],
        hypotheses: [],
        conclusion: 'Verified conclusion',
        confidence: 0.95,
        rounds: 2,
        totalDurationMs: 100,
      } as any,
      sceneIdHint: 'scrolling',
      runIdForAnalysis: 'run-1',
      caseEvolutionConfig: {captureEnabled: false} as any,
      computeTraceHash,
      saveCandidates,
      logger: logger as any,
    });

    expect(computeTraceHash).not.toHaveBeenCalled();
    expect(saveCandidates).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('does not hash or persist candidates from private source or RAG runs', async () => {
    const computeTraceHash = jest.fn(async () => 'must-not-be-used');
    const saveCandidates = jest.fn(async () => ({captured: 1}));
    const logger = {info: jest.fn(), warn: jest.fn()};

    await captureCaseCandidatesAfterQualityArtifacts({
      sessionId: 'private-session',
      traceId: 'trace-private',
      session: {
        codeAwareMode: 'provider_send',
        codebaseIds: ['app-source'],
        knowledgeSourceIds: ['wiki'],
        dataEnvelopes: [],
        orchestrator: {},
      } as any,
      result: {confidence: 0.99, rounds: 3} as any,
      runIdForAnalysis: 'private-run',
      caseEvolutionConfig: {captureEnabled: true} as any,
      computeTraceHash,
      saveCandidates,
      logger: logger as any,
    });

    expect(computeTraceHash).not.toHaveBeenCalled();
    expect(saveCandidates).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      'CaseEvolution',
      'Skipping candidate capture for private source or knowledge analysis',
      expect.objectContaining({sessionId: 'private-session'}),
    );
  });

  it('swallows capture failures so terminal completion can continue', async () => {
    const logger = {
      warn: jest.fn<(component: string, message: string, metadata?: Record<string, unknown>) => void>(),
      info: jest.fn<(component: string, message: string, metadata?: Record<string, unknown>) => void>(),
    };

    await expect(captureCaseCandidatesAfterQualityArtifacts({
      sessionId: 'session-1',
      traceId: 'trace-1',
      session: {
        activeRun: { sequence: 1 },
        dataEnvelopes: [],
        orchestrator: {},
      } as any,
      result: {
        sessionId: 'session-1',
        success: true,
        findings: [],
        hypotheses: [],
        conclusion: 'Verified conclusion',
        confidence: 0.95,
        rounds: 2,
        totalDurationMs: 100,
      } as any,
      sceneIdHint: 'scrolling',
      runIdForAnalysis: 'run-1',
      caseEvolutionConfig: {captureEnabled: true} as any,
      computeTraceHash: jest.fn<(traceId: string) => Promise<string>>(async () => 'trace-hash-1'),
      saveCandidates: jest.fn<(input: any) => Promise<never>>(async () => {
        throw new Error('capture boom');
      }),
      logger: logger as any,
    })).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledWith(
      'CaseEvolution',
      'Candidate capture failed (non-fatal)',
      expect.objectContaining({
        sessionId: 'session-1',
        runId: 'run-1',
        error: 'capture boom',
      }),
    );
  });
});

describe('agentRoutes frontend traceContext envelopes', () => {
  it('converts frontend pre-query datasets into SQL result envelopes for persistence and replay', () => {
    const envelopes = buildTraceContextDataEnvelopes([
      {
        label: 'thread states in range',
        columns: ['thread_name', 'state', 'total_ms'],
        rows: [
          ['RenderThread', 'Running', 12.5],
          ['main', 'R', 4.2],
        ],
      },
    ], 'trace-fast-1');

    expect(envelopes).toHaveLength(1);
    expect(envelopes[0].meta.type).toBe('sql_result');
    expect(envelopes[0].meta.source).toBe('frontend_trace_context');
    expect(envelopes[0].meta.traceId).toBe('trace-fast-1');
    expect(envelopes[0].meta.evidenceRefId).toMatch(/^data:frontend_prequery:current:/);
    expect(envelopes[0].meta.sourceToolCallId).toMatch(/^frontend-prequery:/);
    expect(envelopes[0].meta.intent).toBe('frontend_prequeried_trace_context');
    expect(envelopes[0].display.title).toBe('thread states in range');
    expect(envelopes[0].display.format).toBe('table');
    expect(envelopes[0].data).toEqual({
      columns: ['thread_name', 'state', 'total_ms'],
      rows: [
        ['RenderThread', 'Running', 12.5],
        ['main', 'R', 4.2],
      ],
    });
  });

  it('uses stable hashes and skips empty frontend pre-query datasets', () => {
    const datasets = [
      {
        label: 'running threads in range',
        columns: ['thread_name', 'running_ms'],
        rows: [['main', 9.1]],
      },
      {
        label: 'empty',
        columns: ['name'],
        rows: [],
      },
    ];

    const first = buildTraceContextDataEnvelopes(datasets, 'trace-fast-1');
    const second = buildTraceContextDataEnvelopes(datasets, 'trace-fast-1');

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0].meta.queryHash).toBe(second[0].meta.queryHash);
    expect(first[0].meta.evidenceRefId).toBe(second[0].meta.evidenceRefId);
  });
});
