// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as path from 'path';
import { bootstrap } from '../bootstrap';
import type { OutputFormat } from '../repl/renderer';

export interface ConfigInitCommandArgs {
  envFile?: string;
  sessionDir?: string;
  force: boolean;
  format?: OutputFormat;
}

const ENV_TEMPLATE = `# SmartPerfetto CLI user environment
# This file is loaded after backend/.env when no --env-file is passed.
#
# Analysis runs on Pi Agent Core. Choose ONE endpoint below; Pi calls exactly
# that endpoint with that model and credential. Do not enable the
# Anthropic-compatible and OpenAI-compatible blocks together. A provider
# profile (smp provider / Web UI Provider Manager) takes precedence.

# Anthropic or an Anthropic-compatible endpoint. ANTHROPIC_API_KEY is sent as
# x-api-key; ANTHROPIC_AUTH_TOKEN as Authorization: Bearer. A local Claude Code
# login does not configure this. Leave model envs unset for SmartPerfetto
# defaults, or set the model names your provider requires.
# CLAUDE_MODEL=
# CLAUDE_LIGHT_MODEL=
# ANTHROPIC_API_KEY=
# ANTHROPIC_BASE_URL=
# ANTHROPIC_AUTH_TOKEN=

# OpenAI or an OpenAI-compatible endpoint (responses or chat_completions).
# OPENAI_API_KEY=
# OPENAI_BASE_URL=https://api.openai.com/v1
# OPENAI_MODEL=
# OPENAI_LIGHT_MODEL=
# OPENAI_AGENTS_PROTOCOL=responses

# Ollama / local OpenAI-compatible endpoint example.
# OPENAI_BASE_URL=http://localhost:11434/v1
# OPENAI_API_KEY=ollama
# OPENAI_MODEL=qwen3:8b
# OPENAI_AGENTS_PROTOCOL=chat_completions

# Output language for AI analysis.
# SMARTPERFETTO_OUTPUT_LANGUAGE=zh-CN
`;

export async function runConfigInitCommand(args: ConfigInitCommandArgs): Promise<number> {
  const { paths } = bootstrap({ envFile: args.envFile, sessionDir: args.sessionDir, requireLlm: false });
  const envPath = path.join(paths.home, 'env');
  const format = args.format ?? 'text';

  if (fs.existsSync(envPath) && !args.force) {
    writeOutput(format, {
      ok: false,
      path: envPath,
      error: 'config already exists; pass --force to overwrite',
    });
    return 1;
  }

  fs.mkdirSync(paths.home, { recursive: true });
  fs.writeFileSync(envPath, ENV_TEMPLATE, { encoding: 'utf-8', mode: 0o600 });

  writeOutput(format, {
    ok: true,
    path: envPath,
    overwritten: args.force,
  });
  return 0;
}

function writeOutput(format: OutputFormat, payload: Record<string, unknown>): void {
  if (format === 'json' || format === 'ndjson') {
    console.log(JSON.stringify(payload, null, format === 'json' ? 2 : 0));
    return;
  }
  if (payload.ok) {
    console.log(`Created SmartPerfetto CLI config: ${payload.path}`);
  } else {
    console.error(`Error: ${payload.error}`);
    console.error(`Path: ${payload.path}`);
  }
}
