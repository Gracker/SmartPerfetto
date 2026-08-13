// backend/src/services/providerManager/envIsolation.ts
// SPDX-License-Identifier: AGPL-3.0-or-later

const PI_PROVIDER_ENV_PREFIXES = [
  'AI_GATEWAY_',
  'ANT_LING_',
  'AZURE_OPENAI_',
  'BASETEN_',
  'CEREBRAS_',
  'CLOUDFLARE_',
  'DEEPSEEK_',
  'FIREWORKS_',
  'GEMINI_',
  'GOOGLE_',
  'GROQ_',
  'KIMI_',
  'MINIMAX_',
  'MISTRAL_',
  'MOONSHOT_',
  'NVIDIA_',
  'OPENCODE_',
  'OPENROUTER_',
  'QWEN_TOKEN_PLAN_',
  'RADIUS_',
  'TOGETHER_',
  'XAI_',
  'XIAOMI_',
  'ZAI_',
];

const PI_PROVIDER_ENV_KEYS = new Set([
  'AI_GATEWAY_API_KEY',
  'ANT_LING_API_KEY',
  'AWS_ACCESS_KEY_ID',
  'AWS_BEARER_TOKEN_BEDROCK',
  'AWS_BEDROCK_FORCE_CACHE',
  'AWS_BEDROCK_FORCE_HTTP1',
  'AWS_BEDROCK_SKIP_AUTH',
  'AWS_CONFIG_FILE',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE',
  'AWS_CONTAINER_CREDENTIALS_FULL_URI',
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
  'AWS_DEFAULT_REGION',
  'AWS_EC2_METADATA_DISABLED',
  'AWS_PROFILE',
  'AWS_REGION',
  'AWS_ROLE_ARN',
  'AWS_ROLE_SESSION_NAME',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_SHARED_CREDENTIALS_FILE',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'AZURE_OPENAI_API_KEY',
  'AZURE_OPENAI_API_VERSION',
  'AZURE_OPENAI_BASE_URL',
  'AZURE_OPENAI_DEPLOYMENT_NAME_MAP',
  'AZURE_OPENAI_RESOURCE_NAME',
  'BASETEN_API_KEY',
  'CEREBRAS_API_KEY',
  'CLOUDFLARE_ACCOUNT_ID',
  'CLOUDFLARE_API_KEY',
  'CLOUDFLARE_GATEWAY_ID',
  'COPILOT_GITHUB_TOKEN',
  'DEEPSEEK_API_KEY',
  'FIREWORKS_API_KEY',
  'GCLOUD_PROJECT',
  'GEMINI_API_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_CLOUD_API_KEY',
  'GOOGLE_CLOUD_LOCATION',
  'GOOGLE_CLOUD_PROJECT',
  'GROQ_API_KEY',
  'HF_TOKEN',
  'KIMI_API_KEY',
  'MINIMAX_API_KEY',
  'MINIMAX_CN_API_KEY',
  'MISTRAL_API_KEY',
  'MOONSHOT_API_KEY',
  'NVIDIA_API_KEY',
  'OPENCODE_API_KEY',
  'OPENROUTER_API_KEY',
  'PI_CACHE_RETENTION',
  'QWEN_TOKEN_PLAN_API_KEY',
  'QWEN_TOKEN_PLAN_CN_API_KEY',
  'RADIUS_API_KEY',
  'TOGETHER_API_KEY',
  'XAI_API_KEY',
  'XIAOMI_API_KEY',
  'XIAOMI_TOKEN_PLAN_AMS_API_KEY',
  'XIAOMI_TOKEN_PLAN_CN_API_KEY',
  'XIAOMI_TOKEN_PLAN_SGP_API_KEY',
  'ZAI_API_KEY',
  'ZAI_CODING_CN_API_KEY',
]);

const PROVIDER_ENV_PREFIXES = [
  'ANTHROPIC_',
  'AWS_',
  'CLAUDE_',
  'OPENAI_',
  'QODER_',
  'SMARTPERFETTO_PI_AGENT_CORE_',
  'SMARTPERFETTO_OPENCODE_',
  'SMARTPERFETTO_QODER_',
];

const PROVIDER_ENV_KEYS = new Set([
  'SMARTPERFETTO_AGENT_RUNTIME',
  'CLOUD_ML_REGION',
  'QODERCLI_PATH',
]);

const SUBPROCESS_SYSTEM_ENV_KEYS = new Set([
  'PATH', 'PATHEXT', 'SystemRoot', 'WINDIR', 'COMSPEC',
  'LD_LIBRARY_PATH', 'DYLD_LIBRARY_PATH',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'no_proxy',
  'GOOGLE_APPLICATION_CREDENTIALS',
]);

/** Explicit environment boundary for third-party provider subprocesses. */
export function providerSubprocessEnv(
  inheritedEnv: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  const includePiProviderEnv = inheritedEnv.SMARTPERFETTO_AGENT_RUNTIME === 'pi-agent-core';
  for (const [key, value] of Object.entries(inheritedEnv)) {
    if (
      SUBPROCESS_SYSTEM_ENV_KEYS.has(key) ||
      PROVIDER_ENV_KEYS.has(key) ||
      PROVIDER_ENV_PREFIXES.some(prefix => key.startsWith(prefix)) ||
      (
        includePiProviderEnv &&
        (
          PI_PROVIDER_ENV_KEYS.has(key) ||
          PI_PROVIDER_ENV_PREFIXES.some(prefix => key.startsWith(prefix))
        )
      )
    ) {
      env[key] = value;
    }
  }
  return env;
}

export function clearProviderRuntimeEnv(
  env: Record<string, string | undefined>,
  options: {clearPiSystemEnv?: boolean} = {},
): void {
  for (const key of Object.keys(env)) {
    const generalRuntimeKey = PROVIDER_ENV_KEYS.has(key)
      || PROVIDER_ENV_PREFIXES.some(prefix => key.startsWith(prefix));
    const piRuntimeKey = PI_PROVIDER_ENV_KEYS.has(key)
      || PI_PROVIDER_ENV_PREFIXES.some(prefix => key.startsWith(prefix));
    const preserveSharedSystemKey = piRuntimeKey
      && SUBPROCESS_SYSTEM_ENV_KEYS.has(key)
      && options.clearPiSystemEnv !== true;
    if (generalRuntimeKey || (piRuntimeKey && !preserveSharedSystemKey)) {
      delete env[key];
    }
  }
}

export function isPiProviderEnvKey(key: string): boolean {
  return PI_PROVIDER_ENV_KEYS.has(key);
}

export function mergeIsolatedProviderEnv(
  baseEnv: Record<string, string | undefined>,
  providerEnv: Record<string, string> | null | undefined,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...baseEnv };
  if (providerEnv) {
    clearProviderRuntimeEnv(env, {
      clearPiSystemEnv: providerEnv.SMARTPERFETTO_AGENT_RUNTIME === 'pi-agent-core',
    });
    Object.assign(env, providerEnv);
  }
  return env;
}
