// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type { EnvLike } from './qoderConfig';

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
  const specifier = '@qoder-ai/qoder-agent-sdk';
  let module: Partial<QoderSdkModule>;
  try {
    module = await importEsmModule(specifier) as Partial<QoderSdkModule>;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Qoder Agent SDK is not installed. Review its terms, then explicitly install ${specifier}. ${detail}`,
    );
  }
  if (typeof module.query !== 'function') {
    throw new Error('Qoder Agent SDK module does not export query()');
  }
  return module as QoderSdkModule;
}
