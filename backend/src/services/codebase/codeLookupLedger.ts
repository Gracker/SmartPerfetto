// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as path from 'path';

import {backendLogPath} from '../../runtimePaths';
import {isPlainJsonObject} from '../../utils/isPlainJsonObject';
import {logStoredReadFailure, tryParseStoredJson} from '../../utils/storedData';
import {
  sanitizeSourceIncompleteReason,
  sanitizeSourceReferences,
  sanitizeSourceUseDecision,
  type SourceReferenceV1,
  type SourceUseDecisionV1,
} from './sourceUseDecision';

export type CodeLookupOutcome =
  | 'success'
  | 'budget_exceeded'
  | 'consent_blocked'
  | 'license_blocked'
  | 'symbol_low_confidence'
  | 'unresolved'
  | 'patch_verified'
  | 'patch_sketch'
  | 'patch_unverified'
  | 'sidecar_missing'
  | 'rejected';

/** The outcome of a returned on-demand source result, as the ledger and projections record it. */
export function sourceLookupOutcome(
  result: {success?: unknown; unsupportedReason?: unknown},
): Extract<CodeLookupOutcome, 'success' | 'budget_exceeded' | 'consent_blocked' | 'rejected'> {
  const reason = typeof result.unsupportedReason === 'string' ? result.unsupportedReason : undefined;
  return reason?.includes('consent') ? 'consent_blocked'
    : reason === 'budget_exceeded' ? 'budget_exceeded'
    : result.success === false ? 'rejected' : 'success';
}

export interface CodeLookupLedgerEntry {
  turn: number;
  ts: number;
  toolName: 'resolve_symbol' | 'lookup_app_source' | 'lookup_aosp_source' |
    'lookup_kernel_source' | 'lookup_oem_sdk' | 'lookup_blog_knowledge' |
    'search_codebase' | 'read_codebase_file' | 'query_code_graph' |
    'inspect_code_symbol' | 'find_codebase_files' | 'propose_patch';
  codebaseId?: string;
  knowledgeSourceId?: string;
  sourceGeneration?: string;
  chunkIds: string[];
  /** Bounded source/graph references returned by non-indexed lookup tools. */
  returnedReferenceCount?: number;
  consentApplied: boolean;
  tokensSpent: number;
  /** Local tool wall time only; never includes model text or source content. */
  durationMs?: number;
  outcome: CodeLookupOutcome;
  legacyPath: boolean;
  /** Non-secret authorization partition. Audit-only entries never grant capability across partitions. */
  authorizationFingerprint?: string;
  /** Bounded, metadata-only references. Raw source and lookup inputs are never stored. */
  sourceReferences?: SourceReferenceV1[];
  coverageComplete?: boolean;
  incompleteReason?: string;
  sourceUseDecision?: SourceUseDecisionV1;
}

export interface CodeLookupSummary {
  lookupCount: number;
  patchCount: number;
  /** Attempted/touched selected roots. Kept for compatibility. */
  referencedCodebaseIds: string[];
  /** Roots that returned source/graph references successfully. */
  usedCodebaseIds?: string[];
  usedKnowledgeSources?: Array<{
    knowledgeSourceId: string;
    sourceGenerations: string[];
  }>;
  sourceUseDecision?: SourceUseDecisionV1;
  /**
   * Records that could not be read back: a crash cut them short. They may
   * describe lookups or patches that did happen, so when present
   * `lookupCount` and `patchCount` are lower bounds.
   */
  unreadableRecordCount?: number;
}

/**
 * The end of a restored file that is not a terminated record. `unterminated`
 * is a complete record (or blank space) that only lacks its newline; `torn`
 * is a record a crash cut short.
 */
interface RestoredTail {
  kind: 'unterminated' | 'torn';
  offset: number;
  bytes: Buffer;
}

const NEWLINE = 0x0a;

/** A ledger line as a record object; never the parser's message, which quotes the line. */
function parseLedgerLine(line: string): Record<string, unknown> | undefined {
  const parsed = tryParseStoredJson<unknown>(line, 'code lookup ledger');
  return parsed.ok && isPlainJsonObject(parsed.value) ? parsed.value : undefined;
}

/** Persist a new directory entry before overwriting what it preserves. */
async function syncDirectory(dir: string): Promise<void> {
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(dir, 'r');
    await handle.sync();
  } catch (error) {
    // Windows cannot open or sync a directory; the evidence file is still synced.
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EISDIR' && code !== 'EPERM' && code !== 'EINVAL' && code !== 'ENOTSUP') throw error;
  } finally {
    await handle?.close();
  }
}

function boundedLedgerString(value: unknown, maxLength = 256): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > maxLength ||
    normalized.includes('/') ||
    normalized.includes('\\') ||
    normalized.includes('://') ||
    /[\s\u0000-\u001f\u007f]/.test(normalized)
  ) {
    return undefined;
  }
  return normalized;
}

function boundedChunkIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(chunkId => boundedLedgerString(chunkId))
    .filter((chunkId): chunkId is string => Boolean(chunkId));
}

function normalizeLedgerEntry(
  entry: Partial<CodeLookupLedgerEntry>,
  authorizationFingerprint?: string,
): CodeLookupLedgerEntry {
  const sourceReferences = sanitizeSourceReferences(entry.sourceReferences);
  const sourceUseDecision = sanitizeSourceUseDecision(entry.sourceUseDecision);
  const incompleteReason = sanitizeSourceIncompleteReason(entry.incompleteReason);
  const codebaseId = boundedLedgerString(entry.codebaseId);
  const knowledgeSourceId = boundedLedgerString(entry.knowledgeSourceId);
  const sourceGeneration = boundedLedgerString(entry.sourceGeneration);
  const storedAuthorizationFingerprint = boundedLedgerString(
    authorizationFingerprint ?? entry.authorizationFingerprint,
  );
  return {
    turn: Number.isInteger(entry.turn) ? Number(entry.turn) : 0,
    ts: Number.isFinite(entry.ts) && Number(entry.ts) > 0 ? Number(entry.ts) : Date.now(),
    toolName: entry.toolName as CodeLookupLedgerEntry['toolName'],
    ...(codebaseId ? {codebaseId} : {}),
    ...(knowledgeSourceId ? {knowledgeSourceId} : {}),
    ...(sourceGeneration ? {sourceGeneration} : {}),
    chunkIds: boundedChunkIds(entry.chunkIds),
    ...(Number.isInteger(entry.returnedReferenceCount) && Number(entry.returnedReferenceCount) >= 0
      ? {returnedReferenceCount: Number(entry.returnedReferenceCount)}
      : {}),
    consentApplied: entry.consentApplied === true,
    tokensSpent: Number.isFinite(entry.tokensSpent) ? Number(entry.tokensSpent) : 0,
    ...(Number.isFinite(entry.durationMs)
      ? {durationMs: Math.max(0, Math.floor(Number(entry.durationMs)))}
      : {}),
    outcome: entry.outcome as CodeLookupOutcome,
    legacyPath: entry.legacyPath === true,
    ...(storedAuthorizationFingerprint
      ? {authorizationFingerprint: storedAuthorizationFingerprint}
      : {}),
    ...(sourceReferences.length > 0 ? {sourceReferences} : {}),
    ...(typeof entry.coverageComplete === 'boolean'
      ? {coverageComplete: entry.coverageComplete}
      : {}),
    ...(incompleteReason ? {incompleteReason} : {}),
    ...(sourceUseDecision ? {sourceUseDecision} : {}),
  };
}

function defaultLedgerPath(sessionId: string): string {
  return backendLogPath(path.join('sessions', `${sessionId}.codeLookupLedger.jsonl`));
}

export class CodeLookupLedger {
  private readonly entries: CodeLookupLedgerEntry[] = [];
  private readonly auditEntries: CodeLookupLedgerEntry[] = [];
  private readonly sidecarPath: string;
  private appendQueue: Promise<void> = Promise.resolve();
  /**
   * Records restore could not read. The authorization partition of such a
   * record is unknown, so it is charged to every partition.
   */
  private unreadableRecords = 0;
  private restoredTail?: RestoredTail;

  constructor(
    private readonly sessionId: string,
    private readonly capPatches: number,
    sidecarPath = defaultLedgerPath(sessionId),
    private readonly authorizationFingerprint?: string,
  ) {
    this.sidecarPath = sidecarPath;
  }

  static restore(
    sessionId: string,
    capPatches: number,
    sidecarPath = defaultLedgerPath(sessionId),
    authorizationFingerprint?: string,
  ): CodeLookupLedger {
    const ledger = new CodeLookupLedger(
      sessionId,
      capPatches,
      sidecarPath,
      authorizationFingerprint,
    );
    if (!fs.existsSync(sidecarPath)) return ledger;
    const raw = fs.readFileSync(sidecarPath);
    const bodyEnd = raw.lastIndexOf(NEWLINE) + 1;
    // A lookup names private source, so an error names only the line number.
    for (const [index, line] of raw.subarray(0, bodyEnd).toString('utf-8').split('\n').entries()) {
      if (!line.trim()) continue;
      const parsed = parseLedgerLine(line);
      if (!parsed) {
        const error = new Error(`code_lookup_ledger_corrupt_record: line ${index + 1}`);
        logStoredReadFailure('[CodeLookupLedger] Ledger unreadable', error, {sessionId, path: sidecarPath, line: index + 1});
        throw error;
      }
      ledger.restoreRecord(parsed);
    }
    if (bodyEnd < raw.length) {
      // A copy, so the pending repair does not keep the whole file alive.
      const bytes = Buffer.from(raw.subarray(bodyEnd));
      const text = bytes.toString('utf-8');
      // A cut JSON object never parses, so a tail that does is a whole record
      // that lacks only its newline.
      const parsed = parseLedgerLine(text);
      if (parsed) ledger.restoreRecord(parsed);
      const torn = !parsed && text.trim() !== '';
      if (torn) ledger.unreadableRecords += 1;
      ledger.restoredTail = {kind: torn ? 'torn' : 'unterminated', offset: bodyEnd, bytes};
    }
    return ledger;
  }

  private restoreRecord(parsed: Record<string, unknown>): void {
    if ('unreadableRecord' in parsed) {
      this.unreadableRecords += 1;
      return;
    }
    const entry = normalizeLedgerEntry(parsed as Partial<CodeLookupLedgerEntry>);
    this.auditEntries.push(entry);
    if (
      this.authorizationFingerprint === undefined ||
      entry.authorizationFingerprint === this.authorizationFingerprint
    ) {
      this.entries.push(entry);
    }
  }

  record(entry: CodeLookupLedgerEntry): void {
    const normalized = normalizeLedgerEntry(entry, this.authorizationFingerprint);
    this.entries.push(normalized);
    this.auditEntries.push(normalized);
    this.appendQueue = this.appendQueue.then(async () => {
      const dir = path.dirname(this.sidecarPath);
      await fs.promises.mkdir(dir, {recursive: true});
      if (this.restoredTail) {
        await this.repairRestoredTail(this.restoredTail);
        this.restoredTail = undefined;
      }
      const handle = await fs.promises.open(this.sidecarPath, 'a+');
      try {
        // Appending after an unterminated line would merge two records into
        // one unreadable middle line.
        const {size} = await handle.stat();
        if (size > 0) {
          const last = Buffer.alloc(1);
          await handle.read(last, 0, 1, size - 1);
          if (last[0] !== NEWLINE) throw new Error('code_lookup_ledger_unterminated_record');
        }
        await handle.appendFile(`${JSON.stringify(normalized)}\n`, 'utf-8');
        await handle.sync();
      } finally {
        await handle.close();
      }
    });
  }

  /**
   * Terminate the tail restore found, before the next record lands after it.
   * A torn record is moved to an evidence file next to the ledger and replaced
   * by a marker, so every later restore still charges it. The marker is
   * written over the fragment and the file truncated after it: a crash at any
   * point leaves either the fragment or an unterminated remainder, which
   * restore again treats as torn — counted twice, never zero times.
   */
  private async repairRestoredTail(tail: RestoredTail): Promise<void> {
    const handle = await fs.promises.open(this.sidecarPath, 'r+');
    try {
      const current = await handle.readFile();
      if (
        current.length !== tail.offset + tail.bytes.length ||
        !current.subarray(tail.offset).equals(tail.bytes)
      ) {
        throw new Error('code_lookup_ledger_changed_since_restore');
      }
      if (tail.kind === 'unterminated') {
        await handle.write('\n', current.length, 'utf-8');
        await handle.sync();
        return;
      }
      const repairedAt = Date.now();
      // Named like the ledger so log cleanup removes it with the ledger, and
      // itself one JSON record, so readers of `*.jsonl` logs can parse it.
      const evidence = await fs.promises.open(
        `${this.sidecarPath.replace(/\.jsonl$/, '')}.unreadable-${repairedAt}-${process.pid}.jsonl`,
        'wx',
        0o600,
      );
      try {
        await evidence.writeFile(`${JSON.stringify({unreadableRecordBase64: tail.bytes.toString('base64')})}\n`);
        await evidence.sync();
      } finally {
        await evidence.close();
      }
      await syncDirectory(path.dirname(this.sidecarPath));
      const marker = Buffer.from(
        `${JSON.stringify({unreadableRecord: {bytes: tail.bytes.length, repairedAt}})}\n`,
        'utf-8',
      );
      await handle.write(marker, 0, marker.length, tail.offset);
      await handle.truncate(tail.offset + marker.length);
      await handle.sync();
      console.warn('[CodeLookupLedger] Replaced an unreadable final record; source budgets are charged as spent', {
        bytes: tail.bytes.length,
      });
    } finally {
      await handle.close();
    }
  }

  async flush(): Promise<void> {
    await this.appendQueue;
  }

  getEntries(): readonly CodeLookupLedgerEntry[] {
    return this.entries;
  }

  hasPriorLookupOf(chunkId: string): boolean {
    return this.entries.some(entry =>
      entry.outcome === 'success' && entry.chunkIds.includes(chunkId));
  }

  hasSuccessfulCodeLookup(): boolean {
    return this.entries.some(entry =>
      entry.outcome === 'success' && !entry.legacyPath && entry.chunkIds.length > 0);
  }

  remainingPatches(): number {
    const spent = this.entries.filter(entry =>
      entry.outcome === 'patch_verified' ||
      entry.outcome === 'patch_sketch' ||
      entry.outcome === 'patch_unverified').length;
    // Each unreadable record may have been one patch.
    return Math.max(0, this.capPatches - spent - this.unreadableRecords);
  }

  toSnapshotSummary(): CodeLookupSummary {
    const codebaseIds = new Set<string>();
    const usedCodebaseIds = new Set<string>();
    const knowledgeSources = new Map<string, Set<string>>();
    for (const entry of this.auditEntries) {
      if (entry.codebaseId) codebaseIds.add(entry.codebaseId);
      if (
        entry.codebaseId &&
        entry.outcome === 'success' &&
        ((entry.chunkIds?.length ?? 0) > 0 || (entry.returnedReferenceCount ?? 0) > 0)
      ) {
        usedCodebaseIds.add(entry.codebaseId);
      }
      if (entry.outcome === 'success' && entry.knowledgeSourceId) {
        const generations = knowledgeSources.get(entry.knowledgeSourceId) ?? new Set<string>();
        if (entry.sourceGeneration) generations.add(entry.sourceGeneration);
        knowledgeSources.set(entry.knowledgeSourceId, generations);
      }
    }
    const usedKnowledgeSources = Array.from(knowledgeSources, ([knowledgeSourceId, generations]) => ({
      knowledgeSourceId,
      sourceGenerations: Array.from(generations).sort(),
    })).sort((left, right) => left.knowledgeSourceId.localeCompare(right.knowledgeSourceId));
    const sourceUseDecision = [...this.entries]
      .reverse()
      .map(entry => sanitizeSourceUseDecision(entry.sourceUseDecision))
      .find((decision): decision is SourceUseDecisionV1 => Boolean(decision));
    return {
      lookupCount: this.auditEntries.filter(entry => entry.toolName !== 'propose_patch').length,
      patchCount: this.auditEntries.filter(entry => entry.toolName === 'propose_patch').length,
      referencedCodebaseIds: Array.from(codebaseIds).sort(),
      ...(usedCodebaseIds.size > 0
        ? {usedCodebaseIds: Array.from(usedCodebaseIds).sort()}
        : {}),
      ...(usedKnowledgeSources.length > 0 ? {usedKnowledgeSources} : {}),
      ...(sourceUseDecision ? {sourceUseDecision} : {}),
      ...(this.unreadableRecords > 0 ? {unreadableRecordCount: this.unreadableRecords} : {}),
    };
  }

  getSessionId(): string {
    return this.sessionId;
  }
}
