// SPDX-License-Identifier: AGPL-3.0-or-later
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {before, test} = require('node:test');
const yaml = require('js-yaml');
const {buildConstructedTrace, encodeScenarioOverlay, resolveTraceProcessor} = require('../lib/generator.cjs');
const {loadTraceType, resolveTracePacketFieldName, resolveMessageFieldName} = require('../lib/perfetto-proto.cjs');

const root = path.resolve(__dirname, '../../..');
const caseDir = path.join(root, 'Trace/constructed/scene-observation-contracts');
const output = path.join(root, 'backend/test-output/scene-reconstruction-implementation/sql/scene-generator-test');
const scenario = JSON.parse(fs.readFileSync(path.join(caseDir, 'scenario.json'), 'utf8'));
let built;

function csvRows(text) {
  const rows = []; let row = []; let cell = ''; let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (quoted && text[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted;
    } else if (!quoted && (ch === ',' || ch === '\n')) {
      row.push(cell); cell = '';
      if (ch === '\n') { if (row.some(value => value !== '')) rows.push(row); row = []; }
    } else if (ch !== '\r') cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const columns = rows.shift() || [];
  return rows.map(values => Object.fromEntries(columns.map((column, i) => [column, values[i]])));
}

function query(sql, label, file = path.join(output, 'trace.pftrace')) {
  const queryFile = path.join(output, `${label}.sql`);
  fs.writeFileSync(queryFile, sql);
  const result = spawnSync(resolveTraceProcessor(root), ['query', '--no-agent', '--format', 'csv', '-f', queryFile, file], {
    cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    env: {...process.env, AI_AGENT: '1'},
  });
  fs.writeFileSync(path.join(output, `${label}.csv`), result.stdout || '');
  fs.writeFileSync(path.join(output, `${label}.stderr`), result.stderr || '');
  assert.equal(result.status, 0, result.stderr);
  return csvRows(result.stdout);
}

function skillSql(name, id, range) {
  const folder = ['scene_device_state_changes', 'scene_response_markers'].includes(name) ? 'atomic' : 'composite';
  const skill = yaml.load(fs.readFileSync(path.join(root, `backend/skills/${folder}/${name}.skill.yaml`), 'utf8'));
  const step = skill.steps.find(candidate => candidate.id === id);
  assert.ok(step, `${name}.${id}`);
  let sql = step.sql;
  const fragment = (step.sql_fragments || []).map(file =>
    fs.readFileSync(path.join(root, 'backend/skills', file), 'utf8')).join('\n,\n');
  if (fragment) sql = /^WITH\s/i.test(sql)
    ? sql.replace(/^WITH\s/i, `WITH\n${fragment}\n,\n`) : `WITH\n${fragment}\n${sql}`;
  // Match SkillExecutor: interpolate after fragments have joined the statement.
  sql = sql.replace(/\$\{([^}|]+)(?:\|([^}]+))?\}/g, (_, key, fallback) => {
    if (key === 'start_ts') return range?.start ?? built.provenance.anchor_ns;
    if (key === 'end_ts') return range?.end ?? String(BigInt(built.provenance.anchor_ns) + 1000000000n);
    if (fallback !== undefined) return fallback;
    throw new Error(`unbound production SQL parameter ${key}`);
  });
  return (skill.prerequisites.modules || []).map(module => `INCLUDE PERFETTO MODULE ${module};`).join('\n') + '\n' + sql;
}

before(() => {
  built = buildConstructedTrace(root, {
    caseId: 'scene-observation-contracts',
    basePath: path.join(root, 'Trace/real/android-startup-light/trace.pftrace'),
    scenarioPath: path.join(caseDir, 'scenario.json'),
    overlayPath: path.join(output, 'trace.overlay.pftrace'),
    outputPath: path.join(output, 'trace.pftrace'),
  });
  fs.writeFileSync(path.join(output, 'build-provenance.json'), JSON.stringify(built.provenance, null, 2));
});

test('machine CSV queries remain complete inside an agent environment', () => {
  const rows = query(`WITH RECURSIVE rows(n) AS (
    VALUES(1) UNION ALL SELECT n + 1 FROM rows WHERE n < 1500
  ) SELECT n FROM rows`, 'untruncated-machine-csv');
  assert.equal(rows.length, 1500);
  assert.equal(rows.at(-1).n, '1500');
});

test('native motion and two window deliveries survive real protobuf encoding and pinned TP ingestion', () => {
  const rows = query(`INCLUDE PERFETTO MODULE android.input;
    SELECT CAST(event_id AS TEXT) AS event_id, device_id, display_id, action, source
    FROM android_motion_events WHERE device_id BETWEEN 101 AND 105 ORDER BY ts`, 'native-events');
  assert.equal(rows.length, 10);
  assert.deepEqual(rows.filter(row => row.device_id === '101').map(row => row.action), ['0', '2', '2', '1']);
  assert.ok(rows.some(row => row.device_id === '103' && row.action === '99'));
  assert.ok(rows.every(row => row.source === '4098'));
  const dispatch = query(`INCLUDE PERFETTO MODULE android.input;
    SELECT CAST(event_id AS TEXT) AS event_id, window_id, CAST(vsync_id AS TEXT) AS vsync_id
    FROM android_input_event_dispatch WHERE event_id = ${built.provenance.input_event_ids['8810002']}
    ORDER BY window_id`, 'native-dispatch');
  assert.deepEqual(dispatch.map(row => [row.window_id, row.vsync_id]), [['41', '9007199254740993'], ['42', '9007199254740993']]);
});

test('DeviceStateChanged is an actual N instant on its official global track', () => {
  const rows = query(`SELECT s.name AS raw_state, CAST(s.dur AS TEXT) AS dur, t.name AS track_name
    FROM slice s JOIN track t ON t.id = s.track_id
    WHERE t.name = 'DeviceStateChanged' AND s.name IN ('17', '23') ORDER BY s.ts`, 'committed-state-instants');
  assert.deepEqual(rows, [
    {raw_state: '17', dur: '0', track_name: 'DeviceStateChanged'},
    {raw_state: '23', dur: '0', track_name: 'DeviceStateChanged'},
  ]);
});

test('production device SQL retains on/off/AoD, all charging transitions and raw state without inventing posture', () => {
  const rows = query(skillSql('scene_device_state_changes', 'state_intervals'), 'device-state-skill');
  const observed = rows.filter(row => row.source_status === 'observed');
  for (const value of ['on', 'off', 'doze']) assert.ok(observed.some(row => row.dimension === 'screen' && row.state_value === value));
  for (const value of ['charging', 'discharging', 'not_charging', 'full']) assert.ok(observed.some(row => row.dimension === 'charging' && row.state_value === value));
  const commits = observed.filter(row => row.dimension === 'device_state' && row.fact_kind === 'event');
  assert.deepEqual(commits.map(row => row.state_value), ['17', '23']);
  assert.ok(commits.every(row => row.dur_ns === '0'));
  const device = observed.filter(row => row.dimension === 'device_state' && row.fact_kind === 'state_span');
  assert.deepEqual(device.map(row => [row.state_value, row.previous_value]), [['17', '[NULL]'], ['23', '17']]);
  assert.equal(device[0].dur_ns, '400000000');
  assert.ok(device.every(row => row.semantic_limit === 'posture_requires_device_state_configuration'));
  assert.ok(observed.every(row => row.source_table && row.source_id !== '[NULL]'));
  const sources = query(skillSql('scene_device_state_changes', 'state_sources'), 'device-state-sources');
  assert.ok(sources.every(row => row.source_status === 'partial'));
});

test('production input SQL preserves movement, cancellation, unknown, hold and scroll axis input without duplicate physical gestures', () => {
  const rows = query(skillSql('scene_reconstruction', 'user_gestures'), 'input-gestures')
    .filter(row => Number(row.device_id) >= 101 && Number(row.device_id) <= 105);
  assert.equal(rows.length, 5);
  const byDevice = new Map(rows.map(row => [row.device_id, row]));
  assert.equal(byDevice.get('101').gesture_type, 'touch_move');
  assert.equal(byDevice.get('101').event_count, '4');
  assert.equal(byDevice.get('101').dur, '30000000');
  assert.equal(byDevice.get('102').gesture_type, 'cancelled');
  assert.equal(byDevice.get('103').gesture_type, 'input_unknown');
  assert.equal(byDevice.get('103').source_status, 'partial');
  assert.equal(byDevice.get('104').gesture_type, 'touch_hold');
  assert.equal(byDevice.get('105').gesture_type, 'scroll_input');
  assert.equal(byDevice.get('105').input_source, '4098');
  assert.equal(byDevice.get('105').event, '滚动轴输入（ACTION_SCROLL）');
  const gaps = query(skillSql('scene_reconstruction', 'idle_periods'), 'input-gaps');
  for (const gap of gaps) {
    assert.equal(gap.category, 'unknown');
    for (const contact of rows) assert.ok(!(BigInt(gap.ts) < BigInt(contact.end_ts) &&
      BigInt(contact.ts) < BigInt(gap.ts) + BigInt(gap.dur)), 'gap overlaps observed contact');
  }
  const lanes = query(skillSql('state_timeline', 'input_state_lane_frames'), 'input-state-lane');
  assert.ok(lanes.some(row => row.state === 'INPUT_UNKNOWN'));
  assert.ok(lanes.every(row => row.state !== 'IDLE' && row.state !== 'FLING'));
});

test('response inventory preserves constructed thread and process-track marker execution intervals', () => {
  const rows = query(skillSql('scene_response_markers', 'response_markers'), 'response-markers')
    .filter(row => row.process_name === 'com.smartperfetto.fixture');
  const fling = rows.find(row => row.raw_name === 'FlingStart duration=1580, direction=VERTICAL, caller=UNKNOWN');
  assert.ok(fling);
  assert.equal(fling.dur, '781'); assert.equal(BigInt(fling.end_ts) - BigInt(fling.ts), 781n);
  assert.equal(fling.identity_basis, 'thread_track');
  const scroll = rows.find(row => row.raw_name === 'Scroll');
  assert.ok(scroll); assert.equal(scroll.identity_basis, 'process_track'); assert.equal(scroll.dur, '100600833');
  assert.equal(scroll.upid, fling.upid);
  assert.ok(rows.every(row => row.semantic_limit === 'slice_execution_only_not_action_extent_or_presentation'));
});

test('response inventory finds the real customer markers without synthesizing their full fling duration', () => {
  const realTrace = path.join(root, 'Trace/real/android-scroll-customer/trace.pftrace');
  const rows = query(skillSql('scene_response_markers', 'response_markers', {start: 'NULL', end: 'NULL'}),
    'response-customer-markers', realTrace);
  const flings = rows.filter(row => row.marker_kind === 'fling_start_marker');
  assert.equal(flings.length, 2);
  assert.ok(flings.every(row => row.dur === '781' && BigInt(row.end_ts) - BigInt(row.ts) === 781n));
  assert.ok(flings.every(row => row.identity_basis === 'thread_track' && row.upid === '885'));
  assert.ok(flings.some(row => row.raw_name.includes('duration=1580')));
  assert.ok(flings.some(row => row.raw_name.includes('duration=1497')));
  const scrolls = rows.filter(row => row.raw_name === 'Scroll');
  assert.deepEqual(scrolls.map(row => row.dur), ['100600833', '75086667']);
  assert.ok(scrolls.every(row => row.identity_basis === 'process_track' && row.upid === '885'));
});

test('input IDs isolate from the base while preserving shared physical-event references, and ns above 2^53 survive decode', () => {
  const anchorNs = '9007199254740993';
  const encoded = encodeScenarioOverlay(root, scenario, {
    anchorNs, sequenceId: 701, usedPids: [], usedInputEventIds: [8810001, 8810002],
  });
  assert.notEqual(encoded.provenance.input_event_ids['8810001'], 8810001);
  assert.notEqual(encoded.provenance.input_event_ids['8810002'], 8810002);
  const trace = loadTraceType(root).decode(encoded.buffer);
  const outer = resolveTracePacketFieldName(root, 112);
  const inner = resolveMessageFieldName(root, 'com.android.internal.WinscopeExtensions', 5);
  const native = trace.packet.filter(packet => packet[outer]?.[inner]);
  const motion = native.find(packet => packet[outer][inner].dispatcherMotionEvent);
  assert.equal(motion.timestamp.toString(), String(BigInt(anchorNs) + 100000000n));
  const deliveries = native.filter(packet => packet[outer][inner].dispatcherWindowDispatchEvent);
  assert.equal(deliveries.length, 2);
  assert.ok(deliveries.every(packet => packet[outer][inner].dispatcherWindowDispatchEvent.eventId === encoded.provenance.input_event_ids['8810002']));
});

test('signed device/display/vsync values and unsigned event/source limits retain their wire meaning', () => {
  const motion = {type: 'android-input-motion', at_ns: '1', event_id: 4294967295,
    source: 4294967295, action: -1, device_id: -2147483648, display_id: -1};
  const dispatch = {type: 'android-input-dispatch', at_ns: '2', event_id: 4294967295,
    window_id: -1, vsync_id: '-9223372036854775808'};
  const encoded = encodeScenarioOverlay(root, {...scenario, signals: [motion, dispatch]}, {
    anchorNs: '1000000000', sequenceId: 703, usedPids: [],
  });
  const outer = resolveTracePacketFieldName(root, 112);
  const inner = resolveMessageFieldName(root, 'com.android.internal.WinscopeExtensions', 5);
  const native = loadTraceType(root).decode(encoded.buffer).packet.filter(packet => packet[outer]?.[inner]);
  assert.equal(native[0][outer][inner].dispatcherMotionEvent.eventId, 4294967295);
  assert.equal(native[0][outer][inner].dispatcherMotionEvent.deviceId, -2147483648);
  assert.equal(native[0][outer][inner].dispatcherMotionEvent.displayId, -1);
  assert.equal(native[1][outer][inner].dispatcherWindowDispatchEvent.vsyncId.toString(), '-9223372036854775808');
});

test('new signals reject invalid wire integers and atrace delimiter injection before writing a trace', () => {
  const motion = scenario.signals.find(signal => signal.type === 'android-input-motion');
  const instant = scenario.signals.find(signal => signal.type === 'atrace-track-instant');
  const dispatch = scenario.signals.find(signal => signal.type === 'android-input-dispatch');
  for (const signal of [
    {...motion, event_id: -1}, {...motion, source: 4294967296},
    {...motion, device_id: 2147483648}, {...motion, display_id: -2147483649},
    {...motion, action: 1.5}, {...dispatch, vsync_id: '9223372036854775808'},
    {...dispatch, window_id: 2147483648}, {...instant, name: '17|23'},
    {...instant, track_name: 'DeviceStateChanged\nE|1'},
  ]) {
    assert.throws(() => encodeScenarioOverlay(root, {...scenario, signals: [signal]}, {
      anchorNs: '1000000000', sequenceId: 702, usedPids: [],
    }));
  }
});
