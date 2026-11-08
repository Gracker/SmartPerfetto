// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it, jest} from '@jest/globals';
import * as secretPatterns from '../../services/security/secretPatterns';
import {
  RUN_SUPPLEMENT_MAX_PER_RUN,
  RunSupplementChannel,
  type RunSupplementClassifier,
  type RunSupplementDecision,
  type RunSupplementUpdate,
} from '../runSupplementChannel';

const inPlace = async (): Promise<RunSupplementDecision> => ({disposition: 'in_place'});
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

function target() {
  const steered: Array<{id: string; sequence: number; text: string}> = [];
  const clear = jest.fn();
  return {steered, clear, steer: (delivery: {id: string; sequence: number; text: string}) => { steered.push(delivery); }};
}

function channel(onUpdate?: (update: RunSupplementUpdate) => void) {
  return new RunSupplementChannel({runId: 'run-1', onUpdate});
}

describe('RunSupplementChannel', () => {
  it('moves through classifying -> queued -> delivered and records the carrying request', async () => {
    const instance = channel();
    instance.bindClassifier(inPlace);
    const steer = target();
    instance.bindSteerTarget(steer);
    const submitted = instance.submit({idempotencyKey: 'a', text: 'look at the binder'});
    expect(submitted).toMatchObject({status: 'accepted', receipt: {state: 'classifying', sequence: 1}});
    await flush();
    expect(instance.receipts()[0]).toMatchObject({state: 'queued', disposition: 'in_place'});
    expect(steer.steered).toHaveLength(1);
    instance.markDelivered(steer.steered[0].id);
    instance.assignRequestIndex(3);
    expect(instance.receipts()[0].state).toBe('delivered');
    expect(instance.deliveredRecords({includeText: true}))
      .toEqual([{id: steer.steered[0].id, sequence: 1, deliveredRequestIndex: 3, text: 'look at the binder'}]);
  });

  it('routes restart_required and rejected verdicts without steering, and fails closed on a classifier error', async () => {
    const decisions: Array<RunSupplementDecision | Error> = [
      {disposition: 'restart_required', reason: 'scope_changed'},
      {disposition: 'rejected', reason: 'policy'},
      new Error('provider down'),
    ];
    const instance = channel();
    instance.bindClassifier(async () => {
      const next = decisions.shift()!;
      if (next instanceof Error) throw next;
      return next;
    });
    const steer = target();
    instance.bindSteerTarget(steer);
    for (const key of ['a', 'b', 'c']) instance.submit({idempotencyKey: key, text: `note ${key}`});
    await flush();
    expect(instance.receipts()).toMatchObject([
      {state: 'restart_required', reason: 'scope_changed', disposition: 'restart_required'},
      {state: 'rejected', reason: 'policy'},
      {state: 'rejected', reason: 'classification_unavailable'},
    ]);
    expect(steer.steered).toHaveLength(0);
  });

  it('replays an idempotent retry and refuses the same key with different text', async () => {
    const instance = channel();
    expect(instance.replay({idempotencyKey: 'a', text: 'same'})).toBeUndefined();
    const first = instance.submit({idempotencyKey: 'a', text: 'same'});
    const again = instance.replay({idempotencyKey: 'a', text: 'same'});
    expect(again?.status).toBe('replayed');
    expect((again as any).receipt.id).toBe((first as any).receipt.id);
    expect(instance.replay({idempotencyKey: 'a', text: 'different'})).toEqual({status: 'idempotency_conflict'});
    expect(instance.receipts()).toHaveLength(1);
  });

  it('enforces the per-run capacity', () => {
    const instance = channel();
    for (let i = 0; i < RUN_SUPPLEMENT_MAX_PER_RUN; i++) {
      expect(instance.submit({idempotencyKey: `k${i}`, text: 'x'}).status).toBe('accepted');
    }
    expect(instance.submit({idempotencyKey: 'overflow', text: 'x'})).toEqual({status: 'capacity_exceeded'});
  });

  it('classifies strictly serially and steers in submission order even when an earlier verdict is slow', async () => {
    const instance = channel();
    const resolvers: Array<(decision: RunSupplementDecision) => void> = [];
    const seen: string[] = [];
    const classifier: RunSupplementClassifier = text => {
      seen.push(text);
      return new Promise(resolve => { resolvers.push(resolve); });
    };
    instance.bindClassifier(classifier);
    const steer = target();
    instance.bindSteerTarget(steer);
    instance.submit({idempotencyKey: 'a', text: 'first'});
    instance.submit({idempotencyKey: 'b', text: 'second'});
    await flush();
    expect(seen).toEqual(['first']);
    resolvers.shift()!({disposition: 'in_place'});
    await flush();
    expect(seen).toEqual(['first', 'second']);
    resolvers.shift()!({disposition: 'in_place'});
    await flush();
    expect(steer.steered.map(item => item.text)).toEqual(['first', 'second']);
  });

  it('flushes supplements classified before the agent exists, in order, when the target binds', async () => {
    const instance = channel();
    instance.bindClassifier(inPlace);
    instance.submit({idempotencyKey: 'a', text: 'one'});
    instance.submit({idempotencyKey: 'b', text: 'two'});
    await flush();
    const steer = target();
    instance.bindSteerTarget(steer);
    expect(steer.steered.map(item => item.text)).toEqual(['one', 'two']);
  });

  it('closes monotonically: clears the queue, settles open items, ignores a late verdict and refuses new ones', async () => {
    const instance = channel();
    let releaseVerdict: (decision: RunSupplementDecision) => void = () => undefined;
    instance.bindClassifier(() => new Promise(resolve => { releaseVerdict = resolve; }));
    const steer = target();
    instance.bindSteerTarget(steer);
    instance.submit({idempotencyKey: 'a', text: 'pending verdict'});
    await flush();
    instance.closeAcquisition('window_closed');
    expect(steer.clear).toHaveBeenCalledTimes(1);
    releaseVerdict({disposition: 'in_place'});
    await flush();
    expect(instance.receipts()[0]).toMatchObject({state: 'not_applied', reason: 'window_closed'});
    expect(steer.steered).toHaveLength(0);
    expect(instance.submit({idempotencyKey: 'late', text: 'x'})).toEqual({status: 'window_closed'});
    instance.closeAcquisition('run_failed');
    expect(instance.receipts()[0].reason).toBe('window_closed');
  });

  it('terminates idempotently, settles a classifying item and still answers an exact replay', () => {
    const instance = channel();
    instance.submit({idempotencyKey: 'a', text: 'classifying forever'});
    instance.terminate('run_failed');
    instance.terminate('window_closed');
    expect(instance.receipts()[0]).toMatchObject({state: 'not_applied', reason: 'run_failed'});
    expect(instance.submit({idempotencyKey: 'new', text: 'x'})).toEqual({status: 'not_active'});
    expect(instance.replay({idempotencyKey: 'a', text: 'classifying forever'})).toMatchObject({status: 'replayed'});
    expect(instance.replay({idempotencyKey: 'a', text: 'something else'})).toEqual({status: 'idempotency_conflict'});
  });

  it('aborts the in-flight classification when the window closes', async () => {
    const instance = channel();
    let signal: AbortSignal | undefined;
    instance.bindClassifier((_text, classification) => {
      signal = classification;
      return new Promise(() => undefined);
    });
    instance.submit({idempotencyKey: 'a', text: 'note'});
    await flush();
    expect(signal?.aborted).toBe(false);
    instance.closeAcquisition('run_stopped');
    expect(signal?.aborted).toBe(true);
  });

  it('aborts the in-flight classification on terminate', async () => {
    const instance = channel();
    let signal: AbortSignal | undefined;
    instance.bindClassifier((_text, classification) => {
      signal = classification;
      return new Promise(() => undefined);
    });
    instance.submit({idempotencyKey: 'a', text: 'note'});
    await flush();
    instance.terminate('run_failed');
    expect(signal?.aborted).toBe(true);
  });

  it('drops the text and the update closure on terminate, keeping the record', async () => {
    const updates: RunSupplementUpdate[] = [];
    const instance = channel(update => updates.push(update));
    instance.bindClassifier(inPlace);
    const steer = target();
    instance.bindSteerTarget(steer);
    instance.submit({idempotencyKey: 'a', text: 'kept while live'});
    await flush();
    instance.markDelivered(steer.steered[0].id);
    expect(instance.deliveredRecords({includeText: true})[0].text).toBe('kept while live');
    instance.terminate('window_closed');
    const before = updates.length;
    expect(instance.deliveredRecords({includeText: true})).toEqual([{id: steer.steered[0].id, sequence: 1}]);
    instance.terminate('run_failed');
    expect(updates).toHaveLength(before);
    expect(JSON.stringify(instance.receipts())).not.toContain('kept while live');
  });

  it('skips redaction work for a submission the run would refuse anyway', () => {
    const redact = jest.spyOn(secretPatterns, 'redactSecrets');
    const instance = channel();
    instance.terminate('window_closed');
    redact.mockClear();
    expect(instance.submit({idempotencyKey: 'late', text: 'x'})).toEqual({status: 'not_active'});
    expect(redact).not.toHaveBeenCalled();
    redact.mockRestore();
  });

  it('redacts secrets before any consumer and reports only size and enums in updates', async () => {
    const updates: RunSupplementUpdate[] = [];
    const instance = channel(update => updates.push(update));
    const classified: string[] = [];
    instance.bindClassifier(async text => { classified.push(text); return {disposition: 'in_place'}; });
    instance.submit({idempotencyKey: 'a', text: 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789 here'});
    await flush();
    expect(classified[0]).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    expect(JSON.stringify(instance.receipts())).not.toContain('token');
    expect(JSON.stringify(updates)).not.toContain('token');
    expect(updates[0].byteLength).toBeGreaterThan(0);
    expect(Object.keys(updates[0].receipt).sort()).toEqual(['id', 'runId', 'sequence', 'state'].sort());
  });

  it('omits the text of delivered records for a private run', async () => {
    const instance = channel();
    instance.bindClassifier(inPlace);
    const steer = target();
    instance.bindSteerTarget(steer);
    instance.submit({idempotencyKey: 'a', text: 'private note'});
    await flush();
    instance.markDelivered(steer.steered[0].id);
    expect(instance.deliveredRecords({includeText: false})).toEqual([{id: steer.steered[0].id, sequence: 1}]);
  });

  it('marks unsupported runs and settles anything pending', () => {
    const instance = channel();
    instance.submit({idempotencyKey: 'a', text: 'x'});
    instance.markUnsupported();
    expect(instance.isUnsupported).toBe(true);
    expect(instance.receipts()[0]).toMatchObject({state: 'not_applied', reason: 'window_closed'});
    expect(instance.submit({idempotencyKey: 'b', text: 'y'})).toEqual({status: 'unsupported'});
  });
});
