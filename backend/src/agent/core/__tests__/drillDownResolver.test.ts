/**
 * Drill-Down Resolver Unit Tests
 */

import {
  resolveDrillDown,
  DrillDownResolved,
  DrillDownResolutionTrace,
} from '../drillDownResolver';
import { EnhancedSessionContext } from '../../context/enhancedSessionContext';
import type { Intent, ReferencedEntity } from '../../types';
import type { FollowUpResolution } from '../followUpHandler';

describe('drillDownResolver', () => {
  let sessionContext: EnhancedSessionContext;

  beforeEach(() => {
    sessionContext = new EnhancedSessionContext('session-1', 'trace-1');
  });

  describe('resolveDrillDown', () => {
    describe('Priority 1: Explicit intervals from followUp', () => {
      test('returns followUp intervals when valid timestamps present', async () => {
        const intent: Intent = {
          primaryGoal: '分析帧 1436069',
          aspects: ['jank'],
          expectedOutputType: 'diagnosis',
          complexity: 'moderate',
          followUpType: 'drill_down',
          referencedEntities: [{ type: 'frame', id: 1436069 }],
        };

        const followUp: FollowUpResolution = {
          isFollowUp: true,
          resolvedParams: { frame_id: 1436069 },
          focusIntervals: [{
            id: 0,
            processName: 'com.example.app',
            startTs: '123456789000000',
            endTs: '123456889000000',
            priority: 1,
            label: '帧 1436069',
            metadata: {
              sourceEntityType: 'frame',
              sourceEntityId: 1436069,
            },
          }],
          confidence: 0.9,
        };

        const result = await resolveDrillDown(intent, followUp, sessionContext);

        expect(result).not.toBeNull();
        expect(result!.intervals).toHaveLength(1);
        expect(result!.intervals[0].startTs).toBe('123456789000000');
        expect(result!.traces[0].used).toContain('explicit');
      });

      test('skips invalid intervals with placeholder timestamps', async () => {
        const intent: Intent = {
          primaryGoal: '分析帧 1436069',
          aspects: ['jank'],
          expectedOutputType: 'diagnosis',
          complexity: 'moderate',
          followUpType: 'drill_down',
          referencedEntities: [{ type: 'frame', id: 1436069 }],
        };

        const followUp: FollowUpResolution = {
          isFollowUp: true,
          resolvedParams: { frame_id: 1436069 },
          focusIntervals: [{
            id: 0,
            processName: '',
            startTs: '0', // Invalid placeholder
            endTs: '0',
            priority: 1,
            metadata: { needsEnrichment: true },
          }],
          confidence: 0.5,
        };

        // Should fall through to cache/enrichment
        const result = await resolveDrillDown(intent, followUp, sessionContext);
        // Without cache data, returns null
        expect(result).toBeNull();
      });
    });

    describe('Priority 2: EntityStore cache', () => {
      test('resolves from cache when frame exists', async () => {
        // Pre-populate cache
        const store = sessionContext.getEntityStore();
        store.upsertFrame({
          frame_id: '1436069',
          start_ts: '123456789000000',
          end_ts: '123456889000000',
          process_name: 'com.example.app',
          session_id: '1',
          jank_type: 'App Deadline Missed',
        });

        const intent: Intent = {
          primaryGoal: '分析帧 1436069',
          aspects: ['jank'],
          expectedOutputType: 'diagnosis',
          complexity: 'moderate',
          followUpType: 'drill_down',
          referencedEntities: [{ type: 'frame', id: 1436069 }],
        };

        const followUp: FollowUpResolution = {
          isFollowUp: true,
          resolvedParams: { frame_id: 1436069 },
          confidence: 0.5,
        };

        const result = await resolveDrillDown(intent, followUp, sessionContext);

        expect(result).not.toBeNull();
        expect(result!.intervals).toHaveLength(1);
        expect(result!.intervals[0].startTs).toBe('123456789000000');
        expect(result!.traces[0].used).toContain('cache');
        expect(result!.traces[0].enriched).toBe(false);
        expect(result!.traces[0].reason).toContain('Cache hit');
      });

      test('resolves from cache when session exists', async () => {
        const store = sessionContext.getEntityStore();
        store.upsertSession({
          session_id: '1',
          start_ts: '100000000000000',
          end_ts: '200000000000000',
          process_name: 'com.example.app',
          frame_count: 120,
          jank_count: 5,
        });

        const intent: Intent = {
          primaryGoal: '分析会话 1',
          aspects: ['scrolling'],
          expectedOutputType: 'diagnosis',
          complexity: 'moderate',
          followUpType: 'drill_down',
          referencedEntities: [{ type: 'session', id: 1 }],
        };

        const followUp: FollowUpResolution = {
          isFollowUp: true,
          resolvedParams: { session_id: 1 },
          confidence: 0.5,
        };

        const result = await resolveDrillDown(intent, followUp, sessionContext);

        expect(result).not.toBeNull();
        expect(result!.intervals).toHaveLength(1);
        expect(result!.intervals[0].startTs).toBe('100000000000000');
        expect(result!.traces[0].entityType).toBe('session');
        expect(result!.traces[0].used).toContain('cache');
      });
    });

    describe('Priority 3: Resolved params from findings', () => {
      test('builds interval from resolved params with timestamps', async () => {
        const intent: Intent = {
          primaryGoal: '分析帧 1436069',
          aspects: ['jank'],
          expectedOutputType: 'diagnosis',
          complexity: 'moderate',
          followUpType: 'drill_down',
          referencedEntities: [{ type: 'frame', id: 1436069 }],
        };

        const followUp: FollowUpResolution = {
          isFollowUp: true,
          resolvedParams: {
            frame_id: 1436069,
            start_ts: '123456789000000',
            end_ts: '123456889000000',
            process_name: 'com.example.app',
          },
          confidence: 0.7,
        };

        const result = await resolveDrillDown(intent, followUp, sessionContext);

        expect(result).not.toBeNull();
        expect(result!.intervals).toHaveLength(1);
        expect(result!.traces[0].used).toContain('finding');
      });
    });

    describe('Priority 4: SQL enrichment', () => {
      test('enriches frame via SQL when cache miss', async () => {
        const intent: Intent = {
          primaryGoal: '分析帧 1436069',
          aspects: ['jank'],
          expectedOutputType: 'diagnosis',
          complexity: 'moderate',
          followUpType: 'drill_down',
          referencedEntities: [{ type: 'frame', id: 1436069 }],
        };

        const followUp: FollowUpResolution = {
          isFollowUp: true,
          resolvedParams: { frame_id: 1436069 },
          confidence: 0.5,
        };

        // Mock trace processor service
        const mockTps = {
          executeQuery: jest.fn().mockResolvedValue({
            columns: ['frame_id', 'start_ts', 'end_ts', 'dur', 'process_name', 'upid', 'jank_type', 'layer_name'],
            rows: [
              [1436069, '123456789000000', '123456889000000', 100000000, 'com.example.app', 123, 'App Deadline Missed', 'SurfaceView'],
            ],
          }),
        };

        const result = await resolveDrillDown(intent, followUp, sessionContext, mockTps, 'trace-1');

        expect(result).not.toBeNull();
        expect(result!.intervals).toHaveLength(1);
        expect(result!.intervals[0].startTs).toBe('123456789000000');
        expect(result!.traces[0].used).toContain('enrichment');
        expect(result!.traces[0].enriched).toBe(true);

        // Verify enrichment was cached
        const cachedFrame = sessionContext.getEntityStore().getFrame('1436069');
        expect(cachedFrame).toBeDefined();
        expect(cachedFrame?.source).toBe('enrichment');
      });

      test('returns null when enrichment fails', async () => {
        const intent: Intent = {
          primaryGoal: '分析帧 9999999',
          aspects: ['jank'],
          expectedOutputType: 'diagnosis',
          complexity: 'moderate',
          followUpType: 'drill_down',
          referencedEntities: [{ type: 'frame', id: 9999999 }],
        };

        const followUp: FollowUpResolution = {
          isFollowUp: true,
          resolvedParams: { frame_id: 9999999 },
          confidence: 0.5,
        };

        // Mock returns no rows
        const mockTps = {
          executeQuery: jest.fn().mockResolvedValue({
            columns: [],
            rows: [],
          }),
        };

        const result = await resolveDrillDown(intent, followUp, sessionContext, mockTps, 'trace-1');

        expect(result).toBeNull();
      });

      test('enriches startup via SQL when startup entity is requested', async () => {
        const intent: Intent = {
          primaryGoal: '分析启动 12',
          aspects: ['startup'],
          expectedOutputType: 'diagnosis',
          complexity: 'moderate',
          followUpType: 'drill_down',
          referencedEntities: [{ type: 'startup', id: 12 }],
        };

        const followUp: FollowUpResolution = {
          isFollowUp: true,
          resolvedParams: { startup_id: 12 },
          confidence: 0.5,
        };

        const mockTps = {
          executeQuery: jest.fn().mockResolvedValue({
            columns: [
              'startup_id',
              'start_ts',
              'end_ts',
              'dur_ms',
              'process_name',
              'startup_type',
              'ttid_ms',
              'ttfd_ms',
            ],
            rows: [
              [12, '1000000', '2800000', 1800, 'com.example.app', 'cold', 1500, 1900],
            ],
          }),
        };

        const result = await resolveDrillDown(intent, followUp, sessionContext, mockTps, 'trace-1');

        expect(result).not.toBeNull();
        expect(result!.intervals).toHaveLength(1);
        expect(result!.intervals[0].metadata?.startup_id).toBe('12');
        expect(result!.traces[0].entityType).toBe('startup');
        expect(result!.traces[0].used).toContain('enrichment');
      });

      test('supports trace processor query(traceId, sql) API for enrichment', async () => {
        const intent: Intent = {
          primaryGoal: '分析帧 1436069',
          aspects: ['jank'],
          expectedOutputType: 'diagnosis',
          complexity: 'moderate',
          followUpType: 'drill_down',
          referencedEntities: [{ type: 'frame', id: 1436069 }],
        };

        const followUp: FollowUpResolution = {
          isFollowUp: true,
          resolvedParams: { frame_id: 1436069 },
          confidence: 0.5,
        };

        const mockTps = {
          query: jest.fn().mockResolvedValue({
            columns: ['frame_id', 'start_ts', 'end_ts', 'dur', 'process_name', 'upid', 'jank_type', 'layer_name'],
            rows: [
              [1436069, '123456789000000', '123456889000000', 100000000, 'com.example.app', 123, 'App Deadline Missed', 'SurfaceView'],
            ],
          }),
        };

        const result = await resolveDrillDown(intent, followUp, sessionContext, mockTps, 'trace-1');

        expect(result).not.toBeNull();
        expect(mockTps.query).toHaveBeenCalledWith(
          'trace-1',
          expect.stringContaining('COALESCE(a.display_frame_token, a.surface_frame_token) = 1436069')
        );
      });

      test('falls back to doFrame alias enrichment when token and legacy lookups miss', async () => {
        const intent: Intent = {
          primaryGoal: '分析帧 1435596',
          aspects: ['jank'],
          expectedOutputType: 'diagnosis',
          complexity: 'moderate',
          followUpType: 'drill_down',
          referencedEntities: [{ type: 'frame', id: 1435596 }],
        };

        const followUp: FollowUpResolution = {
          isFollowUp: true,
          resolvedParams: { frame_id: 1435596 },
          confidence: 0.5,
        };

        const queryMock = jest.fn()
          // Token lookup miss.
          .mockResolvedValueOnce({ columns: [], rows: [] })
          // Legacy lookup miss.
          .mockResolvedValueOnce({ columns: [], rows: [] })
          // doFrame alias hit.
          .mockResolvedValueOnce({
            columns: ['frame_id', 'start_ts', 'end_ts', 'dur', 'process_name', 'jank_type', 'layer_name'],
            rows: [
              [1435611, '223456789000000', '223456889000000', 100000000, 'com.example.app', 'App Deadline Missed', 'SurfaceView'],
            ],
          });

        const mockTps = {
          query: queryMock,
        };

        const result = await resolveDrillDown(intent, followUp, sessionContext, mockTps, 'trace-1');

        expect(result).not.toBeNull();
        expect(queryMock).toHaveBeenCalledTimes(3);
        expect(queryMock.mock.calls[2][1]).toContain('Choreographer#doFrame 1435596');
        expect(result!.intervals[0].startTs).toBe('223456789000000');
        expect(result!.intervals[0].endTs).toBe('223456889000000');
        expect(result!.intervals[0].metadata?.frame_id).toBe('1435611');
        expect(result!.intervals[0].metadata?.resolvedFrom).toBe('doframe_alias');
      });
    });

    describe('Multiple entities', () => {
      test('resolves multiple frame entities', async () => {
        const store = sessionContext.getEntityStore();
        store.upsertFrame({
          frame_id: '1436069',
          start_ts: '123456789000000',
          end_ts: '123456889000000',
          process_name: 'com.example.app',
        });
        store.upsertFrame({
          frame_id: '1436070',
          start_ts: '123456889000000',
          end_ts: '123456989000000',
          process_name: 'com.example.app',
        });

        const intent: Intent = {
          primaryGoal: '比较帧 1436069 和 1436070',
          aspects: ['jank'],
          expectedOutputType: 'comparison',
          complexity: 'moderate',
          followUpType: 'drill_down',
          referencedEntities: [
            { type: 'frame', id: 1436069 },
            { type: 'frame', id: 1436070 },
          ],
        };

        const followUp: FollowUpResolution = {
          isFollowUp: true,
          resolvedParams: {},
          confidence: 0.5,
        };

        const result = await resolveDrillDown(intent, followUp, sessionContext);

        expect(result).not.toBeNull();
        expect(result!.intervals).toHaveLength(2);
        expect(result!.traces).toHaveLength(2);
        expect(result!.traces.every(t => t.used.includes('cache'))).toBe(true);
      });
    });

    describe('Entity type filtering', () => {
      test('ignores unsupported non-drill-down entity types', async () => {
        const intent: Intent = {
          primaryGoal: '分析进程',
          aspects: ['process'],
          expectedOutputType: 'diagnosis',
          complexity: 'moderate',
          followUpType: 'drill_down',
          referencedEntities: [{ type: 'process', id: 'com.example.app' }],
        };

        const followUp: FollowUpResolution = {
          isFollowUp: true,
          resolvedParams: {},
          confidence: 0.5,
        };

        const result = await resolveDrillDown(intent, followUp, sessionContext);
        expect(result).toBeNull();
      });
    });

    describe('ReferencedEntity.value handling', () => {
      test('uses value when id is not present', async () => {
        const store = sessionContext.getEntityStore();
        store.upsertFrame({
          frame_id: '1436069',
          start_ts: '123456789000000',
          end_ts: '123456889000000',
          process_name: 'com.example.app',
        });

        const intent: Intent = {
          primaryGoal: '分析帧',
          aspects: ['jank'],
          expectedOutputType: 'diagnosis',
          complexity: 'moderate',
          followUpType: 'drill_down',
          referencedEntities: [{
            type: 'frame',
            value: 1436069, // Using value instead of id
          }],
        };

        const followUp: FollowUpResolution = {
          isFollowUp: true,
          resolvedParams: {},
          confidence: 0.5,
        };

        const result = await resolveDrillDown(intent, followUp, sessionContext);

        expect(result).not.toBeNull();
        expect(result!.intervals).toHaveLength(1);
      });

      test('builds interval from value object with timestamps', async () => {
        const intent: Intent = {
          primaryGoal: '分析帧',
          aspects: ['jank'],
          expectedOutputType: 'diagnosis',
          complexity: 'moderate',
          followUpType: 'drill_down',
          referencedEntities: [{
            type: 'frame',
            id: 1436069,
            value: {
              frame_id: 1436069,
              start_ts: '123456789000000',
              end_ts: '123456889000000',
              process_name: 'com.example.app',
            },
          }],
        };

        const followUp: FollowUpResolution = {
          isFollowUp: true,
          resolvedParams: {},
          confidence: 0.5,
        };

        const result = await resolveDrillDown(intent, followUp, sessionContext);

        expect(result).not.toBeNull();
        expect(result!.intervals).toHaveLength(1);
        expect(result!.traces[0].used).toContain('explicit');
      });
    });
  });
});
