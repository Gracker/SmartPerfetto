// backend/src/services/providerManager/types.ts
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { AgentRuntimeKind } from '../../agentRuntime/runtimeKinds';
import type { DUAL_SURFACE_PROVIDER_TYPES } from './providerTypes';

export interface ProviderModels {
  primary: string;
  light: string;
  subAgent?: string;
}

export type { AgentRuntimeKind };
export type OpenAIProtocol = 'responses' | 'chat_completions';

export interface ProviderConnection {
  /**
   * Legacy/shared fields. Keep these for existing provider configs and for
   * vendors that use one key across both Anthropic-compatible and
   * OpenAI-compatible endpoints.
   */
  baseUrl?: string;
  apiKey?: string;
  claudeBaseUrl?: string;
  claudeApiKey?: string;
  claudeAuthToken?: string;
  openaiBaseUrl?: string;
  openaiApiKey?: string;
  piAgentCoreModulePath?: string;
  piAgentCoreModelJson?: string;
  piAgentCoreSystemPrompt?: string;
  openCodeSdkModulePath?: string;
  openCodeModelJson?: string;
  openCodeSystemPrompt?: string;
  /** Qoder Agent SDK access token (Personal Access Token). */
  qoderAccessToken?: string;
  /** Qoder CLI executable path override. */
  qoderCliPath?: string;
  /** Qoder model identifier. */
  qoderModel?: string;
  /** Optional runtime-level system prompt for Qoder. */
  qoderSystemPrompt?: string;
  /**
   * Backend agent runtime used by this provider.
   *
   * When omitted, SmartPerfetto infers the runtime from `ProviderConfig.type`:
   * Anthropic/Bedrock/Vertex/DeepSeek use the Claude Agent SDK; OpenAI/Ollama
   * use the OpenAI Agents SDK. Custom providers should set this explicitly.
   */
  agentRuntime?: AgentRuntimeKind;
  /**
   * OpenAI Agents SDK transport surface.
   * - responses: OpenAI Responses API. Best for official OpenAI models.
   * - chat_completions: OpenAI-compatible Chat Completions. Best for gateways
   *   and local providers such as Ollama.
   */
  openaiProtocol?: OpenAIProtocol;
  // Bedrock
  useBedrock?: boolean;
  awsBearerToken?: string;
  awsAccessKeyId?: string;
  awsSecretAccessKey?: string;
  awsSessionToken?: string;
  awsProfile?: string;
  awsRegion?: string;
  // Vertex
  gcpProjectId?: string;
  gcpRegion?: string;
}

export interface ProviderTuning {
  maxTurns?: number;
  maxBudgetUsd?: number;
  effort?: 'low' | 'medium' | 'high' | 'max';
  fullPerTurnMs?: number;
  quickPerTurnMs?: number;
  verifierTimeoutMs?: number;
  classifierTimeoutMs?: number;
  enableSubAgents?: boolean;
  enableVerification?: boolean;
}

export interface ProviderCustom {
  headers?: Record<string, string>;
  envOverrides?: Record<string, string>;
}

export type DualSurfaceProviderType = typeof DUAL_SURFACE_PROVIDER_TYPES[number];
export type ProviderType =
  | 'anthropic'
  | 'bedrock'
  | 'vertex'
  | DualSurfaceProviderType
  | 'openai'
  | 'ollama'
  | 'custom';

export interface ProviderConfig {
  id: string;
  name: string;
  category: 'official' | 'custom';
  type: ProviderType;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  models: ProviderModels;
  connection: ProviderConnection;
  tuning?: ProviderTuning;
  custom?: ProviderCustom;
}

export interface ProviderScope {
  tenantId: string;
  workspaceId: string;
  userId?: string;
}

export interface ModelOption {
  id: string;
  name: string;
  tier: 'primary' | 'light';
}

export interface ProviderTemplate {
  type: ProviderType;
  displayName: string;
  requiredFields: string[];
  defaultModels: { primary: string; light: string };
  availableModels: ModelOption[];
  defaultConnection?: Partial<ProviderConnection>;
}

export type OfficialProviderTemplate = ProviderTemplate & {
  type: Exclude<ProviderType, 'custom'>;
};

export interface TestResult {
  success: boolean;
  latencyMs: number;
  error?: string;
  modelVerified?: boolean;
}

export interface ProviderCreateInput {
  name: string;
  category: 'official' | 'custom';
  type: ProviderType;
  models: ProviderModels;
  connection: ProviderConnection;
  tuning?: ProviderTuning;
  custom?: ProviderCustom;
}

export interface ProviderUpdateInput {
  name?: string;
  models?: Partial<ProviderModels>;
  connection?: Partial<ProviderConnection>;
  tuning?: ProviderTuning | null;
  custom?: ProviderCustom | null;
}
