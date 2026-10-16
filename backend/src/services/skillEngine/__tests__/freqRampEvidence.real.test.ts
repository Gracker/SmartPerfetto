// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

// Real-trace gate for freq_ramp_slow evidence (fragments/system_cpu_big_freq_coverage.sql).
// jank_frame_detail and scrolling_analysis run end to end on the pinned
// trace_processor_shell over the constructed scrolling-frequency-limit-jank
// case. No corpus trace records CPU capacity, so every core is 'unknown' there;
// the known-topology paths substitute only the capacity input
// (fragments/system_sched_spans.sql reads `FROM cpu`) to make cpu7 — the CPU
// the fixture main thread runs on — the one big CPU, and the incomplete path
// additionally drops cpu7's frequency samples before frame N. Everything else
// is the shipped SQL. `npm run test:analysis-accuracy` materializes the trace.
//
// cpu7 frequency (ms after the fixture anchor): 1.8 GHz until 1495, 1.2 GHz
// until 1520, then 1.8 GHz. Frame N spans 1500..1530 (main on cpu7 from 1502):
// the big tier reaches high frequency 20 ms into it. Frame N1 spans
// 1400..1430, already at 1.8 GHz: a measured 0 ms ramp.

import {afterAll, beforeAll, describe, expect, it, jest} from '@jest/globals';
import path from 'path';
import {TraceProcessorService} from '../../traceProcessorService';
import {createSkillExecutor} from '../skillExecutor';
import {ensureSkillRegistryInitialized, skillRegistry} from '../skillLoader';
import {queryRows} from '../../../utils/traceProcessorRowUtils';
import {resolveTraceCase} from '../../../../tests/helpers/traceCorpus';

// Each case runs whole Skills; scrolling_analysis dominates.
jest.setTimeout(900_000);

const FIXTURE_PACKAGE = 'com.smartperfetto.fixture';
const TOPOLOGY_INPUT = '    FROM cpu\n  ) c';
const FREQUENCY_INPUT = 'FROM system_windows w JOIN cpu_frequency_counters f';
// Expert probes do not feed batch_frame_root_cause; skipping them halves each run.
const BATCH_PARAMS = {enable_expert_probes: false};

type Row = Record<string, unknown>;
interface Inputs {bigCpu?: number; dropBigSamplesBefore?: string}

describe('freq_ramp_slow evidence on the real trace processor', () => {
  let service: TraceProcessorService;
  let traceId: string;
  const frames: Record<string, {start: string; end: string}> = {};

  beforeAll(async () => {
    await ensureSkillRegistryInitialized();
    service = new TraceProcessorService(path.join(process.cwd(), 'uploads', 'freq-ramp-evidence-real'));
    traceId = await service.loadTraceFromFilePath(resolveTraceCase('scrolling-frequency-limit-jank'));
    const rows = await queryRows(service, traceId, `
      SELECT a.layer_name, printf('%d', a.ts) AS s, printf('%d', a.ts + a.dur) AS e
      FROM actual_frame_timeline_slice a JOIN process p USING(upid)
      WHERE p.name = '${FIXTURE_PACKAGE}' AND a.layer_name IN ('SyntheticFreqLimitN', 'SyntheticFreqLimitN1')`);
    for (const row of rows) frames[String(row.layer_name)] = {start: String(row.s), end: String(row.e)};
    expect(Object.keys(frames).sort()).toEqual(['SyntheticFreqLimitN', 'SyntheticFreqLimitN1']);
  });

  afterAll(async () => {
    if (traceId) await service.deleteTrace(traceId);
  });

  // The shipped Skill through the real executor; only the named inputs are substituted.
  const run = async (skillId: string, params: Row, inputs: Inputs) => {
    const rewrite = (sql: string) => {
      let out = sql;
      if (inputs.bigCpu !== undefined && out.includes(TOPOLOGY_INPUT)) {
        out = out.split(TOPOLOGY_INPUT).join(`    FROM (SELECT id, cpu, machine_id, cluster_id,
      CASE WHEN cpu = ${inputs.bigCpu} THEN 1024 ELSE 512 END AS capacity FROM cpu) cpu\n  ) c`);
      }
      if (inputs.dropBigSamplesBefore !== undefined && out.includes(FREQUENCY_INPUT)) {
        out = out.split(FREQUENCY_INPUT).join(`FROM system_windows w JOIN (SELECT * FROM cpu_frequency_counters
          WHERE NOT (ucpu = ${inputs.bigCpu} AND ts < ${inputs.dropBigSamplesBefore})) f`);
      }
      return out;
    };
    const processor = {query: (id: string, sql: string, options?: any) => service.query(id, rewrite(sql), options)};
    const executor = createSkillExecutor(processor);
    executor.setFragmentRegistry(skillRegistry.getFragmentCache());
    executor.registerSkills(skillRegistry.getAllSkills());
    return (await executor.execute(skillId, traceId, params, {})) as any;
  };

  const detail = async (layer: string, inputs: Inputs = {}) => {
    const frame = frames[layer];
    const result = await run('jank_frame_detail',
      {package: FIXTURE_PACKAGE, start_ts: frame.start, end_ts: frame.end}, inputs);
    const [row] = result.rawResults.root_cause_summary.data as Row[];
    return {result, ramp: {reason_code: row?.reason_code, ramp_to_high_ms: row?.ramp_to_high_ms,
      freq_ramp_evidence: row?.freq_ramp_evidence}};
  };

  const batch = async (inputs: Inputs) => {
    const result = await run('scrolling_analysis', BATCH_PARAMS, inputs);
    const rows = result.rawResults.batch_frame_root_cause.data as Row[];
    const byLayer = (layer: string) => {
      const row = rows.find(candidate => candidate.layer_name === layer);
      expect({layer, found: Boolean(row)}).toEqual({layer, found: true});
      return {reason_code: row!.reason_code, ramp_ms: row!.ramp_ms, freq_ramp_evidence: row!.freq_ramp_evidence};
    };
    return {N: byLayer('SyntheticFreqLimitN'), N1: byLayer('SyntheticFreqLimitN1')};
  };

  it('names no ramp reason without a big tier (the corpus trace as recorded)', async () => {
    const {result, ramp} = await detail('SyntheticFreqLimitN');
    // Before the evidence gate this frame was freq_ramp_slow with a 30 ms (whole-frame) ramp.
    expect(ramp).toEqual({reason_code: 'workload_heavy', ramp_to_high_ms: null,
      freq_ramp_evidence: 'big_core_topology_unknown'});
    // The ramp columns are global CPU context, not target-process measurements.
    const entries = result.rawResults.root_cause_summary.scopeProvenance.entries as any[];
    const target = entries.find(entry => entry.role === 'target');
    const global = entries.find(entry => entry.role === 'global_context');
    for (const field of ['ramp_to_high_ms', 'freq_ramp_evidence']) {
      expect({field, target: target.fields.includes(field), global: global.fields.includes(field)})
        .toEqual({field, target: false, global: true});
    }
    // The batch row of this path (ramp_ms NULL, not an instant 0) is asserted by the
    // corpus case itself (capped-frame-running-below-cap), on the same trace.
  });

  it('times the ramp when the one big CPU is observed for the whole frame', async () => {
    expect((await detail('SyntheticFreqLimitN', {bigCpu: 7})).ramp)
      .toEqual({reason_code: 'freq_ramp_slow', ramp_to_high_ms: 20, freq_ramp_evidence: 'observed'});
    // Already at high frequency when the frame starts: a measured 0.
    const n1 = (await detail('SyntheticFreqLimitN1', {bigCpu: 7})).ramp;
    expect(n1).toEqual(expect.objectContaining({ramp_to_high_ms: 0, freq_ramp_evidence: 'observed'}));
    expect(n1.reason_code).not.toBe('freq_ramp_slow');
    const rows = await batch({bigCpu: 7});
    expect(rows.N).toEqual({reason_code: 'freq_ramp_slow', ramp_ms: 20, freq_ramp_evidence: 'observed'});
    expect(rows.N1).toEqual(expect.objectContaining({ramp_ms: 0, freq_ramp_evidence: 'observed'}));
    expect(rows.N1.reason_code).not.toBe('freq_ramp_slow');
  });

  it('does not time a ramp when the big CPU is first sampled inside the frame', async () => {
    const inputs = {bigCpu: 7, dropBigSamplesBefore: frames.SyntheticFreqLimitN.start};
    expect((await detail('SyntheticFreqLimitN', inputs)).ramp)
      .toEqual({reason_code: 'workload_heavy', ramp_to_high_ms: null, freq_ramp_evidence: 'big_core_freq_incomplete'});
    expect((await batch(inputs)).N)
      .toEqual({reason_code: 'workload_heavy', ramp_ms: null, freq_ramp_evidence: 'big_core_freq_incomplete'});
  });
});
