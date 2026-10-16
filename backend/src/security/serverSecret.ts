// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import crypto from 'crypto';

import {
  resolveFeatureConfig,
  selectServerSecretRoot,
  serverSecretCandidateKeys,
} from '../config';

let developmentRootSecret: Buffer | undefined;

export function deriveServerSecret(input: {
  purpose: string;
  env?: NodeJS.ProcessEnv;
  preferredEnvKeys?: string[];
  minimumBytes?: number;
}): Buffer {
  const env = input.env || process.env;
  const minimumBytes = input.minimumBytes ?? 32;
  const configured = selectServerSecretRoot(env, {
    preferredEnvKeys: input.preferredEnvKeys,
    minimumBytes,
  });

  let rootSecret: Buffer;
  if (configured) {
    rootSecret = Buffer.from(configured, 'utf8');
  } else {
    if (resolveFeatureConfig(env).enterprise) {
      throw new Error(
        `A persistent server secret of at least ${minimumBytes} bytes is required in enterprise mode; `
        + `set one of ${serverSecretCandidateKeys(input.preferredEnvKeys).join(', ')}`,
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
