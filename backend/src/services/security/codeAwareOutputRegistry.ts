// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {createHash} from 'crypto';
import {isPlainJsonObject} from '../../utils/isPlainJsonObject';
import {FINAL_SEMANTIC_INPUT_BYTE_LIMIT} from '../finalSemanticLimits';

import type {SanitizedRagResult} from '../rag/lookupResponseFilter';
import {LLMEchoOutputStream, type CodeRef} from './llmEchoOutputFilter';
import {
  credentialContextForPath,
  credentialValues,
  endsInDanglingCredentialPrefix,
  isCredentialFieldValue,
  redactCredentialsInText,
  REDACTED_SECRET,
  TEXT_CREDENTIAL_CONTEXT,
} from './secretPatterns';

type GuardRegistration =
  | {kind: 'snippet'; snippet: string; ref: CodeRef}
  | {kind: 'private'; snippet: string; replacement: string}
  | {kind: 'query'; snippet: string; replacement: string}
  /** `values`: whole document names (title, headings, path) matched exactly, however short. */
  | {kind: 'knowledge'; snippet: string; replacement: string; values?: readonly string[]}
  | {kind: 'canary'; canary: string};

/**
 * What the owner sees of each kind; strict output replaces every kind. The
 * owner was authorized to read source, the query and knowledge text, so only
 * the credentials inside them are withheld. A new kind does not compile until
 * its owner view is chosen.
 */
const OWNER_VIEW = {
  snippet: 'credentials_withheld',
  query: 'credentials_withheld',
  knowledge: 'credentials_withheld',
  private: 'withheld',
  canary: 'withheld',
} as const satisfies Record<GuardRegistration['kind'], 'credentials_withheld' | 'withheld'>;

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
const DANGEROUS_STRUCTURED_TEXT_KEYS = new Set([
  '__proto__',
  'prototype',
  'constructor',
]);
const STRUCTURED_TEXT_VALUE_DROPPED = Symbol('structured-text-value-dropped');

/** Internal only: never attach this receipt or its input hash to public output. */
export interface CodeAwareTextProjectionReceipt {
  readonly text: string;
  readonly disposition: 'preserved' | 'redacted' | 'replaced';
  readonly inputFingerprint: string;
  readonly outputFingerprint: string;
}

const issuedProjectionReceipts = new WeakSet<object>();

function textFingerprint(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function issueProjectionReceipt(
  receipt: CodeAwareTextProjectionReceipt,
): CodeAwareTextProjectionReceipt {
  const issued = Object.freeze(receipt);
  issuedProjectionReceipts.add(issued);
  return issued;
}

function textProjectionReceipt(
  input: string,
  text: string,
  replaced = false,
): CodeAwareTextProjectionReceipt {
  return issueProjectionReceipt({text, disposition: replaced ? 'replaced' : text === input ? 'preserved' : 'redacted',
    inputFingerprint: textFingerprint(input), outputFingerprint: textFingerprint(text)});
}

export function isIssuedCodeAwareTextProjectionReceipt(value: unknown): value is CodeAwareTextProjectionReceipt {
  return typeof value === 'object' && value !== null && issuedProjectionReceipts.has(value);
}

/** Only a contiguous chain of runtime-issued receipts can carry earlier replacement. */
export function composeCodeAwareTextProjectionReceipts(
  prior: CodeAwareTextProjectionReceipt | undefined,
  current: CodeAwareTextProjectionReceipt,
): CodeAwareTextProjectionReceipt {
  if (!isIssuedCodeAwareTextProjectionReceipt(current)) throw new Error('Unissued text projection receipt');
  if (!isIssuedCodeAwareTextProjectionReceipt(prior) || prior.outputFingerprint !== current.inputFingerprint) return current;
  return issueProjectionReceipt({
    text: current.text,
    inputFingerprint: prior.inputFingerprint,
    outputFingerprint: current.outputFingerprint,
    disposition: prior.disposition === 'replaced' || current.disposition === 'replaced' ? 'replaced' :
      prior.disposition === 'redacted' || current.disposition === 'redacted' ? 'redacted' : 'preserved',
  });
}

/** A channel write or flush, and whether that channel's output so far differs from its input. */
interface GuardedOutput {
  text: string;
  altered: boolean;
}

class SessionCodeAwareOutputGuard {
  private readonly registrations: GuardRegistration[] = [];
  private readonly registered = new Set<string>();
  private readonly streams = new Map<string, LLMEchoOutputStream>();
  private registrationBytes = 0;
  private overflowed = false;
  private version = 0;

  /** Changes whenever the registered set does; text released earlier was not projected against it. */
  get registrationVersion(): number { return this.version; }

  /** A repeat (every history read registers its questions again) spends no capacity and changes nothing. */
  register(registration: GuardRegistration): 'applied' | 'repeat' | 'unavailable' {
    if (this.overflowed) return 'unavailable';
    const key = textFingerprint(JSON.stringify(registration));
    if (this.registered.has(key)) return 'repeat';
    this.version++;
    const pattern = registration.kind === 'snippet'
      ? registration.snippet
      : 'replacement' in registration
        ? [registration.snippet, ...('values' in registration ? registration.values ?? [] : []),
          registration.replacement].join('\0')
        : registration.canary;
    const patternBytes = Buffer.byteLength(pattern, 'utf8');
    if (
      this.registrations.length >= MAX_GUARD_REGISTRATIONS ||
      this.registrationBytes + patternBytes > MAX_GUARD_PATTERN_BYTES
    ) {
      this.overflowed = true;
      this.registrationBytes = 0;
      this.registrations.length = 0;
      this.registered.clear();
      for (const stream of this.streams.values()) stream.destroy();
      this.streams.clear();
      return 'unavailable';
    }
    this.registered.add(key);
    this.registrations.push(registration);
    this.registrationBytes += patternBytes;
    for (const stream of this.streams.values()) this.apply(stream, registration);
    return 'applied';
  }

  projectComplete(text: string): string {
    return this.projectCompleteOutcome(text).text;
  }

  projectCompleteWithReceipt(text: string): CodeAwareTextProjectionReceipt {
    const projected = this.projectCompleteOutcome(text);
    return textProjectionReceipt(text, projected.text, projected.replaced);
  }

  projectProtocolLiteral(text: string): string {
    if (this.overflowed) return PRIVATE_OUTPUT_SUPPRESSED;
    const stream = new LLMEchoOutputStream();
    try {
      for (const registration of this.registrations) {
        if (registration.kind !== 'snippet') this.apply(stream, registration);
      }
      return stream.write(text) + stream.flush();
    } finally { stream.destroy(); }
  }

  private projectCompleteOutcome(text: string): {text: string; replaced: boolean} {
    if (this.overflowed) return {text: PRIVATE_OUTPUT_SUPPRESSED, replaced: true};
    const stream = this.createStream();
    try {
      const projected = stream.write(text) + stream.flush();
      return {text: projected, replaced: stream.outputSuppressed};
    } finally {
      stream.destroy();
    }
  }

  write(channel: string, text: string): GuardedOutput {
    if (this.overflowed) return {text: '', altered: true};
    let stream = this.streams.get(channel);
    if (!stream) {
      stream = this.createStream();
      this.streams.set(channel, stream);
    }
    return {text: stream.write(text), altered: stream.altered};
  }

  flush(channel: string): GuardedOutput {
    if (this.overflowed) return {text: PRIVATE_OUTPUT_SUPPRESSED, altered: true};
    const stream = this.streams.get(channel);
    if (!stream) return {text: '', altered: false};
    this.streams.delete(channel);
    try {
      const text = stream.flush();
      return {text, altered: stream.altered};
    } finally {
      stream.destroy();
    }
  }

  destroy(): void {
    for (const stream of this.streams.values()) stream.destroy();
    this.streams.clear();
    this.registrations.length = 0;
    this.registered.clear();
    this.registrationBytes = 0;
    // Projections may still hold this guard after registry eviction. Keep the
    // detached object irreversibly fail-closed instead of turning it into an
    // empty pass-through guard.
    this.overflowed = true;
  }

  get patternBytes(): number {
    return this.registrationBytes;
  }

  get unavailable(): boolean { return this.overflowed; }

  private createStream(): LLMEchoOutputStream {
    const stream = new LLMEchoOutputStream();
    for (const registration of this.registrations) this.apply(stream, registration);
    return stream;
  }

  private apply(stream: LLMEchoOutputStream, registration: GuardRegistration): void {
    if (registration.kind === 'snippet') {
      stream.registerSnippet(registration.snippet, registration.ref);
    } else if ('replacement' in registration) {
      if (registration.snippet.trim()) stream.registerPrivateSnippet(registration.snippet, registration.replacement);
      if ('values' in registration && registration.values?.length) {
        stream.registerPrivateValues(registration.values, registration.replacement);
      }
    } else {
      stream.registerCanary(registration.canary);
    }
  }
}

export type CodeAwareOutputAudience = 'strict' | 'owner';
let projectionAudience: CodeAwareOutputAudience = 'strict';

/** Pure synchronous projection only. Never span provider calls, logging, or awaits. */
export function withOwnerCodeAwareProjection<T>(project: () => T): T {
  const previous = projectionAudience;
  projectionAudience = 'owner';
  try {
    const result = project();
    if (result && typeof (result as {then?: unknown}).then === 'function') {
      throw new TypeError('Owner projection must be synchronous');
    }
    return result;
  } finally { projectionAudience = previous; }
}

export function isOwnerCodeAwareProjection(): boolean { return projectionAudience === 'owner'; }

class SessionOutputGuards {
  readonly strict = new SessionCodeAwareOutputGuard();
  readonly owner = new SessionCodeAwareOutputGuard();
  /** False for a repeat, which strict holds only because both audiences already applied it. */
  register(registration: GuardRegistration): boolean {
    if (this.strict.register(registration) === 'repeat') return false;
    if (OWNER_VIEW[registration.kind] === 'credentials_withheld' && 'snippet' in registration) {
      // Source is read in its file's syntax; query and knowledge text as prose.
      const context = registration.kind === 'snippet'
        ? credentialContextForPath(registration.ref.filePath)
        : TEXT_CREDENTIAL_CONTEXT;
      const texts = [registration.snippet, ...('values' in registration ? registration.values ?? [] : [])];
      for (const credential of texts.flatMap(text => credentialValues(text, context))) {
        this.owner.register({kind: 'private', snippet: credential, replacement: REDACTED_SECRET});
      }
    } else { this.owner.register(registration); }
    return true;
  }
  get patternBytes(): number { return this.strict.patternBytes + this.owner.patternBytes; }
  destroy(): void { this.strict.destroy(); this.owner.destroy(); }
}

const sessionGuards = new Map<string, SessionOutputGuards>();
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

function touchGuard(sessionId: string): SessionOutputGuards | undefined {
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

function aggregateGuardPatternBytes(audience: CodeAwareOutputAudience): number {
  let total = 0;
  for (const guards of sessionGuards.values()) total += guards[audience].patternBytes;
  return total;
}

function enforceRegistryLimits(currentSessionId: string): void {
  while (sessionGuards.size > MAX_SESSION_GUARDS) {
    if (!evictLeastRecentlyUsedGuard(currentSessionId)) break;
  }
  for (const audience of ['strict', 'owner'] as const) {
    for (const guards of sessionGuards.values()) {
      if (aggregateGuardPatternBytes(audience) <= MAX_AGGREGATE_GUARD_PATTERN_BYTES) break;
      guards[audience].destroy();
    }
  }
}

function guardFor(sessionId: string): SessionOutputGuards | undefined {
  if (sessionWasRevoked(sessionId)) return undefined;
  let guard = touchGuard(sessionId);
  if (!guard) {
    guard = new SessionOutputGuards();
    sessionGuards.set(sessionId, guard);
    enforceRegistryLimits(sessionId);
    guard = touchGuard(sessionId);
  }
  return guard;
}

function registerForSession(sessionId: string, registration: GuardRegistration): void {
  if (guardFor(sessionId)?.register(registration)) enforceRegistryLimits(sessionId);
}

export function registerCodeAwareLookupForEcho(sessionId: string | undefined, result: SanitizedRagResult): void {
  if (!sessionId) return;
  for (const hit of result.hits) {
    if (!hit.snippet) continue;
    if (hit.metadata?.knowledgeSourceId) {
      registerForSession(sessionId, {
        kind: 'knowledge',
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
  /** The issued reference id the model cites; the CodeRef label shows it. */
  id: string;
  codebaseId: string;
  filePath: string;
  lineRange?: {start: number; end: number};
  symbol?: string;
  text?: string;
}

/**
 * Registers provider-sent source returned by bounded on-demand tools. These
 * references do not have RAG chunk ids, so use their issued reference ids for
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
        chunkId: reference.id,
        codebaseId: reference.codebaseId,
        filePath: reference.filePath,
        ...(reference.lineRange ? {lineRange: reference.lineRange} : {}),
      },
    });
  }
}

/** One delivered document-collection item: the text and the document's own names for it. */
export interface KnowledgeEchoItem {
  knowledgeBaseId: string;
  /** The issued `kref-` reference the model cites; the replacement names it. */
  referenceId: string;
  title: string;
  headingPath: readonly string[];
  relativePath: string;
  text: string;
}

/**
 * The shortest document name registered as a whole value, in code points. One
 * character names nothing of the document yet matches nearly any output; two
 * is a whole CJK word (a title such as 渲染), so nothing shorter is protected.
 */
const MIN_KNOWLEDGE_NAME_CODE_POINTS = 2;

/** A document's own names as the model may repeat them: title, each heading, the heading path, the path and its file name. */
function knowledgeNames(item: KnowledgeEchoItem): string[] {
  const headings = item.headingPath.map(heading => heading.trim()).filter(Boolean);
  const fileName = item.relativePath.split('/').pop() ?? '';
  return [...new Set([item.title, ...headings, headings.join(' › '), headings.join(' > '), item.relativePath, fileName]
    .map(name => name.trim())
    .filter(name => [...name].length >= MIN_KNOWLEDGE_NAME_CODE_POINTS))];
}

/**
 * Registers what a document-collection tool delivered, one registration per
 * item so a run stays inside the session's registration cap. The text gets
 * the derived windows every snippet gets; the document's names (title,
 * headings, relative path) are matched as whole values, since the derived
 * windows index nothing shorter than eight characters. A `kb:path#Lx`
 * citation is one text unit with the path inside it, so it is replaced whole.
 * Strict output replaces all of it; the owner view withholds only credentials.
 */
export function registerKnowledgeTextForEcho(sessionId: string | undefined, items: readonly KnowledgeEchoItem[]): void {
  if (!sessionId) return;
  for (const item of items) {
    const values = knowledgeNames(item);
    if (!item.text.trim() && values.length === 0) continue;
    registerForSession(sessionId, {
      kind: 'knowledge',
      snippet: item.text,
      replacement: `[Knowledge: ${item.knowledgeBaseId}/${item.referenceId}]`,
      values,
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
    kind: 'query',
    snippet: query,
    replacement: '[PRIVATE_QUERY_REFERENCE]',
  });
}

/** Owner projection withholds the credentials it finds in any text; other audiences leave text alone here. */
function ownerCredentialPass(text: string): string {
  return isOwnerCodeAwareProjection() ? redactCredentialsInText(text) : text;
}

export function sanitizeCodeAwareText(sessionId: string | undefined, text: string): string {
  if (!text) return text;
  if (!sessionId) return ownerCredentialPass(text);
  const guard = touchGuard(sessionId)?.[projectionAudience];
  if (!guard && sessionWasRevoked(sessionId)) return PRIVATE_OUTPUT_SUPPRESSED;
  const projected = guard ? guard.projectComplete(text) : text;
  return ownerCredentialPass(projected);
}

export function sanitizeCodeAwareTextWithReceipt(
  sessionId: string | undefined,
  text: string,
): CodeAwareTextProjectionReceipt {
  if (!sessionId || !text) return textProjectionReceipt(text, ownerCredentialPass(text));
  const guard = touchGuard(sessionId)?.[projectionAudience];
  if (!guard && sessionWasRevoked(sessionId)) return textProjectionReceipt(text, PRIVATE_OUTPUT_SUPPRESSED, true);
  const receipt = guard ? guard.projectCompleteWithReceipt(text) : textProjectionReceipt(text, text);
  return isOwnerCodeAwareProjection() ? composeCodeAwareTextProjectionReceipts(receipt, textProjectionReceipt(receipt.text, redactCredentialsInText(receipt.text))) : receipt;
}

/** Same per-string limit and empty-string behavior as structured projection. */
export function sanitizeCodeAwareStructuredTextWithReceipt(
  sessionId: string | undefined,
  text: string,
): CodeAwareTextProjectionReceipt {
  if (text.length > MAX_STRUCTURED_TEXT_STRING_BYTES ||
    Buffer.byteLength(text, 'utf8') > MAX_STRUCTURED_TEXT_STRING_BYTES) {
    return textProjectionReceipt(text, PRIVATE_OUTPUT_SUPPRESSED, true);
  }
  return sanitizeCodeAwareTextWithReceipt(sessionId, text);
}

/** Only validated, product-defined protocol literals may use this narrower role. */
export function projectCodeAwareProtocolLiteral(sessionId: string | undefined, literal: string): string {
  if (!sessionId) return literal;
  const guard = touchGuard(sessionId)?.[projectionAudience];
  if (!guard && sessionWasRevoked(sessionId)) return PRIVATE_OUTPUT_SUPPRESSED;
  return guard ? guard.projectProtocolLiteral(literal) : literal;
}

/** Input-role text from issued current reads or exact-bound native declarations; never arbitrary model text. */
export const projectCodeAwareAuthorizedInputText = projectCodeAwareProtocolLiteral;

/** Issues a complete text mapping after a bounded, field-aware security projection. */
export function issueCodeAwareStructuredProjectionReceipt(input: string, text: string, replaced = false): CodeAwareTextProjectionReceipt {
  return textProjectionReceipt(input, text, replaced);
}

function sanitizeStructuredTextValue(
  sessionId: string | undefined,
  value: unknown,
  state: {items: number; maxItems: number; seen: WeakSet<object>; changed: boolean; limited: boolean},
  depth: number,
): unknown | typeof STRUCTURED_TEXT_VALUE_DROPPED {
  if (depth > MAX_STRUCTURED_TEXT_DEPTH || state.items >= state.maxItems) {
    state.changed = true;
    state.limited = true;
    return STRUCTURED_TEXT_VALUE_DROPPED;
  }
  state.items += 1;
  if (typeof value === 'string') {
    if (
      value.length > MAX_STRUCTURED_TEXT_STRING_BYTES ||
      Buffer.byteLength(value, 'utf8') > MAX_STRUCTURED_TEXT_STRING_BYTES
    ) {
      state.changed = true;
      state.limited = true;
      return PRIVATE_OUTPUT_SUPPRESSED;
    }
    const projected = sanitizeCodeAwareText(sessionId, value);
    if (projected !== value) state.changed = true;
    return projected;
  }
  if (
    value === null ||
    value === undefined ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value !== 'object' || state.seen.has(value)) {
    state.changed = true;
    return STRUCTURED_TEXT_VALUE_DROPPED;
  }
  const isArray = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (!isArray && !isPlainJsonObject(value)) {
    state.changed = true;
    return STRUCTURED_TEXT_VALUE_DROPPED;
  }

  state.seen.add(value);
  try {
    const sanitized: Record<PropertyKey, unknown> | unknown[] = isArray
      ? []
      : Object.create(prototype);
    for (const key of Reflect.ownKeys(value)) {
      if (state.items >= state.maxItems) {
        state.changed = true;
        state.limited = true;
        break;
      }
      if (isArray && key === 'length') continue;
      state.items += 1;
      if (
        typeof key !== 'string' ||
        DANGEROUS_STRUCTURED_TEXT_KEYS.has(key)
      ) {
        state.changed = true;
        continue;
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        if (descriptor?.enumerable) state.changed = true;
        continue;
      }
      const credential = isOwnerCodeAwareProjection() && isCredentialField(key, descriptor.value);
      if (credential && descriptor.value !== REDACTED_SECRET) state.changed = true;
      const projected = sanitizeStructuredTextValue(
        sessionId,
        credential ? REDACTED_SECRET : descriptor.value,
        state,
        depth + 1,
      );
      if (projected === STRUCTURED_TEXT_VALUE_DROPPED) continue;
      Object.defineProperty(sanitized, key, {
        value: projected,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    if (isArray) {
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
      if (
        lengthDescriptor &&
        Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value') &&
        typeof lengthDescriptor.value === 'number'
      ) {
        if (lengthDescriptor.value > state.maxItems) {state.changed = true; state.limited = true;}
        Object.defineProperty(sanitized, 'length', {
          value: Math.min(lengthDescriptor.value, state.maxItems),
          enumerable: false,
          configurable: false,
          writable: true,
        });
      }
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
  return projectCodeAwareStructuredText(sessionId, value).value;
}

/** Internal change receipt; detects bounded drops without reading object accessors. */
export function projectCodeAwareStructuredText<T>(
  sessionId: string | undefined,
  value: T,
): {value: T; changed: boolean} {
  const {value: projected, changed} = projectStructuredText(sessionId, value, MAX_STRUCTURED_TEXT_ITEMS);
  return {value: projected, changed};
}

/** Semantic input retains its existing byte budget; ordinary output limits stay unchanged. */
export function projectCodeAwareSemanticInputStructure<T>(sessionId: string | undefined, value: T):
  {value: T; changed: boolean; limited: boolean} {
  return projectStructuredText(sessionId, value, FINAL_SEMANTIC_INPUT_BYTE_LIMIT);
}

function projectStructuredText<T>(sessionId: string | undefined, value: T, maxItems: number):
  {value: T; changed: boolean; limited: boolean} {
  const state = {items: 0, maxItems, seen: new WeakSet<object>(), changed: false, limited: false};
  const sanitized = sanitizeStructuredTextValue(
    sessionId,
    value,
    state,
    0,
  );
  return {value: (sanitized === STRUCTURED_TEXT_VALUE_DROPPED ? undefined : sanitized) as T,
    changed: state.changed, limited: state.limited};
}

export interface CodeAwareStreamingTextProjection {
  write(text: string): string;
  flush(): string;
  projectComplete(text: string): string;
  projectCompleteWithReceipt(text: string): CodeAwareTextProjectionReceipt;
  /**
   * Streamed output so far may differ from what projecting the whole text
   * shows: content was redacted or dropped, the guard became unavailable, or
   * registrations changed after the current stretch (since the last flush)
   * received text, which may still be held unprojected against them.
   * Conservative, and sticky for the projection's life.
   */
  readonly altered: boolean;
}

/** Stateful per-channel projection that keeps cross-token matches private. */
export function createCodeAwareStreamingTextProjection(
  sessionId: string | undefined,
  channel: string,
  audience: CodeAwareOutputAudience = projectionAudience,
): CodeAwareStreamingTextProjection {
  // Capture audience and guard once. A later scope or guard registration cannot
  // convert a retired stream into an unguarded stream.
  const guard = sessionId ? (touchGuard(sessionId) ?? guardFor(sessionId))?.[audience] : undefined;
  const unavailable = () => guard?.unavailable || Boolean(sessionId && sessionWasRevoked(sessionId));
  const credentials = new OwnerCredentialStream();
  let altered = false;
  let stretchVersion: number | undefined;
  const settle = (guarded: GuardedOutput, output: string): string => {
    if (guarded.altered || credentials.altered) altered = true;
    if (stretchVersion !== undefined && guard?.registrationVersion !== stretchVersion) altered = true;
    return output;
  };
  const project = (text: string): CodeAwareTextProjectionReceipt => {
    if (unavailable()) return textProjectionReceipt(text, PRIVATE_OUTPUT_SUPPRESSED, true);
    const receipt = guard ? guard.projectCompleteWithReceipt(text) : textProjectionReceipt(text, text);
    return audience === 'owner' ? composeCodeAwareTextProjectionReceipts(receipt,
      textProjectionReceipt(receipt.text, redactCredentialsInText(receipt.text))) : receipt;
  };
  return {
    write: text => {
      if (unavailable()) { credentials.clear(); altered = true; return ''; }
      if (text && stretchVersion === undefined) stretchVersion = guard?.registrationVersion;
      const guarded = guard ? guard.write(channel, text) : {text, altered: false};
      return settle(guarded, audience === 'owner' ? credentials.write(guarded.text) : guarded.text);
    },
    flush: () => {
      if (unavailable()) { credentials.clear(); altered = true; return PRIVATE_OUTPUT_SUPPRESSED; }
      const guarded = guard?.flush(channel) ?? {text: '', altered: false};
      const output = settle(guarded,
        audience === 'owner' ? credentials.write(guarded.text) + credentials.flush() : guarded.text);
      stretchVersion = undefined;
      return output;
    },
    projectComplete: text => project(text).text,
    projectCompleteWithReceipt: project,
    get altered() { return altered; },
  };
}

/** Held text is only ever appended to or dropped whole, so a UTF-16 count cannot split a character. */
const MAX_OWNER_CREDENTIAL_HOLD_CHARS = 64 * 1024;

/**
 * Credentials may cross provider token boundaries, and a key may sit lines
 * above its value. Hold text until its lines are complete and it does not end
 * in a credential key, separator or Bearer prefix, then redact it as a whole.
 */
class OwnerCredentialStream {
  private pending = '';
  private discardingLine = false;
  /** Output so far differs from its input: a credential was redacted or oversized text dropped. */
  altered = false;
  write(text: string): string {
    let output = '';
    for (const fragment of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
      const complete = fragment.endsWith('\n');
      if (!this.discardingLine) {
        this.pending += fragment;
        if (this.pending.length > MAX_OWNER_CREDENTIAL_HOLD_CHARS) {
          output += '[OVERSIZED_OUTPUT_LINE]';
          this.pending = '';
          this.discardingLine = true;
          this.altered = true;
        } else if (complete && !endsInDanglingCredentialPrefix(this.pending)) {
          output += this.release();
        }
      }
      if (complete && this.discardingLine) { this.discardingLine = false; output += '\n'; }
    }
    return output;
  }
  flush(): string { const output = this.release(); this.clear(); return output; }
  clear(): void { this.pending = ''; this.discardingLine = false; }
  private release(): string {
    const output = redactCredentialsInText(this.pending);
    if (output !== this.pending) this.altered = true;
    this.pending = '';
    return output;
  }
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


export function sanitizeOwnerCodeAwareText(sessionId: string | undefined, text: string): string {
  return withOwnerCodeAwareProjection(() => sanitizeCodeAwareText(sessionId, text));
}

export function sanitizeOwnerCodeAwareStructuredTextWithReceipt(
  ...args: Parameters<typeof sanitizeCodeAwareStructuredTextWithReceipt>
): CodeAwareTextProjectionReceipt {
  return withOwnerCodeAwareProjection(() => sanitizeCodeAwareStructuredTextWithReceipt(...args));
}


const CREDENTIAL_FIELD_NAMES = /^(?:apikey|secret|password|token|accesstoken|authtoken|authorization)$/;

/**
 * Whether a structured field's value is withheld as a credential: a string of
 * at least eight characters in a field these names list, or one the text
 * detector withholds for its field name (`isCredentialFieldValue`). Shorter
 * values stay, so an enum a projection keeps is never broken. A draft's
 * answer text also sits in `token`; the owner streaming projection handles
 * that field before any structured walk.
 */
export function isCredentialField(key: string, value: unknown): boolean {
  return typeof value === 'string' && value.length >= 8 &&
    (CREDENTIAL_FIELD_NAMES.test(key.replace(/[_-]/g, '').toLowerCase()) || isCredentialFieldValue(key, value));
}
