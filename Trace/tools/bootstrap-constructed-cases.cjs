#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

const fs = require('node:fs');
const path = require('node:path');

const {discoverCoverageTargets, resolveCaseTrace} = require('./lib/catalog.cjs');
const {buildConstructedTrace} = require('./lib/generator.cjs');
const {skillSqlContract} = require('./lib/skill-sql-contract.cjs');

const repoRoot = path.resolve(__dirname, '../..');
const yaml = require(require.resolve('js-yaml', {paths: [path.join(repoRoot, 'backend')]}));
const runtimeRevision = fs.readFileSync(
  path.join(repoRoot, 'scripts/trace-processor-pin.env'),
  'utf8',
).match(/^PERFETTO_VERSION=([^\s#]+)$/m)?.[1];
if (!runtimeRevision) throw new Error('scripts/trace-processor-pin.env has no PERFETTO_VERSION');

const FAMILIES = [
  {
    id: 'startup-lifecycle',
    title: 'Startup and process lifecycle',
    scene: 'startup',
    base: 'android-startup-heavy',
    android: {release: '16', api_level: 36, device: 'Xiaomi pandora base'},
    skillPattern: /(^startup|launcher|app_process_start)/,
    strategies: ['startup'],
    signatures: ['MetricsLogger:launchObserverNotifyIntentStarted', 'activityStart', 'bindApplication'],
  },
  {
    id: 'scheduler-cpu-contention',
    title: 'Scheduler and CPU contention',
    scene: 'cpu',
    base: 'android-scroll-customer',
    android: {release: '16', api_level: 36, device: 'OPPO PKH110 base'},
    skillPattern: /(cpu|sched|thread_affinity|runqueue|irq|futex|cache_miss|system_load|util_tracking|task_migration)/,
    strategies: [],
    signatures: ['RunnableWait', 'CPU contention', 'sched_blocked_reason'],
  },
  {
    id: 'rendering-jank',
    title: 'Rendering pipeline jank',
    scene: 'scrolling',
    base: 'android-scroll-customer',
    android: {release: '16', api_level: 36, device: 'OPPO PKH110 base'},
    skillPattern: /(frame|jank|scroll|render|surfaceflinger|sf_|vsync|vrr|textureview|buffer_transaction|consumer|choreographer|fpsgo|game_fps|gl_standalone|present_fence)/,
    strategies: ['game', 'scroll_response', 'scrolling'],
    signatures: ['Choreographer#doFrame', 'DrawFrame', 'SurfaceFlinger::commit', 'queueBuffer'],
  },
  {
    id: 'input-interaction-latency',
    title: 'Input and interaction latency',
    scene: 'interaction',
    base: 'android-scroll-customer',
    android: {release: '16', api_level: 36, device: 'OPPO PKH110 base'},
    skillPattern: /(input|touch|click|handler|navigation|app_lifecycle|scene_reconstruction|state_timeline)/,
    strategies: ['interaction', 'touch_tracking'],
    signatures: ['InputDispatcher::dispatch', 'deliverInputEvent', 'performClick'],
  },
  {
    id: 'binder-io-blocking',
    title: 'Binder, lock, and I/O blocking',
    scene: 'io',
    base: 'android-startup-heavy',
    android: {release: '16', api_level: 36, device: 'Xiaomi pandora base'},
    skillPattern: /(binder|blocking_chain|lock|file_io|page_fault|block_io|io_pressure|filesystem|anr)/,
    strategies: ['anr', 'io'],
    signatures: ['binder transaction', 'monitor contention', 'FileIO'],
  },
  {
    id: 'memory-gc-pressure',
    title: 'Memory and GC pressure',
    scene: 'memory',
    base: 'android-startup-light',
    android: {release: '16', api_level: 36, device: 'Google raven base'},
    skillPattern: /(memory|heap|rss|lmk|oom|gc|native_heap|bitmap|dmabuf)/,
    strategies: ['memory'],
    signatures: ['GC Young Concurrent', 'HeapTrim', 'memory pressure'],
  },
  {
    id: 'power-thermal',
    title: 'Power and thermal throttling',
    scene: 'power',
    base: 'android-scroll-customer',
    android: {release: '16', api_level: 36, device: 'OPPO PKH110 base'},
    skillPattern: /(power|battery|thermal|wakelock|wakeup|doze|dvfs|screen_off|suspend)/,
    strategies: ['power'],
    signatures: ['thermal_throttling', 'WakeLock', 'device_suspend'],
  },
  {
    id: 'gpu-workload',
    title: 'GPU workload and frequency',
    scene: 'gpu',
    base: 'android-scroll-customer',
    android: {release: '16', api_level: 36, device: 'OPPO PKH110 base'},
    skillPattern: /(gpu|mali|vulkan|opengl|angle)/,
    strategies: [],
    signatures: ['GPU completion', 'vkQueueSubmit', 'gpu_work_period'],
  },
  {
    id: 'linux-system-state',
    title: 'Linux and Android system state',
    scene: 'linux',
    base: 'android-startup-light',
    android: {release: '16', api_level: 36, device: 'Google raven base'},
    skillPattern: /(linux|systemd|device_state|trace_state|android_job|logcat)/,
    strategies: ['linux'],
    signatures: ['system_server state', 'journald', 'JobScheduler'],
  },
  {
    id: 'media-network-camera',
    title: 'Media, network, and camera pipeline',
    scene: 'media',
    base: 'android-scroll-customer',
    android: {release: '16', api_level: 36, device: 'OPPO PKH110 base'},
    skillPattern: /(media|network|modem|camera|webview_v8)/,
    strategies: ['media', 'network'],
    signatures: ['Camera3-Device', 'MediaCodec::queueInputBuffer', 'NetworkRequest'],
  },
  {
    id: 'framework-pipelines',
    title: 'Framework rendering pipeline signatures',
    scene: 'pipeline',
    base: 'android-startup-heavy',
    android: {release: '16', api_level: 36, device: 'Xiaomi pandora base'},
    skillPattern: /(^pipeline_|_module$|flutter_scrolling|rn_|compose_|webview_draw|code_pinpoint)/,
    strategies: ['pipeline'],
    signatures: ['Recomposer:recompose', 'Flutter::BeginFrame', 'RN::FabricCommit', 'WebView::DrawFun'],
  },
  {
    id: 'general-runtime-contracts',
    title: 'General analysis and runtime contracts',
    scene: 'general',
    base: 'android-scroll-customer',
    android: {release: '16', api_level: 36, device: 'OPPO PKH110 base'},
    skillPattern: /.*/,
    strategies: [
      'general',
      'multi_trace_result_comparison',
      'overview',
      'runtime_correctness',
      'smart',
      'teaching',
      'verifier_misdiagnosis',
    ],
    signatures: ['SmartPerfetto::general-analysis', 'trace overview', 'comparison baseline'],
  },
];

const SEMANTIC_STEP_OVERRIDES = new Map([
  ['cpu_topology_view', 'read_topology'],
  ['network_analysis', 'network_slice_overview'],
  ['android_heap_dominator_path_extract', 'dominator_paths'],
  ['gpu_compute_kernel_analysis', 'kernel_summary'],
  ['camera_trace_evidence', 'camera_slice_candidates'],
  ['rendering_pipeline_detection', 'determine_pipeline'],
]);

const REQUIRED_STEP_OVERRIDES = new Map([
  ['gpu_compute_kernel_analysis', 'launch_configuration'],
  ['camera_trace_evidence', 'camera_slice_candidates'],
]);

const SEMANTIC_ASSERTION_OVERRIDES = new Map([
  ['camera_trace_evidence', {
    min_rows: 2,
    assertions: [
      {column: 'slice_name', operator: 'contains', value: 'Camera3-Device'},
    ],
  }],
  ['gpu_compute_kernel_analysis', {
    min_rows: 2,
    assertions: [
      {column: 'kernel', operator: 'contains', value: 'SyntheticComputeKernelA'},
      {column: 'dur_ns', operator: 'gte', value: 12000000},
    ],
  }],
  ['android_heap_dominator_path_extract', {
    min_rows: 1,
    assertions: [
      {column: 'path', operator: 'contains', value: 'LeakContainer'},
      {column: 'retained_size_bytes', operator: 'gte', value: 12582912},
    ],
  }],
]);

const EXPECTED_LIMITATIONS = new Map([
  ['android_kernel_wakelock_summary', {mode: 'deferred', reason: 'The current generator does not emit android_kernel_wakelock counter tracks.'}],
  ['binder_root_cause', {mode: 'deferred', reason: 'The fixture has blocking slices but no kernel Binder transaction packet chain.'}],
  ['block_io_analysis', {mode: 'deferred', reason: 'The fixture does not yet emit block_rq ftrace events.'}],
  ['linux_perf_counter_hotspots', {mode: 'deferred', reason: 'The fixture does not contain PMU perf sample/counter packets.'}],
  ['native_heap_breakdown', {mode: 'deferred', reason: 'The fixture does not contain heapprofd allocation packets.'}],
  ['wattson_app_startup_power', {mode: 'deferred', reason: 'Wattson startup attribution is device-model gated and unsupported by this base device.'}],
  ['dmabuf_analysis', {mode: 'deferred', reason: 'The SQL contract executes, but this fixture does not contain DMA-BUF allocation or residency events.'}],
  ['page_fault_in_range', {mode: 'deferred', reason: 'The pinned trace schema requires sched_blocked_reason plus resolvable kernel symbols to populate thread_state.blocked_function for page-fault attribution.'}],
  ['startup_main_thread_binder_blocking_in_range', {mode: 'deferred', reason: 'The current generator does not yet emit a paired kernel Binder transaction/reply chain inside the synthetic startup interval.'}],
  ['startup_class_loading_in_range', {mode: 'deferred', reason: 'The current generator does not yet emit the system_server launch markers required for android_startups to associate L*; class-loading slices with the synthetic process.'}],
  ['startup_thread_blocking_graph', {mode: 'deferred', reason: 'The current generator does not yet emit sched_wakeup relationships that populate thread_state.waker_utid for the synthetic startup threads.'}],
]);

const ISOLATED_SQL_PROBES = new Map([
  ['cpu_topology_view', [{
    step: 'drop_existing_topology_view',
    setup_sql: ['CREATE PERFETTO VIEW _cpu_topology AS SELECT 0 AS cpu_id'],
  }]],
]);

function listSkillFiles(root) {
  const result = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, {withFileTypes: true})) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(absolute);
      else if (
        entry.isFile() &&
        entry.name.endsWith('.skill.yaml') &&
        !entry.name.startsWith('_') &&
        !absolute.split(path.sep).includes('_template')
      ) result.push(absolute);
    }
  }
  return result.sort();
}

function loadSkills() {
  return listSkillFiles(path.join(repoRoot, 'backend/skills')).map((filePath) => {
    const definition = yaml.load(fs.readFileSync(filePath, 'utf8'));
    return {filePath, definition};
  });
}

function loadStrategyFixtures() {
  const strategiesRoot = path.join(repoRoot, 'backend/strategies');
  return new Map(
    fs.readdirSync(strategiesRoot)
      .filter((name) => name.endsWith('.strategy.md'))
      .sort()
      .map((name) => {
        const filePath = path.join(strategiesRoot, name);
        const source = fs.readFileSync(filePath, 'utf8');
        const frontmatter = source.match(/^---\s*$([\s\S]*?)^---\s*$/m);
        if (!frontmatter) throw new Error(`Strategy has no frontmatter: ${name}`);
        const definition = yaml.load(frontmatter[1]);
        const keywords = Array.isArray(definition.keywords)
          ? definition.keywords.filter((keyword) => typeof keyword === 'string' && keyword.trim() !== '')
          : [];
        const query = keywords[0] ?? (definition.scene === 'general' ? '分析这份 trace' : null);
        if (definition.strategy_kind !== 'contract_only' && !query) {
          throw new Error(`Strategy has no classifier fixture query: ${definition.scene}`);
        }
        return [definition.scene, {query, source_file: path.relative(repoRoot, filePath).split(path.sep).join('/')}];
      }),
  );
}

function familyForSkill(skillId) {
  return FAMILIES.find((family) => family.skillPattern.test(skillId));
}

function parameterValue(input, identities) {
  const name = String(input.name ?? '');
  if (name === 'slice_names') return "'Choreographer#doFrame','DrawFrame','queueBuffer','latchBuffer'";
  if (name === 'package' || name.includes('process_name')) {
    return input.required ? 'com.smartperfetto.fixture' : '';
  }
  if (name === 'startup_type' || name === 'launch_type') return 'cold';
  if (name === 'event_type') return 'tap';
  if (name === 'event_action') return 'ACTION_UP';
  if (name === 'event_ts' || name.endsWith('start_ts')) return '${fixture_start}';
  if (name === 'event_end_ts' || name.endsWith('end_ts')) return '${fixture_end}';
  if (name === 'pid' || name.endsWith('_pid')) return identities.processes.app;
  if (name === 'tid' || name.endsWith('_tid')) return identities.threads.main;
  if (name === 'upid') return '${fixture_upid}';
  if (name === 'utid') return '${fixture_utid}';
  if (name.includes('frame') || name.includes('vsync') || name.endsWith('_id')) return 1;
  if (input.default !== undefined) return input.default;
  if (input.type === 'boolean') return false;
  if (['number', 'integer', 'timestamp', 'duration'].includes(input.type)) return 1;
  if (input.type === 'array') return [];
  return '';
}

function skillExpectation(skill, family, identities) {
  const definition = skill.definition;
  const contract = skillSqlContract(definition);
  const {steps, hasRootSql} = contract;
  const parameters = {};
  for (const input of Array.isArray(definition.inputs) ? definition.inputs : []) {
    if (input.required || input.default !== undefined) {
      parameters[input.name] = parameterValue(input, identities);
    }
  }
  if (definition.name === 'jank_frame_detail') {
    parameters.package = 'com.smartperfetto.fixture';
    parameters.pid = identities.processes.app;
    parameters.start_ts = '${trace_start}';
    parameters.end_ts = '${trace_end}';
  }
  if (definition.name === 'scroll_session_analysis') {
    parameters.touch_start_ts = '${trace_start}';
    parameters.touch_end_ts = '${trace_end}';
    parameters.fling_start_ts = '${trace_start}';
    parameters.fling_end_ts = '${trace_end}';
    parameters.has_fling = 1;
  }
  if (!hasRootSql && steps.length === 0) {
    return {
      id: `definition-${definition.name}`,
      type: 'skill',
      target: definition.name,
      mode: 'definition',
      source_file: path.relative(repoRoot, skill.filePath).split(path.sep).join('/'),
      required_marker: `SmartPerfetto::CASE::${family.id}`,
    };
  }
  if (hasRootSql) {
    const limitation = EXPECTED_LIMITATIONS.get(definition.name);
    const semanticAssertions = SEMANTIC_ASSERTION_OVERRIDES.get(definition.name);
    const columns = contract.sqlSourceSteps.find((step) => step.id === 'root')?.requiredColumns ?? [];
    const mode = limitation?.mode ?? (columns.length > 0 || semanticAssertions ? 'semantic' : 'execution');
    return {
      id: `execute-${definition.name}`,
      type: 'skill',
      target: definition.name,
      mode,
      source_file: path.relative(repoRoot, skill.filePath).split(path.sep).join('/'),
      parameters,
      required_steps: ['root'],
      required_sql_steps: ['root'],
      forced_sql_steps: [],
      isolated_sql_probes: [],
      expected_condition_skips: [],
      semantic_step: 'root',
      ...(mode === 'semantic' && columns.length > 0 ? {required_columns: columns} : {}),
      ...(semanticAssertions ?? {}),
      ...(limitation ? {limitation_reason: limitation.reason} : {}),
      ...(limitation?.expected_error ? {expected_error: limitation.expected_error} : {}),
      ...(limitation?.mode === 'unavailable' ? {
        expected_unavailable_sql_steps: [{
          step: 'root',
          reason: limitation.reason,
          error: limitation.expected_error,
        }],
      } : {}),
      required_marker: `SmartPerfetto::CASE::${family.id}`,
    };
  }
  const overrideStep = SEMANTIC_STEP_OVERRIDES.get(definition.name);
  const semanticStepIndex = overrideStep
    ? steps.findIndex((step) => step.id === overrideStep)
    : steps.findIndex((step) =>
    typeof step?.id === 'string' &&
    step.type === 'atomic' &&
    typeof step.sql === 'string' &&
    step.sql.trim() !== '' &&
    step.display &&
    step.display !== false &&
    step.display?.level !== 'hidden',
    );
  const selectedStepIndex = semanticStepIndex >= 0
    ? semanticStepIndex
    : steps.findIndex((step) => typeof step?.id === 'string');
  const requiredStep = REQUIRED_STEP_OVERRIDES.get(definition.name);
  const requiredStepIndex = requiredStep ? steps.findIndex((step) => step.id === requiredStep) : -1;
  if (requiredStep && requiredStepIndex < 0) throw new Error(`Unknown required step override for ${definition.name}: ${requiredStep}`);
  const executionEndIndex = contract.sqlIds.length === 0
    ? steps.length - 1
    : Math.max(selectedStepIndex, requiredStepIndex, contract.lastSqlTopLevelIndex);
  const requiredSteps = steps
    .slice(0, executionEndIndex >= 0 ? executionEndIndex + 1 : steps.length)
    .map((step) => step.id)
    .filter(Boolean);
  const requiredSqlSteps = contract.sqlIds;
  const forcedSqlSteps = contract.forcedSqlStepIds;
  const isolatedSqlProbes = ISOLATED_SQL_PROBES.get(definition.name) ?? [];
  const isolatedSqlStepIds = new Set(isolatedSqlProbes.map((probe) => probe.step));
  const expectedConditionSkips = contract.conditionOnlySqlStepIds
    .filter((stepId) => !isolatedSqlStepIds.has(stepId))
    .map((stepId) => ({
      step: stepId,
      reason: 'This conditional SQL is exercised only on its production branch because forcing it would mutate state or require condition-populated context.',
    }));
  const limitation = EXPECTED_LIMITATIONS.get(definition.name);
  const semanticAssertions = SEMANTIC_ASSERTION_OVERRIDES.get(definition.name);
  const selectedStep = selectedStepIndex >= 0 ? steps[selectedStepIndex] : null;
  const columns = contract.sqlSourceSteps.find((step) => step.id === selectedStep?.id)?.requiredColumns ?? [];
  const mode = limitation?.mode ?? (columns.length > 0 || semanticAssertions ? 'semantic' : 'execution');
  return {
    id: `execute-${definition.name}`,
    type: 'skill',
    target: definition.name,
    // Executing a step and observing rows proves runtime compatibility, but it
    // does not prove that the returned values are semantically correct. Keep
    // that weaker contract explicit so the corpus cannot over-report semantic
    // coverage when no value assertion exists yet.
    mode,
    source_file: path.relative(repoRoot, skill.filePath).split(path.sep).join('/'),
    parameters,
    required_steps: requiredSteps,
    required_sql_steps: requiredSqlSteps,
    forced_sql_steps: forcedSqlSteps,
    isolated_sql_probes: isolatedSqlProbes,
    expected_condition_skips: expectedConditionSkips,
    semantic_step: selectedStepIndex >= 0 ? steps[selectedStepIndex].id : null,
    ...(mode === 'semantic' && columns.length > 0 ? {required_columns: columns} : {}),
    ...(semanticAssertions ?? {}),
    ...(limitation ? {limitation_reason: limitation.reason} : {}),
    ...(limitation?.expected_error ? {expected_error: limitation.expected_error} : {}),
    ...(limitation?.mode === 'unavailable' ? {
      expected_unavailable_sql_steps: requiredSqlSteps.map((stepId) => ({
        step: stepId,
        reason: limitation.reason,
        error: limitation.expected_error,
      })),
    } : {}),
    required_marker: `SmartPerfetto::CASE::${family.id}`,
  };
}

function strategyExpectation(strategy, family, fixture) {
  return {
    id: `strategy-${strategy}`,
    type: 'strategy',
    target: strategy,
    query: fixture.query ?? `contract-only:${strategy}`,
    expected_strategy: strategy,
    source_file: fixture.source_file,
    required_marker: `SmartPerfetto::CASE::${family.id}`,
  };
}

function scenarioForFamily(family) {
  const slices = [`SmartPerfetto::CASE::${family.id}`, ...family.signatures];
  const targetedSlices = {
    'scheduler-cpu-contention': [
      ['system', 'system-main', 'sched_blocked_reason'],
    ],
    'rendering-jank': [
      ['app', 'game', 'PlayerLoop'],
      ['app', 'game', 'eglSwapBuffers'],
      ['app', 'game', 'eglSwapBuffers'],
      ['app', 'game', 'eglSwapBuffers'],
      ['app', 'rn-js', 'BatchedBridge::callFunctionReturnFlushedQueue'],
      ['app', 'rn-native', 'UIManager::dispatchViewUpdates'],
      ['app', 'rn-native', 'FabricMount::executeMount'],
      ['app', 'webview', 'DrawGL::DrawFunctor'],
      ['app', 'webview', 'V8.GCCompactor'],
    ],
    'input-interaction-latency': [
      ['system', 'system-main', 'InputDispatcher::dispatchMotion'],
      ['app', 'main', 'deliverInputEvent src=0x1002'],
      ['app', 'main', 'performClick'],
      ['app', 'main', 'SyntheticHandler: dispatchMessage'],
      ['app', 'main', 'ActivityThread::performCreate'],
      ['app', 'main', 'ActivityThread::performResume'],
    ],
    'binder-io-blocking': [
      ['system', 'system-main', 'binder transaction'],
      ['app', 'main', 'monitor contention'],
      ['app', 'main', 'FileIO::fsync'],
    ],
    'gpu-workload': [
      ['app', 'render', 'vkQueueSubmit'],
      ['app', 'render', 'eglSwapBuffers'],
    ],
    'linux-system-state': [
      ['system', 'system-main', 'device_idle'],
    ],
    'media-network-camera': [
      ['app', 'webview', 'V8.GCCompactor'],
      ['app', 'webview', 'v8.run::LongTask'],
      ['app', 'render', 'MediaCodec::queueInputBuffer'],
      ['app', 'render', 'Camera3-Device::processCaptureRequest'],
      ['app', 'main', 'NetworkRequest::TTFB'],
    ],
    'framework-pipelines': [
      ['app', 'main', 'Choreographer#doFrame'],
      ['app', 'render', 'DrawFrame'],
      ['app', 'render', 'queueBuffer'],
      ['sf', 'sf-main', 'latchBuffer'],
      ['system', 'system-main', 'WindowAnimation'],
      ['system', 'system-main', 'AppTransition'],
      ['app', 'rn-native', 'FabricMount::executeMount'],
      ['app', 'webview', 'DrawGL::DrawFunctor'],
    ],
  }[family.id] ?? [];
  const familySignals = [];
  if (family.id === 'scheduler-cpu-contention') {
    familySignals.push(
      {type: 'cpu-frequency', at_ns: '15000000', cpu_id: 0, value: 1200000, cpu: 0},
      {type: 'sched-running', at_ns: '20000000', duration_ns: '80000000', thread: 'main', cpu: 0, end_state: 'S'},
      {type: 'atrace-counter', at_ns: '30000000', process: 'app', thread: 'main', name: 'L3 cache misses', value: 100000},
      {type: 'atrace-counter', at_ns: '80000000', process: 'app', thread: 'main', name: 'L3 cache misses', value: 350000},
      {type: 'cpu-frequency', at_ns: '520000000', cpu_id: 0, value: 1800000, cpu: 0},
      {type: 'irq-span', at_ns: '540000000', duration_ns: '4000000', irq: 42, name: 'synthetic_irq', cpu: 0},
      {
        type: 'atrace-async-track-slice',
        at_ns: '560000000',
        duration_ns: '30000000',
        process: 'system',
        thread: 'system-main',
        track_name: 'JobScheduler',
        name: 'scheduled job #12#<10999>com.smartperfetto.fixture/.SyntheticJob#',
        cookie: 12,
      },
    );
  }
  if (family.id === 'rendering-jank') {
    familySignals.push(
      {type: 'frame-timeline', at_ns: '280000000', duration_ns: '160000000', process: 'app', cookie: 101, token: 201, display_frame_token: 301, layer_name: 'SyntheticJankLayer', jank_type: 64},
      {type: 'atrace-slice', at_ns: '310000000', duration_ns: '30000000', process: 'app', thread: 'main', name: 'binder transaction'},
      {type: 'gpu-frequency', at_ns: '500000000', gpu_id: 0, value: 700000, cpu: 0},
    );
  }
  if (family.id === 'input-interaction-latency' || family.id === 'linux-system-state') {
    familySignals.push(
      {type: 'atrace-counter', at_ns: '520000000', process: 'system', thread: 'system-main', name: 'ScreenState', value: 1},
      {type: 'battery-counters', at_ns: '540000000', capacity_percent: 80, charge_counter_uah: '4000000', current_ua: '-500000', voltage_uv: '4000000'},
    );
    if (family.id === 'input-interaction-latency') {
      familySignals.push(
        {type: 'atrace-counter', at_ns: '560000000', process: 'system', thread: 'system-main', name: 'DozeDeepState', value: 5},
        {type: 'atrace-counter', at_ns: '660000000', process: 'system', thread: 'system-main', name: 'DozeDeepState', value: 0},
      );
    }
  }
  if (family.id === 'memory-gc-pressure') {
    familySignals.push(
      {type: 'process-stats', at_ns: '400000000', process: 'app', vm_rss_kb: 102400, rss_anon_kb: 81920, rss_file_kb: 20480, rss_shmem_kb: 1024, vm_swap_kb: 1024, vm_hwm_kb: 122880, oom_score_adj: 200},
      {type: 'atrace-counter', at_ns: '500000000', process: 'app', thread: 'main', name: 'Heap size (KB)', value: 196608},
      {type: 'sched-running', at_ns: '510000000', duration_ns: '80000000', thread: 'main', cpu: 0, end_state: 'S'},
      {type: 'atrace-slice', at_ns: '520000000', duration_ns: '40000000', process: 'app', thread: 'main', name: 'Background concurrent copying GC'},
      {type: 'atrace-counter', at_ns: '590000000', process: 'app', thread: 'main', name: 'Heap size (KB)', value: 131072},
      {type: 'process-stats', at_ns: '600000000', process: 'app', vm_rss_kb: 174080, rss_anon_kb: 133120, rss_file_kb: 40960, rss_shmem_kb: 2048, vm_swap_kb: 4096, vm_hwm_kb: 184320, oom_score_adj: 900},
      {type: 'android-log', at_ns: '610000000', process: 'app', thread: 'main', log_id: 'MAIN', priority: 'WARN', tag: 'ActivityManager', message: 'ANR in com.smartperfetto.fixture: input dispatching timed out after GC pressure'},
      {type: 'atrace-slice', at_ns: '620000000', duration_ns: '1000000', process: 'app', thread: 'main', name: 'SI$com.smartperfetto.fixture.LeakedActivity.onDestroy'},
      {
        type: 'managed-heap-graph',
        at_ns: '650000000',
        process: 'app',
        heap_bytes_allocated: '12582976',
        types: [
          {id: 1, class_name: 'com.smartperfetto.fixture.RootHolder', object_size: 64},
          {id: 2, class_name: 'com.smartperfetto.fixture.LeakContainer', object_size: 8388608},
          {id: 3, class_name: 'com.smartperfetto.fixture.LeakedActivity', object_size: 4194304},
        ],
        objects: [
          {id: 1, type_id: 1, self_size: 64, reference_object_ids: [2]},
          {id: 2, type_id: 2, self_size: 8388608, reference_object_ids: [3]},
          {id: 3, type_id: 3, self_size: 4194304, reference_object_ids: []},
        ],
        roots: [{root_type: 'ROOT_JNI_GLOBAL', object_ids: [1]}],
      },
      {type: 'lmk-kill', at_ns: '700000000', duration_ns: '1000000', process: 'app', thread: 'main', kill_reason: 3, oom_score_adj: 900},
    );
  }
  if (family.id === 'power-thermal') {
    familySignals.push(
      {type: 'battery-counters', at_ns: '400000000', capacity_percent: 80, charge_counter_uah: '4000000', current_ua: '-500000', voltage_uv: '4000000'},
      {type: 'battery-counters', at_ns: '600000000', capacity_percent: 79, charge_counter_uah: '3999000', current_ua: '-550000', voltage_uv: '3980000'},
      {type: 'atrace-counter', at_ns: '410000000', process: 'system', thread: 'system-main', name: 'DozeDeepState', value: 5},
      {type: 'atrace-counter', at_ns: '610000000', process: 'system', thread: 'system-main', name: 'DozeDeepState', value: 0},
      {type: 'atrace-counter', at_ns: '420000000', process: 'system', thread: 'system-main', name: 'domain@0 Frequency', value: 800000},
      {type: 'atrace-counter', at_ns: '620000000', process: 'system', thread: 'system-main', name: 'domain@0 Frequency', value: 1600000},
      {type: 'power-rail', at_ns: '430000000', duration_ns: '200000000', name: 'SYNTHETIC_CPU', subsystem: 'CPU', start_energy_uws: '1000000', end_energy_uws: '1300000'},
      {type: 'gpu-work-period', at_ns: '450000000', duration_ns: '30000000', gpu_id: 0, uid: 10999, active_duration_ns: '24000000', cpu: 0},
      {type: 'gpu-frequency', at_ns: '450000000', gpu_id: 0, value: 700000, cpu: 0},
      {type: 'gpu-power-state', at_ns: '450000000', old_state: 0, new_state: 2, cpu: 0},
      {type: 'cpu-frequency', at_ns: '460000000', cpu_id: 0, value: 1800000, cpu: 0},
      {type: 'cpu-idle', at_ns: '470000000', cpu_id: 0, state: 1, cpu: 0},
    );
  }
  if (family.id === 'gpu-workload') {
    familySignals.push(
      {type: 'gpu-work-period', at_ns: '450000000', duration_ns: '30000000', gpu_id: 0, uid: 10999, active_duration_ns: '24000000', cpu: 0},
      {type: 'gpu-frequency', at_ns: '450000000', gpu_id: 0, value: 700000, cpu: 0},
      {type: 'gpu-power-state', at_ns: '460000000', old_state: 0, new_state: 2, cpu: 0},
      {
        type: 'gpu-compute-kernel',
        at_ns: '500000000',
        duration_ns: '12000000',
        process: 'app',
        gpu_id: 0,
        context: '1001',
        kernel: 'SyntheticComputeKernelA',
        demangled_kernel: 'SyntheticComputeKernelA(float*)',
        arch: 'synthetic-v1',
        grid: {x: 64, y: 2, z: 1},
        workgroup: {x: 32, y: 2, z: 1},
        args: {registers_per_thread: 24, shared_mem_static: 1024, shared_mem_dynamic: 2048, barriers_per_block: 2, waves_per_multiprocessor: 4},
      },
      {
        type: 'gpu-compute-kernel',
        at_ns: '540000000',
        duration_ns: '7000000',
        process: 'app',
        gpu_id: 0,
        context: '1001',
        kernel: 'SyntheticComputeKernelB',
        demangled_kernel: 'SyntheticComputeKernelB(int*)',
        arch: 'synthetic-v1',
        grid: {x: 32, y: 1, z: 1},
        workgroup: {x: 16, y: 1, z: 1},
        args: {registers_per_thread: 16, shared_mem_static: 512, shared_mem_dynamic: 0, barriers_per_block: 1, waves_per_multiprocessor: 2},
      },
    );
  }
  if (family.id === 'binder-io-blocking') {
    familySignals.push(
      {type: 'sched-running', at_ns: '50000000', duration_ns: '100000000', thread: 'main', cpu: 0, end_state: 'D'},
      {
        type: 'anr-event',
        at_ns: '800000000',
        process: 'system',
        thread: 'system-main',
        target_process: 'app',
        error_id: 'smartperfetto-synthetic-anr',
        subject: 'Input dispatching timed out waiting for com.smartperfetto.fixture',
        cpu: 0,
      },
    );
  }
  if (family.id === 'startup-lifecycle') {
    familySignals.push(
      {type: 'sched-running', at_ns: '90000000', duration_ns: '150000000', thread: 'main', cpu: 0, end_state: 'S'},
      {type: 'atrace-slice', at_ns: '110000000', duration_ns: '25000000', process: 'app', thread: 'main', name: 'Lcom/smartperfetto/fixture/HomeActivity;'},
      {type: 'atrace-slice', at_ns: '145000000', duration_ns: '60000000', process: 'app', thread: 'main', name: 'inflate com.smartperfetto.fixture.activity_main'},
    );
  }
  if (family.id === 'general-runtime-contracts') {
    familySignals.push(
      {type: 'sched-running', at_ns: '50000000', duration_ns: '100000000', thread: 'main', cpu: 0, end_state: 'S'},
      {
        type: 'perf-sample',
        at_ns: '700000000',
        process: 'app',
        thread: 'main',
        function_name: 'SmartPerfettoSyntheticHotFunction',
        module_name: 'libsmartperfetto_fixture.so',
        sample_count: 12,
        sample_interval_ns: '1000000',
        cpu: 0,
      },
    );
  }
  return {
    schema_version: 1,
    clock: {anchor: 'trace-middle', duration_ns: '1000000000'},
    actors: {
      processes: [
        {id: 'app', name: 'com.smartperfetto.fixture', uid: 10999},
        {id: 'system', name: 'system_server', uid: 1000},
        {id: 'sf', name: '/system/bin/surfaceflinger', uid: 1000},
      ],
      threads: [
        {id: 'main', process: 'app', name: 'main', is_main: true},
        {id: 'render', process: 'app', name: 'RenderThread'},
        {id: 'game', process: 'app', name: 'GameThread'},
        {id: 'rn-js', process: 'app', name: 'mqt_js'},
        {id: 'rn-native', process: 'app', name: 'mqt_native_modules'},
        {id: 'webview', process: 'app', name: 'CrRendererMain'},
        {id: 'system-main', process: 'system', name: 'android.fg', is_main: true},
        {id: 'sf-main', process: 'sf', name: 'surfaceflinger', is_main: true},
      ],
    },
    signals: [
      ...slices.map((name, index) => ({
        type: 'atrace-slice',
        at_ns: String(10000000 + index * 30000000),
        duration_ns: String(18000000 + index * 1000000),
        process: 'app',
        thread: index % 2 === 0 ? 'main' : 'render',
        name,
      })),
      ...targetedSlices.map(([process, thread, name], index) => ({
        type: 'atrace-slice',
        at_ns: String(200000000 + index * 25000000),
        duration_ns: String(22000000 + index * 1000000),
        process,
        thread,
        name,
      })),
      {
        type: 'atrace-counter',
        at_ns: '250000000',
        process: 'app',
        thread: 'main',
        name: `SmartPerfetto.${family.id}.pressure`,
        value: 73,
      },
      {
        type: 'sched-running',
        at_ns: '300000000',
        duration_ns: '45000000',
        thread: 'main',
        cpu: 0,
        end_state: family.id === 'binder-io-blocking' ? 'D' : 'S',
      },
      {
        type: 'sched-running',
        at_ns: '380000000',
        duration_ns: '20000000',
        thread: 'main',
        cpu: 0,
        end_state: family.id === 'binder-io-blocking' ? 'D' : 'S',
      },
      ...familySignals,
    ],
  };
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), {recursive: true});
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function main() {
  const targets = discoverCoverageTargets(repoRoot);
  const skills = loadSkills();
  const strategyFixtures = loadStrategyFixtures();
  const skillsByName = new Map(skills.map((skill) => [skill.definition.name, skill]));
  if (skillsByName.size !== targets.skills.length) {
    throw new Error(`Skill source mismatch: discovered=${targets.skills.length}, parsed=${skillsByName.size}`);
  }
  const assignedStrategies = new Set(FAMILIES.flatMap((family) => family.strategies));
  const missingStrategies = targets.strategies.filter((strategy) => !assignedStrategies.has(strategy));
  if (missingStrategies.length > 0) throw new Error(`Unassigned Strategies: ${missingStrategies.join(', ')}`);

  for (const family of FAMILIES) {
    const caseDir = path.join(repoRoot, 'Trace/constructed', family.id);
    const scenarioPath = path.join(caseDir, 'scenario.json');
    const overlayPath = path.join(caseDir, 'trace.overlay.pftrace');
    const outputPath = path.join(repoRoot, 'Trace/.generated/constructed', family.id, 'trace.pftrace');
    const scenario = scenarioForFamily(family);
    writeJson(scenarioPath, scenario);
    const build = buildConstructedTrace(repoRoot, {
      caseId: family.id,
      basePath: resolveCaseTrace(repoRoot, family.base),
      scenarioPath,
      overlayPath,
      outputPath,
    });
    const familySkills = targets.skills.filter((skillId) => familyForSkill(skillId).id === family.id);
    const expectations = [
      ...familySkills.map((skillId) => skillExpectation(skillsByName.get(skillId), family, build.overlay.identities)),
      ...family.strategies.map((strategy) => {
        const fixture = strategyFixtures.get(strategy);
        if (!fixture) throw new Error(`Missing Strategy fixture: ${strategy}`);
        return strategyExpectation(strategy, family, fixture);
      }),
    ];
    const expectedPath = path.join(caseDir, 'analysis/expected.json');
    writeJson(expectedPath, {
      schema_version: 1,
      case_id: family.id,
      marker: `SmartPerfetto::CASE::${family.id}`,
      expectations,
    });
    writeJson(path.join(caseDir, 'case.json'), {
      schema_version: 1,
      id: family.id,
      kind: 'constructed',
      title: family.title,
      description: `Deterministic ${family.title.toLowerCase()} signals over the ${family.base} real base trace.`,
      scene: family.scene,
      tags: ['android', 'constructed', family.scene],
      aliases: [],
      trace: {
        file: 'trace.overlay.pftrace',
        format: 'perfetto-protobuf',
        sha256: build.provenance.overlay_sha256,
        materialization: 'base-plus-overlay',
      },
      android: {
        ...family.android,
        build_fingerprint: null,
        compatibility: {min_api: 35, max_api: 36},
      },
      source: {
        origin: 'SmartPerfetto deterministic trace generator',
        captured_at: null,
        imported_at: '2026-07-13T00:00:00.000Z',
        license: 'AGPL-3.0-or-later',
        consent: 'generated',
        privacy_review: 'not-applicable',
        sanitization_review: 'not-applicable',
        publication: 'public',
        evidence_tier: 'R3',
      },
      analysis: {results: ['analysis/expected.json'], logs: []},
      construction: {
        base_case_id: family.base,
        scenario_file: 'scenario.json',
        generator_version: 1,
        seed: `${family.id}-v1`,
        output: `Trace/.generated/constructed/${family.id}/trace.pftrace`,
        runtime_revision: runtimeRevision,
      },
      coverage: {
        skills: familySkills,
        strategies: family.strategies,
        expectations,
      },
    });
    writeJson(
      path.join(repoRoot, 'Trace/.generated/constructed', family.id, 'build-provenance.json'),
      build.provenance,
    );
    console.log(`${family.id}: ${familySkills.length} Skills, ${family.strategies.length} Strategies`);
  }
}

main();
