// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type {AnalysisResult} from '../../../agent/core/orchestratorTypes';
import {analysisDeliveryFingerprint} from '../../../types/analysisDelivery';
import {computePaths, ensureSessionLayout, sessionPaths} from '../../io/paths';
import {writeJsonFile} from '../../io/sessionStore';
import {buildCliSceneReportBundle, latestCliSceneReportPath, loadCliSceneReport,
  renderCliSceneReport, turnCliSceneReportPath} from '../sceneReportReference';

function result(): AnalysisResult {
  return {sessionId: 'session', success: true, findings: [], hypotheses: [], conclusion: 'body', confidence: 0.5, rounds: 1, totalDurationMs: 1,
    sceneReport: {schemaVersion: 'scene_report_ref@1', reportId: 'scene-v3-one', traceId: 'trace', sessionId: 'session',
      runId: 'run', revision: 3, expiresAt: Date.now() + 60_000, manifestSha256: 'a'.repeat(64)},
    sceneTimeline: {schemaVersion: 'scene_timeline@1', traceId: 'trace', sessionId: 'session', runId: 'run', revision: 3,
      segments: [], unresolved: ['RAW_TIMELINE_CANARY'], diagnostics: [], status: 'partial',
      coverage: {status: 'unknown', captureStatus: 'unknown', reason: 'missing', sources: []}}};
}
describe('CLI scene report reference', () => {
  let home: string;
  beforeEach(() => {home = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-scene-ref-'));});
  afterEach(() => {fs.rmSync(home, {recursive: true, force: true});});
  function fixture(value = result()) {
    const sp = sessionPaths(computePaths(home), 'session'); ensureSessionLayout(sp);
    const request = {sp, sessionId: 'session', traceId: 'trace', turn: 1, conclusion: 'body', turnMarkdown: '# Turn 1\n\nbody\n'};
    const bundle = buildCliSceneReportBundle({...request, result: value});
    writeJsonFile(sp, turnCliSceneReportPath(sp, 1), bundle); writeJsonFile(sp, latestCliSceneReportPath(sp), bundle);
    return {sp, request, bundle};
  }
  it('stores an exact conclusion/turn/run/revision binding and no full timeline', () => {
    const {bundle, request} = fixture();
    expect(bundle).toMatchObject({status: 'available', binding: {sessionId: 'session', traceId: 'trace', turn: 1,
      runId: 'run', revision: 3, conclusionFingerprint: analysisDeliveryFingerprint('body')}});
    expect(JSON.stringify(bundle)).not.toContain('RAW_TIMELINE_CANARY');
    expect(loadCliSceneReport(request)).toMatchObject({status: 'available', reference: {reportId: 'scene-v3-one'}});
    expect(renderCliSceneReport(loadCliSceneReport(request), 'en')).toContain('Details require backend authorization: /api/agent/v1/scene-reconstruct/report/scene-v3-one');
  });
  it('keeps pending zero-turn sessions compatible without creating scene history', () => {
    const sp = sessionPaths(computePaths(home), 'pending');
    expect(loadCliSceneReport({sp, sessionId: 'pending', turn: 0, turnMarkdown: '', latest: true})).toEqual({status: 'none'});
    expect(fs.existsSync(latestCliSceneReportPath(sp))).toBe(false);
  });
  it.each(['sessionId', 'traceId', 'runId', 'revision'] as const)('does not persist a mismatched %s reference as available', field => {
    const value = result(); (value.sceneReport as any)[field] = field === 'revision' ? 4 : 'other';
    expect(fixture(value).bundle).toMatchObject({status: 'unavailable', reference: null, unavailableReason: 'scene_reference_mismatched'});
  });
  it('retains unavailable state when a timeline lacks a report reference', () => {
    const value = result(); delete value.sceneReport;
    expect(fixture(value).bundle).toMatchObject({status: 'unavailable', unavailableReason: 'scene_report_missing'});
  });
  it('rejects completion from a different body/run without changing the body', () => {
    const value = result(); value.completion = {schemaVersion: 1, runtimeKind: 'openai-agents-sdk', status: 'completed',
      runId: 'other', attemptId: 'attempt', candidateRef: 'candidate', conclusionFingerprint: analysisDeliveryFingerprint('other body')};
    expect(fixture(value).bundle.status).toBe('unavailable'); expect(value.conclusion).toBe('body');
  });
  it.each([
    {sessionId: 'other'}, {traceId: 'other'}, {turn: 2}, {conclusion: 'changed'}, {turnMarkdown: 'changed'},
  ])('rejects mismatched stored binding %j', override => {
    const {request} = fixture();
    expect(loadCliSceneReport({...request, latest: true, ...override})).toMatchObject({status: 'unavailable'});
  });
  it('fails closed on corrupt JSON, changed revision and a missing latest file without per-turn fallback', () => {
    const {sp, request, bundle} = fixture();
    writeJsonFile(sp, latestCliSceneReportPath(sp), {...bundle, reference: {...bundle.reference, revision: 99}});
    expect(loadCliSceneReport({...request, latest: true}).status).toBe('unavailable');
    fs.writeFileSync(latestCliSceneReportPath(sp), '{invalid');
    expect(loadCliSceneReport({...request, latest: true}).status).toBe('unavailable');
    fs.unlinkSync(latestCliSceneReportPath(sp));
    expect(loadCliSceneReport({...request, latest: true})).toMatchObject({status: 'unavailable', reason: 'scene_reference_missing'});
  });
  it('marks expired references unavailable while preserving their historical identity', () => {
    const value = result(); value.sceneReport!.expiresAt = Date.now() - 1;
    const {request} = fixture(value);
    const loaded = loadCliSceneReport(request);
    expect(loaded).toMatchObject({status: 'unavailable', reason: 'scene_report_expired', reference: {reportId: 'scene-v3-one'}});
    expect(renderCliSceneReport(loaded, 'en')).toContain('expired');
  });
  it('clears latest on an ordinary next turn and keeps the older turn reference', () => {
    const {sp, request} = fixture(); const ordinary = result(); delete ordinary.sceneTimeline; delete ordinary.sceneReport;
    const next = {...request, turn: 2, turnMarkdown: '# Turn 2\n\nbody\n'};
    const bundle = buildCliSceneReportBundle({...next, result: ordinary});
    writeJsonFile(sp, latestCliSceneReportPath(sp), bundle); writeJsonFile(sp, turnCliSceneReportPath(sp, 2), bundle);
    expect(loadCliSceneReport({...next, latest: true})).toEqual({status: 'none'});
    expect(loadCliSceneReport(request).status).toBe('available');
  });
  it('rejects a latest reference from another run even if the readable body is unchanged', () => {
    const {sp, request, bundle} = fixture();
    const changed = {...bundle.reference!, runId: 'other-run'};
    writeJsonFile(sp, latestCliSceneReportPath(sp), {...bundle, binding: {...bundle.binding, runId: changed.runId},
      reference: changed, referenceFingerprint: analysisDeliveryFingerprint(changed)});
    expect(loadCliSceneReport({...request, latest: true}).status).toBe('unavailable');
    expect(loadCliSceneReport(request).status).toBe('available');
  });

});
