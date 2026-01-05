/**
 * Comprehensive trace analysis - check all available data
 */

import { getSkillAnalysisAdapterV2 } from '../services/skillEngine/skillAnalysisAdapterV2';
import { getTraceProcessorService } from '../services/traceProcessorService';
import path from 'path';

async function analyzeComprehensive() {
  console.log('\n╔════════════════════════════════════════════════════════════════╗');
  console.log('║     User Trace - Comprehensive Analysis                      ║');
  console.log('╚════════════════════════════════════════════════════════════════╝\n');

  const tracePath = path.join(process.cwd(), 'uploads/traces/d717bd47-21bf-46ac-b546-05c77d45149e.trace');
  console.log('Trace:', path.basename(tracePath));
  console.log('Size:', (require('fs').statSync(tracePath).size / 1024 / 1024).toFixed(2), 'MB\n');

  const traceProcessor = getTraceProcessorService();
  const skillAdapter = getSkillAnalysisAdapterV2(traceProcessor);

  console.log('⏳ Loading trace...');
  const traceId = await traceProcessor.loadTraceFromFilePath(tracePath);
  console.log('✓ Loaded. ID:', traceId, '\n');

  // ============================================================================
  // Check ALL frame-related tables
  // ============================================================================
  console.log('═══════════════════════════════════════════════════════════');
  console.log('Frame-Related Tables Check');
  console.log('═══════════════════════════════════════════════════════════\n');

  const frameTables = [
    'actual_frame_timeline_slice',
    'expected_frame_timeline_slice',
    'frame_timeline',
    'surfaceflinger_transactions',
    'layer_stats',
    'gpu_slice',
    'android_monitor_content'
  ];

  for (const table of frameTables) {
    try {
      const result = await traceProcessor.query(traceId, `
        SELECT COUNT(*) as count FROM ${table} LIMIT 1
      `);
      const count = result.rows[0]?.[0] || 0;
      if (count > 0) {
        console.log(`✅ ${table}: ${count} rows`);
      } else {
        console.log(`⚠️  ${table}: 0 rows`);
      }
    } catch (e: any) {
      console.log(`❌ ${table}: Table not found (${e.message?.substring(0, 50)}...)`);
    }
  }

  // ============================================================================
  // Check what tables DO exist and have data
  // ============================================================================
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('Available Tables with Most Data');
  console.log('═══════════════════════════════════════════════════════════\n');

  // Check common tables
  const commonTables = [
    'slice',
    'sched',
    'process',
    'thread',
    'cpu',
    'f2fs',
    'binder',
    'dmabuf',
    'power'
  ];

  const tableCounts: any[] = [];
  for (const table of commonTables) {
    try {
      const result = await traceProcessor.query(traceId, `
        SELECT COUNT(*) as count FROM ${table}
      `);
      const count = result.rows[0]?.[0] || 0;
      if (count > 0) {
        tableCounts.push({ table, count });
      }
    } catch (e) {
      // Table doesn't exist, skip
    }
  }

  tableCounts.sort((a, b) => b.count - a.count);
  tableCounts.slice(0, 10).forEach(({ table, count }) => {
    console.log(`  ${table.padEnd(20)}: ${count.toLocaleString()} rows`);
  });

  // ============================================================================
  // Check process names in slice table
  // ============================================================================
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('Process Information (from slice table)');
  console.log('═══════════════════════════════════════════════════════════\n');

  try {
    const processes = await traceProcessor.query(traceId, `
      SELECT p.name, p.pid, COUNT(*) as slice_count
      FROM slice s
      JOIN process_track pt ON s.track_id = pt.id
      JOIN process p ON pt.upid = p.upid
      GROUP BY p.name, p.pid
      ORDER BY slice_count DESC
      LIMIT 15
    `);

    console.log('  Process Name                    PID    Slices');
    console.log('  ' + '─'.repeat(55));
    processes.rows?.forEach((row: any) => {
      const name = (row[0] || '(null)').substring(0, 30).padEnd(30);
      const pid = String(row[1] || '?').padStart(6);
      const count = String(row[2] || 0).padStart(8);
      console.log(`  ${name} ${pid} ${count}`);
    });
  } catch (e: any) {
    console.log('Error:', e.message);
  }

  // ============================================================================
  // Check for any scrolling-related events
  // ============================================================================
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('Scrolling-Related Events');
  console.log('═══════════════════════════════════════════════════════════\n');

  try {
    // Check for scroll-related slice names
    const scrollEvents = await traceProcessor.query(traceId, `
      SELECT name, COUNT(*) as count
      FROM slice
      WHERE name GLOB '*scroll*'
         OR name GLOB '*fling*'
         OR name GLOB '*touch*'
         OR name GLOB '*input*'
         OR name GLOB '*gesture*'
      GROUP BY name
      ORDER BY count DESC
      LIMIT 10
    `);

    if (scrollEvents.rows && scrollEvents.rows.length > 0) {
      console.log('Found scrolling-related events:');
      scrollEvents.rows.forEach((row: any) => {
        console.log(`  ${row[0]}: ${row[1]} events`);
      });
    } else {
      console.log('⚠️  No scrolling-related events found');
    }
  } catch (e: any) {
    console.log('Error checking scroll events:', e.message);
  }

  // ============================================================================
  // Try running scrolling analysis
  // ============================================================================
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('Scrolling Analysis Result');
  console.log('═══════════════════════════════════════════════════════════\n');

  const result = await skillAdapter.analyze({
    traceId,
    question: '分析滑动性能',
  });

  const env = result.layeredResult?.layers?.L1?.detect_environment?.data?.[0];
  console.log('Environment Detection:');
  console.log(`  Frame Data Status: ${env?.frame_data_status || 'N/A'}`);
  console.log(`  Total Frames: ${env?.total_frames || 0}`);
  console.log(`  App Count: ${env?.app_count || 0}`);

  const L1 = result.layeredResult?.layers?.L1 || {};
  const jankFrames = L1.get_jank_frames as any;
  const jankStats = L1.jank_type_stats as any;
  const perfSummary = L1.frame_performance_summary as any;

  console.log('\nAnalysis Results:');
  console.log(`  get_jank_frames: ${jankFrames?.success ? '✅' : '❌'} (${jankFrames?.error || jankFrames?.data?.length || 0} rows)`);
  console.log(`  jank_type_stats: ${jankStats?.success ? '✅' : '❌'} (${jankStats?.error || jankStats?.data?.length || 0} rows)`);
  console.log(`  frame_performance_summary: ${perfSummary?.success ? '✅' : '❌'} (${perfSummary?.error || perfSummary?.data?.length || 0} rows)`);

  // ============================================================================
  // Summary and Recommendations
  // ============================================================================
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('SUMMARY & RECOMMENDATIONS');
  console.log('═══════════════════════════════════════════════════════════\n');

  if ((env?.total_frames || 0) === 0) {
    console.log('⚠️  ISSUE: No Frame Timeline Data Found\n');
    console.log('This trace does NOT contain actual_frame_timeline_slice data.');
    console.log('This is required for scrolling performance analysis.\n');
    console.log('Possible causes:');
    console.log('  1. Trace was captured without Android Frame Timeline enabled');
    console.log('  2. Device API level < 29 (Android 10)');
    console.log('  3. Perfetto config missing frame_timeline data source\n');
    console.log('To fix:');
    console.log('  • Use Perfetto config with: android.surface_flinger.frametimeline');
    console.log('  • Capture on Android 10+ device');
    console.log('  • Enable frame tracking in Perfetto UI: "Frame timelines" checkbox');
  } else {
    console.log('✅ Frame data found, analysis should work');
  }

  // Save full result
  const fs = require('fs');
  const outputPath = path.join(process.cwd(), 'test-output/user-trace-full-analysis.json');
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
  console.log(`\n✓ Full result saved to: ${outputPath}`);

  await traceProcessor.cleanup();
}

analyzeComprehensive().catch(console.error);
