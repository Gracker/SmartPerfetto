// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it } from '@jest/globals';
import {
  getClaudeSnapshotEngineState,
  getOpenAISnapshotEngineState,
  getOpenCodeSnapshotEngineState,
  getPiAgentCoreSnapshotEngineState,
  getQoderSnapshotEngineState,
  getSnapshotRuntimeKind,
  getSnapshotRuntimeProviderId,
  getSnapshotRuntimeProviderSnapshotHash,
  normalizeSessionStateSnapshot,
  projectSessionFieldsForDurableSnapshot,
  type SessionStateSnapshot,
} from '../../agentv3/sessionStateSnapshot';
import type { AgentRuntimeKind } from '../../services/providerManager/types';

type IsExact<A, B> =
  (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2)
    ? ((<T>() => T extends B ? 1 : 2) extends
      (<T>() => T extends A ? 1 : 2) ? true : false)
    : false;

const runtimeKindMatchesM10PublicRuntimeContract:
  IsExact<AgentRuntimeKind, 'claude-agent-sdk' | 'openai-agents-sdk' | 'pi-agent-core' | 'opencode' | 'qoder-agent-sdk'> = true;
const snapshotRuntimeKindMatchesProviderManager:
  IsExact<NonNullable<SessionStateSnapshot['agentRuntimeKind']>, AgentRuntimeKind> = true;

const PRODUCT_STATE_FIELDS = [
  'conversationSteps',
  'queryHistory',
  'conclusionHistory',
  'agentDialogue',
  'agentResponses',
  'dataEnvelopes',
  'claimSupport',
  'claimVerificationResult',
  'identityResolutions',
  'hypotheses',
  'analysisNotes',
  'analysisPlan',
  'planHistory',
  'uncertaintyFlags',
  'architecture',
  'artifacts',
  'runSequence',
  'conversationOrdinal',
] as const satisfies readonly (keyof SessionStateSnapshot)[];

const RUNTIME_PINNING_FIELDS = [
  'engineState',
  'agentRuntimeKind',
  'agentRuntimeProviderId',
  'agentRuntimeProviderSnapshotHash',
] as const satisfies readonly (keyof SessionStateSnapshot)[];

const LEGACY_CLAUDE_RUNTIME_MIRROR_FIELDS = [
  'sdkSessionId',
  'sdkSessionMode',
  'claudeHypotheses',
] as const satisfies readonly (keyof SessionStateSnapshot)[];

const LEGACY_OPENAI_RUNTIME_MIRROR_FIELDS = [
  'openAIHistory',
  'openAILastResponseId',
  'openAIRunState',
] as const satisfies readonly (keyof SessionStateSnapshot)[];

describe('SessionStateSnapshot runtime state inventory', () => {
  it('removes model-authored intermediate state from private durable fields', () => {
    const projected = projectSessionFieldsForDurableSnapshot({
      codeAwareMode: 'provider_send',
      codebaseIds: ['private-app'],
      conversationSteps: [{content: {text: 'PRIVATE_STEP_CANARY'}}] as any,
      queryHistory: [],
      conclusionHistory: [],
      agentDialogue: [{content: 'PRIVATE_DIALOGUE_CANARY'}] as any,
      agentResponses: [{response: 'PRIVATE_RESPONSE_CANARY'}] as any,
      dataEnvelopes: [],
      hypotheses: [{description: 'PRIVATE_HYPOTHESIS_CANARY'}],
      comparisonReportSection: {markdown: 'PRIVATE_COMPARISON_CANARY'} as any,
      runSequence: 1,
      conversationOrdinal: 1,
    });

    expect(projected.conversationSteps).toEqual([]);
    expect(projected.agentDialogue).toEqual([]);
    expect(projected.agentResponses).toEqual([]);
    expect(projected.hypotheses).toEqual([]);
    expect(projected.comparisonReportSection).toBeUndefined();
    expect(JSON.stringify(projected)).not.toContain('PRIVATE_');
  });

  it('keeps snapshot v1 runtime kind aligned with public Provider Manager values', () => {
    expect(runtimeKindMatchesM10PublicRuntimeContract).toBe(true);
    expect(snapshotRuntimeKindMatchesProviderManager).toBe(true);
    const publicRuntimeKinds: Array<NonNullable<SessionStateSnapshot['agentRuntimeKind']>> = [
      'claude-agent-sdk',
      'openai-agents-sdk',
      'pi-agent-core',
      'opencode',
      'qoder-agent-sdk',
    ];
    expect(publicRuntimeKinds).toEqual(['claude-agent-sdk', 'openai-agents-sdk', 'pi-agent-core', 'opencode', 'qoder-agent-sdk']);
  });

  it('documents product state separately from current engine-local fields', () => {
    expect(PRODUCT_STATE_FIELDS).toEqual([
      'conversationSteps',
      'queryHistory',
      'conclusionHistory',
      'agentDialogue',
      'agentResponses',
      'dataEnvelopes',
      'claimSupport',
      'claimVerificationResult',
      'identityResolutions',
      'hypotheses',
      'analysisNotes',
      'analysisPlan',
      'planHistory',
      'uncertaintyFlags',
      'architecture',
      'artifacts',
      'runSequence',
      'conversationOrdinal',
    ]);
    expect(RUNTIME_PINNING_FIELDS).toEqual([
      'engineState',
      'agentRuntimeKind',
      'agentRuntimeProviderId',
      'agentRuntimeProviderSnapshotHash',
    ]);
    expect(LEGACY_CLAUDE_RUNTIME_MIRROR_FIELDS).toEqual([
      'sdkSessionId',
      'sdkSessionMode',
      'claudeHypotheses',
    ]);
    expect(LEGACY_OPENAI_RUNTIME_MIRROR_FIELDS).toEqual([
      'openAIHistory',
      'openAILastResponseId',
      'openAIRunState',
    ]);
  });

  it('characterizes the current mixed v1 shape before any state split', () => {
    const snapshot: SessionStateSnapshot = {
      version: 1,
      snapshotTimestamp: 1,
      sessionId: 'session-1',
      traceId: 'trace-1',
      conversationSteps: [],
      queryHistory: [],
      conclusionHistory: [],
      agentDialogue: [],
      agentResponses: [],
      dataEnvelopes: [],
      claimSupport: [],
      claimVerificationResult: undefined,
      identityResolutions: [],
      hypotheses: [],
      analysisNotes: [],
      analysisPlan: null,
      planHistory: [],
      uncertaintyFlags: [],
      architecture: undefined,
      artifacts: [],
      engineState: {
        kind: 'openai-agents-sdk',
        provider: {
          providerId: 'provider-1',
          providerSnapshotHash: 'hash-1',
        },
        openai: {
          history: [{ role: 'user', content: 'q' }],
          lastResponseId: 'resp-1',
          runState: 'opaque-openai-state',
        },
      },
      sdkSessionId: 'claude-sdk-session',
      sdkSessionMode: 'full',
      claudeHypotheses: [],
      agentRuntimeKind: 'openai-agents-sdk',
      agentRuntimeProviderId: 'provider-1',
      agentRuntimeProviderSnapshotHash: 'hash-1',
      openAIHistory: [{ role: 'user', content: 'q' }],
      openAILastResponseId: 'resp-1',
      openAIRunState: 'opaque-openai-state',
      runSequence: 0,
      conversationOrdinal: 0,
    };

    for (const field of [
      ...PRODUCT_STATE_FIELDS,
      ...RUNTIME_PINNING_FIELDS,
      ...LEGACY_CLAUDE_RUNTIME_MIRROR_FIELDS,
      ...LEGACY_OPENAI_RUNTIME_MIRROR_FIELDS,
    ]) {
      expect(field in snapshot).toBe(true);
    }
    expect(snapshot.version).toBe(1);
    expect(getSnapshotRuntimeKind(snapshot)).toBe('openai-agents-sdk');
    expect(getSnapshotRuntimeProviderId(snapshot)).toBe('provider-1');
    expect(getSnapshotRuntimeProviderSnapshotHash(snapshot)).toBe('hash-1');
    expect(getOpenAISnapshotEngineState(snapshot)).toEqual({
      history: [{ role: 'user', content: 'q' }],
      lastResponseId: 'resp-1',
      runState: 'opaque-openai-state',
    });
    expect(getClaudeSnapshotEngineState(snapshot)).toBeUndefined();
  });

  it('normalizes legacy v1 runtime mirrors into canonical engineState', () => {
    const legacySnapshot: SessionStateSnapshot = {
      version: 1,
      snapshotTimestamp: 1,
      sessionId: 'session-1',
      traceId: 'trace-1',
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
      agentRuntimeKind: 'openai-agents-sdk',
      agentRuntimeProviderId: null,
      agentRuntimeProviderSnapshotHash: 'hash-1',
      openAIHistory: [{ role: 'user', content: 'legacy' }],
      openAILastResponseId: 'resp-legacy',
      runSequence: 0,
      conversationOrdinal: 0,
    };

    const normalized = normalizeSessionStateSnapshot(legacySnapshot);
    expect(normalized.engineState).toEqual(expect.objectContaining({
      kind: 'openai-agents-sdk',
      provider: {
        providerId: null,
        providerSnapshotHash: 'hash-1',
      },
      openai: {
        history: [{ role: 'user', content: 'legacy' }],
        lastResponseId: 'resp-legacy',
        runState: undefined,
      },
    }));
  });

  it('normalizes legacy public Pi runtime mirrors into opaque engineState', () => {
    const legacySnapshot: SessionStateSnapshot = {
      version: 1,
      snapshotTimestamp: 1,
      sessionId: 'session-pi',
      traceId: 'trace-pi',
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
      agentRuntimeKind: 'pi-agent-core',
      agentRuntimeProviderId: 'provider-pi',
      agentRuntimeProviderSnapshotHash: 'hash-pi',
      runSequence: 0,
      conversationOrdinal: 0,
    };

    const normalized = normalizeSessionStateSnapshot(legacySnapshot);
    expect(getSnapshotRuntimeKind(normalized)).toBe('pi-agent-core');
    expect(normalized.engineState).toEqual({
      kind: 'pi-agent-core',
      provider: {
        providerId: 'provider-pi',
        providerSnapshotHash: 'hash-pi',
      },
      pi: {
        opaque: undefined,
      },
    });
  });

  it('reads canonical Pi and OpenCode opaque engine states', () => {
    const piSnapshot: SessionStateSnapshot = {
      version: 1,
      snapshotTimestamp: 1,
      sessionId: 'session-pi',
      traceId: 'trace-pi',
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
        kind: 'pi-agent-core',
        provider: {
          providerId: 'provider-pi',
          providerSnapshotHash: 'hash-pi',
        },
        pi: {
          opaque: {
            version: 1,
            messages: [{ role: 'assistant', content: [{ type: 'text', text: 'prior' }] }],
            messageCount: 1,
            byteSize: 72,
          },
        },
      },
      runSequence: 0,
      conversationOrdinal: 0,
    };

    expect(getPiAgentCoreSnapshotEngineState(piSnapshot)).toEqual({
      opaque: {
        version: 1,
        messages: [{ role: 'assistant', content: [{ type: 'text', text: 'prior' }] }],
        messageCount: 1,
        byteSize: 72,
      },
    });

    const openCodeSnapshot: SessionStateSnapshot = {
      version: 1,
      snapshotTimestamp: 1,
      sessionId: 'session-opencode',
      traceId: 'trace-opencode',
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
        kind: 'opencode',
        provider: {
          providerId: 'provider-opencode',
          providerSnapshotHash: 'hash-opencode',
        },
        opencode: {
          opaque: {
            version: 1,
            openCodeSessionId: 'ses-opencode',
            projectDir: '/data/opencode/session/project',
            homeDir: '/data/opencode/session/home',
            configDir: '/data/opencode/session/config',
          },
        },
      },
      runSequence: 0,
      conversationOrdinal: 0,
    };

    expect(getOpenCodeSnapshotEngineState(openCodeSnapshot)).toEqual({
      opaque: {
        version: 1,
        openCodeSessionId: 'ses-opencode',
        projectDir: '/data/opencode/session/project',
        homeDir: '/data/opencode/session/home',
        configDir: '/data/opencode/session/config',
      },
    });
  });

  it('reads canonical Qoder opaque engine states', () => {
    const qoderSnapshot: SessionStateSnapshot = {
      version: 1,
      snapshotTimestamp: 1,
      sessionId: 'session-qoder',
      traceId: 'trace-qoder',
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
        kind: 'qoder-agent-sdk',
        provider: {
          providerId: 'provider-qoder',
          providerSnapshotHash: 'hash-qoder',
        },
        qoder: {
          opaque: {
            version: 1,
            sdkSessionId: 'ses-qoder-123',
          },
        },
      },
      runSequence: 0,
      conversationOrdinal: 0,
    };

    expect(getQoderSnapshotEngineState(qoderSnapshot)).toEqual({
      opaque: {
        version: 1,
        sdkSessionId: 'ses-qoder-123',
      },
    });

    const degradedSnapshot: SessionStateSnapshot = {
      ...qoderSnapshot,
      engineState: {
        kind: 'qoder-agent-sdk',
        provider: {
          providerId: 'provider-qoder',
          providerSnapshotHash: 'hash-qoder',
        },
        qoder: {
          opaque: {
            version: 1,
            degradedReason: 'state_unavailable',
          },
        },
      },
    };

    expect(getQoderSnapshotEngineState(degradedSnapshot)).toEqual({
      opaque: {
        version: 1,
        degradedReason: 'state_unavailable',
      },
    });
  });
});
