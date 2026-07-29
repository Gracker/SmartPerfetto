// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {gunzipSync} from 'zlib';

import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';

import type {
  CurationProposalV1,
  ProposalGateResultV1,
  SelfEvolutionPersistenceCapability,
} from '../../../types/selfEvolution';
import {canonicalContentHash} from '../canonicalJson';
import {ContributionBundleChannel} from '../contributionBundleChannel';
import type {
  ProposalGateAttemptRecordV1,
  ProposalStore,
} from '../proposalStore';

const scope = {tenantId: 'tenant', workspaceId: 'workspace'};

describe('ContributionBundleChannel', () => {
  let directory: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'contribution-bundle-'));
  });

  afterEach(() => {
    fs.rmSync(directory, {recursive: true, force: true});
  });

  it('emits deterministic deidentified archives from a completed gate', async () => {
    const recordChannelArtifact = jest.fn();
    const store = {
      get: () => proposal(),
      getLatestGateAttempt: () => attempt(),
      recordChannelArtifact,
    } as unknown as ProposalStore;
    const channel = new ContributionBundleChannel({
      proposalStore: store,
      persistence: persistence(directory),
      outputDirectory: directory,
      authorize: () => undefined,
      assertContributionEvidencePublic: () => undefined,
    });

    const first = await channel.create({
      scope,
      proposalId: 'proposal_bundle',
      actor: {userId: 'maintainer'},
    });
    const second = await channel.create({
      scope,
      proposalId: 'proposal_bundle',
      actor: {userId: 'maintainer'},
    });

    expect(second).toEqual(first);
    expect(recordChannelArtifact).toHaveBeenCalledTimes(2);
    const archive = gunzipSync(fs.readFileSync(first.archivePath))
      .toString('utf8');
    expect(archive).not.toContain('negative-run-private');
    expect(archive).not.toContain('/Users/');
    expect(archive).not.toContain('com.example.private');
    expect(JSON.parse(archive)).toMatchObject({
      schemaVersion: 1,
      format: 'smartperfetto-contribution-bundle-v1',
    });
  });

  it('fails closed when authoritative privacy rejects the evidence', async () => {
    const channel = new ContributionBundleChannel({
      proposalStore: {
        get: () => proposal(),
      } as unknown as ProposalStore,
      persistence: persistence(directory),
      outputDirectory: directory,
      authorize: () => undefined,
      assertContributionEvidencePublic: () => {
        throw new Error('private_feedback_not_exportable');
      },
    });
    await expect(channel.create({
      scope,
      proposalId: 'proposal_bundle',
      actor: {},
    })).rejects.toThrow('private_feedback_not_exportable');
    expect(fs.readdirSync(directory)).toEqual([]);
  });
});

function proposal(): CurationProposalV1 {
  return {
    schemaVersion: 1,
    proposalId: 'proposal_bundle',
    revision: 2,
    idempotencyKey: '1'.repeat(64),
    kind: 'skill_note',
    tier: 'T1',
    title: 'Bounded evidence improvement',
    rationale: 'Use aggregate evidence only.',
    deltas: [{
      op: 'add',
      targetKind: 'skill_note',
      targetId: 'startup_analysis',
      operationId: 'bundle_note',
      anchor: 'skillNotes[skillId="startup_analysis"]',
      baseContentHash: '2'.repeat(64),
      after: 'Collect a bounded aggregate view.',
    }],
    expectedRegistryFingerprint: '3'.repeat(64),
    expectedOverlayGeneration: 'builtin:test',
    evidence: {
      negativeRunIds: ['negative-run-private'],
      positiveRunIds: [],
      labeledCount: 8,
      negativeCount: 3,
      distinctTraceCount: 4,
      distinctSessionCount: 8,
      statisticalVerdict: 'hypothesis_only',
    },
    pairedGateVerdict: 'passed',
    expectedEffect: 'Improve aggregate evidence.',
    riskLevel: 'low',
    status: 'gated',
    scope,
    createdAt: '2026-07-29T00:00:00.000Z',
  };
}

function attempt(): ProposalGateAttemptRecordV1 {
  const gateResult = {
    schemaVersion: 1,
    proposalId: 'proposal_bundle',
    gateAttemptId: 'attempt_bundle',
    gateAttemptOrdinal: 1,
    gatePolicyFingerprint: '4'.repeat(64),
    draftRevision: 1,
    gatedRevision: 2,
    draftContentHash: '5'.repeat(64),
    startedAt: '2026-07-29T00:00:01.000Z',
    completedAt: '2026-07-29T00:00:02.000Z',
    checks: [{
      schemaVersion: 1,
      gateId: 'schema',
      verdict: 'passed',
      reasonCodes: [],
      evidenceContentHashes: [],
      durationMs: 1,
    }],
    overallVerdict: 'passed',
    pairedGateVerdict: 'passed',
  } as Omit<ProposalGateResultV1, 'contentHash'>;
  const hashed = {
    ...gateResult,
    contentHash: canonicalContentHash(gateResult),
  };
  return {
    session: {
      schemaVersion: 1,
      attemptId: 'attempt_bundle',
      ordinal: 1,
      scope,
      proposalId: 'proposal_bundle',
      draftContentHash: '5'.repeat(64),
      gatePolicyFingerprint: '4'.repeat(64),
      startedAt: '2026-07-29T00:00:01.000Z',
    },
    state: 'completed',
    verdict: 'passed',
    gateResult: hashed,
    completedAt: '2026-07-29T00:00:02.000Z',
  };
}

function persistence(directory: string): SelfEvolutionPersistenceCapability {
  return {
    persistence: 'available',
    configured: true,
    writable: true,
    outsidePackage: true,
    externalMount: false,
    dataRoot: directory,
    packageRoot: path.join(directory, 'package'),
    checkedAt: 1,
  };
}
