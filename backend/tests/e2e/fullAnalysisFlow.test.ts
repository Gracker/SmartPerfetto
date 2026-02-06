/**
 * Full Analysis Flow End-to-End Tests
 *
 * Tests the complete analysis pipeline from query submission to result delivery:
 * 1. Full Scrolling Analysis Flow
 * 2. Multi-Turn Conversation
 * 3. SSE Event Sequence Validation
 * 4. Data Integrity Validation
 *
 * These tests require longer timeouts (up to 120 seconds) as they exercise
 * the full agent-driven analysis pipeline including LLM calls.
 *
 * Prerequisites:
 * - Backend running with trace_processor_shell available
 * - Test traces in ../test-traces/ directory
 * - AI service configured in .env (or tests will use degraded/fallback mode)
 *
 * Run with:
 *   npm test -- tests/e2e/fullAnalysisFlow.test.ts --forceExit
 *
 * Run specific test:
 *   npm test -- tests/e2e/fullAnalysisFlow.test.ts --testNamePattern="Full Scrolling" --forceExit
 *
 * Note: --forceExit is recommended because trace_processor_shell may keep
 * ports open that Jest doesn't automatically clean up.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from '@jest/globals';
import request from 'supertest';
import { createTestApp, loadTestTrace, cleanupTrace, wait } from '../integration/testApp';

// =============================================================================
// Test Configuration
// =============================================================================

// Longer timeout for E2E tests (analysis can take 30-120 seconds)
const E2E_TIMEOUT = 180000; // 3 minutes
const SSE_TIMEOUT = 120000; // 2 minutes for SSE collection

// Test traces
const SCROLLING_TRACE = 'app_aosp_scrolling_light.pftrace';
const HEAVY_JANK_TRACE = 'app_aosp_scrolling_heavy_jank.pftrace';

// =============================================================================
// Types for Test Assertions
// =============================================================================

interface SSEEvent {
  event: string;
  data: any;
}

interface AnalysisResult {
  success: boolean;
  sessionId: string;
  conclusion?: string;
  confidence?: number;
  findings?: any[];
  rounds?: number;
}

// =============================================================================
// Global State for Cleanup
// =============================================================================

// Track active sessions for cleanup
const activeSessions: Set<string> = new Set();

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Collect SSE events from a stream URL
 * Uses raw HTTP to avoid supertest hanging issues
 */
async function collectSSEFromUrl(
  app: ReturnType<typeof createTestApp>,
  sessionId: string,
  timeoutMs: number = SSE_TIMEOUT
): Promise<SSEEvent[]> {
  const events: SSEEvent[] = [];
  let resolved = false;

  return new Promise((resolve) => {
    const safeResolve = (result: SSEEvent[]) => {
      if (!resolved) {
        resolved = true;
        resolve(result);
      }
    };

    const timeout = setTimeout(() => {
      console.log(`[E2E] SSE timeout reached after ${timeoutMs}ms, collected ${events.length} events`);
      safeResolve(events);
    }, timeoutMs);

    const req = request(app)
      .get(`/api/agent/${sessionId}/stream`)
      .set('Accept', 'text/event-stream')
      .buffer(false)
      .parse((res, callback) => {
        let buffer = '';
        let currentEvent = '';
        let currentData = '';

        res.on('data', (chunk: Buffer) => {
          buffer += chunk.toString();

          // Parse SSE events
          const lines = buffer.split('\n');
          buffer = lines.pop() || ''; // Keep incomplete line in buffer

          for (const line of lines) {
            if (line.startsWith('event:')) {
              currentEvent = line.slice(6).trim();
            } else if (line.startsWith('data:')) {
              currentData = line.slice(5).trim();
            } else if (line === '' && currentEvent && currentData) {
              try {
                const data = JSON.parse(currentData);
                events.push({ event: currentEvent, data });

                console.log(`[E2E] SSE Event: ${currentEvent}`);

                // Check for terminal events
                if (currentEvent === 'end' || currentEvent === 'analysis_completed' || currentEvent === 'error') {
                  clearTimeout(timeout);
                  setTimeout(() => safeResolve(events), 500); // Give a moment for any final events
                }
              } catch (e) {
                events.push({ event: currentEvent, data: currentData });
              }

              currentEvent = '';
              currentData = '';
            }
          }
        });

        res.on('end', () => {
          clearTimeout(timeout);
          safeResolve(events);
        });

        res.on('error', () => {
          clearTimeout(timeout);
          safeResolve(events);
        });
      });

    req.end();
  });
}

/**
 * Start analysis and wait for completion via polling
 */
async function runAnalysisToCompletion(
  app: ReturnType<typeof createTestApp>,
  traceId: string,
  query: string,
  sessionId?: string,
  maxWaitMs: number = SSE_TIMEOUT
): Promise<{ sessionId: string; result: any; events: SSEEvent[] }> {
  // Start analysis
  const startResponse = await request(app)
    .post('/api/agent/analyze')
    .send({
      traceId,
      query,
      sessionId,
      options: {
        maxRounds: 3, // Limit rounds for faster tests
        confidenceThreshold: 0.6,
      },
    });

  expect(startResponse.status).toBe(200);
  expect(startResponse.body.success).toBe(true);
  expect(startResponse.body.sessionId).toBeDefined();

  const newSessionId = startResponse.body.sessionId;
  activeSessions.add(newSessionId); // Track for cleanup
  console.log(`[E2E] Analysis started, sessionId: ${newSessionId}`);

  // Collect SSE events
  const events = await collectSSEFromUrl(app, newSessionId, maxWaitMs);

  // Get final status
  const statusResponse = await request(app)
    .get(`/api/agent/${newSessionId}/status`);

  return {
    sessionId: newSessionId,
    result: statusResponse.body,
    events,
  };
}

/**
 * Cleanup a session and remove from tracking
 */
async function cleanupSession(app: ReturnType<typeof createTestApp>, sessionId: string): Promise<void> {
  try {
    await request(app).delete(`/api/agent/${sessionId}`);
    activeSessions.delete(sessionId);
    console.log(`[E2E] Cleaned up session: ${sessionId}`);
  } catch (e) {
    // Ignore cleanup errors
  }
}

/**
 * Cleanup all tracked sessions
 */
async function cleanupAllSessions(app: ReturnType<typeof createTestApp>): Promise<void> {
  for (const sessionId of activeSessions) {
    await cleanupSession(app, sessionId);
  }
}

/**
 * Validate SSE event has correct structure
 */
function validateEventStructure(event: SSEEvent, expectedFields: string[]): void {
  expect(event.data).toBeDefined();
  for (const field of expectedFields) {
    expect(event.data[field]).toBeDefined();
  }
}

/**
 * Find events by type
 */
function findEvents(events: SSEEvent[], eventType: string): SSEEvent[] {
  return events.filter(e => e.event === eventType);
}

/**
 * Check if events contain a specific type
 */
function hasEvent(events: SSEEvent[], eventType: string): boolean {
  return events.some(e => e.event === eventType);
}

// =============================================================================
// Test Suite: Full Scrolling Analysis Flow
// =============================================================================

describe('E2E: Full Scrolling Analysis Flow', () => {
  let app: ReturnType<typeof createTestApp>;
  let traceId: string | null = null;

  beforeAll(async () => {
    app = createTestApp();

    try {
      traceId = await loadTestTrace(SCROLLING_TRACE);
      console.log(`[E2E] Loaded test trace: ${traceId}`);
    } catch (error) {
      console.warn(`[E2E] Could not load trace: ${error}`);
    }
  }, E2E_TIMEOUT);

  afterAll(async () => {
    await cleanupAllSessions(app);
    if (traceId) {
      await cleanupTrace(traceId);
    }
  });

  afterEach(async () => {
    // Give time for any pending operations to complete
    await wait(100);
  });

  it('should complete a full scrolling analysis with proper SSE events', async () => {
    if (!traceId) {
      console.warn('Skipping test: no trace loaded');
      return;
    }

    const { sessionId, result, events } = await runAnalysisToCompletion(
      app,
      traceId,
      '分析滑动性能'
    );

    // Verify analysis started or completed
    expect(['completed', 'running', 'pending']).toContain(result.status);
    expect(result.sessionId).toBe(sessionId);
    expect(result.traceId).toBe(traceId);

    // Verify SSE events were received
    expect(events.length).toBeGreaterThan(0);

    // Verify connected event
    expect(hasEvent(events, 'connected')).toBe(true);
    const connectedEvent = findEvents(events, 'connected')[0];
    expect(connectedEvent.data.sessionId).toBe(sessionId);
    expect(connectedEvent.data.architecture).toBe('agent-driven');

    // Verify progress events
    expect(hasEvent(events, 'progress')).toBe(true);

    console.log(`[E2E] Analysis completed with ${events.length} events`);

    // Cleanup
    await cleanupSession(app, sessionId);
  }, E2E_TIMEOUT);

  it('should generate proper DataEnvelopes during analysis', async () => {
    if (!traceId) {
      console.warn('Skipping test: no trace loaded');
      return;
    }

    const { sessionId, events } = await runAnalysisToCompletion(
      app,
      traceId,
      '分析滑动卡顿'
    );

    // Look for data events
    const dataEvents = findEvents(events, 'data');

    // If we have data events, validate their structure
    if (dataEvents.length > 0) {
      for (const dataEvent of dataEvents) {
        // Each data event should have envelope(s)
        if (dataEvent.data.envelope) {
          const envelopes = Array.isArray(dataEvent.data.envelope)
            ? dataEvent.data.envelope
            : [dataEvent.data.envelope];

          for (const envelope of envelopes) {
            // Validate DataEnvelope structure
            expect(envelope.meta).toBeDefined();
            expect(envelope.meta.type).toBeDefined();
            expect(envelope.meta.version).toBeDefined();
            expect(envelope.meta.source).toBeDefined();

            expect(envelope.display).toBeDefined();
            expect(envelope.display.layer).toBeDefined();
            expect(envelope.display.format).toBeDefined();
            expect(envelope.display.title).toBeDefined();

            // Data should be present
            expect(envelope.data).toBeDefined();
          }
        }
      }
      console.log(`[E2E] Validated ${dataEvents.length} data events with DataEnvelopes`);
    }

    // Cleanup
    await cleanupSession(app, sessionId);
  }, E2E_TIMEOUT);
});

// =============================================================================
// Test Suite: Multi-Turn Conversation
// =============================================================================

describe('E2E: Multi-Turn Conversation', () => {
  let app: ReturnType<typeof createTestApp>;
  let traceId: string | null = null;

  beforeAll(async () => {
    app = createTestApp();

    try {
      traceId = await loadTestTrace(SCROLLING_TRACE);
      console.log(`[E2E] Loaded test trace for multi-turn: ${traceId}`);
    } catch (error) {
      console.warn(`[E2E] Could not load trace: ${error}`);
    }
  }, E2E_TIMEOUT);

  afterAll(async () => {
    await cleanupAllSessions(app);
    if (traceId) {
      await cleanupTrace(traceId);
    }
  });

  it('should handle multi-turn conversation with context preservation', async () => {
    if (!traceId) {
      console.warn('Skipping test: no trace loaded');
      return;
    }

    // First turn: Initial analysis
    const turn1 = await runAnalysisToCompletion(
      app,
      traceId,
      '分析滑动性能',
      undefined,
      90000 // 90 seconds for first turn
    );

    expect(turn1.result.sessionId).toBe(turn1.sessionId);
    console.log(`[E2E] Turn 1 completed: ${turn1.sessionId}`);

    // Wait for analysis to settle
    await wait(2000);

    // Second turn: Follow-up query using same session
    const turn2Response = await request(app)
      .post('/api/agent/analyze')
      .send({
        traceId,
        query: '详细分析最严重的卡顿帧',
        sessionId: turn1.sessionId, // Reuse session
        options: { maxRounds: 2 },
      });

    expect(turn2Response.status).toBe(200);
    expect(turn2Response.body.success).toBe(true);

    // Check if session was reused (isNewSession should be false)
    if (turn2Response.body.isNewSession === false) {
      // Session reused - same sessionId
      expect(turn2Response.body.sessionId).toBe(turn1.sessionId);
      console.log(`[E2E] Turn 2 reused session: ${turn2Response.body.sessionId}`);
    } else {
      // New session created (acceptable)
      console.log(`[E2E] Turn 2 created new session: ${turn2Response.body.sessionId}`);
    }

    // Collect events for turn 2
    const turn2SessionId = turn2Response.body.sessionId;
    const turn2Events = await collectSSEFromUrl(app, turn2SessionId, 60000);

    expect(turn2Events.length).toBeGreaterThan(0);
    console.log(`[E2E] Turn 2 completed with ${turn2Events.length} events`);

    // Cleanup both sessions
    await cleanupSession(app, turn1.sessionId);
    if (turn2SessionId !== turn1.sessionId) {
      await cleanupSession(app, turn2SessionId);
    }
  }, E2E_TIMEOUT);

  it('should handle drill-down queries', async () => {
    if (!traceId) {
      console.warn('Skipping test: no trace loaded');
      return;
    }

    // First: run analysis
    const { sessionId, events } = await runAnalysisToCompletion(
      app,
      traceId,
      '分析滑动性能',
      undefined,
      90000
    );

    // Extract a timestamp from the events if available
    let timestamp: string | undefined;
    for (const event of events) {
      if (event.data?.envelope?.data?.rows?.length > 0) {
        const row = event.data.envelope.data.rows[0];
        // Look for timestamp field (usually first column or 'ts')
        if (row.ts) {
          timestamp = String(row.ts);
        } else if (row.ts_str) {
          timestamp = row.ts_str;
        }
        if (timestamp) break;
      }
    }

    if (timestamp) {
      // Record interaction for drill-down
      const interactionResponse = await request(app)
        .post(`/api/agent/${sessionId}/interaction`)
        .send({
          type: 'drill_down',
          target: {
            entityType: 'frame',
            timeRange: {
              start: timestamp,
              end: timestamp,
            },
          },
        });

      expect(interactionResponse.status).toBe(200);
      console.log(`[E2E] Recorded drill-down interaction for timestamp: ${timestamp}`);
    }

    // Cleanup
    await cleanupSession(app, sessionId);
  }, E2E_TIMEOUT);
});

// =============================================================================
// Test Suite: SSE Event Sequence Validation
// =============================================================================

describe('E2E: SSE Event Sequence Validation', () => {
  let app: ReturnType<typeof createTestApp>;
  let traceId: string | null = null;

  beforeAll(async () => {
    app = createTestApp();

    try {
      traceId = await loadTestTrace(SCROLLING_TRACE);
      console.log(`[E2E] Loaded test trace for SSE validation: ${traceId}`);
    } catch (error) {
      console.warn(`[E2E] Could not load trace: ${error}`);
    }
  }, E2E_TIMEOUT);

  afterAll(async () => {
    await cleanupAllSessions(app);
    if (traceId) {
      await cleanupTrace(traceId);
    }
  });

  it('should emit events in expected sequence', async () => {
    if (!traceId) {
      console.warn('Skipping test: no trace loaded');
      return;
    }

    const { sessionId, events } = await runAnalysisToCompletion(
      app,
      traceId,
      '分析滑动性能'
    );

    // Expected event sequence phases
    const eventSequence = events.map(e => e.event);

    // connected should always be first
    expect(eventSequence[0]).toBe('connected');

    // Verify we have key phase events
    const keyEvents = [
      'connected',
      'progress',
    ];

    for (const keyEvent of keyEvents) {
      expect(eventSequence).toContain(keyEvent);
    }

    // If analysis completed, check for completion events
    if (hasEvent(events, 'analysis_completed')) {
      // analysis_completed should be near the end
      const completedIndex = eventSequence.lastIndexOf('analysis_completed');
      const endIndex = eventSequence.lastIndexOf('end');

      if (endIndex !== -1) {
        expect(completedIndex).toBeLessThan(endIndex);
      }
    }

    console.log(`[E2E] Event sequence validated: ${eventSequence.slice(0, 10).join(' -> ')}...`);

    // Cleanup
    await cleanupSession(app, sessionId);
  }, E2E_TIMEOUT);

  it('should include required fields in progress events', async () => {
    if (!traceId) {
      console.warn('Skipping test: no trace loaded');
      return;
    }

    const { sessionId, events } = await runAnalysisToCompletion(
      app,
      traceId,
      '分析性能'
    );

    const progressEvents = findEvents(events, 'progress');

    for (const event of progressEvents) {
      // Progress events should have timestamp
      expect(event.data.timestamp).toBeDefined();

      // Should have type or data field
      expect(event.data.type || event.data.data).toBeDefined();
    }

    console.log(`[E2E] Validated ${progressEvents.length} progress events`);

    // Cleanup
    await cleanupSession(app, sessionId);
  }, E2E_TIMEOUT);

  it('should handle agent dialogue events correctly', async () => {
    if (!traceId) {
      console.warn('Skipping test: no trace loaded');
      return;
    }

    const { sessionId, events } = await runAnalysisToCompletion(
      app,
      traceId,
      '分析滑动性能'
    );

    // Check for agent dialogue events
    const dialogueEvents = findEvents(events, 'agent_dialogue');
    const responseEvents = findEvents(events, 'agent_response');
    const taskDispatchedEvents = findEvents(events, 'agent_task_dispatched');

    // If we have agent events, validate their structure
    for (const event of dialogueEvents) {
      expect(event.data).toBeDefined();
    }

    for (const event of responseEvents) {
      expect(event.data).toBeDefined();
    }

    for (const event of taskDispatchedEvents) {
      expect(event.data).toBeDefined();
    }

    console.log(`[E2E] Agent events: dialogue=${dialogueEvents.length}, response=${responseEvents.length}, dispatch=${taskDispatchedEvents.length}`);

    // Cleanup
    await cleanupSession(app, sessionId);
  }, E2E_TIMEOUT);
});

// =============================================================================
// Test Suite: Data Integrity Validation
// =============================================================================

describe('E2E: Data Integrity Validation', () => {
  let app: ReturnType<typeof createTestApp>;
  let traceId: string | null = null;

  beforeAll(async () => {
    app = createTestApp();

    try {
      traceId = await loadTestTrace(SCROLLING_TRACE);
      console.log(`[E2E] Loaded test trace for data integrity: ${traceId}`);
    } catch (error) {
      console.warn(`[E2E] Could not load trace: ${error}`);
    }
  }, E2E_TIMEOUT);

  afterAll(async () => {
    await cleanupAllSessions(app);
    if (traceId) {
      await cleanupTrace(traceId);
    }
  });

  it('should generate findings with correct structure', async () => {
    if (!traceId) {
      console.warn('Skipping test: no trace loaded');
      return;
    }

    const { sessionId, result, events } = await runAnalysisToCompletion(
      app,
      traceId,
      '分析滑动卡顿'
    );

    // Wait for completion
    await wait(1000);

    // Get detailed status
    const statusResponse = await request(app)
      .get(`/api/agent/${sessionId}/status`);

    if (statusResponse.body.status === 'completed' && statusResponse.body.result) {
      const analysisResult = statusResponse.body.result;

      // Validate findings count if available
      if (analysisResult.findingsCount !== undefined) {
        expect(typeof analysisResult.findingsCount).toBe('number');
        expect(analysisResult.findingsCount).toBeGreaterThanOrEqual(0);
      }

      // Validate confidence if available
      if (analysisResult.confidence !== undefined) {
        expect(typeof analysisResult.confidence).toBe('number');
        expect(analysisResult.confidence).toBeGreaterThanOrEqual(0);
        expect(analysisResult.confidence).toBeLessThanOrEqual(1);
      }

      console.log(`[E2E] Result validated: confidence=${analysisResult.confidence}, findings=${analysisResult.findingsCount}`);
    }

    // Cleanup
    await cleanupSession(app, sessionId);
  }, E2E_TIMEOUT);

  it('should validate DataEnvelope data payload', async () => {
    if (!traceId) {
      console.warn('Skipping test: no trace loaded');
      return;
    }

    const { sessionId, events } = await runAnalysisToCompletion(
      app,
      traceId,
      '分析性能'
    );

    const dataEvents = findEvents(events, 'data');

    for (const event of dataEvents) {
      if (event.data.envelope) {
        const envelopes = Array.isArray(event.data.envelope)
          ? event.data.envelope
          : [event.data.envelope];

        for (const envelope of envelopes) {
          // Validate data payload format
          if (envelope.data) {
            // If it's a table format, validate structure
            if (envelope.display?.format === 'table') {
              // Should have columns or rows
              const hasTableData = (
                (envelope.data.columns && Array.isArray(envelope.data.columns)) ||
                (envelope.data.rows && Array.isArray(envelope.data.rows))
              );
              // Table format should have some table data structure
              if (envelope.data.rows) {
                expect(Array.isArray(envelope.data.rows)).toBe(true);
              }
            }
          }
        }
      }
    }

    console.log(`[E2E] DataEnvelope payloads validated for ${dataEvents.length} events`);

    // Cleanup
    await cleanupSession(app, sessionId);
  }, E2E_TIMEOUT);

  it('should generate conclusion when analysis completes', async () => {
    if (!traceId) {
      console.warn('Skipping test: no trace loaded');
      return;
    }

    const { sessionId, events } = await runAnalysisToCompletion(
      app,
      traceId,
      '分析滑动性能',
      undefined,
      120000 // 2 minutes
    );

    // Look for analysis_completed event
    const completedEvents = findEvents(events, 'analysis_completed');

    if (completedEvents.length > 0) {
      const completedEvent = completedEvents[0];

      // analysis_completed should have conclusion data
      if (completedEvent.data.data) {
        const resultData = completedEvent.data.data;

        // Check for conclusion
        if (resultData.conclusion) {
          expect(typeof resultData.conclusion).toBe('string');
          expect(resultData.conclusion.length).toBeGreaterThan(0);
          console.log(`[E2E] Conclusion generated: ${resultData.conclusion.substring(0, 100)}...`);
        }

        // Check for findings array
        if (resultData.findings) {
          expect(Array.isArray(resultData.findings)).toBe(true);
          console.log(`[E2E] Generated ${resultData.findings.length} findings`);
        }
      }
    }

    // Cleanup
    await cleanupSession(app, sessionId);
  }, E2E_TIMEOUT);
});

// =============================================================================
// Test Suite: Error Handling
// =============================================================================

describe('E2E: Error Handling', () => {
  let app: ReturnType<typeof createTestApp>;

  beforeAll(() => {
    app = createTestApp();
  });

  it('should handle invalid trace gracefully', async () => {
    const response = await request(app)
      .post('/api/agent/analyze')
      .send({
        traceId: 'non-existent-trace-id',
        query: '分析性能',
      });

    expect(response.status).toBe(404);
    expect(response.body.success).toBe(false);
    expect(response.body.code).toBe('TRACE_NOT_UPLOADED');
  });

  it('should handle empty query gracefully', async () => {
    const response = await request(app)
      .post('/api/agent/analyze')
      .send({
        traceId: 'some-trace-id',
        query: '',
      });

    expect(response.status).toBe(400);
    expect(response.body.success).toBe(false);
  });

  it('should handle session cleanup correctly', async () => {
    // Try to delete non-existent session
    const response = await request(app)
      .delete('/api/agent/non-existent-session-xyz');

    expect(response.status).toBe(404);
  });
});

// =============================================================================
// Test Suite: Performance Validation
// =============================================================================

describe('E2E: Performance Validation', () => {
  let app: ReturnType<typeof createTestApp>;
  let traceId: string | null = null;

  beforeAll(async () => {
    app = createTestApp();

    try {
      traceId = await loadTestTrace(SCROLLING_TRACE);
    } catch (error) {
      console.warn(`[E2E] Could not load trace: ${error}`);
    }
  }, E2E_TIMEOUT);

  afterAll(async () => {
    await cleanupAllSessions(app);
    if (traceId) {
      await cleanupTrace(traceId);
    }
  });

  it('should complete analysis within reasonable time', async () => {
    if (!traceId) {
      console.warn('Skipping test: no trace loaded');
      return;
    }

    const startTime = Date.now();

    const { sessionId, result } = await runAnalysisToCompletion(
      app,
      traceId,
      '分析性能',
      undefined,
      90000 // 90 second timeout
    );

    const duration = Date.now() - startTime;

    // Analysis should complete within 90 seconds for a simple query
    expect(duration).toBeLessThan(90000);

    console.log(`[E2E] Analysis completed in ${duration}ms`);

    // Cleanup
    await cleanupSession(app, sessionId);
  }, E2E_TIMEOUT);

  it('should handle concurrent sessions', async () => {
    if (!traceId) {
      console.warn('Skipping test: no trace loaded');
      return;
    }

    // Start multiple analyses concurrently
    const analysisPromises = [
      runAnalysisToCompletion(app, traceId, '分析滑动性能', undefined, 90000),
      runAnalysisToCompletion(app, traceId, '分析CPU', undefined, 90000),
    ];

    const results = await Promise.all(analysisPromises);

    // All should have unique session IDs
    const sessionIds = results.map(r => r.sessionId);
    const uniqueIds = new Set(sessionIds);
    expect(uniqueIds.size).toBe(sessionIds.length);

    console.log(`[E2E] Concurrent sessions completed: ${sessionIds.join(', ')}`);

    // Cleanup all sessions
    for (const result of results) {
      await cleanupSession(app, result.sessionId);
    }
  }, E2E_TIMEOUT);
});
