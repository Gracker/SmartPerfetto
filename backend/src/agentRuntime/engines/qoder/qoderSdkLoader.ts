// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import path from 'path';
import { pathToFileURL } from 'url';

import {
  getLocalQoderSdkModulePath,
  QODER_SDK_MODULE_PATH_ENV,
  type EnvLike,
} from './qoderConfig';

export interface QoderSdkModule {
  query(params: { prompt: string; options?: unknown }): unknown;
  qodercliAuth(): unknown;
  accessTokenFromEnv(envVar?: string): unknown;
  createSdkMcpServer(config: unknown): unknown;
  AbortError?: new () => Error;
  ProtocolVersionMismatchError?: new () => Error;
}

const importEsmModule = new Function(
  'specifier',
  'return import(specifier);',
) as (specifier: string) => Promise<unknown>;

export async function loadQoderSdkModule(
  env: EnvLike = process.env,
): Promise<QoderSdkModule> {
  const configuredPath = env[QODER_SDK_MODULE_PATH_ENV]?.trim();
  const specifiers = configuredPath
    ? [path.isAbsolute(configuredPath) ? pathToFileURL(configuredPath).href : configuredPath]
    : [
        '@qoder-ai/qoder-agent-sdk',
        pathToFileURL(getLocalQoderSdkModulePath()).href,
      ];

  let module: Partial<QoderSdkModule> | undefined;
  let lastError: unknown;
  for (const specifier of [...new Set(specifiers)]) {
    try {
      module = await importEsmModule(specifier) as Partial<QoderSdkModule>;
      break;
    } catch (error) {
      lastError = error;
    }
  }

  if (!module) {
    const detail = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(
      'Qoder Agent SDK is not installed. Review its terms, then run '
      + '`npm --prefix backend run qoder:install -- --accept-terms` or configure '
      + `${QODER_SDK_MODULE_PATH_ENV}. ${detail}`,
    );
  }
  if (typeof module.query !== 'function') {
    throw new Error('Qoder Agent SDK module does not export query()');
  }
  return module as QoderSdkModule;
}
