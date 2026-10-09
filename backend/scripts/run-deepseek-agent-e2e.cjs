#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { isDeepStrictEqual } = require('node:util');

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
const SYSTEM_ANALYSIS_SUITE = 'system-analysis';
// Flagship scene gates: expectations live in files, never inline in this wrapper.
const FLAGSHIP_SUITE = 'flagship';
const FLAGSHIP_SUITE_NAMES = ['startup', 'scrolling'];
const FLAGSHIP_EXPECTATIONS = {
  startup: 'tests/e2e/flagship/startup-heavy.expectation.json',
  scrolling: 'tests/e2e/flagship/scrolling-customer.expectation.json',
};
const FLAGSHIP_SUMMARY_SCHEMA = 'agent_sse_flagship_summary@1';
const FLAGSHIP_SUMMARY_DIR = 'test-output/e2e-baselines';
// A baseline older than this is still compared, but only as visibly stale local diagnosis.
const FLAGSHIP_BASELINE_STALE_MS = 14 * 24 * 60 * 60 * 1000;
const FLAGSHIP_CHECK_GROUPS = ['value', 'proof', 'delivery'];
const FLAGSHIP_FINGERPRINT_KEYS = ['suite', 'runtime', 'traceSha256', 'query', 'expectationHash', 'providerOrigin', 'model',
  'commit', 'gateSchemaVersion', 'verificationSchemaVersion', 'traceProcessorVersion', 'stdlibRevision'];
const SEMANTIC_DELTA_QUERIES = [
  {
    id: 'autonomous-diagnosis',
    kind: 'autonomous-diagnosis',
    text: '诊断选中的启动标记区间的主要耗时机制，区分本次 Trace 事实与源码机制解释。',
  },
  {
    id: 'quantitative-only',
    kind: 'quantitative-only',
    text: 'Trace 中 StartupHooks.initializeOnMainThread#before-first-frame-sync-policy 这个标记区间持续多久？只回答 Trace 中的量化事实。',
  },
  {
    id: 'explicit-source-location',
    kind: 'explicit-source-location',
    text: '指出本次启动标记对应的源码位置、调用链和最小可操作修改点。',
  },
];
const SEMANTIC_DELTA_TRACE =
  '../Trace/.generated/constructed/source-analysis-semantic/trace.pftrace';
const SEMANTIC_DELTA_SOURCE_ROOT = 'tests/e2e/context-fixtures/app';
const SEMANTIC_DELTA_RELATIVE_SOURCE_PATH =
  'backend/tests/e2e/context-fixtures/app/StartupHooks.kt';
const SEMANTIC_DELTA_SOURCE_FILE = 'StartupHooks.kt';
const PRIVATE_SOURCE_CANARY = 'SEMANTIC_DELTA_PRIVATE_SOURCE_CANARY_NEVER_EMIT';

// Independent FrameTimeline population oracle for these E2E suites:
// count one frame per (upid, frame_id), including separate process instances.
// The slice-id fallback is prefixed: a slice id is not a frame token and must
// not merge with a token of the same digits.
const FRAME_FACT_SQL = `INCLUDE PERFETTO MODULE android.frames.timeline;
WITH per_frame AS (
  SELECT upid, COALESCE(NULLIF(name, ''), CAST(surface_frame_token AS TEXT),
    CAST(display_frame_token AS TEXT), 'slice:' || id) AS frame_id,
    MAX(CASE WHEN jank_type IS NOT NULL AND jank_type != 'None' THEN 1 ELSE 0 END) AS is_jank
  FROM actual_frame_timeline_slice WHERE ts IS NOT NULL AND dur IS NOT NULL AND dur >= 0
  GROUP BY upid, frame_id
)
SELECT COUNT(*) AS total_frames, COALESCE(SUM(is_jank), 0) AS jank_frames FROM per_frame`;

function frameFactExpectation({taskKind = 'fact', deliverable = 'answer', scope = 'bounded_question', withJank = false} = {}) {
  return {schemaVersion: 1, intent: {...(withJank ? {sceneId: 'scrolling'} : {}), taskKind, scope, deliverable},
    facts: ['total_frames', ...(withJank ? ['jank_frames'] : [])].map(column => ({
      id: column, kind: 'numeric', columns: [column], verification: 'proved', unit: 'frames',
      oracle: {sql: FRAME_FACT_SQL, column, unit: 'frames'},
    }))};
}

function sourceFactExpectation(query) {
  const facts = JSON.parse(fs.readFileSync(path.resolve(backendRoot,
    '../Trace/constructed/source-analysis-semantic/analysis/expected.json'), 'utf8')).source_trace_ground_truth.traceFacts;
  const marker = facts.marker.replace(/'/g, "''");
  return {schemaVersion: 1, intent: {sceneId: 'startup',
    ...(query.kind === 'quantitative-only' ? {taskKind: 'fact', scope: 'bounded_question', deliverable: 'answer'} : {})},
    facts: [{id: 'source_marker_duration', kind: 'numeric', columns: ['dur', 'dur_ns'], verification: 'proved',
      value: facts.durationNs, unit: 'ns', oracle: {
        sql: `SELECT s.id AS row_id, s.dur AS duration_ns, s.ts AS start_ts, t.upid FROM slice s
          JOIN thread_track tt ON s.track_id = tt.id JOIN thread t USING(utid) JOIN process p USING(upid)
          WHERE s.name = '${marker}' AND t.name = '${facts.thread}' AND p.name = '${facts.process}'`,
        column: 'duration_ns', unit: 'ns', anchorMatch: {startTs: 'start_ts', upid: 'upid',
          nativeRow: {relation: 'slice', idColumn: 'id', oracleColumn: 'row_id'}},
      }}], uncoveredFacets: query.kind === 'quantitative-only' ? undefined : ['source recommendation action semantics']};
}

const suites = {
  'scene-reconstruction': {
    label: 'scene reconstruction product-route verification',
    output: 'test-output/e2e-scene-reconstruction-real.json',
    args: ['--entry', 'scene-reconstruction', '--mode', 'full', '--provider-id', 'env',
      '--trace', '../Trace/real/android-scroll-customer/trace.pftrace',
      '--output', 'test-output/e2e-scene-reconstruction-real.json', '--keep-session'],
  },
  'scene-cancel': {
    label: 'scene reconstruction cancellation after candidate',
    output: 'test-output/e2e-scene-cancel-real.json',
    args: ['--entry', 'scene-reconstruction', '--scene-scenario', 'cancel', '--mode', 'full', '--provider-id', 'env',
      '--trace', '../Trace/real/android-scroll-customer/trace.pftrace',
      '--output', 'test-output/e2e-scene-cancel-real.json', '--keep-session'],
  },
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
      '--require-claim-verifier-ok',
      '--require-non-partial',
      '--expectation-json',
      `@${FLAGSHIP_EXPECTATIONS.startup}`,
      '--forbid-degraded-fallback',
      'completed_plan_summary_fallback',
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
      '分析滑动性能，并给出整个 Trace 的总帧数与 FrameTimeline 标记的掉帧数（按 upid 与 frame id 去重）。',
      '--output',
      'test-output/e2e-deepseek-scrolling-real.json',
      '--keep-session',
      '--require-non-partial',
      '--expectation-json',
      `@${FLAGSHIP_EXPECTATIONS.scrolling}`,
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
      '--require-text', 'kb:',
      '--require-code-ref',
      '--require-text', 'StartupHooks.kt',
      '--require-non-partial',
      '--forbid-degraded-fallback', 'verification_failed',
      '--forbid-degraded-fallback', 'partial_result_after_incomplete_plan',
    ],
  },
  'context-rag': {
    label: 'request-scoped document knowledge base analysis gate',
    output: 'test-output/e2e-deepseek-context-rag-real.json',
    args: [
      '--mode', 'full',
      '--provider-id', 'env',
      '--trace', '../Trace/real/android-startup-heavy/trace.pftrace',
      '--query',
      '分析启动性能。必须用 search_knowledge 在所选知识库中以 "Startup first-frame knowledge fixture" 为 query 检索，综合其中关于首帧前同步主线程工作的背景知识并按 kb: 格式注明出处。知识库只能作为背景知识，不能替代 Trace 证据。',
      '--setup-knowledge-root', 'tests/e2e/context-fixtures/wiki',
      '--code-aware', 'off',
      '--output', 'test-output/e2e-deepseek-context-rag-real.json',
      '--require-tool', 'search_knowledge',
      '--require-text', 'kb:',
      '--require-non-partial',
      '--forbid-degraded-fallback', 'verification_failed',
      '--forbid-degraded-fallback', 'partial_result_after_incomplete_plan',
    ],
  },
  'context-combined': {
    label: 'request-scoped source plus document knowledge base analysis gate',
    output: 'test-output/e2e-deepseek-context-combined-real.json',
    args: [
      '--mode', 'full',
      '--provider-id', 'env',
      '--trace', '../Trace/real/android-startup-heavy/trace.pftrace',
      '--query',
      '分析启动性能。必须分别调用 lookup_app_source 查询 StartupHooks，并用 search_knowledge 在所选知识库中以 "Startup first-frame knowledge fixture" 为 query 检索。在结论引用 StartupHooks.kt，并综合知识库中关于首帧前同步主线程工作的背景知识、按 kb: 格式注明出处；两类上下文都不能替代 Trace 证据。',
      '--setup-codebase-root', 'tests/e2e/context-fixtures/app',
      '--setup-knowledge-root', 'tests/e2e/context-fixtures/wiki',
      '--code-aware', 'provider_send',
      '--output', 'test-output/e2e-deepseek-context-combined-real.json',
      '--require-tool', 'lookup_app_source',
      '--require-tool', 'search_knowledge',
      '--require-successful-lookup', 'lookup_app_source',
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
  [SYSTEM_ANALYSIS_SUITE]: {label: 'declarative system investigation evidence gate', args: []},
};

function systemAnalysisScenarios() {
  const directory = path.join(backendRoot, 'tests/e2e/system-analysis-fixtures');
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.scenarios) || !manifest.scenarios.length) {
    throw new Error('Invalid system-analysis scenario manifest');
  }
  const ids = new Set();
  return manifest.scenarios.map(scenario => {
    if (!scenario || typeof scenario.id !== 'string' || !/^[a-z][a-z0-9-]+$/.test(scenario.id) || ids.has(scenario.id) ||
      !['real', 'constructed'].includes(scenario.evidenceTier) || typeof scenario.trace !== 'string' ||
      typeof scenario.query !== 'string' || !scenario.query.trim() || typeof scenario.expectation !== 'string' ||
      path.basename(scenario.expectation) !== scenario.expectation) throw new Error('Invalid system-analysis scenario');
    ids.add(scenario.id);
    const expectationPath = path.join(directory, scenario.expectation);
    assertFile(expectationPath, 'system analysis expectation');
    const output = `test-output/system-analysis/${scenario.id}.json`;
    const args = ['--mode', 'full', '--provider-id', 'env', '--trace', scenario.trace, '--query', scenario.query,
      '--output', output, '--require-non-partial', '--require-claim-verifier-ok', '--expectation-json', `@${expectationPath}`];
    if (scenario.selectSlice) args.push('--select-slice-json', JSON.stringify(scenario.selectSlice));
    if (scenario.referenceTrace) args.push('--reference-trace', scenario.referenceTrace,
      '--trace-pair-layout', 'horizontal', '--trace-pair-workspace-open', '--trace-pair-active', 'current');
    return {id: scenario.id, evidenceTier: scenario.evidenceTier, label: `${scenario.evidenceTier} system evidence: ${scenario.id}`,
      output, args};
  });
}

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
    if (options.preflight) {
      const result = runSemanticPreflight(options);
      if (!result.preflightPassed) process.exitCode = 1;
      return;
    }
    const aggregate = runCodeAwareSemanticDeltaSuite(options);
    if (aggregate.attemptFailureCount > 0) process.exitCode = 1;
    return;
  }

  const suiteNames = options.suite === 'all'
    ? ['startup', 'scrolling', 'external-issue', 'dual-trace', ...CONTEXT_SUITE_NAMES]
    : options.suite === 'context'
      ? CONTEXT_SUITE_NAMES
      : options.suite === FLAGSHIP_SUITE
        ? FLAGSHIP_SUITE_NAMES
        : [options.suite];
  const runtimeKinds = resolveRuntimeKinds(options.runtime);

  if (options.suite === FLAGSHIP_SUITE || options.strict || options.deltaBaseline !== undefined) {
    runFlagshipSuites(options, suiteNames, runtimeKinds);
    return;
  }

  for (const runtimeKind of runtimeKinds) {
    const availability = realProviderAvailability(runtimeKind);
    if (!availability.available) {
      throw new Error(`REAL PROVIDER NOT AVAILABLE: ${runtimeKind}: ${availability.reason}`);
    }
    for (const suiteName of suiteNames) {
      if (suiteName === SYSTEM_ANALYSIS_SUITE) {
        for (const scenario of systemAnalysisScenarios().filter(item => !options.systemScenario || item.id === options.systemScenario)) runSuite(suiteName, availability, runtimeKind,
          runtimeKinds.length > 1 || options.runtime !== DEFAULT_RUNTIME, options.timeoutMs, scenario);
        continue;
      }
      runSuite(
        suiteName,
        availability,
        runtimeKind,
        runtimeKinds.length > 1 || options.runtime !== DEFAULT_RUNTIME,
        options.timeoutMs,
      );
    }
  }

  console.log(`\nDeepseek Agent SSE observed checks passed: ${runtimeKinds.join(', ')} / ${suiteNames.join(', ')}${options.systemScenario ? ` / selected scenario=${options.systemScenario}` : ''}; semantic acceptance is recorded separately in each report.`);
}

function parseArgs(argv) {
  let suite = 'all';
  let runtime = DEFAULT_RUNTIME;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let repeat = 1;
  let preflight = false;
  let queryId;
  let condition;
  let systemScenario;
  let strict = false;
  let deltaBaseline;
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
    if (arg === '--system-scenario') {
      systemScenario = argv[++i];
      if (!systemScenario) throw new Error('--system-scenario requires a manifest scenario ID');
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
    if (arg === '--preflight') {
      preflight = true;
      continue;
    }
    if (arg === '--strict') {
      strict = true;
      continue;
    }
    if (arg === '--delta-baseline') {
      const value = argv[++i];
      if (!value) throw new Error('--delta-baseline requires a flagship summary JSON file or a directory of them');
      deltaBaseline = path.resolve(backendRoot, value);
      continue;
    }
    if (arg === '--query-id' || arg === '--condition') {
      const value = argv[++i];
      if (!value) throw new Error(`${arg} requires a value`);
      if (arg === '--query-id') queryId = value;
      else condition = value;
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

  if (preflight) {
    if (suite !== SEMANTIC_DELTA_SUITE || repeat !== 1 || resolveSemanticRuntimeKinds(runtime).length !== 1 ||
        !SEMANTIC_DELTA_QUERIES.some(query => query.id === queryId) || !['A0', 'A2', 'A3'].includes(condition)) {
      throw new Error('--preflight requires the code-aware-semantic-delta suite, one runtime, an existing --query-id, one --condition A0|A2|A3, and no repeats');
    }
  } else if (queryId !== undefined || condition !== undefined) {
    throw new Error('--query-id and --condition are only available with --preflight');
  } else if (suite === SEMANTIC_DELTA_SUITE && repeat !== 5) {
    throw new Error(`${SEMANTIC_DELTA_SUITE} requires --repeat 5`);
  }

  if (systemScenario && (suite !== SYSTEM_ANALYSIS_SUITE || !systemAnalysisScenarios().some(item => item.id === systemScenario))) {
    throw new Error('--system-scenario requires the system-analysis suite and an existing manifest ID');
  }
  if ((strict || deltaBaseline !== undefined) && suite !== FLAGSHIP_SUITE && !FLAGSHIP_SUITE_NAMES.includes(suite)) {
    throw new Error(`--strict and --delta-baseline require the ${FLAGSHIP_SUITE}, ${FLAGSHIP_SUITE_NAMES.join(' or ')} suite`);
  }
  return { suite, runtime, timeoutMs, repeat, outputDir, preflight, queryId, condition, systemScenario, strict, deltaBaseline,
    help: false };
}

function parseSuite(value) {
  if (value === 'all' || value === 'context' || value === FLAGSHIP_SUITE || Object.hasOwn(suites, value)) return value;
  throw new Error(`Invalid suite: ${value}. Expected all, context, ${FLAGSHIP_SUITE}, or one of: ${Object.keys(suites).join(', ')}.`);
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
  console.log('Usage: node scripts/run-deepseek-agent-e2e.cjs [--suite all|context|flagship|startup|scrolling|scene-reconstruction|scene-cancel|external-issue|dual-trace|context-source|context-rag|context-combined|code-aware-semantic-delta|system-analysis] [--runtime claude-agent-sdk|openai-agents-sdk|pi-agent-core|opencode|qoder-agent-sdk|all|all-deepseek] [--timeout-ms <number>] [--repeat 5] [--output-dir <path>] [--strict] [--delta-baseline <summary.json|dir>]');
  console.log('');
  console.log('Runs SmartPerfetto Agent SSE E2E with Deepseek-backed SmartPerfetto runtimes.');
  console.log('');
  console.log('Credential precedence: DEEPSEEK_API_KEY, then OPENAI_API_KEY.');
  console.log('OpenAI receives explicit OPENAI_* pins; Pi reads the installed SDK model catalog, and OpenCode receives Deepseek model JSON unless env already overrides it.');
  console.log('Qoder receives DeepSeek through resolveModel BYOK and still requires QODER_PERSONAL_ACCESS_TOKEN or qodercli login.');
  console.log('BYOK does not replace Qoder authentication.');
  console.log(`Each real SSE scenario has a ${DEFAULT_TIMEOUT_MS}ms default timeout; use --timeout-ms to override it.`);
  console.log('The code-aware semantic-delta suite requires --repeat 5 and writes paired-run plus aggregate JSON artifacts.');
  console.log('The system-analysis suite uses declarative real startup/scrolling and explicitly constructed system/input/ANR scenarios. all/all-deepseek selects OpenAI, Pi and OpenCode; run Claude and Qoder explicitly for their independent evidence.');
  console.log('Use --suite system-analysis --system-scenario <manifest ID> for one bounded Provider run; a selected scenario never represents full matrix acceptance.');
  console.log('The flagship suite runs startup and scrolling from tests/e2e/flagship expectation files and writes a fingerprinted summary per suite/runtime to test-output/e2e-baselines/.');
  console.log('Without --strict a flagship run exits non-zero only for wrong or undelivered answers and hard flags; proof gaps leave it INCONCLUSIVE.');
  console.log('--strict is complete acceptance: value, delivery and proof groups and every hard flag must pass (semanticAcceptance PASSED).');
  console.log('--delta-baseline compares against an earlier summary (file, or directory of summaries) with the same fingerprint except commit; it is regression evidence only, never acceptance, and exits non-zero on new failures or a refused comparison.');
  console.log('For one diagnostic scenario, use --preflight --query-id autonomous-diagnosis|quantitative-only|explicit-source-location --condition A0|A2|A3 with one runtime. Preflight never counts as complete acceptance.');
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

function concreteClaudeCredential(value) {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (!normalized) return undefined;
  const lower = normalized.toLowerCase();
  if (['sk-ant-xxx', 'sk-proxy-xxx', 'xxx', 'placeholder'].includes(lower)) return undefined;
  if (lower.startsWith('your_') || lower.startsWith('replace_with_') || lower.startsWith('example_')) {
    return undefined;
  }
  if (/^<[^>]+>$/.test(normalized)) return undefined;
  return normalized;
}

function enabledEnvFlag(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return ['1', 'true', 'yes', 'on'].includes(normalized);
}

function realProviderAvailability(runtimeKind, env = process.env) {
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
    const anthropicApiKey = concreteClaudeCredential(env.ANTHROPIC_API_KEY);
    const anthropicAuthToken = concreteClaudeCredential(env.ANTHROPIC_AUTH_TOKEN);
    const bedrockConfigured = enabledEnvFlag(env.CLAUDE_CODE_USE_BEDROCK);
    const vertexConfigured = enabledEnvFlag(env.CLAUDE_CODE_USE_VERTEX) &&
      Boolean(concreteClaudeCredential(env.ANTHROPIC_VERTEX_PROJECT_ID));
    return anthropicApiKey || anthropicAuthToken || bedrockConfigured || vertexConfigured
      ? {
          available: true,
          credentialKind: anthropicApiKey
            ? 'ANTHROPIC_API_KEY'
            : anthropicAuthToken
              ? 'ANTHROPIC_AUTH_TOKEN'
            : bedrockConfigured
              ? 'AWS_BEDROCK_AUTH'
              : 'GOOGLE_VERTEX_AUTH',
        }
      : {
          available: false,
          reason: 'CLAUDE_EXPLICIT_CONFIGURATION_MISSING',
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

function scenarioSliceSelector(caseId, scenario, targetName) {
  if (typeof targetName !== 'string' || !targetName.trim()) {
    throw new Error('Source scenario must receive one target slice name');
  }
  const caseMarker = `SmartPerfetto::CASE::${caseId}`;
  if (targetName === caseMarker) {
    throw new Error('Source scenario cannot select its case marker');
  }
  if (!Array.isArray(scenario?.signals)) throw new Error('Source scenario signals must be an array');
  const targets = scenario.signals.filter(signal => signal.type === 'atrace-slice' && signal.name === targetName);
  if (targets.length !== 1) throw new Error('Source scenario must identify exactly one target slice');
  const [target] = targets;
  const threads = (scenario.actors?.threads || []).filter(thread =>
    thread.id === target.thread && thread.process === target.process);
  const processes = (scenario.actors?.processes || []).filter(process => process.id === target.process);
  if (threads.length !== 1 || processes.length !== 1 ||
      [target.name, threads[0]?.name, processes[0]?.name].some(name => typeof name !== 'string' || !name.trim())) {
    throw new Error('Source scenario target process and thread identities are missing or ambiguous');
  }
  return {processName: processes[0].name, threadName: threads[0].name, eventName: target.name};
}

function sourceScenarioSliceSelector() {
  const caseRoot = path.resolve(backendRoot, '../Trace/constructed/source-analysis-semantic');
  const caseMetadata = JSON.parse(fs.readFileSync(path.join(caseRoot, 'case.json'), 'utf8'));
  const scenarioFile = caseMetadata.construction?.scenario_file;
  if (typeof scenarioFile !== 'string' || path.basename(scenarioFile) !== scenarioFile) {
    throw new Error('Source scenario metadata must name a local scenario file');
  }
  const expected = JSON.parse(fs.readFileSync(path.join(caseRoot, 'analysis/expected.json'), 'utf8'));
  const traceFacts = expected?.source_trace_ground_truth?.traceFacts;
  if (!traceFacts || typeof traceFacts !== 'object' || Array.isArray(traceFacts) ||
      !Object.hasOwn(traceFacts, 'marker') || typeof traceFacts.marker !== 'string' || !traceFacts.marker.trim()) {
    throw new Error('Source ground truth must declare one target marker');
  }
  return scenarioSliceSelector(caseMetadata.id,
    JSON.parse(fs.readFileSync(path.join(caseRoot, scenarioFile), 'utf8')), traceFacts.marker);
}

function semanticConditionArgs(query, condition, outputPath, timeoutMs) {
  const args = [
    '--mode', 'full',
    '--provider-id', 'env',
    '--trace', SEMANTIC_DELTA_TRACE,
    '--query', query.text,
    '--select-slice-json', JSON.stringify(sourceScenarioSliceSelector()),
    '--output', outputPath,
    '--timeout-ms', String(timeoutMs),
    '--require-non-partial',
    '--require-claim-verifier-ok',
    '--expectation-json', JSON.stringify(sourceFactExpectation(query)),
    '--forbid-text', PRIVATE_SOURCE_CANARY,
  ];
  if (condition === 'A0') {
    args.push(
      '--code-aware', 'off',
      '--forbid-text', SEMANTIC_DELTA_RELATIVE_SOURCE_PATH,
      '--forbid-text', SEMANTIC_DELTA_SOURCE_FILE,
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
    args.push('--require-code-ref');
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

function nativeOccurrenceForAnchor(anchor, verification) {
  const proof = verification?.deterministicProof;
  const rows = proof?.nativeRows;
  if (rows === undefined || Array.isArray(rows) && rows.length === 0) return {status: 'absent'};
  if (!Array.isArray(rows) || verification?.status !== 'verified' || proof.status !== 'proved' ||
      !['numeric_cell', 'captured_cell', 'interval_overlap', 'comparison_delta'].includes(proof.kind) ||
      verification.propositionCoverage?.status !== 'complete' || verification.propositionCoverage.uncovered?.length !== 0 ||
      !proof.anchorIds?.includes(anchor.anchorId) || !proof.evidenceRefIds?.includes(anchor.evidenceRefId)) return {status: 'invalid'};
  const candidates = rows.filter(row => row?.anchorId === anchor.anchorId && row?.evidenceRefId === anchor.evidenceRefId);
  if (candidates.length !== 1) return {status: 'invalid'};
  const row = candidates[0];
  if (!anchor.context?.captureId || row.captureId !== anchor.context.captureId ||
      row.traceId !== anchor.context.traceId || row.traceSide !== 'current' || anchor.context.traceSide !== 'current' ||
      typeof row.relation !== 'string' || !/^[a-z_][a-z0-9_]*$/.test(row.relation) ||
      typeof row.idColumn !== 'string' || !/^[a-z_][a-z0-9_]*$/.test(row.idColumn) ||
      !Number.isSafeInteger(row.id) || row.id < 0 || !/^[a-f0-9]{64}$/.test(row.schemaFingerprint) ||
      !verification.referenceCells?.some(cell => cell.anchorId === anchor.anchorId &&
        cell.evidenceRefId === anchor.evidenceRefId && cell.status === 'matched')) return {status: 'invalid'};
  return {status: 'valid', row};
}

function sameTraceOccurrence(anchor, oracle, anchorVerification, oracleVerification) {
  if (anchor.missing || oracle.missing || !anchor.context?.traceId || anchor.context.traceId !== oracle.context?.traceId ||
      anchor.context.traceSide !== 'current' || oracle.context?.traceSide !== 'current') return false;
  for (const key of ['upid', 'utid', 'pid', 'tid', 'packageName', 'processName', 'threadName']) {
    if (anchor.identity?.[key] !== undefined && oracle.identity?.[key] !== undefined &&
        anchor.identity[key] !== oracle.identity[key]) return false;
  }
  for (const key of ['startTs', 'endTs', 'unit']) {
    if (anchor.timeRange?.[key] !== undefined && oracle.timeRange?.[key] !== undefined &&
        String(anchor.timeRange[key]) !== String(oracle.timeRange[key])) return false;
  }
  const sameCapture = Boolean(anchor.evidenceRefId) && anchor.evidenceRefId === oracle.evidenceRefId;
  const cells = anchor.cells || [];
  const oracleCells = oracle.cells || [];
  const rowConflict = cells.some(cell => oracleCells.some(other =>
    (sameCapture && Number.isInteger(cell.rowIndex) && Number.isInteger(other.rowIndex) && cell.rowIndex !== other.rowIndex) ||
    Object.entries(cell.rowSelector || {}).some(([key, value]) =>
      Object.hasOwn(other.rowSelector || {}, key) && !isDeepStrictEqual(value, other.rowSelector[key]))));
  if (rowConflict) return false;
  const native = nativeOccurrenceForAnchor(anchor, anchorVerification);
  const nativeOracle = nativeOccurrenceForAnchor(oracle, oracleVerification);
  if (native.status === 'invalid' || nativeOracle.status === 'invalid') return false;
  if (native.status === 'valid' && nativeOracle.status === 'valid') {
    return ['traceId', 'traceSide', 'relation', 'idColumn', 'id', 'schemaFingerprint']
      .every(key => native.row[key] === nativeOracle.row[key]);
  }
  if (sameCapture) {
    // An evidence id identifies a result set. Cross-claim reuse must identify its
    // actual row, not merely a coincident time or a different row in that set.
    if (cells.some(cell => oracleCells.some(other =>
      Number.isInteger(cell.rowIndex) && cell.rowIndex >= 0 && cell.rowIndex === other.rowIndex ||
      Object.keys(cell.rowSelector || {}).length > 0 && isDeepStrictEqual(cell.rowSelector, other.rowSelector)))) return true;
    return Boolean(anchor.anchorId) && anchor.anchorId === oracle.anchorId;
  }
  // Across independent captures, require the entire physical interval and the
  // same trace-scoped thread and process. Shared row selectors may not conflict.
  const validRange = range => range?.unit === 'ns' && /^\d+$/.test(String(range.startTs)) &&
    /^\d+$/.test(String(range.endTs)) && BigInt(range.endTs) > BigInt(range.startTs);
  return validRange(anchor.timeRange) && validRange(oracle.timeRange) &&
    ['upid', 'utid'].every(key => Number.isInteger(anchor.identity?.[key]) && anchor.identity[key] >= 0 &&
      anchor.identity[key] === oracle.identity?.[key]);
}

function evaluateSemanticConditionReport(input) {
  const {report, query, condition, sourceRoot} = input;
  const summary = report?.summary;
  // Canary names appear in the verifier's boolean check keys by design. Scan
  // delivered content, and check those diagnostic booleans separately.
  const {checks: _checks, summary: _summary, ...reportContent} = report || {};
  const {requiredTextMatches: _required, forbiddenTextMatches: forbidden, ...summaryContent} = summary || {};
  const serialized = JSON.stringify({...reportContent, summary: summaryContent});
  const privacyPassed = Boolean(report) &&
    forbidden?.[PRIVATE_SOURCE_CANARY] !== true &&
    !serialized.includes(sourceRoot) &&
    !serialized.includes(PRIVATE_SOURCE_CANARY);
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
  const task = report?.taskVerification;
  const overallTaskChecksPassed = Object.keys(task?.checks || {}).length > 0 &&
    Object.values(task.checks).every(value => value === true);
  const fact = task?.facts?.source_marker_duration;
  const claims = summary?.terminalAnalysis?.conclusionContract?.claims || [];
  const supports = summary?.terminalAnalysis?.claimSupport || [];
  const claimResults = summary?.terminalAnalysis?.claimVerificationResult?.claimResults || [];
  const claimVerification = claimId => {
    const matches = claimResults.filter(result => result.claimId === claimId);
    return matches.length === 1 ? matches[0] : undefined;
  };
  const uniqueIds = ids => Array.isArray(ids) && ids.length > 0 &&
    ids.every(id => typeof id === 'string' && id.length > 0) && new Set(ids).size === ids.length;
  const oracleClaimIds = new Set(Array.isArray(fact?.matchedClaimIds) ? fact.matchedClaimIds : []);
  const oracleAnchorIds = new Set(Array.isArray(fact?.matchedAnchorIds) ? fact.matchedAnchorIds : []);
  // The verifier already matched the independent oracle. Retain that result only
  // while its exact claim/proof/anchor association is present in this terminal.
  const oracleAnchors = [...oracleClaimIds].flatMap(claimId => {
    const declared = claims.filter(claim => claim.id === claimId);
    const supported = supports.filter(support => support.claimId === claimId);
    const verification = claimVerification(claimId);
    const proof = verification?.deterministicProof;
    if (declared.length !== 1 || declared[0].kind !== 'numeric' || supported.length !== 1 ||
        verification?.status !== 'verified' || proof?.kind !== 'numeric_cell' || proof.status !== 'proved' ||
        verification.propositionCoverage?.status !== 'complete' || verification.propositionCoverage.uncovered?.length !== 0) return [];
    return (supported[0].anchors || []).filter(anchor => oracleAnchorIds.has(anchor.anchorId) &&
      supported[0].anchors.filter(other => other.anchorId === anchor.anchorId).length === 1 &&
      !anchor.missing && typeof report?.traceId === 'string' && anchor.context?.traceId === report.traceId &&
      anchor.context.traceSide === 'current' && proof.anchorIds?.includes(anchor.anchorId) &&
      proof.evidenceRefIds?.includes(anchor.evidenceRefId) && verification.referenceCells?.some(cell =>
        cell.anchorId === anchor.anchorId && cell.evidenceRefId === anchor.evidenceRefId && cell.status === 'matched'))
      .map(anchor => ({claimId, anchor, verification}));
  });
  const traceFactPassed = fact?.proposition === 'proved' && fact.matched === true &&
    task?.checks?.['fact:source_marker_duration'] === true &&
    summary?.terminalAnalysis?.claimVerificationResult?.schemaVersion === 'claim_verifier@2' &&
    uniqueIds(fact.matchedClaimIds) && uniqueIds(fact.matchedAnchorIds) &&
    [...oracleClaimIds].every(claimId => oracleAnchors.some(item => item.claimId === claimId)) &&
    [...oracleAnchorIds].every(anchorId => oracleAnchors.some(item => item.anchor.anchorId === anchorId));
  const sourceToolCount = ['search_codebase', 'read_codebase_file', 'lookup_app_source']
    .reduce((count, tool) => count + (summary?.toolCallCounts?.[tool] || 0), 0);
  const forbiddenMatches = summary?.forbiddenTextMatches || {};
  // Generic filename:line syntax also occurs in Trace stacks; it is not source provenance.
  const sourceLeakFree = condition !== 'A0' || (
    !serialized.includes('val startupPolicy =') &&
    [
      SEMANTIC_DELTA_RELATIVE_SOURCE_PATH,
      SEMANTIC_DELTA_SOURCE_FILE,
      '[Code:',
    ].every(text => forbiddenMatches[text] !== true) &&
    (summary?.analysisCompletedSourceReferenceCount || 0) === 0 &&
    (summary?.analysisCompletedSourceBindingCount || 0) === 0 &&
    sourceToolCount === 0
  );
  const claimStatuses = Array.isArray(summary?.analysisCompletedSourceClaimStatuses)
    ? summary.analysisCompletedSourceClaimStatuses
    : [];
  // Weaker-than-linked source claims are delivered (not failed); an invalid
  // reference is the one failure. The oracle-linked claim must independently
  // meet sourceIdentityPassed below.
  const sourceBindingPassed =
    summary?.analysisCompletedSourceClaimVerifierStatus !== 'failed' &&
    summary?.analysisCompletedSourceReferenceMembershipPassed === true &&
    claimStatuses.length > 0 &&
    claimStatuses.every(status => status !== 'invalid');
  const sourceUseDecision = summary?.analysisCompletedSourceUseDecision ??
    summary?.terminalAnalysis?.conclusionContract?.sourceUseDecision;
  const references = sourceUseDecision?.references || [];
  const selectedCodebases = new Set(report?.analysisContext?.codebaseIds || []);
  const sourceGroundTruth = JSON.parse(fs.readFileSync(path.resolve(backendRoot,
    '../Trace/constructed/source-analysis-semantic/analysis/expected.json'), 'utf8')).source_trace_ground_truth;
  const fileReferences = references.filter(reference =>
    typeof reference.id === 'string' && reference.id.startsWith('source-ref-v1-') &&
    selectedCodebases.has(reference.codebaseId) && reference.filePath === SEMANTIC_DELTA_SOURCE_FILE &&
    Number.isSafeInteger(reference.lineRange?.start) && Number.isSafeInteger(reference.lineRange?.end) &&
    reference.lineRange.start > 0 && reference.lineRange.start <= reference.lineRange.end);
  const isBody = reference => reference.lookupKind === 'body' || reference.lookupKind === 'indexed';
  // Mirror of referenceHasReadBody (sourceUseDecision.ts); this script loads
  // no TypeScript, so keep the two in step.
  const hasReadBody = reference => isBody(reference) || fileReferences.some(other => isBody(other) &&
    other.codebaseId === reference.codebaseId && reference.sourceGeneration !== undefined &&
    other.sourceGeneration === reference.sourceGeneration &&
    other.lineRange.start <= reference.lineRange.start && other.lineRange.end >= reference.lineRange.end);
  const matchingReferences = fileReferences.filter(reference => hasReadBody(reference) &&
    reference.lineRange.start <= sourceGroundTruth.lineRange.start &&
    reference.lineRange.end >= sourceGroundTruth.lineRange.end);
  const matchingReferenceIds = new Set(matchingReferences.map(reference => reference.id));
  const verifiedBindings = summary?.analysisCompletedVerifiedSourceBindings || [];
  const sourceIdentityPassed = sourceBindingPassed && verifiedBindings.some(binding => {
    // A body-read source claim bound to Trace evidence of the same claim.
    if (!['trace_linked', 'source_only'].includes(binding.status) ||
        !binding.sourceReferenceIds?.some(id => matchingReferenceIds.has(id))) return false;
    const boundAnchors = supports.filter(support => support.claimId === binding.claimId)
      .flatMap(support => support.anchors || [])
      .filter(anchor => binding.traceEvidenceRefIds?.includes(anchor.evidenceRefId));
    return boundAnchors.some(anchor => oracleAnchors.some(oracle => sameTraceOccurrence(anchor, oracle.anchor,
      claimVerification(binding.claimId), oracle.verification)));
  });
  const canaryLine = fs.readFileSync(path.join(sourceRoot, SEMANTIC_DELTA_SOURCE_FILE), 'utf8')
    .split(/\r?\n/).findIndex(line => line.includes(PRIVATE_SOURCE_CANARY)) + 1;
  // Search hits carry their context text to the provider too.
  const privacyCanaryCovered = canaryLine > 0 && fileReferences.some(reference =>
    (isBody(reference) || reference.lookupKind === 'search_hit') &&
    reference.lineRange.start <= canaryLine && reference.lineRange.end >= canaryLine);
  const quantitativeOutputPassed = traceFactPassed && claims.length > 0 && claims.every(claim =>
    ['numeric', 'time_range', 'comparison'].includes(claim.kind) && claim.semantics?.scope?.population !== 'codebase');
  const sourceSemanticPassed = query?.kind === 'quantitative-only'
    ? quantitativeOutputPassed
    : traceFactPassed && sourceIdentityPassed &&
      (summary?.analysisCompletedSourceReferenceCount || 0) > 0 &&
      (summary?.analysisCompletedSourceBindingCount || 0) > 0 &&
      sourceBindingPassed;
  return {
    privacyPassed,
    provenancePassed,
    traceFactPassed,
    overallTaskChecksPassed,
    sourceLeakFree,
    sourceBindingPassed,
    sourceIdentityPassed,
    privacyCanaryCovered,
    sourceSemanticPassed,
    uncoveredFacets: [...new Set([...(task?.uncoveredFacets || []),
      ...(query?.kind === 'quantitative-only' ? [] : ['source recommendation action semantics'])])],
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
      overallTaskChecksPassed: evaluation.overallTaskChecksPassed,
      sourceLeakFree: evaluation.sourceLeakFree,
      ...(input.condition !== 'A0' && input.query.kind !== 'quantitative-only'
        ? {privacyCanaryCovered: evaluation.privacyCanaryCovered} : {}),
    },
    sourceBindingPassed: evaluation.sourceBindingPassed,
    sourceSemanticPassed: evaluation.sourceSemanticPassed,
    uncoveredFacets: evaluation.uncoveredFacets,
    diagnostic: result.status === 0
      ? undefined
      : sanitizeDiagnostic(result.stderr || result.stdout || result.error?.message),
  };
}

function runSemanticPreflight(options) {
  const [runtimeKind] = resolveSemanticRuntimeKinds(options.runtime);
  const query = semanticDeltaQueries().find(candidate => candidate.id === options.queryId);
  const availability = realProviderAvailability(runtimeKind);
  const attemptDir = path.join(options.outputDir, runtimeKind, 'preflight');
  const outputPath = path.join(attemptDir, query.id, `${options.condition}.preflight.json`);
  const base = {schemaVersion: 'code_aware_semantic_delta_preflight@1', runtime: runtimeKind,
    queryId: query.id, condition: options.condition, completeAcceptance: false,
    passedMeaning: 'single_scenario_diagnostic_only_not_repeated_provider_acceptance'};
  let output;
  if (!availability.available) {
    output = {...base, preflightPassed: false, status: 'REAL PROVIDER NOT AVAILABLE', reason: availability.reason};
  } else {
    const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-semantic-preflight-'));
    try {
      const record = runSemanticCondition({runtimeKind, query, condition: options.condition, availability,
        timeoutMs: options.timeoutMs, outputDir: options.outputDir, attemptDir, isolatedRoot});
      const preflightPassed = record.passed && Object.values(record.hardAssertions).every(Boolean) &&
        (options.condition === 'A0' && query.kind !== 'quantitative-only' || record.sourceSemanticPassed);
      output = {...base, preflightPassed, status: preflightPassed ? 'PREFLIGHT PASSED' : 'PREFLIGHT FAILED', record};
    } finally {
      fs.rmSync(isolatedRoot, {recursive: true, force: true});
    }
  }
  writeJson(outputPath, output);
  console.log(JSON.stringify(output, null, 2));
  console.log(`Preflight artifact written to: ${outputPath}`);
  return output;
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
    const quantitativeOutputPassed = queryRuns
      .filter(run => run.query.kind === 'quantitative-only')
      .every(run => run.conditions.every(condition => condition.sourceSemanticPassed));
    return {
      schemaVersion: 'code_aware_semantic_delta_real_run@1',
      runtime: input.runtimeKind,
      attempt: input.attempt,
      queries: queryRuns,
      hardPassed,
      noTraceRegression,
      quantitativeOutputPassed,
      sourceUpliftPassed: sourceUpliftPassed && quantitativeOutputPassed && noTraceRegression,
      uncoveredFacets: [...new Set(conditions.flatMap(condition => condition.uncoveredFacets))],
    };
  } finally {
    fs.rmSync(isolatedRoot, {recursive: true, force: true});
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), {recursive: true});
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function summarizeSemanticRuntimeRecords(records, attemptsRequired) {
  const hardPassCount = records.filter(record => record.hardPassed).length;
  const sourceUpliftPassCount = records.filter(record => record.sourceUpliftPassed).length;
  const observedChecksPassed = hardPassCount === attemptsRequired &&
    sourceUpliftPassCount >= Math.ceil(attemptsRequired * 0.8);
  const uncoveredFacets = [...new Set(records.flatMap(record => record.uncoveredFacets || []))];
  const completeAcceptance = observedChecksPassed && uncoveredFacets.length === 0;
  return {status: !observedChecksPassed ? 'REAL PROVIDER FAILED' : completeAcceptance ? 'REAL PROVIDER PASSED' : 'REAL PROVIDER INCONCLUSIVE',
    observedChecksPassed, completeAcceptance, uncoveredFacets, attemptsRequired, attemptsRun: records.length,
    hardPassCount, sourceUpliftPassCount, hardAcceptance: `${hardPassCount}/${attemptsRequired}`,
    sourceBindingAcceptance: `${sourceUpliftPassCount}/${attemptsRequired}`,
    semanticAcceptance: !observedChecksPassed ? 'FAILED' : completeAcceptance ? 'PASSED' : 'INCONCLUSIVE'};
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
    const acceptance = summarizeSemanticRuntimeRecords(records, options.repeat);
    if (!acceptance.observedChecksPassed) attemptFailureCount += 1;
    runtimeResults.push({
      runtime: runtimeKind,
      credentialKind: availability.credentialKind,
      ...acceptance,
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
    uncoveredFacets: [...new Set(runtimeResults.flatMap(runtime => runtime.uncoveredFacets || []))],
    semanticAcceptance: runtimeResults.some(runtime => runtime.status === 'REAL PROVIDER FAILED') ? 'FAILED'
      : runtimeResults.length > 0 && runtimeResults.every(runtime => runtime.completeAcceptance) ? 'PASSED' : 'INCONCLUSIVE',
    completeAcceptance: runtimeResults.length > 0 &&
      runtimeResults.every(runtime => runtime.completeAcceptance === true),
  };
  writeJson(path.join(options.outputDir, 'aggregate.json'), aggregate);
  console.log(JSON.stringify(aggregate, null, 2));
  console.log(`Real-provider aggregate written to: ${path.join(options.outputDir, 'aggregate.json')}`);
  return aggregate;
}

function originOf(value, fallback) {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  try {
    return new URL(value).origin;
  } catch {
    return 'invalid-base-url';
  }
}

function parseModelJson(value) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

// Provider endpoint origin and model name only: never a path, query or credential. Pi and
// OpenCode take their model from the model JSON this wrapper (or the caller) supplies.
function providerFingerprint(runtimeKind, env) {
  if (runtimeKind === 'claude-agent-sdk') {
    return {providerOrigin: originOf(env.ANTHROPIC_BASE_URL, 'anthropic-default'), model: env.CLAUDE_MODEL || 'claude-runtime-default'};
  }
  if (runtimeKind === 'qoder-agent-sdk') {
    return {providerOrigin: originOf(env.QODER_BYOK_BASE_URL, 'qoder-default'), model: env.QODER_MODEL || 'qoder-runtime-default'};
  }
  if (runtimeKind === 'pi-agent-core' && env.SMARTPERFETTO_PI_AGENT_CORE_MODEL_JSON) {
    const model = parseModelJson(env.SMARTPERFETTO_PI_AGENT_CORE_MODEL_JSON);
    return {providerOrigin: originOf(model.baseUrl, 'pi-default'), model: model.id || 'pi-runtime-default'};
  }
  if (runtimeKind === 'opencode' && env.SMARTPERFETTO_OPENCODE_MODEL_JSON) {
    const model = parseModelJson(env.SMARTPERFETTO_OPENCODE_MODEL_JSON);
    return {providerOrigin: originOf(model.baseURL, 'opencode-default'), model: model.modelID || 'opencode-runtime-default'};
  }
  return {providerOrigin: originOf(env.OPENAI_BASE_URL, 'openai-default'), model: env.OPENAI_MODEL || 'openai-runtime-default'};
}

function posixRelative(filePath) {
  return path.relative(backendRoot, path.resolve(backendRoot, filePath)).split(path.sep).join('/');
}

/** One read for baselines and reports: missing and unparsable stay distinct. */
function readJsonFile(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    return {status: 'missing', path: filePath};
  }
  try {
    return {status: 'ok', path: filePath, value: JSON.parse(text)};
  } catch {
    return {status: 'corrupt', path: filePath};
  }
}

function gitIdentity() {
  const run = args => spawnSync('git', args, {cwd: backendRoot, encoding: 'utf8', timeout: 10_000});
  const head = run(['rev-parse', 'HEAD']);
  const status = run(['status', '--porcelain', '--untracked-files=no']);
  const commit = head.status === 0 ? head.stdout.trim() : '';
  return {commit: /^[0-9a-f]{40}$/.test(commit) ? commit : 'unknown',
    worktreeDirty: status.status === 0 ? status.stdout.trim().length > 0 : null};
}

function flagshipSummaryFileName(suiteName, runtimeKind, runtimeSpecificOutput) {
  return `${suiteName}${runtimeSpecificOutput ? `-${runtimeKind}` : ''}.json`;
}

function readFlagshipBaseline(baselinePath, fileName) {
  const directory = fs.statSync(baselinePath, {throwIfNoEntry: false})?.isDirectory();
  const {value, ...result} = readJsonFile(directory ? path.join(baselinePath, fileName) : baselinePath);
  return result.status === 'ok' ? {...result, summary: value} : result;
}

function buildFlagshipSummary({suiteName, runtimeKind, report, reportPath, exitCode, provider, git, strict, now = Date.now()}) {
  const identity = report?.runIdentity;
  const groups = report?.checkGroups;
  const fingerprint = {
    suite: suiteName,
    runtime: runtimeKind,
    traceSha256: identity?.traceSha256 ?? null,
    query: identity?.query ?? null,
    expectationHash: identity?.expectationHash ?? null,
    providerOrigin: provider?.providerOrigin ?? null,
    model: provider?.model ?? null,
    commit: git.commit,
    gateSchemaVersion: identity?.gateSchemaVersion ?? null,
    verificationSchemaVersion: identity?.verificationSchemaVersion ?? null,
    traceProcessorVersion: identity?.traceProcessorVersion ?? null,
    stdlibRevision: identity?.stdlibRevision ?? null,
  };
  const reportAvailable = Boolean(report && groups && typeof groups === 'object');
  // A failure artifact (timeout, lifecycle error) still says INCONCLUSIVE for its older readers;
  // here a run without judged groups never delivered, which is a failure, not a proof gap.
  const failure = report?.schemaVersion === 'agent_sse_verification_failure@1'
    ? {phase: String(report.phase ?? 'unknown'), errorCode: String(report.errorCode ?? 'unknown')} : undefined;
  return {
    schemaVersion: FLAGSHIP_SUMMARY_SCHEMA,
    generatedAt: new Date(now).toISOString(),
    fingerprint,
    worktreeDirty: git.worktreeDirty,
    ...(identity?.reportedVersion ? {traceProcessorReportedVersion: identity.reportedVersion} : {}),
    report: reportPath ? posixRelative(reportPath) : null,
    reportAvailable,
    ...(failure ? {verificationFailure: failure} : {}),
    exitCode,
    strict,
    semanticAcceptance: reportAvailable ? report.semanticAcceptance ?? 'FAILED' : 'FAILED',
    proofAcceptance: reportAvailable ? report.proofAcceptance ?? 'INCOMPLETE' : 'INCOMPLETE',
    observedChecksPassed: report?.observedChecksPassed === true,
    hardGatesPassed: report?.hardGatesPassed === true,
    completeAcceptance: report?.completeAcceptance === true,
    checkGroups: reportAvailable ? groups : null,
    facts: Object.fromEntries(Object.entries(report?.taskVerification?.facts ?? {}).map(([id, fact]) => [id, fact?.tier ?? 'none'])),
    uncoveredFacets: Array.isArray(report?.uncoveredFacets) ? report.uncoveredFacets : [],
  };
}

function validFlagshipSummary(summary) {
  const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  return object(summary) && summary.schemaVersion === FLAGSHIP_SUMMARY_SCHEMA && summary.reportAvailable === true &&
    object(summary.fingerprint) && Number.isFinite(Date.parse(summary.generatedAt)) && object(summary.facts) &&
    object(summary.checkGroups) && FLAGSHIP_CHECK_GROUPS.every(group => object(summary.checkGroups[group]) &&
      Object.values(summary.checkGroups[group]).every(value => typeof value === 'boolean'));
}

function incompleteFingerprintKeys(fingerprint) {
  return FLAGSHIP_FINGERPRINT_KEYS.filter(key => typeof fingerprint?.[key] !== 'string' || !fingerprint[key] ||
    fingerprint[key] === 'unknown' || fingerprint[key].startsWith('unknown:'));
}

/**
 * Regression-delta evidence between two comparable flagship runs. A refused comparison is never
 * read as "no change": a missing, corrupt, incomplete or differently fingerprinted baseline says so.
 */
function compareFlagshipSummaries(baseline, current, {now = Date.now()} = {}) {
  if (!baseline || baseline.status === 'missing') return {status: 'refused', reason: 'baseline_missing'};
  if (baseline.status === 'corrupt' || !validFlagshipSummary(baseline.summary)) return {status: 'refused', reason: 'baseline_corrupt'};
  if (!validFlagshipSummary(current)) return {status: 'refused', reason: 'current_report_unavailable'};
  const base = baseline.summary;
  const incomplete = {baseline: incompleteFingerprintKeys(base.fingerprint), current: incompleteFingerprintKeys(current.fingerprint)};
  if (incomplete.baseline.length || incomplete.current.length) {
    return {status: 'refused', reason: 'fingerprint_incomplete', incompleteKeys: incomplete};
  }
  const mismatchedKeys = FLAGSHIP_FINGERPRINT_KEYS.filter(key => key !== 'commit' && base.fingerprint[key] !== current.fingerprint[key]);
  if (mismatchedKeys.length) return {status: 'refused', reason: 'fingerprint_mismatch', mismatchedKeys};
  const flatten = summary => Object.fromEntries(FLAGSHIP_CHECK_GROUPS.flatMap(group =>
    Object.entries(summary.checkGroups[group]).map(([key, value]) => [`${group}:${key}`, value])));
  const before = flatten(base);
  const after = flatten(current);
  const newFailures = [];
  const fixed = [];
  const unchanged = [];
  const added = [];
  for (const [key, value] of Object.entries(after)) {
    if (!(key in before)) {
      (value ? added : newFailures).push(key);
    } else if (before[key] === value) {
      unchanged.push(key);
    } else {
      (value ? fixed : newFailures).push(key);
    }
  }
  const removed = Object.keys(before).filter(key => !(key in after));
  const factTierChanges = Object.fromEntries([...new Set([...Object.keys(base.facts), ...Object.keys(current.facts)])]
    .filter(id => base.facts[id] !== current.facts[id])
    .map(id => [id, {from: base.facts[id] ?? null, to: current.facts[id] ?? null}]));
  const ageMs = now - Date.parse(base.generatedAt);
  return {
    status: 'compared',
    evidence: 'regression_delta_only_not_acceptance',
    baselinePath: posixRelative(baseline.path),
    baselineGeneratedAt: base.generatedAt,
    stale: ageMs > FLAGSHIP_BASELINE_STALE_MS,
    commits: {baseline: base.fingerprint.commit, current: current.fingerprint.commit},
    newFailures, fixed, unchanged, added, removed, factTierChanges,
    acceptance: {semantic: {from: base.semanticAcceptance, to: current.semanticAcceptance},
      proof: {from: base.proofAcceptance, to: current.proofAcceptance}},
  };
}

/** Diagnostic runs follow the verifier exit code; --strict and --delta-baseline add their own requirements. */
function flagshipRunVerdict(summary) {
  const strict = summary.strict === true;
  const delta = summary.delta !== undefined;
  const reasons = [];
  if (!summary.reportAvailable) reasons.push('report_unavailable');
  if (strict && (summary.exitCode !== 0 || !summary.completeAcceptance)) reasons.push(`strict_acceptance_${summary.semanticAcceptance}`);
  if (delta) {
    if (summary.delta?.status !== 'compared') reasons.push(`delta_refused:${summary.delta?.reason ?? 'unknown'}`);
    else if (summary.delta.newFailures.length) reasons.push(`delta_new_failures:${summary.delta.newFailures.length}`);
  }
  if (!strict && !delta && summary.exitCode !== 0) reasons.push(`verifier_exit_${summary.exitCode}`);
  return {passed: reasons.length === 0, reasons};
}

function runFlagshipSuites(options, suiteNames, runtimeKinds) {
  const git = gitIdentity();
  const runtimeSpecificOutput = runtimeKinds.length > 1 || options.runtime !== DEFAULT_RUNTIME;
  const failures = [];
  for (const runtimeKind of runtimeKinds) {
    const availability = realProviderAvailability(runtimeKind);
    if (!availability.available) {
      throw new Error(`REAL PROVIDER NOT AVAILABLE: ${runtimeKind}: ${availability.reason}`);
    }
    for (const suiteName of suiteNames) {
      const fileName = flagshipSummaryFileName(suiteName, runtimeKind, runtimeSpecificOutput);
      // Read before running: the new summary may replace the very file used as the baseline.
      const baseline = options.deltaBaseline !== undefined ? readFlagshipBaseline(options.deltaBaseline, fileName) : undefined;
      const run = runSuite(suiteName, availability, runtimeKind, runtimeSpecificOutput, options.timeoutMs, undefined,
        {throwOnFailure: false, extraArgs: options.strict ? ['--strict'] : []});
      const report = run.outputPath ? readJsonFile(path.resolve(backendRoot, run.outputPath)).value : undefined;
      const summary = buildFlagshipSummary({suiteName, runtimeKind, report, reportPath: run.outputPath, exitCode: run.status,
        provider: run.provider, git, strict: options.strict});
      if (baseline) summary.delta = compareFlagshipSummaries(baseline, summary);
      const verdict = flagshipRunVerdict(summary);
      summary.verdict = verdict;
      const summaryPath = path.join(backendRoot, FLAGSHIP_SUMMARY_DIR, fileName);
      writeJson(summaryPath, summary);
      console.log(`[deepseek-e2e] flagship ${suiteName}/${runtimeKind}: semantic=${summary.semanticAcceptance} ` +
        `proof=${summary.proofAcceptance} exit=${summary.exitCode}` +
        `${summary.delta ? ` delta=${summary.delta.status}${summary.delta.status === 'compared'
          ? ` new=${summary.delta.newFailures.length} fixed=${summary.delta.fixed.length}${summary.delta.stale ? ' STALE_BASELINE' : ''}`
          : `:${summary.delta.reason}`}` : ''} summary=${path.relative(backendRoot, summaryPath)}`);
      if (!verdict.passed) failures.push(`${suiteName}/${runtimeKind}: ${verdict.reasons.join(', ')}`);
    }
  }
  if (failures.length) {
    process.exitCode = 1;
    console.error(`\nFlagship gate failed:\n${failures.map(line => `  ${line}`).join('\n')}`);
    return;
  }
  console.log(`\nFlagship gate ${options.strict ? 'complete acceptance passed' : 'observed checks passed'}: ` +
    `${runtimeKinds.join(', ')} / ${suiteNames.join(', ')}${options.deltaBaseline !== undefined
      ? '; the delta is regression evidence, not acceptance' : ''}.`);
}

function loadBackendEnv() {
  const envPath = path.join(backendRoot, '.env');
  if (!fs.existsSync(envPath)) return;
  // Load local untracked provider credentials before this wrapper validates them.
  require('dotenv').config({ path: envPath, quiet: true });
}

function runSuite(suiteName, availability, runtimeKind, runtimeSpecificOutput, timeoutMs, scenario,
  {throwOnFailure = true, extraArgs = []} = {}) {
  const suite = scenario ?? suites[suiteName];
  const suiteArgs = runtimeSpecificOutput
    ? withRuntimeOutputPath(suite.args, suite.output, runtimeKind)
    : suite.args;
  const args = [...suiteArgs, ...extraArgs, '--timeout-ms', String(timeoutMs)];
  console.log(`\n[deepseek-e2e] suite=${suiteName} (${suite.label})`);
  console.log(`[deepseek-e2e] runtime=${runtimeKind}`);
  console.log(`[deepseek-e2e] output=${getOutputPathFromArgs(args) || suite.output}`);
  console.log(`[deepseek-e2e] credential=${availability.credentialKind}`);

  const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-deepseek-e2e-'));
  try {
    const env = buildSemanticChildEnv(runtimeKind, availability, isolatedRoot);
    const result = spawnSync(process.execPath, [tsxCliPath, verifierPath, ...args], {
      cwd: backendRoot,
      env,
      stdio: 'inherit',
    });

    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0 && throwOnFailure) {
      process.exitCode = result.status ?? 1;
      throw new Error(`Agent SSE verification exited with status ${result.status ?? 1}; inspect ${getOutputPathFromArgs(args)}`);
    }
    return {status: result.status ?? 1, outputPath: getOutputPathFromArgs(args), provider: providerFingerprint(runtimeKind, env)};
  } finally {
    // A killed verifier cannot execute its own finally. Preserve its task-owned
    // logs here as well; failed copying keeps the recoverable isolated root.
    if (preserveIsolatedSessionLogs(isolatedRoot, getOutputPathFromArgs(args))) {
      fs.rmSync(isolatedRoot, {recursive: true, force: true});
    }
  }
}

function preserveIsolatedSessionLogs(isolatedRoot, outputPath) {
  const directory = path.join(isolatedRoot, 'logs/sessions');
  if (!fs.existsSync(directory)) return true;
  if (!outputPath) return false;
  const secrets = Object.entries(process.env).filter(([key, value]) =>
    /key|token|password|secret|credential/i.test(key) && value && value.length >= 8).map(([, value]) => value);
  const redact = value => {
    if (typeof value === 'string') return secrets.reduce((text, secret) => text.split(secret).join('[REDACTED]'), value)
      .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [REDACTED]');
    if (Array.isArray(value)) return value.map(redact);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key,
      /authorization|api[-_]?key|password|secret|credential|cookie|accessToken|refreshToken/i.test(key) ? '[REDACTED]' : redact(nested)]));
  };
  try {
    const files = fs.readdirSync(directory).filter(file => file.startsWith('session_') && file.endsWith('.jsonl')).sort();
    const output = path.resolve(backendRoot, `${outputPath}.isolated-session-log.jsonl`);
    fs.mkdirSync(path.dirname(output), {recursive: true});
    const entries = files.flatMap(file => fs.readFileSync(path.join(directory, file), 'utf8').split('\n').filter(Boolean)
      .map(line => {
        try {return JSON.stringify(redact(JSON.parse(line)));}
        catch {return JSON.stringify({unparsedLine: true});}
      }));
    fs.writeFileSync(output, `${entries.join('\n')}\n`);
    return true;
  } catch {
    console.error('[deepseek-e2e] session_log_copy_failed; isolated evidence retained');
    return false;
  }
}

function withRuntimeOutputPath(args, outputPath, runtimeKind) {
  const next = [...args];
  const index = next.indexOf('--output');
  const runtimeOutput = outputPath.replace(/(-real)?\.json$/, (_match, realSuffix = '') =>
    `-${runtimeKind}${realSuffix}.json`);
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
  const configuredOutputTokens = process.env.OPENAI_MAX_OUTPUT_TOKENS;
  const outputTokens = configuredOutputTokens === undefined ? undefined : Number(configuredOutputTokens.trim());
  if (configuredOutputTokens !== undefined &&
      (!/^\d+$/.test(configuredOutputTokens.trim()) || !Number.isSafeInteger(outputTokens) || outputTokens <= 0)) {
    throw new Error('OPENAI_MAX_OUTPUT_TOKENS must be a positive safe integer');
  }
  const deepseekBaseUrl = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1';
  const deepseekModel = process.env.DEEPSEEK_MODEL || 'deepseek-v4-pro';
  const deepseekLightModel = process.env.DEEPSEEK_LIGHT_MODEL || 'deepseek-flash';
  const baseEnv = {
    ...process.env,
    DEEPSEEK_API_KEY: apiKey,
    OPENAI_API_KEY: apiKey,
    OPENAI_BASE_URL: deepseekBaseUrl,
    OPENAI_MODEL: deepseekModel,
    OPENAI_LIGHT_MODEL: deepseekLightModel,
    ...(outputTokens !== undefined ? {OPENAI_MAX_OUTPUT_TOKENS: String(outputTokens)} : {}),
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
  // The SDK public provider entrypoint is import-only. An offline ESM child
  // preserves this synchronous CLI without reading SDK-private JSON layouts or
  // inventing model capabilities. getModels does not refresh or contact a provider.
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', `
    import {deepseekProvider} from '@earendil-works/pi-ai/providers/deepseek';
    const model = deepseekProvider().getModels().find(candidate => candidate.id === process.argv[1]);
    if (!model) process.exitCode = 2;
    else process.stdout.write(JSON.stringify(model));
  `, '--', model], {
    cwd: backendRoot,
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 256 * 1024,
  });
  if (result.status === 2) {
    throw new Error('Unknown DeepSeek model in the installed Pi SDK; set SMARTPERFETTO_PI_AGENT_CORE_MODEL_JSON explicitly');
  }
  if (result.error || result.status !== 0) {
    throw new Error('Unable to read the installed Pi SDK model catalog; set SMARTPERFETTO_PI_AGENT_CORE_MODEL_JSON explicitly');
  }
  let catalogModel;
  try { catalogModel = JSON.parse(result.stdout); } catch {}
  if (catalogModel?.id !== model || catalogModel.provider !== 'deepseek' ||
      !Number.isSafeInteger(catalogModel.contextWindow) || catalogModel.contextWindow <= 0 ||
      !Number.isSafeInteger(catalogModel.maxTokens) || catalogModel.maxTokens <= 0) {
    throw new Error('Invalid model metadata from the installed Pi SDK');
  }
  return JSON.stringify({...catalogModel, baseUrl, apiKeyEnv: 'DEEPSEEK_API_KEY'});
}

function assertFile(filePath, label) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(`${label} not found: ${filePath}`);
  }
}

module.exports = {
  FLAGSHIP_EXPECTATIONS,
  FLAGSHIP_FINGERPRINT_KEYS,
  buildFlagshipSummary,
  compareFlagshipSummaries,
  flagshipRunVerdict,
  providerFingerprint,
  readFlagshipBaseline,
  summarizeSemanticRuntimeRecords,
  frameFactExpectation,
  suites,
  buildChildEnv,
  evaluateSemanticConditionReport,
  parseArgs,
  realProviderAvailability,
  semanticConditionArgs,
  semanticDeltaQueries,
  runSemanticPreflight,
  runSemanticPairedAttempt,
  sameTraceOccurrence,
  scenarioSliceSelector,
  systemAnalysisScenarios,
  resolveRuntimeKinds,
  runSuite,
  preserveIsolatedSessionLogs,
  withRuntimeOutputPath,
};
