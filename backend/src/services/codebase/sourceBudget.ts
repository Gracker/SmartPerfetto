// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {loadSourceDepthPolicy, type SourceDepth, type SourceDepthPolicy} from './sourceDepthPolicy';

/** Delivered-token accounting for one pool: check before delivering, spend what was delivered. */
export interface TokenPool {
  left(): number;
  spend(tokens: number): void;
}

type SourceCallKind = 'search' | 'read';
type SourceCallStop = 'source_search_budget_exceeded' | 'source_read_budget_exceeded';

/** The token estimate every source and knowledge pool charges: four characters a token. */
export function estimateTextTokens(text: string): number {
  return text ? Math.max(1, Math.ceil(text.length / 4)) : 0;
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
  readonly tokensLeft: number;
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
  private searchesLeft: number;
  private readsLeft: number;

  constructor(depth: SourceDepth, policy: SourceDepthPolicy = loadSourceDepthPolicy()) {
    const limits = policy.depths[depth];
    this.searchesLeft = limits.searches;
    this.readsLeft = limits.reads;
    this.maxReadLines = limits.maxReadLines;
    this.sourceTokens = new CountedTokenPool(limits.tokens);
    this.knowledgeTokens = new CountedTokenPool(policy.knowledge.tokens);
  }

  /** Spends one call of this kind, or names the exhausted budget. */
  beginCall(kind: SourceCallKind): SourceCallStop | undefined {
    if (kind === 'search') {
      if (this.searchesLeft <= 0) return 'source_search_budget_exceeded';
      this.searchesLeft -= 1;
      return undefined;
    }
    if (this.readsLeft <= 0) return 'source_read_budget_exceeded';
    this.readsLeft -= 1;
    return undefined;
  }

  snapshot(): SourceBudgetSnapshot {
    return {searchesLeft: this.searchesLeft, readsLeft: this.readsLeft, tokensLeft: this.sourceTokens.left()};
  }
}
