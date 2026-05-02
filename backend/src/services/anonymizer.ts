// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Anonymizer + Large-Trace Streaming Helpers (Spark Plan 06)
 *
 * Stable identifier mapping per AnonymizationDomain so the same package
 * always becomes the same placeholder across runs (Spark #29). Streaming
 * progress reporter for large-trace ingestion (Spark #30).
 */

import {
  makeSparkProvenance,
  type AnonymizationContract,
  type AnonymizationDomain,
  type AnonymizationMapping,
  type LargeTraceStreamProgress,
} from '../types/sparkContracts';

const DOMAIN_PREFIX: Record<AnonymizationDomain, string> = {
  package: 'app_',
  process: 'proc_',
  thread: 'thread_',
  path: 'path_',
  user_id: 'user_',
  device_id: 'device_',
};

/**
 * Stable, in-process anonymizer. Same input value always maps to same
 * placeholder for the same domain.
 */
export class Anonymizer {
  private mappings: Map<string, AnonymizationMapping> = new Map();
  private counters: Map<AnonymizationDomain, number> = new Map();

  private keyOf(domain: AnonymizationDomain, original: string): string {
    return `${domain}:${original}`;
  }

  /** Map a value to its placeholder, creating one on first sight. */
  redact(domain: AnonymizationDomain, original: string): string {
    const key = this.keyOf(domain, original);
    const cached = this.mappings.get(key);
    if (cached) return cached.placeholder;
    const next = (this.counters.get(domain) ?? 0) + 1;
    this.counters.set(domain, next);
    const prefix = DOMAIN_PREFIX[domain] ?? 'redacted_';
    const placeholder = `${prefix}${next}`;
    this.mappings.set(key, {domain, original, placeholder});
    return placeholder;
  }

  /** Replace every original-value occurrence in a free-form string. */
  redactString(domain: AnonymizationDomain, original: string, body: string): string {
    if (!original) return body;
    const placeholder = this.redact(domain, original);
    return body.split(original).join(placeholder);
  }

  /** Snapshot all mappings (sorted by domain then original for stability). */
  getMappings(): AnonymizationMapping[] {
    return Array.from(this.mappings.values()).sort((a, b) => {
      if (a.domain !== b.domain) return a.domain.localeCompare(b.domain);
      return a.original.localeCompare(b.original);
    });
  }

  /** Build a contract describing the current redaction state. */
  toContract(opts: {
    state?: 'raw' | 'partial' | 'redacted';
    pendingDomains?: AnonymizationDomain[];
    streamProgress?: LargeTraceStreamProgress;
  } = {}): AnonymizationContract {
    return {
      ...makeSparkProvenance({source: 'anonymizer'}),
      state: opts.state ?? (opts.pendingDomains && opts.pendingDomains.length > 0 ? 'partial' : 'redacted'),
      mappings: this.getMappings(),
      ...(opts.pendingDomains ? {pendingDomains: opts.pendingDomains} : {}),
      ...(opts.streamProgress ? {streamProgress: opts.streamProgress} : {}),
      coverage: [
        {sparkId: 29, planId: '06', status: 'implemented'},
        {sparkId: 30, planId: '06', status: opts.streamProgress ? 'implemented' : 'scaffolded'},
      ],
    };
  }
}

/** Streaming progress reporter for large-trace ingestion. */
export class LargeTraceStreamReporter {
  private startedAt = Date.now();
  private chunksEmitted = 0;
  private processedBytes = 0;
  private lastChunkAt = this.startedAt;
  private done = false;

  constructor(private totalBytes: number) {}

  /** Record progress after a chunk is processed. */
  report(chunkBytes: number): LargeTraceStreamProgress {
    const now = Date.now();
    this.processedBytes += chunkBytes;
    this.chunksEmitted += 1;
    const lastChunkMs = now - this.lastChunkAt;
    this.lastChunkAt = now;
    return {
      totalBytes: this.totalBytes,
      processedBytes: Math.min(this.processedBytes, this.totalBytes),
      chunksEmitted: this.chunksEmitted,
      done: this.done || this.processedBytes >= this.totalBytes,
      lastChunkMs,
    };
  }

  /** Mark the stream as completed. */
  complete(): LargeTraceStreamProgress {
    this.done = true;
    return {
      totalBytes: this.totalBytes,
      processedBytes: this.totalBytes,
      chunksEmitted: this.chunksEmitted,
      done: true,
    };
  }
}
