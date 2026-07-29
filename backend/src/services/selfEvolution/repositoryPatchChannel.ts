// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {spawnSync} from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type {ApplicationBuildIdentity} from '../applicationUpdate/types';
import {userDataPath} from '../../runtimePaths';
import type {
  RepositoryPatchArtifactV1,
  RepositoryTargetBindingV1,
  SelfEvolutionPersistenceCapability,
} from '../../types/selfEvolution';
import {atomicWriteFileSync} from '../../utils/atomicFileWriter';
import {canonicalContentHash, canonicalJsonString} from './canonicalJson';
import {
  createRepositoryPatchArtifactV1,
} from './evolutionOverlayContract';
import {
  createRepositoryTargetBindingV1,
} from './proposalGateContract';
import type {ProposalStore} from './proposalStore';

export interface RepositoryTargetBindingResolverInput {
  repositoryRoot: string;
  repositoryRelativePath: string;
  allowedRoot: string;
  proposalId: string;
  proposedFileContent: string;
  structuralPath: string;
  resolveAnchor(baseFileContent: string, structuralPath: string): unknown;
  baseCommit?: string;
}

export function createRepositoryTargetBindingFromRepository(
  input: RepositoryTargetBindingResolverInput,
): RepositoryTargetBindingV1 {
  const repositoryRoot = fs.realpathSync(input.repositoryRoot);
  assertSafeRepositoryPath(
    repositoryRoot,
    input.repositoryRelativePath,
    input.allowedRoot,
  );
  const baseCommit = git(repositoryRoot, [
    'rev-parse',
    '--verify',
    `${input.baseCommit ?? 'HEAD'}^{commit}`,
  ]);
  const treeLine = git(repositoryRoot, [
    'ls-tree',
    baseCommit,
    '--',
    input.repositoryRelativePath,
  ]);
  const match = /^([0-7]{6})\s+blob\s+([0-9a-f]{40,64})\t(.+)$/
    .exec(treeLine);
  if (!match || match[3] !== input.repositoryRelativePath) {
    throw new Error('repository_target_file_not_tracked');
  }
  const baseFileContent = git(repositoryRoot, [
    'show',
    `${baseCommit}:${input.repositoryRelativePath}`,
  ], false);
  const commonDirectory = git(repositoryRoot, [
    'rev-parse',
    '--git-common-dir',
  ]);
  const anchor = input.resolveAnchor(
    baseFileContent,
    input.structuralPath,
  );
  if (anchor === undefined) {
    throw new Error('repository_target_anchor_missing');
  }
  return createRepositoryTargetBindingV1({
    proposalId: input.proposalId,
    proposalRevision: 1,
    repositoryRootIdentityHash: canonicalContentHash({
      repositoryRoot,
      gitCommonDirectory: path.resolve(repositoryRoot, commonDirectory),
    }),
    repositoryRelativePath: input.repositoryRelativePath,
    allowedRoot: input.allowedRoot,
    baseCommit,
    baseBlobOid: match[2],
    baseFileMode: match[1],
    baseFileContentHash: canonicalContentHash(baseFileContent),
    structuralPath: input.structuralPath,
    anchorFingerprint: canonicalContentHash(anchor),
    proposedFileContent: input.proposedFileContent,
    proposedFileContentHash:
      canonicalContentHash(input.proposedFileContent),
    symlinkFree: true,
    containmentVerified: true,
  });
}

export interface RepositoryPatchChannelOptions {
  proposalStore: ProposalStore;
  persistence: SelfEvolutionPersistenceCapability;
  buildIdentity: ApplicationBuildIdentity;
  repositoryRoot: string;
  outputDirectory?: string;
  authorize(context: {scope: {tenantId: string; workspaceId: string}}): void;
  now?: () => number;
}

export class RepositoryPatchChannel {
  private readonly repositoryRoot: string;
  private readonly outputDirectory: string;
  private readonly now: () => number;

  constructor(private readonly options: RepositoryPatchChannelOptions) {
    this.repositoryRoot = fs.realpathSync(options.repositoryRoot);
    this.outputDirectory = path.resolve(
      options.outputDirectory
        ?? userDataPath('self_improve', 'repository-patches'),
    );
    this.now = options.now ?? Date.now;
  }

  create(input: {
    proposalId: string;
    scope: {tenantId: string; workspaceId: string};
  }): RepositoryPatchArtifactV1 {
    this.options.authorize({scope: input.scope});
    this.assertCapability();
    const proposal = this.options.proposalStore.get(
      input.scope,
      input.proposalId,
    );
    if (!proposal) {
      throw new Error('curation_proposal_not_found');
    }
    if (proposal.tier !== 'T4' && proposal.tier !== 'T5a') {
      throw new Error('repository_patch_tier_not_eligible');
    }
    const qualification =
      this.options.proposalStore.getLatestRepositoryTargetBinding(
        input.scope,
        input.proposalId,
      );
    if (!qualification) {
      throw new Error('repository_target_binding_not_qualified');
    }
    const binding = qualification.binding;
    this.assertBinding(binding, input.proposalId);
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-repo-patch-'));
    const checkWorktree =
      fs.mkdtempSync(path.join(os.tmpdir(), 'sp-repo-patch-check-'));
    let worktreeAdded = false;
    let checkWorktreeAdded = false;
    try {
      git(this.repositoryRoot, [
        'worktree',
        'add',
        '--detach',
        worktree,
        binding.baseCommit,
      ]);
      worktreeAdded = true;
      this.verifyPinnedTarget(worktree, binding);
      const targetPath = path.join(worktree, binding.repositoryRelativePath);
      atomicWriteFileSync(targetPath, binding.proposedFileContent);
      const patch = git(worktree, [
        'diff',
        '--binary',
        '--',
        binding.repositoryRelativePath,
      ], false);
      const reversePatch = git(worktree, [
        'diff',
        '-R',
        '--binary',
        '--',
        binding.repositoryRelativePath,
      ], false);
      if (!patch || !reversePatch) {
        throw new Error('repository_patch_empty');
      }
      git(this.repositoryRoot, [
        'worktree',
        'add',
        '--detach',
        checkWorktree,
        binding.baseCommit,
      ]);
      checkWorktreeAdded = true;
      git(checkWorktree, ['apply', '--check', '-'], false, patch);
      const createdAt = this.now();
      const artifact = createRepositoryPatchArtifactV1({
        artifactId:
          `repository-patch:${input.proposalId}:`
          + binding.contentHash.slice(0, 16),
        proposalId: input.proposalId,
        gateAttemptId: qualification.attemptId,
        gateAttemptOrdinal: qualification.attemptOrdinal,
        targetBindingContentHash: binding.contentHash,
        patch,
        patchContentHash: canonicalContentHash(patch),
        reversePatch,
        reversePatchContentHash: canonicalContentHash(reversePatch),
        applyCheck: 'passed',
        sourceMaintainer: true,
        gitCapability: 'available',
        createdAt,
      });
      this.persistArtifact(artifact);
      this.options.proposalStore.recordChannelArtifact({
        scope: input.scope,
        proposalId: input.proposalId,
        channel: 'repository_patch',
        gateAttemptId: qualification.attemptId,
        gateAttemptOrdinal: qualification.attemptOrdinal,
        gateResultContentHash: qualification.gateResultContentHash,
        artifactId: artifact.artifactId,
        artifactContentHash: artifact.contentHash,
        createdAt,
      });
      return artifact;
    } finally {
      if (checkWorktreeAdded) {
        removeWorktree(this.repositoryRoot, checkWorktree);
      } else {
        fs.rmSync(checkWorktree, {recursive: true, force: true});
      }
      if (worktreeAdded) {
        removeWorktree(this.repositoryRoot, worktree);
      } else {
        fs.rmSync(worktree, {recursive: true, force: true});
      }
    }
  }

  private assertCapability(): void {
    if (this.options.persistence.persistence !== 'available') {
      throw new Error('self_evolution_persistence_unavailable');
    }
    if (this.options.buildIdentity.distribution !== 'source') {
      throw new Error('repository_patch_source_maintainer_required');
    }
    git(this.repositoryRoot, ['--version']);
    git(this.repositoryRoot, ['rev-parse', '--is-inside-work-tree']);
  }

  private assertBinding(
    binding: RepositoryTargetBindingV1,
    proposalId: string,
  ): void {
    if (binding.proposalId !== proposalId) {
      throw new Error('repository_target_binding_proposal_mismatch');
    }
    assertSafeRepositoryPath(
      this.repositoryRoot,
      binding.repositoryRelativePath,
      binding.allowedRoot,
    );
    const commonDirectory = git(this.repositoryRoot, [
      'rev-parse',
      '--git-common-dir',
    ]);
    const rootIdentity = canonicalContentHash({
      repositoryRoot: this.repositoryRoot,
      gitCommonDirectory:
        path.resolve(this.repositoryRoot, commonDirectory),
    });
    if (rootIdentity !== binding.repositoryRootIdentityHash) {
      throw new Error('repository_target_root_identity_mismatch');
    }
  }

  private verifyPinnedTarget(
    worktree: string,
    binding: RepositoryTargetBindingV1,
  ): void {
    const targetPath = path.join(worktree, binding.repositoryRelativePath);
    const stats = fs.lstatSync(targetPath);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new Error('repository_target_symlink_or_type_changed');
    }
    const content = fs.readFileSync(targetPath, 'utf8');
    if (canonicalContentHash(content) !== binding.baseFileContentHash) {
      throw new Error('repository_target_base_content_changed');
    }
    const treeLine = git(worktree, [
      'ls-tree',
      'HEAD',
      '--',
      binding.repositoryRelativePath,
    ]);
    if (
      !treeLine.startsWith(
        `${binding.baseFileMode} blob ${binding.baseBlobOid}\t`,
      )
    ) {
      throw new Error('repository_target_tree_binding_changed');
    }
  }

  private persistArtifact(artifact: RepositoryPatchArtifactV1): void {
    fs.mkdirSync(this.outputDirectory, {recursive: true, mode: 0o700});
    const baseName = artifact.contentHash;
    const patchPath = path.join(this.outputDirectory, `${baseName}.patch`);
    const manifestPath = path.join(this.outputDirectory, `${baseName}.json`);
    writeImmutable(patchPath, artifact.patch);
    writeImmutable(
      manifestPath,
      `${canonicalJsonString(artifact)}\n`,
    );
  }
}

function assertSafeRepositoryPath(
  repositoryRoot: string,
  relativePath: string,
  allowedRoot: string,
): void {
  for (const value of [relativePath, allowedRoot]) {
    if (
      path.isAbsolute(value)
      || value.split(/[\\/]/).some(segment =>
        segment === '' || segment === '.' || segment === '..')
    ) {
      throw new Error('repository_target_path_invalid');
    }
  }
  const normalizedAllowed = `${allowedRoot.replace(/[\\/]+$/, '')}/`;
  if (
    relativePath !== allowedRoot
    && !relativePath.startsWith(normalizedAllowed)
  ) {
    throw new Error('repository_target_outside_allowed_root');
  }
  const absolute = path.resolve(repositoryRoot, relativePath);
  if (!absolute.startsWith(`${repositoryRoot}${path.sep}`)) {
    throw new Error('repository_target_path_escape');
  }
  let cursor = repositoryRoot;
  for (const segment of relativePath.split(/[\\/]/)) {
    cursor = path.join(cursor, segment);
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) {
      throw new Error('repository_target_symlink_not_allowed');
    }
  }
}

function git(
  cwd: string,
  args: string[],
  trim = true,
  input?: string,
): string {
  const result = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    input,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `repository_git_failed:${args[0]}:${String(result.stderr).trim()}`,
    );
  }
  return trim ? result.stdout.trim() : result.stdout;
}

function removeWorktree(repositoryRoot: string, worktree: string): void {
  const result = spawnSync('git', [
    '-C',
    repositoryRoot,
    'worktree',
    'remove',
    '--force',
    worktree,
  ], {encoding: 'utf8'});
  if (result.status !== 0) {
    fs.rmSync(worktree, {recursive: true, force: true});
    spawnSync('git', [
      '-C',
      repositoryRoot,
      'worktree',
      'prune',
    ], {encoding: 'utf8'});
  }
}

function writeImmutable(filePath: string, content: string): void {
  if (fs.existsSync(filePath)) {
    if (
      fs.lstatSync(filePath).isSymbolicLink()
      || fs.readFileSync(filePath, 'utf8') !== content
    ) {
      throw new Error('repository_patch_artifact_immutable_conflict');
    }
    return;
  }
  atomicWriteFileSync(filePath, content);
  fs.chmodSync(filePath, 0o600);
}
