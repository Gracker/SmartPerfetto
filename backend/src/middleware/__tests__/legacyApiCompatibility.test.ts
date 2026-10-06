// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import express from 'express';
import request from 'supertest';
import {createLoopbackServerFixture} from '../../../tests/helpers/loopbackServer';
import {
  getLegacyApiUsageSnapshot,
  resetLegacyApiUsageTelemetryForTests,
} from '../../services/legacyApiTelemetry';
import { LEGACY_AGENT_API_SUNSET, markLegacyApi } from '../legacyAgentApi';
import { rejectLegacyAgentApi } from '../removedApi';

const loopbackServers = createLoopbackServerFixture();

describe('legacy API compatibility headers', () => {
  afterEach(async () => {
    await loopbackServers.close();
    resetLegacyApiUsageTelemetryForTests();
  });

  test('adds deprecation headers and records telemetry before delegating to current handlers', async () => {
    const app = express();
    app.get(
      '/api/traces',
      markLegacyApi(
        '/api/workspaces/:workspaceId/traces',
        'Legacy trace API is deprecated. Migrate to workspace-scoped trace APIs',
      ),
      (_req, res) => res.json({ success: true }),
    );

    const res = await request(await loopbackServers.listen(app))
      .get('/api/traces')
      .set('Authorization', 'Bearer test-token')
      .expect(200);

    expect(res.headers.deprecation).toBe('true');
    expect(res.headers.sunset).toBe(LEGACY_AGENT_API_SUNSET);
    expect(res.headers.link).toBe(
      '</api/workspaces/:workspaceId/traces>; rel="successor-version"',
    );
    expect(res.headers.warning).toContain('Legacy trace API is deprecated');
    expect(res.body).toEqual({ success: true });

    const telemetry = getLegacyApiUsageSnapshot();
    expect(telemetry.totalLegacyRequests).toBe(1);
    expect(telemetry.topPaths[0].key).toBe('GET /api/traces');
  });

  test('rejects removed legacy agent paths with mapped successors and telemetry', async () => {
    const app = express();
    app.use('/api/agent', rejectLegacyAgentApi);

    const res = await request(await loopbackServers.listen(app))
      .post('/api/agent/llm/completions?debug=1')
      .set('Authorization', 'Bearer legacy-token')
      .send({ prompt: 'hello' })
      .expect(410);

    expect(res.headers.deprecation).toBe('true');
    expect(res.headers.sunset).toBe(LEGACY_AGENT_API_SUNSET);
    expect(res.headers.link).toBe('</api/agent/v1>; rel="successor-version"');
    expect(res.headers.warning).toBe('299 - "Legacy agent API has been removed. Use /api/agent/v1"');
    expect(res.body).toEqual({
      success: false,
      error: 'Legacy agent API has been removed',
      message: 'Please migrate this request to /api/agent/v1/analyze',
      migration: {
        successor: '/api/agent/v1/analyze',
        root: '/api/agent/v1',
        analyze: '/api/agent/v1/analyze',
      },
    });

    const telemetry = getLegacyApiUsageSnapshot();
    expect(telemetry.totalLegacyRequests).toBe(1);
    expect(telemetry.topPaths[0].key).toBe('POST /api/agent/llm/completions');
    expect(telemetry.topAuthSubjects[0]?.authSubject).toMatch(/^bearer:/);
  });

  test.each([
    ['/api/agent', '/api/agent/v1'],
    ['/api/agent/sessions/abc?x=1', '/api/agent/v1/sessions/abc'],
  ])('maps %s to its v1 path while linking the v1 root', async (url, successor) => {
    const app = express();
    app.use('/api/agent', rejectLegacyAgentApi);

    const res = await request(await loopbackServers.listen(app)).get(url).expect(410);

    expect(res.headers.link).toBe('</api/agent/v1>; rel="successor-version"');
    expect(res.body.message).toBe(`Please migrate this request to ${successor}`);
    expect(res.body.migration).toEqual({
      successor,
      root: '/api/agent/v1',
      analyze: '/api/agent/v1/analyze',
    });
  });

  test('passes through the current /api/agent/v1 subtree when mounted at the legacy root', async () => {
    const app = express();
    app.use('/api/agent', rejectLegacyAgentApi);
    app.get('/api/agent/v1/status', (_req, res) => res.json({ ok: true }));

    const res = await request(await loopbackServers.listen(app))
      .get('/api/agent/v1/status')
      .expect(200);

    expect(res.headers.deprecation).toBeUndefined();
    expect(res.body).toEqual({ ok: true });
    expect(getLegacyApiUsageSnapshot().totalLegacyRequests).toBe(0);
  });
});
