// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Phase 0.6 of v2.1 — verify the structured `expectedCalls` matcher.
 *
 * The legacy `expectedTools: string[]` matcher accepted any call with
 * the right tool name, so a phase declaring "call invoke_skill" passed
 * adherence even when the agent invoked the wrong skill. The new
 * `expectedCalls` field requires both tool and (optional) skillId for the
 * same tool name, while generic support tools can still be declared through
 * `expectedTools`.
 */

import { describe, it, expect } from '@jest/globals';
import { phaseMatchesCall, expectedToolNames, getPlanToolCapability, type PlanPhase } from '../types';

const basePhase: PlanPhase = {
  id: 'p1',
  name: 'test',
  goal: 'test',
  expectedTools: [],
  status: 'pending',
};

describe('phaseMatchesCall', () => {
  it('never lets a background knowledge read satisfy an evidence phase', () => {
    for (const tool of ['search_knowledge', 'read_knowledge_section']) {
      expect(getPlanToolCapability(`mcp__smartperfetto__${tool}`)).toBe('informational');
      expect(phaseMatchesCall(
        { ...basePhase, expectedTools: [tool] },
        { toolName: `mcp__smartperfetto__${tool}`, timestamp: 0 },
      )).toBe(false);
    }
  });

  it('matches by tool name when only expectedTools is set', () => {
    expect(phaseMatchesCall(
      { ...basePhase, expectedTools: ['execute_sql'] },
      { toolName: 'execute_sql', timestamp: 0 },
    )).toBe(true);
  });

  it('strips MCP prefix from record tool name', () => {
    expect(phaseMatchesCall(
      { ...basePhase, expectedTools: ['execute_sql'] },
      { toolName: 'mcp__smartperfetto__execute_sql', timestamp: 0 },
    )).toBe(true);
  });

  it('does not match when tool name differs', () => {
    expect(phaseMatchesCall(
      { ...basePhase, expectedTools: ['invoke_skill'] },
      { toolName: 'execute_sql', timestamp: 0 },
    )).toBe(false);
  });

  it('expectedCalls narrow same-tool skill calls while expectedTools allow support tools', () => {
    const phase: PlanPhase = {
      ...basePhase,
      expectedTools: ['invoke_skill', 'execute_sql'],
      expectedCalls: [{ tool: 'invoke_skill', skillId: 'foo' }],
    };
    expect(phaseMatchesCall(phase, { toolName: 'execute_sql', timestamp: 0 })).toBe(true);
    expect(phaseMatchesCall(phase, {
      toolName: 'invoke_skill',
      timestamp: 0,
      skillId: 'bar',
    })).toBe(false);
  });

  it('does not substitute support skills for an exact declared skill', () => {
    const phase: PlanPhase = {
      ...basePhase,
      expectedTools: ['invoke_skill'],
      expectedCalls: [{ tool: 'invoke_skill', skillId: 'flutter_scrolling_analysis' }],
    };
    expect(phaseMatchesCall(phase, {
      toolName: 'invoke_skill',
      timestamp: 0,
      skillId: 'process_identity_resolver',
    })).toBe(false);
    expect(phaseMatchesCall(phase, {
      toolName: 'invoke_skill',
      timestamp: 0,
      skillId: 'jank_frame_detail',
    })).toBe(false);
  });

  it('expectedCalls matches by tool + skillId together', () => {
    const phase: PlanPhase = {
      ...basePhase,
      expectedCalls: [{ tool: 'invoke_skill', skillId: 'startup_slow_reasons' }],
    };
    expect(phaseMatchesCall(phase, {
      toolName: 'invoke_skill',
      timestamp: 0,
      skillId: 'startup_slow_reasons',
    })).toBe(true);
    expect(phaseMatchesCall(phase, {
      toolName: 'invoke_skill',
      timestamp: 0,
      skillId: 'frame_overview',
    })).toBe(false);
  });

  it('expectedCalls without skillId accepts any invocation of that tool', () => {
    expect(phaseMatchesCall(
      { ...basePhase, expectedCalls: [{ tool: 'invoke_skill' }] },
      { toolName: 'invoke_skill', timestamp: 0, skillId: 'anything' },
    )).toBe(true);
  });

  it('multiple expectedCalls — any match passes', () => {
    const phase: PlanPhase = {
      ...basePhase,
      expectedCalls: [
        { tool: 'invoke_skill', skillId: 'a' },
        { tool: 'invoke_skill', skillId: 'b' },
      ],
    };
    expect(phaseMatchesCall(phase, {
      toolName: 'invoke_skill',
      timestamp: 0,
      skillId: 'b',
    })).toBe(true);
  });
});

describe('expectedToolNames', () => {
  it('falls back to expectedTools when expectedCalls is unset', () => {
    expect(expectedToolNames({
      ...basePhase,
      expectedTools: ['execute_sql', 'invoke_skill'],
    })).toEqual(['execute_sql', 'invoke_skill']);
  });

  it('renders structured calls plus generic support tools without broad duplicate tools', () => {
    expect(expectedToolNames({
      ...basePhase,
      expectedTools: ['invoke_skill', 'execute_sql', 'fetch_artifact'],
      expectedCalls: [
        { tool: 'invoke_skill', skillId: 'startup_slow_reasons' },
        { tool: 'execute_sql' },
      ],
    })).toEqual(['invoke_skill(startup_slow_reasons)', 'execute_sql', 'fetch_artifact']);
  });
});
