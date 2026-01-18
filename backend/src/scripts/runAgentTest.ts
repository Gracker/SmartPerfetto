import { getTraceProcessorService } from '../services/traceProcessorService';
import {
  createOrchestrator,
  createScrollingExpertAgent,
  registerCoreTools,
  createLLMClient,
  LLMConfigurationError,
  StreamingUpdate,
  getAgentTraceRecorder,
  createEvalSystem,
} from '../agent';
import fs from 'fs';
import path from 'path';

async function runAgentTest() {
  console.log('\n╔════════════════════════════════════════════════════════════════╗');
  console.log('║     Agent System Integration Test                              ║');
  console.log('╚════════════════════════════════════════════════════════════════╝\n');

  const testTracePath = path.join(
    process.cwd(),
    '../test-traces/app_aosp_scrolling_heavy_jank.pftrace'
  );

  if (!fs.existsSync(testTracePath)) {
    console.error('❌ Test trace not found:', testTracePath);
    console.log('\nPlease ensure the test trace exists at:', testTracePath);
    process.exit(1);
  }

  console.log('✓ Test trace found:', path.basename(testTracePath));
  console.log('  Size:', (fs.statSync(testTracePath).size / 1024 / 1024).toFixed(2), 'MB\n');

  if (process.argv.includes('--mock')) {
    console.error('❌ Mock mode has been removed. Please configure a real LLM API key.');
    console.error('   Set DEEPSEEK_API_KEY or OPENAI_API_KEY environment variable.');
    process.exit(1);
  }
  console.log('LLM Mode: Real (DeepSeek/OpenAI API)');
  console.log('');

  try {
    const traceProcessor = getTraceProcessorService();
    
    console.log('⏳ Loading trace into TraceProcessor...');
    const traceId = await traceProcessor.loadTraceFromFilePath(testTracePath);
    console.log('✓ Trace loaded. ID:', traceId, '\n');

    console.log('⏳ Initializing Agent System...');
    
    const llm = createLLMClient();
    registerCoreTools();
    
    const orchestrator = createOrchestrator(llm);
    
    const scrollingExpert = createScrollingExpertAgent(llm);
    scrollingExpert.setTraceProcessorService(traceProcessor, traceId);
    orchestrator.registerExpert(scrollingExpert);
    orchestrator.setTraceProcessorService(traceProcessor, traceId);
    
    console.log('✓ Agent system initialized');
    console.log('  - Orchestrator: PerfettoOrchestratorAgent');
    console.log('  - Experts: ScrollingExpertAgent');
    console.log('  - Tools: execute_sql, analyze_frame, calculate_stats');
    console.log('');

    const testQueries = [
      '分析这个 trace 的滑动性能',
      'Why is this trace dropping frames?',
    ];

    for (const query of testQueries) {
      console.log('═══════════════════════════════════════════════════════════');
      console.log('Query:', query);
      console.log('═══════════════════════════════════════════════════════════\n');

      const startTime = Date.now();

      const streamingCallback = (update: StreamingUpdate) => {
        const prefix = getUpdatePrefix(update.type);
        console.log(`${prefix} ${formatUpdateContent(update)}`);
      };

      const result = await orchestrator.handleQuery(query, traceId, {
        streamingCallback,
        maxExpertIterations: 3,
        confidenceThreshold: 0.7,
      });

      const duration = Date.now() - startTime;

      console.log('\n─ Results ─'.padEnd(60, '─'));
      console.log('Execution Time:', duration + 'ms');
      console.log('Confidence:', (result.confidence * 100).toFixed(1) + '%');
      console.log('');

      console.log('Intent:');
      console.log('  Goal:', result.intent.primaryGoal);
      console.log('  Aspects:', result.intent.aspects.join(', '));
      console.log('  Complexity:', result.intent.complexity);
      console.log('');

      console.log('Plan:');
      const tasks = result.plan.tasks || [];
      if (tasks.length === 0) {
        console.log('  (No tasks planned)');
      } else {
        tasks.forEach((task, i) => {
          console.log(`  ${i + 1}. [${task.expertAgent}] ${task.objective}`);
        });
      }
      console.log('');

      console.log('Expert Results:', result.expertResults.length);
      result.expertResults.forEach((er, i) => {
        console.log(`  Expert ${i + 1}: ${er.findings.length} findings, confidence ${(er.confidence * 100).toFixed(1)}%`);
        er.findings.slice(0, 3).forEach(f => {
          console.log(`    - [${f.severity}] ${f.title}`);
        });
        if (er.findings.length > 3) {
          console.log(`    ... and ${er.findings.length - 3} more findings`);
        }
      });
      console.log('');

      console.log('Synthesized Answer:');
      console.log('─'.repeat(60));
      console.log(result.synthesizedAnswer);
      console.log('─'.repeat(60));
      console.log('');

      console.log('Trace Summary:');
      console.log('  Total Duration:', result.trace.totalDuration + 'ms');
      console.log('  Expert Traces:', result.trace.expertTraces.length);
      console.log('');
    }

    const outputDir = path.join(process.cwd(), 'test-output');
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const jsonPath = path.join(outputDir, 'agent-test-result.json');
    fs.writeFileSync(jsonPath, JSON.stringify({
      timestamp: new Date().toISOString(),
      traceId,
      tracePath: testTracePath,
    }, null, 2));
    console.log('✓ Test metadata saved to:', jsonPath);
    console.log('');

    console.log('─ Trace Recorder Statistics ─'.padEnd(60, '─'));
    const recorder = getAgentTraceRecorder({ outputDir: path.join(outputDir, 'agent-traces') });
    const stats = recorder.getStatistics();
    console.log('Total traces recorded:', stats.totalTraces);
    console.log('Avg duration:', stats.avgDurationMs + 'ms');
    console.log('Avg confidence:', (stats.avgConfidence * 100).toFixed(1) + '%');
    console.log('Avg tool calls:', stats.avgToolCalls);
    console.log('');

    console.log('═══════════════════════════════════════════════════════════');
    console.log('AGENT TEST COMPLETED SUCCESSFULLY');
    console.log('═══════════════════════════════════════════════════════════');

    await traceProcessor.deleteTrace(traceId);
    console.log('✓ Cleanup completed');

  } catch (error) {
    console.error('\n❌ Test failed with error:');
    console.error(error);
    process.exit(1);
  }
}

function getUpdatePrefix(type: StreamingUpdate['type']): string {
  switch (type) {
    case 'progress': return '⏳';
    case 'thought': return '💭';
    case 'finding': return '🔍';
    case 'conclusion': return '✅';
    default: return '  ';
  }
}

function formatUpdateContent(update: StreamingUpdate): string {
  if (typeof update.content === 'string') {
    return update.content;
  }
  if (update.type === 'finding') {
    const finding = update.content as any;
    return `[${finding.severity}] ${finding.title}`;
  }
  if (update.type === 'thought') {
    const thought = update.content as any;
    if (thought.intent) {
      return `Intent: ${thought.intent.primaryGoal}`;
    }
    return JSON.stringify(thought);
  }
  return JSON.stringify(update.content);
}

runAgentTest().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
