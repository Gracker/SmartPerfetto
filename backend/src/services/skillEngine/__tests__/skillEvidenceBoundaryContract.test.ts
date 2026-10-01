// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import Database from 'better-sqlite3';
import { describe, expect, it } from '@jest/globals';
import { renderStepSql } from '../../../../tests/helpers/skillFragmentSql';

const repoRoot = path.resolve(__dirname, '../../../..');

function readBackendFile(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

describe('Skill evidence boundary contracts', () => {
  it('keeps network_analysis scoped to packet evidence unless request telemetry exists', () => {
    const content = readBackendFile('skills/composite/network_analysis.skill.yaml');

    expect(content).toContain('id: evidence_scope');
    expect(content).toContain('trace_direct:packet_activity');
    expect(content).toContain('不能直接证明 DNS/TCP/TLS/TTFB/请求体/响应体/解码/服务端处理阶段耗时');
    expect(content).toContain('HTTPDNS 缓存/TTL');
    expect(content).toContain('ECH/CT/local-network permission/NetworkCallback');
    expect(content).toContain('OkHttp/Cronet/HttpEngine/自研网络库阶段埋点');
    expect(content).toContain('NETWORK_DNS_PACKET_ACTIVITY');
    expect(content).toContain('当前 packet trace 不能直接证明 DNS 阶段耗时或请求延迟');
    expect(content).not.toContain('DNS 查询频繁，可能导致网络延迟');
  });

  it('keeps wakelock vitals hints tied to the observed window', () => {
    const content = readBackendFile('skills/atomic/android_kernel_wakelock_summary.skill.yaml');

    expect(content).toContain('observed_window_hours');
    expect(content).toContain('evidence_scope');
    expect(content).toContain('partial_trace_window');
    expect(content).toContain('partial_window_not_vitals_judgment');
    expect(content).not.toContain('excessive_if_24h_window');
  });
});

// Execute the maintained SQL rather than mirroring the temperature filters.
function thermalQuery(db: Database.Database, stepId: string, start = 'NULL', end = 'NULL'): any[] {
  const definition = yaml.load(readBackendFile('skills/composite/thermal_throttling.skill.yaml')) as any;
  const step = definition.steps.find((item: any) => item.id === stepId);
  const fragments = (step.sql_fragments ?? []).map((file: string) => readBackendFile(`skills/${file}`)).join('\n,\n');
  let sql: string = step.sql;
  if (fragments) sql = /^WITH\s/i.test(sql) ? sql.replace(/^WITH\s/i, `WITH ${fragments}\n,\n`) : `WITH ${fragments}\n${sql}`;
  sql = sql.replace(/\$\{start_ts\}/g, start).replace(/\$\{end_ts\}/g, end)
    .replace(/\$\{[^}|]+\|([^}]*)\}/g, (_: string, fallback: string) => fallback);
  return db.prepare(sql).all();
}

function temperatureFixture(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE counter(id INTEGER PRIMARY KEY, track_id INTEGER, ts INTEGER, value REAL);
    CREATE TABLE counter_track(id INTEGER, name TEXT, unit TEXT, type TEXT);
    CREATE TABLE cpu_counter_track(id INTEGER, cpu INTEGER, name TEXT);`);
  return db;
}

function addTemperature(db: Database.Database, id: number, name: string, unit: string | null, values: number[], interval = 1000000000, type: string | null = null) {
  db.prepare('INSERT INTO counter_track(id,name,unit,type) VALUES(?,?,?,?)').run(id,name,unit,type);
  values.forEach((value, index) => db.prepare('INSERT INTO counter(track_id,ts,value) VALUES(?,?,?)').run(id,index*interval,value));
}

describe('temperature evidence quality and DVFS causal boundary', () => {
  it('excludes sparse spikes and UI counters from peaks, retaining skin identity and reasons', () => {
    const db = temperatureFixture();
    try {
      addTemperature(db,1,'virtual-sensor-skin Temperature',null,[34114,34800,35500,35874,35000,34400]);
      addTemperature(db,2,'cpu-1-0-1 Temperature',null,[90300,74800],19598000);
      addTemperature(db,3,'VRI[ThermalActivity]',null,[0,1,2,3,4,0]);
      const rows = thermalQuery(db,'thermal_overview');
      expect(rows.find(row=>row.sensor_track_id===1)).toMatchObject({max_temp_c:35.9,sample_quality:'accepted',unit_basis:'inferred_from_track_range'});
      expect(rows.find(row=>row.sensor_track_id===2)).toMatchObject({max_temp_c:null,raw_max_temp_c:90.3,sample_quality:'insufficient_samples'});
      expect(rows.find(row=>row.sensor_track_id===3)).toMatchObject({max_temp_c:null,sample_quality:'implausible_range'});
      expect(thermalQuery(db,'root_cause_classification')[0]).toMatchObject({classification:'DATA_SUSPECT',peak_temp_c:35.9,throttled_cpu_count:null});
      expect(thermalQuery(db,'thermal_timeline').every(row=>row.sensor_track_id===1)).toBe(true);
      expect(thermalQuery(db,'high_temp_periods')).toEqual([]);
    } finally {db.close();}
  });

  it('reads Perfetto-typed thermal_temperature tracks as millidegrees regardless of value range', () => {
    const db = temperatureFixture();
    try {
      addTemperature(db,1,'cpu-big Temperature',null,[34000,35000,36000,37000,38000,39000],1000000000,'thermal_temperature');
      addTemperature(db,2,'skin-ish Temperature',null,[34,35,36,37,38,39]);
      const rows = thermalQuery(db,'thermal_overview');
      expect(rows.find(row=>row.sensor_track_id===1)).toMatchObject({unit_basis:'perfetto_track_type',sample_quality:'accepted',max_temp_c:39});
      expect(rows.find(row=>row.sensor_track_id===2)).toMatchObject({unit_basis:'inferred_from_track_range',sample_quality:'accepted',max_temp_c:39});
    } finally {db.close();}
  });

  it('keeps same-name tracks separate, detects jumps, respects units and analysis bounds', () => {
    const db = temperatureFixture();
    try {
      addTemperature(db,1,'cpu Temperature','C',[70,71,72,73,74]);
      addTemperature(db,2,'cpu Temperature','C',[90,70,71,72,73],20000000);
      addTemperature(db,3,'other Temperature','F',[70,71,72,73,74]);
      const rows = thermalQuery(db,'thermal_overview');
      expect(rows).toHaveLength(3);
      expect(rows.find(row=>row.sensor_track_id===1)).toMatchObject({sample_quality:'accepted',max_temp_c:74});
      expect(rows.find(row=>row.sensor_track_id===2)).toMatchObject({sample_quality:'abrupt_jump',max_temp_c:null});
      expect(rows.find(row=>row.sensor_track_id===3)).toMatchObject({sample_quality:'unsupported_unit',max_temp_c:null});
      expect(thermalQuery(db,'thermal_overview','0','2000000000').every(row=>row.sample_quality!=='accepted')).toBe(true);
    } finally {db.close();}
  });

  it('preserves real high temperatures and sustained periods without inferring throttling', () => {
    const db = temperatureFixture();
    try {
      addTemperature(db,1,'cpu Temperature','C',[80,81,82,83,84,85]);
      expect(thermalQuery(db,'root_cause_classification')[0]).toMatchObject({classification:'HIGH_TEMP_OBSERVED',peak_temp_c:85,thermal_throttling_evidence:'not_established'});
      expect(thermalQuery(db,'high_temp_periods')[0]).toMatchObject({duration_sec:5,sample_count:6,peak_temp_c:85});
      addTemperature(db,2,'skin Temperature','C',[34,35,35,35,34,34]);
      expect(thermalQuery(db,'root_cause_classification')[0]).toMatchObject({classification:'DATA_SUSPECT',peak_temp_c:85});
      expect(thermalQuery(db,'thermal_overview').every(row=>row.sample_quality==='accepted')).toBe(true);
    } finally {db.close();}
  });

  it('reports unavailable temperature as null rather than a normal zero-degree sample', () => {
    const db = temperatureFixture();
    try {expect(thermalQuery(db,'root_cause_classification')[0]).toMatchObject({classification:'THERMAL_DATA_UNAVAILABLE',peak_temp_c:null});}
    finally {db.close();}
  });

  it('keeps frequency-only decline as an observation with thermal mechanism unknown', () => {
    const db = temperatureFixture();
    try {
      db.exec(`CREATE TABLE _cpu_topology(cpu_id INTEGER,core_type TEXT);
        INSERT INTO _cpu_topology VALUES(0,'big');
        INSERT INTO cpu_counter_track VALUES(1,0,'cpufreq');
        INSERT INTO counter(track_id,ts,value) VALUES(1,0,3000000),(1,1000000000,2000000),(1,2000000000,400000);`);
      const range = yaml.load(readBackendFile('skills/atomic/cpu_throttling_in_range.skill.yaml')) as any;
      const predictor = yaml.load(readBackendFile('skills/atomic/thermal_predictor.skill.yaml')) as any;
      const run = (sql: string) => db.prepare(sql.replace(/\$\{([^}]+)\}/g, (_: string,key: string)=> {
        if(key==='start_ts') return '0'; if(key==='end_ts') return '3000000000';
        const fallback = key.split('|')[1]; if(fallback!==undefined) return fallback;
        if(/^[a-z_]+\.data\[/.test(key)) return ''; throw new Error(key);
      })).all() as any[];
      expect(run(range.steps.find((step:any)=>step.id==='throttle_detection').sql)[0]).toMatchObject({frequency_variation_detected:1,throttle_detected:null,evidence_status:'thermal_evidence_missing'});
      expect(run(predictor.sql)[0]).toMatchObject({frequency_trend_risk:'high',thermal_risk:'unknown'});
    } finally {db.close();}
  });
});

// Execute the maintained throttle_detection SQL over cpufreq tracks. `tracks`
// maps a track id to its local CPU and kHz samples. `topology` is either a
// hand-built _cpu_topology or 'derived': cpu_topology_view's own SQL over the
// tracks with no sched data and no capacity metadata.
function throttleRows(
  topology: Array<[number, string]> | 'derived',
  tracks: Array<[number, number, Array<number | null>]>,
  limit: {status?: string; depth?: number; start?: number; end?: number} = {},
): any[] {
  const db = temperatureFixture();
  try {
    const addTrack = db.prepare('INSERT INTO cpu_counter_track VALUES(?,?,?)');
    const addSample = db.prepare('INSERT INTO counter(track_id,ts,value) VALUES(?,?,?)');
    for (const [id, cpu, values] of tracks) {
      addTrack.run(id, cpu, 'cpufreq');
      values.forEach((value, index) => addSample.run(id, index * 1000, value));
    }
    if (topology === 'derived') {
      db.exec(`CREATE TABLE sched_slice(cpu INTEGER);
        CREATE TABLE thread_state(cpu INTEGER, state TEXT);
        CREATE TABLE cpu(id INTEGER, cpu INTEGER, machine_id INTEGER, capacity INTEGER);`);
      const view = yaml.load(readBackendFile('skills/atomic/cpu_topology_view.skill.yaml')) as any;
      const create: string = view.steps.find((step: any) => step.id === 'create_topology_view').sql;
      db.exec(create.replace(/^\s*CREATE\s+PERFETTO\s+TABLE\s+/i, 'CREATE TABLE '));
    } else {
      db.exec('CREATE TABLE _cpu_topology(cpu_id INTEGER, core_type TEXT)');
      const addCpu = db.prepare('INSERT INTO _cpu_topology VALUES(?,?)');
      for (const [cpu, coreType] of topology) addCpu.run(cpu, coreType);
    }
    const definition = yaml.load(readBackendFile('skills/atomic/cpu_throttling_in_range.skill.yaml')) as any;
    const step = definition.steps.find((item: any) => item.id === 'throttle_detection');
    return db.prepare(renderStepSql(step.sql, step.sql_fragments, {
      start_ts: limit.start ?? 0,
      end_ts: limit.end ?? 1000000,
      'limit_evidence.data[0].evidence_status': limit.status ?? '',
      'limit_evidence.data[0].deepest_depth_pct': limit.depth ?? 0,
    })).all() as any[];
  } finally {db.close();}
}

const byTier = (rows: any[]) => Object.fromEntries(rows.map(row => [row.core_type, row]));

describe('cpu_throttling_in_range tier contract', () => {
  it('reports each topology tier on its own row and never files medium or unknown cores as little', () => {
    const rows = throttleRows(
      [[0, 'little'], [1, 'medium'], [2, 'big'], [3, 'prime'], [4, 'unknown']],
      [[10, 0, [1000000]], [11, 1, [2000000]], [12, 2, [2500000]], [13, 3, [3000000]], [14, 4, [1500000]]],
    );
    expect(rows.map(row => [row.core_type, row.max_freq_mhz])).toEqual([
      ['超大核', 3000], ['大核', 2500], ['中核', 2000], ['小核', 1000], ['未知', 1500],
    ]);
    expect(rows.filter(row => row.interpretation.startsWith('核心类别未知')).map(row => row.core_type)).toEqual(['未知']);
    for (const row of rows) expect(row.interpretation).toContain('最低/最高为本类别包络');
  });

  it('measures the frequency span inside each cpufreq track, never across tracks', () => {
    // Two machines' CPU 0 share a local number; each track stays its own series.
    const [unknown] = throttleRows([[0, 'unknown']], [[1, 0, [500000, 500000]], [2, 0, [3000000, 3000000]]]);
    expect(unknown).toMatchObject({core_type: '未知', min_freq_mhz: 500, max_freq_mhz: 3000, freq_drop_pct: 0, frequency_variation_detected: 0});

    const rows = throttleRows(
      [[0, 'big'], [1, 'medium'], [2, 'little'], [3, 'little'], [4, 'prime']],
      [
        [1, 0, [400000, 3000000]], // a pure rise is still a span
        [2, 1, [1000000, 700000]], // exactly 30% stays under the threshold
        [3, 2, [1000000, 2000000]], [4, 3, [1500000, 1500000]],
        [5, 4, [2000000]], // a single sample shows no span
      ],
    );
    const tiers = byTier(rows);
    expect(tiers['大核']).toMatchObject({freq_drop_pct: 86.7, frequency_variation_detected: 1});
    expect(tiers['中核']).toMatchObject({freq_drop_pct: 30, frequency_variation_detected: 0});
    expect(tiers['小核']).toMatchObject({freq_drop_pct: 50, frequency_variation_detected: 1, start_freq_mhz: 1250, end_freq_mhz: 1750});
    expect(tiers['超大核']).toMatchObject({freq_drop_pct: 0, frequency_variation_detected: 0});
  });

  it('keeps tracks without valid frequency samples out of the span instead of reading them as unchanged', () => {
    const rows = throttleRows(
      [[0, 'big'], [1, 'big'], [2, 'little'], [3, 'medium'], [4, 'medium']],
      [
        [1, 0, [0, 0]], [2, 1, [null]],
        [3, 2, [null, 1000000, 2000000, 0]],
        [4, 3, [1000000, 1500000]], [5, 4, [0]],
      ],
    );
    const tiers = byTier(rows);
    expect(tiers['大核']).toMatchObject({start_freq_mhz: null, max_freq_mhz: null, freq_drop_pct: null, frequency_variation_detected: null});
    expect(tiers['大核'].interpretation).toContain('无法计算频率跨度');
    expect(tiers['小核']).toMatchObject({start_freq_mhz: 1000, end_freq_mhz: 2000, min_freq_mhz: 1000, freq_drop_pct: 50});
    expect(tiers['小核'].interpretation).not.toContain('有效频率采样');
    expect(tiers['中核']).toMatchObject({freq_drop_pct: 33.3, frequency_variation_detected: 1});
    expect(tiers['中核'].interpretation).toContain('跨度只覆盖有采样的轨道');
    expect(throttleRows([[0, 'big']], [[1, 0, [1000000]]], {start: 5000})).toEqual([]);
  });

  it('keeps cpufreq tracks the topology did not admit, as unknown', () => {
    // Without sched data the topology admits only CPUs with a positive cpufreq
    // sample, so CPU 1 (zeros only) is absent from _cpu_topology.
    const [row] = throttleRows('derived', [[1, 0, [1000000, 1500000]], [2, 1, [0, 0]]]);
    expect(row).toMatchObject({core_type: '未知', freq_drop_pct: 33.3});
    expect(row.interpretation).toContain('跨度只覆盖有采样的轨道');
  });

  it('marks observed limit evidence as window-level on every tier row', () => {
    const rows = throttleRows([[0, 'little'], [1, 'big']], [[1, 0, [1000000]], [2, 1, [2000000]]],
      {status: 'freq_limit_observed', depth: 25});
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toMatchObject({throttle_detected: 1, evidence_status: 'freq_limit_observed'});
      expect(row.interpretation).toContain('最大深度 25%');
      expect(row.interpretation).toContain('整窗证据，不说明本行核心受限');
    }
  });
});
