// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import crypto from 'crypto';

import {resolveFeatureConfig} from '../config';

let developmentRootSecret: Buffer | undefined;

export function deriveServerSecret(input: {
  purpose: string;
  env?: NodeJS.ProcessEnv;
  preferredEnvKeys?: string[];
  minimumBytes?: number;
}): Buffer {
  const env = input.env || process.env;
  const minimumBytes = input.minimumBytes ?? 32;
  const configured = [
    ...(input.preferredEnvKeys || []),
    'SMARTPERFETTO_SERVER_SECRET',
    'SMARTPERFETTO_SSO_COOKIE_SECRET',
    'SMARTPERFETTO_API_KEY',
  ]
    .map(key => env[key]?.trim())
    .find((value): value is string =>
      typeof value === 'string' && Buffer.byteLength(value, 'utf8') >= minimumBytes,
    );

  let rootSecret: Buffer;
  if (configured) {
    rootSecret = Buffer.from(configured, 'utf8');
  } else {
    if (resolveFeatureConfig(env).enterprise) {
      throw new Error(
        `A persistent server secret of at least ${minimumBytes} bytes is required in enterprise mode`,
      );
    }
    developmentRootSecret ??= crypto.randomBytes(32);
    rootSecret = developmentRootSecret;
  }

  return crypto
    .createHmac('sha256', rootSecret)
    .update(`smartperfetto.${input.purpose}.v1`)
    .digest();
}

export function resetServerSecretForTests(): void {
  developmentRootSecret = undefined;
}
