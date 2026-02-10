import { describe, expect, it } from '@jest/globals';
import { resolveFollowUp } from '../followUpHandler';
import { EnhancedSessionContext } from '../../context/enhancedSessionContext';
import type { Intent } from '../../types';

describe('followUpHandler', () => {
  it('builds startup minimal interval with startup source entity when timestamps are provided', () => {
    const sessionContext = new EnhancedSessionContext('session-1', 'trace-1');
    const intent: Intent = {
      primaryGoal: '分析启动 12',
      aspects: ['startup'],
      expectedOutputType: 'diagnosis',
      complexity: 'moderate',
      followUpType: 'drill_down',
      referencedEntities: [{ type: 'startup', id: 12 }],
      extractedParams: {
        startup_id: 12,
        start_ts: '1000000',
        end_ts: '2500000',
        package: 'com.example.app',
      },
    };

    const resolved = resolveFollowUp(intent, sessionContext);

    expect(resolved.isFollowUp).toBe(true);
    expect(resolved.suggestedStrategy).toBe('startup_drill_down');
    expect(resolved.focusIntervals).toHaveLength(1);
    expect(resolved.focusIntervals?.[0].startTs).toBe('1000000');
    expect(resolved.focusIntervals?.[0].endTs).toBe('2500000');
    expect(resolved.focusIntervals?.[0].metadata?.sourceEntityType).toBe('startup');
    expect(resolved.focusIntervals?.[0].metadata?.sourceEntityId).toBe(12);
  });

  it('builds startup minimal interval requiring enrichment when timestamps are missing', () => {
    const sessionContext = new EnhancedSessionContext('session-1', 'trace-1');
    const intent: Intent = {
      primaryGoal: '看 startup 9 细节',
      aspects: ['startup'],
      expectedOutputType: 'diagnosis',
      complexity: 'moderate',
      followUpType: 'drill_down',
      referencedEntities: [{ type: 'startup', id: 9 }],
      extractedParams: {
        startup_id: 9,
      },
    };

    const resolved = resolveFollowUp(intent, sessionContext);

    expect(resolved.focusIntervals).toHaveLength(1);
    expect(resolved.focusIntervals?.[0].startTs).toBe('0');
    expect(resolved.focusIntervals?.[0].endTs).toBe('0');
    expect(resolved.focusIntervals?.[0].metadata?.sourceEntityType).toBe('startup');
    expect(resolved.focusIntervals?.[0].metadata?.needsEnrichment).toBe(true);
  });
});
