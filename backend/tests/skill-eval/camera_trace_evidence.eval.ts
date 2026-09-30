// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {afterAll, beforeAll, expect, it} from '@jest/globals';
import {
  createSkillEvaluator,
  describeWithTrace,
  getTestTracePath,
  SkillEvaluator,
} from './runner';

const TRACE_FILE = 'launch_light.pftrace';
const STEP_IDS = [
  'evidence_coverage',
  'camera_process_candidates',
  'camera_slice_candidates',
  'camera_binder_summary',
  'camera_dmabuf_summary',
  'pixel_camera_stage_summary',
] as const;
const EVIDENCE_FAMILIES = [
  'camera_process_thread_identity',
  'camera_slice_candidates',
  'binder_transactions',
  'scheduler_context',
  'cpu_frequency_context',
  'frame_timeline',
  'dmabuf_allocations',
  'pixel_camera_frames',
] as const;

describeWithTrace('camera_trace_evidence skill', TRACE_FILE, () => {
  let evaluator: SkillEvaluator;

  beforeAll(async () => {
    evaluator = createSkillEvaluator('camera_trace_evidence');
    await evaluator.loadTrace(getTestTracePath(TRACE_FILE));
  }, 60000);

  afterAll(async () => {
    await evaluator?.cleanup();
    await new Promise(resolve => setTimeout(resolve, 2500));
  });

  it('executes every evidence step safely on a non-Camera trace', async () => {
    const results = await evaluator.executeStepSequence([...STEP_IDS], {
      start_ts: 2,
      end_ts: 1,
      max_rows: 1000,
    });

    expect(results.map(result => result.stepId)).toEqual(STEP_IDS);
    for (const result of results) {
      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
      expect(Array.isArray(result.data)).toBe(true);
    }
  }, 60000);

  it('reports all eight stable evidence families with bounded statuses', async () => {
    const result = await evaluator.executeStep('evidence_coverage');

    expect(result.success).toBe(true);
    expect(result.data.map(row => row.evidence_family)).toEqual(EVIDENCE_FAMILIES);
    for (const row of result.data) {
      expect(['available', 'vendor_specific', 'missing']).toContain(row.status);
      expect(Number(row.row_count)).toBeGreaterThanOrEqual(0);
      expect(typeof row.source).toBe('string');
      expect(typeof row.limitation).toBe('string');
    }
  }, 30000);

  it('returns Pixel stage rows as typed details or an empty list', async () => {
    const result = await evaluator.executeStep('pixel_camera_stage_summary');

    expect(result.success).toBe(true);
    expect(Array.isArray(result.data)).toBe(true);
    for (const row of result.data) {
      expect(row).toEqual(expect.objectContaining({
        cam_id: expect.any(Number),
        node: expect.any(String),
        port_group: expect.any(String),
        frame_count: expect.any(Number),
        avg_duration_ns: expect.any(Number),
        max_duration_ns: expect.any(Number),
        source: 'pixel_camera_frames',
        limitation: expect.any(String),
      }));
    }
  }, 30000);
});
