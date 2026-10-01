// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {describe, it, expect, beforeEach, afterEach} from '@jest/globals';
import express from 'express';
import request from 'supertest';

import {createCaseRoutes} from '../caseRoutes';
import {DEFAULT_DEV_USER_ID} from '../../middleware/auth';
import {CaseLibrary} from '../../services/caseLibrary';
import {CaseGraph} from '../../services/caseGraph';
import {
  type CaseEdge,
  type CaseNode,
  makeSparkProvenance,
} from '../../types/sparkContracts';
import {caseCurationGrantForMarkdownIngest} from '../../services/security/caseCuration';
import {writeCaseFileWithoutAttestations} from '../../../tests/helpers/caseStoreFixture';

const curator = caseCurationGrantForMarkdownIngest();

let tmpDir: string;
let library: CaseLibrary;
let graph: CaseGraph;
let app: express.Express;
const originalAuthEnv = {
  apiKey: process.env.SMARTPERFETTO_API_KEY,
  trustedHeaders: process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS,
};

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'case-routes-test-'));
  library = new CaseLibrary(path.join(tmpDir, 'cases.json'));
  graph = new CaseGraph(path.join(tmpDir, 'edges.json'), library);
  app = express();
  app.use(express.json({limit: '5mb'}));
  app.use('/api/cases', createCaseRoutes(library, graph));
});

afterEach(() => {
  for (const [key, value] of [
    ['SMARTPERFETTO_API_KEY', originalAuthEnv.apiKey],
    ['SMARTPERFETTO_SSO_TRUSTED_HEADERS', originalAuthEnv.trustedHeaders],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, {recursive: true, force: true});
  }
});

/** An SSO analyst: may read cases, may not curate them. */
function asAnalyst(req: request.Test): request.Test {
  delete process.env.SMARTPERFETTO_API_KEY;
  process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'true';
  return req
    .set('X-SmartPerfetto-SSO-User-Id', 'analyst-user')
    .set('X-SmartPerfetto-SSO-Email', 'analyst@example.test')
    .set('X-SmartPerfetto-SSO-Tenant-Id', 'default-dev-tenant')
    .set('X-SmartPerfetto-SSO-Workspace-Id', 'default-workspace')
    .set('X-SmartPerfetto-SSO-Roles', 'analyst')
    .set('X-SmartPerfetto-SSO-Scopes', 'trace:read,agent:run,report:read');
}

function makeCase(overrides: Partial<CaseNode> = {}): CaseNode {
  return {
    ...makeSparkProvenance({source: 'case-routes-test'}),
    caseId: 'case-001',
    title: 'Heavy mixed scrolling',
    status: 'draft',
    redactionState: 'raw',
    traceArtifactId: 'artifact-001',
    tags: ['scrolling'],
    findings: [{id: 'f1', severity: 'critical', title: 'Binder S>5ms'}],
    ...overrides,
  };
}

function makeEdge(overrides: Partial<CaseEdge> = {}): CaseEdge {
  return {
    edgeId: 'e1',
    fromCaseId: 'a',
    toCaseId: 'b',
    relation: 'similar_root_cause',
    ...overrides,
  };
}

describe('POST /api/cases', () => {
  it('saves a draft case', async () => {
    const c = makeCase();
    const res = await request(app).post('/api/cases').send(c);
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
  });

  it('records the signed-in curator, not a name from the body', async () => {
    const res = await request(app).post('/api/cases').send(makeCase({curatedBy: 'someone-else'}));
    expect(res.status).toBe(201);
    expect(res.body.case.curatedBy).toBe(DEFAULT_DEV_USER_ID);
    expect(library.getCase('case-001')?.curatedBy).toBe(DEFAULT_DEV_USER_ID);
  });

  it('rejects published-status saves with 400 (use /publish)', async () => {
    const c = makeCase({status: 'published', redactionState: 'redacted'});
    const res = await request(app).post('/api/cases').send(c);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/publishCase/);
  });

  it('400 on missing required fields', async () => {
    const res = await request(app).post('/api/cases').send({});
    expect(res.status).toBe(400);
  });
});

describe('GET /api/cases', () => {
  it('lists cases with count', async () => {
    library.saveCase(makeCase({caseId: 'a'}), curator);
    library.saveCase(makeCase({caseId: 'b'}), curator);
    const res = await request(app).get('/api/cases');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
  });

  it('filters by status', async () => {
    library.saveCase(makeCase({caseId: 'a', status: 'draft'}), curator);
    library.saveCase(makeCase({caseId: 'b', status: 'reviewed'}), curator);
    const res = await request(app).get('/api/cases?status=reviewed');
    expect(res.body.count).toBe(1);
    expect(res.body.cases[0].caseId).toBe('b');
  });

  it('filters by tag', async () => {
    library.saveCase(makeCase({caseId: 'a', tags: ['scrolling']}), curator);
    library.saveCase(makeCase({caseId: 'b', tags: ['anr']}), curator);
    const res = await request(app).get('/api/cases?tag=scrolling');
    expect(res.body.count).toBe(1);
    expect(res.body.cases[0].caseId).toBe('a');
  });
});

describe('GET / DELETE /api/cases/:caseId', () => {
  it('returns 200 + case body for known id', async () => {
    library.saveCase(makeCase({caseId: 'a'}), curator);
    const res = await request(app).get('/api/cases/a');
    expect(res.status).toBe(200);
    expect(res.body.case.caseId).toBe('a');
  });

  it('returns 404 for unknown id', async () => {
    const res = await request(app).get('/api/cases/missing');
    expect(res.status).toBe(404);
  });

  it('DELETE removes the case', async () => {
    library.saveCase(makeCase({caseId: 'a'}), curator);
    const res = await request(app).delete('/api/cases/a');
    expect(res.status).toBe(200);
    expect(library.getCase('a')).toBeUndefined();
  });
});

describe('POST /api/cases/:caseId/publish', () => {
  it('publishes a redacted case with the signed-in curator as reviewer', async () => {
    library.saveCase(makeCase({caseId: 'a', redactionState: 'redacted'}), curator);
    const res = await request(app)
      .post('/api/cases/a/publish')
      .send({reviewer: 'someone-else'});
    expect(res.status).toBe(200);
    expect(res.body.case.status).toBe('published');
    expect(res.body.case.curatedBy).toBe(DEFAULT_DEV_USER_ID);
  });

  it('returns 400 when redactionState != redacted', async () => {
    library.saveCase(makeCase({caseId: 'a', redactionState: 'partial'}), curator);
    const res = await request(app)
      .post('/api/cases/a/publish')
      .send({reviewer: 'chris'});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/redactionState/);
  });

  it('returns 404 when case is missing', async () => {
    const res = await request(app)
      .post('/api/cases/missing/publish')
      .send({reviewer: 'chris'});
    expect(res.status).toBe(404);
  });
});

describe('POST /api/cases/:caseId/archive', () => {
  it('archives a case with reason', async () => {
    library.saveCase(makeCase({caseId: 'a'}), curator);
    const res = await request(app)
      .post('/api/cases/a/archive')
      .send({reason: 'archived after 90 days'});
    expect(res.status).toBe(200);
    expect(res.body.case.traceArtifactId).toBeUndefined();
    expect(res.body.case.traceUnavailableReason).toBe(
      'archived after 90 days',
    );
  });

  it('returns 400 when reason is missing', async () => {
    library.saveCase(makeCase({caseId: 'a'}), curator);
    const res = await request(app).post('/api/cases/a/archive').send({});
    expect(res.status).toBe(400);
  });

  it('returns 404 when case is missing', async () => {
    const res = await request(app)
      .post('/api/cases/missing/archive')
      .send({reason: 'gone'});
    expect(res.status).toBe(404);
  });
});

describe('Edge endpoints', () => {
  it('POST /api/cases/edges adds an edge', async () => {
    const res = await request(app).post('/api/cases/edges').send(makeEdge());
    expect(res.status).toBe(201);
    expect(graph.size()).toBe(1);
  });

  it('POST /api/cases/edges rejects self-loops as 400', async () => {
    const res = await request(app)
      .post('/api/cases/edges')
      .send(makeEdge({edgeId: 'self', fromCaseId: 'x', toCaseId: 'x'}));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/self-loop/i);
  });

  it('POST /api/cases/edges rejects malformed body', async () => {
    const res = await request(app).post('/api/cases/edges').send({});
    expect(res.status).toBe(400);
  });

  it('GET /api/cases/edges lists all edges', async () => {
    graph.addEdge(makeEdge({edgeId: 'e1'}));
    graph.addEdge(makeEdge({edgeId: 'e2', relation: 'before_after_fix'}));
    const res = await request(app).get('/api/cases/edges');
    expect(res.body.count).toBe(2);
  });

  it('GET /api/cases/edges/:caseId returns related entries', async () => {
    graph.addEdge(makeEdge({edgeId: 'e1', fromCaseId: 'a', toCaseId: 'b'}));
    graph.addEdge(
      makeEdge({
        edgeId: 'e2',
        fromCaseId: 'c',
        toCaseId: 'a',
        relation: 'same_app',
      }),
    );
    const res = await request(app).get('/api/cases/edges/a?direction=in');
    expect(res.body.count).toBe(1);
    expect(res.body.related[0].caseId).toBe('c');
  });

  it('DELETE /api/cases/edges/:edgeId removes', async () => {
    graph.addEdge(makeEdge({edgeId: 'e1'}));
    const res = await request(app).delete('/api/cases/edges/e1');
    expect(res.status).toBe(200);
    expect(graph.size()).toBe(0);
  });

  it('DELETE /api/cases/edges/:edgeId returns 404 for missing edge', async () => {
    const res = await request(app).delete('/api/cases/edges/missing');
    expect(res.status).toBe(404);
  });
});

const writeAsBeforeAttestations = (record: CaseNode) =>
  writeCaseFileWithoutAttestations(path.join(tmpDir, 'cases.json'), record);

describe('case curation through the API', () => {
  it('attests what a curator writes, never what a request body claims', async () => {
    const res = await request(app).post('/api/cases').send({
      ...makeCase({caseId: 'a', status: 'reviewed', redactionState: 'redacted'}),
      analysisAdmitted: false,
      curation: {issuer: 'markdown_ingest', actor: 'someone-else', issuedAt: 1},
    });

    expect(res.status).toBe(201);
    expect(res.body.case).toMatchObject({
      caseId: 'a',
      analysisAdmitted: true,
      curation: {issuer: 'curator_api', actor: DEFAULT_DEV_USER_ID, issuedAt: expect.any(Number)},
    });
    expect(library.getCase('a')).not.toHaveProperty('curation');
    expect(library.getCase('a')).not.toHaveProperty('analysisAdmitted');
    expect(library.listAdmittedCases(['reviewed']).map(c => c.caseId)).toEqual(['a']);
  });

  it('tells curators which cases analyses read', async () => {
    writeAsBeforeAttestations(makeCase({caseId: 'c', status: 'reviewed', redactionState: 'redacted'}));
    library.saveCase(makeCase({caseId: 'a', status: 'reviewed', redactionState: 'redacted'}), curator);
    library.saveCase(makeCase({caseId: 'b', status: 'reviewed', redactionState: 'raw'}), curator);

    const res = await request(app).get('/api/cases');

    expect(res.body.cases.map((c: {caseId: string; analysisAdmitted: boolean}) => [c.caseId, c.analysisAdmitted]))
      .toEqual([['a', true], ['b', false], ['c', false]]);
  });

  it('makes a case written before attestations readable once a curator sends it back or publishes it', async () => {
    writeAsBeforeAttestations(makeCase({caseId: 'a', status: 'reviewed', redactionState: 'redacted'}));
    writeAsBeforeAttestations(makeCase({caseId: 'b', status: 'published', redactionState: 'redacted', curatedBy: 'old'}));
    const read = await request(app).get('/api/cases/a');
    expect(read.body.case.analysisAdmitted).toBe(false);

    const saved = await request(app).post('/api/cases').send(read.body.case);
    const published = await request(app).post('/api/cases/b/publish').send({});

    expect([saved.status, published.status]).toEqual([201, 200]);
    expect([saved.body.case.analysisAdmitted, published.body.case.analysisAdmitted]).toEqual([true, true]);
    expect(published.body.case.curatedBy).toBe(DEFAULT_DEV_USER_ID);
  });

  it('never makes a case readable by archiving it', async () => {
    writeAsBeforeAttestations(makeCase({caseId: 'a', status: 'reviewed', redactionState: 'redacted'}));
    library.saveCase(makeCase({caseId: 'b', status: 'reviewed', redactionState: 'redacted'}), curator);

    const legacy = await request(app).post('/api/cases/a/archive').send({reason: 'stale'});
    const attested = await request(app).post('/api/cases/b/archive').send({reason: 'stale'});

    expect([legacy.body.case.analysisAdmitted, attested.body.case.analysisAdmitted]).toEqual([false, true]);
    expect(attested.body.case.curation).toMatchObject({issuer: 'curator_api', actor: DEFAULT_DEV_USER_ID});
  });
});

describe('case curation permission', () => {
  it('lets a signed-in user without self_evolution:curate read but not write', async () => {
    library.saveCase(makeCase({caseId: 'a', redactionState: 'redacted'}), curator);
    graph.addEdge(makeEdge({edgeId: 'e1'}));

    expect((await asAnalyst(request(app).get('/api/cases'))).status).toBe(200);
    expect((await asAnalyst(request(app).get('/api/cases/edges'))).status).toBe(200);
    // Built one at a time: supertest opens a server per request object.
    const writes = [
      () => request(app).post('/api/cases').send(makeCase({caseId: 'b'})),
      () => request(app).delete('/api/cases/a'),
      () => request(app).post('/api/cases/a/publish').send({}),
      () => request(app).post('/api/cases/a/archive').send({reason: 'stale'}),
      () => request(app).post('/api/cases/edges').send(makeEdge({edgeId: 'e2'})),
      () => request(app).delete('/api/cases/edges/e1'),
    ];
    const statuses: number[] = [];
    for (const write of writes) statuses.push((await asAnalyst(write())).status);
    expect(statuses).toEqual(writes.map(() => 403));
    expect(library.listCases().map(c => [c.caseId, c.status])).toEqual([['a', 'draft']]);
    expect(graph.listEdges().map(edge => edge.edgeId)).toEqual(['e1']);
  });
});
