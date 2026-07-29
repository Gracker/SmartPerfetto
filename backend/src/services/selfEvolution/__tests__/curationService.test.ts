// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'fs';
import os from 'os';
import path from 'path';
import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';

import type {
  EvalCaseV1,
  RunManifestV1,
} from '../../../types/selfEvolution';
import {canonicalContentHash} from '../canonicalJson';
import {CurationService} from '../curationService';
import {
  FeedbackEventStore,
  PublicFeedbackCurationSource,
  privateFeedbackStorePaths,
  publicFeedbackIndexPath,
  publicFeedbackLogPath,
} from '../feedbackEventStore';
import {ProposalStore} from '../proposalStore';

const scope = {tenantId: 'tenant-a', workspaceId: 'workspace-a'};
const traceHash = canonicalContentHash('trace-a');
const skillHash = canonicalContentHash('skill-a');

let tempDir: string;
const originalBackendDataDir =
  process.env.SMARTPERFETTO_BACKEND_DATA_DIR;
const originalBackendLogDir =
  process.env.SMARTPERFETTO_BACKEND_LOG_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-curation-service-'));
  process.env.SMARTPERFETTO_BACKEND_DATA_DIR = path.join(tempDir, 'data');
  process.env.SMARTPERFETTO_BACKEND_LOG_DIR = path.join(tempDir, 'logs');
});

afterEach(() => {
  restoreEnv(
    'SMARTPERFETTO_BACKEND_DATA_DIR',
    originalBackendDataDir,
  );
  restoreEnv(
    'SMARTPERFETTO_BACKEND_LOG_DIR',
    originalBackendLogDir,
  );
  fs.rmSync(tempDir, {recursive: true, force: true});
});

describe('CurationService', () => {
  it('rejects a durable private store and forged provenance capability', async () => {
    const privateStore = new FeedbackEventStore({
      scope,
      eventLogPath: path.join(tempDir, 'private-feedback.jsonl'),
      databasePath: path.join(tempDir, 'private-feedback.db'),
      storage: 'durable',
      visibility: 'private_local',
    });
    const proposals = new ProposalStore({databasePath: ':memory:'});
    const temporaryPublicStore = new FeedbackEventStore({
      scope,
      eventLogPath: path.join(tempDir, 'temporary-public.jsonl'),
      databasePath: path.join(tempDir, 'temporary-public.db'),
      storage: 'temporary_private',
      visibility: 'public_scoped',
    });
    try {
      const privatePaths = privateFeedbackStorePaths({
        scope,
        userId: 'user-a',
        durable: true,
      });
      const canonicalSource = PublicFeedbackCurationSource.open({
        scope,
        ...privatePaths,
      } as Parameters<typeof PublicFeedbackCurationSource.open>[0]);
      await canonicalSource.append({
        kind: 'created',
        idempotencyKey: 'canonical-path-proof',
        runId: 'run-path-proof',
        sessionId: 'session-path-proof',
        rating: 'negative',
        dimensions: ['too_shallow'],
        targetKind: 'session',
        targetId: 'session-path-proof',
        source: 'api',
        actor: {userId: 'user-a'},
        scope,
      });
      expect(fs.existsSync(publicFeedbackLogPath(scope))).toBe(true);
      expect(fs.existsSync(publicFeedbackIndexPath())).toBe(true);
      expect(fs.existsSync(privatePaths.eventLogPath)).toBe(false);
      expect(fs.existsSync(privatePaths.databasePath)).toBe(false);
      expect(() => {
        (canonicalSource as unknown as {store: FeedbackEventStore}).store =
          privateStore;
      }).toThrow(TypeError);
      expect(
        (canonicalSource as unknown as {store?: FeedbackEventStore}).store,
      ).toBeUndefined();
      expect((
        PublicFeedbackCurationSource as unknown as {create?: unknown}
      ).create).toBeUndefined();
      expect(() => {
        FeedbackEventStore.prototype.close = function captureStore() {};
      }).toThrow(TypeError);
      canonicalSource.close();
      expect(() => {
        (
          privateStore as unknown as {eventLogPath: string}
        ).eventLogPath = privatePaths.eventLogPath;
      }).toThrow(TypeError);

      const service = new CurationService({
        manifests: {get: () => undefined},
        evalCases: {listCases: () => []},
        proposals,
      });
      await expect(service.runExplicit({
        scope,
        source: privateStore,
        env: {SELF_EVOLUTION_ENABLED: '1'},
      })).resolves.toMatchObject({
        proposal: null,
        diagnostics: [{code: 'curation_source_rejected'}],
      });
      await expect(service.runExplicit({
        scope,
        source: temporaryPublicStore,
        env: {SELF_EVOLUTION_ENABLED: '1'},
      })).resolves.toMatchObject({
        proposal: null,
        diagnostics: [{code: 'curation_source_rejected'}],
      });
      await expect(service.runExplicit({
        scope,
        source: {
          provenance: {
            visibility: 'public_scoped',
            durability: 'durable',
          },
          listEffective: () => [],
        },
        env: {SELF_EVOLUTION_ENABLED: '1'},
      })).resolves.toMatchObject({
        proposal: null,
        diagnostics: [{code: 'curation_source_rejected'}],
      });
    } finally {
      privateStore.close();
      temporaryPublicStore.close();
      proposals.close();
    }
  });

  it('runs only on explicit enabled requests and persists one idempotent draft', async () => {
    const source = PublicFeedbackCurationSource.open({scope});
    const manifests = new Map<string, RunManifestV1>();
    const cases: EvalCaseV1[] = [];
    for (let index = 0; index < 8; index += 1) {
      const negative = index < 3;
      const manifest = makeManifest(index, negative);
      manifests.set(manifest.runManifestId, manifest);
      cases.push(makeEvalCase(index, negative ? 'negative' : 'positive'));
      await source.append({
        kind: 'created',
        idempotencyKey: `request-${index}`,
        runId: manifest.runId,
        runManifestId: manifest.runManifestId,
        sessionId: manifest.sessionId,
        rating: negative ? 'negative' : 'positive',
        dimensions: negative ? ['too_shallow'] : [],
        comment: negative ? `empty result example ${index}` : undefined,
        targetKind: 'session',
        targetId: manifest.sessionId,
        source: 'api',
        actor: {userId: 'user-a'},
        scope,
        timestamp: `2026-07-29T00:00:0${index}.000Z`,
      });
    }
    const proposals = new ProposalStore({databasePath: ':memory:'});
    const execute = jest.fn(async (prompt: string) => {
      expect(prompt).toContain('<untrusted_curation_data>');
      expect(prompt).toContain('empty result example 0');
      return {
        ok: true as const,
        value: {
          title: 'Handle empty skill results',
          rationale: 'The manifest signal repeats in three labeled negatives.',
          after: 'Collect a bounded fallback view after an empty result.',
          expectedEffect: 'Improve paired evidence coverage.',
          riskLevel: 'low',
        },
      };
    });
    const service = new CurationService({
      manifests: {get: (_scope, id) => manifests.get(id)},
      evalCases: {listCases: () => cases},
      proposals,
      executeProposalReview: execute,
      workerOwner: 'curation-worker',
      clock: () => 1_000,
    });
    try {
      const disabled = await service.runExplicit({
        scope,
        source,
        env: {},
      });
      expect(disabled).toMatchObject({
        proposal: null,
        diagnostics: [{code: 'curation_disabled'}],
      });

      const first = await service.runExplicit({
        scope,
        source,
        env: {SELF_EVOLUTION_ENABLED: 'true'},
      });
      expect(first).toMatchObject({
        observationsAnalyzed: 8,
        proposal: {
          kind: 'skill_note',
          tier: 'T1',
          status: 'draft',
          pairedGateVerdict: 'not_run',
          evidence: {
            labeledCount: 8,
            negativeCount: 3,
            statisticalVerdict: 'hypothesis_only',
          },
        },
      });
      expect(proposals.list(scope)).toHaveLength(1);

      const second = await service.runExplicit({
        scope,
        source,
        env: {SELF_EVOLUTION_ENABLED: '1'},
      });
      expect(second.proposal).toEqual(first.proposal);
      expect(proposals.list(scope)).toHaveLength(1);
      expect(execute).toHaveBeenCalledTimes(1);
    } finally {
      source.close();
      proposals.close();
    }
  });

  it('does not count feedback whose manifest or real EvalCase is missing', async () => {
    const source = PublicFeedbackCurationSource.open({scope});
    const manifests = new Map<string, RunManifestV1>();
    for (let index = 0; index < 8; index += 1) {
      const manifest = makeManifest(index, index < 3);
      manifests.set(manifest.runManifestId, manifest);
      await source.append({
        kind: 'created',
        idempotencyKey: `fuzzy-${index}`,
        runId: manifest.runId,
        runManifestId: manifest.runManifestId,
        sessionId: manifest.sessionId,
        rating: index < 3 ? 'negative' : 'positive',
        dimensions: index < 3 ? ['too_shallow'] : [],
        targetKind: 'session',
        targetId: manifest.sessionId,
        source: 'api',
        actor: {userId: 'user-a'},
        scope,
      });
    }
    const proposals = new ProposalStore({databasePath: ':memory:'});
    const service = new CurationService({
      manifests: {get: (_scope, id) => manifests.get(id)},
      evalCases: {listCases: () => []},
      proposals,
    });
    try {
      const result = await service.runExplicit({
        scope,
        source,
        env: {SELF_EVOLUTION_ENABLED: '1'},
      });
      expect(result.proposal).toBeNull();
      expect(result.observationsAnalyzed).toBe(0);
      expect(result.diagnostics).toContainEqual(expect.objectContaining({
        code: 'curation_threshold_not_met',
      }));
    } finally {
      source.close();
      proposals.close();
    }
  });
});

function makeManifest(index: number, negative: boolean): RunManifestV1 {
  return {
    schemaVersion: 1,
    runManifestId: `manifest-${index}`,
    runId: `run-${index}`,
    sessionId: `session-${index}`,
    sealedAt: index + 1,
    scope,
    sceneType: 'scrolling',
    architecture: 'standard',
    promptTemplateHashes: [],
    skills: [{
      skillId: 'skill-a',
      version: '1',
      contentFingerprint: skillHash,
      origin: 'built_in',
      appliedOverlayIds: [],
      invocations: 1,
      okCount: 1,
      emptyResultCount: negative ? 1 : 0,
      errorCount: 0,
    }],
    skillRegistryFingerprint: canonicalContentHash('registry-a'),
    evolutionOverlayGeneration: 'builtin:registry-a',
    sqlStatementCount: 1,
    sqlErrorCount: 0,
    runtime: 'claude-agent-sdk',
    providerId: 'provider-a',
    model: 'model-a',
    outputLanguage: 'zh',
    toolAllowlistHash: canonicalContentHash('tools-a'),
    featureFlagSnapshot: {},
    analysisMode: 'full',
    resolvedMode: 'full',
    capabilityFlags: [],
    injections: {
      patterns: [],
      skillNotes: [],
      cases: [],
      phaseHints: [],
      knowledgeDocs: [],
    },
    turns: 2,
    wallclockMs: 100,
  };
}

function makeEvalCase(
  index: number,
  rating: 'positive' | 'negative',
): EvalCaseV1 {
  return {
    schemaVersion: 1,
    caseId: `case-${index}`,
    evalSetId: 'set-a',
    origin: 'labeled_run',
    sourceRunId: `run-${index}`,
    scope,
    traces: [{role: 'current', contentHash: traceHash}],
    query: 'analyze trace',
    analysisMode: 'full',
    label: {
      rating,
      dimensions: rating === 'negative' ? ['too_shallow'] : [],
    },
    split: 'train',
    createdAt: '2026-07-29T00:00:00.000Z',
  };
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
