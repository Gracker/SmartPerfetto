// SPDX-License-Identifier: AGPL-3.0-or-later
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import yaml from 'js-yaml';
import {androidInputEventsTableDdl} from '../helpers/androidInputEventsFixture';
import {withStepFragments} from '../helpers/skillFragmentSql';
const skills = new Map(['scene_reconstruction', 'state_timeline'].map(name => [name,
  yaml.load(fs.readFileSync(path.join(process.cwd(), 'skills/composite', `${name}.skill.yaml`), 'utf8')) as any]));
function query(db: Database.Database, id: string, skill = 'scene_reconstruction', limit = 4096, start = 'NULL', end = 'NULL'): any[] {
  const step = skills.get(skill).steps.find((item: any) => item.id === id);
  const sql = withStepFragments(step.sql.replace(/\$\{scene_row_limit\|4096\}/g, String(limit)), step.sql_fragments)
    .replace(/\$\{start_ts\}/g, start).replace(/\$\{end_ts\}/g, end);
  return db.prepare(sql).all();
}
function fixture(start = 0n, end = 10000000000n): Database.Database {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE trace_bounds(start_ts INTEGER, end_ts INTEGER);
    CREATE TABLE android_motion_events(id INTEGER, event_id INTEGER, ts INTEGER, action INTEGER, device_id INTEGER, display_id INTEGER, source INTEGER);
    CREATE TABLE android_key_events(id INTEGER, event_id INTEGER, ts INTEGER, action INTEGER, device_id INTEGER, display_id INTEGER, source INTEGER);
    ${androidInputEventsTableDdl()}
    CREATE TABLE android_screen_state(id INTEGER, ts INTEGER, dur INTEGER, simple_screen_state TEXT, short_screen_state TEXT, screen_state TEXT);
    CREATE TABLE slice(id INTEGER, ts INTEGER, dur INTEGER, name TEXT, track_id INTEGER);
    CREATE TABLE thread_track(id INTEGER, utid INTEGER); CREATE TABLE thread(utid INTEGER, upid INTEGER, is_main_thread INTEGER);
    CREATE TABLE process(upid INTEGER, name TEXT);
    CREATE TABLE actual_frame_timeline_slice(ts INTEGER, dur INTEGER, upid INTEGER, surface_frame_token INTEGER);`);
  db.prepare('INSERT INTO trace_bounds VALUES (?, ?)').run(start, end); return db;
}
function legacy(db: Database.Database, time: bigint, action: string | null, channel = 'A', upid = 1, processName = `app-${upid}`): void {
  db.prepare(`INSERT INTO android_input_events(input_event_id, event_seq, event_channel, dispatch_ts, receive_ts,
    read_time, event_type, event_action, upid, process_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(String(time), String(time), channel, time, time, time, 'MOTION', action, upid, processName);
}
function native(db: Database.Database, id: number, ts: bigint, action: number, device = 1, display = 0, source = 4098): void {
  db.prepare('INSERT INTO android_motion_events VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, id, ts, action, device, display, source);
}
describe('shared scene input facts: independent semantic cases', () => {
  let db: Database.Database; afterEach(() => db?.close());
  it('preserves movement without asserting scrolling, and excludes the entire span from gaps', () => {
    db = fixture(); ['DOWN','MOVE','MOVE','MOVE','UP'].forEach((a,i) => legacy(db, BigInt(i+1)*100000000n,a));
    const contacts = query(db,'user_gestures');
    expect(contacts).toEqual([expect.objectContaining({gesture_type:'touch_move',dur:'400000000',event_count:5,boundary_complete:1})]);
    for (const gap of query(db,'idle_periods')) for (const contact of contacts) {
      expect(BigInt(gap.ts) < BigInt(contact.ts)+BigInt(contact.dur) && BigInt(contact.ts) < BigInt(gap.ts)+BigInt(gap.dur)).toBe(false);
      expect(gap).toMatchObject({category:'unknown',source_status:'partial'});
    }
    expect(query(db,'scroll_initiation')).toEqual([]);
  });
  it('reads prefixed runtime actions (ACTION_MOVE) as the same contract actions (MOVE)', () => {
    const gestures = (actions: string[]) => {
      db = fixture(); actions.forEach((a,i) => legacy(db, BigInt(i+1)*100000000n,a));
      const rows = query(db,'user_gestures'); db.close(); return rows;
    };
    const prefixed = gestures(['ACTION_DOWN','ACTION_MOVE','ACTION_MOVE','ACTION_UP']);
    expect(prefixed).toEqual([expect.objectContaining({gesture_type:'touch_move',event_count:4,boundary_complete:1,source_status:'observed'})]);
    expect(prefixed).toEqual(gestures(['DOWN','MOVE','MOVE','UP']));
  });
  it('retains 55 action-less MOTION rows and never calls them idle', () => {
    db=fixture(); for(let i=1;i<=55;i++) legacy(db,BigInt(i)*1000000n,null);
    expect(query(db,'user_gestures')[0]).toMatchObject({gesture_type:'input_unknown',event_count:55,missing_action_count:55,source_status:'partial'});
    const rows=query(db,'input_state_lane_frames','state_timeline');
    expect(rows.some(r=>r.state==='INPUT_UNKNOWN'&&r.event_count===55)).toBe(true);
    expect(rows.some(r=>r.state==='IDLE')).toBe(false);
    expect(query(db,'input_coverage')[0]).toMatchObject({observed_event_count:55,missing_action_count:55});
  });
  it('does not extend past UP or infer fling from other app frames', () => {
    db=fixture(); ['DOWN','MOVE','MOVE','MOVE','UP'].forEach((a,i)=>legacy(db,BigInt(i+1),a));
    db.exec('INSERT INTO actual_frame_timeline_slice VALUES(6,8000000000,9,100)');
    expect(query(db,'user_gestures')[0].dur).toBe('4'); expect(query(db,'inertial_scrolls')).toEqual([]);
    expect(query(db,'input_state_lane_frames','state_timeline').some(r=>r.state==='FLING')).toBe(false);
  });
  it('never labels CANCEL as tap',()=>{
    db=fixture(); legacy(db,1n,'DOWN');legacy(db,9n,'CANCEL');
    expect(query(db,'user_gestures')[0]).toMatchObject({gesture_type:'cancelled',boundary_complete:0});
  });
  it('isolates windows and process incarnations',()=>{
    db=fixture();legacy(db,1n,'DOWN','A',1);legacy(db,2n,'DOWN','B',1);legacy(db,3n,'DOWN','A',2);
    legacy(db,4n,'UP','A',1);legacy(db,5n,'UP','B',1);legacy(db,6n,'UP','A',2);
    expect(query(db,'user_gestures').map(r=>[r.stream_key,r.ts,r.dur])).toEqual([['1:A','1','3'],['1:B','2','3'],['2:A','3','3']]);
  });
  it('isolates native devices and preserves POINTER_DOWN/UP within one contact',()=>{
    db=fixture(); native(db,1,1n,0,1);native(db,2,2n,0,2);native(db,3,3n,5,1);native(db,4,4n,6,1);native(db,5,5n,1,1);native(db,6,6n,1,2);
    const rows=query(db,'user_gestures');expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({device_id:1,event_count:4,gesture_type:'input_unknown'});expect(rows[1]).toMatchObject({device_id:2,event_count:2,gesture_type:'tap'});
  });
  it('deduplicates repeated acknowledged rows',()=>{
    db=fixture();legacy(db,1n,'DOWN');legacy(db,1n,'DOWN');legacy(db,2n,'UP');legacy(db,2n,'UP');
    expect(query(db,'user_gestures')).toEqual([expect.objectContaining({event_count:2,gesture_type:'tap'})]);
  });
  it('normalizes physical input once across monitor deliveries without losing raw coverage',()=>{
    db=fixture();
    for(const [time, action] of [[1n,'DOWN'],[2n,null],[3n,'MOVE'],[4n,'UP']] as const){
      legacy(db,time,action,'app',1);legacy(db,time,null,'monitor-A',2);legacy(db,time,null,'monitor-B',2);
    }
    expect(query(db,'user_gestures')).toEqual([expect.objectContaining({gesture_type:'touch_move',event_count:4,dispatch_count:12,receiver_count:1,upid:1,source_status:'partial',end_ts:'4'})]);
    expect(query(db,'input_coverage')[0]).toMatchObject({observed_event_count:12,physical_event_count:4});
  });
  it('does not assign a multiply received physical gesture to an arbitrary app',()=>{
    db=fixture();
    for(const [time,action] of [[1n,'DOWN'],[2n,'UP']] as const){legacy(db,time,action,'A',1);legacy(db,time,action,'B',2);}
    expect(query(db,'user_gestures')).toEqual([expect.objectContaining({gesture_type:'tap',event_count:2,dispatch_count:4,receiver_count:2,upid:null,app_package:null,identity_status:'multiple_recipients',source_status:'partial'})]);
  });
  it('preserves one nanosecond beyond 2^53 and full trace bounds',()=>{
    const start=9007199254740993n;db=fixture(start,start+100n);legacy(db,start+1n,'DOWN');legacy(db,start+2n,'UP');
    expect(query(db,'user_gestures')[0]).toMatchObject({ts:'9007199254740994',dur:'1'});
    expect(query(db,'trace_time_range')[0]).toMatchObject({start_ts:String(start),end_ts:String(start+100n)});
  });
  it('reports truncated output and counts an unreturned tail beyond 200 scenes',()=>{
    db=fixture();for(let i=0;i<220;i++){legacy(db,BigInt(i*10+1),'DOWN');legacy(db,BigInt(i*10+2),'UP');}
    const rows=query(db,'user_gestures','scene_reconstruction',80);expect(rows).toHaveLength(80);expect(rows[0].total_rows).toBe(220);
    expect(query(db,'input_coverage','scene_reconstruction',80)[0]).toMatchObject({gesture_count:220,output_truncated:1,output_row_limit:80});
    expect(query(db,'user_gestures')).toHaveLength(220);
  });
  it('does not turn contact duration into recognized long-press, and preserves open contacts',()=>{
    db=fixture();legacy(db,1n,'DOWN');legacy(db,600000001n,'UP');legacy(db,900000000n,'DOWN');
    expect(query(db,'user_gestures')).toEqual([expect.objectContaining({gesture_type:'touch_hold',source_status:'observed'}),expect.objectContaining({gesture_type:'input_unknown',source_status:'partial',dur:'0'})]);
  });
  it('shares exact input facts and boundaries across both lane paths',()=>{
    db=fixture();legacy(db,1n,'DOWN');legacy(db,500n,'UP');const scenes=query(db,'user_gestures');
    for(const id of ['input_state_lane_frames','input_state_lane_fallback']){
      expect(query(db,id,'state_timeline').filter(r=>r.state!=='UNKNOWN').map(r=>[r.start_ts,r.dur_ns,r.stream_key])).toEqual(scenes.map(r=>[r.ts,r.dur,r.stream_key]));
    }
  });
  it('maps textual on/off/AoD and leaves leading unsampled time unknown',()=>{
    db=fixture(0n,100n);db.exec("INSERT INTO android_screen_state VALUES(1,10,20,'on','on','Screen on'),(2,30,20,'off','off','Screen off'),(3,50,50,'doze','doze-suspend','Always-on display (doze-suspend)')");
    expect(query(db,'screen_state_changes').map(r=>r.state)).toEqual(['SCREEN_ON','SCREEN_OFF','SCREEN_DOZE']);
    expect(query(db,'device_state_lane','state_timeline').map(r=>[r.state,r.start_ts,r.end_ts])).toEqual([['UNKNOWN','0','10'],['SCREEN_ON','10','30'],['SCREEN_OFF','30','50'],['SCREEN_DOZE','50','100']]);
  });
  it('distinguishes dur=0 instant from dur=-1 open state and exposes screen conflicts',()=>{
    db=fixture(0n,100n);db.exec("INSERT INTO android_screen_state VALUES(1,10,0,'on','on','Screen on'),(2,30,-1,'off','off','Screen off'),(3,50,10,'on','on','Screen on')");
    expect(query(db,'screen_state_changes').map(r=>[r.dur,r.boundary_kind])).toEqual([['0','instant'],['70','open'],['10','interval']]);
    expect(query(db,'device_state_lane','state_timeline')).toContainEqual(expect.objectContaining({start_ts:'50',end_ts:'60',state:'UNKNOWN',source_status:'conflict'}));
  });
  it('clips screen observations to canonical bounds and ignores out-of-range samples',()=>{
    db=fixture(100n,200n);db.exec("INSERT INTO android_screen_state VALUES(1,50,100,'on','on','Screen on'),(2,300,10,'off','off','Screen off')");
    expect(query(db,'screen_state_changes')).toEqual([expect.objectContaining({ts:'100',dur:'50',state:'SCREEN_ON'})]);
    expect(query(db,'device_state_lane','state_timeline').map(r=>[r.start_ts,r.end_ts])).toEqual([['100','150'],['150','200']]);
  });
  it.each([4098,8194,0])('keeps ACTION_SCROLL as axis input without inferring a wheel or content scroll for source %s',source=>{
    db=fixture();native(db,1,10n,8,7,3,source);
    expect(query(db,'user_gestures')).toEqual([expect.objectContaining({gesture_type:'scroll_input',device_id:7,display_id:3,
      input_source:source,dur:'0',event_count:1,event:'滚动轴输入（ACTION_SCROLL）'})]);
    for(const id of ['input_state_lane_frames','input_state_lane_fallback']) {
      const rows=query(db,id,'state_timeline');
      expect(rows).toContainEqual(expect.objectContaining({state:'SCROLL_INPUT',state_label:'滚动轴输入（ACTION_SCROLL）'}));
      expect(rows.some(row=>row.state==='WHEEL'||row.state==='FLING')).toBe(false);
    }
    expect(query(db,'scroll_initiation')).toEqual([]);expect(query(db,'inertial_scrolls')).toEqual([]);
  });
  it('does not choose an app when every receiver lacks action information',()=>{
    db=fixture();legacy(db,1n,null,'A',1);legacy(db,1n,null,'B',2);
    expect(query(db,'user_gestures')).toEqual([expect.objectContaining({event_count:1,dispatch_count:2,upid:null,app_package:null,identity_status:'multiple_recipients'})]);
  });
  it('assigns an action-free event to the one receiver that owns its window, whatever the stream order',()=>{
    db=fixture();
    for(const time of [1n,2n,3n]){
      legacy(db,time,null,'[Gesture Monitor] swipe-to-screenshot (server)',10,'com.android.systemui');
      legacy(db,time,null,'e620163 NavigationBar0 (server)',10,'com.android.systemui');
      legacy(db,time,null,'PointerEventDispatcher0 (server)',11,'system_server');
      legacy(db,time,null,'f4033a5 com.android.systemui.wallpapers.ImageWallpaper',10,'com.android.systemui');
      legacy(db,time,null,'32c6ecb com.tencent.mm/com.tencent.mm.ui.LauncherUI (server)',2,'com.tencent.mm:appbrand0');
    }
    expect(query(db,'user_gestures')).toEqual([expect.objectContaining({event_count:3,dispatch_count:15,receiver_count:1,
      upid:2,app_package:'com.tencent.mm:appbrand0',stream_key:'2:32c6ecb com.tencent.mm/com.tencent.mm.ui.LauncherUI (server)',
      identity_status:'observed_recipient',gesture_type:'input_unknown',source_status:'partial',missing_action_count:3})]);
  });
  it('keeps an action-free event unassigned when two receivers own their windows, and never by name prefix alone',()=>{
    db=fixture();
    legacy(db,1n,null,'a1 com.foo/com.foo.Main',1,'com.foo');legacy(db,1n,null,'b2 com.bar/com.bar.Main',2,'com.bar');
    legacy(db,1n,null,'[Gesture Monitor] edge-swipe',3,'com.android.systemui');
    legacy(db,5n,null,'c3 com.foo/com.foo.Main',4,'com.foox');legacy(db,5n,null,'[Gesture Monitor] edge-swipe',3,'com.android.systemui');
    expect(query(db,'user_gestures').map(r=>[r.ts,r.receiver_count,r.upid,r.identity_status,r.stream_key])).toEqual([
      ['1',2,null,'multiple_recipients','1:a1 com.foo/com.foo.Main'],
      ['5',2,null,'multiple_recipients','3:[Gesture Monitor] edge-swipe']]);
  });
  it('lets an action narrow past other window owners',()=>{
    db=fixture();
    for(const [time,action] of [[1n,'DOWN'],[2n,'UP']] as const){
      legacy(db,time,null,'b2 com.bar/com.bar.WatchOutsideDialog',1,'com.bar');legacy(db,time,action,'a1 com.foo/com.foo.Main',9,'com.foo');
    }
    expect(query(db,'user_gestures')).toEqual([expect.objectContaining({gesture_type:'tap',receiver_count:1,upid:9,
      identity_status:'observed_recipient',stream_key:'9:a1 com.foo/com.foo.Main'})]);
  });
  it('picks the representative in the same precedence as the candidates',()=>{
    db=fixture();
    for(const [time,action] of [[1n,'DOWN'],[2n,null],[3n,'UP']] as const){
      legacy(db,time,null,'b2 com.bar/com.bar.Main',1,'com.bar');legacy(db,time,action,'NotificationShade',9,'com.android.systemui');
    }
    expect(query(db,'user_gestures')).toEqual([expect.objectContaining({event_count:3,receiver_count:1,upid:9,stream_key:'9:NotificationShade'})]);
  });
  it('orders same-timestamp native events by ingestion identity, preserving an instant contact',()=>{
    db=fixture();native(db,9,10n,0);native(db,10,10n,1);
    expect(query(db,'user_gestures')).toEqual([expect.objectContaining({gesture_type:'tap',dur:'0',event_count:2,source_id:'9',source_ids:'9,10'})]);
  });
  it('does not allow a negative requested cap to disable the output budget',()=>{
    db=fixture();legacy(db,1n,'DOWN');legacy(db,2n,'UP');legacy(db,3n,'DOWN');legacy(db,4n,'UP');
    expect(query(db,'user_gestures','scene_reconstruction',-1)).toHaveLength(1);
    expect(query(db,'input_coverage','scene_reconstruction',-1)[0]).toMatchObject({output_row_limit:1,output_truncated:1});
  });
  it('requires the explicit RecyclerView main-thread producer, not arbitrary scroll text',()=>{
    db=fixture();db.exec("INSERT INTO process VALUES(1,'app');INSERT INTO thread VALUES(1,1,1);INSERT INTO thread_track VALUES(1,1);INSERT INTO slice VALUES(1,10,20,'RV Scroll',1),(2,30,20,'some_scroll_name',1)");
    expect(query(db,'scroll_initiation')).toEqual([expect.objectContaining({ts:'10',dur:'20',source_table:'slice',source_id:'1',upid:1})]);
  });
  it('counts only gesture output for scan completeness and keeps zero-row scan metadata',()=>{
    db=fixture();
    expect(query(db,'input_coverage','scene_reconstruction',1)[0]).toMatchObject({gesture_count:0,output_truncated:0,cursor_closed:1});
    legacy(db,1n,'DOWN');legacy(db,99n,'UP');
    expect(query(db,'input_coverage','scene_reconstruction',1)[0]).toMatchObject({gesture_count:1,gap_count:2,output_truncated:0});
  });
  it('normalizes before window clipping and keeps source identity across adjacent scans',()=>{
    db=fixture();legacy(db,1n,'DOWN');legacy(db,50n,'MOVE');legacy(db,99n,'UP');
    const left=query(db,'user_gestures','scene_reconstruction',4096,'20','60')[0];
    const right=query(db,'user_gestures','scene_reconstruction',4096,'60','80')[0];
    expect(left).toMatchObject({ts:'20',end_ts:'60',source_start_ts:'1',source_end_ts:'99',window_clipped:1,boundary_complete:0,source_status:'partial'});
    expect(right.source_ids).toBe(left.source_ids);expect(right.stream_key).toBe(left.stream_key);
    expect(query(db,'input_coverage','scene_reconstruction',4096,'20','60')[0]).toMatchObject({start_ts:'20',end_ts:'60',gesture_count:1});
  });

});
