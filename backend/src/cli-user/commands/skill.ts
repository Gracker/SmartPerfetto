// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { bootstrap, resolveInvocationPath } from '../bootstrap';
import type { OutputFormat } from '../repl/renderer';
import { CliAnalyzeService } from '../services/cliAnalyzeService';
import { getTraceProcessorService } from '../../services/traceProcessorService';
import { createSkillExecutor } from '../../services/skillEngine/skillExecutor';
import { ensureSkillRegistryInitialized, skillRegistry } from '../../services/skillEngine/skillLoader';
import { withConsoleLogToStderr } from '../io/stdio';
import {localize, parseOutputLanguage} from '../../agentv3/outputLanguage';
import {
  localizeSkillDiagnostics,
  localizeSkillDisplayResults,
  localizeSkillDefinition,
} from '../../services/skillLocalization';

export interface SkillCommandArgs {
  trace: string;
  skillId: string;
  params?: string;
  envFile?: string;
  sessionDir?: string;
  format?: OutputFormat;
}

export async function runSkillCommand(args: SkillCommandArgs): Promise<number> {
  const tracePath = resolveInvocationPath(args.trace);
  const format = args.format ?? 'text';
  const lifecycle: { service?: CliAnalyzeService } = {};

  try {
    const params = parseParams(args.params);
    const { traceId, result } = await withConsoleLogToStderr(true, async () => {
      bootstrap({ envFile: args.envFile, sessionDir: args.sessionDir, requireLlm: false });
      const service = new CliAnalyzeService();
      lifecycle.service = service;
      await ensureSkillRegistryInitialized();
      const skill = skillRegistry.getSkill(args.skillId);
      if (!skill) {
        throw new Error(`unknown skill: ${args.skillId}`);
      }

      const loadedTraceId = await service.loadTrace(tracePath);
      const outputLanguage = parseOutputLanguage(
        process.env.SMARTPERFETTO_OUTPUT_LANGUAGE,
      );
      const executor = createSkillExecutor(
        getTraceProcessorService(),
        undefined,
        (event) => {
          if (format === 'ndjson') {
            process.stdout.write(`${JSON.stringify({ type: 'event', event })}\n`);
          }
        },
      );
      executor.setFragmentRegistry(skillRegistry.getFragmentCache());
      executor.registerSkills(skillRegistry.getAllSkills());

      const skillResult = await executor.execute(
        args.skillId,
        loadedTraceId,
        params,
        {__outputLanguage: outputLanguage},
      );
      const externalAuthored =
        skillRegistry.getSkillOrigin(args.skillId)?.origin === 'external_pack';
      const localizedSkill = localizeSkillDefinition(
        skill,
        outputLanguage,
        {externalAuthored},
      );
      return {
        traceId: loadedTraceId,
        result: {
          ...skillResult,
          skillName: localizedSkill.meta.display_name,
          displayResults: localizeSkillDisplayResults(
            args.skillId,
            skillResult.displayResults,
            outputLanguage,
            {externalAuthored},
          ),
          diagnostics: localizeSkillDiagnostics(
            skillResult.diagnostics,
            outputLanguage,
            {externalAuthored},
          ),
        },
      };
    });
    writeSkillOutput(format, {
      tracePath,
      traceId,
      skillId: args.skillId,
      params,
      result,
    });
    return result.success === false ? 1 : 0;
  } catch (err) {
    writeError(format, (err as Error).message);
    return 1;
  } finally {
    await lifecycle.service?.shutdown();
  }
}

function parseParams(raw: string | undefined): Record<string, unknown> {
  if (!raw || !raw.trim()) return {};
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('--params must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function writeSkillOutput(format: OutputFormat, payload: Record<string, unknown>): void {
  const result = payload.result as { success?: boolean } | undefined;
  const ok = result?.success !== false;
  if (format === 'json') {
    console.log(JSON.stringify({ ok, ...payload }, null, 2));
    return;
  }
  if (format === 'ndjson') {
    console.log(JSON.stringify({ type: 'complete', ok, ...payload }));
    return;
  }
  console.log(JSON.stringify(payload.result, null, 2));
}

function writeError(format: OutputFormat, message: string): void {
  if (format === 'json' || format === 'ndjson') {
    // The machine-readable shape keeps its stable English key and value; only
    // the human-facing frame follows the configured output language, the way
    // `batch` already does it.
    console.error(JSON.stringify({ ok: false, type: 'error', error: message }));
  } else {
    const language = parseOutputLanguage(process.env.SMARTPERFETTO_OUTPUT_LANGUAGE);
    console.error(localize(language, `错误：${message}`, `Error: ${message}`));
  }
}
