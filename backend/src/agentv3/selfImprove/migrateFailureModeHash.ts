// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * One-shot migration that backfills `failureModeHash` on existing analysis
 * patterns + negative patterns.
 *
 * Defaults to dry-run: read every entry under `logs/`, infer a category via
 * `inferCategoryFromText`, compute the hash, and print a report. Pass
 * `--apply` to actually persist the augmented entries back to disk via
 * atomic tmp-rename.
 *
 * Run: `npx tsx src/agentv3/selfImprove/migrateFailureModeHash.ts [--apply]`
 *
 * The dry-run report is the trustworthy output here — humans audit the
 * inferred categories before letting the migration write back. Anything that
 * lands on `unknown` is excluded from supersede actions in PR9 by design.
 */

import * as fs from 'fs';
import type { AnalysisPatternEntry, NegativePatternEntry, FailedApproach } from '../types';
import { backendLogPath } from '../../runtimePaths';
import {
  computeFailureModeHash,
  inferCategoryFromText,
  type FailureCategory,
  FAILURE_CATEGORIES,
} from './failureTaxonomy';

export interface MigrationReport {
  total: number;
  alreadyHashed: number;
  newlyHashed: number;
  byCategory: Record<FailureCategory, number>;
  samples: Record<FailureCategory, string[]>;
}

function emptyReport(): MigrationReport {
  const byCategory = {} as Record<FailureCategory, number>;
  const samples = {} as Record<FailureCategory, string[]>;
  for (const category of FAILURE_CATEGORIES) {
    byCategory[category] = 0;
    samples[category] = [];
  }
  return { total: 0, alreadyHashed: 0, newlyHashed: 0, byCategory, samples };
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
    if (report.samples[category].length < 3 && evidence.trim()) {
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
    if (report.samples[category].length < 3 && aggregateText.trim()) {
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
  lines.push(`  total entries:      ${report.total}`);
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

function readJsonArray<T>(file: string): T[] {
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch (err) {
    console.warn(`[migrateFailureModeHash] failed to parse ${file}: ${(err as Error).message}`);
    return [];
  }
}

function atomicWrite(file: string, data: unknown): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const patternsFile = backendLogPath('analysis_patterns.json');
  const negativePatternsFile = backendLogPath('analysis_negative_patterns.json');

  const positives = readJsonArray<AnalysisPatternEntry>(patternsFile);
  const negatives = readJsonArray<NegativePatternEntry>(negativePatternsFile);

  const positiveResult = backfillPatternEntries(positives);
  const negativeResult = backfillNegativeEntries(negatives);

  console.log(formatReport(`positive patterns (${patternsFile})`, positiveResult.report));
  console.log(formatReport(`negative patterns (${negativePatternsFile})`, negativeResult.report));

  if (apply) {
    if (positiveResult.report.newlyHashed > 0) {
      atomicWrite(patternsFile, positiveResult.entries);
      console.log(`\n[applied] wrote ${positiveResult.entries.length} entries to ${patternsFile}`);
    }
    if (negativeResult.report.newlyHashed > 0) {
      atomicWrite(negativePatternsFile, negativeResult.entries);
      console.log(`[applied] wrote ${negativeResult.entries.length} entries to ${negativePatternsFile}`);
    }
  } else {
    console.log('\n(dry-run — pass --apply to write changes back to disk)');
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error('[migrateFailureModeHash] failed:', err);
    process.exit(1);
  });
}
