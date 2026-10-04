// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import express from 'express';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import request from 'supertest';

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import {
  authenticate,
} from '../../middleware/auth';
import {DEFAULT_DEV_USER_ID, DEFAULT_TENANT_ID} from '../../utils/localDevIdentity';
import {
  bindWorkspaceRouteContext,
  requireWorkspaceRouteContext,
} from '../../middleware/workspaceRouteContext';
import { CaseLibrary } from '../../services/caseLibrary';
import { openEnterpriseDb } from '../../services/enterpriseDb';
import { RagStore } from '../../services/ragStore';
import { createAnalysisResultSnapshotRepository } from '../../services/analysisResultSnapshotStore';
import {
  ANALYSIS_RESULT_SNAPSHOT_SCHEMA_VERSION,
  type AnalysisResultSnapshot,
} from '../../types/multiTraceComparison';
import type { CaseNode, RagChunk } from '../../types/sparkContracts';
import analysisResultRoutes from '../analysisResultRoutes';
import {NO_PRIVATE_CONTEXT} from '../../services/security/analysisPrivateContext';
import {caseCurationGrantForMarkdownIngest} from '../../services/security/caseCuration';

const curator = caseCurationGrantForMarkdownIngest();

const originalDbPath = process.env.SMARTPERFETTO_ENTERPRISE_DB_PATH;
const originalLogDir = process.env.SMARTPERFETTO_BACKEND_LOG_DIR;

let tmpDir: string;
let dbPath: string;
let logDir: string;

function app(): express.Express {
  const server = express();
  server.use(express.json());
  server.use(
    '/api/workspaces/:workspaceId/analysis-results',
    bindWorkspaceRouteContext,
    authenticate,
    requireWorkspaceRouteContext,
    analysisResultRoutes,
  );
  return server;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-analysis-similarity-routes-'));
  dbPath = path.join(tmpDir, 'enterprise.db');
  logDir = path.join(tmpDir, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  process.env.SMARTPERFETTO_ENTERPRISE_DB_PATH = dbPath;
  process.env.SMARTPERFETTO_BACKEND_LOG_DIR = logDir;
  seedGraph(['current-trace', 'similar-trace']);
});

afterEach(() => {
  process.env.SMARTPERFETTO_ENTERPRISE_DB_PATH = originalDbPath;
  process.env.SMARTPERFETTO_BACKEND_LOG_DIR = originalLogDir;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function seedGraph(traceIds: string[]): void {
  const db = openEnterpriseDb(dbPath);
  const now = 1_700_000_000_000;
  db.prepare(`
    INSERT OR IGNORE INTO organizations (id, name, status, plan, created_at, updated_at)
    VALUES (?, ?, 'active', 'enterprise', ?, ?)
  `).run(DEFAULT_TENANT_ID, DEFAULT_TENANT_ID, now, now);
  db.prepare(`
    INSERT OR IGNORE INTO workspaces (id, tenant_id, name, created_at, updated_at)
    VALUES ('workspace-a', ?, 'workspace-a', ?, ?)
  `).run(DEFAULT_TENANT_ID, now, now);
  db.prepare(`
    INSERT OR IGNORE INTO users (id, tenant_id, email, display_name, idp_subject, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(DEFAULT_DEV_USER_ID, DEFAULT_TENANT_ID, 'dev@example.test', 'Dev', 'dev', now, now);
  for (const traceId of traceIds) {
    db.prepare(`
      INSERT INTO trace_assets
        (id, tenant_id, workspace_id, owner_user_id, local_path, status, created_at)
      VALUES
        (?, ?, 'workspace-a', ?, ?, 'ready', ?)
    `).run(traceId, DEFAULT_TENANT_ID, DEFAULT_DEV_USER_ID, `/tmp/${traceId}`, now);
    db.prepare(`
      INSERT INTO analysis_sessions
        (id, tenant_id, workspace_id, trace_id, created_by, title, visibility, status, created_at, updated_at)
      VALUES
        (?, ?, 'workspace-a', ?, ?, ?, 'private', 'completed', ?, ?)
    `).run(`${traceId}-session`, DEFAULT_TENANT_ID, traceId, DEFAULT_DEV_USER_ID, `${traceId}-session`, now, now);
    db.prepare(`
      INSERT INTO analysis_runs
        (id, tenant_id, workspace_id, session_id, mode, status, question, started_at, completed_at)
      VALUES
        (?, ?, 'workspace-a', ?, 'agent', 'completed', 'analyze', ?, ?)
    `).run(`${traceId}-run`, DEFAULT_TENANT_ID, `${traceId}-session`, now, now);
  }
  const repository = createAnalysisResultSnapshotRepository(db);
  repository.createSnapshot(snapshot('current', { traceId: 'current-trace', sessionId: 'current-trace-session', runId: 'current-trace-run' }));
  repository.createSnapshot(snapshot('similar', { traceId: 'similar-trace', sessionId: 'similar-trace-session', runId: 'similar-trace-run' }));
  db.close();
}

function snapshot(id: string, overrides: Partial<AnalysisResultSnapshot> = {}): AnalysisResultSnapshot {
  return {
    id,
    tenantId: DEFAULT_TENANT_ID,
    workspaceId: 'workspace-a',
    traceId: `${id}-trace`,
    sessionId: `${id}-trace-session`,
    runId: `${id}-trace-run`,
    createdBy: DEFAULT_DEV_USER_ID,
    visibility: 'workspace',
    privateContext: NO_PRIVATE_CONTEXT,
    sceneType: 'scrolling',
    title: id,
    userQuery: 'analyze scrolling',
    traceLabel: id,
    traceMetadata: {
      appPackage: 'com.example.app',
      processName: 'com.example.app',
      deviceModel: 'Pixel 9',
      androidVersion: '16',
      reason_code: 'shader_compile',
      responsibility: 'app',
    },
    summary: { headline: 'ok' },
    metrics: [{
      key: 'scrolling.jank_count',
      label: 'Jank count',
      group: 'jank',
      value: 10,
      confidence: 0.9,
      source: { type: 'skill', skillId: 'scrolling' },
    }],
    evidenceRefs: [{
      id: `${id}-evidence`,
      type: 'skill_step',
      metadata: { render_slices: ['makePipeline'] },
    }],
    status: 'ready',
    schemaVersion: ANALYSIS_RESULT_SNAPSHOT_SCHEMA_VERSION,
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

function addPublishedCase(): void {
  const library = new CaseLibrary(path.join(logDir, 'case_library.json'));
  const ragStore = new RagStore(path.join(logDir, 'rag_store.json'));
  const record: CaseNode = {
    schemaVersion: 1,
    source: 'curated_markdown_case',
    createdAt: 1,
    caseId: 'case-shader',
    title: 'Shader compile jank',
    status: 'reviewed',
    redactionState: 'redacted',
    tags: ['scrolling', 'shader_compile'],
    findings: [],
    knowledge: {
      sourceFile: 'cases/case-shader.md',
      body: 'body',
      quality: 'curated',
      scene: 'scrolling',
      domainPack: 'scrolling.v1',
      taxonomy: {
        primary_root_cause: 'shader_compile',
        secondary_root_causes: [],
        responsibility: 'app',
        severity: 'warning',
      },
      context: {},
      evidenceSignatures: {
        required: [{ field: 'reason_code', op: 'eq', value: 'shader_compile' }],
        supportive: [{ field: 'render_slices', op: 'contains_any', value: ['makePipeline'] }],
      },
      recommendations: {
        app: [{ id: 'r1', priority: 'P1', action: 'Warm shaders', applies_when: 'shader_compile', risks: 'Startup cost' }],
        oem: [],
      },
    },
  };
  library.saveCase(record, curator);
  library.publishCase(record.caseId, {reviewer: 'test'}, curator);
  const chunk: RagChunk = {
    chunkId: 'case:case-shader:summary',
    kind: 'case_library',
    uri: 'case://case-shader',
    title: 'Shader compile jank',
    snippet: 'shader compile makePipeline',
    indexedAt: 1,
    registryOrigin: 'plan54_cases',
  };
  ragStore.addChunk(chunk);
  ragStore.flush();
}

describe('analysis result similarity routes', () => {
  it('returns grouped snapshot and case hints for a readable snapshot', async () => {
    addPublishedCase();

    const response = await request(app())
      .post('/api/workspaces/workspace-a/analysis-results/current/similarity')
      .set('x-tenant-id', DEFAULT_TENANT_ID)
      .send({ includeCases: true, limit: 5 })
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.snapshotId).toBe('current');
    expect(response.body.snapshotHints.map((hint: {sourceId: string}) => hint.sourceId)).toEqual(['similar']);
    expect(response.body.caseHints).toEqual([
      expect.objectContaining({
        source: 'case_library',
        sourceId: 'case-shader',
        band: 'strong',
        allowedUse: 'navigation_hint_only',
      }),
    ]);
    expect(response.body.hints.map((hint: {source: string}) => hint.source)).toEqual(['analysis_result_snapshot', 'case_library']);
    expect(response.body.signature.caseQuery).toMatchObject({ rootCause: 'shader_compile' });
  });

  it('rejects invalid similarity limits and returns not found for unreadable ids', async () => {
    await request(app())
      .post('/api/workspaces/workspace-a/analysis-results/current/similarity')
      .set('x-tenant-id', DEFAULT_TENANT_ID)
      .send({ limit: 21 })
      .expect(400);

    await request(app())
      .post('/api/workspaces/workspace-a/analysis-results/missing/similarity')
      .set('x-tenant-id', DEFAULT_TENANT_ID)
      .expect(404);
  });
});
