// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {createSceneSseObservation, recordSceneSseEvent, evaluateSceneSseVerification, parseSceneOracleSpecs,
  collectSceneOracleRows, evaluateSceneOracleRows} from '../sceneSseVerification';
import {collectSseSummary, parseArgs} from '../verifyAgentSseScrolling';
import type {SceneTimelineView} from '../../types/sceneTimeline';

const scope = {traceId: 'trace', sessionId: 'session', runId: 'run'};
function view(revision = 1): SceneTimelineView {
  return {schemaVersion: 'scene_timeline@1', ...scope, revision, status: 'partial', unresolved: [], diagnostics: [],
    coverage: {status: 'partial', captureStatus: 'unknown', reason: 'capture_completeness_unproven', sources: []},
    segments: [{segment: {id: 's', startNs: '9007199254740993', endNs: '9007199254740994', object: {kind: 'upid', key: '7'},
      userAction: 'Touch movement', deviceState: 'Unknown', appResponse: 'Unknown',
      evidenceRefs: [{evidenceRefId: 'ev', rowIndex: 0}], boundaries: {start: {source: 'evidence'}, end: {source: 'evidence'}}, dependencies: [], supersedes: []},
      contentFingerprint: 'content', dependencyFingerprint: 'dependencies', issuedRevision: revision, referencesResolved: true,
      semanticStatus: 'unverified', checks: [{predicate: 'time.start_cell_equals_boundary', status: 'passed'}], diagnostics: []}]};
}
const fact = (id = 'ev') => ({meta: {traceId: 'trace', traceSide: 'current', sourceToolCallId: `query:${id}`, evidenceRefId: id, executionStatus: 'observed'}});
function fixture(revision = 1) {
  const observation = createSceneSseObservation(); const final = view(revision);
  const reportRef = {schemaVersion: 'scene_report_ref@1' as const, ...scope, reportId: 'scene-v3:r', revision,
    expiresAt: Date.now() + 10000, manifestSha256: 'a'.repeat(64)};
  recordSceneSseEvent(observation, 'data', fact(), scope);
  recordSceneSseEvent(observation, 'agent_task_dispatched', {toolName: 'propose_scene_timeline'}, scope);
  recordSceneSseEvent(observation, 'scene_timeline_updated', final, scope);
  recordSceneSseEvent(observation, 'analysis_completed', {success: true, sceneTimeline: final, sceneReport: reportRef}, scope);
  const replay = createSceneSseObservation();
  recordSceneSseEvent(replay, 'scene_timeline_updated', final, scope);
  recordSceneSseEvent(replay, 'analysis_completed', {success: true, sceneTimeline: final, sceneReport: reportRef}, scope);
  return {observation, replay, scope, status: {success: true, ...scope, status: 'completed', result: {sceneTimeline: final, sceneReport: reportRef}},
    report: {success: true, report: {...scope, reportId: reportRef.reportId, sceneTimeline: final,
      cachePolicy: 'evidence_archive', generatedBy: {pipelineVersion: 'v3', runtimeKind: 'pi-agent-core', providerId: 'provider'}}},
    start: {...scope, analysisId: scope.sessionId}, bounds: {startNs: '9007199254740992', endNs: '9007199254740995'},
    scenario: 'complete' as const, minRevision: 1, runtime: 'pi-agent-core', providerId: 'provider', observationMs: 2000};
}

describe('scene SSE verification gate', () => {
  afterEach(() => jest.restoreAllMocks());
  it('accepts one correct proposal without forcing artificial revisions, but labels semantic scope unproven', () => {
    const result = evaluateSceneSseVerification(fixture());
    expect(result.passed).toBe(true);
    expect(result.uncoveredFacets).toContain('multi_revision_correction_not_required_by_this_case');
    expect(result.uncoveredFacets).toContain('scene_action_and_device_semantics_not_independently_scored');
  });
  it.each(['scope', 'revision', 'report', 'provider', 'terminal', 'bounds', 'uncertainty', 'refs'])('rejects false success: %s', change => {
    const input = fixture();
    if (change === 'scope') input.start.runId = 'other';
    if (change === 'revision') input.observation.finalTimeline = view(2);
    if (change === 'report') input.report.report.reportId = 'missing';
    if (change === 'provider') input.report.report.generatedBy.providerId = 'wrong';
    if (change === 'terminal') input.observation.terminals.push({event: 'analysis_completed', eventIndex: 6});
    if (change === 'bounds') input.bounds.endNs = '9007199254740993';
    if (change === 'uncertainty') (input.observation.finalTimeline!.segments[0] as any).semanticStatus = 'verified';
    if (change === 'refs') (input.observation.finalTimeline!.segments[0] as any).referencesResolved = false;
    expect(evaluateSceneSseVerification(input).passed).toBe(false);
  });
  it('requires additional completed acquisition for explicit revision scenarios', () => {
    const input = fixture(2); input.minRevision = 2;
    expect(evaluateSceneSseVerification(input).checks.sceneRevisionAfterNewAcquisition).toBe(false);
    input.observation.revisions.unshift({revision: 1, event: 0, acquisitions: 0, fingerprint: 'earlier'});
    expect(evaluateSceneSseVerification(input).passed).toBe(true);
  });
  it('does not count progress, foreign traces, failed or skipped outputs or replayed data as fresh acquisition', () => {
    const state = createSceneSseObservation();
    recordSceneSseEvent(state, 'data', {meta: {...fact().meta, traceId: 'other'}}, scope);
    recordSceneSseEvent(state, 'data', {meta: {...fact().meta, executionStatus: 'optional_error'}}, scope);
    recordSceneSseEvent(state, 'data', {meta: {...fact('skipped').meta, executionStatus: 'skipped'}}, scope);
    recordSceneSseEvent(state, 'progress', fact(), scope);
    recordSceneSseEvent(state, 'data', fact(), scope); recordSceneSseEvent(state, 'data', fact(), scope);
    expect(state.acquisitions).toBe(1);
  });
  it('rejects stale and late candidate updates', () => {
    const state = createSceneSseObservation();
    recordSceneSseEvent(state, 'scene_timeline_updated', view(), scope);
    recordSceneSseEvent(state, 'scene_timeline_updated', view(), scope);
    state.cancelConfirmed = true;
    recordSceneSseEvent(state, 'scene_timeline_updated', view(2), scope);
    expect(state.issues).toEqual(expect.arrayContaining(['scene_revision_not_increasing', 'scene_revision_after_terminal_or_cancel']));
  });
  it('checks cancellation against root status and rejects any success report after cancel', () => {
    const input = fixture();
    input.observation.terminals = [{event: 'analysis_cancelled', eventIndex: 4}]; input.observation.cancelConfirmed = true;
    delete input.observation.reportRef; delete input.observation.finalTimeline;
    input.replay.terminals = [{event: 'analysis_cancelled', eventIndex: 4}]; delete input.replay.reportRef; delete input.replay.finalTimeline;
    const status = {...scope, status: 'cancelled'};
    expect(evaluateSceneSseVerification({...input, scenario: 'cancel', status}).passed).toBe(true);
    expect(evaluateSceneSseVerification({...input, scenario: 'cancel'}).passed).toBe(false);
  });
  it('preserves analyze defaults and rejects scene flags on ordinary or incompatible runs', () => {
    expect(parseArgs([]).entry).toBeUndefined();
    expect(parseArgs(['--entry', 'scene-reconstruction']).sceneMinRevision).toBeUndefined();
    expect(() => parseArgs(['--scene-min-revision', '2'])).toThrow('Scene flags');
    expect(() => parseArgs(['--entry', 'scene-reconstruction', '--preset', 'smart'])).toThrow('cannot borrow');
    expect(() => parseArgs(['--entry', 'scene-reconstruction', '--require-non-partial'])).toThrow('cannot borrow');
  });
  it('collects duplicate terminal events in one stream instead of stopping at the first', async () => {
    const events = ['analysis_completed', 'analysis_completed'].map(event => `event: ${event}\ndata: {"success":true}\n\n`).join('');
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(events));
    const seen: string[] = [];
    await collectSseSummary('http://verifier.invalid', 'session', 1000, {requiredText: [], forbiddenText: []},
      {runId: 'run', readUntilClose: true, observeEvent: event => {seen.push(event);}});
    expect(seen).toEqual(['analysis_completed', 'analysis_completed']);
  });
  it('bounds a terminal stream left open by the server and releases its reader', async () => {
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => new Response(new ReadableStream({start(controller) {
      controller.enqueue(new TextEncoder().encode('event: analysis_cancelled\ndata: {}\n\n'));
      options?.signal?.addEventListener('abort', () => controller.error(options.signal?.reason), {once: true});
    }})));
    const summary = await collectSseSummary('http://verifier.invalid', 'session', 1000, {requiredText: [], forbiddenText: []},
      {runId: 'run', readUntilClose: true, terminalObservationMs: 5});
    expect(summary.terminalEvent).toBe('analysis_cancelled');
  });
  it('records a failed run\'s error as its terminal and never the stream-closing end', () => {
    const state = createSceneSseObservation();
    for (const event of ['analysis_completed', 'end', 'error']) recordSceneSseEvent(state, event, {}, scope);
    expect(state.terminals.map(terminal => terminal.event)).toEqual(['analysis_completed', 'error']);
  });
  it.each([true, false])('ends at a failed run\'s error event on a stream the server keeps open (readUntilClose=%s)', async readUntilClose => {
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => new Response(new ReadableStream({start(controller) {
      controller.enqueue(new TextEncoder().encode('event: error\ndata: {"message":"database is locked"}\n\n'));
      options?.signal?.addEventListener('abort', () => controller.error(options.signal?.reason), {once: true});
    }})));
    const summary = await collectSseSummary('http://verifier.invalid', 'session', 1000, {requiredText: [], forbiddenText: []},
      {runId: 'run', readUntilClose, terminalObservationMs: 5});
    expect(summary.terminalEvent).toBe('error');
    expect(summary.errorEvents).toEqual(['database is locked']);
  });
  it('checks independently queried exact source boundaries without promoting natural-language correctness', async () => {
    const spec = parseSceneOracleSpecs([{id: 'native-window', sql: 'SELECT ts, end_ts, upid FROM trusted_fixture',
      startColumn: 'ts', endColumn: 'end_ts', objectKind: 'upid', objectKeyColumn: 'upid'}]);
    const oracle = await collectSceneOracleRows(spec, async () => ({columns: ['ts', 'end_ts', 'upid'], rows: [['9007199254740993', '9007199254740994', 7]]}));
    expect(evaluateSceneOracleRows(view(), oracle)).toEqual({'sceneOracle:native-window': true});
    const changed = view(); changed.segments[0].segment.endNs = '9007199254740995';
    expect(evaluateSceneOracleRows(changed, oracle)).toEqual({'sceneOracle:native-window': false});
    await expect(collectSceneOracleRows(spec, async () => ({columns: ['ts', 'end_ts', 'upid'], rows: [[Number.MAX_SAFE_INTEGER + 1, 2, 7]]}))).rejects.toThrow('NONEXACT');
  });
  it('exposes explicit scene wrapper suites without changing the ordinary default', () => {
    const wrapper = require('../../../scripts/run-deepseek-agent-e2e.cjs');
    expect(wrapper.parseArgs(['--suite', 'scene-reconstruction']).suite).toBe('scene-reconstruction');
    expect(wrapper.suites['scene-reconstruction'].args).toEqual(expect.arrayContaining(['--entry', 'scene-reconstruction']));
    expect(wrapper.suites['scene-cancel'].args).toEqual(expect.arrayContaining(['--scene-scenario', 'cancel']));
    expect(wrapper.suites.scrolling.args).not.toContain('--entry');
  });
  it('keeps raw DataEnvelope provenance when the generic SSE payload unwraps its table data', async () => {
    const state = createSceneSseObservation();
    const envelope = {...fact(), data: {columns: ['ts'], rows: [['1']]}};
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(`event: data\ndata: ${JSON.stringify(envelope)}\n\nevent: end\ndata: {}\n\n`));
    await collectSseSummary('http://verifier.invalid', 'session', 1000, {requiredText: [], forbiddenText: []},
      {runId: 'run', observeEvent: (event, payload) => recordSceneSseEvent(state, event, payload, scope)});
    expect(state.acquisitions).toBe(1);
  });

  it('separates a failed native answer with published partial scene from a successful complete-run case', () => {
    const input = fixture(); input.observation.finalSuccess = false; input.observation.finalPartial = true;
    input.replay.finalSuccess = false; input.replay.finalPartial = true;
    const status = {...input.status, status: 'failed', result: {...input.status.result, success: false, partial: true}};
    expect(evaluateSceneSseVerification({...input, status}).passed).toBe(false);
    expect(evaluateSceneSseVerification({...input, status, scenario: 'partial'}).passed).toBe(true);
    expect(evaluateSceneSseVerification({...input, status: {...status, result: {...status.result, partial: false}}, scenario: 'partial'}).passed).toBe(false);
  });

  it.each(['missing-ref', 'wrong-ref', 'success', 'partial', 'terminal'])('rejects corrupted reconnect output: %s', change => {
    const input = fixture();
    if (change === 'missing-ref') delete input.replay.reportRef;
    if (change === 'wrong-ref') input.replay.reportRef = {...input.replay.reportRef!, reportId: 'other-report'};
    if (change === 'success') input.replay.finalSuccess = false;
    if (change === 'partial') input.replay.finalPartial = true;
    if (change === 'terminal') input.replay.terminals[0].event = 'analysis_cancelled';
    expect(evaluateSceneSseVerification(input).passed).toBe(false);
  });
  it('does not treat new receipts, source locators, segment IDs or ordering as a corrected scene', () => {
    const state = createSceneSseObservation(); const first = view();
    recordSceneSseEvent(state, 'data', fact('first'), scope);
    recordSceneSseEvent(state, 'scene_timeline_updated', first, scope);
    const changed = structuredClone(first); changed.revision = 2;
    changed.segments[0].issuedRevision = 2;
    changed.segments[0].segment.id = 'renamed';
    changed.segments[0].segment.evidenceRefs = [{evidenceRefId: 'fresh-capture', rowIndex: 4}];
    changed.segments[0].checks = [{predicate: 'time.start_cell_equals_boundary', status: 'unknown'}];
    recordSceneSseEvent(state, 'data', fact('second'), scope);
    recordSceneSseEvent(state, 'scene_timeline_updated', changed, scope);
    expect(state.revisions[1].acquisitions).toBeGreaterThan(state.revisions[0].acquisitions);
    expect(state.revisions[1].fingerprint).toBe(state.revisions[0].fingerprint);
    changed.revision = 3; changed.segments[0].segment.endNs = '9007199254740995';
    recordSceneSseEvent(state, 'scene_timeline_updated', changed, scope);
    expect(state.revisions[2].fingerprint).not.toBe(state.revisions[1].fingerprint);
  });

});
