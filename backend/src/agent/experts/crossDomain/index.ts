// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Cross-Domain Expert System
 *
 * A hierarchical expert system where:
 * - Module Experts (YAML Skills) provide specialized data analysis
 * - Cross-Domain Experts (TypeScript) orchestrate multi-turn dialogues
 *
 * This module exports all components needed to build and run cross-domain experts.
 */

// Types
export type {
  CrossDomainType,
  CrossDomainExpertConfig,
  ModuleQuery,
  ModuleResponse,
  ModuleFinding,
  ModuleSuggestion,
  DialogueContext,
  Hypothesis,
  HypothesisEvidence,
  AnalysisDecision,
  ForkRequest,
  UserQuestion,
  CrossDomainInput,
  CrossDomainOutput,
  ModuleCatalogEntry,
  ModuleCapability,
  CrossDomainEventType,
  CrossDomainEvent,
  AIService,
} from './types';

// Core components
export { BaseCrossDomainExpert } from './baseCrossDomainExpert';
export {
  ModuleExpertInvoker,
  createModuleExpertInvoker,
  ModuleExpertInvokerConfig,
} from './moduleExpertInvoker';
export {
  DialogueSession,
  DialogueConfig,
  DEFAULT_DIALOGUE_CONFIG,
  DialogueState,
  DialogueStats,
  DialogueEventHandler,
  createQueryId,
  createHypothesisId,
  buildModuleQuery,
} from './dialogueProtocol';
export {
  HypothesisManager,
  HypothesisManagerConfig,
} from './hypothesisManager';
export {
  ModuleCatalog,
  moduleCatalog,
} from './moduleCatalog';

// Concrete expert implementations
export { PerformanceExpert, createPerformanceExpert } from './experts/performanceExpert';