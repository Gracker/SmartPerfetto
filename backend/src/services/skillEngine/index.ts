/**
 * Skill Engine
 *
 * A configurable skill system that allows performance experts to define
 * analysis workflows in YAML files without modifying code.
 *
 * Features:
 * - YAML-based skill definitions
 * - Composite skills with multi-step analysis
 * - AI-assisted diagnostics and summaries
 * - Automatic skill matching based on keywords and patterns
 * - Variable substitution in SQL queries
 * - Real-time execution events
 */

// =============================================================================
// Types
// =============================================================================
export * from './types';

// =============================================================================
// Skill Loader
// =============================================================================
export * from './skillLoader';

export {
  skillRegistry,
  ensureSkillRegistryInitialized,
  getSkillsDir,
} from './skillLoader';

// =============================================================================
// Skill Executor
// =============================================================================
export * from './skillExecutor';

export {
  SkillExecutor,
  createSkillExecutor,
  LayeredResult,
} from './skillExecutor';

// =============================================================================
// Skill Analysis Adapter
// =============================================================================
export * from './skillAnalysisAdapter';

export {
  SkillAnalysisAdapter,
  createSkillAnalysisAdapter,
  getSkillAnalysisAdapter,
  SkillAnalysisRequest,
  SkillAnalysisResponse,
  SkillListItem,
  AdaptedResult,
} from './skillAnalysisAdapter';

// =============================================================================
// Utilities
// =============================================================================

// 智能摘要和回答生成器
export { smartSummaryGenerator, SmartSummaryGenerator } from './smartSummaryGenerator';
export { answerGenerator, AnswerGenerator } from './answerGenerator';

// 事件收集器
export {
  SkillEventCollector,
  createEventCollector,
  EventSummary,
  ProgressInfo,
} from './eventCollector';

