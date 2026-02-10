/**
 * Strategy Registry
 *
 * Manages the collection of available analysis strategies and provides
 * query-based matching to select the appropriate strategy.
 *
 * v2.0: Enhanced with LLM-driven semantic matching alongside keyword triggers.
 * The registry now supports both:
 * 1. Fast keyword-based matching (legacy, for deterministic triggers)
 * 2. LLM semantic matching (for understanding variant expressions)
 */

import { StagedAnalysisStrategy } from './types';
import { scrollingStrategy } from './scrollingStrategy';
import { startupStrategy } from './startupStrategy';
import { sceneReconstructionQuickStrategy, sceneReconstructionStrategy } from './sceneReconstructionStrategy';
import {
  LLMStrategySelector,
  StrategyDefinition,
  StrategySelectionResult,
  TraceContext,
  strategyToDefinition,
  createLLMStrategySelector,
} from '../core/strategySelector';
import type { ModelRouter } from '../core/modelRouter';
import type { Intent } from '../types';

// =============================================================================
// Strategy Match Result
// =============================================================================

/**
 * Result of strategy matching with additional metadata.
 */
export interface StrategyMatchResult {
  /** Matched strategy (null if no match) */
  strategy: StagedAnalysisStrategy | null;
  /** How the strategy was matched */
  matchMethod: 'keyword' | 'llm' | 'none';
  /** Confidence of the match (1.0 for keyword, 0-1 for LLM) */
  confidence: number;
  /** LLM reasoning if LLM was used */
  reasoning?: string;
  /** Whether to fall back to hypothesis-driven analysis */
  shouldFallback: boolean;
  /** Reason for fallback if applicable */
  fallbackReason?: string;
}

// =============================================================================
// Strategy Registry
// =============================================================================

/**
 * Registry that holds all available staged analysis strategies.
 *
 * Matching modes:
 * - Keyword-first: Try keyword triggers, fall back to LLM if no match
 * - LLM-only: Skip keywords, always use LLM semantic understanding
 * - Keyword-only: Only use keyword triggers (legacy mode)
 */
export class StrategyRegistry {
  private strategies: StagedAnalysisStrategy[] = [];
  private llmSelector: LLMStrategySelector | null = null;
  private matchMode: 'keyword_first' | 'llm_only' | 'keyword_only' = 'keyword_first';

  /**
   * Register a new strategy. Strategies are matched in registration order,
   * so register more specific strategies before general ones.
   */
  register(strategy: StagedAnalysisStrategy): void {
    this.strategies.push(strategy);
  }

  /**
   * Set the LLM selector for semantic matching.
   */
  setLLMSelector(selector: LLMStrategySelector): void {
    this.llmSelector = selector;
  }

  /**
   * Set the match mode.
   */
  setMatchMode(mode: 'keyword_first' | 'llm_only' | 'keyword_only'): void {
    this.matchMode = mode;
  }

  /**
   * Find the first strategy whose trigger matches the given query.
   * Returns null if no strategy matches (analysis falls through to generic path).
   *
   * This is the legacy synchronous method that only uses keyword matching.
   */
  match(query: string): StagedAnalysisStrategy | null {
    for (const strategy of this.strategies) {
      if (strategy.trigger(query)) {
        return strategy;
      }
    }
    return null;
  }

  /**
   * Enhanced matching with optional LLM semantic understanding.
   *
   * @param query - User's natural language query
   * @param intent - Parsed intent (if available)
   * @param traceContext - Trace metadata (for LLM context)
   * @returns Match result with strategy and metadata
   */
  async matchEnhanced(
    query: string,
    intent?: Intent,
    traceContext?: TraceContext
  ): Promise<StrategyMatchResult> {
    // Mode 1: Keyword-only (legacy)
    if (this.matchMode === 'keyword_only') {
      return this.matchKeywordOnly(query);
    }

    // Mode 2: LLM-only
    if (this.matchMode === 'llm_only' && this.llmSelector && intent && traceContext) {
      return this.matchLLMOnly(query, intent, traceContext);
    }

    // Mode 3: Keyword-first, fall back to LLM
    // Try keyword match first
    const keywordMatch = this.match(query);
    if (keywordMatch) {
      return {
        strategy: keywordMatch,
        matchMethod: 'keyword',
        confidence: 1.0,
        shouldFallback: false,
      };
    }

    // No keyword match - try LLM if available
    if (this.llmSelector && intent && traceContext) {
      return this.matchWithLLM(query, intent, traceContext);
    }

    // No match
    return {
      strategy: null,
      matchMethod: 'none',
      confidence: 0,
      shouldFallback: true,
      fallbackReason: '没有匹配的分析策略（关键词未匹配，LLM 不可用）',
    };
  }

  /**
   * Keyword-only matching (legacy mode).
   */
  private matchKeywordOnly(query: string): StrategyMatchResult {
    const strategy = this.match(query);
    if (strategy) {
      return {
        strategy,
        matchMethod: 'keyword',
        confidence: 1.0,
        shouldFallback: false,
      };
    }
    return {
      strategy: null,
      matchMethod: 'none',
      confidence: 0,
      shouldFallback: true,
      fallbackReason: '没有匹配的分析策略',
    };
  }

  /**
   * LLM-only matching (semantic understanding).
   */
  private async matchLLMOnly(
    query: string,
    intent: Intent,
    traceContext: TraceContext
  ): Promise<StrategyMatchResult> {
    return this.matchWithLLM(query, intent, traceContext);
  }

  /**
   * Match using LLM semantic understanding.
   */
  private async matchWithLLM(
    query: string,
    intent: Intent,
    traceContext: TraceContext
  ): Promise<StrategyMatchResult> {
    if (!this.llmSelector) {
      return {
        strategy: null,
        matchMethod: 'none',
        confidence: 0,
        shouldFallback: true,
        fallbackReason: 'LLM 选择器未配置',
      };
    }

    try {
      // Convert strategies to definitions for LLM
      const definitions = this.strategies.map(strategyToDefinition);

      // Call LLM selector
      const result = await this.llmSelector.selectStrategy(
        query,
        intent,
        definitions,
        traceContext
      );

      return this.processLLMResult(result);
    } catch (error: any) {
      console.warn(`[StrategyRegistry] LLM matching failed: ${error.message}`);
      return {
        strategy: null,
        matchMethod: 'none',
        confidence: 0,
        shouldFallback: true,
        fallbackReason: `LLM 匹配失败: ${error.message}`,
      };
    }
  }

  /**
   * Process LLM selection result.
   */
  private processLLMResult(result: StrategySelectionResult): StrategyMatchResult {
    if (result.shouldFallback || !result.selected) {
      return {
        strategy: null,
        matchMethod: 'llm',
        confidence: result.candidates[0]?.confidence || 0,
        reasoning: result.candidates[0]?.reasoning,
        shouldFallback: true,
        fallbackReason: result.fallbackReason,
      };
    }

    // Find the strategy by ID
    const strategy = this.strategies.find(s => s.id === result.selected!.strategyId);
    if (!strategy) {
      return {
        strategy: null,
        matchMethod: 'llm',
        confidence: result.selected.confidence,
        reasoning: result.selected.reasoning,
        shouldFallback: true,
        fallbackReason: `策略 ${result.selected.strategyId} 未在注册表中找到`,
      };
    }

    return {
      strategy,
      matchMethod: 'llm',
      confidence: result.selected.confidence,
      reasoning: result.selected.reasoning,
      shouldFallback: false,
    };
  }

  /**
   * Get strategy definitions for LLM prompt context.
   */
  getDefinitions(): StrategyDefinition[] {
    return this.strategies.map(strategyToDefinition);
  }

  /** Get all registered strategies (for debugging/introspection) */
  getAll(): StagedAnalysisStrategy[] {
    return [...this.strategies];
  }

  /** Get strategy by ID */
  getById(id: string): StagedAnalysisStrategy | undefined {
    return this.strategies.find(s => s.id === id);
  }
}

// =============================================================================
// Factory Functions
// =============================================================================

/**
 * Create a pre-configured strategy registry with all built-in strategies.
 */
export function createStrategyRegistry(): StrategyRegistry {
  const registry = new StrategyRegistry();
  // Register strategies in order of specificity (more specific first)
  registry.register(scrollingStrategy);
  registry.register(startupStrategy);
  registry.register(sceneReconstructionQuickStrategy);
  // Scene reconstruction is a catch-all for overview queries
  registry.register(sceneReconstructionStrategy);
  return registry;
}

/**
 * Create a strategy registry with LLM semantic matching enabled.
 *
 * @param modelRouter - Model router for LLM calls
 * @param matchMode - Matching mode (default: keyword_first)
 */
export function createEnhancedStrategyRegistry(
  modelRouter: ModelRouter,
  matchMode: 'keyword_first' | 'llm_only' | 'keyword_only' = 'keyword_first'
): StrategyRegistry {
  const registry = createStrategyRegistry();

  // Set up LLM selector
  const llmSelector = createLLMStrategySelector(modelRouter);
  registry.setLLMSelector(llmSelector);
  registry.setMatchMode(matchMode);

  return registry;
}
