// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import {describe, expect, it, jest} from '@jest/globals';
import {createSkillExecutor} from '../skillExecutor';
import type {DiagnosticResult, SkillDefinition} from '../types';

/**
 * anr_detail's main-thread placement rule reports where the main thread ran,
 * not why. It has no cpufreq max-limit evidence, so it may neither assert a
 * thermal cause nor a frequency limit; it says the limit is undetermined.
 *
 * The anr_event_diagnosis step runs verbatim from YAML, fed stub rows under
 * the save_as names its rules read.
 */

const SKILL: any = yaml.load(fs.readFileSync(
  path.join(process.cwd(), 'skills/composite/anr_detail.skill.yaml'), 'utf8'));

function stepOf(id: string): any {
  const step = SKILL.steps.find((candidate: any) => candidate.id === id);
  if (!step) throw new Error(`step ${id} not found`);
  return step;
}

type Rows = Record<string, unknown>[];

function table(rows: Rows) {
  const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
  return {columns, rows: rows.map(row => columns.map(column => row[column]))};
}

async function diagnose(inputs: Record<string, Rows>): Promise<DiagnosticResult[]> {
  const names = Object.keys(inputs);
  const tp = {
    query: jest.fn(async (_traceId: string, sql: string) => {
      const name = names.find(candidate => sql.includes(`stub_${candidate}`));
      return name ? table(inputs[name]) : {columns: [], rows: []};
    }),
    touchTrace: jest.fn(),
    getTraceWithPort: jest.fn(async () => ({port: 9100})),
  };
  const executor = createSkillExecutor(tp as any);
  executor.registerSkill({
    name: 'anr_detail_under_test', type: 'composite', version: '1',
    meta: {display_name: 'under test', description: 'under test'},
    steps: [
      ...names.map(name => ({id: `stub_${name}`, type: 'atomic', sql: `SELECT 1 AS stub_${name}`, save_as: name})),
      JSON.parse(JSON.stringify(stepOf('anr_event_diagnosis'))),
    ],
  } as SkillDefinition);
  return (await executor.execute('anr_detail_under_test', 'trace-1', {})).diagnostics;
}

/**
 * A 5 s window that production SQL can emit: Running 55% (120 ms big tier,
 * 2630 ms little), Runnable 35%. direct_blocker_classification grades
 * scheduler_pressure medium only above 30% of the window, low otherwise.
 */
const quadrantRow = (overrides: Record<string, unknown> = {}): Rows => [{
  q1_big_running_ms: 120, q2_little_running_ms: 2630, unknown_running_ms: 0, unknown_running_ns: 0,
  q3_runnable_ms: 1750, q4_sleeping_ms: 500, total_ms: 5000,
  running_pct: 55, runnable_pct: 35, sleeping_pct: 10, ...overrides,
}];
const schedulerPressure = (pctOfTimeout = 35): Rows => [{
  direct_blocker_type: 'scheduler_pressure', evidence_ms: 50 * pctOfTimeout, pct_of_timeout: pctOfTimeout,
  evidence_source: 'thread_state.R_or_R_plus', confidence: pctOfTimeout > 30 ? 'medium' : 'low',
  root_cause_boundary: 'needs_system_load_context', next_evidence_needed: '',
}];

const PLACEMENT = '主线程运行时间主要在小核';
const placement = (diagnostics: DiagnosticResult[]) =>
  diagnostics.filter(d => d.diagnosis.startsWith(PLACEMENT));
/** Wording that names a thermal cause; the one negation that defers to limit evidence is not one. */
const namesThermalCause = (text: string) =>
  /温控|温度|过热|散热|thermal/i.test(text.split('不是限频或温控证据').join(''));

describe('anr_detail main-thread placement diagnosis', () => {
  it('reports placement and runnable wait as an observation, deferring any limit to evidence it lacks', async () => {
    const [finding, ...rest] = placement(await diagnose({
      quadrant: quadrantRow(), direct_blocker_candidates: schedulerPressure()}));
    expect(rest).toEqual([]);
    expect(finding).toMatchObject({severity: 'warning'});
    expect(finding.diagnosis).toBe(
      '主线程运行时间主要在小核：大核组（超大/大/中核）120ms、小核 2630ms，同时 Runnable 等待 35%');
    const suggestions = finding.suggestions ?? [];
    expect(suggestions).toHaveLength(3);
    expect(suggestions[0]).toContain('EAS 能效放置');
    expect(suggestions[1]).toContain('目标任务调度交接');
    expect(suggestions[2]).toContain('是否限频以 ANR 窗口的 CPU 限频证据为准');
    expect(suggestions[2]).toContain('限频与否未判定');
  });

  it('stays silent without classified, contended, little-core-dominant Running time', async () => {
    const cases: Array<Record<string, Rows>> = [
      // Unknown-tier Running time leaves the big-tier share undetermined, even
      // when it rounds to 0 ms (coreTierRollupContract runs that through the
      // real SQL); a row without the exact value decides nothing.
      {quadrant: quadrantRow({unknown_running_ns: 4000}), direct_blocker_candidates: schedulerPressure()},
      {quadrant: quadrantRow({unknown_running_ns: null}), direct_blocker_candidates: schedulerPressure()},
      {quadrant: quadrantRow(), direct_blocker_candidates: schedulerPressure(30)},
      {quadrant: quadrantRow()},
      {quadrant: quadrantRow({q1_big_running_ms: 789}), direct_blocker_candidates: schedulerPressure()},
      {quadrant: quadrantRow({running_pct: 50}), direct_blocker_candidates: schedulerPressure()},
      {quadrant: quadrantRow({runnable_pct: 10}), direct_blocker_candidates: schedulerPressure()},
    ];
    for (const inputs of cases) {
      expect(placement(await diagnose(inputs))).toEqual([]);
    }
  });

  it('names a thermal cause in no rule: anr_detail collects no frequency-limit evidence', () => {
    const offenders = stepOf('anr_event_diagnosis').rules
      .flatMap((rule: any) => [rule.diagnosis, ...(rule.suggestions ?? [])])
      .filter(namesThermalCause);
    expect(offenders).toEqual([]);
  });

  it('reads only quadrant fields the quadrant step declares', () => {
    const rules = JSON.stringify(stepOf('anr_event_diagnosis').rules);
    const fields = [...rules.matchAll(/quadrant\.data\[0\]\??\.(\w+)/g)].map(m => m[1]);
    expect(fields).toContain('unknown_running_ns');
    const columns = new Set(stepOf('main_thread_quadrant').display.columns.map((c: any) => c.name));
    expect(fields.filter(field => !columns.has(field))).toEqual([]);
  });
});
