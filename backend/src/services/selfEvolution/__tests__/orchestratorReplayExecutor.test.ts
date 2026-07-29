// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {createHash} from 'crypto';
import {EventEmitter} from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';

import type {
  AnalysisOptions,
  AnalysisResult,
  IOrchestrator,
} from '../../../agent/core/orchestratorTypes';
import type {TraceProcessorService} from '../../traceProcessorService';
import {ProviderService} from '../../providerManager/providerService';
import type {
  EvalCaseV1,
  SelfEvolutionPersistenceCapability,
} from '../../../types/selfEvolution';
import {canonicalContentHash} from '../canonicalJson';
import {EvalCaseStore} from '../evalCaseStore';
import {
  commitEvaluationExposureSince,
  createEvaluationRoleInjectionContract,
  currentEvaluationInjectionContract,
  evaluationExposureCursor,
  registerEvaluationInjection,
  type EvaluationInjectionRefV1,
} from '../evaluationInjectionContext';
import {
  buildEffectiveRuntimeRegistrySnapshot,
} from '../effectiveRuntimeRegistryProvider';
import {
  OrchestratorReplayExecutor,
} from '../orchestratorReplayExecutor';
import {recordEvaluationObservedTokenDelta} from '../evaluationTelemetry';
import {
  createEvaluationTreatmentArtifact,
  evaluationFullTreatmentContractHash,
  evaluationSkillNoteInjectionContentHash,
  resolveEvaluationRoleVariant,
} from '../evaluationTreatment';
import {RunManifestStore} from '../runManifestStore';

const persistenceUnavailable: SelfEvolutionPersistenceCapability = {
  persistence: 'unavailable',
  reason: 'data_root_not_writable',
  configured: true,
  writable: false,
  outsidePackage: true,
  externalMount: true,
  dataRoot: '/tmp/orchestrator-replay-executor-tests',
  packageRoot: '/app',
  checkedAt: 1,
};
const scope = {tenantId: 'local', workspaceId: 'local'};
const EMPTY_INJECTIONS = {
  patterns: [],
  skillNotes: [],
  cases: [],
  phaseHints: [],
  knowledgeDocs: [],
};

class FakeOrchestrator extends EventEmitter implements IOrchestrator {
  async analyze(
    _query: string,
    sessionId: string,
    _traceId: string,
    options?: AnalysisOptions,
  ): Promise<AnalysisResult> {
    options?.runManifestAttributionSink?.recordToolAllowlist(['query_trace']);
    const cursor = evaluationExposureCursor();
    for (
      const ref of
      currentEvaluationInjectionContract()?.expectedMaterializedRefs ?? []
    ) {
      registerEvaluationInjection({
        ...ref,
        placement: 'test:sdk_handoff',
      });
      options?.runManifestAttributionSink?.recordInjection(
        ref.category,
        ref.id,
        ref.contentHash,
      );
    }
    commitEvaluationExposureSince(cursor, 'sdk_handoff_observed');
    recordEvaluationObservedTokenDelta(12);
    return {
      sessionId,
      success: true,
      findings: [],
      hypotheses: [],
      conclusion: 'The replay completed with verified evidence.',
      confidence: 1,
      rounds: 1,
      totalDurationMs: 1,
      claimVerificationResult: {
        schemaVersion: 'claim_verifier@1',
        status: 'passed',
        policy: 'record_only',
        passed: true,
        checkedClaimCount: 1,
        unsupportedClaimCount: 0,
        claimResults: [{
          claimId: 'claim-a',
          status: 'verified',
          referenceResults: [{
            evidenceRefId: 'evidence-a',
            status: 'matched',
          }],
        }],
        issues: [],
      },
    };
  }

  reset(): void {}
}

describe('OrchestratorReplayExecutor', () => {
  let directory: string;
  let providerService: ProviderService;
  let runManifestStore: RunManifestStore;
  let evalCaseStore: EvalCaseStore;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(
      os.tmpdir(),
      'orchestrator-replay-executor-',
    ));
    providerService = new ProviderService(
      path.join(directory, 'providers.json'),
    );
    runManifestStore = new RunManifestStore({
      persistence: persistenceUnavailable,
    });
    evalCaseStore = new EvalCaseStore({
      persistence: persistenceUnavailable,
      corpusRoot: path.join(directory, 'corpus'),
    });
  });

  afterEach(() => {
    evalCaseStore.close();
    runManifestStore.close();
    fs.rmSync(directory, {recursive: true, force: true});
  });

  it('runs real role-scoped orchestration over a verified trace copy', async () => {
    const traceSource = path.join(directory, 'source.pftrace');
    const traceBytes = Buffer.from('verified replay trace');
    fs.writeFileSync(traceSource, traceBytes);
    const traceHash = createHash('sha256').update(traceBytes).digest('hex');
    const corpus = evalCaseStore.importTrace({
      scope,
      sourcePath: traceSource,
      expectedContentHash: traceHash,
      createdAt: '2026-07-29T00:00:00.000Z',
    });
    const evalCase: EvalCaseV1 = {
      schemaVersion: 1,
      caseId: 'case-a',
      evalSetId: 'set-a',
      origin: 'manual_golden',
      scope,
      traces: [{
        role: 'current',
        corpusId: corpus.corpusId,
        contentHash: corpus.contentHash,
      }],
      query: 'A deliberately unmatched evaluation query.',
      analysisMode: 'full',
      split: 'validation',
      createdAt: '2026-07-29T00:00:00.000Z',
    };
    evalCaseStore.putCase(scope, evalCase);

    const providerId = providerService.create({
      name: 'Replay provider',
      category: 'official',
      type: 'openai',
      models: {primary: 'gpt-eval', light: 'gpt-eval-light'},
      connection: {
        agentRuntime: 'openai-agents-sdk',
        openaiApiKey: 'secret',
      },
    }).id;
    const common = await buildEffectiveRuntimeRegistrySnapshot({scope});
    const baseSkill = common.skillRegistry.getAllSkills()[0];
    expect(baseSkill).toBeDefined();
    const candidateNote = {
      schemaVersion: 1 as const,
      noteId: 'candidate-note',
      content: 'Candidate-only replay guidance.',
      keywords: ['candidate'],
    };
    const candidateRef: EvaluationInjectionRefV1 = {
      category: 'skillNotes',
      id: candidateNote.noteId,
      contentHash: evaluationSkillNoteInjectionContentHash(candidateNote),
    };
    const artifact = createEvaluationTreatmentArtifact({
      artifactId: 'candidate-a',
      scope,
      baseSkillRegistryFingerprint:
        common.skillRegistry.registryFingerprint,
      baseStrategyRegistryFingerprint:
        common.strategyRegistry.registryFingerprint,
      entries: [{
        kind: 'skill_note',
        op: 'add',
        skillId: baseSkill.name,
        noteId: candidateNote.noteId,
        after: candidateNote,
      }],
      createdAt: '2026-07-29T00:00:00.000Z',
    });
    const roleVariant = resolveEvaluationRoleVariant({
      artifact,
      scope,
      baseSkillRegistryFingerprint:
        common.skillRegistry.registryFingerprint,
      baseStrategyRegistryFingerprint:
        common.strategyRegistry.registryFingerprint,
    });
    const fullTreatmentContractHash =
      evaluationFullTreatmentContractHash(roleVariant);
    const traceServiceCalls = {
      registered: 0,
      ensured: 0,
      cleaned: 0,
      deleted: 0,
    };
    const traceProcessorService = {
      registerStoredTrace: () => {
        traceServiceCalls.registered += 1;
      },
      ensureProcessorForLease: async () => {
        traceServiceCalls.ensured += 1;
      },
      runWithLeases: async (
        _leases: unknown,
        callback: () => Promise<unknown>,
      ) => callback(),
      cleanupLeaseProcessor: () => {
        traceServiceCalls.cleaned += 1;
      },
      deleteTrace: async () => {
        traceServiceCalls.deleted += 1;
      },
    } as unknown as TraceProcessorService;
    const executor = new OrchestratorReplayExecutor({
      evalCaseStore,
      traceProcessorService,
      providerService,
      runManifestStore,
      resolveRolePlan: ({replay, commonRegistry}) => {
        const baseline = replay.role === 'baseline';
        return {
          roleVariant,
          injectionContract: createEvaluationRoleInjectionContract({
            role: replay.role,
            mode: 'on',
            selected: EMPTY_INJECTIONS,
            reservedTreatmentNamespace: [candidateRef],
            expectedMaterializedRefs: baseline ? [] : [candidateRef],
            expectedObservedRefs: baseline
              ? []
              : [{
                  ref: candidateRef,
                  minimumGuarantee: 'sdk_handoff_observed',
                }],
            forbiddenObservedRefs: baseline ? [candidateRef] : [],
          }),
          fullTreatmentContractHash,
        };
      },
      resolveBudgetLimits: () => ({
        schemaVersion: 1,
        maxTokens: 100,
        maxToolCalls: 10,
        maxWallclockMs: 10_000,
        maxTraceProcessorCpuMs: 1_000,
      }),
      resolveCapabilities: () => ({
        schemaVersion: 1,
        runtime: 'openai-agents-sdk',
        tokens: 'soft_response_observed',
        toolCalls: 'hard_realtime',
        wallclock: 'hard_realtime',
        traceProcessorCpu: 'sampled_bounded',
        exposure: 'sdk_handoff_observed',
      }),
      createOrchestrator: () => new FakeOrchestrator(),
      createCpuSampler: options => ({
        start: () => options.recordSample(0, {
          platform: process.platform,
          sampleIntervalMs: 10,
          staleThresholdMs: 20,
          logicalCpuCount: 1,
        }),
        stop: () => options.recordSample(1, {
          platform: process.platform,
          sampleIntervalMs: 10,
          staleThresholdMs: 20,
          logicalCpuCount: 1,
        }),
      }),
    });
    const pinned = {
      runtime: 'openai-agents-sdk' as const,
      providerId,
      model: 'gpt-eval',
      outputLanguage: 'zh-CN',
      toolAllowlistHash: canonicalContentHash(['query_trace']),
      injections: 'on' as const,
      overlayGeneration: common.overlayGeneration,
    };

    const baseline = await executor.execute({
      replayRunId: 'replay-a',
      evalCase,
      role: 'baseline',
      candidateId: artifact.artifactId,
      pinned,
      attempt: 1,
      priorUsage: {
        schemaVersion: 1,
        tokens: 0,
        toolCalls: 0,
        wallclockMs: 0,
        traceProcessorCpuMs: 0,
      },
      signal: new AbortController().signal,
      isAuthoritative: () => true,
    });
    const candidate = await executor.execute({
      replayRunId: 'replay-a',
      evalCase,
      role: 'candidate',
      candidateId: artifact.artifactId,
      pinned,
      attempt: 1,
      priorUsage: {
        schemaVersion: 1,
        tokens: 0,
        toolCalls: 0,
        wallclockMs: 0,
        traceProcessorCpuMs: 0,
      },
      signal: new AbortController().signal,
      isAuthoritative: () => true,
    });

    expect(baseline.roleProof.materialization.materializedRefs).toEqual([]);
    expect(candidate.roleProof.materialization.materializedRefs)
      .toEqual([candidateRef]);
    expect(candidate.artifacts.usageReceipt.tokens).toMatchObject({
      used: 12,
      guarantee: 'soft_observed',
    });
    expect(candidate.artifacts.usageReceipt.traceProcessorCpu).toMatchObject({
      usedMs: 1,
      guarantee: 'soft_observed',
    });
    expect(traceServiceCalls).toEqual({
      registered: 2,
      ensured: 2,
      cleaned: 2,
      deleted: 2,
    });
    expect(fs.existsSync(path.join(directory, 'current.pftrace'))).toBe(false);
  });
});
