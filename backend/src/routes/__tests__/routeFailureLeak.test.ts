// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Route catch blocks answer an arbitrary downstream exception with fixed text
 * and a stable code; the exception message (paths, SQL, provider details,
 * stored text) reaches only the server log. Deliberate validation errors keep
 * their user-actionable text.
 */

import * as fs from 'fs';
import * as path from 'path';
import express from 'express';
import request from 'supertest';
import type { RequestContext } from '../../middleware/auth';
import {
  invalidProviderRequest,
  providerNotFound,
} from '../../services/providerManager/providerRequestError';
import { registerAgentLogsRoutes } from '../agentLogsRoutes';
import enterpriseTenantRoutes from '../enterpriseTenantRoutes';
import exportRoutes from '../exportRoutes';
import providerRoutes from '../providerRoutes';
import reportRoutes from '../reportRoutes';
import sessionRoutes from '../sessionRoutes';
import simpleTraceRoutes from '../simpleTraceRoutes';

const CANARY = 'canary-5d81 /Users/someone/.smartperfetto/secret.db SELECT api_key FROM providers';

const mockState: {contextFailure: Error | null; downstream: () => never} = {
  contextFailure: null,
  downstream: () => {
    throw new Error(CANARY);
  },
};
const mockProviderService = {
  create: jest.fn(),
  update: jest.fn(),
  delete: jest.fn(),
  get: jest.fn(),
  list: jest.fn(() => []),
  activate: jest.fn(),
  switchAgentRuntime: jest.fn(),
  rotateSecret: jest.fn(),
};

jest.mock('../../middleware/auth', () => {
  const actual = jest.requireActual('../../middleware/auth');
  const passThrough = (_req: unknown, _res: unknown, next: () => void) => next();
  return {
    ...actual,
    authenticate: passThrough,
    attachRequestContext: passThrough,
    requireRequestContext: (req: unknown) => {
      if (mockState.contextFailure) throw mockState.contextFailure;
      return actual.requireRequestContext(req);
    },
  };
});

jest.mock('../../services/sessionLogger', () => ({
  ...jest.requireActual('../../services/sessionLogger'),
  getSessionLoggerManager: () => ({
    listSessions: () => mockState.downstream(),
    readSessionLogs: () => mockState.downstream(),
    cleanup: () => mockState.downstream(),
    getLogDir: () => '/unused',
  }),
}));

jest.mock('../../agentv3/agentMetrics', () => ({
  ...jest.requireActual('../../agentv3/agentMetrics'),
  metricsDir: () => mockState.downstream(),
}));

jest.mock('../../services/sessionPersistenceService', () => ({
  SessionPersistenceService: {
    getInstance: () => ({
      listSessions: () => mockState.downstream(),
      exportSessions: () => mockState.downstream(),
      getSession: () => mockState.downstream(),
      deleteSession: () => mockState.downstream(),
    }),
  },
}));

jest.mock('../../services/resultExportService', () => ({
  ResultExportService: {
    getInstance: () => ({
      exportResult: () => mockState.downstream(),
      exportSession: () => mockState.downstream(),
      exportAnalysisSession: () => mockState.downstream(),
    }),
  },
}));

jest.mock('../../services/enterpriseDb', () => ({
  ...jest.requireActual('../../services/enterpriseDb'),
  openEnterpriseDb: () => ({close: () => undefined}),
}));

jest.mock('../../services/enterpriseTenantExportService', () => ({
  buildTenantExportBundle: async () => mockState.downstream(),
}));

jest.mock('../../services/enterpriseTenantLifecycleService', () => ({
  ...jest.requireActual('../../services/enterpriseTenantLifecycleService'),
  createTenantTombstone: () => mockState.downstream(),
}));

jest.mock('../../services/enterpriseAdminControlPlaneService', () => ({
  ...jest.requireActual('../../services/enterpriseAdminControlPlaneService'),
  getEnterpriseAdminControlPlaneSummary: () => mockState.downstream(),
}));

jest.mock('../../services/providerManager', () => ({
  ...jest.requireActual('../../services/providerManager'),
  getProviderService: () => mockProviderService,
}));


const context: RequestContext = {
  tenantId: 'tenant-a',
  workspaceId: 'workspace-a',
  userId: 'user-a',
  authType: 'dev',
  roles: ['org_admin'],
  scopes: ['*'],
  requestId: 'req-route-failure-test',
};

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & {requestContext?: RequestContext}).requestContext = {...context};
    next();
  });
  const agentRouter = express.Router();
  registerAgentLogsRoutes(agentRouter);
  app.use('/api/agent/v1', agentRouter);
  app.use('/api/sessions', sessionRoutes);
  app.use('/api/export', exportRoutes);
  app.use('/api/reports', reportRoutes);
  app.use('/api/providers', providerRoutes);
  app.use('/api/tenant', enterpriseTenantRoutes);
  app.use('/api/traces', simpleTraceRoutes);
  return app;
}

type Case = {
  name: string;
  send: (app: express.Express) => request.Test;
  code: string;
  /** Make requireRequestContext throw inside the route's try block. */
  contextFailure?: boolean;
};

const CASES: Case[] = [
  {name: 'agent logs list', send: (app) => request(app).get('/api/agent/v1/logs'), code: 'agent_logs_list_failed'},
  {name: 'agent logs read', send: (app) => request(app).get('/api/agent/v1/logs/s1'), code: 'agent_logs_read_failed'},
  {name: 'agent error logs read', send: (app) => request(app).get('/api/agent/v1/logs/s1/errors'), code: 'agent_logs_read_failed'},
  {name: 'agent metrics summary', send: (app) => request(app).get('/api/agent/v1/logs/metrics/summary'), code: 'agent_metrics_summary_failed'},
  {name: 'agent logs cleanup', send: (app) => request(app).post('/api/agent/v1/logs/cleanup').send({}), code: 'agent_logs_cleanup_failed'},
  {name: 'session list', send: (app) => request(app).get('/api/sessions'), code: 'session_list_failed'},
  {name: 'session export', send: (app) => request(app).get('/api/sessions/export'), code: 'session_export_failed'},
  {name: 'session read', send: (app) => request(app).get('/api/sessions/s1'), code: 'session_read_failed'},
  {name: 'session delete', send: (app) => request(app).delete('/api/sessions/s1'), code: 'session_delete_failed'},
  {
    name: 'result export',
    send: (app) => request(app).post('/api/export/result').send({result: {columns: [], rows: []}}),
    code: 'result_export_failed',
  },
  {name: 'session results export', send: (app) => request(app).post('/api/export/session').send({results: []}), code: 'export_session_failed'},
  {name: 'analysis export', send: (app) => request(app).post('/api/export/analysis').send({sessionId: 's1'}), code: 'analysis_export_failed'},
  {name: 'tenant export', send: (app) => request(app).get('/api/export/tenant'), code: 'tenant_export_failed'},
  {name: 'report export', send: (app) => request(app).get('/api/reports/r1/export'), code: 'report_export_failed', contextFailure: true},
  {name: 'report read', send: (app) => request(app).get('/api/reports/r1'), code: 'report_read_failed', contextFailure: true},
  {name: 'report delete', send: (app) => request(app).delete('/api/reports/r1'), code: 'report_delete_failed', contextFailure: true},
  {name: 'tenant tombstone', send: (app) => request(app).post('/api/tenant/tombstone').send({confirmTenantId: 'tenant-a'}), code: 'tenant_tombstone_failed'},
  {name: 'enterprise admin summary', send: (app) => request(app).get('/api/tenant/admin/summary'), code: 'enterprise_admin_failed'},
  {name: 'trace list', send: (app) => request(app).get('/api/traces'), code: 'trace_list_failed', contextFailure: true},
  {name: 'trace stats', send: (app) => request(app).get('/api/traces/stats'), code: 'trace_stats_failed', contextFailure: true},
  {name: 'trace cleanup', send: (app) => request(app).post('/api/traces/cleanup'), code: 'trace_cleanup_failed', contextFailure: true},
  {name: 'trace RPC register', send: (app) => request(app).post('/api/traces/register-rpc').send({port: 9001}), code: 'trace_rpc_register_failed', contextFailure: true},
];

describe('route catch blocks never return downstream exception messages', () => {
  let errorLog: jest.SpyInstance;
  let app: express.Express;

  beforeAll(() => {
    app = makeApp();
  });

  beforeEach(() => {
    errorLog = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    mockState.contextFailure = null;
    for (const fn of Object.values(mockProviderService)) fn.mockReset();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function loggedText(): string {
    return errorLog.mock.calls
      .flat()
      .map((value) => (value instanceof Error ? `${value.message}\n${value.stack}` : JSON.stringify(value)))
      .join('\n');
  }

  function expectFixedFailure(res: request.Response, status: number, code: string): void {
    expect(res.status).toBe(status);
    expect(res.body).toEqual({
      success: false,
      code,
      error: expect.any(String),
      requestId: 'req-leak-test',
    });
    expect(res.text).not.toContain('canary-5d81');
    expect(res.headers['x-request-id']).toBe('req-leak-test');
    expect(loggedText()).toContain(CANARY);
  }

  test.each(CASES)('$name', async ({send, code, contextFailure}) => {
    if (contextFailure) mockState.contextFailure = new Error(CANARY);

    expectFixedFailure(await send(app).set('X-Request-Id', 'req-leak-test'), 500, code);
  });

  test.each([
    ['create', (a: express.Express) => request(a).post('/api/providers').send({}), 'create'],
    ['update', (a: express.Express) => request(a).patch('/api/providers/p1').send({}), 'update'],
    ['delete', (a: express.Express) => request(a).delete('/api/providers/p1'), 'delete'],
    ['activate', (a: express.Express) => request(a).post('/api/providers/p1/activate'), 'activate'],
    ['runtime', (a: express.Express) => request(a).post('/api/providers/p1/runtime').send({agentRuntime: 'claude-agent-sdk'}), 'switchAgentRuntime'],
    ['rotate secret', (a: express.Express) => request(a).post('/api/providers/p1/rotate-secret'), 'rotateSecret'],
  ] as const)('provider %s answers a secret-store failure with fixed text', async (_name, send, method) => {
    mockProviderService[method].mockImplementation(() => mockState.downstream());

    expectFixedFailure(await send(app).set('X-Request-Id', 'req-leak-test'), 500, 'provider_operation_failed');
  });

  test('provider validation and not-found errors keep their user-facing text', async () => {
    mockProviderService.create.mockImplementation(() => {
      throw invalidProviderRequest('Provider name is required');
    });
    mockProviderService.update.mockImplementation(() => {
      throw providerNotFound('p404');
    });

    const invalid = await request(app).post('/api/providers').send({});
    expect(invalid.status).toBe(400);
    expect(invalid.body).toEqual({success: false, code: 'provider_invalid_request', error: 'Provider name is required'});

    const missing = await request(app).patch('/api/providers/p404').send({});
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({success: false, code: 'provider_not_found', error: 'Provider not found: p404'});
  });

  test('a trace list limit error keeps its text, an unrelated RangeError does not', async () => {
    const invalid = await request(app).get('/api/traces?limit=0');
    expect(invalid.status).toBe(400);
    expect(invalid.body).toEqual({code: 'INVALID_TRACE_LIST_PAGE', error: 'Trace list limit must be between 1 and 200'});

    mockState.contextFailure = new RangeError(CANARY);
    expectFixedFailure(await request(app).get('/api/traces').set('X-Request-Id', 'req-leak-test'), 500, 'trace_list_failed');
  });

  test('an invalid log level keeps its validation text behind a code', async () => {
    const res = await request(app).put('/api/agent/v1/admin/log-level').send({level: 'loud'});

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_log_level');
    expect(res.body.error).toMatch(/^Invalid log level: loud\. Valid: /);
  });
});

/**
 * The remaining direct echoes in route catch blocks are typed validation
 * errors produced by our own code. A new one must be one of those too: adjust
 * this inventory only after checking that the echoed error cannot carry a
 * downstream message.
 */
describe('route exception echo inventory', () => {
  const ECHO = /error: (error|err|e)\??\.message/g;
  const ALLOWED: Record<string, number> = {
    'agentConversationRoutes.ts': 1, // AnalyzeOptionsError
    'enterpriseTenantRoutes.ts': 1, // EnterpriseAdminControlPlaneError
    'providerRoutes.ts': 1, // ProviderRequestError
    'providerStoreHttp.ts': 1, // ProviderStoreUnreadableError (fixed messages)
    'ragAdminRoutes.ts': 3, // NativeDirectoryPickerError, RagSearchInputError x2
    'simpleTraceRoutes.ts': 1, // InvalidTraceMetadataCursorError / TraceListLimitError
    'traceProcessorProxyRoutes.ts': 1, // TraceProcessorProxyError
  };

  test('only typed validation errors are echoed', () => {
    const routesDir = path.resolve(__dirname, '..');
    const found: Record<string, number> = {};
    for (const entry of fs.readdirSync(routesDir, {recursive: true, withFileTypes: true})) {
      if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
      const file = path.join(entry.parentPath, entry.name);
      if (file.includes(`${path.sep}__tests__${path.sep}`)) continue;
      const count = fs.readFileSync(file, 'utf8').match(ECHO)?.length ?? 0;
      if (count > 0) found[path.relative(routesDir, file)] = count;
    }
    expect(found).toEqual(ALLOWED);
  });
});
