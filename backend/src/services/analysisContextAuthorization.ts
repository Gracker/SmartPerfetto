// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {OutputLanguage} from '../agentv3/outputLanguage';
import {localize} from '../agentv3/outputLanguage';
import {codeAwareFeatureEnabled} from './codebase/codeAwareFeature';
import {codebaseRootAvailable, type CodebaseRegistry} from './codebase/codebaseRegistry';
import {getDefaultCodebaseRegistry} from './codebase/defaultCodebaseServices';
import {
  externalKnowledgeSourceHasActiveIndex,
  getDefaultExternalKnowledgeSourceRegistry,
  type ExternalKnowledgeSourceRegistry,
} from './externalKnowledgeSourceRegistry';
import type {KnowledgeScope} from './scopedKnowledgeStore';
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
}

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
  const codebaseIds = input.selection.codebaseIds ?? [];
  const knowledgeSourceIds = input.selection.knowledgeSourceIds ?? [];

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
    if (codebases.some(codebase => !codebase || !codebaseRootAvailable(codebase))) {
      return denied(409, {
        code: 'ANALYSIS_CONTEXT_CODEBASE_ROOT_UNAVAILABLE',
        error: localize(
          input.outputLanguage,
          '一个或多个所选源码库的已注册根目录当前不可用',
          'One or more selected codebases have a registered root that is unavailable',
        ),
      });
    }
    if (
      input.selection.codeAwareMode === 'provider_send' &&
      codebases.some(codebase => !codebase?.consent.sendToProvider)
    ) {
      return denied(409, {
        code: 'ANALYSIS_CONTEXT_CODEBASE_NOT_CONSENTED',
        error: localize(
          input.outputLanguage,
          '完整源码分析要求每个所选源码库都明确授权发送给模型服务',
          'Full source analysis requires explicit provider-send consent for every selected codebase',
        ),
      });
    }
  }

  if (knowledgeSourceIds.length > 0) {
    const registry = input.knowledgeRegistry ?? getDefaultExternalKnowledgeSourceRegistry();
    const sources = knowledgeSourceIds.map(sourceId => registry.get(sourceId, input.scope));
    if (sources.some(source => !source)) {
      return denied(404, {
        code: 'ANALYSIS_CONTEXT_SOURCE_NOT_FOUND',
        error: localize(
          input.outputLanguage,
          '未找到一个或多个所选知识源',
          'One or more selected knowledge sources were not found',
        ),
      });
    }
    if (sources.some(source =>
      !source?.rightsAcknowledged ||
      !source.sendToProvider ||
      !externalKnowledgeSourceHasActiveIndex(source))) {
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
