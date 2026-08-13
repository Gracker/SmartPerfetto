#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const backendRoot = path.resolve(__dirname, '..');
const verifierPath = path.join(backendRoot, 'src/scripts/verifyAgentSseScrolling.ts');
const tsxCliPath = path.join(backendRoot, 'node_modules/tsx/dist/cli.mjs');

const DEFAULT_RUNTIME = 'claude-agent-sdk';
const QUICK_RUNTIME_KINDS = [
  'claude-agent-sdk',
  'openai-agents-sdk',
  'pi-agent-core',
  'opencode',
];
const DEFAULT_TRACE = '../Trace/real/android-scroll-customer/trace.pftrace';
const DEFAULT_TIMEOUT_MS = '300000';
const QUICK_FULL_REPORT_FALLBACK = 'quick_full_report_shape';
const QUICK_REFERENCE_HEADING = '## 逐句数据引用（结构化来源）';
const QUICK_TRIAGE_HEADING = '## 快速 Triage';

const suites = {
  'mixed-trace-scrolling': quickSuite({
    label: 'quick direct mixed trace fact + scrolling triage gate',
    output: 'test-output/e2e-quick-mixed-trace-scrolling-real.json',
    query: '总帧数是多少？整体流畅吗？',
    maxChars: 900,
    requiredText: [QUICK_TRIAGE_HEADING, QUICK_REFERENCE_HEADING],
  }),
  'trace-fact': quickSuite({
    label: 'quick direct trace fact gate',
    output: 'test-output/e2e-quick-trace-fact-real.json',
    query: '总帧数是多少？',
    maxChars: 900,
    requiredText: [QUICK_REFERENCE_HEADING],
  }),
  'process-identity': quickSuite({
    label: 'quick direct process identity gate',
    output: 'test-output/e2e-quick-process-identity-real.json',
    query: '这个 trace 的应用包名和主要进程是什么？',
    maxChars: 900,
    requiredText: [QUICK_REFERENCE_HEADING, '包名'],
  }),
  'scrolling-triage': quickSuite({
    label: 'quick direct scrolling triage gate',
    output: 'test-output/e2e-quick-scrolling-triage-real.json',
    mode: 'fast',
    query: '快速看一下滑动整体流畅吗？',
    maxChars: 900,
    requiredText: [QUICK_TRIAGE_HEADING, QUICK_REFERENCE_HEADING],
  }),
};

main();

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }

  assertFile(tsxCliPath, 'tsx CLI');
  assertFile(verifierPath, 'Agent SSE verifier');

  const suiteNames = options.suite === 'all' ? Object.keys(suites) : [options.suite];
  const runtimeKinds = resolveRuntimeKinds(options.runtime);
  const uniqueOutput = runtimeKinds.length > 1 || suiteNames.length > 1;

  for (const runtimeKind of runtimeKinds) {
    for (const suiteName of suiteNames) {
      runSuite({
        suiteName,
        runtimeKind,
        runtimeSpecificOutput: uniqueOutput,
        dryRun: options.dryRun,
        timeoutMs: options.timeoutMs,
        keepSession: options.keepSession,
        keepTrace: options.keepTrace,
      });
    }
  }

  const verb = options.dryRun ? 'prepared' : 'passed';
  console.log(`\nQuick Agent SSE E2E ${verb}: ${runtimeKinds.join(', ')} / ${suiteNames.join(', ')}`);
}

function parseArgs(argv) {
  let suite = 'mixed-trace-scrolling';
  let runtime = DEFAULT_RUNTIME;
  let dryRun = false;
  let timeoutMs;
  let keepSession = false;
  let keepTrace = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      return { suite, runtime, dryRun, timeoutMs, keepSession, keepTrace, help: true };
    }
    if (arg === '--suite') {
      const value = argv[i + 1];
      if (!value) throw new Error(`--suite requires a value: ${suiteUsage()}`);
      suite = parseSuite(value);
      i += 1;
      continue;
    }
    if (arg === '--runtime') {
      const value = argv[i + 1];
      if (!value) throw new Error('--runtime requires a value: claude-agent-sdk, openai-agents-sdk, pi-agent-core, opencode, or all');
      runtime = parseRuntime(value);
      i += 1;
      continue;
    }
    if (arg === '--timeout-ms') {
      const value = argv[i + 1];
      if (!value || !/^\d+$/.test(value) || Number(value) <= 0) {
        throw new Error('--timeout-ms requires a positive integer');
      }
      timeoutMs = value;
      i += 1;
      continue;
    }
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (arg === '--keep-session') {
      keepSession = true;
      continue;
    }
    if (arg === '--keep-trace') {
      keepTrace = true;
      continue;
    }
    if (!arg.startsWith('-')) {
      suite = parseSuite(arg);
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  return { suite, runtime, dryRun, timeoutMs, keepSession, keepTrace, help: false };
}

function parseSuite(value) {
  if (value === 'mixed') return 'mixed-trace-scrolling';
  if (value === 'fact') return 'trace-fact';
  if (value === 'identity') return 'process-identity';
  if (value === 'scrolling') return 'scrolling-triage';
  if (value === 'all' || Object.prototype.hasOwnProperty.call(suites, value)) return value;
  throw new Error(`Invalid suite: ${value}. Expected ${suiteUsage()}.`);
}

function suiteUsage() {
  return `all, ${Object.keys(suites).join(', ')}`;
}

function parseRuntime(value) {
  if (
    value === 'all' ||
    value === 'claude' ||
    value === 'claude-agent-sdk' ||
    value === 'openai' ||
    value === 'openai-agents-sdk' ||
    value === 'pi' ||
    value === 'pi-agent-core' ||
    value === 'opencode'
  ) {
    return value;
  }
  throw new Error(
    `Invalid runtime: ${value}. Expected claude-agent-sdk, openai-agents-sdk, pi-agent-core, opencode, or all.`,
  );
}

function resolveRuntimeKinds(value) {
  if (value === 'all') return QUICK_RUNTIME_KINDS;
  if (value === 'claude') return ['claude-agent-sdk'];
  if (value === 'openai') return ['openai-agents-sdk'];
  if (value === 'pi') return ['pi-agent-core'];
  return [value];
}

function printUsage() {
  console.log('Usage: node scripts/run-quick-agent-e2e.cjs [--suite all|mixed-trace-scrolling|trace-fact|process-identity|scrolling-triage] [--runtime claude-agent-sdk|openai-agents-sdk|pi-agent-core|opencode|all]');
  console.log('');
  console.log('Runs SmartPerfetto quick-mode Agent SSE E2E suites through the shared verifier.');
  console.log('');
  console.log('Defaults: --suite mixed-trace-scrolling --runtime claude-agent-sdk.');
  console.log('Aliases: --suite mixed|fact|identity|scrolling and --runtime claude|openai|pi.');
  console.log('Useful options: --dry-run, --timeout-ms <ms>, --keep-session, --keep-trace.');
}

function quickSuite(input) {
  return {
    label: input.label,
    output: input.output,
    args: [
      '--mode',
      input.mode ?? 'auto',
      '--provider-id',
      'null',
      '--trace',
      DEFAULT_TRACE,
      '--query',
      input.query,
      '--timeout-ms',
      DEFAULT_TIMEOUT_MS,
      '--output',
      input.output,
      '--require-quick-run',
      '--require-data-envelope',
      '--require-conclusion-evidence',
      '--require-claim-verifier-ok',
      '--require-non-partial',
      '--max-analysis-completed-conclusion-chars',
      String(input.maxChars),
      ...input.requiredText.flatMap(text => ['--require-text', text]),
      '--forbid-degraded-fallback',
      QUICK_FULL_REPORT_FALLBACK,
    ],
  };
}

function runSuite(input) {
  const suite = suites[input.suiteName];
  const args = withRuntimeOptions({
    args: input.runtimeSpecificOutput
      ? withRuntimeOutputPath(suite.args, suite.output, input.runtimeKind)
      : suite.args,
    timeoutMs: input.timeoutMs,
    keepSession: input.keepSession,
    keepTrace: input.keepTrace,
  });
  console.log(`\n[quick-e2e] suite=${input.suiteName} (${suite.label})`);
  console.log(`[quick-e2e] runtime=${input.runtimeKind}`);
  console.log(`[quick-e2e] output=${getOutputPathFromArgs(args) || suite.output}`);
  console.log(`[quick-e2e] env SMARTPERFETTO_AGENT_RUNTIME=${input.runtimeKind}`);

  const command = [process.execPath, tsxCliPath, verifierPath, ...args];
  if (input.dryRun) {
    console.log(`[quick-e2e] command=${formatCommand(command)}`);
    return;
  }

  const result = spawnSync(process.execPath, [tsxCliPath, verifierPath, ...args], {
    cwd: backendRoot,
    env: buildChildEnv(input.runtimeKind),
    stdio: 'inherit',
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function withRuntimeOptions(input) {
  const next = [...input.args];
  if (input.timeoutMs) replaceArgValue(next, '--timeout-ms', input.timeoutMs);
  if (input.keepSession && !next.includes('--keep-session')) next.push('--keep-session');
  if (input.keepTrace && !next.includes('--keep-trace')) next.push('--keep-trace');
  return next;
}

function replaceArgValue(args, name, value) {
  const index = args.indexOf(name);
  if (index >= 0 && args[index + 1]) {
    args[index + 1] = value;
    return;
  }
  args.push(name, value);
}

function withRuntimeOutputPath(args, outputPath, runtimeKind) {
  const next = [...args];
  const index = next.indexOf('--output');
  const runtimeOutput = outputPath.replace(/-real\.json$/, `-${runtimeKind}-real.json`);
  if (index >= 0 && next[index + 1]) {
    next[index + 1] = runtimeOutput;
  } else {
    next.push('--output', runtimeOutput);
  }
  return next;
}

function getOutputPathFromArgs(args) {
  const index = args.indexOf('--output');
  return index >= 0 ? args[index + 1] : undefined;
}

function buildChildEnv(runtimeKind) {
  const loopbackBaseUrl = process.env.SMARTPERFETTO_QUICK_E2E_BASE_URL || 'http://127.0.0.1:9/v1';
  const model = process.env.SMARTPERFETTO_QUICK_E2E_MODEL || 'smartperfetto-quick-e2e-unused';
  const apiKey = process.env.SMARTPERFETTO_QUICK_E2E_API_KEY || 'smartperfetto-quick-e2e-unused';
  const baseEnv = {
    ...process.env,
    ANTHROPIC_API_KEY: process.env.SMARTPERFETTO_QUICK_E2E_ANTHROPIC_API_KEY || '',
    CLAUDE_CODE_OAUTH_TOKEN: process.env.SMARTPERFETTO_QUICK_E2E_CLAUDE_CODE_OAUTH_TOKEN || '',
    DOTENV_CONFIG_QUIET: 'true',
    SMARTPERFETTO_AGENT_RUNTIME: runtimeKind,
    DEEPSEEK_API_KEY: apiKey,
    OPENAI_API_KEY: apiKey,
    OPENAI_BASE_URL: loopbackBaseUrl,
    OPENAI_MODEL: model,
    OPENAI_LIGHT_MODEL: model,
    OPENAI_MAX_OUTPUT_TOKENS: '1024',
  };

  if (runtimeKind === 'claude-agent-sdk') {
    return baseEnv;
  }

  if (runtimeKind === 'openai-agents-sdk') {
    return {
      ...baseEnv,
      OPENAI_AGENTS_PROTOCOL: process.env.OPENAI_AGENTS_PROTOCOL || 'chat_completions',
    };
  }

  if (runtimeKind === 'pi-agent-core') {
    return {
      ...baseEnv,
      SMARTPERFETTO_PI_AGENT_CORE_MODEL_JSON:
        process.env.SMARTPERFETTO_PI_AGENT_CORE_MODEL_JSON || createPiAgentCoreModelJson({ model, baseUrl: loopbackBaseUrl }),
    };
  }

  if (runtimeKind === 'opencode') {
    return {
      ...baseEnv,
      SMARTPERFETTO_OPENCODE_MODEL_JSON:
        process.env.SMARTPERFETTO_OPENCODE_MODEL_JSON || JSON.stringify({
          providerID: 'quick-e2e',
          modelID: model,
          baseURL: loopbackBaseUrl,
          apiKeyEnv: 'OPENAI_API_KEY',
          smallModel: model,
        }),
    };
  }

  throw new Error(`Unsupported runtime: ${runtimeKind}`);
}

function createPiAgentCoreModelJson(input) {
  return JSON.stringify({
    id: input.model,
    name: input.model,
    api: 'openai-completions',
    provider: 'quick-e2e',
    baseUrl: input.baseUrl,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 1024,
    apiKeyEnv: 'OPENAI_API_KEY',
    thinkingLevel: 'off',
  });
}

function formatCommand(command) {
  return command.map(formatToken).join(' ');
}

function formatToken(value) {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

function assertFile(filePath, label) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(`${label} not found: ${filePath}`);
  }
}
