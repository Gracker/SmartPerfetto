// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * CaseLibrary — durable storage for `CaseNode` records (Plan 54 M0).
 *
 * The double-control publish gate from §5.2 of the unified design doc
 * lives here. A case can become `status='published'` ONLY through the
 * dedicated `publishCase()` path AND only when:
 *   1. `redactionState === 'redacted'` — the trace artifact has been
 *      anonymized and approved as such.
 *   2. A curator has signed off — `curatedBy` is set, and
 *      `publishCase()` requires the reviewer to be passed explicitly.
 *
 * `saveCase()` itself rejects records arriving with `status='published'`
 * — the only way through is the dedicated path. This makes the
 * promotion to public a deliberate API call instead of an accidental
 * field update.
 *
 * Out of scope here (M1 / M2):
 * - Case graph / edge management (`caseGraph.ts`).
 * - MCP tools (`recall_similar_case`, `cite_case_in_report`).
 * - Express CRUD route.
 *
 * @module caseLibrary
 */

import * as fs from 'fs';
import * as path from 'path';

import {
  type CaseEducationalLevel,
  type CaseNode,
  type CurationStatus,
  makeSparkProvenance,
} from '../types/sparkContracts';
import {
  enterpriseKnowledgeDbWritesEnabled,
  enterpriseKnowledgeStoreEnabled,
  legacyKnowledgeFilesystemWritesEnabled,
  type KnowledgeScope,
  getScopedKnowledgeRecord,
  listScopedKnowledgeRecords,
  mutateScopedKnowledgeRecordWithSideEffect,
  removeScopedKnowledgeRecord,
  removeScopedKnowledgeRecordIf,
  upsertScopedKnowledgeRecord,
} from './scopedKnowledgeStore';
import {withFilesystemRegistryLock} from './filesystemRegistryLock';
import {assertNotRetiredCaseWrite, isRetiredCaseNode} from './retiredCaseData';
import {logStoredReadFailure, parseStoredJson} from '../utils/storedData';
import {
  attestCaseCuration,
  describeCaseCuration,
  hasValidCaseAttestation,
  isAnalysisAdmittedCase,
  type CaseCurationGrant,
  type CaseCurationView,
} from './security/caseCuration';
import {CURATED_CASE_STATUSES, type CuratedCaseStatus} from '../types/caseKnowledge';

interface StorageEnvelope {
  schemaVersion: 1;
  cases: CaseNode[];
  /** Curation attestations by case id, beside the records (`security/caseCuration.ts`). */
  attestations?: Record<string, unknown>;
}

/** A stored case and the attestation its store keeps beside it. */
interface StoredCase {
  record: CaseNode;
  attestation?: unknown;
}

const KNOWLEDGE_KIND = 'case_node';
const CASE_ROW_SCOPE_PREFIX = 'case:';

export interface ListOptions {
  status?: CurationStatus;
  /** Restrict to cases whose tag set overlaps with at least one of these. */
  anyOfTags?: string[];
  educationalLevel?: CaseEducationalLevel;
}

export interface PublishOptions {
  /** The reviewer a Markdown import names; a signed-in curator always signs as themselves. */
  reviewer?: string;
  /** Preserve an existing curation timestamp during rebuild-style writes. */
  curatedAt?: number;
}

export interface ArchiveOptions {
  reason: string;
}

/** A case as its curators see it: whether analyses read it, and who last vouched for it. */
export type CuratedCaseView = CaseNode & CaseCurationView;

/**
 * CaseLibrary — local file-backed case storage with a cross-process
 * read-modify-write lease for every filesystem mutation.
 */
export class CaseLibrary {
  private readonly storagePath: string;
  private readonly cases = new Map<string, StoredCase>();
  private loadError: Error | undefined;

  constructor(storagePath: string) {
    this.storagePath = storagePath;
  }

  load(): void {
    this.cases.clear();
    this.loadError = undefined;
    if (!fs.existsSync(this.storagePath)) return;
    try {
      const raw = fs.readFileSync(this.storagePath, 'utf-8');
      const parsed = parseStoredJson<StorageEnvelope>(raw, 'case library');
      if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.cases)) {
        this.loadError = new Error('Case library schema is invalid');
        return;
      }
      const attestations = parsed.attestations && typeof parsed.attestations === 'object' ? parsed.attestations : {};
      for (const record of parsed.cases) {
        this.cases.set(record.caseId, {
          record,
          attestation: Object.prototype.hasOwnProperty.call(attestations, record.caseId)
            ? attestations[record.caseId] : undefined,
        });
      }
    } catch (error) {
      // Corrupted JSON: file preserved, in-memory cache stays empty.
      this.loadError = new Error('Case library is unreadable');
      logStoredReadFailure('[CaseLibrary] Case library unreadable, file preserved', error, {path: this.storagePath});
    }
  }

  /**
   * Save (insert or replace) a case a curator submitted whole, attesting it
   * (`security/caseCuration.ts`); a signed-in curator's save is signed by that
   * curator, and a curation view sent back with the case is dropped. Throws
   * when the record arrives with `status='published'` — the only legitimate
   * path to publish is the dedicated `publishCase()` call so the gate cannot
   * be bypassed by a field update — and for a retired learned case.
   */
  saveCase(input: CaseNode, grant: CaseCurationGrant, scope?: KnowledgeScope): CuratedCaseView {
    const record = {...withoutCurationView(input), ...(grant.actor ? {curatedBy: grant.actor} : {})};
    assertNotRetiredCaseWrite('case', isRetiredCaseNode(record), record.caseId);
    if (record.status === 'published') {
      throw new Error(
        `Use publishCase() to advance a case to 'published'; saveCase() rejects published records to keep the gate auditable`,
      );
    }
    const stored = {record, attestation: attestCaseCuration(grant, record)};
    const filesystemWrites = legacyKnowledgeFilesystemWritesEnabled();
    const databaseWrites = enterpriseKnowledgeDbWritesEnabled();
    if (filesystemWrites && databaseWrites) {
      mutateScopedKnowledgeRecordWithSideEffect<CaseNode>(
        KNOWLEDGE_KIND,
        record.caseId,
        scope,
        () => ({...stored, rowScope: caseRowScope(record.status)}),
        (_next, current) => {
          assertReplicaMatches('case', record.caseId, current, this.cases.get(record.caseId)?.record);
          this.cases.set(record.caseId, stored);
        },
        {createdAt: record.createdAt, updatedAt: Date.now()},
        body => this.mutateFilesystem(body),
      );
      return curationView(stored);
    }
    if (filesystemWrites) {
      this.mutateFilesystem(() => this.cases.set(record.caseId, stored));
    }
    if (databaseWrites) {
      upsertScopedKnowledgeRecord(
        KNOWLEDGE_KIND,
        record.caseId,
        caseRowScope(record.status),
        record,
        scope,
        {createdAt: record.createdAt, updatedAt: Date.now(), attestation: stored.attestation},
      );
    }
    return curationView(stored);
  }

  getCase(caseId: string, scope?: KnowledgeScope): CaseNode | undefined {
    const record = this.getStoredCase(caseId, scope)?.record;
    return record && !isRetiredCaseNode(record) ? record : undefined;
  }

  /** `getCase` with the case's curation, for the curators who decide what analyses read. */
  getCaseForCuration(caseId: string, scope?: KnowledgeScope): CuratedCaseView | undefined {
    const stored = this.getStoredCase(caseId, scope);
    return stored && !isRetiredCaseNode(stored.record) ? curationView(stored) : undefined;
  }

  /**
   * The ids of the retired cases this scope's store holds, for a store that
   * must recognize them by node facts: a retired node may carry an ordinary id.
   * A store it cannot fully read throws rather than reading as holding none.
   */
  retiredCaseIds(scope?: KnowledgeScope): Set<string> {
    const cases = this.listStoredCases(scope, undefined, {requireReadable: true}).map(({record}) => record);
    return new Set(cases.filter(isRetiredCaseNode).map(c => c.caseId));
  }

  removeCase(caseId: string, scope?: KnowledgeScope): boolean {
    const filesystemWrites = legacyKnowledgeFilesystemWritesEnabled();
    const databaseWrites = enterpriseKnowledgeDbWritesEnabled();
    if (filesystemWrites && databaseWrites) {
      const removed = removeScopedKnowledgeRecordIf<CaseNode>(
        KNOWLEDGE_KIND,
        caseId,
        scope,
        () => true,
        current => this.mutateFilesystem(() => {
          assertReplicaMatches('case', caseId, current, this.cases.get(caseId)?.record);
          this.cases.delete(caseId);
        }),
      );
      if (removed) return true;
      return this.mutateFilesystem(() => this.cases.delete(caseId));
    }
    let removed = false;
    if (databaseWrites) {
      removed = removeScopedKnowledgeRecord(KNOWLEDGE_KIND, caseId, scope) || removed;
    }
    if (filesystemWrites) {
      const had = this.mutateFilesystem(() => this.cases.delete(caseId));
      removed = had || removed;
    }
    return removed;
  }

  listCases(opts: ListOptions = {}, scope?: KnowledgeScope): CaseNode[] {
    return this.listFilteredCases(opts, scope).map(({record}) => record);
  }

  /** `listCases` with each case's curation, for the curators who decide what analyses read. */
  listCasesForCuration(opts: ListOptions = {}, scope?: KnowledgeScope): CuratedCaseView[] {
    return this.listFilteredCases(opts, scope).map(curationView);
  }

  /**
   * The cases an analysis reads (background, recall, finalization hits,
   * similarity hints), in these statuses: shareable and attested for their
   * current content (`isAnalysisAdmittedCase`). Every analysis read goes
   * through here.
   */
  listAdmittedCases(
    statuses: readonly CuratedCaseStatus[] = CURATED_CASE_STATUSES,
    scope?: KnowledgeScope,
  ): CaseNode[] {
    const curated = this.listFilteredCases({}, scope).filter(({record}) => statuses.includes(record.status as CuratedCaseStatus));
    const admitted = curated.filter(({record, attestation}) => isAnalysisAdmittedCase(record, attestation));
    warnUnadmittedCuratedCases(curated.length - admitted.length);
    return admitted.map(({record}) => record);
  }

  /**
   * Advance a case to `status='published'`. Enforces the double-control
   * gate:
   *   - Case must already exist (we publish a known record).
   *   - `redactionState === 'redacted'` — anonymizer must have run.
   *   - A reviewer signs off — the signed-in curator, or the one a Markdown
   *     import names.
   *
   * The reviewer signs off on the case's current content, so publishing
   * attests it. Returns the published case as curators see it, so callers
   * can render the new state without a follow-up read. Stamps `curatedBy` /
   * `curatedAt` from the reviewer + wall clock.
   */
  publishCase(
    caseId: string,
    opts: PublishOptions,
    grant: CaseCurationGrant,
    scope?: KnowledgeScope,
  ): CuratedCaseView {
    const reviewer = (grant.actor ?? opts.reviewer)?.trim();
    if (!reviewer) {
      throw new Error(
        `Cannot publish case '${caseId}' without a reviewer signoff`,
      );
    }
    return curationView(this.writeExisting(caseId, scope, existing => {
      if (!existing || isRetiredCaseNode(existing)) throw new Error(`Cannot publish case '${caseId}': not found`);
      if (existing.redactionState !== 'redacted') {
        throw new Error(
          `Cannot publish case '${caseId}': redactionState='${existing.redactionState}' (must be 'redacted')`,
        );
      }
      const record: CaseNode = {
        ...existing,
        status: 'published',
        curatedBy: reviewer,
        curatedAt: opts.curatedAt ?? Date.now(),
      };
      return {record, attestation: attestCaseCuration(grant, record)};
    }));
  }

  /**
   * Archive a case: drops the trace artifact pointer (so the artifact
   * store can evict the underlying file) while keeping the case
   * metadata in place for backward references. Records the supplied
   * reason on `traceUnavailableReason` so consumers see why the trace
   * is gone. Archiving maintains a case rather than curating it: the
   * archived content is attested only when a curator had attested the
   * content it replaces.
   */
  archiveCase(
    caseId: string,
    opts: ArchiveOptions,
    grant: CaseCurationGrant,
    scope?: KnowledgeScope,
  ): CuratedCaseView {
    const reason = opts.reason?.trim();
    if (!reason) {
      throw new Error(`archiveCase requires a non-empty reason`);
    }
    return curationView(this.writeExisting(caseId, scope, (existing, attested) => {
      if (!existing || isRetiredCaseNode(existing)) throw new Error(`Cannot archive case '${caseId}': not found`);
      const record: CaseNode = {
        ...existing,
        ...makeSparkProvenance({
          source: existing.source,
          notes: `archived via archiveCase`,
        }),
        traceArtifactId: undefined,
        traceUnavailableReason: reason,
      };
      const attestation = attestCaseCuration(grant, record);
      return {record, ...(attested ? {attestation} : {})};
    }));
  }

  /** Stats by status — useful for the admin dashboard. */
  getStats(scope?: KnowledgeScope): Record<CurationStatus, number> {
    const out: Record<CurationStatus, number> = {
      draft: 0,
      reviewed: 0,
      published: 0,
      private: 0,
    };
    for (const c of this.listCases({}, scope)) out[c.status]++;
    return out;
  }

  /**
   * Rewrite a stored case in every store this phase writes. `attested` says
   * whether a curator attested its current content in every copy: in
   * dual-write the file is what analyses read, so it is read under its lock
   * with the database row, and a valid copy never stands in for a missing or
   * stale one in the other.
   */
  private writeExisting(
    caseId: string,
    scope: KnowledgeScope | undefined,
    rewrite: (existing: CaseNode | undefined, attested: boolean) => StoredCase,
  ): StoredCase {
    const filesystemWrites = legacyKnowledgeFilesystemWritesEnabled();
    const databaseWrites = enterpriseKnowledgeDbWritesEnabled();
    if (!databaseWrites) {
      return this.mutateFilesystem(() => {
        const next = rewrite(this.cases.get(caseId)?.record, this.loadedCopyAttested(caseId));
        this.cases.set(caseId, next);
        return next;
      });
    }
    let next: StoredCase | undefined;
    mutateScopedKnowledgeRecordWithSideEffect<CaseNode>(
      KNOWLEDGE_KIND,
      caseId,
      scope,
      (current, currentAttestation) => {
        const attested = !!current && hasValidCaseAttestation(current, currentAttestation) &&
          (!filesystemWrites || this.loadedCopyAttested(caseId));
        next = rewrite(current, attested);
        return {...next, rowScope: caseRowScope(next.record.status)};
      },
      (_record, current) => {
        if (!filesystemWrites) return;
        assertReplicaMatches('case', caseId, current, this.cases.get(caseId)?.record);
        this.cases.set(caseId, next!);
      },
      {},
      filesystemWrites ? body => this.mutateFilesystem(body) : undefined,
    );
    return next!;
  }

  /** Whether the loaded case file holds an attestation for its own copy of the case. */
  private loadedCopyAttested(caseId: string): boolean {
    const stored = this.cases.get(caseId);
    return !!stored && hasValidCaseAttestation(stored.record, stored.attestation);
  }

  private listFilteredCases(opts: ListOptions, scope?: KnowledgeScope): StoredCase[] {
    let out = this.listStoredCases(scope, opts.status).filter(({record}) => !isRetiredCaseNode(record));
    if (opts.status) out = out.filter(({record}) => record.status === opts.status);
    if (opts.educationalLevel)
      out = out.filter(({record}) => record.educationalLevel === opts.educationalLevel);
    if (opts.anyOfTags && opts.anyOfTags.length > 0) {
      const wanted = new Set(opts.anyOfTags);
      out = out.filter(({record}) => record.tags.some(t => wanted.has(t)));
    }
    return out.sort((a, b) => a.record.caseId.localeCompare(b.record.caseId));
  }

  /** The stored record and attestation as is, retired or not. */
  private getStoredCase(caseId: string, scope?: KnowledgeScope): StoredCase | undefined {
    if (enterpriseKnowledgeStoreEnabled()) {
      return getScopedKnowledgeRecord<CaseNode>(
        KNOWLEDGE_KIND,
        caseId,
        scope,
      );
    }
    this.load();
    return this.cases.get(caseId);
  }

  private listStoredCases(
    scope?: KnowledgeScope,
    status?: CurationStatus,
    {requireReadable = false}: {requireReadable?: boolean} = {},
  ): StoredCase[] {
    if (enterpriseKnowledgeStoreEnabled()) {
      return listScopedKnowledgeRecords<CaseNode>(
        KNOWLEDGE_KIND,
        scope,
        {
          rowScope: status ? caseRowScope(status) : undefined,
          rowScopePrefix: status ? undefined : CASE_ROW_SCOPE_PREFIX,
          requireReadable,
        },
      );
    }
    this.load();
    // The load error quotes the file; the caller learns only that it failed.
    if (requireReadable && this.loadError) throw new Error('case_library_unreadable');
    return Array.from(this.cases.values());
  }

  private persist(): void {
    const dir = path.dirname(this.storagePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, {recursive: true});
    // Per-process unique tmp suffix — Codex round E P1#5.
    const tmp = `${this.storagePath}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
    const stored = Array.from(this.cases.values());
    const envelope: StorageEnvelope = {
      schemaVersion: 1,
      cases: stored.map(({record}) => record),
      attestations: Object.fromEntries(stored
        .filter(({attestation}) => attestation !== undefined)
        .map(({record, attestation}) => [record.caseId, attestation])),
    };
    fs.writeFileSync(tmp, JSON.stringify(envelope, null, 2), 'utf-8');
    fs.renameSync(tmp, this.storagePath);
  }

  private mutateFilesystem<T>(mutation: () => T): T {
    return withFilesystemRegistryLock(
      this.storagePath,
      'case_library_busy',
      () => {
        this.load();
        if (this.loadError) throw this.loadError;
        const result = mutation();
        this.persist();
        return result;
      },
    );
  }
}

/**
 * A case without the curation view fields a curator may send back with it:
 * the view is computed, never stored.
 */
function withoutCurationView(input: CaseNode & Partial<CaseCurationView>): CaseNode {
  const {analysisAdmitted: _admitted, curation: _curation, ...record} = input;
  return record;
}

function curationView({record, attestation}: StoredCase): CuratedCaseView {
  return {...withoutCurationView(record), ...describeCaseCuration(record, attestation)};
}

let unadmittedCuratedCasesWarned = false;

/**
 * Once per process. Cases stored before attestations existed, or changed by
 * anything but a curator's write since, stay unread until a curator vouches
 * for them again.
 */
function warnUnadmittedCuratedCases(count: number): void {
  if (count <= 0 || unadmittedCuratedCasesWarned) return;
  unadmittedCuratedCasesWarned = true;
  console.warn('[CaseLibrary] Published or reviewed cases are not read by analyses: not redacted, or no curator attested their current content; re-publish, re-save or re-ingest them', {count});
}

function assertReplicaMatches<T>(
  kind: string,
  id: string,
  databaseRecord: T | undefined,
  filesystemRecord: T | undefined,
): void {
  if (databaseRecord === undefined || filesystemRecord === undefined) return;
  if (JSON.stringify(databaseRecord) !== JSON.stringify(filesystemRecord)) {
    throw new Error(`${kind} '${id}' has diverged database and filesystem replicas`);
  }
}

function caseRowScope(status: CurationStatus): string {
  return `${CASE_ROW_SCOPE_PREFIX}${status}`;
}
