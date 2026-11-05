// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';
import {SkillExecutor} from '../../services/skillEngine/skillExecutor';
import {ArtifactStore} from '../../agentv3/artifactStore';
import * as skillRunCore from '../../agentv3/skillRunCore';
import {beginRawSqlNativeQuery, readRawSqlNativeProvenanceSnapshot} from '../../services/evidence/rawSqlNativeProvenance';
import {AnalysisContextAuthorizationChangedError} from '../../services/resolvedAnalysisContext';
import {shouldCollectSelectedEvidenceFoundation} from '../selectedEvidenceFoundation';
import {collectSelectedEvidenceForPrompt, SCENE_EVIDENCE_MAX_BYTES} from '../sceneEntryEvidence';
import {createRuntimeEvidenceContext, resolveRuntimeEvidenceStore} from '../runtimeEvidenceContext';
import {createSelectedFoundationFixture as harness, installSelectedNativeSignerMocks,
  selectedFoundationSkill as skill} from '../../../tests/helpers/selectedEvidenceFoundationFixture';

const TRACE = 'selected-trace', RUN = 'selected-run', METRIC = 'fixture.thread.duration';
const columns = ['start', 'end', 'upid', 'utid', 'value_ns', 'status', 'coverage', 'denominator'];
const row = [10, 110, 42, 43, 80, 'observed', 100, 100];
function deferred<T>() {let resolve!: (value: T) => void; const promise = new Promise<T>(done => {resolve = done;}); return {promise, resolve};}

describe('selected evidence foundation', () => {
  beforeEach(() => {
    jest.useFakeTimers({now: 1000, doNotFake: ['nextTick', 'setImmediate']});
    installSelectedNativeSignerMocks();
  });
  afterEach(() => {jest.restoreAllMocks(); jest.useRealTimers();});

  it('seals before identity INCLUDE, preserves exact UTID/window and commits a real bound detail metric', async () => {
    const h = await harness(); const outcome = await h.run();
    expect(outcome.metric.reason).toBeUndefined();
    expect(outcome).toMatchObject({native: {status: 'captured', row: {id: 7, ts: 10, dur: 100, track_id: 9}},
      identity: {upid: 42, utid: 43, startNs: 10, endNs: 110}, metric: {status: 'committed', captureCount: 1,
        artifacts: [expect.objectContaining({metricBinding: 'present', captureRows: 'available'})]}});
    expect(h.query.mock.calls[0]).toEqual(expect.arrayContaining([expect.stringContaining('43 AS utid')]));
    expect(readRawSqlNativeProvenanceSnapshot(h.native.provenance).status).toBe('tainted');
    const view = h.store.createEvidenceReadView({ownerKey: 'owner', currentRunId: RUN,
      allowedTraces: [{traceId: TRACE, traceSide: 'current'}]});
    const ledger = view.investigationEvidence!();
    expect(ledger.records).toEqual([expect.objectContaining({metricId: METRIC, status: 'observed', upid: 42, utid: 43,
      window: {start: 10, end: 110}, value: 80})]);
    expect(ledger.issues).not.toContain('capture_tool_observation_missing');
    expect(h.recordSceneEvidence).not.toHaveBeenCalled();
    expect(h.phase.end).toHaveBeenCalledWith('ok');
  });

  it.each(['other_target', 'unknown', undefined] as const)('does no query for targetUse %s', async targetUse => {
    const h = await harness(); h.input.turnIntent = {...h.input.turnIntent, targetUse};
    expect(shouldCollectSelectedEvidenceFoundation(h.input)).toBe(false);
    expect(await collectSelectedEvidenceForPrompt(h.input)).toEqual({handled: false});
    expect(h.queryBounded).not.toHaveBeenCalled();
  });
  it.each([{dur: -1}, {dur: 0}, {dur: undefined}, {eventId: 1.5}, {ts: Number.MAX_SAFE_INTEGER},
    {nativeTable: undefined}, {source: undefined}])('rejects unsupported UI locator %j', async change => {
    const h = await harness(); h.input.selectionContext = {...h.input.selectionContext!, ...change} as any;
    expect(shouldCollectSelectedEvidenceFoundation(h.input)).toBe(false); await h.run();
    expect(h.queryBounded).not.toHaveBeenCalled();
  });
  it.each(['reference', 'empty_reference', 'pair_without_reference', 'noncanonical_trace', 'noncanonical_run',
    'existing_only', 'closed', 'no_auth', 'expired'])('does no SQL when %s', async kind => {
    const h = await harness();
    if (kind === 'reference') h.input.referenceTraceId = 'other';
    if (kind === 'empty_reference') h.input.referenceTraceId = '';
    if (kind === 'pair_without_reference') h.input.tracePairContext = {} as any;
    if (kind === 'noncanonical_trace') h.input.traceId = ` ${TRACE}`;
    if (kind === 'noncanonical_run') h.input.runId = ` ${RUN}`;
    if (kind === 'existing_only') h.input.turnIntent = {...h.input.turnIntent, evidenceAccess: 'existing_only'};
    if (kind === 'closed') h.input.canInvokeTool = () => false;
    if (kind === 'no_auth') h.input.runAuthorization = undefined;
    if (kind === 'expired') h.input.deadlineMs = Date.now();
    await h.run(); expect(h.queryBounded).not.toHaveBeenCalled(); expect(h.register).not.toHaveBeenCalled();
  });
  it.each([0, 1, 2])('rejects mismatched native id/ts/dur field %s', async index => {
    const h = await harness(); h.nativeResponse.rows[0][index]++;
    expect(await h.run()).toMatchObject({native: {status: 'failed', reason: 'selection_mismatch'}});
    expect(h.register).not.toHaveBeenCalled(); expect(h.queryBounded).toHaveBeenCalledTimes(1);
  });
  it.each([0, 2])('requires exactly one native row, not %s rows', async count => {
    const h = await harness();
    h.nativeResponse.rows = Array.from({length: count}, () => [7, 10, 100, 9]);
    expect(await h.run()).toMatchObject({native: {status: 'failed', reason: 'selection_mismatch'}});
    expect(h.register).not.toHaveBeenCalled(); expect(h.query).not.toHaveBeenCalled();
  });
  it.each(['track_absent', 'utid_zero', 'upid_absent', 'upid_zero'])('preserves native capture without guessing missing identity: %s', async mode => {
    const h = await harness(), original = h.queryBounded.getMockImplementation()!;
    h.queryBounded.mockImplementation(async (...args) => {
      const response = await original(...args);
      if (args[1].includes('FROM thread_track') && mode.startsWith('track')) response.rows = [];
      if (args[1].includes('FROM thread_track') && mode === 'utid_zero') response.rows = [[9, 0]];
      if (args[1].includes('FROM thread WHERE') && mode === 'upid_absent') response.rows = [];
      if (args[1].includes('FROM thread WHERE') && mode === 'upid_zero') response.rows = [[43, 0]];
      return response;
    });
    expect(await h.run()).toMatchObject({native: {status: 'captured'}, metric: {status: 'not_run', reason: 'identity_unresolved'}});
    expect(h.query).not.toHaveBeenCalled();
  });
  it('cannot recover authority from a copied result or a previously tainted processor', async () => {
    for (const mode of ['copy', 'taint']) {
      const h = await harness();
      if (mode === 'taint') beginRawSqlNativeQuery(h.native.provenance, 'INCLUDE PERFETTO MODULE android.frames.timeline;');
      else {const original = h.queryBounded.getMockImplementation()!;
        h.queryBounded.mockImplementation(async (...args) => ({...await original(...args)}));}
      expect(await h.run()).toMatchObject({native: {status: 'failed', reason: 'native_unavailable'}});
      expect(h.register).not.toHaveBeenCalled();
    }
  });
  it('retains native truth when identity fails, unless an explicit selector still needs verification', async () => {
    for (const explicit of [false, true]) {
      const h = await harness(); if (explicit) h.input.userPackageName = 'app.selected';
      h.resolveIdentity.mockImplementation(async () => ({status: 'unresolved', upids: [], candidates: [], confidenceScore: 0, evidenceSources: [], warnings: []}));
      const result = await h.run();
      expect(result.native.status).toBe(explicit ? 'not_run' : 'captured');
      expect(result.metric).toMatchObject({status: 'not_run', reason: 'identity_unresolved'});
      expect(h.register).toHaveBeenCalledTimes(explicit ? 0 : 1); expect(h.query).not.toHaveBeenCalled();
    }
  });
  it('checks the original explicit selector before any store registration', async () => {
    const h = await harness(); h.input.userPackageName = 'app.other';
    expect(await h.run()).toMatchObject({native: {status: 'not_run'}, metric: {reason: 'identity_unresolved'}});
    expect(h.register).not.toHaveBeenCalled(); expect(h.query).not.toHaveBeenCalled();
    const allowed = await harness(); allowed.input.userPackageName = 'app.selected';
    expect(await allowed.run()).toMatchObject({native: {status: 'captured'}, metric: {status: 'committed'}});
  });
  it.each(['absent', 'ambiguous', 'executor_absent'])('does not invent a producer or widen executor scope: %s', async mode => {
    const h = await harness();
    if (mode === 'absent') h.definitions.clear();
    if (mode === 'ambiguous') h.definitions.set('second', {...skill(), name: 'second'});
    if (mode === 'executor_absent') h.input.skillExecutor = new SkillExecutor({query: h.query} as any);
    const result = await h.run();
    expect(result.native.status).toBe('captured'); expect(result.metric.status).toBe('not_run');
    expect(result.metric.reason).toBe(mode === 'absent' ? 'producer_unavailable' : mode === 'ambiguous' ? 'producer_ambiguous' : 'identity_unresolved');
    expect(h.query).not.toHaveBeenCalled();
  });
  it('rejects changed prepared UTID rather than gathering sibling-thread data', async () => {
    const h = await harness(); h.input.userPackageName = 'app.selected';
    const actual = skillRunCore.prepareSkillRun;
    jest.spyOn(skillRunCore, 'prepareSkillRun').mockImplementation(async (...args) => {
      const prepared = await actual(...args);
      if (prepared.status === 'ready') prepared.prepared.effectiveParams.utid = '44';
      return prepared;
    });
    expect(await h.run()).toMatchObject({native: {status: 'not_run'}, metric: {reason: 'binding_unsupported'}});
    expect(h.query).not.toHaveBeenCalled(); expect(h.register).not.toHaveBeenCalled();
  });
  it('refuses an executor missing the exact fragment even when the pinned catalog has it', async () => {
    const h = await harness(); h.input.userPackageName = 'app.selected';
    const producer = h.definitions.values().next().value!;
    producer.sql_fragments = ['selected_cte'];
    const fragments = h.input.skillRegistry.getFragmentCache(); fragments.set('selected_cte', 'selected_cte AS (SELECT 1 AS value)');
    h.executor.setFragmentRegistry(new Map());
    expect(await h.run()).toMatchObject({native: {status: 'not_run'}, metric: {status: 'not_run', reason: 'identity_unresolved'}});
    expect(h.register).not.toHaveBeenCalled(); expect(h.query).not.toHaveBeenCalled();
  });
  it('retains native captured when the Skill fails, without claiming a metric commit', async () => {
    const h = await harness(); h.query.mockRejectedValue(new Error('fixture query failed'));
    const result = await h.run();
    expect(result.native.status).toBe('captured'); expect(result.metric.status).toBe('failed');
    expect(result.metric.captureCount).toBe(0);
  });
  it('records an executor exception as a failed started producer while retaining native capture', async () => {
    const h = await harness();
    jest.spyOn(h.executor, 'execute').mockRejectedValueOnce(new Error('executor failed after admission'));
    const observations = jest.spyOn(h.store, 'observeInvestigationTool');
    expect(await h.run()).toMatchObject({native: {status: 'captured'},
      metric: {status: 'failed', reason: 'failed', artifactCount: 0, captureCount: 0}});
    expect(observations.mock.calls.map(([event]) => event.phase)).toEqual(['started', 'failed']);
    expect(h.register).toHaveBeenCalledTimes(1); expect(h.store.size).toBe(0);
    expect(h.store.createEvidenceReadView({ownerKey: 'owner', currentRunId: RUN,
      allowedTraces: [{traceId: TRACE, traceSide: 'current'}]}).investigationEvidence!().records).toEqual([]);
  });
  it('preserves an explicit partial Skill outcome independently of the native capture', async () => {
    const h = await harness(), actual = h.executor.execute.bind(h.executor);
    jest.spyOn(h.executor, 'execute').mockImplementation(async (...args) => ({...await actual(...args), partial: true}));
    expect(await h.run()).toMatchObject({native: {status: 'captured'}, metric: {status: 'partial', captureCount: 1}});
  });
  it('does not turn a copied Skill result into a private metric binding or ledger proof', async () => {
    const h = await harness(); const actual = h.executor.execute.bind(h.executor);
    jest.spyOn(h.executor, 'execute').mockImplementation(async (...args) => {
      const result = await actual(...args);
      return {...result, displayResults: result.displayResults?.map(display => ({...display}))};
    });
    const result = await h.run();
    expect(result.native.status).toBe('captured');
    expect(result.metric.status).toBe('committed'); // Execution alone is not evidence authority.
    // The core registers an unavailable witness for an unmapped display, not a data-bearing capture.
    expect(result.metric.captureCount).toBe(1);
    expect(result.metric.artifacts).toEqual([expect.objectContaining({metricBinding: 'unknown', captureRows: 'unavailable'})]);
    expect(h.store.createEvidenceReadView({ownerKey: 'owner', currentRunId: RUN,
      allowedTraces: [{traceId: TRACE, traceSide: 'current'}]}).investigationEvidence!().records).toEqual([]);
  });
  it('does not reuse the first run native capture after this processor has been tainted', async () => {
    const h = await harness(); expect((await h.run()).native.status).toBe('captured');
    h.input.runId = 'successor-run';
    expect(await h.run()).toMatchObject({native: {status: 'failed', reason: 'native_unavailable'}, metric: {status: 'not_run'}});
    expect(h.register).toHaveBeenCalledTimes(1);
  });
  it('awaits a pending query after timeout and admits no later work; owner remains alive', async () => {
    const h = await harness(), latch = deferred<typeof h.nativeResponse>();
    h.queryBounded.mockImplementationOnce(() => latch.promise);
    let settled = false; const running = h.run().then(value => {settled = true; return value;});
    await jest.advanceTimersByTimeAsync(20_001);
    expect(settled).toBe(false); expect(h.lease.signal.aborted).toBe(false);
    latch.resolve(h.nativeResponse);
    expect(await running).toMatchObject({native: {status: 'not_run', reason: 'timeout'}, metric: {reason: 'timeout'}});
    expect(h.queryBounded).toHaveBeenCalledTimes(1); expect(h.register).not.toHaveBeenCalled();
  });
  it('does not commit a late Skill result after cancellation', async () => {
    const h = await harness(), latch = deferred<{columns: string[]; rows: typeof row[]; durationMs: number}>();
    const started = deferred<void>(); h.query.mockImplementation(async () => {started.resolve(); return latch.promise;});
    const running = h.run();
    await Promise.race([started.promise, running.then(result => {throw new Error(`Skill did not start: ${JSON.stringify(result.metric)}`);})]);
    h.lease.abort(); latch.resolve({columns, rows: [row], durationMs: 1});
    expect(await running).toMatchObject({native: {status: 'captured'}, metric: {status: 'failed', reason: 'cancelled', captureCount: 0}});
    expect(h.store.size).toBe(0);
  });
  it('does not register a native result when cancellation arrives at query return', async () => {
    const h = await harness(), actual = h.queryBounded.getMockImplementation()!;
    h.queryBounded.mockImplementationOnce(async (...args) => {const value = await actual(...args); h.lease.abort(); return value;});
    expect(await h.run()).toMatchObject({native: {status: 'not_run', reason: 'cancelled'}});
    expect(h.register).not.toHaveBeenCalled(); expect(h.queryBounded).toHaveBeenCalledTimes(1);
  });
  it('holds an expired identity lookup until it drains, without registering an explicit target', async () => {
    const h = await harness(); h.input.userPackageName = 'app.selected';
    const actual = h.resolveIdentity.getMockImplementation()!, started = deferred<void>(), release = deferred<void>();
    h.resolveIdentity.mockImplementation(async (...args: unknown[]) => {started.resolve(); await release.promise; return actual(...args);});
    let settled = false; const running = h.run().then(value => {settled = true; return value;});
    await Promise.race([started.promise, running.then(() => {throw new Error('identity did not start');})]);
    await jest.advanceTimersByTimeAsync(20_001); expect(settled).toBe(false);
    expect(h.register).not.toHaveBeenCalled(); release.resolve();
    expect(await running).toMatchObject({native: {status: 'not_run'}, metric: {reason: 'timeout'}, durationMs: 20_001});
    expect(h.query).not.toHaveBeenCalled(); expect(h.phase.end).toHaveBeenCalledWith('cancelled');
  });
  it('fences authorization after identity resolution before any explicit-target registration', async () => {
    const h = await harness(); h.input.userPackageName = 'app.selected';
    const actual = h.resolveIdentity.getMockImplementation()!, denied = new AnalysisContextAuthorizationChangedError();
    h.resolveIdentity.mockImplementation(async (...args: unknown[]) => {
      const value = await actual(...args); h.authorization.assertCurrentInTurn.mockImplementation(() => {throw denied;}); return value;
    });
    await expect(h.run()).rejects.toBe(denied);
    expect(h.authorization.settled).toHaveBeenCalled(); expect(h.register).not.toHaveBeenCalled(); expect(h.query).not.toHaveBeenCalled();
  });
  it.each(['owner_abort', 'authorization_revoked'] as const)('keeps the primary failure when an issued facade rejects late observations: %s', async reason => {
    const h = await harness();
    const options = {tenantId: 'selected-tenant', workspaceId: 'selected-workspace', userId: 'selected-user'};
    const context = createRuntimeEvidenceContext({logicalSessionId: 'selected-conversation', traceId: TRACE, options});
    let facadeRevoked = false;
    const binding = context.bind(options, {runId: RUN, runtimeSessionId: 'selected-session', signal: h.lease.signal,
      assertAuthorized: () => {if (facadeRevoked) throw new Error('facade refuses revoked run');}});
    const facade = resolveRuntimeEvidenceStore(binding.options, {sessionId: 'selected-session', traceId: TRACE},
      () => {throw new Error('issued facade must not fall back');});
    h.input.artifactStore = facade;
    const stored = jest.spyOn(ArtifactStore.prototype, 'store');
    const captured = jest.spyOn(ArtifactStore.prototype, 'registerStandaloneEvidenceCapture');
    const observed = jest.spyOn(ArtifactStore.prototype, 'observeInvestigationTool');
    const started = deferred<void>(), release = deferred<void>();
    h.query.mockImplementation(async () => {started.resolve(); await release.promise; return {columns, rows: [row], durationMs: 1};});
    let settled = false;
    const operation = h.run();
    const completion = operation.then(value => {settled = true; return {value};}, error => {settled = true; return {error};});
    const primary = new AnalysisContextAuthorizationChangedError();
    try {
      await Promise.race([started.promise, completion.then(() => {throw new Error('metric did not start');})]);
      if (reason === 'owner_abort') h.lease.abort();
      else {
        facadeRevoked = true;
        h.authorization.assertCurrentInTurn.mockImplementation(() => {throw primary;});
      }
      await Promise.resolve(); expect(settled).toBe(false);
      release.resolve(); const result = await completion;
      if (reason === 'authorization_revoked') expect(result).toEqual({error: primary});
      else expect(result).toMatchObject({value: {native: {status: 'captured'}, metric: {status: 'failed', reason: 'cancelled', captureCount: 0}}});
      expect(h.phase.end).toHaveBeenCalledWith('cancelled');
      expect(stored).not.toHaveBeenCalled(); expect(captured).toHaveBeenCalledTimes(1);
      // The real facade continues to refuse every write. No observation bypass was added.
      expect(observed.mock.calls.map(([event]) => event.phase)).toEqual(['started']);
      expect(() => facade.observeInvestigationTool({phase: 'failed', toolCallId: 'late', toolName: 'selected_evidence_foundation',
        params: {}, extra: {}, error: new Error('late observation')}, RUN)).toThrow();
    } finally {release.resolve(); await completion; binding.release(); context.dispose();}
  });
  it('retains the committed metric when owner cancellation makes the completed observation unwritable', async () => {
    const h = await harness();
    const options = {tenantId: 'selected-tenant', workspaceId: 'selected-workspace', userId: 'selected-user'};
    const context = createRuntimeEvidenceContext({logicalSessionId: 'selected-conversation', traceId: TRACE, options});
    const binding = context.bind(options, {runId: RUN, runtimeSessionId: 'selected-session', signal: h.lease.signal, assertAuthorized() {}});
    h.input.artifactStore = resolveRuntimeEvidenceStore(binding.options, {sessionId: 'selected-session', traceId: TRACE},
      () => {throw new Error('issued facade must not fall back');});
    const actual = skillRunCore.executePreparedSkillRun;
    jest.spyOn(skillRunCore, 'executePreparedSkillRun').mockImplementation(async (...args) => {
      const outcome = await actual(...args);
      expect(outcome.status).toBe('committed');
      // The core's synchronous commit was authorized. Only the subsequent observation loses ownership.
      h.lease.abort();
      return outcome;
    });
    try {
      const result = await h.run();
      expect(result).toMatchObject({native: {status: 'captured'}, metric: {status: 'committed', artifactCount: 1, captureCount: 1}});
      expect(h.phase.end).toHaveBeenCalledWith('cancelled');
      binding.release();
      const next = context.bind(options, {runId: 'next-run', runtimeSessionId: 'next-session', signal: new AbortController().signal, assertAuthorized() {}});
      try {
        const store = resolveRuntimeEvidenceStore(next.options, {sessionId: 'next-session', traceId: TRACE}, () => {throw new Error('no fallback');});
        const view = store.createEvidenceReadView({ownerKey: 'next-owner', allowedTraces: [{traceId: TRACE, traceSide: 'current'}]});
        expect(await view.resolveReferences([{key: 'metric', reference: {artifactId: 'art-1', rowIndex: 0, column: 'value_ns'}, requiredColumns: ['value_ns']}]))
          .toMatchObject([{status: 'resolved', row: {value_ns: 80}, record: {originRunId: RUN}}]);
        if (result.native.status !== 'captured') throw new Error('original native capture missing');
        expect(await view.resolveReferences([{key: 'native', reference: {evidenceRefId: result.native.evidenceRefId,
          rowIndex: 0, column: 'dur'}, requiredColumns: ['dur']}]))
          .toMatchObject([{status: 'resolved', row: {dur: 100}, record: {originRunId: RUN, fields: {dur: {unit: 'ns'}}}}]);
        expect(view.investigationEvidence!().records).toEqual([expect.objectContaining({originRunId: RUN, origin: 'reused', status: 'unknown'})]);
        expect(view.investigationEvidence!().issues).toContain('capture_tool_observation_missing');
      } finally {next.release();}
    } finally {binding.release(); context.dispose();}
  });
  it('awaits actual authorization cleanup and propagates revocation without a registration', async () => {
    const h = await harness(), cleanup = deferred<void>();
    const denied = new AnalysisContextAuthorizationChangedError();
    h.authorization.assertCurrentInTurn.mockImplementation(() => {throw denied;});
    h.authorization.settled.mockImplementation(() => cleanup.promise);
    let settled = false; const running = h.run().catch(error => {settled = true; return error;});
    await jest.advanceTimersByTimeAsync(20_001); expect(settled).toBe(false);
    cleanup.resolve(); expect(await running).toBe(denied); expect(h.register).not.toHaveBeenCalled();
  });
  it('projects independent states and exact detail cells within the existing prompt budget', async () => {
    const h = await harness(); const result = await collectSelectedEvidenceForPrompt(h.input);
    expect(result.handled).toBe(true);
    if (!result.handled || !result.data || !('kind' in result.data) || result.data.kind !== 'selected_foundation') throw new Error('selected data expected');
    expect(result.data.native.status).toBe('captured'); expect(result.data.metric.status).toBe('committed');
    expect(Buffer.byteLength(JSON.stringify(result.data))).toBeLessThanOrEqual(SCENE_EVIDENCE_MAX_BYTES);
    expect(result.data.cells?.selected.some(cell => cell[2] === 'value_ns' && cell[3] === 80 && cell[4] === 'ns')).toBe(true);
  });
});
