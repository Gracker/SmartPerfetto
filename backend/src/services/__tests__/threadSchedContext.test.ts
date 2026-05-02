// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, it, expect} from '@jest/globals';
import {buildThreadSchedContext} from '../threadSchedContext';
import {isUnsupported} from '../../types/sparkContracts';

describe('buildThreadSchedContext', () => {
  it('pivots thread_state rows into per-thread durByStateNs', () => {
    const c = buildThreadSchedContext({
      range: {startNs: 0, endNs: 1_000_000_000},
      threadStateRows: [
        {utid: 1, pid: 100, threadName: 'main', state: 'Running', durNs: 600_000},
        {utid: 1, pid: 100, threadName: 'main', state: 'R', durNs: 50_000},
        {utid: 1, pid: 100, threadName: 'main', state: 'S', durNs: 350_000},
        {utid: 2, pid: 100, threadName: 'render', state: 'Running', durNs: 100_000},
      ],
      runnableLatencyP95Ns: {1: 250_000},
    });
    expect(c.threadStates).toHaveLength(2);
    const main = c.threadStates.find(t => t.threadName === 'main');
    expect(main?.durByStateNs.Running).toBe(600_000);
    expect(main?.durByStateNs.S).toBe(350_000);
    expect(main?.runnableLatencyP95Ns).toBe(250_000);
  });

  it('joins wakeup edges and counts incoming wakeups per thread', () => {
    const c = buildThreadSchedContext({
      range: {startNs: 0, endNs: 1_000},
      threadStateRows: [
        {utid: 5, pid: 1, threadName: 'main', state: 'Running', durNs: 1},
      ],
      wakeupEdges: [
        {fromUtid: 9, toUtid: 5, ts: 100, latencyNs: 500, reason: 'binder'},
        {fromUtid: 7, toUtid: 5, ts: 200, latencyNs: 1000, reason: 'futex'},
      ],
    });
    expect(c.threadStates[0].wakeupCount).toBe(2);
    expect(c.wakeupEdges).toHaveLength(2);
  });

  it('marks unsupported when thread_state input is empty', () => {
    const c = buildThreadSchedContext({
      range: {startNs: 0, endNs: 1},
      threadStateRows: [],
    });
    expect(isUnsupported(c)).toBe(true);
  });
});
