// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {afterEach, describe, expect, it, jest} from '@jest/globals';

import {projectAnalysisFailure, projectStoredAnalysisFailure} from '../analysisFailureProjection';
import {providerNotFound} from '../providerManager/providerRequestError';
import {AnalysisContextAuthorizationChangedError} from '../resolvedAnalysisContext';
import {NO_PRIVATE_CONTEXT} from '../security/analysisPrivateContext';
import {
  clearAllCodeAwareOutputGuards,
  revokeCodeAwareOutputGuards,
} from '../security/codeAwareOutputRegistry';
import {TraceProcessorLeaseUnavailableError} from '../traceProcessorLeaseStore';

const PRIVATE = {codebase: true, knowledge: false} as const;
const CANARY = '/srv/smartperfetto/private/analysis.db';

function audience(privateContext: typeof PRIVATE | typeof NO_PRIVATE_CONTEXT, guardSessionId = 'runtime-session') {
  return {privateContext, guardSessionId, language: 'en' as const, requestId: 'req-failure-1'};
}

describe('projectAnalysisFailure', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    clearAllCodeAwareOutputGuards();
  });

  it('answers an untyped exception with fixed text naming the request id and logs the cause under it', () => {
    const log = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const cause = new Error(`SQLITE_CORRUPT: database disk image is malformed (${CANARY})`);

    const english = projectAnalysisFailure(cause, audience(NO_PRIVATE_CONTEXT));
    const chinese = projectAnalysisFailure(cause, {...audience(NO_PRIVATE_CONTEXT), language: 'zh-CN'});

    expect(english).toBe('Analysis did not complete; the server logged the error (request ID: req-failure-1).');
    expect(chinese).toBe('分析未能完成，服务端已记录错误（请求 ID：req-failure-1）。');
    expect(log).toHaveBeenCalledWith(expect.any(String),
      expect.objectContaining({requestId: 'req-failure-1'}), cause);
  });

  it('keeps the text SmartPerfetto wrote for the owner: typed failures and bare reason tokens', () => {
    const log = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const lease = new TraceProcessorLeaseUnavailableError('not_acquirable', 'Trace processor lease lease-1 is draining');

    expect(projectAnalysisFailure(lease, audience(NO_PRIVATE_CONTEXT))).toBe(lease.message);
    expect(projectAnalysisFailure(providerNotFound('p-1'), audience(NO_PRIVATE_CONTEXT))).toBe('Provider not found: p-1');
    expect(projectAnalysisFailure(new AnalysisContextAuthorizationChangedError(), audience(NO_PRIVATE_CONTEXT)))
      .toBe('analysis_context_changed_restart_required');
    // A reason token keeps only the token; the detail after `:` can carry ids or paths.
    expect(projectAnalysisFailure(new Error(`source_chunk_limit_exceeded:${CANARY}`), audience(NO_PRIVATE_CONTEXT)))
      .toBe('source_chunk_limit_exceeded');
    expect(log).not.toHaveBeenCalled();
  });

  it('logs only the error class of a private run, whose message may quote private material', () => {
    const log = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const text = projectAnalysisFailure(new TypeError(`cannot read ${CANARY}`), audience(PRIVATE));

    expect(text).toContain('req-failure-1');
    expect(JSON.stringify(log.mock.calls)).not.toContain(CANARY);
    expect(log).toHaveBeenCalledWith(expect.any(String), expect.anything(), {name: 'TypeError'});
  });

  it('projects a private run\'s typed text through its own guard and suppresses it once the session was revoked', () => {
    const credential = 'sk-proj-abcdefghijklmnop1234567890';
    const typed = providerNotFound(`api_key=${credential}`);

    expect(projectAnalysisFailure(typed, audience(PRIVATE, 'runtime-live'))).toBe('Provider not found: api_key=[REDACTED_SECRET]');
    expect(projectAnalysisFailure(typed, audience(NO_PRIVATE_CONTEXT, 'runtime-live'))).toContain(credential);

    revokeCodeAwareOutputGuards('runtime-revoked');
    expect(projectAnalysisFailure(typed, audience(PRIVATE, 'runtime-revoked'))).toBe('[PRIVATE_OUTPUT_SUPPRESSED]');
  });
});

describe('projectStoredAnalysisFailure', () => {
  afterEach(() => clearAllCodeAwareOutputGuards());

  it('returns a public run\'s stored text as written and passes a private run\'s through its guard again', () => {
    const stored = 'Analysis did not complete; the server logged the error (request ID: req-1).';
    const read = {guardSessionId: 'runtime-stored', language: 'en' as const};

    expect(projectStoredAnalysisFailure(stored, {...read, privateContext: NO_PRIVATE_CONTEXT})).toBe(stored);
    expect(projectStoredAnalysisFailure(undefined, {...read, privateContext: PRIVATE})).toBeUndefined();
    expect(projectStoredAnalysisFailure(stored, {...read, privateContext: PRIVATE})).toBe(stored);
    revokeCodeAwareOutputGuards('runtime-stored');
    expect(projectStoredAnalysisFailure(stored, {...read, privateContext: PRIVATE})).toBe('[PRIVATE_OUTPUT_SUPPRESSED]');
  });
});
