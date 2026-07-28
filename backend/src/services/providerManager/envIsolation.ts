// backend/src/services/providerManager/envIsolation.ts
// SPDX-License-Identifier: AGPL-3.0-or-later

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
  for (const [key, value] of Object.entries(inheritedEnv)) {
    if (
      SUBPROCESS_SYSTEM_ENV_KEYS.has(key) ||
      PROVIDER_ENV_KEYS.has(key) ||
      PROVIDER_ENV_PREFIXES.some(prefix => key.startsWith(prefix))
    ) {
      env[key] = value;
    }
  }
  return env;
}

export function clearProviderRuntimeEnv(env: Record<string, string | undefined>): void {
  for (const key of Object.keys(env)) {
    if (PROVIDER_ENV_KEYS.has(key) || PROVIDER_ENV_PREFIXES.some(prefix => key.startsWith(prefix))) {
      delete env[key];
    }
  }
}

export function mergeIsolatedProviderEnv(
  baseEnv: Record<string, string | undefined>,
  providerEnv: Record<string, string> | null | undefined,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...baseEnv };
  if (providerEnv) {
    clearProviderRuntimeEnv(env);
    Object.assign(env, providerEnv);
  }
  return env;
}
