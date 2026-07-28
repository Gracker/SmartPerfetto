// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Inject skill notes into invoke_skill responses, gated by a per-analysis
 * token budget.
 *
 * Notes from `logs/skill_notes/<skillId>.notes.json` (runtime, written by the
 * review worker) and `backend/skills/curated_skill_notes/<skillId>.notes.json`
 * (curated baseline, promoted by humans + checked into git) get prepended to
 * the invoke_skill text content. The agent reads them as context but the
 * downstream JSON payload is unchanged.
 *
 * Budget rules follow docs/architecture/self-improving-design.md "Skill Notes":
 *   full path:    1500 tokens total / 200 per skill / once per (analysis, skill)
 *   quick path:   0 by default (env override SELF_IMPROVE_QUICK_NOTES_BUDGET ≤100)
 *   correction retry: 0 — never injected
 *
 * Counted in estimated tokens (not bytes) because Chinese text averages ~1.5
 * char/token while Latin averages ~3.3 char/token; a byte cap would silently
 * overshoot Chinese-heavy notes.
 */

import * as fs from 'fs';
import * as path from 'path';
import { readSkillNotesFile, type SkillNotesFile, type PersistedSkillNote } from './skillNotesWriter';
import { backendLogPath } from '../../runtimePaths';
import {canonicalContentHash} from '../../services/selfEvolution/canonicalJson';
import {currentRunManifestAttributionSink} from '../../services/selfEvolution/runManifestLifecycle';

export type AnalysisPathMode = 'full' | 'quick' | 'retry';

export const FULL_PATH_TOTAL_TOKENS = 1500;
export const FULL_PATH_PER_SKILL_TOKENS = 200;
export const QUICK_PATH_DEFAULT_TOTAL_TOKENS = 0;
export const QUICK_PATH_MAX_TOTAL_TOKENS = 100;

const DEFAULT_RUNTIME_NOTES_DIR = backendLogPath('skill_notes');
const DEFAULT_CURATED_NOTES_DIR = path.join(__dirname, '..', '..', '..', 'skills', 'curated_skill_notes');

/**
 * Conservative token estimator: 3 chars/token favours English; the budget
 * intentionally errs short for Chinese which averages 1.5 char/token. The
 * exact ratio doesn't matter as long as it's stable — we want to *under*
 * inject when the agent is mid-context-pressure, not blow the budget.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

export interface BudgetSnapshot {
  mode: AnalysisPathMode;
  totalCap: number;
  perSkillCap: number;
  totalUsed: number;
  injectedSkillIds: string[];
  droppedReasons: { skillId: string; reason: string }[];
}

/**
 * Per-analysis budget state. Construct once per `analyze()` call and pass
 * the same instance to every invoke_skill so the running totals stay
 * consistent.
 */
export class SkillNotesBudget {
  private totalUsed = 0;
  private readonly injected = new Set<string>();
  private readonly dropped: { skillId: string; reason: string }[] = [];
  readonly mode: AnalysisPathMode;
  readonly totalCap: number;
  readonly perSkillCap: number;

  constructor(opts: { mode: AnalysisPathMode; quickOverrideTotal?: number }) {
    this.mode = opts.mode;
    if (opts.mode === 'full') {
      this.totalCap = FULL_PATH_TOTAL_TOKENS;
      this.perSkillCap = FULL_PATH_PER_SKILL_TOKENS;
    } else if (opts.mode === 'quick') {
      const requested = clampNonNegative(opts.quickOverrideTotal ?? QUICK_PATH_DEFAULT_TOTAL_TOKENS);
      this.totalCap = Math.min(requested, QUICK_PATH_MAX_TOTAL_TOKENS);
      this.perSkillCap = this.totalCap; // single-skill quick allowance
    } else {
      this.totalCap = 0;
      this.perSkillCap = 0;
    }
  }

  /**
   * Best-effort note injection. Returns the rendered text + tokens consumed,
   * or `null` if the budget rejected the request. Calling twice for the same
   * `skillId` within the same analysis returns null on the second call (we
   * don't want to inject the same notes twice).
   */
  tryConsume(skillId: string, candidates: ReadonlyArray<PersistedSkillNote>, now: number = Date.now()): {
    text: string;
    tokensUsed: number;
  } | null {
    if (this.totalCap === 0) {
      this.dropped.push({ skillId, reason: 'budget_disabled' });
      return null;
    }
    if (this.injected.has(skillId)) {
      this.dropped.push({ skillId, reason: 'already_injected_this_analysis' });
      return null;
    }
    const remainingTotal = this.totalCap - this.totalUsed;
    if (remainingTotal <= 0) {
      this.dropped.push({ skillId, reason: 'total_budget_exhausted' });
      return null;
    }
    const skillCeiling = Math.min(this.perSkillCap, remainingTotal);

    const eligible = candidates
      .filter(n => n.cooldownUntil <= now)
      .sort((a, b) => b.createdAt - a.createdAt);
    if (eligible.length === 0) {
      this.dropped.push({ skillId, reason: 'no_eligible_notes' });
      return null;
    }

    const lines: string[] = [];
    const selected: PersistedSkillNote[] = [];
    let used = 0;
    for (const note of eligible) {
      const formatted = renderNote(note);
      const cost = estimateTokens(formatted);
      if (used + cost > skillCeiling) break;
      lines.push(formatted);
      selected.push(note);
      used += cost;
    }
    if (lines.length === 0) {
      // If the per-skill ceiling was clipped by the remaining total budget,
      // surface that as the more informative reason — it's why callers see
      // injection drop off across an analysis.
      const reason = skillCeiling < this.perSkillCap
        ? 'total_budget_exhausted'
        : 'first_note_exceeds_per_skill_cap';
      this.dropped.push({ skillId, reason });
      return null;
    }
    const text = `## Skill Notes (历史踩坑) — ${skillId}\n${lines.join('\n')}`;
    this.totalUsed += used;
    this.injected.add(skillId);
    const sink = currentRunManifestAttributionSink();
    for (const note of selected) {
      sink?.recordInjection(
        'skillNotes',
        note.id,
        canonicalContentHash({
          failureCategory: note.failureCategory,
          failureModeHash: note.failureModeHash ?? null,
          evidenceSummary: note.evidenceSummary,
          candidateKeywords: note.candidateKeywords,
          candidateConstraints: note.candidateConstraints,
          candidateCriticalTools: note.candidateCriticalTools,
        }),
      );
    }
    return { text, tokensUsed: used };
  }

  snapshot(): BudgetSnapshot {
    return {
      mode: this.mode,
      totalCap: this.totalCap,
      perSkillCap: this.perSkillCap,
      totalUsed: this.totalUsed,
      injectedSkillIds: Array.from(this.injected),
      droppedReasons: [...this.dropped],
    };
  }
}

function clampNonNegative(value: number): number {
  return Math.max(0, value);
}

function renderNote(note: PersistedSkillNote): string {
  const parts: string[] = [];
  parts.push(`- [${note.failureCategory}] ${note.evidenceSummary}`);
  if (note.candidateConstraints) parts.push(`  → ${note.candidateConstraints}`);
  if (note.candidateCriticalTools.length > 0) {
    parts.push(`  tools: ${note.candidateCriticalTools.join(', ')}`);
  }
  return parts.join('\n');
}

export interface NoteSourceOptions {
  /** Override for tests. */
  runtimeDir?: string;
  curatedDir?: string;
}

/**
 * Load curated + runtime notes for a skill. Curated entries are listed first
 * so they take precedence under tight budgets.
 */
export function loadSkillNotes(
  skillId: string,
  opts: NoteSourceOptions = {},
): PersistedSkillNote[] {
  const runtimeDir = opts.runtimeDir ?? DEFAULT_RUNTIME_NOTES_DIR;
  const curatedDir = opts.curatedDir ?? DEFAULT_CURATED_NOTES_DIR;

  const merged: PersistedSkillNote[] = [];
  for (const dir of [curatedDir, runtimeDir]) {
    if (!fs.existsSync(dir)) continue;
    const file = path.join(dir, `${skillId}.notes.json`);
    if (!fs.existsSync(file)) continue;
    const parsed: SkillNotesFile = readSkillNotesFile(file);
    merged.push(...parsed.notes);
  }
  // Dedupe by note id so a curated copy of the same note doesn't double up.
  const seen = new Set<string>();
  return merged.filter(n => {
    if (seen.has(n.id)) return false;
    seen.add(n.id);
    return true;
  });
}

export const __testing = {
  estimateTokens,
  renderNote,
  DEFAULT_RUNTIME_NOTES_DIR,
  DEFAULT_CURATED_NOTES_DIR,
};
