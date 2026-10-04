// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * The one projection of an analysis run's failure for the surfaces its owner
 * reads: the SSE `error` event, `/status`, the stored session and run state,
 * and the conversation's `run_failed` event and history.
 *
 * A provider or runtime that fails while analyzing does not throw: every
 * runtime returns a failed result with its own reason (`terminationMessage`),
 * which reaches the owner through the result surfaces. What a run throws is
 * one of the typed failures below, whose text SmartPerfetto wrote for the
 * caller, a reason token a service threw as its whole message
 * (`analysis_history_parent_not_authorized`; only the token, never the detail
 * after its `:`), or an arbitrary exception (SQLite, the filesystem),
 * whose message can carry paths, SQL or stored text. The owner then gets
 * fixed text with a request id, and the cause goes to the server log under it.
 *
 * A run with private context (source or knowledge) additionally projects the
 * typed text through its own output guard (`guardSessionId`), so a revoked
 * session's text is suppressed; its log line names only the error class.
 */

import type {OutputLanguage} from '../agentv3/outputLanguage';
import {localize} from '../agentv3/outputLanguage';
import {AiDisabledError} from './aiCapabilityPolicy';
import {ProviderRequestError} from './providerManager/providerRequestError';
import {ProviderStoreUnreadableError} from './providerManager/providerStore';
import {AnalysisContextAuthorizationChangedError} from './resolvedAnalysisContext';
import {
  privateContextRestrictsAudience,
  type AnalysisPrivateContextMarker,
} from './security/analysisPrivateContext';
import {projectOwnerAnalysisError} from './security/privateAnalysisProjection';
import {TraceProcessorLeaseUnavailableError} from './traceProcessorLeaseStore';
import {TraceProcessorAdmissionError} from './traceProcessorRamBudget';
import {thrownReasonCode} from '../utils/publicRequestError';

/** Failures whose message SmartPerfetto wrote for the run's owner to act on. */
const OWNER_ACTIONABLE_FAILURES: ReadonlyArray<abstract new (...args: never[]) => Error> = [
  AnalysisContextAuthorizationChangedError,
  AiDisabledError,
  ProviderRequestError,
  ProviderStoreUnreadableError,
  TraceProcessorAdmissionError,
  TraceProcessorLeaseUnavailableError,
];

interface AnalysisFailureAudience {
  /** The private-context marker of the failed run, fixed at its admission. */
  privateContext: AnalysisPrivateContextMarker;
  /** The physical runtime session whose output guard projects a private run's text. */
  guardSessionId: string | undefined;
  language: OutputLanguage;
}

function ownerActionableMessage(error: unknown): string | undefined {
  return OWNER_ACTIONABLE_FAILURES.some(errorClass => error instanceof errorClass)
    ? (error as Error).message
    : thrownReasonCode(error);
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** The text a run's owner sees when it failed with `error`; an untyped cause is logged under `requestId`. */
export function projectAnalysisFailure(
  error: unknown,
  audience: AnalysisFailureAudience & {requestId: string},
): string {
  const restricted = privateContextRestrictsAudience(audience.privateContext);
  const actionable = ownerActionableMessage(error);
  if (actionable !== undefined) {
    return restricted ? projectOwnerAnalysisError(audience.guardSessionId, actionable, audience.language) : actionable;
  }
  console.error('[AnalysisFailure] Analysis run failed', {
    requestId: audience.requestId,
    sessionId: audience.guardSessionId,
  }, restricted ? {name: errorName(error)} : error);
  return localize(
    audience.language,
    `分析未能完成，服务端已记录错误（请求 ID：${audience.requestId}）。`,
    `Analysis did not complete; the server logged the error (request ID: ${audience.requestId}).`,
  );
}

/**
 * A failure text already stored by `projectAnalysisFailure` (or written by the
 * product: a cancel reason), as a read surface returns it. A private run's
 * text passes its output guard again, which suppresses it once the session
 * was revoked.
 */
export function projectStoredAnalysisFailure(
  storedMessage: string | undefined,
  audience: AnalysisFailureAudience,
): string | undefined {
  if (!storedMessage || !privateContextRestrictsAudience(audience.privateContext)) return storedMessage;
  return projectOwnerAnalysisError(audience.guardSessionId, storedMessage, audience.language);
}
