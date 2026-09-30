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

const ADMISSION = {version: 1 as const, basis: 'public_run' as const, runId: 'run-public', admittedAt: 1};
const originalLogDir = process.env.SMARTPERFETTO_BACKEND_LOG_DIR;

describe('collectSelfImproveMetrics', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-metrics-'));
    process.env.SMARTPERFETTO_BACKEND_LOG_DIR = tmp;
  });

  afterEach(() => {
    if (originalLogDir === undefined) delete process.env.SMARTPERFETTO_BACKEND_LOG_DIR;
    else process.env.SMARTPERFETTO_BACKEND_LOG_DIR = originalLogDir;
    fs.rmSync(tmp, {recursive: true, force: true});
  });

  const patternsFile = () => path.join(tmp, 'analysis_patterns.json');

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
      feedbackFile: path.join(tmp, 'feedback.jsonl'),
      skillNotesDir: path.join(tmp, 'skill_notes'),
      curatedSkillNotesDir: path.join(tmp, 'curated_skill_notes'),
      reviewOutboxDbPath: path.join(tmp, 'stores', 'review.db'),
      supersedeDbPath: path.join(tmp, 'stores', 'supersede.db'),
      selfEvolutionSnapshot: selfEvolutionSnapshot(),
      selfEvolutionOperationalMetrics: () => ({
        proposalCounts: {
          draft: 1,
          gated: 0,
          accepted: 0,
          applied: 0,
          rejected: 0,
          reverted: 0,
        },
        overlayCounts: {
          total: 0,
          effective: 0,
          byActivationState: {
            active: 0,
            inactive: 0,
            quarantined: 0,
            obsolete: 0,
            disabled: 0,
          },
          byValidationState: {
            pending: 0,
            passed: 0,
            failed: 0,
            error: 0,
          },
        },
        generationHead: null,
        latestReconciliationContentHash: null,
        activeOperations: 0,
        l2Judge: {
          status: 'not_configured' as const,
          reason: 'explicit_external_judge_consent_required' as const,
        },
      }),
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
      operational: {
        proposalCounts: {draft: 1},
        activeOperations: 0,
        l2Judge: {
          status: 'not_configured',
          reason: 'explicit_external_judge_consent_required',
        },
      },
    });
    expect(fs.existsSync(path.join(tmp, 'stores'))).toBe(false);
  });

  it('counts admitted entries by status and unadmitted ones only as quarantined', () => {
    const entry = { traceFeatures: [], sceneType: 's', keyInsights: ['text'], confidence: 0.5, createdAt: 0, matchCount: 0 };
    fs.writeFileSync(patternsFile(), JSON.stringify([
      { ...entry, id: 'a', status: 'provisional', learningAdmission: ADMISSION },
      { ...entry, id: 'b', status: 'confirmed', learningAdmission: ADMISSION },
      { ...entry, id: 'c', learningAdmission: ADMISSION }, // legacy (no status)
      { ...entry, id: 'd', status: 'confirmed' }, // no admission
      { ...entry, id: 'e', status: 'confirmed', learningAdmission: {version: 1, basis: 'public_run'} }, // invalid stamp
    ]));
    fs.writeFileSync(path.join(tmp, 'analysis_quick_patterns.json'), JSON.stringify([
      { ...entry, id: 'q', status: 'provisional' },
    ]));
    const metrics = collectSelfImproveMetrics(paths());
    expect(metrics.patterns.positive).toEqual({
      total: 3,
      byStatus: {provisional: 1, confirmed: 1, rejected: 0, disputed: 0, disputed_late: 0, legacy: 1},
      quarantined: 2,
    });
    expect(metrics.patterns.quick).toMatchObject({total: 0, quarantined: 1});
    expect(metrics.patterns.negative).toMatchObject({total: 0, quarantined: 0});
    expect(metrics.warnings).toEqual([]);
  });

  it('counts only the caller scope, as a run of that scope reads', () => {
    const entry = { traceFeatures: [], sceneType: 's', keyInsights: [], confidence: 0.5, createdAt: 0, matchCount: 0, status: 'confirmed' };
    const provenance = (workspaceId: string) => ({sourceTenantId: 'tenant-a', sourceWorkspaceId: workspaceId});
    fs.writeFileSync(patternsFile(), JSON.stringify([
      { ...entry, id: 'mine', provenance: provenance('ws-a'), learningAdmission: ADMISSION },
      { ...entry, id: 'mine-unadmitted', provenance: provenance('ws-a') },
      { ...entry, id: 'other', provenance: provenance('ws-b'), learningAdmission: ADMISSION },
      { ...entry, id: 'other-unadmitted', provenance: provenance('ws-b') },
    ]));
    const metrics = collectSelfImproveMetrics({
      ...paths(),
      knowledgeScope: {tenantId: 'tenant-a', workspaceId: 'ws-a', userId: 'u'},
    });
    expect(metrics.patterns.positive).toMatchObject({total: 1, quarantined: 1});
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

  it('records a warning for a corrupt pattern store and leaves it in place', () => {
    // An unquoted token makes the parser quote the text around it.
    fs.writeFileSync(patternsFile(), '[{"keyInsights":[SECRET-UNADMITTED-TEXT lock]}]');
    const metrics = collectSelfImproveMetrics(paths());
    expect(metrics.warnings).toContain('failed to read positive pattern memory: analysis patterns store is not valid JSON');
    expect(JSON.stringify(metrics.warnings)).not.toContain('SECRET');
    expect(metrics.patterns.positive).toMatchObject({total: 0, quarantined: 0});
    expect(fs.readdirSync(tmp).filter(name => name.startsWith('analysis_patterns.json'))).toEqual(['analysis_patterns.json']);
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
