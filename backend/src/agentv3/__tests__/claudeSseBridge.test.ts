// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it } from '@jest/globals';
import { createSseBridge } from '../claudeSseBridge';
import type { StreamingUpdate } from '../../agent/types';

describe('createSseBridge', () => {
  it('does not emit a terminal error for SDK max-turn results', () => {
    const updates: StreamingUpdate[] = [];
    const bridge = createSseBridge((update) => updates.push(update));

    bridge.handleMessage({
      type: 'result',
      subtype: 'error_max_turns',
      errors: [],
      num_turns: 84,
    });

    expect(updates.some(update => update.type === 'error')).toBe(false);
    expect(updates).toContainEqual(expect.objectContaining({
      type: 'progress',
      content: expect.objectContaining({
        phase: 'concluding',
      }),
    }));
  });

  it('still emits errors for non-recoverable SDK result failures', () => {
    const updates: StreamingUpdate[] = [];
    const bridge = createSseBridge((update) => updates.push(update));

    bridge.handleMessage({
      type: 'result',
      subtype: 'error_during_execution',
      errors: ['boom'],
    });

    expect(updates).toContainEqual(expect.objectContaining({
      type: 'error',
      content: expect.objectContaining({
        message: 'Claude analysis error (error_during_execution): boom',
        subtype: 'error_during_execution',
      }),
    }));
  });
});
