// SPDX-License-Identifier: AGPL-3.0-or-later

export const DUAL_SURFACE_PROVIDER_TYPES = [
  'deepseek',
  'glm',
  'qwen',
  'qwen_coding',
  'kimi_code',
  'kimi',
  'doubao',
  'minimax',
  'xiaomi',
  'tencent_token_plan',
  'tencent_coding_plan',
  'hunyuan',
  'qianfan',
  'stepfun',
  'siliconflow',
  'huawei',
] as const;

/** Every provider type a profile may have, in template order. */
export const PROVIDER_TYPES = [
  'anthropic',
  'bedrock',
  'vertex',
  ...DUAL_SURFACE_PROVIDER_TYPES,
  'openai',
  'ollama',
  'custom',
] as const;

/**
 * Provider types whose profiles already ran on Pi Agent Core before it became
 * the only runtime, through a fixed catalog reference: the pi-ai providers
 * searched in order for the configured model id, and the configured endpoint
 * (OpenAI-compatible or Anthropic) that model's API speaks. Frozen so those
 * profiles keep their provider snapshot; every other profile resolves its Pi
 * model from the endpoint its previous runtime used (piProviderCatalog.ts).
 */
export const PI_CATALOG_ROUTES = {
  deepseek: {catalogProviders: ['deepseek'], surface: 'openai'},
  glm: {catalogProviders: ['zai-coding-cn', 'zai'], surface: 'openai'},
  kimi_code: {catalogProviders: ['kimi-coding'], surface: 'openai'},
  kimi: {catalogProviders: ['moonshotai-cn', 'moonshotai'], surface: 'openai'},
  minimax: {catalogProviders: ['minimax-cn', 'minimax'], surface: 'claude'},
} as const satisfies Record<string, {catalogProviders: readonly string[]; surface: 'openai' | 'claude'}>;

/** The first value with content: a whitespace-only endpoint counts as empty, as Pi's route derivation reads it. */
export function firstNonBlank(...values: Array<string | undefined>): string | undefined {
  return values.find(value => value?.trim());
}
