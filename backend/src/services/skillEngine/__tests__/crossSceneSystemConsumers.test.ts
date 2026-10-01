// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import yaml from 'js-yaml';
import { SkillExecutor } from '../skillExecutor';
import { normalizeSkillDefinition } from '../skillLoader';
import { validateSkillInputs } from '../skillValidator';

function load(name: string, id: string): any {
  const skill = yaml.load(fs.readFileSync(path.join(process.cwd(), 'skills', name.startsWith('atomic/') ? '' : 'composite', `${name}.skill.yaml`), 'utf8')) as any;
  return id === 'root' ? skill : skill.steps.find((s: any) => s.id === id);
}

function query(db: Database.Database, name: string, id: string, extra: Record<string, string> = {}): any[] {
  const step = load(name, id);
  let sql = step.sql as string;
  for (const fragment of step.sql_fragments || []) {
    sql = sql.replace(/\bWITH\s+/i, `WITH ${fs.readFileSync(path.join(process.cwd(), 'skills', fragment), 'utf8')}\n,\n`);
  }
  const params: Record<string, string> = {
    start_ts: '10000000', end_ts: '40000000', main_start_ts: 'NULL', main_end_ts: 'NULL',
    render_start_ts: 'NULL', render_end_ts: 'NULL', event_ts: '10000000', event_end_ts: '40000000',
    anr_ts: '40000000', timeout_ns: '30000000', upid: '42', pid: '100',
    '__process_scope.upid': '42', package: 'com.example.app', process_name: 'com.example.app', ...extra,
  };
  sql = sql.replace(/\$\{([^}]+)\}/g, (_, key: string) => {
    const [name, fallback] = key.split('|');
    if (!(name in params) && fallback === undefined) throw new Error(`Unbound parameter ${key}`);
    return params[name] ?? fallback;
  });
  return db.prepare(sql).all();
}

function fixture(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE trace_bounds(start_ts INTEGER,end_ts INTEGER);
    INSERT INTO trace_bounds VALUES(0,50000000);
    CREATE TABLE process(upid INTEGER PRIMARY KEY,pid INTEGER,name TEXT);
    INSERT INTO process VALUES(42,100,'com.example.app'),(43,101,'com.example.app:remote');
    CREATE TABLE thread(utid INTEGER PRIMARY KEY,upid INTEGER,tid INTEGER,name TEXT,is_idle INTEGER);
    INSERT INTO thread VALUES(1,42,100,'main',0),(2,42,102,'RenderThread',0),(3,43,101,'remote',0),(0,NULL,0,'swapper',1);
    CREATE TABLE cpu(id INTEGER PRIMARY KEY,cpu INTEGER,machine_id INTEGER,cluster_id INTEGER,capacity INTEGER);
    INSERT INTO cpu VALUES(0,0,0,0,300),(1,1,0,1,700),(2,2,0,2,1024),(3,3,1,3,NULL);
    CREATE TABLE thread_state(id INTEGER PRIMARY KEY,utid INTEGER,ts INTEGER,dur INTEGER,state TEXT,cpu INTEGER,ucpu INTEGER,io_wait INTEGER,blocked_function TEXT,waker_utid INTEGER);
    INSERT INTO thread_state VALUES
      (1,1,5000000,10000000,'Running',1,1,NULL,NULL,NULL),
      (2,1,15000000,5000000,'R+',1,1,NULL,NULL,NULL),
      (3,1,20000000,5000000,'Running',3,3,NULL,NULL,NULL),
      (4,1,25000000,5000000,'DK',NULL,NULL,NULL,NULL,NULL),
      (5,1,30000000,-1,'S',NULL,NULL,NULL,NULL,NULL),
      (6,3,10000000,30000000,'Running',2,2,NULL,NULL,NULL),
      (7,2,10000000,30000000,'R',NULL,NULL,NULL,NULL,NULL);
    ALTER TABLE thread_state ADD COLUMN irq_context INTEGER;
    CREATE TABLE sched_slice(id INTEGER PRIMARY KEY,utid INTEGER,ts INTEGER,dur INTEGER,cpu INTEGER,ucpu INTEGER,end_state TEXT,priority INTEGER);
    INSERT INTO sched_slice VALUES(1,1,5000000,10000000,1,1,'R+',120),(2,1,20000000,5000000,3,3,'DK',90),(3,3,10000000,30000000,2,2,'S',120);
    CREATE TABLE cpu_frequency_counters(cpu INTEGER,ts INTEGER,dur INTEGER,freq INTEGER);
    INSERT INTO cpu_frequency_counters VALUES(2,0,20000000,1000000),(2,20000000,5000000,3000000),(2,25000000,15000000,2000000);
    ALTER TABLE cpu_frequency_counters ADD COLUMN id INTEGER;
    ALTER TABLE cpu_frequency_counters ADD COLUMN track_id INTEGER;
    ALTER TABLE cpu_frequency_counters ADD COLUMN ucpu INTEGER;
    UPDATE cpu_frequency_counters SET id=rowid,track_id=cpu,ucpu=cpu;
  `);
  return db;
}

describe('cross-scene canonical system consumers', () => {
  it.each([
    ['anr_detail', 'main_thread_quadrant'], ['click_response_detail', 'quadrant_analysis'],
  ])('%s clips states, keeps R+ and DK, and does not turn unknown topology into little', (name, id) => {
    const db = fixture();
    try {
      const rows = query(db, name, id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({upid: 42, utid: 1, q1_big_running_ms: 5, q2_little_running_ms: 0,
        unknown_running_ms: 5, q3_runnable_ms: 5, uninterruptible_ms: 5, interruptible_sleep_ms: 10,
        total_ms: 30, running_pct: 33.3, state_coverage_pct: 100});
    } finally { db.close(); }
  });

  it('retains unknown and pure waiting threads in session and individual-frame evidence', () => {
    const db = fixture();
    try {
      const session = query(db, 'scrolling_analysis', 'session_quadrant_summary');
      expect(session.find(r => r.utid === 1)).toMatchObject({q1_big_pct: 16.7, q2_little_pct: 0, q3_runnable_pct: 16.7, unknown_running_pct: 16.7, total_ms: 30});
      expect(session.find(r => r.utid === 2)).toMatchObject({q3_runnable_pct: 100, total_ms: 30});
      const deep = query(db, 'jank_frame_detail', 'quadrant_analysis');
      expect(deep.find(r => r.utid === 1 && r.quadrant.includes('Unknown'))).toMatchObject({dur_ms: 5, percentage: 16.7});
      expect(deep.find(r => r.utid === 2)).toMatchObject({dur_ms: 30, percentage: 100});
    } finally { db.close(); }
  });

  it.each([['scrolling_analysis', 'session_cpu_freq'], ['jank_frame_detail', 'cpu_freq_analysis']])('%s frequency uses residence time including the pre-window sample', (name, id) => {
    const db = fixture();
    try {
      expect(query(db, name, id)).toEqual([expect.objectContaining({core_type: 'big', avg_freq_mhz: 1833,
        min_freq_mhz: 1000, max_freq_mhz: 3000, frequency_covered_ns: 30000000, frequency_coverage_pct: 100})]);
      db.exec('INSERT INTO cpu VALUES(4,4,0,2,1024)');
      expect(query(db, name, id)[0]).toMatchObject({frequency_coverage_pct:50});
      db.exec('INSERT INTO cpu VALUES(9,2,1,0,1024)');
      // The pinned relation carries UCPU, so repeated per-machine CPU numbers
      // preserve the exact machine's reading rather than invalidating it.
      expect(query(db, name, id)[0]).toMatchObject({avg_freq_mhz:1833,frequency_coverage_pct:50});
      db.exec('UPDATE cpu_frequency_counters SET ucpu=NULL');
      expect(query(db, name, id)).toEqual([]); // Never guess a missing UCPU from its ordinal.
    } finally { db.close(); }
  });

  it('click placement keeps UPID, unknown capacity and kernel priority without inferring policy', () => {
    const db = fixture();
    try {
      expect(query(db, 'click_response_detail', 'cpu_core_analysis')).toEqual([expect.objectContaining({upid:42,utid:1,
        big_core_ms:5,little_core_ms:0,unknown_running_ms:5,total_running_ms:10,priority_min:90,priority_max:120,
        scheduling_policy_evidence:'not_recorded_in_sched_slice'})]);
    } finally { db.close(); }
  });

  it('reports selection performance-core percentage only with complete running topology', () => {
    const db = fixture();
    try {
      const selection = () => query(db, 'selection_range_cpu_sched_summary', 'running_thread_quadrants')
        .find(row => row.utid === 1);
      const partial = selection();
      expect(partial).toMatchObject({unknown_running_ms: 5, perf_core_pct: null,
        q4a_uninterruptible_ms: 5});
      expect(partial).not.toHaveProperty('q4a_io_blocked_ms');

      db.exec('UPDATE thread_state SET dur=1 WHERE id=3');
      expect(selection()).toMatchObject({unknown_running_ms: 0.000001, perf_core_pct: null});

      db.exec('UPDATE thread_state SET dur=5000000,cpu=0,ucpu=0 WHERE id=3');
      expect(selection()).toMatchObject({unknown_running_ms: 0, perf_core_pct: 50});

      db.exec('UPDATE thread_state SET cpu=0,ucpu=0 WHERE id=1');
      expect(selection()).toMatchObject({unknown_running_ms: 0, perf_core_pct: 0});
    } finally { db.close(); }
  });

  it.each([[5000000,10000000],[35000000,10000000],[35000000,-1]])('clips deep IO and Runnable metrics for ts=%i dur=%i without inventing event endpoints', (ts, dur) => {
    const db = fixture();
    try {
      db.exec('DELETE FROM thread_state WHERE utid=1');
      db.prepare("INSERT INTO thread_state(id,utid,ts,dur,state,cpu,ucpu,io_wait,blocked_function) VALUES(50,1,?,?,'D',NULL,NULL,1,'filemap_fault')").run(ts,dur);
      const io = query(db, 'jank_frame_detail', 'io_blocking');
      expect(io).toEqual([expect.objectContaining({upid:42,utid:1,total_ms:5,max_ms:5,blocked_count:1,
        raw_max_wait_ms:dur === -1 ? null : 10,unfinished_wait_count:dur === -1 ? 1 : 0})]);
      const source = String(load('jank_frame_detail', 'root_cause_summary').sql);
      const ctes = source.slice(source.indexOf('system_target_threads AS ('),source.indexOf('-- 8. GPU Fence')).trim().replace(/,\s*$/, '');
      const fragment = fs.readFileSync(path.join(process.cwd(),'skills/fragments/system_thread_state_spans.sql'),'utf8');
      const sql = `WITH system_windows(window_id,window_start_ts,window_end_ts) AS (VALUES('frame',10000000,40000000)),
        target_threads(utid,thread_type) AS (VALUES(1,'MainThread')), ${fragment}, ${ctes}
        SELECT * FROM io_block CROSS JOIN sched_latency`;
      expect(db.prepare(sql).get()).toMatchObject({io_block_ms:5,max_sched_ms:0,total_sched_ms:0});
      db.exec("UPDATE thread_state SET state='R+' WHERE id=50");
      expect(db.prepare(sql).get()).toMatchObject({io_block_ms:0,max_sched_ms:5,total_sched_ms:5});
    } finally { db.close(); }
  });

  it('ANR wakeup counts native successor events while unfinished waits retain only clipped occupancy', () => {
    const db = fixture();
    try {
      db.exec(`DELETE FROM thread_state WHERE utid=1;
        INSERT INTO thread_state(id,utid,ts,dur,state,blocked_function,waker_utid) VALUES
          (50,1,5000000,15000000,'S','futex_wait',NULL),
          (51,1,20000000,5000000,'R',NULL,3),
          (52,1,35000000,-1,'DK','filemap_fault',NULL);`);
      const rows = query(db,'anr_detail','wakeup_chain');
      expect(rows).toEqual([
        expect.objectContaining({upid:42,utid:1,waker_thread:'remote',waker_process:'com.example.app:remote',
          wakeup_count:1,wait_span_count:1,total_sleep_ms:10,raw_max_sleep_ms:15,left_censored_wait_count:1}),
        expect.objectContaining({upid:42,utid:1,waker_thread:'unknown',waker_process:'unknown',
          wakeup_count:0,wait_span_count:1,total_sleep_ms:5,raw_max_sleep_ms:null,unfinished_wait_count:1}),
      ]);
    } finally { db.close(); }
  });

  it.each([{}, {process_name:''}])('admits anchorless ANR discovery through the production identity gate: %j', async params => {
    const file = path.join(process.cwd(),'skills/atomic/anr_main_thread_blocking.skill.yaml');
    const skill = normalizeSkillDefinition(yaml.load(fs.readFileSync(file,'utf8')),file)!;
    const query = jest.fn();
    const executor = new SkillExecutor({query});
    executor.registerSkills([skill]);
    const validated = validateSkillInputs(skill.name,skill.inputs,params);
    expect(validated.errors).toEqual([]);
    expect(validated.params.process_name).toBe('');
    const admission = await executor.prepareInvocation(skill.name,'trace',validated.params);
    expect(admission.allowed).toBe(true);
    expect(admission.processScope?.mode).toBe('unscoped');
    expect(query).not.toHaveBeenCalled();
  });

  it('discovers anchorless app waits without declaring idle sleep a freeze', () => {
    const db = fixture();
    try {
      db.exec(`ALTER TABLE process ADD COLUMN uid INTEGER;
        UPDATE process SET uid=10123;
        UPDATE trace_bounds SET end_ts=40000000000;
        INSERT INTO process VALUES(44,103,'kernel.worker',1000),(45,104,'com.example.app',10123);
        INSERT INTO thread VALUES(4,44,103,'worker',0),(5,45,104,'main',0);
        DELETE FROM thread_state;
        INSERT INTO thread_state(id,utid,ts,dur,state,blocked_function) VALUES
          (80,1,1000000000,13600000000,'S',NULL),
          (81,1,16000000000,5000000000,'S','futex_wait'),
          (82,3,2000000000,4000000000,'D','io_schedule'),
          (83,4,0,39000000000,'S',NULL),
          (84,5,35000000000,-1,'DK',NULL),
          (85,1,25000000000,-1,'S',NULL);`);
      const params = {process_name:'',upid:'NULL',start_ts:'NULL',end_ts:'NULL',anr_ts:'NULL'};
      const rows = query(db,'atomic/anr_main_thread_blocking','wakeup_chain',params);
      expect(rows.map(row=>row.thread_state_id)).toEqual([85,80,84,82]);
      expect(rows[1]).toMatchObject({upid:42,utid:1,sleep_dur_ms:13600,blocked_function:null,
        candidate_status:'observed_wait_not_proven_unresponsiveness',waker_utid:null,
        raw_start_ts:'1000000000',raw_end_ts:'14600000000'});
      expect(rows[2]).toMatchObject({upid:45,is_unfinished:1,right_censored:1,raw_end_ts:null});
      expect(query(db,'atomic/anr_main_thread_blocking','wakeup_chain',{...params,top_n:'1',offset:'2'})[0].upid).toBe(45);
      expect(query(db,'atomic/anr_main_thread_blocking','wakeup_chain',{...params,upid:'42',
        process_name:'com.example.app',start_ts:'2000000000',end_ts:'15000000000'})[0])
        .toMatchObject({upid:42,start_ts:'2000000000',end_ts:'14600000000',sleep_dur_ms:12600,left_censored:1});
      expect(query(db,'atomic/anr_main_thread_blocking','wakeup_chain',{...params,min_wait_ms:'20000'})).toEqual([]);
      const input = (yaml.load(fs.readFileSync(path.join(process.cwd(),'skills/atomic/anr_main_thread_blocking.skill.yaml'),'utf8')) as any)
        .inputs.find((entry: any)=>entry.name==='process_name');
      expect(input).toMatchObject({required:false,default:''});
      // Empty target must not select an arbitrary process in the legacy detail.
      db.exec('ALTER TABLE thread ADD COLUMN is_main_thread INTEGER');
      expect(query(db,'atomic/anr_main_thread_blocking','main_thread_state',params)).toEqual([]);
    } finally { db.close(); }
  });

  it.each([
    ['atomic/startup_thread_blocking_graph', 'root'],
    ['atomic/anr_main_thread_blocking', 'wakeup_chain'],
  ])('%s keeps native wait/wakeup identity and clipping without inventing blockers', (name, step) => {
    const db = fixture();
    try {
      db.exec(`ALTER TABLE process ADD COLUMN uid INTEGER;
        CREATE TABLE thread_track(id INTEGER PRIMARY KEY,utid INTEGER);
        CREATE TABLE slice(id INTEGER PRIMARY KEY,track_id INTEGER,ts INTEGER,dur INTEGER,depth INTEGER,name TEXT);
        INSERT INTO thread_track VALUES(1,3);
        INSERT INTO slice VALUES(1,1,10000000,15000000,0,'outer'),(2,1,20000000,2000000,1,'actual_task'),
          (3,1,18000000,2000000,2,'ends_at_wakeup');
        INSERT INTO process VALUES(44,103,'com.example.app:remote',10123);
        INSERT INTO thread VALUES(4,44,103,'remote',0),(5,42,104,'same_name',0),(6,42,105,'same_name',0);
        DELETE FROM thread_state;
        INSERT INTO thread_state(id,utid,ts,dur,state,blocked_function,waker_utid,irq_context) VALUES
          (50,1,5000000,15000000,'S','futex_wait',4,NULL),
          (51,1,20000000,1000000,'R',NULL,3,0),
          (52,1,21000000,3000000,'D','io_schedule',NULL,NULL),
          (53,1,24000000,1000000,'R',NULL,4,1),
          (54,1,25000000,3000000,'S',NULL,NULL,NULL),
          (55,1,28000000,1000000,'R',NULL,NULL,NULL),
          (56,1,30000000,5000000,'S',NULL,NULL,NULL),
          (57,1,35000000,1000000,'R',NULL,3,0),
          (58,1,35000000,1000000,'R',NULL,4,0),
          (59,1,36000000,-1,'DK',NULL,4,NULL),
          (60,3,30000000,15000000,'S',NULL,NULL,NULL),
          (61,3,45000000,1000000,'R',NULL,1,0),
          (62,4,10000000,5000000,'S',NULL,NULL,NULL),
          (63,4,15000000,1000000,'R',NULL,3,0),
          (64,5,10000000,5000000,'S',NULL,NULL,NULL),
          (65,6,10000000,5000000,'S',NULL,NULL,NULL);`);
      const rows = query(db,name,step);
      const wait = (id: number) => rows.find(row=>row.thread_state_id===id);
      expect(wait(50)).toMatchObject({upid:42,utid:1,raw_start_ts:'5000000',raw_end_ts:'20000000',
        start_ts:'10000000',end_ts:'20000000',left_censored:1,right_censored:0,is_unfinished:0,
        wakeup_state_id:51,observed_waker_utid:3,waker_utid:3,waker_upid:43,wakeup_count:1,
        wakeup_status:'observed_thread',relation_status:'observed_wakeup_not_proven_blocking_cause'});
      expect(wait(52)).toMatchObject({observed_waker_utid:4,irq_context:1,waker_utid:null,waker_upid:null,
        wakeup_status:'observed_irq',wakeup_count:1});
      expect(wait(54)).toMatchObject({wakeup_status:'successor_without_wake_metadata',wakeup_count:0,waker_utid:null});
      expect(wait(56)).toMatchObject({wakeup_status:'ambiguous_successor',wakeup_count:0,wakeup_state_id:null});
      expect(wait(59)).toMatchObject({raw_end_ts:null,end_ts:'40000000',is_unfinished:1,right_censored:1,
        wakeup_status:'no_in_window_wakeup',wakeup_count:0,waker_utid:null});
      expect(wait(60)).toMatchObject({upid:43,utid:3,raw_end_ts:'45000000',end_ts:'40000000',right_censored:1,
        wakeup_status:'no_in_window_wakeup',wakeup_count:0});
      expect(wait(62)).toMatchObject({upid:44,utid:4,waker_utid:3,wakeup_count:1});
      if (name.includes('startup')) {
        expect(wait(50)).toMatchObject({total_block_ms:10,max_block_ms:10,avg_block_ms:10,block_count:1,
          waker_current_slice:'actual_task',waker_slice_id:2,waker_slice_status:'observed_unique_deepest'});
        expect(wait(52)).toMatchObject({waker_current_slice:'-',waker_slice_status:'not_observed'});
        expect(wait(59).total_block_ms).toBe(4);
        expect(wait(64).utid).not.toBe(wait(65).utid);
        db.exec("INSERT INTO slice VALUES(4,1,20000000,3000000,1,'ambiguous_task')");
        expect(query(db,name,step).find(row=>row.thread_state_id===50)).toMatchObject({
          waker_current_slice:'-',waker_slice_id:null,waker_slice_status:'ambiguous_deepest'});
      } else {
        expect(wait(50)).toMatchObject({ts:'20000000',sleep_dur_ms:10,wait_span_count:1});
        expect(wait(59)).toMatchObject({ts:null,sleep_dur_ms:4});
      }
      expect(query(db,name,step,{end_ts:'20000000'}).find(row=>row.thread_state_id===50))
        .toMatchObject({wakeup_count:0,wakeup_status:'no_in_window_wakeup',end_ts:'20000000'});
      expect(query(db,name,step,{end_ts:'60000000'}).find(row=>row.thread_state_id===59))
        .toMatchObject({end_ts:'50000000',is_unfinished:1,wakeup_count:0});
      const declared = new Set(load(name,step).display.columns.map((column: any)=>column.name));
      for (const field of Object.keys(rows[0])) expect(declared.has(field)).toBe(true);
    } finally { db.close(); }
  });

  it('startup migration compares native CPU identities and never derives cluster identity from core type', () => {
    const db = fixture();
    try {
      // One CPU's ordinal differs from UCPU. Two other CPUs share a recorded
      // cluster but have distinct capacities; capacity labels are not clusters.
      db.exec(`UPDATE cpu SET cpu=7 WHERE id=1;
        UPDATE cpu SET cluster_id=1 WHERE id=2;
        DELETE FROM sched_slice WHERE utid=1;
        INSERT INTO sched_slice VALUES
          (10,1,5000000,10000000,7,1,'S',120),
          (11,1,16000000,2000000,7,1,'S',120),
          (12,1,20000000,2000000,2,2,'S',120),
          (13,1,25000000,2000000,0,0,'S',120);`);
      const source = yaml.load(fs.readFileSync(path.join(process.cwd(),'skills/atomic/startup_critical_tasks.skill.yaml'),'utf8')) as any;
      let sql = source.sql as string;
      for (const fragment of source.sql_fragments) sql=sql.replace(/\bWITH\s+/i,`WITH ${fs.readFileSync(path.join(process.cwd(),'skills',fragment),'utf8')},\n`);
      const params: Record<string,string>={start_ts:'10000000',end_ts:'40000000','__process_scope.upid':'42',package:'com.example.app','top_k|15':'15'};
      sql=sql.replace(/\$\{([^}]+)\}/g,(_,key:string)=>params[key]);
      expect((db.prepare(sql).all() as any[]).find(r=>r.utid===1)).toMatchObject({migrations:2,cross_cluster_migrations:1,unknown_cluster_migrations:0});
      db.exec('UPDATE cpu SET cluster_id=NULL WHERE id=0');
      expect((db.prepare(sql).all() as any[]).find(r=>r.utid===1)).toMatchObject({migrations:2,cross_cluster_migrations:null,observed_cross_cluster_migrations:0,unknown_cluster_migrations:1,migration_evidence:'partial_cluster_identity'});
    } finally { db.close(); }
  });

  it('frequency event views preserve source times and isolate repeated CPU ordinals by native UCPU', () => {
    const db = fixture();
    try {
      db.exec(`INSERT INTO cpu VALUES(9,2,1,0,1024);
        INSERT INTO cpu_frequency_counters VALUES(2,22000000,8000000,9000000,4,9,9);`);
      const events = query(db, 'jank_frame_detail', 'cpu_freq_timeline');
      expect(events).toEqual([
        expect.objectContaining({ts:'20000000',ucpu:2,counter_id:2,freq_mhz:3000,prev_freq_mhz:1000,change_direction:'up'}),
        expect.objectContaining({ts:'22000000',ucpu:9,counter_id:4,core_type:'unknown',freq_mhz:9000,prev_freq_mhz:null,change_direction:'unknown'}),
        expect.objectContaining({ts:'25000000',ucpu:2,counter_id:3,freq_mhz:2000,prev_freq_mhz:3000,change_direction:'down'}),
      ]);
      const source = String(load('scrolling_analysis', 'batch_frame_root_cause').sql);
      const ctes = source.slice(source.indexOf('frame_frequency_events AS ('), source.indexOf('-- 10c.')).trim().replace(/,\s*$/, '');
      const fragments = ['system_sched_spans.sql','system_cpu_frequency_spans.sql']
        .map(file => fs.readFileSync(path.join(process.cwd(),'skills/fragments',file),'utf8')).join(',\n');
      const rows = db.prepare(`WITH system_windows(window_id,window_start_ts,window_end_ts) AS
        (VALUES('wide',10000000,40000000),('narrow',22000000,24000000)), ${fragments}, ${ctes}
        SELECT * FROM per_frame_freq_changes ORDER BY frame_key`).all() as any[];
      expect(JSON.parse(rows[0].freq_timeline_json)).toEqual([expect.objectContaining({source_ts:22000000,ucpu:9,counter_id:4,change:'unknown'})]);
      expect(JSON.parse(rows[1].freq_timeline_json)).toHaveLength(3);
    } finally { db.close(); }
  });

  it('session batch executes the maintained query and preserves task identity and clipped denominators', () => {
    const db = fixture();
    try {
      db.aggregate<number[]>('PERCENTILE', {varargs: true, start: () => [],
        step: (values, value) => typeof value === 'number' ? [...values, value] : values,
        result: () => null});
      db.exec(`
        UPDATE trace_bounds SET end_ts=300000000;
        CREATE TABLE counter(ts INTEGER,track_id INTEGER,value INTEGER);
        CREATE TABLE counter_track(id INTEGER,name TEXT);
        CREATE TABLE actual_frame_timeline_slice(ts INTEGER,dur INTEGER,upid INTEGER,display_frame_token INTEGER,surface_frame_token INTEGER);
      `);
      const insert = db.prepare('INSERT INTO actual_frame_timeline_slice VALUES(?,15000000,42,?,?)');
      for (let i = 0; i < 12; i++) insert.run(5000000 + i * 25000000, i, i);
      const rows = query(db, 'scrolling_analysis', 'session_stats_batch', {start_ts:'0',end_ts:'300000000'});
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({upid:42,session_id:1,start_ts:'5000000'});
      const quadrants = JSON.parse(rows[0].quadrant_json);
      expect(quadrants).toContainEqual(expect.objectContaining({upid:42,utid:1,total_ms:290,unknown_running_ms:5}));
      expect(quadrants).toContainEqual(expect.objectContaining({upid:42,utid:2,q3_runnable_pct:100,total_ms:30}));
      const affinity = JSON.parse(rows[0].core_affinity_json);
      expect(affinity).toContainEqual(expect.objectContaining({upid:42,utid:1,core_type:'unknown',run_ms:5}));
      expect(affinity.some((r: any) => r.upid !== 42)).toBe(false);
    } finally { db.close(); }
  });

  it('ANR CPU health excludes observed idle and reports partial scheduler coverage', () => {
    const db = fixture();
    try {
      db.exec("INSERT INTO sched_slice VALUES(20,0,10000000,30000000,0,0,'S',120)");
      const rows = query(db, 'anr_analysis', 'system_cpu_health', {
        'anr_ctx.data[0].anr_ts':'40000000','anr_ctx.data[0].timeout_ns':'30000000',
      });
      expect(rows.find(r => r.core_type === 'little')).toMatchObject({total_active_ms:0,avg_util_pct:0,status:'normal',sched_covered_ns:30000000});
      expect(rows.find(r => r.core_type === 'medium')).toMatchObject({total_active_ms:5,status:'insufficient_coverage'});
    } finally { db.close(); }
  });

  it('a frequency decline cannot establish thermal throttling in scrolling context', () => {
    const db = fixture();
    try {
      db.exec(`
        UPDATE trace_bounds SET end_ts=10000000000;
        INSERT INTO cpu_frequency_counters VALUES(2,9000000000,1000000000,500000,4,2,2);
        CREATE TABLE thread_track(id INTEGER,utid INTEGER);
        CREATE TABLE slice(track_id INTEGER,ts INTEGER,dur INTEGER,name TEXT);
        CREATE TABLE actual_frame_timeline_slice(ts INTEGER,upid INTEGER,display_frame_token INTEGER);
        CREATE TABLE cpu_counter_track(id INTEGER,cpu INTEGER,type TEXT,name TEXT);
        CREATE TABLE counter_track(id INTEGER,type TEXT,name TEXT,dimension_arg_set_id INTEGER);
        CREATE TABLE counter(id INTEGER,track_id INTEGER,ts INTEGER,value REAL);
        CREATE TABLE args(arg_set_id INTEGER,key TEXT,string_value TEXT);
      `);
      // The decline stays an observation; with no max-limit track the only
      // frequency-limit statement is that the evidence is missing.
      expect(query(db, 'scrolling_analysis', 'global_context_flags', {start_ts:'0',end_ts:'10000000000'}))
        .toEqual([expect.objectContaining({frequency_decline_observed:1,thermal_trending:null,
          thermal_evidence:'LIMIT_EVIDENCE_MISSING',freq_limit_classification:'LIMIT_EVIDENCE_MISSING',
          freq_limit_trace_summary:'LIMIT_EVIDENCE_MISSING'})]);
    } finally { db.close(); }
  });

  it('batch and session consumers share the canonical relation instead of invoking primitives per frame', () => {
    for (const id of ['session_stats_batch','batch_frame_root_cause','session_quadrant_summary']) {
      const step = load('scrolling_analysis', id);
      expect(step.type).toBe('atomic');
      expect(step.sql_fragments).toContain('fragments/system_thread_state_spans.sql');
      expect(step.sql).toContain('system_windows AS');
      expect(step.sql).toContain('system_target_threads AS');
      expect(step.sql).not.toContain("state = 'R'");
      expect(step.sql).not.toContain("core_type NOT IN ('prime', 'big')");
    }
  });
});

// Totals a diagnosis cites are computed in SQL: the portable runtime that also
// renders these templates has no rounding or ternary.
describe('SQL-computed values cited by diagnostic templates', () => {
  it('jank GC total sums the per-type overlaps as displayed, so rounding cannot cross the threshold', () => {
    const db = fixture();
    try {
      // Two GC types each overlap the 10-40ms window by 1.504ms: 1.5 + 1.5, not round(3.008).
      db.exec(`CREATE TABLE android_garbage_collection_events(tid INTEGER,upid INTEGER,gc_type TEXT,gc_ts INTEGER,gc_dur INTEGER);
        INSERT INTO android_garbage_collection_events VALUES
          (100,42,'young',38496000,2000000),(100,42,'full',9000000,2504000),
          (101,43,'young',20000000,5000000),(100,42,'young',45000000,1000000);`);
      const rows = query(db, 'jank_frame_detail', 'gc_in_frame');
      expect(rows).toEqual([
        expect.objectContaining({gc_type: expect.any(String), overlap_ms: 1.5, total_overlap_ms: 3}),
        expect.objectContaining({gc_type: expect.any(String), overlap_ms: 1.5, total_overlap_ms: 3}),
      ]);
    } finally { db.close(); }
  });

  it('startup critical tasks total only the threads it returns, after the top_k cut', () => {
    const db = fixture();
    try {
      db.exec(`INSERT INTO thread_state VALUES(8,2,10000000,3000000,'Running',1,1,NULL,NULL,NULL,NULL);`);
      const all = query(db, 'atomic/startup_critical_tasks', 'root');
      expect(all.map(row => row.utid)).toEqual([1, 2]);
      expect(all.map(row => row.returned_total_cpu_ms)).toEqual([13, 13]);
      const top = query(db, 'atomic/startup_critical_tasks', 'root', {top_k: '1'});
      expect(top).toEqual([expect.objectContaining({utid: 1, total_cpu_ms: 10, returned_total_cpu_ms: 10, total_observed_threads: 2})]);
    } finally { db.close(); }
  });

  it('ANR context gives the exact integer window start of its decimal-string timestamps', () => {
    const db = fixture();
    try {
      db.exec(`CREATE TABLE android_anrs(ts INTEGER,process_name TEXT,pid INTEGER,upid INTEGER,anr_type TEXT,error_id TEXT,default_anr_dur_ms INTEGER,anr_dur_ms INTEGER);
        INSERT INTO android_anrs VALUES(9007199254742101,'com.example.app',100,42,'INPUT_DISPATCHING_TIMEOUT','e1',5000,0);`);
      const rows = query(db, 'atomic/anr_context_in_range', 'root', {anr_type: ''});
      expect(rows).toEqual([expect.objectContaining({
        anr_ts: '9007199254742101', timeout_ns: '5000000000', window_start_ts: '9007194254742101'})]);
    } finally { db.close(); }
  });
});
