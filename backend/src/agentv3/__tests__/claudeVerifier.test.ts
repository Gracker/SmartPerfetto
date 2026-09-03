// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

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

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
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

jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: jest.fn(() => ({
    [Symbol.asyncIterator]: async function* () {
      yield {
        type: 'result',
        subtype: 'success',
        result: '[]',
      };
    },
    close: jest.fn(),
  })),
}));

const claudeSdkMock = require('@anthropic-ai/claude-agent-sdk') as {
  query: jest.Mock;
};

import {
  verifyHeuristic,
  verifyPlanAdherence,
  verifyHypotheses,
  verifySceneCompleteness,
  verifyConclusion,
  generateCorrectionPrompt,
  learnFromVerificationResults,
  normalizeLLMSeverity,
  isConclusionIncomplete,
  parseVerifierJsonIssues,
} from '../claudeVerifier';
import { extractFindingsFromText } from '../claudeFindingExtractor';
import { getProviderService, resetProviderService } from '../../services/providerManager';

const mockFs = require('fs') as jest.Mocked<typeof import('fs')>;
const actualFs = jest.requireActual<typeof import('fs')>('fs');

function restoreEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

beforeEach(() => {
  (mockFs.existsSync as jest.Mock).mockImplementation((...args: unknown[]) => {
    const p = args[0] as string;
    if (typeof p === 'string' && p.includes('learned_misdiagnosis_patterns')) return false;
    return actualFs.existsSync(p);
  });
  (mockFs.readFileSync as jest.Mock).mockImplementation((...args: unknown[]) => {
    const p = args[0] as string;
    if (typeof p === 'string' && p.includes('learned_misdiagnosis_patterns')) return '[]';
    return actualFs.readFileSync(p, args[1] as BufferEncoding | undefined);
  });
  (mockFs.writeFileSync as jest.Mock).mockClear();
  (mockFs.renameSync as jest.Mock).mockClear();
  (mockFs.mkdirSync as jest.Mock).mockClear();
});

afterEach(() => {
  resetProviderService();
  claudeSdkMock.query.mockClear();
});

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

    it('should not extract a root-cause index severity as a duplicate finding', () => {
      const conclusion = `
### **[CRITICAL] SR12：bindApplication 阶段自定义代码过重（非框架 Slice 占 98.8%）**

证据：startup_slow_reasons art-40 显示非框架 slice 占 bindApplication 98.8%，总耗时 568.8ms；actionable_main_thread_slices art-32 与 startup_breakdown art-4 交叉验证。

## 根因编号引用

- **SR12** [CRITICAL]：bindApplication 非框架 Slice 占比过高 — 命中（98.8%）

以上索引只是对已证实发现的引用，不应生成一条脱离证据的新发现。
`;
      const findings = extractFindingsFromText(conclusion);
      const issues = verifyHeuristic(findings, conclusion);

      expect(findings).toHaveLength(1);
      expect(findings[0].title).toContain('SR12');
      expect(findings[0].evidence?.[0]?.text).toContain('art-40');
      expect(issues.filter(issue => issue.type === 'missing_evidence')).toHaveLength(0);
    });

    it('should not flag markdown severity table cells as CRITICAL findings without evidence', () => {
      const conclusion = `
| 类型 | 帧数 | 占比 | 根因 | 严重度 |
|------|------|------|------|--------|
| \`CustomScroll_longFrameLoad\` | 6 | 85.7% | ANIMATION 回调同步重载 | [CRITICAL] |

这是一段足够长的结论，用于描述滑动性能问题和后续排查方向。
`;
      const findings = extractFindingsFromText(conclusion);
      const issues = verifyHeuristic(findings, conclusion);

      expect(findings.map(finding => finding.title)).not.toContain('|');
      expect(issues.filter(issue => issue.type === 'missing_evidence')).toHaveLength(0);
    });

    it('should not flag a critical finding when its evidence is a markdown metrics table', () => {
      const conclusion = `
### 代表帧分析

**[CRITICAL] Frame 2 — 主线程 ANIMATION 同步重载**

| 属性 | 数值 |
|---|---|
| 帧耗时 | **62.73ms（7.5x 预算）** |
| vsync_missed | 7 帧 |
| \`Choreographer#doFrame\` | 60.85ms |
| \`animation\` → \`CustomScroll_longFrameLoad_1\` | **59.02ms** |
| 主线程 Running 占比 | **95.9%**（无锁/IO/GC） |
| RenderThread | 仅 1.88ms，98.3% 等待主线程 |

**因果链**：\`Choreographer#doFrame\` → ANIMATION 回调 → \`CustomScroll_longFrameLoad_1\`

这段结论说明 Frame 2 的超时由主线程同步执行 ANIMATION 负载造成，RenderThread 主要在等待主线程，不是渲染线程自身瓶颈。
`;
      const findings = extractFindingsFromText(conclusion);
      const issues = verifyHeuristic(findings, conclusion);

      expect(findings).toHaveLength(1);
      expect(findings[0].evidence?.[0]?.text).toContain('62.73ms');
      expect(issues.filter(issue => issue.type === 'missing_evidence')).toHaveLength(0);
    });

    it('should not flag a critical recommendation when its evidence is inline metric text', () => {
      const conclusion = `
### 优化建议

1. **[CRITICAL] \`CustomScroll_longFrameLoad\` 移出 ANIMATION 回调** — 当前 6/7 帧在 \`Choreographer#doFrame\` 的 ANIMATION 阶段同步执行 47-59ms。建议异步执行或预计算，预估消除 86% 掉帧，FPS 升至约 120。

这段结论明确将优化建议绑定到已观测的帧数量、主线程阶段、耗时范围和预估收益。
`;
      const findings = extractFindingsFromText(conclusion);
      const issues = verifyHeuristic(findings, conclusion);

      expect(findings).toHaveLength(1);
      expect(findings[0].evidence?.[0]?.text).toContain('47-59ms');
      expect(issues.filter(issue => issue.type === 'missing_evidence')).toHaveLength(0);
    });

    it('should not flag the real startup recommendation when colon-delimited inline metrics provide evidence', () => {
      const conclusion = `
### 优化建议

1. **[CRITICAL] 移除/削减 onCreate 中的合成负载**：如果 \`LoadSimulator_ActivityInit\`、\`ChaosTask\`、\`SimulateInflation\` 复现了真实业务逻辑模式，应延迟非首帧必须的初始化。\`ChaosTask\` 70 次主线程阻塞调用是最大单一瓶颈（self=456ms）。
`;
      const findings = extractFindingsFromText(conclusion);
      const issues = verifyHeuristic(findings, conclusion);

      expect(findings).toHaveLength(1);
      expect(findings[0].evidence?.[0]?.text).toContain('456ms');
      expect(issues.filter(issue => issue.type === 'missing_evidence')).toHaveLength(0);
    });

    it('should reject keyword-only and projected colon text as critical evidence', () => {
      const recommendations = [
        '**[CRITICAL] 优化启动**：请将 IO 操作迁移到后台线程，避免主线程阻塞并继续采集数据确认。',
        '**[CRITICAL] Optimize startup**: Please move Binder work off the main thread and collect more data.',
        '**[CRITICAL] 优化启动**：预计优化后耗时降低 456ms，仍需采集当前 trace 数据确认。',
        '**[CRITICAL] 优化启动**：请迁移 IO 到后台。将降低启动耗时456ms。',
        '**[CRITICAL] Optimize startup**: Move IO off main thread. This will reduce startup time by 456ms.',
        '**[CRITICAL] Optimize startup**: Moving Binder work can reduce startup time by 456ms.',
        '**[CRITICAL] Optimize startup**: Binder latency is 456ms if optimized.',
        '**[CRITICAL] Optimize startup**: IO latency is 456ms after optimization.',
      ];

      for (const recommendation of recommendations) {
        const conclusion = `### 优化建议\n\n${recommendation}`;
        const findings = extractFindingsFromText(conclusion);
        const issues = verifyHeuristic(findings, conclusion);

        expect(findings).toHaveLength(1);
        expect(findings[0].evidence).toBeUndefined();
        expect(issues.some(issue => issue.type === 'missing_evidence' && issue.severity === 'error')).toBe(true);
      }
    });

    it('should accept observed Chinese metrics without treating ordinary words as future modality', () => {
      const recommendations = [
        '**[CRITICAL] 优化启动**：当前会话记录显示 IO self=456ms。',
        '**[CRITICAL] 优化启动**：当前调度机会记录显示 Binder self=456ms。',
        '**[CRITICAL] 优化启动**：实测 IO 耗时已降低至456ms，但仍高于预算。',
      ];

      for (const recommendation of recommendations) {
        const conclusion = `### 优化建议\n\n${recommendation}`;
        const findings = extractFindingsFromText(conclusion);
        const issues = verifyHeuristic(findings, conclusion);

        expect(findings).toHaveLength(1);
        expect(findings[0].evidence?.[0]?.text).toContain('456ms');
        expect(issues.filter(issue => issue.type === 'missing_evidence')).toHaveLength(0);
      }
    });

    it('should accept an observed inline metric before a projected target in the same statement', () => {
      const recommendations = [
        '**[CRITICAL] 优化启动**：当前 ChaosTask self=456ms，优化后预计降低到100ms。',
        '**[CRITICAL] Optimize startup**: Current Binder work takes 456ms, and optimization could reduce it to 100ms.',
      ];

      for (const recommendation of recommendations) {
        const conclusion = `### 优化建议\n\n${recommendation}`;
        const findings = extractFindingsFromText(conclusion);
        const issues = verifyHeuristic(findings, conclusion);

        expect(findings).toHaveLength(1);
        expect(findings[0].evidence?.[0]?.text).toContain('456ms');
        expect(issues.filter(issue => issue.type === 'missing_evidence')).toHaveLength(0);
      }
    });

    it('should bind a suffix severity heading to its following metric list', () => {
      const conclusion = `
### Frame 2 — workload_heavy **[CRITICAL]**

- 耗时: 62.73ms (7.5x VSync 预算)，丢失 7 个 VSync
- 主线程: \`Choreographer#doFrame\` 60.85ms，其中 animation 回调 59.02ms
- 根因: 主线程同步重计算导致 RenderThread 等待

这段结论说明量化条目属于 Frame 2 的严重发现，而不是脱离父标题的独立结论。
`;
      const findings = extractFindingsFromText(conclusion);
      const issues = verifyHeuristic(findings, conclusion);

      expect(findings).toHaveLength(1);
      expect(findings[0].title).toBe('Frame 2 — workload_heavy');
      expect(findings[0].evidence?.[0]?.text).toContain('62.73ms');
      expect(issues.filter(issue => issue.type === 'missing_evidence')).toHaveLength(0);
    });

    it('should accept an observed metric bullet before projected recommendation impact', () => {
      const conclusion = `
### 优化建议

1. **[CRITICAL] 排查 \`animation\` 59ms 热点**
- Frame 2 中 \`animation\` 59.31ms 远超预算。这是 View 动画在 Choreographer#doFrame 中的集中耗时。
- **建议**：使用 CPU Profiling 确认具体回调。
- **收益预估**：将 animation 从 59ms 降至 <5ms，帧长从 63ms 降至 <12ms。
`;
      const findings = extractFindingsFromText(conclusion);
      const issues = verifyHeuristic(findings, conclusion);

      expect(findings).toHaveLength(1);
      expect(findings[0].evidence?.[0]?.text).toContain('59.31ms');
      expect(issues.filter(issue => issue.type === 'missing_evidence')).toHaveLength(0);
    });

    it('should reject projected-only recommendation impact as critical evidence', () => {
      const impactLines = [
        '- **收益预估**：将 animation 从 59ms 降至 <5ms，帧长从 63ms 降至 <12ms。',
        '- **收益**：预计将 animation 从 59ms 降至 5ms。',
        '- **Impact**: Expected frame duration will decrease from 59ms to 5ms.',
      ];

      for (const impactLine of impactLines) {
        const conclusion = `### 优化建议\n\n1. **[CRITICAL] 优化 animation 热点**\n${impactLine}`;
        const findings = extractFindingsFromText(conclusion);
        const issues = verifyHeuristic(findings, conclusion);

        expect(findings).toHaveLength(1);
        expect(findings[0].evidence).toBeUndefined();
        expect(issues.some(issue => issue.type === 'missing_evidence' && issue.severity === 'error')).toBe(true);
      }
    });

    it('should not borrow evidence from the next ordered recommendation', () => {
      const conclusion = `
### 优化建议

1. **[CRITICAL] 优化 animation 热点**
- 需要继续采集数据确认。

2. 后续验证
- Frame 2 animation 59.31ms 已由另一项处理。
`;
      const findings = extractFindingsFromText(conclusion);
      const issues = verifyHeuristic(findings, conclusion);

      expect(findings).toHaveLength(1);
      expect(findings[0].evidence).toBeUndefined();
      expect(issues.some(issue => issue.type === 'missing_evidence' && issue.severity === 'error')).toBe(true);
    });

    it('should not treat an unquantified metric list as critical evidence', () => {
      const conclusion = `
### Main thread issue **[CRITICAL]**

- CPU: 主线程看起来很忙
- 建议: 继续采集数据确认

这段结论没有任何时间、比例、计数或证据引用，不能通过严重发现的证据门禁。
`;
      const findings = extractFindingsFromText(conclusion);
      const issues = verifyHeuristic(findings, conclusion);

      expect(findings).toHaveLength(1);
      expect(findings[0].evidence).toBeUndefined();
      expect(issues.some(issue => issue.type === 'missing_evidence' && issue.severity === 'error')).toBe(true);
    });

    it('should not let a critical finding borrow evidence from the next suffix heading', () => {
      const conclusion = `
### First finding **[CRITICAL]**

这里没有量化数据或证据引用。

### Evidence: 62.73ms **[HIGH]**

后一个发现有独立的量化标题证据，不能回流到前一个发现。
`;
      const findings = extractFindingsFromText(conclusion);
      const issues = verifyHeuristic(findings, conclusion);

      expect(findings).toHaveLength(2);
      expect(findings[0].title).toBe('First finding');
      expect(findings[0].evidence).toBeUndefined();
      expect(issues.some(issue => issue.type === 'missing_evidence' && issue.severity === 'error')).toBe(true);
    });

    it('should ignore a severity marker at the end of an ordinary sentence', () => {
      const conclusion = `
The severity assigned by the model is **[CRITICAL]**

This is explanatory prose rather than a structured finding heading, and it must not create a synthetic finding.
`;
      const findings = extractFindingsFromText(conclusion);

      expect(findings).toHaveLength(0);
    });

    it.each([
      ['预计优化值', '耗时: 预计优化后 10ms'],
      ['中文预期值', '耗时: 预期 10ms'],
      ['English expected value', 'duration: expected 10ms'],
    ])('should not accept %s as observed evidence', (_caseName, metric) => {
      const conclusion = `
### Animation issue **[CRITICAL]**

- ${metric}
- 建议: 重写动画逻辑

这段结论只包含目标值，没有当前 trace 的观测值或证据引用。
`;
      const findings = extractFindingsFromText(conclusion);
      const issues = verifyHeuristic(findings, conclusion);

      expect(findings).toHaveLength(1);
      expect(findings[0].evidence).toBeUndefined();
      expect(issues.some(issue => issue.type === 'missing_evidence' && issue.severity === 'error')).toBe(true);
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
    it('should flag VSync alignment false positive only for scoped scenes', () => {
      const findings = [makeFinding({ title: 'VSync 对齐异常', description: 'VSync misalign detected' })];
      const pipelineIssues = verifyHeuristic(findings, 'VSync 对齐异常严重', 'pipeline');
      expect(pipelineIssues).toContainEqual(expect.objectContaining({
        type: 'known_misdiagnosis',
        severity: 'warning',
        message: expect.stringContaining('VRR'),
      }));

      const scrollResponseIssues = verifyHeuristic(findings, 'VSync 对齐异常严重', 'scroll_response');
      expect(scrollResponseIssues.some(i => i.type === 'known_misdiagnosis')).toBe(true);

      const startupIssues = verifyHeuristic(findings, 'VSync 对齐异常严重', 'startup');
      expect(startupIssues.filter(i => i.type === 'known_misdiagnosis')).toHaveLength(0);
    });

    it('should flag Buffer Stuffing only for scoped scenes', () => {
      const findings = [makeFinding({ title: 'Buffer Stuffing 严重', description: 'Buffer Stuffing critical' })];
      const pipelineIssues = verifyHeuristic(findings, 'Buffer Stuffing critical 掉帧', 'pipeline');
      expect(pipelineIssues).toContainEqual(expect.objectContaining({
        type: 'known_misdiagnosis',
        severity: 'warning',
        message: expect.stringContaining('Buffer Stuffing'),
      }));

      const interactionIssues = verifyHeuristic(findings, 'Buffer Stuffing critical 掉帧', 'interaction');
      expect(interactionIssues.filter(i => i.type === 'known_misdiagnosis')).toHaveLength(0);
    });

    it('should flag single frame CRITICAL globally when a scene is provided', () => {
      const findings = [makeFinding({ title: '单帧异常', severity: 'critical', description: '1帧异常 critical', evidence: [{}] })];
      const issues = verifyHeuristic(findings, '单帧异常是严重问题', 'startup');
      expect(issues).toContainEqual(expect.objectContaining({
        type: 'known_misdiagnosis',
        severity: 'warning',
      }));
    });

    it('appends learned patterns after strategy patterns', () => {
      const learned = [{
        keywords: ['VSync', 'alignment'],
        message: 'Learned VSync warning',
        occurrences: 2,
        createdAt: Date.now(),
      }];
      (mockFs.existsSync as jest.Mock).mockImplementation((...args: unknown[]) => {
        const p = args[0] as string;
        if (typeof p === 'string' && p.includes('learned_misdiagnosis_patterns')) return true;
        return actualFs.existsSync(p);
      });
      (mockFs.readFileSync as jest.Mock).mockImplementation((...args: unknown[]) => {
        const p = args[0] as string;
        if (typeof p === 'string' && p.includes('learned_misdiagnosis_patterns')) {
          return JSON.stringify(learned);
        }
        return actualFs.readFileSync(p, args[1] as BufferEncoding | undefined);
      });

      const issues = verifyHeuristic([], 'VSync alignment misalign and VSync 对齐异常严重', 'pipeline')
        .filter(issue => issue.type === 'known_misdiagnosis');
      expect(issues.map(issue => issue.message)).toEqual([
        expect.stringContaining('VRR'),
        expect.stringContaining('(学习) Learned VSync warning'),
      ]);

      const privateIssues = verifyHeuristic(
        [],
        'VSync alignment misalign and VSync 对齐异常严重',
        'pipeline',
        false,
      ).filter(issue => issue.type === 'known_misdiagnosis');
      expect(privateIssues.map(issue => issue.message)).toEqual([
        expect.stringContaining('VRR'),
      ]);
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

  it('should error on completed phase without matched tool calls', () => {
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
      i.type === 'plan_deviation' && i.severity === 'error' && i.message.includes('无匹配的工具调用'),
    )).toBe(true);
  });

  it('allows a final conclusion phase to synthesize prior evidence without its own matched tool call', () => {
    const plan = makePlan({
      phases: [
        {
          id: 'p1',
          name: '证据采集',
          goal: '收集 frame timeline 和关键证据',
          expectedTools: ['invoke_skill'],
          status: 'completed',
          summary: '已收集掉帧分布和关键 frame 证据，确认存在 62.73ms 长帧。',
        },
        {
          id: 'p2',
          name: '综合结论与优化建议',
          goal: '整合前序证据输出最终报告',
          expectedTools: ['fetch_artifact', 'lookup_knowledge'],
          status: 'completed',
          summary: '最终报告已输出，包含根因、证据链、代表帧和优化建议。',
        },
      ],
      toolCallLog: [
        {
          toolName: 'invoke_skill',
          skillId: 'scrolling_analysis',
          timestamp: Date.now(),
          matchedPhaseId: 'p1',
        },
        { toolName: 'fetch_artifact', timestamp: Date.now(), matchedPhaseId: 'p1' },
        { toolName: 'lookup_knowledge', timestamp: Date.now(), matchedPhaseId: 'p1' },
      ],
    });

    const issues = verifyPlanAdherence(plan);
    expect(issues.some(i =>
      i.type === 'plan_deviation' &&
      i.severity === 'error' &&
      i.message.includes('综合结论与优化建议'),
    )).toBe(false);
  });

  it.each([
    {
      name: 'a wrong tool attributed to the evidence phase',
      record: {
        toolName: 'fetch_artifact',
        success: true,
        timestamp: 10,
        matchedPhaseId: 'p1',
      },
    },
    {
      name: 'a failed expected tool attributed to the evidence phase',
      record: {
        toolName: 'get_comparison_context',
        success: false,
        timestamp: 10,
        matchedPhaseId: 'p1',
      },
    },
  ])('does not let $name stand in for prior evidence', ({record}) => {
    const plan = makePlan({
      phases: [
        {
          id: 'p1',
          name: '证据采集',
          goal: '读取双 Trace 对齐上下文',
          expectedTools: ['get_comparison_context'],
          status: 'skipped',
          summary: '未完成有效证据采集。',
        },
        {
          id: 'p2',
          name: '综合结论',
          goal: '基于前序有效证据输出报告',
          expectedTools: ['fetch_artifact'],
          status: 'completed',
          summary: '声称已经基于前序证据完成报告。',
        },
      ],
      toolCallLog: [record],
    });

    const issues = verifyPlanAdherence(plan);
    expect(issues.some(issue =>
      issue.type === 'plan_deviation' &&
      issue.severity === 'error' &&
      issue.message.includes('综合结论'),
    )).toBe(true);
  });

  it('allows a comparison synthesis phase to reuse prior matching evidence calls', () => {
    const plan = makePlan({
      phases: [
        {
          id: 'p2',
          name: '启动详情对比',
          goal: '通过 SQL 深钻两侧 bindApplication 和主线程热点',
          expectedTools: ['execute_sql_on'],
          status: 'completed',
          summary: '已用 execute_sql_on 对比两侧 bindApplication 子阶段和热点函数。',
        },
        {
          id: 'p5',
          name: '差异深钻与根因定位',
          goal: '对前序阶段中差异显著的指标做综合归因',
          expectedTools: ['execute_sql_on', 'fetch_artifact', 'lookup_knowledge'],
          status: 'completed',
          summary: '差异深钻完成：bindApplication 子分解、主线程热点 self_ms、四象限均已通过 execute_sql_on 对比。',
        },
      ],
      toolCallLog: [
        {
          toolName: 'execute_sql_on',
          timestamp: Date.now(),
          matchedPhaseId: 'p2',
        },
      ],
    });

    const issues = verifyPlanAdherence(plan);
    expect(issues.some(i =>
      i.type === 'plan_deviation' &&
      i.severity === 'error' &&
      i.message.includes('差异深钻与根因定位'),
    )).toBe(false);
  });

  it('does not let unrelated prior evidence satisfy a comparison synthesis phase', () => {
    const plan = makePlan({
      phases: [
        {
          id: 'p1',
          name: '启动概览对比',
          goal: '运行 compare_skill 获取概览',
          expectedTools: ['compare_skill'],
          status: 'completed',
          summary: '已完成概览对比。',
        },
        {
          id: 'p5',
          name: '差异深钻与根因定位',
          goal: '对前序阶段中差异显著的指标做综合归因',
          expectedTools: ['execute_sql_on'],
          status: 'completed',
          summary: '声称完成差异深钻，但没有执行 SQL 深钻。',
        },
      ],
      toolCallLog: [
        {
          toolName: 'compare_skill',
          skillId: 'startup_analysis',
          timestamp: Date.now(),
          matchedPhaseId: 'p1',
        },
      ],
    });

    const issues = verifyPlanAdherence(plan);
    expect(issues.some(i =>
      i.type === 'plan_deviation' &&
      i.severity === 'error' &&
      i.message.includes('无匹配的工具调用'),
    )).toBe(true);
  });

  it('still requires structured expectedCalls on comparison synthesis phases', () => {
    const plan = makePlan({
      phases: [
        {
          id: 'p1',
          name: '启动概览对比',
          goal: '运行 startup_analysis 获取概览',
          expectedTools: ['compare_skill'],
          status: 'completed',
          summary: '已完成概览对比。',
        },
        {
          id: 'p5',
          name: '差异深钻与根因定位',
          goal: '对前序阶段中差异显著的指标做综合归因',
          expectedTools: ['compare_skill'],
          expectedCalls: [{ tool: 'compare_skill', skillId: 'startup_detail' }],
          status: 'completed',
          summary: '声称包含 startup_detail 深钻，但只运行过 startup_analysis。',
        },
      ],
      toolCallLog: [
        {
          toolName: 'compare_skill',
          skillId: 'startup_analysis',
          timestamp: Date.now(),
          matchedPhaseId: 'p1',
        },
      ],
    });

    const issues = verifyPlanAdherence(plan);
    expect(issues.some(i =>
      i.type === 'plan_deviation' &&
      i.severity === 'error' &&
      i.message.includes('缺失: compare_skill(startup_detail)'),
    )).toBe(true);
  });

  it('allows a final conclusion expectedCall when the required call ran in an evidence phase', () => {
    const plan = makePlan({
      phases: [
        {
          id: 'p1',
          name: '根因分析',
          goal: '执行阻塞链分析',
          expectedTools: ['invoke_skill'],
          status: 'completed',
          summary: '已通过 blocking_chain_analysis 确认主线程同步等待路径。',
        },
        {
          id: 'p2',
          name: '综合结论',
          goal: '输出最终报告',
          expectedTools: ['invoke_skill'],
          expectedCalls: [{ tool: 'invoke_skill', skillId: 'blocking_chain_analysis' }],
          status: 'completed',
          summary: '最终报告复用了前序阻塞链证据并给出修复建议。',
        },
      ],
      toolCallLog: [
        {
          toolName: 'invoke_skill',
          skillId: 'blocking_chain_analysis',
          timestamp: Date.now(),
          matchedPhaseId: 'p1',
        },
      ],
    });

    const issues = verifyPlanAdherence(plan);
    expect(issues.some(i =>
      i.type === 'plan_deviation' &&
      i.severity === 'error' &&
      i.message.includes('blocking_chain_analysis'),
    )).toBe(false);
  });

  it('does not let dangling tool attribution satisfy final conclusion expectations', () => {
    const plan = makePlan({
      phases: [
        {
          id: 'p1',
          name: 'Conclusion',
          goal: 'write final report',
          expectedTools: ['fetch_artifact'],
          status: 'completed',
          summary: 'Final report was written from supposed prior evidence.',
        },
      ],
      toolCallLog: [
        { toolName: 'fetch_artifact', timestamp: Date.now(), matchedPhaseId: 'old-phase' },
      ],
    });

    const issues = verifyPlanAdherence(plan);
    expect(issues.some(i =>
      i.type === 'plan_deviation' &&
      i.severity === 'error' &&
      i.message.includes('无匹配的工具调用'),
    )).toBe(true);
  });

  it('still errors when a final conclusion expectedCall never ran anywhere', () => {
    const plan = makePlan({
      phases: [
        {
          id: 'p1',
          name: '根因分析',
          goal: '执行代表帧分析',
          expectedTools: ['invoke_skill'],
          status: 'completed',
          summary: '已完成代表帧分析，但尚未执行阻塞链分析。',
        },
        {
          id: 'p2',
          name: '综合结论',
          goal: '输出最终报告',
          expectedTools: ['invoke_skill'],
          expectedCalls: [{ tool: 'invoke_skill', skillId: 'blocking_chain_analysis' }],
          status: 'completed',
          summary: '最终报告声称包含阻塞链证据。',
        },
      ],
      toolCallLog: [
        {
          toolName: 'invoke_skill',
          skillId: 'jank_frame_detail',
          timestamp: Date.now(),
          matchedPhaseId: 'p1',
        },
      ],
    });

    const issues = verifyPlanAdherence(plan);
    expect(issues.some(i =>
      i.type === 'plan_deviation' &&
      i.severity === 'error' &&
      i.message.includes('缺失: invoke_skill(blocking_chain_analysis)'),
    )).toBe(true);
  });

  it('does not let support tools satisfy a structured expectedCalls phase', () => {
    const plan = makePlan({
      phases: [{
        id: 'p1',
        name: 'Root Cause',
        goal: 'Run the specific root-cause skill and supporting SQL',
        expectedTools: ['invoke_skill', 'execute_sql'],
        expectedCalls: [{ tool: 'invoke_skill', skillId: 'jank_frame_detail' }],
        status: 'completed',
        summary: 'Completed root-cause analysis with supporting SQL',
      }],
      toolCallLog: [
        { toolName: 'execute_sql', timestamp: Date.now(), matchedPhaseId: 'p1' },
      ],
    });

    const issues = verifyPlanAdherence(plan);
    expect(issues.some(i =>
      i.type === 'plan_deviation' &&
      i.severity === 'error' &&
      i.message.includes('未执行全部结构化预期调用'),
    )).toBe(true);
  });

  it('does not let attribution-only resolver satisfy a structured expectedCalls phase', () => {
    const plan = makePlan({
      phases: [{
        id: 'p1',
        name: 'Flutter pipeline',
        goal: 'Run the Flutter skill and resolve process identity if needed',
        expectedTools: ['invoke_skill'],
        expectedCalls: [{ tool: 'invoke_skill', skillId: 'flutter_scrolling_analysis' }],
        status: 'completed',
        summary: 'Completed identity resolution only',
      }],
      toolCallLog: [
        {
          toolName: 'invoke_skill',
          timestamp: Date.now(),
          skillId: 'process_identity_resolver',
          matchedPhaseId: 'p1',
        },
      ],
    });

    const issues = verifyPlanAdherence(plan);
    expect(issues.some(i =>
      i.type === 'plan_deviation' &&
      i.severity === 'error' &&
      i.message.includes('未执行全部结构化预期调用'),
    )).toBe(true);
  });

  it('requires every structured expectedCalls entry before completing a phase', () => {
    const plan = makePlan({
      phases: [{
        id: 'p1',
        name: 'Multi-skill root cause',
        goal: 'Run every required root-cause skill',
        expectedTools: ['invoke_skill'],
        expectedCalls: [
          { tool: 'invoke_skill', skillId: 'scrolling_analysis' },
          { tool: 'invoke_skill', skillId: 'jank_frame_detail' },
        ],
        status: 'completed',
        summary: 'Only the overview skill ran',
      }],
      toolCallLog: [
        {
          toolName: 'invoke_skill',
          timestamp: Date.now(),
          skillId: 'scrolling_analysis',
          matchedPhaseId: 'p1',
        },
      ],
    });

    const issues = verifyPlanAdherence(plan);
    expect(issues.some(i =>
      i.type === 'plan_deviation' &&
      i.severity === 'error' &&
      i.message.includes('缺失: invoke_skill(jank_frame_detail)'),
    )).toBe(true);
  });

  it('accepts a completed structured expectedCalls phase after the required skill runs', () => {
    const plan = makePlan({
      phases: [{
        id: 'p1',
        name: 'Root Cause',
        goal: 'Run the specific root-cause skill and supporting SQL',
        expectedTools: ['invoke_skill', 'execute_sql'],
        expectedCalls: [{ tool: 'invoke_skill', skillId: 'jank_frame_detail' }],
        status: 'completed',
        summary: 'Completed root-cause analysis with supporting SQL',
      }],
      toolCallLog: [
        { toolName: 'execute_sql', timestamp: Date.now(), matchedPhaseId: 'p1' },
        {
          toolName: 'invoke_skill',
          timestamp: Date.now(),
          skillId: 'jank_frame_detail',
          matchedPhaseId: 'p1',
        },
      ],
    });

    const issues = verifyPlanAdherence(plan);
    expect(issues.some(i => i.type === 'plan_deviation' && i.severity === 'error')).toBe(false);
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

  it('should error when plan carries unresolvedAspects (Phase 2.3 force-accepted gap)', () => {
    const plan = makePlan({
      phases: [
        { id: 'p1', name: 'Phase 1', goal: 'G', expectedTools: [], status: 'completed', summary: 'Done.' },
      ],
      toolCallLog: [],
      unresolvedAspects: ['startup_timing', 'launch_type_verdict'],
    });
    const issues = verifyPlanAdherence(plan);
    const unresolvedIssue = issues.find(
      i => i.severity === 'error' && i.message.includes('未覆盖场景必要 aspect'),
    );
    expect(unresolvedIssue).toBeDefined();
    expect(unresolvedIssue!.message).toContain('startup_timing');
    expect(unresolvedIssue!.message).toContain('launch_type_verdict');
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

  it('should require deep drill for small but real app jank counts', () => {
    const findings = [makeFinding({ title: 'Jank', description: '真实掉帧 7 帧，App Deadline Missed' })];
    const conclusion = '滑动分析：347帧中真实掉帧 7 帧，主要为 workload_heavy 和 lock_binder_wait。';
    const issues = verifySceneCompleteness('scrolling', findings, conclusion);
    expect(issues.some(i => i.severity === 'error' && i.message.includes('深钻'))).toBe(true);
  });

  it('does not require a mechanical deep drill for prediction-only jank', () => {
    const findings = [makeFinding({
      title: 'Prediction drift',
      description: 'prediction_error 955帧，属于 SurfaceFlinger scheduler prediction drift',
    })];
    const conclusion = '滑动分析：prediction_error 955帧。孤立预测误差通常不代表用户可感知 App 卡顿。';
    const issues = verifySceneCompleteness('scrolling', findings, conclusion);

    expect(issues.some(i => i.message.includes('Phase 1.9') || i.message.includes('深钻'))).toBe(false);
  });

  it('accepts disclosed app attribution gaps without inventing a deep cause', () => {
    const findings = [makeFinding({
      title: 'App deadline misses remain unattributed',
      description: 'app_jank_unattributed 24帧，FrameTimeline 仅确认 App 责任',
    })];
    const conclusion = '当前 trace 缺少可把这 24 帧继续归因到 Binder、GC、锁或调度的直接证据，保持未归因。';
    const issues = verifySceneCompleteness('scrolling', findings, conclusion);

    expect(issues.some(i => i.severity === 'error')).toBe(false);
  });

  it('still requires deep drill when prediction errors coexist with actionable reasons', () => {
    const findings = [makeFinding({
      title: 'Mixed jank',
      description: 'prediction_error 80帧，workload_heavy 20帧',
    })];
    const conclusion = '滑动分析：prediction_error 占 60%，workload_heavy 占 20%，共 100帧掉帧。';
    const issues = verifySceneCompleteness('scrolling', findings, conclusion);

    expect(issues.some(i => i.severity === 'error' && i.message.includes('深钻'))).toBe(true);
  });

  it('does not count lookup_knowledge alone as scrolling deep drill evidence', () => {
    const findings = [makeFinding({ title: 'Jank', description: '真实掉帧 7 帧，App Deadline Missed' })];
    const conclusion = '滑动分析：真实掉帧 7 帧。lookup_knowledge rendering-pipeline 解释了 Android 渲染背景。';
    const issues = verifySceneCompleteness('scrolling', findings, conclusion, [
      { toolName: 'lookup_knowledge', timestamp: Date.now(), inputSummary: 'rendering-pipeline', matchedPhaseId: 'p5' },
    ]);
    expect(issues.some(i => i.severity === 'error' && i.message.includes('深钻'))).toBe(true);
  });

  it.each([
    {
      name: 'a failed deep-drill Skill call',
      call: {
        toolName: 'invoke_skill',
        skillId: 'jank_frame_detail',
        success: false,
        timestamp: 10,
      },
    },
    {
      name: 'a deep-drill skillId attached to the wrong tool',
      call: {
        toolName: 'lookup_knowledge',
        skillId: 'jank_frame_detail',
        success: true,
        timestamp: 10,
      },
    },
  ])('does not count $name as scrolling deep-drill evidence', ({call}) => {
    const findings = [makeFinding({title: 'Jank', description: '真实掉帧 7 帧，App Deadline Missed'})];
    const conclusion = '滑动分析：347帧中真实掉帧 7 帧，主要为 workload_heavy 和 lock_binder_wait。';
    const issues = verifySceneCompleteness('scrolling', findings, conclusion, [call]);

    expect(issues.some(issue =>
      issue.severity === 'error' && issue.message.includes('深钻'),
    )).toBe(true);
  });

  it('should pass scrolling with deep drill evidence present', () => {
    const findings = [makeFinding({ title: 'Jank', description: '掉帧 freq_ramp_slow 64帧 47%' })];
    const conclusion = '滑动分析：136 帧掉帧。blocking_chain_analysis 显示主线程被 Binder 阻塞。lookup_knowledge cpu-scheduler。';
    const issues = verifySceneCompleteness('scrolling', findings, conclusion);
    expect(issues.filter(i => i.message.includes('深钻'))).toHaveLength(0);
  });

  it('should count executed deep-drill tool calls even when the conclusion cites artifact names', () => {
    const findings = [makeFinding({ title: 'Jank', description: '掉帧 freq_ramp_slow 64帧 47%' })];
    const conclusion = '滑动分析：136 帧掉帧。代表帧证据来自 art-21 和 art-16。';
    const issues = verifySceneCompleteness('scrolling', findings, conclusion, [
      { toolName: 'mcp__smartperfetto__invoke_skill', timestamp: Date.now(), skillId: 'jank_frame_detail', matchedPhaseId: 'p5' },
      { toolName: 'mcp__smartperfetto__invoke_skill', timestamp: Date.now(), skillId: 'frame_blocking_calls', matchedPhaseId: 'p5' },
    ]);
    expect(issues.filter(i => i.message.includes('深钻'))).toHaveLength(0);
  });

  it('should warn startup scene missing TTID/TTFD', () => {
    const findings = [makeFinding({ title: 'CPU busy', description: 'Some CPU work' })];
    const issues = verifySceneCompleteness('startup', findings, 'Done');
    expect(issues.some(i => i.message.includes('TTID/TTFD'))).toBe(true);
  });

  it('should pass startup scene with TTID mention and root-cause id reference', () => {
    // Avoid "冷启动" so cold-start-specific checks don't fire. The startup
    // scene-completeness check requires a root-cause id reference
    // (A1-A18 / B1-B12) followed within 30 chars by a context word
    // ("阻塞" / "加载" / "压力" / etc.) so a bare "A2" alone won't pass.
    const findings = [makeFinding({
      title: 'Startup analysis',
      description: 'TTID=850ms。根因 A2: 磁盘 IO 阻塞。',
    })];
    const conclusion = '启动性能分析。根因 A2 磁盘 IO 阻塞导致 TTID 延长。';
    const issues = verifySceneCompleteness('startup', findings, conclusion);
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

  it('should inject scrolling final report contract for incomplete scrolling conclusions', () => {
    const issues = [
      { type: 'missing_reasoning' as const, severity: 'error' as const, message: '结论不完整' },
    ];
    const prompt = generateCorrectionPrompt(issues, '正在分析滑动帧。', 'zh-CN', 'scrolling');
    expect(prompt).toContain('Final Report Contract');
    expect(prompt).toContain('掉帧与根因分布');
    expect(prompt).toContain('代表帧分析');
    expect(prompt).toContain('峰值/口径指标');
  });

  it('should spell out missing Final Report Contract sections during correction', () => {
    const issues = [
      {
        type: 'missing_reasoning' as const,
        severity: 'error' as const,
        message: 'Final Report Contract required structure missing: 代表帧分析',
      },
    ];
    const prompt = generateCorrectionPrompt(issues, '正在分析滑动帧。', 'zh-CN', 'scrolling');
    expect(prompt).toContain('必须补齐的缺失小节');
    expect(prompt).toContain('- 代表帧分析');
    expect(prompt).toContain('清晰同名小节');
  });

  it('should inject startup final report contract instead of scrolling-specific requirements', () => {
    const issues = [
      { type: 'missing_reasoning' as const, severity: 'error' as const, message: '结论不完整' },
    ];
    const prompt = generateCorrectionPrompt(issues, '正在分析启动耗时。', 'zh-CN', 'startup');
    expect(prompt).toContain('Final Report Contract');
    expect(prompt).toContain('启动类型与 TTID/TTFD');
    expect(prompt).toContain('阶段耗时分解');
    expect(prompt).toContain('App/系统分层建议');
    expect(prompt).not.toContain('掉帧与根因分布');
    expect(prompt).not.toContain('代表帧分析');
  });

  it('should use normal correction prompt when conclusion is complete', () => {
    const issues = [
      { type: 'missing_evidence' as const, severity: 'error' as const, message: 'CRITICAL 缺少证据' },
    ];
    const fullConclusion = '## 滑动性能分析报告\n\n### 1. 概览\n' + '详细内容'.repeat(300);
    const prompt = generateCorrectionPrompt(issues, fullConclusion);
    expect(prompt).not.toContain('结论尚未生成');
    expect(prompt).toContain('请修正以下问题');
    expect(prompt).toContain('修正阶段不要调用工具或重新查询数据');
    expect(prompt).toContain('不要把报告标成');
    expect(prompt).toContain('计划执行偏差');
    expect(prompt).toContain('不要声称某个工具或 Skill 未执行');
  });
});

describe('parseVerifierJsonIssues', () => {
  it('parses the first balanced JSON array and ignores prose after it', () => {
    const issues = parseVerifierJsonIssues(
      '```json\n' +
      '[{"type":"missing_evidence","severity":"critical","message":"缺少 art-1 证据"}]\n' +
      '```\n' +
      '补充说明：[不要把这段当作 JSON]',
    );

    expect(issues).toHaveLength(1);
    expect(issues[0].type).toBe('missing_evidence');
    expect(issues[0].message).toContain('art-1');
  });

  it('skips non-JSON bracketed prose before the verifier array', () => {
    const issues = parseVerifierJsonIssues(
      '[ERROR] 需要关注：\n' +
      '[{"type":"severity_mismatch","severity":"warning","message":"单帧异常不应标 critical"}]',
    );

    expect(issues).toHaveLength(1);
    expect(issues[0].type).toBe('severity_mismatch');
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
    const actualFs = jest.requireActual<typeof import('fs')>('fs');
    (mockFs.existsSync as jest.Mock).mockImplementation((...args: unknown[]) => {
      const p = args[0] as string;
      if (typeof p === 'string' && p.includes('learned_misdiagnosis')) return false;
      return actualFs.existsSync(p);
    });
    (mockFs.readFileSync as jest.Mock).mockImplementation((...args: unknown[]) => {
      const p = args[0] as string;
      if (typeof p === 'string' && p.includes('learned_misdiagnosis')) return '[]';
      return actualFs.readFileSync(p, args[1] as BufferEncoding | undefined);
    });
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

  it('should not warn when conclusion ends with a structured evidence reference', () => {
    const conclusion = 'A'.repeat(80) + '\n- evidence_ref_id=data:skill:x; source_ref=滑动区间; row_selector=session_id IN (1,2); column=session_fps; value=109.1,108.2';
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

describe('verifyConclusion progress output', () => {
  it('requires a locatable CodeRef after a successful source lookup', async () => {
    const sourcePlan = makePlan({
      toolCallLog: [
        {
          toolName: 'mcp__smartperfetto__lookup_app_source',
          timestamp: Date.now(),
          matchedPhaseId: 'phase-1',
          success: true,
          returnedCodeReferences: true,
        },
      ],
    });
    const reportWithoutLocation = [
      '## 综合结论',
      '',
      'StartupHooks.kt 显示首帧前存在同步初始化，但当前 trace 证据才是本次发生的证明。',
      '',
      '## 关键证据链',
      '',
      'TTID=1912ms，证据来自 art-10。',
    ].join('\n');

    const missing = await verifyConclusion([], reportWithoutLocation, {
      enableLLM: false,
      plan: sourcePlan,
      outputLanguage: 'zh-CN',
    });
    expect(missing.heuristicIssues).toContainEqual(expect.objectContaining({
      type: 'missing_evidence',
      severity: 'error',
      message: expect.stringContaining('relative/path/File.kt:L10-L20'),
    }));

    const locatable = await verifyConclusion(
      [],
      `${reportWithoutLocation}\n\n源码定位：app/src/main/java/demo/StartupHooks.kt:L10-L20。`,
      {
        enableLLM: false,
        plan: sourcePlan,
        outputLanguage: 'zh-CN',
      },
    );
    expect(locatable.heuristicIssues.filter(issue =>
      issue.message.includes('relative/path/File.kt:L10-L20'),
    )).toHaveLength(0);
  });

  it('does not require a CodeRef when the source lookup returned no references', async () => {
    const sourcePlan = makePlan({
      toolCallLog: [{
        toolName: 'lookup_app_source',
        timestamp: Date.now(),
        matchedPhaseId: 'phase-1',
        success: true,
      }],
    });

    const result = await verifyConclusion([], '## 综合结论\n\n源码查询无命中，结论仅使用 trace 证据。', {
      enableLLM: false,
      plan: sourcePlan,
      outputLanguage: 'zh-CN',
    });
    expect(result.heuristicIssues.filter(issue =>
      issue.message.includes('relative/path/File.kt:L10-L20'),
    )).toHaveLength(0);
  });

  it('treats missing startup final-report contract sections as correction errors', async () => {
    const conclusion = [
      '# 启动性能分析报告',
      '',
      '## 启动类型与 TTID/TTFD',
      '本次为冷启动，TTID=1912ms，TTFD 不可用。',
      '',
      '## 阶段耗时分解',
      'startup_detail 显示 ChaosTask self_ms=456ms，dur_ms=1338ms。',
      '',
      '## 根因编号引用',
      'SR12 对应三方 SDK 初始化过重，SR19 对应并发启动干扰。',
      '',
      '## 优化建议',
      '[App层] 延迟非关键初始化到首帧后。',
      '',
      'JIT 编译影响可排除；startup_slow_reasons 已交叉验证。',
    ].join('\n');

    const result = await verifyConclusion([], conclusion, {
      enableLLM: false,
      sceneType: 'startup',
      query: '分析启动性能',
    });

    expect(result.passed).toBe(false);
    expect(result.heuristicIssues).toContainEqual(expect.objectContaining({
      type: 'missing_reasoning',
      severity: 'error',
      message: expect.stringContaining('App/系统分层建议'),
    }));
  });

  it('passes sceneType into heuristic misdiagnosis matching', async () => {
    const result = await verifyConclusion([], 'VSync 对齐异常严重，且报告正文已经足够长以通过长度检查。', {
      enableLLM: false,
      sceneType: 'pipeline',
    });

    expect(result.heuristicIssues).toContainEqual(expect.objectContaining({
      type: 'known_misdiagnosis',
      severity: 'warning',
      message: expect.stringContaining('VRR'),
    }));
  });

  it('emits user-facing progress without exposing internal issue details', async () => {
    const emitted: any[] = [];

    const result = await verifyConclusion([], 'short', {
      enableLLM: false,
      plan: null,
      emitUpdate: update => emitted.push(update),
      outputLanguage: 'zh-CN',
    });

    expect(result.passed).toBe(false);
    const progressMessages = emitted
      .filter(update => update.type === 'progress')
      .map(update => String(update.content?.message || ''));
    expect(progressMessages).toEqual(expect.arrayContaining([
      '质量校验记录了报告改进项，系统会根据严重程度决定自动修正或交由最终门禁处理。',
    ]));
    expect(progressMessages.join('\n')).not.toContain('[ERROR]');
    expect(progressMessages.join('\n')).not.toContain('未提交分析计划');
    expect(progressMessages.join('\n')).not.toContain('验证发现');
  });

  it('can suppress user-facing issue progress when final gates remain authoritative', async () => {
    const emitted: any[] = [];

    const result = await verifyConclusion([], 'short', {
      enableLLM: false,
      plan: null,
      emitUpdate: update => emitted.push(update),
      emitIssueProgress: false,
      outputLanguage: 'zh-CN',
    });

    expect(result.passed).toBe(false);
    expect(emitted.filter(update => update.type === 'progress')).toHaveLength(0);
  });

  it('uses the request-pinned Claude provider env and light model for LLM verification', async () => {
    const original = {
      anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL,
      anthropicApiKey: process.env.ANTHROPIC_API_KEY,
      claudeModel: process.env.CLAUDE_MODEL,
      claudeLightModel: process.env.CLAUDE_LIGHT_MODEL,
      claudeBinaryPath: process.env.CLAUDE_BINARY_PATH,
    };
    process.env.ANTHROPIC_BASE_URL = 'https://global-verifier.example/v1';
    process.env.ANTHROPIC_API_KEY = 'sk-global-verifier';
    process.env.CLAUDE_MODEL = 'global-claude-main';
    process.env.CLAUDE_LIGHT_MODEL = 'global-claude-light';
    process.env.CLAUDE_BINARY_PATH = '/tmp/global-verifier-claude';
    try {
      const provider = getProviderService().create({
        name: 'Pinned Claude verifier provider',
        category: 'official',
        type: 'anthropic',
        models: {
          primary: 'provider-claude-main',
          light: 'provider-claude-verifier',
        },
        connection: {
          agentRuntime: 'claude-agent-sdk',
          claudeBaseUrl: 'https://provider-claude-verifier.example/v1',
          claudeApiKey: 'sk-provider-verifier',
        },
        tuning: {
          verifierTimeoutMs: 23_456,
        },
      });

      await verifyConclusion([], 'short', {
        enableLLM: true,
        lightModel: 'provider-claude-verifier',
        verifierTimeoutMs: 23_456,
        providerId: provider.id,
      } as any);

      expect(claudeSdkMock.query).toHaveBeenCalledTimes(1);
      const call = claudeSdkMock.query.mock.calls[0]?.[0] as any;
      expect(call.options.model).toBe('provider-claude-verifier');
      expect(call.options.pathToClaudeCodeExecutable).toBe('/tmp/global-verifier-claude');
      expect(call.options.env.CLAUDE_MODEL).toBe('provider-claude-main');
      expect(call.options.env.CLAUDE_LIGHT_MODEL).toBe('provider-claude-verifier');
      expect(call.options.env.ANTHROPIC_BASE_URL).toBe('https://provider-claude-verifier.example/v1');
      expect(call.options.env.ANTHROPIC_API_KEY).toBe('sk-provider-verifier');
      expect(process.env.ANTHROPIC_BASE_URL).toBe('https://global-verifier.example/v1');
      expect(process.env.ANTHROPIC_API_KEY).toBe('sk-global-verifier');
      expect(process.env.CLAUDE_MODEL).toBe('global-claude-main');
      expect(process.env.CLAUDE_LIGHT_MODEL).toBe('global-claude-light');
      expect(process.env.CLAUDE_BINARY_PATH).toBe('/tmp/global-verifier-claude');
    } finally {
      restoreEnvValue('ANTHROPIC_BASE_URL', original.anthropicBaseUrl);
      restoreEnvValue('ANTHROPIC_API_KEY', original.anthropicApiKey);
      restoreEnvValue('CLAUDE_MODEL', original.claudeModel);
      restoreEnvValue('CLAUDE_LIGHT_MODEL', original.claudeLightModel);
      restoreEnvValue('CLAUDE_BINARY_PATH', original.claudeBinaryPath);
    }
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
