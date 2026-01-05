/**
 * Scrolling Skill Test Runner with Real Frame Data
 *
 * Uses chrome_android_systrace.pftrace which contains actual frame data
 * to verify the complete scrolling analysis functionality.
 */

import { getSkillAnalysisAdapterV2 } from '../services/skillEngine/skillAnalysisAdapterV2';
import { getTraceProcessorService } from '../services/traceProcessorService';
import { getHTMLReportGenerator } from '../services/htmlReportGenerator';
import fs from 'fs';
import path from 'path';

async function runScrollingTestWithRealData() {
  console.log('\n╔════════════════════════════════════════════════════════════════╗');
  console.log('║     Scrolling Skill Test - Real Frame Data                  ║');
  console.log('╚════════════════════════════════════════════════════════════════╝\n');

  // Use Chrome Android trace (43MB) - has actual frame data
  const testTracePath = path.join(
    process.cwd(),
    '../perfetto/test/data/chrome_android_systrace.pftrace'
  );

  if (!fs.existsSync(testTracePath)) {
    console.error('❌ Test trace not found:', testTracePath);
    process.exit(1);
  }

  console.log('✓ Test trace found:', path.basename(testTracePath));
  console.log('  Size:', (fs.statSync(testTracePath).size / 1024 / 1024).toFixed(2), 'MB\n');

  try {
    const traceProcessor = getTraceProcessorService();
    const skillAdapter = getSkillAnalysisAdapterV2(traceProcessor);

    console.log('⏳ Loading trace into TraceProcessor...');
    const traceId = await traceProcessor.loadTraceFromFilePath(testTracePath);
    console.log('✓ Trace loaded. ID:', traceId, '\n');

    console.log('⏳ Executing Scrolling Skill...');
    console.log('─'.repeat(60));
    const startTime = Date.now();

    // Test with empty package to analyze all apps
    const result = await skillAdapter.analyze({
      traceId,
      question: '分析滑动性能',
    });

    const duration = Date.now() - startTime;
    console.log('─'.repeat(60));
    console.log(`✓ Skill execution completed in ${duration}ms\n`);

    // Check if frame data was detected
    const envData = result.layeredResult?.layers?.L1?.detect_environment?.data;
    if (envData && envData.length > 0) {
      const frameStatus = envData[0].frame_data_status;
      const totalFrames = envData[0].total_frames;

      console.log('═══════════════════════════════════════════════════════════');
      console.log('FRAME DATA DETECTION');
      console.log('═══════════════════════════════════════════════════════════');
      console.log(`Frame Data Status: ${frameStatus}`);
      console.log(`Total Frames: ${totalFrames}`);

      if (frameStatus === 'available' && totalFrames > 0) {
        console.log('✅ Frame data detected - analysis should have run successfully\n');

        // Check condition-dependent steps
        const L1 = result.layeredResult?.layers?.L1 || {};
        const conditionSteps = [
          'get_jank_frames',
          'jank_type_stats',
          'frame_performance_summary',
          'calculate_fps_by_phase',
        ];

        console.log('Condition-Dependent Steps Execution:');
        let allExecuted = true;
        for (const stepId of conditionSteps) {
          const step = L1[stepId];
          const executed = step?.success === true;
          const status = executed ? '✅ Executed' : '❌ Skipped/Failed';
          const dataCount = step?.data?.length || 0;
          console.log(`  ${stepId}: ${status} (${dataCount} rows)`);
          if (!executed) allExecuted = false;
        }

        if (allExecuted) {
          console.log('\n✅ ALL CONDITION STEPS EXECUTED - FIX VERIFIED!');
        } else {
          console.log('\n⚠️  Some steps were skipped - check conditions');
        }
      } else {
        console.log('⚠️  No frame data found - this trace may not have scrolling events');
      }
    }

    // Generate HTML report
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('GENERATING REPORTS');
    console.log('═══════════════════════════════════════════════════════════');

    const reportGenerator = getHTMLReportGenerator();
    const htmlReport = reportGenerator.generateHTML({
      traceId,
      analysisResult: result,
      traceFile: path.basename(testTracePath),
    } as any);

    const outputPath = path.join(process.cwd(), 'test-output/scrolling-test-real-data.html');
    fs.writeFileSync(outputPath, htmlReport);
    console.log('✓ HTML report saved to:', outputPath);

    const jsonPath = path.join(process.cwd(), 'test-output/scrolling-test-real-data.json');
    fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2));
    console.log('✓ JSON result saved to:', jsonPath);

    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('TEST COMPLETED');
    console.log('═══════════════════════════════════════════════════════════');

  } catch (error: any) {
    console.error('\n❌ Test failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  } finally {
    await getTraceProcessorService().cleanup();
  }
}

runScrollingTestWithRealData();
