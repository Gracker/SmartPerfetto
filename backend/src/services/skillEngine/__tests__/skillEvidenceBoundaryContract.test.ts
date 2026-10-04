// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import Database from 'better-sqlite3';
import { describe, expect, it } from '@jest/globals';
import { renderStepSql } from '../../../../tests/helpers/skillFragmentSql';
import { skillDocuments } from '../../../../tests/helpers/skillRuleHarness';
import { namesFrequencyCap, namesThermalCause } from '../causeWording';
import { CAP_WORDING, HEAT_WORDING, causeWordingReaders, causeWordingSites, type CauseWordingRule } from '../causeWordingEvidence';

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

// ---------------------------------------------------------------------------
// Thermal wording. A frequency drop, a frequency ratio, a low share on big
// cores or CPU starvation is not thermal evidence: only cpufreq max-limit
// evidence shows a cap, and only temperature / cooling-device evidence speaks
// to a thermal mechanism. A Skill that reads neither may defer to that
// evidence, never name heat as the cause.
// ---------------------------------------------------------------------------

interface CauseWording { site: string; allowedBy?: string; text: string }

/** Every text of `skill` that names `rule`'s cause, as `<skill>[/<step>]` with what allows it. */
function causeWording(skill: any, readers: ReadonlySet<string>, rule: CauseWordingRule = HEAT_WORDING): CauseWording[] {
  const both = {heat: readers, cap: readers};
  return causeWordingSites(skill, {named: both, exact: both, variantsDiffer: false}, rule).map(site => ({
    site: site.stepId ? `${skill.name}/${site.stepId}` : String(skill.name),
    text: site.text,
    allowedBy: site.allowedBy,
  }));
}

describe('thermal wording follows thermal evidence', () => {
  const skills = skillDocuments().map(({skill}) => skill);
  const readers = causeWordingReaders(skills);
  /** Every wording `rule` flags across the Skills, with what allows it. */
  const wordingOf = (rule: CauseWordingRule) =>
    skills.flatMap(skill => causeWording(skill, readers.named[rule.wording], rule));
  const wording = wordingOf(HEAT_WORDING);
  const capWording = wordingOf(CAP_WORDING);

  it('names a thermal cause only where the Skill reads thermal or limit evidence', () => {
    expect(wording.filter(entry => !entry.allowedBy).map(entry => `${entry.site}: ${entry.text}`)).toEqual([]);
  });

  it('says throttle only where the Skill reads a frequency cap, not a temperature alone', () => {
    expect(capWording.filter(entry => !entry.allowedBy).map(entry => `${entry.site}: ${entry.text}`)).toEqual([]);
    // A GPU temperature counter shows heat, not a cap.
    const probe = {name: 'probe', type: 'composite', steps: [{id: 'low_clock', type: 'atomic', name: 'Sustained GPU throttle events',
      sql: "SELECT AVG(c.value) FROM counter c JOIN gpu_counter_track t ON t.id = c.track_id WHERE t.name = 'Temperature'"}]};
    expect(causeWording(probe, new Set(), CAP_WORDING)).toEqual([
      {site: 'probe/low_clock', text: 'Sustained GPU throttle events', allowedBy: undefined},
    ]);
    expect(causeWording(probe, new Set())).toEqual([]);
  });

  it('flags a cause in rule text or a user-facing literal, not a deferral or a code', () => {
    const skill = {name: 'probe', type: 'composite', steps: [
      {id: 'rules', type: 'diagnostic', rules: [
        {condition: 'true', diagnosis: '大核占比偏低', suggestions: ['可能触发温控策略', '占比本身不是限频或温控证据']},
      ]},
      {id: 'sql', type: 'atomic', sql: "SELECT 'thermal_zone' AS kind, '频率突降，可能受温控限制' AS note, '温度: ' AS label"},
    ]};
    expect(causeWording(skill, new Set()).map(entry => entry.text)).toEqual(['可能触发温控策略', '频率突降，可能受温控限制']);
  });

  it('judges each clause: a deferral in one clause does not excuse a cause in another', () => {
    expect(namesThermalCause('是温控导致，不是负载')).toBe(true);
    expect(namesThermalCause('频率下降不是温控证据；是否限频以限频证据为准')).toBe(false);
    expect(namesThermalCause('缺少 cpufreq 上限证据（及温度事件）后才能判断')).toBe(false);
    expect(namesThermalCause('确认由温控触发后，可在设备冷却后重测')).toBe(false);
    expect(namesThermalCause('若干核心因温控降频')).toBe(true);
    // Refusing to rule heat out leaves it standing as a cause.
    expect(namesThermalCause('不能排除温控')).toBe(true);
    expect(namesThermalCause('无法排除温控导致卡顿')).toBe(true);
    // The nearest deferral governs: an earlier 缺少 is about something else.
    expect(namesThermalCause('缺少负载数据但不能排除温控')).toBe(true);
    // A negation inside a condition's premise does not reach the consequence.
    expect(namesThermalCause('如果没有负载突增则可能是温控导致降频')).toBe(true);
    expect(namesThermalCause('如果频率正常则不是温控')).toBe(false);
    // A deferral reaches the thermal word only when no consequence, attribution,
    // contrast or time premise stands between them; a negated break word is the deferral.
    expect(namesThermalCause('负载无异常而温控降频明显')).toBe(true);
    expect(namesThermalCause('没有其他负载突增可能是温控导致')).toBe(true);
    expect(namesThermalCause('缺少负载数据可能是温控导致')).toBe(true);
    expect(namesThermalCause('没有前台负载时温控导致降频')).toBe(true);
    expect(namesThermalCause('降频次数本身不能说明温控或限频')).toBe(false);
    // Denying the absence of heat leaves it standing.
    expect(namesThermalCause('这不代表设备没有发生热控')).toBe(true);
    // A thermal word stands by default: missing data defers only the evidence that is missing,
    // and a deferral reaches a few characters with no connective.
    for (const asserted of ['缺少负载数据但温控降频明显', '没有负载突增因此是温控降频', '没有负载变化所以是温控降频',
      '负载没有变化因为温控', '无异常且温控降频', '若负载正常即为温控', '无负载异常即温控', '缺少负载证据便是温控',
      '尚未发现异常故判断为温控', '没有负载突增的情况下温控降频明显']) {
      expect([asserted, namesThermalCause(asserted)]).toEqual([asserted, true]);
    }
    expect(namesThermalCause('缺少 thermal 限频轨道')).toBe(false);
    // "throttle" reads as a frequency cap; inside an identifier or a placeholder it is a name.
    expect(namesFrequencyCap('Sustained GPU throttle events')).toBe(true);
    expect(namesFrequencyCap('GPU throttling')).toBe(true);
    expect(namesFrequencyCap('min_throttle_ns')).toBe(false);
    expect(namesFrequencyCap('频率变化 ${throttle_events.data.length} 次')).toBe(false);
    expect(namesThermalCause('Sustained GPU throttle events')).toBe(false);
    // English names a component or record the word belongs to, and negates it right before it,
    // the way 热控守护进程 and 不是温控 do; it still blames one the clause attributes something to.
    for (const [text, heat] of [
      ['Android thermal HAL service process', false], ['OEM thermal manager daemon', false],
      ['Kernel thermal zone worker thread', false], ['Any thermal-named track or slice', false],
      ['Mitigation naming used by several vendor thermal stacks', false],
      ['may change frequency limits for non-thermal reasons', false], ['hints and boosts are not thermal mitigation', false],
      ['Thermal throttling detected', true], ['Device thermal state degraded performance', true],
      ['thermal zone trips caused the frame drops', true], ['thermal events', true],
      // Something said of the component makes it a cause; a pattern written as data is a name.
      ['Thermal zone overheated', true], ['Thermal HAL is responsible for latency', true],
      ['*thermal-engine*', false], ['*mtk*thermal*', false],
      ['thermal daemon slowed the frame', true], ['thermal track caused jank', true],
      // A parenthetical is part of the clause: what it says of the component counts.
      ['Thermal HAL (caused jank)', true], ['Android thermal HAL service process (vendor implementation varies)', true],
      ['Thermal HAL (service process)', false],
      // A boundary inside the parenthetical does not cut the component off from what is said of it.
      ['Thermal HAL (service process, caused jank)', true], ['Thermal HAL（service process，caused jank）', true],
      ['Thermal HAL (service process: caused jank)', true], ['Thermal HAL (service process; caused jank)', true],
      ['Thermal HAL ((service) process, caused jank)', true],
      // An evidence condition in a parenthetical covers what follows it, never the text it qualifies.
      ['温控导致卡顿（建议：确认温控证据后再进一步分析）', true], ['Thermal HAL（确认温度证据后再判断）', false],
      ['分析结果（温控导致卡顿，只有温度证据确认后才报告）', true], ['Thermal HAL (caused jank, 只有温度证据确认后才报告)', true],
      ['结论（原因（温控导致卡顿，只有温度证据确认后才报告））', true], ['结论（温控只有在温度证据确认后才可判定）', false],
      ['Thermal HAL (service process), 只有温度证据确认后才报告温控', false],
      // An unmatched bracket is text: it neither guards a boundary nor scopes a condition.
      ['温控导致卡顿 (确认温控证据后', false], ['温控导致卡顿 确认温控证据后', false],
      // In a Chinese sentence an English component name is judged like any English word;
      // the Chinese reference (用户态温控守护进程) is what names the component.
      ['thermal HAL 是卡顿的根因', true], ['thermal HAL 让帧变慢', true], ['thermal HAL 降低帧率', true],
      ['thermal daemon 导致卡顿', true], ['由用户态温控守护进程直接写 cpufreq 上限', false], ['**Thermal HAL is responsible for latency**', true],
    ] as const) {
      expect([text, namesThermalCause(text)]).toEqual([text, heat]);
    }
    for (const [text, cap] of [
      ['Explicit throttling naming; semantics are vendor defined', false], ['no throttling observed', false], ['*throttl*', false], ['**CPU throttled**', true],
      ['CPU throttled', true], ['Throttling caused jank', true],
    ] as const) {
      expect([text, namesFrequencyCap(text)]).toEqual([text, cap]);
    }
    // Chinese cap wording, judged by what each word modifies.
    for (const [text, cap] of [
      ['限频导致卡顿', true], ['GPU 曾深度降频', true], ['大核降频次数', true], ['持续高温会加速热节流', true],
      ['频率上限导致卡顿', true], ['受频率上限影响，频率上限限制了大核', true],
      // An observed step-down, a request or event rate, a hedged source list and a reference to evidence assert no cap.
      ['频率下调次数', false], ['请求节流间隔', false], ['输入事件节流', false],
      ['仅为频率观测：可能来自负载、调速器或频率上限', false], ['频率上限可能降低大核可用容量', false],
      ['是否限频以限频证据为准', false], ['缺少限频轨道', false], ['尚不能据此确定热节流或性能影响', false],
      ['未经核实不得当作限频原因', false], ['先确认限频与触发方', false], ['已确认限频导致卡顿', true], ['限频与否未判定', false], ['超过该值标记为频繁突降；不判定限频', false],
    ] as const) {
      expect([text, namesFrequencyCap(text)]).toEqual([text, cap]);
    }
    // 设备 is a source of evidence only in 散热设备; elsewhere it is what heat acts on.
    for (const asserted of ['温控让设备降频', '过热使设备降频', '高温下设备降频', '温控限制了设备性能',
      '发热严重设备卡顿', '设备过热后设备降频', '温控降频事件频发', '不是负载就是温控', '无法判断负载实为温控',
      '过热设备卡顿', '温控设备降频']) {
      expect([asserted, namesThermalCause(asserted)]).toEqual([asserted, true]);
    }
    expect(namesThermalCause('无散热设备数据')).toBe(false);
    expect(namesThermalCause('若为温控所致，先降低负载')).toBe(false);
    // A negated judgement covers its object until a connective starts a new proposition.
    expect(namesThermalCause('仅为频率观测，不能据此判定限频或温控')).toBe(false);
    expect(namesThermalCause('仅凭频率变化无法判断是否温控')).toBe(false);
    expect(namesThermalCause('不能判断负载因此是温控')).toBe(true);
    // A condition's long premise ends the condition's reach even without a connective.
    expect(namesThermalCause('如果用户在后台长时间运行游戏温控降频明显')).toBe(true);
    // A denied deferral is no deferral.
    expect(namesThermalCause('不意味着不是温控')).toBe(true);
    // A slash after a Chinese word joins alternatives; only an ASCII name is a path.
    expect(namesThermalCause('卡顿可能是温控/调度问题')).toBe(true);
    expect(namesThermalCause('不排除是过热')).toBe(true);
    expect(namesThermalCause('确认后台负载正常，卡顿由温控导致')).toBe(true);
    expect(namesThermalCause('不是负载而是温控导致卡顿')).toBe(true);
    expect(namesThermalCause('仍需注意温控导致的卡顿')).toBe(true);
    // A condition on anything but evidence does not defer the cause after it,
    // and a deferral after the cause does not take it back.
    expect(namesThermalCause('若大核频率持续下降，说明温控降频')).toBe(true);
    expect(namesThermalCause('如果频率突降，可能是温控限频')).toBe(true);
    expect(namesThermalCause('温控导致卡顿还需优化代码')).toBe(true);
    expect(namesThermalCause('热控风险仍需温度和直接限频证据')).toBe(false);
    expect(namesThermalCause('如果是温控导致，应先降低负载')).toBe(false);
    expect(namesThermalCause('降频原因需结合直接 thermal throttling 事件判断')).toBe(false);
    // A condition and its consequence without a comma: the consequence asserts heat.
    expect(namesThermalCause('如果频率突降说明温控限频')).toBe(true);
    expect(namesThermalCause('若频率下降则温控降频')).toBe(true);
    expect(namesThermalCause('如果频率突降可能是温控')).toBe(true);
    expect(namesThermalCause('如果可能是温控导致，需要温度证据')).toBe(false);
    expect(namesThermalCause('按规则温控降频')).toBe(true);
    // Missing evidence, a prohibition and a reference to a source of evidence name no cause;
    // a source to which something is attributed does.
    expect(namesThermalCause('无内核散热设备数据')).toBe(false);
    expect(namesThermalCause('不要把性能下降归因于温控')).toBe(false);
    expect(namesThermalCause('加入 thermal/cdev_update 与 thermal/thermal_temperature')).toBe(false);
    expect(namesThermalCause('请检查温控证据与热控守护进程')).toBe(false);
    expect(namesThermalCause('温控事件导致卡顿')).toBe(true);
    // An undetermined marker covers its own proposition, not one a contrast set apart.
    expect(namesThermalCause('温控导致卡顿但触发方未确认')).toBe(true);
    expect(namesThermalCause('卡顿明显，但是否由温控导致未确认')).toBe(false);
    expect(namesFrequencyCap('限频导致掉帧，不过触发方未判定')).toBe(true);
    expect(namesFrequencyCap('是否限频与否未判定')).toBe(false);
    expect(namesThermalCause('缺少温控证据，可能是温控导致')).toBe(true);
  });

  // Strategy prose teaches thermal mechanisms legitimately; only the lines that
  // tell the model what to conclude or recommend are held to the clause rule.
  it('keeps strategy conclusion and advice lines free of an unhedged heat or cap cause', () => {
    const strategies = path.join(repoRoot, 'strategies');
    const offenders = fs.readdirSync(strategies).filter(file => file.endsWith('.md')).flatMap(file =>
      fs.readFileSync(path.join(strategies, file), 'utf8').split('\n')
        .map((line, index) => ({line, at: `${file}:${index + 1}`}))
        .filter(({line}) => /结论表述|结论模板|典型结论|\*\*建议/.test(line) && (namesThermalCause(line) || namesFrequencyCap(line)))
        .map(({at, line}) => `${at}: ${line}`));
    expect(offenders).toEqual([]);
  });

  it('judges each rule on its own condition, even when its text repeats an allowed one', () => {
    const skill = {name: 'probe', type: 'composite', steps: [
      {id: 'limit', type: 'atomic', sql_fragments: ['fragments/system_cpu_freq_limit_spans.sql'], sql: 'SELECT 1', save_as: 'limit_data'},
      {id: 'diagnosis', type: 'diagnostic', inputs: ['limit_data'], rules: [
        {condition: 'limit_data.data.length > 0', diagnosis: '温控导致降频'},
        {condition: 'limit_data.data.length === 0', diagnosis: '温控导致降频'},
      ]},
    ]};
    expect(causeWording(skill, new Set()).map(entry => entry.allowedBy)).toEqual(['rule probe/diagnosis', undefined]);
  });

  it('allows thermal wording only in steps and rules that read thermal or limit evidence', () => {
    const skill = {name: 'probe', type: 'composite', steps: [
      {id: 'freq', type: 'atomic', sql: "SELECT '频率下降，可能温控' AS note", save_as: 'freq'},
      // Its own user-facing text naming a cooling device is not evidence it read.
      {id: 'self_named', type: 'atomic', sql: "SELECT '可能是温控（cooling device）' AS note"},
      {id: 'limit', type: 'atomic', sql_fragments: ['fragments/system_cpu_freq_limit_spans.sql'],
        sql: "SELECT '限频由温控触发' AS note", save_as: 'limit_data'},
      {id: 'diagnosis', type: 'diagnostic', inputs: ['freq', 'limit_data'], rules: [
        {condition: 'freq.data[0]?.x > 1', diagnosis: '可能是温控'},
        {condition: "limit_data.data[0]?.status === 'observed'", diagnosis: '观测到温控限频'},
      ]},
      // A condition on the absence of evidence reads none: it cannot allow a cause.
      {id: 'gap', type: 'atomic', condition: 'limit_data.data.length === 0',
        sql: "SELECT '缺少 thermal 限频轨道' AS gap, '可能是温控导致' AS note"},
      {id: 'absent', type: 'diagnostic', inputs: ['freq', 'limit_data'], rules: [
        {condition: "limit_data.data[0]?.status !== 'observed'", diagnosis: '可能是温控限频'},
        {condition: "limit_data.data[0]?.status === 'observed' || freq.data[0]?.x > 1", diagnosis: '可能是温控降频'},
        {condition: "freq.data[0]?.x > 1 && limit_data.data[0]?.status === 'observed'", diagnosis: '温控降频'},
        // An alternative inside parentheses, or another name's value, can make it hold without evidence.
        {condition: '(limit_data.data.length > 0 || freq.data?.length > 0)', diagnosis: '温控导致掉帧'},
        {condition: '(limit_data.data[0]?.depth ?? 0) > threshold', diagnosis: '温控导致卡顿'},
        {condition: "(limit_data.data[0]?.status === 'observed' && freq.data[0]?.x > 1)", diagnosis: '温控限频'},
        // Alternatives are judged through parentheses: names a single probe value cannot satisfy together.
        {condition: "(limit_data.data[0]?.status === 'observed' || (mode === 1 && level === 'high'))", diagnosis: '温控降频明显'},
        {condition: "(limit_data.data[0]?.status === 'observed' || (mode === 1 && level === 'high')) === true", diagnosis: '温控降频显著'},
        {condition: '(limit_data.data.length > 0 || mode === 1) === (other === 2 && limit_data.data.length > 0)', diagnosis: '温控降频突出'},
      ]},
      // Its own output names and codes are not input: an alias or a value literal reads nothing.
      {id: 'alias', type: 'atomic', sql: "SELECT freq_mhz AS cooling_hint, '温控导致降频' AS note FROM cpu_freq"},
      {id: 'code', type: 'atomic', sql: "WITH thermal_zone AS (SELECT 1) SELECT 'thermal_zone' AS kind, '温控导致' AS note"},
      // Its own names in any case or quoting: SQL identifiers are case-insensitive.
      {id: 'own_cte', type: 'atomic', sql: "WITH cooling_hint AS (SELECT 1 AS x) SELECT '温控导致掉帧' AS note FROM COOLING_HINT"},
      {id: 'own_quoted', type: 'atomic', sql: 'WITH "cdev_view" AS (SELECT 1 AS x) SELECT \'温控导致卡顿\' AS note FROM [cdev_view]'},
      // A track it compares against is: a temperature track filter reads temperature.
      {id: 'track', type: 'atomic', sql: "SELECT '高温导致降频' AS note FROM counter_track WHERE name GLOB '*temp*'"},
    ]};
    expect(causeWording(skill, new Set()).map(entry => [entry.text, entry.allowedBy])).toEqual([
      ['频率下降，可能温控', undefined],
      ['可能是温控（cooling device）', undefined],
      ['限频由温控触发', 'step probe/limit'],
      ['可能是温控', undefined],
      ['观测到温控限频', 'rule probe/diagnosis'],
      ['可能是温控导致', undefined],
      ['可能是温控限频', undefined],
      ['可能是温控降频', undefined],
      ['温控降频', 'rule probe/absent'],
      ['温控导致掉帧', undefined],
      ['温控导致卡顿', undefined],
      ['温控限频', 'rule probe/absent'],
      ['温控降频明显', undefined],
      ['温控降频显著', undefined],
      ['温控降频突出', undefined],
      ['温控导致降频', undefined],
      ['温控导致', undefined],
      ['温控导致掉帧', undefined],
      ['温控导致卡顿', undefined],
      ['高温导致降频', 'step probe/track'],
    ]);
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
      expect(run(range.steps.find((step:any)=>step.id==='throttle_detection').sql)[0]).toMatchObject({frequency_variation_detected:1,throttle_detected:null,evidence_status:'limit_evidence_unavailable'});
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
    // An absent status is a limit step that produced no row: its placeholder takes the default.
    return db.prepare(renderStepSql(step.sql, step.sql_fragments, {
      start_ts: limit.start ?? 0,
      end_ts: limit.end ?? 1000000,
      ...(limit.status === undefined ? {} : {'limit_evidence.data[0].evidence_status': limit.status}),
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

  it('reports the limit evidence it has, never a thermal mechanism', () => {
    const cases: Array<[string | undefined, string, number | null, string]> = [
      ['no_limit_episode_in_range', 'no_limit_episode_in_range', 0, '未观测到超过阈值的上限下调区段'],
      ['limit_track_unavailable', 'limit_track_unavailable', null, '缺少 cpufreq 上限证据，是否限频未判定'],
      [undefined, 'limit_evidence_unavailable', null, '缺少 cpufreq 上限证据，是否限频未判定'],
    ];
    for (const [status, evidenceStatus, detected, interpretation] of cases) {
      const [row] = throttleRows([[0, 'big']], [[1, 0, [2000000, 1000000]]], {status});
      expect(row).toMatchObject({evidence_status: evidenceStatus, throttle_detected: detected});
      expect(row.interpretation).toContain(interpretation);
    }
  });
});
