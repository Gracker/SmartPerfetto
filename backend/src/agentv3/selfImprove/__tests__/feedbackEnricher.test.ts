// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, it, expect } from '@jest/globals';
import {
  validateFeedbackInput,
  enrichFeedbackEntry,
  type SessionLookup,
} from '../feedbackEnricher';

describe('validateFeedbackInput', () => {
  it('accepts a minimal valid body', () => {
    const result = validateFeedbackInput({ rating: 'positive' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.rating).toBe('positive');
    }
  });

  it('rejects non-object body', () => {
    expect(validateFeedbackInput(null).ok).toBe(false);
    expect(validateFeedbackInput('rating').ok).toBe(false);
    expect(validateFeedbackInput([]).ok).toBe(false);
  });

  it('rejects invalid rating values', () => {
    const result = validateFeedbackInput({ rating: 'maybe' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/rating/);
  });

  it('rejects non-string comment', () => {
    const result = validateFeedbackInput({ rating: 'positive', comment: 42 });
    expect(result.ok).toBe(false);
  });

  it('truncates over-long comment to 500 chars', () => {
    const long = 'a'.repeat(1000);
    const result = validateFeedbackInput({ rating: 'positive', comment: long });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.comment?.length).toBe(500);
  });

  it('rejects negative or non-finite turnIndex', () => {
    expect(validateFeedbackInput({ rating: 'positive', turnIndex: -1 }).ok).toBe(false);
    expect(validateFeedbackInput({ rating: 'positive', turnIndex: NaN }).ok).toBe(false);
    expect(validateFeedbackInput({ rating: 'positive', turnIndex: Infinity }).ok).toBe(false);
  });

  it('floors fractional turnIndex', () => {
    const result = validateFeedbackInput({ rating: 'positive', turnIndex: 3.7 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.turnIndex).toBe(3);
  });

  it('rejects unsupported schemaVersion', () => {
    expect(validateFeedbackInput({ rating: 'positive', schemaVersion: 99 }).ok).toBe(false);
    expect(validateFeedbackInput({ rating: 'positive', schemaVersion: 'v1' }).ok).toBe(false);
  });

  it('accepts schemaVersion=1', () => {
    const result = validateFeedbackInput({ rating: 'positive', schemaVersion: 1 });
    expect(result.ok).toBe(true);
  });

  it('accepts and truncates the full additive metadata block', () => {
    const result = validateFeedbackInput({
      rating: 'negative',
      comment: 'bad analysis',
      turnIndex: 2,
      traceId: 't'.repeat(500),
      sceneType: 'scrolling',
      architecture: 'flutter_surfaceview',
      packageName: 'com.tencent.mm',
      findingIds: ['f1', 'f2', 'f3'],
      patternId: 'pattern_abc',
      caseCandidateId: 'cand-feedback-1',
      caseCandidateSurfacedAt: 1710000000000,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.traceId?.length).toBe(200); // truncated
      expect(result.value.sceneType).toBe('scrolling');
      expect(result.value.architecture).toBe('flutter_surfaceview');
      expect(result.value.packageName).toBe('com.tencent.mm');
      expect(result.value.findingIds).toEqual(['f1', 'f2', 'f3']);
      expect(result.value.patternId).toBe('pattern_abc');
      expect(result.value.caseCandidateId).toBe('cand-feedback-1');
      expect(result.value.caseCandidateSurfacedAt).toBe(1710000000000);
    }
  });

  it('caps findingIds array length at 20', () => {
    const ids = Array.from({ length: 50 }, (_, i) => `f${i}`);
    const result = validateFeedbackInput({ rating: 'positive', findingIds: ids });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.findingIds?.length).toBe(20);
  });

  it('rejects non-array findingIds', () => {
    const result = validateFeedbackInput({ rating: 'positive', findingIds: 'f1' });
    expect(result.ok).toBe(false);
  });

  it('rejects non-string entries inside findingIds', () => {
    const result = validateFeedbackInput({ rating: 'positive', findingIds: ['f1', 42, 'f3'] });
    expect(result.ok).toBe(false);
  });

  it('truncates each findingId to 100 chars', () => {
    const result = validateFeedbackInput({
      rating: 'positive',
      findingIds: ['x'.repeat(200)],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.findingIds?.[0].length).toBe(100);
  });

  it('accepts a closed replaced-event payload', () => {
    const result = validateFeedbackInput({
      eventKind: 'replaced',
      feedbackId: 'feedback-1',
      supersedesEventId: 'event-1',
      idempotencyKey: 'request-2',
      runId: 'run-1',
      rating: 'negative',
      dimensions: ['wrong_conclusion', 'insufficient_evidence'],
      targetKind: 'finding',
      targetId: 'finding-1',
      source: 'api',
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        eventKind: 'replaced',
        feedbackId: 'feedback-1',
        supersedesEventId: 'event-1',
        dimensions: ['wrong_conclusion', 'insufficient_evidence'],
      },
    });
  });

  it('requires a chain head for replacement and retraction', () => {
    expect(validateFeedbackInput({
      eventKind: 'replaced',
      rating: 'negative',
    })).toMatchObject({ok: false});
    expect(validateFeedbackInput({
      eventKind: 'retracted',
      feedbackId: 'feedback-1',
    })).toMatchObject({ok: false});
  });

  it('forbids rating payload on a retraction', () => {
    expect(validateFeedbackInput({
      eventKind: 'retracted',
      feedbackId: 'feedback-1',
      supersedesEventId: 'event-1',
      rating: 'positive',
    })).toMatchObject({
      ok: false,
      error: expect.stringContaining('must not include rating'),
    });
  });

  it('rejects unknown dimensions, targets, sources, and event kinds', () => {
    expect(validateFeedbackInput({
      rating: 'positive',
      dimensions: ['unknown'],
    }).ok).toBe(false);
    expect(validateFeedbackInput({
      rating: 'positive',
      targetKind: 'unknown',
    }).ok).toBe(false);
    expect(validateFeedbackInput({
      rating: 'positive',
      source: 'unknown',
    }).ok).toBe(false);
    expect(validateFeedbackInput({
      rating: 'positive',
      eventKind: 'unknown',
    }).ok).toBe(false);
  });

  it('keeps created feedback identity server-owned', () => {
    expect(validateFeedbackInput({
      rating: 'positive',
      feedbackId: 'client-selected-id',
    })).toEqual({
      ok: false,
      error: 'created feedbackId is server-assigned',
    });
  });

  it('rejects dimensions whose polarity disagrees with the rating', () => {
    expect(validateFeedbackInput({
      rating: 'positive',
      dimensions: ['wrong_conclusion'],
    })).toEqual({
      ok: false,
      error: 'dimensions must match positive feedback',
    });
    expect(validateFeedbackInput({
      rating: 'negative',
      dimensions: ['actionable'],
    })).toEqual({
      ok: false,
      error: 'dimensions must match negative feedback',
    });
  });
});

describe('enrichFeedbackEntry', () => {
  const fixedNow = new Date('2026-04-26T12:00:00Z');

  it('serializes minimal input without session lookup', () => {
    const result = validateFeedbackInput({ rating: 'positive' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const entry = enrichFeedbackEntry('sess_123', result.value, null, fixedNow);
    expect(entry.schemaVersion).toBe(1);
    expect(entry.sessionId).toBe('sess_123');
    expect(entry.rating).toBe('positive');
    expect(entry.timestamp).toBe('2026-04-26T12:00:00.000Z');
    expect(entry.enrichedFromSession).toBe(false);
    expect(entry.traceId).toBeUndefined();
  });

  it('reverse-looks up traceId from session when client did not supply', () => {
    const result = validateFeedbackInput({ rating: 'positive' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const session: SessionLookup = { traceId: 'trace_999' };
    const entry = enrichFeedbackEntry('sess_1', result.value, session, fixedNow);
    expect(entry.traceId).toBe('trace_999');
    expect(entry.enrichedFromSession).toBe(true);
  });

  it('prefers client-provided traceId over session traceId', () => {
    const result = validateFeedbackInput({ rating: 'positive', traceId: 'client_trace' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const session: SessionLookup = { traceId: 'session_trace' };
    const entry = enrichFeedbackEntry('sess_1', result.value, session, fixedNow);
    expect(entry.traceId).toBe('client_trace');
    // referenceTraceId is null → enrichedFromSession stays false
    expect(entry.enrichedFromSession).toBe(false);
  });

  it('attaches referenceTraceId from session when present', () => {
    const result = validateFeedbackInput({ rating: 'negative' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const session: SessionLookup = { traceId: 't1', referenceTraceId: 't2' };
    const entry = enrichFeedbackEntry('sess_1', result.value, session, fixedNow);
    expect(entry.traceId).toBe('t1');
    expect(entry.referenceTraceId).toBe('t2');
    expect(entry.enrichedFromSession).toBe(true);
  });

  it('omits empty findingIds array from the output', () => {
    const result = validateFeedbackInput({ rating: 'positive', findingIds: [] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const entry = enrichFeedbackEntry('sess_1', result.value, null, fixedNow);
    expect(entry.findingIds).toBeUndefined();
  });

  it('preserves all client-supplied additive metadata', () => {
    const result = validateFeedbackInput({
      rating: 'negative',
      comment: 'wrong scene',
      turnIndex: 1,
      sceneType: 'startup',
      architecture: 'standard',
      packageName: 'com.example',
      findingIds: ['f1'],
      patternId: 'p1',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const entry = enrichFeedbackEntry('sess_1', result.value, null, fixedNow);
    expect(entry.rating).toBe('negative');
    expect(entry.comment).toBe('wrong scene');
    expect(entry.turnIndex).toBe(1);
    expect(entry.sceneType).toBe('startup');
    expect(entry.architecture).toBe('standard');
    expect(entry.packageName).toBe('com.example');
    expect(entry.findingIds).toEqual(['f1']);
    expect(entry.patternId).toBe('p1');
  });

  it('produces a JSON-serializable entry suitable for JSONL append', () => {
    const result = validateFeedbackInput({
      rating: 'positive',
      comment: 'looks right',
      turnIndex: 0,
      sceneType: 'scrolling',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const entry = enrichFeedbackEntry('sess_1', result.value, { traceId: 't' }, fixedNow);
    const line = JSON.stringify(entry);
    expect(() => JSON.parse(line)).not.toThrow();
    expect(line).not.toContain('\n');
  });
});
