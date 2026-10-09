// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {CodeLookupLedgerEntry} from '../../services/codebase/codeLookupLedger';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  privateProjectedSourceEventType,
  successfulCodeLookupToolCounts,
} from '../agentSseVerificationEvidence';
import {
  collectAgentSseOracleRows,
  evaluateAgentSseAcceptance,
  evaluateAgentSseExpectation,
  evaluateAgentSseInvestigationExpectation,
  agentSseExpectationHash,
  resolveAgentSseRunIdentity,
  traceProcessorVersionKey,
  parseAgentSseExpectation,
  taskAcceptanceStatus,
  assertVerificationTraceReady,
  loadVerificationTracePair,
  collectSseSummary,
  findSessionLogFile,
  preserveVerificationSessionLog,
  VerificationLifecycleError,
  recordVerificationFailureAndCancel,
  VerificationSseTimeoutError,
  VerificationSliceSelectionError,
  parseSliceSelectionTarget,
  resolveVerificationSliceSelection,
  installVerificationDiagnostics,
  writeVerificationDiagnostics,
  prepareAgentSseNativeOracle,
  collectAgentSseOracleEvidence,
  parseArgs as parseVerificationArgs,
  type TerminalAnalysisEvidence,
} from '../verifyAgentSseScrolling';
import {analysisDeliveryFingerprint} from '../../types/analysisDelivery';
import * as nativeCapture from '../../services/evidence/rawSqlNativeProvenance';
import type {PerfettoSqlDocsAsset} from '../../services/perfettoSqlDocs';
import type {RunningNativeProcessorObservation, TraceInfo} from '../../services/traceProcessorService';
import type {AnalysisRunTraceProcessorLeases} from '../../services/analysisRunTraceProcessorLease';

describe('transparent verification diagnostics', () => {
  const stops: Array<() => unknown> = [];
  afterEach(() => {stops.splice(0).forEach(stop => stop()); jest.restoreAllMocks();});
  function fixture() {
    let time = 100;
    const payload = {model: 'private-model', choices: [{finish_reason: 'stop', message: {content: 'PRIVATE_BODY'}}]};
    const jsonPromise = Promise.resolve(payload);
    const json = jest.fn(function(this: unknown, ..._args: unknown[]) {return jsonPromise;});
    const response = {status: 200, json};
    const fetchPromise = Promise.resolve(response);
    const fetch = jest.fn(function(this: unknown, ..._args: unknown[]) {return fetchPromise;});
    const fetchTarget = {fetch};
    const result = {columns: ['PRIVATE_COLUMN'], rows: [['PRIVATE_CELL']]};
    const queryPromise = Promise.resolve(result);
    const query = jest.fn(function(this: unknown, ..._args: unknown[]) {return queryPromise;});
    const queryPrototype = {query, queryBounded: query};
    const processor = Object.assign(Object.create(queryPrototype), {analysisRunPrivate: true,
      getNativeProvenanceSnapshot: () => ({status: 'trusted', nativeSchemaEligible: true})});
    const diagnostics = installVerificationDiagnostics({phase: () => 'analysis_stream', fetchTarget, queryPrototype, now: () => time});
    stops.push(() => diagnostics.stop());
    return {diagnostics, fetchTarget, fetch, fetchPromise, response, json, jsonPromise, payload,
      queryPrototype, processor, query, queryPromise, result, time: (value: number) => {time = value;}};
  }

  it('returns the original promises and objects while preserving this, args and capture identity', async () => {
    const globalFetch = globalThis.fetch;
    const target = fixture();
    const fields = new WeakMap<object, any>([[target.result, {PRIVATE_COLUMN: {unit: 'ns'}}]]);
    jest.spyOn(nativeCapture, 'readRawSqlCaptureFields').mockImplementation(value => fields.get(value as object));
    const signal = new AbortController().signal;
    const init = {body: JSON.stringify({model: 'requested-private-model', stream: false, messages: ['PRIVATE_PROMPT']}), signal};
    const fetched = target.fetchTarget.fetch('https://provider.invalid/v1/chat/completions', init);
    expect(fetched).toBe(target.fetchPromise);
    expect(target.fetch.mock.contexts[0]).toBe(target.fetchTarget);
    expect(target.fetch.mock.calls[0]).toEqual(['https://provider.invalid/v1/chat/completions', init]);
    expect(await fetched).toBe(target.response);
    expect(target.json).not.toHaveBeenCalled();
    expect(target.response.json()).toBe(target.jsonPromise);
    expect(await target.jsonPromise).toBe(target.payload);
    expect(target.json.mock.contexts[0]).toBe(target.response);
    const options = {signal};
    expect(target.processor.query('SELECT dur FROM slice', options)).toBe(target.queryPromise);
    expect(await target.queryPromise).toBe(target.result);
    expect(target.query.mock.contexts[0]).toBe(target.processor);
    expect(target.query.mock.calls[0]).toEqual(['SELECT dur FROM slice', options]);
    expect(nativeCapture.readRawSqlCaptureFields).toHaveBeenCalledWith(target.result);
    const snapshot = target.diagnostics.stop();
    expect(snapshot.fetch[0]).toMatchObject({state: 'json_fulfilled', stream: false, httpStatus: 200, finishReason: 'stop', outputChars: 12});
    expect(snapshot.sql[0]).toMatchObject({state: 'fulfilled', analysisRunPrivate: true, pureRead: true,
      nativeStatusAtCall: 'trusted', nativeStatusAtSettle: 'trusted', directProjection: true,
      captureFieldsPresent: true, captureFieldCount: 1});
    expect(JSON.stringify(snapshot)).not.toMatch(/PRIVATE_|private-model|SELECT|provider\.invalid/);
    expect(globalThis.fetch).toBe(globalFetch);
    expect(target.fetchTarget.fetch).toBe(target.fetch);
    expect(target.response.json).toBe(target.json);
  });

  it.each(['fetch', 'json'] as const)('distinguishes pending %s and ignores late completion after a frozen stop', async stage => {
    const target = fixture();
    let settle!: (value: any) => void;
    const pending = new Promise<any>(resolve => {settle = resolve;});
    if (stage === 'fetch') target.fetch.mockReturnValue(pending);
    else target.json.mockReturnValue(pending);
    const returned = target.fetchTarget.fetch('https://provider.invalid/responses', {body: '{"model":"m"}'});
    if (stage === 'json') {(await returned).json();}
    target.time(160);
    const snapshot = target.diagnostics.stop();
    expect(snapshot.fetch[0].state).toBe(stage === 'fetch' ? 'fetch_pending' : 'json_pending');
    expect(snapshot.fetch[0]).not.toHaveProperty('outputChars');
    const serialized = JSON.stringify(snapshot);
    settle(stage === 'fetch' ? target.response : target.payload);
    await pending;
    await Promise.resolve();
    expect(JSON.stringify(snapshot)).toBe(serialized);
    expect(Object.isFrozen(snapshot.fetch[0])).toBe(true);
    expect(target.diagnostics.stop()).toBe(snapshot);
  });

  it('preserves rejection and observes abort without aborting or rewriting input', async () => {
    const target = fixture();
    const controller = new AbortController();
    const error = new Error('PRIVATE_FAILURE');
    const rejected = Promise.reject(error);
    target.fetch.mockReturnValue(rejected);
    const returned = target.fetchTarget.fetch('https://provider.invalid/responses', {signal: controller.signal});
    expect(returned).toBe(rejected);
    expect(controller.signal.aborted).toBe(false);
    controller.abort(error);
    await expect(returned).rejects.toBe(error);
    expect(target.diagnostics.stop().fetch[0]).toMatchObject({state: 'fetch_rejected', abortObservedElapsedMs: 0});
  });

  it('does not read opaque request bodies, response headers or an unused streamed json body', async () => {
    const target = fixture();
    const opaque = {text: jest.fn(() => {throw new Error('PRIVATE_REQUEST');})};
    Object.defineProperty(target.response, 'headers', {get: () => {throw new Error('PRIVATE_HEADER');}});
    await target.fetchTarget.fetch('https://provider.invalid/responses', {body: opaque});
    await target.fetchTarget.fetch('https://provider.invalid/chat/completions', {body: '{"stream":true}'});
    expect(opaque.text).not.toHaveBeenCalled();
    expect(target.json).not.toHaveBeenCalled();
    const snapshot = target.diagnostics.stop();
    expect(snapshot.fetch[0]).toMatchObject({stream: 'unknown', state: 'headers_received'});
    expect(snapshot.fetch[1]).toMatchObject({stream: true, state: 'headers_received'});
    expect(snapshot.fetch.every(row => row.outputChars === undefined)).toBe(true);
  });

  it('observes fetch(Request) by URL without reading its body or inferring input and model metadata', async () => {
    const target = fixture();
    const request = new Request('https://provider.invalid/v1/chat/completions', {method: 'POST', body: 'PRIVATE_REQUEST'});
    const forbiddenRead = jest.fn(() => {throw new Error('PRIVATE_READ');});
    Object.defineProperty(request, 'body', {get: forbiddenRead});
    Object.defineProperty(request, 'headers', {get: forbiddenRead});
    Object.defineProperty(request, 'clone', {value: forbiddenRead});
    Object.defineProperty(request, 'text', {value: forbiddenRead});
    const promise = target.fetchTarget.fetch(request);
    expect(promise).toBe(target.fetchPromise);
    expect(await promise).toBe(target.response);
    expect(target.fetch.mock.calls[0][0]).toBe(request);
    expect(forbiddenRead).not.toHaveBeenCalled();
    expect(request.bodyUsed).toBe(false);
    const snapshot = target.diagnostics.stop();
    expect(snapshot.fetch[0]).toMatchObject({endpoint: 'chat_completions', state: 'headers_received',
      requestMetadata: 'unavailable', stream: 'unknown'});
    expect(snapshot.fetch[0]).not.toHaveProperty('inputBytes');
    expect(snapshot.fetch[0]).not.toHaveProperty('requestedModelHash');
    expect(JSON.stringify(snapshot)).not.toContain('PRIVATE');
  });

  it.each([
    ['SELECT 42 AS value FROM slice', false],
    ['SELECT dur / 1e6 AS value FROM slice', false],
    ['SELECT dur, dur / 1e6 AS value FROM slice', true],
    ['SELECT * FROM slice', true],
  ] as const)('records direct projection candidates independently of native capture: %s', async (sql, directProjection) => {
    const target = fixture();
    expect(target.processor.query(sql)).toBe(target.queryPromise);
    await target.queryPromise;
    expect(target.diagnostics.stop().sql[0]).toMatchObject({pureRead: true, directProjection,
      captureFieldsPresent: false, captureFieldCount: 0});
  });

  it('reserves bounded slots at call time including requests that never settle', () => {
    const target = fixture();
    target.fetch.mockReturnValue(new Promise<any>(() => undefined));
    target.query.mockReturnValue(new Promise<any>(() => undefined));
    for (let index = 0; index < 34; index++) target.fetchTarget.fetch('https://provider.invalid/responses');
    for (let index = 0; index < 130; index++) target.processor.queryBounded('SELECT dur FROM slice');
    const snapshot = target.diagnostics.stop();
    expect(snapshot.fetch).toHaveLength(32);
    expect(snapshot.sql).toHaveLength(128);
    expect(snapshot).toMatchObject({fetchDroppedCount: 2, sqlDroppedCount: 2});
  });

  it('restores exact json descriptors and preserves a third-party replacement', async () => {
    const target = fixture();
    const descriptor = {value: target.json, enumerable: false, configurable: true, writable: false};
    Object.defineProperty(target.response, 'json', descriptor);
    await target.fetchTarget.fetch('https://provider.invalid/responses');
    const replacement = jest.fn(() => target.fetchPromise);
    target.fetchTarget.fetch = replacement;
    expect(target.diagnostics.stop().restoreConflicts).toBe(1);
    expect(target.fetchTarget.fetch).toBe(replacement);
    expect(Object.getOwnPropertyDescriptor(target.response, 'json')).toEqual(descriptor);
  });

  it('restores inherited json methods without leaving an own property and tolerates readonly methods', async () => {
    const target = fixture();
    const response = Object.create({json: target.json});
    response.status = 200;
    target.fetch.mockReturnValue(Promise.resolve(response));
    await target.fetchTarget.fetch('https://provider.invalid/responses');
    expect(Object.prototype.hasOwnProperty.call(response, 'json')).toBe(true);
    target.diagnostics.stop();
    expect(Object.prototype.hasOwnProperty.call(response, 'json')).toBe(false);

    const readonly = fixture();
    Object.defineProperty(readonly.response, 'json', {value: readonly.json, configurable: false, writable: false});
    expect(await readonly.fetchTarget.fetch('https://provider.invalid/responses')).toBe(readonly.response);
    expect(readonly.diagnostics.stop().observationFailures).toBe(1);
    expect(readonly.response.json).toBe(readonly.json);
  });

  it.each(['fetch', 'query'] as const)('preserves a synchronous %s exception without copying error text', kind => {
    const target = fixture();
    const error = new Error('PRIVATE_EXCEPTION');
    const invoke = kind === 'fetch'
      ? () => target.fetchTarget.fetch('https://provider.invalid/responses')
      : () => target.processor.query('SELECT dur FROM slice');
    target[kind].mockImplementation(() => {throw error;});
    let caught: unknown;
    try {invoke();} catch (value) {caught = value;}
    expect(caught).toBe(error);
    expect(JSON.stringify(target.diagnostics.stop())).not.toContain('PRIVATE_EXCEPTION');
  });

  it('counts response-protocol text without retaining text or trusting provider status fields', async () => {
    const target = fixture();
    const payload = {model: 'PRIVATE_MODEL', status: 'PRIVATE_STATUS', output: [
      {type: 'message', content: [{type: 'output_text', text: 'PRIVATE_ANSWER'}]},
    ]};
    const promise = Promise.resolve(payload);
    target.json.mockReturnValue(promise as any);
    await target.fetchTarget.fetch('https://provider.invalid/responses');
    expect(target.response.json()).toBe(promise);
    expect(await promise).toBe(payload);
    const snapshot = target.diagnostics.stop();
    expect(snapshot.fetch[0]).toMatchObject({state: 'json_fulfilled', responseStatus: 'unknown', outputChars: 14});
    expect(JSON.stringify(snapshot)).not.toContain('PRIVATE');
  });

  it('keeps observer failures and unknown provider enums out of business results', async () => {
    const target = fixture();
    target.payload.choices[0].finish_reason = 'PRIVATE_FINISH';
    await target.fetchTarget.fetch('https://provider.invalid/responses', {body: '{invalid PRIVATE_JSON'});
    expect(await target.response.json()).toBe(target.payload);
    const snapshot = target.diagnostics.stop();
    expect(snapshot.observationFailures).toBe(1);
    expect(snapshot.fetch[0].finishReason).toBe('unknown');
    expect(JSON.stringify(snapshot)).not.toContain('PRIVATE');
  });

  it('does not replace the original exit state when diagnostic persistence fails', () => {
    const target = fixture();
    const exitCode = process.exitCode;
    const log = jest.spyOn(console, 'error').mockImplementation(() => {throw new Error('PRIVATE_LOG_FAILURE');});
    jest.spyOn(fs, 'mkdirSync').mockImplementation(() => {throw new Error('PRIVATE_PATH');});
    expect(writeVerificationDiagnostics('/private/report', target.diagnostics.stop())).toBe(false);
    expect(log).toHaveBeenCalledWith('diagnostic_write_failed');
    expect(process.exitCode).toBe(exitCode);
  });
});

describe('current-trace slice selection resolution', () => {
  const selector = {processName: 'com.example.target', threadName: 'main', eventName: 'Target event'};
  const columns = ['event_id', 'ts', 'track_id', 'utid', 'upid', 'dur'];
  const match = (dur: unknown = 42_000_000, ts: unknown = '40919952686988') =>
    ({columns, rows: [[7, ts, 19, 11, 10, dur]], durationMs: 1});

  it('parses only a bounded identity selector and rejects conflicting input scopes', () => {
    expect(parseSliceSelectionTarget(selector)).toEqual(selector);
    const args = ['--select-slice-json', JSON.stringify(selector)];
    expect(parseVerificationArgs(args).sliceSelectionTarget).toEqual(selector);
    for (const value of [null, [], {}, {...selector, eventName: ''}, {...selector, threadName: 'main\n'},
      {...selector, eventName: 'event\u0000'}, {...selector, eventName: 'event\u0085'},
      {...selector, processName: 'p'.repeat(257)}, {...selector, eventName: 'x'.repeat(1025)},
      {...selector, eventName: 1}, {...selector, dur: 42_000_000}]) {
      expect(() => parseSliceSelectionTarget(value)).toThrow('SLICE_SELECTION_INVALID');
    }
    expect(() => parseVerificationArgs(args.concat(args))).toThrow('SLICE_SELECTION_INVALID');
    const direct = ['--selection-context-json', JSON.stringify({kind: 'track_event', eventId: 9, ts: 1})];
    expect(() => parseVerificationArgs(args.concat(direct))).toThrow('SLICE_SELECTION_INVALID');
    expect(() => parseVerificationArgs(direct.concat(args))).toThrow('SLICE_SELECTION_INVALID');
  });

  it('reads a bounded selector file without allowing a large or non-object payload', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-selector-'));
    const filePath = path.join(directory, 'selector.json');
    try {
      fs.writeFileSync(filePath, JSON.stringify(selector));
      expect(parseVerificationArgs(['--select-slice-json', `@${filePath}`]).sliceSelectionTarget).toEqual(selector);
      for (const raw of ['null', 'invalid json', ' '.repeat(8193)]) {
        fs.writeFileSync(filePath, raw);
        expect(() => parseVerificationArgs(['--select-slice-json', `@${filePath}`])).toThrow('SLICE_SELECTION_INVALID');
      }
    } finally { fs.rmSync(directory, {recursive: true, force: true}); }
  });

  it('queries only this loaded trace, escapes literals, and returns an identity-and-range frontend selection', async () => {
    const queryBounded = jest.fn(async () => match());
    const escaped = {processName: "App' OR 1=1 --", threadName: "main's", eventName: "event'); DROP TABLE slice; --"};
    const result = await resolveVerificationSliceSelection({service: {queryBounded}, traceId: 'loaded-current-trace',
      selector: escaped, timeoutMs: 1_200_000});
    expect(queryBounded).toHaveBeenCalledWith('loaded-current-trace', expect.any(String),
      expect.objectContaining({timeoutMs: 10_000, maxRows: 2, maxResponseBytes: 16 * 1024, signal: expect.any(AbortSignal)}));
    const sql = (queryBounded.mock.calls[0] as unknown as [string, string])[1];
    expect(sql).toContain("p.name = 'App'' OR 1=1 --'");
    expect(sql).toContain("t.name = 'main''s'");
    expect(sql).toContain("s.name = 'event''); DROP TABLE slice; --'");
    expect(sql).toContain('LIMIT 2');
    expect(sql).toContain('s.dur');
    expect(result.selectionContext).toEqual({kind: 'track_event', source: 'track_event_selection',
      eventId: 7, ts: 40919952686988, dur: 42_000_000});
    expect(result.identity).toEqual({traceId: 'loaded-current-trace', table: 'slice',
      eventId: 7, ts: 40919952686988, trackId: 19, utid: 11, upid: 10});
    expect(result.purpose).toBe('input_scope_not_verified_evidence');
  });

  it.each([
    [0, -5, {kind: 'track_event', source: 'track_event_selection', eventId: 7, ts: -5, dur: 0}],
    [-1, 40919952686988, {kind: 'track_event', source: 'track_event_selection', eventId: 7, ts: 40919952686988}],
  ])('preserves finite duration %s with unfinished omission and legal negative timestamps',
    async (dur, ts, expected) => {
      const result = await resolveVerificationSliceSelection({service: {queryBounded: jest.fn(async () => match(dur, ts))},
        traceId: 'current', selector, timeoutMs: 1000});
      expect(result.selectionContext).toEqual(expected);
    });

  it.each([
    ['SLICE_SELECTION_NOT_FOUND', {columns, rows: [], durationMs: 1}],
    ['SLICE_SELECTION_AMBIGUOUS', {columns, rows: [match().rows[0], match().rows[0]], durationMs: 1}],
    ['SLICE_SELECTION_QUERY_FAILED', {...match(), error: 'private query error'}],
    ['SLICE_SELECTION_INVALID_IDENTITY', {...match(), columns: ['id', 'ts', 'track_id', 'utid', 'upid', 'dur']}],
    ['SLICE_SELECTION_INVALID_IDENTITY', {...match(), rows: [[7, '9007199254740992', 19, 11, 10, 1]]}],
    ['SLICE_SELECTION_INVALID_IDENTITY', {...match(), rows: [[-1, 1000, 19, 11, 10, 1]]}],
    ['SLICE_SELECTION_INVALID_IDENTITY', {...match(), rows: [[7, null, 19, 11, 10, 1]]}],
    ['SLICE_SELECTION_INVALID_IDENTITY', {...match(), rows: [[7, 1000, 19, 11, 10, -2]]}],
    ['SLICE_SELECTION_INVALID_IDENTITY', {...match(), rows: [[7, 1000, 19, 11, 10, null]]}],
    ['SLICE_SELECTION_INVALID_IDENTITY', {...match(), rows: [[7, 1000, 19, 11, 10, 1.5]]}],
    ['SLICE_SELECTION_INVALID_IDENTITY', {...match(), rows: [[7, 1000, 19, 11, 10, '1.5']]}],
    ['SLICE_SELECTION_INVALID_IDENTITY', {...match(), rows: [[7, 1000, 19, 11, 10, '9007199254740992']]}],
    ['SLICE_SELECTION_INVALID_IDENTITY', {...match(), rows: [[7, 1000, 19, 11, 10, Number.MAX_SAFE_INTEGER + 1]]}],
    ['SLICE_SELECTION_INVALID_IDENTITY', {...match(), rows: [
      [7, Number.MAX_SAFE_INTEGER - 5, 19, 11, 10, 10],
    ]}],
  ])('fails with %s before analysis can start', async (code, response) => {
    const queryBounded = jest.fn(async () => response as ReturnType<typeof match>);
    const startAnalysis = jest.fn();
    await expect(resolveVerificationSliceSelection({service: {queryBounded}, traceId: 'current', selector, timeoutMs: 1000})
      .then(startAnalysis)).rejects.toThrow(String(code));
    expect(startAnalysis).not.toHaveBeenCalled();
  });

  it('propagates pre-cancellation and a real timeout to the bounded query', async () => {
    const controller = new AbortController();
    controller.abort();
    const neverQuery = jest.fn(async () => match());
    await expect(resolveVerificationSliceSelection({service: {queryBounded: neverQuery}, traceId: 'current',
      selector, timeoutMs: 1000, signal: controller.signal})).rejects.toThrow('SLICE_SELECTION_CANCELLED');
    expect(neverQuery).not.toHaveBeenCalled();
    const queryBounded = jest.fn((_traceId: string, _sql: string, options: {signal?: AbortSignal}) =>
      new Promise<ReturnType<typeof match>>((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => reject(options.signal?.reason), {once: true});
      }));
    await expect(resolveVerificationSliceSelection({service: {queryBounded}, traceId: 'current', selector, timeoutMs: 10}))
      .rejects.toThrow('SLICE_SELECTION_TIMEOUT');
  });

  it('records selection failure distinctly without cancellation or provider text when no run was started', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-selector-failure-'));
    try {
      const request = jest.fn();
      const result = await recordVerificationFailureAndCancel({baseUrl: 'http://verifier.invalid',
        outputPath: path.join(directory, 'failure.json'), phase: 'selection_resolution', startedAt: Date.now(),
        timeoutMs: 1000, error: new VerificationSliceSelectionError('SLICE_SELECTION_AMBIGUOUS')}, request);
      expect(result).toMatchObject({errorCode: 'SLICE_SELECTION_AMBIGUOUS', cancellation: 'not_owned', completeAcceptance: false});
      expect(request).not.toHaveBeenCalled();
    } finally { fs.rmSync(directory, {recursive: true, force: true}); }
  });
});

describe('owned SSE verifier lifecycle', () => {
  afterEach(() => jest.restoreAllMocks());

  it('retains at most four shared-schema candidate diagnostics without private surrounding fields or admission authority', async () => {
    const diagnostic = {schemaVersion: 'candidate_protocol_diagnostic@1', stage: 'native', candidateIndex: 1,
      status: 'invalid', sidecarStatus: 'invalid', typedJsonStatus: 'not_checked',
      issueCodes: ['invalid_reference'], issueCount: 1, rawChars: 1000, canonicalChars: 0,
      projectionKind: 'protocol_projection'};
    const invalid = [
      {...diagnostic, raw: 'PRIVATE_PROTOCOL_CANARY'},
      {...diagnostic, path: '/private/source'},
      {...diagnostic, claimId: 'PRIVATE_PROTOCOL_CANARY'},
      {...diagnostic, issueCodes: ['PRIVATE_PROTOCOL_CANARY']},
      {...diagnostic, rawChars: -1},
    ];
    const valid = [diagnostic, {...diagnostic, stage: 'runtime_projected'},
      {...diagnostic, candidateIndex: 2}, {...diagnostic, candidateIndex: 2, stage: 'runtime_projected'}];
    const events = [
      {phase: 'unrelated', candidateProtocolDiagnostic: diagnostic},
      ...[...invalid, ...valid, ...valid].map(candidateProtocolDiagnostic => ({phase: 'candidate_protocol',
        candidateProtocolDiagnostic, message: 'PRIVATE_PROTOCOL_CANARY', path: '/private/source'})),
    ].map(data => `event: progress\ndata: ${JSON.stringify(data)}\n\n`).join('') +
      'event: analysis_completed\ndata: {"success":false,"conclusion":"","partial":true}\n\n';
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(events));
    const summary = await collectSseSummary('http://verifier.invalid', 'session', 1000,
      {requiredText: [], forbiddenText: []}, {runId: 'run'});
    expect(summary.candidateProtocolDiagnostics).toEqual(valid);
    expect(JSON.stringify(summary)).not.toContain('PRIVATE_PROTOCOL_CANARY');
    expect(JSON.stringify(summary)).not.toContain('/private/source');
    expect(summary.terminalAnalysis?.success).toBe(false);
    expect(summary.analysisCompletedPartial).toBe(true);
  });

  it('counts a provisional conclusion apart from the terminal conclusion payload', async () => {
    const events = 'event: conclusion\ndata: {"data":{"conclusion":"Final body","provisional":true,"verification":"pending"}}\n\n' +
      'event: analysis_completed\ndata: {"success":true,"conclusion":"Final body"}\n\n';
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(events));
    const summary = await collectSseSummary('http://verifier.invalid', 'session', 1000,
      {requiredText: [], forbiddenText: []}, {runId: 'run'});
    expect(summary.provisionalConclusionCount).toBe(1);
    expect(summary.firstProvisionalConclusionMs).toEqual(expect.any(Number));
    expect(summary.conclusionCount).toBe(0);
    expect(summary.analysisCompletedConclusionChars).toBe('Final body'.length);
  });

  it('turns a stalled owned stream into a typed timeout and releases its reader', async () => {
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => new Response(new ReadableStream({
      start(controller) {
        options?.signal?.addEventListener('abort', () => controller.error(options.signal?.reason), {once: true});
      },
    })));
    await expect(collectSseSummary('http://verifier.invalid', 'session', 10,
      {requiredText: [], forbiddenText: []}, {runId: 'run-2'})).rejects.toBeInstanceOf(VerificationSseTimeoutError);
    expect(fetch).toHaveBeenCalledWith('http://verifier.invalid/api/agent/v1/runs/run-2/stream',
      expect.objectContaining({signal: expect.any(AbortSignal)}));
  });

  it('extracts actual verified binding identities without persisting private reasons', async () => {
    const binding = {claimId: 'duration', mechanismStatus: 'compatible',
      sourceReferenceIds: ['source-ref-v1-issued'], traceEvidenceRefIds: ['data-marker']};
    const payload = {success: true, conclusion: 'Safe conclusion.',
      sourceUseDecision: {references: [{id: 'source-ref-v1-issued'}]},
      sourceClaimVerificationResult: {schemaVersion: 'source_claim_verifier@1', status: 'passed',
        bindings: [{...binding, reason: 'private source content'}]}};
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(`event: analysis_completed\ndata: ${JSON.stringify(payload)}\n\n`));
    const summary = await collectSseSummary('http://verifier.invalid', 'session', 1000,
      {requiredText: [], forbiddenText: []}, {runId: 'run'});
    // A historical result reports its stored mechanism status as the row status.
    const {mechanismStatus, ...identity} = binding;
    expect(summary.analysisCompletedVerifiedSourceBindings).toEqual([{...identity, status: mechanismStatus}]);
    expect(JSON.stringify(summary)).not.toContain('private source content');
  });

  it('reports the current verifier\'s per-claim standing as the row status', async () => {
    const claim = {claimId: 'duration', status: 'trace_linked',
      sourceReferenceIds: ['source-ref-v1-issued'], traceEvidenceRefIds: ['data-marker']};
    const payload = {success: true, conclusion: 'Safe conclusion.',
      sourceUseDecision: {references: [{id: 'source-ref-v1-issued'}]},
      sourceClaimVerificationResult: {schemaVersion: 'source_claim_verifier@2', status: 'partial', bindings: [],
        claims: [claim, {claimId: 'other', status: 'unbound', sourceReferenceIds: [], traceEvidenceRefIds: []}],
        citations: [], issues: []}};
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(`event: analysis_completed\ndata: ${JSON.stringify(payload)}\n\n`));
    const summary = await collectSseSummary('http://verifier.invalid', 'session', 1000,
      {requiredText: [], forbiddenText: []}, {runId: 'run'});
    expect(summary.analysisCompletedSourceClaimStatuses).toEqual(['trace_linked', 'unbound']);
    // An unbound claim cites nothing, which does not void the membership of the others.
    expect(summary.analysisCompletedSourceReferenceMembershipPassed).toBe(true);
    expect(summary.analysisCompletedVerifiedSourceBindings?.[0]).toEqual(claim);
  });

  it('retains private tool telemetry and safe actual source use when a failed terminal has no conclusion contract', async () => {
    const sourceRoot = path.resolve(__dirname, '../../../tests/e2e/context-fixtures/app');
    const canaryLine = fs.readFileSync(path.join(sourceRoot, 'StartupHooks.kt'), 'utf8').split(/\r?\n/)
      .findIndex(line => line.includes('SEMANTIC_DELTA_PRIVATE_SOURCE_CANARY_NEVER_EMIT')) + 1;
    expect(canaryLine).toBeGreaterThan(0);
    const sourceUseDecision = {schemaVersion: 'source_use_decision@1', codeAwareMode: 'provider_send',
      selectedCodebaseIds: ['cb-source'], queriedCodebaseIds: ['cb-source'], usedCodebaseIds: ['cb-source'],
      status: 'corroborated', attemptedTools: ['search_codebase', 'read_codebase_file'],
      rootPath: '/private/source', query: 'private query text',
      references: [{codebaseId: 'cb-source', filePath: 'StartupHooks.kt', lookupKind: 'body',
        referenceId: 'source-read', lineRange: {start: canaryLine, end: canaryLine}, text: 'private source text'}]};
    const terminal = {success: false, conclusion: 'Output limit reached.', partial: true,
      terminationReason: 'output_limit', sourceUseDecision,
      completion: {schemaVersion: 1, status: 'failed'}};
    const events = [
      {event: 'tool_call', data: {toolName: 'search_codebase', message: 'Searching source.', args: {query: 'private query text'}}},
      {event: 'tool_call', data: {toolName: 'mcp__smartperfetto__read_codebase_file', args: {filePath: '/private/source'}}},
      {event: 'agent_task_dispatched', data: {toolName: 'execute_sql'}},
      {event: 'analysis_completed', data: terminal},
    ];
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(events
      .map(item => `event: ${item.event}\ndata: ${JSON.stringify(item.data)}\n\n`).join('')));
    const summary = await collectSseSummary('http://verifier.invalid', 'session', 1000,
      {requiredText: [], forbiddenText: []}, {runId: 'run'});
    expect(summary.toolCallCounts).toMatchObject({search_codebase: 1, read_codebase_file: 1, execute_sql: 1});
    expect(summary.analysisCompletedSourceUseDecision).toMatchObject({status: 'corroborated',
      references: [{id: expect.stringMatching(/^source-ref-v1-/), filePath: 'StartupHooks.kt', lineRange: {start: canaryLine, end: canaryLine}}]});
    expect(summary.terminalAnalysis?.conclusionContract).toBeUndefined();
    expect(summary.analysisCompletedPartial).toBe(true);
    for (const privateText of ['/private/source', 'private query text', 'private source text']) {
      expect(JSON.stringify(summary)).not.toContain(privateText);
    }
    const assessment = evaluateAgentSseExpectation({terminal: summary.terminalAnalysis, expectation, traceId: 'trace-current'});
    expect(assessment.checks.taskCompleted).toBe(false);
    expect(assessment.checks.originalClaimsVerified).toBe(false);
    expect(taskAcceptanceStatus(Object.values(assessment.checks).every(Boolean), assessment.uncoveredFacets).completeAcceptance).toBe(false);
    const wrapper = require('../../../scripts/run-deepseek-agent-e2e.cjs');
    const evaluated = wrapper.evaluateSemanticConditionReport({condition: 'A2',
      query: wrapper.semanticDeltaQueries()[0], sourceRoot,
      report: {passed: false, analysisContext: {codebaseIds: ['cb-source']}, taskVerification: assessment, summary}});
    expect(evaluated).toMatchObject({traceFactPassed: false, sourceSemanticPassed: false, privacyCanaryCovered: true});
  });

  it.each(['confirmed', 'wrong_run', 'rejected', 'failed'])(
    'persists a safe failure before cancellation and records %s without widening ownership', async outcome => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-verifier-lifecycle-'));
      const outputPath = path.join(directory, 'failure.json');
      try {
        const request = jest.fn(async (url: string | URL | Request, options?: RequestInit) => {
          expect(JSON.parse(fs.readFileSync(outputPath, 'utf8')).cancellation).toBe('pending');
          expect(url).toBe('http://verifier.invalid/api/agent/v1/owned-session/cancel');
          expect(JSON.parse(String(options?.body))).toEqual({runId: 'owned-run'});
          expect(options?.signal).toBeInstanceOf(AbortSignal);
          if (outcome === 'failed') throw new Error('/private/source secret provider response');
          return new Response(JSON.stringify({success: outcome !== 'rejected', sessionId: 'owned-session',
            runId: outcome === 'wrong_run' ? 'other-run' : 'owned-run'}), {status: outcome === 'rejected' ? 409 : 200});
        });
        const result = await recordVerificationFailureAndCancel({baseUrl: 'http://verifier.invalid',
          outputPath, phase: 'follow_up_stream', startedAt: Date.now() - 20, timeoutMs: 10,
          sessionId: 'owned-session', runId: 'owned-run', error: new VerificationSseTimeoutError()}, request);
        expect(result).toMatchObject({errorCode: 'SSE_TIMEOUT', phase: 'follow_up_stream', completeAcceptance: false,
          cancellation: outcome === 'wrong_run' ? 'rejected' : outcome});
        expect(result.durationMs).toBeGreaterThanOrEqual(20);
        expect(request).toHaveBeenCalledTimes(1);
        expect(fs.readFileSync(outputPath, 'utf8')).not.toContain('secret');
      } finally {
        fs.rmSync(directory, {recursive: true, force: true});
      }
    });
});

const expectation = parseAgentSseExpectation({schemaVersion: 1,
  intent: {taskKind: 'fact', scope: 'bounded_question', deliverable: 'answer'},
  facts: [{id: 'frame_count', kind: 'numeric', columns: ['total_frames'], unit: 'frames',
    verification: 'proved', oracle: {sql: 'SELECT COUNT(*) AS total_frames FROM actual_frame_timeline_slice', column: 'total_frames', unit: 'frames'}}]});

function terminalFixture(text = 'There are 1912 frames.'): TerminalAnalysisEvidence {
  const reference = {evidenceRefId: 'data:frames', rowIndex: 0, column: 'total_frames', value: 1912};
  const semantics = {schemaVersion: 'claim_semantics@1' as const, predicate: 'numeric.cell',
    polarity: 'affirmed' as const, discourse: 'asserted' as const, modality: 'certain' as const, quantifier: 'one' as const,
    scope: {population: 'cited_rows' as const, subjectRefs: [reference]}, numeric: {operator: 'eq' as const, value: 1912, unit: 'frames'}};
  return {
    success: true, conclusion: text,
    completion: {schemaVersion: 1, status: 'completed', runtimeKind: 'openai-agents-sdk', runId: 'run',
      attemptId: 'attempt', candidateRef: 'candidate', conclusionFingerprint: analysisDeliveryFingerprint(text)},
    deliveryAssurance: {schemaVersion: 1, entry: 'new_finalization', completion: 'passed', claims: 'passed',
      source: 'not_applicable', identity: 'not_applicable', report: 'not_applicable'},
    turnIntent: {schemaVersion: 1, status: 'resolved', source: 'semantic', sceneId: 'scrolling',
      taskKind: 'fact', scope: 'bounded_question', deliverable: 'answer', recommendedComplexity: 'quick',
      evidenceAccess: 'read_new', registryFingerprint: 'registry'},
    conclusionContract: {schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer', conclusions: [],
      clusters: [], evidenceChain: [], uncertainties: [], nextSteps: [],
      claims: [{id: 'frames', kind: 'numeric', text, references: [reference], semantics}]},
    claimVerificationResult: {schemaVersion: 'claim_verifier@2', status: 'passed', passed: true, policy: 'record_only',
      checkedClaimCount: 1, unsupportedClaimCount: 0, issues: [], claimResults: [{claimId: 'frames', status: 'verified',
        referenceCells: [{anchorId: 'anchor:frames', evidenceRefId: 'data:frames', column: 'total_frames', status: 'matched'}],
        deterministicProof: {kind: 'numeric_cell', status: 'proved', reason: 'numeric_cell_verified',
          anchorIds: ['anchor:frames'], evidenceRefIds: ['data:frames']},
        propositionCoverage: {status: 'complete', covered: ['numeric'], uncovered: [], reason: 'proved'}}]},
    claimSupport: [{claimId: 'frames', kind: 'numeric', text, semantics, supportLevel: 'verified', anchors: [{
      anchorId: 'anchor:frames', evidenceRefId: 'data:frames', version: 'evidence_contract@1',
      context: {traceId: 'trace-current', traceSide: 'current', producerKind: 'execute_sql'},
      cells: [{column: 'total_frames', rowIndex: 0, value: 1912, actualValue: 1912}],
    }]}],
  };
}

function evaluate(terminal = terminalFixture()) {
  return evaluateAgentSseExpectation({terminal, expectation, traceId: 'trace-current',
    oracleRows: {frame_count: [{total_frames: 1912}]}});
}

describe('system investigation terminal acceptance', () => {
  it('preserves isolated runtime session logs and lifecycle codes without credentials', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'verification-logs-'));
    const previous = process.env.SMARTPERFETTO_BACKEND_LOG_DIR;
    const oldKey = process.env.DEEPSEEK_API_KEY;
    process.env.SMARTPERFETTO_BACKEND_LOG_DIR = path.join(directory, 'runtime-logs');
    process.env.DEEPSEEK_API_KEY = 'provider-key-must-not-appear';
    try {
      fs.mkdirSync(path.join(process.env.SMARTPERFETTO_BACKEND_LOG_DIR, 'sessions'), {recursive: true});
      const source = path.join(process.env.SMARTPERFETTO_BACKEND_LOG_DIR, 'sessions/session_owned_2026.jsonl');
      fs.writeFileSync(source, JSON.stringify({level: 'error', error: {message: 'analysis_history_parent_not_authorized',
        stack: 'HistoryStore.append -> persistence'}, data: {apiKey: 'another-secret', providerMessage: 'provider-key-must-not-appear'}}) + '\n');
      expect(findSessionLogFile('owned')).toBe(source);
      const outputPath = path.join(directory, 'artifact.json');
      const result = preserveVerificationSessionLog(outputPath, 'owned');
      expect(result.lifecycleErrorCode).toBe('analysis_history_parent_not_authorized');
      const saved = fs.readFileSync(result.sessionLogFile!, 'utf8');
      expect(saved).toContain('HistoryStore.append');
      expect(saved).not.toContain('provider-key-must-not-appear');
      expect(saved).not.toContain('another-secret');
      const failure = await recordVerificationFailureAndCancel({baseUrl: 'http://invalid', outputPath, phase: 'analysis_stream',
        startedAt: Date.now(), timeoutMs: 1, sessionId: 'owned', error: new VerificationLifecycleError('analysis_history_parent_not_authorized')});
      expect(failure).toMatchObject({errorCode: 'analysis_history_parent_not_authorized', lifecycleErrorCode: 'analysis_history_parent_not_authorized'});
    } finally {
      if (previous === undefined) delete process.env.SMARTPERFETTO_BACKEND_LOG_DIR; else process.env.SMARTPERFETTO_BACKEND_LOG_DIR = previous;
      if (oldKey === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = oldKey;
      fs.rmSync(directory, {recursive: true, force: true});
    }
  });

  it('stops immediately on a structured lifecycle SSE error code', async () => {
    const request = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      'event: error\ndata: {"code":"analysis_history_parent_not_authorized","message":"sensitive detail"}\n\n'));
    try {
      await expect(collectSseSummary('http://verifier.invalid', 'owned', 1000,
        {requiredText: [], forbiddenText: []}, {runId: 'run'})).rejects.toMatchObject({code: 'analysis_history_parent_not_authorized'});
    } finally {request.mockRestore();}
  });

  it('queries identical oracle SQL independently for both trace sides', async () => {
    const pair = parseAgentSseExpectation({...expectation, facts: [expectation.facts[0],
      {...expectation.facts[0], id: 'reference_frames', oracle: {...expectation.facts[0].oracle!, traceSide: 'reference'}}]});
    const query = jest.fn(async (_sql: string, side: 'current' | 'reference') =>
      ({columns: ['total_frames'], rows: [[side === 'current' ? 1912 : 700]]}));
    expect(await collectAgentSseOracleRows(pair, query)).toEqual({frame_count: [{total_frames: 1912}], reference_frames: [{total_frames: 700}]});
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls.map(call => call[1])).toEqual(['current', 'reference']);
  });

  it('binds reference fact claims to the real reference trace instead of the current trace', () => {
    const referenceExpected = parseAgentSseExpectation({...expectation, facts: [{...expectation.facts[0],
      oracle: {...expectation.facts[0].oracle!, traceSide: 'reference'}}]});
    const terminal = terminalFixture();
    const anchor = terminal.claimSupport![0].anchors[0];
    Object.assign(anchor.context, {traceId: 'reference-trace', traceSide: 'reference'});
    const check = (referenceTraceId?: string) => evaluateAgentSseExpectation({terminal, expectation: referenceExpected,
      traceId: 'trace-current', referenceTraceId, oracleRows: {frame_count: [{total_frames: 1912}]}}).checks['fact:frame_count'];
    expect(check('reference-trace')).toBe(true);
    expect(check()).toBe(false);
    expect(check('wrong-reference')).toBe(false);
    anchor.context.traceSide = 'current';
    expect(check('reference-trace')).toBe(false);
  });
  it('loads every declarative real/constructed suite through the same closed expectation parser', () => {
    const wrapper = require('../../../scripts/run-deepseek-agent-e2e.cjs');
    for (const scenario of wrapper.systemAnalysisScenarios()) {
      const value = scenario.args[scenario.args.indexOf('--expectation-json') + 1];
      expect(parseAgentSseExpectation(JSON.parse(fs.readFileSync(value.slice(1), 'utf8'))).investigation?.requirements.length)
        .toBeGreaterThan(0);
    }
  });
  function fixture() {
    const terminal = terminalFixture();
    terminal.turnIntent = {...terminal.turnIntent!, taskKind: 'investigation'};
    terminal.deliveryAssurance = {...terminal.deliveryAssurance!, investigation: 'passed', investigationEvidence: 'passed'};
    const record = {recordId: 'capture:0:0', captureId: 'capture', rowIndex: 0, skillId: 'declared-producer', stepId: 'root',
      definitionFingerprint: 'definition-hash', selectedSqlHash: 'sql-hash', traceId: 'trace-current', traceSide: 'current' as const,
      originRunId: 'run', origin: 'current_run' as const, domain: 'thread_state', metricId: 'system.thread.state.duration',
      status: 'observed' as const, window: {start: '100', end: '200'}, upid: 2, utid: 3, value: 100, unit: 'ns'};
    terminal.investigationAssessment = {schemaVersion: 1, status: 'checked',
      binding: {...terminal.completion!, registryFingerprint: terminal.turnIntent.registryFingerprint,
        intentFingerprint: analysisDeliveryFingerprint(terminal.turnIntent),
        conclusionContractFingerprint: analysisDeliveryFingerprint(terminal.conclusionContract),
        requirementsFingerprint: 'requirements-hash', evidenceFingerprint: 'evidence-hash', ledgerFingerprint: 'ledger-hash',
        evidenceRecordsFingerprint: analysisDeliveryFingerprint([record])},
      requirements: [{requirementId: 'thread_state', domain: 'thread_state', applicability: 'applicable', coverage: 'covered',
        contentLocations: [{start: 0, end: terminal.conclusion!.length}], evidenceRecordIds: [record.recordId], scopeMatch: 'matched',
        evidenceStatus: 'observed', acquisition: 'observed'}], evidenceRecords: [record]};
    const expected = parseAgentSseExpectation({...expectation, intent: {taskKind: 'investigation'}, investigation: {
      contentAssurance: 'passed', evidenceAssurance: 'passed', assessmentStatus: 'checked', requirements: [{id: 'thread_state',
        domain: 'thread_state', applicability: 'applicable', coverage: 'covered', acquisition: 'observed', scopeMatch: 'matched',
        records: [{metricId: record.metricId, traceSide: 'current', origin: 'current_run', upid: 2, utid: 3,
          window: {start: '100', end: '200'}, oracleScope: {factId: 'frame_count', startColumn: 'start', endColumn: 'end', upidColumn: 'upid', utidColumn: 'utid'}}]}]}});
    const check = () => evaluateAgentSseInvestigationExpectation({terminal, expectation: expected.investigation!, traceId: 'trace-current',
      oracleRows: {frame_count: [{start: '100', end: '200', upid: 2, utid: 3}]}});
    return {terminal, expected, record, check};
  }

  it('accepts exact candidate, requirement and producer record bindings with an independent scope oracle', () => {
    expect(Object.values(fixture().check()).every(Boolean)).toBe(true);
  });

  it('retains the final assessment and sanitized record projection from the terminal SSE event', async () => {
    const {terminal} = fixture();
    const request = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      `event: analysis_completed\ndata: ${JSON.stringify(terminal)}\n\n`));
    try {
      const summary = await collectSseSummary('http://verifier.invalid', 'session', 1000,
        {requiredText: [], forbiddenText: []}, {runId: 'run'});
      expect(summary.terminalAnalysis?.investigationAssessment).toEqual(terminal.investigationAssessment);
    } finally {request.mockRestore();}
  });

  it.each(['recordId', 'captureId', 'metricId', 'domain', 'traceId', 'traceSide', 'originRunId', 'window', 'upid', 'utid', 'status'])(
    'rejects wrong %s even when the copied record fingerprint is refreshed', key => {
      const {terminal, record, check} = fixture();
      (record as any)[key] = key === 'window' ? {start: '101', end: '200'} : key === 'upid' || key === 'utid' ? 99 : 'wrong';
      terminal.investigationAssessment!.binding.evidenceRecordsFingerprint = analysisDeliveryFingerprint([record]);
      expect(Object.values(check()).every(Boolean)).toBe(false);
    },
  );

  it.each(['candidateRef', 'runId', 'attemptId', 'conclusionFingerprint', 'intentFingerprint', 'registryFingerprint', 'conclusionContractFingerprint', 'evidenceRecordsFingerprint'])(
    'rejects a stale %s binding', field => {
      const {terminal, check} = fixture();
      (terminal.investigationAssessment!.binding as any)[field] = 'stale';
      expect(Object.values(check()).every(Boolean)).toBe(false);
    },
  );

  it('rejects duplicate requirement/record IDs and unbound prose even when content mentions system analysis', () => {
    const first = fixture();
    first.terminal.investigationAssessment!.requirements = [...first.terminal.investigationAssessment!.requirements,
      first.terminal.investigationAssessment!.requirements[0]];
    expect(first.check()['investigation:uniqueRequirements']).toBe(false);
    const second = fixture();
    second.terminal.investigationAssessment!.evidenceRecords = [second.record, second.record];
    expect(second.check()['investigation:uniqueRecords']).toBe(false);
    const third = fixture();
    third.terminal.conclusion = 'CPU frequency, scheduler, preemption: everything checked.';
    third.terminal.investigationAssessment = undefined;
    expect(Object.values(third.check()).every(Boolean)).toBe(false);
  });

  it('does not upgrade unknown or missing capture data to observed', () => {
    const {terminal, check} = fixture();
    terminal.investigationAssessment!.evidenceRecords = [];
    expect(Object.values(check()).every(Boolean)).toBe(false);
    terminal.investigationAssessment!.requirements = terminal.investigationAssessment!.requirements.map(row =>
      ({...row, acquisition: 'unknown', evidenceStatus: 'unknown'}));
    expect(check()['investigation:requirement:thread_state']).toBe(false);
  });

  it('validates reference side against its actual trace ID and preserves missing reference as unknown', () => {
    const {terminal, expected, record} = fixture();
    Object.assign(record, {traceSide: 'reference', traceId: 'reference-actual'});
    expected.investigation!.requirements[0].records![0].traceSide = 'reference';
    delete expected.investigation!.requirements[0].records![0].oracleScope;
    terminal.investigationAssessment!.binding.evidenceRecordsFingerprint = analysisDeliveryFingerprint([record]);
    const check = (referenceTraceId?: string) => evaluateAgentSseInvestigationExpectation({terminal, expectation: expected.investigation!,
      traceId: 'trace-current', referenceTraceId, oracleRows: {frame_count: [{start: 100, end: 200, upid: 2, utid: 3}]}});
    expect(Object.values(check('reference-actual')).every(Boolean)).toBe(true);
    expect(Object.values(check()).every(Boolean)).toBe(false);
  });

  it('fails closed on misspelled fields, duplicate requirements, invalid windows and unknown oracle facts', () => {
    const {expected} = fixture();
    for (const change of [
      (value: any) => {value.investigation.typo = true;},
      (value: any) => {value.investigation.requirements.push(value.investigation.requirements[0]);},
      (value: any) => {value.investigation.requirements[0].records[0].window.end = '100';},
      (value: any) => {value.investigation.requirements[0].records[0].oracleScope.factId = 'missing';},
      (value: any) => {value.investigation.requirements[0].acquisition = 'passed';},
      (value: any) => {value.investigation.requirements[0].records[0].traceSide = 'reference';},
    ]) {
      const value = structuredClone(expected); change(value);
      expect(() => parseAgentSseExpectation(value)).toThrow('Invalid --expectation-json');
    }
  });
});

describe('independent native row oracle', () => {
  afterEach(() => {jest.useRealTimers();});
  const nativeExpectation = () => parseAgentSseExpectation({schemaVersion: 1,
    intent: {taskKind: 'fact', scope: 'bounded_question', deliverable: 'answer'}, facts: [{
      id: 'duration', kind: 'numeric', columns: ['dur'], unit: 'ns', value: 42_000_000, verification: 'proved',
      oracle: {sql: 'SELECT id AS row_id, dur FROM slice WHERE id = 7', column: 'dur', unit: 'ns',
        anchorMatch: {startTs: 'start_ts', upid: 'upid', nativeRow: {relation: 'slice', idColumn: 'id', oracleColumn: 'row_id'}}},
    }]});
  function pinFixture() {
    const trace = {id: 'trace-current', status: 'ready'} as TraceInfo;
    const observation: RunningNativeProcessorObservation = Object.freeze({instanceToken: Object.freeze({}),
      registrationToken: Object.freeze({}), instanceId: 'instance', traceId: trace.id, status: 'trusted',
      nativeSchemaEligible: true, analysisRunPrivate: false,
      binarySelection: Object.freeze({source: 'local_binary', selectedPath: '/fixture/binary', selectionOrigin: 'default'})});
    const service = {getTrace: jest.fn(() => trace), getRunningNativeProcessorObservation: jest.fn(() => observation),
      getRunningCapabilityTraceProcessorInput: jest.fn(() => observation.binarySelection)};
    const identity = {source: 'bundled' as const, gitRevision: 'formal-revision', stdlibRevision: 'formal-revision'};
    const docs = {version: 1, generatedFrom: 'formal-revision', modules: [], symbolToModule: {}, entries: [
      {id: 'slice', name: 'slice', package: 'prelude', type: 'table', module: '', category: '', description: '',
        columns: [{name: 'id', type: 'ID'}, {name: 'dur', type: 'DURATION'}]},
    ]} as PerfettoSqlDocsAsset;
    const resolveIdentity = jest.fn(async () => identity);
    const loadDocs = jest.fn(() => docs);
    const expectation = nativeExpectation();
    return {trace, observation, service, identity, docs, resolveIdentity, loadDocs, expectation,
      prepare: () => prepareAgentSseNativeOracle({expectation, traceId: trace.id, service}, {resolveIdentity, loadDocs})};
  }
  async function fixture() {
    const pin = pinFixture();
    const oracle = await pin.prepare();
    const terminal = terminalFixture('The observed duration is 42000000 ns.');
    const claim = terminal.conclusionContract!.claims![0];
    const support = terminal.claimSupport![0];
    const anchor = support.anchors[0];
    const proof = terminal.claimVerificationResult!.claimResults[0];
    const reference = {...claim.references[0], column: 'dur', value: 42_000_000};
    claim.references = [reference];
    claim.semantics!.scope.subjectRefs = [reference];
    claim.semantics!.numeric = {operator: 'eq', value: 42_000_000, unit: 'ns'};
    support.semantics = JSON.parse(JSON.stringify(claim.semantics));
    anchor.context.captureId = 'capture-original';
    anchor.cells = [{column: 'dur', rowIndex: 0, value: 42_000_000, actualValue: 42_000_000, unit: 'ns'}];
    proof.referenceCells![0].column = 'dur';
    proof.deterministicProof!.nativeRows = [{...oracle.schemas.duration,
      anchorId: anchor.anchorId, evidenceRefId: anchor.evidenceRefId,
      captureId: anchor.context.captureId, traceSide: 'current', id: 7}];
    const oracleRows = {duration: [{row_id: 7, dur: 42_000_000, start_ts: '1000', upid: 10}]};
    return {pin, oracle, terminal, claim, support, anchor, proof, oracleRows,
      evaluate: () => evaluateAgentSseExpectation({terminal, expectation: pin.expectation, traceId: 'trace-current',
        oracleRows, oracleNativeSchemas: oracle.schemas})};
  }

  function groupFixture() {
    const target = pinFixture();
    const scope = {tenantId: 'test', workspaceId: 'test', userId: 'test'};
    let inside = false;
    const observation = {...target.observation, analysisRunPrivate: true};
    const entry = {side: 'current', privateProcessor: true, lease: {id: 'oracle-lease', traceId: target.trace.id, mode: 'isolated'},
      context: {traceId: target.trace.id, leaseId: 'oracle-lease', mode: 'isolated', leaseScope: scope,
        holder: {holderType: 'agent_run', holderRef: ''}}};
    target.service.getRunningNativeProcessorObservation.mockImplementation((_id?: string, options?: any) => {
      if (!inside) return {...target.observation, status: 'tainted'};
      expect(options.leaseId).toBe(entry.lease.id);
      expect(options.leaseScope).toBe(scope);
      return observation;
    });
    const query = jest.fn(async (_id: string, _sql: string, options?: any) => {
      expect(inside).toBe(true);
      expect(options.leaseId).toBe(entry.lease.id);
      expect(options.leaseScope).toBe(scope);
      return {columns: ['dur', 'row_id'], rows: [[42_000_000, 7]]};
    });
    const service = {...target.service, query};
    const release = jest.fn();
    const run = jest.fn(async (callback: () => Promise<any>) => {
      inside = true;
      try {return await callback();} finally {inside = false;}
    });
    const group = {entries: [entry], assertCurrent: jest.fn(), run, release} as unknown as AnalysisRunTraceProcessorLeases;
    const prepareLeases = jest.fn(async (args: any) => {entry.context.holder.holderRef = args.runId; return group;});
    return {...target, service, scope, entry, group, observation, query, release, run, prepareLeases,
      collect: (deadlineMs = Date.now() + 1000, signal?: AbortSignal) => collectAgentSseOracleEvidence({
        expectation: target.expectation, traceId: target.trace.id, service: service as any, scope, deadlineMs, signal,
      }, {prepareLeases, resolveIdentity: target.resolveIdentity, loadDocs: target.loadDocs})};
  }

  function pairGroupFixture() {
    const target = pinFixture();
    const scope = {tenantId: 'test', workspaceId: 'test', userId: 'test'};
    const traces = new Map(['current', 'reference'].map(side => [side, {id: `trace-${side}`, status: 'ready'}]));
    const entries = ['current', 'reference'].map(side => ({side, privateProcessor: true,
      lease: {id: `lease-${side}`, traceId: `trace-${side}`, mode: 'isolated'},
      context: {traceId: `trace-${side}`, leaseId: `lease-${side}`, mode: 'isolated', leaseScope: scope,
        holder: {holderType: 'agent_run', holderRef: 'oracle'}}}));
    const observations = new Map(entries.map(entry => [entry.context.traceId,
      {...target.observation, traceId: entry.context.traceId, instanceId: entry.lease.id, analysisRunPrivate: true}]));
    const service = {getTrace: jest.fn((id: string) => [...traces.values()].find(trace => trace.id === id)),
      getRunningNativeProcessorObservation: jest.fn((id: string, options: any) => {
        expect(options.leaseId).toBe(`lease-${id.slice('trace-'.length)}`);
        return observations.get(id);
      }), getRunningCapabilityTraceProcessorInput: jest.fn(() => target.observation.binarySelection),
      query: jest.fn(async (id: string, _sql: string, options: any) => {
        expect(options.leaseId).toBe(`lease-${id.slice('trace-'.length)}`);
        return {columns: ['dur', 'row_id'], rows: [[id === 'trace-current' ? 42_000_000 : 24_000_000, id === 'trace-current' ? 7 : 8]]};
      })};
    const group = {entries, assertCurrent: jest.fn(), run: jest.fn(async (callback: () => Promise<any>) => callback()), release: jest.fn()};
    const expected = parseAgentSseExpectation({...target.expectation, facts: [target.expectation.facts[0],
      {...target.expectation.facts[0], id: 'reference_duration', value: 24_000_000,
        oracle: {...target.expectation.facts[0].oracle!, traceSide: 'reference'}}]});
    const prepareLeases = jest.fn(async () => group as unknown as AnalysisRunTraceProcessorLeases);
    const collect = () => collectAgentSseOracleEvidence({expectation: expected, traceId: 'trace-current', referenceTraceId: 'trace-reference',
      service: service as any, scope, deadlineMs: Date.now() + 1000},
      {prepareLeases, resolveIdentity: target.resolveIdentity, loadDocs: target.loadDocs});
    return {traces, entries, service, group, prepareLeases, collect};
  }

  it('uses one authentic pair lease group with separate native pins and same-SQL results', async () => {
    const pair = pairGroupFixture();
    const result = await pair.collect();
    expect(result.rows).toEqual({duration: [{dur: 42_000_000, row_id: 7}], reference_duration: [{dur: 24_000_000, row_id: 8}]});
    expect(result.schemas.duration.traceId).toBe('trace-current');
    expect(result.schemas.reference_duration.traceId).toBe('trace-reference');
    expect(pair.prepareLeases).toHaveBeenCalledWith(expect.objectContaining({currentTraceId: 'trace-current', referenceTraceId: 'trace-reference'}));
    expect(pair.service.query.mock.calls.map(call => call[0])).toEqual(['trace-current', 'trace-reference']);
    expect(pair.group.release).toHaveBeenCalledTimes(1);
  });

  it('rejects swapped side leases and a reference registration replaced during the current query', async () => {
    const swapped = pairGroupFixture();
    swapped.entries[1].side = 'current';
    await expect(swapped.collect()).rejects.toThrow('lease unavailable');
    expect(swapped.group.release).toHaveBeenCalledTimes(1);
    const replaced = pairGroupFixture();
    const query = replaced.service.query.getMockImplementation()!;
    replaced.service.query.mockImplementation(async (...args) => {
      const result = await query(...args);
      replaced.traces.set('reference', {id: 'trace-reference', status: 'ready'});
      return result;
    });
    await expect(replaced.collect()).rejects.toThrow('registration changed');
    expect(replaced.group.release).toHaveBeenCalledTimes(1);
  });

  it('pins and queries inside one formally prepared oracle group, then releases it without exporting owner tokens', async () => {
    const target = groupFixture();
    const result = await target.collect();
    expect(result.rows.duration).toEqual([{dur: 42_000_000, row_id: 7}]);
    expect(result.schemas.duration.schemaFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(target.prepareLeases).toHaveBeenCalledTimes(1);
    expect(target.run).toHaveBeenCalledTimes(1);
    expect(target.query).toHaveBeenCalledTimes(1);
    expect(target.query.mock.calls[0][1]).toBe(target.expectation.facts[0].oracle!.sql);
    expect(target.prepareLeases.mock.calls[0][0]).toMatchObject({currentTraceId: 'trace-current', scope: target.scope,
      runId: expect.stringMatching(/^verification-oracle-/), sessionId: expect.stringMatching(/^verification-oracle-/), signal: expect.any(AbortSignal)});
    expect(target.release).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toMatch(/instanceToken|registrationToken|oracle-lease/);
  });

  it('does not rebuild an oracle group after a query taints it', async () => {
    const target = groupFixture();
    target.expectation.facts.push({...target.expectation.facts[0], id: 'second',
      oracle: {...target.expectation.facts[0].oracle!, sql: 'SELECT id AS row_id, dur FROM slice WHERE id = 8'}});
    target.query.mockImplementation(async () => {target.observation.status = 'tainted'; return {columns: ['dur', 'row_id'], rows: [[42_000_000, 7]]};});
    await expect(target.collect()).rejects.toThrow('Task native row oracle unavailable');
    expect(target.query).toHaveBeenCalledTimes(1);
    expect(target.prepareLeases).toHaveBeenCalledTimes(1);
    expect(target.release).toHaveBeenCalledTimes(1);
  });

  it('keeps the legacy non-native oracle path free of new lease admission', async () => {
    const target = groupFixture();
    delete target.expectation.facts[0].oracle!.anchorMatch!.nativeRow;
    target.query.mockResolvedValue({columns: ['dur', 'row_id'], rows: [[42_000_000, 7]]});
    expect((await target.collect()).rows.duration).toHaveLength(1);
    expect(target.prepareLeases).not.toHaveBeenCalled();
    expect(target.query.mock.calls[0]).toEqual(['trace-current', target.expectation.facts[0].oracle!.sql]);
  });

  it.each(['query', 'preparation'] as const)('bounds a stalled %s by the original deadline and releases late ownership', async stage => {
    jest.useFakeTimers({now: 1000});
    const target = groupFixture();
    let settle!: (value: any) => void;
    const pending = new Promise<any>(resolve => {settle = resolve;});
    if (stage === 'query') target.query.mockReturnValue(pending);
    else target.prepareLeases.mockReturnValue(pending);
    const result = target.collect(1100);
    const rejected = expect(result).rejects.toMatchObject({name: 'TimeoutError'});
    await jest.advanceTimersByTimeAsync(100);
    await rejected;
    expect(target.prepareLeases).toHaveBeenCalledTimes(1);
    expect(target.prepareLeases.mock.calls[0][0].signal.aborted).toBe(true);
    settle(stage === 'query' ? {columns: ['dur', 'row_id'], rows: [[42_000_000, 7]]} : target.group);
    await Promise.resolve();
    await Promise.resolve();
    expect(target.release).toHaveBeenCalledTimes(1);
    if (stage === 'preparation') expect(target.run).not.toHaveBeenCalled();
  });

  it('does not begin preparation after the original deadline or parent cancellation', async () => {
    const expired = groupFixture();
    await expect(expired.collect(Date.now() - 1)).rejects.toMatchObject({name: 'TimeoutError'});
    expect(expired.prepareLeases).not.toHaveBeenCalled();
    const cancelled = groupFixture();
    const controller = new AbortController();
    controller.abort();
    await expect(cancelled.collect(Date.now() + 1000, controller.signal)).rejects.toMatchObject({name: 'AbortError'});
    expect(cancelled.prepareLeases).not.toHaveBeenCalled();
  });

  it.each(['preparation', 'query', 'outer completion'] as const)(
    'rejects %s after the absolute deadline even when the timer has not run', async stage => {
      jest.useFakeTimers({now: 1000});
      const target = groupFixture();
      if (stage === 'outer completion') {
        const run = target.run.getMockImplementation()!;
        target.run.mockImplementation(async callback => {
          const result = await run(callback);
          jest.setSystemTime(1100);
          return result;
        });
      } else if (stage === 'query') {
        const query = target.query.getMockImplementation()!;
        target.query.mockImplementation(async (...args) => {
          const result = await query(...args);
          jest.setSystemTime(1100);
          return result;
        });
      } else {
        const prepare = target.prepareLeases.getMockImplementation()!;
        target.prepareLeases.mockImplementation(async args => {
          const group = await prepare(args);
          jest.setSystemTime(1100);
          return group;
        });
      }
      await expect(target.collect(1100)).rejects.toMatchObject({name: 'TimeoutError'});
      expect(target.prepareLeases).toHaveBeenCalledTimes(1);
      expect(target.prepareLeases.mock.calls[0][0].signal.aborted).toBe(true);
      expect(target.query).toHaveBeenCalledTimes(stage === 'preparation' ? 0 : 1);
      expect(target.run).toHaveBeenCalledTimes(1);
      expect(target.release).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(0);
    });

  it('rejects invalid absolute deadlines before preparing an owner', async () => {
    const target = groupFixture();
    for (const deadline of [NaN, Infinity, -Infinity]) {
      await expect(target.collect(deadline)).rejects.toThrow('Task native row oracle deadline invalid');
    }
    expect(target.prepareLeases).not.toHaveBeenCalled();
  });

  it('observes cancellation when the deadline crosses at try entry before the first race', async () => {
    jest.useFakeTimers({now: 1000});
    const target = groupFixture();
    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);
    // Admission and timer setup see time remaining; try-entry validation sees expiry.
    const now = jest.spyOn(Date, 'now').mockReturnValueOnce(1000).mockReturnValueOnce(1000).mockReturnValue(1100);
    try {
      await expect(target.collect(1100)).rejects.toMatchObject({name: 'TimeoutError'});
      expect(target.prepareLeases).not.toHaveBeenCalled();
      expect(target.run).not.toHaveBeenCalled();
      expect(target.query).not.toHaveBeenCalled();
      expect(target.release).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
      await jest.advanceTimersByTimeAsync(0);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      now.mockRestore();
      process.removeListener('unhandledRejection', unhandled);
    }
  });

  it('preserves a synchronous preparation error without an unhandled rejection or unowned cleanup', async () => {
    jest.useFakeTimers({now: 1000});
    const target = groupFixture();
    const failure = new Error('preparation failed');
    target.prepareLeases.mockImplementation(() => {throw failure;});
    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);
    try {
      await expect(target.collect(1100)).rejects.toBe(failure);
      expect(target.prepareLeases).toHaveBeenCalledTimes(1);
      expect(target.prepareLeases.mock.calls[0][0].signal.aborted).toBe(true);
      expect(target.run).not.toHaveBeenCalled();
      expect(target.query).not.toHaveBeenCalled();
      expect(target.release).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
      await jest.advanceTimersByTimeAsync(0);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.removeListener('unhandledRejection', unhandled);
    }
  });

  it('builds the expected schema from actual identity and formal docs without reading a candidate proof', async () => {
    const target = pinFixture();
    const pin = await target.prepare();
    expect(pin.schemas.duration).toEqual({...nativeCapture.resolveRawSqlNativeRowSchema(target.identity, target.docs, 'slice'), traceId: 'trace-current'});
    expect(Object.isFrozen(pin.schemas.duration)).toBe(true);
    expect(target.resolveIdentity).toHaveBeenCalledWith(target.observation.binarySelection);
    expect(JSON.stringify(pin.schemas)).not.toContain('/fixture/binary');
  });

  it.each(['instanceToken', 'registrationToken', 'instanceId', 'traceId', 'status', 'nativeSchemaEligible', 'analysisRunPrivate', 'binary'] as const)(
    'rejects %s drift even when the other instance properties still match', async field => {
      const target = pinFixture();
      const pin = await target.prepare();
      const changed = {...target.observation};
      if (field === 'instanceToken' || field === 'registrationToken') changed[field] = Object.freeze({});
      else if (field === 'instanceId' || field === 'traceId') changed[field] = 'other';
      else if (field === 'status') changed.status = 'tainted';
      else if (field === 'nativeSchemaEligible') changed.nativeSchemaEligible = false;
      else if (field === 'analysisRunPrivate') changed.analysisRunPrivate = true;
      else changed.binarySelection = {...changed.binarySelection, selectedPath: '/another/binary'};
      target.service.getRunningNativeProcessorObservation.mockReturnValue(changed);
      await expect(pin.assertCurrent()).rejects.toThrow('Task native row oracle unavailable');
    });

  it('rejects a replacement registration object or a processor swapped during async identity resolution', async () => {
    const target = pinFixture();
    const pin = await target.prepare();
    target.service.getTrace.mockReturnValue({...target.trace});
    await expect(pin.assertCurrent()).rejects.toThrow('Task native row oracle unavailable');
    const swapped = pinFixture();
    swapped.resolveIdentity.mockImplementation(async () => {
      swapped.service.getRunningNativeProcessorObservation.mockReturnValue({...swapped.observation, instanceToken: {}});
      return swapped.identity;
    });
    await expect(swapped.prepare()).rejects.toThrow('Task native row oracle unavailable');
  });

  it.each(['revision', 'duplicateTable', 'multipleIds', 'identity', 'scope', 'missing'] as const)(
    'fails before analysis when independent %s authority is unavailable', async change => {
      const target = pinFixture();
      if (change === 'revision') target.docs.generatedFrom = 'different-revision';
      if (change === 'duplicateTable') target.docs.entries.push({...target.docs.entries[0]});
      if (change === 'multipleIds') target.docs.entries[0].columns!.push({name: 'other_id', type: 'ID'});
      if (change === 'identity') target.resolveIdentity.mockResolvedValue({source: 'custom', binarySha256: 'untrusted'} as any);
      if (change === 'scope') target.service.getRunningNativeProcessorObservation.mockReturnValue({...target.observation, analysisRunPrivate: true});
      if (change === 'missing') target.service.getRunningNativeProcessorObservation.mockReturnValue(undefined as any);
      await expect(target.prepare()).rejects.toThrow('Task native row oracle unavailable');
    });

  it('uses the issued numeric operand row when the result did not include timestamp or process columns', async () => {
    const target = await fixture();
    expect(target.anchor.timeRange).toBeUndefined();
    expect(target.anchor.identity).toBeUndefined();
    expect(target.evaluate().facts.duration.proposition).toBe('proved');
  });

  it.each(['id', 'traceId', 'traceSide', 'relation', 'idColumn', 'schemaFingerprint', 'anchorId', 'evidenceRefId', 'captureId'] as const)(
    'rejects another %s even when its scalar value is the same 42 ms', async field => {
      const target = await fixture();
      const row = target.proof.deterministicProof!.nativeRows![0];
      if (field === 'id') row.id = 8;
      else if (field === 'traceSide') row.traceSide = 'reference';
      else if (field === 'schemaFingerprint') row.schemaFingerprint = '0'.repeat(64);
      else row[field] = 'other';
      expect(target.evaluate().facts.duration.matched).toBe(false);
    });

  it.each(['duplicate', 'missingCapture', 'candidate', 'wrongUnit', 'wrongValue', 'incompleteCoverage'] as const)(
    'does not let native metadata bypass %s verification', async change => {
      const target = await fixture();
      if (change === 'duplicate') target.proof.deterministicProof!.nativeRows!.push({...target.proof.deterministicProof!.nativeRows![0]});
      if (change === 'missingCapture') delete target.anchor.context.captureId;
      if (change === 'candidate') target.proof.deterministicProof!.status = 'candidate';
      if (change === 'wrongUnit') target.claim.semantics!.numeric!.unit = 'frames';
      if (change === 'wrongValue') target.claim.semantics!.numeric!.value = 43_000_000;
      if (change === 'incompleteCoverage') target.proof.propositionCoverage!.uncovered.push('typed_proposition');
      target.support.semantics = JSON.parse(JSON.stringify(target.claim.semantics));
      expect(target.evaluate().facts.duration.matched).toBe(false);
    });

  it('keeps the strict legacy timestamp/process fallback and ignores JSON row metadata outside a current proof', async () => {
    const target = await fixture();
    const publicCopy = JSON.parse(JSON.stringify(target.proof.deterministicProof!.nativeRows));
    delete target.proof.deterministicProof!.nativeRows;
    Object.assign(target.anchor, {nativeRows: publicCopy});
    expect(target.evaluate().facts.duration.matched).toBe(false);
    target.anchor.timeRange = {startTs: '1000', endTs: '42001000', unit: 'ns', source: 'row'};
    target.anchor.identity = {upid: 10};
    expect(target.evaluate().facts.duration.matched).toBe(true);
    target.anchor.identity.upid = 11;
    expect(target.evaluate().facts.duration.matched).toBe(false);
    target.anchor.identity.upid = 10;
    target.anchor.timeRange.startTs = '2000';
    expect(target.evaluate().facts.duration.matched).toBe(false);
  });

  it.each([{columns: ['dur'], rows: [[42_000_000]]}, {columns: ['dur', 'row_id'], rows: [[42_000_000, '7']]},
    {columns: ['dur', 'row_id', 'row_id'], rows: [[42_000_000, 7, 8]]}])('rejects an absent, non-native or ambiguous oracle ID', async result => {
    await expect(collectAgentSseOracleRows(nativeExpectation(), async () => result)).rejects.toThrow('Task fact oracle unavailable');
  });
});

describe('Agent SSE verification evidence', () => {
  it('accepts only an authored native row tuple, never an expected fingerprint copied into configuration', () => {
    const input = structuredClone(expectation);
    const nativeRow = {relation: 'slice', idColumn: 'id', oracleColumn: 'row_id'};
    input.facts[0].oracle!.anchorMatch = {startTs: 'start_ts', upid: 'upid', nativeRow};
    expect(parseAgentSseExpectation(input).facts[0].oracle?.anchorMatch?.nativeRow).toEqual(nativeRow);
    for (const invalid of [null, {}, {...nativeRow, idColumn: ''}, {...nativeRow, oracleColumn: 1},
      {...nativeRow, relation: 'slice; SELECT'}, {...nativeRow, schemaFingerprint: 'public-proof-value'}]) {
      const changed = structuredClone(input);
      changed.facts[0].oracle!.anchorMatch!.nativeRow = invalid as any;
      expect(() => parseAgentSseExpectation(changed)).toThrow('Invalid --expectation-json');
    }
  });

  it('admits only a ready trace and preserves the processor startup error', () => {
    expect(() => assertVerificationTraceReady('trace', {status: 'ready'})).not.toThrow();
    for (const status of ['uploading', 'processing', 'error'] as const) {
      expect(() => assertVerificationTraceReady('trace', {status, error: 'worker module could not load'}))
        .toThrow('worker module could not load');
    }
    expect(() => assertVerificationTraceReady('trace', undefined)).toThrow('not ready (missing)');
  });

  it('rejects a failed reference before pair admission while retaining both IDs for cleanup', async () => {
    const owned: string[] = [];
    const oracle = jest.fn();
    const service = {
      loadTraceFromFilePath: jest.fn(async (file: string) => file),
      getTrace: jest.fn((id: string) => ({id, filename: id, size: 1, uploadTime: new Date(),
        status: id === 'primary' ? 'ready' as const : 'error' as const, error: 'reference worker failed'})),
    };
    await expect(loadVerificationTracePair({service, tracePath: 'primary', referenceTracePath: 'reference',
      onLoaded: id => owned.push(id)}).then(oracle)).rejects.toThrow('reference worker failed');
    expect(owned).toEqual(['primary', 'reference']);
    expect(oracle).not.toHaveBeenCalled();
    await expect(loadVerificationTracePair({service, tracePath: 'primary'})).resolves.toEqual({traceId: 'primary'});
  });
  it('recognizes privacy-projected full-mode lifecycle events', () => {
    expect(privateProjectedSourceEventType({
      privateModelTextSuppressed: true,
      sourceEventType: 'plan_submitted',
    })).toBe('plan_submitted');
    expect(privateProjectedSourceEventType({
      privateModelTextSuppressed: true,
      sourceEventType: 'agent_response',
    })).toBe('agent_response');
    expect(privateProjectedSourceEventType({sourceEventType: 'plan_submitted'})).toBeUndefined();
  });

  it('credits only successful provenance-bearing code lookups', () => {
    const entry = (
      toolName: CodeLookupLedgerEntry['toolName'],
      outcome: CodeLookupLedgerEntry['outcome'],
      chunkIds: string[],
    ): CodeLookupLedgerEntry => ({
      turn: 1,
      ts: 1,
      toolName,
      chunkIds,
      consentApplied: true,
      tokensSpent: 10,
      outcome,
      legacyPath: false,
    });

    expect(successfulCodeLookupToolCounts([
      entry('lookup_app_source', 'success', ['chunk-app']),
      entry('lookup_aosp_source', 'success', ['chunk-rag']),
      entry('lookup_app_source', 'unresolved', []),
      entry('lookup_kernel_source', 'success', []),
    ])).toEqual({
      lookup_app_source: 1,
      lookup_aosp_source: 1,
    });
  });
});

describe('task fact oracle (deterministic composition, not a model semantic benchmark)', () => {
  it('does not promote reference-only or uncovered facets into full semantic acceptance', () => {
    expect(taskAcceptanceStatus(true, ['identity: proposition proof unavailable'])).toEqual({
      observedChecksPassed: true, semanticAcceptance: 'INCONCLUSIVE', completeAcceptance: false,
    });
    expect(taskAcceptanceStatus(true, [])).toMatchObject({semanticAcceptance: 'PASSED', completeAcceptance: true});
  });
  it.each(['There are 1912 frames.', '共记录 1912 帧。', 'The trace contains 1,912 frames.'])
    ('accepts equivalent output without titles or a prescribed tool path: %s', text => {
      const result = evaluate(terminalFixture(text));
      expect(Object.values(result.checks).every(Boolean)).toBe(true);
      expect(result.facts.frame_count).toMatchObject({matchedClaimIds: ['frames'], matchedAnchorIds: ['anchor:frames']});
    });

  it('does not accept successful tool counts when no original claims or raw proof exist', () => {
    const terminal = terminalFixture();
    terminal.conclusionContract!.claims = [];
    const result = evaluate(terminal);
    expect(result.checks.originalClaimsVerified).toBe(false);
    expect(result.facts.frame_count.matched).toBe(false);
    expect(result.facts.frame_count.matchedClaimIds).toEqual([]);
    expect(result.facts.frame_count.matchedAnchorIds).toEqual([]);
  });

  it('keeps the wrong proposition 9999 separate from an unrelated correctly cited 1912', () => {
    const terminal = terminalFixture('There are 9999 frames; 1912 unrelated events were observed.');
    terminal.conclusionContract!.claims![0].semantics!.numeric!.value = 9999;
    expect(evaluate(terminal).facts.frame_count.matched).toBe(false);
  });

  it('accepts exact numeric strings and artifact references without imposing evidence-id spelling', () => {
    const terminal = terminalFixture();
    terminal.conclusionContract!.claims![0].semantics!.numeric!.value = '1912';
    const reference = terminal.conclusionContract!.claims![0].semantics!.scope.subjectRefs![0];
    delete reference.evidenceRefId;
    reference.artifactId = 'artifact:frames';
    terminal.claimSupport![0].anchors[0].context.artifactId = 'artifact:frames';
    expect(Object.values(evaluate(terminal).checks).every(Boolean)).toBe(true);
  });

  it.each(['negated', 'quoted', 'rejected_quote', 'possible'])('does not turn %s language into the requested fact', disposition => {
    const terminal = terminalFixture();
    const semantics = terminal.conclusionContract!.claims![0].semantics!;
    if (disposition === 'negated') semantics.polarity = disposition;
    else if (disposition === 'possible') semantics.modality = disposition;
    else semantics.discourse = disposition as 'quoted' | 'rejected_quote';
    expect(evaluate(terminal).facts.frame_count.matched).toBe(false);
  });

  it.each(['wrong_trace', 'wrong_unit', 'missing_anchor', 'wrong_cell', 'partial_proof', 'v1', 'stale_body', 'unavailable_assurance'])
    ('rejects %s even if the aggregate compatibility flag says passed', failure => {
      const terminal = terminalFixture();
      if (failure === 'wrong_trace') terminal.claimSupport![0].anchors[0].context.traceId = 'other';
      if (failure === 'wrong_unit') terminal.conclusionContract!.claims![0].semantics!.numeric!.unit = 'events';
      if (failure === 'missing_anchor') terminal.claimSupport![0].anchors = [];
      if (failure === 'wrong_cell') terminal.claimSupport![0].anchors[0].cells![0].actualValue = 9999;
      if (failure === 'partial_proof') terminal.claimVerificationResult!.claimResults[0].propositionCoverage!.status = 'partial';
      if (failure === 'v1') terminal.claimVerificationResult!.schemaVersion = 'claim_verifier@1';
      if (failure === 'stale_body') terminal.conclusion = 'changed after verification';
      if (failure === 'unavailable_assurance') terminal.deliveryAssurance!.claims = 'unavailable';
      expect(Object.values(evaluate(terminal).checks).every(Boolean)).toBe(false);
    });

  it('requires independently queried task facts, not a different numeric observation', () => {
    const result = evaluateAgentSseExpectation({terminal: terminalFixture(), expectation, traceId: 'trace-current',
      oracleRows: {frame_count: [{total_frames: 8}]}});
    expect(result.facts.frame_count.matched).toBe(false);
  });

  it('checks the semantic scope decision instead of counting plan/tool events', () => {
    const terminal = terminalFixture();
    terminal.turnIntent = {...terminal.turnIntent!, scope: 'scene_wide', deliverable: 'report'};
    expect(evaluate(terminal).checks['intent:scope']).toBe(false);
    expect(evaluate(terminal).checks['intent:deliverable']).toBe(false);
  });

  it('rejects unknown expectation keys, missing numeric targets, and mutation SQL', () => {
    expect(() => parseAgentSseExpectation({...expectation, typo: true})).toThrow('Invalid --expectation-json');
    expect(() => parseAgentSseExpectation({...expectation, intent: {...expectation.intent, scope: 'all'}})).toThrow();
    expect(() => parseAgentSseExpectation({...expectation, facts: [{...expectation.facts[0], oracle: undefined}]})).toThrow();
    expect(() => parseAgentSseExpectation({...expectation, facts: [{...expectation.facts[0],
      oracle: {sql: 'SELECT 1; DROP TABLE process', column: 'total_frames'}}]})).toThrow();
  });

  it('collects real oracle rows and fails closed on unavailable or missing metrics', async () => {
    const query = jest.fn(async () => ({columns: ['total_frames'], rows: [[1912]]}));
    await expect(collectAgentSseOracleRows(expectation, query)).resolves.toEqual({frame_count: [{total_frames: 1912}]});
    expect(query).toHaveBeenCalledTimes(1);
    await expect(collectAgentSseOracleRows(expectation, async () => ({columns: ['other'], rows: [[1912]]})))
      .rejects.toThrow('Task fact oracle unavailable');
  });
});

describe('grouped acceptance: wrong answer, unproved answer and undelivered answer stay apart', () => {
  // The DeepSeek scrolling shape: the value is right and bound to its cell, the finite proof is still a candidate.
  function unprovedTerminal() {
    const terminal = terminalFixture();
    const result = terminal.claimVerificationResult!;
    Object.assign(result, {status: 'partial', passed: false});
    Object.assign(result.claimResults[0], {status: 'partial'});
    result.claimResults[0].deterministicProof!.status = 'candidate';
    result.claimResults[0].propositionCoverage = {status: 'partial', covered: [], uncovered: ['numeric'], reason: 'candidate'};
    terminal.deliveryAssurance!.claims = 'coverage_incomplete';
    return terminal;
  }
  type Checks = Record<string, boolean>;
  const accept = (terminal: TerminalAnalysisEvidence, extra: {value?: Checks; delivery?: Checks; proof?: Checks;
    ungrouped?: Checks; hard?: Checks; strict?: boolean} = {}) => evaluateAgentSseAcceptance({task: evaluate(terminal),
    observedGroups: {value: {hasTerminalConclusionPayload: true, hasNoSseErrors: true, ...extra.value},
      delivery: {hasAnalysisCompletedEvent: true, ...extra.delivery}, proof: extra.proof},
    ungroupedChecks: extra.ungrouped ?? {}, hardChecks: extra.hard ?? {}, strict: extra.strict});

  it('keeps a right but unproved value at the value tier: INCONCLUSIVE, and the run exits by its hard flags', () => {
    const result = evaluate(unprovedTerminal());
    expect(result.facts.frame_count).toMatchObject({tier: 'value', matched: true, proposition: 'unknown',
      matchedClaimIds: ['frames'], matchedAnchorIds: ['anchor:frames']});
    expect(result.checkGroups.value['fact:frame_count']).toBe(true);
    expect(result.checkGroups.proof['fact:frame_count:proved']).toBe(false);
    expect(result.checkGroups.value.deliveryClaimsNotContradicted).toBe(true);
    expect(result.checkGroups.proof).toMatchObject({originalClaimsVerified: false, deliveryClaimsVerified: false});
    const observed = accept(unprovedTerminal());
    expect(observed).toMatchObject({semanticAcceptance: 'INCONCLUSIVE', proofAcceptance: 'INCOMPLETE', observedChecksPassed: true,
      passed: true, completeAcceptance: false});
    expect(observed.uncoveredFacets).toEqual(expect.arrayContaining(['frame_count: proposition not proved (tier=value)',
      'proof check not passed: originalClaimsVerified']));
    const hard = accept(unprovedTerminal(), {proof: {claimVerifierPassed: false}, hard: {claimVerifierPassed: false}});
    expect(hard).toMatchObject({semanticAcceptance: 'INCONCLUSIVE', hardGatesPassed: false, passed: false});
    expect(hard.checkGroups.proof.claimVerifierPassed).toBe(false);
  });

  it('fails a wrong value even when everything else was delivered', () => {
    const terminal = unprovedTerminal();
    terminal.conclusionContract!.claims![0].semantics!.numeric!.value = 1913;
    terminal.claimSupport![0].semantics = JSON.parse(JSON.stringify(terminal.conclusionContract!.claims![0].semantics));
    const result = evaluate(terminal);
    expect(result.facts.frame_count).toMatchObject({tier: 'none', matched: false, matchedClaimIds: []});
    expect(accept(terminal)).toMatchObject({semanticAcceptance: 'FAILED', passed: false});
  });

  it('fails contradicted claims or source, and never reads a missing or restored assurance as not contradicted', () => {
    const contradicted = unprovedTerminal();
    contradicted.deliveryAssurance!.claims = 'failed';
    expect(evaluate(contradicted).checkGroups.value.deliveryClaimsNotContradicted).toBe(false);
    expect(accept(contradicted)).toMatchObject({semanticAcceptance: 'FAILED', passed: false});
    const source = unprovedTerminal();
    source.deliveryAssurance!.source = 'failed';
    expect(accept(source).semanticAcceptance).toBe('FAILED');
    const restored = unprovedTerminal();
    restored.deliveryAssurance!.entry = 'historical_restore';
    expect(evaluate(restored).checkGroups.value).toMatchObject({deliveryClaimsNotContradicted: false, deliverySourceNotContradicted: false});
    const missing = unprovedTerminal();
    delete missing.deliveryAssurance;
    expect(evaluate(missing).checkGroups.value).toMatchObject({deliveryClaimsNotContradicted: false, deliverySourceNotContradicted: false});
  });

  it('passes only when value, delivery and proof all hold, and --strict refuses anything less', () => {
    const proved = evaluate();
    expect(proved.facts.frame_count).toMatchObject({tier: 'proved', proposition: 'proved'});
    expect(accept(terminalFixture(), {strict: true})).toMatchObject({semanticAcceptance: 'PASSED', proofAcceptance: 'PASSED',
      completeAcceptance: true, strict: true, passed: true, uncoveredFacets: []});
    expect(accept(unprovedTerminal(), {strict: true})).toMatchObject({semanticAcceptance: 'INCONCLUSIVE', strict: true, passed: false});
    expect(accept(terminalFixture(), {strict: true, delivery: {analysisCompletedNotPartial: false},
      hard: {analysisCompletedNotPartial: false}})).toMatchObject({semanticAcceptance: 'FAILED', passed: false});
    expect(evaluateAgentSseAcceptance({observedGroups: {value: {hasNoSseErrors: true}}, ungroupedChecks: {}, hardChecks: {}, strict: true}))
      .toMatchObject({semanticAcceptance: 'INCONCLUSIVE', uncoveredFacets: ['task semantics not evaluated'], passed: false});
  });

  it('blocks an unfinished run in the delivery group and keeps ungrouped observed gates', () => {
    const observed = accept(terminalFixture(), {delivery: {hasAnalysisCompletedEvent: false}, ungrouped: {'requiresTool:invoke_skill': true}});
    expect(observed.checkGroups.delivery.hasAnalysisCompletedEvent).toBe(false);
    expect(observed).toMatchObject({semanticAcceptance: 'FAILED', passed: false});
    const tool = accept(terminalFixture(), {ungrouped: {'requiresTool:invoke_skill': false}});
    expect(tool.ungroupedChecks).toEqual({'requiresTool:invoke_skill': false});
    expect(tool).toMatchObject({semanticAcceptance: 'PASSED', observedChecksPassed: false, passed: false});
    expect(evaluateAgentSseAcceptance({task: evaluate(), observedGroups: {}, ungroupedChecks: {}, hardChecks: {},
      additionalGatesPassed: false}).passed)
      .toBe(false);
  });

  it('requires a passed report only for report deliverables and blocks a failed report for any deliverable', () => {
    const answer = terminalFixture();
    answer.deliveryAssurance!.report = 'not_checked';
    const answerResult = evaluate(answer);
    expect(answerResult.checkGroups.delivery).toEqual({deliveryReportNotFailed: true});
    expect(answerResult.checks.deliveryReportPassed).toBe(false);
    answer.deliveryAssurance!.report = 'failed';
    expect(accept(answer).semanticAcceptance).toBe('FAILED');
    const reportExpectation = parseAgentSseExpectation({...expectation, intent: {...expectation.intent, deliverable: 'report'}});
    const report = terminalFixture();
    report.turnIntent = {...report.turnIntent!, deliverable: 'report'};
    report.deliveryAssurance!.report = 'not_checked';
    const reportResult = evaluateAgentSseExpectation({terminal: report, expectation: reportExpectation, traceId: 'trace-current',
      oracleRows: {frame_count: [{total_frames: 1912}]}});
    expect(reportResult.checkGroups.delivery).toEqual({deliveryReportNotFailed: true, deliveryReportPassed: false});
  });

  it('keeps every earlier flat check key, so existing readers of the flat union keep their meaning', () => {
    const result = evaluate(unprovedTerminal());
    for (const key of ['taskCompleted', 'deliveryCompletionPassed', 'deliveryClaimsPassed', 'deliveryIdentityPassed',
      'deliverySourcePassed', 'deliveryReportPassed', 'intentResolved', 'originalClaimsVerified', 'intent:taskKind', 'fact:frame_count']) {
      expect(result.checks).toHaveProperty([key]);
    }
    expect(Object.values(result.checks).every(Boolean)).toBe(false);
    expect(Object.values(evaluate().checks).every(Boolean)).toBe(true);
    const grouped = {...result.checkGroups.value, ...result.checkGroups.proof, ...result.checkGroups.delivery};
    for (const [key, value] of Object.entries(grouped)) expect(result.checks[key]).toBe(value);
  });

  it('accepts a frame count declared as a plain count for a frames oracle', () => {
    const terminal = unprovedTerminal();
    terminal.conclusionContract!.claims![0].semantics!.numeric!.unit = 'count';
    terminal.claimSupport![0].semantics = JSON.parse(JSON.stringify(terminal.conclusionContract!.claims![0].semantics));
    expect(evaluate(terminal).facts.frame_count.tier).toBe('value');
  });

  it('binds a categorical startup_type to the oracle row of the same startup and process', () => {
    const startup = parseAgentSseExpectation({schemaVersion: 1, intent: {sceneId: 'startup', deliverable: 'report'}, facts: [{
      id: 'startup_type', kind: 'categorical', columns: ['startup_type'], verification: 'reference_only',
      oracle: {sql: 'INCLUDE PERFETTO MODULE android.startup.startups; SELECT s.startup_type, s.ts AS start_ts, sp.upid ' +
        'FROM android_startups s JOIN android_startup_processes sp USING (startup_id)', column: 'startup_type',
      anchorMatch: {startTs: 'start_ts', upid: 'upid'}}}]});
    const terminal = terminalFixture('This was a warm start.');
    const reference = {evidenceRefId: 'data:startup', rowIndex: 0, column: 'startup_type', value: 'warm'};
    const semantics = {...terminal.conclusionContract!.claims![0].semantics!, predicate: 'captured.cell',
      scope: {population: 'cited_rows' as const, subjectRefs: [reference]}};
    delete semantics.numeric;
    terminal.conclusionContract!.claims = [{id: 'type', kind: 'categorical', text: 'This was a warm start.', references: [reference], semantics}];
    terminal.claimSupport = [{claimId: 'type', kind: 'categorical', text: 'This was a warm start.', semantics: JSON.parse(JSON.stringify(semantics)),
      supportLevel: 'verified', anchors: [{anchorId: 'anchor:startup', evidenceRefId: 'data:startup', version: 'evidence_contract@1',
        context: {traceId: 'trace-current', traceSide: 'current', producerKind: 'invoke_skill'},
        timeRange: {startTs: '564166786132658', endTs: '564168124787136', unit: 'ns', source: 'row'}, identity: {upid: 948},
        cells: [{column: 'startup_type', rowIndex: 0, value: 'warm', actualValue: 'warm'}]}]}];
    const check = (rows: Array<Record<string, unknown>>) => evaluateAgentSseExpectation({terminal, expectation: startup,
      traceId: 'trace-current', oracleRows: {startup_type: rows}});
    const matched = check([{startup_type: 'warm', start_ts: 564166786132658, upid: 948}]);
    expect(matched.facts.startup_type).toMatchObject({tier: 'value', matched: true});
    expect(matched.checkGroups.proof).not.toHaveProperty(['fact:startup_type:proved']);
    expect(matched.uncoveredFacets).toEqual(['startup_type: proposition proof unavailable']);
    expect(check([{startup_type: 'cold', start_ts: 564166786132658, upid: 948}]).facts.startup_type.tier).toBe('none');
    expect(check([{startup_type: 'warm', start_ts: 564166786132658, upid: 949}]).facts.startup_type.tier).toBe('none');
    expect(check([{startup_type: 'warm', start_ts: 1, upid: 948}]).facts.startup_type.tier).toBe('none');
  });

  it('fingerprints the run by content, pinned processor revision and stdlib, never by reported version text', async () => {
    const reordered = parseAgentSseExpectation(JSON.parse(JSON.stringify({facts: expectation.facts, intent: expectation.intent,
      schemaVersion: 1})));
    expect(agentSseExpectationHash(reordered)).toBe(agentSseExpectationHash(expectation));
    expect(agentSseExpectationHash(parseAgentSseExpectation({...expectation, uncoveredFacets: ['x']})))
      .not.toBe(agentSseExpectationHash(expectation));
    expect(traceProcessorVersionKey({source: 'bundled', gitRevision: 'a'.repeat(40), reportedVersion: 'v1'})).toBe(`bundled:${'a'.repeat(40)}`);
    expect(traceProcessorVersionKey({source: 'custom', binarySha256: 'b'.repeat(64)})).toBe(`custom:${'b'.repeat(64)}`);
    expect(traceProcessorVersionKey({source: 'unknown', unavailableReason: 'external_rpc_binary_unavailable'}))
      .toBe('unknown:external_rpc_binary_unavailable');
    const identity = await resolveAgentSseRunIdentity({tracePath: '/trace', runtime: 'openai-agents-sdk', query: 'q', expectation,
      processorInput: {source: 'local_binary', selectedPath: '/tp', selectionOrigin: 'default'}}, {
      resolveTrace: async () => ({status: 'ready', identity: {fingerprintSha256: 'c'.repeat(64),
        fingerprintKind: 'trace_bytes_sha256', traceSide: 'current'}}),
      resolveProcessor: async () => ({source: 'bundled', gitRevision: 'd'.repeat(40), stdlibRevision: 'stdlib-rev', reportedVersion: 'v59'})});
    expect(identity).toEqual({schemaVersion: 1, gateSchemaVersion: 'agent_sse_gate@2', verificationSchemaVersion: 'claim_verifier@2',
      runtime: 'openai-agents-sdk', query: 'q', traceSha256: 'c'.repeat(64), expectationHash: agentSseExpectationHash(expectation),
      traceProcessorVersion: `bundled:${'d'.repeat(40)}`, stdlibRevision: 'stdlib-rev', reportedVersion: 'v59'});
    const failed = await resolveAgentSseRunIdentity({tracePath: '/trace', runtime: 'r', query: 'q'}, {
      resolveTrace: async () => ({status: 'unavailable', reason: 'trace_file_unavailable'}),
      resolveProcessor: async () => {throw new Error('boom');}});
    expect(failed).toMatchObject({traceSha256: null, expectationHash: null, stdlibRevision: null,
      traceProcessorVersion: 'unknown:identity_resolution_failed'});
  });

  it('leaves the quick frame expectation and every earlier flat check key in place', () => {
    const wrapper = require('../../../scripts/run-deepseek-agent-e2e.cjs');
    const quick = wrapper.frameFactExpectation({taskKind: 'investigation', withJank: true});
    expect(quick.intent).toEqual({sceneId: 'scrolling', taskKind: 'investigation', scope: 'bounded_question', deliverable: 'answer'});
    expect(quick.facts.map((fact: any) => [fact.id, fact.columns, fact.verification, fact.unit]))
      .toEqual([['total_frames', ['total_frames'], 'proved', 'frames'], ['jank_frames', ['jank_frames'], 'proved', 'frames']]);
    const keys = Object.keys(evaluateAgentSseExpectation({expectation: parseAgentSseExpectation(quick), traceId: 'trace'}).checks);
    expect(keys).toEqual(expect.arrayContaining(['taskCompleted', 'deliveryCompletionPassed', 'deliveryClaimsPassed',
      'deliveryIdentityPassed', 'deliverySourcePassed', 'deliveryReportPassed', 'intentResolved', 'originalClaimsVerified',
      'intent:sceneId', 'intent:taskKind', 'intent:scope', 'intent:deliverable', 'fact:total_frames', 'fact:jank_frames']));
  });

  it('parses --strict and keeps it away from the scene route', () => {
    expect(parseVerificationArgs(['--strict']).strict).toBe(true);
    expect(parseVerificationArgs([]).strict).toBeUndefined();
    expect(() => parseVerificationArgs(['--entry', 'scene-reconstruction', '--strict'])).toThrow('Scene entry cannot borrow');
  });
});
