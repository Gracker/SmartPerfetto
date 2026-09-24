// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const test = require('node:test');

const {
  buildConstructedTrace,
  encodeScenarioOverlay,
  materializeTrace,
  probeTrace,
  resolveTraceProcessor,
} = require('../lib/generator.cjs');
const {resolveCaseTrace} = require('../lib/catalog.cjs');
const {buildCatalogCases} = require('../lib/builder.cjs');
const {loadTraceType} = require('../lib/perfetto-proto.cjs');
const {parseSourceAnalysisGroundTruth, runCli} = require('../bootstrap-constructed-cases.cjs');

const repoRoot = path.resolve(__dirname, '../../..');
const traceProcessor = resolveTraceProcessor(repoRoot);

test('bootstrap CLI handles help and rejects unsupported arguments before generation', () => {
  const stdout = [];
  const stderr = [];
  const io = {
    stdout: {write: (value) => stdout.push(value)},
    stderr: {write: (value) => stderr.push(value)},
  };
  let runCount = 0;
  const run = () => { runCount += 1; };

  assert.equal(runCli([], io, run), 0);
  assert.equal(runCount, 1);

  for (const help of ['--help', '-h']) {
    assert.equal(runCli([help], io, run), 0);
  }
  assert.deepEqual(stdout, [
    'Usage: node Trace/tools/bootstrap-constructed-cases.cjs\n',
    'Usage: node Trace/tools/bootstrap-constructed-cases.cjs\n',
  ]);
  assert.equal(runCount, 1);

  for (const args of [['--case', 'startup-lifecycle'], ['--help', '--case'], ['unexpected']]) {
    assert.equal(runCli(args, io, run), 1);
  }
  assert.deepEqual(stderr, Array(3).fill('Error: unsupported arguments. Use --help for usage.\n'));
  assert.equal(runCount, 1);
});

test('source-analysis ground truth requires executable marker, file read, and callers', () => {
  const sourcePath = path.join(repoRoot, 'backend/tests/e2e/context-fixtures/app/StartupHooks.kt');
  const source = fs.readFileSync(sourcePath, 'utf8');
  const groundTruth = parseSourceAnalysisGroundTruth(source);
  assert.deepEqual(groundTruth.callChain, [
    'Application.onCreate',
    'StartupHooks.initializeOnMainThread',
    'StartupHooks.readStartupPolicySynchronously',
    'File.readText',
  ]);
  assert.deepEqual(groundTruth.compatibility, {
    buildLink: 'synthetic_constructed_pair_only', causalStatus: 'candidate', baseAndroidStartupLinked: false,
  });
  assert.ok(groundTruth.sourceLines.beginLine < groundTruth.sourceLines.policyLine);
  assert.ok(groundTruth.sourceLines.policyLine < groundTruth.sourceLines.endLine);
  assert.ok(groundTruth.sourceLines.endLine < groundTruth.sourceLines.readLine);

  const commentOnlyRead = mutateSource(source, 'return policyFile.readText()',
    '// return policyFile.readText()\n    return "startup-policy"');
  assert.throws(() => parseSourceAnalysisGroundTruth(commentOnlyRead), /File\.readText call/);
  const stringOnlyBegin = mutateSource(source, 'Trace.beginSection(TRACE_SOURCE_MARKER)',
    'val ignoredMarkerCall = "Trace.beginSection(TRACE_SOURCE_MARKER)"');
  assert.throws(() => parseSourceAnalysisGroundTruth(stringOnlyBegin), /TRACE_SOURCE_MARKER begin/);
  const missingCaller = mutateSource(source, 'StartupHooks.initializeOnMainThread(policyFile)',
    '// StartupHooks.initializeOnMainThread(policyFile)');
  assert.throws(() => parseSourceAnalysisGroundTruth(missingCaller), /Application startup caller/);
  for (const decoy of [
    mutateSource(source, 'Trace.beginSection(TRACE_SOURCE_MARKER)',
      'val decoy = """prefix " Trace.beginSection(TRACE_SOURCE_MARKER) " suffix"""'),
    mutateSource(source, 'return policyFile.readText()',
      'val decoy = """policyFile.readText()"""\n    return "startup-policy"'),
    mutateSource(source, 'StartupHooks.initializeOnMainThread(policyFile)',
      'val decoy = """StartupHooks.initializeOnMainThread(policyFile)"""'),
  ]) {
    assert.throws(() => parseSourceAnalysisGroundTruth(decoy), /Kotlin raw strings are not allowed/);
  }
  const callerOutsideOnCreate = mutateSource(
    mutateSource(source, 'StartupHooks.initializeOnMainThread(policyFile)', '// moved outside onCreate'),
    'StartupHooks.onFirstFrame()',
    'StartupHooks.initializeOnMainThread(policyFile)\n    StartupHooks.onFirstFrame()',
  );
  assert.throws(() => parseSourceAnalysisGroundTruth(callerOutsideOnCreate), /Application startup caller/);
  const firstFrameBeginOutside = mutateSource(
    mutateSource(source, 'Trace.beginSection(FIRST_FRAME_TRACE_MARKER)', '// moved outside onFirstFrame'),
    'fun onFirstFrame() {',
    'Trace.beginSection(FIRST_FRAME_TRACE_MARKER)\n\n  fun onFirstFrame() {',
  );
  assert.throws(() => parseSourceAnalysisGroundTruth(firstFrameBeginOutside), /synthetic first-frame begin/);
  const missingFirstFrameEnd = mutateSource(source,
    'Trace.beginSection(FIRST_FRAME_TRACE_MARKER)\n    Trace.endSection()',
    'Trace.beginSection(FIRST_FRAME_TRACE_MARKER)',
  );
  assert.throws(() => parseSourceAnalysisGroundTruth(missingFirstFrameEnd), /first-frame Trace\.endSection/);
  assert.throws(() => parseSourceAnalysisGroundTruth(mutateSource(source, 'import android.os.Trace', '')), /Trace import/);
  assert.throws(() => parseSourceAnalysisGroundTruth(mutateSource(source, 'import java.io.File', '')), /File import/);
  assert.throws(() => parseSourceAnalysisGroundTruth(mutateSource(source,
    'val policyFile = File(filesDir, "startup-policy.txt")',
    'val policyFile = filesDir',
  )), /policy File construction/);
  const endBeforeFinally = mutateSource(source,
    '} finally {\n      Trace.endSection()',
    'Trace.endSection()\n    } finally {',
  );
  assert.throws(() => parseSourceAnalysisGroundTruth(endBeforeFinally), /marker must enclose/);
  const endAfterFinally = mutateSource(source,
    '} finally {\n      Trace.endSection()\n    }',
    '} finally {\n      check(TRACE_SOURCE_MARKER.isNotEmpty())\n    }\n    Trace.endSection()',
  );
  assert.throws(() => parseSourceAnalysisGroundTruth(endAfterFinally), /marker must enclose/);
});

/** Edit the fixture in its checkout's native line ending; a no-op edit would pass vacuously. */
function mutateSource(source, search, replacement) {
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const nativeSearch = search.replaceAll('\n', eol);
  const mutated = source.replace(nativeSearch, () => replacement.replaceAll('\n', eol));
  assert.notEqual(mutated, source, `fixture edit did not apply: ${JSON.stringify(search)}`);
  return mutated;
}

function fixtureScenario() {
  return {
    schema_version: 1,
    clock: {anchor: 'trace-start', duration_ns: '500000000'},
    actors: {
      processes: [{id: 'app', name: 'com.smartperfetto.fixture'}],
      threads: [{id: 'main', process: 'app', name: 'main'}],
    },
    signals: [
      {
        type: 'atrace-slice',
        at_ns: '1000000',
        duration_ns: '4000000',
        process: 'app',
        thread: 'main',
        name: 'SmartPerfetto::CPU_CONTENTION',
      },
      {
        type: 'atrace-counter',
        at_ns: '2000000',
        process: 'app',
        thread: 'main',
        name: 'SmartPerfettoPressure',
        value: 73,
      },
      {
        type: 'sched-running',
        at_ns: '1000000',
        duration_ns: '3000000',
        thread: 'main',
        cpu: 0,
        end_state: 'S',
      },
    ],
  };
}

function managedHeapSignal() {
  return {
    type: 'managed-heap-graph',
    at_ns: '150000000',
    process: 'app',
    heap_bytes_allocated: '12352',
    types: [
      {id: 1, class_name: 'RootHolder', object_size: 64},
      {id: 2, class_name: 'LeakContainer', object_size: 8192},
      {id: 3, class_name: 'LeakedActivity', object_size: 4096},
    ],
    objects: [
      {id: 1, type_id: 1, self_size: 64, reference_object_ids: [2]},
      {id: 2, type_id: 2, self_size: 8192, reference_object_ids: [3]},
      {id: 3, type_id: 3, self_size: 4096, reference_object_ids: []},
    ],
    roots: [{root_type: 'ROOT_JNI_GLOBAL', object_ids: [1]}],
  };
}

function gpuComputeSignal() {
  return {
    type: 'gpu-compute-kernel',
    at_ns: '150000000',
    duration_ns: '12000000',
    process: 'app',
    gpu_id: 0,
    context: '1001',
    kernel: 'SyntheticComputeKernel',
    demangled_kernel: 'SyntheticComputeKernel(float*)',
    arch: 'synthetic-v1',
    grid: {x: 64, y: 1, z: 1},
    workgroup: {x: 32, y: 1, z: 1},
    args: {
      registers_per_thread: 24,
      shared_mem_static: 1024,
      shared_mem_dynamic: 2048,
      barriers_per_block: 2,
      waves_per_multiprocessor: 4,
    },
  };
}

function queryTrace(tracePath, sql) {
  const result = spawnSync(traceProcessor, ['-Q', sql, tracePath], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test('encodes deterministic isolated overlay packets with lossless timestamps', () => {
  const options = {
    anchorNs: '9007199254740993000',
    usedPids: new Set([700000, 700001]),
    sequenceId: 987654,
  };
  const first = encodeScenarioOverlay(repoRoot, fixtureScenario(), options);
  const second = encodeScenarioOverlay(repoRoot, fixtureScenario(), options);

  assert.deepEqual(first.buffer, second.buffer);
  assert.equal(first.identities.processes.app, 700002);
  assert.equal(first.identities.threads.main, 700003);
  assert.equal(first.provenance.anchor_ns, '9007199254740993000');
  assert.equal(first.provenance.sequence_id, 987654);
  // Recorded before explicit scheduler signals: absent optional signals must
  // retain the existing protobuf representation, including default priority.
  assert.equal(first.provenance.overlay_sha256, 'aa2ca6c6becfb039254e41df7876e98e165db455a1b8a618e7d81349b3e6f7fd');
  assert.ok(first.buffer.length > 0);
});

test('preserves native handoffs, wakeups, priority changes and clipped system evidence', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-system-scheduling-'));
  t.after(() => fs.rmSync(tempDir, {recursive: true, force: true}));
  const caseDir = path.join(repoRoot, 'Trace/constructed/system-scheduling-evidence');
  const expected = JSON.parse(fs.readFileSync(path.join(caseDir, 'analysis/expected.json'), 'utf8')).native_oracle;
  const outputPath = path.join(tempDir, 'trace.pftrace');
  const build = buildConstructedTrace(repoRoot, {
    caseId: 'system-scheduling-evidence',
    basePath: resolveCaseTrace(repoRoot, 'android-scroll-customer'),
    scenarioPath: path.join(caseDir, 'scenario.json'),
    overlayPath: path.join(tempDir, 'overlay.pftrace'),
    outputPath,
  });
  const anchor = BigInt(build.provenance.anchor_ns);
  const start = anchor + BigInt(expected.clipped_window_relative_ns[0]);
  const end = anchor + BigInt(expected.clipped_window_relative_ns[1]);
  const targetTid = build.overlay.identities.threads.main;
  const peerTid = build.overlay.identities.threads.peer;
  const cpu = build.provenance.cpu_map;

  const states = queryTrace(outputPath, `
    SELECT state, SUM(MIN(ts + dur, ${end}) - MAX(ts, ${start})) AS duration_ns
    FROM thread_state JOIN thread USING (utid)
    WHERE tid = ${targetTid} AND dur > 0 AND ts < ${end} AND ts + dur > ${start}
    GROUP BY state ORDER BY state`);
  for (const [state, duration] of Object.entries(expected.state_duration_ns)) {
    assert.ok(states.includes(`"${state}",${duration}`), states);
  }
  // Exact raw boundary and ucpu identity, independent of the shared production SQL.
  const handoff = queryTrace(outputPath, `
    SELECT a.end_state, a.priority, b.priority, b.ts - a.ts - a.dur AS gap_ns,
           b.ts - ${anchor} AS relative_ts, tb.tid
    FROM sched a JOIN thread ta ON ta.utid = a.utid
    JOIN sched b ON b.ucpu = a.ucpu AND b.ts = a.ts + a.dur
    JOIN thread tb ON tb.utid = b.utid
    WHERE ta.tid = ${targetTid} AND a.end_state = 'R+'`);
  assert.ok(handoff.includes(`"R+",120,${expected.preempted_next_priority},0,${expected.preempted_handoff_relative_ns},${peerTid}`), handoff);
  const priorities = queryTrace(outputPath, `
    SELECT DISTINCT priority FROM sched JOIN thread USING (utid)
    WHERE tid = ${targetTid} ORDER BY priority`);
  assert.deepEqual(
    priorities.trim().split(/\r?\n/),
    ['"priority"', ...expected.observed_target_priorities.map(String)],
  );

  const negativeEvidence = queryTrace(outputPath, `
    SELECT
      (SELECT COUNT(*) FROM sched JOIN thread USING (utid)
       WHERE tid = ${targetTid} AND end_state = 'R') AS ordinary_r,
      (SELECT COUNT(*) FROM sched JOIN thread USING (utid)
       WHERE tid = ${build.overlay.identities.threads.waiting}) AS waiting_runs,
      (SELECT COUNT(*) FROM thread_state JOIN thread USING (utid)
       WHERE tid = ${build.overlay.identities.threads.waiting} AND state = 'R') AS waiting_states,
      (SELECT COUNT(*) FROM sched JOIN thread USING (utid)
       WHERE tid = ${build.overlay.identities.threads.unfinished} AND dur = -1) AS unfinished,
      (SELECT COUNT(*) FROM thread_state s JOIN thread t ON t.utid = s.utid
       JOIN thread w ON w.utid = s.waker_utid
       WHERE t.tid = ${targetTid} AND w.tid = ${peerTid} AND s.state = 'R') AS wakeups,
      COALESCE((SELECT value FROM stats WHERE name = 'mismatched_sched_switch_tids'), 0) AS mismatches`);
  assert.match(negativeEvidence, /\n1,0,1,1,1,0\s*$/);

  const frequency = queryTrace(outputPath, `
    WITH spans AS (
      SELECT c.ts, LEAD(c.ts, 1, trace_end()) OVER (PARTITION BY track_id ORDER BY c.ts) AS end_ts,
             c.value, t.cpu
      FROM counter c JOIN cpu_counter_track t ON t.id = c.track_id WHERE t.name = 'cpufreq'
    ), running AS (
      SELECT MAX(ts, ${start}) AS ts, MIN(ts + dur, ${end}) AS end_ts, cpu
      FROM sched JOIN thread USING (utid)
      WHERE tid = ${targetTid} AND dur > 0 AND ts < ${end} AND ts + dur > ${start}
    ), overlaps AS (
      SELECT MIN(r.end_ts, f.end_ts) - MAX(r.ts, f.ts) AS dur, value
      FROM running r JOIN spans f ON r.cpu = f.cpu AND r.ts < f.end_ts AND r.end_ts > f.ts
    )
    SELECT SUM(dur), (SELECT SUM(end_ts - ts) FROM running) - SUM(dur),
           SUM(dur * value) / SUM(dur) / 1000 AS weighted_mhz FROM overlaps`);
  assert.ok(frequency.includes(`\n${expected.clipped_frequency_covered_running_ns},${expected.clipped_frequency_unknown_running_ns},${expected.clipped_frequency_weighted_mhz}`), frequency);
  const cpuEvidence = queryTrace(outputPath, `
    SELECT
      (SELECT COUNT(*) FROM counter c JOIN cpu_counter_track t ON t.id = c.track_id
       WHERE t.name = 'cpufreq' AND t.cpu = ${cpu[0]} AND c.ts >= ${anchor}) AS frequency_samples,
      (SELECT COUNT(*) FROM cpu_counter_track WHERE name = 'cpufreq' AND cpu = ${cpu[1]}) AS missing_frequency,
      (SELECT COUNT(*) FROM counter c JOIN cpu_counter_track t ON t.id = c.track_id
       WHERE t.name = 'cpuidle' AND t.cpu = ${cpu[2]} AND c.ts >= ${anchor}) AS idle_samples,
      (SELECT COUNT(*) FROM cpu WHERE cpu IN (${cpu[0]}, ${cpu[1]}, ${cpu[2]}) AND capacity IS NOT NULL) AS known_capacity`);
  assert.match(cpuEvidence, /\n3,0,2,0\s*$/);

  // Decode the original protobuf too: waking target_cpu must follow the same
  // isolation map as the ftrace bundle and frequency/idle payload cpu_id.
  const trace = loadTraceType(repoRoot).decode(build.overlay.buffer);
  const waking = trace.packet.flatMap((p) => p.ftraceEvents?.event ?? []).filter((e) => e.schedWaking);
  assert.equal(waking.length, 2);
  assert.ok(waking.every((e) => e.schedWaking.targetCpu === cpu[1]));
});

test('rejects malformed explicit sched signals without reusing Android log priority', () => {
  const scenario = fixtureScenario();
  const signal = {type: 'sched-switch', at_ns: '1', cpu: 0, prev_thread: null,
    next_thread: 'main', prev_state_raw: '0', prev_priority: 120, next_priority: 90};
  const options = {anchorNs: '1', sequenceId: 1};
  for (const [field, value, error] of [
    ['next_priority', 'WARN', /kernel sched priority/],
    ['next_priority', 140, /kernel sched priority/],
    ['prev_state_raw', 'R+', /decimal string/],
    ['prev_state_raw', '9223372036854775808', /signed 64-bit/],
    ['next_thread', 'missing', /unknown thread/],
  ]) {
    scenario.signals = [{...signal, [field]: value}];
    assert.throws(() => encodeScenarioOverlay(repoRoot, scenario, options), error);
  }
  scenario.signals = [{...signal, next_thread: null}];
  assert.throws(() => encodeScenarioOverlay(repoRoot, scenario, options), /change the running thread/);
  scenario.signals = [{type: 'sched-waking', at_ns: '1', cpu: 0, thread: 'main',
    waker_thread: null, target_cpu: -1, sched_priority: 120}];
  assert.throws(() => encodeScenarioOverlay(repoRoot, scenario, options), /non-negative integer/);
  scenario.signals[0].thread = null;
  scenario.signals[0].target_cpu = 0;
  assert.throws(() => encodeScenarioOverlay(repoRoot, scenario, options), /cannot wake the idle thread/);
});

test('materializes a parseable trace with slice, counter, and sched evidence', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-generator-'));
  const outputPath = path.join(tempDir, 'combined.pftrace');
  const overlay = encodeScenarioOverlay(repoRoot, fixtureScenario(), {
    anchorNs: '1000000000',
    usedPids: new Set(),
    sequenceId: 424242,
  });

  materializeTrace(Buffer.alloc(0), overlay.buffer, outputPath);

  const output = queryTrace(
    outputPath,
    `SELECT
       (SELECT COUNT(*) FROM slice WHERE name = 'SmartPerfetto::CPU_CONTENTION') AS slices,
       (SELECT COUNT(*) FROM counter_track WHERE name = 'SmartPerfettoPressure') AS counters,
       (SELECT COUNT(*) FROM sched s JOIN thread t USING (utid) WHERE t.name = 'main') AS sched_rows`,
  );
  assert.match(output, /1,1,[1-9][0-9]*/);
});

test('encodes frame timeline events through the active TracePacket schema', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-generator-frame-timeline-'));
  const outputPath = path.join(tempDir, 'combined.pftrace');
  const scenario = fixtureScenario();
  scenario.signals.push({
    type: 'frame-timeline',
    at_ns: '100000000',
    duration_ns: '16000000',
    process: 'app',
    cookie: 101,
    token: 201,
    display_frame_token: 301,
    layer_name: 'SyntheticJankLayer',
    jank_type: 64,
  });
  const overlay = encodeScenarioOverlay(repoRoot, scenario, {
    anchorNs: '1000000000',
    usedPids: new Set(),
    sequenceId: 434343,
  });

  materializeTrace(Buffer.alloc(0), overlay.buffer, outputPath);

  const output = queryTrace(
    outputPath,
    `SELECT COUNT(*), MIN(p.name)
     FROM actual_frame_timeline_slice a
     JOIN process p USING (upid)
     WHERE a.jank_type = 'App Deadline Missed'`,
  );
  assert.match(output, /\n1,"com\.smartperfetto\.fixture"\s*$/);
});

test('materializes ANR and perf callstack evidence for conditional SQL branches', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-generator-conditional-'));
  const outputPath = path.join(tempDir, 'combined.pftrace');
  const scenario = fixtureScenario();
  scenario.actors.processes.push({id: 'system', name: 'system_server', uid: 1000});
  scenario.actors.threads.push({id: 'system-main', process: 'system', name: 'android.fg'});
  scenario.signals.push(
    {
      type: 'anr-event',
      at_ns: '100000000',
      process: 'system',
      thread: 'system-main',
      target_process: 'app',
      error_id: 'synthetic-anr',
      subject: 'Input dispatching timed out waiting for com.smartperfetto.fixture',
      cpu: 0,
    },
    {
      type: 'perf-sample',
      at_ns: '150000000',
      process: 'app',
      thread: 'main',
      function_name: 'SyntheticHotFunction',
      module_name: 'libsynthetic.so',
      sample_count: 12,
      sample_interval_ns: '1000000',
      cpu: 0,
    },
  );
  const overlay = encodeScenarioOverlay(repoRoot, scenario, {
    anchorNs: '1000000000',
    usedPids: new Set(),
    sequenceId: 444444,
  });
  materializeTrace(Buffer.alloc(0), overlay.buffer, outputPath);

  const output = queryTrace(outputPath, `
    INCLUDE PERFETTO MODULE android.anrs;
    SELECT
      (SELECT COUNT(*) FROM android_anrs WHERE process_name = 'com.smartperfetto.fixture') AS anrs,
      (SELECT COUNT(*) FROM perf_sample) AS samples,
      (SELECT COUNT(*) FROM stack_profile_frame WHERE name = 'SyntheticHotFunction') AS frames`);
  assert.match(output, /\n1,12,1\s*$/);
  fs.rmSync(tempDir, {recursive: true, force: true});
});

test('materializes source-level Android log events for logcat SQL', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-generator-android-log-'));
  const outputPath = path.join(tempDir, 'combined.pftrace');
  const scenario = fixtureScenario();
  scenario.signals.push({
    type: 'android-log',
    at_ns: '120000000',
    process: 'app',
    thread: 'main',
    log_id: 'MAIN',
    priority: 'WARN',
    tag: 'ActivityManager',
    message: 'ANR in com.smartperfetto.fixture: input dispatching timed out',
  });
  const overlay = encodeScenarioOverlay(repoRoot, scenario, {
    anchorNs: '1000000000',
    usedPids: new Set(),
    sequenceId: 454545,
  });
  materializeTrace(Buffer.alloc(0), overlay.buffer, outputPath);

  const output = queryTrace(outputPath, `
    SELECT COUNT(*), MIN(tag), MIN(prio)
    FROM android_logs
    WHERE tag = 'ActivityManager'
      AND msg GLOB '*com.smartperfetto.fixture*'`);
  assert.match(output, /\n1,"ActivityManager",5\s*$/);
  fs.rmSync(tempDir, {recursive: true, force: true});
});

test('materializes memory, battery, power, GPU, CPU frequency, IRQ, and async evidence', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-generator-signals-'));
  const outputPath = path.join(tempDir, 'combined.pftrace');
  const scenario = fixtureScenario();
  scenario.signals.push(
    {
      type: 'process-stats',
      at_ns: '10000000',
      process: 'app',
      vm_rss_kb: 102400,
      rss_anon_kb: 81920,
      rss_file_kb: 20480,
      vm_swap_kb: 1024,
      vm_hwm_kb: 122880,
      oom_score_adj: 200,
    },
    {
      type: 'process-stats',
      at_ns: '20000000',
      process: 'app',
      vm_rss_kb: 133120,
      rss_anon_kb: 102400,
      rss_file_kb: 30720,
      vm_swap_kb: 2048,
      vm_hwm_kb: 143360,
      oom_score_adj: 900,
    },
    {
      type: 'battery-counters',
      at_ns: '30000000',
      capacity_percent: 80,
      charge_counter_uah: '4000000',
      current_ua: '-500000',
      voltage_uv: '4000000',
    },
    {
      type: 'battery-counters',
      at_ns: '40000000',
      capacity_percent: 79,
      charge_counter_uah: '3999000',
      current_ua: '-550000',
      voltage_uv: '3980000',
    },
    {
      type: 'power-rail',
      at_ns: '50000000',
      duration_ns: '10000000',
      name: 'SYNTHETIC_CPU',
      subsystem: 'CPU',
      start_energy_uws: '1000000',
      end_energy_uws: '1100000',
    },
    {
      type: 'gpu-work-period',
      at_ns: '70000000',
      duration_ns: '10000000',
      gpu_id: 0,
      uid: 10999,
      active_duration_ns: '8000000',
      cpu: 0,
    },
    {type: 'gpu-frequency', at_ns: '90000000', gpu_id: 0, value: 700000, cpu: 0},
    {type: 'cpu-frequency', at_ns: '100000000', cpu_id: 0, value: 1800000, cpu: 0},
    {
      type: 'irq-span',
      at_ns: '110000000',
      duration_ns: '2000000',
      irq: 42,
      name: 'synthetic_irq',
      cpu: 0,
    },
    {
      type: 'frame-timeline',
      at_ns: '115000000',
      duration_ns: '20000000',
      process: 'app',
      cookie: 100,
      token: 200,
      display_frame_token: 300,
      layer_name: 'SyntheticLayer',
      jank_type: 64,
    },
    {type: 'gpu-power-state', at_ns: '116000000', old_state: 0, new_state: 2, cpu: 0},
    {type: 'cpu-idle', at_ns: '117000000', cpu_id: 0, state: 1, cpu: 0},
    {
      type: 'atrace-async-slice',
      at_ns: '120000000',
      duration_ns: '5000000',
      process: 'app',
      thread: 'main',
      name: 'SyntheticAsync',
      cookie: 7,
    },
    {
      type: 'atrace-async-track-slice',
      at_ns: '130000000',
      duration_ns: '5000000',
      process: 'app',
      thread: 'main',
      track_name: 'SyntheticTrack',
      name: 'SyntheticTrackEvent',
      cookie: 8,
    },
    {
      type: 'lmk-kill',
      at_ns: '140000000',
      duration_ns: '1000000',
      process: 'app',
      thread: 'main',
      kill_reason: 3,
      oom_score_adj: 900,
    },
  );
  const overlay = encodeScenarioOverlay(repoRoot, scenario, {
    anchorNs: '1000000000',
    usedPids: new Set(),
    sequenceId: 434343,
  });
  materializeTrace(Buffer.alloc(0), overlay.buffer, outputPath);

  const output = queryTrace(outputPath, `
    INCLUDE PERFETTO MODULE android.battery;
    INCLUDE PERFETTO MODULE android.gpu.work_period;
    INCLUDE PERFETTO MODULE android.oom_adjuster;
    INCLUDE PERFETTO MODULE linux.memory.process;
    INCLUDE PERFETTO MODULE linux.irqs;
    INCLUDE PERFETTO MODULE android.gpu.mali_power_state;
    INCLUDE PERFETTO MODULE linux.cpu.idle;
    INCLUDE PERFETTO MODULE android.memory.lmk;
    SELECT
      (SELECT COUNT(*) FROM memory_rss_and_swap_per_process) AS rss,
      (SELECT COUNT(*) FROM android_battery_charge) AS battery,
      (SELECT COUNT(*) FROM track WHERE type = 'power_rails') AS rails,
      (SELECT COUNT(*) FROM android_gpu_work_period_track t JOIN slice s ON s.track_id = t.id) AS gpu_work,
      (SELECT COUNT(*) FROM gpu_counter_track WHERE name GLOB '*freq*') AS gpu_freq,
      (SELECT COUNT(*) FROM cpu_counter_track WHERE name = 'cpufreq') AS cpu_freq,
      (SELECT COUNT(*) FROM linux_hard_irqs WHERE name GLOB '*synthetic_irq*') AS irq,
      (SELECT COUNT(*) FROM actual_frame_timeline_slice WHERE layer_name = 'SyntheticLayer') AS frame,
      (SELECT COUNT(*) FROM android_mali_gpu_power_state) AS gpu_power,
      (SELECT COUNT(*) FROM cpu_idle_counters WHERE idle = 1) AS cpu_idle,
      (SELECT COUNT(*) FROM slice WHERE name = 'SyntheticAsync') AS async_slice,
      (SELECT COUNT(*) FROM slice s JOIN process_track pt ON pt.id = s.track_id WHERE s.name = 'SyntheticAsync') AS async_process_slice,
      (SELECT COUNT(*) FROM slice s JOIN process_track pt ON pt.id = s.track_id WHERE pt.name = 'SyntheticTrack' AND s.name = 'SyntheticTrackEvent') AS named_async,
      (SELECT COUNT(*) FROM android_lmk_events WHERE process_name = 'com.smartperfetto.fixture') AS lmk,
      (SELECT COUNT(*) FROM android_oom_adj_intervals) AS oom_adj`);
  assert.match(output, /\n(?:[1-9][0-9]*,){14}[1-9][0-9]*\s*$/);
});

function thermalLimitSignals() {
  return [
    {
      type: 'cpu-frequency-limits', at_ns: '200000000', cpu_id: 5,
      min_freq_khz: 500000, max_freq_khz: 3000000, cpu: 5,
    },
    {
      type: 'cpu-frequency-limits', at_ns: '260000000', cpu_id: 5,
      min_freq_khz: 500000, max_freq_khz: 1700000, cpu: 5,
    },
    {
      type: 'thermal-temperature', at_ns: '210000000', id: 3,
      thermal_zone: 'cpu-big', temp_mc: 62000, temp_prev_mc: 61000, cpu: 0,
    },
    {
      type: 'thermal-temperature', at_ns: '250000000', id: 3,
      thermal_zone: 'cpu-big', temp_mc: 96000, temp_prev_mc: 62000, cpu: 0,
    },
    {type: 'cdev-update', at_ns: '220000000', cdev_type: 'thermal-cpufreq-2', target: 0, cpu: 0},
    {type: 'cdev-update', at_ns: '260000000', cdev_type: 'thermal-cpufreq-2', target: 3, cpu: 0},
  ];
}

test('encodes thermal, cooling device, and frequency limit events at their ftrace field numbers', () => {
  const scenario = fixtureScenario();
  scenario.signals.push(...thermalLimitSignals());
  const overlay = encodeScenarioOverlay(repoRoot, scenario, {
    anchorNs: '1000000000',
    usedPids: new Set(),
    sequenceId: 464646,
  });

  // The field number is the wire contract trace_processor dispatches on; a
  // renamed schema field would still decode, a renumbered one would not.
  const traceType = loadTraceType(repoRoot);
  const ftraceEvent = traceType.root.lookupType('perfetto.protos.FtraceEvent');
  assert.equal(ftraceEvent.fields.cpuFrequencyLimits.id, 12);
  assert.equal(ftraceEvent.fields.thermalTemperature.id, 341);
  assert.equal(ftraceEvent.fields.cdevUpdate.id, 342);

  const events = traceType.decode(overlay.buffer).packet
    .flatMap((packet) => packet.ftraceEvents?.event ?? []);
  assert.deepEqual(
    events
      .filter((event) => event.event === 'cpuFrequencyLimits')
      .map((event) => ({
        at: String(event.timestamp),
        cpuId: event.cpuFrequencyLimits.cpuId,
        minFreq: event.cpuFrequencyLimits.minFreq,
        maxFreq: event.cpuFrequencyLimits.maxFreq,
      })),
    [
      {at: '1200000000', cpuId: 5, minFreq: 500000, maxFreq: 3000000},
      {at: '1260000000', cpuId: 5, minFreq: 500000, maxFreq: 1700000},
    ],
  );
  assert.deepEqual(
    events
      .filter((event) => event.event === 'thermalTemperature')
      .map((event) => ({
        at: String(event.timestamp),
        id: event.thermalTemperature.id,
        zone: event.thermalTemperature.thermalZone,
        temp: event.thermalTemperature.temp,
        tempPrev: event.thermalTemperature.tempPrev,
      })),
    [
      {at: '1210000000', id: 3, zone: 'cpu-big', temp: 62000, tempPrev: 61000},
      {at: '1250000000', id: 3, zone: 'cpu-big', temp: 96000, tempPrev: 62000},
    ],
  );
  assert.deepEqual(
    events
      .filter((event) => event.event === 'cdevUpdate')
      .map((event) => ({
        at: String(event.timestamp),
        type: event.cdevUpdate.type,
        target: String(event.cdevUpdate.target),
      })),
    [
      {at: '1220000000', type: 'thermal-cpufreq-2', target: '0'},
      {at: '1260000000', type: 'thermal-cpufreq-2', target: '3'},
    ],
  );

  // temp_prev and id are optional; omitting them must not change the zone,
  // the sample value, or the signal's own field number.
  const defaulted = fixtureScenario();
  defaulted.signals.push({
    type: 'thermal-temperature', at_ns: '210000000',
    thermal_zone: 'skin', temp_mc: 38000, cpu: 0,
  });
  const defaultedEvent = traceType
    .decode(encodeScenarioOverlay(repoRoot, defaulted, {
      anchorNs: '1000000000', usedPids: new Set(), sequenceId: 464647,
    }).buffer)
    .packet.flatMap((packet) => packet.ftraceEvents?.event ?? [])
    .find((event) => event.event === 'thermalTemperature');
  assert.equal(defaultedEvent.thermalTemperature.id, 0);
  assert.equal(defaultedEvent.thermalTemperature.temp, 38000);
  assert.equal(defaultedEvent.thermalTemperature.tempPrev, 38000);
});

test('materializes thermal zone, cooling device, and policy frequency limit counters', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-thermal-limit-'));
  const outputPath = path.join(tempDir, 'combined.pftrace');
  const scenario = fixtureScenario();
  scenario.signals.push(...thermalLimitSignals());
  const overlay = encodeScenarioOverlay(repoRoot, scenario, {
    anchorNs: '1000000000',
    usedPids: new Set(),
    sequenceId: 464648,
  });
  materializeTrace(Buffer.alloc(0), overlay.buffer, outputPath);

  // trace_processor derives the track name from cpu_id, thermal_zone, and the
  // cooling device type, so these names are the analysis-visible contract.
  const output = queryTrace(outputPath, `
    SELECT t.type, t.name, COUNT(*) AS samples, CAST(MIN(c.value) AS INT) AS min_value,
           CAST(MAX(c.value) AS INT) AS max_value
    FROM counter c JOIN counter_track t ON c.track_id = t.id
    WHERE t.type IN ('cpu_max_frequency_limit', 'cpu_min_frequency_limit',
                     'thermal_temperature', 'cooling_device_counter')
    GROUP BY t.id
    ORDER BY t.type, t.name`);
  assert.equal(output.trim().split(/\r?\n/).slice(1).join('\n'), [
    '"cooling_device_counter","thermal-cpufreq-2 Cooling Device",2,0,3',
    '"cpu_max_frequency_limit","Cpu 5 Max Freq Limit",2,1700000,3000000',
    '"cpu_min_frequency_limit","Cpu 5 Min Freq Limit",2,500000,500000',
    '"thermal_temperature","cpu-big Temperature",2,62000,96000',
  ].join('\n'));
});

test('rejects frequency limits that invert the policy bounds or lose CPU isolation', () => {
  const inverted = fixtureScenario();
  inverted.signals.push({
    type: 'cpu-frequency-limits', at_ns: '200000000', cpu_id: 5,
    min_freq_khz: 3000000, max_freq_khz: 1700000, cpu: 5,
  });
  assert.throws(
    () => encodeScenarioOverlay(repoRoot, inverted, {anchorNs: '1', usedPids: new Set(), sequenceId: 1}),
    /min_freq_khz must not exceed max_freq_khz/,
  );

  const fractionalTarget = fixtureScenario();
  fractionalTarget.signals.push({
    type: 'cdev-update', at_ns: '200000000', cdev_type: 'thermal-cpufreq-2', target: 1.5, cpu: 0,
  });
  assert.throws(
    () => encodeScenarioOverlay(repoRoot, fractionalTarget, {anchorNs: '1', usedPids: new Set(), sequenceId: 1}),
    /cdev-update target must be a non-negative safe integer/,
  );

  const emptyZone = fixtureScenario();
  emptyZone.signals.push({
    type: 'thermal-temperature', at_ns: '200000000', thermal_zone: ' ', temp_mc: 62000, cpu: 0,
  });
  assert.throws(
    () => encodeScenarioOverlay(repoRoot, emptyZone, {anchorNs: '1', usedPids: new Set(), sequenceId: 1}),
    /thermal_zone must be a non-empty string/,
  );
});

test('materializes a typed GPU compute kernel launch', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-generator-gpu-compute-'));
  const outputPath = path.join(tempDir, 'combined.pftrace');
  const scenario = fixtureScenario();
  scenario.signals.push(gpuComputeSignal());
  const overlay = encodeScenarioOverlay(repoRoot, scenario, {
    anchorNs: '1000000000',
    usedPids: new Set(),
    sequenceId: 454545,
  });
  materializeTrace(Buffer.alloc(0), overlay.buffer, outputPath);

  const output = queryTrace(outputPath, `
    SELECT
      s.render_stage_category,
      s.dur,
      EXTRACT_ARG(s.arg_set_id, 'kernel_demangled_name') AS kernel,
      EXTRACT_ARG(s.arg_set_id, 'launch.grid_size.x') AS grid_x,
      EXTRACT_ARG(s.arg_set_id, 'launch.workgroup_size.x') AS workgroup_x,
      EXTRACT_ARG(s.arg_set_id, 'registers_per_thread') AS registers,
      EXTRACT_ARG(s.arg_set_id, 'shared_mem_static') AS shared_static,
      EXTRACT_ARG(s.arg_set_id, 'shared_mem_dynamic') AS shared_dynamic,
      EXTRACT_ARG(s.arg_set_id, 'barriers_per_block') AS barriers,
      EXTRACT_ARG(s.arg_set_id, 'waves_per_multiprocessor') AS waves
    FROM gpu_slice AS s
    WHERE s.render_stage_category = 2`);
  assert.match(
    output,
    /\n2,12000000,"SyntheticComputeKernel\(float\*\)",64,32,24,1024,2048,2,4\s*$/,
  );

  const reorderedScenario = fixtureScenario();
  const reorderedSignal = gpuComputeSignal();
  reorderedSignal.args = Object.fromEntries(Object.entries(reorderedSignal.args).reverse());
  reorderedScenario.signals.push(reorderedSignal);
  const reordered = encodeScenarioOverlay(repoRoot, reorderedScenario, {
    anchorNs: '1000000000',
    usedPids: new Set(),
    sequenceId: 454545,
  });
  assert.deepEqual(reordered.buffer, overlay.buffer);
});

test('rejects malformed or unbounded GPU compute launches', () => {
  const zeroDimension = fixtureScenario();
  const zeroDimensionSignal = gpuComputeSignal();
  zeroDimensionSignal.workgroup.x = 0;
  zeroDimension.signals.push(zeroDimensionSignal);
  assert.throws(
    () => encodeScenarioOverlay(repoRoot, zeroDimension, {anchorNs: '1', usedPids: new Set(), sequenceId: 1}),
    /workgroup.x must be a positive unsigned 32-bit integer/,
  );

  const tooManyArgs = fixtureScenario();
  const tooManyArgsSignal = gpuComputeSignal();
  tooManyArgsSignal.args = Object.fromEntries(
    Array.from({length: 65}, (_, index) => [`arg_${index}`, index]),
  );
  tooManyArgs.signals.push(tooManyArgsSignal);
  assert.throws(
    () => encodeScenarioOverlay(repoRoot, tooManyArgs, {anchorNs: '1', usedPids: new Set(), sequenceId: 1}),
    /args exceed 64/,
  );
});

test('materializes a managed heap graph with dominator path evidence', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-generator-heap-'));
  const outputPath = path.join(tempDir, 'combined.pftrace');
  const scenario = fixtureScenario();
  scenario.signals.push(managedHeapSignal());
  const overlay = encodeScenarioOverlay(repoRoot, scenario, {
    anchorNs: '1000000000',
    usedPids: new Set(),
    sequenceId: 444444,
  });
  materializeTrace(Buffer.alloc(0), overlay.buffer, outputPath);

  const availability = queryTrace(outputPath, `
    INCLUDE PERFETTO MODULE android.memory.heap_graph.class_summary_tree;
    SELECT
      (SELECT COUNT(*) FROM heap_graph_object) AS object_count,
      (SELECT COUNT(*) FROM android_heap_graph_class_summary_tree) AS class_count`);
  assert.match(availability, /\n3,[3-9][0-9]*\s*$/);

  const dominator = queryTrace(outputPath, `
    INCLUDE PERFETTO MODULE android.memory.heap_graph.dominator_class_tree;
    INCLUDE PERFETTO MODULE graphs.scan;
    INCLUDE PERFETTO MODULE graphs.hierarchy;

    CREATE PERFETTO TABLE test_heap_cumulatives AS
    SELECT * FROM _graph_aggregating_scan!(
      (
        SELECT id AS source_node_id, parent_id AS dest_node_id
        FROM _heap_graph_dominator_class_tree
        WHERE parent_id IS NOT NULL
      ),
      (
        SELECT parent.id, parent.self_count AS cumulative_count,
               parent.self_size AS cumulative_size
        FROM _heap_graph_dominator_class_tree AS parent
        LEFT JOIN _heap_graph_dominator_class_tree AS child
          ON child.parent_id = parent.id
        WHERE child.id IS NULL
      ),
      (cumulative_count, cumulative_size),
      (
        WITH child_totals AS (
          SELECT id, SUM(cumulative_count) AS cumulative_count,
                 SUM(cumulative_size) AS cumulative_size
          FROM $table
          GROUP BY id
        )
        SELECT child_totals.id,
               child_totals.cumulative_count + node.self_count AS cumulative_count,
               child_totals.cumulative_size + node.self_size AS cumulative_size
        FROM child_totals
        JOIN _heap_graph_dominator_class_tree AS node USING (id)
      )
    );

    CREATE PERFETTO TABLE test_heap_top AS
    SELECT id FROM (
      SELECT tree.id,
             ROW_NUMBER() OVER (
               PARTITION BY tree.upid, tree.graph_sample_ts
               ORDER BY tree.self_size DESC, cumulative.cumulative_size DESC, tree.id
             ) AS row_number
      FROM _heap_graph_dominator_class_tree AS tree
      JOIN test_heap_cumulatives AS cumulative USING (id)
    ) WHERE row_number = 1;

    CREATE PERFETTO TABLE test_heap_ancestors AS
    SELECT id FROM _tree_reachable_ancestors_or_self!((
      SELECT id, parent_id FROM _heap_graph_dominator_class_tree
    ), (SELECT id FROM test_heap_top));

    CREATE PERFETTO TABLE test_heap_labels AS
    SELECT tree.id, tree.parent_id,
           IFNULL(tree.name, '[Unknown]') || ' [' || tree.self_count || ']' AS label,
           tree.root_type
    FROM _heap_graph_dominator_class_tree AS tree
    JOIN test_heap_ancestors AS ancestor USING (id);

    CREATE PERFETTO TABLE test_heap_paths AS
    WITH RECURSIVE paths(id, path, root_type) AS (
      SELECT id, '[' || COALESCE(root_type, 'ROOT') || '] ' || label AS path,
             COALESCE(root_type, 'ROOT') AS root_type
      FROM test_heap_labels
      WHERE parent_id IS NULL
      UNION ALL
      SELECT child.id, parent.path || ' -> ' || child.label, parent.root_type
      FROM paths AS parent
      JOIN test_heap_labels AS child ON child.parent_id = parent.id
    )
    SELECT id, path, root_type FROM paths;

    SELECT paths.root_type, paths.path, tree.self_size, cumulative.cumulative_size
    FROM test_heap_top AS top
    JOIN _heap_graph_dominator_class_tree AS tree ON tree.id = top.id
    JOIN test_heap_cumulatives AS cumulative ON cumulative.id = top.id
    JOIN test_heap_paths AS paths ON paths.id = top.id`);
  assert.match(
    dominator,
    /"ROOT_JNI_GLOBAL","\[ROOT_JNI_GLOBAL\] RootHolder \[1\] -> LeakContainer \[1\]",8192,12288/,
  );
});

test('rejects malformed or unbounded managed heap graphs', () => {
  const unknownReference = fixtureScenario();
  const unknownReferenceSignal = managedHeapSignal();
  unknownReferenceSignal.objects[1].reference_object_ids = [999];
  unknownReference.signals.push(unknownReferenceSignal);
  assert.throws(
    () => encodeScenarioOverlay(repoRoot, unknownReference, {anchorNs: '1', usedPids: new Set(), sequenceId: 1}),
    /references unknown object 999/,
  );

  const duplicateType = fixtureScenario();
  const duplicateTypeSignal = managedHeapSignal();
  duplicateTypeSignal.types[1].id = 1;
  duplicateType.signals.push(duplicateTypeSignal);
  assert.throws(
    () => encodeScenarioOverlay(repoRoot, duplicateType, {anchorNs: '1', usedPids: new Set(), sequenceId: 1}),
    /duplicate type id: 1/,
  );

  const oversizedHeap = fixtureScenario();
  const oversizedHeapSignal = managedHeapSignal();
  oversizedHeapSignal.heap_bytes_allocated = '9223372036854775808';
  oversizedHeap.signals.push(oversizedHeapSignal);
  assert.throws(
    () => encodeScenarioOverlay(repoRoot, oversizedHeap, {anchorNs: '1', usedPids: new Set(), sequenceId: 1}),
    /must fit in a signed 64-bit integer/,
  );

  const unbounded = fixtureScenario();
  const unboundedSignal = managedHeapSignal();
  unboundedSignal.objects = Array.from({length: 10001}, (_, index) => ({
    id: index + 1,
    type_id: 1,
    self_size: 1,
    reference_object_ids: [],
  }));
  unbounded.signals.push(unboundedSignal);
  assert.throws(
    () => encodeScenarioOverlay(repoRoot, unbounded, {anchorNs: '1', usedPids: new Set(), sequenceId: 1}),
    /objects must contain 1-10000 entries/,
  );
});

function frameworkStateScenario() {
  return {
    schema_version: 1,
    clock: {anchor: 'trace-start', duration_ns: '1000000000'},
    actors: {
      processes: [
        {id: 'app', name: 'com.smartperfetto.fixture', uid: 10123},
        {id: 'system', name: 'system_server', uid: 1000},
      ],
      threads: [
        {id: 'main', process: 'app', name: 'main', is_main: true},
        {id: 'am', process: 'system', name: 'ActivityManager', is_main: true},
      ],
    },
    signals: [
      {type: 'android-process-state-change', at_ns: '100000000', thread: 'am', target_process: 'app',
        prev_proc_state: 'PROCESS_STATE_TOP', cur_proc_state: 'PROCESS_STATE_LAST_ACTIVITY',
        prev_oom_score: 0, cur_oom_score: 700, reason: 'OOM_ADJ_REASON_ACTIVITY'},
      {type: 'android-process-state-change', at_ns: '400000000', thread: 'am', target_process: 'app',
        prev_proc_state: 'PROCESS_STATE_LAST_ACTIVITY', cur_proc_state: 'PROCESS_STATE_CACHED_ACTIVITY'},
      {type: 'android-process-state-snapshot', at_ns: '900000000', records: [
        {process: 'app', proc_state: 'PROCESS_STATE_CACHED_ACTIVITY', oom_score: 900},
        {process: 'system', proc_state: 'PROCESS_STATE_PERSISTENT', oom_score: -900},
      ]},
      {type: 'statsd-atom', at_ns: '200000000', atom: 'app_standby_bucket_changed',
        fields: {package_name: 'com.smartperfetto.fixture', user_id: 0, bucket: 'BUCKET_RARE', main_reason: 'MAIN_TIMEOUT'}},
      {type: 'statsd-atom', at_ns: '450000000', atom: 'app_freeze_changed', process: 'app',
        fields: {action: 'FREEZE_APP', unfreeze_reason_v2: 'UFR_NONE'}},
      {type: 'battery-stats-span', at_ns: '150000000', duration_ns: '300000000', process: 'system', thread: 'am',
        event: 'longwake', owner_process: 'app', tag: 'SyncJob'},
      {type: 'atrace-slice', at_ns: '450000000', duration_ns: '1000000', process: 'system', thread: 'am',
        name: 'Freeze com.smartperfetto.fixture:{pid:app}'},
      {type: 'atrace-slice', at_ns: '700000000', duration_ns: '1000000', process: 'system', thread: 'am',
        name: 'Unfreeze com.smartperfetto.fixture:{pid:app} 18'},
    ],
  };
}

test('materializes framework process state, statsd atoms, battery stats and freezer slices', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-generator-framework-state-'));
  const outputPath = path.join(tempDir, 'combined.pftrace');
  const overlay = encodeScenarioOverlay(repoRoot, frameworkStateScenario(), {
    anchorNs: '1000000000',
    usedPids: new Set(),
    sequenceId: 555555,
  });
  materializeTrace(Buffer.alloc(0), overlay.buffer, outputPath);

  const output = queryTrace(outputPath, `
    INCLUDE PERFETTO MODULE android.process_state;
    INCLUDE PERFETTO MODULE android.app_wakelocks;
    INCLUDE PERFETTO MODULE android.standby_bucket;
    INCLUDE PERFETTO MODULE android.freezer;
    SELECT
      (SELECT GROUP_CONCAT(state || ':' || dur, ',') FROM (
        SELECT state, dur FROM _android_process_state_intervals
        WHERE process_name = 'com.smartperfetto.fixture' ORDER BY ts, state_rank)) AS states,
      (SELECT name || ':' || uid || ':' || dur FROM android_app_wakelocks) AS wakelock,
      (SELECT bucket || ':' || main_reason FROM android_standby_bucket) AS bucket,
      (SELECT freezer_state || ':' || pid FROM android_freezer_state_statsd) AS freeze_atom,
      (SELECT unfreeze_reason_str || ':' || dur FROM android_freezer_events) AS freeze_slice`);
  const pid = overlay.identities.processes.app;
  assert.equal(output.trim().split(/\r?\n/)[1], [
    '"TOP:0,LAST_ACTIVITY:300000000,CACHED_ACTIVITY:301000000"',
    '"SyncJob:10123:300000000"',
    '"BUCKET_RARE:MAIN_TIMEOUT"',
    `"FREEZE_APP:${pid}"`,
    '"binder_txns:250000000"',
  ].join(','));
});

test('rejects framework signals outside the pinned proto and atom allow-list', () => {
  const encode = (mutate) => {
    const scenario = frameworkStateScenario();
    mutate(scenario.signals);
    return () => encodeScenarioOverlay(repoRoot, scenario, {anchorNs: '1', usedPids: new Set(), sequenceId: 1});
  };
  assert.throws(encode((signals) => { signals[0].cur_proc_state = 'CACHED'; }), /ProcessStateEnum value name/);
  assert.throws(encode((signals) => { signals[3].atom = 'screen_state_changed'; }), /atom is unsupported/);
  assert.throws(encode((signals) => { signals[3].fields.bucket = 'BUCKET_NOPE'; }), /value name/);
  assert.throws(encode((signals) => { signals[3].fields.not_a_field = 1; }), /has no field not_a_field/);
  assert.throws(encode((signals) => { signals[3].process = 'app'; }), /has no process fields/);
  assert.throws(encode((signals) => { signals[5].event = 'wakelock'; }), /event is unsupported/);
  assert.throws(encode((signals) => { signals[5].tag = 'a"b'; }), /must not contain a quote/);
  assert.throws(encode((signals) => { signals[6].name = 'Freeze x:{pid:missing}'; }), /unknown process missing/);
  assert.throws(encode((signals) => { signals[6].name = 'owner x ({tid:missing})'; }), /unknown thread missing/);
});

test('rejects unsafe or imprecise scenario values', () => {
  const invalid = fixtureScenario();
  invalid.signals[0].at_ns = 1;

  assert.throws(
    () => encodeScenarioOverlay(repoRoot, invalid, {anchorNs: '1', usedPids: new Set(), sequenceId: 1}),
    /decimal string/,
  );
});

test('materialization is exact protobuf concatenation', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-materialize-'));
  const outputPath = path.join(tempDir, 'trace.pftrace');
  const base = Buffer.from([0x0a, 0x00]);
  const overlay = Buffer.from([0x0a, 0x00, 0x0a, 0x00]);

  const result = materializeTrace(base, overlay, outputPath);

  assert.deepEqual(fs.readFileSync(outputPath), Buffer.concat([base, overlay]));
  assert.equal(result.base_bytes, 2);
  assert.equal(result.overlay_bytes, 4);
  assert.equal(result.output_bytes, 6);
});

test('probes a real base and builds a combined trace inside its bounds', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-real-base-'));
  const basePath = resolveCaseTrace(repoRoot, 'android-startup-light');
  const scenarioPath = path.join(tempDir, 'scenario.json');
  const overlayPath = path.join(tempDir, 'trace.overlay.pftrace');
  const outputPath = path.join(tempDir, 'trace.pftrace');
  const scenario = fixtureScenario();
  scenario.signals.push({
    type: 'android-log',
    at_ns: '120000000',
    process: 'app',
    thread: 'main',
    log_id: 'MAIN',
    priority: 'WARN',
    tag: 'ActivityManager',
    message: 'ANR in com.smartperfetto.fixture',
  });
  fs.writeFileSync(scenarioPath, `${JSON.stringify(scenario, null, 2)}\n`);

  const probe = probeTrace(repoRoot, basePath);
  assert.ok(BigInt(probe.end_ns) > BigInt(probe.start_ns));
  assert.ok(probe.used_pids.size > 0);

  const build = buildConstructedTrace(repoRoot, {
    caseId: 'cpu-contention',
    basePath,
    scenarioPath,
    overlayPath,
    outputPath,
  });
  assert.ok(BigInt(build.provenance.anchor_ns) >= BigInt(probe.start_ns));
  assert.ok(BigInt(build.provenance.anchor_ns) + 500000000n <= BigInt(probe.end_ns));
  assert.equal(build.provenance.base_sha256.length, 64);
  assert.equal(build.provenance.output_sha256.length, 64);
  assert.deepEqual(fs.readFileSync(overlayPath), build.overlay.buffer);

  const output = queryTrace(
    outputPath,
    `SELECT
       (SELECT COUNT(*) FROM slice WHERE name = 'SmartPerfetto::CPU_CONTENTION') AS markers,
       (SELECT COUNT(*) FROM android_logs WHERE tag = 'ActivityManager') AS logs,
       COALESCE((SELECT value FROM stats WHERE name = 'mismatched_sched_switch_tids'), 0) AS sched_mismatches`,
  );
  assert.match(output, /\n1,1,0\s*$/);
  assert.ok(Object.values(build.provenance.cpu_map).every((cpu) => Number(cpu) > 0));
});

test('rebuilds a repository constructed case with matching source hash and provenance', () => {
  const result = buildCatalogCases(repoRoot, {caseIds: ['startup-lifecycle'], check: true});

  assert.equal(result.length, 1);
  assert.equal(result[0].case_id, 'startup-lifecycle');
  assert.equal(result[0].overlay_hash_matches, true);
  assert.ok(fs.existsSync(path.join(repoRoot, result[0].output)));
  assert.ok(fs.existsSync(path.join(repoRoot, result[0].provenance_file)));
  const provenance = JSON.parse(fs.readFileSync(path.join(repoRoot, result[0].provenance_file), 'utf8'));
  assert.equal(provenance.base_case_id, 'android-startup-heavy');
  assert.equal(provenance.trace_processor.sha256.length, 64);
  assert.match(provenance.trace_processor.version, /^Perfetto /);
});

test('isolates every policy CPU of the thermal frequency limit case above the base topology', () => {
  const result = buildCatalogCases(repoRoot, {caseIds: ['thermal-frequency-limit'], check: true});

  assert.equal(result.length, 1);
  assert.equal(result[0].overlay_hash_matches, true);
  const provenance = JSON.parse(fs.readFileSync(path.join(repoRoot, result[0].provenance_file), 'utf8'));
  const basePath = resolveCaseTrace(repoRoot, 'android-scroll-customer');
  const baseCpus = probeTrace(repoRoot, basePath).used_cpus;
  // cpu_id is a second CPU identity inside the payload. If it were left out of
  // the isolation map, a policy limit would land on a real base CPU's track.
  const mapped = Object.entries(provenance.cpu_map);
  assert.equal(mapped.length, 5);
  for (const [requested, isolated] of mapped) {
    assert.ok(baseCpus.has(Number(requested)), `base lacks requested CPU ${requested}`);
    assert.ok(!baseCpus.has(isolated), `isolated CPU ${isolated} collides with the base topology`);
  }
});
