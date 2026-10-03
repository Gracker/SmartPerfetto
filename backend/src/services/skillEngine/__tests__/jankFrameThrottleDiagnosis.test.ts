// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import {describe, expect, it, jest} from '@jest/globals';
import {createSkillExecutor} from '../skillExecutor';
import {readSkillFragmentFile, skillFragmentKey} from '../skillFragments';
import type {DiagnosticResult, SkillDefinition, SkillExecutionResult} from '../types';
import {diagnoseRuleStep, fresh, rowsTable as table, stepOf, type Rows, type Table} from '../../../../tests/helpers/skillRuleHarness';
import {namesThermalCause} from '../../../../tests/helpers/skillWording';

/**
 * jank_frame_detail's frame_diagnosis may assert a CPU frequency limit only
 * from the cpufreq max-limit evidence row, and never a thermal cause.
 *
 * The Skill steps run verbatim from YAML — the `cpu_throttling` reference with
 * its `save_from`, the real `cpu_throttling_in_range` child with the real
 * fragments, and the `frame_diagnosis` rules — against a trace processor that
 * answers each child query with the rows a scenario needs.
 */

const skillsDir = path.join(process.cwd(), 'skills');
const PARENT_FILE = 'composite/jank_frame_detail.skill.yaml';
const CHILD_FILE = 'atomic/cpu_throttling_in_range.skill.yaml';

function loadSkill(rel: string): any {
  return yaml.load(fs.readFileSync(path.join(skillsDir, rel), 'utf8'));
}


interface Scenario {
  /** The limit_evidence row; 'error' makes that query fail. */
  limit: Rows | 'error';
  /** throttle_detection rows (cpufreq samples inside the window). */
  throttle?: Rows;
  /** The parent's own per-tier frequency ranges (cpu_freq_analysis). */
  freq?: Rows;
  /** The parent's own frequency change events (cpu_freq_timeline). */
  timeline?: Rows;
}

const limitRow = (overrides: Record<string, unknown>): Rows => [{
  has_limit_track: 1, has_max_limit_data: 1, episode_count: 0, policy_count: 0,
  deepest_depth_pct: null, min_limit_khz: null, reference_max_limit_khz: 2400000,
  reference_basis: 'observed_max_limit_in_trace_not_hardware_max',
  evidence_status: 'no_limit_episode_in_range', limit_evidence_missing_reason: null,
  next_step: '', evidence_scope: 'observation_not_causal', ...overrides,
}];
const OBSERVED = limitRow({episode_count: 1, policy_count: 1, deepest_depth_pct: 25,
  min_limit_khz: 1800000, evidence_status: 'freq_limit_observed'});
const NO_EPISODE = limitRow({});
const NOT_CAPTURED = limitRow({has_limit_track: 0, has_max_limit_data: 0, reference_max_limit_khz: null,
  evidence_status: 'limit_track_unavailable', limit_evidence_missing_reason: 'max_limit_not_captured'});
const NO_VALID_SAMPLES = limitRow({has_max_limit_data: 0, reference_max_limit_khz: null,
  evidence_status: 'limit_track_unavailable', limit_evidence_missing_reason: 'max_limit_samples_missing'});

const fragmentsDir = path.join(skillsDir, 'fragments');
const FRAGMENTS = new Map(fs.readdirSync(fragmentsDir).filter(file => file.endsWith('.sql'))
  .map(file => [skillFragmentKey(file), readSkillFragmentFile(fragmentsDir, file)]));
const CHILD = loadSkill(CHILD_FILE);
const PARENT = loadSkill(PARENT_FILE);

const bigRange = (min: number, max: number, coreType = 'big'): Rows => [
  {core_type: coreType, avg_freq_mhz: (min + max) / 2, max_freq_mhz: max, min_freq_mhz: min},
  {core_type: 'little', avg_freq_mhz: 1800, max_freq_mhz: 1800, min_freq_mhz: 1800},
];

type QueryAnswer = Table | {columns: string[]; rows: unknown[][]; error: string};

/** A query's rows, or 'error' to make that query fail. */
const reply = (rows: Rows | 'error'): QueryAnswer =>
  rows === 'error' ? {columns: [], rows: [], error: 'query failed'} : table(rows);

/** Runs `steps` as one Skill against a trace processor that answers each query with `answer`. */
async function runSkill(
  steps: unknown[],
  answer: (sql: string) => QueryAnswer | undefined,
  setup: (executor: ReturnType<typeof createSkillExecutor>) => void = () => {},
): Promise<SkillExecutionResult> {
  const tp = {
    query: jest.fn(async (_traceId: string, sql: string) => answer(sql) ?? {columns: [], rows: []}),
    touchTrace: jest.fn(),
    getTraceWithPort: jest.fn(async () => ({port: 9100})),
  };
  const executor = createSkillExecutor(tp as any);
  setup(executor);
  executor.registerSkill({
    name: 'jank_frame_detail_under_test', type: 'composite', version: '1',
    meta: {display_name: 'under test', description: 'under test'}, steps,
  } as SkillDefinition);
  return executor.execute('jank_frame_detail_under_test', 'trace-1', {start_ts: 1, end_ts: 2});
}

async function runSteps(...args: Parameters<typeof runSkill>): Promise<DiagnosticResult[]> {
  return (await runSkill(...args)).diagnostics;
}

function diagnose(scenario: Scenario): Promise<DiagnosticResult[]> {
  return runSteps([
    {id: 'cpu_freq_analysis', type: 'atomic', sql: 'SELECT 1 AS stub_freq_data', save_as: 'freq_data'},
    {id: 'cpu_freq_timeline', type: 'atomic', sql: 'SELECT 1 AS stub_freq_timeline', save_as: 'freq_timeline'},
    fresh(stepOf(PARENT, 'cpu_throttling')),
    fresh(stepOf(PARENT, 'frame_diagnosis')),
  ], sql => {
    if (sql.includes('has_limit_track')) return reply(scenario.limit);
    if (sql.includes('freq_drop_pct')) return table(scenario.throttle ?? []);
    if (sql.includes('stub_freq_data')) return table(scenario.freq ?? []);
    if (sql.includes('stub_freq_timeline')) return table(scenario.timeline ?? []);
    return undefined;
  }, executor => {
    executor.setFragmentRegistry(FRAGMENTS);
    executor.registerSkill(fresh(CHILD));
    executor.registerSkill({name: 'cpu_topology_view', type: 'atomic', version: '1',
      meta: {display_name: 'topology', description: 'topology'}, sql: 'SELECT 1'} as SkillDefinition);
  });
}

const LIMIT_ASSERTION = '帧窗口内观测到 CPU 限频';
const RANGE_OBSERVATION = '核组频率最高';
/** How a hint defers a frequency cause to the frame's limit evidence. */
const LIMIT_DEFERRAL = '是否限频以本帧的 CPU 限频证据为准';
const find = (diagnostics: DiagnosticResult[], ...markers: string[]) =>
  diagnostics.filter(d => markers.some(marker => d.diagnosis.includes(marker)));
const texts = (diagnostics: DiagnosticResult[]) => diagnostics.flatMap(d => [d.diagnosis, ...(d.suggestions ?? [])]);

const RULES = JSON.stringify(stepOf(PARENT, 'frame_diagnosis').rules);
/** Fields frame_diagnosis reads from a row of `name`, as `.data[0]` or `.data.find(c => c.cluster === '…')`. */
function rowFieldsRead(name: string): string[] {
  const row = String.raw`\??\.data(?:\??\.?\[0\]|\??\.find\(c => c\.cluster === '[^']+'\))\??\.(\w+)`;
  return [...RULES.matchAll(new RegExp(name + row, 'g'))].map(m => m[1]);
}
const undeclared = (fields: string[], step: any) => {
  const columns = new Set(step.display.columns.map((column: any) => column.name));
  return fields.filter(field => !columns.has(field));
};

describe('jank_frame_detail frequency-limit diagnosis', () => {
  it('asserts a limit from the evidence row even when the window holds no cpufreq sample', async () => {
    const diagnostics = await diagnose({limit: OBSERVED, throttle: []});
    const [limit] = find(diagnostics, LIMIT_ASSERTION);
    expect(limit).toMatchObject({severity: 'warning'});
    expect(limit.diagnosis).toContain('限频区段 1 个');
    expect(limit.diagnosis).toContain('涉及 1 个 cpufreq policy');
    expect(limit.diagnosis).toContain('最大限频深度 25%');
    expect(limit.diagnosis).toContain('非硬件最大频率');
    expect(limit.diagnosis).toContain('最低上限 1800000 kHz');
    expect(limit.suggestions?.join('\n')).toContain('cpu_frequency_limit_attribution');
  });

  it('never asserts a thermal cause, and the observation rule stays silent under a limit', async () => {
    const diagnostics = await diagnose({limit: OBSERVED, freq: bigRange(1000, 2400)});
    expect(find(diagnostics, LIMIT_ASSERTION)).toHaveLength(1);
    expect(find(diagnostics, RANGE_OBSERVATION)).toHaveLength(0);
    expect(texts(diagnostics).filter(namesThermalCause)).toEqual([]);
  });

  it('reports a wide big-tier range without limit evidence only as an observation', async () => {
    const diagnostics = await diagnose({limit: NO_EPISODE, freq: bigRange(1000, 2400)});
    expect(find(diagnostics, LIMIT_ASSERTION)).toHaveLength(0);
    expect(find(diagnostics, RANGE_OBSERVATION)).toHaveLength(1);
    const [range] = find(diagnostics, RANGE_OBSERVATION);
    expect(range).toMatchObject({severity: 'info'});
    expect(range.diagnosis).toContain('big 核组频率最高 2400 MHz、最低 1000 MHz（组内各 CPU 与时间合计，跨度超过 20%）');
    expect(range.diagnosis).toContain('本帧窗口未检测到限频区段（窗口覆盖未确认，不能据此排除限频）');
    expect(range.diagnosis).toContain('不能据此判定限频或温控');
    expect(range.suggestions).toEqual(['频率变化原因（负载、调速器、空闲 DVFS）需结合调度数据排查']);
  });

  it('names why limit evidence is unavailable instead of assuming a missing track', async () => {
    const cases: Array<[Scenario['limit'], string, string]> = [
      [NOT_CAPTURED, 'trace 未采集 cpufreq 上限轨道', '采集 power/cpu_frequency_limits'],
      [NO_VALID_SAMPLES, 'cpufreq 上限轨道无有效样本', '检查 cpufreq 上限轨道的采集与解析'],
      ['error', '限频证据未取得（证据查询未产出结果）', '检查 cpu_throttling_in_range 的 limit_evidence 步骤'],
    ];
    for (const [limit, reason, advice] of cases) {
      const ranges = find(await diagnose({limit, freq: bigRange(1000, 2400)}), RANGE_OBSERVATION);
      expect(ranges).toHaveLength(1);
      const [range] = ranges;
      expect(range.diagnosis).toContain(reason);
      expect(range.suggestions?.[0]).toContain(advice);
    }
  });

  it('does not bind the cpufreq-sample rows when limit_evidence fails', async () => {
    // throttle_detection rows would be the engine's fallback pick; save_from
    // keeps them out, so their evidence_status cannot read as a limit.
    const throttle = [{core_type: '大核', freq_drop_pct: 50, max_freq_mhz: 2400, min_freq_mhz: 1200,
      throttle_detected: 1, evidence_status: 'freq_limit_observed'}];
    const diagnostics = await diagnose({limit: 'error', throttle});
    expect(find(diagnostics, LIMIT_ASSERTION)).toHaveLength(0);
  });

  it('ignores ranges at or below 20% and tiers other than prime/big/medium', async () => {
    expect(find(await diagnose({limit: NO_EPISODE, freq: bigRange(2000, 2400)}), RANGE_OBSERVATION))
      .toHaveLength(0);
    expect(find(await diagnose({limit: NO_EPISODE, freq: bigRange(1000, 2400, 'unknown')}), RANGE_OBSERVATION))
      .toHaveLength(0);
    const [prime] = find(await diagnose({limit: NO_EPISODE, freq: bigRange(1000, 2400, 'prime')}), RANGE_OBSERVATION);
    expect(prime.diagnosis).toContain('prime 核组频率最高');
  });

  it('keeps the adjacent frequency hints free of an unevidenced thermal cause', async () => {
    const lowFreq = bigRange(1000, 1400);
    const downSteps = [1, 2, 3].map(i => ({core_type: 'big', change_direction: 'down', ts: String(i)}));
    const hints = (await diagnose({limit: NO_EPISODE, freq: lowFreq, timeline: downSteps}))
      .filter(d => d.diagnosis.startsWith('大核频率'))
      .flatMap(d => d.suggestions ?? []);
    expect(hints).toHaveLength(4);
    expect(hints.filter(namesThermalCause)).toEqual([]);
    expect(hints.filter(text => text.includes(LIMIT_DEFERRAL))).toHaveLength(2);
  });

  it('reads only fields and values the child evidence step can produce', () => {
    const binding = stepOf(PARENT, 'cpu_throttling');
    expect(binding).toMatchObject({save_as: 'freq_limit_evidence', save_from: 'limit_evidence'});
    const evidenceStep = stepOf(CHILD, binding.save_from);
    const fields = rowFieldsRead(binding.save_as);
    expect(fields.length).toBeGreaterThan(0);
    expect(undeclared(fields, evidenceStep)).toEqual([]);

    const statuses = [...RULES.matchAll(/evidence_status [!=]== '(\w+)'/g)].map(m => m[1]);
    expect(statuses.filter(status => !evidenceStep.sql.includes(`'${status}'`))).toEqual([]);
    const spansFragment = fs.readFileSync(path.join(skillsDir, 'fragments/system_cpu_freq_limit_spans.sql'), 'utf8');
    const reasons = [...RULES.matchAll(/limit_evidence_missing_reason === '(\w+)'/g)].map(m => m[1]);
    expect(reasons.length).toBeGreaterThan(0);
    expect(reasons.filter(reason => !spansFragment.includes(`'${reason}'`))).toEqual([]);
  });
});

/** frame_diagnosis alone, fed stub rows under the save_as names its rules read. */
const diagnoseFrom = (inputs: Record<string, Rows>): Promise<DiagnosticResult[]> =>
  diagnoseRuleStep(stepOf(PARENT, 'frame_diagnosis'), inputs, {start_ts: 1, end_ts: 2});

describe('jank_frame_detail frame_diagnosis values', () => {
  it('carries the root-cause confidence level as the rule confidence', async () => {
    const cases: Array<[unknown, number]> = [['高', 0.9], ['中', 0.7], ['低', 0.5], [null, 0.5]];
    for (const [level, confidence] of cases) {
      const rootCause = [{primary_cause: '主线程锁竞争', confidence: level, secondary_info: null}];
      const matched = (await diagnoseFrom({root_cause: rootCause}))
        .filter(d => d.diagnosis === '主线程锁竞争');
      expect(matched).toHaveLength(1);
      expect(matched[0]).toMatchObject({confidence, severity: 'critical', suggestions: ['查看下方详细数据分析具体原因']});
    }
  });

  // Every cluster-load rule reads its input as `cluster_load_data?.data`.
  it('cites the cluster-load rows a fired cluster-load rule read', async () => {
    const rows = [
      {cluster: '大核簇', load_pct: 95, max_single_core_pct: 97},
      {cluster: '小核簇', load_pct: 40, max_single_core_pct: 60},
    ];
    const fired = find(await diagnoseFrom({cluster_load_data: rows}), '大核簇负载');
    expect(fired.map(d => d.diagnosis)).toEqual(['大核簇负载 95%，接近跑满']);
    expect(fired[0].evidence).toEqual({
      cluster_load_data: {_rowCount: 2, _firstRow: rows[0]},
    });
  });

  it('cites the frame-window GC total the gc step computed', async () => {
    const gc = (total: number) => [
      {gc_type: 'young', overlap_ms: 2.2, total_overlap_ms: total},
      {gc_type: 'full', overlap_ms: 1.1, total_overlap_ms: total},
    ];
    const heavy = find(await diagnoseFrom({gc_data: gc(3.3)}), 'GC 严重影响帧渲染');
    expect(heavy.map(d => d.diagnosis)).toEqual(['GC 严重影响帧渲染：总重叠 3.3ms']);
    expect(find(await diagnoseFrom({gc_data: gc(3)}), 'GC 严重影响帧渲染')).toHaveLength(0);
  });
});

/**
 * task_migration_in_range and cpu_cluster_load_in_range both begin with a
 * cpu_topology_view reference, whose rows are present on any real trace.
 * `save_from` names the read step: the default selection binds an unobserved
 * read step as `[]`, and a selection that let the topology result count as
 * data would bind it in place of the rows. The real children run here, the
 * topology reference included.
 */
const TOPOLOGY_CHILD = loadSkill('atomic/cpu_topology_view.skill.yaml');
/** The jank_frame_detail steps whose child begins with that reference, and each child. */
const TOPOLOGY_BACKED = new Map(['task_migration', 'cpu_cluster_load']
  .map(id => [id, loadSkill(`atomic/${stepOf(PARENT, id).skill}.skill.yaml`)]));

const TOPOLOGY_ROWS: Rows = [
  {cpu_id: 0, universe_source: 'cpu', capacity: 400, core_type: 'little', topology_source: 'capacity'},
  {cpu_id: 4, universe_source: 'cpu', capacity: 1024, core_type: 'big', topology_source: 'capacity'},
];
const MIGRATION_ROWS: Rows = [{thread_name: 'RenderThread', migration_count: 9, big_to_little: 5,
  little_to_big: 4, big_core_pct: 20, unknown_core_ns: 0, unique_cpus: 6}];
const CLUSTER_ROWS: Rows = [
  {cluster: '大核簇', core_count: 3, load_pct: 95, max_single_core_pct: 99},
  {cluster: '小核簇', core_count: 4, load_pct: 40, max_single_core_pct: 50},
];

async function runTopologyBacked(answers: {migration: Rows | 'error'; cluster: Rows | 'error'}) {
  const result = await runSkill([
    ...[...TOPOLOGY_BACKED.keys()].map(id => fresh(stepOf(PARENT, id))),
    fresh(stepOf(PARENT, 'frame_diagnosis')),
  ], sql => {
    if (sql.includes('big_to_little')) return reply(answers.migration);
    if (sql.includes('max_single_core_pct')) return reply(answers.cluster);
    if (sql.includes('FROM _cpu_topology') && !sql.includes('CREATE')) return table(TOPOLOGY_ROWS);
    return undefined;
  }, executor => {
    executor.setFragmentRegistry(FRAGMENTS);
    executor.registerSkill(fresh(TOPOLOGY_CHILD));
    for (const child of TOPOLOGY_BACKED.values()) executor.registerSkill(fresh(child));
  });
  const inputs = (result.rawResults?.frame_diagnosis?.data as {inputs: Record<string, unknown>}).inputs;
  return {diagnostics: result.diagnostics, inputs};
}

const MIGRATION_FINDINGS = ['迁移到小核', '运行占比仅'];
const CLUSTER_FINDINGS = ['簇负载', '簇中有核心接近'];

const clusterRow = (cluster: string, loadPct: number, maxSingleCorePct = 80) =>
  ({cluster, core_count: 2, load_pct: loadPct, max_single_core_pct: maxSingleCorePct});
/** Wording that asserts a thread identity or a scope these rows do not establish. */
const UNEVIDENCED_SCOPE = /UI 线程|资源严重不足|资源紧张|导致调度延迟|整体负载|整机/;
const unevidenced = (text: string) => namesThermalCause(text) || UNEVIDENCED_SCOPE.test(text);

describe('jank_frame_detail topology-backed child bindings', () => {
  it('binds the read steps rows, and the rules cite them', async () => {
    const {diagnostics, inputs} = await runTopologyBacked({migration: MIGRATION_ROWS, cluster: CLUSTER_ROWS});
    expect(inputs.migration_data).toEqual(MIGRATION_ROWS);
    expect(inputs.cluster_load_data).toEqual(CLUSTER_ROWS);
    expect(find(diagnostics, ...MIGRATION_FINDINGS).map(d => d.diagnosis)).toEqual([
      'RenderThread 从大核组（超大/大/中核）迁移到小核 5 次，小核迁回大核组 4 次（迁移次数最多的线程）',
      'RenderThread 大核组（超大/大/中核）运行占比仅 20%',
    ]);
    expect(find(diagnostics, ...CLUSTER_FINDINGS).map(d => d.diagnosis)).toEqual([
      '大核簇负载 95%，接近跑满',
      '大核簇中有核心接近 100% (99%)',
    ]);
    // Evidence is drawn only from `name.data` in a condition, which the cluster rules do not write.
    expect(find(diagnostics, ...MIGRATION_FINDINGS).map(d => d.evidence?.migration_data?._firstRow))
      .toEqual([MIGRATION_ROWS[0], MIGRATION_ROWS[0]]);
  });

  it('keeps the migration and cluster-load hints free of an unevidenced cause', async () => {
    // The thread with the most migrations is not the UI thread, and every tier is saturated.
    const migration: Rows = [
      {...MIGRATION_ROWS[0], thread_name: 'Thread-7'},
      {...MIGRATION_ROWS[0], thread_name: 'RenderThread', migration_count: 4, big_to_little: 3},
    ];
    const cluster = [clusterRow('超大核簇', 95), clusterRow('大核簇', 95, 99), clusterRow('中核簇', 95),
      clusterRow('小核簇', 96)];
    const {diagnostics} = await runTopologyBacked({migration, cluster});
    const migrationFindings = find(diagnostics, ...MIGRATION_FINDINGS);
    expect(migrationFindings.map(d => d.severity)).toEqual(['warning', 'warning']);
    for (const finding of migrationFindings) expect(finding.diagnosis).toMatch(/^Thread-7 /);
    const clusterFindings = find(diagnostics, ...CLUSTER_FINDINGS);
    const bigTierSaturated = ['大核簇负载 95%，接近跑满', '超大核簇负载 95%，接近跑满', '中核簇负载 95%，接近跑满'];
    expect(clusterFindings.map(d => [d.diagnosis, d.severity])).toEqual([
      [bigTierSaturated[0], 'critical'],
      [bigTierSaturated[1], 'critical'],
      [bigTierSaturated[2], 'warning'],
      ['小核簇负载 96%，几乎跑满', 'warning'],
      ['大核簇与小核簇负载均高于 70%: 大核簇 95%, 小核簇 96%', 'warning'],
      ['大核簇中有核心接近 100% (99%)', 'info'],
    ]);

    expect(texts([...migrationFindings, ...clusterFindings]).filter(unevidenced)).toEqual([]);
    // Placement and Running-time share carry no frequency: the migration and the
    // big-tier saturation hints defer to the limit evidence.
    const deferring = [...migrationFindings,
      ...clusterFindings.filter(d => bigTierSaturated.includes(d.diagnosis))];
    expect(deferring).toHaveLength(5);
    for (const finding of deferring) {
      expect(finding.suggestions?.some(text => text.includes(LIMIT_DEFERRAL))).toBe(true);
    }
  });

  it('states only the tiers a cluster rule measured', async () => {
    const littleOnly = find((await runTopologyBacked({migration: [],
      cluster: [clusterRow('大核簇', 40), clusterRow('小核簇', 96)]})).diagnostics, ...CLUSTER_FINDINGS);
    expect(littleOnly.map(d => d.diagnosis)).toEqual(['小核簇负载 96%，几乎跑满']);

    const bigAndLittle = find((await runTopologyBacked({migration: [], cluster: [clusterRow('超大核簇', 20),
      clusterRow('大核簇', 75), clusterRow('中核簇', 20), clusterRow('小核簇', 75)]})).diagnostics, ...CLUSTER_FINDINGS);
    expect(bigAndLittle.map(d => d.diagnosis)).toEqual(['大核簇与小核簇负载均高于 70%: 大核簇 75%, 小核簇 75%']);

    expect(texts([...littleOnly, ...bigAndLittle]).filter(unevidenced)).toEqual([]);
  });

  it('binds an empty read step as empty, never the topology reference before it', async () => {
    const {diagnostics, inputs} = await runTopologyBacked({migration: [], cluster: []});
    expect(inputs.migration_data).toEqual([]);
    expect(inputs.cluster_load_data).toEqual([]);
    expect(find(diagnostics, ...MIGRATION_FINDINGS, ...CLUSTER_FINDINGS)).toEqual([]);
  });

  it('leaves the binding without data when the read step observed nothing', async () => {
    const {diagnostics, inputs} = await runTopologyBacked({migration: 'error', cluster: 'error'});
    expect(inputs.migration_data).toBeNull();
    expect(inputs.cluster_load_data).toBeNull();
    expect(find(diagnostics, ...MIGRATION_FINDINGS, ...CLUSTER_FINDINGS)).toEqual([]);
  });

  it('reads only fields the named child step declares and cluster names its SQL emits', () => {
    for (const [id, child] of TOPOLOGY_BACKED) {
      const binding = stepOf(PARENT, id);
      const readStep = stepOf(child, binding.save_from);
      expect(readStep.type).toBe('atomic');
      const fields = rowFieldsRead(binding.save_as);
      expect(fields.length).toBeGreaterThan(0);
      expect(undeclared(fields, readStep)).toEqual([]);
    }
    const clusterSql = stepOf(TOPOLOGY_BACKED.get('cpu_cluster_load'), 'cluster_load').sql;
    const clusters = [...RULES.matchAll(/c\.cluster === '([^']+)'/g)].map(m => m[1]);
    expect(clusters.length).toBeGreaterThan(0);
    expect(clusters.filter(cluster => !clusterSql.includes(`'${cluster}'`))).toEqual([]);
  });
});
