// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import { DEFAULT_DEV_USER_ID, DEFAULT_TENANT_ID } from '../../../utils/localDevIdentity';
import {
  ANALYSIS_RESULT_SNAPSHOT_SCHEMA_VERSION,
  type AnalysisResultSnapshot,
} from '../../../types/multiTraceComparison';
import type { CaseNode, RagChunk } from '../../../types/sparkContracts';
import { createAnalysisResultSnapshotRepository } from '../../analysisResultSnapshotStore';
import { CaseLibrary } from '../../caseLibrary';
import { openEnterpriseDb } from '../../enterpriseDb';
import { RagStore } from '../../ragStore';
import { createTraceSimilarityService } from '../similarityService';
import {NO_PRIVATE_CONTEXT} from '../../security/analysisPrivateContext';
import {caseCurationGrantForMarkdownIngest} from '../../security/caseCuration';

const curator = caseCurationGrantForMarkdownIngest();

const originalDbPath = process.env.SMARTPERFETTO_ENTERPRISE_DB_PATH;

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-similarity-service-'));
  dbPath = path.join(tmpDir, 'enterprise.db');
  process.env.SMARTPERFETTO_ENTERPRISE_DB_PATH = dbPath;
});

afterEach(() => {
  process.env.SMARTPERFETTO_ENTERPRISE_DB_PATH = originalDbPath;
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

function addPublishedCase(library: CaseLibrary, ragStore: RagStore): void {
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

describe('trace similarity service', () => {
  it('returns grouped snapshot and case hints for readable snapshots', () => {
    seedGraph(['current-trace', 'similar-trace', 'other-trace']);
    const db = openEnterpriseDb(dbPath);
    const repository = createAnalysisResultSnapshotRepository(db);
    repository.createSnapshot(snapshot('current', { traceId: 'current-trace', sessionId: 'current-trace-session', runId: 'current-trace-run' }));
    repository.createSnapshot(snapshot('similar', { traceId: 'similar-trace', sessionId: 'similar-trace-session', runId: 'similar-trace-run' }));
    repository.createSnapshot(snapshot('other', {
      traceId: 'other-trace',
      sessionId: 'other-trace-session',
      runId: 'other-trace-run',
      sceneType: 'cpu',
      traceMetadata: { appPackage: 'com.other.app' },
      metrics: [],
    }));
    const library = new CaseLibrary(path.join(tmpDir, 'case_library.json'));
    const ragStore = new RagStore(path.join(tmpDir, 'rag_store.json'));
    addPublishedCase(library, ragStore);

    const result = createTraceSimilarityService({
      snapshotRepository: repository,
      caseLibrary: library,
      ragStore,
    }).findSimilarAnalysisResult({
      scope: {
        tenantId: DEFAULT_TENANT_ID,
        workspaceId: 'workspace-a',
        userId: DEFAULT_DEV_USER_ID,
      },
      knowledgeScope: {
        tenantId: DEFAULT_TENANT_ID,
        workspaceId: 'workspace-a',
        userId: DEFAULT_DEV_USER_ID,
      },
      snapshotId: 'current',
      includeCases: true,
      limit: 5,
    });

    db.close();
    expect(result).not.toBeNull();
    expect(result?.snapshotHints.map(hint => hint.sourceId)).toEqual(['similar']);
    expect(result?.caseHints).toEqual([
      expect.objectContaining({
        source: 'case_library',
        sourceId: 'case-shader',
        band: 'strong',
        allowedUse: 'navigation_hint_only',
      }),
    ]);
    expect(result?.hints.map(hint => hint.source)).toEqual(['analysis_result_snapshot', 'case_library']);
    expect(result?.signature.caseQuery).toMatchObject({
      scene: 'scrolling',
      rootCause: 'shader_compile',
    });
  });
});
