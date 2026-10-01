// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import Database from 'better-sqlite3';
import {describe, expect, it} from '@jest/globals';
import {ArtifactStore} from '../../../agentv3/artifactStore';
import {SkillExecutor} from '../skillExecutor';
import {buildTraceProcessorQueryProvenance} from '../../traceProcessorConnectionModel';
import {evidenceTableFor, projectEvidenceColumnUnitsForModel} from '../../evidence/evidenceCapture';
import type {RuntimeToolInvocationEvent} from '../../../agentRuntime/runtimeToolObserver';
import {runWithinRuntimeToolInvocation} from '../../../agentRuntime/runtimeToolInvocationContext';
import {prepareClaimEvidence} from '../../evidence/claimEvidencePreparation';
import {runClaimVerification} from '../../verifier/claimVerificationRunner';
import type {ConclusionContract, ConclusionContractClaimReference} from '../../../agent/core/conclusionContract';

const step = (yaml.load(fs.readFileSync(path.join(process.cwd(), 'skills/composite/scrolling_analysis.skill.yaml'), 'utf-8')) as any)
  .steps.find((candidate: any) => candidate.id === 'frame_timeline_population');

function population(rows: string): Record<string, unknown> {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE actual_frame_timeline_slice(id INTEGER, ts INTEGER, dur INTEGER, upid INTEGER, name TEXT,
      surface_frame_token INTEGER, display_frame_token INTEGER, jank_type TEXT);
    CREATE TABLE trace_bounds(start_ts INTEGER, end_ts INTEGER);
    INSERT INTO trace_bounds VALUES (0, 1000);
    ${rows}
  `);
  return db.prepare(step.sql).get() as Record<string, unknown>;
}

describe('scrolling_analysis frame_timeline_population', () => {
  it('counts one frame per process and FrameTimeline token across the whole trace', () => {
    expect(population(`INSERT INTO actual_frame_timeline_slice VALUES
      (1, 0, 10, 10, '100', 100, NULL, 'None'),
      (2, 5, 10, 10, '100', 100, NULL, 'App Deadline Missed'),
      (3, 20, 10, 10, '', 101, NULL, 'None'),
      (4, 25, 10, 10, '101', 101, NULL, 'None'),
      (5, 30, 10, 10, '102', 102, NULL, 'Buffer Stuffing'),
      (6, 40, 10, 10, '7', 7, NULL, 'None'),
      (7, 45, 10, 10, '', NULL, NULL, NULL),
      (8, 0, 10, 20, '100', 100, NULL, 'None'),
      (9, 0, 10, 30, '500', NULL, 500, 'None'),
      (10, 0, 10, 30, '', NULL, 501, 'None'),
      (11, NULL, 10, 10, '103', 103, NULL, 'App Deadline Missed'),
      (12, 50, -1, 10, '104', 104, NULL, 'App Deadline Missed'),
      (13, 60, 10, NULL, '900', 900, NULL, 'App Deadline Missed');`)).toEqual({
      // upid 10: 100 (two slices, one tagged), 101 (empty name falls back to the
      // same token), 102 (Buffer Stuffing), 7, and slice:7 (a slice id is not
      // token 7); upid 20: 100 (same token, another process); upid 30: display
      // frames 500 and 501; one frame without a process. Rows with no ts or a
      // negative dur are not frames.
      total_frames: 9, jank_frames: 3, process_count: 3, unattributed_frames: 1,
      evidence_scope: 'trace_wide_all_processes', trace_start_ts: 0, trace_end_ts: 1000,
      frame_population_evidence: 'observed',
    });
  });

  it('reports an observed zero for a trace with no FrameTimeline frames', () => {
    expect(population('')).toMatchObject({total_frames: 0, jank_frames: 0, process_count: 0, unattributed_frames: 0});
  });

  it('gives its frame counts producer unit authority without a display time unit', async () => {
    for (const column of ['total_frames', 'jank_frames']) {
      expect(step.display.columns.find((candidate: any) => candidate.name === column).unit).toBeUndefined();
    }
    // Production path: SkillExecutor capture -> artifact registration inside the observed tool call.
    const columns = step.display.columns.map((column: any) => column.name);
    const executor = new SkillExecutor({query: async () => ({columns,
      rows: [[697, 21, 3, 0, 'trace_wide_all_processes', 0, 1000, 'observed']], durationMs: 1})});
    executor.registerSkill({name: 'frame_population_fixture', version: '1', type: 'atomic',
      meta: {display_name: step.name, description: 'scrolling_analysis frame_timeline_population'},
      process_scope: step.process_scope, sql: step.sql, investigation_evidence: step.investigation_evidence,
      output: {display: {...step.display, format: 'table'}}} as any);
    const result = await executor.execute('frame_population_fixture', 'trace');
    expect(result.success).toBe(true);
    const display = result.displayResults[0];
    const witness = evidenceTableFor(display)!;
    expect(projectEvidenceColumnUnitsForModel(display.data, witness)).toMatchObject({total_frames: 'frames', jank_frames: 'frames'});

    const store = new ArtifactStore();
    const observation = (phase: 'started' | 'completed') => ({toolCallId: 'call', toolName: 'invoke_skill', params: {}, extra: {},
      phase, ...(phase === 'completed' ? {result: {content: []}} : {})}) as RuntimeToolInvocationEvent;
    store.observeInvestigationTool(observation('started'), 'run-1');
    store.observeInvestigationTool(observation('completed'), 'run-1');
    const id = store.store({skillId: result.skillId, data: display.data, sourceToolCallId: 'invoke_skill:1:population',
      traceProvenance: buildTraceProcessorQueryProvenance({traceId: 'trace', traceSide: 'current'})});
    await runWithinRuntimeToolInvocation({toolCallId: 'call'}, async () =>
      store.registerEvidenceCapture(id, witness, {evidenceRefId: 'data:population', originRunId: 'run-1'}));
    const view = store.createEvidenceReadView({ownerKey: 'owner', currentRunId: 'run-1',
      allowedTraces: [{traceId: 'trace', traceSide: 'current'}]});
    expect(view.investigationEvidence!().records.map(record => ({metricId: record.metricId, value: record.value,
      unit: record.unit, status: record.status, aggregation: record.aggregation, window: record.window}))).toEqual([
      {metricId: 'render.frame.timeline.trace_frames', value: 697, unit: 'frames', status: 'observed',
        aggregation: 'trace_wide_all_processes', window: {start: 0, end: 1000}},
      {metricId: 'render.frame.timeline.jank_tagged_frames', value: 21, unit: 'frames', status: 'observed',
        aggregation: 'trace_wide_all_processes', window: {start: 0, end: 1000}},
    ]);

    const claim = (column: string, value: number) => {
      const reference: ConclusionContractClaimReference = {artifactId: id, rowIndex: 0, column, value};
      return {id: column, kind: 'numeric' as const, text: `${value} frames`, references: [reference],
        semantics: {schemaVersion: 'claim_semantics@1' as const, predicate: 'numeric.cell', polarity: 'affirmed' as const,
          discourse: 'asserted' as const, quantifier: 'one' as const, modality: 'certain' as const,
          scope: {population: 'cited_rows' as const, subjectRefs: [reference]}, numeric: {operator: 'eq' as const, value, unit: 'frames'}}};
    };
    const conclusionContract: ConclusionContract = {schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer',
      conclusions: [], clusters: [], evidenceChain: [], uncertainties: [], nextSteps: [], bindingEligibility: 'eligible',
      claims: [claim('total_frames', 697), claim('jank_frames', 21)]};
    const preparedEvidence = await prepareClaimEvidence({conclusionContract, evidenceReadView: view});
    expect(runClaimVerification({conclusionContract, preparedEvidence}).claimVerificationResult.claimResults
      .map(result => result.deterministicProof)).toEqual([
      expect.objectContaining({kind: 'numeric_cell', status: 'proved'}),
      expect.objectContaining({kind: 'numeric_cell', status: 'proved'}),
    ]);
  });
});
