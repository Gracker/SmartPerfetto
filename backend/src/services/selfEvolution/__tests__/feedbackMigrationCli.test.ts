// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';

const originalBackendDataDir =
  process.env.SMARTPERFETTO_BACKEND_DATA_DIR;
const originalBackendLogDir =
  process.env.SMARTPERFETTO_BACKEND_LOG_DIR;
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-feedback-migration-'));
  process.env.SMARTPERFETTO_BACKEND_DATA_DIR = path.join(tmpDir, 'data');
  process.env.SMARTPERFETTO_BACKEND_LOG_DIR = path.join(tmpDir, 'logs');
  jest.resetModules();
});

afterEach(() => {
  if (originalBackendDataDir === undefined) {
    delete process.env.SMARTPERFETTO_BACKEND_DATA_DIR;
  } else {
    process.env.SMARTPERFETTO_BACKEND_DATA_DIR = originalBackendDataDir;
  }
  if (originalBackendLogDir === undefined) {
    delete process.env.SMARTPERFETTO_BACKEND_LOG_DIR;
  } else {
    process.env.SMARTPERFETTO_BACKEND_LOG_DIR = originalBackendLogDir;
  }
  fs.rmSync(tmpDir, {recursive: true, force: true});
});

describe('feedbackMigrationCli', () => {
  it('parses explicit rebuild scope and rejects missing values', () => {
    const {parseFeedbackMigrationCliArgs} =
      require('../feedbackMigrationCli') as
        typeof import('../feedbackMigrationCli');
    expect(parseFeedbackMigrationCliArgs([
      '--rebuild',
      '--tenant',
      'tenant-a',
      '--workspace',
      'workspace-a',
    ])).toEqual({
      rebuild: true,
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
    });
    expect(() => parseFeedbackMigrationCliArgs(['--tenant']))
      .toThrow('--tenant requires a value');
    expect(() => parseFeedbackMigrationCliArgs(['--unknown']))
      .toThrow('unknown argument: --unknown');
  });

  it('runs an empty scoped rebuild outside the request path', async () => {
    const {runFeedbackMigration} =
      require('../feedbackMigrationCli') as
        typeof import('../feedbackMigrationCli');
    await expect(runFeedbackMigration({
      rebuild: true,
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
    })).resolves.toEqual({
      patternStatusesMigrated: 0,
      legacyCandidateFeedbackImported: 0,
      projectionTargetsApplied: 0,
      rebuilt: true,
    });
  });

  it('imports only accepted legacy candidate feedback into the truth log', async () => {
    const {openCaseCandidateOutbox} =
      require('../../caseEvolution/caseCandidateOutbox') as
        typeof import('../../caseEvolution/caseCandidateOutbox');
    const {runFeedbackMigration} =
      require('../feedbackMigrationCli') as
        typeof import('../feedbackMigrationCli');
    const {FeedbackEventStore} =
      require('../feedbackEventStore') as
        typeof import('../feedbackEventStore');
    const outbox = openCaseCandidateOutbox();
    outbox.enqueue({
      candidateId: 'candidate-legacy',
      schemaVersion: 'case_candidate@2',
      provenance: {
        sourceSessionId: 'session-origin',
        sourceAnalysisRunId: 'run-origin',
        sourceTurnIndex: 1,
        traceContentHash: 'trace',
        capturedAt: 1,
        engine: 'claude',
        sceneType: 'scrolling',
        architectureType: 'unknown',
        originScope: {tenantId: 'tenant-a', workspaceId: 'workspace-a'},
      },
    } as any, {dedupeKey: 'legacy-candidate'});
    outbox.close();

    const raw = new Database(path.join(
      tmpDir,
      'data',
      'self_improve',
      'case_evolution.db',
    ));
    const insert = raw.prepare(`
      INSERT INTO candidate_feedback (
        candidate_id, source_session_id, source_analysis_run_id, rating,
        received_at, received_within_seconds, within_time_window, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
    `);
    insert.run(
      'candidate-legacy',
      'session-accepted',
      'run-accepted',
      'positive',
      20_000,
      20,
      'short',
    );
    insert.run(
      'candidate-legacy',
      'session-audit-only',
      'run-audit-only',
      'negative',
      90_000_000,
      90_000,
      'audit_only',
    );
    raw.close();

    await expect(runFeedbackMigration({
      rebuild: false,
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
    })).resolves.toMatchObject({
      legacyCandidateFeedbackImported: 1,
      projectionTargetsApplied: 1,
    });

    const store = new FeedbackEventStore({
      scope: {tenantId: 'tenant-a', workspaceId: 'workspace-a'},
    });
    expect(store.getEffectiveForTarget(
      'case_candidate',
      'candidate-legacy',
    )).toMatchObject([{
      legacy: true,
      sessionId: 'session-accepted',
      rating: 'positive',
    }]);
    store.close();
  });
});
