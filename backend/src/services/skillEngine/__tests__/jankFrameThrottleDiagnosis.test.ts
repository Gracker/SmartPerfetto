// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import {describe, expect, it, jest} from '@jest/globals';
import {createSkillExecutor} from '../skillExecutor';
import {readSkillFragmentFile, skillFragmentKey} from '../skillFragments';
import type {DiagnosticResult, SkillDefinition} from '../types';

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

function stepOf(skill: any, id: string): any {
  const step = skill.steps.find((candidate: any) => candidate.id === id);
  if (!step) throw new Error(`step ${id} not found`);
  return step;
}

type Rows = Record<string, unknown>[];
type Table = {columns: string[]; rows: unknown[][]};

function table(rows: Rows): Table {
  const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
  return {columns, rows: rows.map(row => columns.map(column => row[column]))};
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
/** A fresh plain copy per run: the executor must never see state from a previous one. */
const fresh = <T>(value: T): T => JSON.parse(JSON.stringify(value));

const bigRange = (min: number, max: number, coreType = 'big'): Rows => [
  {core_type: coreType, avg_freq_mhz: (min + max) / 2, max_freq_mhz: max, min_freq_mhz: min},
  {core_type: 'little', avg_freq_mhz: 1800, max_freq_mhz: 1800, min_freq_mhz: 1800},
];

type QueryAnswer = Table | {columns: string[]; rows: unknown[][]; error: string};

/** Runs `steps` as one Skill against a trace processor that answers each query with `answer`. */
async function runSteps(
  steps: unknown[],
  answer: (sql: string) => QueryAnswer | undefined,
  setup: (executor: ReturnType<typeof createSkillExecutor>) => void = () => {},
): Promise<DiagnosticResult[]> {
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
  return (await executor.execute('jank_frame_detail_under_test', 'trace-1', {start_ts: 1, end_ts: 2})).diagnostics;
}

function diagnose(scenario: Scenario): Promise<DiagnosticResult[]> {
  return runSteps([
    {id: 'cpu_freq_analysis', type: 'atomic', sql: 'SELECT 1 AS stub_freq_data', save_as: 'freq_data'},
    {id: 'cpu_freq_timeline', type: 'atomic', sql: 'SELECT 1 AS stub_freq_timeline', save_as: 'freq_timeline'},
    fresh(stepOf(PARENT, 'cpu_throttling')),
    fresh(stepOf(PARENT, 'frame_diagnosis')),
  ], sql => {
    if (sql.includes('has_limit_track')) {
      if (scenario.limit === 'error') return {columns: [], rows: [], error: 'limit query failed'};
      return table(scenario.limit);
    }
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
const find = (diagnostics: DiagnosticResult[], marker: string) =>
  diagnostics.filter(d => d.diagnosis.includes(marker));

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
    for (const text of diagnostics.flatMap(d => [d.diagnosis, ...(d.suggestions ?? [])])) {
      expect(text).not.toMatch(/温度过高|过热|散热/);
    }
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
    for (const text of hints) {
      expect(text).not.toMatch(/温控降频|温控策略|温度/);
    }
    expect(hints.filter(text => text.includes('是否限频以本帧的 CPU 限频证据为准'))).toHaveLength(2);
  });

  it('reads only fields and values the child evidence step can produce', () => {
    const binding = stepOf(PARENT, 'cpu_throttling');
    expect(binding).toMatchObject({save_as: 'freq_limit_evidence', save_from: 'limit_evidence'});
    const evidenceStep = stepOf(CHILD, binding.save_from);
    const columns = new Set(evidenceStep.display.columns.map((column: any) => column.name));

    const rules = JSON.stringify(stepOf(PARENT, 'frame_diagnosis').rules);
    const fields = [...rules.matchAll(/freq_limit_evidence\??\.data\??\.?\[0\]\??\.(\w+)/g)].map(m => m[1]);
    expect(fields.length).toBeGreaterThan(0);
    expect(fields.filter(field => !columns.has(field))).toEqual([]);

    const statuses = [...rules.matchAll(/evidence_status [!=]== '(\w+)'/g)].map(m => m[1]);
    expect(statuses.filter(status => !evidenceStep.sql.includes(`'${status}'`))).toEqual([]);
    const spansFragment = fs.readFileSync(path.join(skillsDir, 'fragments/system_cpu_freq_limit_spans.sql'), 'utf8');
    const reasons = [...rules.matchAll(/limit_evidence_missing_reason === '(\w+)'/g)].map(m => m[1]);
    expect(reasons.length).toBeGreaterThan(0);
    expect(reasons.filter(reason => !spansFragment.includes(`'${reason}'`))).toEqual([]);
  });
});

/** frame_diagnosis alone, fed stub rows under the save_as names its rules read. */
function diagnoseFrom(inputs: Record<string, Rows>): Promise<DiagnosticResult[]> {
  const names = Object.keys(inputs);
  return runSteps([
    ...names.map(name => ({id: `stub_${name}`, type: 'atomic', sql: `SELECT 1 AS stub_${name}`, save_as: name})),
    fresh(stepOf(PARENT, 'frame_diagnosis')),
  ], sql => {
    const name = names.find(candidate => sql.includes(`stub_${candidate}`));
    return name ? table(inputs[name]) : undefined;
  });
}

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
