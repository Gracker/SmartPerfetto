// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * One-shot migration that backfills `failureModeHash` on existing analysis
 * patterns + negative patterns.
 *
 * Defaults to dry-run: read every admitted entry of every pattern memory
 * partition, infer a category via `inferCategoryFromText`, compute the hash,
 * and print a report. Pass `--apply` to persist the augmented entries through
 * the pattern memory store (its lock, and the DB once the DB is written).
 * Entries without a learning admission are never read by a run, so they are
 * only counted: neither rewritten nor quoted in the report.
 *
 * Run: `npx tsx src/agentv3/selfImprove/migrateFailureModeHash.ts [--apply]`
 *
 * The dry-run report is the trustworthy output here — humans audit the
 * inferred categories before letting the migration write back. Anything that
 * lands on `unknown` is excluded from supersede actions in PR9 by design.
 */

import type { AnalysisPatternEntry, NegativePatternEntry, FailedApproach } from '../types';
import {mutateEveryAdmittedPatternPartition} from '../analysisPatternMemory';
import {
  computeFailureModeHash,
  inferCategoryFromText,
  type FailureCategory,
  FAILURE_CATEGORIES,
} from './failureTaxonomy';

export interface MigrationReport {
  total: number;
  /** Unadmitted entries left as they are. */
  quarantined: number;
  alreadyHashed: number;
  newlyHashed: number;
  byCategory: Record<FailureCategory, number>;
  samples: Record<FailureCategory, string[]>;
}

const MAX_SAMPLES_PER_CATEGORY = 3;

function emptyReport(): MigrationReport {
  const byCategory = {} as Record<FailureCategory, number>;
  const samples = {} as Record<FailureCategory, string[]>;
  for (const category of FAILURE_CATEGORIES) {
    byCategory[category] = 0;
    samples[category] = [];
  }
  return { total: 0, quarantined: 0, alreadyHashed: 0, newlyHashed: 0, byCategory, samples };
}

function pickArchType(arch: string | undefined): string {
  return (arch || 'UNKNOWN').toUpperCase();
}

function pickSceneType(scene: string | undefined): string {
  return (scene || 'unknown').toLowerCase();
}

/**
 * Backfill `failureModeHash` on positive analysis-pattern entries.
 *
 * Positive patterns track successful insights, so historical entries usually
 * carry no failure signal. Without an inferred category we still emit a hash
 * keyed on `unknown` so cross-artifact dedupe works on the (sceneType, archType)
 * dimensions; this never trips supersede because the category is `unknown`.
 */
export function backfillPatternEntries(
  entries: ReadonlyArray<AnalysisPatternEntry>,
): { entries: AnalysisPatternEntry[]; report: MigrationReport } {
  const report = emptyReport();
  const out: AnalysisPatternEntry[] = entries.map(e => {
    report.total += 1;
    if (e.failureModeHash) {
      report.alreadyHashed += 1;
      return e;
    }
    const evidence = e.keyInsights.join(' ');
    const category = inferCategoryFromText(evidence);
    report.byCategory[category] += 1;
    if (report.samples[category].length < MAX_SAMPLES_PER_CATEGORY && evidence.trim()) {
      report.samples[category].push(evidence.substring(0, 120));
    }
    const failureModeHash = computeFailureModeHash({
      sceneType: pickSceneType(e.sceneType),
      archType: pickArchType(e.architectureType),
      category,
    });
    report.newlyHashed += 1;
    return { ...e, failureModeHash };
  });
  return { entries: out, report };
}

/**
 * Backfill negative-pattern entries. Each entry can carry multiple
 * `failedApproaches`; we hash both the entry-level and per-approach to
 * cover supersede dedupe at either granularity.
 */
export function backfillNegativeEntries(
  entries: ReadonlyArray<NegativePatternEntry>,
): { entries: NegativePatternEntry[]; report: MigrationReport } {
  const report = emptyReport();
  const out: NegativePatternEntry[] = entries.map(e => {
    report.total += 1;
    const updatedApproaches: FailedApproach[] = e.failedApproaches.map(a => {
      if (a.failureModeHash) return a;
      const category = inferCategoryFromText(`${a.reason} ${a.approach}`);
      return {
        ...a,
        failureModeHash: computeFailureModeHash({
          sceneType: pickSceneType(e.sceneType),
          archType: pickArchType(e.architectureType),
          category,
          toolOrSkillId: failedApproachToolHint(a),
          errorClass: a.type,
        }),
      };
    });

    if (e.failureModeHash) {
      report.alreadyHashed += 1;
      return { ...e, failedApproaches: updatedApproaches };
    }

    const aggregateText = e.failedApproaches.map(a => `${a.reason} ${a.approach}`).join(' ');
    const category = inferCategoryFromText(aggregateText);
    report.byCategory[category] += 1;
    if (report.samples[category].length < MAX_SAMPLES_PER_CATEGORY && aggregateText.trim()) {
      report.samples[category].push(aggregateText.substring(0, 120));
    }
    const failureModeHash = computeFailureModeHash({
      sceneType: pickSceneType(e.sceneType),
      archType: pickArchType(e.architectureType),
      category,
    });
    report.newlyHashed += 1;
    return { ...e, failedApproaches: updatedApproaches, failureModeHash };
  });
  return { entries: out, report };
}

function failedApproachToolHint(a: FailedApproach): string | undefined {
  if (a.type === 'tool_failure') return a.approach.split(/\s+/)[0]?.toLowerCase();
  return undefined;
}

function formatReport(label: string, report: MigrationReport): string {
  const lines: string[] = [];
  lines.push(`\n=== ${label} ===`);
  lines.push(`  admitted entries:   ${report.total}`);
  lines.push(`  quarantined:        ${report.quarantined} (unadmitted; not migrated)`);
  lines.push(`  already hashed:     ${report.alreadyHashed}`);
  lines.push(`  newly hashed:       ${report.newlyHashed}`);
  lines.push(`  by inferred category:`);
  for (const category of FAILURE_CATEGORIES) {
    const count = report.byCategory[category];
    if (count === 0) continue;
    lines.push(`    ${category.padEnd(32)} ${count}`);
    for (const sample of report.samples[category]) {
      lines.push(`        sample: ${sample}`);
    }
  }
  return lines.join('\n');
}

function mergeReports(parts: readonly MigrationReport[]): MigrationReport {
  const total = emptyReport();
  for (const part of parts) {
    total.total += part.total;
    total.quarantined += part.quarantined;
    total.alreadyHashed += part.alreadyHashed;
    total.newlyHashed += part.newlyHashed;
    for (const category of FAILURE_CATEGORIES) {
      total.byCategory[category] += part.byCategory[category];
      const room = MAX_SAMPLES_PER_CATEGORY - total.samples[category].length;
      if (room > 0) total.samples[category].push(...part.samples[category].slice(0, room));
    }
  }
  return total;
}

export interface FailureModeHashMigrationResult {
  positive: MigrationReport;
  negative: MigrationReport;
}

/**
 * Backfill every partition's admitted positive and negative patterns. A dry
 * run only reads; `apply` rewrites under the store lock. Either way the
 * report is what the authoritative store held while it was visited.
 */
export async function runFailureModeHashMigration(
  opts: {apply: boolean},
): Promise<FailureModeHashMigrationResult> {
  const dryRun = {dryRun: !opts.apply};
  const positive = await mutateEveryAdmittedPatternPartition('positive', (admitted, quarantined) => {
    const {entries, report} = backfillPatternEntries(admitted);
    return {entries, result: {...report, quarantined}};
  }, dryRun);
  const negative = await mutateEveryAdmittedPatternPartition('negative', (admitted, quarantined) => {
    const {entries, report} = backfillNegativeEntries(admitted);
    return {entries, result: {...report, quarantined}};
  }, dryRun);
  return {positive: mergeReports(positive), negative: mergeReports(negative)};
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const {positive, negative} = await runFailureModeHashMigration({apply});
  console.log(formatReport('positive patterns', positive));
  console.log(formatReport('negative patterns', negative));
  console.log(apply
    ? `\n[applied] hashed ${positive.newlyHashed} positive and ${negative.newlyHashed} negative entries`
    : '\n(dry-run — pass --apply to write changes back)');
}

if (require.main === module) {
  main().catch(err => {
    console.error('[migrateFailureModeHash] failed:', err);
    process.exit(1);
  });
}
