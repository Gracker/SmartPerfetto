// backend/src/services/providerManager/index.ts
// SPDX-License-Identifier: AGPL-3.0-or-later

import { ProviderService } from './providerService';
import {providerDataPath} from './providerPaths';
import {resetProviderModelCatalogService} from './providerModelCatalog';

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
  getProviderModelCatalogService,
  mergeModelOptions,
  ProviderModelCatalogService,
} from './providerModelCatalog';
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
    } else if (instance.getStoreStatus() === 'unreadable') {
      console.log('[ProviderManager] providers.json could not be read, using env fallback');
    } else {
      console.log('[ProviderManager] No active provider configured, using env fallback');
    }
  }
  return instance;
}

/** Reset the singleton — for tests only. */
export function resetProviderService(): void {
  instance = null;
  resetProviderModelCatalogService();
}
