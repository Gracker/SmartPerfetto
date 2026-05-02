// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {describe, it, expect, beforeEach, afterEach} from '@jest/globals';
import express from 'express';
import request from 'supertest';

import {createBaselineRoutes} from '../baselineRoutes';
import {BaselineStore} from '../../services/baselineStore';
import {
  type BaselineRecord,
  type PerfBaselineKey,
  makeSparkProvenance,
} from '../../types/sparkContracts';

const ANON_KEY: PerfBaselineKey = {
  appId: 'anon-app-001',
  deviceId: 'anon-device-001',
  buildId: 'main-abc1234',
  cuj: 'scroll_feed',
};

const RAW_KEY: PerfBaselineKey = {
  appId: 'com.example.feed',
  deviceId: 'pixel-9-android-15',
  buildId: 'main-abc1234',
  cuj: 'scroll_feed',
};

function makeBaseline(overrides: Partial<BaselineRecord> = {}): BaselineRecord {
  const key = overrides.key ?? ANON_KEY;
  return {
    ...makeSparkProvenance({source: 'baseline-routes-test'}),
    baselineId:
      overrides.baselineId ??
      `${key.appId}/${key.deviceId}/${key.buildId}/${key.cuj}`,
    artifactId: 'artifact-001',
    capturedAt: 1714600000000,
    sampleCount: 12,
    key,
    status: 'reviewed',
    redactionState: 'partial',
    windowStartMs: 1714000000000,
    windowEndMs: 1714600000000,
    metrics: [],
    ...overrides,
  };
}

let tmpDir: string;
let app: express.Express;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'baseline-route-test-'));
  const store = new BaselineStore(path.join(tmpDir, 'baselines.json'));
  app = express();
  app.use(express.json({limit: '5mb'}));
  app.use('/api/baselines', createBaselineRoutes(store));
});

afterEach(() => {
  if (fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, {recursive: true, force: true});
  }
});

describe('POST /api/baselines', () => {
  it('creates a baseline and returns 201', async () => {
    const record = makeBaseline({baselineId: 'b1'});
    const res = await request(app).post('/api/baselines').send(record);
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.baseline.baselineId).toBe('b1');
  });

  it('rejects an empty body with 400', async () => {
    const res = await request(app).post('/api/baselines').send({});
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('surfaces publish-invariant errors as 400', async () => {
    const record = makeBaseline({
      baselineId: 'b-bad',
      key: RAW_KEY,
      status: 'published',
      redactionState: 'partial',
      sampleCount: 12,
    });
    const res = await request(app).post('/api/baselines').send(record);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/redactionState/);
  });
});

describe('GET /api/baselines/:id', () => {
  it('returns the baseline when present', async () => {
    const record = makeBaseline({baselineId: 'b1'});
    await request(app).post('/api/baselines').send(record);
    const res = await request(app).get('/api/baselines/b1');
    expect(res.status).toBe(200);
    expect(res.body.baseline.baselineId).toBe('b1');
  });

  it('returns 404 when missing', async () => {
    const res = await request(app).get('/api/baselines/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });
});

describe('DELETE /api/baselines/:id', () => {
  it('removes a baseline and returns 200', async () => {
    await request(app)
      .post('/api/baselines')
      .send(makeBaseline({baselineId: 'b1'}));
    const res = await request(app).delete('/api/baselines/b1');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const get = await request(app).get('/api/baselines/b1');
    expect(get.status).toBe(404);
  });

  it('returns 404 when removing a missing id', async () => {
    const res = await request(app).delete('/api/baselines/missing');
    expect(res.status).toBe(404);
  });
});

describe('GET /api/baselines (list)', () => {
  beforeEach(async () => {
    await request(app)
      .post('/api/baselines')
      .send(makeBaseline({baselineId: 'a/d/b/c', status: 'draft'}));
    await request(app)
      .post('/api/baselines')
      .send(
        makeBaseline({
          baselineId: 'b/d/b/c',
          status: 'published',
          redactionState: 'raw',
          sampleCount: 5,
        }),
      );
    await request(app)
      .post('/api/baselines')
      .send(makeBaseline({baselineId: 'b/e/b/c', status: 'reviewed'}));
  });

  it('lists all baselines without filters', async () => {
    const res = await request(app).get('/api/baselines');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(3);
    expect(res.body.baselines.map((b: BaselineRecord) => b.baselineId)).toEqual([
      'a/d/b/c',
      'b/d/b/c',
      'b/e/b/c',
    ]);
  });

  it('respects status filter', async () => {
    const res = await request(app).get('/api/baselines?status=published');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.baselines[0].baselineId).toBe('b/d/b/c');
  });

  it('respects keyPrefix filter', async () => {
    const res = await request(app).get('/api/baselines?keyPrefix=b/');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
  });
});
