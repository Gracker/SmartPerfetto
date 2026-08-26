// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {spawnSync} from 'child_process';
import {randomUUID} from 'crypto';

import type {RagStore} from '../ragStore';
import type {RagChunk} from '../../types/sparkContracts';
import {activeCodebaseGeneration, type CodebaseRegistry} from './codebaseRegistry';
import {sourcePathAllowedForProvider} from './sourceDisclosure';
import {hardenedGitEnvironment, hardenedGitPrefixArguments} from './subprocessHardening';
import type {CodeLookupLedger} from './codeLookupLedger';
import type {KnowledgeScope} from '../scopedKnowledgeStore';

export type PatchStatus = 'verified' | 'sketch' | 'unverified';

export interface PatchProposalResponse {
  patchProposalId: string;
  patchStatus: PatchStatus;
  diff?: string;
  patchSketch?: string;
  rationale: string;
  confidence: 'low' | 'medium' | 'high';
  targetFiles: Array<{codebaseId: string; path: string; lineRange?: {start: number; end: number}}>;
  warnings: string[];
  unsupportedReason?: string;
  applyCheck?: {
    ran: boolean;
    passed: boolean;
    workdir?: string;
    error?: string;
  };
}

export interface ProposePatchInput {
  contextChunkIds: string[];
  problem: string;
  proposedDiff?: string;
  patchSketch?: string;
  turn?: number;
}

function isPatchableKind(kind: RagChunk['kind']): boolean {
  return kind === 'app_source' || kind === 'aosp' || kind === 'kernel_source';
}

function parseDiffTargetFiles(diff: string): string[] {
  const files = new Set<string>();
  for (const line of diff.split(/\r?\n/)) {
    const match = line.match(/^\+\+\+\s+b\/(.+)$/) ?? line.match(/^diff --git a\/.+ b\/(.+)$/);
    if (match?.[1] && match[1] !== '/dev/null') files.add(match[1]);
  }
  return Array.from(files);
}

export class PatchProposer {
  constructor(
    private readonly store: RagStore,
    private readonly registry: CodebaseRegistry,
    private readonly ledger?: CodeLookupLedger,
    private readonly scope?: KnowledgeScope,
  ) {}

  propose(input: ProposePatchInput): PatchProposalResponse {
    const patchProposalId = `patch_${randomUUID()}`;
    const chunks = input.contextChunkIds
      .map(id => this.store.getChunk(id, this.scope))
      .filter((chunk): chunk is RagChunk => Boolean(chunk));
    const rejected = (unsupportedReason: string, rationale: string): PatchProposalResponse => {
      this.record(input.turn ?? 0, [], 'patch_unverified');
      return {
        patchProposalId,
        patchStatus: 'unverified',
        rationale,
        confidence: 'low',
        targetFiles: [],
        warnings: [unsupportedReason],
        unsupportedReason,
      };
    };

    if (input.contextChunkIds.length === 0 || chunks.length !== input.contextChunkIds.length) {
      return rejected('missing_context_chunk', 'Patch proposal requires prior source lookup chunk ids.');
    }
    for (const chunk of chunks) {
      if (!this.ledger?.hasPriorLookupOf(chunk.chunkId)) {
        return rejected('prior_lookup_required', `Chunk ${chunk.chunkId} was not successfully looked up in this session.`);
      }
      if (!isPatchableKind(chunk.kind)) {
        return rejected('unsupported_source_kind', `Chunk ${chunk.chunkId} is kind=${chunk.kind}, which is not patchable.`);
      }
      if (!chunk.codebaseId || !chunk.filePath) {
        return rejected('invalid_codebase_metadata', `Chunk ${chunk.chunkId} does not carry codebase/file metadata.`);
      }
    }
    const codebaseIds = new Set(chunks.map(chunk => chunk.codebaseId));
    if (codebaseIds.size !== 1) {
      return rejected('multi_codebase_not_supported_phase1', 'Phase 1 patch proposals must target one codebase at a time.');
    }
    const codebaseId = chunks[0].codebaseId!;
    const ref = this.registry.get(codebaseId, this.scope);
    if (!ref) return rejected('invalid_codebase_metadata', `Codebase ${codebaseId} is not registered.`);
    const activeGeneration = activeCodebaseGeneration(ref);
    if (chunks.some(chunk => chunk.sourceGeneration !== activeGeneration)) {
      return rejected(
        'inactive_codebase_generation',
        'Patch proposal context is not from the codebase active generation; run a fresh source lookup.',
      );
    }
    if (!ref.consent.sendToProvider) {
      return rejected('no_send_to_provider_consent', 'Patch proposal requires source-send consent for the target codebase.');
    }
    if (chunks.some(chunk => !sourcePathAllowedForProvider(ref, chunk.filePath!))) {
      return rejected(
        'source_path_outside_provider_grant',
        'Patch proposal context falls outside the current source selection and consent grant.',
      );
    }
    if (this.ledger && this.ledger.remainingPatches() <= 0) {
      return rejected('budget_exceeded', 'Patch proposal budget is exhausted for this session.');
    }

    const targetFiles = chunks.map(chunk => ({
      codebaseId,
      path: chunk.filePath!,
      ...(chunk.lineRange ? {lineRange: chunk.lineRange} : {}),
    }));
    const allowedFiles = new Set(targetFiles.map(target => target.path));
    if (!input.proposedDiff?.trim()) {
      this.record(input.turn ?? 0, input.contextChunkIds, 'patch_sketch');
      return {
        patchProposalId,
        patchStatus: 'sketch',
        patchSketch: input.patchSketch ?? `Investigate ${targetFiles.map(target => target.path).join(', ')} for: ${input.problem}`,
        rationale: 'No verified unified diff was supplied; returning a non-copyable patch sketch.',
        confidence: 'medium',
        targetFiles,
        warnings: ['diff_not_supplied'],
        applyCheck: {ran: false, passed: false},
      };
    }

    const diffFiles = parseDiffTargetFiles(input.proposedDiff);
    const outside = diffFiles.filter(file => !allowedFiles.has(file));
    if (diffFiles.length === 0 || outside.length > 0) {
      this.record(input.turn ?? 0, input.contextChunkIds, 'patch_unverified');
      return {
        patchProposalId,
        patchStatus: 'unverified',
        rationale: outside.length > 0
          ? `Diff touches files outside the looked-up context: ${outside.join(', ')}.`
          : 'Diff did not contain parseable target files.',
        confidence: 'low',
        targetFiles,
        warnings: outside.length > 0 ? ['diff_target_outside_context'] : ['diff_unparseable'],
        unsupportedReason: outside.length > 0 ? 'diff_target_outside_context' : 'diff_unparseable',
        applyCheck: {ran: false, passed: false},
      };
    }

    const apply = spawnSync('git', [
      ...hardenedGitPrefixArguments(ref.rootRealpath),
      'apply',
      '--check',
      '-',
    ], {
      input: input.proposedDiff,
      encoding: 'utf-8',
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
      env: hardenedGitEnvironment(),
    });
    if (apply.status !== 0) {
      this.record(input.turn ?? 0, input.contextChunkIds, 'patch_sketch');
      return {
        patchProposalId,
        patchStatus: 'sketch',
        patchSketch: input.patchSketch ?? `A diff was drafted for ${diffFiles.join(', ')}, but apply-check failed. Rework hunks against the current tree.`,
        rationale: 'Static file scoping passed, but git apply --check failed in the target codebase.',
        confidence: 'medium',
        targetFiles,
        warnings: ['apply_check_failed'],
        applyCheck: {
          ran: true,
          passed: false,
          error: apply.stderr || apply.stdout || `git apply exited with ${apply.status}`,
        },
      };
    }

    this.record(input.turn ?? 0, input.contextChunkIds, 'patch_verified');
    return {
      patchProposalId,
      patchStatus: 'verified',
      diff: input.proposedDiff,
      rationale: 'Diff target files are restricted to prior lookup chunks and git apply --check passed in the target codebase.',
      confidence: 'high',
      targetFiles,
      warnings: [],
      applyCheck: {
        ran: true,
        passed: true,
      },
    };
  }

  private record(turn: number, chunkIds: string[], outcome: 'patch_verified' | 'patch_sketch' | 'patch_unverified'): void {
    const codebaseId = chunkIds.length > 0
      ? this.store.getChunk(chunkIds[0], this.scope)?.codebaseId
      : undefined;
    this.ledger?.record({
      turn,
      ts: Date.now(),
      toolName: 'propose_patch',
      chunkIds,
      ...(codebaseId ? {codebaseId} : {}),
      consentApplied: true,
      tokensSpent: 0,
      outcome,
      legacyPath: false,
    });
  }
}
