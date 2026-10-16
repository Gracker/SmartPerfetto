// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {ArtifactStore, EVIDENCE_RETENTION_CELLS_ENV} from '../../../agentv3/artifactStore';
import {buildTraceProcessorQueryProvenance} from '../../../services/traceProcessorConnectionModel';
import {captureEvidenceTable, type CapturedFieldSemantics} from '../../../services/evidence/evidenceCapture';
import {investigationCaptureFields} from '../../../services/evidence/investigationEvidenceLedger';
import type {EvidenceReadView} from '../../../services/evidence/evidenceReadView';
import {createSceneRunContext, sealSceneTimeline, sceneRunState, revokeSceneRunContext, type SceneRunContext} from '../sceneRunContext';
import {proposeSceneTimeline, sceneCellValueMatches, sceneProposalActionRequired} from '../sceneTimelineProposal';
import {assessSceneTimeline} from '../sceneTimelineAssessment';
import type {SceneTimelineSegment, SceneRunLimits} from '../sceneTimelineContract';

const scope = {runId: 'run', sessionId: 'session', traceId: 'trace', ownerKey: 'owner'};
const start = '9007199254740992';
const end = '9007199254740993';
const field: CapturedFieldSemantics = {origin: {kind: 'skill_literal', definitionFingerprint: 'producer@1',
  skillId: 'fixture', stepId: 'facts'}, unit: 'ns', timeRole: 'start', clock: 'trace_monotonic'};
function fixture(options: {runId?: string; traceId?: string; fields?: Record<string, CapturedFieldSemantics>;
  values?: [string | number, string | number]; limits?: Partial<SceneRunLimits>; signal?: AbortSignal} = {}) {
  const store = new ArtifactStore();
  const add = (evidenceRefId = 'ev', values: [string | number, string | number] = options.values || [start, end]) => {
    const data = {columns: ['begin', 'finish', 'device_id'], rows: [[...values, '7']]};
    const id = store.store({skillId: 'fixture', stepId: 'facts', data,
      traceProvenance: buildTraceProcessorQueryProvenance({traceId: options.traceId || scope.traceId, traceSide: 'current'})});
    store.registerEvidenceCapture(id, captureEvidenceTable(data, options.fields || {begin: field, finish: {...field, timeRole: 'end'}}),
      {evidenceRefId, originRunId: options.runId || scope.runId});
    return id;
  };
  add();
  const view = () => store.createEvidenceReadView({currentRunId: scope.runId, ownerKey: scope.ownerKey,
    allowedTraces: [{traceId: options.traceId || scope.traceId, traceSide: 'current'}]});
  const create = (reader: () => EvidenceReadView = view) => createSceneRunContext({...scope, deadlineMs: Date.now() + 60000,
    traceBounds: {startNs: '0', endNs: '99999999999999999'}, signal: options.signal, assertAuthorized: () => {},
    createEvidenceReadView: reader, limits: options.limits});
  return {store, add, view, create, handle: create()};
}
function segment(id = 's', changes: Partial<SceneTimelineSegment> = {}): SceneTimelineSegment {
  return {id, startNs: start, endNs: end, object: {kind: 'input_device', key: '7'},
    userAction: 'Observed touch movement', deviceState: 'Screen state unknown', appResponse: 'Response unknown',
    evidenceRefs: [{evidenceRefId: 'ev', rowIndex: 0}], boundaries: {
      start: {source: 'evidence', evidenceIndex: 0, column: 'begin'}, end: {source: 'evidence', evidenceIndex: 0, column: 'finish'}},
    dependencies: [], supersedes: [], ...changes};
}
const proposal = (segments = [segment()], baseRevision = 0, proposalId = 'p') => ({segments, baseRevision, proposalId, unresolved: []});

describe('scene timeline issued run and revision evidence', () => {
  it('seals committed work after execution expiry without renewing its acquisition budget', async () => {
    const {handle} = fixture();
    await proposeSceneTimeline(handle, proposal());
    const clock = jest.spyOn(Date, 'now').mockReturnValue(sceneRunState(handle).options.deadlineMs + 1);
    try {
      const snapshot = sealSceneTimeline(handle);
      expect(assessSceneTimeline(snapshot, scope).segments).toHaveLength(1);
      await expect(proposeSceneTimeline(handle, proposal([], 1, 'late'))).rejects.toThrow();
    } finally {clock.mockRestore();}
  });
  it('seals the last committed revision while rejecting an in-flight late proposal', async () => {
    const data = fixture();
    let resume!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => {entered = resolve;});
    const gate = new Promise<void>(resolve => {resume = resolve;});
    let delay = false;
    const handle = data.create(() => ({async resolveReferences(requests, signal) {
      if (delay) {entered(); await gate;}
      return data.view().resolveReferences(requests, signal);
    }}));
    await proposeSceneTimeline(handle, proposal());
    delay = true;
    const pending = proposeSceneTimeline(handle, proposal([segment('new')], 1, 'pending'));
    await started;
    const snapshot = sealSceneTimeline(handle);
    resume();
    await expect(pending).rejects.toThrow('scene_run_frozen');
    expect(snapshot.revision).toBe(1);
    expect(snapshot.segments.map(item => item.segment.id)).toEqual(['s']);
    expect(assessSceneTimeline(snapshot, scope).segments).toHaveLength(1);
  });
  it('never seals or reads a cancelled run even if its prior revision was valid', async () => {
    const controller = new AbortController();
    const {handle} = fixture({signal: controller.signal});
    await proposeSceneTimeline(handle, proposal());
    const snapshot = sealSceneTimeline(handle);
    controller.abort();
    expect(() => sealSceneTimeline(handle)).toThrow('scene_run_cancelled');
    expect(() => assessSceneTimeline(snapshot, scope)).toThrow('scene_run_cancelled');
  });
  it('preserves >2^53 values and 1 ns boundaries without certifying story or guessed identity', async () => {
    const {handle} = fixture();
    const result = await proposeSceneTimeline(handle, proposal());
    expect(result.accepted).toBe(true);
    expect(result.segments![0]).toMatchObject({referencesResolved: true, semanticStatus: 'unverified', checks: [
      {status: 'passed'}, {status: 'passed'}, {status: 'unknown'}, {status: 'unknown'}]});
    const snapshot = sealSceneTimeline(handle);
    expect(assessSceneTimeline(snapshot, scope)).toMatchObject({status: 'partial', coverage: {status: 'unknown'}});
    expect(() => assessSceneTimeline(JSON.parse(JSON.stringify(snapshot)), scope)).toThrow('unissued_scene_snapshot');
    await expect(proposeSceneTimeline(handle, proposal())).rejects.toThrow('scene_run_frozen');
  });
  it('rejects copied context and model proof authority', async () => {
    const {handle} = fixture();
    await expect(proposeSceneTimeline({...handle} as SceneRunContext, proposal())).rejects.toThrow('unissued_scene_context');
    expect(await proposeSceneTimeline(handle, {...proposal(), verified: true})).toMatchObject({accepted: false});
    expect(await proposeSceneTimeline(handle, proposal([{...segment(), receipt: {verified: true}} as SceneTimelineSegment])))
      .toMatchObject({accepted: false});
  });
  it.each([{runId: 'old-run'}, {traceId: 'other-trace'}])('rejects old capture scope %j even when ordinary reader can resolve it', async (options) => {
    const {handle} = fixture(options);
    const result = await proposeSceneTimeline(handle, proposal());
    expect(result).toMatchObject({accepted: false, revision: 0,
      diagnostics: [{code: 'evidence_scope_or_witness_mismatch', segmentId: 's', referenceIndex: 0}]});
    expect(JSON.stringify(result)).not.toContain(options.runId || options.traceId);
    expect(JSON.stringify(result)).not.toContain(start);
  });
  it('locates a mismatched reference without echoing its private captured or submitted value', async () => {
    const {handle} = fixture({values: ['private-captured-cell', end]});
    const result = await proposeSceneTimeline(handle, proposal([segment('segment:with:colons', {
      evidenceRefs: [{evidenceRefId: 'ev', rowIndex: 0},
        {evidenceRefId: 'ev', rowIndex: 0, column: 'begin', value: 'submitted-wrong-value'}],
    })]));
    const diagnostic = {code: 'evidence_value_mismatch', segmentId: 'segment:with:colons', referenceIndex: 1,
      detail: 'column: begin; captured type: string'};
    expect(result).toEqual({accepted: false, revision: 0, diagnostics: [diagnostic], rejectedGroups: [{
      segmentIds: ['segment:with:colons'], segmentIndices: [0], removedSegmentIds: [], diagnostics: [diagnostic]}]});
    expect(JSON.stringify(result)).not.toContain('private-captured-cell');
    expect(JSON.stringify(result)).not.toContain('submitted-wrong-value');
  });
  it('locates a missing boundary column even without a reference column', async () => {
    const {handle} = fixture();
    const result = await proposeSceneTimeline(handle, proposal([segment('s', {boundaries: {
      start: {source: 'evidence', evidenceIndex: 0, column: 'begin'},
      end: {source: 'evidence', evidenceIndex: 0, column: 'invented_end'},
    }})]));
    expect(result).toMatchObject({accepted: false, diagnostics: [{code: 'evidence_reference_rejected',
      segmentId: 's', referenceIndex: 0,
      detail: 'required_column_missing; requiredColumns: ["begin","invented_end"]; availableColumns: ["begin","finish","device_id"]; ' +
        'cite an existing column, query a real end column, or mark the boundary inferred'}]});
    expect(JSON.stringify(result)).not.toContain(start);
  });
  it('does not echo an arbitrary reader failure reason', async () => {
    const data = fixture();
    const handle = data.create(() => ({async resolveReferences(requests) {
      return requests.map(request => ({key: request.key, status: 'denied' as const, reason: 'private-scope-detail'}));
    }}));
    const result = await proposeSceneTimeline(handle, proposal());
    expect(result.diagnostics[0]).toMatchObject({segmentId: 's', referenceIndex: 0});
    expect(result.diagnostics[0].detail).toContain('reference_unavailable');
    expect(JSON.stringify(result)).not.toContain('private-scope-detail');
  });
  it('rejects serialized read resolution despite matching scope and rows', async () => {
    const fixtureData = fixture();
    const handle = fixtureData.create(() => ({async resolveReferences(requests) {
      return JSON.parse(JSON.stringify(await fixtureData.view().resolveReferences(requests)));
    }}));
    expect(await proposeSceneTimeline(handle, proposal())).toMatchObject({accepted: false,
      diagnostics: [{code: 'evidence_scope_or_witness_mismatch'}]});
  });
  it('does not infer timestamp units or semantics from column spelling', async () => {
    const {handle} = fixture({fields: {begin: {...field, timeRole: undefined}, finish: {...field, clock: undefined}}});
    const result = await proposeSceneTimeline(handle, proposal());
    expect(result.segments![0].checks.slice(0, 2).map(check => check.status)).toEqual(['unknown', 'unknown']);
  });
  it('reports contradicted finite boundaries but never promotes unsupported story predicates', async () => {
    const {handle} = fixture();
    const result = await proposeSceneTimeline(handle, proposal([segment('s', {endNs: '9007199254740994'})]));
    expect(result.segments![0].checks[1]).toMatchObject({status: 'contradicted'});
    expect(result.segments![0].semanticStatus).toBe('unverified');
  });
  it('supports idempotency, rejects stale updates and conflicting retries', async () => {
    const {handle} = fixture();
    const first = await proposeSceneTimeline(handle, proposal());
    expect(await proposeSceneTimeline(handle, proposal())).toBe(first);
    expect(await proposeSceneTimeline(handle, proposal([], 0, 'other'))).toMatchObject({accepted: false, diagnostics: [{code: 'stale_base_revision'}]});
    expect(await proposeSceneTimeline(handle, proposal([], 0))).toMatchObject({accepted: false, diagnostics: [{code: 'proposal_id_content_conflict'}]});
  });
  it('retains unchanged receipts on append and invalidates dependency closure on semantic revisions', async () => {
    const {handle} = fixture();
    const a = segment('a'); const b = segment('b', {dependencies: ['a']});
    const first = await proposeSceneTimeline(handle, proposal([a, b]));
    const second = await proposeSceneTimeline(handle, proposal([segment('c')], 1, 'append'));
    expect(second.segments!.find(item => item.segment.id === 'a')).toBe(first.segments![0]);
    const third = await proposeSceneTimeline(handle, proposal([{...a, userAction: 'Revised observed action'}], 2, 'revise'));
    expect(third.segments!.find(item => item.segment.id === 'a')!.issuedRevision).toBe(3);
    expect(third.segments!.find(item => item.segment.id === 'b')!.issuedRevision).toBe(3);
    expect(third.segments!.find(item => item.segment.id === 'c')!.issuedRevision).toBe(2);
  });
  it('rejects missing parents and cross-block cycles, supports explicit split membership', async () => {
    const {handle} = fixture();
    expect((await proposeSceneTimeline(handle, proposal([segment('a', {dependencies: ['missing']})]))).accepted).toBe(false);
    expect((await proposeSceneTimeline(handle, proposal([segment('a', {dependencies: ['b']}), segment('b', {dependencies: ['a']})]))).accepted).toBe(false);
    await proposeSceneTimeline(handle, proposal([segment('parent')]));
    const split = await proposeSceneTimeline(handle, proposal([segment('left', {supersedes: ['parent']}),
      segment('right', {supersedes: ['parent']})], 1, 'split'));
    expect(split.accepted).toBe(true);
    expect(split.segments!.map(item => item.segment.id).sort()).toEqual(['left', 'right']);
    const revision = await proposeSceneTimeline(handle, proposal([segment('left', {supersedes: ['parent'], userAction: 'Revised child'})], 2, 'child-revision'));
    expect(revision.accepted).toBe(true);
  });
  it('reacquires views between revisions and diagnoses evicted references without restoring witnesses', async () => {
    const old = process.env[EVIDENCE_RETENTION_CELLS_ENV];
    process.env[EVIDENCE_RETENTION_CELLS_ENV] = '3';
    try {
      const {handle, add} = fixture();
      await proposeSceneTimeline(handle, proposal());
      add('new');
      const result = await proposeSceneTimeline(handle, proposal([segment('s', {userAction: 'Changed story'})], 1, 'changed'));
      expect(result).toMatchObject({accepted: false, diagnostics: [{code: 'evidence_reference_rejected'}]});
      expect(result.diagnostics[0].detail).toContain('reacquire');
      expect((await proposeSceneTimeline(handle, proposal([segment('s', {userAction: 'Changed story',
        evidenceRefs: [{evidenceRefId: 'new', rowIndex: 0}]})], 1, 'reacquired'))).accepted).toBe(true);
    } finally {if (old === undefined) delete process.env[EVIDENCE_RETENTION_CELLS_ENV]; else process.env[EVIDENCE_RETENTION_CELLS_ENV] = old;}
  });
  it('chunks more than 256 refs and enforces cumulative read/receipt/candidate budgets', async () => {
    const f = fixture({limits: {maxReferencesPerRead: 128, maxRunReferences: 301}});
    const chunks: number[] = [];
    const handle = f.create(() => ({async resolveReferences(requests, signal) {chunks.push(requests.length);
      return f.view().resolveReferences(requests, signal);}}));
    const refs = Array.from({length: 300}, () => ({evidenceRefId: 'ev', rowIndex: 0}));
    expect((await proposeSceneTimeline(handle, proposal([segment('s', {evidenceRefs: refs})]))).accepted).toBe(true);
    expect(chunks).toEqual([128, 128, 44]);
    expect(await proposeSceneTimeline(handle, proposal([segment('t', {evidenceRefs: refs})], 1, 'over')))
      .toMatchObject({accepted: false, diagnostics: [{code: 'scene_reference_budget_exhausted'}]});
    expect(sceneRunState(handle).segments.size).toBe(1);
    const limited = fixture({limits: {maxReceipts: 1}}).handle;
    await proposeSceneTimeline(limited, proposal());
    expect(await proposeSceneTimeline(limited, proposal([segment('s', {userAction: 'changed'})], 1, 'new')))
      .toMatchObject({accepted: false, diagnostics: [{code: 'scene_receipt_budget_exhausted'}]});
  });
  it('rejects concurrent mutation and cancels pending reads before any commit', async () => {
    const controller = new AbortController(); const f = fixture({signal: controller.signal});
    let resume!: () => void;
    const gate = new Promise<void>(resolve => {resume = resolve;});
    const handle = f.create(() => ({async resolveReferences(requests) {await gate; return f.view().resolveReferences(requests);}}));
    const pending = proposeSceneTimeline(handle, proposal());
    await expect(proposeSceneTimeline(handle, proposal([], 0, 'second'))).rejects.toThrow('scene_mutation_in_progress');
    controller.abort(); resume();
    await expect(pending).rejects.toThrow('scene_run_cancelled');
    expect(sceneRunState(handle).revision).toBe(0);
  });
  it('checks live authorization after evidence awaits and rejects late deadline', async () => {
    const f = fixture(); let allowed = true;
    const handle = createSceneRunContext({...scope, deadlineMs: Date.now() + 60000,
      traceBounds: {startNs: '0', endNs: '99999999999999999'}, assertAuthorized: () => {if (!allowed) throw new Error('denied');},
      createEvidenceReadView: () => ({async resolveReferences(requests) {const reads = await f.view().resolveReferences(requests); allowed = false; return reads;}})});
    await expect(proposeSceneTimeline(handle, proposal())).rejects.toThrow('denied');
    expect(sceneRunState(handle).revision).toBe(0);
    expect(() => createSceneRunContext({...scope, deadlineMs: Date.now() - 1, traceBounds: {startNs: '0', endNs: '1'},
      assertAuthorized: () => {}, createEvidenceReadView: f.view})).toThrow('scene_run_deadline_exhausted');
  });
  it('revokes live authority after finalization while preserving readable historical DTOs', async () => {
    const {handle} = fixture();
    await proposeSceneTimeline(handle, proposal());
    const snapshot = sealSceneTimeline(handle);
    const assessment = assessSceneTimeline(snapshot, scope);
    revokeSceneRunContext(handle);
    expect(() => assessSceneTimeline(snapshot, scope)).toThrow('unissued_scene_snapshot');
    expect(assessment.segments[0].segment.id).toBe('s');
    await expect(proposeSceneTimeline(handle, proposal())).rejects.toThrow('unissued_scene_context');
  });
  it('converts only producer-declared exact time quantities', async () => {
    const {handle} = fixture({values: ['9007199254.740992', '9007199254.740993'], fields: {
      begin: {...field, unit: 'ms'}, finish: {...field, unit: 'ms', timeRole: 'end'}}});
    expect((await proposeSceneTimeline(handle, proposal())).segments![0].checks.slice(0, 2).map(check => check.status))
      .toEqual(['passed', 'passed']);
    const unsafe = fixture({values: [Number(start), Number(end)]}).handle;
    expect((await proposeSceneTimeline(unsafe, proposal())).segments![0].checks[0]).toMatchObject({status: 'unknown'});
  });
  it.each([
    [{maxSegments: 1}, [segment('a'), segment('b')], 'scene_candidate_budget_exhausted'],
    [{maxRunCandidates: 1}, [segment('a'), segment('b')], 'scene_cumulative_candidate_budget_exhausted'],
    [{maxDependencyEdges: 1}, [segment('a'), segment('b', {dependencies: ['a', 'a']})], 'scene_dependency_budget_exhausted'],
    [{maxProposalBytes: 1}, [segment('a')], 'scene_byte_budget_exhausted'],
    [{maxRunBytes: 1000}, [segment('a')], 'scene_byte_budget_exhausted'],
  ] as Array<[Partial<SceneRunLimits>, SceneTimelineSegment[], string]>)('enforces resource quota %j', async (limits, segments, code) => {
    const {handle} = fixture({limits});
    const result = await proposeSceneTimeline(handle, proposal(segments));
    expect(result).toMatchObject({accepted: false, revision: 0, diagnostics: [{code}]});
    expect(assessSceneTimeline(sealSceneTimeline(handle), scope)).toMatchObject({status: 'partial', diagnostics: expect.arrayContaining([{code}])});
  });
  it('does not silently retain an incomplete read receipt when a later delta can resolve it', async () => {
    const f = fixture(); let complete = false;
    const handle = f.create(() => complete ? f.view() : {async resolveReferences(requests) {
      return requests.map(request => ({key: request.key, status: 'incomplete' as const, reason: 'read_budget_exhausted'}));
    }});
    const first = await proposeSceneTimeline(handle, proposal());
    expect(first.segments![0].referencesResolved).toBe(false);
    complete = true;
    const next = await proposeSceneTimeline(handle, proposal([], 1, 'retry'));
    expect(next.segments![0]).toMatchObject({referencesResolved: true, issuedRevision: 2});
  });

  it('checks CTE identities only from declared producer roles, keeping prose unverified', async () => {
    const fields = investigationCaptureFields({window: {start: 'begin', end: 'finish'}, identity: {upid: 'device_id'}, metrics: []}, field.origin);
    const {handle} = fixture({fields});
    const result = await proposeSceneTimeline(handle, proposal([segment('s', {object: {kind: 'upid', key: '7'}})]));
    expect(result.segments![0].checks[2]).toMatchObject({predicate: 'identity.cited_object_observed', status: 'passed'});
    expect(result.segments![0].semanticStatus).toBe('unverified');
    const mismatch = await proposeSceneTimeline(handle, proposal([segment('s', {object: {kind: 'upid', key: '8'}})], 1, 'mismatch'));
    expect(mismatch.segments![0].checks[2]).toMatchObject({status: 'contradicted'});
  });
  it('never treats cpu number alone as a machine-independent identity', async () => {
    const {handle} = fixture({fields: {begin: field, finish: {...field, timeRole: 'end'},
      device_id: {origin: field.origin, identityRole: 'cpu'}}});
    const result = await proposeSceneTimeline(handle, proposal([segment('s', {object: {kind: 'cpu', key: '7'}})]));
    expect(result.segments![0].checks[2]).toMatchObject({status: 'unknown'});
  });

});

describe('scene proposal change groups', () => {
  const missing = {evidenceRefId: 'missing-ref', rowIndex: 0};
  const ids = (result: Awaited<ReturnType<typeof proposeSceneTimeline>>) => result.segments!.map(item => item.segment.id).sort();

  it('commits independent groups and names every failing reference of the rejected group at once', async () => {
    const {handle} = fixture();
    const result = await proposeSceneTimeline(handle, proposal([segment('good'),
      segment('bad', {evidenceRefs: [missing, {evidenceRefId: 'also-missing', rowIndex: 0}]})]));
    expect(result).toMatchObject({accepted: true, revision: 1});
    expect(ids(result)).toEqual(['good']);
    expect(result.rejectedGroups).toEqual([expect.objectContaining({segmentIds: ['bad'], segmentIndices: [1]})]);
    expect(result.rejectedGroups![0].diagnostics.map(item => item.referenceIndex)).toEqual([0, 1]);
    expect(result.rejectedGroups![0].diagnostics[0].detail).toContain('evidence_not_retained');
    expect(sceneRunState(handle).pacing.committedSegments).toBe(1);
  });
  it('rejects a fingerprint-only dependent together with the change it reaches', async () => {
    const {handle} = fixture();
    await proposeSceneTimeline(handle, proposal([segment('x'), segment('u', {dependencies: ['x']})]));
    const result = await proposeSceneTimeline(handle, proposal([segment('x', {userAction: 'Revised', evidenceRefs: [missing]}),
      segment('n', {dependencies: ['u']}), segment('free')], 1, 'second'));
    expect(ids(result)).toEqual(['free', 'u', 'x']);
    expect(result.segments!.find(item => item.segment.id === 'x')!.segment.userAction).toBe('Observed touch movement');
    expect([...result.rejectedGroups![0].segmentIds].sort()).toEqual(['n', 'x']);
  });
  it('keeps a cross-group cycle inside one rejected group', async () => {
    const {handle} = fixture();
    await proposeSceneTimeline(handle, proposal([segment('x'), segment('u', {dependencies: ['x']}),
      segment('y'), segment('v', {dependencies: ['y']})]));
    const result = await proposeSceneTimeline(handle, proposal([segment('x', {dependencies: ['v']}),
      segment('y', {dependencies: ['u']}), segment('free')], 1, 'cycle'));
    expect(ids(result)).toEqual(['free', 'u', 'v', 'x', 'y']);
    expect(result.rejectedGroups).toHaveLength(1);
    expect(result.rejectedGroups![0].diagnostics.some(item => item.code === 'dependency_cycle')).toBe(true);
    expect(result.segments!.find(item => item.segment.id === 'x')!.segment.dependencies).toEqual([]);
  });
  it('rejects a whole split when one child fails and keeps the parent', async () => {
    const {handle} = fixture();
    await proposeSceneTimeline(handle, proposal([segment('parent')]));
    const result = await proposeSceneTimeline(handle, proposal([segment('left', {supersedes: ['parent']}),
      segment('right', {supersedes: ['parent'], evidenceRefs: [missing]})], 1, 'split'));
    expect(result.accepted).toBe(false);
    expect([...sceneRunState(handle).segments.keys()]).toEqual(['parent']);
    expect([...result.rejectedGroups![0].segmentIds].sort()).toEqual(['left', 'right']);
  });
  it('applies a removal and a supersede of the same parent together', async () => {
    const {handle} = fixture();
    await proposeSceneTimeline(handle, proposal([segment('parent')]));
    const result = await proposeSceneTimeline(handle, {...proposal([segment('child', {supersedes: ['parent']})], 1, 'replace'),
      removeSegmentIds: ['parent']});
    expect(ids(result)).toEqual(['child']);
  });
  it('rejects a supersede together with a new segment that still depends on the parent', async () => {
    const {handle} = fixture();
    await proposeSceneTimeline(handle, proposal([segment('parent')]));
    const result = await proposeSceneTimeline(handle, proposal([segment('child', {supersedes: ['parent']}),
      segment('reader', {dependencies: ['parent']}), segment('free')], 1, 'dangling'));
    expect(ids(result)).toEqual(['free', 'parent']);
    expect([...result.rejectedGroups![0].segmentIds].sort()).toEqual(['child', 'reader']);
  });
  it('does not chain independent segments through a stable shared context', async () => {
    const {handle} = fixture();
    await proposeSceneTimeline(handle, proposal([segment('context')]));
    const result = await proposeSceneTimeline(handle, proposal([segment('a', {dependencies: ['context']}),
      segment('b', {dependencies: ['context'], evidenceRefs: [missing]})], 1, 'shared'));
    expect(ids(result)).toEqual(['a', 'context']);
    expect(result.rejectedGroups![0].segmentIds).toEqual(['b']);
  });
  it('keeps the previous revision of a segment whose evidence was evicted while other groups commit', async () => {
    const old = process.env[EVIDENCE_RETENTION_CELLS_ENV];
    process.env[EVIDENCE_RETENTION_CELLS_ENV] = '3';
    try {
      const {handle, add} = fixture();
      await proposeSceneTimeline(handle, proposal());
      add('new');
      const result = await proposeSceneTimeline(handle, proposal([segment('s', {userAction: 'Changed story'}),
        segment('t', {evidenceRefs: [{evidenceRefId: 'new', rowIndex: 0}]})], 1, 'mixed'));
      expect(ids(result)).toEqual(['s', 't']);
      expect(result.segments!.find(item => item.segment.id === 's')!.segment.userAction).toBe('Observed touch movement');
      expect(result.rejectedGroups![0]).toMatchObject({segmentIds: ['s']});
      expect(result.rejectedGroups![0].diagnostics[0].detail).toContain('evicted');
    } finally {if (old === undefined) delete process.env[EVIDENCE_RETENTION_CELLS_ENV]; else process.env[EVIDENCE_RETENTION_CELLS_ENV] = old;}
  });
  it('checks segment capacity on the map that would actually commit', async () => {
    const {handle} = fixture({limits: {maxSegments: 2}});
    await proposeSceneTimeline(handle, proposal([segment('x'), segment('u', {dependencies: ['x']})]));
    const result = await proposeSceneTimeline(handle, {...proposal([segment('n')], 1, 'capacity'), removeSegmentIds: ['x']});
    expect(result).toMatchObject({accepted: false, diagnostics: [{code: 'scene_candidate_budget_exhausted'}]});
    expect([...sceneRunState(handle).segments.keys()]).toEqual(['x', 'u']);
  });
  it('replays a committed partial result before cumulative budgets are checked', async () => {
    const {handle} = fixture({limits: {maxRunCandidates: 2}});
    const request = proposal([segment('good'), segment('bad', {evidenceRefs: [missing]})]);
    const first = await proposeSceneTimeline(handle, request);
    expect(first.accepted).toBe(true);
    expect(await proposeSceneTimeline(handle, request)).toBe(first);
  });
  it('treats explicit nulls and blank identifiers as absent without defaulting required fields', async () => {
    const {handle} = fixture();
    const result = await proposeSceneTimeline(handle, proposal([{...segment('n'), dependencies: null,
      object: {kind: 'input_device', key: '7', machineId: null},
      evidenceRefs: [{evidenceRefId: 'ev', artifactId: '', sourceToolCallId: null, rowIndex: 0, column: null}],
      boundaries: {start: {source: 'evidence', evidenceIndex: 0, column: 'begin'}, end: {source: 'inferred', column: ' '}},
    } as unknown as SceneTimelineSegment]));
    expect(result.accepted).toBe(true);
    const missingAction = await proposeSceneTimeline(handle, proposal([{...segment('m'), userAction: null} as unknown as SceneTimelineSegment], 1, 'required'));
    expect(missingAction).toMatchObject({accepted: false, rejectedGroups: [{segmentIds: ['m'],
      diagnostics: [expect.objectContaining({code: 'invalid_segment'})]}]});
    expect(sceneProposalActionRequired(missingAction)).toBe('repair_scene_proposal');
    const nullValue = await proposeSceneTimeline(handle, proposal([segment('v', {evidenceRefs: [{evidenceRefId: 'ev', rowIndex: 0,
      column: 'begin', value: null}]})], 1, 'null-value'));
    expect(nullValue.rejectedGroups![0].diagnostics[0]).toMatchObject({code: 'evidence_value_mismatch'});
  });
  it('accepts a numeric cell quoted as its exact decimal string only', async () => {
    const {handle} = fixture({values: [123, 456]});
    const cite = (value: unknown) => segment('s', {startNs: '123', endNs: '456',
      evidenceRefs: [{evidenceRefId: 'ev', rowIndex: 0, column: 'begin', value: value as string}]});
    const result = await proposeSceneTimeline(handle, proposal([cite('123')]));
    expect(result.accepted).toBe(true);
    expect(result.segments![0].checks.slice(0, 2).map(check => check.status)).toEqual(['passed', 'passed']);
    expect((await proposeSceneTimeline(handle, proposal([cite('124')], 1, 'different'))).rejectedGroups![0].diagnostics[0])
      .toMatchObject({code: 'evidence_value_mismatch', detail: 'column: begin; captured type: number'});
    // The claim verifier's exact-number rule: equal decimal forms denote the same cell.
    expect(sceneCellValueMatches(123, '0123')).toBe(true);
    expect(sceneCellValueMatches(123, '1.23e2')).toBe(true);
    expect(sceneCellValueMatches(1.5, '1.50')).toBe(true);
    expect(sceneCellValueMatches(2 ** 53 + 2, String(2 ** 53 + 2))).toBe(false);
    expect(sceneCellValueMatches(true, 'true')).toBe(false);
    expect(sceneCellValueMatches(0, '')).toBe(false);
  });
  it('classifies only actionable rejections as policy refusals', () => {
    const rejected = (code: string) => ({accepted: false, revision: 0, diagnostics: [{code}]});
    expect(sceneProposalActionRequired(rejected('stale_base_revision'))).toBe('repair_scene_proposal');
    expect(sceneProposalActionRequired(rejected('scene_revision_budget_exhausted'))).toBe('deliver_with_last_scene_revision');
    expect(sceneProposalActionRequired(rejected('scene_evidence_read_failed'))).toBeUndefined();
    expect(sceneProposalActionRequired({accepted: true, revision: 1, diagnostics: []})).toBeUndefined();
  });
});
