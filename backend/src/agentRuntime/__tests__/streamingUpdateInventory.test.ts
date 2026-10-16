// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it } from '@jest/globals';
import type { StreamingUpdate } from '../../agent/types';
import { shouldExposeLiveStreamingUpdate } from '../../cli-user/services/cliAnalyzeService';
import { SSE_EVENT_TYPES } from '../../types/dataContract';

const SSE_DATA_CONTRACT_STREAMING_EVENTS = [
  'data',
  'skill_data',
  'skill_layered_result',
  'finding',
  'progress',
  'conversation_step',
  'error',
  'thought',
  'tool_call',
  'answer_token',
  'answer_segment_reset',
  'conclusion',
  'scene_detected',
  'track_data',
  'worker_thought',
  'architecture_detected',
  'scene_story_detected',
  'scene_story_selection_ready',
  'scene_story_queued',
  'scene_story_started',
  'scene_story_retrying',
  'scene_story_completed',
  'scene_story_failed',
  'scene_story_cancelled',
  'scene_story_dropped',
  'scene_story_report_ready',
  'scene_story_smart_eta_refined',
] as const satisfies readonly StreamingUpdate['type'][];

function update(type: StreamingUpdate['type']): StreamingUpdate {
  return { type, content: {}, timestamp: 1 };
}

describe('StreamingUpdate public event inventory', () => {
  it('keeps DataContract SSE streaming names covered by StreamingUpdate', () => {
    expect(SSE_EVENT_TYPES).toEqual(expect.arrayContaining([
      ...SSE_DATA_CONTRACT_STREAMING_EVENTS,
      'analysis_completed',
      'snapshot_created',
    ]));
  });

  it('exposes tool calls to CLI live streams', () => {
    expect(shouldExposeLiveStreamingUpdate(update('tool_call'))).toBe(true);
  });
});
