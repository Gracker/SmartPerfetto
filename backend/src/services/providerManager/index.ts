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
} from './types';
export { ProviderService } from './providerService';
export { ProviderStoreUnreadableError } from './providerStore';
export { officialTemplates } from './templates';
export {
  getProviderModelCatalogService,
  mergeModelOptions,
} from './providerModelCatalog';
export { isAgentRuntimeKind } from './providerRuntimeMatrix';

let instance: ProviderService | null = null;

export function getProviderService(): ProviderService {
  if (!instance) {
    const file = providerDataPath('providers.json');
    instance = new ProviderService(file);
    const active = instance.list().find(p => p.isActive);
    if (active) {
      console.log(`[ProviderManager] Active: "${active.name}" (${active.type}, ${active.models.primary})`);
    } else if (instance.getStoreStatus() === 'unreadable') {
      console.log('[ProviderManager] providers.json could not be read; analyses that follow the active provider are refused until it is repaired');
    } else {
      console.log('[ProviderManager] No active provider configured, using env fallback');
    }
  }
  return instance;
}

/** @internal Reset the singleton — for tests only. */
export function resetProviderService(): void {
  instance = null;
  resetProviderModelCatalogService();
}
