// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it } from '@jest/globals';
import { resolveCaptureEntityKindByStepId } from '../entityRegistry';

describe('entityRegistry', () => {
  it('resolves capture entity kind by step id in exact mode', () => {
    expect(resolveCaptureEntityKindByStepId('get_app_jank_frames', 'exact')).toBe('frame');
    expect(resolveCaptureEntityKindByStepId('scroll_sessions', 'exact')).toBe('session');
    expect(resolveCaptureEntityKindByStepId('binder_calls', 'exact')).toBe('binder');
    expect(resolveCaptureEntityKindByStepId('unknown_step', 'exact')).toBeNull();
  });

  it('resolves capture entity kind by step id in contains mode', () => {
    expect(resolveCaptureEntityKindByStepId('scene_reconstruction:get_app_jank_frames', 'contains')).toBe('frame');
    expect(resolveCaptureEntityKindByStepId('abc:memory_events:v2', 'contains')).toBe('memory');
    expect(resolveCaptureEntityKindByStepId('other:step', 'contains')).toBeNull();
  });
});
