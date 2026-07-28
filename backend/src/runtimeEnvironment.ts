// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import dotenv from 'dotenv';

const SERVICE_PORT_ENV_KEYS = [
  'PORT',
  'SMARTPERFETTO_BACKEND_PORT',
  'SMARTPERFETTO_FRONTEND_PORT',
  'SMARTPERFETTO_BACKEND_PUBLIC_PORT',
  'SMARTPERFETTO_BACKEND_PUBLIC_URL',
  'SMARTPERFETTO_BACKEND_URL',
  'FRONTEND_URL',
];

const RUNTIME_IDENTITY_ENV_KEYS = [
  'SMARTPERFETTO_BACKEND_DATA_DIR',
  'SMARTPERFETTO_PACKAGE',
  'SMARTPERFETTO_PACKAGE_ROOT',
  'SMARTPERFETTO_DISTRIBUTION',
  'SMARTPERFETTO_UPDATE_CHANNEL',
  'SMARTPERFETTO_BUILD_COMMIT',
  'SMARTPERFETTO_PACKAGE_TARGET',
  'SMARTPERFETTO_SIGNING_MODE',
  'SMARTPERFETTO_PACKAGE_TARGET_OS',
  'SMARTPERFETTO_PACKAGE_TARGET_ARCH',
];

function captureEnvironment(
  env: NodeJS.ProcessEnv,
  enabled: boolean,
  keys: readonly string[],
): Record<string, string> | null {
  if (!enabled) return null;
  return Object.fromEntries(
    keys
      .filter((key) => env[key] !== undefined)
      .map((key) => [key, env[key] as string]),
  );
}

export function configureRuntimeEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): void {
  const lockedServiceEnv = captureEnvironment(
    env,
    env.SMARTPERFETTO_LOCK_SERVICE_PORTS === '1',
    SERVICE_PORT_ENV_KEYS,
  );
  const lockedRuntimeIdentityEnv = captureEnvironment(
    env,
    env.SMARTPERFETTO_LOCK_RUNTIME_IDENTITY === '1',
    RUNTIME_IDENTITY_ENV_KEYS,
  );

  dotenv.config(
    env.SMARTPERFETTO_ENV_FILE
      ? {
        path: env.SMARTPERFETTO_ENV_FILE,
        override: true,
        processEnv: env,
        quiet: true,
      }
      : {override: true, processEnv: env, quiet: true},
  );

  for (const lockedEnv of [lockedServiceEnv, lockedRuntimeIdentityEnv]) {
    if (!lockedEnv) continue;
    for (const [key, value] of Object.entries(lockedEnv)) {
      env[key] = value;
    }
  }
}

export const __testing = {
  RUNTIME_IDENTITY_ENV_KEYS,
  SERVICE_PORT_ENV_KEYS,
};
