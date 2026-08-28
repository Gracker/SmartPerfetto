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

const DEFAULT_RUNTIME = 'openai-agents-sdk';
const DEFAULT_TIMEOUT_MS = 20 * 60_000;
const DEEPSEEK_RUNTIME_KINDS = [
  'openai-agents-sdk',
  'pi-agent-core',
  'opencode',
];
const ALL_RUNTIME_KINDS = [
  'claude-agent-sdk',
  ...DEEPSEEK_RUNTIME_KINDS,
  'qoder-agent-sdk',
];
const CONTEXT_SUITE_NAMES = ['context-source', 'context-rag', 'context-combined'];
const SEMANTIC_DELTA_SUITE = 'code-aware-semantic-delta';
const SEMANTIC_DELTA_QUERIES = [
  {
    id: 'autonomous-diagnosis',
    kind: 'autonomous-diagnosis',
    text: '诊断这次启动变慢的主要机制，区分本次 Trace 事实与源码机制解释。',
  },
  {
    id: 'quantitative-only',
    kind: 'quantitative-only',
    text: '这个 Trace 的启动区间持续多久？只回答 Trace 中的量化事实。',
  },
  {
    id: 'explicit-source-location',
    kind: 'explicit-source-location',
    text: '指出本次启动标记对应的源码位置、调用链和最小可操作修改点。',
  },
];
const SEMANTIC_DELTA_MARKER =
  'StartupHooks.initializeOnMainThread#before-first-frame-sync-policy';
const SEMANTIC_DELTA_TRACE =
  '../Trace/.generated/constructed/source-analysis-semantic/trace.pftrace';
const SEMANTIC_DELTA_SOURCE_ROOT = 'tests/e2e/context-fixtures/app';
const SEMANTIC_DELTA_RELATIVE_SOURCE_PATH =
  'backend/tests/e2e/context-fixtures/app/StartupHooks.kt';
const SEMANTIC_DELTA_SOURCE_FILE = 'StartupHooks.kt';
const SEMANTIC_DELTA_SOURCE_SYMBOL = 'StartupHooks.initializeOnMainThread';
const SEMANTIC_DELTA_CALLER = 'Application.onCreate';
const SEMANTIC_DELTA_ACTIONABLE_SEAM = 'avoid synchronous disk I/O before first frame';
const PRIVATE_SOURCE_CANARY = 'SEMANTIC_DELTA_PRIVATE_SOURCE_CANARY_NEVER_EMIT';

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
  [SEMANTIC_DELTA_SUITE]: {
    label: 'real-provider code-aware semantic delta gate',
    output: 'test-output/code-aware-semantic-delta/real-provider',
    args: [],
  },
};

if (require.main === module) main();

function main() {
  loadBackendEnv();
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }

  assertFile(tsxCliPath, 'tsx CLI');
  assertFile(verifierPath, 'Agent SSE verifier');

  if (options.suite === SEMANTIC_DELTA_SUITE) {
    const aggregate = runCodeAwareSemanticDeltaSuite(options);
    if (aggregate.attemptFailureCount > 0) process.exitCode = 1;
    return;
  }

  const suiteNames = options.suite === 'all'
    ? ['startup', 'scrolling', 'external-issue', 'dual-trace', ...CONTEXT_SUITE_NAMES]
    : options.suite === 'context'
      ? CONTEXT_SUITE_NAMES
      : [options.suite];
  const runtimeKinds = resolveRuntimeKinds(options.runtime);

  for (const runtimeKind of runtimeKinds) {
    const availability = realProviderAvailability(runtimeKind);
    if (!availability.available) {
      throw new Error(`REAL PROVIDER NOT AVAILABLE: ${runtimeKind}: ${availability.reason}`);
    }
    for (const suiteName of suiteNames) {
      runSuite(
        suiteName,
        availability,
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
  let repeat = 1;
  let outputDir = path.resolve(
    backendRoot,
    'test-output/code-aware-semantic-delta/real-provider',
  );

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      return { suite, runtime, timeoutMs, repeat, outputDir, help: true };
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
        throw new Error('--runtime requires a value: openai-agents-sdk, pi-agent-core, opencode, qoder-agent-sdk, or all-deepseek');
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
    if (arg === '--repeat') {
      const value = Number(argv[i + 1]);
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error('--repeat requires a positive integer');
      }
      repeat = value;
      i += 1;
      continue;
    }
    if (arg === '--output-dir') {
      const value = argv[i + 1];
      if (!value) throw new Error('--output-dir requires a value');
      outputDir = path.resolve(backendRoot, value);
      i += 1;
      continue;
    }
    if (!arg.startsWith('-')) {
      suite = parseSuite(arg);
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  if (suite === SEMANTIC_DELTA_SUITE && repeat !== 5) {
    throw new Error(`${SEMANTIC_DELTA_SUITE} requires --repeat 5`);
  }

  return { suite, runtime, timeoutMs, repeat, outputDir, help: false };
}

function parseSuite(value) {
  if (value === 'all' || value === 'context' || Object.hasOwn(suites, value)) return value;
  throw new Error(`Invalid suite: ${value}. Expected all, context, or one of: ${Object.keys(suites).join(', ')}.`);
}

function parseRuntime(value) {
  if (
    value === 'all' ||
    value === 'all-deepseek' ||
    value === 'claude' ||
    value === 'claude-agent-sdk' ||
    value === 'openai' ||
    value === 'openai-agents-sdk' ||
    value === 'pi' ||
    value === 'pi-agent-core' ||
    value === 'opencode' ||
    value === 'qoder' ||
    value === 'qoder-agent-sdk'
  ) {
    return value;
  }
  throw new Error(
    `Invalid runtime: ${value}. Expected claude-agent-sdk, openai-agents-sdk, pi-agent-core, opencode, qoder-agent-sdk, all, or all-deepseek.`,
  );
}

function resolveRuntimeKinds(value) {
  if (value === 'all' || value === 'all-deepseek') return DEEPSEEK_RUNTIME_KINDS;
  if (value === 'claude') return ['claude-agent-sdk'];
  if (value === 'openai') return ['openai-agents-sdk'];
  if (value === 'pi') return ['pi-agent-core'];
  if (value === 'qoder') return ['qoder-agent-sdk'];
  return [value];
}

function printUsage() {
  console.log('Usage: node scripts/run-deepseek-agent-e2e.cjs [--suite all|context|startup|scrolling|external-issue|dual-trace|context-source|context-rag|context-combined|code-aware-semantic-delta] [--runtime claude-agent-sdk|openai-agents-sdk|pi-agent-core|opencode|qoder-agent-sdk|all|all-deepseek] [--timeout-ms <number>] [--repeat 5] [--output-dir <path>]');
  console.log('');
  console.log('Runs SmartPerfetto Agent SSE E2E with Deepseek-backed SmartPerfetto runtimes.');
  console.log('');
  console.log('Credential precedence: DEEPSEEK_API_KEY, then OPENAI_API_KEY.');
  console.log('OpenAI receives OPENAI_* pins; Pi/OpenCode receive generated Deepseek model JSON unless env already overrides it.');
  console.log('Qoder receives DeepSeek through resolveModel BYOK and still requires QODER_PERSONAL_ACCESS_TOKEN or qodercli login.');
  console.log('BYOK does not replace Qoder authentication.');
  console.log(`Each real SSE scenario has a ${DEFAULT_TIMEOUT_MS}ms default timeout; use --timeout-ms to override it.`);
  console.log('The code-aware semantic-delta suite requires --repeat 5 and writes paired-run plus aggregate JSON artifacts.');
}

function resolveSemanticRuntimeKinds(value) {
  if (value === 'all') return ALL_RUNTIME_KINDS;
  if (value === 'all-deepseek') return DEEPSEEK_RUNTIME_KINDS;
  if (value === 'claude') return ['claude-agent-sdk'];
  return resolveRuntimeKinds(value);
}

function concreteCredential(value) {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (!normalized || /^(?:your_|replace|changeme|placeholder)/i.test(normalized)) return undefined;
  return normalized;
}

function realProviderAvailability(runtimeKind, env = process.env, fileExists = fs.existsSync) {
  const deepseekApiKey = concreteCredential(
    env.DEEPSEEK_API_KEY || env.OPENAI_API_KEY,
  );
  if (DEEPSEEK_RUNTIME_KINDS.includes(runtimeKind)) {
    return deepseekApiKey
      ? {
          available: true,
          credentialKind: env.DEEPSEEK_API_KEY
            ? 'DEEPSEEK_API_KEY'
            : 'OPENAI_API_KEY',
          apiKey: deepseekApiKey,
        }
      : {
          available: false,
          reason: 'DEEPSEEK_API_KEY_OR_OPENAI_API_KEY_MISSING',
        };
  }
  if (runtimeKind === 'claude-agent-sdk') {
    const claudeCredential = concreteCredential(
      env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || env.CLAUDE_CODE_OAUTH_TOKEN,
    );
    const bedrockConfigured = Boolean(
      concreteCredential(env.AWS_BEARER_TOKEN_BEDROCK) ||
      (concreteCredential(env.AWS_ACCESS_KEY_ID) &&
        concreteCredential(env.AWS_SECRET_ACCESS_KEY)) ||
      concreteCredential(env.AWS_PROFILE),
    );
    const localClaudeCredential = fileExists(
      path.join(os.homedir(), '.claude', '.credentials.json'),
    );
    return claudeCredential || bedrockConfigured || localClaudeCredential
      ? {
          available: true,
          credentialKind: claudeCredential
            ? (env.ANTHROPIC_API_KEY
                ? 'ANTHROPIC_API_KEY'
                : env.ANTHROPIC_AUTH_TOKEN
                  ? 'ANTHROPIC_AUTH_TOKEN'
                  : 'CLAUDE_CODE_OAUTH_TOKEN')
            : bedrockConfigured
              ? 'AWS_BEDROCK_AUTH'
              : 'CLAUDE_LOCAL_LOGIN',
        }
      : {
          available: false,
          reason: 'ANTHROPIC_OR_CLAUDE_LOCAL_AUTH_MISSING',
        };
  }
  if (runtimeKind === 'qoder-agent-sdk') {
    const qoderToken = concreteCredential(env.QODER_PERSONAL_ACCESS_TOKEN);
    const qoderCliPath = concreteCredential(env.QODERCLI_PATH);
    const missingReasons = [
      ...(!deepseekApiKey ? ['DEEPSEEK_API_KEY_OR_OPENAI_API_KEY_MISSING'] : []),
      ...(!qoderToken && !qoderCliPath
        ? ['QODER_PERSONAL_ACCESS_TOKEN_OR_QODERCLI_PATH_MISSING']
        : []),
    ];
    if (missingReasons.length > 0) {
      return {
        available: false,
        reason: missingReasons.join(';'),
      };
    }
    return {
      available: true,
      credentialKind: qoderToken ? 'QODER_PERSONAL_ACCESS_TOKEN' : 'QODERCLI_PATH',
      apiKey: deepseekApiKey,
    };
  }
  return {available: false, reason: 'UNSUPPORTED_RUNTIME'};
}

function buildSemanticChildEnv(runtimeKind, availability, isolatedRoot) {
  if (runtimeKind !== 'claude-agent-sdk') {
    return buildChildEnv(availability.apiKey, runtimeKind, isolatedRoot);
  }
  return {
    ...process.env,
    SMARTPERFETTO_AGENT_RUNTIME: 'claude-agent-sdk',
    DOTENV_CONFIG_QUIET: 'true',
    SMARTPERFETTO_BACKEND_DATA_DIR: path.join(isolatedRoot, 'data'),
    SMARTPERFETTO_BACKEND_LOG_DIR: path.join(isolatedRoot, 'logs'),
    SMARTPERFETTO_TRACE_UPLOAD_DIR: path.join(isolatedRoot, 'uploads', 'traces'),
    SMARTPERFETTO_CODEBASE_ROOTS: path.join(
      backendRoot,
      'tests/e2e/context-fixtures/app',
    ),
  };
}

function semanticDeltaQueries() {
  return SEMANTIC_DELTA_QUERIES.map(query => ({...query}));
}

function semanticConditionArgs(query, condition, outputPath, timeoutMs) {
  const args = [
    '--mode', 'full',
    '--provider-id', 'env',
    '--trace', SEMANTIC_DELTA_TRACE,
    '--query', query.text,
    '--output', outputPath,
    '--timeout-ms', String(timeoutMs),
    '--require-non-partial',
    '--require-claim-verifier-ok',
    '--require-text', SEMANTIC_DELTA_MARKER,
    '--forbid-text', PRIVATE_SOURCE_CANARY,
  ];
  if (condition === 'A0') {
    args.push(
      '--code-aware', 'off',
      '--forbid-text', SEMANTIC_DELTA_RELATIVE_SOURCE_PATH,
      '--forbid-text', SEMANTIC_DELTA_SOURCE_FILE,
      '--forbid-text', SEMANTIC_DELTA_SOURCE_SYMBOL,
      '--forbid-text', SEMANTIC_DELTA_CALLER,
      '--forbid-text', SEMANTIC_DELTA_ACTIONABLE_SEAM,
      '--forbid-text', '[Code:',
    );
    return args;
  }
  args.push(
    '--setup-codebase-root', SEMANTIC_DELTA_SOURCE_ROOT,
    '--setup-codebase-mode', condition === 'A2' ? 'register-only' : 'register-and-index',
    '--code-aware', 'provider_send',
  );
  if (query.kind !== 'quantitative-only') {
    args.push(
      '--require-code-ref',
      '--require-text', SEMANTIC_DELTA_SOURCE_FILE,
      '--require-text', SEMANTIC_DELTA_SOURCE_SYMBOL,
      '--require-text', SEMANTIC_DELTA_CALLER,
      '--require-text', SEMANTIC_DELTA_ACTIONABLE_SEAM,
    );
  }
  return args;
}

function sanitizeDiagnostic(value) {
  let sanitized = String(value || '').slice(0, 1000);
  const sensitiveValues = [
    process.env.DEEPSEEK_API_KEY,
    process.env.OPENAI_API_KEY,
    process.env.ANTHROPIC_API_KEY,
    process.env.ANTHROPIC_AUTH_TOKEN,
    process.env.CLAUDE_CODE_OAUTH_TOKEN,
    process.env.QODER_PERSONAL_ACCESS_TOKEN,
  ].map(concreteCredential).filter(Boolean);
  for (const secret of sensitiveValues) sanitized = sanitized.split(secret).join('<redacted-secret>');
  return sanitized
    .split(backendRoot).join('<backend-root>')
    .split(os.homedir()).join('<home>')
    .replace(/\s+/g, ' ')
    .trim();
}

function evaluateSemanticConditionReport(input) {
  const {report, query, condition, sourceRoot} = input;
  const summary = report?.summary;
  const serialized = report ? JSON.stringify(report) : '';
  const privacyPassed = Boolean(report) &&
    !serialized.includes(sourceRoot) &&
    !serialized.includes(PRIVATE_SOURCE_CANARY) &&
    !serialized.includes('val startupPolicy =');
  const setup = report?.analysisContext?.setup?.codebases?.[0];
  const provenancePassed = condition === 'A0'
    ? Array.isArray(report?.analysisContext?.codebaseIds) &&
      report.analysisContext.codebaseIds.length === 0
    : condition === 'A2'
      ? setup?.setupMode === 'register-only' &&
        setup?.chunkCount === 0 &&
        setup?.activeIndexState === 'none' &&
        setup?.activeGeneration === undefined &&
        setup?.pendingGeneration === false &&
        setup?.reindexRequests === 0
      : setup?.setupMode === 'register-and-index' &&
        setup?.reindexRequests === 1 &&
        setup?.chunkCount > 0 &&
        setup?.activeIndexState === 'active' &&
        typeof setup?.activeGeneration === 'string' &&
        setup?.pendingGeneration === false;
  const traceClaimPassed = summary?.claimVerifierStatus === 'passed' &&
    summary?.claimVerifierPassed === true &&
    (summary?.claimVerifierCheckedClaimCount || 0) > 0 &&
    (summary?.claimVerifierUnsupportedClaimCount || 0) === 0;
  const traceFactPassed =
    summary?.requiredTextMatches?.[SEMANTIC_DELTA_MARKER] === true &&
    traceClaimPassed;
  const sourceToolCount = ['search_codebase', 'read_codebase_file', 'lookup_app_source']
    .reduce((count, tool) => count + (summary?.toolCallCounts?.[tool] || 0), 0);
  const forbiddenMatches = summary?.forbiddenTextMatches || {};
  const sourceLeakFree = condition !== 'A0' || (
    [
      SEMANTIC_DELTA_RELATIVE_SOURCE_PATH,
      SEMANTIC_DELTA_SOURCE_FILE,
      SEMANTIC_DELTA_SOURCE_SYMBOL,
      SEMANTIC_DELTA_CALLER,
      SEMANTIC_DELTA_ACTIONABLE_SEAM,
      '[Code:',
    ].every(text => forbiddenMatches[text] !== true) &&
    summary?.conclusionHasConcreteCodeRefs !== true &&
    summary?.analysisCompletedHasConcreteCodeRefs !== true &&
    (summary?.analysisCompletedSourceReferenceCount || 0) === 0 &&
    (summary?.analysisCompletedSourceBindingCount || 0) === 0 &&
    sourceToolCount === 0
  );
  const mechanismStatuses = Array.isArray(summary?.analysisCompletedSourceMechanismStatuses)
    ? summary.analysisCompletedSourceMechanismStatuses
    : [];
  const sourceBindingPassed =
    summary?.analysisCompletedSourceClaimVerifierStatus === 'passed' &&
    summary?.analysisCompletedSourceReferenceMembershipPassed === true &&
    mechanismStatuses.length > 0 &&
    mechanismStatuses.every(status => status === 'corroborated' || status === 'compatible');
  const sourceSemanticPassed = query?.kind === 'quantitative-only'
    ? sourceToolCount === 0 &&
      (
        condition === 'A0' ||
        (
          summary?.analysisCompletedSourceUseStatus === 'not_needed' &&
          summary?.analysisCompletedSourceReferenceCount === 0
        )
      )
    : summary?.requiredTextMatches?.[SEMANTIC_DELTA_SOURCE_FILE] === true &&
      summary?.requiredTextMatches?.[SEMANTIC_DELTA_SOURCE_SYMBOL] === true &&
      summary?.requiredTextMatches?.[SEMANTIC_DELTA_CALLER] === true &&
      summary?.requiredTextMatches?.[SEMANTIC_DELTA_ACTIONABLE_SEAM] === true &&
      (
        summary?.conclusionHasConcreteCodeRefs === true ||
        summary?.analysisCompletedHasConcreteCodeRefs === true
      ) &&
      summary?.analysisCompletedSourceUseStatus === 'corroborated' &&
      (summary?.analysisCompletedSourceReferenceCount || 0) > 0 &&
      (summary?.analysisCompletedSourceBindingCount || 0) > 0 &&
      sourceBindingPassed;
  return {
    privacyPassed,
    provenancePassed,
    traceFactPassed,
    sourceLeakFree,
    sourceBindingPassed,
    sourceSemanticPassed,
  };
}

function runSemanticCondition(input) {
  const reportPath = path.join(input.attemptDir, input.query.id, `${input.condition}.json`);
  const args = semanticConditionArgs(input.query, input.condition, reportPath, input.timeoutMs);
  const result = spawnSync(process.execPath, [tsxCliPath, verifierPath, ...args], {
    cwd: backendRoot,
    env: buildSemanticChildEnv(input.runtimeKind, input.availability, input.isolatedRoot),
    encoding: 'utf8',
    timeout: input.timeoutMs + 60_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const report = fs.existsSync(reportPath)
    ? JSON.parse(fs.readFileSync(reportPath, 'utf8'))
    : undefined;
  const sourceRoot = path.resolve(backendRoot, SEMANTIC_DELTA_SOURCE_ROOT);
  const evaluation = evaluateSemanticConditionReport({
    report,
    query: input.query,
    condition: input.condition,
    sourceRoot,
  });
  return {
    queryId: input.query.id,
    queryKind: input.query.kind,
    condition: input.condition,
    report: path.relative(input.outputDir, reportPath).split(path.sep).join('/'),
    exitCode: result.status,
    passed: result.status === 0 && report?.passed === true,
    hardAssertions: {
      privacyPassed: evaluation.privacyPassed,
      provenancePassed: evaluation.provenancePassed,
      traceFactPassed: evaluation.traceFactPassed,
      sourceLeakFree: evaluation.sourceLeakFree,
    },
    sourceBindingPassed: evaluation.sourceBindingPassed,
    sourceSemanticPassed: evaluation.sourceSemanticPassed,
    diagnostic: result.status === 0
      ? undefined
      : sanitizeDiagnostic(result.stderr || result.stdout || result.error?.message),
  };
}

function runSemanticPairedAttempt(input) {
  const attemptDir = path.join(
    input.outputDir,
    input.runtimeKind,
    `run-${String(input.attempt).padStart(2, '0')}`,
  );
  fs.mkdirSync(attemptDir, {recursive: true});
  const isolatedRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'smartperfetto-semantic-delta-'),
  );
  try {
    const queryRuns = semanticDeltaQueries().map(query => ({
      query,
      conditions: ['A0', 'A2', 'A3'].map(condition => runSemanticCondition({
        ...input,
        query,
        condition,
        attemptDir,
        isolatedRoot,
      })),
    }));
    const conditions = queryRuns.flatMap(run => run.conditions);
    const hardPassed = conditions.every(condition =>
      condition.passed && Object.values(condition.hardAssertions).every(Boolean));
    const noTraceRegression = conditions.every(condition => condition.hardAssertions.traceFactPassed);
    const sourceUpliftPassed = queryRuns
      .filter(run => run.query.kind !== 'quantitative-only')
      .every(run => {
        const a0 = run.conditions.find(condition => condition.condition === 'A0');
        const a2 = run.conditions.find(condition => condition.condition === 'A2');
        const a3 = run.conditions.find(condition => condition.condition === 'A3');
        return a0?.hardAssertions.sourceLeakFree === true &&
          !a0?.sourceSemanticPassed &&
          a2?.sourceSemanticPassed &&
          a3?.sourceSemanticPassed;
      });
    const quantitativeNotNeededPassed = queryRuns
      .filter(run => run.query.kind === 'quantitative-only')
      .every(run => run.conditions.every(condition => condition.sourceSemanticPassed));
    return {
      schemaVersion: 'code_aware_semantic_delta_real_run@1',
      runtime: input.runtimeKind,
      attempt: input.attempt,
      queries: queryRuns,
      hardPassed,
      noTraceRegression,
      quantitativeNotNeededPassed,
      sourceUpliftPassed: sourceUpliftPassed && quantitativeNotNeededPassed && noTraceRegression,
    };
  } finally {
    fs.rmSync(isolatedRoot, {recursive: true, force: true});
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), {recursive: true});
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function runCodeAwareSemanticDeltaSuite(options) {
  fs.mkdirSync(options.outputDir, {recursive: true});
  const runtimeKinds = resolveSemanticRuntimeKinds(options.runtime);
  const runtimeResults = [];
  let attemptFailureCount = 0;
  for (const runtimeKind of runtimeKinds) {
    const availability = realProviderAvailability(runtimeKind);
    if (!availability.available) {
      runtimeResults.push({
        runtime: runtimeKind,
        status: 'REAL PROVIDER NOT AVAILABLE',
        reason: availability.reason,
        attemptsRequired: options.repeat,
        attemptsRun: 0,
        hardPassCount: 0,
        sourceUpliftPassCount: 0,
      });
      continue;
    }
    const records = [];
    for (let attempt = 1; attempt <= options.repeat; attempt += 1) {
      const record = runSemanticPairedAttempt({
        runtimeKind,
        attempt,
        timeoutMs: options.timeoutMs,
        outputDir: options.outputDir,
        availability,
      });
      records.push(record);
      writeJson(
        path.join(
          options.outputDir,
          runtimeKind,
          `paired-run-${String(attempt).padStart(2, '0')}.json`,
        ),
        record,
      );
    }
    const hardPassCount = records.filter(record => record.hardPassed).length;
    const sourceUpliftPassCount = records.filter(record => record.sourceUpliftPassed).length;
    const passed = hardPassCount === options.repeat &&
      sourceUpliftPassCount >= Math.ceil(options.repeat * 0.8);
    if (!passed) attemptFailureCount += 1;
    runtimeResults.push({
      runtime: runtimeKind,
      status: passed ? 'REAL PROVIDER PASSED' : 'REAL PROVIDER FAILED',
      credentialKind: availability.credentialKind,
      attemptsRequired: options.repeat,
      attemptsRun: records.length,
      hardPassCount,
      sourceUpliftPassCount,
      hardAcceptance: `${hardPassCount}/${options.repeat}`,
      semanticAcceptance: `${sourceUpliftPassCount}/${options.repeat}`,
    });
  }
  const aggregate = {
    schemaVersion: 'code_aware_semantic_delta_real_aggregate@1',
    suite: SEMANTIC_DELTA_SUITE,
    repeat: options.repeat,
    queries: semanticDeltaQueries(),
    deterministicCoverage: {
      A1: 'verify:code-aware-semantic-delta',
      A4: 'verify:code-aware-semantic-delta',
    },
    hardRequirement: `${options.repeat}/${options.repeat}`,
    semanticRequirement: `${Math.ceil(options.repeat * 0.8)}/${options.repeat}`,
    runtimeResults,
    attemptFailureCount,
    completeAcceptance: runtimeResults.length > 0 &&
      runtimeResults.every(runtime => runtime.status === 'REAL PROVIDER PASSED'),
  };
  writeJson(path.join(options.outputDir, 'aggregate.json'), aggregate);
  console.log(JSON.stringify(aggregate, null, 2));
  console.log(`Real-provider aggregate written to: ${path.join(options.outputDir, 'aggregate.json')}`);
  return aggregate;
}

function loadBackendEnv() {
  const envPath = path.join(backendRoot, '.env');
  if (!fs.existsSync(envPath)) return;
  // Load local untracked provider credentials before this wrapper validates them.
  require('dotenv').config({ path: envPath, quiet: true });
}

function runSuite(suiteName, availability, runtimeKind, runtimeSpecificOutput, timeoutMs) {
  const suite = suites[suiteName];
  const suiteArgs = runtimeSpecificOutput
    ? withRuntimeOutputPath(suite.args, suite.output, runtimeKind)
    : suite.args;
  const args = [...suiteArgs, '--timeout-ms', String(timeoutMs)];
  console.log(`\n[deepseek-e2e] suite=${suiteName} (${suite.label})`);
  console.log(`[deepseek-e2e] runtime=${runtimeKind}`);
  console.log(`[deepseek-e2e] output=${getOutputPathFromArgs(args) || suite.output}`);
  console.log(`[deepseek-e2e] credential=${availability.credentialKind}`);

  const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-deepseek-e2e-'));
  try {
    const result = spawnSync(process.execPath, [tsxCliPath, verifierPath, ...args], {
      cwd: backendRoot,
      env: buildSemanticChildEnv(runtimeKind, availability, isolatedRoot),
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

  if (runtimeKind === 'qoder-agent-sdk') {
    return {
      ...baseEnv,
      SMARTPERFETTO_AGENT_RUNTIME: 'qoder-agent-sdk',
      QODER_MODEL: deepseekModel,
      QODER_LIGHT_MODEL: deepseekLightModel,
      QODER_BYOK_API_KEY: apiKey,
      QODER_BYOK_PROVIDER: 'deepseek',
      QODER_BYOK_BASE_URL: deepseekBaseUrl,
      QODER_BYOK_STYLE: 'openai',
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

module.exports = {
  buildChildEnv,
  evaluateSemanticConditionReport,
  parseArgs,
  realProviderAvailability,
  semanticConditionArgs,
  semanticDeltaQueries,
};
