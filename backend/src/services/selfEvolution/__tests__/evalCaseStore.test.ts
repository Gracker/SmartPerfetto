// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {createHash} from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {ProviderService} from '../../providerManager/providerService';
import type {
  EvalCaseV1,
  EvalPinnedEnvironmentV1,
  EvalScoreV1,
  RunInjectionAttribution,
  RunManifestScope,
  RunManifestV1,
  SelfEvolutionPersistenceCapability,
} from '../../../types/selfEvolution';
import {canonicalContentHash} from '../canonicalJson';
import {
  assertBaselineCacheTokenComparable,
  EvalCaseStore,
} from '../evalCaseStore';
import {
  captureEvaluationEnvironmentStart,
  evaluationEnvironmentManifestBinding,
  finalizeEvaluationEnvironmentProof,
  type EvaluationEnvironmentProofV1,
  type EvaluationEnvironmentStartV1,
} from '../evaluationEnvironmentProof';
import {RunManifestStore} from '../runManifestStore';

const persistenceAvailable: SelfEvolutionPersistenceCapability = {
  persistence: 'available',
  configured: true,
  writable: true,
  outsidePackage: true,
  externalMount: true,
  dataRoot: '/tmp/smartperfetto-eval-store-tests',
  packageRoot: '/app',
  checkedAt: 1,
};
const persistenceUnavailable: SelfEvolutionPersistenceCapability = {
  ...persistenceAvailable,
  persistence: 'unavailable',
  reason: 'data_root_not_writable',
  writable: false,
};
const scope: RunManifestScope = {
  tenantId: 'local',
  workspaceId: 'local',
};
const otherScope: RunManifestScope = {
  tenantId: 'tenant-b',
  workspaceId: 'workspace-b',
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

function evalCase(
  caseId = 'case-a',
  caseScope = scope,
): EvalCaseV1 {
  return {
    schemaVersion: 1,
    caseId,
    evalSetId: 'set-a',
    origin: 'synthetic_seed',
    scope: caseScope,
    traces: [{
      role: 'current',
      catalogAlias: 'startup-lifecycle',
      contentHash: 'a'.repeat(64),
    }],
    query: 'Analyze startup latency.',
    analysisMode: 'full',
    expectedScene: 'startup',
    goldenPoints: ['Find the blocking startup slice.'],
    split: 'validation',
    createdAt: '2026-07-29T00:00:00.000Z',
  };
}

function scoreFor(
  proof: EvaluationEnvironmentProofV1,
  overrides: Partial<EvalScoreV1> = {},
): EvalScoreV1 {
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
      evidenceAnchors: 3,
    },
    l3: {turns: 2, wallclockMs: 1000, toolCalls: 2},
    ...overrides,
  };
}

describe('EvalCaseStore', () => {
  let directory: string;
  let databasePath: string;
  let corpusRoot: string;
  let providerService: ProviderService;
  let providerId: string;
  let pinned: EvalPinnedEnvironmentV1;
  let manifestStore: RunManifestStore;
  const stores: EvalCaseStore[] = [];

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-case-store-'));
    databasePath = path.join(directory, 'eval.db');
    corpusRoot = path.join(directory, 'corpus');
    providerService = new ProviderService(path.join(directory, 'providers.json'));
    providerId = providerService.create({
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

  afterEach(() => {
    manifestStore.close();
    stores.splice(0).forEach(store => store.close());
    fs.rmSync(directory, {recursive: true, force: true});
  });

  function store(
    persistence = persistenceAvailable,
    options: Partial<ConstructorParameters<typeof EvalCaseStore>[0]> = {},
  ): EvalCaseStore {
    const instance = new EvalCaseStore({
      persistence,
      databasePath,
      corpusRoot,
      ...options,
    });
    stores.push(instance);
    return instance;
  }

  function proof(
    runId: string,
    proofId?: string,
    evalScope: RunManifestScope = scope,
  ): EvaluationEnvironmentProofV1 {
    const environmentStart = environment(evalScope);
    const manifest = manifestForEvaluationStart(environmentStart, runId);
    manifestStore.append(evalScope, manifest);
    return finalizeEvaluationEnvironmentProof({
      providerService,
      runManifestStore: manifestStore,
      start: environmentStart,
      runManifestId: manifest.runManifestId,
      proofId,
      capturedAt: '2026-07-29T00:00:01.000Z',
    });
  }

  function environment(
    evalScope: RunManifestScope = scope,
  ): EvaluationEnvironmentStartV1 {
    return captureEvaluationEnvironmentStart({
      providerService,
      scope: evalScope,
      pinned,
      selector: {
        schemaVersion: 1,
        mode: 'off',
        selected: EMPTY_INJECTIONS,
      },
      capturedAt: '2026-07-29T00:00:00.000Z',
    });
  }

  it('persists immutable cases idempotently with scope-qualified reads', () => {
    const first = store();
    const value = evalCase();
    expect(first.putCase(scope, value)).toMatchObject({idempotent: false});
    expect(first.putCase(scope, value)).toMatchObject({idempotent: true});
    expect(first.getCase(otherScope, value.caseId)).toBeUndefined();
    expect(() => first.putCase(scope, {
      ...value,
      query: 'Changed query',
    })).toThrow('eval_case_conflict');
    first.close();

    const reopened = store();
    expect(reopened.getCase(scope, value.caseId)).toEqual(value);
  });

  it('stores a score and immutable environment proof atomically', () => {
    const instance = store();
    instance.putCase(scope, evalCase());
    const firstProof = proof('run-a', 'proof-stable-id');
    const score = scoreFor(firstProof);
    const stored = instance.storeScoreWithProof(scope, score, firstProof);
    expect(stored).toMatchObject({idempotent: false, storage: 'sqlite'});
    expect(instance.storeScoreWithProof(scope, score, firstProof))
      .toMatchObject({idempotent: true});
    expect(instance.getScore(scope, stored.scoreKey)).toEqual(score);
    expect(instance.getScore(otherScope, stored.scoreKey)).toBeUndefined();
    expect(instance.getProof(scope, firstProof.proofId)).toEqual(firstProof);
    expect(instance.getScoreWithProof(scope, stored.scoreKey)).toEqual({
      scoreKey: stored.scoreKey,
      score,
      proof: firstProof,
    });
    expect(instance.listScores(scope, {role: 'baseline'}))
      .toEqual([{
        scoreKey: stored.scoreKey,
        score,
        proof: firstProof,
      }]);
    expect(instance.listScores(otherScope)).toEqual([]);

    providerService.activate(providerId);
    const changedStart = environment();
    const changedManifest = manifestForEvaluationStart(changedStart, 'run-a');
    const isolatedManifestStore = new RunManifestStore({
      persistence: persistenceUnavailable,
    });
    isolatedManifestStore.append(scope, changedManifest);
    const changedProof = finalizeEvaluationEnvironmentProof({
      providerService,
      runManifestStore: isolatedManifestStore,
      start: changedStart,
      runManifestId: changedManifest.runManifestId,
      proofId: 'proof-stable-id',
      capturedAt: '2026-07-29T00:00:01.000Z',
    });
    isolatedManifestStore.close();
    expect(() => instance.storeScoreWithProof(scope, score, changedProof))
      .toThrow('evaluation_environment_proof_conflict');

    const missingProof = proof('run-missing');
    expect(() => instance.storeScoreWithProof(scope, scoreFor(missingProof, {
      caseId: 'case-missing',
    }), missingProof)).toThrow('eval_score_case_not_found');
    expect(instance.getProof(scope, missingProof.proofId)).toBeUndefined();
  });

  it('keeps proof and score identities isolated by tenant and workspace', () => {
    const instance = store();
    instance.putCase(scope, evalCase());
    instance.putCase(otherScope, evalCase('case-a', otherScope));
    const localProof = proof('run-shared', 'proof-shared', scope);
    const otherProof = proof('run-shared', 'proof-shared', otherScope);

    const local = instance.storeScoreWithProof(
      scope,
      scoreFor(localProof),
      localProof,
    );
    const other = instance.storeScoreWithProof(
      otherScope,
      scoreFor(otherProof),
      otherProof,
    );

    expect(instance.getProof(scope, 'proof-shared')).toEqual(localProof);
    expect(instance.getProof(otherScope, 'proof-shared')).toEqual(otherProof);
    expect(instance.getScore(scope, local.scoreKey)).toEqual(local.score);
    expect(instance.getScore(otherScope, other.scoreKey)).toEqual(other.score);
  });

  it('owns baseline cache lookup, proof-bound tokens, and mutation invalidation', () => {
    const instance = store();
    const value = evalCase();
    instance.putCase(scope, value);
    const baselineProof = proof('baseline');
    const stored = instance.storeScoreWithProof(
      scope,
      scoreFor(baselineProof),
      baselineProof,
    );
    instance.publishBaseline(scope, value.caseId, stored.scoreKey);

    const lookupStart = environment();
    const lookupCase: EvalCaseV1 = {
      ...value,
      caseId: 'semantically-equivalent-case',
      evalSetId: 'another-set',
      origin: 'manual_golden',
      createdAt: '2026-07-30T00:00:00.000Z',
    };
    const hit = instance.lookupBaseline({
      scope,
      evalCase: lookupCase,
      pinned,
      currentEnvironmentStart: lookupStart,
      issuedAt: '2026-07-29T01:00:00.000Z',
    });
    expect(hit?.score.runId).toBe('baseline');
    const lookupManifest = manifestForEvaluationStart(lookupStart, 'lookup');
    manifestStore.append(scope, lookupManifest);
    const lookupProof = finalizeEvaluationEnvironmentProof({
      providerService,
      runManifestStore: manifestStore,
      start: lookupStart,
      runManifestId: lookupManifest.runManifestId,
      capturedAt: '2026-07-29T00:00:01.000Z',
    });
    expect(() => assertBaselineCacheTokenComparable(hit!.token, {
      evalCase: lookupCase,
      pinned,
      candidateProof: lookupProof,
    }))
      .not.toThrow();
    expect(() => assertBaselineCacheTokenComparable(hit!.token, {
      evalCase: {...lookupCase, query: 'Different semantic case.'},
      pinned,
      candidateProof: lookupProof,
    })).toThrow('baseline_cache_token_environment_changed');

    providerService.activate(providerId);
    const candidateStart = environment();
    expect(instance.lookupBaseline({
      scope,
      evalCase: value,
      pinned,
      currentEnvironmentStart: candidateStart,
    })).toBeUndefined();
    const candidateManifest = manifestForEvaluationStart(
      candidateStart,
      'candidate',
    );
    manifestStore.append(scope, candidateManifest);
    const candidateProof = finalizeEvaluationEnvironmentProof({
      providerService,
      runManifestStore: manifestStore,
      start: candidateStart,
      runManifestId: candidateManifest.runManifestId,
      capturedAt: '2026-07-29T00:00:01.000Z',
    });
    expect(() => assertBaselineCacheTokenComparable(hit!.token, {
      evalCase: value,
      pinned,
      candidateProof,
    }))
      .toThrow('baseline_cache_token_environment_changed');
  });

  it('rejects unavailable or candidate scores as cache publishers', () => {
    const instance = store();
    instance.putCase(scope, evalCase());
    for (const [runId, overrides] of [
      ['unavailable', {availability: 'unavailable' as const}],
      ['candidate', {role: 'candidate' as const, candidateId: 'candidate-a'}],
    ] as const) {
      const environmentProof = proof(runId);
      const stored = instance.storeScoreWithProof(
        scope,
        scoreFor(environmentProof, overrides),
        environmentProof,
      );
      expect(() => instance.publishBaseline(scope, 'case-a', stored.scoreKey))
        .toThrow('baseline_cache_score_not_publishable');
    }
  });

  it('imports content-addressed corpus objects per scope and detects corruption', () => {
    const instance = store();
    const sourcePath = path.join(directory, 'trace.pftrace');
    const content = Buffer.from('synthetic perfetto trace bytes');
    fs.writeFileSync(sourcePath, content);
    const contentHash = createHash('sha256').update(content).digest('hex');

    const imported = instance.importTrace({
      scope,
      sourcePath,
      expectedContentHash: contentHash,
      createdAt: '2026-07-29T00:00:00.000Z',
    });
    const other = instance.importTrace({
      scope: otherScope,
      sourcePath,
      expectedContentHash: contentHash,
      createdAt: '2026-07-29T00:00:00.000Z',
    });
    expect(imported.corpusId).toBe(contentHash);
    expect(other.corpusId).toBe(contentHash);

    const opened = instance.openTrace(scope, imported.corpusId)!;
    const otherOpened = instance.openTrace(otherScope, other.corpusId)!;
    expect(fs.readFileSync(opened.fileDescriptor)).toEqual(content);
    expect(fs.readFileSync(otherOpened.fileDescriptor)).toEqual(content);
    opened.close();
    otherOpened.close();
    const sameHashInOtherScope = instance.openTrace(
      otherScope,
      imported.corpusId,
    )!;
    expect(sameHashInOtherScope.record.scope).toEqual(otherScope);
    sameHashInOtherScope.close();

    const objectPath = path.join(
      corpusRoot,
      canonicalContentHash(scope),
      'objects',
      `${contentHash}.pftrace`,
    );
    fs.chmodSync(objectPath, 0o600);
    fs.writeFileSync(objectPath, 'corrupt');
    expect(() => instance.openTrace(scope, imported.corpusId))
      .toThrow('eval_corpus_object_corrupt');
    const intactOther = instance.openTrace(otherScope, other.corpusId)!;
    expect(fs.readFileSync(intactOther.fileDescriptor)).toEqual(content);
    intactOther.close();
  });

  it('rejects symlinks and hash mismatches before publishing metadata', () => {
    const instance = store();
    const sourcePath = path.join(directory, 'source.pftrace');
    const symlinkPath = path.join(directory, 'source-link.pftrace');
    fs.writeFileSync(sourcePath, 'trace');
    fs.symlinkSync(sourcePath, symlinkPath);

    expect(() => instance.importTrace({
      scope,
      sourcePath: symlinkPath,
    })).toThrow('eval_corpus_source_not_regular');
    expect(() => instance.importTrace({
      scope,
      sourcePath,
      expectedContentHash: 'f'.repeat(64),
    })).toThrow('eval_corpus_content_hash_mismatch');
    expect(instance.openTrace(scope, 'f'.repeat(64))).toBeUndefined();
  });

  it('rejects corpus root and scoped-directory symlink escapes', () => {
    const sourcePath = path.join(directory, 'safe-source.pftrace');
    fs.writeFileSync(sourcePath, 'trace');
    const outside = path.join(directory, 'outside');
    fs.mkdirSync(outside);

    const rootSymlink = path.join(directory, 'root-symlink');
    fs.symlinkSync(outside, rootSymlink);
    const rootSymlinkStore = store(persistenceAvailable, {
      corpusRoot: rootSymlink,
    });
    expect(() => rootSymlinkStore.importTrace({scope, sourcePath}))
      .toThrow('eval_corpus_directory_not_safe');

    const scopedSymlinkRoot = path.join(directory, 'scoped-symlink-root');
    fs.mkdirSync(scopedSymlinkRoot);
    fs.symlinkSync(
      outside,
      path.join(scopedSymlinkRoot, canonicalContentHash(scope)),
    );
    const scopedSymlinkStore = store(persistenceAvailable, {
      corpusRoot: scopedSymlinkRoot,
    });
    expect(() => scopedSymlinkStore.importTrace({scope, sourcePath}))
      .toThrow('eval_corpus_directory_not_safe');
  });

  it('keeps verified consumption bound to the opened descriptor', () => {
    const instance = store();
    const sourcePath = path.join(directory, 'leased-source.pftrace');
    const content = Buffer.from('immutable trace bytes');
    fs.writeFileSync(sourcePath, content);
    const imported = instance.importTrace({scope, sourcePath});
    const opened = instance.openTrace(scope, imported.corpusId)!;
    const objectPath = path.join(
      corpusRoot,
      canonicalContentHash(scope),
      'objects',
      `${imported.contentHash}.pftrace`,
    );
    fs.unlinkSync(objectPath);
    fs.writeFileSync(objectPath, 'replacement');

    expect(fs.readFileSync(opened.fileDescriptor)).toEqual(content);
    opened.close();
    expect(() => instance.openTrace(scope, imported.corpusId))
      .toThrow('eval_corpus_object_corrupt');
  });

  it('publishes corpus bytes before metadata so DB failure leaves only an orphan', () => {
    const sourcePath = path.join(directory, 'orphan-source.pftrace');
    const content = Buffer.from('orphan-safe-trace');
    fs.writeFileSync(sourcePath, content);
    const contentHash = createHash('sha256').update(content).digest('hex');
    const failing = store(persistenceAvailable, {
      beforeCorpusMetadataWrite: () => {
        throw new Error('injected_metadata_failure');
      },
    });

    expect(() => failing.importTrace({scope, sourcePath}))
      .toThrow('injected_metadata_failure');
    failing.close();
    const reopened = store();
    expect(reopened.openTrace(scope, contentHash)).toBeUndefined();
    const objects = fs.readdirSync(
      path.join(corpusRoot, canonicalContentHash(scope), 'objects'),
    );
    expect(objects).toContain(`${contentHash}.pftrace`);
  });

  it('rejects a novel oversized ephemeral trace before creating a temp object', () => {
    const boundedRoot = path.join(directory, 'bounded-corpus');
    const bounded = new EvalCaseStore({
      persistence: persistenceUnavailable,
      corpusRoot: boundedRoot,
      ephemeralCorpusMaxBytes: 4,
    });
    stores.push(bounded);
    const sourcePath = path.join(directory, 'oversized-novel.pftrace');
    fs.writeFileSync(sourcePath, Buffer.alloc(1024 * 1024, 0x41));

    expect(() => bounded.importTrace({scope, sourcePath}))
      .toThrow('eval_corpus_ephemeral_capacity_exceeded');
    expect(fs.existsSync(boundedRoot)).toBe(false);
  });

  it('uses bounded ephemeral state and removes its owned corpus on close', () => {
    const ephemeral = new EvalCaseStore({
      persistence: persistenceUnavailable,
      ephemeralCapacity: 1,
      ephemeralCorpusMaxBytes: 4,
    });
    const ownedRoot = ephemeral.corpusStorageRoot;
    ephemeral.putCase(scope, evalCase('case-one'));
    ephemeral.putCase(scope, evalCase('case-two'));
    expect(ephemeral.getCase(scope, 'case-one')).toBeUndefined();
    expect(ephemeral.getCase(scope, 'case-two')).toBeDefined();

    const exactCapacityPath = path.join(directory, 'exact-capacity.pftrace');
    fs.writeFileSync(exactCapacityPath, '1234');
    const firstImport = ephemeral.importTrace({
      scope,
      sourcePath: exactCapacityPath,
    });
    expect(ephemeral.importTrace({
      scope,
      sourcePath: exactCapacityPath,
    })).toEqual(firstImport);

    const sourcePath = path.join(directory, 'large-trace.pftrace');
    fs.writeFileSync(sourcePath, '12345');
    expect(() => ephemeral.importTrace({scope, sourcePath}))
      .toThrow('eval_corpus_ephemeral_capacity_exceeded');

    expect(fs.existsSync(ownedRoot)).toBe(true);
    ephemeral.close();
    expect(fs.existsSync(ownedRoot)).toBe(false);
  });
});
