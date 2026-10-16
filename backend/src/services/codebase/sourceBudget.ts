// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {loadSourceDepthPolicy, type SourceDepth, type SourceDepthPolicy} from './sourceDepthPolicy';

/** Delivered-token accounting for one pool: check before delivering, spend what was delivered. */
export interface TokenPool {
  left(): number;
  spend(tokens: number): void;
}

type SourceCallKind = 'search' | 'read' | 'locate';
const CALL_STOPS = {
  search: 'source_search_budget_exceeded',
  read: 'source_read_budget_exceeded',
  locate: 'source_locate_budget_exceeded',
} as const satisfies Record<SourceCallKind, string>;
type SourceCallStop = typeof CALL_STOPS[SourceCallKind];

type KnowledgeCallKind = 'search' | 'read';
const KNOWLEDGE_CALL_STOPS = {
  search: 'knowledge_search_budget_exceeded',
  read: 'knowledge_read_budget_exceeded',
} as const satisfies Record<KnowledgeCallKind, string>;
type KnowledgeCallStop = typeof KNOWLEDGE_CALL_STOPS[KnowledgeCallKind];

/** The token estimate every source and knowledge pool charges: four characters a token. */
export function estimateTextTokens(text: string): number {
  return text ? Math.max(1, Math.ceil(text.length / 4)) : 0;
}

/** The most characters that fit in `tokensLeft` beside `fixedChars` of framing, by the same estimate; never negative. */
export function charsWithin(tokensLeft: number, fixedChars = 0): number {
  return Math.max(0, tokensLeft * 4 - fixedChars);
}

/**
 * How many leading items fit in `left` tokens when delivered joined: items of
 * these character lengths, `separatorChars` between them, `fixedChars` around
 * them (a JSON array's brackets). One pass, whatever the item count.
 */
export function longestPrefixWithin(
  lengths: readonly number[],
  left: number,
  {separatorChars = 1, fixedChars = 0}: {separatorChars?: number; fixedChars?: number} = {},
): number {
  let chars = fixedChars;
  for (let count = 0; count < lengths.length; count += 1) {
    chars += lengths[count]! + (count > 0 ? separatorChars : 0);
    if (Math.max(1, Math.ceil(chars / 4)) > left) return count;
  }
  return lengths.length;
}

export interface SourceBudgetSnapshot {
  readonly searchesLeft: number;
  readonly readsLeft: number;
  readonly locatesLeft: number;
  readonly tokensLeft: number;
}

/** What the document-collection tools have left; every knowledge tool result reports it. */
export interface KnowledgeBudgetSnapshot {
  readonly searchesLeft: number;
  readonly readsLeft: number;
  readonly tokensLeft: number;
}

/** Call counts by kind: each begin spends one, or names the stop of the exhausted kind. */
class CallCounter<Kind extends string, Stop extends string> {
  private readonly left: Record<Kind, number>;

  constructor(limits: Readonly<Record<Kind, number>>, private readonly stops: Readonly<Record<Kind, Stop>>) {
    this.left = {...limits};
  }

  begin(kind: Kind): Stop | undefined {
    if (this.left[kind] <= 0) return this.stops[kind];
    this.left[kind] -= 1;
    return undefined;
  }

  remaining(kind: Kind): number {
    return this.left[kind];
  }
}

class CountedTokenPool implements TokenPool {
  constructor(private remaining: number) {}

  left(): number {
    return this.remaining;
  }

  spend(tokens: number): void {
    this.remaining = Math.max(0, this.remaining - Math.max(0, tokens));
  }
}

/**
 * One run's source budget, from the depth policy. It lives in memory with the
 * run's MCP server, so a new run starts full; retries within a run share it.
 * A call is counted when it reaches the source (failures are not refunded, so
 * a failing call cannot be repeated for free); tokens are spent for what was
 * actually delivered. Knowledge-base text draws on its own pool.
 */
export class SourceBudget {
  readonly maxReadLines: number;
  readonly sourceTokens: TokenPool;
  readonly knowledgeTokens: TokenPool;
  /** The most section text one knowledge read delivers. */
  readonly knowledgePartChars: number;
  private readonly sourceCalls: CallCounter<SourceCallKind, SourceCallStop>;
  private readonly knowledgeCalls: CallCounter<KnowledgeCallKind, KnowledgeCallStop>;

  constructor(depth: SourceDepth, policy: SourceDepthPolicy = loadSourceDepthPolicy()) {
    const limits = policy.depths[depth];
    this.sourceCalls = new CallCounter({search: limits.searches, read: limits.reads, locate: limits.locates}, CALL_STOPS);
    this.maxReadLines = limits.maxReadLines;
    this.sourceTokens = new CountedTokenPool(limits.tokens);
    this.knowledgeTokens = new CountedTokenPool(policy.knowledge.tokens);
    this.knowledgeCalls = new CallCounter({search: policy.knowledge.searches, read: policy.knowledge.reads},
      KNOWLEDGE_CALL_STOPS);
    this.knowledgePartChars = policy.knowledge.partChars;
  }

  /** Spends one call of this kind, or names the exhausted budget. */
  beginCall(kind: SourceCallKind): SourceCallStop | undefined {
    return this.sourceCalls.begin(kind);
  }

  /** The same for a document-collection search or section read; depth does not change these. */
  beginKnowledgeCall(kind: KnowledgeCallKind): KnowledgeCallStop | undefined {
    return this.knowledgeCalls.begin(kind);
  }

  knowledgeSnapshot(): KnowledgeBudgetSnapshot {
    return {searchesLeft: this.knowledgeCalls.remaining('search'), readsLeft: this.knowledgeCalls.remaining('read'),
      tokensLeft: this.knowledgeTokens.left()};
  }

  snapshot(): SourceBudgetSnapshot {
    return {searchesLeft: this.sourceCalls.remaining('search'), readsLeft: this.sourceCalls.remaining('read'),
      locatesLeft: this.sourceCalls.remaining('locate'), tokensLeft: this.sourceTokens.left()};
  }
}
