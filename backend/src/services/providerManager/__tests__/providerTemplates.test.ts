// SPDX-License-Identifier: AGPL-3.0-or-later

import { officialTemplates } from '../templates';
import type { ProviderTemplate, ProviderType } from '../types';

function templateFor(type: ProviderType): ProviderTemplate {
  const template = officialTemplates.find(candidate => candidate.type === type);
  if (!template) throw new Error(`Missing provider template: ${type}`);
  return template;
}

function availableModelIds(template: ProviderTemplate): Set<string> {
  return new Set(template.availableModels.map(model => model.id));
}

describe('Provider Manager templates', () => {
  it('uses the Huawei OpenAI-compatible endpoint for its current models', () => {
    expect(templateFor('huawei').defaultConnection).toMatchObject({
      claudeBaseUrl: 'https://api.modelarts-maas.com/anthropic',
      openaiBaseUrl: 'https://api.modelarts-maas.com/openai/v1',
      openaiProtocol: 'chat_completions',
    });
  });

  it('provides unambiguous, non-empty model options for each provider', () => {
    for (const template of officialTemplates) {
      const ids = template.availableModels.map(model => model.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const model of template.availableModels) {
        expect(model.id).toBe(model.id.trim());
        expect(model.id.length).toBeGreaterThan(0);
        expect(model.name.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it('keeps every non-empty default model selectable', () => {
    for (const template of officialTemplates) {
      if (template.availableModels.length === 0) continue;
      const ids = availableModelIds(template);
      if (template.defaultModels.primary) {
        expect(ids.has(template.defaultModels.primary)).toBe(true);
      }
      if (template.defaultModels.light) {
        expect(ids.has(template.defaultModels.light)).toBe(true);
      }
    }
  });

  it('uses cost-effective defaults while retaining flagship options', () => {
    const anthropic = templateFor('anthropic');
    expect(anthropic.defaultModels).toEqual({
      primary: 'claude-sonnet-5',
      light: 'claude-haiku-4-5',
    });
    expect(availableModelIds(anthropic).has('claude-fable-5')).toBe(true);

    const openai = templateFor('openai');
    expect(openai.defaultModels).toEqual({
      primary: 'gpt-5.6-terra',
      light: 'gpt-5.6-luna',
    });
    expect(availableModelIds(openai).has('gpt-5.5')).toBe(true);

    const deepseek = templateFor('deepseek');
    expect(deepseek.defaultModels).toEqual({
      primary: 'deepseek-v4-pro',
      light: 'deepseek-flash',
    });
    expect(availableModelIds(deepseek)).toEqual(
      new Set(['deepseek-flash', 'deepseek-v4-pro']),
    );

    const huawei = templateFor('huawei');
    expect(huawei.defaultModels).toEqual({
      primary: 'deepseek-v4-pro',
      light: 'deepseek-v4-flash',
    });
  });

  it('defaults the catalog-backed GLM and DeepSeek templates to Pi Agent Core', () => {
    expect(templateFor('deepseek').defaultConnection?.agentRuntime).toBe('pi-agent-core');
    expect(templateFor('glm').defaultConnection?.agentRuntime).toBe('pi-agent-core');
    expect(templateFor('qwen').defaultConnection?.agentRuntime).toBe('claude-agent-sdk');
  });
});
