// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it, jest} from '@jest/globals';

import {canonicalContentHash} from '../canonicalJson';
import {RunManifestBuilder} from '../runManifestBuilder';

const TRACE_SHA = 'a'.repeat(64);
const CONTENT_SHA = 'b'.repeat(64);
const CACHE_KEY_SHA = 'c'.repeat(64);

function createBuilder(now = jest.fn(() => 1_010)) {
  return new RunManifestBuilder({
    runManifestId: 'manifest-1',
    runId: 'run-1',
    sessionId: 'session-1',
    scope: {tenantId: 'tenant-a', workspaceId: 'workspace-a'},
    startedAt: 1_000,
    runtime: 'qoder-agent-sdk',
    providerId: 'provider-a',
    providerSnapshotHash: 'provider-snapshot-a',
    outputLanguage: 'zh-CN',
    analysisMode: 'auto',
    now,
  });
}

function recordEmptyRegistry(builder: RunManifestBuilder): void {
  builder.recordSkillRegistry({registryFingerprint: 'registry-a', skills: []});
}

function capabilityAttribution(
  outcome: 'hit' | 'miss' | 'bypass',
  overrides: Record<string, unknown> = {},
) {
  return {
    schemaVersion: 'capability_manifest_attribution@1' as const,
    resolution: {
      status: 'ready' as const,
      manifestId: `capability_manifest:${CONTENT_SHA}`,
      contentHash: CONTENT_SHA,
      manifestSchemaVersion: 'capability_manifest@1' as const,
      traceFingerprintSha256: TRACE_SHA,
      traceProcessor: {
        source: 'bundled' as const,
        gitRevision: 'd'.repeat(40),
      },
      ...overrides,
    },
    probeCache: {
      ...(outcome === 'bypass' ? {} : {keyHash: CACHE_KEY_SHA}),
      hits: outcome === 'hit' ? 1 : 0,
      misses: outcome === 'miss' ? 1 : 0,
      bypasses: outcome === 'bypass' ? 1 : 0,
    },
  };
}

describe('RunManifestBuilder', () => {
  it('merges matching capability manifest miss and hit counters into the sealed run', () => {
    const builder = createBuilder();
    recordEmptyRegistry(builder);

    builder.recordCapabilityManifest(capabilityAttribution('miss'));
    builder.recordCapabilityManifest(capabilityAttribution('hit'));

    expect(builder.seal().capabilityManifest).toEqual({
      ...capabilityAttribution('miss'),
      probeCache: {
        keyHash: CACHE_KEY_SHA,
        hits: 1,
        misses: 1,
        bypasses: 0,
      },
    });
  });

  it('fails closed when capability manifest identity or cache key conflicts', () => {
    const identityConflict = createBuilder();
    recordEmptyRegistry(identityConflict);
    identityConflict.recordCapabilityManifest(capabilityAttribution('miss'));
    expect(() => identityConflict.recordCapabilityManifest(
      capabilityAttribution('hit', {
        contentHash: 'e'.repeat(64),
        manifestId: `capability_manifest:${'e'.repeat(64)}`,
      }),
    )).toThrow('run_manifest_capability_manifest_identity_mismatch');

    const keyConflict = createBuilder();
    recordEmptyRegistry(keyConflict);
    keyConflict.recordCapabilityManifest(capabilityAttribution('miss'));
    const conflictingKey = capabilityAttribution('hit');
    conflictingKey.probeCache.keyHash = 'f'.repeat(64);
    expect(() => keyConflict.recordCapabilityManifest(conflictingKey))
      .toThrow('run_manifest_capability_manifest_identity_mismatch');
  });

  it('seals one immutable canonical manifest with actual invocation outcomes', () => {
    const builder = createBuilder();
    builder.recordSkillRegistry({
      registryFingerprint: 'registry-a',
      skills: [{
        skillId: 'startup_analysis',
        version: '1.2.3',
        contentFingerprint: 'skill-hash',
        origin: 'external_pack',
        packId: 'pack-a',
        packVersion: '2.0.0',
        trustState: 'approved',
        appliedOverlayIds: [],
      }],
    });
    const ok = builder.startSkillInvocation({
      skillId: 'startup_analysis',
      version: '1.2.3',
      contentFingerprint: 'skill-hash',
    });
    builder.finishSkillInvocation(ok, {success: true, empty: false});
    const empty = builder.startSkillInvocation({
      skillId: 'startup_analysis',
      version: '1.2.3',
      contentFingerprint: 'skill-hash',
    });
    builder.finishSkillInvocation(empty, {success: true, empty: true});
    const failed = builder.startSkillInvocation({
      skillId: 'startup_analysis',
      version: '1.2.3',
      contentFingerprint: 'skill-hash',
    });
    builder.finishSkillInvocation(failed, {success: false, empty: false});
    builder.recordSqlStatement(true);
    builder.recordSqlStatement(false);
    builder.recordToolAllowlist(['query_trace', 'invoke_skill', 'query_trace']);
    builder.recordInjection('patterns', 'pattern-b', 'hash-b');
    builder.recordInjection('patterns', 'pattern-a', 'hash-a');
    builder.recordPromptTemplate('strategy-template', 'template-hash');
    builder.recordTurnCount(3);
    builder.recordRuntime({
      runtime: 'qoder-agent-sdk',
      providerSnapshotHash: 'provider-snapshot-a',
      providerId: 'provider-a',
      model: 'qoder-model',
    });

    const manifest = builder.seal();

    expect(builder.seal()).toBe(manifest);
    expect(manifest).toEqual(expect.objectContaining({
      schemaVersion: 1,
      runManifestId: 'manifest-1',
      runtime: 'qoder-agent-sdk',
      model: 'qoder-model',
      sqlStatementCount: 2,
      sqlErrorCount: 1,
      skillRegistryFingerprint: 'registry-a',
      evolutionOverlayGeneration: 'builtin:registry-a',
      wallclockMs: 10,
      turns: 3,
      toolAllowlistHash: canonicalContentHash(['invoke_skill', 'query_trace']),
    }));
    expect(manifest.skills).toEqual([expect.objectContaining({
      skillId: 'startup_analysis',
      invocations: 3,
      okCount: 1,
      emptyResultCount: 1,
      errorCount: 1,
    })]);
    expect(manifest.injections.patterns.map(item => item.id)).toEqual([
      'pattern-a',
      'pattern-b',
    ]);
    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(manifest.skills)).toBe(true);
  });

  it('omits the optional performance receipt when no performance was recorded', () => {
    const builder = createBuilder();
    recordEmptyRegistry(builder);

    expect(builder.seal()).not.toHaveProperty('performance');
  });

  it('seals a privacy-safe immutable performance receipt before the run manifest closes', () => {
    const builder = createBuilder();
    recordEmptyRegistry(builder);

    const phase = builder.runtimePerformanceRecorder.startPhase('classification');
    phase.end();
    builder.runtimePerformanceRecorder.recordTool({
      toolCallId: 'raw-tool-call-id',
      mode: 'exclusive',
      schedulerWaitMs: 0,
      durationMs: 2,
      outcome: 'ok',
    });

    const manifest = builder.seal();

    expect(manifest.performance).toEqual({
      schemaVersion: 1,
      phases: [expect.objectContaining({
        name: 'classification',
        outcome: 'ok',
      })],
      tools: [expect.objectContaining({
        mode: 'exclusive',
        toolCallIdHash: expect.stringMatching(/^sha256:/),
      })],
      sql: [],
    });
    expect(JSON.stringify(manifest.performance)).not.toContain('raw-tool-call-id');
    expect(Object.isFrozen(manifest.performance)).toBe(true);
    expect(Object.isFrozen(manifest.performance?.phases)).toBe(true);
    expect(() => builder.runtimePerformanceRecorder.recordFirstOutput()).toThrow(
      'runtime_performance_already_sealed:record_first_output',
    );
  });

  it('records zero-turn quick runs and closes pending terminal invocations as errors', () => {
    const builder = createBuilder();
    builder.recordSkillRegistry({
      registryFingerprint: 'registry-a',
      skills: [{
        skillId: 'startup_analysis',
        version: '1.2.3',
        contentFingerprint: 'skill-hash',
        origin: 'built_in',
        appliedOverlayIds: [],
      }],
    });
    builder.startSkillInvocation({
      skillId: 'startup_analysis',
      version: '1.2.3',
      contentFingerprint: 'skill-hash',
    });

    builder.closePendingSkillInvocationsAsErrors();
    const manifest = builder.seal();

    expect(manifest.turns).toBe(0);
    expect(manifest.skills).toEqual([expect.objectContaining({
      invocations: 1,
      errorCount: 1,
    })]);
  });

  it('blocks seal with pending attribution and rejects every late write', () => {
    const diagnostic = jest.fn();
    const builder = new RunManifestBuilder({
      runManifestId: 'manifest-2',
      runId: 'run-2',
      sessionId: 'session-2',
      scope: {tenantId: 'tenant-a', workspaceId: 'workspace-a'},
      runtime: 'claude-agent-sdk',
      providerId: null,
      outputLanguage: 'en',
      analysisMode: 'full',
      onDiagnostic: diagnostic,
    });
    builder.recordSkillRegistry({
      registryFingerprint: 'registry-a',
      skills: [{
        skillId: 'skill-a',
        version: '1',
        contentFingerprint: 'hash-a',
        origin: 'built_in',
        appliedOverlayIds: [],
      }],
    });
    const invocation = builder.startSkillInvocation({
      skillId: 'skill-a',
      version: '1',
      contentFingerprint: 'hash-a',
    });

    expect(() => builder.seal()).toThrow('run_manifest_pending_attributions:1');
    builder.finishSkillInvocation(invocation, {success: true, empty: false});
    builder.seal();
    expect(() => builder.recordSqlStatement(true)).toThrow(
      'run_manifest_already_sealed:record_sql_statement',
    );
    expect(diagnostic).toHaveBeenCalledWith(
      'late_attribution_rejected',
      {operation: 'record_sql_statement'},
    );
  });
});
