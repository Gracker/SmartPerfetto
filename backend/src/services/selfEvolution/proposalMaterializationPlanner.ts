// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'fs';
import path from 'path';

import {userDataPath} from '../../runtimePaths';
import type {
  CurationProposalKind,
  ProposalMaterializationPlanV1,
} from '../../types/selfEvolution';
import {canonicalContentHash, immutableCanonicalSnapshot} from './canonicalJson';
import {
  createProposalMaterializationPlanV1,
  proposalDraftContentHash,
} from './proposalGateContract';
import {parseM6DraftProposal} from './proposalContract';

export type ProposalMaterializationRootId =
  | 'evolution_overlays'
  | 'maintainer_drafts'
  | 'contribution_bundles';

export interface ProposalMaterializationPolicy {
  kind: CurationProposalKind;
  rootId: ProposalMaterializationRootId;
  channel: ProposalMaterializationPlanV1['channel'];
  directory: string;
  extension: ProposalMaterializationPlanV1['fileExtension'];
  generatedTargetForbidden: true;
}

interface RegisteredRoot {
  rootId: ProposalMaterializationRootId;
  absolutePath: string;
}

const POLICIES: readonly ProposalMaterializationPolicy[] = [
  policy('phase_hint', 'evolution_overlays', 'runtime_overlay',
    'injections/phase-hints', '.json'),
  policy('skill_note', 'evolution_overlays', 'runtime_overlay',
    'injections/skill-notes', '.json'),
  policy('strategy_section', 'evolution_overlays', 'runtime_overlay',
    'strategies', '.json'),
  policy('skill_overlay_delta', 'evolution_overlays', 'runtime_overlay',
    'skill-overlays', '.json'),
  policy('retire_injection', 'evolution_overlays', 'runtime_overlay',
    'injections/retired', '.json'),
  policy('skill_sql', 'maintainer_drafts', 'maintainer_draft',
    'skill-sql', '.sql'),
  policy('new_skill_draft', 'contribution_bundles', 'contribution_bundle',
    'new-skills', '.yaml'),
] as const;

const POLICY_BY_KIND = new Map(POLICIES.map(item => [item.kind, item]));

export class ProposalMaterializationRegistry {
  readonly contentHash: string;
  private readonly roots = new Map<ProposalMaterializationRootId, RegisteredRoot>();

  private constructor(roots: readonly RegisteredRoot[]) {
    for (const root of roots) {
      if (
        this.roots.has(root.rootId)
        || !path.isAbsolute(root.absolutePath)
      ) {
        throw new Error('proposal_materialization_registry_root_invalid');
      }
      fs.mkdirSync(root.absolutePath, {recursive: true, mode: 0o700});
      this.roots.set(root.rootId, {
        rootId: root.rootId,
        absolutePath: path.resolve(root.absolutePath),
      });
    }
    const required = new Set(POLICIES.map(item => item.rootId));
    if (
      this.roots.size !== required.size
      || [...required].some(rootId => !this.roots.has(rootId))
    ) {
      throw new Error('proposal_materialization_registry_incomplete');
    }
    this.contentHash = canonicalContentHash({
      schemaVersion: 1,
      policies: POLICIES,
      roots: [...this.roots.values()]
        .map(root => ({
          rootId: root.rootId,
          rootIdentityHash: resolveRootIdentityHash(root.absolutePath),
        }))
        .sort((left, right) => left.rootId.localeCompare(right.rootId)),
    });
  }

  static production(): ProposalMaterializationRegistry {
    return new ProposalMaterializationRegistry([
      {
        rootId: 'evolution_overlays',
        absolutePath: userDataPath('self_improve', 'overlays'),
      },
      {
        rootId: 'maintainer_drafts',
        absolutePath: userDataPath('self_improve', 'maintainer-drafts'),
      },
      {
        rootId: 'contribution_bundles',
        absolutePath: userDataPath('self_improve', 'contribution-bundles'),
      },
    ]);
  }

  policyFor(kind: CurationProposalKind): ProposalMaterializationPolicy {
    const found = POLICY_BY_KIND.get(kind);
    if (!found) throw new Error('proposal_materialization_policy_missing');
    return immutableCanonicalSnapshot(found);
  }

  resolveRoot(rootId: string): string {
    const root = this.roots.get(rootId as ProposalMaterializationRootId);
    if (!root) throw new Error('proposal_materialization_root_unavailable');
    return fs.realpathSync.native(root.absolutePath);
  }

  assertPlanPolicy(plan: ProposalMaterializationPlanV1): void {
    const policy = this.policyFor(plan.proposalKind);
    if (
      plan.materializationRegistryContentHash !== this.contentHash
      || plan.rootId !== policy.rootId
      || plan.channel !== policy.channel
      || plan.fileExtension !== policy.extension
      || !plan.relativeTargetPath.startsWith(`${policy.directory}/`)
    ) {
      throw new Error('proposal_materialization_plan_policy_mismatch');
    }
  }

  static forTesting(root: string): ProposalMaterializationRegistry {
    const absolute = path.resolve(root);
    return new ProposalMaterializationRegistry([
      {
        rootId: 'evolution_overlays',
        absolutePath: path.join(absolute, 'overlays'),
      },
      {
        rootId: 'maintainer_drafts',
        absolutePath: path.join(absolute, 'maintainer-drafts'),
      },
      {
        rootId: 'contribution_bundles',
        absolutePath: path.join(absolute, 'contribution-bundles'),
      },
    ]);
  }
}

export class ProposalMaterializationPlanner {
  constructor(readonly registry: ProposalMaterializationRegistry) {}

  plan(value: unknown): ProposalMaterializationPlanV1 {
    const proposal = parseM6DraftProposal(value);
    const mapping = this.registry.policyFor(proposal.kind);
    const rootPath = this.registry.resolveRoot(mapping.rootId);
    const target = proposal.deltas[0];
    const targetToken = [
      slug(target.targetId),
      canonicalContentHash({
        proposalId: proposal.proposalId,
        operationId: target.operationId,
        targetId: target.targetId,
      }).slice(0, 16),
    ].join('-');
    const relativeTargetPath = path.posix.join(
      mapping.directory,
      `${targetToken}${mapping.extension}`,
    );
    const archiveEntries = mapping.channel === 'contribution_bundle'
      ? [
          {
            relativePath: 'manifest.json',
            contentHash: canonicalContentHash({
              proposalId: proposal.proposalId,
              draftContentHash: proposalDraftContentHash(proposal),
            }),
          },
          {
            relativePath: path.posix.join('payload', relativeTargetPath),
            contentHash: canonicalContentHash(target.after ?? ''),
          },
        ]
      : [];
    return createProposalMaterializationPlanV1({
      proposalId: proposal.proposalId,
      proposalRevision: 1,
      proposalKind: proposal.kind,
      draftContentHash: proposalDraftContentHash(proposal),
      materializationRegistryContentHash: this.registry.contentHash,
      rootId: mapping.rootId,
      rootIdentityHash: resolveRootIdentityHash(rootPath),
      relativeTargetPath,
      targetKind: target.targetKind,
      tier: proposal.tier,
      channel: mapping.channel,
      fileExtension: mapping.extension,
      archiveEntries,
      baseContentHash: target.baseContentHash,
      expectedRegistryFingerprint: proposal.expectedRegistryFingerprint,
      expectedOverlayGeneration: proposal.expectedOverlayGeneration,
    });
  }

  resolveRoot(plan: ProposalMaterializationPlanV1): string {
    this.registry.assertPlanPolicy(plan);
    const root = this.registry.resolveRoot(
      plan.rootId,
    );
    if (resolveRootIdentityHash(root) !== plan.rootIdentityHash) {
      throw new Error('proposal_materialization_root_identity_changed');
    }
    return root;
  }
}

export function resolveRootIdentityHash(rootPath: string): string {
  const realpath = fs.realpathSync.native(rootPath);
  const stat = fs.statSync(realpath);
  if (!stat.isDirectory()) {
    throw new Error('proposal_materialization_root_not_directory');
  }
  return canonicalContentHash({
    realpath,
    device: stat.dev,
    inode: stat.ino,
  });
}

function policy(
  kind: CurationProposalKind,
  rootId: ProposalMaterializationRootId,
  channel: ProposalMaterializationPlanV1['channel'],
  directory: string,
  extension: ProposalMaterializationPlanV1['fileExtension'],
): ProposalMaterializationPolicy {
  return {
    kind,
    rootId,
    channel,
    directory,
    extension,
    generatedTargetForbidden: true,
  };
}

function slug(value: string): string {
  const normalized = value
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return normalized || 'target';
}
