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
import { PERFETTO_SQL_SKILL_IDS, rejectRemovedPerfettoSqlApi } from '../removedApi';

const FALLBACK = '/api/workspaces/:workspaceId/agent';

function perfettoSqlApp() {
  const app = express();
  app.use('/api/perfetto-sql', rejectRemovedPerfettoSqlApi);
  return app;
}

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
