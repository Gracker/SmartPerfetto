// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * The route families that echoed exception text through other spellings
 * (`instanceof Error ? message`, `details`, `message`, stored job errors,
 * reason codes): a downstream exception reaches only the server log, while a
 * typed error SmartPerfetto wrote for the caller, or a service reason token,
 * keeps its text and code.
 */

import express from 'express';
import request from 'supertest';
import type { RequestContext } from '../../middleware/auth';
import { createBaselineRoutes } from '../baselineRoutes';
import { createCaseRoutes } from '../caseRoutes';
import { createMemoryRoutes } from '../memoryRoutes';
import { createEnterpriseApiKeyRouter } from '../enterpriseApiKeyRoutes';
import { createRagAdminRoutes } from '../ragAdminRoutes';
import { createSelfEvolutionAdminRoutes } from '../selfEvolutionAdminRoutes';
import traceConfigProposalRoutes from '../traceConfigProposalRoutes';
import { KnowledgeCurationError } from '../../services/knowledgeCurationError';
import { ApiKeyRequestError } from '../../services/enterpriseApiKeyService';
import { KnowledgeSourceRequestError } from '../../services/externalKnowledgeSourceRegistry';
import { CodebaseManagementError } from '../../services/codebase/codebaseManagementService';
import { NativeDirectoryPickerError } from '../../services/codebase/nativeDirectoryPicker';
import * as traceConfigProposal from '../../services/traceConfigProposal';
import { ConversationRequestError, ConversationSessionService } from '../../assistant/application/conversationSessionService';

const CANARY = 'canary-7e3a /Users/someone/.smartperfetto/secret.db SELECT api_key FROM providers';

jest.mock('../../middleware/auth', () => {
  const actual = jest.requireActual('../../middleware/auth');
  const passThrough = (_req: unknown, _res: unknown, next: () => void) => next();
  return {...actual, authenticate: passThrough, attachRequestContext: passThrough};
});

const context: RequestContext = {
  tenantId: 'tenant-a',
  workspaceId: 'workspace-a',
  userId: 'user-a',
  authType: 'dev',
  roles: ['org_admin'],
  scopes: ['*'],
  requestId: 'req-route-failure-variants',
};

function appWith(mount: (app: express.Express) => void): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    // The request id comes from the caller's correlation header.
    req.headers['x-request-id'] = context.requestId;
    (req as express.Request & {requestContext?: RequestContext}).requestContext = {...context};
    next();
  });
  mount(app);
  return app;
}

const downstream = (): never => {
  throw new Error(CANARY);
};

describe('route failure variants', () => {
  let errorLog: jest.SpyInstance;
  let warnLog: jest.SpyInstance;

  beforeEach(() => {
    errorLog = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    warnLog = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
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
    expect(res.body).toEqual({success: false, code, error: expect.any(String), requestId: context.requestId});
    expect(res.text).not.toContain('canary-7e3a');
    expect(res.headers['x-request-id']).toBe(context.requestId);
    expect(loggedText()).toContain(CANARY);
  }

  /**
   * A route that reads a user's folder logs a failure through
   * `pathFreeFailure`: the fixed answer, and a log that keeps the error's
   * class and frames but not its message, which can carry the folder's path.
   */
  function expectPathFreeFixedFailure(res: request.Response, status: number, code: string): void {
    expect(res.status).toBe(status);
    expect(res.body).toEqual({success: false, code, error: expect.any(String), requestId: context.requestId});
    expect(res.text).not.toContain('canary-7e3a');
    expect(loggedText()).toContain(code);
    expect(loggedText()).not.toContain('canary-7e3a');
  }

  function expectPublicError(res: request.Response, status: number, code: string, error: string): void {
    expect(res.status).toBe(status);
    expect(res.body).toEqual({success: false, code, error, requestId: context.requestId});
  }

  describe('knowledge curation', () => {
    test('baseline save: a store failure is fixed, a publish gate keeps its text', async () => {
      const store = {addBaseline: jest.fn(downstream)};
      const app = appWith(a => a.use('/api/baselines', createBaselineRoutes(store as never)));
      const record = {baselineId: 'b1', key: {}, status: 'published'};

      expectFixedFailure(await request(app).post('/api/baselines').send(record), 500, 'baseline_save_failed');

      store.addBaseline.mockImplementation(() => {
        throw new KnowledgeCurationError('baseline_publish_rejected', 'Baseline \'b1\' cannot be published');
      });
      expectPublicError(await request(app).post('/api/baselines').send(record), 400,
        'baseline_publish_rejected', 'Baseline \'b1\' cannot be published');
    });

    test('case publish: not found is a typed 404, a storage failure no longer matches /not found/', async () => {
      const library = {publishCase: jest.fn(() => {
        throw new KnowledgeCurationError('case_not_found', 'Cannot publish case \'c1\': not found', 404);
      })};
      const app = appWith(a => a.use('/api/cases', createCaseRoutes(library as never, {} as never)));

      expectPublicError(await request(app).post('/api/cases/c1/publish').send({reviewer: 'r'}), 404,
        'case_not_found', 'Cannot publish case \'c1\': not found');

      library.publishCase.mockImplementation(() => {
        throw new Error(`${CANARY} row not found`);
      });
      expectFixedFailure(await request(app).post('/api/cases/c1/publish').send({reviewer: 'r'}), 500, 'case_publish_failed');
    });

    test('memory promote answers a storage failure with fixed text', async () => {
      const memory = {promoteEntry: jest.fn(downstream)};
      const app = appWith(a => a.use('/api/memory', createMemoryRoutes(memory as never)));

      expectFixedFailure(
        await request(app).post('/api/memory/promote').send({entryId: 'm1', policy: {trigger: 'user_feedback'}}),
        500,
        'memory_promotion_failed',
      );
    });
  });

  test('enterprise API key: delegation errors keep text, database failures do not', async () => {
    const apiKeyService = {createApiKey: jest.fn(downstream)};
    const app = appWith(a => a.use('/api/auth', createEnterpriseApiKeyRouter({apiKeyService: apiKeyService as never})));

    expectFixedFailure(await request(app).post('/api/auth/api-keys').send({}), 500, 'api_key_create_failed');

    apiKeyService.createApiKey.mockImplementation(() => {
      throw new ApiKeyRequestError('expiresAt must be in the future');
    });
    expectPublicError(await request(app).post('/api/auth/api-keys').send({}), 400,
      'invalid_api_key_request', 'expiresAt must be in the future');
  });

  test('trace config proposal: field validation keeps its text, an internal failure is fixed', async () => {
    const app = appWith(a => a.use('/api/trace-config', traceConfigProposalRoutes));

    expectPublicError(
      await request(app).post('/api/trace-config/proposals').send({request: 'startup', durationSeconds: -1}),
      400,
      'invalid_trace_config_proposal',
      'durationSeconds must be a positive number',
    );

    jest.spyOn(traceConfigProposal, 'buildTraceConfigProposal').mockImplementation(downstream);
    expectFixedFailure(await request(app).post('/api/trace-config/proposals').send({request: 'startup'}), 500,
      'trace_config_proposal_failed');
  });

  describe('RAG admin', () => {
    const services = {
      registry: {},
      gate: {},
      sourceEnumerator: {},
      appSourceIngester: {},
      aospSourceIngester: {},
      kernelSourceIngester: {},
      directoryPicker: {validateSelection: jest.fn(() => {
        throw new NativeDirectoryPickerError('DIRECTORY_PICKER_FAILED', 'Unable to open the system directory picker', 500,
          new Error(CANARY));
      })},
      codebaseManagementService: {get: jest.fn(downstream), delete: jest.fn(async (): Promise<never> => downstream())},
      externalKnowledgeRegistry: {get: jest.fn(() => ({id: 'k1', kind: 'android_internals_wiki'})), setProviderConsent: jest.fn(downstream)},
      androidInternalsWikiIngester: {ingest: jest.fn(async (): Promise<never> => downstream())},
    };
    const app = () => appWith(a => a.use('/api/rag', createRagAdminRoutes({} as never, services as never)));

    test('knowledge source consent: unknown source is a typed 404, a database failure is fixed', async () => {
      expectFixedFailure(
        await request(app()).patch('/api/rag/android-internals/sources/k1/consent').send({sendToProvider: true}),
        500,
        'knowledge_source_consent_failed',
      );

      services.externalKnowledgeRegistry.setProviderConsent.mockImplementation(() => {
        throw new KnowledgeSourceRequestError('KNOWLEDGE_SOURCE_NOT_FOUND', 'External knowledge source \'k1\' not found', 404);
      });
      expectPublicError(
        await request(app()).patch('/api/rag/android-internals/sources/k1/consent').send({sendToProvider: true}),
        404,
        'KNOWLEDGE_SOURCE_NOT_FOUND',
        'External knowledge source \'k1\' not found',
      );
    });

    test('knowledge source reindex: a reason token keeps its code without its detail, prose is fixed', async () => {
      services.androidInternalsWikiIngester.ingest.mockImplementation(async () => {
        throw new Error('source_changed_during_ingest:docs/secret-canary-7e3a.md');
      });
      const reason = await request(app()).post('/api/rag/android-internals/sources/k1/reindex');
      expect(reason.status).toBe(400);
      expect(reason.body).toEqual({
        success: false,
        code: 'source_changed_during_ingest',
        error: 'source_changed_during_ingest',
        requestId: context.requestId,
      });
      // A rejection, not a fault: logged at warn level with the dropped detail.
      expect(JSON.stringify(warnLog.mock.calls)).toContain('secret-canary-7e3a');

      services.androidInternalsWikiIngester.ingest.mockImplementation(async () => downstream());
      expectPathFreeFixedFailure(await request(app()).post('/api/rag/android-internals/sources/k1/reindex'), 500,
        'knowledge_source_reindex_failed');
    });

    test('an internal reason token gets fixed text; a caller-facing one keeps its code', async () => {
      services.androidInternalsWikiIngester.ingest.mockImplementation(async () => {
        throw new Error('staged_chunk_count_mismatch:3:2');
      });
      const internal = await request(app()).post('/api/rag/android-internals/sources/k1/reindex');
      expect(internal.status).toBe(500);
      expect(internal.body.code).toBe('knowledge_source_reindex_failed');
      expect(internal.text).not.toContain('staged_chunk_count_mismatch');

      // A caller-facing family prefix does not make an unlisted token public.
      services.androidInternalsWikiIngester.ingest.mockImplementation(async () => {
        throw new Error('codebase_delete_not_started');
      });
      const prefixed = await request(app()).post('/api/rag/android-internals/sources/k1/reindex');
      expect(prefixed.status).toBe(500);
      expect(prefixed.body.code).toBe('knowledge_source_reindex_failed');
      expect(prefixed.text).not.toContain('codebase_delete_not_started');

      services.androidInternalsWikiIngester.ingest.mockImplementation(async () => {
        throw new Error('provider_send_not_consented');
      });
      const consent = await request(app()).post('/api/rag/android-internals/sources/k1/reindex');
      expect(consent.status).toBe(400);
      expect(consent.body.code).toBe('provider_send_not_consented');
    });

    test('a server-side directory picker failure keeps its fixed text and logs its cause', async () => {
      const res = await request(app()).post('/api/rag/codebases/preview')
        .set('Origin', 'http://127.0.0.1:10000')
        .send({rootPath: '/src/app', directorySelectionId: 'selection-1'});
      expectPublicError(res, 500, 'DIRECTORY_PICKER_FAILED', 'Unable to open the system directory picker');
      expect(res.text).not.toContain('canary-7e3a');
      const logged = errorLog.mock.calls.flat().find(value => value instanceof NativeDirectoryPickerError);
      expect((logged as NativeDirectoryPickerError | undefined)?.cause).toEqual(new Error(CANARY));
    });

    test('codebase delete: a storage failure is fixed', async () => {
      expectFixedFailure(await request(app()).delete('/api/rag/codebases/cb1'), 500, 'CODEBASE_DELETE_FAILED');
    });

    test('codebase read: a management error keeps its status, anything else is fixed', async () => {
      expectFixedFailure(await request(app()).get('/api/rag/codebases/cb1'), 500, 'CODEBASE_READ_FAILED');

      services.codebaseManagementService.get.mockImplementation(() => {
        throw new CodebaseManagementError('CODEBASE_NOT_FOUND', 404, 'Codebase \'cb1\' not found');
      });
      expectPublicError(await request(app()).get('/api/rag/codebases/cb1'), 404,
        'CODEBASE_NOT_FOUND', 'Codebase \'cb1\' not found');
    });
  });

  test('self-evolution answers prose with its fallback code and logs it', async () => {
    const service = {overview: jest.fn(downstream)};
    const app = appWith(a => a.use('/api/admin/self-evolution', createSelfEvolutionAdminRoutes(service as never)));

    const prose = await request(app).get('/api/admin/self-evolution/overview');
    expect(prose.status).toBe(500);
    expect(prose.body).toEqual({success: false, error: 'self_evolution_request_failed'});
    expect(loggedText()).toContain(CANARY);

    service.overview.mockImplementation(() => {
      throw new Error('curation_proposal_not_found');
    });
    const reason = await request(app).get('/api/admin/self-evolution/overview');
    expect(reason.status).toBe(404);
    expect(reason.body).toEqual({success: false, error: 'curation_proposal_not_found'});
  });

  test('conversation errors the routes return are typed with a code and status', () => {
    const service = new ConversationSessionService({createRuntime: () => ({}) as never});

    expect(() => service.startTurn({query: ' '} as never)).toThrow(ConversationRequestError);
    expect(() => service.startTurn({query: 'q', sessionId: 'missing'} as never)).toThrow(
      expect.objectContaining({code: 'CONVERSATION_NOT_FOUND', status: 404}),
    );
    return expect(service.cancelRun('missing', 'run-1')).rejects.toMatchObject({
      code: 'CONVERSATION_NOT_FOUND',
      status: 404,
    });
  });
});
