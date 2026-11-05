// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

'use strict';

// Harness routes, not model capability declarations. Native Pi metadata comes
// from its installed public provider entrypoint, never from these defaults.
const providers = {
  glm: Object.freeze({slug: 'glm', label: 'GLM Coding Plan', id: 'zai-coding-cn', envPrefix: 'GLM',
    runtimeGroup: 'all-glm', baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
    model: 'glm-5.3', lightModel: 'glm-5.3-flash',
    credentialKeys: Object.freeze(['GLM_API_KEY', 'GLM_CODING_API_KEY', 'ZAI_CODING_CN_API_KEY']),
    missingCredential: 'GLM_CODING_PLAN_API_KEY_MISSING', piExport: 'zaiCodingCnProvider'}),
  deepseek: Object.freeze({slug: 'deepseek', label: 'DeepSeek V4.1 Flash', id: 'deepseek', envPrefix: 'DEEPSEEK',
    runtimeGroup: 'all-deepseek', baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-flash', lightModel: 'deepseek-flash',
    credentialKeys: Object.freeze(['DEEPSEEK_API_KEY']),
    missingCredential: 'DEEPSEEK_API_KEY_MISSING', piExport: 'deepseekProvider'}),
};

function providerDescriptor(kind) {
  if (!Object.hasOwn(providers, kind)) throw new Error('Unsupported E2E provider');
  return providers[kind];
}

function providerConfiguration(profile, env, provider) {
  if (provider !== profile.id) throw new Error(`${profile.label} requires --provider ${profile.id}`);
  const baseUrl = env[`${profile.envPrefix}_BASE_URL`] || profile.baseUrl;
  let parsed;
  try {parsed = new URL(baseUrl);} catch {}
  const pathname = parsed?.pathname.replace(/\/+$/, '');
  const validOrigin = parsed?.origin === new URL(profile.baseUrl).origin;
  const validPath = profile.slug === 'glm' ? pathname === '/api/coding/paas/v4' : pathname === '' || pathname === '/v1';
  if (!parsed || !validOrigin || !validPath || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(profile.slug === 'glm'
      ? 'GLM Coding Plan requires https://open.bigmodel.cn/api/coding/paas/v4; generic paid or other endpoints are refused'
      : 'DeepSeek Flash requires https://api.deepseek.com/v1; other endpoints and URL credentials are refused');
  }
  const model = env[`${profile.envPrefix}_MODEL`] || profile.model;
  const lightModel = env[`${profile.envPrefix}_LIGHT_MODEL`] || profile.lightModel;
  if (profile.slug === 'glm' && ![model, lightModel].every(value => /^glm-[a-z0-9.-]+$/.test(value))) {
    throw new Error('GLM Coding Plan requires GLM model names');
  }
  // Official API model deepseek-flash serves V4.1 Flash. Legacy v4 aliases or
  // Pro are not substitutes for the explicitly requested cross-validation.
  if (profile.slug === 'deepseek' && (model !== 'deepseek-flash' || lightModel !== 'deepseek-flash')) {
    throw new Error('DeepSeek V4.1 Flash requires --model deepseek-flash and --light-model deepseek-flash');
  }
  return {provider, baseUrl: profile.baseUrl, model, lightModel};
}

module.exports = {providerDescriptor, providerConfiguration};
