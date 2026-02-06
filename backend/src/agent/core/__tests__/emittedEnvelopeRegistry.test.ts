import {
  EmittedEnvelopeRegistry,
  generateDeduplicationKey,
} from '../emittedEnvelopeRegistry';
import type { DataEnvelope } from '../../../types/dataContract';

function makeEnvelope(params: {
  source: string;
  rows: any[][];
  stepId?: string;
  skillId?: string;
}): DataEnvelope {
  return {
    meta: {
      type: 'skill_result',
      version: '2.0.0',
      source: params.source,
      timestamp: Date.now(),
      skillId: params.skillId || 'scrolling_analysis',
      stepId: params.stepId || 'performance_summary',
    },
    display: {
      layer: 'overview',
      format: 'table',
      title: '测试表',
    },
    data: {
      columns: ['a', 'b'],
      rows: params.rows,
    },
  } as DataEnvelope;
}

describe('EmittedEnvelopeRegistry', () => {
  test('deduplicates same content across different execution suffixes', () => {
    const envA = makeEnvelope({
      source: 'scrolling_analysis:performance_summary#mandatory_frame_1770328005587',
      rows: [[1, 2], [3, 4]],
    });
    const envB = makeEnvelope({
      source: 'scrolling_analysis:performance_summary#t1',
      rows: [[1, 2], [3, 4]],
    });

    const keyA = generateDeduplicationKey(envA);
    const keyB = generateDeduplicationKey(envB);

    expect(keyA).toBe(keyB);

    const registry = new EmittedEnvelopeRegistry();
    const firstBatch = registry.filterNewEnvelopes([envA]);
    const secondBatch = registry.filterNewEnvelopes([envB]);

    expect(firstBatch).toHaveLength(1);
    expect(secondBatch).toHaveLength(0);
  });

  test('keeps different rows as different envelopes', () => {
    const envA = makeEnvelope({
      source: 'scrolling_analysis:performance_summary#run_a',
      rows: [[1, 2], [3, 4]],
    });
    const envB = makeEnvelope({
      source: 'scrolling_analysis:performance_summary#run_b',
      rows: [[1, 2], [3, 5]],
    });

    const keyA = generateDeduplicationKey(envA);
    const keyB = generateDeduplicationKey(envB);

    expect(keyA).not.toBe(keyB);
  });
});
