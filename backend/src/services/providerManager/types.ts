// backend/src/services/providerManager/types.ts
// SPDX-License-Identifier: AGPL-3.0-or-later

export interface ProviderModels {
  primary: string;
  light: string;
  subAgent?: string;
}

export interface ProviderConnection {
  baseUrl?: string;
  apiKey?: string;
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

export type ProviderType = 'anthropic' | 'bedrock' | 'vertex' | 'deepseek' | 'openai' | 'ollama' | 'custom';

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

export interface ModelOption {
  id: string;
  name: string;
  tier: 'primary' | 'light';
}

export interface OfficialProviderTemplate {
  type: Exclude<ProviderType, 'custom'>;
  displayName: string;
  requiredFields: string[];
  defaultModels: { primary: string; light: string };
  availableModels: ModelOption[];
  defaultConnection?: Partial<ProviderConnection>;
}

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
