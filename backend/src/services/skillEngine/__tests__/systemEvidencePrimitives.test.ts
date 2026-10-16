// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import Database from 'better-sqlite3';
import {describe, expect, it} from '@jest/globals';
import {createSkillExecutor} from '../skillExecutor';
import {ArtifactStore} from '../../../agentv3/artifactStore';

const names = ['cpu_system_context_in_range', 'thread_system_summary_in_range',
  'thread_preemption_handoffs_in_range', 'thread_cpu_placement_timeline'];
const load = (name: string): any => yaml.load(fs.readFileSync(path.join(process.cwd(), 'skills/atomic', `${name}.skill.yaml`), 'utf8'));
const fixture = () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE trace_bounds(start_ts INTEGER,end_ts INTEGER);
    INSERT INTO trace_bounds VALUES(0,100000000);
    CREATE TABLE cpu(id INTEGER,cpu INTEGER,machine_id INTEGER,cluster_id INTEGER,capacity INTEGER);
    INSERT INTO cpu VALUES(0,0,NULL,0,300),(7,7,NULL,1,1024),(8,8,NULL,1,600),(10,10,NULL,2,512);
    CREATE TABLE process(upid INTEGER PRIMARY KEY,pid INTEGER,name TEXT);
    INSERT INTO process VALUES(42,100,'app'),(43,100,'app'),(99,900,'peer');
    CREATE TABLE thread(utid INTEGER PRIMARY KEY,tid INTEGER,upid INTEGER,name TEXT,is_idle INTEGER DEFAULT 0);
    INSERT INTO thread(utid,tid,upid,name) VALUES(1,100,42,'main'),(2,101,42,'waiting'),(3,900,99,'peer'),(4,100,43,'main');
    CREATE TABLE sched_slice(id INTEGER PRIMARY KEY,ts INTEGER,dur INTEGER,cpu INTEGER,ucpu INTEGER,utid INTEGER,end_state TEXT,priority INTEGER);
    INSERT INTO sched_slice VALUES(1,0,15000000,7,7,1,'R+',120),(2,15000000,15000000,7,7,3,'S',90),
      (3,30000000,20000000,8,8,1,'R',110),(4,0,100000000,0,0,4,'S',120);
    CREATE TABLE thread_state(id INTEGER PRIMARY KEY,ts INTEGER,dur INTEGER,cpu INTEGER,ucpu INTEGER,utid INTEGER,state TEXT,io_wait INTEGER,blocked_function TEXT,waker_utid INTEGER,irq_context INTEGER);
    INSERT INTO thread_state VALUES(1,0,15000000,7,7,1,'Running',NULL,NULL,NULL,NULL),
      (2,15000000,15000000,NULL,NULL,1,'R+',NULL,NULL,NULL,NULL),
      (3,30000000,20000000,8,8,1,'Running',NULL,NULL,NULL,NULL),
      (4,0,-1,NULL,NULL,2,'D',NULL,NULL,NULL,NULL),(5,0,100000000,0,0,4,'Running',NULL,NULL,NULL,NULL);
    CREATE TABLE cpu_frequency_counters(cpu INTEGER,ts INTEGER,dur INTEGER,freq INTEGER,id INTEGER,track_id INTEGER,ucpu INTEGER);
    INSERT INTO cpu_frequency_counters(cpu,ts,dur,freq) VALUES(7,0,35000000,1000000),(7,35000000,65000000,2000000),
      (8,35000000,65000000,2000000);
  `);
  db.exec('UPDATE cpu_frequency_counters SET id=rowid,track_id=cpu,ucpu=cpu');
  return db;
};
const query = (db: Database.Database, name: string, options: {start?: number; end?: number; utid?: number; windows?: string} = {}) => {
  const [file,step] = name.split('#');
  const definition = name.includes('/') ? yaml.load(fs.readFileSync(path.join(process.cwd(),'skills',file+'.skill.yaml'),'utf8')) as any : load(name);
  const skill = step ? definition.steps.find((item:any)=>item.id===step) : definition;
  let sql = skill.sql as string;
  const fragments = (skill.sql_fragments||[]).map((file: string) => fs.readFileSync(path.join(process.cwd(), 'skills', file), 'utf8')).join('\n,\n');
  sql = sql.replace(/\bWITH(\s+RECURSIVE)?\s+/, (_:string,recursive:string|undefined)=>`WITH${recursive||''} ${fragments}\n,\n`);
  if (options.windows) sql = sql.replace('SELECT 0 AS window_id, ${start_ts} AS window_start_ts, ${end_ts} AS window_end_ts', options.windows);
  const params: Record<string, string> = {start_ts: String(options.start ?? 10000000), end_ts: String(options.end ?? 40000000),
    '__process_scope.upid': '42', package: 'stale-name', 'package|':'stale-name','thread_name|':'','top_k|20':'20','target_process.data[0].upid':'42','sched_delay_critical_ms|16':'16','freq_bucket_mhz|100':'100','top_k|15':'15','bucket_ms|50':'50',tid:'NULL',utid: options.utid === undefined ? 'NULL' : String(options.utid)};
  sql = sql.replace(/\$\{([^}]+)\}/g, (_: string, key: string) => {
    if (!(key in params)) throw new Error(`Unknown parameter ${key}`);
    return params[key];
  });
  try {return db.prepare(sql).all() as Array<Record<string, any>>;} catch(error) {throw new Error(`${name}: ${String(error)}`);}
};

describe('canonical system evidence primitives', () => {
  it('clips crossings, retains pure waiters, separates incarnation identity, and weights only covered running', () => {
    const db = fixture();
    try {
      const rows = query(db, names[1]);
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({upid: 42,utid: 1,running_ns: 15000000,runnable_ns: 15000000,
        runnable_preempted_ns: 15000000,state_covered_ns: 30000000,big_running_ns: 15000000,little_running_ns: 0,
        frequency_covered_ns: 10000000,avg_freq_khz: 1500000,frequency_evidence: 'partial',
        priority_min: 110,priority_max: 120,preemption_count: 1,migrations: 1});
      expect(rows[1]).toMatchObject({utid: 2,running_ns: 0,uninterruptible_ns: 30000000,
        unfinished_state_ns: 30000000,state_evidence: 'observed',placement_evidence: 'unavailable',priority_min: null});
      expect(query(db,names[1],{utid:2})).toHaveLength(1);
    } finally {db.close();}
  });
  it('excludes a nonzero idle UTID from busy time and preserves an idle successor as a real handoff', () => {
    const db=fixture();
    try {
      db.exec('UPDATE thread SET is_idle=1 WHERE utid=3');
      const cpu=query(db,names[0],{start:10000000,end:30000000}).find(row=>row.ucpu===7)!;
      expect(cpu).toMatchObject({sched_covered_ns:20000000,busy_ns:5000000,idle_ns:15000000,
        idle_identity_unknown_ns:0,busy_pct:25,sched_evidence:'observed'});
      expect(query(db,names[2])[0]).toMatchObject({sched_id:1,peer_sched_id:2,peer_utid:3,
        peer_is_idle:1,peer_role:'idle_not_competing_task',peer_priority:90,handoff_evidence:'observed'});
      expect(query(db,'composite/startup_detail#per_cpu_system_context',{start:10000000,end:30000000})
        .find(row=>row.ucpu===7)).toMatchObject({system_busy_ms:5,idle_ns:15000000,sched_evidence:'observed'});
      expect(query(db,'composite/startup_detail#preemption')[0]).toMatchObject({next_utid:3,next_is_idle:1,next_role:'idle_not_competing_task'});
      db.exec('DELETE FROM thread WHERE utid=3');
      expect(query(db,names[0],{start:10000000,end:30000000}).find(row=>row.ucpu===7))
        .toMatchObject({busy_ns:5000000,idle_identity_unknown_ns:15000000,sched_evidence:'partial'});
      expect(query(db,names[2])[0]).toMatchObject({peer_sched_id:2,peer_is_idle:null,peer_role:'idle_identity_unknown'});
    } finally {db.close();}
  });
  it('keeps an observed zero frequency interval distinct from missing frequency', () => {
    const db=fixture();
    try {
      db.exec('UPDATE cpu_frequency_counters SET freq=0 WHERE cpu=7');
      expect(query(db,names[0],{start:10000000,end:15000000}).find(row=>row.ucpu===7))
        .toMatchObject({avg_freq_khz:0,min_freq_khz:0,frequency_covered_ns:5000000,frequency_evidence:'observed'});
      expect(query(db,names[1],{start:10000000,end:15000000,utid:1})[0])
        .toMatchObject({avg_freq_khz:0,frequency_covered_ns:5000000,frequency_evidence:'observed'});
      expect(query(db,'composite/startup_detail#cpu_freq_analysis',{start:10000000,end:15000000})[0])
        .toMatchObject({avg_freq_mhz:0,min_freq_mhz:0});
      db.exec('DELETE FROM cpu_frequency_counters WHERE cpu=7');
      expect(query(db,names[1],{start:10000000,end:15000000,utid:1})[0])
        .toMatchObject({avg_freq_khz:null,frequency_covered_ns:0,frequency_evidence:'unavailable'});
    } finally {db.close();}
  });
  it('distinguishes recorded homogeneous capacity from missing topology without inventing a big core', () => {
    const db=fixture();
    try {
      db.exec('UPDATE cpu SET capacity=512');
      expect(query(db,names[1],{utid:1})[0]).toMatchObject({big_running_ns:0,little_running_ns:0,
        unknown_running_ns:15000000,homogeneous_running_ns:15000000,topology_missing_running_ns:0,
        placement_mode:'homogeneous_big_little_not_applicable',topology_source:'capacity_uniform_no_big_little',placement_evidence:'observed'});
      expect(query(db,names[3],{utid:1})[0]).toMatchObject({core_type:'unknown',capacity:512,
        placement_mode:'homogeneous_big_little_not_applicable',placement_evidence:'observed'});
      db.exec('UPDATE cpu SET capacity=NULL WHERE id=8');
      expect(query(db,names[1],{utid:1})[0]).toMatchObject({homogeneous_running_ns:0,
        topology_missing_running_ns:15000000,placement_mode:'unknown_topology',placement_evidence:'partial'});
      expect(query(db,names[1],{utid:1})[0].topology_source).toContain('capacity_incomplete');
    } finally {db.close();}
  });
  it('requires complete capacity per machine before assigning extrema and keeps the legacy quadrant consistent', () => {
    const db=fixture();
    try {
      db.exec('UPDATE cpu SET capacity=CASE id WHEN 0 THEN 512 WHEN 7 THEN 768 WHEN 8 THEN NULL ELSE 640 END');
      const partial=query(db,names[0]);
      expect(partial.every(row=>row.core_type==='unknown' && row.topology_source==='capacity_incomplete')).toBe(true);
      expect(partial.find(row=>row.ucpu===7)).toMatchObject({capacity:768});
      expect(partial.find(row=>row.ucpu===8)).toMatchObject({capacity:null});
      expect(query(db,names[1],{utid:1})[0]).toMatchObject({big_running_ns:0,little_running_ns:0,
        unknown_running_ns:15000000,topology_missing_running_ns:15000000,placement_mode:'unknown_topology'});
      const quadrant=fs.readFileSync(path.join(process.cwd(),'skills/fragments/thread_states_quadrant.sql'),'utf8');
      const legacy=db.prepare(`WITH target_threads AS (SELECT 1 AS utid,'main' AS thread_type,
        10000000 AS thread_start_ts,40000000 AS thread_end_ts), ${quadrant} SELECT * FROM thread_states`).all();
      expect(legacy).toEqual(expect.arrayContaining([expect.objectContaining({quadrant:'UnknownRunning',dur_ns:15000000})]));
      expect(legacy.some((row:any)=>row.quadrant==='Q1'||row.quadrant==='Q2')).toBe(false);
      db.exec('INSERT INTO cpu VALUES(100,0,1,0,256),(107,7,1,1,1024)');
      const machines=query(db,names[0]);
      expect(machines.filter(row=>row.machine_id===null).every(row=>row.core_type==='unknown')).toBe(true);
      expect(machines.find(row=>row.ucpu===100)).toMatchObject({core_type:'little',topology_source:'recorded_capacity'});
      expect(machines.find(row=>row.ucpu===107)).toMatchObject({core_type:'big',topology_source:'recorded_capacity'});
      db.exec('UPDATE cpu SET capacity=NULL WHERE machine_id IS NULL');
      expect(query(db,names[0]).filter(row=>row.machine_id===null)
        .every(row=>row.core_type==='unknown' && row.topology_source==='capacity_unavailable')).toBe(true);
      expect(query(db,names[0]).find(row=>row.ucpu===107)).toMatchObject({core_type:'big'});
    } finally {db.close();}
  });
  it('distinguishes observed zero preemptions from unavailable scheduling evidence', () => {
    const db=fixture();
    try {
      expect(query(db,names[1],{utid:2})[0]).toMatchObject({preemption_count:0,preemption_evidence:'observed'});
      db.exec('DELETE FROM thread_state WHERE utid=2');
      expect(query(db,names[1],{utid:2})[0]).toMatchObject({preemption_count:null,preemption_evidence:'unavailable'});
      db.exec('INSERT INTO cpu VALUES(11,11,NULL,2,NULL),(12,12,NULL,2,NULL),(13,13,NULL,2,NULL),(14,14,NULL,2,NULL)');
      const cpus=query(db,names[0]);
      expect(cpus).toHaveLength(8);
      expect(cpus.filter(row=>row.frequency_evidence==='unavailable')).toHaveLength(6);
    } finally {db.close();}
  });
  it('uses window time for global frequency, reports gaps, and preserves native identity across repeated machine CPU ordinals', () => {
    const db=fixture();
    try {
      const cpu=query(db,names[0]).find(row=>row.ucpu===7)!;
      expect(cpu.avg_freq_khz).toBeCloseTo(1166666.6667,3);
      expect(cpu).toMatchObject({frequency_covered_ns:30000000,frequency_evidence:'observed',busy_ns:20000000,sched_evidence:'partial'});
      expect(query(db,names[0]).find(row=>row.ucpu===10)).toMatchObject({core_type:'medium',frequency_evidence:'unavailable',avg_freq_khz:null});
      db.exec('INSERT INTO cpu VALUES(107,7,1,0,1024)');
      db.exec('INSERT INTO cpu_frequency_counters VALUES(7,10000000,30000000,3000000,99,99,107)');
      const distinct=query(db,names[0]).filter(row=>row.cpu===7);
      expect(distinct.find(row=>row.ucpu===7)!.avg_freq_khz).toBeCloseTo(1166666.6667,3);
      expect(distinct.find(row=>row.ucpu===107)).toMatchObject({machine_id:1,avg_freq_khz:3000000,frequency_evidence:'observed'});
    } finally {db.close();}
  });
  it('requires a real R+ switch and exact ucpu successor, without attributing the whole peer duration', () => {
    const db=fixture();
    try {
      const rows=query(db,names[2]);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({sched_id:1,switch_ts:15000000,priority:120,peer_sched_id:2,peer_upid:99,
        peer_priority:90,runnable_overlap_ns:15000000,handoff_evidence:'observed'});
      expect(query(db,names[2],{end:12000000})).toHaveLength(0);
      expect(query(db,names[2],{start:15000000,end:16000000})[0].runnable_overlap_ns).toBe(1000000);
      db.exec('UPDATE sched_slice SET ucpu=107 WHERE id=2');
      expect(query(db,names[2])[0]).toMatchObject({peer_sched_id:null,handoff_evidence:'partial'});
      db.exec("UPDATE sched_slice SET end_state='R' WHERE id=1");
      expect(query(db,names[2])).toHaveLength(0);
    } finally {db.close();}
  });
  it('preserves unfinished raw duration and multiwindow identity without manufacturing switches', () => {
    const db=fixture();
    try {
      db.exec("UPDATE sched_slice SET dur=-1,end_state=NULL WHERE id=3");
      const rows=query(db,names[3],{windows:'SELECT 11 AS window_id, 10000000 AS window_start_ts,40000000 AS window_end_ts UNION ALL SELECT 12,35000000,45000000'});
      expect(rows.find(row=>row.window_id===12)).toMatchObject({raw_dur:-1,raw_end_ts:null,clipped_start_ts:35000000,
        clipped_end_ts:45000000,dur_ns:10000000,is_unfinished:1,right_censored:1});
      expect(rows.filter(row=>row.sched_id===1)).toHaveLength(1);
      expect(query(db,names[2],{start:40000000,end:45000000})).toHaveLength(0);
    } finally {db.close();}
  });
  it('keeps compatibility consumers on the same scoped half-open spans', () => {
    const db=fixture();
    try {
      for (const name of ['atomic/startup_critical_tasks','atomic/startup_cpu_placement_timeline','composite/startup_detail#cpu_core_analysis','composite/startup_detail#cpu_freq_analysis','composite/startup_detail#quadrant_analysis','composite/startup_detail#per_cpu_system_context','atomic/scheduling_analysis','atomic/sched_latency_in_range','atomic/main_thread_sched_latency_in_range',
        'atomic/task_migration_in_range#migration_analysis','modules/kernel/scheduler_module#runnable_analysis',
        'modules/kernel/scheduler_module#cpu_frequency','modules/kernel/scheduler_module#core_distribution',
        'composite/cpu_analysis#get_process','composite/cpu_analysis#core_type_stats','composite/cpu_analysis#thread_cpu_usage',
        'composite/cpu_analysis#main_thread_states','composite/cpu_analysis#runnable_latency','composite/cpu_analysis#main_thread_cores',
        'composite/cpu_analysis#blocked_functions','composite/cpu_analysis#cpu_frequency_distribution','composite/cpu_analysis#wakeup_chain',
        'composite/selection_range_cpu_sched_summary#running_thread_quadrants','composite/selection_range_cpu_sched_summary#running_process_ranking',
        'composite/selection_range_cpu_sched_summary#cpu_freq_by_core','composite/selection_range_cpu_sched_summary#cpu_freq_distribution']) {
        expect(()=>query(db,name)).not.toThrow();
      }
      const selection=query(db,'composite/selection_range_cpu_sched_summary#running_thread_quadrants');
      expect(selection).toHaveLength(2);
      expect(selection.find(row=>row.utid===2)).toMatchObject({total_cpu_ms:0,q4a_uninterruptible_ms:30,total_observed_threads:2});
      expect(selection.every(row=>!Object.prototype.hasOwnProperty.call(row,'q4a_io_blocked_ms'))).toBe(true);
      expect(query(db,'atomic/sched_latency_in_range')[0]).toMatchObject({utid:1,total_runnable_ms:15,runnable_preempted_ms:15});
      expect(query(db,'composite/cpu_analysis#core_type_stats').reduce((sum,row)=>sum+row.total_time_ms,0)).toBe(15);
    } finally {db.close();}
  });
  it('carries every raw evidence field through executor projection and artifact restoration', async () => {
    const db=fixture();
    try {
      for (const name of names) {
        const raw=query(db,name);const columns=Object.keys(raw[0]);
        const skill=load(name);
        const executor=createSkillExecutor({query:async()=>({columns,rows:raw.map(row=>columns.map(column=>row[column]))}),touchTrace:()=>undefined});
        executor.registerSkill(JSON.parse(JSON.stringify({...skill,identity:undefined,prerequisites:undefined,sql_fragments:undefined,process_scope:undefined,sql:'SELECT 1'})));
        executor.registerSkill({name:'delivery_'+name,version:'1.0',type:'composite',meta:{display_name:name,description:name},steps:[{id:'raw',type:'skill',skill:name,params:{start_ts:10000000,end_ts:40000000},display:skill.display}]} as any);
        const result=await executor.execute('delivery_'+name,'system-fixture',{});
        expect(result.error).toBeUndefined();expect(result.success).toBe(true);
        const display=result.displayResults[0].data as {columns:string[];rows:unknown[][]};
        expect(new Set(display.columns)).toEqual(new Set(columns));
        const store=new ArtifactStore();const id=store.store({skillId:name,stepId:'root',data:display});
        const restored=ArtifactStore.fromSnapshot(JSON.parse(JSON.stringify(store.serialize()))).fetch(id,'rows');
        expect(restored.columns).toEqual(display.columns);
        // fetch_artifact rows carry their artifact-wide index (rowShape indexed_rows@1).
        expect(restored.rows.map((row: {values: unknown[]}) => row.values)).toEqual(display.rows);
        expect(restored.rows.map((row: {rowIndex: number}) => row.rowIndex)).toEqual(display.rows.map((_: unknown, index: number) => index));
        expect(restored.rows).toHaveLength(raw.length);
      }
    } finally {db.close();}
  });
});
