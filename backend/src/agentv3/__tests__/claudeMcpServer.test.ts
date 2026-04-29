// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * claudeMcpServer unit tests
 *
 * Tests MCP tool registration and key validation logic:
 * - Plan enforcement (P0-G10): execute_sql/invoke_skill require prior submit_plan
 * - submit_plan scene template validation
 * - Hypothesis lifecycle (submit → resolve)
 * - Analysis notes (write_analysis_note)
 * - write_analysis_note cap (20)
 * - flag_uncertainty (non-blocking)
 * - revise_plan (preserves completed phases)
 * - Tool count and allowedTools auto-derivation (P2-G1)
 *
 * The MCP server is tested by directly invoking tool handlers returned from
 * the SDK mock's `tool()` function.
 */

import { jest, describe, it, expect } from '@jest/globals';
import type { AnalysisPlanV3, AnalysisNote, Hypothesis, UncertaintyFlag } from '../types';

// ── Mock dependencies ────────────────────────────────────────────────────

// Mock modules that claudeMcpServer imports
jest.mock('../../services/skillEngine/skillAnalysisAdapter', () => ({
  getSkillAnalysisAdapter: jest.fn(() => ({
    adaptSkillResult: jest.fn((r: any) => r),
    listSkills: jest.fn(async () => [
      { id: 'scrolling_analysis', displayName: 'Scrolling Analysis', description: 'Analyze scrolling jank', type: 'composite', keywords: ['scroll', 'jank'] },
      { id: 'cpu_analysis', displayName: 'CPU Analysis', description: 'Analyze CPU usage', type: 'atomic', keywords: ['cpu'] },
    ]),
  })),
}));

jest.mock('../../agent/detectors/architectureDetector', () => ({
  createArchitectureDetector: jest.fn(() => ({
    detect: jest.fn(async () => ({ type: 'Standard', confidence: 0.9 })),
  })),
}));

jest.mock('../../services/skillEngine/skillLoader', () => ({
  skillRegistry: {
    getSkill: jest.fn(() => ({ type: 'atomic', name: 'test_skill' })),
    getAllSkills: jest.fn(() => [
      { name: 'scrolling_analysis', type: 'composite', description: 'Scrolling analysis' },
      { name: 'cpu_analysis', type: 'atomic', description: 'CPU analysis' },
    ]),
  },
}));

jest.mock('../artifactStore', () => ({
  ArtifactStore: jest.fn().mockImplementation(() => ({
    store: jest.fn(),
    get: jest.fn(() => null),
    list: jest.fn(() => []),
  })),
}));

jest.mock('../sqlSummarizer', () => ({
  summarizeSqlResult: jest.fn(() => ({
    totalRows: 10,
    columns: ['col1'],
    columnStats: {},
    sampleRows: [[1]],
  })),
}));

jest.mock('../analysisPatternMemory', () => ({
  matchPatterns: jest.fn(() => []),
  matchNegativePatterns: jest.fn(() => []),
  extractTraceFeatures: jest.fn(() => ['arch:Standard']),
}));

// Mock the schema index loading (it reads a JSON file at import time)
jest.mock('fs', () => {
  const actual = jest.requireActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: jest.fn((...args: unknown[]) => {
      const p = args[0] as string;
      if (typeof p === 'string' && p.includes('perfettoSqlIndex')) return false;
      if (typeof p === 'string' && p.includes('sql_learning')) return false;
      return (actual as any).existsSync(p);
    }),
    readFileSync: jest.fn((...args: unknown[]) => {
      const p = args[0] as string;
      if (typeof p === 'string' && p.includes('perfettoSqlIndex')) return '{"version":"1","generatedAt":"","templates":[]}';
      if (typeof p === 'string' && p.includes('sql_learning')) return '[]';
      return (actual as any).readFileSync(p, args[1]);
    }),
  };
});

import { createClaudeMcpServer, MCP_NAME_PREFIX, loadLearnedSqlFixPairs } from '../claudeMcpServer';
import { ArtifactStore } from '../artifactStore';

// ── Helpers ──────────────────────────────────────────────────────────────

type ToolDef = { name: string; handler: (...args: any[]) => any };

function createTestServer() {
  const analysisNotes: AnalysisNote[] = [];
  const hypotheses: Hypothesis[] = [];
  const uncertaintyFlags: UncertaintyFlag[] = [];
  const analysisPlan: { current: AnalysisPlanV3 | null } = { current: null };
  const watchdogWarning: { current: string | null } = { current: null };
  const emittedUpdates: any[] = [];

  const mockTpService = {
    query: jest.fn(async () => ({ columns: ['id'], rows: [[1]], rowCount: 1, durationMs: 5 })),
  };
  const mockSkillExecutor = {
    executeCompositeSkill: jest.fn(async () => ({
      success: true,
      displayResults: [{ display: { title: 'Result' }, data: { rows: [[1]], columns: ['a'] } }],
      layers: {},
    })),
    registerSkill: jest.fn(),
  };

  const { server, allowedTools } = createClaudeMcpServer({
    traceId: 'test-trace-123',
    traceProcessorService: mockTpService as any,
    skillExecutor: mockSkillExecutor as any,
    analysisNotes,
    hypotheses,
    uncertaintyFlags,
    analysisPlan,
    watchdogWarning,
    artifactStore: new ArtifactStore() as any,
    emitUpdate: (u: any) => emittedUpdates.push(u),
  });

  // Extract tool handlers from the mock SDK server
  const tools: Map<string, ToolDef> = new Map();
  if (server?.instance?.tools) {
    for (const t of server.instance.tools) {
      tools.set(t.name.replace(MCP_NAME_PREFIX, ''), t);
    }
  }

  return {
    tools,
    allowedTools,
    analysisNotes,
    hypotheses,
    uncertaintyFlags,
    analysisPlan,
    watchdogWarning,
    emittedUpdates,
    mockTpService,
    mockSkillExecutor,
  };
}

async function callTool(tools: Map<string, ToolDef>, name: string, params: Record<string, any> = {}): Promise<any> {
  const tool = tools.get(name);
  if (!tool) throw new Error(`Tool ${name} not found. Available: ${[...tools.keys()].join(', ')}`);
  const rawResult = await tool.handler(params);
  // MCP tool handlers return { content: [{ type: 'text', text: JSON.stringify(...) }] }
  if (rawResult && typeof rawResult === 'object' && Array.isArray(rawResult.content)) {
    const textEntry = rawResult.content.find((c: any) => c.type === 'text');
    if (textEntry?.text) {
      try { return JSON.parse(textEntry.text); } catch { return textEntry.text; }
    }
  }
  if (typeof rawResult === 'string') {
    try { return JSON.parse(rawResult); } catch { return rawResult; }
  }
  return rawResult;
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('createClaudeMcpServer', () => {
  describe('tool registration', () => {
    it('should register the full MCP toolset (range guard, not exact count)', () => {
      // Asserting an exact count breaks every time we add or retire a tool;
      // assert a sane range plus the must-have anchors so a regression that
      // *removes* a critical tool still fails loudly.
      const { tools } = createTestServer();
      expect(tools.size).toBeGreaterThanOrEqual(15);
      expect(tools.size).toBeLessThanOrEqual(25);
      for (const required of ['execute_sql', 'invoke_skill', 'lookup_sql_schema', 'submit_plan']) {
        expect(tools.has(required)).toBe(true);
      }
    });

    it('should auto-derive allowedTools matching registered tools (P2-G1)', () => {
      const { tools, allowedTools } = createTestServer();
      // Every tool should have a matching allowedTools entry (with prefix)
      for (const name of tools.keys()) {
        const prefixed = MCP_NAME_PREFIX + name;
        expect(allowedTools).toContain(prefixed);
      }
      expect(allowedTools.length).toBe(tools.size);
    });

    it('should register all expected tools', () => {
      const { tools } = createTestServer();
      const expected = [
        'execute_sql', 'invoke_skill', 'list_skills', 'detect_architecture',
        'lookup_sql_schema', 'submit_plan', 'update_plan_phase', 'revise_plan',
        'submit_hypothesis', 'resolve_hypothesis', 'write_analysis_note',
        'fetch_artifact', 'query_perfetto_source', 'flag_uncertainty', 'recall_patterns',
      ];
      for (const name of expected) {
        expect(tools.has(name)).toBe(true);
      }
    });
  });

  describe('plan enforcement (P0-G10)', () => {
    it('execute_sql should require plan', async () => {
      const { tools } = createTestServer();
      const result = await callTool(tools, 'execute_sql', { sql: 'SELECT 1' });
      expect(result.error || result.message || '').toMatch(/submit_plan|计划/i);
    });

    it('invoke_skill should require plan', async () => {
      const { tools } = createTestServer();
      const result = await callTool(tools, 'invoke_skill', { skillId: 'scrolling_analysis' });
      expect(result.error || result.message || '').toMatch(/submit_plan|计划/i);
    });

    it('execute_sql should work after plan is submitted', async () => {
      const { tools, analysisPlan } = createTestServer();
      // Submit plan first
      await callTool(tools, 'submit_plan', {
        phases: [{ id: 'p1', name: 'Test', goal: 'Test', expectedTools: ['execute_sql'] }],
        successCriteria: 'Test done',
      });
      expect(analysisPlan.current).not.toBeNull();

      // Now execute_sql should work
      const result = await callTool(tools, 'execute_sql', { sql: 'SELECT 1' });
      expect(result.error).toBeUndefined();
    });

    it('planning-exempt tools should work without plan', async () => {
      const { tools } = createTestServer();
      // These should NOT require a plan
      const listResult = await callTool(tools, 'list_skills', {});
      expect(listResult).toBeDefined();
      // list_skills returns an array of skill objects
      expect(Array.isArray(listResult)).toBe(true);
      expect(listResult.length).toBeGreaterThan(0);
    });
  });

  describe('submit_plan', () => {
    it('should create a plan with phases', async () => {
      const { tools, analysisPlan } = createTestServer();
      const result = await callTool(tools, 'submit_plan', {
        phases: [
          { id: 'p1', name: 'Collect', goal: 'Get frame data', expectedTools: ['execute_sql'] },
          { id: 'p2', name: 'Analyze', goal: 'Find root cause', expectedTools: ['invoke_skill'] },
        ],
        successCriteria: 'Identify jank root cause',
      });
      expect(result.success).toBe(true);
      expect(analysisPlan.current?.phases).toHaveLength(2);
      expect(analysisPlan.current?.successCriteria).toBe('Identify jank root cause');
    });
  });

  describe('hypothesis lifecycle (P0-G4)', () => {
    it('should submit a hypothesis', async () => {
      const { tools, hypotheses } = createTestServer();
      const result = await callTool(tools, 'submit_hypothesis', {
        statement: 'RenderThread blocked by Binder call',
        reasoning: 'Observed 50ms gap in frame rendering',
      });
      expect(result.success || result.id).toBeTruthy();
      expect(hypotheses).toHaveLength(1);
      expect(hypotheses[0].status).toBe('formed');
      expect(hypotheses[0].statement).toBe('RenderThread blocked by Binder call');
    });

    it('should resolve a hypothesis as confirmed', async () => {
      const { tools, hypotheses } = createTestServer();
      await callTool(tools, 'submit_hypothesis', { statement: 'Test hypothesis' });
      const hId = hypotheses[0].id;

      const result = await callTool(tools, 'resolve_hypothesis', {
        hypothesisId: hId,
        status: 'confirmed',
        evidence: 'Binder latency confirmed at 45ms',
      });
      expect(result.success).toBe(true);
      expect(hypotheses[0].status).toBe('confirmed');
    });

    it('should resolve a hypothesis as rejected', async () => {
      const { tools, hypotheses } = createTestServer();
      await callTool(tools, 'submit_hypothesis', { statement: 'Memory pressure' });
      const hId = hypotheses[0].id;

      await callTool(tools, 'resolve_hypothesis', {
        hypothesisId: hId,
        status: 'rejected',
        evidence: 'Memory usage normal at 200MB',
      });
      expect(hypotheses[0].status).toBe('rejected');
    });

    it('should reject resolving non-existent hypothesis', async () => {
      const { tools } = createTestServer();
      const result = await callTool(tools, 'resolve_hypothesis', {
        hypothesisId: 'non-existent',
        status: 'confirmed',
      });
      expect(result.error || result.message || '').toContain('non-existent');
    });
  });

  describe('write_analysis_note', () => {
    it('should add a note', async () => {
      const { tools, analysisNotes } = createTestServer();
      const result = await callTool(tools, 'write_analysis_note', {
        section: 'finding',
        content: 'RenderThread is consistently blocked for >16ms in jank frames',
        priority: 'high',
      });
      expect(result.success).toBe(true);
      expect(analysisNotes).toHaveLength(1);
      expect(analysisNotes[0].section).toBe('finding');
      expect(analysisNotes[0].priority).toBe('high');
    });

    it('should evict lowest-priority note when exceeding cap of 20', async () => {
      const { tools, analysisNotes } = createTestServer();
      // Pre-fill 20 notes: 19 low + 1 medium
      for (let i = 0; i < 19; i++) {
        analysisNotes.push({
          section: 'observation',
          content: `Low note ${i} content is at least ten chars`,
          priority: 'low',
          timestamp: Date.now() - (20 - i) * 1000, // older first
        });
      }
      analysisNotes.push({
        section: 'finding',
        content: 'Medium priority note should survive eviction',
        priority: 'medium',
        timestamp: Date.now(),
      });
      // Adding 21st note should trigger eviction of oldest low-priority note
      const result = await callTool(tools, 'write_analysis_note', {
        section: 'finding',
        content: 'High priority new note added over cap',
        priority: 'high',
      });
      expect(result.success).toBe(true);
      // Should still have exactly 20 after eviction
      expect(analysisNotes).toHaveLength(20);
      // The new high-priority note should be present
      expect(analysisNotes.some(n => n.content.includes('High priority new note'))).toBe(true);
      // The medium-priority note should survive (low-priority evicted first)
      expect(analysisNotes.some(n => n.content.includes('Medium priority'))).toBe(true);
    });
  });

  describe('flag_uncertainty (P1-G1)', () => {
    it('should add uncertainty flag and emit SSE', async () => {
      const { tools, uncertaintyFlags, emittedUpdates } = createTestServer();
      const result = await callTool(tools, 'flag_uncertainty', {
        topic: 'VRR support',
        assumption: 'Assuming device does not support VRR',
        question: 'Does this device support variable refresh rate?',
      });
      expect(result.success).toBe(true);
      expect(uncertaintyFlags).toHaveLength(1);
      expect(uncertaintyFlags[0].topic).toBe('VRR support');
      // Should emit progress SSE
      expect(emittedUpdates.some((u: any) => u.type === 'progress')).toBe(true);
    });
  });

  describe('revise_plan (P1-3)', () => {
    it('should allow revising a plan', async () => {
      const { tools, analysisPlan } = createTestServer();
      // Submit initial plan
      await callTool(tools, 'submit_plan', {
        phases: [
          { id: 'p1', name: 'Phase 1', goal: 'G1', expectedTools: ['execute_sql'] },
        ],
        successCriteria: 'Done',
      });
      // Mark phase 1 as completed
      await callTool(tools, 'update_plan_phase', {
        phaseId: 'p1',
        status: 'completed',
        summary: 'Phase 1 done',
      });

      // Revise plan with new phase
      const result = await callTool(tools, 'revise_plan', {
        updatedPhases: [
          { id: 'p1', name: 'Phase 1', goal: 'G1', expectedTools: ['execute_sql'], status: 'completed' },
          { id: 'p2', name: 'Phase 2', goal: 'G2', expectedTools: ['invoke_skill'] },
        ],
        reason: 'Discovered new data requiring additional analysis',
      });
      expect(result.success).toBe(true);
      expect(analysisPlan.current?.phases).toHaveLength(2);
      expect(analysisPlan.current?.revisionHistory).toHaveLength(1);
    });
  });
});

describe('loadLearnedSqlFixPairs', () => {
  it('should return empty array when no file', () => {
    const pairs = loadLearnedSqlFixPairs();
    expect(pairs).toEqual([]);
  });
});