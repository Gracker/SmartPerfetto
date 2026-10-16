/**
 * Process Identity Resolver Skill Evaluation Tests
 *
 * Verifies that process_identity_resolver stays executable on canonical traces
 * and does not rank launcher/system context above the traced app by default.
 */

import { describe, expect, it, beforeAll } from '@jest/globals';
import { ensureSkillRegistryInitialized, skillRegistry } from '../../src/services/skillEngine/skillLoader';
import { createSkillExecutor, SkillExecutor } from '../../src/services/skillEngine/skillExecutor';
import { getTraceProcessorService, TraceProcessorService } from '../../src/services/traceProcessorService';
import { resolveTraceCase } from '../helpers/traceCorpus';

const TRACE_CASES = [
  { file: 'lacunh_heavy.pftrace', expectedTop: /^com\.example\./ },
  { file: 'launch_light.pftrace', expectedTop: /^com\.example\./ },
  { file: 'scroll_Standard-AOSP-App-Without-PreAnimation.pftrace', expectedTop: /^com\.example\./ },
  { file: 'scroll-demo-customer-scroll.pftrace', expectedTop: /^com\.example\./ },
  { file: 'Scroll-Flutter-327-TextureView.pftrace', expectedTop: /^com\.example\./ },
  { file: 'Scroll-Flutter-SurfaceView-Wechat-Wenyiwen.pftrace', expectedTop: null },
] as const;

const IDX_CONFIDENCE = 1;
const IDX_STATUS = 2;
const IDX_CANONICAL = 3;
const IDX_PROCESS_PARAM = 4;

function getRows(result: any): any[][] {
  return result.displayResults?.[0]?.data?.rows || [];
}

async function withTrace<T>(
  traceProcessor: TraceProcessorService,
  traceFile: string,
  callback: (traceId: string) => Promise<T>,
): Promise<T> {
  const tracePath = resolveTraceCase(traceFile);
  const traceId = await traceProcessor.loadTraceFromFilePath(tracePath);
  try {
    return await callback(traceId);
  } finally {
    await traceProcessor.deleteTrace(traceId);
  }
}

describe('process_identity_resolver skill', () => {
  let traceProcessor: TraceProcessorService;
  let executor: SkillExecutor;

  beforeAll(async () => {
    await ensureSkillRegistryInitialized();
    traceProcessor = getTraceProcessorService();
    executor = createSkillExecutor(traceProcessor);
    executor.registerSkills(skillRegistry.getAllSkills());
  }, 60000);

  it('executes on canonical trace fixtures and ranks app candidates above launchers', async () => {
    for (const traceCase of TRACE_CASES) {
      // eslint-disable-next-line no-await-in-loop
      await withTrace(traceProcessor, traceCase.file, async traceId => {
        const result = await executor.execute('process_identity_resolver', traceId, { max_rows: 5 });
        const rows = getRows(result);

        expect(result.success).toBe(true);
        if (traceCase.expectedTop === null) {
          expect(rows).toHaveLength(0);
          return;
        }

        const first = rows[0];
        expect(rows.length).toBeGreaterThan(0);
        expect(first[IDX_STATUS]).toBe('foreground_candidate');
        expect(String(first[IDX_CANONICAL])).toMatch(traceCase.expectedTop);
        expect(String(first[IDX_PROCESS_PARAM])).toMatch(traceCase.expectedTop);
        expect(String(first[IDX_CANONICAL])).not.toBe('com.miui.home');
      });
    }
  }, 240000);

  it('returns only matching candidates when a target package is provided', async () => {
    await withTrace(traceProcessor, 'scroll-demo-customer-scroll.pftrace', async traceId => {
      const result = await executor.execute('process_identity_resolver', traceId, {
        package: 'com.example.wechatfriendforcustomscroller',
        max_rows: 10,
      });
      const rows = getRows(result);
      const first = rows[0];

      expect(result.success).toBe(true);
      expect(rows).toHaveLength(1);
      expect(first[IDX_CONFIDENCE]).toBeGreaterThanOrEqual(80);
      expect(first[IDX_STATUS]).toBe('confirmed');
      expect(first[IDX_CANONICAL]).toBe('com.example.wechatfriendforcustomscroller');
      expect(first[IDX_PROCESS_PARAM]).toBe('com.example.wechatfriendforcustomscroller');
      const columns = result.displayResults?.[0]?.data?.columns || [];
      const warningIndex = columns.indexOf('identity_warning');
      expect(warningIndex).toBeGreaterThanOrEqual(0);
      expect(first[warningIndex]).toBe('ok');
    });
  }, 60000);

  it('does not bury explicit system process targets behind non-system context rows', async () => {
    await withTrace(traceProcessor, 'launch_light.pftrace', async traceId => {
      const result = await executor.execute('process_identity_resolver', traceId, {
        process_name: 'system_server',
        max_rows: 3,
      });
      const rows = getRows(result);
      const first = rows[0];

      expect(result.success).toBe(true);
      expect(rows.length).toBeGreaterThan(0);
      expect(first[IDX_CONFIDENCE]).toBeGreaterThanOrEqual(50);
      expect(first[IDX_STATUS]).toMatch(/confirmed|probable/);
      expect(first[IDX_PROCESS_PARAM]).toBe('system_server');
    });
  }, 60000);
});
