// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import path from 'path';
import fs from 'fs';
import yaml from 'js-yaml';
import {describe, it, expect} from '@jest/globals';

describe('startup display unit contracts', () => {
  const loadYaml = (relativePath: string) => {
    const skillPath = path.join(process.cwd(), relativePath);
    return yaml.load(fs.readFileSync(skillPath, 'utf-8')) as any;
  };

  const getColumn = (columns: any[], name: string) => {
    const column = columns?.find((c: any) => c.name === name);
    expect(column).toBeDefined();
    return column;
  };

  it('startup_events_in_range exposes ms display and ns jump fields consistently', () => {
    const skill = loadYaml('skills/atomic/startup_events_in_range.skill.yaml');
    const columns = skill.display?.columns || [];

    // dur_ms is the visible human-readable column; dur_ns is hidden, used by
    // start_ts.clickAction navigate_range. Original spec had this swapped, but
    // commit 0bae10a5 fixed dur_ns 32-bit overflow by showing dur_ms instead.
    const durMs = getColumn(columns, 'dur_ms');
    expect(durMs.type).toBe('duration');
    expect(durMs.format).toBe('duration_ms');
    expect(durMs.unit).toBe('ms');
    expect(durMs.hidden).not.toBe(true);

    const startTs = getColumn(columns, 'start_ts');
    expect(startTs.type).toBe('timestamp');
    expect(startTs.unit).toBe('ns');
    expect(startTs.clickAction).toBe('navigate_range');
    expect(startTs.durationColumn).toBe('dur_ns');

    const durNs = getColumn(columns, 'dur_ns');
    expect(durNs.type).toBe('duration');
    expect(durNs.format).toBe('duration_ms');
    expect(durNs.unit).toBe('ns');
    expect(durNs.hidden).toBe(true);

    const ttid = getColumn(columns, 'ttid_ms');
    expect(ttid.type).toBe('duration');
    expect(ttid.format).toBe('duration_ms');
    expect(ttid.unit).toBe('ms');

    const ttfd = getColumn(columns, 'ttfd_ms');
    expect(ttfd.type).toBe('duration');
    expect(ttfd.format).toBe('duration_ms');
    expect(ttfd.unit).toBe('ms');
  });

  it('startup_detail uses ms display units for startup and CPU/quadrant durations', () => {
    const skill = loadYaml('skills/composite/startup_detail.skill.yaml');
    const getStep = (id: string) => {
      const step = skill.steps?.find((s: any) => s.id === id);
      expect(step).toBeDefined();
      return step;
    };

    const startupInfoCols = getStep('startup_info').display?.columns || [];
    const durMs = getColumn(startupInfoCols, 'dur_ms');
    expect(durMs.type).toBe('duration');
    expect(durMs.format).toBe('duration_ms');
    expect(durMs.unit).toBe('ms');

    const ttid = getColumn(startupInfoCols, 'ttid_ms');
    expect(ttid.type).toBe('duration');
    expect(ttid.format).toBe('duration_ms');
    expect(ttid.unit).toBe('ms');

    const startTs = getColumn(startupInfoCols, 'start_ts');
    expect(startTs.type).toBe('timestamp');
    expect(startTs.unit).toBe('ns');

    const cpuCoreCols = getStep('cpu_core_analysis').display?.columns || [];
    for (const name of ['big_core_ms', 'little_core_ms', 'total_running_ms']) {
      const col = getColumn(cpuCoreCols, name);
      expect(col.type).toBe('duration');
      expect(col.format).toBe('duration_ms');
      expect(col.unit).toBe('ms');
    }

    // quadrant_analysis exposes per-quadrant *_ms columns + per-quadrant *_pct
    // columns (Q1 big-running / Q2 little-running / Q3 runnable / Q4a io / Q4b sleep)
    // — there is no generic dur_ms / quadrant / percentage column.
    const quadrantCols = getStep('quadrant_analysis').display?.columns || [];
    for (const name of ['q1_big_running_ms', 'q2_little_running_ms', 'q3_runnable_ms', 'q4a_io_blocked_ms', 'q4b_sleeping_ms', 'total_ms']) {
      const col = getColumn(quadrantCols, name);
      expect(col.type).toBe('duration');
      expect(col.format).toBe('duration_ms');
      expect(col.unit).toBe('ms');
    }

    const threadType = getColumn(quadrantCols, 'thread_type');
    expect(threadType.type).toBe('string');

    const q1Pct = getColumn(quadrantCols, 'q1_pct');
    expect(q1Pct.type).toBe('percentage');
    expect(q1Pct.format).toBe('percentage');
  });
});