// backend/src/services/providerManager/index.ts
// SPDX-License-Identifier: AGPL-3.0-or-later

import { ProviderService } from './providerService';
import { officialTemplates } from './templates';
import {providerDataPath} from './providerPaths';

export type {
  AgentRuntimeKind,
  OpenAIProtocol,
  ProviderConfig,
  ProviderScope,
  ProviderCreateInput,
  ProviderUpdateInput,
  ProviderTemplate,
  OfficialProviderTemplate,
  ModelOption,
  TestResult,
  ProviderType,
} from './types';
export { ProviderService } from './providerService';
export { ProviderStore } from './providerStore';
export { officialTemplates } from './templates';
export {
  DUAL_SURFACE_PROVIDER_TYPES,
  isAgentRuntimeKind,
  isDualSurfaceProviderType,
  resolveProviderAgentRuntime,
  sharedKeyShouldUseClaudeAuthToken,
  supportsAgentRuntimeType,
} from './providerRuntimeMatrix';

let instance: ProviderService | null = null;

export function getProviderService(): ProviderService {
  if (!instance) {
    const file = providerDataPath('providers.json');
    instance = new ProviderService(file);
    const active = instance.list().find(p => p.isActive);
    if (active) {
      console.log(`[ProviderManager] Active: "${active.name}" (${active.type}, ${active.models.primary})`);
    } else {
      console.log('[ProviderManager] No active provider configured, using env fallback');
    }
  }
  return instance;
}

/** Reset the singleton — for tests only. */
export function resetProviderService(): void {
  instance = null;
}
