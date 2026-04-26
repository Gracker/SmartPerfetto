// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Mock child_process so worktreeRunner can spin up a fake worktree without
// needing a real git binary inside the test runner.
type ExecFileResult = { stdout: string; stderr: string };
const execFileMock = jest.fn<(cmd: string, args: string[], opts: unknown) => Promise<ExecFileResult>>();

jest.mock('child_process', () => ({
  execFile: (cmd: string, args: string[], opts: unknown, cb: (err: Error | null, result?: ExecFileResult) => void) => {
    Promise.resolve(execFileMock(cmd, args, opts))
      .then(result => cb(null, result))
      .catch(err => cb(err as Error));
  },
}));

import { proposeStrategyPatch } from '../proposeStrategyPatch';
import type { PhaseHintProposal } from '../phaseHintsRenderer';
import { __testing as worktreeTesting } from '../worktreeRunner';

describe('proposeStrategyPatch', () => {
  let workingDir: string;
  let strategyDir: string;
  const proposal: PhaseHintProposal = {
    failureCategoryEnum: 'misdiagnosis_vsync_vrr',
    evidenceSummary: 'frame jank misattributed to VRR boundary',
    candidateKeywords: ['vsync', 'vrr'],
    candidateConstraints: 'invoke vsync_dynamics_analysis first',
    candidateCriticalTools: ['vsync_dynamics_analysis'],
    appliedAt: 1_700_000_000_000,
  };

  let jobId: string;

  beforeEach(() => {
    execFileMock.mockReset();
    execFileMock.mockResolvedValue({ stdout: '', stderr: '' });
    // Reset in-flight job registry so jobIds can be reused across tests.
    worktreeTesting.ACTIVE_JOBS.clear();

    workingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-patch-orch-'));
    jobId = `job${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    const worktreePath = path.join(os.tmpdir(), `sp-autopatch-${jobId}`);
    strategyDir = path.join(worktreePath, 'backend', 'strategies');
    fs.mkdirSync(strategyDir, { recursive: true });
    fs.writeFileSync(
      path.join(strategyDir, 'scrolling.strategy.md'),
      '---\nscene: scrolling\nphase_hints:\n  - id: overview\n    keywords: [\'a\']\n    constraints: \'c\'\n    critical_tools: [\'t\']\n    critical: true\n---\n\nbody\n',
    );
  });

  afterEach(() => {
    fs.rmSync(path.join(os.tmpdir(), `sp-autopatch-${jobId}`), { recursive: true, force: true });
  });

  it('renders, opens a worktree, applies the patch, and returns the handle', async () => {
    const result = await proposeStrategyPatch({
      proposal,
      scene: 'scrolling',
      jobId,
      workingDir,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.phaseHintId).toMatch(/^auto_misdiagnosis-vsync-vrr_/);
    expect(result.renderedYaml).toContain('vsync');
    // The worktree was opened (git worktree add) but NOT removed on the
    // happy path — caller drives downstream checks.
    expect(execFileMock.mock.calls.some(c => c[1].includes('add'))).toBe(true);
    expect(execFileMock.mock.calls.some(c => c[1].includes('remove'))).toBe(false);

    const updated = fs.readFileSync(result.strategyFilePath, 'utf-8');
    expect(updated).toContain(result.phaseHintId);
  });

  it('returns render_failed for invalid proposals', async () => {
    const bad = { ...proposal, failureCategoryEnum: 'made_up' as never };
    const result = await proposeStrategyPatch({
      proposal: bad,
      scene: 'scrolling',
      jobId,
      workingDir,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('render_failed');
  });

  it('returns worktree_failed when git refuses to create the worktree', async () => {
    execFileMock.mockRejectedValueOnce(new Error('fatal: ref not found'));
    const result = await proposeStrategyPatch({
      proposal,
      scene: 'scrolling',
      jobId,
      workingDir,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('worktree_failed');
  });

  it('cleans up worktree when patch_failed (file_missing)', async () => {
    // Remove the pre-populated strategy file so applyPhaseHintPatch fails.
    fs.rmSync(strategyDir, { recursive: true, force: true });
    const result = await proposeStrategyPatch({
      proposal,
      scene: 'scrolling',
      jobId,
      workingDir,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('patch_failed');
    // worktree remove was invoked despite the failure.
    expect(execFileMock.mock.calls.some(c => c[1].includes('remove'))).toBe(true);
  });

  it('runs caller-supplied validate hook and cleans up on validation_failed', async () => {
    const result = await proposeStrategyPatch({
      proposal,
      scene: 'scrolling',
      jobId,
      workingDir,
      validate: async () => ({ ok: false, details: 'validate:strategies failed' }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('validation_failed');
      expect(result.details).toContain('validate:strategies failed');
    }
    expect(execFileMock.mock.calls.some(c => c[1].includes('remove'))).toBe(true);
  });

  it('respects a passing validate hook', async () => {
    const validate = jest.fn(async () => ({ ok: true } as const));
    const result = await proposeStrategyPatch({
      proposal,
      scene: 'scrolling',
      jobId,
      workingDir,
      validate: validate as never,
    });
    expect(result.ok).toBe(true);
    expect(validate).toHaveBeenCalledTimes(1);
  });
});
