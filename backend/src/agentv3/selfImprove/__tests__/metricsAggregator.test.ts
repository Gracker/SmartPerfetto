// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {afterEach, beforeEach, describe, expect, it} from '@jest/globals';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { collectSelfImproveMetrics } from '../metricsAggregator';
import type {SelfEvolutionLifecycleSnapshot} from '../../../types/selfEvolution';
import {__testing as snapshotTesting} from '../../../utils/sqliteReadSnapshot';

describe('collectSelfImproveMetrics', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-metrics-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, {recursive: true, force: true});
  });

  function snapshotDirectories(): string[] {
    return fs.readdirSync(os.tmpdir())
      .filter((name) => name.startsWith(snapshotTesting.SNAPSHOT_PREFIX))
      .sort();
  }

  function selfEvolutionSnapshot(): SelfEvolutionLifecycleSnapshot {
    return {
      initializedAt: 1,
      requestedConfig: {enabled: true, applyEnabled: true},
      effectiveConfig: {enabled: true, applyEnabled: false},
      persistence: {
        persistence: 'unavailable',
        reason: 'data_root_inside_package',
        configured: true,
        writable: true,
        outsidePackage: false,
        externalMount: false,
        dataRoot: path.join(tmp, 'data'),
        packageRoot: tmp,
        checkedAt: 1,
      },
      migration: {
        status: 'not_attempted_persistence_unavailable',
        errorCode: 'test_migration_error',
      },
      currentBuildIdentity: {
        distribution: 'source',
        channel: 'stable',
        version: '1.0.0',
        target: {os: 'darwin', arch: 'arm64'},
        signingMode: 'source-checkout',
      },
      buildIdentityState: {
        status: 'not_loaded_persistence_unavailable',
        record: null,
      },
      warnings: [],
      errors: [{
        code: 'apply_requires_persistent_user_data',
        message: 'disabled for test',
      }],
    };
  }

  function paths() {
    return {
      patternsFile: path.join(tmp, 'patterns.json'),
      negativePatternsFile: path.join(tmp, 'negatives.json'),
      quickPatternsFile: path.join(tmp, 'quicks.json'),
      feedbackFile: path.join(tmp, 'feedback.jsonl'),
      skillNotesDir: path.join(tmp, 'skill_notes'),
      curatedSkillNotesDir: path.join(tmp, 'curated_skill_notes'),
      reviewOutboxDbPath: path.join(tmp, 'stores', 'review.db'),
      supersedeDbPath: path.join(tmp, 'stores', 'supersede.db'),
      selfEvolutionSnapshot: selfEvolutionSnapshot(),
    };
  }

  it('returns zeros when nothing exists yet', () => {
    const metrics = collectSelfImproveMetrics(paths());
    expect(metrics.patterns.positive.total).toBe(0);
    expect(metrics.patterns.negative.total).toBe(0);
    expect(metrics.patterns.quick.total).toBe(0);
    expect(metrics.skillNotes.runtimeFiles).toBe(0);
    expect(metrics.feedback.total).toBe(0);
    expect(metrics.activeRunSnapshots).toBeGreaterThanOrEqual(0);
    expect(metrics.selfEvolution).toMatchObject({
      requested: {enabled: true, applyEnabled: true},
      effective: {enabled: true, applyEnabled: false},
      persistence: 'unavailable',
      persistenceReason: 'data_root_inside_package',
      migration: 'not_attempted_persistence_unavailable',
      migrationErrorCode: 'test_migration_error',
      lastReconciledBuildIdentity: null,
    });
    expect(fs.existsSync(path.join(tmp, 'stores'))).toBe(false);
  });

  it('counts pattern entries by status (legacy entries fold into `legacy` bucket)', () => {
    const p = paths();
    fs.writeFileSync(p.patternsFile, JSON.stringify([
      { id: 'a', status: 'provisional', traceFeatures: [], sceneType: 's', keyInsights: [], confidence: 0.5, createdAt: 0, matchCount: 0 },
      { id: 'b', status: 'confirmed', traceFeatures: [], sceneType: 's', keyInsights: [], confidence: 0.7, createdAt: 0, matchCount: 0 },
      { id: 'c', traceFeatures: [], sceneType: 's', keyInsights: [], confidence: 0.6, createdAt: 0, matchCount: 0 }, // legacy (no status)
    ]));
    const metrics = collectSelfImproveMetrics(p);
    expect(metrics.patterns.positive.total).toBe(3);
    expect(metrics.patterns.positive.byStatus.provisional).toBe(1);
    expect(metrics.patterns.positive.byStatus.confirmed).toBe(1);
    expect(metrics.patterns.positive.byStatus.legacy).toBe(1);
  });

  it('counts skill notes across runtime and curated directories', () => {
    const p = paths();
    fs.mkdirSync(p.skillNotesDir, { recursive: true });
    fs.mkdirSync(p.curatedSkillNotesDir, { recursive: true });
    fs.writeFileSync(path.join(p.skillNotesDir, 's1.notes.json'), JSON.stringify({
      schemaVersion: 1, skillId: 's1', notes: [{ id: 'n1' }, { id: 'n2' }], lastUpdated: 0, totalBytes: 0,
    }));
    fs.writeFileSync(path.join(p.curatedSkillNotesDir, 's1.notes.json'), JSON.stringify({
      schemaVersion: 1, skillId: 's1', notes: [{ id: 'curated-1' }], lastUpdated: 0, totalBytes: 0,
    }));
    const metrics = collectSelfImproveMetrics(p);
    expect(metrics.skillNotes.runtimeFiles).toBe(1);
    expect(metrics.skillNotes.runtimeNotes).toBe(2);
    expect(metrics.skillNotes.curatedFiles).toBe(1);
    expect(metrics.skillNotes.curatedNotes).toBe(1);
  });

  it('parses feedback JSONL into positive/negative tallies', () => {
    const p = paths();
    const lines = [
      JSON.stringify({ rating: 'positive', sessionId: 's1' }),
      JSON.stringify({ rating: 'negative', sessionId: 's2' }),
      JSON.stringify({ rating: 'negative', sessionId: 's3' }),
      'corrupt-line-skipped',
    ];
    fs.writeFileSync(p.feedbackFile, lines.join('\n') + '\n');
    const metrics = collectSelfImproveMetrics(p);
    // Three valid lines, the corrupt one is silently dropped.
    expect(metrics.feedback.total).toBe(3);
    expect(metrics.feedback.positive).toBe(1);
    expect(metrics.feedback.negative).toBe(2);
  });

  it('records a warning when a JSON file is corrupt', () => {
    const p = paths();
    fs.writeFileSync(p.patternsFile, '{ malformed');
    const metrics = collectSelfImproveMetrics(p);
    expect(metrics.warnings.some(w => w.includes('patterns.json'))).toBe(true);
  });

  it('exposes the canonical SupersedeState keys with zero defaults', () => {
    const metrics = collectSelfImproveMetrics(paths());
    // No supersede DB exists, and metrics must not create one.
    for (const k of [
      'pending_review', 'active_canary', 'active',
      'failed', 'rejected', 'drifted', 'reverted',
    ]) {
      expect(metrics.supersede[k as keyof typeof metrics.supersede]).toBeGreaterThanOrEqual(0);
    }
  });

  it('exposes outbox state buckets with default zeros', () => {
    const metrics = collectSelfImproveMetrics(paths());
    for (const k of ['pending', 'leased', 'done', 'failed']) {
      expect(metrics.outbox.byState[k as keyof typeof metrics.outbox.byState]).toBeGreaterThanOrEqual(0);
    }
    expect(metrics.outbox.dailyJobs).toBeGreaterThanOrEqual(0);
    expect(fs.existsSync(path.join(tmp, 'stores'))).toBe(false);
  });

  it('degrades corrupt store schemas to warnings and cleans read snapshots', () => {
    const p = paths();
    fs.mkdirSync(path.dirname(p.reviewOutboxDbPath), {recursive: true});
    for (const databasePath of [p.reviewOutboxDbPath, p.supersedeDbPath]) {
      const database = new Database(databasePath);
      database.exec('CREATE TABLE unrelated(value TEXT)');
      database.close();
    }
    const snapshotsBefore = snapshotDirectories();

    const metrics = collectSelfImproveMetrics(p);

    expect(metrics.outbox).toEqual({
      byState: {pending: 0, leased: 0, done: 0, failed: 0},
      dailyJobs: 0,
    });
    expect(metrics.supersede).toEqual({
      pending_review: 0,
      active_canary: 0,
      active: 0,
      failed: 0,
      rejected: 0,
      drifted: 0,
      reverted: 0,
    });
    expect(metrics.warnings.some((warning) => warning.includes('outbox'))).toBe(true);
    expect(metrics.warnings.some((warning) => warning.includes('supersede'))).toBe(true);
    expect(snapshotDirectories()).toEqual(snapshotsBefore);
  });
});
