// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as path from 'path';

import {backendLogPath} from '../../runtimePaths';

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

export interface CodeLookupLedgerEntry {
  turn: number;
  ts: number;
  toolName: 'resolve_symbol' | 'lookup_app_source' | 'lookup_aosp_source' |
    'lookup_kernel_source' | 'lookup_oem_sdk' | 'lookup_blog_knowledge' |
    'search_codebase' | 'read_codebase_file' | 'query_code_graph' |
    'inspect_code_symbol' | 'propose_patch';
  codebaseId?: string;
  knowledgeSourceId?: string;
  sourceGeneration?: string;
  chunkIds: string[];
  /** Bounded source/graph references returned by non-indexed lookup tools. */
  returnedReferenceCount?: number;
  consentApplied: boolean;
  tokensSpent: number;
  outcome: CodeLookupOutcome;
  legacyPath: boolean;
  /** Non-secret authorization partition. Audit-only entries never grant capability across partitions. */
  authorizationFingerprint?: string;
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
}

function defaultLedgerPath(sessionId: string): string {
  return backendLogPath(path.join('sessions', `${sessionId}.codeLookupLedger.jsonl`));
}

export class CodeLookupLedger {
  private readonly entries: CodeLookupLedgerEntry[] = [];
  private readonly auditEntries: CodeLookupLedgerEntry[] = [];
  private readonly sidecarPath: string;
  private appendQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly sessionId: string,
    private readonly capTokens: number,
    private readonly capPatches: number,
    sidecarPath = defaultLedgerPath(sessionId),
    private readonly authorizationFingerprint?: string,
  ) {
    this.sidecarPath = sidecarPath;
  }

  static restore(
    sessionId: string,
    capTokens: number,
    capPatches: number,
    sidecarPath = defaultLedgerPath(sessionId),
    authorizationFingerprint?: string,
  ): CodeLookupLedger {
    const ledger = new CodeLookupLedger(
      sessionId,
      capTokens,
      capPatches,
      sidecarPath,
      authorizationFingerprint,
    );
    if (!fs.existsSync(sidecarPath)) return ledger;
    const raw = fs.readFileSync(sidecarPath, 'utf-8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      const parsed = JSON.parse(line) as Partial<CodeLookupLedgerEntry>;
      const entry = {
        ...parsed,
        chunkIds: Array.isArray(parsed.chunkIds) ? parsed.chunkIds : [],
      } as CodeLookupLedgerEntry;
      ledger.auditEntries.push(entry);
      if (
        authorizationFingerprint === undefined ||
        entry.authorizationFingerprint === authorizationFingerprint
      ) {
        ledger.entries.push(entry);
      }
    }
    return ledger;
  }

  record(entry: CodeLookupLedgerEntry): void {
    const normalized: CodeLookupLedgerEntry = {
      ...entry,
      ts: entry.ts || Date.now(),
      chunkIds: [...entry.chunkIds],
      ...(this.authorizationFingerprint
        ? {authorizationFingerprint: this.authorizationFingerprint}
        : {}),
    };
    this.entries.push(normalized);
    this.auditEntries.push(normalized);
    this.appendQueue = this.appendQueue.then(async () => {
      const dir = path.dirname(this.sidecarPath);
      await fs.promises.mkdir(dir, {recursive: true});
      const handle = await fs.promises.open(this.sidecarPath, 'a');
      try {
        await handle.appendFile(`${JSON.stringify(normalized)}\n`, 'utf-8');
        await handle.sync();
      } finally {
        await handle.close();
      }
    });
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

  remainingTokens(): number {
    const spent = this.entries.reduce((sum, entry) => sum + Math.max(0, entry.tokensSpent || 0), 0);
    return Math.max(0, this.capTokens - spent);
  }

  remainingPatches(): number {
    const spent = this.entries.filter(entry =>
      entry.outcome === 'patch_verified' ||
      entry.outcome === 'patch_sketch' ||
      entry.outcome === 'patch_unverified').length;
    return Math.max(0, this.capPatches - spent);
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
    return {
      lookupCount: this.auditEntries.filter(entry => entry.toolName !== 'propose_patch').length,
      patchCount: this.auditEntries.filter(entry => entry.toolName === 'propose_patch').length,
      referencedCodebaseIds: Array.from(codebaseIds).sort(),
      ...(usedCodebaseIds.size > 0
        ? {usedCodebaseIds: Array.from(usedCodebaseIds).sort()}
        : {}),
      ...(usedKnowledgeSources.length > 0 ? {usedKnowledgeSources} : {}),
    };
  }

  getSessionId(): string {
    return this.sessionId;
  }
}
