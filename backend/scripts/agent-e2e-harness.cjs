#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { isDeepStrictEqual } = require('node:util');
const {providerDescriptor, providerConfiguration} = require('./agent-e2e-provider.cjs');

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
      id: column, kind: 'numeric', unit: 'frames',
      oracle: {sql: FRAME_FACT_SQL, column, unit: 'frames'},
    }))};
}

/** Independent provider-bound instances share the suite/oracle implementation, never mutable env. */
function createProviderE2eHarness(providerKind) {
  const profile = providerDescriptor(providerKind);
  let runConfiguration;
  const configuredEnv = () => runConfiguration ? {...process.env,
    [`${profile.envPrefix}_BASE_URL`]: runConfiguration.baseUrl,
    [`${profile.envPrefix}_MODEL`]: runConfiguration.model,
    [`${profile.envPrefix}_LIGHT_MODEL`]: runConfiguration.lightModel} : process.env;
  const configuration = (env = configuredEnv(), provider = profile.id) => providerConfiguration(profile, env, provider);

  const backendRoot = path.resolve(__dirname, '..');
  const verifierPath = path.join(backendRoot, 'src/scripts/verifyAgentSseScrolling.ts');
  const tsxCliPath = path.join(backendRoot, 'node_modules/tsx/dist/cli.mjs');

  const DEFAULT_RUNTIME = 'openai-agents-sdk';
  const DEFAULT_TIMEOUT_MS = 20 * 60_000;
  const PROVIDER_RUNTIME_KINDS = [
    'openai-agents-sdk',
    'pi-agent-core',
    'opencode',
  ];
  const ALL_RUNTIME_KINDS = [
    'claude-agent-sdk',
    ...PROVIDER_RUNTIME_KINDS,
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
  const FLAGSHIP_SUMMARY_SCHEMA = 'agent_sse_flagship_summary@2';
  const FLAGSHIP_SUMMARY_DIR = profile.slug === 'glm' ? 'test-output/e2e-baselines' : `test-output/e2e-baselines/${profile.slug}`;
  // A baseline older than this is still compared, but only as visibly stale local diagnosis.
  const FLAGSHIP_BASELINE_STALE_MS = 14 * 24 * 60 * 60 * 1000;
  const FLAGSHIP_CHECK_GROUPS = ['value', 'delivery'];
  const FLAGSHIP_FINGERPRINT_KEYS = ['suite', 'runtime', 'traceSha256', 'query', 'expectationHash', 'providerOrigin', 'model',
    'commit', 'gateSchemaVersion', 'traceProcessorVersion', 'stdlibRevision'];
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


  function sourceFactExpectation(query) {
    const facts = JSON.parse(fs.readFileSync(path.resolve(backendRoot,
      '../Trace/constructed/source-analysis-semantic/analysis/expected.json'), 'utf8')).source_trace_ground_truth.traceFacts;
    const marker = facts.marker.replace(/'/g, "''");
    return {schemaVersion: 1, intent: {sceneId: 'startup',
      ...(query.kind === 'quantitative-only' ? {taskKind: 'fact', scope: 'bounded_question', deliverable: 'answer'} : {})},
      facts: [{id: 'source_marker_duration', kind: 'numeric',
        value: facts.durationNs, unit: 'ns', oracle: {
          sql: `SELECT s.dur AS duration_ns FROM slice s
            JOIN thread_track tt ON s.track_id = tt.id JOIN thread t USING(utid) JOIN process p USING(upid)
            WHERE s.name = '${marker}' AND t.name = '${facts.thread}' AND p.name = '${facts.process}'`,
          column: 'duration_ns', unit: 'ns',
        }}], uncoveredFacets: query.kind === 'quantitative-only' ? undefined : ['source recommendation action semantics']};
  }

  const suites = {
    'scene-reconstruction': {
      label: 'scene reconstruction product-route verification',
      output: `test-output/e2e-${profile.slug === 'glm' ? '' : `${profile.slug}-`}scene-reconstruction-real.json`,
      args: ['--entry', 'scene-reconstruction', '--mode', 'full', '--provider-id', 'env',
        '--trace', '../Trace/real/android-scroll-customer/trace.pftrace',
        '--output', `test-output/e2e-${profile.slug === 'glm' ? '' : `${profile.slug}-`}scene-reconstruction-real.json`, '--keep-session'],
    },
    'scene-cancel': {
      label: 'scene reconstruction cancellation after candidate',
      output: `test-output/e2e-${profile.slug === 'glm' ? '' : `${profile.slug}-`}scene-cancel-real.json`,
      args: ['--entry', 'scene-reconstruction', '--scene-scenario', 'cancel', '--mode', 'full', '--provider-id', 'env',
        '--trace', '../Trace/real/android-scroll-customer/trace.pftrace',
        '--output', `test-output/e2e-${profile.slug === 'glm' ? '' : `${profile.slug}-`}scene-cancel-real.json`, '--keep-session'],
    },
    startup: {
      label: 'startup final-report gate',
      output: `test-output/e2e-${profile.slug}-startup-real.json`,
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
        `test-output/e2e-${profile.slug}-startup-real.json`,
        '--keep-session',
        '--require-non-partial',
        '--expectation-json',
        `@${FLAGSHIP_EXPECTATIONS.startup}`,
        '--forbid-degraded-fallback',
        'completed_plan_summary_fallback',
      ],
    },
    scrolling: {
      label: 'scrolling full analysis gate',
      output: `test-output/e2e-${profile.slug}-scrolling-real.json`,
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
        `test-output/e2e-${profile.slug}-scrolling-real.json`,
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
      output: `test-output/e2e-${profile.slug}-external-issue-real.json`,
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
        `test-output/e2e-${profile.slug}-external-issue-real.json`,
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
      output: `test-output/e2e-${profile.slug}-dual-trace-real.json`,
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
        `test-output/e2e-${profile.slug}-dual-trace-real.json`,
        '--keep-session',
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
      output: `test-output/e2e-${profile.slug}-context-source-real.json`,
      args: [
        '--mode', 'full',
        '--provider-id', 'env',
        '--trace', '../Trace/real/android-startup-heavy/trace.pftrace',
        '--query',
        '分析启动性能。必须先用 lookup_app_source 查询 StartupHooks，并在最终报告引用 StartupHooks.kt；源码只能解释候选机制，Trace 证据才可证明本次发生。',
        '--setup-codebase-root', 'tests/e2e/context-fixtures/app',
        '--code-aware', 'provider_send',
        '--output', `test-output/e2e-${profile.slug}-context-source-real.json`,
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
      output: `test-output/e2e-${profile.slug}-context-rag-real.json`,
      args: [
        '--mode', 'full',
        '--provider-id', 'env',
        '--trace', '../Trace/real/android-startup-heavy/trace.pftrace',
        '--query',
        '分析启动性能。必须用 search_knowledge 在所选知识库中以 "Startup first-frame knowledge fixture" 为 query 检索，综合其中关于首帧前同步主线程工作的背景知识并按 kb: 格式注明出处。知识库只能作为背景知识，不能替代 Trace 证据。',
        '--setup-knowledge-root', 'tests/e2e/context-fixtures/wiki',
        '--code-aware', 'off',
        '--output', `test-output/e2e-${profile.slug}-context-rag-real.json`,
        '--require-tool', 'search_knowledge',
        '--require-text', 'kb:',
        '--require-non-partial',
        '--forbid-degraded-fallback', 'verification_failed',
        '--forbid-degraded-fallback', 'partial_result_after_incomplete_plan',
      ],
    },
    'context-combined': {
      label: 'request-scoped source plus document knowledge base analysis gate',
      output: `test-output/e2e-${profile.slug}-context-combined-real.json`,
      args: [
        '--mode', 'full',
        '--provider-id', 'env',
        '--trace', '../Trace/real/android-startup-heavy/trace.pftrace',
        '--query',
        '分析启动性能。必须分别调用 lookup_app_source 查询 StartupHooks，并用 search_knowledge 在所选知识库中以 "Startup first-frame knowledge fixture" 为 query 检索。在结论引用 StartupHooks.kt，并综合知识库中关于首帧前同步主线程工作的背景知识、按 kb: 格式注明出处；两类上下文都不能替代 Trace 证据。',
        '--setup-codebase-root', 'tests/e2e/context-fixtures/app',
        '--setup-knowledge-root', 'tests/e2e/context-fixtures/wiki',
        '--code-aware', 'provider_send',
        '--output', `test-output/e2e-${profile.slug}-context-combined-real.json`,
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
      output: profile.slug === 'glm' ? 'test-output/code-aware-semantic-delta/real-provider'
        : `test-output/code-aware-semantic-delta/${profile.slug}`,
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
      const output = profile.slug === 'glm' ? `test-output/system-analysis/${scenario.id}.json`
        : `test-output/system-analysis/${profile.slug}/${scenario.id}.json`;
      const args = ['--mode', 'full', '--provider-id', 'env', '--trace', scenario.trace, '--query', scenario.query,
        '--output', output, '--require-non-partial', '--expectation-json', `@${expectationPath}`];
      if (scenario.selectSlice) args.push('--select-slice-json', JSON.stringify(scenario.selectSlice));
      if (scenario.referenceTrace) args.push('--reference-trace', scenario.referenceTrace,
        '--trace-pair-layout', 'horizontal', '--trace-pair-workspace-open', '--trace-pair-active', 'current');
      return {id: scenario.id, evidenceTier: scenario.evidenceTier, label: `${scenario.evidenceTier} system evidence: ${scenario.id}`,
        output, args};
    });
  }

  function main() {
    if (!process.argv.slice(2).some(arg => arg === '--help' || arg === '-h')) loadBackendEnv();
    runConfiguredSuites(parseArgs(process.argv.slice(2)));
  }

  /** Execute parsed configuration without loading a developer's .env. */
  function runConfiguredSuites(options) {
    if (options.help) {
      printUsage();
      return;
    }

    const previousConfiguration = runConfiguration;
    runConfiguration = configuration({
      [`${profile.envPrefix}_BASE_URL`]: options.baseUrl,
      [`${profile.envPrefix}_MODEL`]: options.model,
      [`${profile.envPrefix}_LIGHT_MODEL`]: options.lightModel,
    }, options.provider);
    try {
      return executeConfiguredSuites(options);
    } finally {runConfiguration = previousConfiguration;}
  }

  function executeConfiguredSuites(options) {
    assertFile(tsxCliPath, 'tsx CLI');
    assertFile(verifierPath, 'Agent SSE verifier');

    if (options.suite === SEMANTIC_DELTA_SUITE) {
      assertFreshSemanticOutputRoot(options.outputDir);
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
            runtimeKinds.length > 1 || options.runtime !== DEFAULT_RUNTIME, options.timeoutMs, scenario,
            {outputDir: options.outputDirExplicit ? options.outputDir : undefined});
          continue;
        }
        runSuite(
          suiteName,
          availability,
          runtimeKind,
          runtimeKinds.length > 1 || options.runtime !== DEFAULT_RUNTIME,
          options.timeoutMs,
          undefined,
          {outputDir: options.outputDirExplicit ? options.outputDir : undefined},
        );
      }
    }

    console.log(`\n${profile.label} Agent SSE observed checks passed: ${runtimeKinds.join(', ')} / ${suiteNames.join(', ')}${options.systemScenario ? ` / selected scenario=${options.systemScenario}` : ''}; semantic acceptance is recorded separately in each report.`);
  }

  function parseArgs(argv) {
    let provider = profile.id;
    let baseUrl = process.env[`${profile.envPrefix}_BASE_URL`] || profile.baseUrl;
    let model = process.env[`${profile.envPrefix}_MODEL`] || profile.model;
    let lightModel = process.env[`${profile.envPrefix}_LIGHT_MODEL`] || profile.lightModel;
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
    let outputDirExplicit = false;
    let outputDir = path.resolve(
      backendRoot,
      profile.slug === 'glm' ? 'test-output/code-aware-semantic-delta/real-provider'
        : `test-output/code-aware-semantic-delta/${profile.slug}`,
    );

    for (let i = 0; i < argv.length; i += 1) {
      const arg = argv[i];
      if (arg === '--help' || arg === '-h') {
        return { suite, runtime, timeoutMs, repeat, outputDir, help: true };
      }
      if (['--provider', '--base-url', '--model', '--light-model'].includes(arg)) {
        const value = argv[++i];
        if (!value) throw new Error(`${arg} requires a value`);
        if (arg === '--provider') provider = value;
        else if (arg === '--base-url') baseUrl = value;
        else if (arg === '--model') model = value;
        else lightModel = value;
        continue;
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
          throw new Error(`--runtime requires a value: openai-agents-sdk, pi-agent-core, opencode, qoder-agent-sdk, or ${profile.runtimeGroup}`);
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
        outputDirExplicit = true;
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
    const selectedProvider = configuration({[`${profile.envPrefix}_BASE_URL`]: baseUrl,
      [`${profile.envPrefix}_MODEL`]: model, [`${profile.envPrefix}_LIGHT_MODEL`]: lightModel}, provider);
    return {...selectedProvider, suite, runtime, timeoutMs, repeat, outputDir, outputDirExplicit, preflight, queryId, condition, systemScenario, strict, deltaBaseline,
      help: false };
  }

  function parseSuite(value) {
    if (value === 'all' || value === 'context' || value === FLAGSHIP_SUITE || Object.hasOwn(suites, value)) return value;
    throw new Error(`Invalid suite: ${value}. Expected all, context, ${FLAGSHIP_SUITE}, or one of: ${Object.keys(suites).join(', ')}.`);
  }

  function parseRuntime(value) {
    if (
      value === 'all' ||
      value === profile.runtimeGroup ||
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
      `Invalid runtime: ${value}. Expected claude-agent-sdk, openai-agents-sdk, pi-agent-core, opencode, qoder-agent-sdk, all, or ${profile.runtimeGroup}.`,
    );
  }

  function resolveRuntimeKinds(value) {
    parseRuntime(value);
    if (value === 'all' || value === profile.runtimeGroup) return PROVIDER_RUNTIME_KINDS;
    if (value === 'claude') return ['claude-agent-sdk'];
    if (value === 'openai') return ['openai-agents-sdk'];
    if (value === 'pi') return ['pi-agent-core'];
    if (value === 'qoder') return ['qoder-agent-sdk'];
    return [value];
  }

  function printUsage() {
    console.log(`Usage: node scripts/run-${profile.slug}-agent-e2e.cjs [--suite all|context|flagship|startup|scrolling|scene-reconstruction|scene-cancel|external-issue|dual-trace|context-source|context-rag|context-combined|code-aware-semantic-delta|system-analysis] [--runtime claude-agent-sdk|openai-agents-sdk|pi-agent-core|opencode|qoder-agent-sdk|all|${profile.runtimeGroup}] [--timeout-ms <number>] [--repeat 5] [--output-dir <path>] [--strict] [--delta-baseline <summary.json|dir>]`);
    console.log('');
    console.log(`Runs SmartPerfetto Agent SSE E2E with ${profile.label}; main ${profile.model}, light ${profile.lightModel}.`);
    console.log(`Credential precedence: ${profile.credentialKeys.join(', ')}. No other-provider or generic OpenAI fallback.`);
    console.log(`--provider ${profile.id} --base-url ${profile.baseUrl} --model ${profile.model} --light-model ${profile.lightModel}`);
    if (profile.slug === 'glm') {
      console.log('Only the official Coding Plan endpoint is allowed; the generic paid /api/paas/v4 endpoint is refused.');
      console.log('Claude uses its separate explicit native configuration; its actual provider fingerprint is recorded, not labelled GLM acceptance.');
    } else {
      console.log('Only the official DeepSeek Flash endpoint/model is allowed. Claude uses the official Anthropic-format endpoint.');
    }
    console.log('OpenAI, Pi and OpenCode receive pinned provider/model configuration. An absent installed Pi model is unavailable, never replaced with another model.');
    console.log('Qoder uses resolveModel BYOK and still requires QODER_PERSONAL_ACCESS_TOKEN or qodercli login; BYOK does not replace Qoder authentication.');
    console.log(`Each real SSE scenario has a ${DEFAULT_TIMEOUT_MS}ms default timeout; --timeout-ms changes observation only.`);
    console.log('The code-aware semantic-delta suite requires --repeat 5 and writes paired-run plus aggregate JSON artifacts.');
    console.log(`The system-analysis suite uses declarative real/constructed fixtures. all/${profile.runtimeGroup} selects OpenAI, Pi and OpenCode; Claude/Qoder require separate runs.`);
    console.log('Use --suite system-analysis --system-scenario <manifest ID> for one diagnostic; it never represents full matrix acceptance.');
    console.log('The flagship suite runs startup/scrolling independent expectation files and writes fingerprinted summaries.');
    console.log('Without --strict, wrong/undelivered answers and hard flags fail; unmeasured facets remain INCONCLUSIVE.');
    console.log('--strict requires value, delivery and every hard flag to pass. Delta baselines prove regression status, never current acceptance.');
    console.log('Explicit --output-dir refuses existing reports before dispatch. Source matrices always require an empty/fresh output directory; other legacy default paths retain their behavior.');
    console.log('For a diagnostic source scenario use --preflight --query-id autonomous-diagnosis|quantitative-only|explicit-source-location --condition A0|A2|A3 and one runtime.');
  }

  function resolveSemanticRuntimeKinds(value) {
    if (value === 'all') return ALL_RUNTIME_KINDS;
    if (value === profile.runtimeGroup) return PROVIDER_RUNTIME_KINDS;
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

  function glmCodingConfiguration(env = configuredEnv(), provider = profile.id) {
    return configuration(env, provider);
  }

  function assertPinnedModelJson(override, pinned, runtime, supportedThinkingLevels) {
    if (override) {
      let parsed;
      try { parsed = JSON.parse(override); } catch {}
      let authoredThinkingLevel;
      if (supportedThinkingLevels && parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Object.hasOwn(parsed, 'thinkingLevel')) {
        const {thinkingLevel, ...model} = parsed;
        if (typeof thinkingLevel !== 'string' || !supportedThinkingLevels.includes(thinkingLevel.trim()))
          throw new Error('Pi thinkingLevel is not supported by the installed SDK model');
        authoredThinkingLevel = thinkingLevel.trim();
        parsed = model;
      }
      if (!isDeepStrictEqual(parsed, JSON.parse(pinned))) throw new Error(`${runtime} model JSON must match the pinned ${profile.label} configuration`);
      if (authoredThinkingLevel !== undefined) return JSON.stringify({...JSON.parse(pinned), thinkingLevel: authoredThinkingLevel});
    }
    return pinned;
  }

  function realProviderAvailability(runtimeKind, env = configuredEnv()) {
    const selected = configuration(env);
    const credentialKind = profile.credentialKeys.find(key => concreteCredential(env[key]));
    const providerApiKey = credentialKind ? concreteCredential(env[credentialKind]) : undefined;
    if (runtimeKind === 'pi-agent-core' && profile.slug === 'deepseek' && providerApiKey) {
      try {readPiCatalogModel(selected.model, env);} catch (error) {
        return {available: false, reason: error.code === 'E2E_PI_MODEL_NOT_INSTALLED'
          ? 'UNSUPPORTED_INSTALLED_MODEL_METADATA' : 'PI_MODEL_METADATA_UNAVAILABLE'};
      }
    }
    if (PROVIDER_RUNTIME_KINDS.includes(runtimeKind)) {
      return providerApiKey
        ? {
            available: true,
            credentialKind,
            apiKey: providerApiKey,
          }
        : {
            available: false,
            reason: profile.missingCredential,
          };
    }
    if (runtimeKind === 'claude-agent-sdk') {
      if (profile.slug === 'deepseek') return providerApiKey
        ? {available: true, credentialKind, apiKey: providerApiKey}
        : {available: false, reason: profile.missingCredential};
      if (typeof env.ANTHROPIC_BASE_URL === 'string' && /deepseek/i.test(env.ANTHROPIC_BASE_URL))
        return {available: false, reason: 'DEEPSEEK_E2E_DISABLED'};
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
        ...(!providerApiKey ? [profile.missingCredential] : []),
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
        apiKey: providerApiKey,
      };
    }
    return {available: false, reason: 'UNSUPPORTED_RUNTIME'};
  }

  function buildSemanticChildEnv(runtimeKind, availability, isolatedRoot, env = configuredEnv()) {
    if (runtimeKind !== 'claude-agent-sdk' || profile.slug === 'deepseek') {
      return buildChildEnv(availability.apiKey, runtimeKind, isolatedRoot, env);
    }
    return {
      ...Object.fromEntries(Object.entries(env).filter(([key]) => key !== 'QODER_PERSONAL_ACCESS_TOKEN')),
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

  /** Synchronous preparation for a maintained controller; never selects from global run state. */
  function prepareProviderChild(input, env = process.env) {
    const capturedEnv = {...env,
      [`${profile.envPrefix}_BASE_URL`]: input.baseUrl ?? profile.baseUrl,
      [`${profile.envPrefix}_MODEL`]: input.model ?? profile.model,
      [`${profile.envPrefix}_LIGHT_MODEL`]: input.lightModel ?? profile.lightModel};
    const selected = configuration(capturedEnv, input.provider ?? profile.id);
    // The legacy GLM CLI's Claude branch intentionally uses independent native
    // credentials. It cannot supply this controller's provider-bound pin.
    const availability = profile.slug === 'glm' && input.runtimeKind === 'claude-agent-sdk'
      ? {available: false, reason: 'PROVIDER_BOUND_PREPARATION_UNAVAILABLE'}
      : realProviderAvailability(input.runtimeKind, capturedEnv);
    return {configuration: selected, availability,
      ...(availability.available ? {env: buildSemanticChildEnv(input.runtimeKind, availability,
        input.isolatedRoot, capturedEnv)} : {})};
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
    let sanitized = String(value || '');
    const sensitiveValues = [
      ...profile.credentialKeys.map(key => process.env[key]),
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
      .trim().slice(0, 1000);
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
    // The answer body states the independently queried marker duration.
    const traceFactPassed = fact?.matched === true && task?.checks?.['fact:source_marker_duration'] === true;
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
      (summary?.analysisCompletedSourceCitationCount || 0) === 0 &&
      sourceToolCount === 0
    );
    // The citation check against this run's references: an unissued citation is the one failure.
    const sourceBindingPassed = summary?.analysisCompletedSourceClaimVerifierStatus !== 'failed';
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
    // The run read the ground-truth source body, and the answer cites it at a location the run returned.
    const citedReferenceIds = new Set(summary?.analysisCompletedSourceCitedReferenceIds || []);
    const sourceIdentityPassed = sourceBindingPassed && matchingReferences.length > 0 &&
      matchingReferences.some(reference => citedReferenceIds.has(reference.id));
    const canaryLine = fs.readFileSync(path.join(sourceRoot, SEMANTIC_DELTA_SOURCE_FILE), 'utf8')
      .split(/\r?\n/).findIndex(line => line.includes(PRIVATE_SOURCE_CANARY)) + 1;
    // Search hits carry their context text to the provider too.
    const privacyCanaryCovered = canaryLine > 0 && fileReferences.some(reference =>
      (isBody(reference) || reference.lookupKind === 'search_hit') &&
      reference.lineRange.start <= canaryLine && reference.lineRange.end >= canaryLine);
    const sourceSemanticPassed = query?.kind === 'quantitative-only'
      ? traceFactPassed
      : traceFactPassed && sourceIdentityPassed &&
        (summary?.analysisCompletedSourceReferenceCount || 0) > 0 &&
        (summary?.analysisCompletedSourceCitationCount || 0) > 0 &&
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
    assertFreshOutput(reportPath);
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
    const attemptDir = path.join(options.outputDir, runtimeKind, 'preflight');
    const outputPath = path.join(attemptDir, query.id, `${options.condition}.preflight.json`);
    assertFreshOutput(attemptDir);
    const availability = realProviderAvailability(runtimeKind);
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
    assertFreshOutput(attemptDir);
    assertFreshOutput(path.join(input.outputDir, input.runtimeKind,
      `paired-run-${String(input.attempt).padStart(2, '0')}.json`));
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
      const config = parseModelJson(env.SMARTPERFETTO_PI_AGENT_CORE_MODEL_JSON);
      // A catalog reference nests the model id and endpoint under `catalog`.
      const model = config.catalog && typeof config.catalog === 'object' ? config.catalog : config;
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
      traceProcessorVersion: identity?.traceProcessorVersion ?? null,
      stdlibRevision: identity?.stdlibRevision ?? null,
    };
    const reportAvailable = Boolean(report && groups && typeof groups === 'object');
    // A failure artifact (timeout, lifecycle error) still says INCONCLUSIVE for its older readers;
    // here a run without judged groups never delivered, which is a failure, not an unmeasured facet.
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
      observedChecksPassed: report?.observedChecksPassed === true,
      hardGatesPassed: report?.hardGatesPassed === true,
      completeAcceptance: report?.completeAcceptance === true,
      checkGroups: reportAvailable ? groups : null,
      facts: Object.fromEntries(Object.entries(report?.taskVerification?.facts ?? {})
        .map(([id, fact]) => [id, fact?.matched === true ? 'matched' : 'none'])),
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
    const factChanges = Object.fromEntries([...new Set([...Object.keys(base.facts), ...Object.keys(current.facts)])]
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
      newFailures, fixed, unchanged, added, removed, factChanges,
      acceptance: {semantic: {from: base.semanticAcceptance, to: current.semanticAcceptance}},
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
        const summaryPath = path.join(options.outputDirExplicit ? options.outputDir : path.join(backendRoot, FLAGSHIP_SUMMARY_DIR), fileName);
        if (options.outputDirExplicit) assertFreshOutput(summaryPath);
        // Read before running: the new summary may replace the very file used as the baseline.
        const baseline = options.deltaBaseline !== undefined ? readFlagshipBaseline(options.deltaBaseline, fileName) : undefined;
        const run = runSuite(suiteName, availability, runtimeKind, runtimeSpecificOutput, options.timeoutMs, undefined,
          {throwOnFailure: false, extraArgs: options.strict ? ['--strict'] : [],
            outputDir: options.outputDirExplicit ? options.outputDir : undefined});
        const report = run.outputPath ? readJsonFile(path.resolve(backendRoot, run.outputPath)).value : undefined;
        const summary = buildFlagshipSummary({suiteName, runtimeKind, report, reportPath: run.outputPath, exitCode: run.status,
          provider: run.provider, git, strict: options.strict});
        if (baseline) summary.delta = compareFlagshipSummaries(baseline, summary);
        const verdict = flagshipRunVerdict(summary);
        summary.verdict = verdict;
        writeJson(summaryPath, summary);
        console.log(`[${profile.slug}-e2e] flagship ${suiteName}/${runtimeKind}: semantic=${summary.semanticAcceptance} ` +
          `exit=${summary.exitCode}` +
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

  // Source matrices have nested report/summary paths shared by both providers.
  // Refuse the complete previously-used output root before the first dispatch,
  // including a late repeat's old artifact, rather than failing after paid work.
  function assertFreshSemanticOutputRoot(outputDir) {
    let stat;
    try {stat = fs.lstatSync(outputDir);}
    catch (error) {if (error.code === 'ENOENT') return; throw error;}
    if (!stat.isDirectory() || fs.readdirSync(outputDir).length !== 0) {
      throw new Error('E2E source output already exists; select a fresh --output-dir');
    }
  }

  function assertFreshOutput(outputPath) {
    const resolved = path.resolve(backendRoot, outputPath);
    for (const suffix of ['', '.diagnostics.json', '.session-log.jsonl', '.isolated-session-log.jsonl']) {
      try {fs.lstatSync(`${resolved}${suffix}`);}
      catch (error) {if (error.code === 'ENOENT') continue; throw error;}
      throw new Error('E2E output already exists; select a fresh --output-dir');
    }
  }

  function runSuite(suiteName, availability, runtimeKind, runtimeSpecificOutput, timeoutMs, scenario,
    {throwOnFailure = true, extraArgs = [], outputDir} = {}) {
    const suite = scenario ?? suites[suiteName];
    const suiteArgs = runtimeSpecificOutput
      ? withRuntimeOutputPath(suite.args, suite.output, runtimeKind)
      : suite.args;
    const baseOutput = getOutputPathFromArgs(suiteArgs) ?? suite.output;
    const output = outputDir === undefined ? baseOutput : path.join(outputDir, path.basename(baseOutput));
    const args = withOutputPath([...suiteArgs, ...extraArgs, '--timeout-ms', String(timeoutMs)], output);
    if (outputDir !== undefined) assertFreshOutput(output);
    console.log(`\n[${profile.slug}-e2e] suite=${suiteName} (${suite.label})`);
    console.log(`[${profile.slug}-e2e] runtime=${runtimeKind}`);
    console.log(`[${profile.slug}-e2e] output=${getOutputPathFromArgs(args) || suite.output}`);
    console.log(`[${profile.slug}-e2e] credential=${availability.credentialKind}`);

    const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), `smartperfetto-${profile.slug}-e2e-`));
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
      console.error(`[${profile.slug}-e2e] session_log_copy_failed; isolated evidence retained`);
      return false;
    }
  }

  /** Keep one output switch, without mutating shared suite/scenario definitions. */
  function withOutputPath(args, outputPath) {
    const next = [];
    let inserted = false;
    for (let index = 0; index < args.length; index++) {
      if (args[index] !== '--output') {next.push(args[index]); continue;}
      index++;
      if (!inserted) {next.push('--output', outputPath); inserted = true;}
    }
    if (!inserted) next.push('--output', outputPath);
    return next;
  }

  function withRuntimeOutputPath(args, outputPath, runtimeKind) {
    const runtimeOutput = outputPath.replace(/(-real)?\.json$/, (_match, realSuffix = '') =>
      `-${runtimeKind}${realSuffix}.json`);
    return withOutputPath(args, runtimeOutput);
  }

  function getOutputPathFromArgs(args) {
    const index = args.indexOf('--output');
    return index >= 0 ? args[index + 1] : undefined;
  }

  function isolatedProviderEnv(env) {
    return Object.fromEntries(Object.entries(env).filter(([key]) =>
      !/^(?:GLM_|ZAI_|DEEPSEEK_|ANTHROPIC_|CLAUDE_CODE_|AWS_|AZURE_OPENAI_|GEMINI_|GOOGLE_API_KEY$|OPENAI_API_KEY$|OPENAI_BASE_URL$|OPENAI_MODEL$|OPENAI_LIGHT_MODEL$|OPENAI_AGENTS_PROTOCOL$|QODER_PERSONAL_ACCESS_TOKEN$|QODER_BYOK_|SMARTPERFETTO_PI_AGENT_CORE_MODEL_JSON$|SMARTPERFETTO_OPENCODE_MODEL_JSON$)/.test(key)));
  }

  function buildChildEnv(apiKey, runtimeKind, isolatedRoot, env = configuredEnv()) {
    const configuredOutputTokens = env.OPENAI_MAX_OUTPUT_TOKENS;
    const outputTokens = configuredOutputTokens === undefined ? undefined : Number(configuredOutputTokens.trim());
    if (configuredOutputTokens !== undefined &&
        (!/^\d+$/.test(configuredOutputTokens.trim()) || !Number.isSafeInteger(outputTokens) || outputTokens <= 0)) {
      throw new Error('OPENAI_MAX_OUTPUT_TOKENS must be a positive safe integer');
    }
    const {baseUrl, model, lightModel} = configuration(env);
    const baseEnv = {
      ...isolatedProviderEnv(env),
      [profile.credentialKeys[0]]: apiKey,
      ...(profile.slug === 'glm' ? {ZAI_CODING_CN_API_KEY: apiKey} : {}),
      OPENAI_API_KEY: apiKey,
      OPENAI_BASE_URL: baseUrl,
      OPENAI_MODEL: model,
      OPENAI_LIGHT_MODEL: lightModel,
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
          createPiAgentCoreProviderModelJson({
            model, baseUrl,
            override: env.SMARTPERFETTO_PI_AGENT_CORE_MODEL_JSON,
          }, env),
      };
    }

    if (runtimeKind === 'opencode') {
      return {
        ...baseEnv,
        SMARTPERFETTO_AGENT_RUNTIME: 'opencode',
        SMARTPERFETTO_OPENCODE_MODEL_JSON:
          assertPinnedModelJson(env.SMARTPERFETTO_OPENCODE_MODEL_JSON, JSON.stringify({
            providerID: profile.id,
            modelID: model,
            baseURL: baseUrl,
            apiKeyEnv: profile.credentialKeys[0],
            smallModel: lightModel,
          }), 'OpenCode'),
      };
    }

    if (runtimeKind === 'qoder-agent-sdk') {
      return {
        ...baseEnv,
        SMARTPERFETTO_AGENT_RUNTIME: 'qoder-agent-sdk',
        ...(env.QODER_PERSONAL_ACCESS_TOKEN !== undefined
          ? {QODER_PERSONAL_ACCESS_TOKEN: env.QODER_PERSONAL_ACCESS_TOKEN} : {}),
        QODER_MODEL: model,
        QODER_LIGHT_MODEL: lightModel,
        QODER_BYOK_API_KEY: apiKey,
        QODER_BYOK_PROVIDER: profile.slug,
        QODER_BYOK_BASE_URL: baseUrl,
        QODER_BYOK_STYLE: 'openai',
      };
    }

    if (runtimeKind === 'claude-agent-sdk' && profile.slug === 'deepseek') {
      return {...baseEnv, SMARTPERFETTO_AGENT_RUNTIME: runtimeKind,
        ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic', ANTHROPIC_AUTH_TOKEN: apiKey,
        CLAUDE_MODEL: model, CLAUDE_LIGHT_MODEL: lightModel, CLAUDE_SUB_AGENT_MODEL: model};
    }
    throw new Error(`Unsupported runtime: ${runtimeKind}`);
  }

  function readPiCatalogModel(model, env = configuredEnv()) {
    // The SDK public provider entrypoint is import-only. An offline ESM child
    // preserves this synchronous CLI without reading SDK-private JSON layouts or
    // inventing model capabilities. getModels does not refresh or contact a provider.
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', `
      import {${profile.piExport} as nativeProvider} from '@earendil-works/pi-ai/providers/${profile.id}';
      import {getSupportedThinkingLevels} from '@earendil-works/pi-ai';
      const model = nativeProvider().getModels().find(candidate => candidate.id === process.argv[1]);
      if (!model) process.exitCode = 2;
      else process.stdout.write(JSON.stringify({model, supportedThinkingLevels: getSupportedThinkingLevels(model)}));
    `, '--', model], {
      cwd: backendRoot,
      env,
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 256 * 1024,
    });
    if (result.status === 2) {
      throw Object.assign(new Error(`Unknown ${profile.label} model in the installed Pi SDK`),
        {code: 'E2E_PI_MODEL_NOT_INSTALLED'});
    }
    if (result.error || result.status !== 0) {
      throw new Error(`Unable to read the installed ${profile.label} SDK model catalog`);
    }
    let catalogModel, supportedThinkingLevels;
    try { ({model: catalogModel, supportedThinkingLevels} = JSON.parse(result.stdout)); } catch {}
    if (catalogModel?.id !== model || catalogModel.provider !== profile.id ||
        !Number.isSafeInteger(catalogModel.contextWindow) || catalogModel.contextWindow <= 0 ||
        !Number.isSafeInteger(catalogModel.maxTokens) || catalogModel.maxTokens <= 0 ||
        !Array.isArray(supportedThinkingLevels) || !supportedThinkingLevels.every(level => typeof level === 'string')) {
      throw new Error('Invalid model metadata from the installed Pi SDK');
    }
    return {catalogModel, supportedThinkingLevels};
  }

  function createPiAgentCoreProviderModelJson({model, baseUrl, override}, env = configuredEnv()) {
    const {catalogModel, supportedThinkingLevels} = readPiCatalogModel(model, env);
    return assertPinnedModelJson(override, JSON.stringify({...catalogModel, baseUrl, apiKeyEnv: profile.credentialKeys[0]}), 'Pi', supportedThinkingLevels);
  }

  function assertFile(filePath, label) {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      throw new Error(`${label} not found: ${filePath}`);
    }
  }

  return {
    main,
    buildChildEnv,
    providerConfiguration: configuration,
    buildSemanticChildEnv,
    prepareProviderChild,
    FLAGSHIP_EXPECTATIONS,
    FLAGSHIP_FINGERPRINT_KEYS,
    buildFlagshipSummary,
    compareFlagshipSummaries,
    flagshipRunVerdict,
    providerFingerprint,
    readFlagshipBaseline,
    summarizeSemanticRuntimeRecords,
    frameFactExpectation,
    glmCodingConfiguration,
    suites,
    evaluateSemanticConditionReport,
    // Fixed benchmark-only oracle inputs; callers must never accept a report-authored root.
    sourceFacetInputs: () => ({query: SEMANTIC_DELTA_QUERIES[0],
      expectation: sourceFactExpectation(SEMANTIC_DELTA_QUERIES[0]),
      sourceRoot: path.resolve(backendRoot, SEMANTIC_DELTA_SOURCE_ROOT),
      tracePath: path.resolve(backendRoot, SEMANTIC_DELTA_TRACE),
      groundTruthPath: path.resolve(backendRoot, '../Trace/constructed/source-analysis-semantic/analysis/expected.json')}),
    parseArgs,
    realProviderAvailability,
    semanticConditionArgs,
    semanticDeltaQueries,
    runSemanticPreflight,
    runSemanticPairedAttempt,
    scenarioSliceSelector,
    systemAnalysisScenarios,
    resolveRuntimeKinds,
    runSuite,
    runConfiguredSuites,
    preserveIsolatedSessionLogs,
    withRuntimeOutputPath,
  };

}

module.exports = {createProviderE2eHarness, frameFactExpectation};
