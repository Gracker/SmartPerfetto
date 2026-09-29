// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

export interface EnterpriseSecurityAuditEvidence {
  file: string;
  patterns: string[];
}

export interface EnterpriseSecurityAuditItem {
  id: string;
  auditArea: string;
  requiredInvariant: string;
  evidence: EnterpriseSecurityAuditEvidence[];
}

export const ENTERPRISE_SECURITY_AUDIT_CHECKLIST = [
  {
    id: 'id-enumeration-trace-session-report',
    auditArea: 'ID 枚举',
    requiredInvariant: '未知或越权 traceId/sessionId/runId/reportId 不能区分不存在与无权访问。',
    evidence: [
      {
        file: 'backend/src/routes/__tests__/ownerGuardRoutes.test.ts',
        patterns: [
          'filters trace list and returns 404 for traces owned by another tenant',
          'returns 404 for another tenant session report without invoking report recovery',
          'guards persisted report access and delete by owner fields',
        ],
      },
      {
        file: 'backend/src/routes/__tests__/enterpriseTraceMetadataRoutes.test.ts',
        patterns: ['expect(otherWorkspaceRes.status).toBe(404)'],
      },
      {
        file: 'backend/src/routes/__tests__/enterpriseReportRoutes.test.ts',
        patterns: ['expect(otherWorkspaceRes.status).toBe(404)'],
      },
    ],
  },
  {
    id: 'cross-tenant-owner-guard',
    auditArea: '跨 tenant',
    requiredInvariant: '跨 tenant/workspace 的持久化引用、列表、资源路径和知识检索必须先按 scope 过滤。',
    evidence: [
      {
        file: 'backend/src/services/__tests__/enterpriseSchema.test.ts',
        patterns: ['rejects cross-tenant workspace and session/run references on new core tables'],
      },
      {
        file: 'backend/src/routes/__tests__/workspaceResourceRoutes.test.ts',
        patterns: ['rejects trusted SSO requests whose selected workspace differs from the workspace path'],
      },
      {
        file: 'backend/src/services/__tests__/enterpriseKnowledgeScope.test.ts',
        patterns: [
          'filters RAG candidates by tenant/workspace before keyword retrieval',
          'tenant a memory',
          'tenant b memory',
        ],
      },
    ],
  },
  {
    id: 'provider-management-permission',
    auditArea: '无权限 provider 访问',
    requiredInvariant: 'Provider 管理面必须要求 provider:manage_workspace，不允许 analyst/viewer 枚举或读取 provider 配置。',
    evidence: [
      {
        file: 'backend/src/routes/providerRoutes.ts',
        patterns: [
          "hasRbacPermission(context, 'provider:manage_workspace')",
          'Provider management requires provider:manage_workspace permission',
        ],
      },
      {
        file: 'backend/src/services/providerManager/__tests__/providerRoutes.test.ts',
        patterns: ['requires provider management permission for provider access in enterprise SSO'],
      },
    ],
  },
  {
    id: 'report-read-permission',
    auditArea: '无权限 report 访问',
    requiredInvariant: '缺少 report:read 的同 workspace 请求也必须按 not found 处理，避免报告 ID 枚举。',
    evidence: [
      {
        file: 'backend/src/services/rbac.ts',
        patterns: [
          "hasRbacPermission(context, 'report:read')",
          'canReadReportResource',
        ],
      },
      {
        file: 'backend/src/routes/__tests__/ownerGuardRoutes.test.ts',
        patterns: [
          'returns 404 for same-workspace reports when caller lacks report read permission',
          'trace_only_custom_role',
          "expect(exportRes.status).toBe(404)",
        ],
      },
    ],
  },
  {
    id: 'memory-admin-permission',
    auditArea: '无权限 memory 访问',
    requiredInvariant: 'Memory 检视、promotion、删除和审计面必须要求 audit:read。',
    evidence: [
      {
        file: 'backend/src/routes/memoryRoutes.ts',
        patterns: [
          "hasRbacPermission(context, 'audit:read')",
          'Memory administration requires audit:read permission',
        ],
      },
      {
        file: 'backend/src/routes/__tests__/memoryRoutes.test.ts',
        patterns: ['requires audit read permission for memory admin access in enterprise SSO'],
      },
    ],
  },
] satisfies readonly EnterpriseSecurityAuditItem[];
