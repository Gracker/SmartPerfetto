// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {spawnSync} from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';

import type {
  CurationProposalV1,
  SelfEvolutionPersistenceCapability,
} from '../../../types/selfEvolution';
import type {ApplicationBuildIdentity} from '../../applicationUpdate/types';
import type {ProposalStore} from '../proposalStore';
import {
  createRepositoryTargetBindingFromRepository,
  RepositoryPatchChannel,
} from '../repositoryPatchChannel';

const scope = {tenantId: 'tenant', workspaceId: 'workspace'};

describe('RepositoryPatchChannel', () => {
  let root: string;
  let repository: string;
  let target: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'repository-patch-channel-'));
    repository = path.join(root, 'repository');
    target = 'backend/strategies/example.md';
    fs.mkdirSync(path.join(repository, 'backend/strategies'), {recursive: true});
    fs.writeFileSync(path.join(repository, target), 'before\n');
    runGit(['init', '-q']);
    runGit(['add', target]);
    runGit([
      '-c',
      'user.name=SmartPerfetto Test',
      '-c',
      'user.email=test@smartperfetto.local',
      'commit',
      '-qm',
      'base',
    ]);
  });

  afterEach(() => {
    fs.rmSync(root, {recursive: true, force: true});
  });

  it('builds and rechecks a detached patch without mutating git history or the checkout', () => {
    const binding = createRepositoryTargetBindingFromRepository({
      repositoryRoot: repository,
      repositoryRelativePath: target,
      allowedRoot: 'backend/strategies',
      proposalId: 'proposal_patch',
      proposedFileContent: 'after\n',
      structuralPath: 'document',
      resolveAnchor: content => ({content}),
    });
    const recordChannelArtifact = jest.fn();
    const store = {
      get: () => ({tier: 'T4'} as CurationProposalV1),
      getLatestRepositoryTargetBinding: () => ({
        attemptId: 'attempt_patch',
        attemptOrdinal: 1,
        gateResultContentHash: '1'.repeat(64),
        binding,
      }),
      recordChannelArtifact,
    } as unknown as ProposalStore;
    const beforeHead = runGit(['rev-parse', 'HEAD']);
    const beforeStatus = runGit(['status', '--porcelain']);
    const channel = new RepositoryPatchChannel({
      proposalStore: store,
      persistence: persistence(),
      buildIdentity: identity('source'),
      repositoryRoot: repository,
      outputDirectory: path.join(root, 'patches'),
      authorize: () => undefined,
      now: () => 100,
    });

    const artifact = channel.create({
      proposalId: 'proposal_patch',
      scope,
    });

    expect(artifact).toMatchObject({
      applyCheck: 'passed',
      sourceMaintainer: true,
      gitCapability: 'available',
    });
    expect(artifact.patch).toContain('+after');
    expect(artifact.reversePatch).toContain('+before');
    expect(fs.readFileSync(path.join(repository, target), 'utf8')).toBe('before\n');
    expect(runGit(['rev-parse', 'HEAD'])).toBe(beforeHead);
    expect(runGit(['status', '--porcelain'])).toBe(beforeStatus);
    expect(runGit(['worktree', 'list', '--porcelain'])
      .split('\n').filter(line => line.startsWith('worktree '))).toHaveLength(1);
    expect(recordChannelArtifact).toHaveBeenCalledTimes(1);
  });

  it('rejects non-source distributions before creating a worktree', () => {
    const channel = new RepositoryPatchChannel({
      proposalStore: {} as ProposalStore,
      persistence: persistence(),
      buildIdentity: identity('portable'),
      repositoryRoot: repository,
      outputDirectory: path.join(root, 'patches'),
      authorize: () => undefined,
    });
    expect(() => channel.create({
      proposalId: 'proposal_patch',
      scope,
    })).toThrow('repository_patch_source_maintainer_required');
  });

  function runGit(args: string[]): string {
    const result = spawnSync('git', ['-C', repository, ...args], {
      encoding: 'utf8',
    });
    if (result.status !== 0) {
      throw new Error(String(result.stderr));
    }
    return result.stdout.trim();
  }

  function persistence(): SelfEvolutionPersistenceCapability {
    return {
      persistence: 'available',
      configured: true,
      writable: true,
      outsidePackage: true,
      externalMount: false,
      dataRoot: path.join(root, 'data'),
      packageRoot: repository,
      checkedAt: 1,
    };
  }
});

function identity(
  distribution: ApplicationBuildIdentity['distribution'],
): ApplicationBuildIdentity {
  return {
    distribution,
    channel: 'stable',
    version: '1.3.0',
    commit: 'a'.repeat(40),
    target: {os: 'darwin', arch: 'arm64', id: 'darwin-arm64'},
    signingMode:
      distribution === 'source' ? 'source-checkout' : 'unsigned',
  };
}
