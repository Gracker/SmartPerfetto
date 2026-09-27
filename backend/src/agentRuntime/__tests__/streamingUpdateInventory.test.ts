// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it } from '@jest/globals';
import type { StreamingUpdate } from '../../agent/types';
import { shouldExposeLiveStreamingUpdate } from '../../cli-user/services/cliAnalyzeService';
import { SSE_EVENT_TYPES } from '../../types/dataContract';

const STREAMING_UPDATE_TYPES = [
  'data',
  'thought',
  'tool_call',
  'finding',
  'progress',
  'answer_token',
  'answer_segment_reset',
  'conclusion',
  'error',
  'scene_detected',
  'track_data',
  'skill_layered_result',
  'worker_thought',
  'architecture_detected',
  'conversation_step',
  'hypothesis_generated',
  'agent_task_dispatched',
  'agent_dialogue',
  'agent_response',
  'round_start',
  'synthesis_complete',
  'strategy_decision',
  'degraded',
  'stage_transition',
  'circuit_breaker',
  'strategy_selected',
  'strategy_fallback',
  'sql_generated',
  'sql_validation_failed',
  'focus_updated',
  'incremental_scope',
  'sub_agent_started',
  'sub_agent_completed',
  'plan_submitted',
  'plan_phase_updated',
  'plan_revised',
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
  'skill_data',
] as const satisfies readonly StreamingUpdate['type'][];

const ROUTE_SYNTHESIZED_TERMINAL_EVENTS = [
  'analysis_completed',
  'end',
] as const;

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
  it('documents every current StreamingUpdate type before runtime event refactors', () => {
    expect(STREAMING_UPDATE_TYPES).toEqual([
      'data',
      'thought',
      'tool_call',
      'finding',
      'progress',
      'answer_token',
      'answer_segment_reset',
      'conclusion',
      'error',
      'scene_detected',
      'track_data',
      'skill_layered_result',
      'worker_thought',
      'architecture_detected',
      'conversation_step',
      'hypothesis_generated',
      'agent_task_dispatched',
      'agent_dialogue',
      'agent_response',
      'round_start',
      'synthesis_complete',
      'strategy_decision',
      'degraded',
      'stage_transition',
      'circuit_breaker',
      'strategy_selected',
      'strategy_fallback',
      'sql_generated',
      'sql_validation_failed',
      'focus_updated',
      'incremental_scope',
      'sub_agent_started',
      'sub_agent_completed',
      'plan_submitted',
      'plan_phase_updated',
      'plan_revised',
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
      'skill_data',
    ]);
  });

  it('keeps route-synthesized terminal events separate from native runtime updates', () => {
    expect(ROUTE_SYNTHESIZED_TERMINAL_EVENTS).toEqual([
      'analysis_completed',
      'end',
    ]);
    expect(STREAMING_UPDATE_TYPES).not.toContain('analysis_completed' as StreamingUpdate['type']);
    expect(STREAMING_UPDATE_TYPES).not.toContain('end' as StreamingUpdate['type']);
  });

  it('keeps DataContract SSE streaming names covered by StreamingUpdate', () => {
    expect(SSE_EVENT_TYPES).toEqual(expect.arrayContaining([
      ...SSE_DATA_CONTRACT_STREAMING_EVENTS,
      'analysis_completed',
      'snapshot_created',
    ]));
    expect(STREAMING_UPDATE_TYPES).toEqual(
      expect.arrayContaining([...SSE_DATA_CONTRACT_STREAMING_EVENTS]),
    );
  });

  it('documents CLI live-stream filtering for final-answer events', () => {
    expect(shouldExposeLiveStreamingUpdate(update('conclusion'))).toBe(false);
    expect(shouldExposeLiveStreamingUpdate(update('answer_token'))).toBe(false);
    expect(shouldExposeLiveStreamingUpdate(update('answer_segment_reset'))).toBe(false);
    expect(shouldExposeLiveStreamingUpdate(update('tool_call'))).toBe(true);
    expect(shouldExposeLiveStreamingUpdate(update('data'))).toBe(true);
  });
});
