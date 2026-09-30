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
      projectionTargetsApplied: 0,
      rebuilt: true,
    });
  });

  it('leaves the retired case candidate outbox unread', async () => {
    const outboxPath = path.join(tmpDir, 'data', 'self_improve', 'case_evolution.db');
    fs.mkdirSync(path.dirname(outboxPath), {recursive: true});
    const raw = new Database(outboxPath);
    raw.exec('CREATE TABLE candidate_feedback (candidate_id TEXT, rating TEXT, within_time_window TEXT)');
    raw.prepare('INSERT INTO candidate_feedback VALUES (?, ?, ?)')
      .run('candidate-legacy', 'positive', 'short');
    raw.close();
    const outboxBytes = fs.readFileSync(outboxPath);
    const {runFeedbackMigration} =
      require('../feedbackMigrationCli') as
        typeof import('../feedbackMigrationCli');
    const {publicFeedbackLogPath} =
      require('../feedbackEventStore') as
        typeof import('../feedbackEventStore');

    await expect(runFeedbackMigration({
      rebuild: false,
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
    })).resolves.toEqual({
      patternStatusesMigrated: 0,
      projectionTargetsApplied: 0,
      rebuilt: false,
    });

    // Nothing opened the outbox (no WAL sidecar, same bytes) and nothing
    // from it reached the feedback log.
    expect(fs.readFileSync(outboxPath)).toEqual(outboxBytes);
    expect(fs.existsSync(`${outboxPath}-wal`)).toBe(false);
    expect(fs.existsSync(publicFeedbackLogPath({
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
    }))).toBe(false);
  });
});
