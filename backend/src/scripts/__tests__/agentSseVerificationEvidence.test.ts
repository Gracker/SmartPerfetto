// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {CodeLookupLedgerEntry} from '../../services/codebase/codeLookupLedger';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
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
  startVerificationServer,
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
  collectAgentSseOracleEvidence,
  parseArgs as parseVerificationArgs,
  type TerminalAnalysisEvidence,
} from '../verifyAgentSseScrolling';
import {analysisDeliveryFingerprint} from '../../types/analysisDelivery';
import * as nativeCapture from '../../services/evidence/rawSqlNativeProvenance';

describe('transparent verification diagnostics', () => {
  function privateCaptureFixture(directory: string, phase = () => 'analysis_stream') {
    const jsonTarget = {parse: JSON.parse};
    const options = {phase, privateOutputDirectory: directory, jsonTarget,
      fetchTarget: {fetch: jest.fn()}, queryPrototype: {query: jest.fn(), queryBounded: jest.fn()}};
    return {jsonTarget, diagnostics: installVerificationDiagnostics(options)};
  }

  it('keeps private parser capture absent by default', () => {
    const jsonTarget = {parse: JSON.parse};
    const diagnostics = installVerificationDiagnostics({phase: () => 'analysis_stream',
      fetchTarget: {fetch: jest.fn()}, queryPrototype: {query: jest.fn(), queryBounded: jest.fn()}, jsonTarget});
    try {
      expect(jsonTarget.parse).toBe(JSON.parse);
      expect(diagnostics.privateOutputCaptureReady).toBe(false);
      expect(diagnostics.stop()).not.toHaveProperty('privateNativeOutputCapture');
    } finally {diagnostics.stop();}
  });

  it('captures opt-in private native parse samples losslessly while preserving parsing', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smp-private-native-'));
    const directory = path.join(root, 'private');
    const originalParse = JSON.parse;
    const jsonTarget = {parse: originalParse};
    const options = {phase: () => 'analysis_stream', privateOutputDirectory: directory, jsonTarget,
      fetchTarget: {fetch: jest.fn()}, queryPrototype: {query: jest.fn(), queryBounded: jest.fn()}};
    const diagnostics = installVerificationDiagnostics(options);
    const valid = '{"document":{"representationVersion":"authored_claim_document@2","text":"PRIVATE_NATIVE_CANARY\ud800"}}  ';
    const invalid = '{"document":{"representationVersion":"authored_claim_document@2","text":"PRIVATE_NATIVE_CANARY"';
    try {
      expect(jsonTarget.parse(valid)).toEqual(originalParse(valid));
      expect(() => jsonTarget.parse(invalid)).toThrow(SyntaxError);
      jsonTarget.parse(valid);
      const snapshot = diagnostics.stop();
      expect(snapshot).toMatchObject({privateNativeOutputCapture: {enabled: true, attemptedCount: 2,
        records: [expect.objectContaining({fileName: 'native-output-0001.json'}), expect.objectContaining({fileName: 'native-output-0002.json'})]}});
      expect(originalParse(fs.readFileSync(path.join(directory, 'native-output-0001.json'), 'utf8')).text).toBe(valid);
      expect(originalParse(fs.readFileSync(path.join(directory, 'native-output-0002.json'), 'utf8')).text).toBe(invalid);
      expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
      expect(fs.statSync(path.join(directory, 'native-output-0001.json')).mode & 0o777).toBe(0o600);
      expect(JSON.stringify(snapshot)).not.toContain('PRIVATE_NATIVE_CANARY');
      expect(jsonTarget.parse).toBe(originalParse);
    } finally {diagnostics.stop(); fs.rmSync(root, {recursive: true, force: true});}
  });

  it('distinguishes lone surrogates and passes the original reviver', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smp-private-native-'));
    const target = privateCaptureFixture(path.join(root, 'private'));
    const document = (text: string) => `{"document":{"representationVersion":"authored_claim_document@2","text":"${text}"}}`;
    try {
      const reviver = jest.fn((_key: string, value: unknown) => value === 'original' ? 'changed' : value);
      expect(target.jsonTarget.parse(document('original'), reviver).document.text).toBe('changed');
      target.jsonTarget.parse(document('\ud800'));
      target.jsonTarget.parse(document('\ud801'));
      const snapshot = target.diagnostics.stop();
      expect(snapshot).toMatchObject({privateNativeOutputCapture: {attemptedCount: 3, records: expect.any(Array)}});
      const artifacts = fs.readdirSync(path.join(root, 'private')).map(file => JSON.parse(fs.readFileSync(path.join(root, 'private', file), 'utf8')).text);
      expect(artifacts).toEqual([document('original'), document('\ud800'), document('\ud801')]);
      expect(reviver).toHaveBeenCalled();
    } finally {target.diagnostics.stop(); fs.rmSync(root, {recursive: true, force: true});}
  });

  it('limits failed private writes without affecting parsing or leaking errors', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smp-private-native-'));
    const target = privateCaptureFixture(path.join(root, 'private'));
    const write = jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {throw new Error('PRIVATE_IO_CANARY');});
    try {
      for (let index = 0; index < 12; index++) {
        const raw = JSON.stringify({document: {representationVersion: 'authored_claim_document@2', index}});
        expect(target.jsonTarget.parse(raw).document.index).toBe(index);
        target.jsonTarget.parse(raw);
      }
      expect(write).toHaveBeenCalledTimes(8);
      const snapshot = target.diagnostics.stop();
      expect(snapshot).toMatchObject({observationFailures: 8, privateNativeOutputCapture: {attemptedCount: 8, records: []}});
      expect(JSON.stringify(snapshot)).not.toContain('PRIVATE_IO_CANARY');
    } finally {write.mockRestore(); target.diagnostics.stop(); fs.rmSync(root, {recursive: true, force: true});}
  });

  it('keeps private capture scoped and preserves a successor parser', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smp-private-native-'));
    let phase = 'context_setup';
    const target = privateCaptureFixture(path.join(root, 'private'), () => phase);
    const raw = JSON.stringify({document: {representationVersion: 'authored_claim_document@2'}});
    try {
      target.jsonTarget.parse(raw);
      phase = 'analysis_stream';
      target.jsonTarget.parse('{"other":"authored_claim_document@2"}');
      expect(target.jsonTarget.parse(raw + ' '.repeat(1024 * 1024))).toEqual(JSON.parse(raw));
      expect(fs.readdirSync(path.join(root, 'private'))).toEqual([]);
      expect(() => target.jsonTarget.parse(' '.repeat(4096))).toThrow(SyntaxError);
      const successor = JSON.parse.bind(JSON);
      target.jsonTarget.parse = successor;
      expect(target.diagnostics.stop()).toMatchObject({restoreConflicts: 1,
        privateNativeOutputCapture: {attemptedCount: 1, records: [expect.objectContaining({whitespaceChars: 4096})]}});
      expect(target.jsonTarget.parse).toBe(successor);
    } finally {target.diagnostics.stop(); fs.rmSync(root, {recursive: true, force: true});}
  });

  it.each(['directory', 'symlink'] as const)('refuses an existing private capture %s', kind => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smp-private-native-'));
    const directory = path.join(root, 'private');
    if (kind === 'directory') fs.mkdirSync(directory);
    else fs.symlinkSync(root, directory);
    const target = privateCaptureFixture(directory);
    try {
      expect(target.diagnostics.privateOutputCaptureReady).toBe(false);
      expect(target.jsonTarget.parse).toBe(JSON.parse);
      expect(target.diagnostics.stop()).toMatchObject({observationFailures: 1,
        privateNativeOutputCapture: {enabled: false, attemptedCount: 0, records: []}});
    } finally {target.diagnostics.stop(); fs.rmSync(root, {recursive: true, force: true});}
  });


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
      eventId: 7, ts: 40919952686988, dur: 42_000_000, nativeTable: 'slice'});
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
      expect(result.selectionContext).toEqual({...expected, nativeTable: 'slice'});
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

  it('summarizes the citation-only source check against the returned references', async () => {
    const payload = {success: true, conclusion: 'Safe conclusion.',
      sourceUseDecision: {references: [{id: 'source-ref-v1-issued'}]},
      sourceClaimVerificationResult: {schemaVersion: 'source_claim_verifier@2', status: 'partial', bindings: [], claims: [],
        citations: [{citation: 'Foo.kt:L1', filePath: 'Foo.kt', lineRange: {start: 1, end: 1}, status: 'verified_body',
          sourceReferenceId: 'source-ref-v1-issued'},
        {citation: 'Bar.kt:L2', filePath: 'Bar.kt', lineRange: {start: 2, end: 2}, status: 'unmatched'}],
        issues: [{severity: 'warning', code: 'source_citation_unmatched', message: 'private source content'}]}};
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(`event: analysis_completed\ndata: ${JSON.stringify(payload)}\n\n`));
    const summary = await collectSseSummary('http://verifier.invalid', 'session', 1000,
      {requiredText: [], forbiddenText: []}, {runId: 'run'});
    expect(summary).toMatchObject({analysisCompletedSourceClaimVerifierStatus: 'partial', analysisCompletedSourceCitationCount: 2,
      analysisCompletedSourceCitationsMatched: false, analysisCompletedSourceCitedReferenceIds: ['source-ref-v1-issued']});
    expect(JSON.stringify(summary)).not.toContain('private source content');
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
    expect(taskAcceptanceStatus(Object.values(assessment.checks).every(Boolean), assessment.uncoveredFacets).completeAcceptance).toBe(false);
    const wrapper = require('../../../scripts/run-glm-agent-e2e.cjs');
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
  facts: [{id: 'frame_count', kind: 'numeric', unit: 'frames',
    oracle: {sql: 'SELECT COUNT(*) AS total_frames FROM actual_frame_timeline_slice', column: 'total_frames', unit: 'frames'}}]});

function terminalFixture(text = 'There are 1912 frames.'): TerminalAnalysisEvidence {
  return {
    success: true, conclusion: text,
    completion: {schemaVersion: 1, status: 'completed', runtimeKind: 'openai-agents-sdk', runId: 'run',
      attemptId: 'attempt', candidateRef: 'candidate', conclusionFingerprint: analysisDeliveryFingerprint(text)},
    deliveryAssurance: {schemaVersion: 1, entry: 'new_finalization', completion: 'passed', claims: 'not_applicable',
      source: 'not_applicable', identity: 'not_applicable', report: 'not_applicable',
      investigation: 'not_applicable', investigationEvidence: 'not_applicable'},
    turnIntent: {schemaVersion: 1, status: 'resolved', source: 'semantic', sceneId: 'scrolling',
      taskKind: 'fact', scope: 'bounded_question', deliverable: 'answer', recommendedComplexity: 'quick',
      evidenceAccess: 'read_new', registryFingerprint: 'registry'},
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
    const oldKey = process.env.GLM_API_KEY;
    process.env.SMARTPERFETTO_BACKEND_LOG_DIR = path.join(directory, 'runtime-logs');
    process.env.GLM_API_KEY = 'provider-key-must-not-appear';
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
      if (oldKey === undefined) delete process.env.GLM_API_KEY; else process.env.GLM_API_KEY = oldKey;
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

  it('loads every declarative real/constructed suite through the same closed expectation parser', () => {
    const wrapper = require('../../../scripts/run-glm-agent-e2e.cjs');
    for (const scenario of wrapper.systemAnalysisScenarios()) {
      const value = scenario.args[scenario.args.indexOf('--expectation-json') + 1];
      expect(parseAgentSseExpectation(JSON.parse(fs.readFileSync(value.slice(1), 'utf8'))).investigation?.requirements.length)
        .toBeGreaterThan(0);
    }
  });
  function fixture() {
    const terminal = terminalFixture();
    terminal.turnIntent = {...terminal.turnIntent!, taskKind: 'investigation'};
    terminal.deliveryAssurance = {...terminal.deliveryAssurance!, investigation: 'not_applicable', investigationEvidence: 'not_applicable'};
    const record = {recordId: 'capture:0:0', captureId: 'capture', rowIndex: 0, skillId: 'declared-producer', stepId: 'root',
      definitionFingerprint: 'definition-hash', selectedSqlHash: 'sql-hash', traceId: 'trace-current', traceSide: 'current' as const,
      originRunId: 'run', origin: 'current_run' as const, domain: 'thread_state', metricId: 'system.thread.state.duration',
      status: 'observed' as const, window: {start: '100', end: '200'}, upid: 2, utid: 3, value: 100, unit: 'ns'};
    // The record-only ledger display: acquisition rows and retained records, no assessed content.
    terminal.investigationAssessment = {schemaVersion: 1, status: 'not_checked',
      binding: {...terminal.completion!, registryFingerprint: terminal.turnIntent.registryFingerprint,
        intentFingerprint: analysisDeliveryFingerprint(terminal.turnIntent),
        conclusionContractFingerprint: analysisDeliveryFingerprint(terminal.conclusionContract),
        requirementsFingerprint: 'requirements-hash', evidenceFingerprint: 'evidence-hash', ledgerFingerprint: 'ledger-hash',
        evidenceRecordsFingerprint: analysisDeliveryFingerprint([record])},
      ledgerAcquisition: [{requirementId: 'thread_state', domain: 'thread_state', applicability: 'applicable',
        status: 'observed', declaredMetrics: [record.metricId], observedMetrics: [record.metricId]}],
      requirements: [], evidenceRecords: [record]};
    const expected = parseAgentSseExpectation({...expectation, intent: {taskKind: 'investigation'}, investigation: {
      requirements: [{id: 'thread_state', domain: 'thread_state', acquisition: 'observed',
        records: [{metricId: record.metricId, traceSide: 'current', origin: 'current_run', upid: 2, utid: 3,
          window: {start: '100', end: '200'}, oracleScope: {factId: 'frame_count', startColumn: 'start', endColumn: 'end', upidColumn: 'upid', utidColumn: 'utid'}}]}]}});
    const check = () => evaluateAgentSseInvestigationExpectation({terminal, expectation: expected.investigation!, traceId: 'trace-current',
      oracleRows: {frame_count: [{start: '100', end: '200', upid: 2, utid: 3}]}});
    return {terminal, expected, record, check};
  }

  it('accepts exact candidate, ledger acquisition and producer record bindings with an independent scope oracle', () => {
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

  it('rejects duplicate ledger rows/record IDs and unbound prose even when content mentions system analysis', () => {
    const first = fixture();
    first.terminal.investigationAssessment!.ledgerAcquisition = [...first.terminal.investigationAssessment!.ledgerAcquisition!,
      first.terminal.investigationAssessment!.ledgerAcquisition![0]];
    expect(first.check()['investigation:requirement:thread_state']).toBe(false);
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
    terminal.investigationAssessment!.ledgerAcquisition = terminal.investigationAssessment!.ledgerAcquisition!.map(row =>
      ({...row, status: 'unknown' as const, observedMetrics: []}));
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


describe('Agent SSE verification evidence', () => {

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
  it('does not promote uncovered facets into full semantic acceptance', () => {
    expect(taskAcceptanceStatus(true, ['identity: primary application selection'])).toEqual({
      observedChecksPassed: true, semanticAcceptance: 'INCONCLUSIVE', completeAcceptance: false,
    });
    expect(taskAcceptanceStatus(true, [])).toMatchObject({semanticAcceptance: 'PASSED', completeAcceptance: true});
  });

  it.each(['There are 1912 frames.', '共记录 1912 帧。', 'The trace contains 1,912 frames.'])
    ('matches the independently queried value in the answer body without a prescribed tool path: %s', text => {
      const result = evaluate(terminalFixture(text));
      expect(Object.values(result.checks).every(Boolean)).toBe(true);
      expect(result.facts.frame_count).toMatchObject({matched: true});
      expect(result.facts.frame_count.matchedText.join(' ')).toContain('1');
    });

  it('fails a wrong value and never borrows an unrelated matching number with a different unit', () => {
    expect(evaluate(terminalFixture('There are 9999 frames.')).facts.frame_count.matched).toBe(false);
    // A frames fact must be written without a time unit; 1912 ms is a different quantity.
    expect(evaluate(terminalFixture('The longest frame took 1912 ms.')).facts.frame_count.matched).toBe(false);
  });

  it.each([
    ['23.11 ms', 23_109_000, 'ns', true], ['23.1 ms', 23_109_000, 'ns', true], ['23109 us', 23_109_000, 'ns', true],
    ['0.023 s', 23_109_000, 'ns', true], ['23.2 ms', 23_109_000, 'ns', false], ['23 ms', 23_109_000, 'ns', true],
    ['2.4 ms', 2_400_000, 'ns', true], ['2 ms', 2_400_000, 'ns', false], ['4 s', 4_041_000_000, 'ns', false], ['4041 ms', 4_041_000_000, 'ns', true],
    ['4.04 秒', 4_041_000_000, 'ns', true], ['12.3%', 12.34, '%', true], ['12.4%', 12.34, '%', false],
  ] as const)('normalizes units and display rounding: %s for %d %s -> %s', (written, value, unit, matched) => {
    const target = parseAgentSseExpectation({schemaVersion: 1, intent: {taskKind: 'fact'},
      facts: [{id: 'value', kind: 'numeric', value, unit}]});
    const text = `The measured value is ${written}.`;
    const result = evaluateAgentSseExpectation({terminal: terminalFixture(text), expectation: target, traceId: 'trace-current'});
    expect(result.facts.value.matched).toBe(matched);
  });

  it('matches identity and categorical text case-insensitively', () => {
    const target = parseAgentSseExpectation({schemaVersion: 1, intent: {taskKind: 'fact'},
      facts: [{id: 'process', kind: 'identity', oracle: {sql: 'SELECT name FROM process', column: 'name'}}]});
    const run = (text: string) => evaluateAgentSseExpectation({terminal: terminalFixture(text), expectation: target,
      traceId: 'trace-current', oracleRows: {process: [{name: 'com.example.app'}, {name: 'system_server'}]}});
    expect(run('The main process is COM.EXAMPLE.APP.').facts.process.matched).toBe(true);
    expect(run('The main process is not named here.').facts.process.matched).toBe(false);
  });

  it('requires independently queried task facts, not a different numeric observation', () => {
    const result = evaluateAgentSseExpectation({terminal: terminalFixture(), expectation, traceId: 'trace-current',
      oracleRows: {frame_count: [{total_frames: 2000}]}});
    expect(result.facts.frame_count.matched).toBe(false);
  });

  it('checks the semantic scope decision instead of counting plan/tool events', () => {
    const terminal = terminalFixture();
    terminal.turnIntent = {...terminal.turnIntent!, scope: 'scene_wide'};
    expect(evaluate(terminal).checks['intent:scope']).toBe(false);
  });

  it('rejects unknown expectation keys, retired proof fields, missing numeric targets, and mutation SQL', () => {
    for (const fact of [{id: 'x', kind: 'numeric', value: 1, verification: 'proved'}, {id: 'x', kind: 'numeric', value: 1, columns: ['x']},
      {id: 'x', kind: 'numeric'}, {id: 'x', kind: 'numeric', oracle: {sql: 'DELETE FROM slice', column: 'x'}},
      {id: 'x', kind: 'numeric', oracle: {sql: 'SELECT 1 AS x', column: 'x', anchorMatch: {startTs: 'ts'}}}]) {
      expect(() => parseAgentSseExpectation({schemaVersion: 1, intent: {taskKind: 'fact'}, facts: [fact]})).toThrow();
    }
  });

  it('checks explicit alternative scene labels without relaxing the task', () => {
    const target = parseAgentSseExpectation({schemaVersion: 1, intent: {allowedSceneIds: ['scrolling', 'jank']}, facts: expectation.facts});
    expect(evaluateAgentSseExpectation({terminal: terminalFixture(), expectation: target, traceId: 'trace-current',
      oracleRows: {frame_count: [{total_frames: 1912}]}}).checks['intent:sceneId']).toBe(true);
    const terminal = terminalFixture();
    terminal.turnIntent = {...terminal.turnIntent!, sceneId: 'startup'};
    expect(evaluateAgentSseExpectation({terminal, expectation: target, traceId: 'trace-current',
      oracleRows: {frame_count: [{total_frames: 1912}]}}).checks['intent:sceneId']).toBe(false);
  });

  it('collects real oracle rows and fails closed on unavailable or missing metrics', async () => {
    await expect(collectAgentSseOracleRows(expectation, async () => ({columns: ['total_frames'], rows: [[1912]]})))
      .resolves.toEqual({frame_count: [{total_frames: 1912}]});
    await expect(collectAgentSseOracleRows(expectation, async () => ({columns: ['other'], rows: [[1]]})))
      .rejects.toThrow('Task fact oracle unavailable: frame_count');
    await expect(collectAgentSseOracleRows(expectation, async () => ({columns: [], rows: [], error: 'no table'})))
      .rejects.toThrow('Task fact oracle unavailable: frame_count');
  });

  it('queries one oracle SQL per side and checks the reference registration', async () => {
    const paired = parseAgentSseExpectation({schemaVersion: 1, intent: {taskKind: 'comparison'}, facts: [
      {id: 'current_frames', kind: 'numeric', oracle: {sql: 'SELECT 1 AS n', column: 'n'}},
      {id: 'reference_frames', kind: 'numeric', oracle: {sql: 'SELECT 1 AS n', column: 'n', traceSide: 'reference'}}]});
    const trace = (id: string) => ({id, status: 'ready'});
    const traces = new Map([['current', trace('current')], ['reference', trace('reference')]]);
    const query = jest.fn(async (id: string) => ({columns: ['n'], rows: [[id === 'current' ? 1 : 2]]}));
    const service = {getTrace: (id: string) => traces.get(id), query} as unknown as Parameters<typeof collectAgentSseOracleEvidence>[0]['service'];
    await expect(collectAgentSseOracleEvidence({expectation: paired, traceId: 'current', referenceTraceId: 'reference',
      service, deadlineMs: Date.now() + 60_000})).resolves.toEqual({rows: {current_frames: [{n: 1}], reference_frames: [{n: 2}]}});
    expect(query.mock.calls.map(call => call[0])).toEqual(['current', 'reference']);
    await expect(collectAgentSseOracleEvidence({expectation: paired, traceId: 'current', service,
      deadlineMs: Date.now() + 60_000})).rejects.toThrow('reference trace oracle unavailable');
  });
});

describe('grouped acceptance: wrong answer and undelivered answer stay apart', () => {
  type Checks = Record<string, boolean>;
  const accept = (terminal: TerminalAnalysisEvidence, extra: {value?: Checks; delivery?: Checks;
    ungrouped?: Checks; hard?: Checks; strict?: boolean} = {}) => evaluateAgentSseAcceptance({task: evaluate(terminal),
    observedGroups: {value: {hasTerminalConclusionPayload: true, hasNoSseErrors: true, ...extra.value},
      delivery: {hasAnalysisCompletedEvent: true, ...extra.delivery}},
    ungroupedChecks: extra.ungrouped ?? {}, hardChecks: extra.hard ?? {}, strict: extra.strict});

  it('passes a delivered right answer with retired claim, report and investigation axes not applicable', () => {
    const result = accept(terminalFixture(), {strict: true});
    expect(result).toMatchObject({passed: true, completeAcceptance: true, semanticAcceptance: 'PASSED',
      observedChecksPassed: true, hardGatesPassed: true, uncoveredFacets: []});
    expect(result.checkGroups).not.toHaveProperty('proof');
    expect(result).not.toHaveProperty('proofAcceptance');
  });

  it('fails a wrong value even when everything else was delivered', () => {
    const result = accept(terminalFixture('There are 9999 frames.'));
    expect(result).toMatchObject({passed: false, semanticAcceptance: 'FAILED'});
    expect(result.checkGroups.value['fact:frame_count']).toBe(false);
  });

  it('fails a failed source annotation, and never reads a missing or restored assurance as delivered', () => {
    const failedSource = terminalFixture();
    failedSource.deliveryAssurance = {...failedSource.deliveryAssurance!, source: 'failed'};
    expect(accept(failedSource).checkGroups.value.deliverySourceNotContradicted).toBe(false);
    const restored = terminalFixture();
    restored.deliveryAssurance = {...restored.deliveryAssurance!, entry: 'historical_restore'};
    expect(accept(restored).checkGroups.value.deliveryCompletionPassed).toBe(false);
    const missing = terminalFixture();
    delete missing.deliveryAssurance;
    expect(accept(missing).passed).toBe(false);
  });

  it('keeps an unmeasured facet INCONCLUSIVE and --strict refuses it', () => {
    const result = evaluateAgentSseAcceptance({strict: true,
      task: {checkGroups: {value: {marker: true}, delivery: {delivered: true}},
        uncoveredFacets: ['source recommendation action semantics']},
      observedGroups: {}, ungroupedChecks: {}, hardChecks: {notPartial: true}, additionalGatesPassed: true});
    expect(result).toMatchObject({passed: false, strict: true, completeAcceptance: false,
      semanticAcceptance: 'INCONCLUSIVE', observedChecksPassed: true});
    expect(accept(terminalFixture(), {strict: false, ungrouped: {extra: true}}).passed).toBe(true);
  });

  it('blocks an unfinished run in the delivery group and keeps ungrouped observed gates', () => {
    expect(accept(terminalFixture(), {delivery: {analysisCompletedNotPartial: false}})).toMatchObject({passed: false,
      semanticAcceptance: 'FAILED'});
    expect(accept(terminalFixture(), {ungrouped: {requiredTool: false}})).toMatchObject({passed: false,
      semanticAcceptance: 'PASSED', observedChecksPassed: false});
    expect(accept(terminalFixture(), {hard: {analysisCompletedNotPartial: false}})).toMatchObject({passed: false,
      hardGatesPassed: false});
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
    expect(identity).toEqual({schemaVersion: 1, gateSchemaVersion: 'agent_sse_gate@3',
      runtime: 'openai-agents-sdk', query: 'q', traceSha256: 'c'.repeat(64), expectationHash: agentSseExpectationHash(expectation),
      traceProcessorVersion: `bundled:${'d'.repeat(40)}`, stdlibRevision: 'stdlib-rev', reportedVersion: 'v59'});
    const failed = await resolveAgentSseRunIdentity({tracePath: '/trace', runtime: 'r', query: 'q'}, {
      resolveTrace: async () => ({status: 'unavailable', reason: 'trace_file_unavailable'}),
      resolveProcessor: async () => {throw new Error('boom');}});
    expect(failed).toMatchObject({traceSha256: null, expectationHash: null, stdlibRevision: null,
      traceProcessorVersion: 'unknown:identity_resolution_failed'});
  });

  it('keeps the quick frame expectation and the value/delivery check keys in place', () => {
    const wrapper = require('../../../scripts/run-glm-agent-e2e.cjs');
    const quick = wrapper.frameFactExpectation({taskKind: 'investigation', withJank: true});
    expect(quick.intent).toEqual({sceneId: 'scrolling', taskKind: 'investigation', scope: 'bounded_question', deliverable: 'answer'});
    expect(quick.facts.map((fact: any) => [fact.id, fact.unit, fact.oracle.column]))
      .toEqual([['total_frames', 'frames', 'total_frames'], ['jank_frames', 'frames', 'jank_frames']]);
    const keys = Object.keys(evaluateAgentSseExpectation({expectation: parseAgentSseExpectation(quick), traceId: 'trace'}).checks);
    expect(keys).toEqual(expect.arrayContaining(['taskCompleted', 'deliveryCompletionPassed', 'deliveryIdentityPassed',
      'deliverySourceNotContradicted', 'intentResolved', 'intent:sceneId', 'intent:taskKind', 'intent:scope', 'intent:deliverable',
      'fact:total_frames', 'fact:jank_frames']));
    expect(keys).not.toEqual(expect.arrayContaining(['originalClaimsVerified']));
  });

  it('parses --strict, keeps it away from the scene route, and refuses the retired claim-verifier flag', () => {
    expect(parseVerificationArgs(['--strict']).strict).toBe(true);
    expect(parseVerificationArgs([]).strict).toBeUndefined();
    expect(() => parseVerificationArgs(['--entry', 'scene-reconstruction', '--strict'])).toThrow('Scene entry cannot borrow');
    expect(() => parseVerificationArgs(['--require-claim-verifier-ok'])).toThrow();
  });
});

describe('verification server IPv4 lifecycle', () => {
  const servers: http.Server[] = [];
  const nativeListeners = http.createServer();
  const close = (server: http.Server) => new Promise<void>((resolve, reject) => {
    if (!server.listening) {resolve(); return;}
    server.close(error => error ? reject(error) : resolve());
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await Promise.all(servers.splice(0).map(close));
  });
  async function start(port = 0) {
    const app = express();
    app.get('/ready', (_request, response) => response.send('ready'));
    const server = await startVerificationServer(app, port);
    servers.push(server);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected an IPv4 address');
    return {server, address};
  }
  const read = (port: number) => new Promise<string>((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/ready`, {agent: false}, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {body += chunk;});
      response.once('end', () => resolve(body));
      response.once('error', reject);
    }).once('error', reject);
  });

  it('returns only after an ephemeral IPv4 loopback listener is ready', async () => {
    const {server, address} = await start();
    expect(address).toMatchObject({address: '127.0.0.1', family: 'IPv4'});
    expect(address.port).toBeGreaterThan(0);
    expect(server.listening).toBe(true);
    expect(server.listeners('listening')).toEqual(nativeListeners.listeners('listening'));
    expect(server.listeners('error')).toEqual(nativeListeners.listeners('error'));
    expect(await read(address.port)).toBe('ready');
  });

  it('rejects an occupied port and removes startup listeners without closing its owner', async () => {
    const {server: owner, address} = await start();
    const create = jest.spyOn(http, 'createServer');
    await expect(startVerificationServer(express(), address.port)).rejects.toMatchObject({code: 'EADDRINUSE'});
    const failed = create.mock.results[0].value as http.Server;
    expect(failed.listening).toBe(false);
    expect(failed.listeners('listening')).toEqual(nativeListeners.listeners('listening'));
    expect(failed.listeners('error')).toEqual(nativeListeners.listeners('error'));
    expect(owner.listening).toBe(true);
    expect(await read(address.port)).toBe('ready');
  });

  it('releases the owned port on close so another verification can reuse it', async () => {
    const first = await start();
    await close(first.server);
    expect(first.server.address()).toBeNull();
    const second = await start(first.address.port);
    expect(second.address).toEqual(first.address);
    expect(await read(second.address.port)).toBe('ready');
  });
});
