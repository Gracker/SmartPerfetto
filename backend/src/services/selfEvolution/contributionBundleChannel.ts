// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {createHash} from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {gzipSync} from 'zlib';

import {userDataPath} from '../../runtimePaths';
import type {
  ContributionBundleArtifactV1,
  CurationProposalV1,
  RunManifestScope,
  SelfEvolutionPersistenceCapability,
} from '../../types/selfEvolution';
import {atomicWriteFileSync} from '../../utils/atomicFileWriter';
import {canonicalContentHash, canonicalJsonString} from './canonicalJson';
import {
  createContributionBundleArtifactV1,
} from './evolutionOverlayContract';
import {sanitizeProposalData} from './proposalDataSanitizer';
import type {ProposalStore} from './proposalStore';

interface ContributionEntry {
  path: string;
  content: string;
}

export interface ContributionBundleChannelOptions {
  proposalStore: ProposalStore;
  persistence: SelfEvolutionPersistenceCapability;
  outputDirectory?: string;
  authorize(context: {scope: RunManifestScope; userId?: string}): void;
  assertContributionEvidencePublic(
    proposal: CurationProposalV1,
  ): void | Promise<void>;
}

export class ContributionBundleChannel {
  private readonly outputDirectory: string;

  constructor(private readonly options: ContributionBundleChannelOptions) {
    this.outputDirectory = path.resolve(
      options.outputDirectory
        ?? userDataPath('self_improve', 'contribution-bundles'),
    );
  }

  async create(input: {
    scope: RunManifestScope;
    proposalId: string;
    actor: {userId?: string};
  }): Promise<ContributionBundleArtifactV1> {
    this.options.authorize({scope: input.scope, ...input.actor});
    if (this.options.persistence.persistence !== 'available') {
      throw new Error('self_evolution_persistence_unavailable');
    }
    const proposal = this.options.proposalStore.get(
      input.scope,
      input.proposalId,
    );
    if (!proposal) throw new Error('curation_proposal_not_found');
    await this.options.assertContributionEvidencePublic(proposal);
    const attempt = this.options.proposalStore.getLatestGateAttempt(
      input.scope,
      input.proposalId,
    );
    if (
      !attempt
      || attempt.state !== 'completed'
      || !attempt.gateResult
      || !attempt.completedAt
    ) {
      throw new Error('proposal_gate_qualification_missing');
    }
    const entries = buildContributionEntries(proposal, attempt.gateResult);
    const archiveManifest = {
      schemaVersion: 1,
      format: 'smartperfetto-contribution-bundle-v1',
      entries,
    };
    const archiveBytes = gzipSync(
      Buffer.from(canonicalJsonString(archiveManifest), 'utf8'),
      {level: 9, mtime: 0} as Parameters<typeof gzipSync>[1],
    );
    const archiveContentHash = createHash('sha256')
      .update(archiveBytes)
      .digest('hex');
    const archivePath = path.join(
      this.outputDirectory,
      `${archiveContentHash}.json.gz`,
    );
    persistImmutableBytes(archivePath, archiveBytes);
    const createdAt = Date.parse(attempt.completedAt);
    const artifact = createContributionBundleArtifactV1({
      artifactId:
        `contribution-bundle:${proposal.proposalId}:`
        + archiveContentHash.slice(0, 16),
      proposalId: proposal.proposalId,
      gateAttemptId: attempt.session.attemptId,
      gateAttemptOrdinal: attempt.session.ordinal,
      archivePath,
      archiveContentHash,
      entryContentHashes: entries.map(entry => ({
        path: entry.path,
        contentHash: canonicalContentHash(entry.content),
      })),
      deidentified: true,
      createdAt,
    });
    persistImmutableBytes(
      path.join(this.outputDirectory, `${archiveContentHash}.json`),
      Buffer.from(`${canonicalJsonString(artifact)}\n`, 'utf8'),
    );
    this.options.proposalStore.recordChannelArtifact({
      scope: input.scope,
      proposalId: proposal.proposalId,
      channel: 'contribution_bundle',
      gateAttemptId: attempt.session.attemptId,
      gateAttemptOrdinal: attempt.session.ordinal,
      gateResultContentHash: attempt.gateResult.contentHash,
      artifactId: artifact.artifactId,
      artifactContentHash: artifact.contentHash,
      createdAt,
    });
    return artifact;
  }
}

function buildContributionEntries(
  proposal: CurationProposalV1,
  gateResult: NonNullable<CurationProposalV1['gateResult']>,
): ContributionEntry[] {
  const projectedProposal = {
    schemaVersion: 1,
    proposalId: proposal.proposalId,
    kind: proposal.kind,
    tier: proposal.tier,
    title: proposal.title,
    rationale: proposal.rationale,
    deltas: proposal.deltas,
    evidenceSummary: {
      labeledCount: proposal.evidence.labeledCount,
      negativeCount: proposal.evidence.negativeCount,
      distinctTraceCount: proposal.evidence.distinctTraceCount,
      distinctSessionCount: proposal.evidence.distinctSessionCount,
      statisticalVerdict: proposal.evidence.statisticalVerdict,
    },
    expectedEffect: proposal.expectedEffect,
    riskLevel: proposal.riskLevel,
  };
  const gateSummary = {
    schemaVersion: 1,
    gateAttemptId: gateResult.gateAttemptId,
    gateAttemptOrdinal: gateResult.gateAttemptOrdinal,
    gatePolicyFingerprint: gateResult.gatePolicyFingerprint,
    overallVerdict: gateResult.overallVerdict,
    pairedGateVerdict: gateResult.pairedGateVerdict,
    checks: gateResult.checks.map(check => ({
      gateId: check.gateId,
      verdict: check.verdict,
      reasonCodes: check.reasonCodes,
    })),
  };
  const rawEntries: ContributionEntry[] = [
    {
      path: 'manifest.json',
      content: canonicalJsonString({
        schemaVersion: 1,
        license: 'AGPL-3.0-or-later',
        proposalId: proposal.proposalId,
      }),
    },
    {
      path: 'proposal.json',
      content: sanitizeOrThrow(projectedProposal),
    },
    {
      path: 'gate-summary.json',
      content: sanitizeOrThrow(gateSummary),
    },
  ];
  for (const entry of rawEntries) {
    assertSafeEntryPath(entry.path);
    if (
      /(?:api[_-]?key|access[_-]?token|client[_-]?secret|password|private[_-]?key)/i
        .test(entry.content)
    ) {
      throw new Error('contribution_bundle_secret_scan_failed');
    }
  }
  return rawEntries.sort((left, right) => left.path.localeCompare(right.path));
}

function sanitizeOrThrow(value: unknown): string {
  const sanitized = sanitizeProposalData(value);
  if (!sanitized.ok) {
    throw new Error(
      `contribution_bundle_sanitization_failed:${sanitized.errors[0]}`,
    );
  }
  return canonicalJsonString(sanitized.value);
}

function assertSafeEntryPath(entryPath: string): void {
  if (
    path.posix.isAbsolute(entryPath)
    || path.win32.isAbsolute(entryPath)
    || entryPath.includes('\0')
    || entryPath.split(/[\\/]/).some(segment =>
      segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error('contribution_bundle_zip_slip');
  }
}

function persistImmutableBytes(filePath: string, bytes: Buffer): void {
  fs.mkdirSync(path.dirname(filePath), {recursive: true, mode: 0o700});
  if (fs.existsSync(filePath)) {
    if (
      fs.lstatSync(filePath).isSymbolicLink()
      || !fs.readFileSync(filePath).equals(bytes)
    ) {
      throw new Error('contribution_bundle_immutable_conflict');
    }
    return;
  }
  atomicWriteFileSync(filePath, bytes);
  fs.chmodSync(filePath, 0o600);
}
