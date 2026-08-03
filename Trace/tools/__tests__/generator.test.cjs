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

const repoRoot = path.resolve(__dirname, '../../..');
const traceProcessor = resolveTraceProcessor(repoRoot);

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
  assert.ok(first.buffer.length > 0);
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
  fs.writeFileSync(scenarioPath, `${JSON.stringify(fixtureScenario(), null, 2)}\n`);

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
       COALESCE((SELECT value FROM stats WHERE name = 'mismatched_sched_switch_tids'), 0) AS sched_mismatches`,
  );
  assert.match(output, /\n1,0\s*$/);
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
