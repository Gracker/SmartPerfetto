// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {afterEach, describe, expect, it} from '@jest/globals';
import express from 'express';
import request from 'supertest';

import type {SceneReport} from '../../agent/scene/types';
import {
  agentRoutesSmartPreviewSelectionTestSeam,
  default as agentRoutes,
  buildSmartDeepDiveRunOptions,
  isUsableSmartPreviewReport,
  resolveSmartPreviewReportForSelection,
  smartPreviewSelectionErrorMessage,
  SmartPreviewSelectionError,
} from '../agentRoutes';

const originalAiEnabled = process.env.SMARTPERFETTO_AI_ENABLED;
const originalApiKey = process.env.SMARTPERFETTO_API_KEY;
const ROUTE_SESSION_ID = 'smart-stale-route-session';

afterEach(() => {
  if (originalAiEnabled === undefined) delete process.env.SMARTPERFETTO_AI_ENABLED;
  else process.env.SMARTPERFETTO_AI_ENABLED = originalAiEnabled;
  if (originalApiKey === undefined) delete process.env.SMARTPERFETTO_API_KEY;
  else process.env.SMARTPERFETTO_API_KEY = originalApiKey;
  agentRoutesSmartPreviewSelectionTestSeam.deleteSession(ROUTE_SESSION_ID);
});

const OWNER = {
  tenantId: 'tenant-a',
  workspaceId: 'workspace-a',
  userId: 'user-a',
};

function preview(overrides: Partial<SceneReport> = {}): SceneReport {
  return {
    reportId: 'preview-1',
    ...OWNER,
    traceHash: null,
    traceId: 'trace-1',
    traceOrigin: 'external_rpc',
    cachePolicy: 'memory_session',
    expiresAt: null,
    createdAt: Date.now(),
    phase: 'selection_preview',
    traceMeta: {durationSec: 1},
    displayedScenes: [],
    cachedDataEnvelopes: [],
    jobs: [],
    summary: '场景盘点完成，请选择需要深钻的范围。',
    insights: [],
    partialReport: false,
    totalDurationMs: 1,
    generatedBy: {runtime: 'claude-sdk', pipelineVersion: 'v2'},
    ...overrides,
  };
}

describe('Smart preview selection binding', () => {
  it('accepts only the exact live preview for the same trace and owner', () => {
    expect(isUsableSmartPreviewReport(preview(), 'trace-1', OWNER, 'preview-1')).toBe(true);
    expect(isUsableSmartPreviewReport(
      preview({phase: 'analyzed'}),
      'trace-1',
      OWNER,
      'preview-1',
    )).toBe(false);
    expect(isUsableSmartPreviewReport(
      preview({expiresAt: Date.now() - 1}),
      'trace-1',
      OWNER,
      'preview-1',
    )).toBe(false);
    expect(isUsableSmartPreviewReport(preview(), 'trace-other', OWNER, 'preview-1')).toBe(false);
  });

  it('fails closed for a stale explicit report even when selecting all scenes', async () => {
    await expect(resolveSmartPreviewReportForSelection({
      session: {sceneStoryReport: undefined} as any,
      selection: {scope: 'all', reportId: 'stale-preview'},
      traceId: 'trace-1',
      owner: OWNER,
      loadReport: async () => null,
    })).rejects.toBeInstanceOf(SmartPreviewSelectionError);
  });

  it('allows a fresh preview only when no report identity was supplied', async () => {
    await expect(resolveSmartPreviewReportForSelection({
      session: {sceneStoryReport: undefined} as any,
      selection: {scope: 'all'},
      traceId: 'trace-1',
      owner: OWNER,
      loadReport: async () => {
        throw new Error('must not load without an explicit report id');
      },
    })).resolves.toBeNull();
  });

  it('localizes a stale preview response without changing the stable error code', () => {
    expect(smartPreviewSelectionErrorMessage('zh-CN', 'preview-stale'))
      .toContain('不可用、已过期或不再被授权');
    expect(smartPreviewSelectionErrorMessage('en', 'preview-stale'))
      .toContain("Smart scene inventory 'preview-stale' is unavailable");
    expect(new SmartPreviewSelectionError('preview-stale')).toMatchObject({
      code: 'smart_preview_selection_stale',
      reportId: 'preview-stale',
    });
  });

  it.each([
    ['neither', {}, {analysisMode: 'fast'}],
    ['source only', {
      codeAwareMode: 'metadata_only',
      codebaseIds: ['app-source'],
    }, {
      analysisMode: 'fast',
      codeAwareMode: 'metadata_only',
      codebaseIds: ['app-source'],
    }],
    ['RAG only', {knowledgeSourceIds: ['wiki']}, {
      analysisMode: 'full',
      knowledgeSourceIds: ['wiki'],
    }],
    ['source and RAG', {
      codeAwareMode: 'provider_send',
      codebaseIds: ['app-source'],
      knowledgeSourceIds: ['wiki'],
    }, {
      analysisMode: 'full',
      codeAwareMode: 'provider_send',
      codebaseIds: ['app-source'],
      knowledgeSourceIds: ['wiki'],
    }],
  ] as const)('preserves the exact %s context at the Smart route dispatch boundary', (
    _label,
    privateContext,
    expected,
  ) => {
    const expectedContext = expected as {
      codebaseIds?: readonly string[];
      knowledgeSourceIds?: readonly string[];
    };
    const options = buildSmartDeepDiveRunOptions({
      traceProcessorService: {} as any,
      runContext: {runId: 'run-1', requestId: 'request-1', sequence: 1} as any,
      dispatch: {
        query: 'Analyze selected scenes',
        selectedScenes: [],
      },
      outputLanguage: 'en',
      analysisMode: 'fast',
      runManifestAttributionSink: {} as any,
      ...privateContext,
    });

    expect(options).toEqual(expect.objectContaining(expected));
    if (expectedContext.codebaseIds === undefined) expect(options).not.toHaveProperty('codebaseIds');
    if (expectedContext.knowledgeSourceIds === undefined) {
      expect(options).not.toHaveProperty('knowledgeSourceIds');
    }
  });

  it('returns stale explicit preview 409 before creating or mutating a session', async () => {
    delete process.env.SMARTPERFETTO_API_KEY;
    process.env.SMARTPERFETTO_AI_ENABLED = 'true';
    const app = express();
    app.use(express.json());
    app.use('/api/agent/v1', agentRoutes);

    const res = await request(app).post('/api/agent/v1/analyze').send({
      traceId: 'trace-does-not-need-to-exist',
      sessionId: ROUTE_SESSION_ID,
      query: 'Analyze selected scenes',
      options: {
        preset: 'smart',
        smartAction: 'analyze',
        outputLanguage: 'en',
        smartSelection: {scope: 'all', reportId: 'stale-explicit-preview'},
      },
    });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      success: false,
      code: 'smart_preview_selection_stale',
    });
    expect(agentRoutesSmartPreviewSelectionTestSeam.hasSession(ROUTE_SESSION_ID)).toBe(false);
  });
});
