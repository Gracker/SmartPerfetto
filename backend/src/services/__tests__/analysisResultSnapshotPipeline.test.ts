// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'fs';
import os from 'os';
import path from 'path';
import type { DataEnvelope } from '../../types/dataContract';
import {
  buildCompletedAnalysisResultSnapshot,
  persistCompletedAnalysisResultSnapshot,
  resolveAnalysisResultSceneType,
} from '../analysisResultSnapshotPipeline';
import { ENTERPRISE_DB_PATH_ENV, openEnterpriseDb } from '../enterpriseDb';
import {clearCodeAwareOutputGuards, registerCodeAwareCanary} from '../security/codeAwareOutputRegistry';
import type {CapabilityManifestAttributionV1} from '../../types/capabilityManifest';
import {createClaudeMcpServer} from '../../agentv3/claudeMcpServer';
import {finalizeSourceAwareAnalysisResult} from '../codebase/sourceClaimVerifier';
import {sanitizeSourceReference} from '../codebase/sourceUseDecision';
import {
  createRuntimeSourceFinalizationFixture,
  createSourceAuthoredAnalysisResult,
  SOURCE_FINALIZATION_CANARY,
} from '../../agentRuntime/__tests__/sourceFinalizationFixture';

const originalDbPath = process.env[ENTERPRISE_DB_PATH_ENV];
const tmpDirs: string[] = [];

function useTempEnterpriseDb(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-snapshot-pipeline-'));
  tmpDirs.push(tmpDir);
  const dbPath = path.join(tmpDir, 'enterprise.sqlite');
  process.env[ENTERPRISE_DB_PATH_ENV] = dbPath;
  return dbPath;
}

afterEach(() => {
  if (originalDbPath === undefined) {
    delete process.env[ENTERPRISE_DB_PATH_ENV];
  } else {
    process.env[ENTERPRISE_DB_PATH_ENV] = originalDbPath;
  }
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

function envelope(): DataEnvelope {
  return {
    meta: {
      type: 'skill_result',
      version: '2.0.0',
      source: 'startup_analysis',
      skillId: 'startup_analysis',
      stepId: 'summary',
      timestamp: 123,
    },
    data: { rows: [] },
    display: {
      layer: 'overview',
      format: 'table',
      title: 'Startup summary',
    },
  };
}

const receiptCapabilityManifest: CapabilityManifestAttributionV1 = {
  schemaVersion: 'capability_manifest_attribution@1',
  resolution: {
    status: 'ready',
    manifestId: `capability_manifest:${'a'.repeat(64)}`,
    contentHash: 'a'.repeat(64),
    manifestSchemaVersion: 'capability_manifest@1',
    traceFingerprintSha256: 'b'.repeat(64),
    traceProcessor: {source: 'bundled', gitRevision: 'c'.repeat(40)},
  },
  probeCache: {hits: 2, misses: 1, bypasses: 0},
};

describe('analysis result snapshot pipeline', () => {
  test('resolves a canonical scene before private query projection', () => {
    expect(resolveAnalysisResultSceneType('分析点击响应性能')).toBe('interaction');
    expect(resolveAnalysisResultSceneType(
      'Private source or knowledge analysis request (original content not persisted)',
    )).toBe('general');
  });

  test('builds a partial snapshot from completed run metadata', () => {
    const capabilityCanary = '/private/SNAPSHOT_RECEIPT_CAPABILITY_CANARY';
    const traceSummaryCanary = '/private/SNAPSHOT_TRACE_SUMMARY_CANARY';
    const traceSummary = {
      schemaVersion: 'trace_summary_attribution@1' as const, status: 'ready' as const,
      specId: 'smartperfetto.core.v1', specDigestSha256: '1'.repeat(64),
      traceFingerprintSha256: '2'.repeat(64),
      traceProcessor: {source: 'custom' as const, binarySha256: '3'.repeat(64)},
      resultDigestSha256: '4'.repeat(64),
      availableMetricIds: ['metric_a'], missingMetricIds: [],
    };
    const snapshot = buildCompletedAnalysisResultSnapshot({
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
      userId: 'user-a',
      traceId: 'trace-a',
      sessionId: 'session-a',
      runId: 'run-a',
      reportId: 'report-a',
      query: '分析启动速度',
      conclusion: '启动耗时偏高。\n需要继续看主线程。',
      conclusionContract: {
        claims: [{
          id: 'Q1',
          text: '启动耗时偏高',
          references: [{ evidenceRefId: 'data:startup:summary:123', sourceRef: '表 1' }],
        }],
      },
      confidence: 0.7,
      dataEnvelopes: [envelope()],
      uiActionProposals: [{
        schemaVersion: 1,
        id: 'ui-navigate_timeline-1',
        kind: 'navigate_timeline',
        title: '跳到启动',
        reason: '来自启动证据',
        source: { evidenceRefId: 'data:startup:summary:123' },
        payload: { ts: '123456789' },
        requiresConfirmation: true,
      }],
      analysisReceipt: {
        schemaVersion: 1,
        runId: 'run-a',
        sessionId: 'session-a',
        traceId: 'trace-a',
        mode: 'auto',
        resolvedMode: 'full',
        providerId: null,
        generatedAt: 1234,
        traceEvidence: {
          sqlCount: 1,
          skillCount: 0,
          dataEnvelopeCount: 1,
          artifactCount: 1,
          evidenceRefCount: 1,
        },
        nonEvidenceContext: {
          frontendPrequeryCount: 0,
          memoryHintCount: 0,
          conversationContextCount: 0,
          strategyHintCount: 0,
        },
        claimAudit: {
          totalClaims: 1,
          verifiedClaims: 1,
          unsupportedClaims: 0,
          uncertainClaims: 0,
        },
        qualityGates: {
          finalReportContract: 'passed',
          claimVerification: 'not_applicable',
          identityResolution: 'not_applicable',
        },
        outputs: {
          reportId: 'report-a',
        },
        capabilityManifest: {
          ...receiptCapabilityManifest,
          localPath: capabilityCanary,
          resolution: {
            ...receiptCapabilityManifest.resolution,
            localPath: capabilityCanary,
          },
        } as any,
        traceSummary: {
          ...traceSummary,
          localPath: traceSummaryCanary,
          traceProcessor: {...traceSummary.traceProcessor, localPath: traceSummaryCanary},
        } as any,
      },
      createdAt: 1234,
    });

    expect(snapshot).toEqual(expect.objectContaining({
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
      traceId: 'trace-a',
      sessionId: 'session-a',
      runId: 'run-a',
      reportId: 'report-a',
      createdBy: 'user-a',
      sceneType: 'startup',
      visibility: 'private',
      status: 'partial',
      createdAt: 1234,
    }));
    expect(snapshot?.summary).toEqual(expect.objectContaining({
      headline: '启动耗时偏高。',
      confidence: 0.7,
      partialReasons: expect.arrayContaining(['No normalized comparison metrics extracted yet']),
      analysisReceipt: expect.objectContaining({
        schemaVersion: 1,
        runId: 'run-a',
        traceId: 'trace-a',
      }),
      uiActionProposals: [expect.objectContaining({
        id: 'ui-navigate_timeline-1',
        kind: 'navigate_timeline',
      })],
    }));
    expect(snapshot?.conclusionContract).toEqual(expect.objectContaining({
      claims: [expect.objectContaining({ id: 'Q1' })],
    }));
    expect(snapshot?.capabilityManifest).toEqual(receiptCapabilityManifest);
    expect(snapshot?.summary.analysisReceipt?.capabilityManifest).toEqual(
      receiptCapabilityManifest,
    );
    expect(snapshot?.summary.traceSummary).toEqual(traceSummary);
    expect(snapshot?.summary.analysisReceipt?.traceSummary).toEqual(traceSummary);
    expect(JSON.stringify(snapshot)).not.toContain(capabilityCanary);
    expect(JSON.stringify(snapshot)).not.toContain(traceSummaryCanary);
    expect(snapshot?.metrics).toEqual([]);
    expect(snapshot?.evidenceRefs).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'report:report-a', type: 'report' }),
      expect.objectContaining({ type: 'data_envelope', label: 'Startup summary' }),
    ]));
  });

  test('prefers explicit capability attribution over receipt attribution', () => {
    const explicit: CapabilityManifestAttributionV1 = {
      schemaVersion: 'capability_manifest_attribution@1',
      resolution: {status: 'failed', reason: 'capability_manifest_build_failed'},
      probeCache: {hits: 0, misses: 0, bypasses: 1},
    };
    const snapshot = buildCompletedAnalysisResultSnapshot({
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
      traceId: 'trace-a',
      sessionId: 'session-a',
      runId: 'run-a',
      query: 'analyze',
      capabilityManifest: explicit,
      analysisReceipt: {
        schemaVersion: 2,
        runManifestId: 'manifest-run',
        runId: 'run-a',
        sessionId: 'session-a',
        traceId: 'trace-a',
        mode: 'auto',
        resolvedMode: 'full',
        providerId: null,
        generatedAt: 1,
        traceEvidence: {sqlCount: 0, skillCount: 0, dataEnvelopeCount: 0, artifactCount: 0, evidenceRefCount: 0},
        nonEvidenceContext: {frontendPrequeryCount: 0, memoryHintCount: 0, conversationContextCount: 0, strategyHintCount: 0},
        claimAudit: {totalClaims: 0, verifiedClaims: 0, unsupportedClaims: 0, uncertainClaims: 0},
        qualityGates: {finalReportContract: 'not_applicable', claimVerification: 'not_applicable', identityResolution: 'not_applicable'},
        outputs: {},
        capabilityManifest: receiptCapabilityManifest,
      },
      createdAt: 1234,
    });

    expect(snapshot?.capabilityManifest).toEqual(explicit);
  });

  test('returns null when tenant, workspace, or run metadata is missing', () => {
    expect(buildCompletedAnalysisResultSnapshot({
      traceId: 'trace-a',
      sessionId: 'session-a',
      query: 'analyze',
    })).toBeNull();
  });

  test('extracts startup metrics from structured DataEnvelope rows', () => {
    const snapshot = buildCompletedAnalysisResultSnapshot({
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
      traceId: 'trace-a',
      sessionId: 'session-a',
      runId: 'run-a',
      query: 'startup analysis',
      dataEnvelopes: [{
        ...envelope(),
        data: {
          columns: ['startup_id', 'total_ms', 'first_frame_ms'],
          rows: [[1, 1450.5, 620]],
        },
      }],
      createdAt: 1234,
    });

    expect(snapshot?.status).toBe('ready');
    expect(snapshot?.metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: 'startup.total_ms',
        value: 1450.5,
        unit: 'ms',
        source: expect.objectContaining({ skillId: 'startup_analysis' }),
      }),
      expect.objectContaining({
        key: 'startup.first_frame_ms',
        value: 620,
      }),
    ]));
    expect(snapshot?.summary.partialReasons).toBeUndefined();
  });

  test('preserves runtime partial warning even when startup metrics are present', () => {
    const message = '最终结果质量闸门发现 provider 没有产出可独立交付的完整结论';
    const snapshot = buildCompletedAnalysisResultSnapshot({
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
      traceId: 'trace-a',
      sessionId: 'session-a',
      runId: 'run-a',
      query: 'startup analysis',
      conclusion: '启动结论降级。',
      partial: true,
      terminationMessage: message,
      dataEnvelopes: [{
        ...envelope(),
        data: {
          columns: ['startup_id', 'total_ms', 'first_frame_ms'],
          rows: [[1, 1450.5, 620]],
        },
      }],
      createdAt: 1234,
    });

    expect(snapshot?.status).toBe('partial');
    expect(snapshot?.summary.partialReasons).toEqual([message]);
    expect(snapshot?.metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'startup.total_ms', value: 1450.5 }),
    ]));
  });

  test('extracts scrolling metrics and normalizes fractional jank rate to percent', () => {
    const snapshot = buildCompletedAnalysisResultSnapshot({
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
      traceId: 'trace-a',
      sessionId: 'session-a',
      runId: 'run-a',
      query: '对比 FPS 和 jank',
      dataEnvelopes: [{
        ...envelope(),
        meta: {
          ...envelope().meta,
          source: 'scrolling_analysis',
          skillId: 'scrolling_analysis',
          stepId: 'session_jank',
        },
        display: {
          ...envelope().display,
          title: 'Scrolling summary',
        },
        data: {
          rows: [{
            avg_fps: '58.5',
            frame_count: 240,
            jank_count: 12,
            jank_rate: 0.05,
            p95_frame_ms: 28,
          }],
        } as any,
      }],
      createdAt: 1234,
    });

    expect(snapshot?.sceneType).toBe('scrolling');
    expect(snapshot?.metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'scrolling.avg_fps', value: 58.5, unit: 'fps' }),
      expect.objectContaining({ key: 'scrolling.jank_rate_pct', value: 5, unit: '%' }),
      expect.objectContaining({ key: 'scrolling.p95_frame_ms', value: 28, unit: 'ms' }),
    ]));
  });

  test('uses stable DataEnvelope evidence refs without collapsing SQL comparison tables', () => {
    const currentSql = {
      ...envelope(),
      meta: {
        type: 'sql_result' as const,
        version: '2.0.0',
        source: 'execute_sql',
        timestamp: 0,
        evidenceRefId: 'data:sql:current:trace-a:q1',
        traceSide: 'current' as const,
        paneSide: 'left' as const,
        traceId: 'trace-a',
        queryHash: 'q1',
        sourceToolCallId: 'execute_sql_on:1:params_hash:current',
        paramsHash: 'params_hash',
        planPhaseId: 'phase-compare',
        planPhaseTitle: 'Compare FPS',
        planPhaseGoal: 'Query current and reference FPS',
        toolNarration: '执行对比 SQL：查询当前 Trace 帧率',
        producerReason: '验证当前 Trace FPS 基线',
      },
      data: {
        columns: ['avg_fps'],
        rows: [[58]],
      },
      display: {
        layer: 'list' as const,
        format: 'table' as const,
        title: 'SQL Query current',
      },
    };
    const referenceSql = {
      ...currentSql,
      meta: {
        ...currentSql.meta,
        evidenceRefId: 'data:sql:reference:trace-b:q1',
        traceSide: 'reference' as const,
        paneSide: 'right' as const,
        traceId: 'trace-b',
        sourceToolCallId: 'execute_sql_on:2:params_hash:reference',
        toolNarration: '执行对比 SQL：查询参考 Trace 帧率',
        producerReason: '验证参考 Trace FPS 基线',
      },
      display: {
        ...currentSql.display,
        title: 'SQL Query reference',
      },
    };

    const snapshot = buildCompletedAnalysisResultSnapshot({
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
      traceId: 'trace-a',
      sessionId: 'session-a',
      runId: 'run-a',
      query: 'compare fps',
      dataEnvelopes: [currentSql, referenceSql],
      createdAt: 1234,
    });

    const dataRefs = snapshot?.evidenceRefs.filter(ref => ref.type === 'data_envelope');
    expect(dataRefs?.map(ref => ref.id)).toEqual([
      'data:sql:current:trace-a:q1',
      'data:sql:reference:trace-b:q1',
    ]);
    expect(dataRefs?.[0].metadata).toEqual(expect.objectContaining({
      traceSide: 'current',
      paneSide: 'left',
      traceId: 'trace-a',
      queryHash: 'q1',
      sourceToolCallId: 'execute_sql_on:1:params_hash:current',
      paramsHash: 'params_hash',
      planPhaseId: 'phase-compare',
      planPhaseTitle: 'Compare FPS',
      planPhaseGoal: 'Query current and reference FPS',
      toolNarration: '执行对比 SQL：查询当前 Trace 帧率',
      producerReason: '验证当前 Trace FPS 基线',
    }));
    expect(dataRefs?.[1].metadata).toEqual(expect.objectContaining({
      traceSide: 'reference',
      paneSide: 'right',
      traceId: 'trace-b',
      queryHash: 'q1',
      sourceToolCallId: 'execute_sql_on:2:params_hash:reference',
      paramsHash: 'params_hash',
      planPhaseId: 'phase-compare',
      planPhaseTitle: 'Compare FPS',
      planPhaseGoal: 'Query current and reference FPS',
      toolNarration: '执行对比 SQL：查询参考 Trace 帧率',
      producerReason: '验证参考 Trace FPS 基线',
    }));
  });

  test('keeps duplicate evidence refs separate when tool call ids differ', () => {
    const first = {
      ...envelope(),
      meta: {
        ...envelope().meta,
        evidenceRefId: 'data:sql:duplicate',
        sourceToolCallId: 'execute_sql:1:params',
        timestamp: 1,
      },
      display: {
        ...envelope().display,
        title: 'Duplicate table 1',
      },
      data: {
        columns: ['value'],
        rows: [[1]],
      },
    };
    const second = {
      ...first,
      meta: {
        ...first.meta,
        sourceToolCallId: 'execute_sql:2:params',
        timestamp: 2,
      },
      display: {
        ...first.display,
        title: 'Duplicate table 2',
      },
      data: {
        columns: ['value'],
        rows: [[2]],
      },
    };

    const snapshot = buildCompletedAnalysisResultSnapshot({
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
      traceId: 'trace-a',
      sessionId: 'session-a',
      runId: 'run-a',
      query: 'duplicate evidence refs',
      dataEnvelopes: [first, second],
      conclusionContract: {
        claims: [{
          id: 'Q1',
          text: '第二个表的值为 2',
          references: [{
            evidence_ref_id: 'data:sql:duplicate',
            source_tool_call_id: 'execute_sql:2:params',
            row_index: 0,
            column: 'value',
            value: 2,
          }],
        }],
      },
      createdAt: 1234,
    });

    const dataRefs = snapshot?.evidenceRefs.filter(ref => ref.type === 'data_envelope') || [];
    expect(dataRefs.map(ref => ref.id)).toEqual([
      'data:sql:duplicate:tool:execute_sql:1:params',
      'data:sql:duplicate:tool:execute_sql:2:params',
    ]);
    expect(dataRefs.map(ref => ref.metadata?.sourceToolCallId)).toEqual([
      'execute_sql:1:params',
      'execute_sql:2:params',
    ]);
  });

  test('keeps claim-referenced DataEnvelope evidence refs beyond the snapshot list cap', () => {
    const dataEnvelopes = Array.from({ length: 105 }, (_, index): DataEnvelope => ({
      ...envelope(),
      meta: {
        ...envelope().meta,
        evidenceRefId: `data:sql:${index + 1}`,
        sourceToolCallId: `execute_sql:${index + 1}:params`,
        timestamp: index + 1,
      },
      display: {
        ...envelope().display,
        title: `SQL table ${index + 1}`,
      },
      data: {
        columns: ['idx', 'value'],
        rows: [[index + 1, index + 1]],
      },
    }));

    const snapshot = buildCompletedAnalysisResultSnapshot({
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
      traceId: 'trace-a',
      sessionId: 'session-a',
      runId: 'run-a',
      query: 'long evidence run',
      dataEnvelopes,
      conclusionContract: {
        claims: [{
          id: 'Q1',
          text: '第 105 个表的值为 105',
          references: [{
            evidence_ref_id: 'data:sql:105',
            source_tool_call_id: 'execute_sql:105:params',
            source_ref: '表 105',
            row_index: 0,
            column: 'value',
            value: 105,
          }],
        }],
      },
      createdAt: 1234,
    });

    const dataRefs = snapshot?.evidenceRefs.filter(ref => ref.type === 'data_envelope') || [];
    expect(dataRefs).toHaveLength(101);
    expect(dataRefs.map(ref => ref.id)).toContain('data:sql:100');
    expect(dataRefs.map(ref => ref.id)).not.toContain('data:sql:101');
    expect(dataRefs.map(ref => ref.id)).toContain('data:sql:105');
    expect(dataRefs.find(ref => ref.id === 'data:sql:105')).toEqual(expect.objectContaining({
      label: 'SQL table 105',
      metadata: expect.objectContaining({
        evidenceRefId: 'data:sql:105',
        sourceToolCallId: 'execute_sql:105:params',
      }),
    }));
  });

  test('keeps source_ref-only claim tables beyond the snapshot list cap', () => {
    const dataEnvelopes = Array.from({ length: 105 }, (_, index): DataEnvelope => ({
      ...envelope(),
      meta: {
        ...envelope().meta,
        evidenceRefId: `data:sql:${index + 1}`,
        sourceToolCallId: `execute_sql:${index + 1}:params`,
        timestamp: index + 1,
      },
      display: {
        ...envelope().display,
        title: `SQL table ${index + 1}`,
      },
      data: {
        columns: ['idx', 'value'],
        rows: [[index + 1, index + 1]],
      },
    }));

    const snapshot = buildCompletedAnalysisResultSnapshot({
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
      traceId: 'trace-a',
      sessionId: 'session-a',
      runId: 'run-a',
      query: 'long source_ref-only run',
      dataEnvelopes,
      conclusionContract: {
        claims: [{
          id: 'Q1',
          text: '第 105 个表的值为 105',
          references: [{
            source_ref: '表 105',
            row_index: 0,
            column: 'value',
            value: 105,
          }],
        }],
      },
      createdAt: 1234,
    });

    const dataRefs = snapshot?.evidenceRefs.filter(ref => ref.type === 'data_envelope') || [];
    expect(dataRefs.map(ref => ref.id)).toContain('data:sql:105');
    expect(dataRefs.find(ref => ref.id === 'data:sql:105')).toEqual(expect.objectContaining({
      label: 'SQL table 105',
    }));
  });

  test('persists snapshot when the parent run graph does not exist yet', () => {
    useTempEnterpriseDb();

    const snapshot = persistCompletedAnalysisResultSnapshot({
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
      userId: 'user-a',
      traceId: 'trace-a',
      sessionId: 'session-a',
      runId: 'run-a',
      query: '分析滑动性能',
      conclusion: '滑动整体稳定。',
      dataEnvelopes: [{
        ...envelope(),
        meta: {
          ...envelope().meta,
          source: 'scrolling_analysis',
          skillId: 'scrolling_analysis',
        },
        data: {
          rows: [{
            avg_fps: 60,
            jank_count: 0,
          }],
        } as any,
      }],
      createdAt: 1778937300000,
    });

    expect(snapshot).toEqual(expect.objectContaining({
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
      traceId: 'trace-a',
      sessionId: 'session-a',
      runId: 'run-a',
      status: 'ready',
    }));

    const db = openEnterpriseDb();
    try {
      const row = db.prepare(`
        SELECT s.id AS snapshot_id, r.id AS run_id, t.id AS trace_id
        FROM analysis_result_snapshots s
        JOIN analysis_runs r
          ON r.tenant_id = s.tenant_id
          AND r.workspace_id = s.workspace_id
          AND r.id = s.run_id
        JOIN trace_assets t
          ON t.tenant_id = s.tenant_id
          AND t.workspace_id = s.workspace_id
          AND t.id = s.trace_id
        WHERE s.id = ?
      `).get(snapshot!.id) as { snapshot_id: string; run_id: string; trace_id: string } | undefined;
      expect(row).toEqual({
        snapshot_id: snapshot!.id,
        run_id: 'run-a',
        trace_id: 'trace-a',
      });
    } finally {
      db.close();
    }
  });

  test('persists only the projected private snapshot graph', () => {
    useTempEnterpriseDb();
    const sessionId = 'session-private-snapshot';
    const canary = 'PRIVATE_SNAPSHOT_DB_CANARY';
    const canaryCodebaseId = `private-${canary}`;
    const rawRoot = `/private/root/${canary}`;
    const rawSnippet = `private source snippet ${canary}`;
    registerCodeAwareCanary(sessionId, canary);
    try {
      const snapshot = persistCompletedAnalysisResultSnapshot({
        tenantId: 'tenant-private',
        workspaceId: 'workspace-private',
        userId: 'user-private',
        traceId: 'trace-private',
        sessionId,
        runId: 'run-private',
        query: `query ${canary}`,
        traceLabel: `label ${canary}`,
        conclusion: `conclusion ${canary}`,
        conclusionContract: {
          schemaVersion: 'conclusion_contract_v1',
          mode: 'focused_answer',
          conclusions: [{rank: 1, statement: `trace conclusion ${canary}`}],
          clusters: [],
          evidenceChain: [],
          claims: [{id: 'claim-private', text: `trace claim ${canary}`, references: []}],
          uncertainties: [],
          nextSteps: [],
        },
        sourceUseDecision: {
          schemaVersion: 'source_use_decision@1',
          codeAwareMode: 'provider_send',
          selectedCodebaseIds: ['app-safe', canaryCodebaseId],
          status: 'located',
          attemptedTools: ['read_codebase_file', `tool-${canary}`],
          queriedCodebaseIds: ['app-safe', canaryCodebaseId],
          usedCodebaseIds: ['app-safe', canaryCodebaseId],
          references: [{
            id: 'model-safe-id',
            referenceId: 'lookup-safe',
            codebaseId: 'app-safe',
            filePath: 'src/Safe.kt',
            lookupKind: 'body',
          }, {
            id: `model-${canary}`,
            referenceId: `lookup-${canary}`,
            codebaseId: canaryCodebaseId,
            filePath: `src/${canary}.kt`,
            sourceGeneration: `generation-${canary}`,
            lookupKind: 'body',
            rootPath: rawRoot,
            snippet: rawSnippet,
          } as any],
        },
        claimSupport: [{claimId: canary}] as any,
        claimVerificationResult: {
          schemaVersion: 'claim_verifier@1',
          status: 'passed',
          policy: 'record_only',
          passed: true,
          checkedClaimCount: 1,
          unsupportedClaimCount: 0,
          claimResults: [{
            claimId: 'claim-private',
            status: 'verified',
            referenceResults: [],
          }],
          issues: [{message: canary}],
        } as any,
        identityResolutions: [{identityRefId: canary}] as any,
        dataEnvelopes: [{
          ...envelope(),
          sql: `SELECT '${canary}'`,
          meta: {
            ...envelope().meta,
            source: canary,
            skillId: canary,
            stepId: canary,
            intent: canary,
          },
          data: {columns: ['leak'], rows: [[canary]], executableSql: `SELECT '${canary}'`},
          display: {...envelope().display, title: `Title ${canary}`},
        } as any],
        terminationMessage: canary,
        analysisReceipt: {
          schemaVersion: 1,
          runId: 'run-private',
          sessionId,
          traceId: 'trace-private',
          mode: 'full',
          resolvedMode: 'full',
          providerId: null,
          generatedAt: 1,
          traceEvidence: {sqlCount: 0, skillCount: 0, dataEnvelopeCount: 0, artifactCount: 0, evidenceRefCount: 0},
          nonEvidenceContext: {frontendPrequeryCount: 0, memoryHintCount: 0, conversationContextCount: 0, strategyHintCount: 0},
          claimAudit: {totalClaims: 0, verifiedClaims: 0, unsupportedClaims: 0, uncertainClaims: 0},
          qualityGates: {finalReportContract: 'passed', claimVerification: 'passed', identityResolution: 'passed'},
          outputs: {reportError: canary, cliTurnPath: `/tmp/${canary}`},
          capabilityManifest: {
            ...receiptCapabilityManifest,
            localPath: canary,
            resolution: {
              ...receiptCapabilityManifest.resolution,
              localPath: canary,
              traceProcessor: {
                ...(receiptCapabilityManifest.resolution.status === 'ready'
                  ? receiptCapabilityManifest.resolution.traceProcessor
                  : {}),
                localPath: canary,
              },
            },
            probeCache: {...receiptCapabilityManifest.probeCache, cachePath: canary},
          } as any,
        },
        uiActionProposals: [{title: canary}] as any,
        privateKnowledge: true,
        outputLanguage: 'en',
        sceneType: 'startup',
      });

      expect(snapshot).not.toBeNull();
      expect(JSON.stringify(snapshot)).not.toContain(canary);
      expect(snapshot?.userQuery).toBe(
        'Private source or knowledge analysis request (original content not persisted)',
      );
      expect(snapshot?.traceLabel).toBe('trace-private');
      expect(snapshot?.sceneType).toBe('startup');
      expect(snapshot?.capabilityManifest).toEqual(receiptCapabilityManifest);
      expect(snapshot?.summary.analysisReceipt?.capabilityManifest).toEqual(receiptCapabilityManifest);
      expect(snapshot?.summary.analysisReceipt?.outputs).toEqual({});
      const storedSourceDecision = (snapshot?.conclusionContract as any)?.sourceUseDecision;
      expect(storedSourceDecision).toEqual(expect.objectContaining({
        schemaVersion: 'source_use_decision@1',
        selectedCodebaseIds: ['app-safe'],
        queriedCodebaseIds: ['app-safe'],
        usedCodebaseIds: ['app-safe'],
        references: [expect.objectContaining({
          codebaseId: 'app-safe',
          filePath: 'src/Safe.kt',
          referenceId: 'lookup-safe',
        })],
      }));
      expect(storedSourceDecision.references[0]).not.toHaveProperty('rootPath');
      expect(storedSourceDecision.references[0]).not.toHaveProperty('snippet');
      expect(JSON.stringify(storedSourceDecision)).not.toContain(rawRoot);
      expect(JSON.stringify(storedSourceDecision)).not.toContain(rawSnippet);

      const db = openEnterpriseDb();
      try {
        const rows = db.prepare(`
          SELECT user_query, trace_label, summary_json, conclusion_contract_json,
                 claim_support_json, claim_verification_json, identity_resolutions_json,
                 capability_manifest_json
          FROM analysis_result_snapshots
          WHERE session_id = ?
        `).all(sessionId);
        const run = db.prepare('SELECT question FROM analysis_runs WHERE id = ?').get('run-private');
        expect(JSON.stringify({rows, run})).not.toContain(canary);
        expect(rows).toHaveLength(1);
        expect((rows[0] as any).conclusion_contract_json).not.toBeNull();
        expect((rows[0] as any).claim_support_json).not.toBeNull();
        expect((rows[0] as any).claim_verification_json).not.toBeNull();
        expect((rows[0] as any).identity_resolutions_json).not.toBeNull();
        expect(JSON.parse((rows[0] as any).capability_manifest_json)).toEqual(receiptCapabilityManifest);
      } finally {
        db.close();
      }
    } finally {
      clearCodeAwareOutputGuards(sessionId);
    }
  });

  test('persists the same real-handler finalized result without raw source echo', async () => {
    useTempEnterpriseDb();
    const fixture = createRuntimeSourceFinalizationFixture({
      createMcpServer: createClaudeMcpServer,
      sessionId: 'session-task7-finalized-snapshot',
    });
    try {
      const {decision} = await fixture.executeProviderSourceLookup();
      const result = finalizeSourceAwareAnalysisResult(
        createSourceAuthoredAnalysisResult(fixture.sessionId),
        fixture.sourceUse,
      );
      const snapshot = persistCompletedAnalysisResultSnapshot({
        tenantId: 'tenant-task7',
        workspaceId: 'workspace-task7',
        userId: 'user-task7',
        traceId: 'trace-task7',
        sessionId: fixture.sessionId,
        runId: 'run-task7',
        query: 'analyze Task7Source',
        conclusion: result.conclusion,
        conclusionContract: result.conclusionContract,
        sourceUseDecision: result.sourceUseDecision,
        confidence: result.confidence,
        partial: result.partial,
        terminationReason: result.terminationReason,
        terminationMessage: result.terminationMessage,
        privateKnowledge: true,
        outputLanguage: 'en',
      });

      expect(result.sourceUseDecision).toEqual(decision);
      expect(JSON.stringify(result)).not.toContain(SOURCE_FINALIZATION_CANARY);
      expect(JSON.stringify(snapshot)).not.toContain(SOURCE_FINALIZATION_CANARY);
      expect((snapshot?.conclusionContract as any)?.sourceUseDecision)
        .toEqual(expect.objectContaining({
          status: 'corroborated',
          references: decision.references,
        }));

      const db = openEnterpriseDb();
      try {
        const row = db.prepare(`
          SELECT summary_json, conclusion_contract_json
          FROM analysis_result_snapshots
          WHERE session_id = ?
        `).get(fixture.sessionId);
        expect(JSON.stringify(row)).not.toContain(SOURCE_FINALIZATION_CANARY);
      } finally {
        db.close();
      }
    } finally {
      fixture.cleanup();
    }
  });

  test('keeps only sanitized source-claim provenance in completed snapshots', () => {
    useTempEnterpriseDb();
    const actualSourceUseDecision = {
      schemaVersion: 'source_use_decision@1' as const,
      codeAwareMode: 'provider_send' as const,
      selectedCodebaseIds: ['app-source'],
      status: 'corroborated' as const,
      attemptedTools: ['read_codebase_file'],
      queriedCodebaseIds: ['app-source'],
      usedCodebaseIds: ['app-source'],
      references: [{
        id: 'model-controlled-id',
        referenceId: 'lookup-1',
        codebaseId: 'app-source',
        filePath: 'src/main/Foo.kt',
        lookupKind: 'body' as const,
        rootPath: '/private/raw-root-canary',
        snippet: 'raw-source-canary',
      } as any],
    };
    const snapshot = persistCompletedAnalysisResultSnapshot({
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
      userId: 'user-a',
      traceId: 'trace-source',
      sessionId: 'session-source',
      runId: 'run-source',
      query: 'analyze Foo.run',
      conclusion: 'Foo.run matches the verified trace occurrence',
      sourceUseDecision: actualSourceUseDecision,
      conclusionContract: {
        schemaVersion: 'conclusion_contract_v1',
        mode: 'focused_answer',
        conclusions: [{rank: 1, statement: 'Foo.run matches the verified trace occurrence'}],
        clusters: [],
        evidenceChain: [],
        claims: [{
          id: 'claim-1',
          text: 'Foo.run matches the verified trace occurrence',
          references: [{evidenceRefId: 'data:trace-1'}],
        }],
        sourceUseDecision: actualSourceUseDecision,
        sourceReferences: [{
          id: 'model-controlled-id',
          referenceId: 'lookup-1',
          codebaseId: 'app-source',
          filePath: 'src/main/Foo.kt',
          lookupKind: 'body',
          text: 'raw-source-canary',
        }],
        sourceClaimBindings: [{
          claimId: 'claim-1',
          mechanismStatus: 'compatible',
          sourceReferenceIds: ['model-controlled-id'],
          traceEvidenceRefIds: ['data:trace-1'],
          reason: 'raw-source-canary',
        }],
        uncertainties: [],
        nextSteps: [],
      },
      claimVerificationResult: {
        schemaVersion: 'claim_verifier@1',
        status: 'passed',
        policy: 'record_only',
        passed: true,
        checkedClaimCount: 1,
        unsupportedClaimCount: 0,
        claimResults: [{
          claimId: 'claim-1',
          status: 'verified',
          referenceResults: [{evidenceRefId: 'data:trace-1', status: 'matched'}],
        }],
        issues: [],
      },
    });

    const contract = snapshot?.conclusionContract as any;
    expect(contract.sourceReferences[0].id).toMatch(/^source-ref-v1-/);
    expect(contract.sourceClaimBindings[0].sourceReferenceIds).toEqual([
      contract.sourceReferences[0].id,
    ]);
    expect(JSON.stringify(contract)).not.toContain('model-controlled-id');
    expect(JSON.stringify(contract)).not.toContain('raw-source-canary');
    expect(JSON.stringify(contract)).not.toContain('/private/raw-root-canary');

    const db = openEnterpriseDb();
    try {
      const row = db.prepare(`
        SELECT conclusion_contract_json AS conclusionContractJson
        FROM analysis_result_snapshots
        WHERE id = ?
      `).get(snapshot!.id) as {conclusionContractJson: string};
      expect(JSON.parse(row.conclusionContractJson)).toEqual(contract);
    } finally {
      db.close();
    }
  });

  test('keeps source-free completed snapshot contracts backward compatible', () => {
    useTempEnterpriseDb();
    const legacyContract = {
      schemaVersion: 'conclusion_contract_v1' as const,
      mode: 'focused_answer' as const,
      conclusions: [{rank: 1, statement: 'Trace-only conclusion'}],
      clusters: [],
      evidenceChain: [],
      claims: [{id: 'claim-trace-only', text: 'Trace-only conclusion', references: []}],
      uncertainties: [],
      nextSteps: [],
      metadata: {legacy: true},
    };

    const snapshot = persistCompletedAnalysisResultSnapshot({
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
      userId: 'user-a',
      traceId: 'trace-source-free',
      sessionId: 'session-source-free',
      runId: 'run-source-free',
      query: 'trace-only analysis',
      conclusion: 'Trace-only conclusion',
      conclusionContract: legacyContract,
    });

    expect(snapshot?.conclusionContract).toEqual(legacyContract);
    expect(snapshot?.conclusionContract).not.toHaveProperty('sourceUseDecision');
    expect(snapshot?.conclusionContract).not.toHaveProperty('sourceReferences');
    expect(snapshot?.conclusionContract).not.toHaveProperty('sourceClaimBindings');

    const db = openEnterpriseDb();
    try {
      const row = db.prepare(`
        SELECT conclusion_contract_json AS conclusionContractJson
        FROM analysis_result_snapshots
        WHERE id = ?
      `).get(snapshot!.id) as {conclusionContractJson: string};
      expect(JSON.parse(row.conclusionContractJson)).toEqual(legacyContract);
    } finally {
      db.close();
    }
  });

  test('does not persist body use or corroborated mechanisms for metadata-only source decisions', () => {
    const bodyReference = sanitizeSourceReference({
      referenceId: 'metadata-body-invalid',
      codebaseId: 'app-source',
      filePath: 'src/main/Foo.kt',
      lookupKind: 'body',
    })!;
    const sourceUseDecision = {
      schemaVersion: 'source_use_decision@1' as const,
      codeAwareMode: 'metadata_only' as const,
      selectedCodebaseIds: ['app-source'],
      status: 'corroborated' as const,
      attemptedTools: ['read_codebase_file'],
      queriedCodebaseIds: ['app-source'],
      usedCodebaseIds: ['app-source'],
      references: [bodyReference],
    };
    const snapshot = buildCompletedAnalysisResultSnapshot({
      tenantId: 'tenant-metadata-only',
      workspaceId: 'workspace-metadata-only',
      traceId: 'trace-metadata-only',
      sessionId: 'session-metadata-only',
      runId: 'run-metadata-only',
      query: 'metadata-only analysis',
      conclusion: 'Trace-only mechanism result',
      sourceUseDecision,
      conclusionContract: {
        schemaVersion: 'conclusion_contract_v1',
        mode: 'focused_answer',
        conclusions: [],
        clusters: [],
        evidenceChain: [],
        claims: [{id: 'claim-1', text: 'Trace-only mechanism result', references: []}],
        sourceUseDecision,
        sourceReferences: [bodyReference],
        sourceClaimBindings: [{
          claimId: 'claim-1',
          mechanismStatus: 'corroborated',
          sourceReferenceIds: [bodyReference.id],
          traceEvidenceRefIds: ['trace-evidence-1'],
        }],
        uncertainties: [],
        nextSteps: [],
      },
    });

    const storedContract = snapshot?.conclusionContract as any;
    expect(storedContract.sourceUseDecision.status).toBe('located');
    expect(storedContract.sourceUseDecision.references).toEqual([]);
    expect(storedContract.sourceReferences).toEqual([]);
    expect(storedContract.sourceClaimBindings).toEqual([]);
    expect(JSON.stringify(storedContract)).not.toContain('"lookupKind":"body"');
    expect(JSON.stringify(storedContract)).not.toContain('"mechanismStatus":"corroborated"');
  });
});
