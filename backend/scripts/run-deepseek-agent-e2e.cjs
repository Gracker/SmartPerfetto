#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const backendRoot = path.resolve(__dirname, '..');
const verifierPath = path.join(backendRoot, 'src/scripts/verifyAgentSseScrolling.ts');
const tsxCliPath = path.join(backendRoot, 'node_modules/tsx/dist/cli.mjs');

loadBackendEnv();

const DEFAULT_RUNTIME = 'openai-agents-sdk';
const DEFAULT_TIMEOUT_MS = 20 * 60_000;
const DEEPSEEK_RUNTIME_KINDS = [
  'openai-agents-sdk',
  'pi-agent-core',
  'opencode',
];
const CONTEXT_SUITE_NAMES = ['context-source', 'context-rag', 'context-combined'];

const suites = {
  startup: {
    label: 'startup final-report gate',
    output: 'test-output/e2e-deepseek-startup-real.json',
    args: [
      '--mode',
      'full',
      '--provider-id',
      'env',
      '--trace',
      '../Trace/real/android-startup-heavy/trace.pftrace',
      '--query',
      '分析启动性能',
      '--output',
      'test-output/e2e-deepseek-startup-real.json',
      '--keep-session',
      '--require-conclusion-evidence',
      '--require-claim-verifier-ok',
      '--require-non-partial',
      '--require-final-report-heading',
      '--forbid-process-narration',
      '--forbid-degraded-fallback',
      'completed_plan_summary_fallback',
      '--require-text',
      '冷启动',
      '--require-text',
      'ChaosTask',
      '--forbid-text',
      '完成综合结论输出',
      '--forbid-text',
      '分阶段证据摘要',
      '--forbid-text',
      '完整结构化报告已生成',
      '--forbid-text',
      '应维持温启动',
      '--forbid-text',
      'bindApplication 不存在',
    ],
  },
  scrolling: {
    label: 'scrolling full analysis gate',
    output: 'test-output/e2e-deepseek-scrolling-real.json',
    args: [
      '--mode',
      'full',
      '--provider-id',
      'env',
      '--trace',
      '../Trace/real/android-scroll-customer/trace.pftrace',
      '--query',
      '分析滑动性能',
      '--output',
      'test-output/e2e-deepseek-scrolling-real.json',
      '--keep-session',
      '--require-non-partial',
      '--require-tool',
      'invoke_skill',
      '--require-skill',
      'scrolling_analysis',
      '--require-skill',
      'jank_frame_detail',
      '--require-skill',
      'frame_blocking_calls',
      '--require-skill',
      'blocking_chain_analysis',
      '--forbid-degraded-fallback',
      'verification_failed',
    ],
  },
  'external-issue': {
    label: 'M10 Agent-assisted external issue triage gate',
    output: 'test-output/e2e-deepseek-external-issue-real.json',
    args: [
      '--mode',
      'full',
      '--provider-id',
      'env',
      '--trace',
      '../Trace/real/android-startup-heavy/trace.pftrace',
      '--query',
      '这是反馈路径验证：请明确调用 anr_analysis 检查这个启动 Trace 是否包含 ANR；即使结果为空也必须如实完成分析，不要编造。',
      '--output',
      'test-output/e2e-deepseek-external-issue-real.json',
      '--keep-session',
      '--require-tool',
      'invoke_skill',
      '--require-skill',
      'anr_analysis',
      '--require-non-partial',
      '--require-external-issue-triage',
      '--forbid-degraded-fallback',
      'verification_failed',
    ],
  },
  'dual-trace': {
    label: 'raw dual-trace comparison gate',
    output: 'test-output/e2e-deepseek-dual-trace-real.json',
    args: [
      '--mode',
      'full',
      '--provider-id',
      'env',
      '--trace',
      '../Trace/real/android-startup-heavy/trace.pftrace',
      '--reference-trace',
      '../Trace/real/android-startup-light/trace.pftrace',
      '--query',
      '对比左右两个 Trace 的启动速度差异。请先读取窗口映射，然后用 compare_skill 跑 startup_analysis 对比冷启动阶段，最后用证据说明哪边更慢。',
      '--output',
      'test-output/e2e-deepseek-dual-trace-real.json',
      '--keep-session',
      '--require-claim-verifier-ok',
      '--require-non-partial',
      '--require-tool',
      'get_comparison_context',
      '--require-tool',
      'compare_skill',
      '--require-data-envelope',
      '--require-text',
      'com.example.launch.aosp.heavy',
      '--require-text',
      'com.example.androidappdemo',
      '--forbid-degraded-fallback',
      'verification_failed',
      '--trace-pair-layout',
      'horizontal',
      '--trace-pair-workspace-open',
      '--trace-pair-split',
      '58',
      '--trace-pair-active',
      'current',
    ],
  },
  'context-source': {
    label: 'request-scoped source-only analysis gate',
    output: 'test-output/e2e-deepseek-context-source-real.json',
    args: [
      '--mode', 'full',
      '--provider-id', 'env',
      '--trace', '../Trace/real/android-startup-heavy/trace.pftrace',
      '--query',
      '分析启动性能。必须先用 lookup_app_source 查询 StartupHooks，并在最终报告引用 StartupHooks.kt；源码只能解释候选机制，Trace 证据才可证明本次发生。',
      '--setup-codebase-root', 'tests/e2e/context-fixtures/app',
      '--code-aware', 'provider_send',
      '--output', 'test-output/e2e-deepseek-context-source-real.json',
      '--require-tool', 'lookup_app_source',
      '--require-successful-lookup', 'lookup_app_source',
      '--require-code-ref',
      '--require-text', 'StartupHooks.kt',
      '--require-non-partial',
      '--forbid-degraded-fallback', 'verification_failed',
      '--forbid-degraded-fallback', 'partial_result_after_incomplete_plan',
    ],
  },
  'context-rag': {
    label: 'request-scoped external-RAG-only analysis gate',
    output: 'test-output/e2e-deepseek-context-rag-real.json',
    args: [
      '--mode', 'full',
      '--provider-id', 'env',
      '--trace', '../Trace/real/android-startup-heavy/trace.pftrace',
      '--query',
      '分析启动性能。必须用 lookup_blog_knowledge，将 source 设为 android_internals_wiki，并以 "Startup first-frame knowledge fixture" 为 query 检索；综合其中关于首帧前同步主线程工作的背景知识，但不要复述私有 Wiki 原文。知识库只能作为背景知识，不能替代 Trace 证据。',
      '--setup-knowledge-root', 'tests/e2e/context-fixtures/wiki',
      '--code-aware', 'off',
      '--output', 'test-output/e2e-deepseek-context-rag-real.json',
      '--require-tool', 'lookup_blog_knowledge',
      '--require-successful-lookup', 'lookup_blog_knowledge',
      '--require-non-partial',
      '--forbid-degraded-fallback', 'verification_failed',
      '--forbid-degraded-fallback', 'partial_result_after_incomplete_plan',
    ],
  },
  'context-combined': {
    label: 'request-scoped source plus external-RAG analysis gate',
    output: 'test-output/e2e-deepseek-context-combined-real.json',
    args: [
      '--mode', 'full',
      '--provider-id', 'env',
      '--trace', '../Trace/real/android-startup-heavy/trace.pftrace',
      '--query',
      '分析启动性能。必须分别调用 lookup_app_source 查询 StartupHooks；调用 lookup_blog_knowledge 时将 source 设为 android_internals_wiki，并以 "Startup first-frame knowledge fixture" 为 query 检索。在结论引用 StartupHooks.kt，并综合 Wiki 中关于首帧前同步主线程工作的背景知识，但不要复述私有 Wiki 原文；两类上下文都不能替代 Trace 证据。',
      '--setup-codebase-root', 'tests/e2e/context-fixtures/app',
      '--setup-knowledge-root', 'tests/e2e/context-fixtures/wiki',
      '--code-aware', 'provider_send',
      '--output', 'test-output/e2e-deepseek-context-combined-real.json',
      '--require-tool', 'lookup_app_source',
      '--require-tool', 'lookup_blog_knowledge',
      '--require-successful-lookup', 'lookup_app_source',
      '--require-successful-lookup', 'lookup_blog_knowledge',
      '--require-code-ref',
      '--require-text', 'StartupHooks.kt',
      '--require-non-partial',
      '--forbid-degraded-fallback', 'verification_failed',
      '--forbid-degraded-fallback', 'partial_result_after_incomplete_plan',
    ],
  },
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

  const credential = resolveDeepseekCredential();
  const suiteNames = options.suite === 'all'
    ? ['startup', 'scrolling', 'external-issue', 'dual-trace', ...CONTEXT_SUITE_NAMES]
    : options.suite === 'context'
      ? CONTEXT_SUITE_NAMES
      : [options.suite];
  const runtimeKinds = resolveRuntimeKinds(options.runtime);

  for (const runtimeKind of runtimeKinds) {
    for (const suiteName of suiteNames) {
      runSuite(
        suiteName,
        credential,
        runtimeKind,
        runtimeKinds.length > 1 || options.runtime !== DEFAULT_RUNTIME,
        options.timeoutMs,
      );
    }
  }

  console.log(`\nDeepseek Agent SSE E2E passed: ${runtimeKinds.join(', ')} / ${suiteNames.join(', ')}`);
}

function parseArgs(argv) {
  let suite = 'all';
  let runtime = DEFAULT_RUNTIME;
  let timeoutMs = DEFAULT_TIMEOUT_MS;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      return { suite, runtime, help: true };
    }
    if (arg === '--suite') {
      const value = argv[i + 1];
      if (!value) throw new Error('--suite requires a value');
      suite = parseSuite(value);
      i += 1;
      continue;
    }
    if (arg === '--runtime') {
      const value = argv[i + 1];
      if (!value) {
        throw new Error('--runtime requires a value: openai-agents-sdk, pi-agent-core, opencode, or all-deepseek');
      }
      runtime = parseRuntime(value);
      i += 1;
      continue;
    }
    if (arg === '--timeout-ms') {
      const value = Number(argv[i + 1]);
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error('--timeout-ms requires a positive integer');
      }
      timeoutMs = value;
      i += 1;
      continue;
    }
    if (!arg.startsWith('-')) {
      suite = parseSuite(arg);
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  return { suite, runtime, timeoutMs, help: false };
}

function parseSuite(value) {
  if (value === 'all' || value === 'context' || Object.hasOwn(suites, value)) return value;
  throw new Error(`Invalid suite: ${value}. Expected all, context, or one of: ${Object.keys(suites).join(', ')}.`);
}

function parseRuntime(value) {
  if (
    value === 'all' ||
    value === 'all-deepseek' ||
    value === 'openai' ||
    value === 'openai-agents-sdk' ||
    value === 'pi' ||
    value === 'pi-agent-core' ||
    value === 'opencode'
  ) {
    return value;
  }
  throw new Error(
    `Invalid runtime: ${value}. Expected openai-agents-sdk, pi-agent-core, opencode, or all-deepseek.`,
  );
}

function resolveRuntimeKinds(value) {
  if (value === 'all' || value === 'all-deepseek') return DEEPSEEK_RUNTIME_KINDS;
  if (value === 'openai') return ['openai-agents-sdk'];
  if (value === 'pi') return ['pi-agent-core'];
  return [value];
}

function printUsage() {
  console.log('Usage: node scripts/run-deepseek-agent-e2e.cjs [--suite all|context|startup|scrolling|external-issue|dual-trace|context-source|context-rag|context-combined] [--runtime openai-agents-sdk|pi-agent-core|opencode|all-deepseek] [--timeout-ms <number>]');
  console.log('');
  console.log('Runs SmartPerfetto Agent SSE E2E with Deepseek-backed SmartPerfetto runtimes.');
  console.log('');
  console.log('Credential precedence: DEEPSEEK_API_KEY, then OPENAI_API_KEY.');
  console.log('OpenAI receives OPENAI_* pins; Pi/OpenCode receive generated Deepseek model JSON unless env already overrides it.');
  console.log(`Each real SSE scenario has a ${DEFAULT_TIMEOUT_MS}ms default timeout; use --timeout-ms to override it.`);
}

function loadBackendEnv() {
  const envPath = path.join(backendRoot, '.env');
  if (!fs.existsSync(envPath)) return;
  // Load local untracked provider credentials before this wrapper validates them.
  require('dotenv').config({ path: envPath, quiet: true });
}

function resolveDeepseekCredential() {
  const source = process.env.DEEPSEEK_API_KEY ? 'DEEPSEEK_API_KEY' : 'OPENAI_API_KEY';
  const apiKey = process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey || apiKey.trim() === '') {
    throw new Error(
      'DEEPSEEK_API_KEY or OPENAI_API_KEY is required. Use a local untracked env file or GitHub secret DEEPSEEK_API_KEY; do not commit provider keys.',
    );
  }
  return { apiKey, source };
}

function runSuite(suiteName, credential, runtimeKind, runtimeSpecificOutput, timeoutMs) {
  const suite = suites[suiteName];
  const suiteArgs = runtimeSpecificOutput
    ? withRuntimeOutputPath(suite.args, suite.output, runtimeKind)
    : suite.args;
  const args = [...suiteArgs, '--timeout-ms', String(timeoutMs)];
  console.log(`\n[deepseek-e2e] suite=${suiteName} (${suite.label})`);
  console.log(`[deepseek-e2e] runtime=${runtimeKind}`);
  console.log(`[deepseek-e2e] output=${getOutputPathFromArgs(args) || suite.output}`);
  console.log(`[deepseek-e2e] credential=${credential.source}`);

  const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-deepseek-e2e-'));
  try {
    const result = spawnSync(process.execPath, [tsxCliPath, verifierPath, ...args], {
      cwd: backendRoot,
      env: buildChildEnv(credential.apiKey, runtimeKind, isolatedRoot),
      stdio: 'inherit',
    });

    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      process.exit(result.status ?? 1);
    }
  } finally {
    fs.rmSync(isolatedRoot, {recursive: true, force: true});
  }
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

function buildChildEnv(apiKey, runtimeKind, isolatedRoot) {
  const deepseekBaseUrl = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1';
  const deepseekModel = process.env.DEEPSEEK_MODEL || 'deepseek-v4-pro';
  const deepseekLightModel = process.env.DEEPSEEK_LIGHT_MODEL || 'deepseek-v4-flash';
  const baseEnv = {
    ...process.env,
    DEEPSEEK_API_KEY: apiKey,
    OPENAI_API_KEY: apiKey,
    OPENAI_BASE_URL: deepseekBaseUrl,
    OPENAI_MODEL: deepseekModel,
    OPENAI_LIGHT_MODEL: deepseekLightModel,
    OPENAI_MAX_OUTPUT_TOKENS: '8192',
    DOTENV_CONFIG_QUIET: 'true',
    SMARTPERFETTO_BACKEND_DATA_DIR: path.join(isolatedRoot, 'data'),
    SMARTPERFETTO_BACKEND_LOG_DIR: path.join(isolatedRoot, 'logs'),
    SMARTPERFETTO_TRACE_UPLOAD_DIR: path.join(isolatedRoot, 'uploads', 'traces'),
    SMARTPERFETTO_CODEBASE_ROOTS: path.join(backendRoot, 'tests/e2e/context-fixtures/app'),
    SMARTPERFETTO_KNOWLEDGE_ROOTS: path.join(backendRoot, 'tests/e2e/context-fixtures/wiki'),
  };

  if (runtimeKind === 'openai-agents-sdk') {
    return {
      ...baseEnv,
      SMARTPERFETTO_AGENT_RUNTIME: 'openai-agents-sdk',
      OPENAI_AGENTS_PROTOCOL: 'chat_completions',
    };
  }

  if (runtimeKind === 'pi-agent-core') {
    return {
      ...baseEnv,
      SMARTPERFETTO_AGENT_RUNTIME: 'pi-agent-core',
      SMARTPERFETTO_PI_AGENT_CORE_MODEL_JSON:
        process.env.SMARTPERFETTO_PI_AGENT_CORE_MODEL_JSON || createPiAgentCoreDeepseekModelJson({
          model: deepseekModel,
          baseUrl: deepseekBaseUrl,
        }),
    };
  }

  if (runtimeKind === 'opencode') {
    return {
      ...baseEnv,
      SMARTPERFETTO_AGENT_RUNTIME: 'opencode',
      SMARTPERFETTO_OPENCODE_MODEL_JSON:
        process.env.SMARTPERFETTO_OPENCODE_MODEL_JSON || JSON.stringify({
          providerID: 'deepseek',
          modelID: deepseekModel,
          baseURL: deepseekBaseUrl,
          apiKeyEnv: 'DEEPSEEK_API_KEY',
          smallModel: deepseekLightModel,
        }),
    };
  }

  throw new Error(`Unsupported runtime: ${runtimeKind}`);
}

function createPiAgentCoreDeepseekModelJson({ model, baseUrl }) {
  return JSON.stringify({
    id: model,
    name: model,
    api: 'openai-completions',
    provider: 'deepseek',
    baseUrl,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    thinkingLevel: 'off',
  });
}

function assertFile(filePath, label) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(`${label} not found: ${filePath}`);
  }
}
