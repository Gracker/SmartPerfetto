/**
 * Test Deep Layer Fix - Verify L4 frame details rendering
 */

import { getSkillAnalysisAdapter } from '../services/skillEngine/skillAnalysisAdapter';
import { getTraceProcessorService } from '../services/traceProcessorService';
import { getHTMLReportGenerator } from '../services/htmlReportGenerator';
import fs from 'fs';
import path from 'path';

async function testDeepLayerFix() {
  console.log('\n╔════════════════════════════════════════════════════════════════╗');
  console.log('║     Deep Layer Fix Verification Test                         ║');
  console.log('╚════════════════════════════════════════════════════════════════╝\n');

  // Use the scrolling test trace with actual jank data
  let testTracePath = path.join(
    process.cwd(),
    '../test-traces/app_aosp_scrolling_heavy_jank.pftrace'
  );

  if (!fs.existsSync(testTracePath)) {
    // Fallback to the lighter trace
    const fallbackPath = path.join(
      process.cwd(),
      '../test-traces/scrolling_with_blocked_nonblocked_frames.pftrace'
    );
    if (fs.existsSync(fallbackPath)) {
      testTracePath = fallbackPath;
      console.log('Using fallback trace:', path.basename(fallbackPath));
    } else {
      console.error('❌ No test trace found');
      process.exit(1);
    }
  }

  console.log('✓ Test trace:', path.basename(testTracePath));
  console.log('  Size:', (fs.statSync(testTracePath).size / 1024 / 1024).toFixed(2), 'MB\n');

  try {
    const traceProcessor = getTraceProcessorService();
    const skillAdapter = getSkillAnalysisAdapter(traceProcessor);

    console.log('⏳ Loading trace...');
    const traceId = await traceProcessor.loadTraceFromFilePath(testTracePath);
    console.log('✓ Trace loaded. ID:', traceId, '\n');

    console.log('⏳ Executing Scrolling Analysis...');
    const startTime = Date.now();

    const result = await skillAdapter.analyze({
      traceId,
      question: '分析滑动性能',
    });

    const duration = Date.now() - startTime;
    console.log(`✓ Analysis completed in ${duration}ms\n`);

    // Check deep layer data
    console.log('═══════════════════════════════════════════════════════════');
    console.log('DEEP LAYER DATA CHECK');
    console.log('═══════════════════════════════════════════════════════════');

    const deepLayer = result.layeredResult?.layers?.deep;
    if (deepLayer && Object.keys(deepLayer).length > 0) {
      console.log(`✅ Deep layer has ${Object.keys(deepLayer).length} sessions`);

      // Check first session's frames
      const firstSessionId = Object.keys(deepLayer)[0];
      const frames = deepLayer[firstSessionId];
      console.log(`   First session (${firstSessionId}) has ${Object.keys(frames).length} frames`);

      // Check frame detail data structure
      const firstFrameId = Object.keys(frames)[0];
      const firstFrame = frames[firstFrameId];
      console.log(`\n   Sample frame (${firstFrameId}):`);
      console.log(`     - Has diagnosis_summary: ${!!firstFrame.data?.diagnosis_summary}`);
      console.log(`     - Has full_analysis: ${!!firstFrame.data?.full_analysis}`);

      if (firstFrame.data?.full_analysis) {
        const analysis = firstFrame.data.full_analysis;
        console.log(`     - quadrants.main_thread: ${JSON.stringify(analysis.quadrants?.main_thread || {})}`);
        console.log(`     - binder_calls count: ${analysis.binder_calls?.length || 0}`);
        console.log(`     - main_thread_slices count: ${analysis.main_thread_slices?.length || 0}`);
        console.log(`     - cpu_frequency: ${JSON.stringify(analysis.cpu_frequency || {})}`);

        // Verify field mapping fix
        if (analysis.main_thread_slices?.length > 0) {
          const slice = analysis.main_thread_slices[0];
          console.log(`\n   Field mapping verification (main_thread_slices):`);
          console.log(`     - Has 'total_ms' (expected): ${slice.total_ms !== undefined}`);
          console.log(`     - Has 'dur_ms' (old): ${slice.dur_ms !== undefined}`);

          if (slice.total_ms !== undefined) {
            console.log('   ✅ Field mapping fix is working!');
          } else if (slice.dur_ms !== undefined) {
            console.log('   ❌ Field mapping not applied - still using old field name');
          }
        }
      }
    } else {
      console.log('⚠️ No deep layer data found');
    }

    // Generate HTML report
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('GENERATING HTML REPORT');
    console.log('═══════════════════════════════════════════════════════════');

    const reportGenerator = getHTMLReportGenerator();
    const htmlReport = reportGenerator.generateHTML({
      sessionId: 'test-session',
      traceId,
      question: '分析滑动性能',
      answer: result.summary || '分析完成',
      metrics: {
        totalDuration: result.executionTimeMs || 0,
        iterationsCount: 1,
        sqlQueriesCount: Object.keys(result.sections || {}).length,
      },
      collectedResults: [],
      skillEngineResult: {
        skillId: result.skillId,
        skillName: result.skillName,
        sections: result.sections || {},
        diagnostics: result.diagnostics || [],
        layeredResult: result.layeredResult,
      } as any,
      timestamp: Date.now(),
    });

    const outputPath = path.join(process.cwd(), 'test-output/deep-layer-fix-test.html');
    fs.writeFileSync(outputPath, htmlReport);
    console.log('✓ HTML report saved to:', outputPath);

    const jsonPath = path.join(process.cwd(), 'test-output/deep-layer-fix-test.json');
    fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2));
    console.log('✓ JSON result saved to:', jsonPath);

    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('✅ TEST COMPLETED - Please check the HTML report');
    console.log('═══════════════════════════════════════════════════════════');

  } catch (error: any) {
    console.error('\n❌ Test failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  } finally {
    await getTraceProcessorService().cleanup();
  }
}

testDeepLayerFix();
