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


/**
 * Provider types whose models the Pi runtime resolves from its builtin catalog:
 * the pi-ai providers searched in order for the configured model id, and the
 * configured endpoint (OpenAI-compatible or Anthropic) that model's API speaks.
 */
export const PI_CATALOG_ROUTES = {
  deepseek: {catalogProviders: ['deepseek'], surface: 'openai'},
  glm: {catalogProviders: ['zai-coding-cn', 'zai'], surface: 'openai'},
  kimi_code: {catalogProviders: ['kimi-coding'], surface: 'openai'},
  kimi: {catalogProviders: ['moonshotai-cn', 'moonshotai'], surface: 'openai'},
  minimax: {catalogProviders: ['minimax-cn', 'minimax'], surface: 'claude'},
} as const satisfies Record<string, {catalogProviders: readonly string[]; surface: 'openai' | 'claude'}>;

export const PI_CATALOG_PROVIDER_TYPES = Object.keys(PI_CATALOG_ROUTES) as Array<keyof typeof PI_CATALOG_ROUTES>;
