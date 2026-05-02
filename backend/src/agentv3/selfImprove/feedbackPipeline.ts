// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * FeedbackPipeline — state machine for the feedback → case → skill
 * draft → review flow (Plan 44 M1, Spark #95).
 *
 * Each `FeedbackPipelineEntry` rides this machine:
 *
 *     feedback → case_draft → skill_draft → reviewed → merged
 *                                                   ↘  rejected
 *
 * The transitions are intentionally linear with one branch at the
 * `reviewed` stage. No back-edges (a rejected entry stays rejected;
 * resurrecting it means a fresh feedback intake). The reviewer field
 * is required at any stage advance from `reviewed` onward.
 *
 * Storage: independent JSON file at
 * `backend/logs/feedback_pipeline.json`. Same atomic temp+rename
 * pattern as the other Plan 44 stores.
 *
 * Out of scope:
 * - Case draft generation (the actual case is created by the caller
 *   and referenced via the shared `CaseRef` shape; this module only
 *   tracks the pipeline state, not the case content).
 * - Skill draft generation (caller-driven).
 * - MCP tool surface — feedback pipeline is operator-side, not
 *   agent-callable.
 *
 * @module feedbackPipeline
 */

import * as fs from 'fs';
import * as path from 'path';

import {
  type CaseRef,
  type FeedbackPipelineEntry,
} from '../../types/sparkContracts';

/** Allowed forward transitions. The graph is intentionally narrow —
 * any other transition throws so operator scripts cannot accidentally
 * advance entries past review without the right inputs. */
const ALLOWED_TRANSITIONS: Record<
  FeedbackPipelineEntry['stage'],
  ReadonlyArray<FeedbackPipelineEntry['stage']>
> = {
  feedback: ['case_draft', 'rejected'],
  case_draft: ['skill_draft', 'rejected'],
  skill_draft: ['reviewed', 'rejected'],
  reviewed: ['merged', 'rejected'],
  merged: [], // terminal
  rejected: [], // terminal
};

/** Stages that require a reviewer name on advance. */
const REQUIRES_REVIEWER: ReadonlySet<FeedbackPipelineEntry['stage']> = new Set([
  'reviewed',
  'merged',
  'rejected',
]);

interface StorageEnvelope {
  schemaVersion: 1;
  entries: FeedbackPipelineEntry[];
}

export interface CreateOptions {
  entryId: string;
  feedbackId: string;
}

export interface AdvanceOptions {
  /** Target stage. Must be in `ALLOWED_TRANSITIONS[currentStage]`. */
  stage: FeedbackPipelineEntry['stage'];
  /** Reviewer name. Required when advancing to reviewed / merged / rejected. */
  reviewer?: string;
  /** Case reference (CaseRef from shared base types). Optional — set
   * when advancing into `case_draft` so the entry carries the
   * generated case id forward. */
  case?: CaseRef;
  /** Generated skill draft id. Optional — set when advancing into
   * `skill_draft`. */
  skillDraftId?: string;
}

export class FeedbackPipeline {
  private readonly storagePath: string;
  private readonly entries = new Map<string, FeedbackPipelineEntry>();
  private loaded = false;
  /** High-water mark of stamped `updatedAt` values. Subsequent stamps
   * are guaranteed strictly greater so sorting by `updatedAt` desc
   * stays deterministic even when many ops land in the same ms — a
   * real concern for rapid-fire pipelines. The mark is reseeded from
   * the loaded entries so persisted ordering survives across
   * instances. */
  private updatedAtFloor = 0;

  constructor(storagePath: string) {
    this.storagePath = storagePath;
  }

  load(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!fs.existsSync(this.storagePath)) return;
    try {
      const raw = fs.readFileSync(this.storagePath, 'utf-8');
      const parsed = JSON.parse(raw) as StorageEnvelope;
      if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.entries)) return;
      for (const e of parsed.entries) {
        this.entries.set(e.entryId, e);
        if (e.updatedAt > this.updatedAtFloor) this.updatedAtFloor = e.updatedAt;
      }
    } catch {
      // Corrupted JSON: file preserved, in-memory cache stays empty.
    }
  }

  /** Monotonic stamp — strictly greater than every previously
   * returned value, even when wall clock has not advanced. */
  private nextUpdatedAt(): number {
    const wall = Date.now();
    const next = Math.max(wall, this.updatedAtFloor + 1);
    this.updatedAtFloor = next;
    return next;
  }

  /** Create a new entry at the `feedback` stage. Throws when an entry
   * with the same id already exists — the operator should resolve the
   * existing one (advance or reject) before creating a new one. */
  createEntry(opts: CreateOptions): FeedbackPipelineEntry {
    this.load();
    if (this.entries.has(opts.entryId)) {
      throw new Error(
        `FeedbackPipelineEntry '${opts.entryId}' already exists; advance or reject first`,
      );
    }
    const entry: FeedbackPipelineEntry = {
      entryId: opts.entryId,
      feedbackId: opts.feedbackId,
      stage: 'feedback',
      updatedAt: this.nextUpdatedAt(),
    };
    this.entries.set(opts.entryId, entry);
    this.persist();
    return entry;
  }

  /**
   * Advance an existing entry to the next stage. Throws on:
   * - Entry not found
   * - Target stage not in `ALLOWED_TRANSITIONS[currentStage]`
   * - Target stage requires a reviewer and `opts.reviewer` is missing
   *   or whitespace
   */
  advance(entryId: string, opts: AdvanceOptions): FeedbackPipelineEntry {
    this.load();
    const existing = this.entries.get(entryId);
    if (!existing) {
      throw new Error(`FeedbackPipelineEntry '${entryId}' not found`);
    }
    const allowed = ALLOWED_TRANSITIONS[existing.stage];
    if (!allowed.includes(opts.stage)) {
      throw new Error(
        `Illegal transition from '${existing.stage}' to '${opts.stage}'; allowed: [${allowed.join(', ')}]`,
      );
    }
    const trimmedReviewer = opts.reviewer?.trim();
    if (REQUIRES_REVIEWER.has(opts.stage) && !trimmedReviewer) {
      throw new Error(
        `Advancing to '${opts.stage}' requires a reviewer name`,
      );
    }
    const advanced: FeedbackPipelineEntry = {
      ...existing,
      stage: opts.stage,
      updatedAt: this.nextUpdatedAt(),
      ...(trimmedReviewer ? {reviewer: trimmedReviewer} : {}),
      // Preserve existing fields; allow per-call updates of case + skillDraftId.
      ...(opts.case !== undefined ? {case: opts.case} : {}),
      ...(opts.skillDraftId !== undefined
        ? {skillDraftId: opts.skillDraftId}
        : {}),
    };
    this.entries.set(entryId, advanced);
    this.persist();
    return advanced;
  }

  /** Read an entry by id. */
  getEntry(entryId: string): FeedbackPipelineEntry | undefined {
    this.load();
    return this.entries.get(entryId);
  }

  /**
   * List entries optionally filtered by stage. Default sort is by
   * `updatedAt` descending so the most-recently-touched entries
   * surface first in operator UIs.
   */
  listEntries(opts: {stage?: FeedbackPipelineEntry['stage']} = {}): FeedbackPipelineEntry[] {
    this.load();
    let out = Array.from(this.entries.values());
    if (opts.stage) out = out.filter(e => e.stage === opts.stage);
    out.sort((a, b) => b.updatedAt - a.updatedAt);
    return out;
  }

  /** Remove an entry. Returns whether anything was removed. */
  removeEntry(entryId: string): boolean {
    this.load();
    const had = this.entries.delete(entryId);
    if (had) this.persist();
    return had;
  }

  /** Per-stage counts for dashboards. */
  getStats(): Record<FeedbackPipelineEntry['stage'], number> {
    this.load();
    const out: Record<FeedbackPipelineEntry['stage'], number> = {
      feedback: 0,
      case_draft: 0,
      skill_draft: 0,
      reviewed: 0,
      merged: 0,
      rejected: 0,
    };
    for (const e of this.entries.values()) out[e.stage]++;
    return out;
  }

  private persist(): void {
    const dir = path.dirname(this.storagePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, {recursive: true});
    const tmp = `${this.storagePath}.tmp`;
    const envelope: StorageEnvelope = {
      schemaVersion: 1,
      entries: Array.from(this.entries.values()),
    };
    fs.writeFileSync(tmp, JSON.stringify(envelope, null, 2), 'utf-8');
    fs.renameSync(tmp, this.storagePath);
  }
}
