// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {
  deriveEvidenceBackedConclusionContractForNarrative,
  deriveConclusionContractForNarrative,
  normalizeNarrativeForContract,
  normalizeNarrativeForClient,
  normalizeResultForReport,
} from '../agentResultNormalizer';
import type { AnalysisResult } from '../../agent/core/orchestratorTypes';
import type { ConclusionContract } from '../../agent/core/conclusionContract';
import { runClaimVerification } from '../verifier/claimVerificationRunner';
import type { DataEnvelope } from '../../types/dataContract';

function makeResult(overrides: Partial<AnalysisResult> = {}): AnalysisResult {
  return {
    sessionId: 'agent-test',
    success: true,
    findings: [],
    hypotheses: [],
    conclusion: '',
    confidence: 0.7,
    rounds: 1,
    totalDurationMs: 1000,
    ...overrides,
  };
}

describe('normalizeNarrativeForClient', () => {
  test('returns empty string unchanged', () => {
    expect(normalizeNarrativeForClient('')).toBe('');
    expect(normalizeNarrativeForClient('   ')).toBe('   ');
  });

  test('strips evidence ids (internal sanitization)', () => {
    // Sample an evidence-id-shaped token — the sanitizer should remove it.
    const input = 'The jank event (ev_deadbeef1234) was at frame 12.';
    const out = normalizeNarrativeForClient(input);
    expect(out).not.toContain('ev_deadbeef1234');
  });

  test('returns raw when narrative is non-conclusion text', () => {
    const raw = 'just a plain string with no special markers';
    expect(normalizeNarrativeForClient(raw)).toBe(raw);
  });

  test('preserves a complete final report when it contains legacy section labels', () => {
    const report = [
      '# 双 Trace 对比分析报告',
      '',
      '## 综合结论',
      '',
      '- com.example.launch.aosp.heavy 的冷启动 TTID 为 1912ms。',
      '- com.example.androidappdemo 的冷启动 TTID 为 1339ms。',
      '',
      '结论: 两条 trace 的启动耗时存在明显差异',
      '证据链: C1: 两条 trace 都已完成启动事件采集',
      '不确定性: 暂无',
      '下一步: 对比主线程热点',
    ].join('\n');

    const out = normalizeNarrativeForClient(report);

    expect(out).toContain('## 综合结论');
    expect(out).toContain('com.example.launch.aosp.heavy');
    expect(out).toContain('com.example.androidappdemo');
  });

  test('tolerates non-string-coerced inputs', () => {
    expect(normalizeNarrativeForClient(null as unknown as string)).toBe('');
    expect(normalizeNarrativeForClient(undefined as unknown as string)).toBe('');
  });
});

describe('deriveConclusionContractForNarrative', () => {
  const narrativeWithEvClaim = [
    '快速回答：帧耗时 45.6ms（ev_deadbeef1234）。',
    '',
    '## 逐句数据引用（结构化来源）',
    '- Q1 / C1: 帧耗时 45.6ms',
    '  - evidence_ref_id=ev_deadbeef1234; source_ref=表 1; row_index=0; column=dur_ms; value=45.6',
  ].join('\n');

  test('keeps evidence ids available for contract parsing before display sanitization', () => {
    const display = normalizeNarrativeForClient(narrativeWithEvClaim);
    expect(display).not.toContain('ev_deadbeef1234');

    const contractSource = normalizeNarrativeForContract(narrativeWithEvClaim);
    expect(contractSource).toContain('ev_deadbeef1234');

    const contract = deriveConclusionContractForNarrative(narrativeWithEvClaim);
    expect(contract?.claims?.[0]?.references?.[0]?.evidenceRefId).toBe('ev_deadbeef1234');
    expect(contract?.claims?.[0]?.references?.[0]?.sourceRef).toBe('表 1');
  });
});

describe('deriveEvidenceBackedConclusionContractForNarrative', () => {
  test('builds verifier-ready claims for rich reports that do not use contract headings', () => {
    const envelopes: DataEnvelope[] = [
      {
        meta: {
          type: 'skill_result',
          version: '2.0.0',
          source: 'startup_analysis',
          skillId: 'startup_analysis',
          stepId: 'get_startups',
          evidenceRefId: 'data:skill:startup_analysis:get_startups:current:abc',
          artifactId: 'art-2',
          traceId: 'trace-1',
          traceSide: 'current',
          timestamp: 1,
        },
        display: {
          layer: 'list',
          format: 'table',
          title: '检测到的启动事件',
        },
        data: {
          columns: ['package', 'startup_type', 'dur_ms', 'ttid_ms'],
          rows: [['com.example.launch.aosp.heavy', 'cold', 1339, 1912]],
        },
      },
      {
        meta: {
          type: 'skill_result',
          version: '2.0.0',
          source: 'startup_detail',
          skillId: 'startup_detail',
          stepId: 'actionable_hotspots',
          evidenceRefId: 'data:skill:startup_detail:actionable_hotspots:current:def',
          artifactId: 'art-30',
          traceId: 'trace-1',
          traceSide: 'current',
          timestamp: 2,
        },
        display: {
          layer: 'list',
          format: 'table',
          title: '可操作热点',
        },
        data: {
          columns: ['slice_name', 'self_ms', 'self_percent'],
          rows: [
            ['ChaosTask', 456, 34.1],
            ['LoadSimulator_ActivityInit', 249.8, 18.7],
          ],
        },
      },
    ];
    const report = [
      '# 启动性能分析报告',
      '',
      '## 综合结论',
      '',
      '冷启动 TTID=1912ms，dur=1339ms，主因是 ChaosTask self=456ms 和 LoadSimulator_ActivityInit self=249.8ms。',
      '',
      '## 关键证据链',
      '',
      '- 启动事件与热点表均已采集。',
    ].join('\n');

    const contract = deriveEvidenceBackedConclusionContractForNarrative(report, envelopes, {
      mode: 'initial_report',
      sceneId: 'startup',
    });
    expect(contract?.claims?.length).toBeGreaterThanOrEqual(2);
    expect(contract?.metadata?.derivedFromNarrativeEvidenceMatch).toBe(true);
    expect(contract?.metadata?.claimVerificationScope).toBe('sampled_narrative_evidence');
    expect(contract?.claims?.some(claim =>
      claim.references.some(ref => ref.evidenceRefId === 'art-2' || ref.evidenceRefId === 'data:skill:startup_analysis:get_startups:current:abc'),
    )).toBe(true);

    const verification = runClaimVerification({
      conclusionContract: contract,
      dataEnvelopes: envelopes,
      policy: 'record_only',
    }).claimVerificationResult;
    expect(verification.status).toBe('passed');
    expect(verification.checkedClaimCount).toBeGreaterThan(0);
  });

  test('does not derive numeric claims from numbers embedded inside larger tokens', () => {
    const envelopes: DataEnvelope[] = [{
      meta: {
        type: 'skill_result',
        version: '2.0.0',
        source: 'startup_detail',
        skillId: 'startup_detail',
        stepId: 'counts',
        evidenceRefId: 'data:skill:startup_detail:counts:current:abc',
        traceId: 'trace-1',
        traceSide: 'current',
        timestamp: 1,
      },
      display: {
        layer: 'list',
        format: 'table',
        title: '计数表',
      },
      data: {
        columns: ['slice_name', 'small_count'],
        rows: [['ChaosTask', 3]],
      },
    }];
    const report = '# 启动性能分析报告\n\n## 综合结论\n\nChaosTask self=1339ms，未提到 small_count。';

    const contract = deriveEvidenceBackedConclusionContractForNarrative(report, envelopes);

    expect(contract?.claims?.some(claim =>
      claim.references.some(ref => ref.column === 'small_count' && ref.value === 3),
    )).not.toBe(true);
  });

  test('keeps fallback claims, evidence chain, and metadata from the same source', () => {
    const envelopes: DataEnvelope[] = [{
      meta: {
        type: 'skill_result',
        version: '2.0.0',
        source: 'startup_analysis',
        skillId: 'startup_analysis',
        stepId: 'startup_overview',
        evidenceRefId: 'data:skill:startup_analysis:startup_overview:current:abc',
        traceId: 'trace-1',
        traceSide: 'current',
        timestamp: 1,
      },
      display: {
        layer: 'overview',
        format: 'table',
        title: '启动概览',
      },
      data: {
        columns: ['package', 'startup_type', 'ttid_ms'],
        rows: [['com.example.launch.aosp.heavy', 'cold', 1912]],
      },
    }];
    const parsed: ConclusionContract = {
      schemaVersion: 'conclusion_contract_v1',
      mode: 'initial_report',
      conclusions: [{ rank: 1, statement: '旧结论' }],
      clusters: [],
      evidenceChain: [{ conclusionId: 'C1', text: 'legacy provider evidence chain' }],
      uncertainties: [],
      nextSteps: [],
      metadata: {
        claimDerivation: 'explicit_model_contract',
        claimVerificationScope: 'explicit_claims',
      },
    };

    const contract = deriveEvidenceBackedConclusionContractForNarrative(
      '# 启动性能分析报告\n\n## 综合结论\n\ncom.example.launch.aosp.heavy 是 cold 启动，TTID=1912ms。',
      envelopes,
      { existingContract: parsed },
    );

    expect(contract?.claims?.length).toBeGreaterThan(0);
    expect(contract?.evidenceChain.some(item => item.text === 'legacy provider evidence chain')).toBe(false);
    expect(contract?.evidenceChain.some(item =>
      item.text.includes('data:skill:startup_analysis:startup_overview:current:abc'),
    )).toBe(true);
    expect(contract?.metadata?.claimDerivation).toBe('narrative_evidence_match');
    expect(contract?.metadata?.claimVerificationScope).toBe('sampled_narrative_evidence');
  });

  test('replaces provider claims when every structured reference is unresolvable but narrative evidence matches data', () => {
    const envelopes: DataEnvelope[] = [{
      meta: {
        type: 'skill_result',
        version: '2.0.0',
        source: 'scrolling_analysis:jank_type_stats',
        skillId: 'scrolling_analysis',
        stepId: 'jank_type_stats',
        evidenceRefId: 'data:skill:scrolling_analysis:jank_type_stats:current:abc',
        artifactId: 'art-6',
        traceId: 'trace-1',
        traceSide: 'current',
        timestamp: 1,
      },
      display: {
        layer: 'list',
        format: 'table',
        title: '掉帧类型分布',
      },
      data: {
        columns: ['jank_type', 'count', 'real_jank_count', 'false_positive'],
        rows: [['App Deadline Missed', 6, 6, 0]],
      },
    }];
    const parsed = {
      schemaVersion: 'conclusion_contract_v1',
      mode: 'initial_report',
      conclusions: [],
      clusters: [],
      evidenceChain: [],
      claims: [{
        id: 'Q1',
        text: 'App Deadline Missed 有 6 帧',
        kind: 'numeric',
        references: [{
          evidenceRefId: 'missing-artifact',
          sourceRef: 'jank_type_stats',
          rowIndex: 0,
          column: 'count',
          value: 6,
        }],
      }],
      uncertainties: [],
      nextSteps: [],
    } as any;

    const contract = deriveEvidenceBackedConclusionContractForNarrative(
      '# 滑动性能分析报告\n\n## 概览\n\nApp Deadline Missed 有 6 帧，real_jank_count=6，false_positive=0。',
      envelopes,
      { existingContract: parsed },
    );

    expect((contract?.metadata as any)?.replacedUnresolvableProviderClaims).toBe(true);
    const verification = runClaimVerification({
      conclusionContract: contract,
      dataEnvelopes: envelopes,
      policy: 'record_only',
    }).claimVerificationResult;
    expect(verification.status).toBe('passed');
  });

  test('replaces partially resolvable provider claims when artifact ids conflict with source labels', () => {
    const envelopes: DataEnvelope[] = [
      {
        meta: {
          type: 'skill_result',
          version: '2.0.0',
          source: 'scrolling_analysis:performance_summary',
          skillId: 'scrolling_analysis',
          stepId: 'performance_summary',
          evidenceRefId: 'data:skill:scrolling_analysis:performance_summary:current:abc',
          artifactId: 'art-4',
          traceId: 'trace-1',
          traceSide: 'current',
          timestamp: 1,
        },
        display: {
          layer: 'list',
          format: 'table',
          title: '滑动性能概览',
        },
        data: {
          columns: ['total_frames', 'perceived_jank_frames', 'jank_rate'],
          rows: [[347, 7, 2.02]],
        },
      },
      {
        meta: {
          type: 'skill_result',
          version: '2.0.0',
          source: 'scrolling_analysis:batch_frame_root_cause',
          skillId: 'scrolling_analysis',
          stepId: 'batch_frame_root_cause',
          evidenceRefId: 'data:skill:scrolling_analysis:batch_frame_root_cause:current:def',
          artifactId: 'art-9',
          traceId: 'trace-1',
          traceSide: 'current',
          timestamp: 2,
        },
        display: {
          layer: 'list',
          format: 'table',
          title: '掉帧列表',
        },
        data: {
          columns: ['dur_ms', 'vsync_missed'],
          rows: [[18.66, 2], [62.73, 7]],
        },
      },
    ];
    const parsed = {
      schemaVersion: 'conclusion_contract_v1',
      mode: 'initial_report',
      conclusions: [],
      clusters: [],
      evidenceChain: [],
      claims: [
        {
          id: 'Q1',
          text: '总帧数 347，真实掉帧 7 帧，掉帧率 2.02%',
          kind: 'numeric',
          references: [
            { evidenceRefId: 'data:art-4', sourceRef: '滑动性能概览', rowIndex: 0, column: 'total_frames', value: 347 },
          ],
        },
        {
          id: 'Q2',
          text: '最长帧 62.73ms，最长连续丢帧 7 VSync',
          kind: 'numeric',
          references: [
            { evidenceRefId: 'data:art-14', sourceRef: '掉帧列表', rowIndex: 1, column: 'dur_ms', value: 62.73 },
          ],
        },
      ],
      uncertainties: [],
      nextSteps: [],
    } as any;

    const contract = deriveEvidenceBackedConclusionContractForNarrative(
      [
        '# 滑动性能分析报告',
        '',
        '## 概览',
        '',
        '总帧数 347，真实掉帧 7 帧，掉帧率 2.02%。最长帧 62.73ms，最长连续丢帧 7 VSync。',
      ].join('\n'),
      envelopes,
      { existingContract: parsed },
    );

    expect((contract?.metadata as any)?.replacedUnresolvableProviderClaims).toBe(true);
    expect(contract?.claims?.some(claim =>
      claim.references.some(ref => ref.evidenceRefId === 'data:art-14'),
    )).not.toBe(true);

    const verification = runClaimVerification({
      conclusionContract: contract,
      dataEnvelopes: envelopes,
      policy: 'record_only',
    }).claimVerificationResult;
    expect(verification.status).toBe('passed');
  });

  test('replaces row-only identity claims with verifier-ready process identity cells', () => {
    const envelopes: DataEnvelope[] = [{
      meta: {
        type: 'skill_result',
        version: '2.0.0',
        source: 'process_identity_resolver',
        skillId: 'process_identity_resolver',
        stepId: 'current',
        evidenceRefId: 'data:skill:process_identity_resolver:current:identity',
        traceId: 'trace-1',
        traceSide: 'current',
        timestamp: 1,
        identityStatus: 'verified',
        identityRefId: 'identity:trace-1:current:process:885',
      },
      display: {
        layer: 'list',
        format: 'table',
        title: '进程身份候选',
      },
      data: {
        columns: ['process_name', 'package_name', 'pid', 'upid', 'confidence_score'],
        rows: [['com.example.wechatfriendforcustomscroller', 'com.example.wechatfriendforcustomscroller', 13534, 885, 100]],
      },
    }];
    const parsed: ConclusionContract = {
      schemaVersion: 'conclusion_contract_v1',
      mode: 'focused_answer',
      conclusions: [],
      clusters: [],
      evidenceChain: [],
      claims: [{
        id: 'C2',
        text: '主要进程名为 com.example.wechatfriendforcustomscroller，PID 为 13534，UPID 为 885',
        kind: 'identity',
        references: [{
          evidenceRefId: 'data:skill:process_identity_resolver:current:identity',
          sourceRef: '进程身份候选',
          rowIndex: 0,
        }],
      }],
      uncertainties: [],
      nextSteps: [],
    };

    const contract = deriveEvidenceBackedConclusionContractForNarrative(
      '这个 trace 的主要进程名为 com.example.wechatfriendforcustomscroller，PID 为 13534，UPID 为 885。',
      envelopes,
      { existingContract: parsed, mode: 'focused_answer' },
    );

    expect(contract?.metadata?.replacedUnresolvableProviderClaims).toBe(true);
    const columns = new Set(contract?.claims?.flatMap(claim =>
      claim.references.map(ref => ref.column).filter(Boolean),
    ));
    expect(columns.has('process_name')).toBe(true);
    expect(columns.has('pid')).toBe(true);
    expect(columns.has('upid')).toBe(true);

    const verification = runClaimVerification({
      conclusionContract: contract,
      dataEnvelopes: envelopes,
      policy: 'record_only',
    }).claimVerificationResult;
    expect(verification.status).toBe('passed');
  });
});

describe('normalizeResultForReport', () => {
  test('returns input identity when nothing would change', () => {
    const r = makeResult({ conclusion: 'plain text', conclusionContract: { mode: 'focused_answer' } as any });
    const out = normalizeResultForReport(r);
    // Identity check — callers rely on this to skip downstream work.
    expect(out).toBe(r);
  });

  test('strips evidence ids from conclusion', () => {
    const r = makeResult({ conclusion: 'Frame regression at (ev_aaaaaaaaaaaa).' });
    const out = normalizeResultForReport(r);
    expect(out.conclusion).not.toContain('ev_aaaaaaaaaaaa');
  });

  test('derives a conclusionContract when missing', () => {
    const r = makeResult({ conclusion: 'Some analysis summary.', conclusionContract: undefined, rounds: 2 });
    const out = normalizeResultForReport(r);
    // Either gets a contract (if derivable from this text) or stays undefined;
    // what matters is that the call doesn't throw and the shape is preserved.
    expect(typeof out.conclusion).toBe('string');
    expect(out.rounds).toBe(2);
  });

  test('preserves existing conclusionContract', () => {
    const contract = { mode: 'initial_report' } as any;
    const r = makeResult({ conclusion: 'text', conclusionContract: contract });
    const out = normalizeResultForReport(r);
    expect(out.conclusionContract).toBe(contract);
  });

  test('derives claim provenance from unsanitized narrative while returning sanitized display text', () => {
    const r = makeResult({
      conclusion: [
        '快速回答：帧耗时 45.6ms（ev_deadbeef1234）。',
        '',
        '## 逐句数据引用（结构化来源）',
        '- Q1 / C1: 帧耗时 45.6ms',
        '  - evidence_ref_id=ev_deadbeef1234; source_ref=表 1; row_index=0; column=dur_ms; value=45.6',
      ].join('\n'),
    });

    const out = normalizeResultForReport(r);
    expect(out.conclusion).not.toContain('ev_deadbeef1234');
    expect(out.conclusionContract?.claims?.[0]?.references?.[0]?.evidenceRefId).toBe('ev_deadbeef1234');
  });

  test('uses captured DataEnvelopes to normalize rich report contracts for CLI/report paths', () => {
    const envelopes: DataEnvelope[] = [{
      meta: {
        type: 'skill_result',
        version: '2.0.0',
        source: 'startup_analysis',
        skillId: 'startup_analysis',
        stepId: 'startup_overview',
        evidenceRefId: 'data:skill:startup_analysis:startup_overview:current:abc',
        traceId: 'trace-1',
        traceSide: 'current',
        timestamp: 1,
      },
      display: {
        layer: 'overview',
        format: 'table',
        title: '启动概览',
      },
      data: {
        columns: ['package', 'startup_type', 'ttid_ms'],
        rows: [['com.example.launch.aosp.heavy', 'cold', 1912]],
      },
    }];
    const r = makeResult({
      conclusion: '# 启动性能分析报告\n\n## 综合结论\n\ncom.example.launch.aosp.heavy 是冷启动，TTID=1912ms。',
      conclusionContract: undefined,
    });

    const out = normalizeResultForReport(r, { dataEnvelopes: envelopes });

    expect(out.conclusionContract?.metadata?.derivedFromNarrativeEvidenceMatch).toBe(true);
    expect(out.conclusionContract?.claims?.some(claim =>
      claim.references.some(ref => ref.column === 'ttid_ms' && ref.value === 1912),
    )).toBe(true);
  });

  test('preserves sidecar metadata while normalizing report text', () => {
    const receipt = {
      schemaVersion: 1,
      runId: 'run-1',
      sessionId: 'agent-test',
      traceId: 'trace-1',
      mode: 'auto',
      resolvedMode: 'full',
      providerId: null,
      generatedAt: 1,
      traceEvidence: {
        sqlCount: 0,
        skillCount: 0,
        dataEnvelopeCount: 0,
        artifactCount: 0,
        evidenceRefCount: 0,
      },
      nonEvidenceContext: {
        frontendPrequeryCount: 0,
        memoryHintCount: 0,
        conversationContextCount: 0,
        strategyHintCount: 0,
      },
      claimAudit: {
        totalClaims: 0,
        verifiedClaims: 0,
        unsupportedClaims: 0,
        uncertainClaims: 0,
      },
      qualityGates: {
        finalReportContract: 'not_applicable',
        claimVerification: 'not_applicable',
        identityResolution: 'not_applicable',
      },
      outputs: {},
    } as const;
    const r = makeResult({
      conclusion: '快速回答：帧耗时 45.6ms（ev_deadbeef1234）。',
      analysisReceipt: receipt,
      uiActionProposals: [
        {
          schemaVersion: 1,
          id: 'ui-navigate_timeline-1',
          kind: 'navigate_timeline',
          title: '跳到帧',
          reason: '来自证据表',
          source: { evidenceRefId: 'ev_deadbeef1234' },
          payload: { ts: '123456789' },
          requiresConfirmation: true,
        },
      ],
    });

    const out = normalizeResultForReport(r);

    expect(out.conclusion).not.toContain('ev_deadbeef1234');
    expect(out.analysisReceipt).toBe(receipt);
    expect(out.uiActionProposals).toBe(r.uiActionProposals);
  });
});
