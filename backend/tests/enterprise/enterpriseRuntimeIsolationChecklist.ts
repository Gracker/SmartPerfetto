// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

export interface RuntimeIsolationEvidence {
  file: string;
  patterns: string[];
}

export interface RuntimeIsolationChecklistItem {
  id: string;
  vulnerability: string;
  fix: string;
  acceptance: string;
  evidence: RuntimeIsolationEvidence[];
}

export const RUNTIME_ISOLATION_CHECKLIST = [
  {
    id: 'proxy-status-websocket-query',
    vulnerability: 'Proxy 只代理 HTTP `/query`',
    fix: 'Backend lease proxy covers `/status`, `/websocket`, `/query`, and the enterprise UI uses lease proxy targets instead of raw local ports.',
    acceptance: '企业模式前端 network 不再访问 `127.0.0.1:9100-9900`',
    evidence: [
      {
        file: 'backend/src/routes/__tests__/traceProcessorProxyRoutes.test.ts',
        patterns: [
          'proxies status and query bytes through the scoped lease',
          'tunnels API-key browser websocket upgrades with a scoped capability',
        ],
      },
      {
        file: 'backend/src/scripts/verifyEnterpriseMultiTenantWindows.ts',
        patterns: [
          'frontendTimelineUsesLeaseProxy',
          '/api/tp/${encodeURIComponent(frontendLease.id)}/websocket',
          "!target.includes('127.0.0.1')",
        ],
      },
      {
        file: 'perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/ai_panel.ts',
        patterns: ["rpcTarget.mode === 'backend-lease-proxy'"],
      },
    ],
  },
  {
    id: 'http-rpc-target-lease-proxy',
    vulnerability: '`HttpRpcEngine` 仍只接受 port',
    fix: '`HttpRpcEngine` accepts a structured `HttpRpcTarget`, so enterprise mode can hide port changes behind a stable lease proxy.',
    acceptance: 'processor restart 后前端 leaseId 不变',
    evidence: [
      {
        file: 'perfetto/ui/src/trace_processor/http_rpc_engine.ts',
        patterns: [
          'export interface HttpRpcTarget',
          "mode: 'direct-port' | 'backend-lease-proxy'",
          'static setRpcTarget(target: HttpRpcTarget): void',
        ],
      },
      {
        file: 'perfetto/ui/src/trace_processor/http_rpc_engine_unittest.ts',
        patterns: ['uses backend lease proxy targets when configured'],
      },
      {
        file: 'backend/src/routes/__tests__/traceProcessorProxyRoutes.test.ts',
        patterns: ['lets workspace admins restart a scoped lease without changing the lease id'],
      },
      {
        file: 'backend/src/scripts/verifyEnterpriseMultiTenantWindows.ts',
        patterns: ['leaseIdStableAcrossCrashRestart'],
      },
    ],
  },
  {
    id: 'websocket-fifo-query-order',
    vulnerability: '同一 WebSocket 内重排 query',
    fix: 'Frontend WebSocket responses are drained in FIFO order, and the backend SQL worker keeps queued work ordered by priority and FIFO within a priority.',
    acceptance: '并发 timeline 查询结果不错位',
    evidence: [
      {
        file: 'perfetto/ui/src/trace_processor/http_rpc_engine.ts',
        patterns: [
          'private isProcessingQueue = false',
          'this.queue.push(blob)',
          'while (this.queue.length > 0)',
        ],
      },
      {
        file: 'backend/src/services/__tests__/traceProcessorSqlWorker.test.ts',
        patterns: [
          'does not preempt the running query, but runs queued P0 before queued P1/P2',
          'keeps FIFO order inside the same priority level',
        ],
      },
      {
        file: 'backend/src/scripts/verifyEnterpriseMultiTenantWindows.ts',
        patterns: ['queryResultsStayAssociatedWithOriginalSql'],
      },
    ],
  },
  {
    id: 'agent-frontend-same-lease-stats',
    vulnerability: 'Agent query 和前端 WebSocket 走两套 processor',
    fix: 'Frontend, agent, and report paths acquire typed holders through `TraceProcessorLease`, with shared/isolated mode visible in lease stats.',
    acceptance: '同 trace 的 frontend/agent/report holder 出现在同一 lease stats',
    evidence: [
      {
        file: 'backend/src/scripts/verifyEnterpriseMultiTenantWindows.ts',
        patterns: [
          'frontendAndAgentUseLeaseHolders',
          "holderType: 'frontend_http_rpc'",
          "holderType: 'agent_run'",
          "holderType: 'report_generation'",
        ],
      },
      {
        file: 'backend/src/routes/__tests__/agentRoutesRbac.test.ts',
        patterns: ['selects an isolated lease for full analysis runs'],
      },
      {
        file: 'backend/src/routes/__tests__/enterpriseTraceMetadataRoutes.test.ts',
        patterns: ['reports isolated report-generation lease queue length separately from the frontend shared queue'],
      },
    ],
  },
  {
    id: 'sse-terminal-events-persisted',
    vulnerability: 'SSE terminal event 不进持久事件表',
    fix: 'SSE replay is backed by persisted `AgentEvent` rows and clients reconnect with `Last-Event-ID`.',
    acceptance: '断线发生在 conclusion 和 report 之间也能 replay reportUrl',
    evidence: [
      {
        file: 'backend/src/routes/__tests__/agentRoutesRbac.test.ts',
        patterns: ['replays persisted terminal SSE events before falling back to the in-memory buffer'],
      },
      {
        file: 'backend/src/scripts/verifyEnterpriseMultiTenantWindows.ts',
        patterns: ['persistedEventsReplayAfterRestart'],
      },
      {
        file: 'perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/agent_sse_transport.ts',
        patterns: ["headers['Last-Event-ID']"],
      },
      {
        file: 'perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/agent_sse_transport_unittest.ts',
        patterns: ['sends replay cursor through Last-Event-ID header'],
      },
    ],
  },
  {
    id: 'running-run-independent-cleanup',
    vulnerability: 'running run cleanup 只看 SSE client',
    fix: 'Cleanup/delete decisions check persisted run state and run heartbeat, not only the SSE client connection.',
    acceptance: '长 run 断开 SSE 后仍可恢复',
    evidence: [
      {
        file: 'backend/src/services/enterpriseSchema.ts',
        patterns: [
          "addColumnIfMissing(db, 'analysis_runs', 'heartbeat_at', 'INTEGER')",
          'idx_analysis_runs_heartbeat',
        ],
      },
      {
        file: 'backend/src/routes/__tests__/enterpriseTraceMetadataRoutes.test.ts',
        patterns: ['blocks enterprise trace delete while runs, active leases, or report holders still own the trace'],
      },
      {
        file: 'backend/src/scripts/verifyEnterpriseMultiTenantWindows.ts',
        patterns: [
          'deleteDetectsRunningRunBeforeRemovingTrace',
          "activeRuns[0]?.status === 'running'",
          'aEventStreamContinuesAfterBStart',
        ],
      },
    ],
  },
  {
    id: 'upload-temp-path-unique',
    vulnerability: '上传临时文件名冲突',
    fix: 'Uploads are persisted through trace-id scoped storage and atomic finalization instead of shared original filenames.',
    acceptance: '两窗口上传同名 trace 不互相覆盖',
    evidence: [
      {
        file: 'backend/src/routes/__tests__/enterpriseTraceMetadataRoutes.test.ts',
        patterns: ['stores uploaded trace metadata in trace_assets and moves the trace into scoped data storage'],
      },
      {
        file: 'backend/src/scripts/verifyEnterpriseMultiTenantWindows.ts',
        patterns: [
          'sameFilenameUsesDistinctTraceIds',
          'sameFilenameUsesDistinctFiles',
        ],
      },
    ],
  },
  {
    id: 'url-upload-streaming',
    vulnerability: 'URL 上传全量 buffer',
    fix: 'URL uploads stream directly into scoped trace storage without buffering the full response in Node memory.',
    acceptance: '大 trace 上传期间第一窗口心跳和 SSE 不超时',
    evidence: [
      {
        file: 'backend/src/routes/__tests__/enterpriseTraceMetadataRoutes.test.ts',
        patterns: ['streams URL uploads into scoped trace storage without buffering the response body'],
      },
      {
        file: 'backend/src/scripts/verifyEnterpriseMultiTenantWindows.ts',
        patterns: [
          'aEventStreamContinuesAfterBStart',
          '/api/tp/${encodeURIComponent(frontendLease.id)}/heartbeat',
        ],
      },
    ],
  },
  {
    id: 'legacy-register-rpc-disabled',
    vulnerability: 'ExternalRpc/register-rpc 兼容路径绕过新 lease',
    fix: 'Enterprise mode rejects legacy direct RPC registration before it can create naked-port processor state.',
    acceptance: '代码搜索无企业模式可用裸 port 注册路径',
    evidence: [
      {
        file: 'backend/src/routes/__tests__/enterpriseTraceMetadataRoutes.test.ts',
        patterns: ['disables legacy direct RPC registration in enterprise mode before creating naked-port state'],
      },
      {
        file: 'backend/src/services/__tests__/workingTraceProcessor.enterpriseIsolation.test.ts',
        patterns: [
          'applies the same wall-clock timeout to external raw RPC queries',
          'runs health SELECT 1 on a dedicated channel outside the SQL worker queue',
        ],
      },
    ],
  },
  {
    id: 'cleanup-draining-audit',
    vulnerability: '`/api/traces/cleanup` 悬崖 endpoint',
    fix: 'Enterprise cleanup is admin-only, drains idle leases, blocks active holders, and records audit events.',
    acceptance: 'running lease 存在时 cleanup 返回 blocked',
    evidence: [
      {
        file: 'backend/src/routes/__tests__/enterpriseTraceMetadataRoutes.test.ts',
        patterns: [
          'blocks enterprise cleanup when scoped trace processor leases still have active holders and audits the attempt',
          'drains idle enterprise leases before scoped processor cleanup and records an audit event',
          'hides enterprise cleanup from non-admin analysts',
        ],
      },
      {
        file: 'backend/src/scripts/verifyEnterpriseMultiTenantWindows.ts',
        patterns: [
          'activeLeaseBlocksCleanupOrDelete',
          'drainingLeaseRejectsNewWork',
        ],
      },
    ],
  },
  {
    id: 'window-scoped-session-storage',
    vulnerability: 'localStorage 跨窗口覆盖',
    fix: 'Pending trace state is scoped by workspace and window id in `sessionStorage`, with stale save merging to avoid read-modify-write overwrites.',
    acceptance: '双窗口刷新后各自 traceId/sessionId 不变',
    evidence: [
      {
        file: 'perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/session_manager.ts',
        patterns: [
          'windowId = getSmartPerfettoWindowId()',
          'sessionStorage.setItem',
          'sessionStorage.getItem(scopedKey)',
        ],
      },
      {
        file: 'perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/session_manager_unittest.ts',
        patterns: [
          'stores pending backend traces under a workspace and window-scoped sessionStorage key',
          'does not recover another window pending trace',
          'recovers pending backend traces by lease id for proxy mode',
          'merges stale read-modify-write saves instead of overwriting concurrent sessions',
        ],
      },
    ],
  },
  {
    id: 'report-generation-isolated-priority',
    vulnerability: 'report generation 长 SQL 阻塞前端',
    fix: 'Report generation uses a report holder, P2 priority, and isolated heavy-work visibility so frontend P0 timeline work remains protected.',
    acceptance: 'report 生成时前端 P0 query 延迟在阈值内或明确显示 isolated',
    evidence: [
      {
        file: 'backend/src/routes/__tests__/enterpriseTraceMetadataRoutes.test.ts',
        patterns: ['reports isolated report-generation lease queue length separately from the frontend shared queue'],
      },
      {
        file: 'backend/src/services/__tests__/traceProcessorSqlWorker.test.ts',
        patterns: ['does not preempt the running query, but runs queued P0 before queued P1/P2'],
      },
      {
        file: 'backend/src/scripts/verifyEnterpriseMultiTenantWindows.ts',
        patterns: [
          'p0DoesNotWaitBehindQueuedP1OrP2',
          'workerStatsExposeQueuedP0',
          'reportGenerationHolderIsProtected',
        ],
      },
    ],
  },
  {
    id: 'single-supervisor-crash-recovery',
    vulnerability: 'processor crash recovery 重启风暴',
    fix: 'Crash recovery is coordinated by one lease supervisor with backoff, while holders wait on lease state.',
    acceptance: 'crash 后只有一个 restart 序列',
    evidence: [
      {
        file: 'backend/src/services/__tests__/traceProcessorLeaseProcessorRouting.test.ts',
        patterns: [
          'uses one supervisor restart for concurrent crashed lease holders and preserves the lease id',
          'marks the lease failed after the 1s/5s/15s backoff restart attempts all fail',
        ],
      },
      {
        file: 'backend/src/scripts/verifyEnterpriseMultiTenantWindows.ts',
        patterns: [
          'leaseIdStableAcrossCrashRestart',
          'stateMachineUsesSingleRestartSequence',
        ],
      },
    ],
  },
  {
    id: 'timeout-health-admin-drain',
    vulnerability: '24h timeout 掩盖挂死 query',
    fix: 'Long query timeout is paired with a dedicated health channel and admin drain/restart controls for bad leases.',
    acceptance: '挂死 query 可被管理员标记 lease draining/restart',
    evidence: [
      {
        file: 'backend/src/services/__tests__/workingTraceProcessor.enterpriseIsolation.test.ts',
        patterns: [
          'defaults trace processor query timeout to 24 hours',
          'runs health SELECT 1 on a dedicated channel outside the SQL worker queue',
        ],
      },
      {
        file: 'backend/src/routes/__tests__/traceProcessorProxyRoutes.test.ts',
        patterns: [
          'lets workspace admins drain a scoped lease and block new proxy work',
          'lets workspace admins restart a scoped lease without changing the lease id',
        ],
      },
    ],
  },
  {
    id: 'rss-budget-observed-highwater',
    vulnerability: 'RSS budget 估算错误',
    fix: 'Admission uses a RAM budget, observed processor RSS, and benchmark coverage so high-water behavior rejects new leases instead of killing existing windows.',
    acceptance: '压测记录 RSS，高水位超过预算时拒绝新 lease',
    evidence: [
      {
        file: 'backend/src/services/__tests__/traceProcessorRamBudget.test.ts',
        patterns: [
          'subtracts observed processor RSS from explicit RAM budget',
          'rejects a new trace when the estimate exceeds the remaining budget',
        ],
      },
      {
        file: 'backend/src/routes/__tests__/enterpriseTraceMetadataRoutes.test.ts',
        patterns: ['records observed processor RSS on the frontend lease and exposes RAM budget stats'],
      },
      {
        file: 'backend/src/scripts/__tests__/benchmarkTraceProcessorRss.test.ts',
        patterns: [
          'marks the §0.4.3 matrix incomplete when required scene/size cells are missing',
          'marks the §0.4.3 matrix complete only after every scene and size bucket is covered',
        ],
      },
      {
        file: 'backend/src/scripts/verifyEnterpriseMultiTenantWindows.ts',
        patterns: [
          'admissionRejectsNewLeaseNearRamBudget',
          'activeLeaseSurvivesRejectedAdmission',
          'noOomStyleCleanupOfExistingWindow',
        ],
      },
    ],
  },
] satisfies readonly RuntimeIsolationChecklistItem[];
