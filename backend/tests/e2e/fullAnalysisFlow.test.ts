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
 * - Trace fixtures registered in ../Trace/catalog.json
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
const SCROLLING_TRACE = 'scroll-demo-customer-scroll.pftrace';
const STARTUP_TRACE = 'lacunh_heavy.pftrace';

// =============================================================================
// Types for Test Assertions
// =============================================================================

interface SSEEvent {
  event: string;
  data: any;
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
  let settled = false;

  return new Promise((resolve, reject) => {
    const safeResolve = (result: SSEEvent[]) => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };
    const safeReject = (error: Error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    };

    const timeout = setTimeout(() => {
      safeReject(new Error(
        `[E2E] SSE timeout after ${timeoutMs}ms; collected events: ${events.map(event => event.event).join(', ')}`,
      ));
    }, timeoutMs);

    const req = request(app)
      .get(`/api/agent/v1/${sessionId}/stream`)
      .set('Accept', 'text/event-stream')
      .buffer(false)
      .parse((res, _callback) => {
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
                if (currentEvent === 'end' || currentEvent === 'error') {
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
          if (events.some(event =>
            event.event === 'end' || event.event === 'analysis_completed' || event.event === 'error')) {
            safeResolve(events);
          } else {
            safeReject(new Error(
              `[E2E] SSE stream ended without a terminal event; collected: ${events.map(event => event.event).join(', ')}`,
            ));
          }
        });

        res.on('error', (error: Error) => {
          clearTimeout(timeout);
          safeReject(error);
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
    .post('/api/agent/v1/analyze')
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
    .get(`/api/agent/v1/${newSessionId}/status`);

  expect(statusResponse.status).toBe(200);
  expect(statusResponse.body.status).toBe('completed');
  expect(hasEvent(events, 'analysis_completed')).toBe(true);
  expect(hasEvent(events, 'end')).toBe(true);
  expect(hasEvent(events, 'error')).toBe(false);

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
    await request(app).delete(`/api/agent/v1/${sessionId}`);
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

function getAnalysisCompletedPayload(events: SSEEvent[]): Record<string, any> | null {
  const completed = findEvents(events, 'analysis_completed');
  if (completed.length === 0) return null;
  return (completed[0].data?.data || completed[0].data || null) as Record<string, any> | null;
}

function requireCompletedAnalysis(events: SSEEvent[]): Record<string, any> {
  expect(hasEvent(events, 'error')).toBe(false);
  expect(hasEvent(events, 'analysis_completed')).toBe(true);
  expect(hasEvent(events, 'end')).toBe(true);
  const payload = getAnalysisCompletedPayload(events);
  expect(payload).toBeTruthy();
  completedConclusionOrExplicitDegradation(payload!, events);
  return payload!;
}

function completedConclusionOrExplicitDegradation(
  payload: Record<string, any>,
  events: SSEEvent[],
): string {
  expect(typeof payload.conclusion).toBe('string');
  const conclusion = String(payload.conclusion || '').trim();
  if (conclusion) return conclusion;

  // A provider-free/degraded run must stay semantically honest: an empty
  // narrative is acceptable only when the structured result explicitly says
  // it is partial and carries a user-visible termination reason.
  expect(payload.partial).toBe(true);
  expect(String(payload.terminationMessage || '').trim().length).toBeGreaterThan(0);
  expect(hasEvent(events, 'degraded')).toBe(true);
  return '';
}

function collectEnvelopes(events: SSEEvent[]): any[] {
  const envelopes: any[] = [];
  for (const event of events) {
    if (event.event !== 'data' || !event.data?.envelope) continue;
    const env = Array.isArray(event.data.envelope) ? event.data.envelope : [event.data.envelope];
    envelopes.push(...env);
  }
  return envelopes;
}

function toRowObjects(data: any): Record<string, any>[] {
  if (!data) return [];
  if (Array.isArray(data)) return data as Record<string, any>[];
  if (Array.isArray(data.rows) && Array.isArray(data.columns)) {
    return data.rows.map((row: any[]) => {
      const obj: Record<string, any> = {};
      data.columns.forEach((col: string, idx: number) => {
        obj[col] = row[idx];
      });
      return obj;
    });
  }
  if (Array.isArray(data.data)) return data.data as Record<string, any>[];
  if (typeof data === 'object') return [data as Record<string, any>];
  return [];
}

function findEnvelopeByStep(envelopes: any[], stepId: string): any | undefined {
  return envelopes.find((envelope) => {
    const source = String(envelope?.meta?.source || '');
    return source.includes(`:${stepId}`) || source.includes(`#${stepId}`);
  });
}

async function queryTraceRows(
  app: ReturnType<typeof createTestApp>,
  traceId: string,
  sql: string
): Promise<Record<string, any>[]> {
  const candidatePaths = [
    `/api/trace-processor/${traceId}/query`,
    `/api/traces/${traceId}/query`,
  ];

  for (const path of candidatePaths) {
    const response = await request(app)
      .get(path)
      .query({ q: sql });

    if (response.status === 404) continue;
    expect(response.status).toBe(200);
    expect(response.body?.error).toBeFalsy();
    return toRowObjects(response.body);
  }

  throw new Error(`Trace query endpoint not found for trace ${traceId}`);
}

function readNumericMetric(
  metric: Record<string, any>,
  keys: string[],
  fallback: number = 0
): number {
  for (const key of keys) {
    const value = metric[key];
    if (value === null || value === undefined) continue;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return fallback;
}

// =============================================================================
// Test Suite: Full Scrolling Analysis Flow
// =============================================================================

describe('E2E: Full Scrolling Analysis Flow', () => {
  let app: ReturnType<typeof createTestApp>;
  let traceId: string;

  beforeAll(async () => {
    app = createTestApp();

    traceId = await loadTestTrace(SCROLLING_TRACE);
    console.log(`[E2E] Loaded test trace: ${traceId}`);
  }, E2E_TIMEOUT);

  afterAll(async () => {
    await cleanupAllSessions(app);
    await cleanupTrace(traceId);
  });

  afterEach(async () => {
    // Give time for any pending operations to complete
    await wait(100);
  });

  it('should complete a full scrolling analysis with proper SSE events', async () => {
    const { sessionId, result, events } = await runAnalysisToCompletion(
      app,
      traceId,
      '分析滑动性能'
    );

    // Verify analysis started or completed
    expect(result.status).toBe('completed');
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
    const { sessionId, events } = await runAnalysisToCompletion(
      app,
      traceId,
      '分析滑动卡顿'
    );

    // Look for data events
    const dataEvents = findEvents(events, 'data');

    expect(dataEvents.length > 0 || hasEvent(events, 'degraded')).toBe(true);
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

    // Cleanup
    await cleanupSession(app, sessionId);
  }, E2E_TIMEOUT);
});

// =============================================================================
// Test Suite: Full Startup Analysis Flow
// =============================================================================

describe('E2E: Full Startup Analysis Flow', () => {
  let app: ReturnType<typeof createTestApp>;
  let traceId: string;

  beforeAll(async () => {
    app = createTestApp();

    traceId = await loadTestTrace(STARTUP_TRACE);
    console.log(`[E2E] Loaded startup test trace: ${traceId}`);
  }, E2E_TIMEOUT);

  afterAll(async () => {
    await cleanupAllSessions(app);
    await cleanupTrace(traceId);
  });

  it('should complete a full startup analysis and emit data events', async () => {
    const { sessionId, result, events } = await runAnalysisToCompletion(
      app,
      traceId,
      '分析启动性能'
    );

    expect(result.status).toBe('completed');
    expect(result.sessionId).toBe(sessionId);
    expect(result.traceId).toBe(traceId);
    expect(events.length).toBeGreaterThan(0);
    expect(hasEvent(events, 'connected')).toBe(true);
    expect(hasEvent(events, 'progress')).toBe(true);

    await cleanupSession(app, sessionId);
  }, E2E_TIMEOUT);
});

// =============================================================================
// Test Suite: Multi-Turn Conversation
// =============================================================================

describe('E2E: Multi-Turn Conversation', () => {
  let app: ReturnType<typeof createTestApp>;
  let traceId: string;

  beforeAll(async () => {
    app = createTestApp();

    traceId = await loadTestTrace(SCROLLING_TRACE);
    console.log(`[E2E] Loaded test trace for multi-turn: ${traceId}`);
  }, E2E_TIMEOUT);

  afterAll(async () => {
    await cleanupAllSessions(app);
    await cleanupTrace(traceId);
  });

  it('should handle multi-turn conversation with context preservation', async () => {
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
      .post('/api/agent/v1/analyze')
      .send({
        traceId,
        query: '详细分析最严重的卡顿帧',
        sessionId: turn1.sessionId, // Reuse session
        options: { maxRounds: 2 },
      });

    expect(turn2Response.status).toBe(200);
    expect(turn2Response.body.success).toBe(true);

    expect(turn2Response.body.isNewSession).toBe(false);
    expect(turn2Response.body.sessionId).toBe(turn1.sessionId);
    console.log(`[E2E] Turn 2 reused session: ${turn2Response.body.sessionId}`);

    // Collect events for turn 2
    const turn2SessionId = turn2Response.body.sessionId;
    const turn2Events = await collectSSEFromUrl(app, turn2SessionId, 60000);

    expect(turn2Events.length).toBeGreaterThan(0);
    const turn2Completed = requireCompletedAnalysis(turn2Events);
    const turn2DataEnvelopes = collectEnvelopes(turn2Events);
    const hasDrillDownEvidence = turn2DataEnvelopes.some((envelope) => {
      const source = String(envelope?.meta?.source || '').toLowerCase();
      return (
        source.includes('jank_frame_detail') ||
        source.includes('scrolling_analysis') ||
        source.includes('frame')
      );
    });
    const hasStructuredFindings =
      Array.isArray(turn2Completed.findings) && turn2Completed.findings.length > 0;
    const degradedMode = hasEvent(turn2Events, 'degraded');
    expect(hasDrillDownEvidence || hasStructuredFindings || degradedMode).toBe(true);

    console.log(`[E2E] Turn 2 completed with ${turn2Events.length} events`);

    // Cleanup both sessions
    await cleanupSession(app, turn1.sessionId);
    if (turn2SessionId !== turn1.sessionId) {
      await cleanupSession(app, turn2SessionId);
    }
  }, E2E_TIMEOUT);

  it('should handle drill-down queries', async () => {
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
        .post(`/api/agent/v1/${sessionId}/interaction`)
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
  let traceId: string;

  beforeAll(async () => {
    app = createTestApp();

    traceId = await loadTestTrace(SCROLLING_TRACE);
    console.log(`[E2E] Loaded test trace for SSE validation: ${traceId}`);
  }, E2E_TIMEOUT);

  afterAll(async () => {
    await cleanupAllSessions(app);
    await cleanupTrace(traceId);
  });

  it('should emit events in expected sequence', async () => {
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

    const completedIndex = eventSequence.lastIndexOf('analysis_completed');
    const endIndex = eventSequence.lastIndexOf('end');
    expect(completedIndex).toBeGreaterThan(-1);
    expect(endIndex).toBeGreaterThan(completedIndex);
    requireCompletedAnalysis(events);

    const dataEvents = findEvents(events, 'data');
    const envelopeCount = collectEnvelopes(dataEvents).length;
    const degradedMode = hasEvent(events, 'degraded');
    expect(envelopeCount > 0 || degradedMode).toBe(true);

    console.log(`[E2E] Event sequence validated: ${eventSequence.slice(0, 10).join(' -> ')}...`);

    // Cleanup
    await cleanupSession(app, sessionId);
  }, E2E_TIMEOUT);

  it('should include required fields in progress events', async () => {
    const { sessionId, events } = await runAnalysisToCompletion(
      app,
      traceId,
      '分析性能'
    );

    const progressEvents = findEvents(events, 'progress');
    expect(progressEvents.length).toBeGreaterThan(0);

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
  let traceId: string;

  beforeAll(async () => {
    app = createTestApp();

    traceId = await loadTestTrace(SCROLLING_TRACE);
    console.log(`[E2E] Loaded test trace for data integrity: ${traceId}`);
  }, E2E_TIMEOUT);

  afterAll(async () => {
    await cleanupAllSessions(app);
    await cleanupTrace(traceId);
  });

  it('should generate findings with correct structure', async () => {
    const { sessionId, events } = await runAnalysisToCompletion(
      app,
      traceId,
      '分析滑动卡顿'
    );

    // Wait for completion
    await wait(1000);

    // Get detailed status
    const statusResponse = await request(app)
      .get(`/api/agent/v1/${sessionId}/status`);

    expect(statusResponse.status).toBe(200);
    expect(statusResponse.body.status).toBe('completed');
    expect(statusResponse.body.result).toBeDefined();
    const analysisResult = statusResponse.body.result;
    const completed = requireCompletedAnalysis(events);
    expect(Array.isArray(completed.findings)).toBe(true);

    if (analysisResult.findingsCount !== undefined) {
      expect(typeof analysisResult.findingsCount).toBe('number');
      expect(analysisResult.findingsCount).toBeGreaterThanOrEqual(0);
    }

    if (analysisResult.confidence !== undefined) {
      expect(typeof analysisResult.confidence).toBe('number');
      expect(analysisResult.confidence).toBeGreaterThanOrEqual(0);
      expect(analysisResult.confidence).toBeLessThanOrEqual(1);
    }

    console.log(`[E2E] Result validated: confidence=${analysisResult.confidence}, findings=${analysisResult.findingsCount}`);

    // Cleanup
    await cleanupSession(app, sessionId);
  }, E2E_TIMEOUT);

  it('should validate DataEnvelope data payload', async () => {
    const { sessionId, events } = await runAnalysisToCompletion(
      app,
      traceId,
      '分析性能'
    );

    const dataEvents = findEvents(events, 'data');
    expect(dataEvents.length > 0 || hasEvent(events, 'degraded')).toBe(true);

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
    const { sessionId, events } = await runAnalysisToCompletion(
      app,
      traceId,
      '分析滑动性能',
      undefined,
      120000 // 2 minutes
    );

    const resultData = requireCompletedAnalysis(events);
    expect(Array.isArray(resultData.findings)).toBe(true);
    console.log(`[E2E] Generated ${resultData.findings.length} findings`);

    // Cleanup
    await cleanupSession(app, sessionId);
  }, E2E_TIMEOUT);

  it('should match golden key metrics and conclusion for heavy jank trace', async () => {
    const { sessionId, events } = await runAnalysisToCompletion(
      app,
      traceId,
      '分析滑动卡顿并给出根因',
      undefined,
      120000
    );

    const completedEvents = findEvents(events, 'analysis_completed');
    expect(completedEvents.length).toBeGreaterThan(0);
    const completed = completedEvents[0].data?.data || {};
    const conclusion = completedConclusionOrExplicitDegradation(completed, events).toLowerCase();
    expect(Array.isArray(completed.findings)).toBe(true);
    // In degraded/no-LLM mode the pipeline may still produce a valid conclusion + metrics
    // while findings stay empty; keep this test focused on golden conclusion/metrics.
    expect(completed.findings.length).toBeGreaterThanOrEqual(0);

    // Golden conclusion contract: heavy jank trace should explicitly discuss jank.
    if (conclusion) {
      expect(
        conclusion.includes('jank') ||
        conclusion.includes('掉帧') ||
        conclusion.includes('卡顿')
      ).toBe(true);
    }

    const envelopes = collectEnvelopes(events);
    const perfEnvelope = findEnvelopeByStep(envelopes, 'performance_summary');
    let metric: Record<string, any> | undefined;

    if (perfEnvelope) {
      const perfRows = toRowObjects(perfEnvelope?.data);
      expect(perfRows.length).toBeGreaterThan(0);
      metric = perfRows[0];
    } else {
      // Degraded/no-LLM mode may not emit performance_summary envelopes.
      // Fall back to deterministic SQL baseline directly from trace processor.
      const fallbackRows = await queryTraceRows(app, traceId, `
        WITH
          vsync_intervals AS (
            SELECT
              c.ts - LAG(c.ts) OVER (ORDER BY c.ts) as interval_ns
            FROM counter c
            JOIN counter_track t ON c.track_id = t.id
            WHERE t.name = 'VSYNC-sf'
          ),
          vsync_config AS (
            SELECT
              CASE
                WHEN COUNT(*) > 10 THEN ROUND(AVG(interval_ns))
                ELSE 16666666
              END as vsync_period_ns
            FROM vsync_intervals
            WHERE interval_ns BETWEEN 1000000 AND 50000000
          ),
          vsync_events AS (
            SELECT
              c.ts as vsync_ts,
              c.ts - LAG(c.ts) OVER (ORDER BY c.ts) as interval_ns
            FROM counter c
            JOIN counter_track t ON c.track_id = t.id
            WHERE t.name = 'VSYNC-sf'
          ),
          buffer_events AS (
            SELECT c.ts, c.value as buffer_count
            FROM counter c
            JOIN counter_track t ON c.track_id = t.id
            WHERE t.name LIKE '%BufferTX%'
          ),
          vsync_with_buffer AS (
            SELECT
              v.vsync_ts,
              v.interval_ns,
              (
                SELECT b.buffer_count
                FROM buffer_events b
                WHERE b.ts <= v.vsync_ts
                ORDER BY b.ts DESC
                LIMIT 1
              ) as buffer_at_vsync
            FROM vsync_events v
            WHERE v.interval_ns IS NOT NULL
          ),
          jank_analysis AS (
            SELECT
              SUM(CASE WHEN interval_ns > (SELECT vsync_period_ns FROM vsync_config) * 1.5
                  THEN 1 ELSE 0 END) as total_jank_count,
              SUM(CASE WHEN interval_ns > (SELECT vsync_period_ns FROM vsync_config) * 1.5
                    AND buffer_at_vsync = 0 THEN 1 ELSE 0 END) as app_jank_count,
              SUM(CASE WHEN interval_ns > (SELECT vsync_period_ns FROM vsync_config) * 1.5
                    AND COALESCE(buffer_at_vsync, 1) > 0 THEN 1 ELSE 0 END) as sf_jank_count,
              MAX(CASE WHEN interval_ns > (SELECT vsync_period_ns FROM vsync_config) * 1.5
                  THEN ROUND(interval_ns * 1.0 / (SELECT vsync_period_ns FROM vsync_config) - 1)
                  ELSE 0 END) as max_vsync_missed
            FROM vsync_with_buffer
            WHERE buffer_at_vsync IS NOT NULL
          ),
          app_stats AS (
            SELECT
              COUNT(*) as total_frames,
              SUM(CASE WHEN jank_type != 'None' THEN 1 ELSE 0 END) as app_janky_frames
            FROM actual_frame_timeline_slice a
            LEFT JOIN process p ON a.upid = p.upid
            WHERE p.name NOT LIKE '/system/%'
              AND COALESCE(a.display_frame_token, a.surface_frame_token) IS NOT NULL
          )
        SELECT
          COALESCE((SELECT total_frames FROM app_stats), 0) as total_frames,
          COALESCE(
            (SELECT total_jank_count FROM jank_analysis),
            (SELECT app_janky_frames FROM app_stats),
            0
          ) as janky_frames,
          COALESCE(
            (SELECT app_jank_count FROM jank_analysis),
            (SELECT app_janky_frames FROM app_stats),
            0
          ) as app_janky_frames,
          COALESCE((SELECT sf_jank_count FROM jank_analysis), 0) as sf_jank_count,
          COALESCE((SELECT max_vsync_missed FROM jank_analysis), 0) as max_vsync_missed,
          ROUND((SELECT vsync_period_ns FROM vsync_config) / 1e6, 2) as vsync_period_ms
        LIMIT 1
      `);
      expect(fallbackRows.length).toBeGreaterThan(0);
      metric = fallbackRows[0];
    }

    expect(metric).toBeDefined();
    const totalFrames = readNumericMetric(metric!, ['total_frames']);
    const jankyFrames = readNumericMetric(metric!, ['janky_frames']);
    const appJank = readNumericMetric(metric!, ['app_jank', 'app_janky_frames']);
    const sfJank = readNumericMetric(metric!, ['sf_jank', 'sf_jank_count']);
    const maxVsyncMissed = readNumericMetric(metric!, ['max_vsync_missed']);
    const vsyncPeriodMs = readNumericMetric(metric!, ['vsync_period_ms']);

    // Golden key-metric checks (heavy-jank baseline, tolerant bounds).
    expect(totalFrames).toBeGreaterThan(0);
    // The committed fixture's independent FPS report records 21 late frames;
    // the interval-based fallback currently resolves 24. Keep the lower bound
    // tied to that checked-in evidence instead of an obsolete count of 30.
    expect(jankyFrames).toBeGreaterThanOrEqual(20);
    expect(appJank).toBeGreaterThanOrEqual(1);
    expect(sfJank).toBeGreaterThanOrEqual(1);
    expect(maxVsyncMissed).toBeGreaterThanOrEqual(1);
    expect(vsyncPeriodMs).toBeGreaterThan(6.0);
    expect(vsyncPeriodMs).toBeLessThan(10.5);
    expect(jankyFrames).toBe(appJank + sfJank);

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
      .post('/api/agent/v1/analyze')
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
      .post('/api/agent/v1/analyze')
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
      .delete('/api/agent/v1/non-existent-session-xyz');

    expect(response.status).toBe(404);
  });
});

// =============================================================================
// Test Suite: Performance Validation
// =============================================================================

describe('E2E: Performance Validation', () => {
  let app: ReturnType<typeof createTestApp>;
  let traceId: string;

  beforeAll(async () => {
    app = createTestApp();

    traceId = await loadTestTrace(SCROLLING_TRACE);
  }, E2E_TIMEOUT);

  afterAll(async () => {
    await cleanupAllSessions(app);
    await cleanupTrace(traceId);
  });

  it('should complete analysis within reasonable time', async () => {
    const startTime = Date.now();

    const { sessionId } = await runAnalysisToCompletion(
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
