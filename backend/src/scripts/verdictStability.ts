// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * How stable claim verdicts are across repeated runs of the same question.
 *
 * Reads `NNN.claim-verification.json` files (CLI turn artifacts or E2E
 * copies) and reports the verdict, not-checked-reason and per-claim status
 * distributions, plus whether the semantic review judged the same answer
 * fragment the same way every time. Fragments are joined by the text hash
 * finalization records with each located review span
 * (`ClaimSemanticReviewTrace`), so no answer text is read or printed.
 *
 * Usage:
 *   npm run verdict:stability -- <claim-verification.json>... [--out <path>]
 */

import * as fs from 'fs';
import * as path from 'path';

import {tryParseStoredJson} from '../utils/storedData';

export interface VerdictStabilitySummary {
  schemaVersion: 'verdict_stability@1';
  runs: number;
  unreadable: number;
  statuses: Record<string, number>;
  notCheckedReasons: Record<string, number>;
  claimStatuses: Record<string, number>;
  fragments: {total: number; repeated: number; stable: number; unstable: number};
  unstableFragments: Array<{textHash: string; consistencies: Record<string, number>}>;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function count(target: Record<string, number>, key: string): void {
  target[key] = (target[key] ?? 0) + 1;
}

/** Pure summary of parsed claim-verification documents; `undefined` marks an unreadable one. */
export function summarizeVerdictStability(documents: readonly unknown[]): VerdictStabilitySummary {
  const summary: VerdictStabilitySummary = {schemaVersion: 'verdict_stability@1', runs: 0, unreadable: 0,
    statuses: {}, notCheckedReasons: {}, claimStatuses: {},
    fragments: {total: 0, repeated: 0, stable: 0, unstable: 0}, unstableFragments: []};
  // textHash -> run index -> consistencies seen in that run
  const fragments = new Map<string, Map<number, Set<string>>>();
  documents.forEach((document, runIndex) => {
    const verification = record(document);
    if (!verification || typeof verification.status !== 'string' || !Array.isArray(verification.claimResults)) {
      summary.unreadable++;
      return;
    }
    summary.runs++;
    count(summary.statuses, verification.status);
    if (typeof verification.notCheckedReason === 'string') count(summary.notCheckedReasons, verification.notCheckedReason);
    for (const raw of verification.claimResults) {
      const claim = record(raw);
      if (!claim) continue;
      if (typeof claim.status === 'string') count(summary.claimStatuses, claim.status);
      const review = record(claim.semanticReview);
      if (!review || typeof review.consistency !== 'string' || !Array.isArray(review.contentLocations)) continue;
      for (const rawLocation of review.contentLocations) {
        const textHash = record(rawLocation)?.textHash;
        if (typeof textHash !== 'string') continue;
        const runs = fragments.get(textHash) ?? new Map<number, Set<string>>();
        const seen = runs.get(runIndex) ?? new Set<string>();
        seen.add(review.consistency);
        runs.set(runIndex, seen);
        fragments.set(textHash, runs);
      }
    }
  });
  for (const [textHash, runs] of fragments) {
    summary.fragments.total++;
    if (runs.size < 2) continue;
    summary.fragments.repeated++;
    const consistencies: Record<string, number> = {};
    for (const seen of runs.values()) for (const consistency of seen) count(consistencies, consistency);
    if (Object.keys(consistencies).length === 1) summary.fragments.stable++;
    else {
      summary.fragments.unstable++;
      summary.unstableFragments.push({textHash, consistencies});
    }
  }
  summary.unstableFragments.sort((a, b) => a.textHash.localeCompare(b.textHash));
  return summary;
}

function main(argv: readonly string[]): number {
  const files: string[] = [];
  let outPath: string | undefined;
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--out') outPath = argv[++index];
    else files.push(argv[index]!);
  }
  if (files.length === 0) {
    console.error('Usage: npm run verdict:stability -- <claim-verification.json>... [--out <path>]');
    return 2;
  }
  const documents = files.map(file => {
    let text: string;
    try { text = fs.readFileSync(path.resolve(file), 'utf8'); } catch { return undefined; }
    const parsed = tryParseStoredJson(text, 'claim verification artifact');
    return parsed.ok ? parsed.value : undefined;
  });
  const output = `${JSON.stringify(summarizeVerdictStability(documents), null, 2)}\n`;
  if (outPath) fs.writeFileSync(path.resolve(outPath), output);
  else process.stdout.write(output);
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
