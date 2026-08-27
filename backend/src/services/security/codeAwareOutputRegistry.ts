// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {createHash} from 'crypto';

import type {SanitizedRagResult} from '../rag/lookupResponseFilter';
import {LLMEchoOutputStream, type CodeRef} from './llmEchoOutputFilter';

type GuardRegistration =
  | {kind: 'snippet'; snippet: string; ref: CodeRef}
  | {kind: 'private'; snippet: string; replacement: string}
  | {kind: 'canary'; canary: string};

const MAX_GUARD_REGISTRATIONS = 200;
const MAX_GUARD_PATTERN_BYTES = 2 * 1024 * 1024;
const MAX_SESSION_GUARDS = 256;
const MAX_AGGREGATE_GUARD_PATTERN_BYTES = 64 * 1024 * 1024;
const REVOKED_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_REVOKED_SESSION_MARKERS = 4_096;
const PRIVATE_OUTPUT_SUPPRESSED = '[PRIVATE_OUTPUT_SUPPRESSED]';
const MAX_STRUCTURED_TEXT_DEPTH = 24;
const MAX_STRUCTURED_TEXT_ITEMS = 10_000;
const MAX_STRUCTURED_TEXT_STRING_BYTES = 1024 * 1024;

class SessionCodeAwareOutputGuard {
  private readonly registrations: GuardRegistration[] = [];
  private readonly streams = new Map<string, LLMEchoOutputStream>();
  private registrationBytes = 0;
  private overflowed = false;

  register(registration: GuardRegistration): void {
    if (this.overflowed) return;
    const pattern = registration.kind === 'snippet'
      ? registration.snippet
      : registration.kind === 'private'
        ? `${registration.snippet}\0${registration.replacement}`
        : registration.canary;
    const patternBytes = Buffer.byteLength(pattern, 'utf8');
    if (
      this.registrations.length >= MAX_GUARD_REGISTRATIONS ||
      this.registrationBytes + patternBytes > MAX_GUARD_PATTERN_BYTES
    ) {
      this.overflowed = true;
      this.registrationBytes = 0;
      this.registrations.length = 0;
      for (const stream of this.streams.values()) stream.destroy();
      this.streams.clear();
      return;
    }
    this.registrations.push(registration);
    this.registrationBytes += patternBytes;
    for (const stream of this.streams.values()) this.apply(stream, registration);
  }

  projectComplete(text: string): string {
    if (this.overflowed) return PRIVATE_OUTPUT_SUPPRESSED;
    const stream = this.createStream();
    try {
      return stream.write(text) + stream.flush();
    } finally {
      stream.destroy();
    }
  }

  write(channel: string, text: string): string {
    if (this.overflowed) return '';
    let stream = this.streams.get(channel);
    if (!stream) {
      stream = this.createStream();
      this.streams.set(channel, stream);
    }
    return stream.write(text);
  }

  flush(channel: string): string {
    if (this.overflowed) return PRIVATE_OUTPUT_SUPPRESSED;
    const stream = this.streams.get(channel);
    if (!stream) return '';
    this.streams.delete(channel);
    try {
      return stream.flush();
    } finally {
      stream.destroy();
    }
  }

  destroy(): void {
    for (const stream of this.streams.values()) stream.destroy();
    this.streams.clear();
    this.registrations.length = 0;
    this.registrationBytes = 0;
    // Projections may still hold this guard after registry eviction. Keep the
    // detached object irreversibly fail-closed instead of turning it into an
    // empty pass-through guard.
    this.overflowed = true;
  }

  get patternBytes(): number {
    return this.registrationBytes;
  }

  private createStream(): LLMEchoOutputStream {
    const stream = new LLMEchoOutputStream();
    for (const registration of this.registrations) this.apply(stream, registration);
    return stream;
  }

  private apply(stream: LLMEchoOutputStream, registration: GuardRegistration): void {
    if (registration.kind === 'snippet') {
      stream.registerSnippet(registration.snippet, registration.ref);
    } else if (registration.kind === 'private') {
      stream.registerPrivateSnippet(registration.snippet, registration.replacement);
    } else {
      stream.registerCanary(registration.canary);
    }
  }
}

const sessionGuards = new Map<string, SessionCodeAwareOutputGuard>();
const revokedSessions = new Map<string, number>();
let failClosedUnknownUntil = 0;

function sessionMarker(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('hex');
}

function sweepRevokedSessions(now = Date.now()): void {
  for (const [marker, expiresAt] of revokedSessions) {
    if (expiresAt <= now) revokedSessions.delete(marker);
  }
  if (failClosedUnknownUntil <= now) failClosedUnknownUntil = 0;
}

function markSessionRevoked(sessionId: string): void {
  const now = Date.now();
  sweepRevokedSessions(now);
  if (revokedSessions.size >= MAX_REVOKED_SESSION_MARKERS) {
    revokedSessions.clear();
    failClosedUnknownUntil = now + REVOKED_SESSION_TTL_MS;
    return;
  }
  revokedSessions.set(sessionMarker(sessionId), now + REVOKED_SESSION_TTL_MS);
}

function sessionWasRevoked(sessionId: string): boolean {
  sweepRevokedSessions();
  return failClosedUnknownUntil > Date.now() || revokedSessions.has(sessionMarker(sessionId));
}

function touchGuard(sessionId: string): SessionCodeAwareOutputGuard | undefined {
  const guard = sessionGuards.get(sessionId);
  if (!guard) return undefined;
  sessionGuards.delete(sessionId);
  sessionGuards.set(sessionId, guard);
  return guard;
}

function evictLeastRecentlyUsedGuard(excludeSessionId?: string): boolean {
  for (const [sessionId, guard] of sessionGuards) {
    if (sessionId === excludeSessionId) continue;
    sessionGuards.delete(sessionId);
    guard.destroy();
    markSessionRevoked(sessionId);
    return true;
  }
  return false;
}

function aggregateGuardPatternBytes(): number {
  let total = 0;
  for (const guard of sessionGuards.values()) total += guard.patternBytes;
  return total;
}

function enforceRegistryLimits(currentSessionId: string): void {
  while (
    sessionGuards.size > MAX_SESSION_GUARDS ||
    aggregateGuardPatternBytes() > MAX_AGGREGATE_GUARD_PATTERN_BYTES
  ) {
    if (evictLeastRecentlyUsedGuard(currentSessionId)) continue;
    const current = sessionGuards.get(currentSessionId);
    if (current) {
      sessionGuards.delete(currentSessionId);
      current.destroy();
      markSessionRevoked(currentSessionId);
    }
    break;
  }
}

function guardFor(sessionId: string): SessionCodeAwareOutputGuard | undefined {
  if (sessionWasRevoked(sessionId)) return undefined;
  let guard = touchGuard(sessionId);
  if (!guard) {
    guard = new SessionCodeAwareOutputGuard();
    sessionGuards.set(sessionId, guard);
    enforceRegistryLimits(sessionId);
    guard = touchGuard(sessionId);
  }
  return guard;
}

function registerForSession(sessionId: string, registration: GuardRegistration): void {
  const guard = guardFor(sessionId);
  if (!guard) return;
  guard.register(registration);
  enforceRegistryLimits(sessionId);
}

export function registerCodeAwareLookupForEcho(sessionId: string | undefined, result: SanitizedRagResult): void {
  if (!sessionId) return;
  for (const hit of result.hits) {
    if (!hit.snippet) continue;
    if (hit.metadata?.knowledgeSourceId) {
      registerForSession(sessionId, {
        kind: 'private',
        snippet: hit.snippet,
        replacement: `[Knowledge: ${hit.metadata.knowledgeSourceId}/${hit.chunkId}]`,
      });
      continue;
    }
    if (!hit.metadata?.codebaseId || !hit.metadata.filePath) continue;
    const ref: CodeRef = {
      chunkId: hit.chunkId,
      codebaseId: hit.metadata.codebaseId,
      filePath: hit.metadata.filePath,
      ...(hit.metadata.lineRange ? {lineRange: hit.metadata.lineRange} : {}),
      ...(hit.metadata.symbol ? {symbol: hit.metadata.symbol} : {}),
    };
    registerForSession(sessionId, {kind: 'snippet', snippet: hit.snippet, ref});
  }
}

export interface OnDemandEchoReference {
  referenceId: string;
  codebaseId: string;
  filePath: string;
  lineRange?: {start: number; end: number};
  symbol?: string;
  text?: string;
}

/**
 * Registers provider-sent source returned by bounded on-demand tools. These
 * references do not have RAG chunk ids, so use their stable reference ids for
 * a relative CodeRef replacement instead of retaining source text in output.
 */
export function registerOnDemandSourceLookupForEcho(
  sessionId: string | undefined,
  references: readonly OnDemandEchoReference[],
): void {
  if (!sessionId) return;
  for (const reference of references) {
    if (!reference.text?.trim()) continue;
    registerForSession(sessionId, {
      kind: 'snippet',
      snippet: reference.text,
      ref: {
        chunkId: reference.referenceId,
        codebaseId: reference.codebaseId,
        filePath: reference.filePath,
        ...(reference.lineRange ? {lineRange: reference.lineRange} : {}),
      },
    });
  }
}

export function registerCodeAwareCanary(sessionId: string | undefined, canary: string): void {
  if (!sessionId || !canary) return;
  registerForSession(sessionId, {kind: 'canary', canary});
}

/**
 * A private analysis query may itself contain pasted source or wiki text.
 * Register its exact, line, and sliding-window forms before any provider
 * output is projected so a model cannot replay the pasted content verbatim.
 */
export function registerPrivateAnalysisQueryForEcho(
  sessionId: string | undefined,
  query: string,
): void {
  if (!sessionId || !query.trim()) return;
  registerForSession(sessionId, {
    kind: 'private',
    snippet: query,
    replacement: '[PRIVATE_QUERY_REFERENCE]',
  });
}

export function sanitizeCodeAwareText(sessionId: string | undefined, text: string): string {
  if (!sessionId || !text) return text;
  const guard = touchGuard(sessionId);
  if (!guard && sessionWasRevoked(sessionId)) return PRIVATE_OUTPUT_SUPPRESSED;
  return guard ? guard.projectComplete(text) : text;
}

function sanitizeStructuredTextValue(
  sessionId: string | undefined,
  value: unknown,
  state: {items: number; seen: WeakSet<object>},
  depth: number,
): unknown {
  if (depth > MAX_STRUCTURED_TEXT_DEPTH || state.items >= MAX_STRUCTURED_TEXT_ITEMS) {
    return undefined;
  }
  state.items += 1;
  if (typeof value === 'string') {
    if (
      value.length > MAX_STRUCTURED_TEXT_STRING_BYTES ||
      Buffer.byteLength(value, 'utf8') > MAX_STRUCTURED_TEXT_STRING_BYTES
    ) {
      return PRIVATE_OUTPUT_SUPPRESSED;
    }
    return sanitizeCodeAwareText(sessionId, value);
  }
  if (
    value === null ||
    value === undefined ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value !== 'object') return undefined;
  if (state.seen.has(value)) return undefined;
  if (!Array.isArray(value)) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
  }

  state.seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value
        .map(item => sanitizeStructuredTextValue(sessionId, item, state, depth + 1))
        .filter(item => item !== undefined);
    }

    const sanitized: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const projected = sanitizeStructuredTextValue(sessionId, entry, state, depth + 1);
      if (projected !== undefined) sanitized[key] = projected;
    }
    return sanitized;
  } finally {
    state.seen.delete(value);
  }
}

/**
 * Applies the session echo guard to every string in a model-authored value.
 * Traversal is bounded and cycle-safe; ordinary serializable values retain
 * their keys and byte-identical strings when no registered pattern matches.
 */
export function sanitizeCodeAwareStructuredText<T>(
  sessionId: string | undefined,
  value: T,
): T {
  return sanitizeStructuredTextValue(
    sessionId,
    value,
    {items: 0, seen: new WeakSet<object>()},
    0,
  ) as T;
}

export interface CodeAwareStreamingTextProjection {
  write(text: string): string;
  flush(): string;
  projectComplete(text: string): string;
}

/** Stateful per-channel projection that keeps cross-token matches private. */
export function createCodeAwareStreamingTextProjection(
  sessionId: string | undefined,
  channel: string,
): CodeAwareStreamingTextProjection {
  if (!sessionId) {
    return {write: text => text, flush: () => '', projectComplete: text => text};
  }
  const guard = touchGuard(sessionId);
  if (!guard && sessionWasRevoked(sessionId)) {
    return {
      write: () => '',
      flush: () => PRIVATE_OUTPUT_SUPPRESSED,
      projectComplete: () => PRIVATE_OUTPUT_SUPPRESSED,
    };
  }
  if (!guard) {
    return {write: text => text, flush: () => '', projectComplete: text => text};
  }
  return {
    write: text => guard.write(channel, text),
    flush: () => guard.flush(channel),
    projectComplete: text => guard.projectComplete(text),
  };
}

export function clearCodeAwareOutputGuards(sessionId: string): void {
  const guard = sessionGuards.get(sessionId);
  guard?.destroy();
  sessionGuards.delete(sessionId);
  revokedSessions.delete(sessionMarker(sessionId));
}

/**
 * Permanently fail closed for late output from a retired private session.
 * Unlike `clearCodeAwareOutputGuards`, this keeps a bounded TTL marker so an
 * asynchronous runtime callback cannot recreate an empty pass-through guard.
 */
export function revokeCodeAwareOutputGuards(sessionId: string): void {
  const guard = sessionGuards.get(sessionId);
  guard?.destroy();
  sessionGuards.delete(sessionId);
  markSessionRevoked(sessionId);
}

export function clearAllCodeAwareOutputGuards(): void {
  for (const guard of sessionGuards.values()) guard.destroy();
  sessionGuards.clear();
  revokedSessions.clear();
  failClosedUnknownUntil = 0;
}
