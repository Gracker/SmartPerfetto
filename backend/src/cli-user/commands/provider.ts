// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { providerConfigurationHelp } from '../../services/providerManager/providerConfigurationHelp';
import { parseOutputLanguage } from '../../agentv3/outputLanguage';
import { bootstrap } from '../bootstrap';
import type { OutputFormat } from '../repl/renderer';
import { getProviderService } from '../../services/providerManager';
import { testProviderConnection } from '../../services/providerManager/connectionTester';
import { resolveAgentRuntimeSelectionForDiagnostics } from '../../agentRuntime/runtimeSelection';
import { getRuntimeDiagnostics } from '../../agentRuntime/runtimeDiagnostics';
import {
  EXPERIMENTAL_OPENCODE_RUNTIME_KIND,
  OPENCODE_RUNTIME_KIND,
  QODER_AGENT_RUNTIME_KIND,
} from '../../agentRuntime/runtimeKinds';
import { getClaudeRuntimeDiagnostics } from '../../agentv3/claudeConfig';
import { getOpenAIRuntimeDiagnostics, hasOpenAICredentials } from '../../agentOpenAI/openAiConfig';
import { withConsoleLogToStderr } from '../io/stdio';
import { isClaudeSdkBinaryUsable } from '../services/runtimeGuard';
import {
  AiDisabledError,
  assertAiFeatureEnabled,
  buildAiDisabledPayload,
} from '../../services/aiCapabilityPolicy';

export interface ProviderCommandBaseArgs {
  envFile?: string;
  sessionDir?: string;
  format?: OutputFormat;
}

export async function runProviderListCommand(args: ProviderCommandBaseArgs): Promise<number> {
  bootstrap({ envFile: args.envFile, sessionDir: args.sessionDir, requireLlm: false });
  const format = args.format ?? 'text';
  const {providers, storeStatus} = await withConsoleLogToStderr(format !== 'text', async () => {
    const svc = getProviderService();
    return {providers: svc.list(), storeStatus: svc.getStoreStatus()};
  });

  if (format === 'json' || format === 'ndjson') {
    console.log(JSON.stringify({ ok: true, providers, store: {status: storeStatus} }, null, format === 'json' ? 2 : 0));
    return 0;
  }

  if (storeStatus === 'unreadable') {
    console.log('(providers.json could not be read; provider changes and analyses that follow the active provider are refused until it is repaired)');
    return 0;
  }
  if (providers.length === 0) {
    console.log('(no providers configured; using env/default runtime)');
    return 0;
  }

  for (const p of providers) {
    const active = p.isActive ? '*' : ' ';
    const runtime = getProviderService().resolveAgentRuntime(getProviderService().getRaw(p.id) ?? p);
    console.log(`${active} ${p.id}  ${p.name}  ${p.type}  ${runtime}  model=${p.models.primary}`);
  }
  return 0;
}

export interface ProviderTestCommandArgs extends ProviderCommandBaseArgs {
  target?: string;
}

export async function runProviderTestCommand(args: ProviderTestCommandArgs): Promise<number> {
  bootstrap({ envFile: args.envFile, sessionDir: args.sessionDir, requireLlm: false });
  const format = args.format ?? 'text';
  const target = args.target || 'system';
  const svc = await withConsoleLogToStderr(format !== 'text', async () => getProviderService());
  try {
    assertAiFeatureEnabled('cli_provider_test');
  } catch (error) {
    if (error instanceof AiDisabledError) {
      return writeResult(format, {
        ok: false,
        target,
        ...buildAiDisabledPayload(error),
      });
    }
    throw error;
  }

  if (target !== 'system') {
    const provider = svc.getRaw(target);
    if (!provider) {
      return writeResult(format, {
        ok: false,
        target,
        error: `provider not found: ${target}`,
      });
    }
    const result = await withConsoleLogToStderr(
      format !== 'text',
      async () => testProviderConnection(provider),
    );
    return writeResult(format, {
      ok: result.success,
      target,
      provider: { id: provider.id, name: provider.name, type: provider.type },
      result,
      note: result.success ? 'Provider connection test passed.' : result.error,
    });
  }

  const {selection, providerStoreError} = await withConsoleLogToStderr(
    format !== 'text',
    async () => resolveAgentRuntimeSelectionForDiagnostics(),
  );
  if (providerStoreError) {
    return writeResult(format, {
      ok: false, target: 'system', code: providerStoreError.code, error: providerStoreError.message,
    });
  }
  const providerId = selection.source === 'provider' ? selection.providerId ?? null : null;
  if (providerId) {
    const provider = svc.getRaw(providerId);
    if (!provider) {
      return writeResult(format, {
        ok: false,
        target: 'system',
        runtime: selection,
        error: `active provider not found: ${providerId}`,
      });
    }
    const result = await withConsoleLogToStderr(
      format !== 'text',
      async () => testProviderConnection(provider),
    );
    return writeResult(format, {
      ok: result.success,
      target: 'system',
      runtime: selection,
      provider: { id: provider.id, name: provider.name, type: provider.type },
      result,
      note: result.success
        ? 'Active provider connection test passed.'
        : result.error || 'Active provider connection test failed.',
    });
  }

  if (selection.kind === 'openai-agents-sdk') {
    const diagnostics = await withConsoleLogToStderr(format !== 'text', async () => getOpenAIRuntimeDiagnostics(providerId));
    return writeResult(format, {
      ok: hasOpenAICredentials(providerId),
      target: 'system',
      runtime: selection,
      diagnostics,
      note: hasOpenAICredentials(providerId)
        ? 'OpenAI-compatible runtime is configured.'
        : `OpenAI-compatible runtime needs OPENAI_API_KEY or a localhost provider endpoint. ${providerConfigurationHelp(parseOutputLanguage(process.env.SMARTPERFETTO_OUTPUT_LANGUAGE), 'cli')}`,
    });
  }

  if (selection.kind === QODER_AGENT_RUNTIME_KIND) {
    const diagnostics = await withConsoleLogToStderr(
      format !== 'text',
      async () => getRuntimeDiagnostics(selection),
    );
    const sdkInstalled = diagnostics.sdkInstalled === true;
    return writeResult(format, {
      ok: sdkInstalled,
      target: 'system',
      runtime: selection,
      diagnostics,
      note: !sdkInstalled
        ? 'Qoder Agent SDK is not installed; review its terms and install the optional SDK explicitly.'
        : diagnostics.configured
        ? 'Qoder runtime has an explicit PAT or CLI path.'
        : 'Qoder runtime will use the local qodercli login; SDK availability and authentication are verified during analysis.',
    });
  }

  if (
    selection.kind === OPENCODE_RUNTIME_KIND ||
    selection.kind === EXPERIMENTAL_OPENCODE_RUNTIME_KIND
  ) {
    const diagnostics = await withConsoleLogToStderr(format !== 'text', async () => getRuntimeDiagnostics(selection));
    // Keep CLI preflight on the runtime's parser so accepted configuration
    // cannot drift from what OpenCode will actually consume.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { validateOpenCodeModelConfiguration } = require(
      '../../agentRuntime/engines/opencode/openCodeRuntime'
    ) as typeof import('../../agentRuntime/engines/opencode/openCodeRuntime');
    const modelConfiguration = validateOpenCodeModelConfiguration(process.env, selection);
    return writeResult(format, {
      ok: modelConfiguration.configured,
      target: 'system', runtime: selection, diagnostics,
      note: modelConfiguration.configured
        ? 'OpenCode model configuration detected.'
        : `${modelConfiguration.error} ${providerConfigurationHelp(parseOutputLanguage(process.env.SMARTPERFETTO_OUTPUT_LANGUAGE), 'cli')}`,
    });
  }

  if (selection.kind !== 'claude-agent-sdk') {
    const diagnostics = await withConsoleLogToStderr(format !== 'text', async () => getRuntimeDiagnostics(selection));
    return writeResult(format, {
      ok: diagnostics.configured,
      target: 'system', runtime: selection, diagnostics,
      note: diagnostics.configured
        ? `${selection.kind} configuration detected.`
        : providerConfigurationHelp(parseOutputLanguage(process.env.SMARTPERFETTO_OUTPUT_LANGUAGE), 'cli'),
    });
  }

  const diagnostics = await withConsoleLogToStderr(format !== 'text', async () => getClaudeRuntimeDiagnostics(providerId));
  const binaryOk = isClaudeSdkBinaryUsable(diagnostics.sdkBinary);
  return writeResult(format, {
    ok: binaryOk && diagnostics.configured,
    target: 'system',
    runtime: selection,
    diagnostics,
    note: !binaryOk
      ? 'Claude Agent SDK native binary is missing or not executable.'
      : diagnostics.configured
        ? 'Claude runtime has explicit credentials.'
        : `Claude runtime has no configured credentials. ${providerConfigurationHelp(parseOutputLanguage(process.env.SMARTPERFETTO_OUTPUT_LANGUAGE), 'cli')}`,
  });
}

function writeResult(format: OutputFormat, payload: Record<string, unknown>): number {
  if (format === 'json' || format === 'ndjson') {
    console.log(JSON.stringify(payload, null, format === 'json' ? 2 : 0));
  } else if (payload.ok) {
    console.log('OK');
    if (payload.note) console.log(String(payload.note));
  } else {
    console.error(`Error: ${payload.error || payload.note || 'provider test failed'}`);
  }
  return payload.ok ? 0 : 1;
}
