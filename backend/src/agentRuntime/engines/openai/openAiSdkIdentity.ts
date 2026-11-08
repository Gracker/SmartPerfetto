// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {createRequire} from 'node:module';
import {Agent, OpenAIProvider, Runner, StreamedRunResult} from '@openai/agents';
import {isPlainObject} from '../../../utils/llmJson';

export interface OpenAiSdkIdentity {
  readonly agentsCoreVersion: string;
  readonly agentsOpenAiVersion: string;
  /** `matched` only when both packages resolve to the umbrella SDK already imported here. */
  readonly identity: 'matched' | 'unknown';
}

let installedIdentity: OpenAiSdkIdentity | undefined;

/**
 * Resolve the packages used by the already imported umbrella SDK, not a
 * configured version label. Installed packages cannot change within a
 * process, so the first resolution is reused.
 */
export function installedOpenAiSdkIdentity(): OpenAiSdkIdentity {
  installedIdentity ??= Object.freeze(resolveInstalledOpenAiSdkIdentity());
  return installedIdentity;
}

function resolveInstalledOpenAiSdkIdentity(): OpenAiSdkIdentity {
  const unknown = {agentsCoreVersion: 'unknown', agentsOpenAiVersion: 'unknown', identity: 'unknown'} as const;
  try {
    const sdkRequire = createRequire(require.resolve('@openai/agents'));
    const coreEntry = sdkRequire.resolve('@openai/agents-core'), openAiEntry = sdkRequire.resolve('@openai/agents-openai');
    const core = require(coreEntry), openAi = require(openAiEntry);
    if (core.Agent !== Agent || core.Runner !== Runner || core.StreamedRunResult !== StreamedRunResult ||
      openAi.OpenAIProvider !== OpenAIProvider) return unknown;
    const version = (entry: string, name: string): string => {
      const value: unknown = JSON.parse(readFileSync(join(dirname(entry), '..', 'package.json'), 'utf8'));
      return isPlainObject(value) && value.name === name && typeof value.version === 'string' ? value.version : 'unknown';
    };
    const agentsCoreVersion = version(coreEntry, '@openai/agents-core');
    const agentsOpenAiVersion = version(openAiEntry, '@openai/agents-openai');
    return {agentsCoreVersion, agentsOpenAiVersion,
      identity: agentsCoreVersion === 'unknown' || agentsOpenAiVersion === 'unknown' ? 'unknown' : 'matched'};
  } catch {return unknown;}
}
