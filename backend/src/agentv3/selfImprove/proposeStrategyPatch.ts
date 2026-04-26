// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * High-level orchestrator that turns a review-agent JSON proposal into a
 * patch landed inside an isolated git worktree. The actual git push +
 * GitHub PR creation lives outside this module — once the worktree is
 * verified, the caller (or an operator) takes over.
 *
 * The five-step pipeline:
 *   1. Render the proposal via phaseHintsRenderer (deterministic YAML).
 *   2. Open a tmp worktree via worktreeRunner (PR3).
 *   3. Apply the rendered entry to the target strategy file.
 *   4. Run a validation hook (typically `validate:strategies`).
 *   5. Return success + the worktree handle, or failure with a structured
 *      reason. Worktree cleanup is the caller's responsibility on success
 *      so they can run heavier downstream checks (regression, e2e) before
 *      pushing the branch.
 *
 * See docs/self-improving-design.md §13.2 (Worktree isolation), §13 (PR9c).
 */

import * as path from 'path';
import { renderPhaseHint, type PhaseHintProposal, type RenderResult } from './phaseHintsRenderer';
import { applyPhaseHintPatch } from './strategyPatchApplier';
import { createWorktree, removeWorktree, type WorktreeHandle } from './worktreeRunner';

export interface ProposeStrategyPatchInput {
  /** Validated proposal from the review agent. */
  proposal: PhaseHintProposal;
  /** Scene whose strategy file to patch (e.g. `scrolling`, `startup`). */
  scene: string;
  /** Unique job id (matches worktreeRunner's whitelist regex). */
  jobId: string;
  /** Optional: override the validation step (used by tests). */
  validate?: (handle: WorktreeHandle) => Promise<{ ok: boolean; details?: string }>;
  /** Optional: override the tool registry passed to the renderer. */
  toolRegistry?: ReadonlySet<string>;
  /** Override repo root — for tests. */
  workingDir?: string;
}

export type ProposeRejectReason =
  | 'render_failed'
  | 'worktree_failed'
  | 'patch_failed'
  | 'validation_failed';

export type ProposeResult =
  | {
      ok: true;
      handle: WorktreeHandle;
      patchFingerprint: string;
      phaseHintId: string;
      renderedYaml: string;
      strategyFilePath: string;
    }
  | { ok: false; reason: ProposeRejectReason; details: string };

/**
 * Drive the full pipeline. On success, the worktree is left intact so the
 * caller can run downstream checks; the worktree handle is returned for
 * cleanup. On failure, the worktree is cleaned up (if it was opened) and a
 * structured reason is returned — never throws.
 */
export async function proposeStrategyPatch(input: ProposeStrategyPatchInput): Promise<ProposeResult> {
  const renderResult = renderPhaseHint(input.proposal, { toolRegistry: input.toolRegistry });
  if (!renderResult.ok) {
    return { ok: false, reason: 'render_failed', details: `${renderResult.reason}: ${renderResult.details}` };
  }
  const rendered: Extract<RenderResult, { ok: true }> = renderResult;

  let handle: WorktreeHandle;
  try {
    handle = await createWorktree({ jobId: input.jobId, workingDir: input.workingDir });
  } catch (err) {
    return {
      ok: false,
      reason: 'worktree_failed',
      details: `failed to create worktree: ${(err as Error).message}`,
    };
  }

  const strategyFilePath = path.join(handle.worktreePath, 'backend', 'strategies', `${input.scene}.strategy.md`);
  const apply = applyPhaseHintPatch(strategyFilePath, rendered.yaml);
  if (!apply.ok) {
    await removeWorktree(handle, true);
    return {
      ok: false,
      reason: 'patch_failed',
      details: `${apply.reason}: ${apply.details ?? ''}`,
    };
  }

  if (input.validate) {
    const validation = await input.validate(handle);
    if (!validation.ok) {
      await removeWorktree(handle, true);
      return {
        ok: false,
        reason: 'validation_failed',
        details: validation.details ?? 'validation hook returned not-ok',
      };
    }
  }

  return {
    ok: true,
    handle,
    patchFingerprint: rendered.patchFingerprint,
    phaseHintId: rendered.phaseHintId,
    renderedYaml: rendered.yaml,
    strategyFilePath,
  };
}
