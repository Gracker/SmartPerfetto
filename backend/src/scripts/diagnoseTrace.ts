/**
 * Simple diagnostic script to check trace data consistency
 */

import { getSkillAnalysisAdapterV2 } from '../services/skillEngine/skillAnalysisAdapterV2';
import { getTraceProcessorService } from '../services/traceProcessorService';
import path from 'path';

async function diagnose() {
  const tracePath = path.join(process.cwd(), '../test-traces/app_aosp_scrolling_heavy_jank.pftrace');
  console.log('Trace:', path.basename(tracePath));
  console.log('Size:', (require('fs').statSync(tracePath).size / 1024 / 1024).toFixed(2), 'MB\n');

  const traceProcessor = getTraceProcessorService();
  const skillAdapter = getSkillAnalysisAdapterV2(traceProcessor);

  console.log('⏳ Loading trace...');
  const traceId = await traceProcessor.loadTraceFromFilePath(tracePath);
  console.log('✓ Loaded. ID:', traceId, '\n');

  // Run the exact same queries as the skill
  console.log('=== Query 1: Environment Detection ===');
  const envQuery = `
    WITH frame_info AS (
      SELECT
        COUNT(*) as total_frames,
        COUNT(DISTINCT a.upid) as app_count
      FROM actual_frame_timeline_slice a
      JOIN process p ON a.upid = p.upid
      WHERE (p.name GLOB '' OR '' = '')
        AND a.surface_frame_token IS NOT NULL
    )
    SELECT
      (SELECT total_frames FROM frame_info) as total_frames,
      (SELECT app_count FROM frame_info) as app_count,
      CASE WHEN (SELECT total_frames FROM frame_info) > 0 THEN 'available' ELSE 'unavailable' END as frame_data_status
  `;

  const envResult = await traceProcessor.query(traceId, envQuery);
  console.log('Environment result:', JSON.stringify(envResult, null, 2));

  console.log('\n=== Query 2: Frame Count (with package = "") ===');
  const frameQuery = `
    SELECT COUNT(*) as count
    FROM actual_frame_timeline_slice a
    JOIN process p ON a.upid = p.upid
    WHERE (p.name GLOB '' OR '' = '')
      AND a.dur > 0
      AND a.surface_frame_token IS NOT NULL
  `;

  const frameResult = await traceProcessor.query(traceId, frameQuery);
  console.log('Frame count result:', JSON.stringify(frameResult, null, 2));

  console.log('\n=== Query 3: Simple count (no filters) ===');
  const simpleCount = await traceProcessor.query(traceId, `
    SELECT COUNT(*) as count FROM actual_frame_timeline_slice
  `);
  console.log('Simple count:', JSON.stringify(simpleCount, null, 2));

  console.log('\n=== Running scrolling analysis ===');
  const result = await skillAdapter.analyze({
    traceId,
    question: '分析滑动性能',
  });

  const env = result.layeredResult?.layers?.L1?.detect_environment?.data?.[0];
  console.log('Environment from result:', env);

  const getFrames = result.layeredResult?.layers?.L1?.get_frames_from_stdlib;
  console.log('\nget_frames_from_stdlib:');
  console.log('  success:', getFrames?.success);
  console.log('  data length:', getFrames?.data?.length || 0);
  console.log('  error:', getFrames?.error);

  await traceProcessor.cleanup();
}

diagnose().catch(console.error);
