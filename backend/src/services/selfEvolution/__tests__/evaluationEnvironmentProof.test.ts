// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {promises as fsp} from 'fs';
import os from 'os';
import path from 'path';

import {ProviderService} from '../../providerManager/providerService';
import type {
  EvalPinnedEnvironmentV1,
  EvalScoreV1,
  RunInjectionAttribution,
  RunManifestV1,
  SelfEvolutionPersistenceCapability,
} from '../../../types/selfEvolution';
import {canonicalContentHash} from '../canonicalJson';
import {
  assertComparableEvaluationProofs,
  assertEvaluationProofMatchesScore,
  captureEvaluationEnvironmentStart,
  evaluationEnvironmentManifestBinding,
  finalizeEvaluationEnvironmentProof,
  parseEvaluationEnvironmentProof,
  parseEvaluationEnvironmentStart,
  __testing,
  type EvaluationEnvironmentProofV1,
  type EvaluationEnvironmentStartV1,
} from '../evaluationEnvironmentProof';
import {RunManifestStore} from '../runManifestStore';

const persistenceUnavailable: SelfEvolutionPersistenceCapability = {
  persistence: 'unavailable',
  reason: 'data_root_not_writable',
  configured: true,
  writable: false,
  outsidePackage: true,
  externalMount: true,
  dataRoot: '/tmp/evaluation-proof-tests',
  packageRoot: '/app',
  checkedAt: 1,
};
const EMPTY_INJECTIONS: RunInjectionAttribution = {
  patterns: [],
  skillNotes: [],
  cases: [],
  phaseHints: [],
  knowledgeDocs: [],
};

function manifestForEvaluationStart(
  start: EvaluationEnvironmentStartV1,
  runId: string,
  overrides: Partial<RunManifestV1> = {},
): RunManifestV1 {
  return {
    schemaVersion: 1,
    runManifestId: `manifest-${runId}`,
    runId,
    sessionId: `session-${runId}`,
    sealedAt: Date.parse(start.capturedAt) + 1,
    scope: start.scope,
    sceneType: 'general',
    promptTemplateHashes: [],
    skills: [],
    skillRegistryFingerprint: 'registry-a',
    evolutionOverlayGeneration: start.pinned.overlayGeneration,
    sqlStatementCount: 0,
    sqlErrorCount: 0,
    runtime: start.pinned.runtime,
    providerId: start.pinned.providerId,
    ...(start.pinned.model === undefined ? {} : {model: start.pinned.model}),
    outputLanguage: start.pinned.outputLanguage,
    toolAllowlistHash: start.pinned.toolAllowlistHash,
    featureFlagSnapshot: evaluationEnvironmentManifestBinding(start),
    analysisMode: 'full',
    resolvedMode: 'full',
    capabilityFlags: [],
    injections: start.injections,
    turns: 1,
    wallclockMs: 100,
    ...overrides,
  };
}

describe('evaluation environment proof', () => {
  let directory: string;
  let service: ProviderService;
  let providerId: string;
  let pinned: EvalPinnedEnvironmentV1;
  let manifestStore: RunManifestStore;

  beforeEach(async () => {
    directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'evaluation-proof-'));
    service = new ProviderService(path.join(directory, 'providers.json'));
    providerId = service.create({
      name: 'Eval Provider',
      category: 'official',
      type: 'openai',
      models: {primary: 'gpt-eval', light: 'gpt-eval-light'},
      connection: {
        agentRuntime: 'openai-agents-sdk',
        openaiApiKey: 'eval-secret',
      },
    }).id;
    pinned = {
      runtime: 'openai-agents-sdk',
      providerId,
      model: 'gpt-eval',
      outputLanguage: 'zh-CN',
      toolAllowlistHash: canonicalContentHash(['query_trace']),
      injections: 'off',
      overlayGeneration: 'builtin:registry-a',
    };
    manifestStore = new RunManifestStore({
      persistence: persistenceUnavailable,
    });
  });

  afterEach(async () => {
    manifestStore.close();
    await fsp.rm(directory, {recursive: true, force: true});
  });

  function start(): EvaluationEnvironmentStartV1 {
    return captureEvaluationEnvironmentStart({
      providerService: service,
      scope: {tenantId: 'local', workspaceId: 'local'},
      pinned,
      selector: {
        schemaVersion: 1,
        mode: pinned.injections,
        selected: EMPTY_INJECTIONS,
      },
      capturedAt: '2026-07-29T00:00:00.000Z',
    });
  }

  function finalize(
    environmentStart: EvaluationEnvironmentStartV1,
    runId: string,
    overrides: Partial<RunManifestV1> = {},
  ): EvaluationEnvironmentProofV1 {
    const manifest = manifestForEvaluationStart(
      environmentStart,
      runId,
      overrides,
    );
    manifestStore.append(environmentStart.scope, manifest);
    return finalizeEvaluationEnvironmentProof({
      providerService: service,
      runManifestStore: manifestStore,
      start: environmentStart,
      runManifestId: manifest.runManifestId,
      capturedAt: '2026-07-29T00:01:00.000Z',
    });
  }

  function scoreFor(proof: EvaluationEnvironmentProofV1): EvalScoreV1 {
    return {
      schemaVersion: 1,
      caseId: 'case-a',
      evalSetId: 'set-a',
      runId: proof.runId,
      runManifestId: proof.runManifestId,
      attempt: 1,
      role: 'baseline',
      scope: proof.scope,
      pinned: proof.pinned,
      availability: 'available',
      l0: {
        runOk: true,
        sqlErrorFree: true,
        reportContractPass: true,
        skillCrashFree: true,
      },
      l1: {
        claimVerifiedRatio: 1,
        unsupportedClaims: 0,
        evidenceAnchors: 2,
      },
      l3: {turns: 1, wallclockMs: 100, toolCalls: 1},
    };
  }

  it('binds the proof to a sealed manifest and a stable provider environment', () => {
    const environmentStart = start();
    const proof = finalize(environmentStart, 'run-a');

    expect(parseEvaluationEnvironmentStart(environmentStart))
      .toEqual(environmentStart);
    expect(parseEvaluationEnvironmentProof(proof)).toEqual(proof);
    expect(proof.evaluationStartContentHash).toBe(environmentStart.contentHash);
    expect(proof.injectionSetHash).toBe(
      canonicalContentHash(EMPTY_INJECTIONS),
    );
    expect(assertEvaluationProofMatchesScore(scoreFor(proof), proof))
      .toEqual(proof);
    expect(JSON.stringify(proof)).not.toContain('eval-secret');
  });

  it('rejects provider mutations during a run, including A to B to A', () => {
    const environmentStart = start();
    service.activate(providerId);
    service.activate(providerId);

    const manifest = manifestForEvaluationStart(environmentStart, 'run-mutated');
    manifestStore.append(environmentStart.scope, manifest);
    expect(() => finalizeEvaluationEnvironmentProof({
      providerService: service,
      runManifestStore: manifestStore,
      start: environmentStart,
      runManifestId: manifest.runManifestId,
    })).toThrow('evaluation_environment_changed_during_run');
  });

  it('compares two completed runs only when their final proofs match', () => {
    const baseline = finalize(start(), 'baseline');
    const candidate = finalize(start(), 'candidate');
    expect(() => assertComparableEvaluationProofs(baseline, candidate))
      .not.toThrow();

    service.activate(providerId);
    const changed = finalize(start(), 'changed');
    expect(() => assertComparableEvaluationProofs(baseline, changed))
      .toThrow('evaluation_environment_not_comparable');
  });

  it('fails closed while a provider mutation lease is visible', () => {
    const spy = jest.spyOn(service, 'getMutationGeneration');
    const stable = service.getMutationGeneration();
    spy.mockReturnValue({
      ...stable,
      entries: stable.entries.map(entry => ({...entry, inFlight: 1})),
    });

    expect(() => start()).toThrow(
      'evaluation_environment_provider_mutation_in_flight',
    );
  });

  it('retries a torn generation read and binds the accepted revision', () => {
    const stable = service.getMutationGeneration();
    const changed = {
      ...stable,
      entries: stable.entries.map(entry => ({
        ...entry,
        revision: entry.revision + 2,
      })),
    };
    const spy = jest.spyOn(service, 'getMutationGeneration');
    spy
      .mockReturnValueOnce(stable)
      .mockReturnValueOnce(changed)
      .mockReturnValueOnce(changed)
      .mockReturnValueOnce(changed);

    const environmentStart = start();
    expect(environmentStart.providerMutationGeneration).toEqual(changed);
    expect(spy).toHaveBeenCalledTimes(4);
  });

  it('rejects forged selector, injection, and start bindings in the manifest', () => {
    expect(() => captureEvaluationEnvironmentStart({
      providerService: service,
      scope: {tenantId: 'local', workspaceId: 'local'},
      pinned,
      selector: {
        schemaVersion: 1,
        mode: 'off',
        selected: {
          ...EMPTY_INJECTIONS,
          patterns: [{id: 'pattern-a', contentHash: 'a'.repeat(64)}],
        },
      },
    })).toThrow('evaluation_environment_off_injections_not_empty');

    const environmentStart = start();
    const injectedManifest = manifestForEvaluationStart(
      environmentStart,
      'run-injected',
      {
        injections: {
          ...EMPTY_INJECTIONS,
          patterns: [{id: 'pattern-a', contentHash: 'a'.repeat(64)}],
        },
      },
    );
    manifestStore.append(environmentStart.scope, injectedManifest);
    expect(() => finalizeEvaluationEnvironmentProof({
      providerService: service,
      runManifestStore: manifestStore,
      start: environmentStart,
      runManifestId: injectedManifest.runManifestId,
    })).toThrow('evaluation_environment_run_manifest_environment_mismatch');

    const forgedBinding = manifestForEvaluationStart(
      environmentStart,
      'run-forged',
      {featureFlagSnapshot: {}},
    );
    manifestStore.append(environmentStart.scope, forgedBinding);
    expect(() => finalizeEvaluationEnvironmentProof({
      providerService: service,
      runManifestStore: manifestStore,
      start: environmentStart,
      runManifestId: forgedBinding.runManifestId,
    })).toThrow('evaluation_environment_run_manifest_binding_mismatch');
  });

  it('requires an explicit matching provider scope for enterprise generations', () => {
    const local = service.getMutationGeneration();
    jest.spyOn(service, 'getMutationGeneration').mockReturnValue({
      ...local,
      entries: [{
        scope: {
          level: 'org',
          tenantId: 'tenant-a',
          workspaceId: null,
          userId: null,
        },
        revision: 1,
        inFlight: 0,
      }],
    });

    expect(() => captureEvaluationEnvironmentStart({
      providerService: service,
      scope: {tenantId: 'tenant-a', workspaceId: 'workspace-a'},
      pinned,
      selector: {
        schemaVersion: 1,
        mode: 'off',
        selected: EMPTY_INJECTIONS,
      },
    })).toThrow('evaluation_environment_provider_scope_required');
  });

  it('fails closed for ambient environment providers without a mutation generation', () => {
    expect(() => captureEvaluationEnvironmentStart({
      providerService: service,
      scope: {tenantId: 'local', workspaceId: 'local'},
      pinned: {...pinned, providerId: null},
      selector: {
        schemaVersion: 1,
        mode: 'off',
        selected: EMPTY_INJECTIONS,
      },
    })).toThrow('evaluation_environment_managed_provider_required');
  });

  it('rejects self-consistent forged ambient start and proof records', () => {
    const environmentStart = start();
    const nullPinned = {...environmentStart.pinned, providerId: null};
    const forgedStartWithoutContentHash = {
      ...environmentStart,
      pinned: nullPinned,
      environmentFingerprint: __testing.environmentFingerprint({
        pinned: nullPinned,
        providerSnapshotHash: environmentStart.providerSnapshotHash,
        providerMutationGenerationFingerprint:
          environmentStart.providerMutationGenerationFingerprint,
        injectionSetHash: environmentStart.injectionSetHash,
        injectionSelectorConfigFingerprint:
          environmentStart.injectionSelectorConfigFingerprint,
      }),
    };
    const {
      contentHash: _ignoredStartHash,
      ...forgedStartPayload
    } = forgedStartWithoutContentHash;
    const forgedStart = {
      ...forgedStartPayload,
      contentHash: __testing.startContentHash(forgedStartPayload),
    };
    expect(() => parseEvaluationEnvironmentStart(forgedStart))
      .toThrow('evaluation_environment_managed_provider_required');

    const proof = finalize(environmentStart, 'run-managed');
    const forgedProofWithoutContentHash = {
      ...proof,
      pinned: nullPinned,
      environmentFingerprint: __testing.environmentFingerprint({
        pinned: nullPinned,
        providerSnapshotHash: proof.providerSnapshotHash,
        providerMutationGenerationFingerprint:
          proof.providerMutationGenerationFingerprint,
        injectionSetHash: proof.injectionSetHash,
        injectionSelectorConfigFingerprint:
          proof.injectionSelectorConfigFingerprint,
      }),
    };
    const {
      contentHash: _ignoredProofHash,
      ...forgedProofPayload
    } = forgedProofWithoutContentHash;
    const forgedProof = {
      ...forgedProofPayload,
      contentHash: __testing.proofContentHash(forgedProofPayload),
    };
    expect(() => parseEvaluationEnvironmentProof(forgedProof))
      .toThrow('evaluation_environment_managed_provider_required');
  });

  it('detects tampering in both start and final proof records', () => {
    const environmentStart = start();
    expect(() => parseEvaluationEnvironmentStart({
      ...environmentStart,
      providerSnapshotHash: 'b'.repeat(64),
    })).toThrow('evaluation_environment_start_fingerprint_mismatch');

    const proof = finalize(environmentStart, 'run-tamper');
    expect(() => parseEvaluationEnvironmentProof({
      ...proof,
      providerSnapshotHash: 'b'.repeat(64),
    })).toThrow('evaluation_environment_proof_fingerprint_mismatch');
  });
});
