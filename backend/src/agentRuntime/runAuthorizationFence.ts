// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {setImmediate} from 'node:timers';

import type {AnalysisOptions} from '../agent/core/orchestratorTypes';
import {
  AnalysisContextAuthorizationChangedError,
  assertCurrentAnalysisContextAuthorization,
  buildAnalysisContextAuthorizationFingerprint,
} from '../services/resolvedAnalysisContext';
import {resolveKnowledgeScope} from '../services/scopedKnowledgeStore';
import {authorizationRegistryWriteGeneration} from '../services/authorizationRegistryWrites';
import {analysisHasPrivateContext} from '../services/security/analysisPrivateContext';
import type {RuntimeExecutionLease} from './runtimeExecutionGuard';

/** The one check every model dispatch and tool boundary of a run makes. */
export interface RunAuthorizationCheck {
  /**
   * False for a run without private context: there is nothing a revoke could
   * withdraw, so every check passes and no tool is wrapped.
   */
  readonly enforced: boolean;
  /**
   * Throws `AnalysisContextAuthorizationChangedError`, after ending the run,
   * once the pinned authorization no longer holds, from a fresh read. A store
   * that cannot be read throws its own error and refuses only this dispatch:
   * it is not a revoke. Every model dispatch uses this.
   */
  assertCurrent(): void;
  /**
   * The same check for a tool boundary, sharing one successful read with every
   * other check of the current event-loop turn (a tool's pre-check and the
   * server's own, the calls of one batch) while no registry write of this
   * process happened since (`authorizationRegistryWriteGeneration`): an
   * in-process consent change or delete always forces a fresh read. Only
   * another process's change can wait for the next turn's check.
   */
  assertCurrentInTurn(): void;
  /** Ends the run for a mismatch another reader of the same pinned authorization saw; throws the fixed error. */
  revoke(): never;
  /** Settles when the run's cancel for a revoke has finished (at once when none started). */
  settled(): Promise<void>;
}

export interface RuntimeRunAuthorization {
  readonly fence: RunAuthorizationCheck;
  /** The lease, then the fence: the check before an in-process step. */
  assertActive(): void;
}

/**
 * A run's pinned analysis-context authorization, checked before every model
 * request the runtime can intercept and at every tool boundary. A native loop
 * resends earlier tool results (source or knowledge text among them) with each
 * request, so refusing later reads is not enough: the first check that sees a
 * changed fingerprint aborts the run's own lease and stops its native SDK or
 * session (`stopNative`), and every later check throws the same fixed error
 * without reading the registries again. Ending touches this run only: after
 * the lease settled it does nothing beyond refusing.
 *
 * Each check reads every selected registration from one fresh read of each
 * store; only tool-boundary checks share a read, within one event-loop turn
 * and while this process wrote no registry. Nothing is cached across turns.
 */
export function createRuntimeRunAuthorization(input: {
  options: AnalysisOptions;
  executionLease: RuntimeExecutionLease;
  /** The runtime's native stop for this run, beyond aborting its lease; may return its completion. */
  stopNative?: (error: AnalysisContextAuthorizationChangedError) => void | Promise<unknown>;
}): RuntimeRunAuthorization {
  const {options, executionLease} = input;
  const enforced = analysisHasPrivateContext(options);
  const scope = resolveKnowledgeScope(options);
  const fingerprint = enforced
    ? options.analysisContextFingerprint ?? buildAnalysisContextAuthorizationFingerprint(options, scope)
    : '';
  let revoked: AnalysisContextAuthorizationChangedError | undefined;
  let ending: Promise<void> = Promise.resolve();
  // The registry write generation a fresh read of this turn verified, if any.
  let verifiedGeneration: number | undefined;
  const end = (error: AnalysisContextAuthorizationChangedError): never => {
    if (!revoked) {
      revoked = error;
      try {
        if (executionLease.abort(error)) {
          ending = Promise.resolve(input.stopNative?.(error)).then(() => undefined, () => undefined);
        }
      } catch {
        // Ending is the runtime's cancel; the throw below still refuses this dispatch.
      }
    }
    throw revoked;
  };
  const fence: RunAuthorizationCheck = {
    enforced,
    assertCurrent() {
      if (revoked) throw revoked;
      if (!enforced) return;
      try {
        assertCurrentAnalysisContextAuthorization(options, scope, fingerprint);
      } catch (error) {
        if (error instanceof AnalysisContextAuthorizationChangedError) end(error);
        throw error;
      }
      if (verifiedGeneration === undefined) setImmediate(() => { verifiedGeneration = undefined; });
      verifiedGeneration = authorizationRegistryWriteGeneration();
    },
    assertCurrentInTurn() {
      if (revoked) throw revoked;
      if (verifiedGeneration !== authorizationRegistryWriteGeneration()) fence.assertCurrent();
    },
    revoke: () => end(revoked ?? new AnalysisContextAuthorizationChangedError()),
    settled: () => ending,
  };
  return {
    fence,
    assertActive: () => {
      executionLease.throwIfAborted();
      fence.assertCurrent();
    },
  };
}

/**
 * Throws the fixed error a run ends with when its lease was aborted for a
 * revoke, instead of letting the runtime build a cancelled or partial result:
 * every surface then reports `analysis_context_changed_restart_required` and
 * nothing of the revoked run is committed.
 */
export function throwIfRunAuthorizationRevoked(signal: AbortSignal): void {
  if (signal.aborted && signal.reason instanceof AnalysisContextAuthorizationChangedError) throw signal.reason;
}
