// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

export {
  createAgentOrchestrator,
  resolveAgentRuntimeSelection,
  type BackendAgentRuntimeKind,
  type CreateAgentOrchestratorInput,
  type RuntimeSelection,
} from './runtimeSelection';
export {
  createAnalysisRunSpec,
  type AnalysisRunSpec,
  type CreateAnalysisRunSpecInput,
  type RuntimeBudgetInputs,
} from './analysisRunSpec';
export {
  getProductionEngineCapabilities,
  getProductionRuntimeDescriptor,
  getProviderTypesForRuntime,
  isProductionAgentRuntimeKind,
  listProductionRuntimeKinds,
  supportsRuntimeProviderType,
  type AgentRuntimeKind,
} from './runtimeDescriptors';
export {
  EXPERIMENTAL_AGENT_RUNTIME_ENABLED_ENV,
  EXPERIMENTAL_AGENT_RUNTIME_ENV,
  isExperimentalAgentRuntimeKind,
  listExperimentalRuntimeKinds,
  resolveExperimentalAgentRuntimeSelection,
  type ExperimentalAgentRuntimeKind,
  type ExperimentalRuntimeSelection,
} from './experimentalRuntime';
export {
  type EngineCapabilities,
  type RuntimeDiagnosticsInput,
  type RuntimeDiagnosticsPayload,
  type RuntimeEngineDescriptor,
} from './runtimeDescriptorTypes';
export {
  asRuntimeDiagnosticsPayload,
  getRuntimeDiagnosticModel,
  getRuntimeDiagnosticProviderMode,
  getRuntimeDiagnostics,
  type GetRuntimeDiagnosticsInput,
} from './runtimeDiagnostics';
export {
  createRuntimeRegistryForSelection,
  type RuntimeEngineDefinition,
  type RuntimeFactoryInput,
} from './runtimeRegistry';
export {
  EXPERIMENTAL_OPENCODE_RUNTIME_KIND,
  OPENCODE_PROJECT_DIR_ENV,
  OPENCODE_SDK_MODULE_PATH_ENV,
  OPENCODE_SERVER_PORT_ENV,
  OPENCODE_SERVER_TIMEOUT_MS_ENV,
  OpenCodeRuntime,
  createOpenCodeHardenedConfig,
  createOpenCodeRuntimeDefinition,
  createOpenCodeToolAllowlist,
  getOpenCodeEngineCapabilities,
  getOpenCodeRuntimeDiagnostics,
  projectOpenCodeEventToStreamingUpdate,
  type ExperimentalOpenCodeRuntimeKind,
  type OpenCodeEvent,
  type OpenCodeRuntimeOptions,
  type OpenCodeSdkModuleLoader,
} from './engines/opencode';
export {
  QODER_AGENT_RUNTIME_KIND,
  QODER_PERSONAL_ACCESS_TOKEN_ENV,
  QODER_CLI_PATH_ENV,
  QODER_MODEL_ENV,
  QODER_SYSTEM_PROMPT_ENV,
  QoderRuntime,
  createQoderRuntimeDefinition,
  getQoderEngineCapabilities,
  getQoderRuntimeDiagnostics,
  resolveQoderRuntimeConfig,
  type QoderRuntimeConfig,
  type QoderRuntimeKind,
} from './engines/qoder';
export {
  SDK_SESSION_FRESHNESS_MS,
  buildEntityContext,
  buildQuickConversationContext,
  buildRuntimeSessionMapKey,
  captureSkillDisplayEntities,
  collectRecentFindings,
  createRuntimeSkillNotesBudget,
  formatTraceContext,
  getLruCacheEntry,
  isFreshRuntimeEntry,
  knowledgeScopeFromAnalysisOptions,
  providerScopeFromAnalysisOptions,
  setLruCacheEntry,
  toProtocolHypothesis,
  type RuntimeHypothesisSource,
} from './runtimeCommon';
