/**
 * Strategy System - Barrel Exports
 *
 * Usage:
 *   import { createStrategyRegistry, intervalHelpers } from '../strategies';
 *   const registry = createStrategyRegistry();
 *   const matched = registry.match(userQuery);
 */

export type {
  FocusInterval,
  IntervalHelpers,
  StageTaskTemplate,
  StageDefinition,
  StagedAnalysisStrategy,
  StrategyExecutionState,
  DirectSkillTask,
} from './types';

export {
  payloadToObjectRows,
  isLikelyAppProcessName,
  formatNsRangeLabel,
  intervalHelpers,
} from './helpers';

export {
  StrategyRegistry,
  createStrategyRegistry,
  createEnhancedStrategyRegistry,
  type StrategyMatchResult,
} from './registry';
export { scrollingStrategy } from './scrollingStrategy';
export { startupStrategy } from './startupStrategy';
export { sceneReconstructionQuickStrategy, sceneReconstructionStrategy } from './sceneReconstructionStrategy';
