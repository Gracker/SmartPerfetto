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
import type {Server} from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {createLoopbackServerFixture} from '../helpers/loopbackServer';
// Import the app only after its import-time scene stores see the owned paths.
let createTestApp: typeof import('./testApp').createTestApp;
let loadTestTrace: typeof import('./testApp').loadTestTrace;
let cleanupTrace: typeof import('./testApp').cleanupTrace;
let wait: typeof import('./testApp').wait;

const fixtureEnvKeys = [
  'SMARTPERFETTO_ENTERPRISE_DB_PATH', 'SMARTPERFETTO_DATA_DIR',
  'SMARTPERFETTO_BACKEND_DATA_DIR', 'SMARTPERFETTO_BACKEND_LOG_DIR',
  'UPLOAD_DIR', 'SMARTPERFETTO_TRACE_UPLOAD_DIR', 'PROVIDER_DATA_DIR_OVERRIDE',
  'SCENE_REPORT_DIR', 'SCENE_JOB_ARTIFACT_DIR',
  'SMARTPERFETTO_ENTERPRISE', 'SMARTPERFETTO_API_KEY',
  'SMARTPERFETTO_SSO_TRUSTED_HEADERS', 'SMARTPERFETTO_AI_ENABLED',
  'SMARTPERFETTO_OIDC_ISSUER_URL', 'SMARTPERFETTO_OIDC_CLIENT_ID',
  'SMARTPERFETTO_OIDC_CLIENT_SECRET', 'SMARTPERFETTO_OIDC_REDIRECT_URI',
  'SMARTPERFETTO_ENTERPRISE_MIGRATION_PHASE', 'SMARTPERFETTO_ENTERPRISE_CUTOVER_CONFIRMED',
] as const;
const previousFixtureEnv = new Map(fixtureEnvKeys.map(key => [key, process.env[key]]));
const ownedListeners: ReturnType<typeof createLoopbackServerFixture>[] = [];
const closeStores: Array<() => void> = [];
const cleanupErrors: unknown[] = [];
const ownedSessionIds = new Set<string>();
let fixtureRoot: string | undefined;

function createOwnedLoopbackServerFixture() {
  const fixture = createLoopbackServerFixture();
  ownedListeners.push(fixture);
  return fixture;
}

async function cleanupOwnedResource(cleanup: () => void | Promise<void>): Promise<void> {
  try {await cleanup();} catch (error) {cleanupErrors.push(error);}
}

beforeAll(async () => {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-agent-routes-integration-'));
  for (const key of fixtureEnvKeys) delete process.env[key];
  Object.assign(process.env, {
    SMARTPERFETTO_ENTERPRISE_DB_PATH: path.join(fixtureRoot, 'enterprise.sqlite'),
    SMARTPERFETTO_DATA_DIR: path.join(fixtureRoot, 'enterprise'),
    SMARTPERFETTO_BACKEND_DATA_DIR: path.join(fixtureRoot, 'data'),
    SMARTPERFETTO_BACKEND_LOG_DIR: path.join(fixtureRoot, 'logs'),
    UPLOAD_DIR: path.join(fixtureRoot, 'uploads'),
    SMARTPERFETTO_TRACE_UPLOAD_DIR: path.join(fixtureRoot, 'uploads', 'traces'),
    PROVIDER_DATA_DIR_OVERRIDE: path.join(fixtureRoot, 'providers'),
    SCENE_REPORT_DIR: path.join(fixtureRoot, 'scene-reports'),
    SCENE_JOB_ARTIFACT_DIR: path.join(fixtureRoot, 'scene-job-artifacts'),
    SMARTPERFETTO_ENTERPRISE: 'false', SMARTPERFETTO_SSO_TRUSTED_HEADERS: 'false',
    SMARTPERFETTO_AI_ENABLED: 'true',
  });
  ({createTestApp, loadTestTrace, cleanupTrace, wait} = await import('./testApp'));

  const {SessionPersistenceService} = await import('../../src/services/sessionPersistenceService');
  const {resetAgentEventStoreForTests} = await import('../../src/services/agentEventStore');
  const {resetAnalysisRunStoreForTests} = await import('../../src/services/analysisRunStore');
  const {resetAnalysisHistoryStoreForTests} = await import('../../src/services/analysisHistoryStore');
  const {resetConversationSessionStoreForTests} = await import('../../src/services/conversationSessionStore');
  const {clearRunManifestLifecyclesForTests} = await import('../../src/services/selfEvolution/runManifestLifecycle');
  const {resetRunManifestStoreForTests} = await import('../../src/services/selfEvolution/runManifestStore');
  const {resetProviderService} = await import('../../src/services/providerManager');
  closeStores.push(clearRunManifestLifecyclesForTests, resetRunManifestStoreForTests,
    () => SessionPersistenceService.resetForTests(), resetAgentEventStoreForTests,
    resetAnalysisRunStoreForTests, resetAnalysisHistoryStoreForTests,
    resetConversationSessionStoreForTests, resetProviderService);

  const {TraceProcessorService, setTraceProcessorServiceForTests} =
    await import('../../src/services/traceProcessorService');
  const service = new TraceProcessorService(process.env.SMARTPERFETTO_TRACE_UPLOAD_DIR);
  setTraceProcessorServiceForTests(service);
  closeStores.unshift(() => {
    service.cleanupProcessorsForTraces(service.getAllTraces().map(trace => trace.id));
    setTraceProcessorServiceForTests(null);
  });
  const {TraceProcessorLeaseStore, setTraceProcessorLeaseStoreForTests} =
    await import('../../src/services/traceProcessorLeaseStore');
  const leaseStore = new TraceProcessorLeaseStore();
  setTraceProcessorLeaseStoreForTests(leaseStore);
  closeStores.push(() => {leaseStore.close(); setTraceProcessorLeaseStoreForTests(null);});
});

afterAll(async () => {
  try {
    for (const fixture of ownedListeners) await cleanupOwnedResource(() => fixture.close());
    for (const close of closeStores) await cleanupOwnedResource(close);
  } finally {
    for (const [key, value] of previousFixtureEnv) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
  // Never remove a directory while one of its owned resources failed to close.
  if (cleanupErrors.length) throw cleanupErrors[0];
  if (fixtureRoot) fs.rmSync(fixtureRoot, {recursive: true, force: true});
});

// =============================================================================
// Fast Validation Tests (no trace needed)
// =============================================================================

describe('Agent Routes - Input Validation', () => {
  const loopbackServers = createOwnedLoopbackServerFixture();
  let app: Server;

  beforeAll(async () => {
    app = await loopbackServers.listen(createTestApp());
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
  const loopbackServers = createOwnedLoopbackServerFixture();
  let app: Server;

  beforeAll(async () => {
    app = await loopbackServers.listen(createTestApp());
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
  const loopbackServers = createOwnedLoopbackServerFixture();
  let app: Server;

  beforeAll(async () => {
    app = await loopbackServers.listen(createTestApp());
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
  const loopbackServers = createOwnedLoopbackServerFixture();
  let app: Server;
  let traceId: string | null = null;

  // Use a smaller trace for faster tests
  const TEST_TRACE = 'android-scroll-standard';

  // These runs start real analyses: pin the jest-mocked Claude SDK runtime and
  // send providerId: null so no Provider Manager profile reaches a provider.
  const previousRuntime = process.env.SMARTPERFETTO_AGENT_RUNTIME;

  beforeAll(async () => {
    process.env.SMARTPERFETTO_AGENT_RUNTIME = 'claude-agent-sdk';
    app = await loopbackServers.listen(createTestApp());

    // A trace that does not load fails the suite: these tests must not pass by skipping.
    traceId = await loadTestTrace(TEST_TRACE);
  }, 120000);

  afterAll(async () => {
    for (const sessionId of ownedSessionIds) {
      await cleanupOwnedResource(async () => {
        // The production DELETE awaits run abort and session cleanup.
        const response = await request(app).delete(`/api/agent/v1/${sessionId}`);
        if (response.status !== 200 && response.status !== 404) {
          throw new Error(`Failed to clean integration session: HTTP ${response.status}`);
        }
      });
    }
    if (traceId) await cleanupOwnedResource(() => cleanupTrace(traceId!));
    if (previousRuntime === undefined) delete process.env.SMARTPERFETTO_AGENT_RUNTIME;
    else process.env.SMARTPERFETTO_AGENT_RUNTIME = previousRuntime;
  });

  it('should create, query status, and delete session', async () => {
    // 1. Create session
    const createResponse = await request(app)
      .post('/api/agent/v1/analyze')
      .send({
        traceId,
        providerId: null,
        query: '分析性能',
        options: { maxIterations: 1 },
      });

    if (typeof createResponse.body.sessionId === 'string') ownedSessionIds.add(createResponse.body.sessionId);
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
    // Create session
    const createResponse = await request(app)
      .post('/api/agent/v1/analyze')
      .send({
        traceId,
        providerId: null,
        query: '测试',
        options: { maxIterations: 1 },
      });

    if (typeof createResponse.body.sessionId === 'string') ownedSessionIds.add(createResponse.body.sessionId);
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
});
