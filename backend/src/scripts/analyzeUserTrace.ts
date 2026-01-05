/**
 * Detailed analysis of user trace - debug data flow
 */

import { getSkillAnalysisAdapterV2 } from '../services/skillEngine/skillAnalysisAdapterV2';
import { getTraceProcessorService } from '../services/traceProcessorService';
import path from 'path';

async function analyzeUserTrace() {
  console.log('\n╔════════════════════════════════════════════════════════════════╗');
  console.log('║     User Trace Data Flow Analysis                            ║');
  console.log('╚════════════════════════════════════════════════════════════════╝\n');

  // User's uploaded trace
  const tracePath = path.join(process.cwd(), 'uploads/traces/d717bd47-21bf-46ac-b546-05c77d45149e.trace');
  console.log('Trace:', tracePath);
  console.log('Size:', (require('fs').statSync(tracePath).size / 1024 / 1024).toFixed(2), 'MB\n');

  const traceProcessor = getTraceProcessorService();
  const skillAdapter = getSkillAnalysisAdapterV2(traceProcessor);

  // Load trace
  console.log('⏳ Loading trace...');
  const traceId = await traceProcessor.loadTraceFromFilePath(tracePath);
  console.log('✓ Loaded. ID:', traceId, '\n');

  // ============================================================================
  // STEP 1: Check what data is available in the trace
  // ============================================================================
  console.log('═══════════════════════════════════════════════════════════');
  console.log('STEP 1: Available Data in Trace');
  console.log('═══════════════════════════════════════════════════════════\n');

  // Check actual_frame_timeline_slice
  const frameCheck = await traceProcessor.query(traceId, `
    SELECT
      COUNT(*) as total_frames,
      COUNT(DISTINCT a.upid) as unique_upids,
      COUNT(CASE WHEN a.jank_type != 'None' THEN 1 END) as janky_frames
    FROM actual_frame_timeline_slice a
  `);
  console.log('actual_frame_timeline_slice:');
  console.log('  Total frames:', frameCheck.rows[0]?.[0] || 0);
  console.log('  Unique processes:', frameCheck.rows[0]?.[1] || 0);
  console.log('  Janky frames:', frameCheck.rows[0]?.[2] || 0);

  // Check processes
  const processCheck = await traceProcessor.query(traceId, `
    SELECT DISTINCT p.name, COUNT(*) as frame_count
    FROM actual_frame_timeline_slice a
    JOIN process p ON a.upid = p.upid
    GROUP BY p.name
    ORDER BY frame_count DESC
    LIMIT 10
  `);
  console.log('\nTop processes with frame data:');
  processCheck.rows?.forEach((row: any) => {
    console.log(`  ${row[0]}: ${row[1]} frames`);
  });

  // ============================================================================
  // STEP 2: Execute scrolling analysis
  // ============================================================================
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('STEP 2: Executing Scrolling Analysis');
  console.log('═══════════════════════════════════════════════════════════\n');

  const result = await skillAdapter.analyze({
    traceId,
    question: '分析滑动性能',
  });

  console.log('✓ Analysis completed\n');

  // ============================================================================
  // STEP 3: Analyze result structure
  // ============================================================================
  console.log('═══════════════════════════════════════════════════════════');
  console.log('STEP 3: Result Structure Analysis');
  console.log('═══════════════════════════════════════════════════════════\n');

  // Check layered result
  const layers = result.layeredResult?.layers;
  if (layers) {
    console.log('L1 (Summary Layer):');
    const L1 = layers.L1 || {};
    for (const [stepId, stepResult] of Object.entries(L1)) {
      const r = stepResult as any;
      const dataLen = r.data?.length || 0;
      const success = r.success ? '✅' : '❌';
      const error = r.error ? ` (${r.error})` : '';
      console.log(`  ${success} ${stepId}: ${dataLen} rows${error}`);
    }

    console.log('\nL2 (Session Layer):');
    const L2 = layers.L2 || {};
    for (const [stepId, stepResult] of Object.entries(L2)) {
      const r = stepResult as any;
      const dataLen = r.data?.length || 0;
      const success = r.success ? '✅' : '❌';
      console.log(`  ${success} ${stepId}: ${dataLen} rows`);
    }

    console.log('\nL3 (Session Detail Layer):');
    const L3 = layers.L3 || {};
    const sessionIds = Object.keys(L3);
    console.log(`  Sessions: ${sessionIds.length}`);
    if (sessionIds.length > 0) {
      sessionIds.slice(0, 3).forEach(sid => {
        const steps = Object.keys(L3[sid] || {});
        console.log(`    ${sid}: ${steps.length} steps`);
      });
    }

    console.log('\nL4 (Frame Analysis Layer):');
    const L4 = layers.L4 || {};
    const l4SessionIds = Object.keys(L4);
    console.log(`  Sessions: ${l4SessionIds.length}`);
    if (l4SessionIds.length > 0) {
      l4SessionIds.slice(0, 2).forEach(sid => {
        const frames = L4[sid] || {};
        const frameIds = Object.keys(frames);
        console.log(`    ${sid}: ${frameIds.length} frames`);
        frameIds.slice(0, 3).forEach(fid => {
          const f = frames[fid] as any;
          const hasData = f.data?.length > 0;
          console.log(`      ${fid}: ${hasData ? '✅ has data' : '❌ empty'}`);
        });
      });
    }
  }

  // ============================================================================
  // STEP 4: Check displayResults
  // ============================================================================
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('STEP 4: Display Results (Frontend Data)');
  console.log('═══════════════════════════════════════════════════════════\n');

  const displayResults = result.displayResults || [];
  console.log(`Total display results: ${displayResults.length}\n`);

  displayResults.forEach((dr: any) => {
    const dataLen = dr.data ? (Array.isArray(dr.data) ? dr.data.length : 'object') : 0;
    const expandable = dr.data?.expandableData?.length || 0;
    console.log(`${dr.stepId}:`);
    console.log(`  Level: ${dr.level}, Layer: ${dr.layer || 'N/A'}`);
    console.log(`  Data: ${dataLen} rows`);
    if (expandable > 0) {
      console.log(`  Expandable items: ${expandable}`);
    }
    console.log('');
  });

  // ============================================================================
  // STEP 5: Check sections (legacy format)
  // ============================================================================
  console.log('═══════════════════════════════════════════════════════════');
  console.log('STEP 5: Sections (Legacy Format)');
  console.log('═══════════════════════════════════════════════════════════\n');

  const sections = result.sections || {};
  const sectionKeys = Object.keys(sections);
  console.log(`Total sections: ${sectionKeys.length}\n`);

  sectionKeys.slice(0, 10).forEach(key => {
    const section = sections[key];
    const rowCount = section.rowCount || section.data?.length || 0;
    console.log(`  ${key}: ${rowCount} rows`);
  });

  // ============================================================================
  // STEP 6: Save detailed JSON for inspection
  // ============================================================================
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('STEP 6: Saving Detailed Output');
  console.log('═══════════════════════════════════════════════════════════\n');

  const fs = require('fs');
  const outputPath = path.join(process.cwd(), 'test-output/user-trace-analysis.json');
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
  console.log('✓ Full result saved to:', outputPath);

  await traceProcessor.cleanup();
}

analyzeUserTrace().catch(console.error);
