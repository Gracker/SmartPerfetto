// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * ProjectMemory — independent storage for project- and world-scope
 * memory entries (Plan 44).
 *
 * Codex round 1 P1#3 locked in: this module does NOT modify
 * `analysisPatternMemory.ts`. Session-scope entries stay in the
 * existing 200-entry weighted-Jaccard store with the supersede
 * integration intact; project + world entries live here, in
 * `backend/logs/analysis_project_memory.json`, on a separate
 * lifecycle.
 *
 * Plan 44 M0 scope (this file):
 * - Save / get / remove / list `ProjectMemoryEntry` records.
 * - Service-layer invariants the schema does NOT enforce so older
 *   snapshots remain readable:
 *     - `scope='world'` requires `promotionPolicy` (Codex round 3
 *       P1#2 testability fix). Save throws when missing.
 *     - `promoteEntry()` rejects any trigger outside the enum —
 *       auto promotion is forbidden by design.
 *     - `recallProjectMemory()` MUST NOT write — Codex round 2 P1#1
 *       caught `recall_patterns` quietly mutating the supersede
 *       store via `openSupersedeStore`. The recall path here calls
 *       a single in-memory load (idempotent) and never persists.
 * - Promotion audit log: every promote() call appends to
 *   `promotionAudit[]` so the reviewer trail survives even if the
 *   target entry is later removed.
 *
 * Out of scope:
 * - The feedback → case → skill draft pipeline (M1, separate file).
 * - The `recall_project_memory` MCP tool (M1, in claudeMcpServer.ts).
 * - The admin-only `/api/memory/promote` route + `consolidate_to_world_memory`
 *   (M2).
 *
 * @module projectMemory
 */

import * as fs from 'fs';
import * as path from 'path';

import {
  type ProjectMemoryEntry,
  type MemoryPromotionPolicy,
  type MemoryPromotionTrigger,
  type MemoryScope,
} from '../types/sparkContracts';
import {
  enterpriseKnowledgeDbWritesEnabled,
  enterpriseKnowledgeStoreEnabled,
  legacyKnowledgeFilesystemWritesEnabled,
  type KnowledgeScope,
  getScopedKnowledgeRecord,
  listScopedKnowledgeRecords,
  removeScopedKnowledgeRecord,
  upsertScopedKnowledgeRecord,
} from '../services/scopedKnowledgeStore';
import {KnowledgeCurationError} from '../services/knowledgeCurationError';

const VALID_PROMOTION_TRIGGERS: ReadonlySet<MemoryPromotionTrigger> = new Set([
  'user_feedback',
  'reviewer_approval',
  'skill_eval_pass',
]);

/** One audit-log row recording a cross-scope promotion. */
export interface PromotionAuditEntry {
  entryId: string;
  policy: MemoryPromotionPolicy;
  /** Wall-clock when the audit row was written (epoch ms). */
  auditedAt: number;
}

/** On-disk envelope. Schema mismatches load empty (file preserved). */
interface StorageEnvelope {
  schemaVersion: 1;
  entries: ProjectMemoryEntry[];
  promotionAudit: PromotionAuditEntry[];
}

const KNOWLEDGE_KIND = 'project_memory';
const MEMORY_ROW_SCOPE_PREFIX = 'memory:';

export interface ListOptions {
  scope?: Exclude<MemoryScope, 'session'>;
  projectKey?: string;
  /** Restrict to entries whose `tags` overlap with at least one of these. */
  anyOfTags?: string[];
}

export interface RecallOptions {
  /** Restrict to a scope. Defaults to all (project + world). */
  scope?: Exclude<MemoryScope, 'session'>;
  /** Restrict to a project key prefix (exact match). */
  projectKey?: string;
  /** Tag tokens to score against — entries with overlap rank higher. */
  tags?: string[];
  /** Maximum hits returned. Defaults to 5. */
  topK?: number;
}

/** One recall hit with the score that ranked it. The hit object is a
 * shallow copy of the stored entry — recall never mutates the store
 * even via reference sharing. */
export interface RecallHit {
  entry: ProjectMemoryEntry;
  score: number;
}

/**
 * ProjectMemory — local file-backed store for project + world entries.
 * Session entries stay in `analysisPatternMemory.ts` and are not
 * touched by this class.
 */
export class ProjectMemory {
  private readonly storagePath: string;
  private readonly entries = new Map<string, ProjectMemoryEntry>();
  private readonly auditLog: PromotionAuditEntry[] = [];
  private loaded = false;

  constructor(storagePath: string) {
    this.storagePath = storagePath;
  }

  /** Idempotently load on-disk state into memory. */
  load(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!fs.existsSync(this.storagePath)) return;
    try {
      const raw = fs.readFileSync(this.storagePath, 'utf-8');
      const parsed = JSON.parse(raw) as StorageEnvelope;
      if (
        parsed.schemaVersion !== 1 ||
        !Array.isArray(parsed.entries) ||
        !Array.isArray(parsed.promotionAudit)
      ) {
        return;
      }
      for (const e of parsed.entries) this.entries.set(e.entryId, e);
      this.auditLog.push(...parsed.promotionAudit);
    } catch {
      // Corrupted JSON: preserve file for inspection, leave cache empty.
    }
  }

  /**
   * Save (insert or replace) an entry. Throws when:
   *   - scope is 'session' (those belong in analysisPatternMemory.ts)
   *   - scope is 'world' but promotionPolicy is missing
   *   - promotionPolicy carries a trigger outside the canonical enum
   */
  saveProjectMemoryEntry(
    entry: ProjectMemoryEntry,
    storageScope?: KnowledgeScope,
  ): void {
    this.load();
    this.assertSaveInvariants(entry);
    if (legacyKnowledgeFilesystemWritesEnabled()) {
      this.entries.set(entry.entryId, entry);
      this.persist();
    }
    if (enterpriseKnowledgeDbWritesEnabled()) {
      upsertScopedKnowledgeRecord(
        KNOWLEDGE_KIND,
        entry.entryId,
        memoryRowScope(entry.scope),
        entry,
        storageScope,
        {
          createdAt: entry.createdAt,
          updatedAt: entry.lastSeenAt ?? entry.createdAt,
          sourceRunId: storageScope?.sourceRunId ?? storageScope?.runId,
        },
      );
    }
  }

  /** Get an entry by id. */
  getProjectMemoryEntry(
    entryId: string,
    storageScope?: KnowledgeScope,
  ): ProjectMemoryEntry | undefined {
    if (enterpriseKnowledgeStoreEnabled()) {
      return getScopedKnowledgeRecord<ProjectMemoryEntry>(
        KNOWLEDGE_KIND,
        entryId,
        storageScope,
      )?.record;
    }
    this.load();
    return this.entries.get(entryId);
  }

  /** Remove an entry. Returns whether it was present. The promotion
   * audit log is NOT redacted — past promotions stay traceable. */
  removeProjectMemoryEntry(
    entryId: string,
    storageScope?: KnowledgeScope,
  ): boolean {
    let removed = false;
    if (enterpriseKnowledgeDbWritesEnabled()) {
      removed = removeScopedKnowledgeRecord(KNOWLEDGE_KIND, entryId, storageScope) || removed;
    }
    if (legacyKnowledgeFilesystemWritesEnabled()) {
      this.load();
      const had = this.entries.delete(entryId);
      if (had) this.persist();
      removed = had || removed;
    }
    return removed;
  }

  /** Filtered list, deterministically ordered by entryId. */
  listProjectMemoryEntries(
    opts: ListOptions = {},
    storageScope?: KnowledgeScope,
  ): ProjectMemoryEntry[] {
    this.load();
    let out = enterpriseKnowledgeStoreEnabled()
      ? listScopedKnowledgeRecords<ProjectMemoryEntry>(
          KNOWLEDGE_KIND,
          storageScope,
          {
            rowScope: opts.scope ? memoryRowScope(opts.scope) : undefined,
            rowScopePrefix: opts.scope ? undefined : MEMORY_ROW_SCOPE_PREFIX,
          },
        ).map(row => row.record)
      : Array.from(this.entries.values());
    if (opts.scope) out = out.filter(e => e.scope === opts.scope);
    if (opts.projectKey)
      out = out.filter(e => e.projectKey === opts.projectKey);
    if (opts.anyOfTags && opts.anyOfTags.length > 0) {
      const wanted = new Set(opts.anyOfTags);
      out = out.filter(e => e.tags.some(t => wanted.has(t)));
    }
    out.sort((a, b) => a.entryId.localeCompare(b.entryId));
    return out;
  }

  /**
   * Pure-read recall. Scores entries by tag overlap with the query
   * tags. Never writes — `lastSeenAt` and any other mutable counters
   * remain frozen even after thousands of recall calls.
   */
  recallProjectMemory(
    opts: RecallOptions = {},
    storageScope?: KnowledgeScope,
  ): RecallHit[] {
    this.load();
    const topK = opts.topK ?? 5;
    const wantedTags = opts.tags ? new Set(opts.tags) : null;
    const candidates: RecallHit[] = [];
    const entries = enterpriseKnowledgeStoreEnabled()
      ? listScopedKnowledgeRecords<ProjectMemoryEntry>(
          KNOWLEDGE_KIND,
          storageScope,
          {
            rowScope: opts.scope ? memoryRowScope(opts.scope) : undefined,
            rowScopePrefix: opts.scope ? undefined : MEMORY_ROW_SCOPE_PREFIX,
          },
        ).map(row => row.record)
      : Array.from(this.entries.values());

    for (const entry of entries) {
      if (opts.scope && entry.scope !== opts.scope) continue;
      if (opts.projectKey && entry.projectKey !== opts.projectKey) continue;
      if (entry.unsupportedReason) continue;
      let score = 0;
      if (wantedTags) {
        for (const t of entry.tags) if (wantedTags.has(t)) score += 1;
        if (score === 0) continue;
        score = score / Math.max(wantedTags.size, 1);
      } else {
        // No tag query — rank everything by confidence.
        score = entry.confidence;
      }
      // Defensive copy so callers cannot mutate stored state via the hit.
      candidates.push({entry: {...entry, tags: [...entry.tags]}, score});
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates.slice(0, topK);
  }

  /**
   * Promote an entry across scopes per the supplied policy. Throws on
   * any trigger outside the enum; appends a row to the promotion
   * audit log; sets `entry.promotionPolicy` to the supplied policy.
   */
  promoteEntry(
    entryId: string,
    policy: MemoryPromotionPolicy,
    storageScope?: KnowledgeScope,
  ): void {
    this.load();
    if (!VALID_PROMOTION_TRIGGERS.has(policy.trigger)) {
      throw new KnowledgeCurationError('memory_promotion_rejected',
        `Invalid promotion trigger '${policy.trigger}'; auto-promotion is forbidden`,
      );
    }
    if (policy.toScope === 'world' && policy.trigger !== 'reviewer_approval') {
      throw new KnowledgeCurationError('memory_promotion_rejected',
        `Promotion to scope='world' requires trigger='reviewer_approval'; got '${policy.trigger}'`,
      );
    }
    if (policy.trigger === 'reviewer_approval' && !policy.reviewer) {
      throw new KnowledgeCurationError('memory_promotion_rejected',
        "Promotion with trigger='reviewer_approval' requires a `reviewer` field",
      );
    }
    if (policy.trigger === 'skill_eval_pass' && !policy.evalCaseId) {
      throw new KnowledgeCurationError('memory_promotion_rejected',
        "Promotion with trigger='skill_eval_pass' requires an `evalCaseId` field",
      );
    }
    const entry = enterpriseKnowledgeStoreEnabled()
      ? getScopedKnowledgeRecord<ProjectMemoryEntry>(
          KNOWLEDGE_KIND,
          entryId,
          storageScope,
        )?.record
      : this.entries.get(entryId);
    if (!entry) {
      throw new KnowledgeCurationError('memory_entry_not_found', `Cannot promote: entry '${entryId}' not found`, 404);
    }
    if (entry.scope !== policy.fromScope) {
      throw new KnowledgeCurationError('memory_promotion_rejected',
        `Promotion fromScope='${policy.fromScope}' does not match current scope '${entry.scope}'`,
      );
    }
    const promoted: ProjectMemoryEntry = {
      ...entry,
      scope: policy.toScope,
      promotionLevel: (entry.promotionLevel ?? 0) + 1,
      promotionPolicy: policy,
    };
    const auditEntry = {entryId, policy, auditedAt: Date.now()};
    let auditRecorded = false;
    if (legacyKnowledgeFilesystemWritesEnabled()) {
      this.entries.set(entryId, promoted);
      this.auditLog.push(auditEntry);
      this.persist();
      auditRecorded = true;
    }
    if (enterpriseKnowledgeDbWritesEnabled()) {
      upsertScopedKnowledgeRecord(
        KNOWLEDGE_KIND,
        entryId,
        memoryRowScope(promoted.scope),
        promoted,
        storageScope,
        {
          createdAt: promoted.createdAt,
          updatedAt: Date.now(),
          sourceRunId: storageScope?.sourceRunId ?? storageScope?.runId,
        },
      );
      if (!auditRecorded) this.auditLog.push(auditEntry);
    }
  }

  /** Read-only view of the audit log, sorted by audit time ascending. */
  getPromotionAudit(): PromotionAuditEntry[] {
    this.load();
    return [...this.auditLog].sort((a, b) => a.auditedAt - b.auditedAt);
  }

  /** Count entries currently in storage by scope. */
  getStats(storageScope?: KnowledgeScope): Record<'project' | 'world', number> {
    this.load();
    const out = {project: 0, world: 0};
    const entries = enterpriseKnowledgeStoreEnabled()
      ? listScopedKnowledgeRecords<ProjectMemoryEntry>(
          KNOWLEDGE_KIND,
          storageScope,
          {rowScopePrefix: MEMORY_ROW_SCOPE_PREFIX},
        ).map(row => row.record)
      : Array.from(this.entries.values());
    for (const entry of entries) {
      if (entry.scope === 'project') out.project++;
      else if (entry.scope === 'world') out.world++;
    }
    return out;
  }

  private assertSaveInvariants(entry: ProjectMemoryEntry): void {
    if ((entry.scope as string) === 'session') {
      throw new Error(
        `ProjectMemory does not store session-scope entries; use analysisPatternMemory.ts instead`,
      );
    }
    if (entry.scope === 'world' && !entry.promotionPolicy) {
      throw new Error(
        `Entry '${entry.entryId}' with scope='world' must carry a promotionPolicy`,
      );
    }
    if (
      entry.promotionPolicy &&
      !VALID_PROMOTION_TRIGGERS.has(entry.promotionPolicy.trigger)
    ) {
      throw new Error(
        `Entry '${entry.entryId}' has an invalid promotion trigger '${entry.promotionPolicy.trigger}'`,
      );
    }
  }

  /** Atomic temp+rename. Same contract as ragStore / baselineStore. */
  private persist(): void {
    const dir = path.dirname(this.storagePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, {recursive: true});
    // Per-process unique tmp suffix — Codex round E P1#5.
    const tmp = `${this.storagePath}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
    const envelope: StorageEnvelope = {
      schemaVersion: 1,
      entries: Array.from(this.entries.values()),
      promotionAudit: [...this.auditLog],
    };
    fs.writeFileSync(tmp, JSON.stringify(envelope, null, 2), 'utf-8');
    fs.renameSync(tmp, this.storagePath);
  }
}

function memoryRowScope(scope: MemoryScope): string {
  if (scope === 'session') {
    throw new Error(`ProjectMemory does not store session-scope entries`);
  }
  return `${MEMORY_ROW_SCOPE_PREFIX}${scope}`;
}
