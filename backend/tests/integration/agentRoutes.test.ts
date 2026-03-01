/**
 * Agent Routes Integration Tests
 *
 * Tests the Agent API endpoints for:
 * - Input validation
 * - Error handling
 * - Basic session management
 *
 * Note: Full agent analysis tests are in skill-eval/ as they need longer timeouts
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import request from 'supertest';
import { createTestApp, loadTestTrace, cleanupTrace, wait } from './testApp';

type ParsedSSEEvent = { event: string; data: any };

function parseSSEText(text: string): ParsedSSEEvent[] {
  const events: ParsedSSEEvent[] = [];
  const chunks = String(text || '').split('\n\n');
  for (const chunk of chunks) {
    const lines = chunk.split('\n').map((line) => line.trim()).filter(Boolean);
    if (lines.length === 0) continue;
    const eventLine = lines.find((line) => line.startsWith('event:'));
    const dataLine = lines.find((line) => line.startsWith('data:'));
    if (!eventLine || !dataLine) continue;
    const event = eventLine.slice('event:'.length).trim();
    const rawData = dataLine.slice('data:'.length).trim();
    let data: any = rawData;
    try {
      data = JSON.parse(rawData);
    } catch {
      // Keep raw string when payload is non-JSON.
    }
    events.push({ event, data });
  }
  return events;
}

async function waitForTerminalStatus(
  app: ReturnType<typeof createTestApp>,
  sessionId: string,
  timeoutMs = 30000
): Promise<{ status: string; payload: any }> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const response = await request(app).get(`/api/agent/v1/${sessionId}/status`);
    if (response.status === 200) {
      const status = String(response.body?.status || '');
      if (status === 'completed' || status === 'failed') {
        return { status, payload: response.body };
      }
    }
    await wait(300);
  }
  throw new Error(`Timed out waiting for terminal status of session ${sessionId}`);
}

// =============================================================================
// Fast Validation Tests (no trace needed)
// =============================================================================

describe('Agent Routes - Input Validation', () => {
  let app: ReturnType<typeof createTestApp>;

  beforeAll(() => {
    app = createTestApp();
  });

  describe('Health Check', () => {
    it('should return healthy status', async () => {
      const response = await request(app).get('/health');

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('OK');
    });
  });

  describe('Authentication', () => {
    const API_KEY_ENV = 'SMARTPERFETTO_API_KEY';

    const restoreApiKey = (value: string | undefined) => {
      if (value === undefined) {
        delete process.env[API_KEY_ENV];
      } else {
        process.env[API_KEY_ENV] = value;
      }
    };

    it('should return 401 when API key is configured but not provided', async () => {
      const previousApiKey = process.env[API_KEY_ENV];
      process.env[API_KEY_ENV] = 'test-key';

      try {
        const response = await request(app).get('/api/agent/v1/sessions');
        expect(response.status).toBe(401);
        expect(response.body.error).toContain('Unauthorized');
      } finally {
        restoreApiKey(previousApiKey);
      }
    });

    it('should allow requests with the configured API key', async () => {
      const previousApiKey = process.env[API_KEY_ENV];
      process.env[API_KEY_ENV] = 'test-key';

      try {
        const response = await request(app)
          .get('/api/agent/v1/sessions')
          .set('x-api-key', 'test-key');

        expect(response.status).toBe(200);
        expect(response.body.success).toBe(true);
      } finally {
        restoreApiKey(previousApiKey);
      }
    });
  });

  describe('Assistant Web Shell', () => {
    it('should serve standalone assistant shell page', async () => {
      const response = await request(app).get('/assistant-shell');

      expect(response.status).toBe(200);
      expect(response.text).toContain('SmartPerfetto Assistant Web Shell');
      expect(response.text).toContain('/api/agent/v1');
    });
  });

  describe('Legacy API Compatibility', () => {
    it('should return 410 for /api/agent alias with migration headers', async () => {
      const response = await request(app).get('/api/agent/sessions');

      expect(response.status).toBe(410);
      expect(response.body.success).toBe(false);
      expect(response.headers.deprecation).toBe('true');
      expect(response.headers.sunset).toBeTruthy();
      expect(response.headers.link).toContain('/api/agent/v1');
      expect(response.headers.warning).toContain('removed');
      expect(response.body.migration.successor).toBe('/api/agent/v1/sessions');
    });
  });

  describe('POST /api/agent/v1/analyze - Validation', () => {
    it('should return 400 if traceId is missing', async () => {
      const response = await request(app)
        .post('/api/agent/v1/analyze')
        .send({ query: 'Test query' });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('traceId');
    });

    it('should return 400 if query is missing', async () => {
      const response = await request(app)
        .post('/api/agent/v1/analyze')
        .send({ traceId: 'some-trace-id' });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('query');
    });

    it('should return 400 for empty body', async () => {
      const response = await request(app)
        .post('/api/agent/v1/analyze')
        .send({});

      expect(response.status).toBe(400);
    });

    it('should return 400 for null traceId', async () => {
      const response = await request(app)
        .post('/api/agent/v1/analyze')
        .send({ traceId: null, query: 'test' });

      expect(response.status).toBe(400);
    });

    it('should return 404 if trace does not exist', async () => {
      const response = await request(app)
        .post('/api/agent/v1/analyze')
        .send({
          traceId: 'non-existent-trace-id',
          query: '分析滑动性能',
        });

      expect(response.status).toBe(404);
      expect(response.body.success).toBe(false);
      expect(response.body.code).toBe('TRACE_NOT_UPLOADED');
    });
  });

  describe('GET /api/agent/v1/:sessionId/status - Validation', () => {
    it('should return 404 for non-existent session', async () => {
      const response = await request(app)
        .get('/api/agent/v1/non-existent-session-123/status');

      expect(response.status).toBe(404);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('not found');
    });
  });

  describe('DELETE /api/agent/v1/:sessionId - Validation', () => {
    it('should return 404 for non-existent session', async () => {
      const response = await request(app)
        .delete('/api/agent/v1/non-existent-session-456');

      expect(response.status).toBe(404);
      expect(response.body.success).toBe(false);
    });
  });

  describe('POST /api/agent/v1/:sessionId/respond - Validation', () => {
    it('should return 404 for non-existent session', async () => {
      const response = await request(app)
        .post('/api/agent/v1/non-existent-session-789/respond')
        .send({ action: 'continue' });

      expect(response.status).toBe(404);
      expect(response.body.success).toBe(false);
    });
  });

  describe('POST /api/agent/v1/resume - Validation', () => {
    it('should return 400 if sessionId is missing', async () => {
      const response = await request(app)
        .post('/api/agent/v1/resume')
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('sessionId');
    });

    it('should return 404 for non-existent session', async () => {
      const response = await request(app)
        .post('/api/agent/v1/resume')
        .send({ sessionId: 'non-existent-session' });

      // In environments where better-sqlite3 native binding is unavailable,
      // persistence lookup can fail with 500 before "not found" handling.
      expect([404, 500]).toContain(response.status);
      expect(response.body.success).toBe(false);
    });
  });

  describe('GET /api/agent/v1/:sessionId/report - Validation', () => {
    it('should return 404 for non-existent session', async () => {
      const response = await request(app)
        .get('/api/agent/v1/non-existent-session-abc/report');

      expect(response.status).toBe(404);
      expect(response.body.success).toBe(false);
    });
  });
});

// =============================================================================
// Session Management Tests
// =============================================================================

describe('Agent Routes - Session Management', () => {
  let app: ReturnType<typeof createTestApp>;

  beforeAll(() => {
    app = createTestApp();
  });

  describe('GET /api/agent/v1/sessions', () => {
    it('should list all sessions with correct structure', async () => {
      const response = await request(app).get('/api/agent/v1/sessions');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(Array.isArray(response.body.activeSessions)).toBe(true);
      expect(Array.isArray(response.body.recoverableSessions)).toBe(true);
      expect(typeof response.body.totalActive).toBe('number');
      expect(typeof response.body.totalRecoverable).toBe('number');
    });
  });
});

// =============================================================================
// Session Logs Tests
// =============================================================================

describe('Agent Routes - Session Logs', () => {
  let app: ReturnType<typeof createTestApp>;

  beforeAll(() => {
    app = createTestApp();
  });

  describe('GET /api/agent/v1/logs', () => {
    it('should list session logs with correct structure', async () => {
      const response = await request(app).get('/api/agent/v1/logs');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.logDir).toBeDefined();
      expect(Array.isArray(response.body.sessions)).toBe(true);
      expect(typeof response.body.count).toBe('number');
    });
  });

  describe('GET /api/agent/v1/logs/:sessionId', () => {
    it('should handle non-existent session gracefully', async () => {
      const response = await request(app)
        .get('/api/agent/v1/logs/test-session-xyz');

      // May return 200 with empty array or 500 if file operations fail
      expect([200, 500]).toContain(response.status);
      if (response.status === 200) {
        expect(response.body.success).toBe(true);
        expect(Array.isArray(response.body.logs)).toBe(true);
      }
    });
  });

  describe('GET /api/agent/v1/logs/:sessionId/errors', () => {
    it('should handle non-existent session gracefully', async () => {
      const response = await request(app)
        .get('/api/agent/v1/logs/test-session-xyz/errors');

      // May return 200 with empty arrays or 500 if file operations fail
      expect([200, 500]).toContain(response.status);
      if (response.status === 200) {
        expect(response.body.success).toBe(true);
        expect(typeof response.body.errorCount).toBe('number');
        expect(typeof response.body.warnCount).toBe('number');
      }
    });
  });

  describe('POST /api/agent/v1/logs/cleanup', () => {
    it('should accept cleanup request with default maxAgeDays', async () => {
      const response = await request(app)
        .post('/api/agent/v1/logs/cleanup')
        .send({});

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(typeof response.body.deletedCount).toBe('number');
    });

    it('should accept cleanup request with custom maxAgeDays', async () => {
      const response = await request(app)
        .post('/api/agent/v1/logs/cleanup')
        .send({ maxAgeDays: 30 });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.message).toContain('30 days');
    });
  });
});

// =============================================================================
// Full Session Lifecycle Test (with real trace)
// =============================================================================

describe('Agent Routes - Session Lifecycle', () => {
  let app: ReturnType<typeof createTestApp>;
  let traceId: string | null = null;

  // Use a smaller trace for faster tests
  const TEST_TRACE = 'app_aosp_scrolling_light.pftrace';

  beforeAll(async () => {
    app = createTestApp();

    // Load test trace
    try {
      traceId = await loadTestTrace(TEST_TRACE);
      console.log(`[Test] Loaded trace: ${traceId}`);
    } catch (error) {
      console.warn(`[Test] Could not load trace: ${error}`);
    }
  }, 120000);

  afterAll(async () => {
    if (traceId) {
      await cleanupTrace(traceId);
    }
  });

  it('should create, query status, and delete session', async () => {
    if (!traceId) {
      console.warn('Skipping test: no trace loaded');
      return;
    }

    // 1. Create session
    const createResponse = await request(app)
      .post('/api/agent/v1/analyze')
      .send({
        traceId,
        query: '分析性能',
        options: { maxIterations: 1 },
      });

    expect(createResponse.status).toBe(200);
    expect(createResponse.body.success).toBe(true);
    expect(createResponse.body.sessionId).toBeDefined();
    expect(typeof createResponse.body.runId).toBe('string');
    expect(typeof createResponse.body.requestId).toBe('string');
    expect(typeof createResponse.body.runSequence).toBe('number');
    expect(createResponse.headers['x-request-id']).toBe(createResponse.body.requestId);

    const sessionId = createResponse.body.sessionId;

    // 2. Query status
    await wait(500); // Give it time to initialize

    const statusResponse = await request(app)
      .get(`/api/agent/v1/${sessionId}/status`);

    expect(statusResponse.status).toBe(200);
    expect(statusResponse.body.success).toBe(true);
    expect(statusResponse.body.sessionId).toBe(sessionId);
    expect(statusResponse.body.traceId).toBe(traceId);
    expect(statusResponse.body.observability?.runId).toBe(createResponse.body.runId);
    expect(statusResponse.body.observability?.requestId).toBe(createResponse.body.requestId);
    expect(statusResponse.body.observability?.runSequence).toBe(createResponse.body.runSequence);
    expect(['pending', 'running', 'awaiting_user', 'completed', 'failed'])
      .toContain(statusResponse.body.status);

    // 3. Session should appear in list
    const listResponse = await request(app).get('/api/agent/v1/sessions');

    expect(listResponse.status).toBe(200);
    const foundSession = listResponse.body.activeSessions.find(
      (s: any) => s.sessionId === sessionId
    );
    expect(foundSession).toBeDefined();

    // 4. Delete session
    const deleteResponse = await request(app)
      .delete(`/api/agent/v1/${sessionId}`);

    expect(deleteResponse.status).toBe(200);
    expect(deleteResponse.body.success).toBe(true);

    // 5. Verify deletion
    const verifyResponse = await request(app)
      .get(`/api/agent/v1/${sessionId}/status`);

    expect(verifyResponse.status).toBe(404);
  }, 60000);

  it('should handle respond endpoint correctly for running session', async () => {
    if (!traceId) {
      console.warn('Skipping test: no trace loaded');
      return;
    }

    // Create session
    const createResponse = await request(app)
      .post('/api/agent/v1/analyze')
      .send({
        traceId,
        query: '测试',
        options: { maxIterations: 1 },
      });

    const sessionId = createResponse.body.sessionId;

    // Try to respond with invalid action
    const invalidResponse = await request(app)
      .post(`/api/agent/v1/${sessionId}/respond`)
      .send({ action: 'invalid_action' });

    expect(invalidResponse.status).toBe(400);
    // Session state check happens before action validation
    expect(invalidResponse.body.error).toBeDefined();

    // Try to respond when not awaiting user (should fail)
    await wait(200);
    const respondResponse = await request(app)
      .post(`/api/agent/v1/${sessionId}/respond`)
      .send({ action: 'continue' });

    // Either succeeds or fails with "not awaiting user"
    expect([200, 400]).toContain(respondResponse.status);

    // Cleanup
    await request(app).delete(`/api/agent/v1/${sessionId}`);
  }, 30000);

  it('should satisfy SSE contract for analysis_completed event', async () => {
    if (!traceId) {
      console.warn('Skipping test: no trace loaded');
      return;
    }

    const createResponse = await request(app)
      .post('/api/agent/v1/analyze')
      .send({
        traceId,
        query: '分析性能',
        options: { maxIterations: 1 },
      });

    expect(createResponse.status).toBe(200);
    expect(createResponse.body.success).toBe(true);
    const sessionId = createResponse.body.sessionId as string;
    const runId = createResponse.body.runId as string;
    const requestId = createResponse.body.requestId as string;
    const runSequence = createResponse.body.runSequence as number;
    expect(sessionId).toBeTruthy();
    expect(runId).toBeTruthy();
    expect(requestId).toBeTruthy();
    expect(Number.isFinite(runSequence)).toBe(true);

    const terminal = await waitForTerminalStatus(app, sessionId, 45000);
    expect(terminal.status).toBe('completed');

    const streamResponse = await request(app)
      .get(`/api/agent/v1/${sessionId}/stream`)
      .buffer(true);

    expect(streamResponse.status).toBe(200);
    const sseEvents = parseSSEText(streamResponse.text);
    expect(sseEvents.length).toBeGreaterThan(0);

    const eventNames = sseEvents.map((e) => e.event);
    expect(eventNames).toContain('connected');
    expect(eventNames).toContain('end');

    const connectedEvent = sseEvents.find((e) => e.event === 'connected');
    expect(connectedEvent).toBeDefined();
    expect(connectedEvent?.data?.runId).toBe(runId);
    expect(connectedEvent?.data?.requestId).toBe(requestId);
    expect(connectedEvent?.data?.runSequence).toBe(runSequence);

    const completedEvent = sseEvents.find((e) => e.event === 'analysis_completed');
    expect(completedEvent).toBeDefined();
    expect(completedEvent?.data?.type).toBe('analysis_completed');
    expect(completedEvent?.data?.architecture).toBe('agent-driven');
    expect(completedEvent?.data?.runId).toBe(runId);
    expect(completedEvent?.data?.requestId).toBe(requestId);
    expect(completedEvent?.data?.runSequence).toBe(runSequence);
    expect(completedEvent?.data?.data).toBeDefined();
    expect(typeof completedEvent?.data?.data?.conclusion).toBe('string');
    expect(typeof completedEvent?.data?.data?.confidence).toBe('number');
    expect(typeof completedEvent?.data?.data?.rounds).toBe('number');
    expect(typeof completedEvent?.data?.data?.totalDurationMs).toBe('number');
    expect(Array.isArray(completedEvent?.data?.data?.findings)).toBe(true);
    expect(completedEvent?.data?.data?.resultContract?.version).toBe('1.0.0');
    expect(Array.isArray(completedEvent?.data?.data?.resultContract?.dataEnvelopes)).toBe(true);
    expect(Array.isArray(completedEvent?.data?.data?.resultContract?.diagnostics)).toBe(true);
    expect(Array.isArray(completedEvent?.data?.data?.resultContract?.actions)).toBe(true);
    expect(completedEvent?.data?.data?.observability?.runId).toBe(runId);
    expect(completedEvent?.data?.data?.observability?.requestId).toBe(requestId);
    expect(completedEvent?.data?.data?.observability?.runSequence).toBe(runSequence);

    const statusResponse = await request(app).get(`/api/agent/v1/${sessionId}/status`);
    expect(statusResponse.status).toBe(200);
    expect(statusResponse.body?.status).toBe('completed');
    expect(statusResponse.body?.observability?.runId).toBe(runId);
    expect(statusResponse.body?.observability?.requestId).toBe(requestId);
    expect(statusResponse.body?.observability?.runSequence).toBe(runSequence);
    expect(statusResponse.body?.result?.resultContract?.version).toBe('1.0.0');
    expect(Array.isArray(statusResponse.body?.result?.resultContract?.dataEnvelopes)).toBe(true);
    expect(Array.isArray(statusResponse.body?.result?.resultContract?.diagnostics)).toBe(true);
    expect(Array.isArray(statusResponse.body?.result?.resultContract?.actions)).toBe(true);

    await request(app).delete(`/api/agent/v1/${sessionId}`);
  }, 90000);
});
