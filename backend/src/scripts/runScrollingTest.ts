/**
 * Scrolling Skill Test Runner
 *
 * Run automated tests for Scrolling Skill without UI
 * This helps identify issues in the layered architecture implementation
 */

import { getSkillAnalysisAdapter } from '../services/skillEngine/skillAnalysisAdapter';
import { getTraceProcessorService } from '../services/traceProcessorService';
import { getHTMLReportGenerator } from '../services/htmlReportGenerator';
import { AnalysisState } from '../types/analysis';
import fs from 'fs';
import path from 'path';

async function runScrollingSkillTest() {
  console.log('\n╔════════════════════════════════════════════════════════════════╗');
  console.log('║     Scrolling Skill Automated Test Runner                     ║');
  console.log('╚════════════════════════════════════════════════════════════════╝\n');

  // Test trace path
  const testTracePath = path.join(
    process.cwd(),
    '../test-traces/app_aosp_scrolling_heavy_jank.pftrace'
  );

  if (!fs.existsSync(testTracePath)) {
    console.error('❌ Test trace not found:', testTracePath);
    console.log('\nAvailable traces in perfetto/test/data:');
    const traceDir = path.join(process.cwd(), '../perfetto/test/data');
    const files = fs.readdirSync(traceDir).filter(f => f.endsWith('.pftrace'));
    files.forEach(f => console.log('  -', f));
    process.exit(1);
  }

  console.log('✓ Test trace found:', path.basename(testTracePath));
  console.log('  Size:', (fs.statSync(testTracePath).size / 1024 / 1024).toFixed(2), 'MB\n');

  try {
    // Initialize services
    const traceProcessor = getTraceProcessorService();
    const skillAdapter = getSkillAnalysisAdapter(traceProcessor);

    // Load trace
    console.log('⏳ Loading trace into TraceProcessor...');
    const traceId = await traceProcessor.loadTraceFromFilePath(testTracePath);
    console.log('✓ Trace loaded. ID:', traceId, '\n');

    // Execute Scrolling Skill
    console.log('⏳ Executing Scrolling Skill...');
    console.log('─'.repeat(60));
    const startTime = Date.now();

    const result = await skillAdapter.analyze({
      traceId,
      question: '分析滑动性能',
    });

    const duration = Date.now() - startTime;
    console.log('─'.repeat(60));
    console.log(`✓ Skill execution completed in ${duration}ms\n`);

    // Validate results
    console.log('═══════════════════════════════════════════════════════════');
    console.log('RESULT VALIDATION');
    console.log('═══════════════════════════════════════════════════════════\n');

    // 1. Basic success check
    console.log('1. Basic Success Check:');
    console.log('   Success:', result.success ? '✓' : '✗');
    console.log('   Skill:', result.skillName);
    console.log('   Execution Time:', result.executionTimeMs + 'ms');
    console.log('   Has LayeredResult:', result.layeredResult ? '✓' : '✗');
    console.log('   Has Sections:', result.sections ? '✓' : '✗');
    console.log('');

    // 2. LayeredResult structure
    if (result.layeredResult) {
      console.log('2. LayeredResult Structure:');
      const layers = result.layeredResult.layers;
      console.log('   overview steps:', Object.keys(layers.overview || {}).length);
      console.log('     ', Object.keys(layers.overview || {}));
      console.log('   list steps:', Object.keys(layers.list || {}).length);
      console.log('     ', Object.keys(layers.list || {}));
      console.log('   session entries:', Object.keys(layers.session || {}).length);
      console.log('   deep entries:', Object.keys(layers.deep || {}).length);
      console.log('');

      // 3. Overview data validation
      console.log('3. Overview Data Validation:');
      if (layers.overview && layers.overview.detect_environment) {
        const envData = layers.overview.detect_environment.data;
        console.log('   detect_environment:');
        console.log('     Type:', Array.isArray(envData) ? 'array' : typeof envData);
        console.log('     Length:', Array.isArray(envData) ? envData.length : 'N/A');
        if (Array.isArray(envData) && envData.length > 0) {
          console.log('     First row:', JSON.stringify(envData[0], null, 2));
        }
      } else {
        console.log('   ✗ detect_environment not found');
      }
      console.log('');

      // 4. Sections validation
      console.log('4. Sections (displayResults conversion):');
      if (result.sections) {
        const sectionKeys = Object.keys(result.sections);
        console.log('   Total sections:', sectionKeys.length);
        console.log('   Sections:', sectionKeys.slice(0, 10).join(', '), sectionKeys.length > 10 ? '...' : '');

        // Check detect_environment section
        if (result.sections.detect_environment) {
          const sec = result.sections.detect_environment;
          console.log('\n   detect_environment section:');
          console.log('     Has data:', !!sec.data);
          console.log('     Data type:', Array.isArray(sec.data) ? 'array' : typeof sec.data);
          console.log('     Data length:', Array.isArray(sec.data) ? sec.data.length : 'N/A');
          console.log('     Has columns:', !!sec.columns);
          console.log('     Columns:', sec.columns);
          if (Array.isArray(sec.data) && sec.data.length > 0) {
            console.log('     First row:', JSON.stringify(sec.data[0], null, 2));
          }
        }
      }
      console.log('');

      // 5. Deep structure
      console.log('5. Deep Frame Structure:');
      if (layers.deep) {
        const sessionIds = Object.keys(layers.deep);
        console.log('   Sessions:', sessionIds.length);
        if (sessionIds.length > 0) {
          const firstSession = sessionIds[0];
          const frames = layers.deep[firstSession];
          console.log('   First session:', firstSession);
          console.log('   Frames:', Object.keys(frames).length);
          const firstFrameId = Object.keys(frames)[0];
          const firstFrame = frames[firstFrameId];
          console.log('   First frame:', firstFrameId);
          console.log('     Has data:', !!firstFrame.data);
          console.log('     Data type:', Array.isArray(firstFrame.data) ? 'array' : typeof firstFrame.data);
          console.log('     Data length:', Array.isArray(firstFrame.data) ? firstFrame.data.length : 'N/A');
        }
      }
      console.log('');
    }

    // 6. Diagnostics
    if (result.diagnostics && result.diagnostics.length > 0) {
      console.log('6. Diagnostics:');
      result.diagnostics.forEach(d => {
        console.log(`   [${d.severity}] ${d.id}: ${d.message}`);
      });
      console.log('');
    }

    // 7. Generate HTML report
    console.log('7. Generating HTML Report...');
    const outputDir = path.join(process.cwd(), 'test-output');
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const session = {
      id: 'test-scrolling-session',
      traceId,
      question: '分析滑动性能',
      status: AnalysisState.COMPLETED,
      createdAt: new Date(),
      updatedAt: new Date(),
      messages: [],
      currentIteration: 1,
      maxIterations: 10,
      collectedResults: [],
      stepsCompleted: 1,
      skillEngineResult: {
        skillId: 'scrolling_analysis',
        skillName: '滑动性能分析',
        sections: result.sections || {},
        diagnostics: result.diagnostics || [],
        executionTimeMs: result.executionTimeMs,
        layeredResult: result.layeredResult,
      },
    };

    const htmlGenerator = getHTMLReportGenerator();
    const html = await htmlGenerator.generateFromSession(session, result.directAnswer || 'Test answer');

    const htmlPath = path.join(outputDir, 'scrolling-skill-test-report.html');
    fs.writeFileSync(htmlPath, html);
    console.log('   ✓ HTML report saved to:', htmlPath);
    console.log('');

    // 8. Save JSON output for debugging
    const jsonPath = path.join(outputDir, 'scrolling-skill-test-result.json');
    fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2));
    console.log('   ✓ JSON result saved to:', jsonPath);
    console.log('');

    console.log('═══════════════════════════════════════════════════════════');
    console.log('TEST COMPLETED SUCCESSFULLY');
    console.log('═══════════════════════════════════════════════════════════');

    // Cleanup
    await traceProcessor.deleteTrace(traceId);
    console.log('✓ Cleanup completed');

  } catch (error) {
    console.error('\n❌ Test failed with error:');
    console.error(error);
    process.exit(1);
  }
}

// Run the test
runScrollingSkillTest().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
