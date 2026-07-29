// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {
  EvolutionRollbackReceiptV1,
  RunManifestScope,
} from '../../types/selfEvolution';
import {createEvolutionRollbackReceiptV1} from './evolutionOverlayContract';
import type {EvolutionOverlayRegistry} from './evolutionOverlayRegistry';
import type {ProposalStore} from './proposalStore';

interface RollbackActor {
  userId?: string;
}

export interface EvolutionRollbackServiceOptions {
  proposalStore: ProposalStore;
  overlayRegistry: EvolutionOverlayRegistry;
  authorize(
    permission: 'self_evolution:revert',
    context: {scope: RunManifestScope; userId?: string},
  ): void;
  /**
   * The adapter must persist its own actionId idempotency marker before
   * returning. This closes the crash window between the Case side effect and
   * the shared rollback receipt.
   */
  retractCase(input: {
    actionId: string;
    caseId: string;
    scope: RunManifestScope;
    reason: string;
  }): {sideEffectContentHash: string};
  now?: () => number;
}

/**
 * Rollbacks for non-runtime channels. Local overlays and Skill Notes use the
 * ProposalApplicationService saga because they must publish a new immutable
 * runtime generation. Repository artifacts are revoked, never reverse-applied
 * to the maintainer checkout; Case retraction delegates to the authoritative
 * Case store.
 */
export class EvolutionRollbackService {
  private readonly now: () => number;

  constructor(private readonly options: EvolutionRollbackServiceOptions) {
    this.now = options.now ?? Date.now;
  }

  revokeRepositoryPatch(input: {
    actionId: string;
    scope: RunManifestScope;
    proposalId: string;
    artifactId: string;
    actor: RollbackActor;
  }): EvolutionRollbackReceiptV1 {
    this.authorize(input.scope, input.actor);
    if (!this.options.proposalStore.get(input.scope, input.proposalId)) {
      throw new Error('proposal_channel_artifact_not_found');
    }
    const prior = this.findReceipt(
      input.scope,
      input.actionId,
      'repository_patch_revoked',
      input.artifactId,
    );
    if (prior) return prior;
    const revision = this.options.proposalStore.revokeChannelArtifact({
      scope: input.scope,
      proposalId: input.proposalId,
      channel: 'repository_patch',
      artifactId: input.artifactId,
      createdAt: this.now(),
    });
    return this.saveReceipt({
      actionId: input.actionId,
      scope: input.scope,
      kind: 'repository_patch_revoked',
      targetId: input.artifactId,
      sideEffectContentHash: revision.contentHash,
    });
  }

  retractCase(input: {
    actionId: string;
    scope: RunManifestScope;
    caseId: string;
    reason: string;
    actor: RollbackActor;
  }): EvolutionRollbackReceiptV1 {
    this.authorize(input.scope, input.actor);
    const prior = this.findReceipt(
      input.scope,
      input.actionId,
      'case_retracted',
      input.caseId,
    );
    if (prior) return prior;
    const result = this.options.retractCase({
      actionId: input.actionId,
      caseId: input.caseId,
      scope: input.scope,
      reason: input.reason,
    });
    return this.saveReceipt({
      actionId: input.actionId,
      scope: input.scope,
      kind: 'case_retracted',
      targetId: input.caseId,
      sideEffectContentHash: result.sideEffectContentHash,
    });
  }

  private authorize(scope: RunManifestScope, actor: RollbackActor): void {
    this.options.authorize('self_evolution:revert', {
      scope,
      ...actor,
    });
  }

  private findReceipt(
    scope: RunManifestScope,
    actionId: string,
    kind: EvolutionRollbackReceiptV1['kind'],
    targetId: string,
  ): EvolutionRollbackReceiptV1 | undefined {
    return this.options.overlayRegistry.listRollbackReceipts(scope, actionId)
      .find(receipt => receipt.kind === kind && receipt.targetId === targetId);
  }

  private saveReceipt(input: {
    actionId: string;
    scope: RunManifestScope;
    kind: EvolutionRollbackReceiptV1['kind'];
    targetId: string;
    sideEffectContentHash: string;
  }): EvolutionRollbackReceiptV1 {
    return this.options.overlayRegistry.saveRollbackReceipt(
      createEvolutionRollbackReceiptV1({
        ...input,
        idempotent: true,
        createdAt: this.now(),
      }),
    );
  }
}
