// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  jest,
} from '@jest/globals';
import express from 'express';
import request from 'supertest';

import {authenticate} from '../../middleware/auth';
import {BaselineStore} from '../../services/baselineStore';
import {CiGateRunStore} from '../../services/ciGateRunStore';
import {createCiGateRoutes} from '../ciGateRoutes';
import {
  BaselineRecord,
  PerfBaselineKey,
  makeSparkProvenance,
} from '../../types/sparkContracts';
import {createLoopbackServerFixture} from '../../../tests/helpers/loopbackServer';

const loopbackServers = createLoopbackServerFixture();

const ANON_KEY: PerfBaselineKey = {
  appId: 'anon-app-001',
  deviceId: 'anon-device-001',
  buildId: 'main-abc1234',
  cuj: 'scroll_feed',
};

function makeBaseline(
  overrides: Partial<BaselineRecord> = {},
): BaselineRecord {
  const key = overrides.key ?? ANON_KEY;
  return {
    ...makeSparkProvenance({source: 'ci-gate-route-test'}),
    baselineId:
      overrides.baselineId ??
      `${key.appId}/${key.deviceId}/${key.buildId}/${key.cuj}`,
    artifactId: 'artifact-001',
    capturedAt: 1714600000000,
    sampleCount: 10,
    key,
    status: overrides.status ?? 'published',
    redactionState: overrides.redactionState ?? 'raw',
    windowStartMs: 1714000000000,
    windowEndMs: 1714600000000,
    metrics: overrides.metrics ?? [
      {
        metricId: 'frames.jank.p95',
        unit: 'ms',
        median: 5,
        p95: 8,
        p99: 12,
        max: 20,
        sampleCount: 10,
      },
    ],
    ...overrides,
  };
}

let tmpDir: string;
let app: express.Express;
let server: Awaited<ReturnType<typeof loopbackServers.listen>>;
let baselineStore: BaselineStore;
let runStore: CiGateRunStore;
const baselineId = `${ANON_KEY.appId}/${ANON_KEY.deviceId}/${ANON_KEY.buildId}/${ANON_KEY.cuj}`;
const originalApiKey = process.env.SMARTPERFETTO_API_KEY;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-gate-route-test-'));
  baselineStore = new BaselineStore(path.join(tmpDir, 'baselines.json'));
  runStore = new CiGateRunStore({dbPath: ':memory:'});
  app = express();
  app.use(express.json({limit: '5mb'}));
  app.use(
    '/api/ci',
    authenticate,
    createCiGateRoutes({baselineStore, runStore}),
  );
  server = await loopbackServers.listen(app);
});

afterEach(async () => {
  await loopbackServers.close();
  runStore.close();
  if (fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, {recursive: true, force: true});
  }
  if (originalApiKey === undefined) {
    delete process.env.SMARTPERFETTO_API_KEY;
  } else {
    process.env.SMARTPERFETTO_API_KEY = originalApiKey;
  }
  jest.restoreAllMocks();
});

const validBody = () => ({
  gateId: 'startup-cold-p95',
  baselineId,
  ciSource: 'github_actions',
  rules: [{metricId: 'frames.jank.p95', threshold: 0.1}],
  candidate: {
    kind: 'trace',
    traceId: 't-001',
    metrics: [
      {
        metricId: 'frames.jank.p95',
        unit: 'ms',
        median: 5,
        p95: 9,
        p99: 13,
        max: 22,
        sampleCount: 10,
      },
    ],
  },
});

describe('POST /api/ci/gate-eval — auth', () => {
  it('returns 401 when SMARTPERFETTO_API_KEY is set and the request lacks a bearer', async () => {
    process.env.SMARTPERFETTO_API_KEY = 'test-secret';
    baselineStore.addBaseline(makeBaseline());
    const res = await request(server).post('/api/ci/gate-eval').send(validBody());
    expect(res.status).toBe(401);
  });

  it('returns 401 when the bearer token does not match', async () => {
    process.env.SMARTPERFETTO_API_KEY = 'test-secret';
    baselineStore.addBaseline(makeBaseline());
    const res = await request(server)
      .post('/api/ci/gate-eval')
      .set('Authorization', 'Bearer wrong')
      .send(validBody());
    expect(res.status).toBe(401);
  });

  it('passes when the bearer matches the configured key', async () => {
    process.env.SMARTPERFETTO_API_KEY = 'test-secret';
    baselineStore.addBaseline(makeBaseline());
    const res = await request(server)
      .post('/api/ci/gate-eval')
      .set('Authorization', 'Bearer test-secret')
      .send(validBody());
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('passes in dev fallback (no env configured) so local development is unblocked', async () => {
    delete process.env.SMARTPERFETTO_API_KEY;
    baselineStore.addBaseline(makeBaseline());
    const res = await request(server).post('/api/ci/gate-eval').send(validBody());
    expect(res.status).toBe(200);
  });
});

describe('POST /api/ci/gate-eval — body validation', () => {
  beforeEach(() => {
    delete process.env.SMARTPERFETTO_API_KEY;
    baselineStore.addBaseline(makeBaseline());
  });

  it('rejects missing gateId', async () => {
    const body = validBody();
    delete (body as Record<string, unknown>).gateId;
    const res = await request(server).post('/api/ci/gate-eval').send(body);
    expect(res.status).toBe(400);
  });

  it('rejects empty rules array', async () => {
    const body = {...validBody(), rules: []};
    const res = await request(server).post('/api/ci/gate-eval').send(body);
    expect(res.status).toBe(400);
  });

  it('rejects rules entry without numeric threshold', async () => {
    const body = {
      ...validBody(),
      rules: [{metricId: 'm', threshold: 'high'}],
    };
    const res = await request(server).post('/api/ci/gate-eval').send(body);
    expect(res.status).toBe(400);
  });

  it('rejects ciSource with disallowed characters', async () => {
    const body = {...validBody(), ciSource: 'foo bar'};
    const res = await request(server).post('/api/ci/gate-eval').send(body);
    expect(res.status).toBe(400);
  });

  it("rejects candidate kind='trace' without metrics", async () => {
    const body = {
      ...validBody(),
      candidate: {kind: 'trace', traceId: 't'},
    };
    const res = await request(server).post('/api/ci/gate-eval').send(body);
    expect(res.status).toBe(400);
  });
});

describe('POST /api/ci/gate-eval — skipped runs are still persisted with runId', () => {
  beforeEach(() => {
    delete process.env.SMARTPERFETTO_API_KEY;
  });

  it('records a skipped run when the baseline is missing', async () => {
    const res = await request(server).post('/api/ci/gate-eval').send(validBody());
    expect(res.status).toBe(200);
    expect(res.body.skipReason).toBe('baseline_not_found');
    expect(res.body.runId).toBeTruthy();
    const stored = runStore.getRun(res.body.runId);
    expect(stored?.result.status).toBe('skipped');
    expect(stored?.skipReason).toBe('baseline_not_found');
  });

  it('records a skipped run when the baseline is not yet published', async () => {
    baselineStore.addBaseline(makeBaseline({status: 'reviewed'}));
    const res = await request(server).post('/api/ci/gate-eval').send(validBody());
    expect(res.status).toBe(200);
    expect(res.body.skipReason).toBe('baseline_status_reviewed');
    const stored = runStore.getRun(res.body.runId);
    expect(stored?.baselineStatus).toBe('reviewed');
  });
});

describe('POST /api/ci/gate-eval — gate evaluation', () => {
  beforeEach(() => {
    delete process.env.SMARTPERFETTO_API_KEY;
    baselineStore.addBaseline(makeBaseline());
  });

  it('passes when all metrics are within threshold', async () => {
    const res = await request(server).post('/api/ci/gate-eval').send(validBody());
    expect(res.status).toBe(200);
    expect(res.body.result.status).toBe('pass');
  });

  it('fails when a metric breaches its threshold', async () => {
    const body = validBody();
    body.candidate.metrics = [
      {
        metricId: 'frames.jank.p95',
        unit: 'ms',
        median: 10,
        p95: 25, // base p95 was 8, so deltaPct ≈ 2.125 > 0.1 threshold
        p99: 30,
        max: 50,
        sampleCount: 10,
      },
    ];
    const res = await request(server).post('/api/ci/gate-eval').send(body);
    expect(res.status).toBe(200);
    expect(res.body.result.status).toBe('fail');
  });

  it('promotes a pass to flaky when a rule references a metric not in the diff', async () => {
    const body = {
      ...validBody(),
      rules: [{metricId: 'metric.does.not.exist', threshold: 0.1}],
    };
    const res = await request(server).post('/api/ci/gate-eval').send(body);
    expect(res.status).toBe(200);
    expect(res.body.result.status).toBe('flaky');
  });

  it('persists the rules snapshot verbatim so the run is replayable', async () => {
    const body = validBody();
    body.rules = [{metricId: 'frames.jank.p95', threshold: 0.07}];
    const res = await request(server).post('/api/ci/gate-eval').send(body);
    const stored = runStore.getRun(res.body.runId);
    expect(stored?.rulesSnapshot).toEqual([
      {metricId: 'frames.jank.p95', threshold: 0.07},
    ]);
  });

  it('persists the candidate snapshot for replay', async () => {
    const res = await request(server).post('/api/ci/gate-eval').send(validBody());
    const stored = runStore.getRun(res.body.runId);
    expect(stored?.candidateSnapshot.kind).toBe('trace');
    expect(stored?.candidateSnapshot.metrics.length).toBe(1);
  });
});

describe('GET /api/ci/gate-runs/:runId', () => {
  beforeEach(() => {
    delete process.env.SMARTPERFETTO_API_KEY;
    baselineStore.addBaseline(makeBaseline());
  });

  it('returns 404 for unknown runId', async () => {
    const res = await request(server).get('/api/ci/gate-runs/missing');
    expect(res.status).toBe(404);
  });

  it('fetches a previously recorded run', async () => {
    const post = await request(server)
      .post('/api/ci/gate-eval')
      .send(validBody());
    const get = await request(server).get(`/api/ci/gate-runs/${post.body.runId}`);
    expect(get.status).toBe(200);
    expect(get.body.run.runId).toBe(post.body.runId);
  });
});

describe('GET /api/ci/gate-runs (list with filters)', () => {
  beforeEach(() => {
    delete process.env.SMARTPERFETTO_API_KEY;
    baselineStore.addBaseline(makeBaseline());
  });

  it('returns runs newest first', async () => {
    await request(server).post('/api/ci/gate-eval').send(validBody());
    await request(server).post('/api/ci/gate-eval').send(validBody());
    const res = await request(server).get('/api/ci/gate-runs');
    expect(res.status).toBe(200);
    expect(res.body.runs.length).toBe(2);
    expect(res.body.runs[0].createdAt).toBeGreaterThanOrEqual(
      res.body.runs[1].createdAt,
    );
  });

  it('filters by gateId', async () => {
    const a = {...validBody(), gateId: 'gate-a'};
    const b = {...validBody(), gateId: 'gate-b'};
    await request(server).post('/api/ci/gate-eval').send(a);
    await request(server).post('/api/ci/gate-eval').send(b);
    const res = await request(server).get(
      '/api/ci/gate-runs?gateId=gate-a',
    );
    expect(res.body.runs.map((r: {gateId: string}) => r.gateId)).toEqual([
      'gate-a',
    ]);
  });
});
