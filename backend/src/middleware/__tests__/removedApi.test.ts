// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'fs';
import path from 'path';
import express from 'express';
import request from 'supertest';
import {
  getLegacyApiUsageSnapshot,
  resetLegacyApiUsageTelemetryForTests,
} from '../../services/legacyApiTelemetry';
import {
  AGENT_API_FALLBACK as FALLBACK,
  PERFETTO_SQL_SKILL_IDS,
  rejectRemovedPerfettoSqlApi,
  rejectRemovedSessionsApi,
  rejectRemovedSqlApi,
  rejectRemovedTemplateAnalysisApi,
} from '../removedApi';

function appFor(mount: string, handler: express.RequestHandler) {
  const app = express();
  app.use(mount, handler);
  return app;
}

const perfettoSqlApp = () => appFor('/api/perfetto-sql', rejectRemovedPerfettoSqlApi);

describe('removed /api/perfetto-sql', () => {
  afterEach(() => {
    resetLegacyApiUsageTelemetryForTests();
  });

  test('maps scene endpoints to the Skill with the same request body', async () => {
    const res = await request(perfettoSqlApp())
      .post('/api/perfetto-sql/click-response/?debug=1')
      .send({ traceId: 't1', packageName: "x' OR 1=1 --" })
      .expect(410);

    expect(res.headers.deprecation).toBe('true');
    expect(res.headers.sunset).toBeUndefined();
    expect(res.headers.link).toBe(
      '</api/skills/execute/click_response_analysis>; rel="successor-version"',
    );
    expect(res.body).toMatchObject({
      success: false,
      error: 'Perfetto SQL API has been removed',
      migration: { successor: '/api/skills/execute/click_response_analysis', fallback: FALLBACK },
    });
    expect(getLegacyApiUsageSnapshot().topPaths[0].key).toBe(
      'POST /api/perfetto-sql/click-response/',
    );
  });

  test('matches scene paths case-insensitively like the router it replaces', async () => {
    const res = await request(perfettoSqlApp()).head('/api/perfetto-sql/Startup').expect(410);
    expect(res.headers.link).toBe('</api/skills/execute/startup_analysis>; rel="successor-version"');
  });

  test.each([
    ['post', '/api/perfetto-sql/sql'],
    ['get', '/api/perfetto-sql/tables/slice'],
    ['post', '/api/perfetto-sql/analyze'],
    ['get', '/api/perfetto-sql'],
  ] as const)('%s %s has no direct successor', async (method, url) => {
    const res = await request(perfettoSqlApp())[method](url).send({ sql: 'SELECT 1' }).expect(410);
    expect(res.headers.link).toBeUndefined();
    expect(res.body.migration).toEqual({ successor: null, fallback: FALLBACK });
  });

  test.each(Object.values(PERFETTO_SQL_SKILL_IDS))('successor Skill %s exists', (skillId) => {
    const file = path.join(__dirname, '../../../skills/composite', `${skillId}.skill.yaml`);
    expect(fs.readFileSync(file, 'utf-8')).toMatch(new RegExp(`^name: ${skillId}$`, 'm'));
  });
});

describe('removed /api/sessions', () => {
  const sessionsFallback = '/api/agent/v1/sessions';
  const sessionsApp = () => {
    const app = express();
    app.use('/api/sessions', rejectRemovedSessionsApi);
    return app;
  };

  afterEach(() => {
    resetLegacyApiUsageTelemetryForTests();
  });

  test.each([
    ['get', '/api/sessions?traceId=t1', '/api/agent/v1/sessions'],
    ['get', '/api/sessions/agent-1790-abc', '/api/agent/v1/agent-1790-abc/turns'],
    ['delete', '/api/sessions/agent-1790-abc', '/api/agent/v1/agent-1790-abc'],
  ] as const)('%s %s points at its owner-scoped successor', async (method, url, successor) => {
    const res = await request(sessionsApp())[method](url).expect(410);
    expect(res.headers.link).toBe(`<${successor}>; rel="successor-version"`);
    expect(res.body).toMatchObject({
      success: false,
      error: 'Session API has been removed',
      migration: { successor, fallback: sessionsFallback },
    });
  });

  test.each([
    '/api/sessions/export',
    // A request path is never echoed into the Link header unless it is a plain session id.
    '/api/sessions/a%3Cscript%3E',
    '/api/sessions/a/b',
  ])('%s has no direct successor', async (url) => {
    const res = await request(sessionsApp()).get(url).expect(410);
    expect(res.headers.link).toBeUndefined();
    expect(res.body.migration).toEqual({ successor: null, fallback: sessionsFallback });
  });
});

describe('removed /api/template-analysis', () => {
  test.each([
    ['post', '/api/template-analysis/auto'],
    ['post', '/api/template-analysis/four-quadrant'],
    ['post', '/api/template-analysis/cpu-core'],
    ['post', '/api/template-analysis/frame-stats'],
    ['get', '/api/template-analysis'],
  ] as const)('%s %s answers 410 with the agent fallback', async (method, url) => {
    const app = appFor('/api/template-analysis', rejectRemovedTemplateAnalysisApi);
    const res = await request(app)[method](url).expect(410);

    expect(res.headers.link).toBeUndefined();
    expect(res.body).toMatchObject({
      success: false,
      error: 'Template analysis API has been removed',
      migration: { successor: null, fallback: FALLBACK },
    });
  });
});

describe('removed /api/sql', () => {
  beforeEach(() => {
    resetLegacyApiUsageTelemetryForTests();
  });

  test.each([
    ['get', '/api/sql/tables'],
    ['post', '/api/sql/generate'],
    ['get', '/api/sql'],
  ] as const)('%s %s answers 410 with the agent fallback', async (method, url) => {
    const app = appFor('/api/sql', rejectRemovedSqlApi);
    const res = await request(app)[method](url).send({ query: 'slowest frames' }).expect(410);

    expect(res.headers.deprecation).toBe('true');
    expect(res.headers.link).toBeUndefined();
    expect(res.body).toEqual({
      success: false,
      error: 'SQL generation API has been removed',
      message: `This endpoint has no direct successor; use ${FALLBACK}`,
      migration: { successor: null, fallback: FALLBACK },
    });
    expect(getLegacyApiUsageSnapshot().topPaths[0].key).toBe(`${method.toUpperCase()} ${url}`);
  });
});
