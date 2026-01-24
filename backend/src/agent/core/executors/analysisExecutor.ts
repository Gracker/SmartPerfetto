/**
 * Analysis Executor Interface
 *
 * Unified interface for all analysis execution paths.
 * Eliminates the strategy-vs-hypothesis dual-path hardcoding
 * by abstracting the execution loop behind a common contract.
 *
 * Implementations:
 * - StrategyExecutor: deterministic multi-stage pipeline
 * - HypothesisExecutor: adaptive AI-driven hypothesis loop
 */

import { ExecutionContext, ExecutorResult, ProgressEmitter } from '../orchestratorTypes';

/**
 * Common interface for analysis execution strategies.
 * Each executor owns its own loop (stages or rounds) and returns
 * accumulated results in a uniform format.
 */
export interface AnalysisExecutor {
  execute(ctx: ExecutionContext, emitter: ProgressEmitter): Promise<ExecutorResult>;
}
