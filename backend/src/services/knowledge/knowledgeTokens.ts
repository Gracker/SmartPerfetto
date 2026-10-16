// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * The one tokenizer of the knowledge FTS indexes (the built-in knowledge
 * pack and registered document collections). SQLite's `unicode61` keeps a run
 * of Han characters as one token and an identifier such as
 * `XRenderCompositorWorker` as one lowercase word, so neither a two-character
 * Chinese term nor one camelCase part could match on its own. Both sides
 * therefore index and query these application tokens: the whole word, its
 * `_ . $ : / -` and camelCase parts, Latin runs inside mixed-script words, and
 * Han bigrams.
 */

const MAX_QUERY_LENGTH = 1_000;
const MAX_QUERY_TOKENS = 64;

function addTokens(normalized: string, tokens: Set<string>): void {
  for (const match of normalized.matchAll(/[\p{L}\p{N}_.$:/-]+/gu)) {
    const raw = match[0].toLowerCase();
    if (!raw) continue;
    tokens.add(raw);
    for (const part of raw.split(/[_.$:/-]+/u)) {
      if (part) tokens.add(part);
    }
    const camelParts = match[0]
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .split(/\s+/u)
      .map(part => part.toLowerCase())
      .filter(Boolean);
    for (const part of camelParts) tokens.add(part);
  }
  for (const latin of normalized.match(/[\p{Script=Latin}\p{N}_.$:/-]+/gu) ?? []) {
    const raw = latin.toLowerCase();
    tokens.add(raw);
    for (const part of raw.split(/[_.$:/-]+/u)) {
      if (part) tokens.add(part);
    }
  }
  for (const sequence of normalized.match(/\p{Script=Han}+/gu) ?? []) {
    if (sequence.length === 1) tokens.add(sequence);
    for (let index = 0; index < sequence.length - 1; index += 1) {
      tokens.add(sequence.slice(index, index + 2));
    }
  }
}

/** A query as both stores search and report it: NFKC, trimmed, bounded. */
export function normalizeKnowledgeQuery(query: string): string {
  return query.normalize('NFKC').trim().slice(0, MAX_QUERY_LENGTH);
}

/** Distinct query tokens, bounded in input length and count. */
export function knowledgeQueryTokens(query: string): string[] {
  const normalized = normalizeKnowledgeQuery(query);
  if (!normalized) return [];
  const tokens = new Set<string>();
  addTokens(normalized, tokens);
  return Array.from(tokens).slice(0, MAX_QUERY_TOKENS);
}

/**
 * The FTS5 MATCH expression for query tokens: each quoted, OR-joined. A token
 * without a letter or digit (`-`, `/`, `_.$`) is dropped: `unicode61` reads
 * it as an empty phrase, which matches no row and leaves every rank as it was.
 * Undefined when nothing remains.
 */
export function knowledgeFtsMatchExpression(tokens: readonly string[]): string | undefined {
  const phrases = tokens
    .filter(token => /[\p{L}\p{N}]/u.test(token))
    .map(token => `"${token.replace(/"/g, '""')}"`);
  return phrases.length > 0 ? phrases.join(' OR ') : undefined;
}

/**
 * bm25 over the knowledge FTS columns title, heading, path, body and tokens:
 * a title match counts most, the body least, and the application tokens
 * (identifier parts, Han bigrams) between. `unindexedLeadingColumns` columns
 * before them (the pack's `chunk_id`) weigh nothing.
 */
export function knowledgeBm25(table: string, unindexedLeadingColumns = 0): string {
  const weights = [...Array<string>(unindexedLeadingColumns).fill('0.0'), '8.0', '5.0', '3.0', '1.0', '2.0'];
  return `bm25(${table}, ${weights.join(', ')})`;
}

/** The distinct tokens of indexed text, space separated, for an FTS `tokens` column. */
export function knowledgeIndexTokenText(text: string): string {
  const tokens = new Set<string>();
  addTokens(text.normalize('NFKC'), tokens);
  return Array.from(tokens).join(' ');
}
