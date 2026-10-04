// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it } from '@jest/globals';
import type express from 'express';
import { StreamProjector } from '../streamProjector';
import { createDataEnvelope, type DataEnvelope } from '../../../types/dataContract';
import {projectDataEnvelopePreview, projectSerializedDataEvent, TABLE_PREVIEW_MAX_BYTES, TABLE_PREVIEW_MAX_ROWS} from '../dataEnvelopePreview';
import {runClaimVerification} from '../../../services/verifier/claimVerificationRunner';
import type {ConclusionContract} from '../../../agent/core/conclusionContract';

class MockSseResponse {
  readonly writes: string[] = [];

  setHeader(_name: string, _value: string): void {
    // No-op for tests.
  }

  write(chunk: string): boolean {
    this.writes.push(String(chunk));
    return true;
  }
}

function parseSsePayload(raw: string): Array<{ event: string; data: any }> {
  const out: Array<{ event: string; data: any }> = [];
  const chunks = raw.split('\n\n').filter(Boolean);
  for (const chunk of chunks) {
    const lines = chunk.split('\n');
    const eventLine = lines.find((line) => line.startsWith('event:'));
    const dataLine = lines.find((line) => line.startsWith('data:'));
    if (!eventLine || !dataLine) continue;
    const event = eventLine.slice('event:'.length).trim();
    const rawData = dataLine.slice('data:'.length).trim();
    out.push({ event, data: JSON.parse(rawData) });
  }
  return out;
}

describe('StreamProjector SSE Contract', () => {
  function largeTable(rows: any[][]): DataEnvelope {
    return createDataEnvelope({columns: ['id', 'value'], rows}, {
      type: 'skill_result', source: 'compare_skill', title: 'Startup table',
      layer: 'list', format: 'table', traceSide: 'reference',
      evidenceRefId: 'evidence:original',
    });
  }

  it('bounds large Skill tables on the wire without changing retained evidence', () => {
    const projector = new StreamProjector();
    const res = new MockSseResponse();
    const envelope = largeTable(Array.from({length: 50_000}, (_, i) => [i, `slice-${i}`]));
    let captured: unknown;
    let buffered: unknown;
    projector.broadcastStreamingUpdate('s1', [res as unknown as express.Response], {
      type: 'data', content: [envelope, envelope], timestamp: 1,
    } as any, {
      seqId: 1,
      onValidDataEnvelopes: (data) => {captured = data[0];},
      onBufferedEvent: (event) => {buffered = JSON.parse(event.eventData);},
    });
    const payload = parseSsePayload(res.writes.join(''))[0].data;
    expect(captured).toBe(envelope);
    expect(envelope.data.rows).toHaveLength(50_000);
    expect(envelope.display.preview).toBeUndefined();
    expect(buffered).toEqual(payload);
    for (const preview of payload.envelope) {
      expect(preview.data.rows).toHaveLength(TABLE_PREVIEW_MAX_ROWS);
      expect(preview.meta).toEqual(envelope.meta);
      expect(preview.display.preview).toEqual({totalRows: 50_000, returnedRows: 200, reason: 'row_limit'});
      expect(Buffer.byteLength(JSON.stringify(preview.data))).toBeLessThanOrEqual(TABLE_PREVIEW_MAX_BYTES);
    }
  });

  it('bounds wide rows and nested row details without rewriting evidence cells', () => {
    const wide = largeTable([[1, 'x'.repeat(300_000)], [2, 'short']]);
    const preview = projectDataEnvelopePreview(wide);
    expect(preview.data.rows).toEqual([]);
    expect(preview.display.preview).toMatchObject({totalRows: 2, returnedRows: 0, reason: 'byte_limit'});
    expect(wide.data.rows?.[0][1]).toHaveLength(300_000);

    const detailed = largeTable([[1, 'one'], [2, 'two']]);
    detailed.data.expandableData = [{item: {}, result: {success: true, error: 'x'.repeat(300_000)}}];
    const projected = projectDataEnvelopePreview(detailed);
    expect(projected.data.rows).toEqual(detailed.data.rows);
    expect(projected.data.expandableData).toBeUndefined();
    expect(projected.display.preview).toMatchObject({totalRows: 2, returnedRows: 2, detailsOmitted: true});
    expect(detailed.data.expandableData).toHaveLength(1);
    expect(projectDataEnvelopePreview(projected)).toEqual(projected);
  });

  it.each([false, true])('preserves conclusion evidence beyond the preview on both trace sides (wrong claim: %s)', (wrongClaim) => {
    const envelopes = (['current', 'reference'] as const).map((side, index) =>
      createDataEnvelope({columns: ['launch_ms'], rows: Array.from({length: 1000}, (_, row) => [row === 900 ? 120 + index * 80 : 1])}, {
        type: 'skill_result', source: 'compare_skill', title: side, layer: 'list', format: 'table',
        traceSide: side, traceId: `trace-${side}`, evidenceRefId: `evidence:${side}`,
        sourceToolCallId: `compare:${side}`,
      }));
    const conclusionContract: ConclusionContract = {
      schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer',
      conclusions: [], clusters: [], evidenceChain: [], uncertainties: [], nextSteps: [],
      claims: envelopes.map((envelope, index) => ({
        id: `claim-${index}`, kind: 'numeric', text: `${envelope.meta.traceSide} startup`,
        references: [{evidenceRefId: envelope.meta.evidenceRefId,
          sourceToolCallId: envelope.meta.sourceToolCallId,
          rowIndex: 900, column: 'launch_ms', value: wrongClaim ? 999 : 120 + index * 80}],
      })),
    };
    const before = runClaimVerification({conclusionContract, dataEnvelopes: envelopes});
    const retained: DataEnvelope[] = [];
    const response = new MockSseResponse();
    new StreamProjector().broadcastStreamingUpdate('comparison', [response as unknown as express.Response], {
      type: 'data', content: envelopes, timestamp: 1,
    } as any, {onValidDataEnvelopes: (data) => retained.push(...data)});
    const displayed = parseSsePayload(response.writes.join(''))[0].data.envelope;
    expect(displayed.map((envelope: DataEnvelope) => envelope.data.rows?.[900])).toEqual([undefined, undefined]);
    const after = runClaimVerification({conclusionContract, dataEnvelopes: retained});
    expect(after.claimSupport).toEqual(before.claimSupport);
    expect(after.claimVerificationResult.claimResults).toEqual(before.claimVerificationResult.claimResults);
    expect(after.claimVerificationResult.issues).toEqual(before.claimVerificationResult.issues);
    for (const [index, side] of (['current', 'reference'] as const).entries()) {
      const anchor = after.claimSupport[index].anchors[0];
      expect(anchor.context).toMatchObject({traceSide: side, traceId: `trace-${side}`});
      expect(anchor.cells).toEqual([expect.objectContaining({rowIndex: 900, column: 'launch_ms',
        actualValue: 120 + index * 80, value: wrongClaim ? 999 : 120 + index * 80})]);
    }
    // Replayed display cells alone are not native execution proof, even when
    // their numbers match. This transport change must not promote them.
    expect(after.claimVerificationResult.passed).toBe(false);
  });

  it('sends and replays the entire long final conclusion and all declarations outside table preview limits', () => {
    const claims = Array.from({length: 240}, (_, index) => ({id: `phase-${index}`, kind: 'numeric',
      text: `Phase ${index} took ${index + 0.125} ms.`,
      references: [{evidenceRefId: 'data:all-phases', rowIndex: index + 1000,
        column: 'duration_ms', value: index + 0.125}]}));
    const conclusion = claims.map(claim => `${claim.text} This phase is scoped to its original investigation interval. ` +
      'Overlapping work cannot be summed into the launch total, and its cause remains unresolved.\n').join('\n') +
      '\n| Final finding | Duration (ms) |\n| --- | ---: |\n| TAIL_PHASE_239 | 239.125 |\n\n' +
      'TAIL_LIMITATION: No cause has been verified for the last measured phase.';
    expect(conclusion.length).toBeGreaterThan(40_000);
    const payload = {type: 'analysis_completed', data: {conclusion, conclusionContract: {claims},
      claimVerificationResult: {schemaVersion: 'claim_verifier@2', status: 'not_checked', passed: false}}};
    const projector = new StreamProjector();
    const res = new MockSseResponse();
    projector.sendEvent(res as unknown as express.Response, 'analysis_completed', payload, 10);
    projector.replayBufferedEvents(res as unknown as express.Response,
      [{seqId: 10, eventType: 'analysis_completed', eventData: JSON.stringify(payload)}], 9);

    const events = parseSsePayload(res.writes.join(''));
    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event.event).toBe('analysis_completed');
      expect(event.data).toEqual(payload);
    }
  });

  it('reprojects old table events on direct send and buffered or persisted replay', () => {
    const projector = new StreamProjector();
    const payload = {type: 'data', envelope: largeTable(Array.from({length: 500}, (_, i) => [i, i]))};
    const raw = JSON.stringify(payload);
    const projected = projectSerializedDataEvent('data', raw);
    expect(projectSerializedDataEvent('data', projected)).toBe(projected);
    expect(JSON.parse(projected).envelope.display.preview.totalRows).toBe(500);
    const res = new MockSseResponse();
    projector.sendEvent(res as unknown as express.Response, 'data', payload, 3);
    projector.replayBufferedEvents(res as unknown as express.Response,
      [{seqId: 4, eventType: 'data', eventData: raw}], 3);
    const events = parseSsePayload(res.writes.join(''));
    expect(events).toHaveLength(2);
    for (const event of events) expect(event.data.envelope.data.rows).toHaveLength(200);
    expect(projectSerializedDataEvent('conclusion', raw)).toBe(raw);
  });

  it('does not return unchecked trailing details or sparse oversized cells', () => {
    for (const rows of [[], [[1, 'one']]]) {
      const envelope = largeTable(rows);
      envelope.data.expandableData = [
        {item: {}, result: {success: true}},
        {item: {}, result: {success: true, error: 'x'.repeat(300_000)}},
      ];
      const preview = projectDataEnvelopePreview(envelope);
      expect(preview.display.preview?.detailsOmitted).toBe(true);
      expect(preview.data.expandableData).toHaveLength(rows.length);
      expect(Buffer.byteLength(JSON.stringify(preview.data))).toBeLessThanOrEqual(TABLE_PREVIEW_MAX_BYTES);
    }
    const sparse = largeTable([[1, new Array(500_000)]]);
    expect(projectDataEnvelopePreview(sparse).data.rows).toEqual([]);
  });

  it('emits data event contract with envelope payload', () => {
    const projector = new StreamProjector();
    const res = new MockSseResponse();

    const envelope = createDataEnvelope(
      { columns: ['metric'], rows: [[123]] },
      {
        type: 'skill_result',
        source: 'test.stream_projector',
        title: 'test_data',
        skillId: 'test_skill',
        stepId: 'step_a',
        layer: 'list',
        format: 'table',
      }
    );

    projector.broadcastStreamingUpdate(
      'session-1',
      [res as unknown as express.Response],
      {
        type: 'data',
        content: envelope,
        timestamp: Date.now(),
      } as any,
      {
        observability: {
          runId: 'run-1',
          requestId: 'req-1',
          runSequence: 1,
        },
      }
    );

    const parsed = parseSsePayload(res.writes.join(''));
    expect(parsed.length).toBe(1);
    expect(parsed[0].event).toBe('data');
    expect(parsed[0].data.type).toBe('data');
    expect(typeof parsed[0].data.id).toBe('string');
    expect(typeof parsed[0].data.timestamp).toBe('number');
    expect(parsed[0].data.envelope).toBeDefined();
    expect(parsed[0].data.envelope.data.columns).toEqual(['metric']);
    expect(parsed[0].data.runId).toBe('run-1');
    expect(parsed[0].data.requestId).toBe('req-1');
    expect(parsed[0].data.runSequence).toBe(1);
  });

  it('rejects an invalid data envelope even when it contains data', () => {
    const projector = new StreamProjector();
    const res = new MockSseResponse();
    const admitted: unknown[][] = [];
    const warnings: unknown[] = [];
    const invalidEnvelope = {
      meta: {
        type: 'skill_result',
        version: '1.0.0',
        timestamp: Date.now(),
      },
      display: {
        title: 'invalid_data',
        layer: 'list',
        format: 'table',
      },
      data: {columns: ['metric'], rows: [[123]]},
    };

    projector.broadcastStreamingUpdate(
      'session-invalid',
      [res as unknown as express.Response],
      {
        type: 'data',
        content: invalidEnvelope,
        timestamp: Date.now(),
      } as any,
      {
        onValidDataEnvelopes: (envelopes) => admitted.push(envelopes),
        onDataEnvelopeValidationWarning: (warning) => warnings.push(warning),
      }
    );

    expect(admitted).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toEqual({
      sessionId: 'session-invalid',
      envelopeIndex: 0,
      errors: [{path: 'meta.source', message: 'meta.source must be a non-empty string'}],
      totalErrors: 1,
      envelope: {
        metaType: 'skill_result',
        metaVersion: '1.0.0',
        displayLayer: 'list',
        displayFormat: 'table',
      },
    });
    const parsed = parseSsePayload(res.writes.join(''));
    expect(parsed[0].data.envelope).toEqual([]);
  });

  it('reports a rejected envelope to the log by schema identity, never by its content', () => {
    const projector = new StreamProjector();
    const warnings: unknown[] = [];
    const secretRow = 'row-value-that-must-not-be-logged';
    const invalidEnvelope = createDataEnvelope(
      {columns: ['metric'], rows: [[secretRow]]},
      {type: 'skill_result', source: 'test.stream_projector', title: 'leaky', skillId: 'test_skill',
        stepId: 'step_leaky', layer: 'list', format: 'table'},
    );
    // A column list the validator rejects carries its whole value on the error.
    (invalidEnvelope.display as any).columns = {[secretRow]: secretRow};
    projector.broadcastStreamingUpdate('session-leaky', [new MockSseResponse() as unknown as express.Response],
      {type: 'data', content: invalidEnvelope, timestamp: Date.now()} as any,
      {onDataEnvelopeValidationWarning: (warning) => warnings.push(warning)});

    expect(warnings).toEqual([{
      sessionId: 'session-leaky',
      envelopeIndex: 0,
      errors: [{path: 'display.columns', message: 'display.columns must be an array'}],
      totalErrors: 1,
      envelope: expect.objectContaining({metaSource: 'test.stream_projector', skillId: 'test_skill',
        stepId: 'step_leaky', displayLayer: 'list', displayFormat: 'table'}),
    }]);
    expect(JSON.stringify(warnings)).not.toContain(secretRow);
  });

  it('admits only valid envelopes from a mixed batch and preserves array shape', () => {
    const projector = new StreamProjector();
    const res = new MockSseResponse();
    const admitted: unknown[][] = [];
    const warnings: unknown[] = [];
    const validEnvelope = createDataEnvelope(
      {columns: ['metric'], rows: [[456]]},
      {
        type: 'skill_result',
        source: 'test.stream_projector',
        title: 'valid_data',
        skillId: 'test_skill',
        stepId: 'step_valid',
        layer: 'list',
        format: 'table',
      }
    );
    const invalidEnvelope = {
      ...validEnvelope,
      display: {...validEnvelope.display, layer: 'invalid_layer'},
    };

    projector.broadcastStreamingUpdate(
      'session-mixed',
      [res as unknown as express.Response],
      {
        type: 'data',
        content: [invalidEnvelope, validEnvelope],
        timestamp: Date.now(),
      } as any,
      {
        onValidDataEnvelopes: (envelopes) => admitted.push(envelopes),
        onDataEnvelopeValidationWarning: (warning) => warnings.push(warning),
      }
    );

    expect(admitted).toEqual([[validEnvelope]]);
    expect(warnings).toHaveLength(1);
    const parsed = parseSsePayload(res.writes.join(''));
    expect(Array.isArray(parsed[0].data.envelope)).toBe(true);
    expect(parsed[0].data.envelope).toEqual([validEnvelope]);
  });

  it('emits an empty envelope array when every batch item is invalid', () => {
    const projector = new StreamProjector();
    const res = new MockSseResponse();
    const admitted: unknown[][] = [];

    projector.broadcastStreamingUpdate(
      'session-all-invalid',
      [res as unknown as express.Response],
      {
        type: 'data',
        content: [
          {data: {columns: ['a'], rows: [[1]]}},
          {meta: {}, display: {}, data: {columns: ['b'], rows: [[2]]}},
        ],
        timestamp: Date.now(),
      } as any,
      {
        onValidDataEnvelopes: (envelopes) => admitted.push(envelopes),
      }
    );

    expect(admitted).toEqual([]);
    const parsed = parseSsePayload(res.writes.join(''));
    expect(parsed[0].data.envelope).toEqual([]);
  });

  it('emits conversation_step event contract with generic data payload', () => {
    const projector = new StreamProjector();
    const res = new MockSseResponse();

    projector.broadcastStreamingUpdate(
      'session-2',
      [res as unknown as express.Response],
      {
        type: 'conversation_step',
        id: 'evt-123',
        content: {
          phase: 'thinking',
          role: 'agent',
          text: '正在分析',
        },
        timestamp: Date.now(),
      } as any,
      {
        observability: {
          runId: 'run-2',
          requestId: 'req-2',
          runSequence: 2,
        },
      }
    );

    const parsed = parseSsePayload(res.writes.join(''));
    expect(parsed.length).toBe(1);
    expect(parsed[0].event).toBe('conversation_step');
    expect(parsed[0].data.type).toBe('conversation_step');
    expect(parsed[0].data.id).toBe('evt-123');
    expect(typeof parsed[0].data.timestamp).toBe('number');
    expect(parsed[0].data.data.phase).toBe('thinking');
    expect(parsed[0].data.data.role).toBe('agent');
    expect(parsed[0].data.runId).toBe('run-2');
    expect(parsed[0].data.requestId).toBe('req-2');
    expect(parsed[0].data.runSequence).toBe(2);
  });

  it('emits error event with both error and message fields for client compatibility', () => {
    const projector = new StreamProjector();
    const res = new MockSseResponse();

    projector.sendError(
      res as unknown as express.Response,
      'trace not found',
      {
        runId: 'run-3',
        requestId: 'req-3',
        runSequence: 3,
      }
    );

    const parsed = parseSsePayload(res.writes.join(''));
    expect(parsed.length).toBe(1);
    expect(parsed[0].event).toBe('error');
    expect(parsed[0].data.error).toBe('trace not found');
    expect(parsed[0].data.message).toBe('trace not found');
    expect(parsed[0].data.runId).toBe('run-3');
    expect(parsed[0].data.requestId).toBe('req-3');
    expect(parsed[0].data.runSequence).toBe(3);
  });

  it('replays only buffered events after Last-Event-ID', () => {
    const projector = new StreamProjector();
    const res = new MockSseResponse();

    const replayed = projector.replayBufferedEvents(
      res as unknown as express.Response,
      [
        {seqId: 1, eventType: 'progress', eventData: JSON.stringify({step: 1})},
        {
          seqId: 2,
          eventType: 'analysis_completed',
          eventData: JSON.stringify({reportUrl: '/api/reports/report-a'}),
        },
        {seqId: 3, eventType: 'end', eventData: JSON.stringify({done: true})},
      ],
      1
    );

    expect(replayed).toBe(2);
    const raw = res.writes.join('');
    expect(raw).toContain('id: 2\n');
    expect(raw).toContain('event: analysis_completed\n');
    expect(raw).toContain('id: 3\n');
    expect(raw).toContain('event: end\n');
    expect(raw).not.toContain('id: 1\n');
  });
});
