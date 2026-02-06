/**
 * DirectSkillExecutor Unit Tests
 *
 * Tests for direct skill execution without the LLM loop.
 * Key responsibilities:
 * - Direct skill invocation (bypasses LLM)
 * - Parameter mapping from task to skill
 * - Result formatting as findings
 * - Entity capture from skill results
 */

import { DirectSkillExecutor } from '../directSkillExecutor';
import type { DirectSkillTask, FocusInterval, StageTaskTemplate } from '../../../strategies/types';
import type { ProgressEmitter } from '../../orchestratorTypes';
import type { SkillExecutionResult, DiagnosticResult, DisplayResult } from '../../../../services/skillEngine/types';

// =============================================================================
// Mocks
// =============================================================================

// Mock skillLoader module
const mockGetAllSkills = jest.fn();
const mockEnsureSkillRegistryInitialized = jest.fn().mockResolvedValue(undefined);

jest.mock('../../../../services/skillEngine/skillLoader', () => ({
  skillRegistry: {
    getAllSkills: () => mockGetAllSkills(),
  },
  ensureSkillRegistryInitialized: () => mockEnsureSkillRegistryInitialized(),
}));

// Mock SkillExecutor
const mockExecute = jest.fn();
const mockRegisterSkills = jest.fn();

jest.mock('../../../../services/skillEngine/skillExecutor', () => ({
  createSkillExecutor: jest.fn(() => ({
    execute: mockExecute,
    registerSkills: mockRegisterSkills,
  })),
  SkillExecutor: class {
    execute = mockExecute;
    registerSkills = mockRegisterSkills;
  },
}));

// Mock dataContract
jest.mock('../../../../types/dataContract', () => ({
  displayResultToEnvelope: jest.fn((dr, skillId) => ({
    meta: { type: 'skill_result', version: '2.0', source: `${skillId}:${dr.stepId}` },
    data: dr.data,
    display: { layer: dr.layer || 'list', format: dr.format, title: dr.title },
  })),
}));

// =============================================================================
// Test Helpers
// =============================================================================

function createMockEmitter(): ProgressEmitter {
  return {
    emitUpdate: jest.fn(),
    log: jest.fn(),
  };
}

function createMockTraceProcessorService() {
  return {
    query: jest.fn(),
  };
}

function createMockAIService() {
  return {
    chat: jest.fn(),
    callWithFallback: jest.fn(),
  };
}

function createFocusInterval(overrides: Partial<FocusInterval> = {}): FocusInterval {
  return {
    id: 0,
    processName: 'com.example.app',
    startTs: '1000000000000',
    endTs: '2000000000000',
    priority: 1,
    label: 'Test Interval',
    metadata: {},
    ...overrides,
  };
}

function createStageTaskTemplate(overrides: Partial<StageTaskTemplate> = {}): StageTaskTemplate {
  return {
    agentId: 'frame_agent',
    domain: 'frame',
    scope: 'per_interval',
    descriptionTemplate: 'Analyze {{scopeLabel}}',
    executionMode: 'direct_skill',
    directSkillId: 'jank_frame_detail',
    ...overrides,
  };
}

function createDirectSkillTask(
  templateOverrides: Partial<StageTaskTemplate> = {},
  intervalOverrides: Partial<FocusInterval> = {}
): DirectSkillTask {
  return {
    template: createStageTaskTemplate(templateOverrides),
    interval: createFocusInterval(intervalOverrides),
    scopeLabel: 'Frame 1436069',
  };
}

function createMockSkillResult(overrides: Partial<SkillExecutionResult> = {}): SkillExecutionResult {
  return {
    skillId: 'jank_frame_detail',
    skillName: 'Jank Frame Detail',
    success: true,
    displayResults: [],
    diagnostics: [],
    executionTimeMs: 100,
    rawResults: {},
    ...overrides,
  };
}

function createMockDiagnostic(overrides: Partial<DiagnosticResult> = {}): DiagnosticResult {
  return {
    id: 'diag_1',
    diagnosis: 'CPU Intensive work detected',
    confidence: 0.85,
    severity: 'warning',
    evidence: { cpu_load: 95 },
    suggestions: ['Optimize render thread work', 'Consider offloading to background thread'],
    source: 'rule',
    ...overrides,
  };
}

function createMockDisplayResult(overrides: Partial<DisplayResult> = {}): DisplayResult {
  return {
    stepId: 'frame_metrics',
    title: 'Frame Metrics',
    level: 'detail',
    layer: 'list',
    format: 'table',
    data: {
      columns: ['frame_id', 'dur_ms', 'jank_type'],
      rows: [[1436069, 45.5, 'App Deadline Missed']],
    },
    ...overrides,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('DirectSkillExecutor', () => {
  let executor: DirectSkillExecutor;
  let mockTPS: ReturnType<typeof createMockTraceProcessorService>;
  let mockAI: ReturnType<typeof createMockAIService>;
  let emitter: ProgressEmitter;

  beforeEach(() => {
    jest.clearAllMocks();

    mockTPS = createMockTraceProcessorService();
    mockAI = createMockAIService();
    emitter = createMockEmitter();

    mockGetAllSkills.mockReturnValue([]);
    mockEnsureSkillRegistryInitialized.mockResolvedValue(undefined);

    executor = new DirectSkillExecutor(mockTPS, mockAI, 'trace_123', 6);
  });

  // ===========================================================================
  // Basic Execution
  // ===========================================================================

  describe('Basic Execution', () => {
    test('executes skill directly without LLM', async () => {
      const task = createDirectSkillTask();
      const skillResult = createMockSkillResult();
      mockExecute.mockResolvedValue(skillResult);

      const responses = await executor.executeTasks([task], emitter);

      expect(responses).toHaveLength(1);
      expect(responses[0].success).toBe(true);
      expect(responses[0].agentId).toBe('frame_agent');
      expect(mockExecute).toHaveBeenCalledWith('jank_frame_detail', 'trace_123', expect.any(Object));
    });

    test('returns skill results as findings', async () => {
      const task = createDirectSkillTask();
      const diagnostic = createMockDiagnostic({
        diagnosis: 'RenderThread blocked',
        severity: 'critical',
      });
      const skillResult = createMockSkillResult({
        diagnostics: [diagnostic],
      });
      mockExecute.mockResolvedValue(skillResult);

      const responses = await executor.executeTasks([task], emitter);

      expect(responses[0].findings).toHaveLength(1);
      expect(responses[0].findings[0].title).toContain('RenderThread blocked');
      expect(responses[0].findings[0].severity).toBe('critical');
    });

    test('includes skill metadata in response', async () => {
      const task = createDirectSkillTask();
      const skillResult = createMockSkillResult({
        skillId: 'jank_frame_detail',
        executionTimeMs: 150,
      });
      mockExecute.mockResolvedValue(skillResult);

      const responses = await executor.executeTasks([task], emitter);

      expect(responses[0].toolResults).toHaveLength(1);
      expect(responses[0].toolResults![0].metadata).toMatchObject({
        kind: 'skill',
        skillId: 'jank_frame_detail',
        executionMode: 'direct_skill',
      });
    });

    test('returns empty array for empty task list', async () => {
      const responses = await executor.executeTasks([], emitter);
      expect(responses).toEqual([]);
      expect(mockExecute).not.toHaveBeenCalled();
    });

    test('ensures skill registry is initialized', async () => {
      const task = createDirectSkillTask();
      mockExecute.mockResolvedValue(createMockSkillResult());

      await executor.executeTasks([task], emitter);

      expect(mockEnsureSkillRegistryInitialized).toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Parameter Mapping
  // ===========================================================================

  describe('Parameter Mapping', () => {
    test('maps task params to skill inputs with default mapping', async () => {
      const interval = createFocusInterval({
        startTs: '1234567890000000',
        endTs: '1234567990000000',
        processName: 'com.example.app',
      });
      const task = createDirectSkillTask({}, { ...interval });
      mockExecute.mockResolvedValue(createMockSkillResult());

      await executor.executeTasks([task], emitter);

      expect(mockExecute).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.objectContaining({
          start_ts: '1234567890000000',
          end_ts: '1234567990000000',
          package: 'com.example.app',
        })
      );
    });

    test('uses explicit paramMapping when defined', async () => {
      const interval = createFocusInterval({
        metadata: {
          frameId: 1436069,
          sessionId: 5,
        },
      });
      const task = createDirectSkillTask(
        {
          paramMapping: {
            frame_id: 'frameId',
            session_id: 'sessionId',
            start_timestamp: 'startTs',
          },
        },
        { ...interval }
      );
      mockExecute.mockResolvedValue(createMockSkillResult());

      await executor.executeTasks([task], emitter);

      expect(mockExecute).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.objectContaining({
          frame_id: 1436069,
          session_id: 5,
          start_timestamp: interval.startTs,
        })
      );
    });

    test('handles missing optional params gracefully', async () => {
      const interval = createFocusInterval({
        processName: '', // Empty process name
        metadata: {},
      });
      const task = createDirectSkillTask({}, { ...interval });
      mockExecute.mockResolvedValue(createMockSkillResult());

      await executor.executeTasks([task], emitter);

      // Should not throw and should call execute
      expect(mockExecute).toHaveBeenCalled();
    });

    test('merges skillParams from template', async () => {
      const task = createDirectSkillTask({
        skillParams: {
          max_frames: 10,
          include_gpu: true,
        },
      });
      mockExecute.mockResolvedValue(createMockSkillResult());

      await executor.executeTasks([task], emitter);

      expect(mockExecute).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.objectContaining({
          max_frames: 10,
          include_gpu: true,
        })
      );
    });

    test('handles snake_case to camelCase key variations in metadata', async () => {
      const interval = createFocusInterval({
        metadata: {
          frame_id: 1436069, // snake_case
        },
      });
      const task = createDirectSkillTask(
        {
          paramMapping: {
            frame: 'frameId', // Looking for camelCase
          },
        },
        { ...interval }
      );
      mockExecute.mockResolvedValue(createMockSkillResult());

      await executor.executeTasks([task], emitter);

      // Should find frame_id when looking for frameId
      expect(mockExecute).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.objectContaining({
          frame: 1436069,
        })
      );
    });

    test('computes duration from interval timestamps', async () => {
      const interval = createFocusInterval({
        startTs: '1000000000000',
        endTs: '2000000000000',
      });
      const task = createDirectSkillTask(
        {
          paramMapping: {
            frame_duration: 'duration',
          },
        },
        { ...interval }
      );
      mockExecute.mockResolvedValue(createMockSkillResult());

      await executor.executeTasks([task], emitter);

      expect(mockExecute).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.objectContaining({
          frame_duration: '1000000000000', // Duration computed
        })
      );
    });

    test('normalizes timestamps to strings', async () => {
      const task = createDirectSkillTask();
      mockExecute.mockResolvedValue(createMockSkillResult());

      await executor.executeTasks([task], emitter);

      const callArgs = mockExecute.mock.calls[0][2];
      expect(typeof callArgs.start_ts).toBe('string');
      expect(typeof callArgs.end_ts).toBe('string');
    });

    test('adds time_range_start/end in seconds for legacy skills', async () => {
      // 1e9 nanoseconds = 1 second
      // 10e9 ns = 10 seconds, 20e9 ns = 20 seconds
      const interval = createFocusInterval({
        startTs: '10000000000', // 10 seconds in ns (10 * 1e9)
        endTs: '20000000000', // 20 seconds in ns (20 * 1e9)
      });
      const task = createDirectSkillTask({}, { ...interval });
      mockExecute.mockResolvedValue(createMockSkillResult());

      await executor.executeTasks([task], emitter);

      const callArgs = mockExecute.mock.calls[0][2];
      // Division by 1e9 converts ns to seconds
      expect(callArgs.time_range_start).toBe('10');
      expect(callArgs.time_range_end).toBe('20');
    });
  });

  // ===========================================================================
  // Result Formatting
  // ===========================================================================

  describe('Result Formatting', () => {
    test('converts skill data to findings', async () => {
      const diagnostic = createMockDiagnostic({
        id: 'diag_cpu',
        diagnosis: 'High CPU load on main thread',
        severity: 'warning',
        confidence: 0.9,
        suggestions: ['Optimize heavy calculations'],
      });
      const task = createDirectSkillTask();
      mockExecute.mockResolvedValue(
        createMockSkillResult({
          diagnostics: [diagnostic],
        })
      );

      const responses = await executor.executeTasks([task], emitter);

      const finding = responses[0].findings[0];
      expect(finding.category).toBe('frame');
      expect(finding.type).toBe('root_cause');
      expect(finding.severity).toBe('warning');
      expect(finding.title).toContain('High CPU load');
      expect(finding.description).toContain('Optimize heavy calculations');
    });

    test('sets appropriate severity levels from diagnostics', async () => {
      const tasks = [
        createDirectSkillTask({ directSkillId: 'skill_1' }),
        createDirectSkillTask({ directSkillId: 'skill_2' }),
        createDirectSkillTask({ directSkillId: 'skill_3' }),
      ];

      mockExecute
        .mockResolvedValueOnce(
          createMockSkillResult({
            diagnostics: [createMockDiagnostic({ severity: 'info' })],
          })
        )
        .mockResolvedValueOnce(
          createMockSkillResult({
            diagnostics: [createMockDiagnostic({ severity: 'warning' })],
          })
        )
        .mockResolvedValueOnce(
          createMockSkillResult({
            diagnostics: [createMockDiagnostic({ severity: 'critical' })],
          })
        );

      const responses = await executor.executeTasks(tasks, emitter);

      expect(responses[0].findings[0].severity).toBe('info');
      expect(responses[1].findings[0].severity).toBe('warning');
      expect(responses[2].findings[0].severity).toBe('critical');
    });

    test('includes source skill ID in findings', async () => {
      const task = createDirectSkillTask({
        directSkillId: 'my_custom_skill',
      });
      mockExecute.mockResolvedValue(
        createMockSkillResult({
          skillId: 'my_custom_skill',
          diagnostics: [createMockDiagnostic()],
        })
      );

      const responses = await executor.executeTasks([task], emitter);

      expect(responses[0].findings[0].source).toBe('direct_skill:my_custom_skill');
    });

    test('creates info finding from AI summary when no diagnostics', async () => {
      const task = createDirectSkillTask();
      mockExecute.mockResolvedValue(
        createMockSkillResult({
          diagnostics: [],
          aiSummary: 'Frame rendered within budget, no issues detected.',
        })
      );

      const responses = await executor.executeTasks([task], emitter);

      expect(responses[0].findings).toHaveLength(1);
      expect(responses[0].findings[0].severity).toBe('info');
      expect(responses[0].findings[0].description).toContain('Frame rendered within budget');
    });

    test('builds DataEnvelopes from displayResults', async () => {
      const displayResult = createMockDisplayResult();
      const task = createDirectSkillTask();
      mockExecute.mockResolvedValue(
        createMockSkillResult({
          displayResults: [displayResult],
        })
      );

      const responses = await executor.executeTasks([task], emitter);

      expect(responses[0].toolResults![0].dataEnvelopes).toHaveLength(1);
    });
  });

  // ===========================================================================
  // Entity Capture (root_cause enrichment)
  // ===========================================================================

  describe('Entity Capture', () => {
    test('enriches findings with root_cause data from rawResults', async () => {
      const task = createDirectSkillTask();
      mockExecute.mockResolvedValue(
        createMockSkillResult({
          diagnostics: [createMockDiagnostic()],
          rawResults: {
            root_cause: {
              stepId: 'root_cause',
              stepType: 'diagnostic',
              success: true,
              data: [
                {
                  cause_type: 'CPU_INTENSIVE',
                  primary_cause: 'Expensive measure/layout pass',
                  secondary_info: 'View hierarchy too deep',
                  confidence: 0.92,
                  frame_dur_ms: 45.5,
                  jank_type: 'App Deadline Missed',
                },
              ],
              executionTimeMs: 50,
            },
          },
        })
      );

      const responses = await executor.executeTasks([task], emitter);

      const finding = responses[0].findings[0];
      expect(finding.details).toBeDefined();
      expect(finding.details!.cause_type).toBe('CPU_INTENSIVE');
      expect(finding.details!.primary_cause).toBe('Expensive measure/layout pass');
      expect(finding.details!.frame_dur_ms).toBe(45.5);
    });

    test('enriches findings when root_cause is under root_cause_summary step key', async () => {
      const task = createDirectSkillTask();
      mockExecute.mockResolvedValue(
        createMockSkillResult({
          diagnostics: [createMockDiagnostic()],
          rawResults: {
            root_cause_summary: {
              stepId: 'root_cause_summary',
              stepType: 'atomic',
              success: true,
              data: [
                {
                  cause_type: 'SF_BUFFER_STUFFING',
                  primary_cause: 'Buffer Stuffing dominates consumer jank',
                  secondary_info: 'SF queue pressure',
                  confidence: 'high',
                  frame_dur_ms: 19.2,
                  jank_type: 'Buffer Stuffing',
                },
              ],
              executionTimeMs: 20,
            },
          },
        })
      );

      const responses = await executor.executeTasks([task], emitter);

      const finding = responses[0].findings[0];
      expect(finding.details).toBeDefined();
      expect(finding.details!.cause_type).toBe('SF_BUFFER_STUFFING');
      expect(finding.details!.primary_cause).toContain('Buffer Stuffing');
      expect(finding.details!.jank_type).toBe('Buffer Stuffing');
    });

    test('handles columnar format for root_cause data', async () => {
      const task = createDirectSkillTask();
      mockExecute.mockResolvedValue(
        createMockSkillResult({
          diagnostics: [createMockDiagnostic()],
          rawResults: {
            root_cause: {
              stepId: 'root_cause',
              stepType: 'diagnostic',
              success: true,
              data: {
                columns: ['cause_type', 'primary_cause', 'confidence'],
                rows: [['GPU_BOUND', 'Complex shader operations', 0.88]],
              },
              executionTimeMs: 50,
            },
          },
        })
      );

      const responses = await executor.executeTasks([task], emitter);

      const finding = responses[0].findings[0];
      expect(finding.details!.cause_type).toBe('GPU_BOUND');
      expect(finding.details!.primary_cause).toBe('Complex shader operations');
      expect(finding.details!.confidence_level).toBe(0.88);
    });

    test('handles single object format for root_cause', async () => {
      const task = createDirectSkillTask();
      mockExecute.mockResolvedValue(
        createMockSkillResult({
          diagnostics: [createMockDiagnostic()],
          rawResults: {
            root_cause: {
              stepId: 'root_cause',
              stepType: 'diagnostic',
              success: true,
              data: {
                cause_type: 'BINDER_BLOCKING',
                primary_cause: 'IPC call to system_server',
              },
              executionTimeMs: 50,
            },
          },
        })
      );

      const responses = await executor.executeTasks([task], emitter);

      const finding = responses[0].findings[0];
      expect(finding.details!.cause_type).toBe('BINDER_BLOCKING');
    });

    test('handles missing root_cause in rawResults gracefully', async () => {
      const task = createDirectSkillTask();
      mockExecute.mockResolvedValue(
        createMockSkillResult({
          diagnostics: [createMockDiagnostic()],
          rawResults: {
            some_other_step: {
              stepId: 'some_other_step',
              stepType: 'atomic',
              success: true,
              data: {},
              executionTimeMs: 10,
            },
          },
        })
      );

      const responses = await executor.executeTasks([task], emitter);

      // Should not throw and findings should still be present
      expect(responses[0].findings).toHaveLength(1);
      expect(responses[0].findings[0].details).toBeUndefined();
    });
  });

  // ===========================================================================
  // Error Handling
  // ===========================================================================

  describe('Error Handling', () => {
    test('returns error finding on skill failure', async () => {
      const task = createDirectSkillTask();
      mockExecute.mockResolvedValue(
        createMockSkillResult({
          success: false,
          error: 'SQL execution failed',
        })
      );

      const responses = await executor.executeTasks([task], emitter);

      expect(responses[0].success).toBe(false);
      expect(responses[0].confidence).toBe(0.2); // Low confidence for failures
    });

    test('handles missing skill gracefully', async () => {
      const task = createDirectSkillTask({
        directSkillId: undefined,
      });

      const responses = await executor.executeTasks([task], emitter);

      expect(responses[0].success).toBe(false);
      expect(responses[0].toolResults![0].error).toContain('No directSkillId specified');
    });

    test('handles SQL execution errors', async () => {
      const task = createDirectSkillTask();
      mockExecute.mockRejectedValue(new Error('Database connection lost'));

      const responses = await executor.executeTasks([task], emitter);

      expect(responses[0].success).toBe(false);
      expect(responses[0].toolResults![0].error).toBe('Database connection lost');
      expect(responses[0].toolResults![0].metadata?.skillId).toBe('jank_frame_detail');
    });

    test('includes scope label in error response metadata', async () => {
      const task = createDirectSkillTask();
      task.scopeLabel = 'Frame 1436069 (Session 5)';
      mockExecute.mockRejectedValue(new Error('Timeout'));

      const responses = await executor.executeTasks([task], emitter);

      expect(responses[0].toolResults![0].metadata?.scopeLabel).toBe('Frame 1436069 (Session 5)');
    });

    test('includes time range in error response metadata', async () => {
      const task = createDirectSkillTask(
        {},
        {
          startTs: '1000000',
          endTs: '2000000',
        }
      );
      mockExecute.mockRejectedValue(new Error('Execution failed'));

      const responses = await executor.executeTasks([task], emitter);

      expect(responses[0].toolResults![0].metadata?.timeRange).toEqual({
        start: '1000000',
        end: '2000000',
      });
    });
  });

  // ===========================================================================
  // Multiple Tasks
  // ===========================================================================

  describe('Multiple Tasks', () => {
    test('executes multiple tasks in sequence within concurrency limit', async () => {
      const tasks = [
        createDirectSkillTask({ directSkillId: 'skill_1' }),
        createDirectSkillTask({ directSkillId: 'skill_2' }),
        createDirectSkillTask({ directSkillId: 'skill_3' }),
      ];

      mockExecute
        .mockResolvedValueOnce(createMockSkillResult({ skillId: 'skill_1' }))
        .mockResolvedValueOnce(createMockSkillResult({ skillId: 'skill_2' }))
        .mockResolvedValueOnce(createMockSkillResult({ skillId: 'skill_3' }));

      const responses = await executor.executeTasks(tasks, emitter);

      expect(responses).toHaveLength(3);
      expect(mockExecute).toHaveBeenCalledTimes(3);
    });

    test('aggregates results from all tasks', async () => {
      const tasks = [
        createDirectSkillTask({ domain: 'frame' }),
        createDirectSkillTask({ domain: 'cpu' }),
      ];

      mockExecute
        .mockResolvedValueOnce(
          createMockSkillResult({
            diagnostics: [createMockDiagnostic({ diagnosis: 'Frame issue' })],
          })
        )
        .mockResolvedValueOnce(
          createMockSkillResult({
            diagnostics: [createMockDiagnostic({ diagnosis: 'CPU issue' })],
          })
        );

      const responses = await executor.executeTasks(tasks, emitter);

      expect(responses[0].findings[0].title).toContain('Frame issue');
      expect(responses[1].findings[0].title).toContain('CPU issue');
    });

    test('continues execution when some tasks fail', async () => {
      const tasks = [
        createDirectSkillTask({ directSkillId: 'skill_1' }),
        createDirectSkillTask({ directSkillId: 'skill_2' }),
        createDirectSkillTask({ directSkillId: 'skill_3' }),
      ];

      mockExecute
        .mockResolvedValueOnce(createMockSkillResult())
        .mockRejectedValueOnce(new Error('Skill 2 failed'))
        .mockResolvedValueOnce(createMockSkillResult());

      const responses = await executor.executeTasks(tasks, emitter);

      expect(responses).toHaveLength(3);
      expect(responses[0].success).toBe(true);
      expect(responses[1].success).toBe(false);
      expect(responses[2].success).toBe(true);
    });

    test('respects concurrency limit', async () => {
      // Create executor with concurrency limit of 2
      const limitedExecutor = new DirectSkillExecutor(mockTPS, mockAI, 'trace_123', 2);

      const executionOrder: number[] = [];
      const tasks = Array.from({ length: 5 }, (_, i) =>
        createDirectSkillTask({ directSkillId: `skill_${i}` })
      );

      mockExecute.mockImplementation(async (skillId: string) => {
        const index = parseInt(skillId.split('_')[1]);
        executionOrder.push(index);
        // Simulate async work
        await new Promise((resolve) => setTimeout(resolve, 10));
        return createMockSkillResult({ skillId });
      });

      const responses = await limitedExecutor.executeTasks(tasks, emitter);

      expect(responses).toHaveLength(5);
      // Verify all tasks were executed
      expect(executionOrder.sort()).toEqual([0, 1, 2, 3, 4]);
    });

    test('captures entities from all task results', async () => {
      const tasks = [
        createDirectSkillTask({}, { metadata: { frameId: 1001 } }),
        createDirectSkillTask({}, { metadata: { frameId: 1002 } }),
      ];

      mockExecute.mockResolvedValue(
        createMockSkillResult({
          diagnostics: [createMockDiagnostic()],
          rawResults: {
            root_cause: {
              stepId: 'root_cause',
              stepType: 'diagnostic',
              success: true,
              data: [{ cause_type: 'TEST', frame_dur_ms: 50 }],
              executionTimeMs: 10,
            },
          },
        })
      );

      const responses = await executor.executeTasks(tasks, emitter);

      // Both responses should have enriched findings
      expect(responses[0].findings[0].details?.cause_type).toBe('TEST');
      expect(responses[1].findings[0].details?.cause_type).toBe('TEST');
    });
  });

  // ===========================================================================
  // Confidence Computation
  // ===========================================================================

  describe('Confidence Computation', () => {
    test('computes confidence as average of diagnostic confidences', async () => {
      const task = createDirectSkillTask();
      mockExecute.mockResolvedValue(
        createMockSkillResult({
          diagnostics: [
            createMockDiagnostic({ confidence: 0.9 }),
            createMockDiagnostic({ confidence: 0.7 }),
          ],
        })
      );

      const responses = await executor.executeTasks([task], emitter);

      expect(responses[0].confidence).toBe(0.8); // (0.9 + 0.7) / 2
    });

    test('returns 0.5 confidence when no diagnostics', async () => {
      const task = createDirectSkillTask();
      mockExecute.mockResolvedValue(
        createMockSkillResult({
          diagnostics: [],
        })
      );

      const responses = await executor.executeTasks([task], emitter);

      expect(responses[0].confidence).toBe(0.5);
    });

    test('returns 0.2 confidence on failure', async () => {
      const task = createDirectSkillTask();
      mockExecute.mockResolvedValue(
        createMockSkillResult({
          success: false,
        })
      );

      const responses = await executor.executeTasks([task], emitter);

      expect(responses[0].confidence).toBe(0.2);
    });
  });

  // ===========================================================================
  // Progress Emission
  // ===========================================================================

  describe('Progress Emission', () => {
    test('emits progress update with task count', async () => {
      const tasks = [createDirectSkillTask(), createDirectSkillTask()];
      mockExecute.mockResolvedValue(createMockSkillResult());

      await executor.executeTasks(tasks, emitter);

      expect(emitter.emitUpdate).toHaveBeenCalledWith(
        'progress',
        expect.objectContaining({
          phase: 'tasks_dispatched',
          taskCount: 2,
        })
      );
    });

    test('logs execution start and completion', async () => {
      const tasks = [createDirectSkillTask()];
      mockExecute.mockResolvedValue(createMockSkillResult());

      await executor.executeTasks(tasks, emitter);

      expect(emitter.log).toHaveBeenCalledWith(
        expect.stringContaining('executing 1 tasks')
      );
      expect(emitter.log).toHaveBeenCalledWith(
        expect.stringContaining('completed 1 tasks')
      );
    });

    test('logs individual skill execution', async () => {
      const task = createDirectSkillTask({
        directSkillId: 'jank_frame_detail',
      });
      task.scopeLabel = 'Frame 1436069';
      mockExecute.mockResolvedValue(createMockSkillResult());

      await executor.executeTasks([task], emitter);

      expect(emitter.log).toHaveBeenCalledWith(
        expect.stringContaining('jank_frame_detail')
      );
      expect(emitter.log).toHaveBeenCalledWith(
        expect.stringContaining('Frame 1436069')
      );
    });

    test('logs errors on skill failure', async () => {
      const task = createDirectSkillTask();
      mockExecute.mockRejectedValue(new Error('Test error'));

      await executor.executeTasks([task], emitter);

      expect(emitter.log).toHaveBeenCalledWith(
        expect.stringContaining('error')
      );
      expect(emitter.log).toHaveBeenCalledWith(
        expect.stringContaining('Test error')
      );
    });
  });

  // ===========================================================================
  // Source Entity Tracking
  // ===========================================================================

  describe('Source Entity Tracking', () => {
    test('includes sourceEntityType in tool result metadata', async () => {
      const task = createDirectSkillTask(
        {},
        {
          metadata: {
            sourceEntityType: 'frame',
            sourceEntityId: 1436069,
          },
        }
      );
      mockExecute.mockResolvedValue(createMockSkillResult());

      const responses = await executor.executeTasks([task], emitter);

      expect(responses[0].toolResults![0].metadata?.sourceEntityType).toBe('frame');
      expect(responses[0].toolResults![0].metadata?.sourceEntityId).toBe('1436069');
    });

    test('includes package name in tool result metadata', async () => {
      const task = createDirectSkillTask({}, { processName: 'com.test.package' });
      mockExecute.mockResolvedValue(createMockSkillResult());

      const responses = await executor.executeTasks([task], emitter);

      expect(responses[0].toolResults![0].metadata?.packageName).toBe('com.test.package');
    });
  });
});
