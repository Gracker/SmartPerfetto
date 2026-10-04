// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {OutputLanguage} from '../agentv3/outputLanguage';
import {localize} from '../agentv3/outputLanguage';
import {codeAwareFeatureEnabled} from './codebase/codeAwareFeature';
import type {CodebaseRegistry} from './codebase/codebaseRegistry';
import {
  evaluateCodebaseModeAuthorization,
  evaluateCodebaseRoot,
  type CodebaseModeAuthorizationFailure,
  type CodebaseRootUnavailableReason,
} from './codebase/codebaseCapability';
import type {PathSecurityGate} from './codebase/pathSecurityGate';
import {getDefaultCodebaseRegistry} from './codebase/defaultCodebaseServices';
import {
  externalKnowledgeSourceHasActiveIndex,
  getDefaultExternalKnowledgeSourceRegistry,
  type ExternalKnowledgeSourceRegistry,
} from './externalKnowledgeSourceRegistry';
import type {KnowledgeScope} from './scopedKnowledgeStore';
import {effectiveAnalysisSelection} from './effectiveAnalysisSelection';
import type {AnalysisContextSelection} from './resolvedAnalysisContext';

export interface AnalysisContextAuthorizationDenial {
  allowed: false;
  httpStatus: 403 | 404 | 409;
  payload: Record<string, unknown>;
}

export type AnalysisContextAuthorizationDecision =
  | {allowed: true}
  | AnalysisContextAuthorizationDenial;

interface AnalysisContextAuthorizationInput {
  selection: AnalysisContextSelection;
  scope: KnowledgeScope;
  outputLanguage: OutputLanguage;
  canReadRegisteredContext: boolean;
  featureEnabled?: boolean;
  codebaseRegistry?: CodebaseRegistry;
  knowledgeRegistry?: ExternalKnowledgeSourceRegistry;
  /** The allowlist registered roots are checked against; the configured environment by default. */
  gate?: Pick<PathSecurityGate, 'rootWithinAllowlist'>;
}

/** Why one selected codebase cannot start this analysis, and which layer refused it. */
type AnalysisContextCodebaseDenial =
  | {layer: 'root'; codebaseId: string; reason: CodebaseRootUnavailableReason}
  | {layer: 'mode'; codebaseId: string; reason: CodebaseModeAuthorizationFailure};

/** What each start-gate codebase refusal says, in Chinese then English. */
const CODEBASE_DENIAL_MESSAGES = {
  ANALYSIS_CONTEXT_CODEBASE_ROOT_UNAVAILABLE: [
    '一个或多个所选源码库的已注册根目录当前不可用',
    'One or more selected codebases have a registered root that is unavailable',
  ],
  ANALYSIS_CONTEXT_CODEBASE_NOT_CONSENTED: [
    '完整源码分析要求每个所选源码库都明确授权发送给模型服务',
    'Full source analysis requires explicit provider-send consent for every selected codebase',
  ],
  ANALYSIS_CONTEXT_CODEBASE_CONSENT_STALE: [
    '一个或多个所选源码库的发送授权与当前选择范围不一致，请重新授权',
    'One or more selected codebases have a provider-send grant that no longer matches their selection; grant it again',
  ],
} as const satisfies Record<string, readonly [string, string]>;

function denied(
  httpStatus: AnalysisContextAuthorizationDenial['httpStatus'],
  payload: Record<string, unknown>,
): AnalysisContextAuthorizationDenial {
  return {allowed: false, httpStatus, payload: {success: false, ...payload}};
}

/**
 * Shared final authorization boundary for every model-backed surface that can
 * consume registered source or knowledge. Callers must run this immediately
 * before creating a runtime so registry/root/consent changes cannot be skipped
 * by adding a new HTTP endpoint.
 */
export function authorizeAnalysisContext(
  input: AnalysisContextAuthorizationInput,
): AnalysisContextAuthorizationDecision {
  const selection = effectiveAnalysisSelection(input.selection);
  const codebaseIds = selection.codebaseIds ?? [];
  const knowledgeSourceIds = selection.knowledgeSourceIds ?? [];

  if (codebaseIds.length > 0 && (input.featureEnabled ?? codeAwareFeatureEnabled()) === false) {
    return denied(409, {
      code: 'FEATURE_DISABLED',
      error: localize(
        input.outputLanguage,
        '此后端已禁用注册源码分析',
        'Registered source analysis is disabled on this backend',
      ),
    });
  }

  if ((codebaseIds.length > 0 || knowledgeSourceIds.length > 0) && !input.canReadRegisteredContext) {
    return denied(403, {
      error: 'Forbidden',
      details: localize(
        input.outputLanguage,
        '使用已注册分析上下文需要 codebase:read 权限',
        'Using registered analysis context requires codebase:read permission',
      ),
    });
  }

  if (codebaseIds.length > 0) {
    const registry = input.codebaseRegistry ?? getDefaultCodebaseRegistry();
    const codebases = codebaseIds.map(codebaseId => registry.get(codebaseId, input.scope));
    if (codebases.some(codebase => !codebase)) {
      return denied(404, {
        code: 'ANALYSIS_CONTEXT_CODEBASE_NOT_FOUND',
        error: localize(
          input.outputLanguage,
          '未找到一个或多个所选源码库',
          'One or more selected codebases were not found',
        ),
      });
    }
    // Each codebase answers its first failing check, root before mode; the
    // response names the codebase and a fixed reason, never a path.
    const failures = codebases.flatMap((codebase, index): AnalysisContextCodebaseDenial[] => {
      const codebaseId = codebaseIds[index]!;
      const root = evaluateCodebaseRoot(codebase!, input.gate ? {gate: input.gate} : {});
      if (!root.available) return [{layer: 'root', codebaseId, reason: root.reason}];
      const mode = evaluateCodebaseModeAuthorization(codebase!, selection.codeAwareMode);
      return mode.authorized ? [] : [{layer: 'mode', codebaseId, reason: mode.reason}];
    });
    if (failures.length > 0) {
      const code = failures.some(failure => failure.layer === 'root')
        ? 'ANALYSIS_CONTEXT_CODEBASE_ROOT_UNAVAILABLE'
        : failures.some(failure => failure.reason === 'consent_required')
          ? 'ANALYSIS_CONTEXT_CODEBASE_NOT_CONSENTED'
          : 'ANALYSIS_CONTEXT_CODEBASE_CONSENT_STALE';
      const [zh, en] = CODEBASE_DENIAL_MESSAGES[code];
      return denied(409, {
        code,
        error: localize(input.outputLanguage, zh, en),
        codebases: failures.map(({codebaseId, reason}) => ({codebaseId, reason})),
      });
    }
  }

  if (knowledgeSourceIds.length > 0) {
    const registry = input.knowledgeRegistry ?? getDefaultExternalKnowledgeSourceRegistry();
    // The registry's own access rule decides; an active index is what a run additionally needs.
    const decisions = knowledgeSourceIds.map(sourceId =>
      registry.evaluateAccess(sourceId, input.scope, knowledgeSourceIds));
    const refused = (reason: string) => decisions.some(decision => !decision.allowed && decision.reason === reason);
    if (refused('source_not_found_or_out_of_scope')) {
      return denied(404, {
        code: 'ANALYSIS_CONTEXT_SOURCE_NOT_FOUND',
        error: localize(
          input.outputLanguage,
          '未找到一个或多个所选知识源',
          'One or more selected knowledge sources were not found',
        ),
      });
    }
    if (refused('knowledge_kind_retired')) {
      return denied(409, {
        code: 'ANALYSIS_CONTEXT_SOURCE_RETIRED',
        error: localize(
          input.outputLanguage,
          '所选知识源来自已停用的旧版 Wiki 连接器；请删除它，并把 Wiki 的 src/ 目录重新注册为文档知识库',
          "A selected knowledge source comes from the retired legacy Wiki connector; delete it and register the Wiki's src/ folder as a document knowledge base",
        ),
      });
    }
    if (decisions.some(decision => !decision.allowed || !externalKnowledgeSourceHasActiveIndex(decision.source))) {
      return denied(409, {
        code: 'ANALYSIS_CONTEXT_SOURCE_UNAVAILABLE',
        error: localize(
          input.outputLanguage,
          '一个或多个知识源未激活，或尚未授权给模型服务使用',
          'One or more knowledge sources are inactive or not consented for provider use',
        ),
      });
    }
  }

  return {allowed: true};
}
