// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it } from '@jest/globals';
import {
  continuityBreaksAfterRestore,
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

const snapshotRuntimeKindMatchesProviderManager:
  IsExact<NonNullable<SessionStateSnapshot['agentRuntimeKind']>, AgentRuntimeKind> = true;

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

  it('keeps snapshot runtime kind aligned with Provider Manager', () => {
    expect(snapshotRuntimeKindMatchesProviderManager).toBe(true);
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
      agentRuntimeProviderId: null,
      agentRuntimeProviderSnapshotHash: 'hash-1',
      openAIHistory: [{ role: 'user', content: 'legacy' }],
      openAILastResponseId: 'resp-legacy',
      runSequence: 0,
      conversationOrdinal: 0,
    };

    // Without agentRuntimeKind, only the legacy OpenAI mirrors identify the runtime.
    const normalized = normalizeSessionStateSnapshot(legacySnapshot);
    expect(getSnapshotRuntimeKind(normalized)).toBe('openai-agents-sdk');
    expect(getSnapshotRuntimeProviderId(normalized)).toBeNull();
    expect(getSnapshotRuntimeProviderSnapshotHash(normalized)).toBe('hash-1');
    // Legacy mirror content is not copied into engineState: no run consumes it.
    expect(normalized.engineState).toEqual({
      kind: 'openai-agents-sdk',
      provider: {
        providerId: null,
        providerSnapshotHash: 'hash-1',
      },
      openai: {},
    });
  });

  it('normalizes a legacy Claude SDK session mirror into a provider-only engineState', () => {
    const legacySnapshot: SessionStateSnapshot = {
      version: 1,
      snapshotTimestamp: 1,
      sessionId: 'session-claude',
      traceId: 'trace-claude',
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
      agentRuntimeProviderId: 'provider-claude',
      agentRuntimeProviderSnapshotHash: 'hash-claude',
      sdkSessionId: 'sdk-legacy',
      sdkSessionMode: 'full',
      runSequence: 0,
      conversationOrdinal: 0,
    };

    // Without agentRuntimeKind, only the legacy SDK session mirror identifies the runtime.
    const normalized = normalizeSessionStateSnapshot(legacySnapshot);
    expect(getSnapshotRuntimeKind(normalized)).toBe('claude-agent-sdk');
    expect(getSnapshotRuntimeProviderId(normalized)).toBe('provider-claude');
    expect(getSnapshotRuntimeProviderSnapshotHash(normalized)).toBe('hash-claude');
    // No run resumes the SDK session, so its id is not copied into engineState.
    expect(normalized.engineState).toEqual({
      kind: 'claude-agent-sdk',
      provider: {
        providerId: 'provider-claude',
        providerSnapshotHash: 'hash-claude',
      },
      claude: {},
    });
  });

  it('normalizes legacy public Pi runtime mirrors into a provider-only engineState', () => {
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
      pi: {},
    });
  });

  it('keeps the provider pin of a legacy Pi snapshot that still stores a transcript', () => {
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

    // No run reads the stored transcript; normalization leaves it untouched and
    // the provider pin still resolves from engineState.
    expect(normalizeSessionStateSnapshot(piSnapshot)).toBe(piSnapshot);
    expect(getSnapshotRuntimeKind(piSnapshot)).toBe('pi-agent-core');
    expect(getSnapshotRuntimeProviderId(piSnapshot)).toBe('provider-pi');
    expect(getSnapshotRuntimeProviderSnapshotHash(piSnapshot)).toBe('hash-pi');
  });

  it('keeps the provider pin of a legacy OpenCode snapshot that still stores a session', () => {
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

    // No run reads the stored session id or directories; normalization leaves
    // them untouched and the provider pin still resolves from engineState.
    expect(normalizeSessionStateSnapshot(openCodeSnapshot)).toBe(openCodeSnapshot);
    expect(getSnapshotRuntimeKind(openCodeSnapshot)).toBe('opencode');
    expect(getSnapshotRuntimeProviderId(openCodeSnapshot)).toBe('provider-opencode');
    expect(getSnapshotRuntimeProviderSnapshotHash(openCodeSnapshot)).toBe('hash-opencode');
  });

  it('keeps the provider pin of legacy Qoder snapshots that still store a session id', () => {
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

    expect(normalizeSessionStateSnapshot(qoderSnapshot)).toBe(qoderSnapshot);
    expect(getSnapshotRuntimeKind(qoderSnapshot)).toBe('qoder-agent-sdk');
    expect(getSnapshotRuntimeProviderId(qoderSnapshot)).toBe('provider-qoder');
    expect(getSnapshotRuntimeProviderSnapshotHash(qoderSnapshot)).toBe('hash-qoder');

    // A Qoder snapshot that predates engineState gets the same provider-only shape.
    const {engineState: _engineState, ...mirrorOnly} = qoderSnapshot;
    expect(normalizeSessionStateSnapshot({
      ...mirrorOnly,
      agentRuntimeKind: 'qoder-agent-sdk',
      agentRuntimeProviderId: 'provider-qoder',
      agentRuntimeProviderSnapshotHash: 'hash-qoder',
    }).engineState).toEqual({
      kind: 'qoder-agent-sdk',
      provider: {providerId: 'provider-qoder', providerSnapshotHash: 'hash-qoder'},
      qoder: {},
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

    expect(getSnapshotRuntimeKind(degradedSnapshot)).toBe('qoder-agent-sdk');
    expect(getSnapshotRuntimeProviderSnapshotHash(degradedSnapshot)).toBe('hash-qoder');
  });

  it('carries the valid continuity-break audit forward and appends only on a provider change', () => {
    const recorded = {at: 1, previousProviderHash: 'hash-0', reason: 'provider_snapshot_hash_mismatch' as const};
    const persisted = [recorded, {at: 2, previousProviderHash: '', reason: 'provider_snapshot_hash_mismatch'}, 'junk'];

    expect(continuityBreaksAfterRestore(persisted, undefined)).toEqual([recorded]);
    expect(continuityBreaksAfterRestore(undefined, null)).toEqual([]);
    expect(continuityBreaksAfterRestore(persisted, 'hash-1')).toEqual([
      recorded,
      {at: expect.any(Number), previousProviderHash: 'hash-1', reason: 'provider_snapshot_hash_mismatch'},
    ]);
  });
});
