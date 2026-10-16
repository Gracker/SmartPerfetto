// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {expect} from '@jest/globals';

import type {AnalysisResult} from '../../src/agent/core/orchestratorTypes';
import type {VerificationIssue} from '../../src/agentv3/types';
import {quickStopReasonFromTermination} from '../../src/agentRuntime/quickBudget';

/**
 * A runtime diagnostic no same-run repair addresses: it has no recovery kind.
 * Before the finalizer owned the terminal state, Qoder, OpenCode and Pi turned
 * one of these into `partial` / `quality_gate_failed`, Claude announced it as
 * a `degraded` update, and OpenAI ignored it.
 */
export const UNREPAIRABLE_DRAFT_ISSUE: VerificationIssue = Object.freeze({
  type: 'missing_evidence', severity: 'error', message: 'draft-only runtime diagnostic',
}) as VerificationIssue;

interface RecordedTurnResult {
  partial?: boolean;
  terminationReason?: string;
  terminationMessage?: string;
  confidence?: number;
}

/**
 * The contract every runtime keeps: what it returns, streams and records
 * before `addTurn` follows from native facts only. The quality verdict is the
 * product finalizer's, which annotates the recorded turn afterwards.
 */
export function expectRuntimeLeftTerminalStateToFinalizer(input: {
  result: AnalysisResult;
  updates: ReadonlyArray<{type?: string; content?: unknown}>;
  native: {partial: boolean; terminationReason?: AnalysisResult['terminationReason']};
  /** The result the runtime passed to `sessionContext.addTurn` for this run. */
  recordedTurn: RecordedTurnResult | undefined;
}): void {
  const {result, updates, native, recordedTurn} = input;
  expect(result.partial === true).toBe(native.partial);
  expect(result.terminationReason).toBe(native.terminationReason);
  expect(result.terminationReason).not.toBe('quality_gate_failed');
  expect(updates.filter(update => update.type === 'degraded')).toEqual([]);
  expect(updates.filter(update => update.type === 'progress' &&
    (update.content as {phase?: string} | undefined)?.phase === 'concluding')).toEqual([]);
  expect(recordedTurn).toBeDefined();
  expect(recordedTurn!.partial === true).toBe(native.partial);
  expect(recordedTurn!.terminationReason).toBe(result.terminationReason);
  expect(recordedTurn!.terminationMessage).toBe(result.terminationMessage);
  expect(recordedTurn!.confidence).toBe(result.confidence);
  if (result.quickRun) {
    expect(result.quickRun.stopReason).toBe(quickStopReasonFromTermination({
      partial: native.partial, terminationReason: native.terminationReason,
      actualTurns: result.quickRun.actualTurns, targetTurns: result.quickRun.targetTurns,
      hardCapTurns: result.quickRun.hardCapTurns,
    }));
  }
}
