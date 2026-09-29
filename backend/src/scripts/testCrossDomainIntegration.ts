// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Integration Test for Cross-Domain Expert System
 *
 * Tests the full dialogue flow with a real trace file.
 * Run with: npx ts-node src/scripts/testCrossDomainIntegration.ts
 */

import * as path from 'path';
import { uuidv4 } from '../utils/uuid';
import { ensureSkillRegistryInitialized } from '../services/skillEngine/skillLoader';
import { TraceProcessorService } from '../services/traceProcessorService';
import {
  moduleCatalog,
  createPerformanceExpert,
  CrossDomainEvent,
  CrossDomainOutput,
  CrossDomainInput,
} from '../agent/experts/crossDomain';

// Colors for console output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
};

function log(color: keyof typeof colors, message: string) {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function logSection(title: string) {
  console.log('\n' + '='.repeat(70));
  log('bright', title);
  console.log('='.repeat(70));
}

// Test trace file path (relative from backend directory)
const TEST_TRACE = path.resolve(
  process.cwd(),
  '../perfetto/test/data/scrolling_with_blocked_nonblocked_frames_new.pftrace'
);

async function runIntegrationTest() {
  console.log('\n');
  log('bright', '╔════════════════════════════════════════════════════════════════════╗');
  log('bright', '║       Cross-Domain Expert Integration Test                         ║');
  log('bright', '╚════════════════════════════════════════════════════════════════════╝');

  // =========================================================================
  // Step 1: Initialize Skills
  // =========================================================================
  logSection('Step 1: Initialize Skills');

  try {
    await ensureSkillRegistryInitialized();
    await moduleCatalog.initialize();
    log('green', '✓ Skills and module catalog initialized');
  } catch (error: any) {
    log('red', `✗ Initialization failed: ${error.message}`);
    process.exit(1);
  }

  // =========================================================================
  // Step 2: Start Trace Processor
  // =========================================================================
  logSection('Step 2: Start Trace Processor');

  const traceService = new TraceProcessorService();
  let traceId: string;

  try {
    // Load trace file
    log('cyan', `Loading trace: ${TEST_TRACE}`);
    traceId = await traceService.loadTraceFromFilePath(TEST_TRACE);
    log('green', `✓ Trace loaded: ${traceId}`);

    // Wait for processing to complete
    let retries = 0;
    const maxRetries = 30;
    while (retries < maxRetries) {
      const traceInfo = traceService.getTrace(traceId);
      if (traceInfo?.status === 'ready') {
        break;
      } else if (traceInfo?.status === 'error') {
        throw new Error(`Trace processing error: ${traceInfo.error}`);
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
      retries++;
    }

    const traceInfo = traceService.getTrace(traceId);
    if (traceInfo?.status !== 'ready') {
      throw new Error('Trace processing timeout');
    }

    const port = traceService.getProcessorPort(traceId);
    log('cyan', `  RPC Port: ${port}`);
    log('green', `✓ Trace processor ready`);
  } catch (error: any) {
    log('red', `✗ Failed to load trace: ${error.message}`);
    process.exit(1);
  }

  // =========================================================================
  // Step 3: Create PerformanceExpert
  // =========================================================================
  logSection('Step 3: Create PerformanceExpert');

  const expert = createPerformanceExpert();
  const events: CrossDomainEvent[] = [];

  // Listen to events (multiple event channels)
  const handleEvent = (event: any) => {
    events.push(event);

    const icon: Record<string, string> = {
      'dialogue_started': '🚀',
      'turn_started': '🔄',
      'module_queried': '❓',
      'module_responded': '💬',
      'finding_discovered': '🔍',
      'hypothesis_created': '💡',
      'hypothesis_updated': '🔬',
      'decision_made': '🎯',
      'conclusion_reached': '✅',
      'user_intervention_needed': '⚠️',
      'dialogue_completed': '🏁',
      'error': '❌',
    };

    const eventType = event.type || 'unknown';
    const turnNumber = event.turnNumber ?? event.turn ?? 0;
    log('cyan', `  ${icon[eventType] || '📌'} [Turn ${turnNumber}] ${eventType}`);

    if (eventType === 'module_queried') {
      log('magenta', `     → Module: ${event.data?.targetModule}, Question: ${event.data?.questionId}`);
    } else if (eventType === 'module_responded') {
      log('magenta', `     ← Findings: ${event.data?.findingsCount || 0}, Suggestions: ${event.data?.suggestionsCount || 0}`);
    } else if (eventType === 'hypothesis_updated') {
      log('magenta', `     Confidence: ${((event.data?.confidence || 0) * 100).toFixed(1)}%`);
    }
  };

  // Subscribe to all event channels
  expert.on('expert_event', handleEvent);
  expert.on('dialogue_event', handleEvent);
  expert.on('skill_event', handleEvent);

  log('green', `✓ PerformanceExpert created`);
  log('cyan', `  Domain: ${expert.config.domain}`);
  log('cyan', `  Entry modules: ${expert.config.entryModules.join(', ')}`);

  // =========================================================================
  // Step 4: Execute Cross-Domain Analysis
  // =========================================================================
  logSection('Step 4: Execute Cross-Domain Analysis');

  log('blue', 'Query: "分析这个 trace 的滑动性能问题"');
  log('cyan', '\nDialogue events:');

  try {
    const input: CrossDomainInput = {
      sessionId: uuidv4(),
      traceId,
      query: '分析这个 trace 的滑动性能问题',
      intentCategory: 'SCROLLING',
      traceProcessorService: traceService,
      packageName: 'com.android.systemui', // Fallback package for test
    };

    const output: CrossDomainOutput = await expert.analyze(input);

    log('green', '\n✓ Analysis completed!');

    // =========================================================================
    // Step 5: Validate Results
    // =========================================================================
    logSection('Step 5: Validate Results');

    // Check dialogue stats
    log('blue', 'Dialogue Statistics:');
    log('cyan', `  Total turns: ${output.dialogueStats.totalTurns}`);
    log('cyan', `  Modules queried: ${output.dialogueStats.modulesQueried.join(', ') || 'none'}`);
    log('cyan', `  Hypotheses explored: ${output.dialogueStats.hypothesesExplored}`);
    log('cyan', `  Total execution time: ${output.dialogueStats.totalExecutionTimeMs}ms`);

    // Check conclusion
    log('blue', '\nConclusion:');
    if (output.conclusion) {
      log('cyan', `  Category: ${output.conclusion.category}`);
      log('cyan', `  Component: ${output.conclusion.component}`);
      log('cyan', `  Summary: ${output.conclusion.summary.substring(0, 100)}...`);
      log('cyan', `  Confidence: ${((output.conclusion.confidence || 0) * 100).toFixed(1)}%`);
      log('cyan', `  Evidence count: ${output.conclusion.evidence?.length || 0}`);
      if (output.conclusion.suggestions?.length) {
        log('cyan', `  Suggestions: ${output.conclusion.suggestions.length}`);
        for (const sug of output.conclusion.suggestions.slice(0, 3)) {
          log('cyan', `    - ${sug}`);
        }
      }
    } else {
      log('yellow', '  No conclusion generated');
    }

    // Check findings
    log('blue', `\nFindings: ${output.findings.length}`);
    for (const finding of output.findings.slice(0, 5)) {
      log('cyan', `  - [${finding.severity}] ${finding.title}`);
    }

    // Check events
    log('blue', '\nEvent Summary:');
    const eventCounts: Record<string, number> = {};
    for (const event of events) {
      eventCounts[event.type] = (eventCounts[event.type] || 0) + 1;
    }
    for (const [type, count] of Object.entries(eventCounts)) {
      log('cyan', `  ${type}: ${count}`);
    }

    // =========================================================================
    // Step 6: Test Summary
    // =========================================================================
    logSection('Test Summary');

    const checks = [
      { name: 'Skills initialized', pass: true },
      { name: 'Trace loaded', pass: !!traceId },
      { name: 'Expert created', pass: !!expert },
      { name: 'Dialogue completed', pass: output.dialogueStats.totalTurns > 0 },
      { name: 'Events emitted', pass: events.length > 0 },
      { name: 'Modules queried', pass: output.dialogueStats.modulesQueried.length > 0 },
      { name: 'Analysis succeeded', pass: output.success },
    ];

    let passCount = 0;
    for (const check of checks) {
      if (check.pass) {
        log('green', `  ✓ ${check.name}`);
        passCount++;
      } else {
        log('red', `  ✗ ${check.name}`);
      }
    }

    console.log('\n' + '-'.repeat(50));
    if (passCount === checks.length) {
      log('green', `All checks passed! (${passCount}/${checks.length})`);
    } else {
      log('yellow', `${passCount}/${checks.length} checks passed`);
    }

  } catch (error: any) {
    log('red', `\n✗ Analysis failed: ${error.message}`);
    console.error(error.stack);
  } finally {
    // Cleanup
    logSection('Cleanup');
    try {
      await traceService.cleanup(0, 0); // Force cleanup
      log('green', '✓ Trace processor stopped');
    } catch (e) {
      log('yellow', '⚠ Cleanup warning (may be already stopped)');
    }
  }

  process.exit(0);
}

// Run test
runIntegrationTest().catch((error) => {
  log('red', `Fatal error: ${error.message}`);
  console.error(error.stack);
  process.exit(1);
});
