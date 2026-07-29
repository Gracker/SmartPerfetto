// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'fs';
import os from 'os';
import path from 'path';

import {ProviderService} from '../../providerManager/providerService';
import type {
  EvalCaseV1,
  EvalPinnedEnvironmentV1,
  EvalScoreV1,
  RunInjectionAttribution,
  RunManifestV1,
  SelfEvolutionPersistenceCapability,
} from '../../../types/selfEvolution';
import {canonicalContentHash} from '../canonicalJson';
import {EvalCaseStore} from '../evalCaseStore';
import {
  captureEvaluationEnvironmentStart,
  evaluationEnvironmentManifestBinding,
  finalizeEvaluationEnvironmentProof,
  type EvaluationEnvironmentStartV1,
} from '../evaluationEnvironmentProof';
import {RunManifestStore} from '../runManifestStore';
import {
  createEvaluationRoleInjectionContract,
  sealEvaluationExposureReceipt,
  withEvaluationInjectionContext,
} from '../evaluationInjectionContext';
import {
  createEvaluationMaterializationProof,
  createEvaluationRoleProofV2,
} from '../evaluationPairAttestation';
import {EvaluationReplayPublisher} from '../evaluationReplayPublisher';

const persistenceUnavailable: SelfEvolutionPersistenceCapability = {
  persistence: 'unavailable',
  reason: 'data_root_not_writable',
  configured: true,
  writable: false,
  outsidePackage: true,
  externalMount: true,
  dataRoot: '/tmp/evaluation-replay-publisher-tests',
  packageRoot: '/app',
  checkedAt: 1,
};
const scope = {tenantId: 'local', workspaceId: 'local'};
const EMPTY_INJECTIONS: RunInjectionAttribution = {
  patterns: [],
  skillNotes: [],
  cases: [],
  phaseHints: [],
  knowledgeDocs: [],
};
const treatmentRef = {
  category: 'phaseHints' as const,
  id: 'candidate-hint-a',
  contentHash: 'a'.repeat(64),
};

function manifest(
  start: EvaluationEnvironmentStartV1,
): RunManifestV1 {
  return {
    schemaVersion: 1,
    runManifestId: 'manifest-baseline',
    runId: 'run-baseline',
    sessionId: 'session-baseline',
    sealedAt: Date.parse(start.capturedAt) + 1,
    scope,
    sceneType: 'startup',
    promptTemplateHashes: [],
    skills: [],
    skillRegistryFingerprint: 'registry',
    evolutionOverlayGeneration: start.pinned.overlayGeneration,
    sqlStatementCount: 0,
    sqlErrorCount: 0,
    runtime: start.pinned.runtime,
    providerId: start.pinned.providerId,
    model: start.pinned.model,
    outputLanguage: start.pinned.outputLanguage,
    toolAllowlistHash: start.pinned.toolAllowlistHash,
    featureFlagSnapshot: evaluationEnvironmentManifestBinding(start),
    analysisMode: 'full',
    resolvedMode: 'full',
    capabilityFlags: [],
    injections: start.injections,
    turns: 1,
    wallclockMs: 10,
  };
}

describe('EvaluationReplayPublisher', () => {
  let directory: string;
  let providerService: ProviderService;
  let manifestStore: RunManifestStore;
  let evalStore: EvalCaseStore;
  let pinned: EvalPinnedEnvironmentV1;
  let evalCase: EvalCaseV1;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-publisher-'));
    providerService = new ProviderService(
      path.join(directory, 'providers.json'),
    );
    const providerId = providerService.create({
      name: 'Evaluation provider',
      category: 'official',
      type: 'openai',
      models: {primary: 'gpt-eval', light: 'gpt-eval-light'},
      connection: {
        agentRuntime: 'openai-agents-sdk',
        openaiApiKey: 'secret',
      },
    }).id;
    pinned = {
      runtime: 'openai-agents-sdk',
      providerId,
      model: 'gpt-eval',
      outputLanguage: 'zh-CN',
      toolAllowlistHash: canonicalContentHash(['query_trace']),
      injections: 'on',
      overlayGeneration: 'builtin:registry',
    };
    evalCase = {
      schemaVersion: 1,
      caseId: 'case-a',
      evalSetId: 'set-a',
      origin: 'manual_golden',
      scope,
      traces: [{
        role: 'current',
        catalogAlias: 'trace-a',
        contentHash: 'b'.repeat(64),
      }],
      query: 'Analyze startup.',
      analysisMode: 'full',
      split: 'validation',
      createdAt: '2026-07-29T00:00:00.000Z',
    };
    manifestStore = new RunManifestStore({
      persistence: persistenceUnavailable,
    });
    evalStore = new EvalCaseStore({
      persistence: persistenceUnavailable,
      corpusRoot: path.join(directory, 'corpus'),
    });
    evalStore.putCase(scope, evalCase);
  });

  afterEach(() => {
    evalStore.close();
    manifestStore.close();
    fs.rmSync(directory, {recursive: true, force: true});
  });

  function environmentStart(): EvaluationEnvironmentStartV1 {
    return captureEvaluationEnvironmentStart({
      providerService,
      scope,
      pinned,
      selector: {
        schemaVersion: 1,
        mode: 'on',
        selected: EMPTY_INJECTIONS,
      },
      capturedAt: '2026-07-29T00:00:00.000Z',
    });
  }

  it('uses the M4 cache but rejects stale M5 role-treatment proof bindings', async () => {
    const start = environmentStart();
    const runManifest = manifest(start);
    manifestStore.append(scope, runManifest);
    const environmentProof = finalizeEvaluationEnvironmentProof({
      providerService,
      runManifestStore: manifestStore,
      start,
      runManifestId: runManifest.runManifestId,
      capturedAt: '2026-07-29T00:00:01.000Z',
    });
    const roleContract = createEvaluationRoleInjectionContract({
      role: 'baseline',
      mode: 'on',
      selected: EMPTY_INJECTIONS,
      reservedTreatmentNamespace: [treatmentRef],
      expectedMaterializedRefs: [],
      expectedObservedRefs: [],
      forbiddenObservedRefs: [treatmentRef],
    });
    const exposureReceipt = await withEvaluationInjectionContext({
      contract: roleContract,
    }, async () => sealEvaluationExposureReceipt());
    const roleProof = createEvaluationRoleProofV2({
      role: 'baseline',
      baseProof: environmentProof,
      contract: roleContract,
      materialization: createEvaluationMaterializationProof({
        artifactId: 'baseline:candidate-a',
        baseRegistryContentHash: 'c'.repeat(64),
        persistentOverlayGeneration: pinned.overlayGeneration,
        treatmentGeneration: 'evaluation:baseline',
        materializedRefs: [],
        effectiveSkillRegistryFingerprint: 'd'.repeat(64),
        effectiveStrategyRegistryFingerprint: 'e'.repeat(64),
      }),
      exposureReceipt,
      commonBaseRegistryContentHash: 'c'.repeat(64),
    });
    const score: EvalScoreV1 = {
      schemaVersion: 1,
      caseId: evalCase.caseId,
      evalSetId: evalCase.evalSetId,
      runId: environmentProof.runId,
      runManifestId: environmentProof.runManifestId,
      attempt: 1,
      role: 'baseline',
      scope,
      pinned,
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
        evidenceAnchors: 1,
      },
      l3: {
        turns: 1,
        wallclockMs: 10,
        estimatedTokens: 5,
        toolCalls: 1,
      },
    };
    let currentTreatmentHash = 'f'.repeat(64);
    let publicationCommitted = false;
    const publisher = new EvaluationReplayPublisher({
      persistence: persistenceUnavailable,
      evalCaseStore: evalStore,
      resolveBaselineContext: () => ({
        environmentStart: environmentStart(),
        roleContract,
        fullTreatmentContractHash: currentTreatmentHash,
      }),
      isPublicationCommitted: () => publicationCommitted,
    });
    const resultRef = await publisher.publish({
      score,
      environmentProof,
      roleProof,
      roleContract,
      fullTreatmentContractHash: currentTreatmentHash,
      frozenArtifactsHash: '1'.repeat(64),
      executionFence: {
        taskId: 'task-a',
        executionToken: 'token-a',
      },
      isAuthoritative: () => true,
    });
    expect(evalStore.getScore(scope, resultRef)).toBeUndefined();
    expect(await publisher.lookupBaseline({
      evalCase,
      pinned,
      candidateId: 'candidate-a',
    })).toBeUndefined();
    expect(await publisher.loadPublished({scope, resultRef}))
      .toBeUndefined();

    publicationCommitted = true;
    await publisher.commitPublication({scope, resultRef});
    expect(evalStore.getScore(scope, resultRef)).toEqual(score);
    expect((await publisher.lookupBaseline({
      evalCase,
      pinned,
      candidateId: 'candidate-a',
    }))?.resultRef).toBe(resultRef);

    publicationCommitted = false;
    expect(await publisher.lookupBaseline({
      evalCase,
      pinned,
      candidateId: 'candidate-a',
    })).toBeUndefined();
    expect(await publisher.loadPublished({scope, resultRef}))
      .toBeUndefined();

    publicationCommitted = true;
    currentTreatmentHash = '2'.repeat(64);
    expect(await publisher.lookupBaseline({
      evalCase,
      pinned,
      candidateId: 'candidate-b',
    })).toBeUndefined();
    await expect(publisher.publish({
      score,
      environmentProof,
      roleProof,
      roleContract,
      fullTreatmentContractHash: currentTreatmentHash,
      frozenArtifactsHash: '1'.repeat(64),
      executionFence: {
        taskId: 'task-a',
        executionToken: 'token-a',
      },
      isAuthoritative: () => false,
    })).rejects.toThrow('evaluation_execution_fence_lost');
    publisher.close();
  });
});
