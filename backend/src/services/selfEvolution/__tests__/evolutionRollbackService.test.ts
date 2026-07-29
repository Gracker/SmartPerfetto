// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it, jest} from '@jest/globals';

import type {ProposalStore} from '../proposalStore';
import {EvolutionOverlayRegistry} from '../evolutionOverlayRegistry';
import {EvolutionRollbackService} from '../evolutionRollbackService';

const scope = {tenantId: 'tenant', workspaceId: 'workspace'};
const persistence = {
  persistence: 'available' as const,
  configured: true,
  writable: true,
  outsidePackage: true,
  externalMount: false,
  dataRoot: '/tmp/evolution-rollback-test',
  packageRoot: '/tmp/evolution-rollback-package',
  checkedAt: 1,
};

describe('EvolutionRollbackService', () => {
  it('persists idempotent repository and Case rollback receipts by actionId', () => {
    const registry = new EvolutionOverlayRegistry({
      databasePath: ':memory:',
      persistence,
    });
    const revokeChannelArtifact = jest.fn((_input: unknown) => ({
      contentHash: '1'.repeat(64),
    }));
    const retractCase = jest.fn(() => ({
      sideEffectContentHash: '2'.repeat(64),
    }));
    const service = new EvolutionRollbackService({
      proposalStore: {
        get: () => ({proposalId: 'proposal_patch'}),
        revokeChannelArtifact,
      } as unknown as ProposalStore,
      overlayRegistry: registry,
      authorize: () => undefined,
      retractCase,
      now: () => 100,
    });
    try {
      const repositoryReceipt = service.revokeRepositoryPatch({
        actionId: 'action_repository_revoke',
        scope,
        proposalId: 'proposal_patch',
        artifactId: 'repository-patch:proposal_patch:test',
        actor: {userId: 'maintainer'},
      });
      expect(repositoryReceipt.kind).toBe('repository_patch_revoked');
      expect(service.revokeRepositoryPatch({
        actionId: 'action_repository_revoke',
        scope,
        proposalId: 'proposal_patch',
        artifactId: 'repository-patch:proposal_patch:test',
        actor: {userId: 'maintainer'},
      })).toEqual(repositoryReceipt);
      expect(revokeChannelArtifact).toHaveBeenCalledTimes(1);
      expect(revokeChannelArtifact).toHaveBeenCalledWith(
        expect.objectContaining({scope}),
      );

      const caseReceipt = service.retractCase({
        actionId: 'action_case_retract',
        scope,
        caseId: 'learned:case-test',
        reason: 'manual rollback',
        actor: {userId: 'maintainer'},
      });
      expect(caseReceipt.kind).toBe('case_retracted');
      expect(service.retractCase({
        actionId: 'action_case_retract',
        scope,
        caseId: 'learned:case-test',
        reason: 'manual rollback',
        actor: {userId: 'maintainer'},
      })).toEqual(caseReceipt);
      expect(retractCase).toHaveBeenCalledTimes(1);
      expect(registry.listRollbackReceipts(scope, 'action_case_retract'))
        .toEqual([caseReceipt]);
    } finally {
      registry.close();
    }
  });
});
