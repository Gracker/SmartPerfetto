// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { ENTERPRISE_FEATURE_FLAG_ENV } from '../../config';
import { sessionContextManager } from '../../agent/context/enhancedSessionContext';
import { ENTERPRISE_DB_PATH_ENV, openEnterpriseDb } from '../../services/enterpriseDb';
import {
  ENTERPRISE_MIGRATION_CUTOVER_CONFIRMED_ENV,
  ENTERPRISE_MIGRATION_PHASE_ENV,
} from '../../services/enterpriseMigration';
import { getProviderService, resetProviderService } from '../../services/providerManager';
import {SECRET_STORE_MASTER_KEY_ENV} from '../../services/providerManager/localSecretStore';
import { saveClaudeSessionMapToRuntimeSnapshots } from '../../services/runtimeSnapshotStore';
import type { TraceProcessorService } from '../../services/traceProcessorService';
import * as quickEvidenceDirectAnswer from '../../agentRuntime/quickEvidenceDirectAnswer';
import * as runtimePromptContext from '../../agentRuntime/runtimePromptContext';
import {createRuntimePerformanceRecorder, createRuntimePerformanceRun} from '../../agentRuntime/runtimePerformance';
import {evaluationRuntimeCapabilities} from '../../services/selfEvolution/evaluationRuntimeCapabilities';
import * as sqlKnowledgeBase from '../../services/sqlKnowledgeBase';
import * as skillLoader from '../../services/skillEngine/skillLoader';
import * as skillAnalysisAdapter from '../../services/skillEngine/skillAnalysisAdapter';
import {
  withEffectiveRuntimeRegistrySnapshot,
  type EffectiveRuntimeRegistrySnapshot,
} from '../../services/selfEvolution/effectiveRuntimeRegistryContext';
import {
  clearCodeAwareOutputGuards,
  registerCodeAwareCanary,
} from '../../services/security/codeAwareOutputRegistry';
import * as focusAppDetector from '../focusAppDetector';
import * as architectureDetector from '../../agent/detectors/architectureDetector';
import * as traceCompletenessProber from '../traceCompletenessProber';
import {
  snapshotEvaluationUsageReceipt,
  withEvaluationTelemetry,
} from '../../services/selfEvolution/evaluationTelemetry';
import { ClaudeRuntime, __testing } from '../claudeRuntime';
import * as claudeMcpServer from '../claudeMcpServer';
import {
  createRuntimeSourceFinalizationFixture,
  SOURCE_FINALIZATION_CANARY,
  SOURCE_FINALIZATION_RAW_SOURCE,
} from '../../agentRuntime/__tests__/sourceFinalizationFixture';
import type {RunManifestAttributionSink} from '../../types/selfEvolution';

const mockClaudeVerifierVerifyConclusion = jest.fn();
jest.mock('../../agentRuntime/engines/claude/claudeVerifier', () => {
  const actual = jest.requireActual('../../agentRuntime/engines/claude/claudeVerifier') as any;
  return {
    ...actual,
    verifyConclusion: (...args: unknown[]) => mockClaudeVerifierVerifyConclusion(...args),
  };
});

const claudeSdkMock = require('@anthropic-ai/claude-agent-sdk') as {
  __setQueryImplementation: (impl: (params: any) => AsyncIterable<any>) => void;
  __getQueryCalls: () => any[];
  __resetQueryMock: () => void;
};

const originalEnv = {
  enterprise: process.env[ENTERPRISE_FEATURE_FLAG_ENV],
  enterpriseDbPath: process.env[ENTERPRISE_DB_PATH_ENV],
  migrationPhase: process.env[ENTERPRISE_MIGRATION_PHASE_ENV],
  cutoverConfirmed: process.env[ENTERPRISE_MIGRATION_CUTOVER_CONFIRMED_ENV],
  providerDataDirOverride: process.env.PROVIDER_DATA_DIR_OVERRIDE,
  secretStoreMasterKey: process.env[SECRET_STORE_MASTER_KEY_ENV],
  precompactThreshold: process.env.CLAUDE_PRECOMPACT_THRESHOLD,
  precompactWarnEnabled: process.env.CLAUDE_PRECOMPACT_WARN_ENABLED,
  admittedRuntimeCandidates: process.env.SMARTPERFETTO_ADMITTED_RUNTIME_CANDIDATES,
};

let tmpDir: string | undefined;
let dbPath: string;

function restoreEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

function runtimeSnapshotCount(): number {
  const db = openEnterpriseDb(dbPath);
  try {
    const row = db.prepare<unknown[], { count: number }>(
      'SELECT COUNT(*) AS count FROM runtime_snapshots',
    ).get();
    return row?.count ?? 0;
  } finally {
    db.close();
  }
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createNoopAttributionSink(
  runtimePerformanceRecorder = createRuntimePerformanceRecorder(),
): RunManifestAttributionSink {
  return {
    identity: {
      runId: 'run-claude-test',
      sessionId: 'session-claude',
      scope: {
        tenantId: 'tenant-test',
        workspaceId: 'workspace-test',
      },
    },
    runtimePerformanceRecorder,
    recordScene: jest.fn(),
    recordRuntime: jest.fn(),
    recordMode: jest.fn(),
    recordAdaptiveRouting: jest.fn(),
    recordCapabilityManifest: jest.fn(),
    recordSkillRegistry: jest.fn(),
    startSkillInvocation: jest.fn(() => 'skill-invocation-test'),
    finishSkillInvocation: jest.fn(),
    recordUnknownSkillInvocation: jest.fn(),
    recordSqlStatement: jest.fn(),
    recordPromptTemplate: jest.fn(),
    recordInjection: jest.fn(),
    recordToolAllowlist: jest.fn(),
    recordTurn: jest.fn(),
  };
}

function createEffectiveRuntimeRegistrySnapshot(): EffectiveRuntimeRegistrySnapshot {
  const skillRegistry = {
    registryFingerprint: 'registry-test',
    overlayGeneration: 'overlay-test',
    isInitialized: () => true as const,
    getSkill: () => undefined,
    getAllSkills: () => [],
    getFragmentCache: () => new Map<string, string>(),
    getSkillOrigin: () => undefined,
    getAppliedOverlayIds: () => [],
    getVendorOverride: () => undefined,
    getVendorOverridesForSkill: () => [],
    getVendorOverrideLoadIssues: () => [],
    findMatchingSkill: () => undefined,
  };
  return {
    scope: {tenantId: 'tenant-test', workspaceId: 'workspace-test'},
    baseSkillRegistryFingerprint: 'base-skills-test',
    baseStrategyRegistryFingerprint: 'base-strategies-test',
    overlayGeneration: 'overlay-test',
    skillRegistry,
    strategyRegistry: {
      registryFingerprint: 'strategy-registry-test',
      overlayGeneration: 'overlay-test',
      getStrategy: () => undefined,
      getAllStrategies: () => [],
    },
    skillNotes: {
      registryFingerprint: 'skill-notes-test',
      getSkillNotes: () => [],
      getSkillIds: () => [],
    },
  };
}

beforeEach(async () => {
  const actualVerifier = jest.requireActual('../../agentRuntime/engines/claude/claudeVerifier') as any;
  mockClaudeVerifierVerifyConclusion.mockReset();
  mockClaudeVerifierVerifyConclusion.mockImplementation((...args: unknown[]) => (
    actualVerifier.verifyConclusion(...args)
  ));
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smartperfetto-claude-runtime-snapshot-'));
  dbPath = path.join(tmpDir, 'enterprise.sqlite');
  process.env[ENTERPRISE_FEATURE_FLAG_ENV] = 'true';
  process.env[ENTERPRISE_DB_PATH_ENV] = dbPath;
  process.env[ENTERPRISE_MIGRATION_PHASE_ENV] = 'cutover';
  process.env[ENTERPRISE_MIGRATION_CUTOVER_CONFIRMED_ENV] = 'true';
  process.env.PROVIDER_DATA_DIR_OVERRIDE = tmpDir;
  process.env[SECRET_STORE_MASTER_KEY_ENV] = Buffer.alloc(32, 17).toString('base64');
  resetProviderService();
});

afterEach(async () => {
  claudeSdkMock.__resetQueryMock();
  clearCodeAwareOutputGuards('session-private-stream-recovery');
  sessionContextManager.remove('session-a');
  sessionContextManager.remove('session-quick');
  sessionContextManager.remove('session-quick-focus-evidence');
  sessionContextManager.remove('session-quick-selection-trace-fact');
  sessionContextManager.remove('session-language-quick');
  sessionContextManager.remove('session-language-full');
  sessionContextManager.remove('session-provider');
  restoreEnvValue(ENTERPRISE_FEATURE_FLAG_ENV, originalEnv.enterprise);
  restoreEnvValue(ENTERPRISE_DB_PATH_ENV, originalEnv.enterpriseDbPath);
  restoreEnvValue(ENTERPRISE_MIGRATION_PHASE_ENV, originalEnv.migrationPhase);
  restoreEnvValue(ENTERPRISE_MIGRATION_CUTOVER_CONFIRMED_ENV, originalEnv.cutoverConfirmed);
  restoreEnvValue('PROVIDER_DATA_DIR_OVERRIDE', originalEnv.providerDataDirOverride);
  restoreEnvValue(SECRET_STORE_MASTER_KEY_ENV, originalEnv.secretStoreMasterKey);
  restoreEnvValue('CLAUDE_PRECOMPACT_THRESHOLD', originalEnv.precompactThreshold);
  restoreEnvValue('CLAUDE_PRECOMPACT_WARN_ENABLED', originalEnv.precompactWarnEnabled);
  restoreEnvValue(
    'SMARTPERFETTO_ADMITTED_RUNTIME_CANDIDATES',
    originalEnv.admittedRuntimeCandidates,
  );
  resetProviderService();
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

describe('ClaudeRuntime enterprise runtime_snapshots session map', () => {
  it('does not manufacture a final report from completed plan evidence', () => {
    const recovered = __testing.recoverClaudeInterruptedFinalReport({
      accumulatedAnswer: '',
      plan: {
        phases: [
          {
            id: 'p1',
            name: '启动概览',
            goal: '确认启动指标',
            expectedTools: ['invoke_skill'],
            status: 'completed',
            summary: '冷启动 TTID=1912ms，证据来自 art-1。',
          },
          {
            id: 'p2',
            name: '综合结论',
            goal: '输出最终报告',
            expectedTools: [],
            status: 'pending',
          },
        ],
        successCriteria: '形成可验证结论',
        submittedAt: 1,
        toolCallLog: [],
      },
      hypotheses: [],
      outputLanguage: 'zh-CN',
    });

    expect(recovered).toBeUndefined();
  });

  it('preserves an evidence-backed truncated answer when recovering an interrupted report', () => {
    const recovered = __testing.recoverClaudeInterruptedFinalReport({
      accumulatedAnswer: [
        '# 启动性能分析报告',
        '',
        '## 综合结论',
        '',
        '冷启动 TTID=1912ms，主线程热点 568.8ms，证据来自 art-1。',
        '',
        '## 优化建议',
        '',
        '- 拆分主线程初始化中的同步热点任务',
      ].join('\n'),
      plan: null,
      hypotheses: [],
      outputLanguage: 'zh-CN',
    });

    expect(recovered).toContain('冷启动 TTID=1912ms，主线程热点 568.8ms');
    expect(recovered).not.toContain('拆分主线程初始化中的同步热点任务');
    expect(recovered).toContain('## 截断恢复补充');
  });

  it('rejects metric-bearing process narration instead of promoting plan evidence', () => {
    const recovered = __testing.recoverClaudeInterruptedFinalReport({
      accumulatedAnswer:
        '我需要继续执行 Phase 2，并调用 update_plan_phase。当前看到 TTID=9999ms，但还不能输出结论。',
      plan: {
        phases: [{
          id: 'p1',
          name: '启动概览',
          goal: '确认启动指标',
          expectedTools: ['invoke_skill'],
          status: 'completed',
          summary: '已验证冷启动 TTID=1912ms，证据来自 art-1。',
        }],
        successCriteria: '形成可验证结论',
        submittedAt: 1,
        toolCallLog: [],
      },
      hypotheses: [],
      outputLanguage: 'zh-CN',
    });

    expect(recovered).toBeUndefined();
  });

  it('only treats bounded mid-stream failures as recoverable', () => {
    const recoverable = (errorMessage: string, hasPartialEvidence = true) =>
      __testing.isRecoverableClaudeStreamInterruption({
        errorMessage,
        streamStarted: true,
        hasPartialEvidence,
        quotaExceeded: false,
      });

    expect(recoverable('stream terminated before completion')).toBe(true);
    expect(recoverable('Claude analysis error after tool execution')).toBe(false);
    expect(recoverable('Claude analysis error after tool execution', false)).toBe(false);
    expect(recoverable('401 unauthorized: invalid API key')).toBe(false);
    expect(recoverable('No conversation found with session ID sdk-a')).toBe(false);
    expect(recoverable('permission denied for configured cwd')).toBe(false);
    expect(__testing.isRecoverableClaudeStreamInterruption({
      errorMessage: 'stream terminated before completion',
      streamStarted: true,
      hasPartialEvidence: true,
      quotaExceeded: true,
    })).toBe(false);
  });

  it('does not mark a correction timeout partial when the existing conclusion is deliverable', () => {
    const conclusion =
      '我来分析这个 WebView 应用的启动性能。首先提交分析计划并获取启动概览数据。计划已提交。开始 Phase 1：获取启动概览数据。\n\n' +
      '# 启动性能分析报告\n\n' +
      '## 综合结论\n\n' +
      '冷启动 TTID=1912ms，主因是主线程 ChaosTask 模拟负载，证据来自 art-1 与 art-2。\n\n' +
      '## 关键证据链\n\n' +
      '- art-1: startup_analysis 显示冷启动。\n' +
      '- art-2: main thread running=63%。\n\n' +
      '## 优化建议\n\n' +
      '- App 侧：削减 ChaosTask 初始化负载。\n' +
      '- 系统侧：当前无明确系统瓶颈。';

    expect(__testing.sanitizeClaudeConclusionText(conclusion).startsWith('# 启动性能分析报告')).toBe(true);
    expect(__testing.shouldMarkCorrectionTimeoutPartial({
      correctedResult: '',
      existingConclusion: conclusion,
    })).toBe(false);
  });

  it('marks a correction timeout partial when neither correction nor existing conclusion is deliverable', () => {
    expect(__testing.shouldMarkCorrectionTimeoutPartial({
      correctedResult: '',
      existingConclusion: '我需要继续调用工具补齐 Phase 2，并稍后输出报告。',
    })).toBe(true);
  });

  it('gives correction retries enough per-turn budget for streamed report output', () => {
    expect(__testing.getCorrectionRetryTimeoutMs(5, false)).toBe(225_000);
    expect(__testing.getCorrectionRetryTimeoutMs(10, true)).toBe(300_000);
  });

  it('only skips SDK correction for deliverable reports when errors are non-content blockers', () => {
    const deliverable =
      '# 启动性能分析报告\n\n' +
      '## 综合结论\n\n' +
      '冷启动 TTID=1912ms，主因是 ChaosTask，证据来自 art-1。\n\n' +
      '## 关键证据链\n\n' +
      '- art-1: ChaosTask self_ms=456ms。\n\n' +
      '## 优化建议\n\n' +
      '- 延迟模拟负载。';

    expect(__testing.shouldSkipSdkCorrectionForDeliverableConclusion([
      { type: 'plan_deviation', severity: 'error', message: '阶段未完成' },
    ], deliverable)).toBe(true);

    expect(__testing.shouldSkipSdkCorrectionForDeliverableConclusion([
      { type: 'missing_evidence', severity: 'error', message: '缺少证据' },
    ], deliverable)).toBe(false);

    expect(__testing.shouldSkipSdkCorrectionForDeliverableConclusion([
      {
        type: 'missing_reasoning',
        severity: 'error',
        message: '最终报告缺失 Final Report Contract 必需结构：App/系统分层建议。',
      },
    ], deliverable)).toBe(false);

    expect(__testing.shouldSkipSdkCorrectionForDeliverableConclusion([
      { type: 'truncation', severity: 'error', message: '结论文本被截断' },
    ], deliverable)).toBe(false);

    expect(__testing.shouldSkipSdkCorrectionForDeliverableConclusion([
      { type: 'missing_reasoning', severity: 'error', message: '结论不完整' },
    ], '我还需要继续分析，稍后输出报告。')).toBe(false);
  });

  it('does not run SDK correction for soft truncation false positives on complete reports', () => {
    const report =
      '# 滑动性能分析报告\n\n' +
      '## 综合结论\n\n' +
      '滑动窗口总帧数 347，真实掉帧 7 帧，最长帧 62.73ms，主因是 CustomScroll_longFrameLoad。' +
      '证据来自 evidence_ref_id=data:skill:scrolling_analysis:summary 与 source_ref=art-7。\n\n' +
      '## 关键证据链\n\n' +
      Array.from({ length: 20 }, (_, idx) =>
        `- art-${idx + 1}: frame_id=${idx + 100}, dur=${30 + idx}.1ms, reason_code=workload_heavy。`,
      ).join('\n') +
      '\n\n## 优化建议\n\n' +
      '- 拆分 CustomScroll_longFrameLoad，移出 Choreographer animation 回调。\n\n' +
      '- source_ref=art-7 value=CustomScroll_longFrameLoad 59.31ms';

    expect(__testing.looksLikeSoftTruncationFalsePositive(report)).toBe(true);
    expect(__testing.shouldSkipSdkCorrectionForDeliverableConclusion([
      { type: 'truncation', severity: 'error', message: '结论文本被截断' },
    ], report)).toBe(true);

    expect(__testing.shouldSkipSdkCorrectionForDeliverableConclusion([
      { type: 'truncation', severity: 'error', message: '结论文本被截断' },
      { type: 'missing_reasoning', severity: 'error', message: '缺少报告结构' },
    ], report)).toBe(false);
  });

  it('still runs SDK correction for hard truncation of an otherwise structured report', () => {
    const report =
      '# 滑动性能分析报告\n\n' +
      '## 综合结论\n\n' +
      '滑动窗口总帧数 347，真实掉帧 7 帧，最长帧 62.73ms，证据来自 evidence_ref_id=data:art-1。\n\n' +
      '## 关键证据链\n\n' +
      Array.from({ length: 20 }, (_, idx) =>
        `- art-${idx + 1}: frame_id=${idx + 100}, dur=${30 + idx}.1ms, reason_code=workload_heavy。`,
      ).join('\n') +
      '\n\n## 优化建议\n\n' +
      '因此下一步需要继续';

    expect(__testing.looksLikeSoftTruncationFalsePositive(report)).toBe(false);
    expect(__testing.shouldSkipSdkCorrectionForDeliverableConclusion([
      { type: 'truncation', severity: 'error', message: '结论文本被截断' },
    ], report)).toBe(false);
  });

  it('prefers a streamed deliverable report over a terse terminal summary before verification', () => {
    const chosen = __testing.chooseClaudeConclusionText({
      finalResult: '**总结**：冷启动 TTID 1912ms，主因是 ChaosTask。',
      accumulatedAnswer:
        '我来分析这个 WebView 应用的启动性能。开始 Phase 1：获取启动概览数据。\n\n' +
        '# 启动性能分析报告\n\n' +
        '## 综合结论\n\n' +
        '冷启动 TTID=1912ms，主因是主线程 ChaosTask 模拟负载，证据来自 art-1 与 art-2。\n\n' +
        '## 关键证据链\n\n' +
        '- art-1: startup_analysis 显示冷启动。\n' +
        '- art-2: main thread running=63%。\n\n' +
        '## 优化建议\n\n' +
        '- App 侧：削减 ChaosTask 初始化负载。',
    });

    expect(chosen.startsWith('# 启动性能分析报告')).toBe(true);
    expect(chosen).not.toContain('我来分析这个 WebView 应用');
  });

  it('adds a scene report heading for structured reports that start with a domain annotation', () => {
    const normalized = __testing.ensureClaudeFinalReportHeading(
      '所有深钻数据已收集完毕。现在输出综合结论。\n\n' +
      '## ⚠️ 测试/基准应用标注\n\n' +
      'CustomScroll_longFrameLoad 是测试负载。\n\n' +
      '## 1. 概览\n\n' +
      '总帧数 347，真实掉帧 7 帧，最长帧 62.73ms，掉帧率 2.02%。' +
      '证据来自 evidence_ref_id=data:art-4 与 source_ref=滑动性能概览。' +
      '根因集中在 animation 回调内的 CustomScroll_longFrameLoad，同步占用主线程 59.31ms。' +
      'RenderThread 仅 1.88ms，说明瓶颈不在渲染线程。' +
      '优化建议是拆分长负载并移出 Choreographer animation 回调。',
      'scrolling',
      'zh-CN',
    );

    expect(normalized.startsWith('# 滑动性能分析报告')).toBe(true);
    expect(normalized).not.toContain('所有深钻数据已收集完毕');
  });

  it('strips process narration that appears after an inserted scene report heading', () => {
    const normalized = __testing.ensureClaudeFinalReportHeading(
      '我来分析这个 trace 的滑动性能。首先提交分析计划并获取 trace 时间范围。计划缺少架构特定分析阶段，需要补充。重新提交完整计划。计划已提交。\n\n' +
      '## ⚠️ 测试/基准应用标注\n\n' +
      'CustomScroll_longFrameLoad 是测试负载。\n\n' +
      '## 1. 概览\n\n' +
      '总帧数 347，真实掉帧 7 帧，最长帧 62.73ms。证据来自 evidence_ref_id=data:art-4 与 source_ref=滑动性能概览。\n\n' +
      '## 优化建议\n\n' +
      '- App 侧：拆分 CustomScroll_longFrameLoad。',
      'scrolling',
      'zh-CN',
    );

    expect(normalized.startsWith('# 滑动性能分析报告')).toBe(true);
    expect(normalized).not.toContain('我来分析这个 trace');
    expect(normalized).not.toContain('计划缺少架构特定分析阶段');
    expect(normalized).toContain('## ⚠️ 测试/基准应用标注');
  });

  it('normalizes bridge conclusion updates before they reach session logs', () => {
    const normalized = __testing.normalizeClaudeBridgeConclusionUpdate({
      type: 'conclusion',
      content: {
        conclusion:
          '所有假设已解决，数据收集完整。输出最终报告：\n\n' +
          '# 滑动性能分析报告\n\n' +
          '## 综合结论\n\n' +
          '真实掉帧 7 帧，证据来自 evidence_ref_id=data:art-1。\n\n' +
          '## 优化建议\n\n' +
          '- 拆分长任务。',
      },
      timestamp: 1,
    } as any, 'scrolling', 'zh-CN');

    expect((normalized.content as any).conclusion).toMatch(/^# 滑动性能分析报告/);
    expect((normalized.content as any).conclusion).not.toContain('输出最终报告');
  });

  it('strips completed-data narration before startup report headings', () => {
    const normalized = __testing.sanitizeClaudeConclusionText(
      '所有数据收集完毕，开始撰写综合结论报告。\n\n' +
      '---\n\n' +
      '## 启动性能分析报告：`com.example.launch.aosp.heavy`\n\n' +
      '### 1. 概览\n\n' +
      '冷启动 TTID=1912ms，主因是 ChaosTask，证据来自 evidence_ref_id=data:art-1。\n\n' +
      '### 2. 优化建议\n\n' +
      '- 保留测试应用标注。',
    );

    expect(normalized).toMatch(/^## 启动性能分析报告/);
    expect(normalized).not.toContain('所有数据收集完毕');
  });

  it('strips correction scaffold from corrected reports', () => {
    const normalized = __testing.sanitizeClaudeConclusionText(
      '# 滑动性能分析报告\n\n' +
      '## 滑动性能分析报告（修正版）\n\n' +
      '> ⚠️ **计划执行偏差（p1.5 + p2）**\n' +
      '>\n' +
      '> - **p1.5**: invoke_skill(process_identity_resolver) 未执行。\n\n' +
      '---\n\n' +
      '### 概览\n\n' +
      '滑动总帧 347，真实掉帧 7，最长帧 62.73ms。',
    );

    expect(normalized).toMatch(/^# 滑动性能分析报告\n\n### 概览/);
    expect(normalized).not.toContain('修正版');
    expect(normalized).not.toContain('计划执行偏差');
    expect((normalized.match(/滑动性能分析报告/g) || [])).toHaveLength(1);
  });

  it('strips tool-not-executed correction scaffold from corrected reports', () => {
    const normalized = __testing.sanitizeClaudeConclusionText(
      '# 滑动性能分析报告\n\n' +
      '> ⚠️ **架构检测置信度低**（`detect_architecture` Skill 本次未执行，架构类型按标准 HWUI 处理）。\n\n' +
      '## 一、概览\n\n' +
      '滑动总帧 347，真实掉帧 7，证据来自 evidence_ref_id=data:skill:scrolling_analysis。\n\n' +
      '## 优化建议\n\n' +
      '- 移除 animation 回调中的长任务。',
    );

    expect(normalized).toContain('架构检测置信度低');
    expect(normalized).toContain('架构类型按标准 HWUI 处理');
    expect(normalized).not.toContain('Skill 本次未执行');
    expect(normalized).not.toContain('detect_architecture` Skill');
  });

  it('recognizes missing SDK conversations from object-shaped result errors', () => {
    const message = __testing.getSdkResultErrorMessage({
      type: 'result',
      subtype: 'error_during_execution',
      errors: [{ message: 'No conversation found with session ID: sdk-session-a' }],
    });

    expect(message).toBe('Claude analysis error (error_during_execution): No conversation found with session ID: sdk-session-a');
    expect(__testing.isMissingSdkConversationError(message!)).toBe(true);
  });

  it('loads SDK session mappings from runtime_snapshots on construction', () => {
    const now = Date.now();
    saveClaudeSessionMapToRuntimeSnapshots({
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
      userId: 'user-a',
      sessionId: 'session-a',
      runId: 'run-a',
      traceId: 'trace-a',
    }, 'session-a', {
      sdkSessionId: 'sdk-session-a',
      updatedAt: now,
      mode: 'full',
    });

    const runtime = new ClaudeRuntime({} as any, {
      enableVerification: false,
      enableSubAgents: false,
    });

    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      expect(runtime.getSdkSessionId('session-a')).toBe('sdk-session-a');
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('does not expose stale SDK session mappings for persistence', () => {
    const now = 1_700_000_000_000;
    saveClaudeSessionMapToRuntimeSnapshots({
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
      userId: 'user-a',
      sessionId: 'session-a',
      runId: 'run-a',
      traceId: 'trace-a',
    }, 'session-a', {
      sdkSessionId: 'sdk-session-a',
      updatedAt: now - (5 * 60 * 60 * 1000),
      mode: 'full',
    });

    const runtime = new ClaudeRuntime({} as any, {
      enableVerification: false,
      enableSubAgents: false,
    });

    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      expect(runtime.getSdkSessionId('session-a')).toBeUndefined();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('removes enterprise runtime_snapshots rows during session cleanup', () => {
    saveClaudeSessionMapToRuntimeSnapshots({
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
      userId: 'user-a',
      sessionId: 'session-a',
      runId: 'run-a',
      traceId: 'trace-a',
    }, 'session-a', {
      sdkSessionId: 'sdk-session-a',
      updatedAt: Date.now(),
      mode: 'full',
    });
    expect(runtimeSnapshotCount()).toBe(1);

    const runtime = new ClaudeRuntime({} as any, {
      enableVerification: false,
      enableSubAgents: false,
    });

    runtime.removeSession('session-a');
    expect(runtimeSnapshotCount()).toBe(0);
  });

  it('forgets stale SDK mappings when the remote conversation is gone', () => {
    saveClaudeSessionMapToRuntimeSnapshots({
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
      userId: 'user-a',
      sessionId: 'session-a',
      runId: 'run-a',
      traceId: 'trace-a',
    }, 'session-a', {
      sdkSessionId: 'sdk-session-a',
      updatedAt: Date.now(),
      mode: 'full',
    });
    saveClaudeSessionMapToRuntimeSnapshots({
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
      userId: 'user-a',
      sessionId: 'session-a',
      runId: 'run-a',
      traceId: 'trace-a',
    }, 'session-a:ref:trace-b', {
      sdkSessionId: 'sdk-session-b',
      updatedAt: Date.now(),
      mode: 'full',
    });
    expect(runtimeSnapshotCount()).toBe(2);

    const runtime = new ClaudeRuntime({} as any, {
      enableVerification: false,
      enableSubAgents: false,
    });

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      (runtime as any).forgetSdkSessionMapping(
        'session-a',
        'session-a',
        'Claude analysis error (error_during_execution): No conversation found with session ID: sdk-session-a',
      );
    } finally {
      warnSpy.mockRestore();
    }

    expect(runtime.getSdkSessionId('session-a')).toBeUndefined();
    expect(runtimeSnapshotCount()).toBe(1);
  });

  it('restores full-mode snapshot SDK mappings with the snapshot timestamp', () => {
    const runtime = new ClaudeRuntime({} as any, {
      enableVerification: false,
      enableSubAgents: false,
    });
    const snapshotTimestamp = Date.now() - (5 * 60 * 60 * 1000);

    runtime.restoreFromSnapshot('session-a', 'trace-a', {
      version: 1,
      snapshotTimestamp,
      sessionId: 'session-a',
      traceId: 'trace-a',
      conversationSteps: [],
      queryHistory: [],
      conclusionHistory: [],
      agentDialogue: [],
      agentResponses: [],
      dataEnvelopes: [],
      hypotheses: [],
      analysisNotes: [],
      analysisPlan: null,
      planHistory: [],
      uncertaintyFlags: [],
      engineState: {
        kind: 'claude-agent-sdk',
        provider: { providerId: null, providerSnapshotHash: null },
        claude: {
          sdkSessionId: 'sdk-session-a',
          sdkSessionMode: 'full',
        },
      },
      runSequence: 0,
      conversationOrdinal: 0,
    });

    expect((runtime as any).sessionMap.get('session-a')).toEqual(expect.objectContaining({
      sdkSessionId: 'sdk-session-a',
      updatedAt: snapshotTimestamp,
      mode: 'full',
    }));
  });

  it('restores full-mode comparison snapshot SDK mappings under the comparison key', () => {
    const runtime = new ClaudeRuntime({} as any, {
      enableVerification: false,
      enableSubAgents: false,
    });
    const snapshotTimestamp = Date.now() - (30 * 60 * 1000);

    runtime.restoreFromSnapshot('session-a', 'trace-a', {
      version: 1,
      snapshotTimestamp,
      sessionId: 'session-a',
      traceId: 'trace-a',
      referenceTraceId: 'trace-b',
      comparisonSource: 'raw_trace_pair',
      conversationSteps: [],
      queryHistory: [],
      conclusionHistory: [],
      agentDialogue: [],
      agentResponses: [],
      dataEnvelopes: [],
      hypotheses: [],
      analysisNotes: [],
      analysisPlan: null,
      planHistory: [],
      uncertaintyFlags: [],
      sdkSessionId: 'sdk-session-compare',
      sdkSessionMode: 'full',
      runSequence: 0,
      conversationOrdinal: 0,
    });

    expect((runtime as any).sessionMap.get('session-a')).toBeUndefined();
    expect((runtime as any).sessionMap.get('session-a:ref:trace-b')).toEqual(expect.objectContaining({
      sdkSessionId: 'sdk-session-compare',
      updatedAt: snapshotTimestamp,
      mode: 'full',
    }));
    expect(runtime.getSdkSessionId('session-a', 'trace-b')).toBe('sdk-session-compare');
  });


  it('does not restore legacy unmarked SDK mappings from snapshots', () => {
    const runtime = new ClaudeRuntime({} as any, {
      enableVerification: false,
      enableSubAgents: false,
    });

    runtime.restoreFromSnapshot('session-a', 'trace-a', {
      version: 1,
      snapshotTimestamp: Date.now(),
      sessionId: 'session-a',
      traceId: 'trace-a',
      conversationSteps: [],
      queryHistory: [],
      conclusionHistory: [],
      agentDialogue: [],
      agentResponses: [],
      dataEnvelopes: [],
      hypotheses: [],
      analysisNotes: [],
      analysisPlan: null,
      planHistory: [],
      uncertaintyFlags: [],
      sdkSessionId: 'legacy-sdk-session',
      runSequence: 0,
      conversationOrdinal: 0,
    });

    expect((runtime as any).sessionMap.get('session-a')).toBeUndefined();
  });

  it('does not persist stale SDK session mappings into snapshots', () => {
    const now = 1_700_000_000_000;
    const runtime = new ClaudeRuntime({} as any, {
      enableVerification: false,
      enableSubAgents: false,
    });
    (runtime as any).sessionMap.set('session-a', {
      sdkSessionId: 'sdk-session-stale',
      updatedAt: now - (5 * 60 * 60 * 1000),
      mode: 'full',
    });

    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const snapshot = runtime.takeSnapshot('session-a', 'trace-a', {
        conversationSteps: [],
        queryHistory: [],
        conclusionHistory: [],
        agentDialogue: [],
        agentResponses: [],
        dataEnvelopes: [],
        hypotheses: [],
        runSequence: 0,
        conversationOrdinal: 0,
      });

      expect(snapshot.sdkSessionId).toBeUndefined();
      expect(snapshot.engineState).toMatchObject({
        kind: 'claude-agent-sdk',
        claude: {
          sdkSessionId: undefined,
        },
      });
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('persists fresh SDK session mappings into snapshots', () => {
    const now = 1_700_000_000_000;
    const runtime = new ClaudeRuntime({} as any, {
      enableVerification: false,
      enableSubAgents: false,
    });
    (runtime as any).sessionMap.set('session-a', {
      sdkSessionId: 'sdk-session-fresh',
      updatedAt: now - (30 * 60 * 1000),
      mode: 'full',
    });

    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const snapshot = runtime.takeSnapshot('session-a', 'trace-a', {
        conversationSteps: [],
        queryHistory: [],
        conclusionHistory: [],
        agentDialogue: [],
        agentResponses: [],
        dataEnvelopes: [],
        hypotheses: [],
        runSequence: 0,
        conversationOrdinal: 0,
      });

      expect(snapshot.sdkSessionId).toBe('sdk-session-fresh');
      expect(snapshot.sdkSessionMode).toBe('full');
      expect(snapshot.engineState).toEqual(expect.objectContaining({
        kind: 'claude-agent-sdk',
        provider: {
          providerId: null,
          providerSnapshotHash: null,
        },
        claude: {
          sdkSessionId: 'sdk-session-fresh',
          sdkSessionMode: 'full',
        },
      }));
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('does not persist provider resume or intermediate model state for private source sessions', () => {
    const now = 1_700_000_000_000;
    const runtime = new ClaudeRuntime({} as any, {
      enableVerification: false,
      enableSubAgents: false,
    });
    (runtime as any).sessionMap.set('session-private', {
      sdkSessionId: 'PRIVATE_PROVIDER_SESSION_CANARY',
      updatedAt: now,
      mode: 'full',
    });
    (runtime as any).sessionNotes.set('session-private', [{content: 'PRIVATE_NOTE_CANARY'}]);
    (runtime as any).sessionPlans.set('session-private', {
      current: {
        phases: [],
        successCriteria: 'PRIVATE_PLAN_CANARY',
        submittedAt: now,
        toolCallLog: [{
          toolName: 'submit_hypothesis',
          timestamp: now,
          inputSummary: 'PRIVATE_TOOL_ARGUMENT_CANARY',
        }],
      },
      history: [],
    });
    (runtime as any).sessionHypotheses.set('session-private', [{statement: 'PRIVATE_TITLE_ONLY_CANARY'}]);

    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const snapshot = runtime.takeSnapshot('session-private', 'trace-a', {
        codeAwareMode: 'provider_send',
        codebaseIds: ['private-app'],
        conversationSteps: [{content: {text: 'PRIVATE_STEP_CANARY'}}] as any,
        queryHistory: [],
        conclusionHistory: [],
        agentDialogue: [{content: 'PRIVATE_DIALOGUE_CANARY'}] as any,
        agentResponses: [{response: 'PRIVATE_RESPONSE_CANARY'}] as any,
        dataEnvelopes: [],
        hypotheses: [{description: 'PRIVATE_HYPOTHESIS_CANARY'}],
        runSequence: 0,
        conversationOrdinal: 0,
      });

      expect(snapshot.sdkSessionId).toBeUndefined();
      expect(snapshot.analysisNotes).toEqual([]);
      expect(snapshot.analysisPlan).toBeNull();
      expect(snapshot.planHistory).toEqual([]);
      expect(snapshot.claudeHypotheses).toBeUndefined();
      expect(snapshot.artifacts).toBeUndefined();
      expect(JSON.stringify(snapshot)).not.toContain('PRIVATE_');
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('persists fresh comparison SDK session mappings into snapshots', () => {
    const now = 1_700_000_000_000;
    const runtime = new ClaudeRuntime({} as any, {
      enableVerification: false,
      enableSubAgents: false,
    });
    (runtime as any).sessionMap.set('session-a:ref:trace-b', {
      sdkSessionId: 'sdk-session-compare',
      updatedAt: now - (30 * 60 * 1000),
      mode: 'full',
    });

    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const snapshot = runtime.takeSnapshot('session-a', 'trace-a', {
        referenceTraceId: 'trace-b',
        comparisonSource: 'raw_trace_pair',
        conversationSteps: [],
        queryHistory: [],
        conclusionHistory: [],
        agentDialogue: [],
        agentResponses: [],
        dataEnvelopes: [],
        hypotheses: [],
        runSequence: 0,
        conversationOrdinal: 0,
      });

      expect(snapshot.referenceTraceId).toBe('trace-b');
      expect(snapshot.comparisonSource).toBe('raw_trace_pair');
      expect(snapshot.sdkSessionId).toBe('sdk-session-compare');
      expect(snapshot.sdkSessionMode).toBe('full');
      expect(snapshot.engineState).toMatchObject({
        kind: 'claude-agent-sdk',
        claude: {
          sdkSessionId: 'sdk-session-compare',
        },
      });
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('does not expose fresh legacy session-map entries without full-mode ownership', () => {
    const now = 1_700_000_000_000;
    const runtime = new ClaudeRuntime({} as any, {
      enableVerification: false,
      enableSubAgents: false,
    });
    (runtime as any).sessionMap.set('session-a', {
      sdkSessionId: 'legacy-sdk-session',
      updatedAt: now,
    });

    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      expect(runtime.getSdkSessionId('session-a')).toBeUndefined();
      const snapshot = runtime.takeSnapshot('session-a', 'trace-a', {
        conversationSteps: [],
        queryHistory: [],
        conclusionHistory: [],
        agentDialogue: [],
        agentResponses: [],
        dataEnvelopes: [],
        hypotheses: [],
        runSequence: 0,
        conversationOrdinal: 0,
      });
      expect(snapshot.sdkSessionId).toBeUndefined();
      expect(snapshot.engineState).toMatchObject({
        kind: 'claude-agent-sdk',
        claude: {
          sdkSessionId: undefined,
        },
      });
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('runs quick mode without SDK resume or full-session map overwrite', async () => {
    const runtime = new ClaudeRuntime({
      query: async () => ({ columns: ['cnt'], rows: [[0]] }),
    } as any, {
      enableVerification: false,
      enableSubAgents: false,
    });
    const now = Date.now();
    (runtime as any).sessionMap.set('session-quick', {
      sdkSessionId: 'full-sdk-session',
      updatedAt: now,
      mode: 'full',
    });
    (runtime as any).architectureCache.set('trace-quick', {
      type: 'STANDARD',
      confidence: 0.9,
      evidence: [],
    });
    sessionContextManager.getOrCreate('session-quick', 'trace-quick').addTurn(
      '上一轮查到的包名是什么？',
      {
        primaryGoal: '上一轮查到的包名是什么？',
        aspects: [],
        expectedOutputType: 'summary',
        complexity: 'simple',
        followUpType: 'initial',
      },
      {
        agentId: 'claude-agent',
        success: true,
        findings: [],
        confidence: 0.8,
        message: '上一轮回答：主要包名是 com.example.app。',
      },
      [],
    );
    claudeSdkMock.__setQueryImplementation(async function* () {
      yield {
        type: 'result',
        subtype: 'success',
        session_id: 'quick-sdk-session',
        num_turns: 1,
        result: '当前仍然是 com.example.app。',
      };
    });

    await runtime.analyze('继续回答刚才的问题', 'session-quick', 'trace-quick', {
      analysisMode: 'fast',
      packageName: 'com.example.app',
    });

    const calls = claudeSdkMock.__getQueryCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].options.resume).toBeUndefined();
    expect(calls[0].options.persistSession).toBe(false);
    expect(calls[0].options.allowedTools).toContain('mcp__smartperfetto__fetch_artifact');
    expect(calls[0].prompt).toContain('上一轮回答：主要包名是 com.example.app。');
    expect((runtime as any).sessionMap.get('session-quick')).toEqual(expect.objectContaining({
      sdkSessionId: 'full-sdk-session',
      mode: 'full',
    }));
  });

  it('passes the active code-aware mode and selected codebases into the Claude quick prompt', async () => {
    const runtime = new ClaudeRuntime({
      query: async () => ({columns: [], rows: []}),
    } as any, {
      enableVerification: false,
      enableSubAgents: false,
    });
    claudeSdkMock.__setQueryImplementation(async function* () {
      yield {
        type: 'result',
        subtype: 'success',
        session_id: 'quick-source-sdk-session',
        num_turns: 1,
        result: 'done',
      };
    });

    await runtime.analyze(
      '快速结合源码定位候选机制',
      'session-claude-source-quick',
      'trace-claude-source-quick',
      {
        analysisMode: 'fast',
        assistantSurface: 'conversation',
        conversationTraceAttached: true,
        codeAwareMode: 'metadata_only',
        codebaseIds: ['cb-claude-quick'],
      },
    );

    const call = claudeSdkMock.__getQueryCalls()[0];
    expect(JSON.stringify(call.options.systemPrompt)).toContain('cb-claude-quick');
    expect(JSON.stringify(call.options.systemPrompt)).toContain('metadata_only');
    expect(JSON.stringify(call.options.systemPrompt)).toContain('源码使用决策契约');
  });

  it('does not run trace preflight for a no-trace conversation turn', async () => {
    const traceProcessor = {
      query: jest.fn(async () => {
        throw new Error('no trace processor exists for conversation');
      }),
    };
    const runtime = new ClaudeRuntime(traceProcessor as any, {
      enableVerification: false,
      enableSubAgents: false,
    });
    claudeSdkMock.__setQueryImplementation(async function* () {
      yield {
        type: 'result',
        subtype: 'success',
        session_id: 'sdk-conversation-no-trace',
        num_turns: 1,
        result: '对话模式可用。',
      };
    });

    await runtime.analyze(
      '只回复：对话模式可用。',
      'session-conversation-no-trace',
      'conversation-no-trace:session-conversation-no-trace',
      {
        analysisMode: 'fast',
        assistantSurface: 'conversation',
        conversationTraceAttached: false,
      },
    );

    expect(traceProcessor.query).not.toHaveBeenCalled();
    expect(claudeSdkMock.__getQueryCalls()).toHaveLength(1);
  });

  it('enables and auto-allows the Agent tool only when sub-agents are defined', () => {
    expect(__testing.buildClaudeSdkToolOptions(
      ['mcp__smartperfetto__execute_sql'],
      {'frame-expert': {}},
    )).toEqual({
      tools: ['Agent'],
      allowedTools: ['mcp__smartperfetto__execute_sql', 'Agent'],
    });
    expect(__testing.buildClaudeSdkToolOptions(
      ['mcp__smartperfetto__execute_sql'],
    )).toEqual({
      tools: [],
      allowedTools: ['mcp__smartperfetto__execute_sql'],
    });
  });

  it('keeps a terminal SDK success when iterator cleanup throws afterward', async () => {
    const runtime = new ClaudeRuntime({
      query: jest.fn(async () => {
        throw new Error('no trace processor exists for conversation');
      }),
    } as any, {
      enableVerification: false,
      enableSubAgents: false,
    });
    claudeSdkMock.__setQueryImplementation(async function* () {
      yield {
        type: 'result',
        subtype: 'success',
        session_id: 'sdk-conversation-terminal-success',
        num_turns: 1,
        result: '对话模式可用。',
      };
      throw new Error('Not logged in · Please run /login');
    });

    const result = await runtime.analyze(
      '只回复：对话模式可用。',
      'session-conversation-terminal-success',
      'conversation-no-trace:session-conversation-terminal-success',
      {
        analysisMode: 'fast',
        assistantSurface: 'conversation',
        conversationTraceAttached: false,
      },
    );

    expect(result.success).toBe(true);
    expect(result.conclusion).toContain('对话模式可用');
  });

  it('uses the request language throughout the quick path without mutating runtime defaults', async () => {
    const runtime = new ClaudeRuntime({
      query: async () => ({columns: ['cnt'], rows: [[0]]}),
    } as any, {
      outputLanguage: 'zh-CN',
      enableVerification: false,
      enableSubAgents: false,
    });
    (runtime as any).architectureCache.set('trace-language-quick', {
      type: 'STANDARD',
      confidence: 0.9,
      evidence: [],
    });
    const updates: any[] = [];
    runtime.on('update', update => updates.push(update));
    claudeSdkMock.__setQueryImplementation(async function* () {
      yield {
        type: 'result',
        subtype: 'success',
        session_id: 'sdk-language-quick',
        num_turns: 1,
        result: 'The current app is com.example.app.',
      };
    });

    await runtime.analyze(
      'Explain the current app briefly',
      'session-language-quick',
      'trace-language-quick',
      {analysisMode: 'fast', outputLanguage: 'en', packageName: 'com.example.app'},
    );

    const [call] = claudeSdkMock.__getQueryCalls();
    expect(JSON.stringify(call.options.systemPrompt)).toContain('English');
    const progress = updates.filter(update => update.type === 'progress')
      .map(update => String(update.content?.message ?? '')).join('\n');
    expect(progress).toContain('Fast Q&A mode');
    expect(progress).not.toContain('快速问答模式');
    expect((runtime as any).config.outputLanguage).toBe('zh-CN');
  });

  it('emits focus evidence for auto-detected app-scoped direct quick facts', async () => {
    const traceProcessor = {
      query: jest.fn(async (_traceId: string, sql: string) => {
        if (sql.includes('android_battery_stats_event_slices')) {
          return {
            columns: ['package_name', 'total_duration_ns', 'switch_count'],
            rows: [['com.example.app', 1_250_000_000, 3]],
            durationMs: 1,
          };
        }
        if (sql.includes('runtime_app_process_thread_count')) {
          return {
            columns: [
              'package_name',
              'process_count',
              'thread_count',
              'process_names',
              'process_thread_counts',
              'source_table',
            ],
            rows: [[
              'com.example.app',
              2,
              7,
              'com.example.app,com.example.app:worker',
              '4,3',
              'process,thread,android_process_metadata',
            ]],
            durationMs: 2,
          };
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      }),
    };
    const runtime = new ClaudeRuntime(traceProcessor as any, {
      enableVerification: false,
      enableSubAgents: false,
    });
    const updates: Array<{ type?: string; content?: unknown }> = [];
    runtime.on('update', update => updates.push(update));

    const result = await runtime.analyze(
      '焦点应用有多少线程？',
      'session-quick-focus-evidence',
      'trace-quick-focus-evidence',
    );

    expect(claudeSdkMock.__getQueryCalls()).toHaveLength(0);
    expect(traceProcessor.query).toHaveBeenCalledTimes(2);
    expect(result.rounds).toBe(0);
    expect(result.conclusion).toContain('焦点应用 com.example.app');
    expect(result.quickRun).toMatchObject({
      requestedMode: 'auto',
      resolvedMode: 'quick',
      actualTurns: 0,
      stopReason: 'answered',
      evidence: {
        currentRunDataEnvelopes: 2,
        citedEvidenceRefs: 1,
      },
    });
    const dataUpdates = updates.filter(update => update.type === 'data');
    expect(dataUpdates).toHaveLength(2);
    expect(dataUpdates[0].content).toEqual([
      expect.objectContaining({
        meta: expect.objectContaining({
          source: 'runtime_focus_detection',
          intent: 'runtime_focus_app_detection',
        }),
      }),
    ]);
    expect(dataUpdates[1].content).toEqual([
      expect.objectContaining({
        meta: expect.objectContaining({
          source: 'runtime_trace_fact:app_thread_count',
        }),
      }),
    ]);
  });

  it('answers selected trace-wide frame facts without focus or SDK preflight', async () => {
    const traceProcessor = {
      query: jest.fn(async (_traceId: string, sql: string) => {
        if (sql.includes('actual_frame_timeline_slice')) {
          return {
            columns: [
              'scope',
              'total_frames',
              'window_start_ns',
              'window_end_ns',
              'duration_s',
              'scope_start_ns',
              'scope_end_ns',
              'source_table',
            ],
            rows: [[
              'selected_range',
              57,
              100,
              200,
              0.0000001,
              100,
              200,
              'actual_frame_timeline_slice',
            ]],
            durationMs: 2,
          };
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      }),
    };
    const runtime = new ClaudeRuntime(traceProcessor as any, {
      enableVerification: false,
      enableSubAgents: false,
    });
    const updates: Array<{ type?: string; content?: unknown }> = [];
    runtime.on('update', update => updates.push(update));

    const result = await runtime.analyze(
      '这个 trace 一共有多少帧？',
      'session-quick-selected-trace-frame-count',
      'trace-quick-selected-trace-frame-count',
      {
        selectionContext: {
          kind: 'area',
          source: 'area_selection',
          startNs: 100,
          endNs: 200,
        },
      },
    );

    expect(claudeSdkMock.__getQueryCalls()).toHaveLength(0);
    expect(traceProcessor.query).toHaveBeenCalledTimes(1);
    expect(result.rounds).toBe(0);
    expect(result.conclusion).toContain('当前选区的 FrameTimeline 中共有 57 帧');
    expect(result.quickRun).toMatchObject({
      requestedMode: 'auto',
      resolvedMode: 'quick',
      actualTurns: 0,
      stopReason: 'answered',
      evidence: {
        currentRunDataEnvelopes: 1,
        citedEvidenceRefs: 1,
      },
    });
    const dataUpdates = updates.filter(update => update.type === 'data');
    expect(dataUpdates).toHaveLength(1);
    expect(dataUpdates[0].content).toEqual([
      expect.objectContaining({
        meta: expect.objectContaining({
          source: 'runtime_trace_fact:trace_frame_count',
        }),
        data: expect.objectContaining({
          rows: [[
            'selected_range',
            57,
            100,
            200,
            0.0000001,
            100,
            200,
            'actual_frame_timeline_slice',
          ]],
        }),
      }),
    ]);
  });

  it('skips architecture preflight when shared quick direct evidence answers', async () => {
    const directEvidence = jest.spyOn(
      quickEvidenceDirectAnswer,
      'buildRuntimeQuickEvidenceAttempt',
    );
    directEvidence.mockImplementation(async input => {
      input.emitUpdate({
        type: 'data',
        content: [{
          meta: {
            type: 'skill_result',
            version: '2.0.0',
            source: 'scrolling_analysis:performance_summary',
            timestamp: 1,
            skillId: 'scrolling_analysis',
            stepId: 'performance_summary',
            evidenceRefId: 'data:skill:scrolling_analysis:current:test:performance_summary',
            sourceToolCallId: 'runtime-skill:scrolling_analysis:test',
            traceSide: 'current',
            traceId: 'trace-quick-shared-direct',
            planPhaseId: 'quick',
          },
          data: {
            columns: ['total_frames'],
            rows: [[347]],
          },
          display: {
            layer: 'overview',
            format: 'table',
            title: '滑动性能概览',
          },
        }],
        timestamp: Date.now(),
      });
      return {
        directAnswer: {
          conclusion:
            '## 快速 Triage\n当前滑动概览可由 performance_summary 直接回答；' +
            'evidence_ref_id=`data:skill:scrolling_analysis:current:test:performance_summary`。',
          confidence: 0.9,
          conclusionContract: {
            schemaVersion: 'conclusion_contract_v1',
            mode: 'focused_answer',
            conclusions: [{
              rank: 1,
              statement: '当前滑动概览可由 performance_summary 直接回答。',
              confidencePercent: 90,
            }],
            clusters: [],
            evidenceChain: [{
              conclusionId: 'quick_scrolling_summary',
              text: 'performance_summary total_frames=347',
            }],
            claims: [{
              id: 'quick_scrolling_total_frames',
              text: 'performance_summary total_frames=347',
              kind: 'numeric',
              references: [{
                evidenceRefId: 'data:skill:scrolling_analysis:current:test:performance_summary',
                sourceRef: 'runtime-skill:scrolling_analysis:test',
                column: 'total_frames',
                value: 347,
              }],
              supportLevel: 'verified',
            }],
            uncertainties: [],
            nextSteps: [],
            metadata: {
              confidencePercent: 90,
              rounds: 0,
              claimDerivation: 'explicit_model_contract',
              claimVerificationScope: 'explicit_claims',
            },
          },
        },
        focusResult: {
          apps: [],
          method: 'none',
        },
        effectivePackageName: 'com.example.app',
        evidenceCounts: {
          currentRunDataEnvelopes: 1,
          citedEvidenceRefs: 1,
        },
      };
    });
    const traceProcessor = {
      query: jest.fn(async (_traceId: string, sql: string) => {
        if (sql.includes('android_battery_stats_event_slices')) {
          return {
            columns: ['package_name', 'total_duration_ns', 'switch_count'],
            rows: [['com.example.app', 1_250_000_000, 3]],
            durationMs: 1,
          };
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      }),
    };
    const runtime = new ClaudeRuntime(traceProcessor as unknown as TraceProcessorService, {
      enableVerification: false,
      enableSubAgents: false,
    });
    const updates: Array<{ type?: string; content?: unknown }> = [];
    runtime.on('update', update => updates.push(update));

    try {
      const result = await runtime.analyze(
        'scroll jank overview and smoothness',
        'session-quick-shared-direct',
        'trace-quick-shared-direct',
      );

      expect(directEvidence).toHaveBeenCalledTimes(1);
      expect(claudeSdkMock.__getQueryCalls()).toHaveLength(0);
      expect(traceProcessor.query).toHaveBeenCalledTimes(1);
      expect(result.rounds).toBe(0);
      expect(result.quickRun).toMatchObject({
        requestedMode: 'auto',
        resolvedMode: 'quick',
        actualTurns: 0,
        stopReason: 'answered',
        evidence: {
          currentRunDataEnvelopes: 1,
          citedEvidenceRefs: 1,
        },
      });
      expect(updates.map(update => update.type)).not.toContain('architecture_detected');
    } finally {
      directEvidence.mockRestore();
      sessionContextManager.remove('session-quick-shared-direct');
    }
  });

  it('keeps Claude mixed trace-fact plus scrolling quick evidence in the shared direct builder', async () => {
    const directEvidence = jest.spyOn(
      quickEvidenceDirectAnswer,
      'buildRuntimeQuickEvidenceAttempt',
    );
    directEvidence.mockImplementation(async input => {
      expect(input.quickTraceFactPreEvidence).toBe(true);
      expect(input.quickScrollingTriagePreEvidence).toBe(true);
      expect(input.quickProcessIdentityPreEvidence).toBe(false);
      expect(input.quickFocusAppPreEvidence).toBe(false);
      return {
        directAnswer: {
          conclusion:
            '## 快速 Triage\n- 总帧数和整体流畅度均已由运行时结构化证据回答。\n\n' +
            '## 逐句数据引用（结构化来源）\n' +
            '- Q1: FPS 和流畅度均有结构化引用。\n' +
            '  - evidence_ref_id=`data:runtime:test`; source_ref=runtime; column=`fps`; value=`58`',
          confidence: 0.9,
          conclusionContract: {
            schemaVersion: 'conclusion_contract_v1',
            mode: 'focused_answer',
            conclusions: [{
              rank: 1,
              statement: '总帧数和整体流畅度均已由运行时结构化证据回答。',
              confidencePercent: 90,
            }],
            clusters: [],
            evidenceChain: [{
              conclusionId: 'quick_mixed_trace_scrolling',
              text: 'runtime mixed trace fact and scrolling evidence',
            }],
            claims: [{
              id: 'quick_mixed_fps',
              text: '总帧数和流畅度均有结构化引用。',
              kind: 'numeric',
              references: [{
                evidenceRefId: 'data:runtime:test',
                sourceRef: 'runtime',
                column: 'fps',
                value: 58,
              }],
              supportLevel: 'verified',
            }],
            uncertainties: [],
            nextSteps: [],
            metadata: {
              confidencePercent: 90,
              rounds: 0,
              claimDerivation: 'explicit_model_contract',
              claimVerificationScope: 'explicit_claims',
            },
          },
        },
        focusResult: {
          apps: [],
          method: 'none',
        },
        evidenceCounts: {
          currentRunDataEnvelopes: 2,
          citedEvidenceRefs: 1,
        },
      };
    });
    const traceProcessor = {
      query: jest.fn(async (_traceId: string, sql: string) => {
        if (sql.includes('android_battery_stats_event_slices')) {
          return {
            columns: ['package_name', 'total_duration_ns', 'switch_count'],
            rows: [['com.example.app', 1_250_000_000, 3]],
            durationMs: 1,
          };
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      }),
    };
    const runtime = new ClaudeRuntime(traceProcessor as unknown as TraceProcessorService, {
      enableVerification: false,
      enableSubAgents: false,
    });

    try {
      const result = await runtime.analyze(
        '总帧数是多少？整体流畅吗？',
        'session-quick-mixed-trace-scrolling',
        'trace-quick-mixed-trace-scrolling',
      );

      expect(directEvidence).toHaveBeenCalledTimes(1);
      expect(claudeSdkMock.__getQueryCalls()).toHaveLength(0);
      expect(result.rounds).toBe(0);
      expect(result.quickRun).toMatchObject({
        actualTurns: 0,
        evidence: {
          currentRunDataEnvelopes: 2,
          citedEvidenceRefs: 1,
        },
      });
      expect(result.conclusion).toContain('总帧数和整体流畅度');
    } finally {
      directEvidence.mockRestore();
      sessionContextManager.remove('session-quick-mixed-trace-scrolling');
    }
  });

  it('does not answer selected-range trace facts from global runtime pre-evidence', async () => {
    const traceProcessor = {
      query: jest.fn(async (_traceId: string, sql: string) => {
        if (sql.includes('android_battery_stats_event_slices')) {
          return {
            columns: ['package_name', 'total_duration_ns', 'switch_count'],
            rows: [['com.example.app', 1_250_000_000, 3]],
            durationMs: 1,
          };
        }
        return { columns: [], rows: [], durationMs: 1 };
      }),
    };
    const runtime = new ClaudeRuntime(traceProcessor as any, {
      enableVerification: false,
      enableSubAgents: false,
    });
    (runtime as any).architectureCache.set('trace-quick-selection-trace-fact', {
      type: 'STANDARD',
      confidence: 0.9,
      evidence: [],
    });
    claudeSdkMock.__setQueryImplementation(async function* () {
      yield {
        type: 'result',
        subtype: 'success',
        session_id: 'quick-selection-sdk-session',
        num_turns: 1,
        result: '选区内帧数需要基于选区上下文查询，不能使用全局 trace 计数直接代替。',
      };
    });

    const result = await runtime.analyze(
      '这个 trace 一共有多少帧？',
      'session-quick-selection-trace-fact',
      'trace-quick-selection-trace-fact',
      {
        selectionContext: {
          kind: 'area',
          source: 'area_selection',
          startNs: 100,
          endNs: 200,
        },
      },
    );

    expect(claudeSdkMock.__getQueryCalls()).toHaveLength(1);
    expect(result.rounds).toBe(1);
    expect(result.quickRun).toMatchObject({
      requestedMode: 'auto',
      resolvedMode: 'quick',
      actualTurns: 1,
      stopReason: 'answered',
    });
    const [call] = claudeSdkMock.__getQueryCalls();
    expect(call.options.systemPrompt).toContain('用户选区上下文');
    expect(call.options.systemPrompt).toContain('起始时间:** 100 ns');
    expect(call.options.systemPrompt).toContain('结束时间:** 200 ns');
  });

  it('reuses real quick-evidence attempt state on Claude fallback without publishing pre-model evidence', async () => {
    process.env.SMARTPERFETTO_ADMITTED_RUNTIME_CANDIDATES = 'task4';
    const updates: Array<{ type?: string; content?: unknown }> = [];
    const focusSqlKinds: string[] = [];
    const traceFactSqlKinds: string[] = [];
    let now = 0;
    const traceProcessor = {
      query: jest.fn(async (_traceId: string, sql: string) => {
        const fromFocusDetector = new Error().stack?.includes('focusAppDetector') === true;
        if (
          fromFocusDetector &&
          sql.includes('android_battery_stats_event_slices') &&
          sql.includes('GROUP BY str_value')
        ) {
          focusSqlKinds.push('battery');
          now = 5;
          return {
            columns: ['package_name', 'total_duration_ns', 'switch_count'],
            rows: [],
            durationMs: 1,
          };
        }
        if (
          fromFocusDetector &&
          sql.includes('android_oom_adj_intervals') &&
          sql.includes('WITH foreground_intervals')
        ) {
          focusSqlKinds.push('oom_adj');
          now = 10;
          return {
            columns: ['package_name', 'total_duration_ns', 'switch_count'],
            rows: [],
            durationMs: 1,
          };
        }
        if (sql.includes('runtime_frame_metrics')) {
          traceFactSqlKinds.push('runtime_frame_metrics');
          now = 20;
          return {
            columns: [
              'package_name',
              'process_names',
              'upid_count',
              'total_frames',
              'window_start_ns',
              'window_end_ns',
              'duration_s',
              'fps',
              'source_table',
            ],
            rows: [[
              'com.frame.app',
              'com.frame.app',
              1,
              120,
              100,
              200,
              0.0000001,
              58,
              'actual_frame_timeline_slice',
            ]],
            durationMs: 1,
          };
        }
        if (
          fromFocusDetector &&
          sql.includes('actual_frame_timeline_slice') &&
          sql.includes('WITH frame_packages')
        ) {
          focusSqlKinds.push('frame_timeline');
          now = 15;
          return {
            columns: ['package_name', 'total_duration_ns', 'frame_count'],
            rows: [['com.frame.app', 1_250_000_000, 3]],
            durationMs: 1,
          };
        }
        return { columns: [], rows: [], durationMs: 1 };
      }),
    };
    const runtime = new ClaudeRuntime(traceProcessor as any, {
      enableVerification: false,
      enableSubAgents: false,
    });
    runtime.on('update', update => updates.push(update));
    (runtime as any).architectureCache.set('trace-claude-reused-quick-attempt', {
      type: 'STANDARD',
      confidence: 0.9,
      evidence: [],
    });
    claudeSdkMock.__setQueryImplementation(async function* () {
      expect(updates.map(update => update.type)).not.toContain('data');
      expect(updates.map(update => update.type)).not.toContain('conclusion');
      yield {
        type: 'result',
        subtype: 'success',
        session_id: 'quick-reused-sdk-session',
        num_turns: 1,
        result: '## Final Report\nfallback',
      };
    });
    const runtimePerformanceRecorder = createRuntimePerformanceRecorder({now: () => now});

    try {
      const result = await withEffectiveRuntimeRegistrySnapshot(
        createEffectiveRuntimeRegistrySnapshot(),
        () => runtime.analyze(
          '应用包名和 FPS 是多少？',
          'session-claude-reused-quick-attempt',
          'trace-claude-reused-quick-attempt',
          {
            analysisMode: 'fast',
            runManifestAttributionSink: createNoopAttributionSink(runtimePerformanceRecorder),
          },
        ),
      );

      expect(focusSqlKinds).toEqual(['battery', 'oom_adj', 'frame_timeline']);
      expect(traceFactSqlKinds).toEqual(['runtime_frame_metrics']);
      expect(claudeSdkMock.__getQueryCalls()).toHaveLength(1);
      const [call] = claudeSdkMock.__getQueryCalls();
      expect(call.options.systemPrompt).toContain('com.frame.app');
      expect(call.options.systemPrompt).toContain('非引用运行时路由上下文');
      expect(call.options.systemPrompt).toContain('frame_metrics');
      expect(call.options.systemPrompt).toContain('| fps |');
      expect(call.options.systemPrompt).not.toContain('data:runtime_trace_fact');
      const routingContext = call.options.systemPrompt.slice(
        call.options.systemPrompt.indexOf('非引用运行时路由上下文'),
      );
      expect(routingContext).not.toContain('evidence_ref_id');
      expect(routingContext).not.toContain('source_tool_call_id');
      expect(routingContext).not.toContain('evidenceRefId');
      expect(routingContext).not.toContain('sourceToolCallId');
      expect(routingContext).not.toContain('Current Trace Runtime Evidence');
      expect(result.conclusion).toContain('## Final Report');
      const receipt = runtimePerformanceRecorder.seal();
      expect(receipt.phases.filter(phase => phase.name === 'focus')).toHaveLength(1);
      const focusPhase = receipt.phases.find(phase => phase.name === 'focus');
      const classificationPhase = receipt.phases.find(phase => phase.name === 'classification');
      expect(focusPhase).toBeDefined();
      expect(classificationPhase).toBeDefined();
      expect(focusPhase!.startOffsetMs).toBeLessThanOrEqual(
        classificationPhase!.startOffsetMs + classificationPhase!.durationMs,
      );
      expect(focusPhase!.startOffsetMs + focusPhase!.durationMs).toBeGreaterThan(
        classificationPhase!.startOffsetMs + classificationPhase!.durationMs,
      );
      expect(receipt.phases).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'focus', outcome: 'ok' }),
        expect.objectContaining({ name: 'quick_evidence', outcome: 'ok' }),
        expect.objectContaining({ name: 'provider', outcome: 'ok' }),
      ]));
    } finally {
      sessionContextManager.remove('session-claude-reused-quick-attempt');
    }
  });

  it('does not answer selected-range process identity questions from global runtime pre-evidence', async () => {
    const traceProcessor = {
      query: jest.fn(async () => ({ columns: [], rows: [], durationMs: 1 })),
    };
    const runtime = new ClaudeRuntime(traceProcessor as any, {
      enableVerification: false,
      enableSubAgents: false,
    });
    (runtime as any).architectureCache.set('trace-quick-selection-identity', {
      type: 'STANDARD',
      confidence: 0.9,
      evidence: [],
    });
    claudeSdkMock.__setQueryImplementation(async function* () {
      yield {
        type: 'result',
        subtype: 'success',
        session_id: 'quick-selection-identity-sdk-session',
        num_turns: 1,
        result: '选区内进程身份需要基于选区上下文查询，不能使用全局 trace 进程身份直接代替。',
      };
    });

    const result = await runtime.analyze(
      '这个选区的应用包名和主要进程是什么？',
      'session-quick-selection-identity',
      'trace-quick-selection-identity',
      {
        selectionContext: {
          kind: 'area',
          source: 'area_selection',
          startNs: 100,
          endNs: 200,
        },
      },
    );

    expect(claudeSdkMock.__getQueryCalls()).toHaveLength(1);
    expect(result.rounds).toBe(1);
    expect(result.quickRun).toMatchObject({
      requestedMode: 'auto',
      resolvedMode: 'quick',
      actualTurns: 1,
      stopReason: 'answered',
    });
    const [call] = claudeSdkMock.__getQueryCalls();
    expect(call.options.systemPrompt).toContain('用户选区上下文');
    expect(call.options.systemPrompt).toContain('起始时间:** 100 ns');
    expect(call.options.systemPrompt).toContain('结束时间:** 200 ns');
  });

  it('passes selection time range into Claude skip-focus explicit-package quick evidence', async () => {
    const traceProcessor = {
      query: jest.fn(async () => {
        throw new Error('explicit-package selected duration should not query trace processor');
      }),
    };
    const runtime = new ClaudeRuntime(traceProcessor as any, {
      enableVerification: false,
      enableSubAgents: false,
    });
    const attemptSpy = jest.spyOn(quickEvidenceDirectAnswer, 'buildRuntimeQuickEvidenceAttempt');

    try {
      const result = await runtime.analyze(
        '选区持续多久？',
        'session-claude-selection-explicit-package',
        'trace-claude-selection-explicit-package',
        {
          analysisMode: 'fast',
          packageName: 'com.example.app',
          selectionContext: {
            kind: 'area',
            source: 'area_selection',
            startNs: 100,
            endNs: 250,
          },
        },
      );

      expect(result.rounds).toBe(0);
      expect(result.conclusion).toContain('duration_ns');
      expect(result.conclusion).toContain('value=`150`');
      expect(traceProcessor.query).not.toHaveBeenCalled();
      expect(claudeSdkMock.__getQueryCalls()).toHaveLength(0);
      expect(attemptSpy).toHaveBeenCalledTimes(1);
      expect(attemptSpy.mock.calls[0][0].focusResult).toMatchObject({
        method: 'none',
        timeRange: { startNs: 100, endNs: 250 },
      });
    } finally {
      attemptSpy.mockRestore();
      sessionContextManager.remove('session-claude-selection-explicit-package');
    }
  });

  it('records Claude performance receipt from actual provider output and finalization', async () => {
    const traceId = 'trace-claude-performance';
    const traceProcessor = {
      query: jest.fn(async () => ({ columns: ['cnt'], rows: [[0]], durationMs: 1 })),
      getTrace: jest.fn(() => ({
        id: traceId,
        filename: 'trace.pftrace',
        size: 1,
        uploadTime: new Date(),
        status: 'ready',
        traceOs: 'android',
        traceFormat: 'perfetto_protobuf',
      })),
    };
    const runtime = new ClaudeRuntime(traceProcessor as any, {
      enableVerification: false,
      enableSubAgents: false,
    });
    (runtime as any).architectureCache.set(traceId, {
      type: 'STANDARD',
      confidence: 0.9,
      evidence: [],
    });
    claudeSdkMock.__setQueryImplementation(async function* () {
      yield {
        type: 'assistant',
        message: {
          content: [{type: 'text', text: '## 综合结论\nClaude provider output.'}],
        },
      };
      yield {
        type: 'result',
        subtype: 'success',
        session_id: 'sdk-claude-performance',
        num_turns: 1,
        result: '## 综合结论\nClaude provider output.',
      };
    });

    const runtimePerformanceRecorder = createRuntimePerformanceRecorder();
    await expect(withEffectiveRuntimeRegistrySnapshot(
      createEffectiveRuntimeRegistrySnapshot(),
      () => runtime.analyze('分析启动性能', 'session-claude-performance', traceId, {
        analysisMode: 'full',
        packageName: 'com.example.app',
        runManifestAttributionSink: createNoopAttributionSink(runtimePerformanceRecorder),
      }),
    )).resolves.toMatchObject({sessionId: 'session-claude-performance'});

    const receipt = runtimePerformanceRecorder.seal();
    expect(receipt.firstOutputMs).toEqual(expect.any(Number));
    const finalizationPhases = receipt.phases.filter(phase => phase.name === 'finalization');
    expect(finalizationPhases).toHaveLength(1);
    expect(finalizationPhases[0]).toEqual(expect.objectContaining({outcome: 'ok'}));
    expect(receipt.phases).toEqual(expect.arrayContaining([
      expect.objectContaining({name: 'provider', outcome: 'ok'}),
      expect.objectContaining({name: 'finalization', outcome: 'ok'}),
    ]));
  });

  it('starts Claude full comparison, registry, and SQL knowledge before current architecture/vendor settle and records preflight phases once', async () => {
    process.env.SMARTPERFETTO_ADMITTED_RUNTIME_CANDIDATES = 'task6';
    const traceId = 'trace-claude-overlap-current';
    const referenceTraceId = 'trace-claude-overlap-reference';
    const sessionId = 'session-claude-overlap-preflight';
    const traceProcessor = {
      query: jest.fn(async () => ({ columns: [], rows: [], durationMs: 1 })),
      getTrace: jest.fn(() => ({
        id: traceId,
        filename: 'trace.pftrace',
        size: 1,
        uploadTime: new Date(),
        status: 'ready',
        traceOs: 'android',
        traceFormat: 'perfetto_protobuf',
      })),
    };
    const runtime = new ClaudeRuntime(traceProcessor as any, {
      enableVerification: false,
      enableSubAgents: false,
    });

    const architectureStarted = createDeferred<void>();
    const releaseArchitecture = createDeferred<any>();
    const releaseVendor = createDeferred<{ vendor: string }>();
    const releaseCompleteness = createDeferred<any>();
    const releaseRegistry = createDeferred<void>();
    const releaseKnowledge = createDeferred<{ getContextForAI: () => string }>();
    const releaseComparison = createDeferred<any>();
    const runtimePerformanceRecorder = createRuntimePerformanceRecorder();
    const runtimePerformance = createRuntimePerformanceRun(createNoopAttributionSink(runtimePerformanceRecorder));
    const architectureSpy = jest.spyOn(architectureDetector, 'createArchitectureDetector')
      .mockReturnValue({
        detect: jest.fn(async ({traceId: requestedTraceId}: {traceId: string}) => {
          if (requestedTraceId === traceId) {
            architectureStarted.resolve();
            return releaseArchitecture.promise;
          }
          return { type: 'STANDARD', confidence: 0.8, evidence: [] };
        }),
      } as any);
    const adapterSpy = jest.spyOn(skillAnalysisAdapter, 'getSkillAnalysisAdapter')
      .mockReturnValue({
        ensureInitialized: jest.fn(async () => undefined),
        detectVendor: jest.fn(async () => releaseVendor.promise),
      } as any);
    const completenessSpy = jest.spyOn(traceCompletenessProber, 'probeTraceCompleteness')
      .mockImplementation(async () => releaseCompleteness.promise);
    const registrySpy = jest.spyOn(skillLoader, 'ensureSkillRegistryInitialized')
      .mockImplementation(async () => releaseRegistry.promise);
    const knowledgeSpy = jest.spyOn(sqlKnowledgeBase, 'getExtendedKnowledgeBase')
      .mockImplementation(async () => releaseKnowledge.promise as any);
    const comparisonSpy = jest.spyOn(runtimePromptContext, 'buildRuntimeTracePairComparisonContext')
      .mockImplementation(async () => releaseComparison.promise);

    const preparePromise = (runtime as any).prepareAnalysisContext(
      '分析两条 trace 的启动差异',
      sessionId,
      traceId,
      {
        analysisMode: 'full',
        packageName: 'com.current.app',
        referenceTraceId,
      },
      {
        focusResult: {
          apps: [],
          primaryApp: undefined,
          method: 'none',
        },
        previousTurns: [],
        sceneType: 'startup',
        runtimePerformance,
      },
    );

    try {
      await architectureStarted.promise;
      await Promise.resolve();
      await Promise.resolve();

      expect(registrySpy).toHaveBeenCalledTimes(1);
      expect(knowledgeSpy).toHaveBeenCalledTimes(1);
      expect(comparisonSpy).toHaveBeenCalledTimes(1);
      expect(adapterSpy).not.toHaveBeenCalled();
      expect(completenessSpy).not.toHaveBeenCalled();
    } finally {
      releaseArchitecture.resolve({ type: 'STANDARD', confidence: 0.9, evidence: [] });
      releaseVendor.resolve({ vendor: 'xiaomi' });
      releaseCompleteness.resolve(undefined);
      releaseRegistry.resolve();
      releaseKnowledge.resolve({ getContextForAI: () => 'SQL knowledge overlap context' });
      releaseComparison.resolve({
        currentPackageName: 'com.current.app',
        referencePackageName: 'com.reference.app',
        commonCapabilities: [],
        capabilityDiff: { currentOnly: [], referenceOnly: [] },
      });
      await preparePromise;
      const phases = runtimePerformanceRecorder.seal().phases;
      for (const phaseName of ['architecture', 'completeness', 'comparison', 'skill_registry', 'knowledge']) {
        expect(phases.filter(phase => phase.name === phaseName)).toHaveLength(1);
      }
      expect(phases).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'architecture', outcome: 'ok' }),
        expect.objectContaining({ name: 'completeness', outcome: 'ok' }),
        expect.objectContaining({ name: 'comparison', outcome: 'ok' }),
        expect.objectContaining({ name: 'skill_registry', outcome: 'ok' }),
        expect.objectContaining({ name: 'knowledge', outcome: 'ok' }),
      ]));
      architectureSpy.mockRestore();
      adapterSpy.mockRestore();
      completenessSpy.mockRestore();
      registrySpy.mockRestore();
      knowledgeSpy.mockRestore();
      comparisonSpy.mockRestore();
      sessionContextManager.remove(sessionId);
    }
  });

  it('runs the widened Claude preflight operations sequentially by default', async () => {
    delete process.env.SMARTPERFETTO_ADMITTED_RUNTIME_CANDIDATES;
    const traceId = 'trace-claude-serial-preflight';
    const sessionId = 'session-claude-serial-preflight';
    const traceProcessor = {
      query: jest.fn(async () => ({columns: [], rows: [], durationMs: 1})),
      getTrace: jest.fn(() => ({
        id: traceId,
        filename: 'trace.pftrace',
        size: 1,
        uploadTime: new Date(),
        status: 'ready',
      })),
    };
    const runtime = new ClaudeRuntime(traceProcessor as any, {
      enableVerification: false,
      enableSubAgents: false,
    });
    const releaseRegistry = createDeferred<void>();
    const registrySpy = jest.spyOn(skillLoader, 'ensureSkillRegistryInitialized')
      .mockImplementation(async () => releaseRegistry.promise);
    const knowledgeSpy = jest.spyOn(sqlKnowledgeBase, 'getExtendedKnowledgeBase')
      .mockResolvedValue({getContextForAI: () => 'serial knowledge'} as any);
    const architectureDetect = jest.fn(async () => ({type: 'STANDARD', confidence: 0.9, evidence: []}));
    const architectureSpy = jest.spyOn(architectureDetector, 'createArchitectureDetector')
      .mockReturnValue({detect: architectureDetect} as any);
    const adapterSpy = jest.spyOn(skillAnalysisAdapter, 'getSkillAnalysisAdapter')
      .mockReturnValue({
        ensureInitialized: jest.fn(async () => undefined),
        detectVendor: jest.fn(async () => ({vendor: 'xiaomi'})),
      } as any);
    const completenessSpy = jest.spyOn(traceCompletenessProber, 'probeTraceCompleteness')
      .mockResolvedValue(undefined as any);

    const pending = (runtime as any).prepareAnalysisContext(
      '分析启动性能',
      sessionId,
      traceId,
      {analysisMode: 'full', packageName: 'com.example.app'},
      {
        focusResult: {apps: [], primaryApp: undefined, method: 'none'},
        previousTurns: [],
        sceneType: 'startup',
      },
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(registrySpy).toHaveBeenCalledTimes(1);
    expect(knowledgeSpy).not.toHaveBeenCalled();
    expect(architectureDetect).not.toHaveBeenCalled();

    releaseRegistry.resolve();
    await pending;
    expect(knowledgeSpy).toHaveBeenCalledTimes(1);
    expect(architectureDetect).toHaveBeenCalledTimes(1);
    expect(adapterSpy).toHaveBeenCalledTimes(1);
    expect(completenessSpy).toHaveBeenCalledTimes(1);
    expect(registrySpy.mock.invocationCallOrder[0]).toBeLessThan(knowledgeSpy.mock.invocationCallOrder[0]);
    expect(knowledgeSpy.mock.invocationCallOrder[0]).toBeLessThan(architectureDetect.mock.invocationCallOrder[0]);

    architectureSpy.mockRestore();
    adapterSpy.mockRestore();
    completenessSpy.mockRestore();
    registrySpy.mockRestore();
    knowledgeSpy.mockRestore();
    sessionContextManager.remove(sessionId);
  });

  it('settles Claude overlapped full preflights before cancellation returns without session state writes', async () => {
    process.env.SMARTPERFETTO_ADMITTED_RUNTIME_CANDIDATES = 'task6';
    const traceId = 'trace-claude-cancel-current';
    const referenceTraceId = 'trace-claude-cancel-reference';
    const sessionId = 'session-claude-cancel-preflight';
    const traceProcessor = {
      query: jest.fn(async () => ({ columns: [], rows: [], durationMs: 1 })),
      getTrace: jest.fn(() => ({
        id: traceId,
        filename: 'trace.pftrace',
        size: 1,
        uploadTime: new Date(),
        status: 'ready',
        traceOs: 'android',
        traceFormat: 'perfetto_protobuf',
      })),
    };
    const runtime = new ClaudeRuntime(traceProcessor as any, {
      enableVerification: false,
      enableSubAgents: false,
    });
    const abortController = new AbortController();
    const abortError = new Error('cancelled by Claude preflight barrier test');
    const executionLease = {
      key: { runtime: 'claude-agent', sessionId, referenceTraceId },
      signal: abortController.signal,
      throwIfAborted: () => {
        if (abortController.signal.aborted) throw abortError;
      },
      settle: jest.fn(),
    };
    const architectureStarted = createDeferred<void>();
    const comparisonStarted = createDeferred<void>();
    const releaseArchitecture = createDeferred<any>();
    const releaseVendor = createDeferred<{ vendor: string }>();
    const releaseCompleteness = createDeferred<any>();
    const releaseRegistry = createDeferred<void>();
    const releaseKnowledge = createDeferred<{ getContextForAI: () => string }>();
    const releaseComparison = createDeferred<any>();
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.on('unhandledRejection', onUnhandledRejection);
    const architectureSpy = jest.spyOn(architectureDetector, 'createArchitectureDetector')
      .mockReturnValue({
        detect: jest.fn(async ({traceId: requestedTraceId}: {traceId: string}) => {
          if (requestedTraceId === traceId) {
            architectureStarted.resolve();
            return releaseArchitecture.promise;
          }
          return { type: 'STANDARD', confidence: 0.8, evidence: [] };
        }),
      } as any);
    const adapterSpy = jest.spyOn(skillAnalysisAdapter, 'getSkillAnalysisAdapter')
      .mockReturnValue({
        ensureInitialized: jest.fn(async () => undefined),
        detectVendor: jest.fn(async () => releaseVendor.promise),
      } as any);
    const completenessSpy = jest.spyOn(traceCompletenessProber, 'probeTraceCompleteness')
      .mockImplementation(async () => releaseCompleteness.promise);
    const registrySpy = jest.spyOn(skillLoader, 'ensureSkillRegistryInitialized')
      .mockImplementation(async () => releaseRegistry.promise);
    const knowledgeSpy = jest.spyOn(sqlKnowledgeBase, 'getExtendedKnowledgeBase')
      .mockImplementation(async () => releaseKnowledge.promise as any);
    const comparisonSpy = jest.spyOn(runtimePromptContext, 'buildRuntimeTracePairComparisonContext')
      .mockImplementation(async () => {
        comparisonStarted.resolve();
        return releaseComparison.promise;
      });

    const preparePromise = (runtime as any).prepareAnalysisContext(
      '取消前的两条 trace 启动差异',
      sessionId,
      traceId,
      {
        analysisMode: 'full',
        packageName: 'com.current.app',
        referenceTraceId,
      },
      {
        focusResult: {
          apps: [],
          primaryApp: undefined,
          method: 'none',
        },
        previousTurns: [],
        sceneType: 'startup',
        executionLease,
      },
    );

    try {
      await Promise.all([architectureStarted.promise, comparisonStarted.promise]);
      abortController.abort(abortError);
      releaseRegistry.reject(new Error('registry rejected after cancellation'));
      releaseKnowledge.reject(new Error('knowledge rejected after cancellation'));
      releaseComparison.reject(new Error('comparison rejected after cancellation'));
      releaseArchitecture.resolve({ type: 'STANDARD', confidence: 0.9, evidence: [] });
      await Promise.resolve();
      releaseVendor.resolve({ vendor: 'xiaomi' });
      releaseCompleteness.resolve(undefined);

      await expect(preparePromise).rejects.toThrow(abortError.message);
      await new Promise(resolve => setImmediate(resolve));
      expect(unhandledRejections).toHaveLength(0);
      expect(registrySpy).toHaveBeenCalledTimes(1);
      expect(knowledgeSpy).toHaveBeenCalledTimes(1);
      expect(comparisonSpy).toHaveBeenCalledTimes(1);
      expect(completenessSpy).toHaveBeenCalledTimes(1);
      expect((runtime as any).artifactStores.has(sessionId)).toBe(false);
      expect((runtime as any).sessionPlans.has(sessionId)).toBe(false);
      expect((runtime as any).sessionNotes.has(sessionId)).toBe(false);
      expect((runtime as any).sessionHypotheses.has(sessionId)).toBe(false);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
      architectureSpy.mockRestore();
      adapterSpy.mockRestore();
      completenessSpy.mockRestore();
      registrySpy.mockRestore();
      knowledgeSpy.mockRestore();
      comparisonSpy.mockRestore();
      sessionContextManager.remove(sessionId);
    }
  });

  it('records focus:error when Claude focus detection unexpectedly rejects and provider policy remains graceful', async () => {
    const sessionId = 'session-claude-focus-rejection';
    const traceId = 'trace-claude-focus-rejection';
    const focusSpy = jest.spyOn(focusAppDetector, 'detectFocusApps')
      .mockRejectedValueOnce(new Error('synthetic unexpected focus rejection'));
    const traceProcessor = {
      query: jest.fn(async () => ({ columns: ['cnt'], rows: [[0]], durationMs: 1 })),
      getTrace: jest.fn(() => ({
        id: traceId,
        filename: 'trace.pftrace',
        size: 1,
        uploadTime: new Date(),
        status: 'ready',
        traceOs: 'android',
        traceFormat: 'perfetto_protobuf',
      })),
    };
    const runtime = new ClaudeRuntime(traceProcessor as any, {
      enableVerification: false,
      enableSubAgents: false,
    });
    (runtime as any).architectureCache.set(traceId, {
      type: 'STANDARD',
      confidence: 0.9,
      evidence: [],
    });
    claudeSdkMock.__setQueryImplementation(async function* () {
      yield {
        type: 'result',
        subtype: 'success',
        session_id: 'sdk-claude-focus-rejection',
        num_turns: 1,
        result: '## 综合结论\nProvider still runs after focus detection degrades gracefully.',
      };
    });
    const runtimePerformanceRecorder = createRuntimePerformanceRecorder();

    try {
      const result = await withEffectiveRuntimeRegistrySnapshot(
        createEffectiveRuntimeRegistrySnapshot(),
        () => runtime.analyze('分析启动性能', sessionId, traceId, {
          analysisMode: 'full',
          runManifestAttributionSink: createNoopAttributionSink(runtimePerformanceRecorder),
        }),
      );

      expect(result.success).toBe(true);
      expect(focusSpy).toHaveBeenCalledTimes(1);
      expect(claudeSdkMock.__getQueryCalls()).toHaveLength(1);
      const receipt = runtimePerformanceRecorder.seal();
      const focusPhases = receipt.phases.filter(phase => phase.name === 'focus');
      const providerPhases = receipt.phases.filter(phase => phase.name === 'provider');
      const finalizationPhases = receipt.phases.filter(phase => phase.name === 'finalization');
      expect(focusPhases).toHaveLength(1);
      expect(focusPhases[0]).toEqual(expect.objectContaining({outcome: 'error'}));
      expect(providerPhases).toHaveLength(1);
      expect(providerPhases[0]).toEqual(expect.objectContaining({outcome: 'ok'}));
      expect(finalizationPhases).toHaveLength(1);
      expect(finalizationPhases[0]).toEqual(expect.objectContaining({outcome: 'ok'}));
    } finally {
      focusSpy.mockRestore();
      sessionContextManager.remove(sessionId);
    }
  });

  it('records focus:cancelled and publishes no Claude state when cancellation arrives while focus is active', async () => {
    const sessionId = 'session-claude-focus-live-cancel';
    const traceId = 'trace-claude-focus-live-cancel';
    const focusStarted = createDeferred<void>();
    const releaseFocus = createDeferred<focusAppDetector.FocusAppDetectionResult>();
    const focusSpy = jest.spyOn(focusAppDetector, 'detectFocusApps')
      .mockImplementationOnce(async () => {
        focusStarted.resolve();
        return releaseFocus.promise;
      });
    const runtime = new ClaudeRuntime({
      query: jest.fn(async () => ({ columns: ['cnt'], rows: [[0]], durationMs: 1 })),
      getTrace: jest.fn(() => ({
        id: traceId,
        filename: 'trace.pftrace',
        size: 1,
        uploadTime: new Date(),
        status: 'ready',
        traceOs: 'android',
        traceFormat: 'perfetto_protobuf',
      })),
    } as any, {
      enableVerification: false,
      enableSubAgents: false,
    });
    (runtime as any).architectureCache.set(traceId, {
      type: 'STANDARD',
      confidence: 0.9,
      evidence: [],
    });
    claudeSdkMock.__setQueryImplementation(async function* () {
      throw new Error('provider must not start after focus cancellation');
    });
    const runtimePerformanceRecorder = createRuntimePerformanceRecorder();

    try {
      const analysis = withEffectiveRuntimeRegistrySnapshot(
        createEffectiveRuntimeRegistrySnapshot(),
        () => runtime.analyze('分析启动性能', sessionId, traceId, {
          analysisMode: 'full',
          runManifestAttributionSink: createNoopAttributionSink(runtimePerformanceRecorder),
        }),
      );
      await focusStarted.promise;
      runtime.abortSession(sessionId);
      releaseFocus.resolve({ apps: [], method: 'none' });

      const result = await analysis;
      expect(result.success).toBe(false);
      expect(result.terminationMessage).toMatch(/aborted|cancelled/i);
      expect(focusSpy).toHaveBeenCalledTimes(1);
      expect(claudeSdkMock.__getQueryCalls()).toHaveLength(0);
      const turns = sessionContextManager.getOrCreate(sessionId, traceId).getAllTurns?.() ?? [];
      expect(turns).toHaveLength(0);
      expect((runtime as any).sessionMap.get(sessionId)).toBeUndefined();
      expect(runtimeSnapshotCount()).toBe(0);
      const receipt = runtimePerformanceRecorder.seal();
      expect(receipt.phases.filter(phase => phase.name === 'focus')).toEqual([
        expect.objectContaining({outcome: 'cancelled'}),
      ]);
      expect(receipt.phases.filter(phase => phase.name === 'provider')).toHaveLength(0);
      expect(receipt.phases.filter(phase => phase.name === 'finalization')).toEqual([
        expect.objectContaining({outcome: 'cancelled'}),
      ]);
    } finally {
      focusSpy.mockRestore();
      sessionContextManager.remove(sessionId);
    }
  });

  it('passes stable and volatile full-mode prompt blocks through the Claude cache boundary', async () => {
    const runtime = new ClaudeRuntime({
      query: async () => ({ columns: ['cnt'], rows: [[0]] }),
      getTrace: () => ({ traceOs: 'android', traceFormat: 'perfetto' }),
    } as any, {
      enableVerification: false,
      enableSubAgents: false,
    });
    (runtime as any).architectureCache.set('trace-cache-boundary', {
      type: 'STANDARD',
      confidence: 0.9,
      evidence: [],
    });
    claudeSdkMock.__setQueryImplementation(async function* () {
      yield {
        type: 'result',
        subtype: 'success',
        session_id: 'sdk-cache-boundary',
        num_turns: 1,
        result: [
          '## 综合结论',
          'Full-mode prompt cache boundary was applied.',
          '',
          '## 关键证据链',
          '- Selection context stayed in the volatile suffix.',
          '',
          '## 优化建议',
          '- Keep stable prompt sections cacheable.',
        ].join('\n'),
      };
    });

    const result = await runtime.analyze('分析选区内的掉帧', 'session-cache-boundary', 'trace-cache-boundary', {
      analysisMode: 'full',
      packageName: 'com.example.app',
      selectionContext: { kind: 'area', startNs: 100, endNs: 200 } as any,
    });

    expect(result.success).toBe(true);
    const [call] = claudeSdkMock.__getQueryCalls();
    expect(Array.isArray(call.options.systemPrompt)).toBe(true);
    const blocks = call.options.systemPrompt as string[];
    const boundaryIndex = blocks.indexOf('__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__');
    expect(boundaryIndex).toBeGreaterThan(0);
    expect(blocks.slice(0, boundaryIndex).join('\n\n')).toContain('SmartPerfetto');
    expect(blocks.slice(boundaryIndex + 1).join('\n\n')).toContain('用户选区上下文');
    expect(call.options.persistSession).toBe(true);
  });

  it('rejects same-session direct overlap even when run and reference ids differ', async () => {
    const runtime = new ClaudeRuntime({
      query: async () => ({ columns: ['cnt'], rows: [[0]] }),
      getTrace: () => ({ traceOs: 'android', traceFormat: 'perfetto' }),
    } as any, {
      enableVerification: false,
      enableSubAgents: false,
    });
    (runtime as any).architectureCache.set('trace-claude-overlap', {
      type: 'STANDARD',
      confidence: 0.9,
      evidence: [],
    });
    const releaseSdk = createDeferred<void>();
    claudeSdkMock.__setQueryImplementation(async function* () {
      await releaseSdk.promise;
      yield {
        type: 'result',
        subtype: 'success',
        session_id: 'sdk-claude-overlap',
        num_turns: 1,
        result: [
          '## 综合结论',
          '',
          'Claude overlap first run completed.',
          '',
          '## 关键证据链',
          '',
          '- The first run held the runtime session lease.',
          '',
          '## 优化建议',
          '',
          '- Reject overlapping direct callers.',
        ].join('\n'),
      };
    });

    const first = runtime.analyze('first', 'session-claude-overlap', 'trace-claude-overlap', {
      analysisMode: 'full',
      packageName: 'com.example.app',
      runId: 'run-1',
      referenceTraceId: 'ref-1',
    });
    await Promise.resolve();
    const second = runtime.analyze('second', 'session-claude-overlap', 'trace-claude-overlap', {
      analysisMode: 'full',
      packageName: 'com.example.app',
      runId: 'run-2',
      referenceTraceId: 'ref-2',
    });

    await expect(second).rejects.toThrow(/already in progress/i);
    releaseSdk.resolve();
    await expect(first).resolves.toMatchObject({ success: true });
  });

  it('allows different sessions to run independently', async () => {
    const runtime = new ClaudeRuntime({
      query: async () => ({ columns: ['cnt'], rows: [[0]] }),
      getTrace: () => ({ traceOs: 'android', traceFormat: 'perfetto' }),
    } as any, {
      enableVerification: false,
      enableSubAgents: false,
    });
    (runtime as any).architectureCache.set('trace-claude-isolated', {
      type: 'STANDARD',
      confidence: 0.9,
      evidence: [],
    });
    claudeSdkMock.__setQueryImplementation(async function* () {
      yield {
        type: 'result',
        subtype: 'success',
        session_id: `sdk-claude-${Math.random().toString(36).slice(2)}`,
        num_turns: 1,
        result: [
          '## 综合结论',
          '',
          'Claude isolated session completed.',
          '',
          '## 关键证据链',
          '',
          '- Different logical sessions use independent leases.',
          '',
          '## 优化建议',
          '',
          '- Keep concurrent sessions independent.',
        ].join('\n'),
      };
    });

    await expect(Promise.all([
      runtime.analyze('first', 'session-claude-isolated-1', 'trace-claude-isolated', {
        analysisMode: 'full',
        packageName: 'com.example.app',
      }),
      runtime.analyze('second', 'session-claude-isolated-2', 'trace-claude-isolated', {
        analysisMode: 'full',
        packageName: 'com.example.app',
      }),
    ])).resolves.toEqual([
      expect.objectContaining({ success: true }),
      expect.objectContaining({ success: true }),
    ]);
  });

  it('recovers a missing SDK conversation inside the active guard lease', async () => {
    const runtime = new ClaudeRuntime({
      query: async () => ({ columns: ['cnt'], rows: [[0]] }),
      getTrace: () => ({ traceOs: 'android', traceFormat: 'perfetto' }),
    } as any, {
      enableVerification: false,
      enableSubAgents: false,
    });
    (runtime as any).architectureCache.set('trace-claude-retry-guard', {
      type: 'STANDARD',
      confidence: 0.9,
      evidence: [],
    });
    (runtime as any).sessionMap.set('session-claude-retry-guard', {
      sdkSessionId: 'sdk-missing',
      updatedAt: Date.now(),
      mode: 'full',
    });
    const updates: any[] = [];
    runtime.on('update', update => updates.push(update));
    const focusSpy = jest.spyOn(focusAppDetector, 'detectFocusApps')
      .mockResolvedValue({
        apps: [{ packageName: 'com.example.app', processName: 'com.example.app', score: 1 }],
        primaryApp: 'com.example.app',
        method: 'process_track',
      } as any);
    const completenessSpy = jest.spyOn(traceCompletenessProber, 'probeTraceCompleteness')
      .mockResolvedValue(undefined as any);
    const registrySpy = jest.spyOn(skillLoader, 'ensureSkillRegistryInitialized')
      .mockResolvedValue(undefined);
    const knowledgeSpy = jest.spyOn(sqlKnowledgeBase, 'getExtendedKnowledgeBase')
      .mockResolvedValue({ getContextForAI: () => 'SQL knowledge missing conversation context' } as any);
    let sdkCalls = 0;
    claudeSdkMock.__setQueryImplementation(async function* () {
      sdkCalls += 1;
      if (sdkCalls === 1) {
        yield {
          type: 'result',
          subtype: 'error_during_execution',
          errors: [{ message: 'No conversation found with session ID: sdk-missing' }],
          session_id: 'sdk-missing',
          num_turns: 1,
        };
        return;
      }
      yield {
        type: 'result',
        subtype: 'success',
        session_id: 'sdk-recovered',
        num_turns: 1,
        result: [
          '## 综合结论',
          '',
          'Claude missing SDK conversation recovery stayed inside the original guard lease.',
          '',
          '## 关键证据链',
          '',
          '- Local persisted context was reused without public analyze re-entry.',
          '',
          '## 优化建议',
          '',
          '- Continue with the recovered SDK session.',
        ].join('\n'),
      };
    });
    const runtimePerformanceRecorder = createRuntimePerformanceRecorder();

    try {
      const result = await withEffectiveRuntimeRegistrySnapshot(
        createEffectiveRuntimeRegistrySnapshot(),
        () => runtime.analyze(
          '继续分析启动性能',
          'session-claude-retry-guard',
          'trace-claude-retry-guard',
          {
            analysisMode: 'full',
            packageName: 'com.example.app',
            runManifestAttributionSink: createNoopAttributionSink(runtimePerformanceRecorder),
          },
        ),
      );

      expect(result.success).toBe(true);
      const calls = claudeSdkMock.__getQueryCalls();
      expect(calls).toHaveLength(2);
      expect(calls[0].options.resume).toBe('sdk-missing');
      expect(calls[1].options.resume).toBeUndefined();
      expect(focusSpy).toHaveBeenCalledTimes(1);
      expect(completenessSpy).toHaveBeenCalledTimes(1);
      expect(registrySpy).toHaveBeenCalled();
      expect(knowledgeSpy).toHaveBeenCalledTimes(1);
      const phases = runtimePerformanceRecorder.seal().phases;
      for (const phaseName of [
        'classification',
        'focus',
        'architecture',
        'completeness',
        'skill_registry',
        'knowledge',
        'sdk_start',
        'finalization',
      ]) {
        expect(phases.filter(phase => phase.name === phaseName)).toHaveLength(1);
      }
      expect(phases.filter(phase => phase.name === 'provider')).toEqual([
        expect.objectContaining({ name: 'provider', outcome: 'error' }),
        expect.objectContaining({ name: 'provider', outcome: 'ok' }),
      ]);
      expect((runtime as any).sessionMap.get('session-claude-retry-guard')).toEqual(expect.objectContaining({
        sdkSessionId: 'sdk-recovered',
        mode: 'full',
      }));
      expect(updates).toContainEqual(expect.objectContaining({
        type: 'degraded',
        content: expect.objectContaining({
          fallback: 'fresh_sdk_session_after_missing_conversation',
        }),
      }));
    } finally {
      focusSpy.mockRestore();
      completenessSpy.mockRestore();
      registrySpy.mockRestore();
      knowledgeSpy.mockRestore();
      sessionContextManager.remove('session-claude-retry-guard');
    }
  });

  it('does not start a second Claude provider when cancelled during missing SDK recovery', async () => {
    const sessionId = 'session-claude-retry-cancel';
    const traceId = 'trace-claude-retry-cancel';
    const runtime = new ClaudeRuntime({
      query: async () => ({ columns: ['cnt'], rows: [[0]] }),
      getTrace: () => ({ traceOs: 'android', traceFormat: 'perfetto' }),
    } as any, {
      enableVerification: false,
      enableSubAgents: false,
    });
    (runtime as any).architectureCache.set(traceId, {
      type: 'STANDARD',
      confidence: 0.9,
      evidence: [],
    });
    (runtime as any).sessionMap.set(sessionId, {
      sdkSessionId: 'sdk-missing',
      updatedAt: Date.now(),
      mode: 'full',
    });
    const originalRetryWithoutSdkResume = (runtime as any).retryWithoutSdkResume.bind(runtime);
    jest.spyOn(runtime as any, 'retryWithoutSdkResume').mockImplementation(async (params: unknown) => {
      await originalRetryWithoutSdkResume(params);
      await (runtime as any).executionGuard.abortSession(sessionId);
    });
    claudeSdkMock.__setQueryImplementation(async function* () {
      yield {
        type: 'result',
        subtype: 'error_during_execution',
        errors: [{ message: 'No conversation found with session ID: sdk-missing' }],
        session_id: 'sdk-missing',
        num_turns: 1,
      };
    });

    const result = await runtime.analyze(
      '继续分析启动性能',
      sessionId,
      traceId,
      {
        analysisMode: 'full',
        packageName: 'com.example.app',
      },
    );
    expect(result.success).toBe(false);
    expect(result.terminationMessage).toMatch(/aborted|cancelled/i);
    expect(claudeSdkMock.__getQueryCalls()).toHaveLength(1);
  });

  it('does not publish a Claude turn or correction when cancelled during final verification', async () => {
    const sessionId = 'session-claude-verification-cancel';
    const traceId = 'trace-claude-verification-cancel';
    const verificationStarted = createDeferred<void>();
    const releaseVerification = createDeferred<void>();
    mockClaudeVerifierVerifyConclusion.mockImplementationOnce(async () => {
      verificationStarted.resolve();
      await releaseVerification.promise;
      return {
        passed: true,
        heuristicIssues: [],
        llmIssues: [],
        durationMs: 1,
      };
    });
    const runtime = new ClaudeRuntime({
      query: async () => ({ columns: ['cnt'], rows: [[0]] }),
      getTrace: () => ({ traceOs: 'android', traceFormat: 'perfetto' }),
    } as any, {
      enableVerification: true,
      enableSubAgents: false,
    });
    (runtime as any).architectureCache.set(traceId, {
      type: 'STANDARD',
      confidence: 0.9,
      evidence: [],
    });
    claudeSdkMock.__setQueryImplementation(async function* () {
      yield {
        type: 'result',
        subtype: 'success',
        session_id: 'sdk-claude-verification-cancel',
        num_turns: 1,
        result: [
          '## 综合结论',
          '',
          'Claude verification cancellation should not publish a durable turn.',
          '',
          '## 关键证据链',
          '',
          '- Verification is paused by the test before publication.',
          '',
          '## 优化建议',
          '',
          '- Do not publish after cancellation.',
        ].join('\n'),
      };
    });

    const runtimePerformanceRecorder = createRuntimePerformanceRecorder();
    const analysis = withEffectiveRuntimeRegistrySnapshot(
      createEffectiveRuntimeRegistrySnapshot(),
      () => runtime.analyze('分析启动性能', sessionId, traceId, {
        analysisMode: 'full',
        packageName: 'com.example.app',
        runManifestAttributionSink: createNoopAttributionSink(runtimePerformanceRecorder),
      }),
    );
    await verificationStarted.promise;
    runtime.abortSession(sessionId);
    releaseVerification.resolve();

    const result = await analysis;
    expect(result.success).toBe(false);
    expect(result.terminationMessage).toMatch(/aborted|cancelled/i);
    expect(claudeSdkMock.__getQueryCalls()).toHaveLength(1);
    const turns = sessionContextManager.getOrCreate(sessionId, traceId).getAllTurns?.() ?? [];
    expect(turns).toHaveLength(0);
    const receipt = runtimePerformanceRecorder.seal();
    const finalizationPhases = receipt.phases.filter(phase => phase.name === 'finalization');
    expect(finalizationPhases).toHaveLength(1);
    expect(finalizationPhases[0]).toEqual(expect.objectContaining({outcome: 'cancelled'}));
    sessionContextManager.remove(sessionId);
  });

  it('does not mutate Claude plan, notes, or snapshot state when cancelled after provider loop closes', async () => {
    const sessionId = 'session-claude-post-loop-cancel';
    const traceId = 'trace-claude-post-loop-cancel';
    const runtime = new ClaudeRuntime({
      query: async () => ({ columns: ['cnt'], rows: [[0]] }),
      getTrace: () => ({ traceOs: 'android', traceFormat: 'perfetto' }),
    } as any, {
      enableVerification: false,
      enableSubAgents: false,
    });
    (runtime as any).architectureCache.set(traceId, {
      type: 'STANDARD',
      confidence: 0.9,
      evidence: [],
    });
    const plan = {
      phases: [{
        id: 'final',
        name: '综合结论',
        goal: '输出最终报告',
        expectedTools: [],
        status: 'pending',
      }],
      successCriteria: '输出最终报告',
      submittedAt: Date.now(),
      toolCallLog: [],
    };
    const originalPrepare = (runtime as any).prepareAnalysisContext.bind(runtime);
    jest.spyOn(runtime as any, 'prepareAnalysisContext').mockImplementation(async (...args: unknown[]) => {
      const ctx = await originalPrepare(...args);
      ctx.analysisPlan.current = plan;
      (runtime as any).sessionPlans.set(sessionId, ctx.analysisPlan);
      (runtime as any).sessionNotes.set(sessionId, []);
      return ctx;
    });
    claudeSdkMock.__setQueryImplementation(async function* () {
      yield { type: 'system', subtype: 'compact_boundary' };
      yield {
        type: 'result',
        subtype: 'success',
        session_id: 'sdk-claude-post-loop-cancel',
        num_turns: 1,
        result: [
          '## 综合结论',
          '',
          'Claude post-loop cancellation should not mutate plan or recovery notes.',
          '',
          '## 关键证据链',
          '',
          '- Provider loop completed before cancellation.',
          '',
          '## 优化建议',
          '',
          '- Stop before durable post-loop state mutation.',
        ].join('\n'),
      };
      queueMicrotask(() => {
        void runtime.abortSession(sessionId);
      });
    });

    const result = await runtime.analyze('分析启动性能', sessionId, traceId, {
      analysisMode: 'full',
      packageName: 'com.example.app',
    });

    expect(result.success).toBe(false);
    expect(result.terminationMessage).toMatch(/aborted|cancelled/i);
    expect((runtime.getSessionPlan(sessionId)?.phases[0] as any)?.status).toBe('pending');
    expect(runtime.getSessionNotes(sessionId)).toHaveLength(0);
    const snapshot = runtime.takeSnapshot(sessionId, traceId, {
      conversationSteps: [],
      queryHistory: [],
      conclusionHistory: [],
      agentDialogue: [],
      agentResponses: [],
      dataEnvelopes: [],
      runSequence: 0,
      conversationOrdinal: 0,
    } as any);
    expect((snapshot.analysisPlan?.phases[0] as any)?.status).toBe('pending');
    expect(snapshot.analysisNotes).toEqual([]);
    sessionContextManager.remove(sessionId);
  });

  it('uses the request language throughout the full path without mutating runtime defaults', async () => {
    const runtime = new ClaudeRuntime({
      query: async () => ({columns: ['cnt'], rows: [[0]]}),
      getTrace: () => ({traceOs: 'android', traceFormat: 'perfetto'}),
    } as any, {
      outputLanguage: 'zh-CN',
      enableVerification: false,
      enableSubAgents: false,
    });
    (runtime as any).architectureCache.set('trace-language-full', {
      type: 'STANDARD',
      confidence: 0.9,
      evidence: [],
    });
    const updates: any[] = [];
    runtime.on('update', update => updates.push(update));
    claudeSdkMock.__setQueryImplementation(async function* () {
      yield {
        type: 'result',
        subtype: 'success',
        session_id: 'sdk-language-full',
        num_turns: 1,
        result: [
          '# Performance Analysis Report',
          '',
          '## Overall Conclusion',
          '',
          'The selected interval is stable based on the collected evidence.',
          '',
          '## Key Evidence Chain',
          '',
          '- The trace query completed successfully.',
          '',
          '## Recommendations',
          '',
          '- Continue monitoring the selected interval.',
        ].join('\n'),
      };
    });

    await runtime.analyze(
      'Analyze the selected interval',
      'session-language-full',
      'trace-language-full',
      {
        analysisMode: 'full',
        outputLanguage: 'en',
        packageName: 'com.example.app',
        selectionContext: {kind: 'area', startNs: 100, endNs: 200} as any,
      },
    );

    const [call] = claudeSdkMock.__getQueryCalls();
    expect(JSON.stringify(call.options.systemPrompt)).toContain(
      'All user-facing answers, reports, phase summaries',
    );
    const progress = updates.filter(update => update.type === 'progress')
      .map(update => String(update.content?.message ?? '')).join('\n');
    expect(progress).toContain('Starting analysis with');
    expect(progress).not.toContain('开始分析');
    expect((runtime as any).config.outputLanguage).toBe('zh-CN');
  });

  it('keeps private full-mode Claude transcripts ephemeral and out of resume maps', async () => {
    const sessionId = 'session-private-sdk';
    const runtime = new ClaudeRuntime({
      query: async () => ({columns: ['cnt'], rows: [[0]]}),
      getTrace: () => ({traceOs: 'android', traceFormat: 'perfetto'}),
    } as any, {
      enableVerification: false,
      enableSubAgents: false,
    });
    (runtime as any).architectureCache.set('trace-private-sdk', {
      type: 'STANDARD',
      confidence: 0.9,
      evidence: [],
    });
    sessionContextManager.getOrCreate(sessionId, 'trace-private-sdk').addTurn(
      '上一轮私有问题',
      {
        primaryGoal: '上一轮私有问题',
        aspects: [],
        expectedOutputType: 'diagnosis',
        complexity: 'complex',
        followUpType: 'initial',
      },
      {
        agentId: 'claude-agent',
        success: true,
        findings: [],
        confidence: 0.8,
        message: 'PRIVATE_LOCAL_CONTINUITY_CANARY',
      },
      [],
    );
    claudeSdkMock.__setQueryImplementation(async function* () {
      yield {
        type: 'result',
        subtype: 'success',
        session_id: 'sdk-private-session-canary',
        num_turns: 1,
        result: [
          '## 综合结论',
          '私有源码分析已完成。',
          '',
          '## 关键证据链',
          '- 仅使用本轮授权上下文。',
          '',
          '## 优化建议',
          '- 修正私有源码中的热点路径。',
        ].join('\n'),
      };
    });

    try {
      const result = await runtime.analyze('分析私有源码热点', sessionId, 'trace-private-sdk', {
        analysisMode: 'full',
        codeAwareMode: 'metadata_only',
        codebaseIds: ['private-app'],
        tenantId: 'tenant-private',
        workspaceId: 'workspace-private',
        userId: 'user-private',
      });

      expect(result).toMatchObject({
        success: false,
        partial: true,
        terminationReason: 'plan_incomplete',
        sourceUseDecision: expect.objectContaining({status: 'pending'}),
      });
      const [call] = claudeSdkMock.__getQueryCalls();
      expect(call.options.persistSession).toBe(false);
      expect(call.options.resume).toBeUndefined();
      expect(call.prompt).toContain('PRIVATE_LOCAL_CONTINUITY_CANARY');
      expect(runtime.getSdkSessionId(sessionId)).toBeUndefined();
      expect(JSON.stringify(Array.from((runtime as any).sessionMap.values())))
        .not.toContain('sdk-private-session-canary');
    } finally {
      sessionContextManager.remove(sessionId);
    }
  });

  it.each(['full', 'fast'] as const)(
    'blocks successful Claude %s output while the real source accessor is pending',
    async analysisMode => {
      const sessionId = `session-claude-pending-${analysisMode}`;
      const traceId = `trace-claude-pending-${analysisMode}`;
      const originalCreateMcp = claudeMcpServer.createClaudeMcpServer;
      const fixture = createRuntimeSourceFinalizationFixture({
        createMcpServer: originalCreateMcp,
        sessionId,
      });
      const createMcpSpy = jest.spyOn(claudeMcpServer, 'createClaudeMcpServer')
        .mockReturnValue(fixture.mcp);
      const runtime = new ClaudeRuntime({
        query: async () => ({columns: ['cnt'], rows: [[0]]}),
        getTrace: () => ({traceOs: 'android', traceFormat: 'perfetto'}),
      } as any, {
        enableVerification: false,
        enableSubAgents: false,
      });
      (runtime as any).architectureCache.set(traceId, {
        type: 'STANDARD',
        confidence: 0.9,
        evidence: [],
      });
      claudeSdkMock.__setQueryImplementation(async function* () {
        yield {
          type: 'result',
          subtype: 'success',
          session_id: `sdk-pending-${analysisMode}`,
          num_turns: 1,
          result: '## Final Report\nTask 7 pending source answer',
        };
      });

      try {
        const result = await runtime.analyze('source pending run', sessionId, traceId, {
          analysisMode,
          assistantSurface: analysisMode === 'fast' ? 'conversation' : undefined,
          conversationTraceAttached: analysisMode === 'fast' ? true : undefined,
          codeAwareMode: 'provider_send',
          codebaseIds: [fixture.codebaseId],
        });

        expect(result).toMatchObject({
          success: false,
          partial: true,
          terminationReason: 'plan_incomplete',
          sourceUseDecision: expect.objectContaining({status: 'pending'}),
        });
      } finally {
        createMcpSpy.mockRestore();
        fixture.cleanup();
        sessionContextManager.remove(sessionId);
      }
    },
  );

  it('finalizes a failed Claude quick result with the actual source accessor and echo guard', async () => {
    const sessionId = 'session-claude-quick-error-finalization';
    const traceId = 'trace-claude-quick-error-finalization';
    const originalCreateMcp = claudeMcpServer.createClaudeMcpServer;
    const fixture = createRuntimeSourceFinalizationFixture({
      createMcpServer: originalCreateMcp,
      sessionId,
    });
    const createMcpSpy = jest.spyOn(claudeMcpServer, 'createClaudeMcpServer')
      .mockReturnValue(fixture.mcp);
    const runtime = new ClaudeRuntime({
      query: async () => ({columns: ['cnt'], rows: [[0]]}),
      getTrace: () => ({traceOs: 'android', traceFormat: 'perfetto'}),
    } as any, {
      enableVerification: false,
      enableSubAgents: false,
    });
    (runtime as any).architectureCache.set(traceId, {
      type: 'STANDARD',
      confidence: 0.9,
      evidence: [],
    });
    claudeSdkMock.__setQueryImplementation(async function* () {
      yield {
        type: 'result',
        subtype: 'error_during_execution',
        errors: [SOURCE_FINALIZATION_RAW_SOURCE],
      };
    });

    try {
      const {decision} = await fixture.executeProviderSourceLookup();
      const result = await runtime.analyze('source quick error run', sessionId, traceId, {
        analysisMode: 'fast',
        assistantSurface: 'conversation',
        conversationTraceAttached: true,
        codeAwareMode: 'provider_send',
        codebaseIds: [fixture.codebaseId],
      });

      expect(result.success).toBe(false);
      expect(result.terminationReason).toBe('execution_error');
      expect(result.terminationMessage).toBeDefined();
      expect(result.sourceUseDecision).toEqual(decision);
      expect(result.sourceReferences).toEqual(decision.references);
      expect(JSON.stringify(result)).not.toContain(SOURCE_FINALIZATION_CANARY);
    } finally {
      createMcpSpy.mockRestore();
      fixture.cleanup();
      sessionContextManager.remove(sessionId);
    }
  });

  it('returns real MCP source refs and starts the next Claude run without stale source state', async () => {
    const sessionId = 'session-claude-source-finalization';
    const traceId = 'trace-claude-source-finalization';
    const originalCreateMcp = claudeMcpServer.createClaudeMcpServer;
    const fixture = createRuntimeSourceFinalizationFixture({
      createMcpServer: originalCreateMcp,
      sessionId,
    });
    const createMcpSpy = jest.spyOn(claudeMcpServer, 'createClaudeMcpServer')
      .mockImplementation((options: any) => options.codeAwareMode === 'provider_send'
        ? fixture.mcp
        : originalCreateMcp(options));
    const runtime = new ClaudeRuntime({
      query: async () => ({columns: ['cnt'], rows: [[0]]}),
      getTrace: () => ({traceOs: 'android', traceFormat: 'perfetto'}),
    } as any, {
      enableVerification: false,
      enableSubAgents: false,
    });
    (runtime as any).architectureCache.set(traceId, {
      type: 'STANDARD',
      confidence: 0.9,
      evidence: [],
    });
    claudeSdkMock.__setQueryImplementation(async function* ({prompt}: any) {
      const sourceRun = String(prompt).includes('source terminal run');
      yield {
        type: 'result',
        subtype: 'success',
        session_id: sourceRun ? 'sdk-source-terminal' : 'sdk-source-off',
        num_turns: 1,
        result: sourceRun ? SOURCE_FINALIZATION_RAW_SOURCE : 'public second run',
      };
    });

    try {
      const {decision} = await fixture.executeProviderSourceLookup();
      const terminal = await runtime.analyze('source terminal run', sessionId, traceId, {
        analysisMode: 'fast',
        assistantSurface: 'conversation',
        conversationTraceAttached: true,
        codeAwareMode: 'provider_send',
        codebaseIds: [fixture.codebaseId],
      });
      const next = await runtime.analyze('public second run', sessionId, traceId, {
        analysisMode: 'fast',
        codeAwareMode: 'off',
      });

      expect(terminal.success).toBe(true);
      expect(terminal.sourceUseDecision).toEqual(decision);
      expect(terminal.sourceReferences).toEqual(decision.references);
      expect(JSON.stringify(terminal)).not.toContain(SOURCE_FINALIZATION_CANARY);
      expect(next.sourceUseDecision).toBeUndefined();
      expect(next.sourceReferences).toBeUndefined();
    } finally {
      createMcpSpy.mockRestore();
      fixture.cleanup();
      sessionContextManager.remove(sessionId);
    }
  });

  it('keeps generic SDK execution errors failed after an evidence-backed streamed answer', async () => {
    const sessionId = 'session-generic-stream-failure';
    const runtime = new ClaudeRuntime({
      query: async () => ({columns: ['cnt'], rows: [[0]]}),
      getTrace: () => ({traceOs: 'android', traceFormat: 'perfetto'}),
    } as any, {
      enableVerification: false,
      enableSubAgents: false,
    });
    (runtime as any).architectureCache.set('trace-generic-stream-failure', {
      type: 'STANDARD',
      confidence: 0.9,
      evidence: [],
    });
    const updates: Array<{type?: string; content?: Record<string, unknown>}> = [];
    runtime.on('update', update => updates.push(update as any));
    claudeSdkMock.__setQueryImplementation(async function* () {
      yield {
        type: 'assistant',
        session_id: 'sdk-generic-stream-failure',
        message: {
          content: [{
            type: 'text',
            text: [
              '# 启动性能分析报告',
              '',
              '## 综合结论',
              '',
              '冷启动 TTID=1912ms，证据来自 art-1。',
              '',
              '## 关键证据链',
              '',
              '- art-1: 主线程热点 568.8ms。',
              '',
              '## 优化建议',
              '',
              '- 拆分主线程同步初始化。',
            ].join('\n'),
          }],
        },
      };
      yield {
        type: 'result',
        subtype: 'error_during_execution',
        session_id: 'sdk-generic-stream-failure',
        num_turns: 2,
        errors: ['Claude analysis error after tool execution'],
      };
    });

    const runtimePerformanceRecorder = createRuntimePerformanceRecorder();
    try {
      const result = await withEffectiveRuntimeRegistrySnapshot(
        createEffectiveRuntimeRegistrySnapshot(),
        () => runtime.analyze(
          '分析启动性能',
          sessionId,
          'trace-generic-stream-failure',
          {
            analysisMode: 'full',
            runManifestAttributionSink: createNoopAttributionSink(runtimePerformanceRecorder),
          },
        ),
      );

      expect(result).toMatchObject({
        success: false,
        terminationReason: 'execution_error',
      });
      expect(result.partial).not.toBe(true);
      expect(result.conclusion).toContain('分析过程中出错');
      expect(updates).not.toContainEqual(expect.objectContaining({
        type: 'degraded',
        content: expect.objectContaining({
          fallback: 'partial_result_after_stream_termination',
        }),
      }));
      const receipt = runtimePerformanceRecorder.seal();
      const finalizationPhases = receipt.phases.filter(phase => phase.name === 'finalization');
      expect(finalizationPhases).toHaveLength(1);
      expect(finalizationPhases[0]).toEqual(expect.objectContaining({outcome: 'error'}));
      expect(receipt.phases).toEqual(expect.arrayContaining([
        expect.objectContaining({name: 'provider', outcome: 'error'}),
      ]));
    } finally {
      sessionContextManager.remove(sessionId);
    }
  });

  it.each([
    {
      name: 'stream execution failure',
      subtype: 'error_during_execution',
      errors: ['stream terminated before completion'],
      terminationReason: 'execution_error',
      fallback: 'partial_result_after_stream_termination',
    },
    {
      name: 'maximum-turn termination',
      subtype: 'error_max_turns',
      errors: ['maximum turns reached'],
      terminationReason: 'max_turns',
      fallback: 'partial_result_after_max_turns',
    },
  ])('sanitizes a private streamed report before returning after $name', async ({
    subtype,
    errors,
    terminationReason,
    fallback,
  }) => {
    const sessionId = 'session-private-stream-recovery';
    const privateCanary = 'PRIVATE_STREAM_RECOVERY_CANARY';
    registerCodeAwareCanary(sessionId, privateCanary);
    const runtime = new ClaudeRuntime({
      query: async () => ({columns: ['cnt'], rows: [[0]]}),
      getTrace: () => ({traceOs: 'android', traceFormat: 'perfetto'}),
    } as any, {
      enableVerification: false,
      enableSubAgents: false,
    });
    (runtime as any).architectureCache.set('trace-private-stream-recovery', {
      type: 'STANDARD',
      confidence: 0.9,
      evidence: [],
    });
    const updates: Array<{type?: string; content?: Record<string, unknown>}> = [];
    runtime.on('update', update => updates.push(update as any));
    claudeSdkMock.__setQueryImplementation(async function* () {
      yield {
        type: 'assistant',
        session_id: 'sdk-private-stream-recovery',
        message: {
          content: [{
            type: 'text',
            text: [
              '# 启动性能分析报告',
              '',
              '## 综合结论',
              '',
              `冷启动 TTID=1912ms，证据来自 art-1。${privateCanary}`,
              '',
              '## 关键证据链',
              '',
              '- art-1: 主线程热点 568.8ms。',
              '',
              '## 优化建议',
              '',
              '- 拆分主线程同步初始化。',
            ].join('\n'),
          }],
        },
      };
      yield {
        type: 'result',
        subtype,
        session_id: 'sdk-private-stream-recovery',
        num_turns: 2,
        errors,
      };
    });

    try {
      const result = await runtime.analyze(
        '分析私有源码启动热点',
        sessionId,
        'trace-private-stream-recovery',
        {
          analysisMode: 'full',
          codeAwareMode: 'metadata_only',
          codebaseIds: ['private-app'],
          tenantId: 'tenant-private',
          workspaceId: 'workspace-private',
          userId: 'user-private',
        },
      );

      expect(result).toMatchObject({
        success: false,
        partial: true,
        terminationReason: 'plan_incomplete',
        sourceUseDecision: expect.objectContaining({status: 'pending'}),
      });
      expect(result.conclusion).toContain('TTID=1912ms');
      expect(JSON.stringify(result)).not.toContain(privateCanary);
      expect(updates).toContainEqual(expect.objectContaining({
        type: 'degraded',
        content: expect.objectContaining({
          fallback,
          partial: true,
        }),
      }));
    } finally {
      sessionContextManager.remove(sessionId);
    }
  });

  it('keeps unsupported runtime prompt cache capabilities on the full system prompt string', () => {
    const sdkPrompt = __testing.buildClaudeSdkSystemPrompt({
      fullPrompt: 'stable\n\nvolatile',
      stablePrefix: 'stable',
      volatileSuffix: 'volatile',
    }, {
      kind: 'unsupported-runtime',
      displayName: 'Unsupported Runtime',
      production: false,
      publicRuntime: false,
      promptCache: { systemPromptDynamicBoundary: false },
    });

    expect(sdkPrompt).toBe('stable\n\nvolatile');
  });

  it('keeps monitor-only context pressure warnings out of user-facing progress updates', async () => {
    process.env.CLAUDE_PRECOMPACT_THRESHOLD = '0.6';
    const runtime = new ClaudeRuntime({
      query: async () => ({ columns: [], rows: [] }),
      getTrace: () => ({ traceOs: 'android', traceFormat: 'perfetto' }),
    } as any, {
      enableVerification: false,
      enableSubAgents: false,
    });
    (runtime as any).architectureCache.set('trace-context-pressure', {
      type: 'STANDARD',
      confidence: 0.9,
      evidence: [],
    });
    const updates: any[] = [];
    runtime.on('update', update => updates.push(update));
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    claudeSdkMock.__setQueryImplementation(async function* () {
      yield {
        type: 'assistant',
        session_id: 'sdk-context-pressure',
        message: { content: [] },
      };
      yield {
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: {
            usage: {
              input_tokens: 130_000,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
          },
        },
      };
      yield {
        type: 'result',
        subtype: 'success',
        session_id: 'sdk-context-pressure',
        num_turns: 1,
        result: [
          '# 启动性能分析报告',
          '',
          '## 综合结论',
          '',
          '冷启动 TTID=1912ms，主因是 ChaosTask，证据来自 data:art-1。',
          '',
          '## 关键证据链',
          '',
          '- data:art-1: startup_analysis 显示冷启动。',
          '',
          '## 优化建议',
          '',
          '- 减少主线程模拟负载。',
        ].join('\n'),
      };
    });

    try {
      const result = await runtime.analyze('分析启动性能', 'session-context-pressure', 'trace-context-pressure', {
        analysisMode: 'full',
        packageName: 'com.example.launch.aosp.heavy',
      });

      expect(result.success).toBe(true);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('pre-rot threshold crossed'));
      const progressText = updates
        .filter(update => update.type === 'progress')
        .map(update => JSON.stringify(update.content))
        .join('\n');
      expect(progressText).not.toContain('接近上下文上限');
      expect(progressText).not.toContain('Context window is close to its limit');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('records authoritative first-turn Claude result usage including cache tokens', async () => {
    const runtime = new ClaudeRuntime({
      query: async () => ({columns: [], rows: []}),
      getTrace: () => ({traceOs: 'android', traceFormat: 'perfetto'}),
    } as any, {
      enableVerification: false,
      enableSubAgents: false,
    });
    (runtime as any).architectureCache.set('trace-evaluation-usage', {
      type: 'STANDARD',
      confidence: 0.9,
      evidence: [],
    });
    claudeSdkMock.__setQueryImplementation(async function* () {
      yield {
        type: 'assistant',
        session_id: 'sdk-evaluation-usage',
        message: {content: []},
      };
      yield {
        type: 'result',
        subtype: 'success',
        session_id: 'sdk-evaluation-usage',
        num_turns: 1,
        usage: {
          input_tokens: 10,
          output_tokens: 3,
          cache_read_input_tokens: 7,
          cache_creation_input_tokens: 2,
        },
        result: [
          '# 启动性能分析报告',
          '',
          '## 综合结论',
          '',
          '启动分析完成，证据来自 data:art-usage。',
          '',
          '## 关键证据链',
          '',
          '- data:art-usage: 启动路径证据。',
          '',
          '## 优化建议',
          '',
          '- 缩短主线程初始化。',
        ].join('\n'),
      };
    });

    const receipt = await withEvaluationTelemetry({
      limits: {
        schemaVersion: 1,
        maxTokens: 100,
        maxToolCalls: 100,
        maxWallclockMs: 30_000,
        maxTraceProcessorCpuMs: 30_000,
      },
      capabilities: evaluationRuntimeCapabilities({
        runtime: 'claude-agent-sdk',
      }),
      signal: new AbortController().signal,
      isAuthoritative: () => true,
    }, async () => {
      const result = await runtime.analyze(
        '分析启动性能',
        'session-evaluation-usage',
        'trace-evaluation-usage',
        {
          analysisMode: 'full',
          packageName: 'com.example.app',
        },
      );
      expect(result.success).toBe(true);
      return snapshotEvaluationUsageReceipt();
    });

    expect(receipt.tokens).toMatchObject({
      used: 22,
      guarantee: 'soft_observed',
    });
    sessionContextManager.remove('session-evaluation-usage');
  });

  it('returns a terminal partial result after the full provider stream becomes idle', async () => {
    const sessionId = 'session-full-stream-idle-timeout';
    const traceId = 'trace-full-stream-idle-timeout';
    const runtime = new ClaudeRuntime({
      query: async () => ({columns: ['cnt'], rows: [[0]]}),
      getTrace: () => ({traceOs: 'android', traceFormat: 'perfetto'}),
    } as any, {
      enableVerification: false,
      enableSubAgents: false,
      maxTurns: 1,
      fullPathPerTurnMs: 100,
      fullRequestTimeoutMs: 1_000,
      streamIdleTimeoutMs: 15,
    });
    (runtime as any).architectureCache.set(traceId, {
      type: 'STANDARD',
      confidence: 0.9,
      evidence: [],
    });
    const updates: Array<{type?: string; content?: Record<string, unknown>}> = [];
    runtime.on('update', update => updates.push(update as any));
    claudeSdkMock.__setQueryImplementation(async function* () {
      yield {
        type: 'assistant',
        session_id: 'sdk-full-stream-idle-timeout',
        message: {content: [{
          type: 'text',
          text: [
            '# 启动性能分析报告',
            '',
            '## 综合结论',
            '',
            '已收集到可交付的部分证据，art-1 显示主线程存在阻塞。',
            '',
            '## 关键证据链',
            '',
            '- art-1: 主线程阻塞 568.8ms。',
            '',
            '## 优化建议',
            '',
            '- 拆分同步初始化。',
          ].join('\n'),
        }]},
      };
      await new Promise<void>(() => undefined);
    });

    try {
      const result = await runtime.analyze(
        '分析启动性能',
        sessionId,
        traceId,
        {analysisMode: 'full'},
      );

      expect(result).toMatchObject({
        success: true,
        partial: true,
        terminationReason: 'timeout',
      });
      expect(result.conclusion).toContain('art-1');
      expect(updates).toContainEqual(expect.objectContaining({
        type: 'degraded',
        content: expect.objectContaining({
          fallback: 'partial_result_after_timeout',
          partial: true,
          terminationReason: 'timeout',
          timeoutKind: 'stream_idle',
        }),
      }));
    } finally {
      sessionContextManager.remove(sessionId);
    }
  });

  it('uses scoped Claude provider tuning when preparing full SDK options', async () => {
    const original = {
      anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL,
      anthropicApiKey: process.env.ANTHROPIC_API_KEY,
      claudeModel: process.env.CLAUDE_MODEL,
      claudeLightModel: process.env.CLAUDE_LIGHT_MODEL,
      claudeBinaryPath: process.env.CLAUDE_BINARY_PATH,
    };
    process.env.ANTHROPIC_BASE_URL = 'https://global-main.example/v1';
    process.env.ANTHROPIC_API_KEY = 'sk-global-main';
    process.env.CLAUDE_MODEL = 'global-claude-main';
    process.env.CLAUDE_LIGHT_MODEL = 'global-claude-light';
    process.env.CLAUDE_BINARY_PATH = '/tmp/global-main-claude';
    try {
      const svc = getProviderService();
      const provider = svc.create({
        name: 'Scoped Claude Provider',
        category: 'official',
        type: 'anthropic',
        models: {
          primary: 'provider-claude-main',
          light: 'provider-claude-light',
          subAgent: 'provider-claude-subagent',
        },
        connection: {
          agentRuntime: 'claude-agent-sdk',
          claudeBaseUrl: 'https://provider-main.example/v1',
          claudeApiKey: 'sk-provider-claude',
        },
        tuning: {
          maxTurns: 4,
          fullPerTurnMs: 10000,
          effort: 'max',
          enableSubAgents: true,
          enableVerification: false,
        },
      });
      svc.activate(provider.id);

      const runtime = new ClaudeRuntime({
        query: async () => ({ columns: [], rows: [] }),
        getTrace: () => ({ traceOs: 'android', traceFormat: 'perfetto' }),
      } as any, {
        enableVerification: false,
        enableSubAgents: false,
        model: 'base-claude-main',
        maxTurns: 60,
        effort: 'low',
      });
      (runtime as any).architectureCache.set('trace-provider', {
        type: 'STANDARD',
        confidence: 0.9,
        evidence: [],
      });
      claudeSdkMock.__setQueryImplementation(async function* () {
        yield {
          type: 'result',
          subtype: 'success',
          session_id: 'sdk-provider-session',
          num_turns: 1,
          result: [
            '## 综合结论',
            'Scoped provider tuning was applied to the Claude full analysis path.',
            '',
            '## 证据',
            '- Provider-specific model, effort, maxTurns, and sub-agent config were used.',
          ].join('\n'),
        };
      });

      const result = await runtime.analyze('分析 UI 卡顿', 'session-provider', 'trace-provider', {
        analysisMode: 'full',
        packageName: 'com.example.app',
      });

      expect(result.success).toBe(true);
      const [call] = claudeSdkMock.__getQueryCalls();
      expect(call.options.model).toBe('provider-claude-main');
      expect(call.options.maxTurns).toBe(4);
      expect(call.options.effort).toBe('max');
      expect(call.options.pathToClaudeCodeExecutable).toBe('/tmp/global-main-claude');
      expect(call.options.env.CLAUDE_MODEL).toBe('provider-claude-main');
      expect(call.options.env.CLAUDE_LIGHT_MODEL).toBe('provider-claude-light');
      expect(call.options.env.ANTHROPIC_BASE_URL).toBe('https://provider-main.example/v1');
      expect(call.options.env.ANTHROPIC_API_KEY).toBe('sk-provider-claude');
      expect(call.options.agents).toBeDefined();
      expect(call.options.tools).toEqual(['Agent']);
      expect(call.options.allowedTools).toContain('Agent');
      expect(JSON.stringify(call.options.agents)).toContain('provider-claude-subagent');
      expect(process.env.ANTHROPIC_BASE_URL).toBe('https://global-main.example/v1');
      expect(process.env.ANTHROPIC_API_KEY).toBe('sk-global-main');
      expect(process.env.CLAUDE_MODEL).toBe('global-claude-main');
      expect(process.env.CLAUDE_LIGHT_MODEL).toBe('global-claude-light');
      expect(process.env.CLAUDE_BINARY_PATH).toBe('/tmp/global-main-claude');
    } finally {
      restoreEnvValue('ANTHROPIC_BASE_URL', original.anthropicBaseUrl);
      restoreEnvValue('ANTHROPIC_API_KEY', original.anthropicApiKey);
      restoreEnvValue('CLAUDE_MODEL', original.claudeModel);
      restoreEnvValue('CLAUDE_LIGHT_MODEL', original.claudeLightModel);
      restoreEnvValue('CLAUDE_BINARY_PATH', original.claudeBinaryPath);
    }
  });

  it('uses scoped Claude provider tuning for SDK correction retries without mutating process.env', async () => {
    const original = {
      anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL,
      anthropicApiKey: process.env.ANTHROPIC_API_KEY,
      claudeModel: process.env.CLAUDE_MODEL,
      claudeLightModel: process.env.CLAUDE_LIGHT_MODEL,
      claudeBinaryPath: process.env.CLAUDE_BINARY_PATH,
    };
    process.env.ANTHROPIC_BASE_URL = 'https://global-correction.example/v1';
    process.env.ANTHROPIC_API_KEY = 'sk-global-correction';
    process.env.CLAUDE_MODEL = 'global-claude-main';
    process.env.CLAUDE_LIGHT_MODEL = 'global-claude-light';
    process.env.CLAUDE_BINARY_PATH = '/tmp/global-correction-claude';
    try {
      const svc = getProviderService();
      const provider = svc.create({
        name: 'Scoped Claude Correction Provider',
        category: 'official',
        type: 'anthropic',
        models: {
          primary: 'provider-claude-correction-main',
          light: 'provider-claude-correction-light',
        },
        connection: {
          agentRuntime: 'claude-agent-sdk',
          claudeBaseUrl: 'https://provider-correction.example/v1',
          claudeApiKey: 'sk-provider-correction',
        },
        tuning: {
          maxTurns: 4,
          fullPerTurnMs: 10000,
          effort: 'max',
          enableVerification: true,
          enableSubAgents: false,
        },
      });
      svc.activate(provider.id);

      const runtime = new ClaudeRuntime({
        query: async () => ({ columns: [], rows: [] }),
        getTrace: () => ({ traceOs: 'android', traceFormat: 'perfetto' }),
      } as any, {
        enableVerification: true,
        enableSubAgents: false,
        model: 'base-claude-main',
        maxTurns: 60,
        effort: 'low',
      });
      (runtime as any).architectureCache.set('trace-provider-correction', {
        type: 'STANDARD',
        confidence: 0.9,
        evidence: [],
      });
      let sdkCallCount = 0;
      claudeSdkMock.__setQueryImplementation(async function* () {
        sdkCallCount += 1;
        yield {
          type: 'result',
          subtype: 'success',
          session_id: 'sdk-provider-correction-session',
          num_turns: 1,
          result: sdkCallCount === 1
            ? '## 综合结论\nInitial provider conclusion requires correction.'
            : [
                '## 综合结论',
                'Corrected provider conclusion.',
                '',
                '## 证据',
                '- Correction retry used the pinned provider SDK options.',
              ].join('\n'),
        };
      });
      mockClaudeVerifierVerifyConclusion
        .mockResolvedValueOnce({
          passed: false,
          heuristicIssues: [{
            type: 'final_report_contract',
            severity: 'error',
            message: 'missing required final report evidence',
          }],
          llmIssues: [],
          durationMs: 1,
        })
        .mockResolvedValueOnce({
          passed: true,
          heuristicIssues: [],
          llmIssues: [],
          durationMs: 1,
        });

      const result = await runtime.analyze(
        '分析 UI 卡顿并补齐报告',
        'session-provider-correction',
        'trace-provider-correction',
        {
          analysisMode: 'full',
          packageName: 'com.example.app',
        },
      );

      expect(result.success).toBe(true);
      const calls = claudeSdkMock.__getQueryCalls();
      expect(calls).toHaveLength(2);
      const correctionCall = calls[1];
      expect(correctionCall.options.model).toBe('provider-claude-correction-main');
      expect(correctionCall.options.pathToClaudeCodeExecutable).toBe('/tmp/global-correction-claude');
      expect(correctionCall.options.env.CLAUDE_MODEL).toBe('provider-claude-correction-main');
      expect(correctionCall.options.env.CLAUDE_LIGHT_MODEL).toBe('provider-claude-correction-light');
      expect(correctionCall.options.env.ANTHROPIC_BASE_URL).toBe('https://provider-correction.example/v1');
      expect(correctionCall.options.env.ANTHROPIC_API_KEY).toBe('sk-provider-correction');
      expect(process.env.ANTHROPIC_BASE_URL).toBe('https://global-correction.example/v1');
      expect(process.env.ANTHROPIC_API_KEY).toBe('sk-global-correction');
      expect(process.env.CLAUDE_MODEL).toBe('global-claude-main');
      expect(process.env.CLAUDE_LIGHT_MODEL).toBe('global-claude-light');
      expect(process.env.CLAUDE_BINARY_PATH).toBe('/tmp/global-correction-claude');
    } finally {
      restoreEnvValue('ANTHROPIC_BASE_URL', original.anthropicBaseUrl);
      restoreEnvValue('ANTHROPIC_API_KEY', original.anthropicApiKey);
      restoreEnvValue('CLAUDE_MODEL', original.claudeModel);
      restoreEnvValue('CLAUDE_LIGHT_MODEL', original.claudeLightModel);
      restoreEnvValue('CLAUDE_BINARY_PATH', original.claudeBinaryPath);
    }
  });

  it('records Claude preflight phases once while the provider SDK retries once', async () => {
    const sessionId = 'session-claude-provider-retry-phases';
    const traceId = 'trace-claude-provider-retry-phases';
    const referenceTraceId = 'trace-claude-provider-retry-reference';
    const traceProcessor = {
      query: jest.fn(async () => ({ columns: [], rows: [], durationMs: 1 })),
      getTrace: jest.fn(() => ({
        id: traceId,
        filename: 'trace.pftrace',
        size: 1,
        uploadTime: new Date(),
        status: 'ready',
        traceOs: 'android',
        traceFormat: 'perfetto_protobuf',
      })),
    };
    const runtime = new ClaudeRuntime(traceProcessor as any, {
      enableVerification: false,
      enableSubAgents: false,
    });
    const focusSpy = jest.spyOn(focusAppDetector, 'detectFocusApps')
      .mockResolvedValue({
        apps: [{ packageName: 'com.example.app', processName: 'com.example.app', score: 1 }],
        primaryApp: 'com.example.app',
        method: 'process_track',
      } as any);
    const architectureSpy = jest.spyOn(architectureDetector, 'createArchitectureDetector')
      .mockReturnValue({
        detect: jest.fn(async () => ({ type: 'STANDARD', confidence: 0.9, evidence: [] })),
      } as any);
    const adapterSpy = jest.spyOn(skillAnalysisAdapter, 'getSkillAnalysisAdapter')
      .mockReturnValue({
        ensureInitialized: jest.fn(async () => undefined),
        detectVendor: jest.fn(async () => ({ vendor: 'xiaomi' })),
      } as any);
    const completenessSpy = jest.spyOn(traceCompletenessProber, 'probeTraceCompleteness')
      .mockResolvedValue(undefined as any);
    const registrySpy = jest.spyOn(skillLoader, 'ensureSkillRegistryInitialized')
      .mockResolvedValue(undefined);
    const knowledgeSpy = jest.spyOn(sqlKnowledgeBase, 'getExtendedKnowledgeBase')
      .mockResolvedValue({ getContextForAI: () => 'SQL knowledge retry context' } as any);
    const comparisonSpy = jest.spyOn(runtimePromptContext, 'buildRuntimeTracePairComparisonContext')
      .mockResolvedValue({
        currentPackageName: 'com.example.app',
        referencePackageName: 'com.example.reference',
        commonCapabilities: [],
        capabilityDiff: { currentOnly: [], referenceOnly: [] },
      } as any);
    let providerAttempts = 0;
    claudeSdkMock.__setQueryImplementation(async function* () {
      providerAttempts += 1;
      if (providerAttempts === 1) {
        throw new Error('503 service unavailable');
      }
      yield {
        type: 'result',
        subtype: 'success',
        session_id: 'sdk-provider-retry-phases',
        num_turns: 1,
        result: '## 综合结论\nClaude provider retry recovered.\n\n## 证据\n- Retry path preserved preflight receipt phases.',
      };
    });
    const runtimePerformanceRecorder = createRuntimePerformanceRecorder();

    try {
      const result = await withEffectiveRuntimeRegistrySnapshot(
        createEffectiveRuntimeRegistrySnapshot(),
        () => runtime.analyze(
          '对比两条 trace 的启动差异',
          sessionId,
          traceId,
          {
            analysisMode: 'full',
            packageName: 'com.example.app',
            referenceTraceId,
            runManifestAttributionSink: createNoopAttributionSink(runtimePerformanceRecorder),
          },
        ),
      );
      expect(result).toMatchObject({ success: true });

      expect(providerAttempts).toBe(2);
      expect(claudeSdkMock.__getQueryCalls()).toHaveLength(2);
      expect(focusSpy).toHaveBeenCalledTimes(1);
      expect(architectureSpy).toHaveBeenCalledTimes(1);
      expect(adapterSpy).toHaveBeenCalledTimes(1);
      expect(completenessSpy).toHaveBeenCalledTimes(1);
      expect(registrySpy).toHaveBeenCalledTimes(1);
      expect(knowledgeSpy).toHaveBeenCalledTimes(1);
      expect(comparisonSpy).toHaveBeenCalledTimes(1);

      const phases = runtimePerformanceRecorder.seal().phases;
      for (const phaseName of [
        'classification',
        'focus',
        'architecture',
        'completeness',
        'comparison',
        'skill_registry',
        'knowledge',
        'sdk_start',
        'finalization',
      ]) {
        expect(phases.filter(phase => phase.name === phaseName)).toHaveLength(1);
      }
      expect(phases.filter(phase => phase.name === 'provider')).toEqual([
        expect.objectContaining({ name: 'provider', outcome: 'error' }),
        expect.objectContaining({ name: 'provider', outcome: 'ok' }),
      ]);
      expect(phases).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'classification', outcome: 'ok' }),
        expect.objectContaining({ name: 'focus', outcome: 'ok' }),
        expect.objectContaining({ name: 'architecture', outcome: 'ok' }),
        expect.objectContaining({ name: 'completeness', outcome: 'ok' }),
        expect.objectContaining({ name: 'comparison', outcome: 'ok' }),
        expect.objectContaining({ name: 'skill_registry', outcome: 'ok' }),
        expect.objectContaining({ name: 'knowledge', outcome: 'ok' }),
        expect.objectContaining({ name: 'finalization', outcome: 'ok' }),
      ]));
    } finally {
      focusSpy.mockRestore();
      architectureSpy.mockRestore();
      adapterSpy.mockRestore();
      completenessSpy.mockRestore();
      registrySpy.mockRestore();
      knowledgeSpy.mockRestore();
      comparisonSpy.mockRestore();
      sessionContextManager.remove(sessionId);
    }
  });
});
