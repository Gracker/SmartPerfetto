// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { createHash } from 'crypto';
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

export type QoderSdkModuleImporter = (specifier: string) => Promise<unknown>;

const importEsmModule = new Function(
  'specifier',
  'return import(specifier);',
) as QoderSdkModuleImporter;

interface QoderSdkModuleCacheEntry {
  key: string;
  generation: number;
  promise: Promise<QoderSdkModule>;
}

let moduleCacheEntry: QoderSdkModuleCacheEntry | undefined;
let moduleCacheGeneration = 0;

function resolveQoderSdkSpecifiers(env: EnvLike): string[] {
  const configuredPath = env[QODER_SDK_MODULE_PATH_ENV]?.trim();
  const candidates = configuredPath
    ? [path.isAbsolute(configuredPath) ? pathToFileURL(configuredPath).href : configuredPath]
    : [
        '@qoder-ai/qoder-agent-sdk',
        pathToFileURL(getLocalQoderSdkModulePath()).href,
      ];
  return [...new Set(candidates)];
}

function moduleCacheKey(specifiers: readonly string[]): string {
  return createHash('sha256')
    .update(JSON.stringify(specifiers))
    .digest('hex');
}

async function importQoderSdkModule(
  specifiers: readonly string[],
  importer: QoderSdkModuleImporter,
): Promise<QoderSdkModule> {
  let module: Partial<QoderSdkModule> | undefined;
  let lastError: unknown;
  for (const specifier of specifiers) {
    try {
      module = await importer(specifier) as Partial<QoderSdkModule>;
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

export function resetQoderSdkModuleCache(): void {
  moduleCacheGeneration += 1;
  moduleCacheEntry = undefined;
}

export function loadQoderSdkModule(
  env: EnvLike = process.env,
  importer: QoderSdkModuleImporter = importEsmModule,
): Promise<QoderSdkModule> {
  const specifiers = resolveQoderSdkSpecifiers(env);
  const key = moduleCacheKey(specifiers);
  if (moduleCacheEntry?.key === key) return moduleCacheEntry.promise;
  if (moduleCacheEntry) {
    moduleCacheGeneration += 1;
  }

  const generation = moduleCacheGeneration;
  const entry: QoderSdkModuleCacheEntry = {
    key,
    generation,
    promise: importQoderSdkModule(specifiers, importer),
  };
  moduleCacheEntry = entry;
  void entry.promise.catch(() => {
    if (
      moduleCacheGeneration === entry.generation
      && moduleCacheEntry === entry
    ) {
      moduleCacheEntry = undefined;
    }
  });
  return entry.promise;
}
