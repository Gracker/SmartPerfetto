/**
 * claudeVerifier unit tests
 *
 * Tests the 4-layer verification pipeline:
 * 1. Heuristic checks (6 sub-checks)
 * 2. Plan adherence
 * 3. Hypothesis resolution
 * 4. Scene completeness
 *
 * LLM verification (Layer 5) is not tested here — it requires an SDK call.
 * The generateCorrectionPrompt helper is also tested.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { Finding } from '../../agent/types';
import type { AnalysisPlanV3, Hypothesis } from '../types';

// Mock fs for learned patterns I/O
jest.mock('fs', () => {
  const actual = jest.requireActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: jest.fn((p: string) => {
      if (typeof p === 'string' && p.includes('learned_misdiagnosis_patterns')) return false;
      return (actual as any).existsSync(p);
    }),
    readFileSync: jest.fn((p: string, enc?: string) => {
      if (typeof p === 'string' && p.includes('learned_misdiagnosis_patterns')) return '[]';
      return (actual as any).readFileSync(p, enc);
    }),
    writeFileSync: jest.fn(),
    renameSync: jest.fn(),
    mkdirSync: jest.fn(),
  };
});

import {
  verifyHeuristic,
  verifyPlanAdherence,
  verifyHypotheses,
  verifySceneCompleteness,
  generateCorrectionPrompt,
  learnFromVerificationResults,
  normalizeLLMSeverity,
  isConclusionIncomplete,
} from '../claudeVerifier';

// ── Helpers ──────────────────────────────────────────────────────────────

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: `f-${Math.random().toString(36).slice(2, 6)}`,
    title: 'Test finding',
    description: 'Test description with some detail',
    severity: 'warning',
    ...overrides,
  };
}

function makePlan(overrides: Partial<AnalysisPlanV3> = {}): AnalysisPlanV3 {
  return {
    phases: [
      {
        id: 'phase-1',
        name: 'Data Collection',
        goal: 'Collect frame data',
        expectedTools: ['execute_sql', 'invoke_skill'],
        status: 'completed',
        summary: 'Collected 200 frames from frame_timeline',
      },
    ],
    successCriteria: 'Identify root cause of jank',
    submittedAt: Date.now(),
    toolCallLog: [
      { toolName: 'execute_sql', timestamp: Date.now(), matchedPhaseId: 'phase-1' },
    ],
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('verifyHeuristic', () => {
  describe('Check 1: CRITICAL without evidence', () => {
    it('should flag CRITICAL findings without evidence', () => {
      const findings = [makeFinding({ severity: 'critical', evidence: [] })];
      const issues = verifyHeuristic(findings, 'Some conclusion text that is long enough');
      expect(issues.some(i => i.type === 'missing_evidence' && i.severity === 'error')).toBe(true);
    });

    it('should pass CRITICAL findings with evidence', () => {
      const findings = [makeFinding({ severity: 'critical', evidence: [{ type: 'data', value: '50ms' }] })];
      const issues = verifyHeuristic(findings, 'Some conclusion text that is long enough');
      expect(issues.filter(i => i.type === 'missing_evidence')).toHaveLength(0);
    });
  });

  describe('Check 2: Too many CRITICALs', () => {
    it('should warn when >5 CRITICAL findings', () => {
      const findings = Array.from({ length: 6 }, (_, i) =>
        makeFinding({ severity: 'critical', evidence: [{ type: 'data' }], title: `Issue ${i}` }),
      );
      const issues = verifyHeuristic(findings, 'Conclusion with enough text here');
      expect(issues.some(i => i.type === 'too_many_criticals')).toBe(true);
    });

    it('should not warn with <=5 CRITICALs', () => {
      const findings = Array.from({ length: 5 }, (_, i) =>
        makeFinding({ severity: 'critical', evidence: [{ type: 'data' }], title: `Issue ${i}` }),
      );
      const issues = verifyHeuristic(findings, 'Conclusion with enough text here');
      expect(issues.filter(i => i.type === 'too_many_criticals')).toHaveLength(0);
    });
  });

  describe('Check 3: Known misdiagnosis patterns', () => {
    it('should flag VSync alignment false positive', () => {
      const findings = [makeFinding({ title: 'VSync 对齐异常', description: 'VSync misalign detected' })];
      const issues = verifyHeuristic(findings, 'VSync 对齐异常严重');
      expect(issues.some(i => i.type === 'known_misdiagnosis')).toBe(true);
    });

    it('should flag single frame CRITICAL', () => {
      const findings = [makeFinding({ title: '单帧异常', severity: 'critical', description: '1帧异常 critical', evidence: [{}] })];
      const issues = verifyHeuristic(findings, '单帧异常是严重问题');
      expect(issues.some(i => i.type === 'known_misdiagnosis')).toBe(true);
    });
  });

  describe('Check 4: Severity mismatch', () => {
    it('should warn when conclusion mentions CRITICAL but findings have none', () => {
      const findings = [makeFinding({ severity: 'warning' })];
      const issues = verifyHeuristic(findings, 'Found [CRITICAL] issue in rendering pipeline that is really bad');
      expect(issues.some(i => i.type === 'severity_mismatch')).toBe(true);
    });

    it('should not warn when findings have CRITICAL too', () => {
      const findings = [makeFinding({ severity: 'critical', evidence: [{}] })];
      const issues = verifyHeuristic(findings, 'Found [CRITICAL] issue');
      expect(issues.filter(i => i.type === 'severity_mismatch')).toHaveLength(0);
    });
  });

  describe('Check 5: Empty conclusion', () => {
    it('should error when conclusion is too short', () => {
      const issues = verifyHeuristic([], 'short');
      expect(issues.some(i => i.type === 'missing_reasoning' && i.severity === 'error')).toBe(true);
    });

    it('should pass with sufficient conclusion length', () => {
      const issues = verifyHeuristic([], 'A'.repeat(60));
      expect(issues.filter(i =>
        i.type === 'missing_reasoning' && i.severity === 'error' && i.message.includes('过短'),
      )).toHaveLength(0);
    });
  });

  describe('Check 6: Causal reasoning', () => {
    it('6a: should warn when duration data exists without causal keywords', () => {
      const findings = [makeFinding({
        severity: 'high',
        description: 'Frame took 35.2 ms to render, which is longer than expected',
      })];
      const issues = verifyHeuristic(findings, 'A'.repeat(60));
      expect(issues.some(i =>
        i.type === 'missing_reasoning' && i.message.includes('缺少根因'),
      )).toBe(true);
    });

    it('6a: should pass when causal keywords present', () => {
      const findings = [makeFinding({
        severity: 'high',
        description: 'Frame took 35.2 ms 因为 CPU 频率降低导致渲染超时',
      })];
      const issues = verifyHeuristic(findings, 'A'.repeat(60));
      expect(issues.filter(i =>
        i.type === 'missing_reasoning' && i.message.includes('缺少根因'),
      )).toHaveLength(0);
    });

    it('6b: should warn CRITICAL with quantitative data but no baseline', () => {
      const findings = [makeFinding({
        severity: 'critical',
        evidence: [{}],
        description: 'RenderThread 耗时 50ms, CPU usage 80%',
      })];
      const issues = verifyHeuristic(findings, 'A'.repeat(60));
      expect(issues.some(i => i.message.includes('对比基准'))).toBe(true);
    });

    it('6b: should pass when baseline comparison present', () => {
      const findings = [makeFinding({
        severity: 'critical',
        evidence: [{}],
        description: 'RenderThread 耗时 50ms, 超过阈值 16.6ms 因为 GPU 阻塞',
      })];
      const issues = verifyHeuristic(findings, 'A'.repeat(60));
      expect(issues.filter(i => i.message.includes('对比基准'))).toHaveLength(0);
    });

    it('6c: should warn when overall reasoning density is low', () => {
      const findings = Array.from({ length: 4 }, (_, i) =>
        makeFinding({
          severity: 'high',
          title: `Issue ${i}`,
          description: `耗时 ${10 + i} ms 超过预期`,
        }),
      );
      const issues = verifyHeuristic(findings, 'A'.repeat(60));
      expect(issues.some(i => i.message.includes('推理密度'))).toBe(true);
    });

    it('6d: should warn on long descriptions with metrics but few causal connectors', () => {
      const findings = [makeFinding({
        severity: 'high',
        description: 'A'.repeat(100) + ' 测量到 50ms, 30%, 200MB 的数据指标. ' + 'B'.repeat(100),
      })];
      const issues = verifyHeuristic(findings, 'A'.repeat(60));
      expect(issues.some(i => i.message.includes('因果连接'))).toBe(true);
    });
  });
});

describe('verifyPlanAdherence', () => {
  it('should error when no plan submitted', () => {
    const issues = verifyPlanAdherence(null);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('error');
    expect(issues[0].type).toBe('plan_deviation');
  });

  it('should pass a fully completed plan', () => {
    const issues = verifyPlanAdherence(makePlan());
    // Might have reasoning summary warnings but no plan_deviation errors
    const deviations = issues.filter(i => i.type === 'plan_deviation');
    expect(deviations.filter(i => i.severity === 'error')).toHaveLength(0);
  });

  it('should warn on pending phases with tool calls', () => {
    const plan = makePlan({
      phases: [
        { id: 'p1', name: 'Phase 1', goal: 'G1', expectedTools: ['execute_sql'], status: 'completed', summary: 'Done with phase 1' },
        { id: 'p2', name: 'Phase 2', goal: 'G2', expectedTools: ['invoke_skill'], status: 'pending' },
      ],
      toolCallLog: [{ toolName: 'execute_sql', timestamp: Date.now(), matchedPhaseId: 'p1' }],
    });
    const issues = verifyPlanAdherence(plan);
    expect(issues.some(i => i.type === 'plan_deviation' && i.severity === 'warning')).toBe(true);
  });

  it('should error on pending phases with no tool calls', () => {
    const plan = makePlan({
      phases: [
        { id: 'p1', name: 'Phase 1', goal: 'G1', expectedTools: ['execute_sql'], status: 'pending' },
      ],
      toolCallLog: [],
    });
    const issues = verifyPlanAdherence(plan);
    expect(issues.some(i => i.type === 'plan_deviation' && i.severity === 'error')).toBe(true);
  });

  it('should warn on completed phase without matched tool calls', () => {
    const plan = makePlan({
      phases: [{
        id: 'p1', name: 'Phase 1', goal: 'G1',
        expectedTools: ['execute_sql'],
        status: 'completed',
        summary: 'Completed analysis',
      }],
      toolCallLog: [], // No tool calls matched to phase
    });
    const issues = verifyPlanAdherence(plan);
    expect(issues.some(i =>
      i.type === 'plan_deviation' && i.message.includes('无匹配的工具调用'),
    )).toBe(true);
  });

  it('should warn when completed phases lack reasoning summary', () => {
    const plan = makePlan({
      phases: [
        { id: 'p1', name: 'Phase 1', goal: 'G', expectedTools: [], status: 'completed', summary: 'Done with this phase.' },
        { id: 'p2', name: 'Phase 2', goal: 'G', expectedTools: [], status: 'completed' },
      ],
      toolCallLog: [],
    });
    const issues = verifyPlanAdherence(plan);
    expect(issues.some(i =>
      i.type === 'missing_reasoning' && i.message.includes('推理摘要'),
    )).toBe(true);
  });
});

describe('verifyHypotheses', () => {
  it('should pass when all hypotheses resolved', () => {
    const hypotheses: Hypothesis[] = [
      { id: 'h1', statement: 'RenderThread blocked', status: 'confirmed', formedAt: Date.now(), resolvedAt: Date.now() },
      { id: 'h2', statement: 'Memory pressure', status: 'rejected', formedAt: Date.now(), resolvedAt: Date.now() },
    ];
    expect(verifyHypotheses(hypotheses)).toHaveLength(0);
  });

  it('should pass with empty hypotheses', () => {
    expect(verifyHypotheses([])).toHaveLength(0);
  });

  it('should error when unresolved hypotheses exist', () => {
    const hypotheses: Hypothesis[] = [
      { id: 'h1', statement: 'RenderThread blocked by Binder', status: 'formed', formedAt: Date.now() },
    ];
    const issues = verifyHypotheses(hypotheses);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('error');
    expect(issues[0].type).toBe('unresolved_hypothesis');
    expect(issues[0].message).toContain('RenderThread blocked');
  });

  it('should only flag formed hypotheses, not resolved ones', () => {
    const hypotheses: Hypothesis[] = [
      { id: 'h1', statement: 'Blocked', status: 'confirmed', formedAt: Date.now(), resolvedAt: Date.now() },
      { id: 'h2', statement: 'Leaked', status: 'formed', formedAt: Date.now() },
    ];
    const issues = verifyHypotheses(hypotheses);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('Leaked');
    expect(issues[0].message).not.toContain('Blocked');
  });
});

describe('verifySceneCompleteness', () => {
  it('should warn scrolling scene missing frame/jank content', () => {
    const findings = [makeFinding({ title: 'CPU issue', description: 'CPU is busy', category: 'cpu' })];
    const issues = verifySceneCompleteness('scrolling', findings, 'CPU analysis done');
    expect(issues.some(i => i.type === 'missing_check' && i.message.includes('帧'))).toBe(true);
  });

  it('should pass scrolling scene with frame content', () => {
    const findings = [makeFinding({ title: 'Jank frames detected', description: '15帧卡顿' })];
    const issues = verifySceneCompleteness('scrolling', findings, '帧渲染分析完成');
    expect(issues).toHaveLength(0);
  });

  it('should warn scrolling with significant jank but no deep drill', () => {
    const findings = [makeFinding({ title: 'Jank', description: '掉帧 freq_ramp_slow 64帧 47%' })];
    const conclusion = '滑动分析：136 帧掉帧，freq_ramp_slow 占 47%，workload_heavy 占 9%。';
    const issues = verifySceneCompleteness('scrolling', findings, conclusion);
    expect(issues.some(i => i.message.includes('Phase 1.9') || i.message.includes('深钻'))).toBe(true);
  });

  it('should pass scrolling with deep drill evidence present', () => {
    const findings = [makeFinding({ title: 'Jank', description: '掉帧 freq_ramp_slow 64帧 47%' })];
    const conclusion = '滑动分析：136 帧掉帧。blocking_chain_analysis 显示主线程被 Binder 阻塞。lookup_knowledge cpu-scheduler。';
    const issues = verifySceneCompleteness('scrolling', findings, conclusion);
    expect(issues.filter(i => i.message.includes('深钻'))).toHaveLength(0);
  });

  it('should warn startup scene missing TTID/TTFD', () => {
    const findings = [makeFinding({ title: 'CPU busy', description: 'Some CPU work' })];
    const issues = verifySceneCompleteness('startup', findings, 'Done');
    expect(issues.some(i => i.message.includes('TTID/TTFD'))).toBe(true);
  });

  it('should pass startup scene with TTID mention', () => {
    // Use "启动" without "冷启动" to avoid triggering cold-start-specific checks
    const findings = [makeFinding({ title: 'Startup analysis', description: 'TTID=850ms 启动分析' })];
    const issues = verifySceneCompleteness('startup', findings, '启动性能分析');
    expect(issues).toHaveLength(0);
  });

  it('should warn ANR scene missing deadlock/ANR content', () => {
    const findings = [makeFinding({ title: 'Memory high', description: 'OOM risk' })];
    const issues = verifySceneCompleteness('anr', findings, 'Memory analysis');
    expect(issues.some(i => i.message.includes('阻塞/死锁'))).toBe(true);
  });

  it('should not check general scene', () => {
    // verifySceneCompleteness is only called for non-general scenes
    // But if called with 'general', it should return no issues
    const issues = verifySceneCompleteness('general', [], '');
    expect(issues).toHaveLength(0);
  });
});

describe('generateCorrectionPrompt', () => {
  it('should include ERROR issues in the correction prompt', () => {
    const issues = [
      { type: 'missing_evidence' as const, severity: 'error' as const, message: 'CRITICAL 发现缺少证据' },
      { type: 'plan_deviation' as const, severity: 'warning' as const, message: '有阶段未完成' },
    ];
    const prompt = generateCorrectionPrompt(issues, '原始结论文本');
    expect(prompt).toContain('[ERROR]');
    expect(prompt).toContain('CRITICAL 发现缺少证据');
    expect(prompt).toContain('有阶段未完成'); // Warnings in "注意事项"
    expect(prompt).toContain('原始结论文本');
  });

  it('should handle only warnings gracefully', () => {
    const issues = [
      { type: 'too_many_criticals' as const, severity: 'warning' as const, message: '过多 CRITICAL' },
    ];
    const prompt = generateCorrectionPrompt(issues, '结论');
    // No ERROR items → empty numbered list, but warnings section present
    expect(prompt).toContain('过多 CRITICAL');
  });

  it('should use "generate from scratch" prompt when conclusion is incomplete', () => {
    const issues = [
      { type: 'unresolved_hypothesis' as const, severity: 'error' as const, message: '假设未解决' },
    ];
    // Short conclusion = just reasoning notes, no structured report
    const shortConclusion = '正在分析数据，发现 136 帧掉帧。准备输出结论。';
    const prompt = generateCorrectionPrompt(issues, shortConclusion);
    expect(prompt).toContain('结论尚未生成');
    expect(prompt).toContain('完整的结构化分析报告');
  });

  it('should use normal correction prompt when conclusion is complete', () => {
    const issues = [
      { type: 'missing_evidence' as const, severity: 'error' as const, message: 'CRITICAL 缺少证据' },
    ];
    const fullConclusion = '## 滑动性能分析报告\n\n### 1. 概览\n' + '详细内容'.repeat(300);
    const prompt = generateCorrectionPrompt(issues, fullConclusion);
    expect(prompt).not.toContain('结论尚未生成');
    expect(prompt).toContain('请修正以下问题');
  });
});

// ── New tests: isConclusionIncomplete ────────────────────────────────────

describe('isConclusionIncomplete', () => {
  it('should detect short reasoning notes as incomplete', () => {
    expect(isConclusionIncomplete('正在分析数据。准备出结论。')).toBe(true);
  });

  it('should detect text without headings as incomplete', () => {
    const noHeadings = '分析发现 CPU 频率问题。'.repeat(100);
    expect(isConclusionIncomplete(noHeadings)).toBe(true);
  });

  it('should accept structured report as complete', () => {
    const fullReport = '## 滑动性能分析报告\n\n### 1. 概览\n' + '详细分析内容。'.repeat(200);
    expect(isConclusionIncomplete(fullReport)).toBe(false);
  });

  it('should detect empty string as incomplete', () => {
    expect(isConclusionIncomplete('')).toBe(true);
  });
});

describe('learnFromVerificationResults', () => {
  const mockFs = require('fs') as jest.Mocked<typeof import('fs')>;

  beforeEach(() => {
    (mockFs.existsSync as jest.Mock).mockImplementation((...args: unknown[]) => {
      const p = args[0] as string;
      if (typeof p === 'string' && p.includes('learned_misdiagnosis')) return false;
      return false;
    });
    (mockFs.readFileSync as jest.Mock).mockImplementation(() => '[]');
    (mockFs.writeFileSync as jest.Mock).mockClear();
    (mockFs.renameSync as jest.Mock).mockClear();
    (mockFs.mkdirSync as jest.Mock).mockClear();
  });

  it('should ignore non-misdiagnosis issues', () => {
    const issues = [{ type: 'missing_evidence' as const, severity: 'error' as const, message: 'Missing data' }];
    learnFromVerificationResults(issues, []);
    expect(mockFs.writeFileSync).not.toHaveBeenCalled();
  });

  it('should extract keywords from misdiagnosis issues', () => {
    const issues = [{
      type: 'known_misdiagnosis' as const,
      severity: 'warning' as const,
      message: 'VSync alignment issue is likely VRR behavior',
    }];
    const findings = [makeFinding({ title: 'VSync Alignment Problem' })];
    learnFromVerificationResults(issues, findings);
    // Should have attempted to write patterns
    expect(mockFs.writeFileSync).toHaveBeenCalled();
  });

  it('should enrich keywords from matching finding titles (P2-G7)', () => {
    const issues = [{
      type: 'severity_mismatch' as const,
      severity: 'warning' as const,
      message: 'Buffer Stuffing 标记可能是假阳性',
    }];
    const findings = [makeFinding({
      title: 'Buffer Stuffing 严重',
      description: 'Buffer Stuffing 标记为 critical',
    })];
    learnFromVerificationResults(issues, findings);
    expect(mockFs.writeFileSync).toHaveBeenCalled();
  });
});

// ── New tests: Check 7 (truncation detection) ────────────────────────────

describe('verifyHeuristic — Check 7: Truncation detection', () => {
  it('should warn when conclusion ends mid-sentence', () => {
    // Last line must be > 15 chars to trigger truncation check
    const conclusion = 'A'.repeat(80) + '\n分析发现主线程 ChaosTask 耗时较长但缺少根因分析链条和深层阻塞';
    const issues = verifyHeuristic([], conclusion);
    expect(issues.some(i => i.type === 'truncation')).toBe(true);
  });

  it('should not warn when conclusion ends with Chinese period', () => {
    const conclusion = 'A'.repeat(80) + '\n分析完成，主线程无明显瓶颈。';
    const issues = verifyHeuristic([], conclusion);
    expect(issues.filter(i => i.type === 'truncation')).toHaveLength(0);
  });

  it('should not warn when conclusion ends with English period', () => {
    const conclusion = 'A'.repeat(80) + '\nAnalysis complete, no significant bottleneck found.';
    const issues = verifyHeuristic([], conclusion);
    expect(issues.filter(i => i.type === 'truncation')).toHaveLength(0);
  });

  it('should not warn when conclusion ends with table row', () => {
    const conclusion = 'A'.repeat(80) + '\n| Binder 阻塞 | < 5ms | ✅ 可排除 |';
    const issues = verifyHeuristic([], conclusion);
    expect(issues.filter(i => i.type === 'truncation')).toHaveLength(0);
  });

  it('should not warn when conclusion ends with arrow or checkmark', () => {
    const conclusion = 'A'.repeat(80) + '\n└── CPU 频率（正常，无升频不足）✅';
    const issues = verifyHeuristic([], conclusion);
    expect(issues.filter(i => i.type === 'truncation')).toHaveLength(0);
  });

  it('should not warn on short conclusions (< 100 chars)', () => {
    const conclusion = '短结论，未完';
    const issues = verifyHeuristic([], conclusion);
    // Should trigger "conclusion too short" error but NOT truncation
    expect(issues.filter(i => i.type === 'truncation')).toHaveLength(0);
  });
});

// ── New tests: Startup scene completeness (cold-start specific) ──────────

describe('verifySceneCompleteness — startup cold-start checks', () => {
  it('should warn cold start missing Phase 2.6 slow reasons', () => {
    const findings = [makeFinding({ title: '冷启动分析', description: 'bindApplication 477ms, TTID=1912ms 冷启动' })];
    const issues = verifySceneCompleteness('startup', findings, '冷启动总耗时 1338ms');
    expect(issues.some(i => i.message.includes('Phase 2.6') && i.message.includes('官方'))).toBe(true);
  });

  it('should not warn cold start with slow reasons present', () => {
    const findings = [makeFinding({ title: '冷启动分析', description: 'TTID=850ms 冷启动' })];
    const conclusion = '冷启动分析完成。startup_slow_reasons 检查未发现 DEX2OAT 问题。';
    const issues = verifySceneCompleteness('startup', findings, conclusion);
    expect(issues.filter(i => i.message.includes('Phase 2.6'))).toHaveLength(0);
  });

  it('should warn cold start missing JIT analysis', () => {
    const findings = [makeFinding({ title: '冷启动分析', description: 'bindApplication 477ms 冷启动' })];
    const issues = verifySceneCompleteness('startup', findings, '冷启动总耗时 1338ms');
    expect(issues.some(i => i.message.includes('JIT'))).toBe(true);
  });

  it('should not warn cold start when JIT mentioned', () => {
    const findings = [makeFinding({ title: '冷启动分析', description: '冷启动 bindApplication' })];
    const conclusion = '冷启动完成，JIT 编译影响可排除（< 5ms），startup_slow_reasons 正常。';
    const issues = verifySceneCompleteness('startup', findings, conclusion);
    expect(issues.filter(i => i.message.includes('JIT'))).toHaveLength(0);
  });

  it('should warn Q4 heavy without blocking chain analysis', () => {
    const findings = [makeFinding({ title: '启动分析', description: 'Q4 Sleeping 35% 启动' })];
    const conclusion = '启动分析发现 S(Sleeping) = 470ms (35.1%)，推测为 join 等待。';
    const issues = verifySceneCompleteness('startup', findings, conclusion);
    expect(issues.some(i => i.message.includes('阻塞链'))).toBe(true);
  });

  it('should not warn Q4 heavy when blocking chain present', () => {
    const findings = [makeFinding({ title: '启动分析', description: 'Q4 Sleeping 35% 启动' })];
    const conclusion = '启动分析：S(Sleeping) = 470ms (35.1%)。blocking_chain_analysis 显示 waker_current_slice 为 pool-3-thread 唤醒者。';
    const issues = verifySceneCompleteness('startup', findings, conclusion);
    expect(issues.filter(i => i.message.includes('阻塞链'))).toHaveLength(0);
  });

  it('should not trigger cold-start checks for warm start', () => {
    const findings = [makeFinding({ title: '温启动分析', description: 'TTID=300ms 温启动 startup' })];
    const conclusion = '温启动总耗时 300ms。';
    const issues = verifySceneCompleteness('startup', findings, conclusion);
    // Should not have Phase 2.6 or JIT warnings (these are cold-start only)
    expect(issues.filter(i => i.message.includes('Phase 2.6'))).toHaveLength(0);
    expect(issues.filter(i => i.message.includes('JIT'))).toHaveLength(0);
  });

  it('should not trigger cold-start checks when warm start mentions bindApplication', () => {
    // bindApplication can appear in warm-start analysis text (e.g., agent discussing its absence)
    const findings = [makeFinding({ title: '温启动分析', description: 'TTID=300ms 温启动 startup' })];
    const conclusion = '温启动分析：无 bindApplication slice，确认为温启动。';
    const issues = verifySceneCompleteness('startup', findings, conclusion);
    expect(issues.filter(i => i.message.includes('Phase 2.6'))).toHaveLength(0);
    expect(issues.filter(i => i.message.includes('JIT'))).toHaveLength(0);
  });
});

// ── New tests: normalizeLLMSeverity ──────────────────────────────────────

describe('normalizeLLMSeverity', () => {
  it('should map "error" to "error"', () => {
    expect(normalizeLLMSeverity('error')).toBe('error');
  });

  it('should map "critical" to "error"', () => {
    expect(normalizeLLMSeverity('critical')).toBe('error');
  });

  it('should map "high" to "warning" (importance, not action-required)', () => {
    expect(normalizeLLMSeverity('high')).toBe('warning');
  });

  it('should map "warning" to "warning"', () => {
    expect(normalizeLLMSeverity('warning')).toBe('warning');
  });

  it('should map "medium" to "warning"', () => {
    expect(normalizeLLMSeverity('medium')).toBe('warning');
  });

  it('should map "low" to "warning"', () => {
    expect(normalizeLLMSeverity('low')).toBe('warning');
  });

  it('should map "info" to "warning"', () => {
    expect(normalizeLLMSeverity('info')).toBe('warning');
  });

  it('should handle case-insensitive input', () => {
    expect(normalizeLLMSeverity('CRITICAL')).toBe('error');
    expect(normalizeLLMSeverity('High')).toBe('warning');
    expect(normalizeLLMSeverity('WARNING')).toBe('warning');
  });

  it('should handle undefined/empty gracefully', () => {
    expect(normalizeLLMSeverity(undefined as any)).toBe('warning');
    expect(normalizeLLMSeverity('')).toBe('warning');
  });
});
