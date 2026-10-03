// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { estimatePromptTokens } from '../../agentv3/claudeSystemPrompt';
import type {OutputLanguage} from '../../agentv3/outputLanguage';
import { loadPromptTemplate, renderTemplate } from '../../agentv3/strategyLoader';
import { backendLogPath } from '../../runtimePaths';
import {
  CURATED_CASE_STATUSES,
  caseKnowledgeQualityRank,
  caseStatusRank,
  type CaseEvidenceSignature,
} from '../../types/caseKnowledge';
import type { CaseNode } from '../../types/sparkContracts';
import { caseAppliesToArchitecture } from '../caseArchitecture';
import { CaseLibrary } from '../caseLibrary';
import type { KnowledgeScope } from '../scopedKnowledgeStore';
import {
  isCaseBackgroundInjectionEnabled,
  loadCaseEvolutionConfig,
  type CaseEvolutionConfig,
} from './caseEvolutionConfig';
import {canonicalContentHash} from '../selfEvolution/canonicalJson';
import {currentRunManifestAttributionSink} from '../selfEvolution/runManifestLifecycle';
import {
  isEvaluationInjectionAllowed,
  registerEvaluationInjection,
} from '../selfEvolution/evaluationInjectionContext';

const TEMPLATE_NAMES: Record<OutputLanguage, {context: string; line: string}> = {
  'zh-CN': {
    context: 'case-background-context',
    line: 'case-background-case-line',
  },
  en: {
    context: 'case-background-context-en',
    line: 'case-background-case-line-en',
  },
};
const DEFAULT_TOP_K = 3;
const DEFAULT_CASE_BACKGROUND_TOKEN_BUDGET = 600;

export interface BuildCaseBackgroundContextOptions {
  library?: CaseLibrary;
  config?: CaseEvolutionConfig;
  maxTokens?: number;
  topK?: number;
  loadTemplate?: typeof loadPromptTemplate;
  outputLanguage?: OutputLanguage;
}

/**
 * The curated cases a run's prompt starts with, when both case switches are
 * on: the same admitted cases for every run, a private one included
 * (`security/caseCuration.ts`).
 */
export function buildCaseBackgroundContext(
  sceneType: string | undefined,
  architectureType?: string,
  knowledgeScope?: KnowledgeScope,
  opts: BuildCaseBackgroundContextOptions = {},
): string | undefined {
  if (!isCaseBackgroundInjectionEnabled(opts.config ?? loadCaseEvolutionConfig())) return undefined;

  const library = opts.library ?? new CaseLibrary(backendLogPath('case_library.json'));
  const cases = findBackgroundCases({
    library,
    sceneType,
    architectureType,
    topK: opts.topK ?? DEFAULT_TOP_K,
    knowledgeScope,
  });
  const eligibleCases = cases.map(caseNode => ({
    caseNode,
    contentHash: canonicalContentHash({
      title: caseNode.title,
      status: caseNode.status,
      knowledge: caseNode.knowledge,
    }),
  })).filter(entry => isEvaluationInjectionAllowed({
    category: 'cases',
    id: entry.caseNode.caseId,
    contentHash: entry.contentHash,
  }));
  if (eligibleCases.length === 0) return undefined;

  const outputLanguage = opts.outputLanguage ?? 'zh-CN';
  const templateNames = TEMPLATE_NAMES[outputLanguage];
  const templateLoader = opts.loadTemplate ?? loadPromptTemplate;
  const template = templateLoader(templateNames.context);
  const lineTemplate = templateLoader(templateNames.line);
  if (!template || !lineTemplate) return undefined;
  const context = renderTemplate(template, {
    case_lines: eligibleCases
      .map(({caseNode}) => formatCaseLine(caseNode, lineTemplate))
      .join('\n'),
  });
  const maxTokens = opts.maxTokens ?? DEFAULT_CASE_BACKGROUND_TOKEN_BUDGET;
  if (estimatePromptTokens(context) > maxTokens) return undefined;
  const sink = currentRunManifestAttributionSink();
  for (const {caseNode, contentHash} of eligibleCases) {
    registerEvaluationInjection({
      category: 'cases',
      id: caseNode.caseId,
      contentHash,
      placement: 'system_prompt:case_background',
    });
    sink?.recordInjection(
      'cases',
      caseNode.caseId,
      contentHash,
    );
  }
  return context;
}

function findBackgroundCases(opts: {
  library: CaseLibrary;
  sceneType?: string;
  architectureType?: string;
  topK: number;
  knowledgeScope?: KnowledgeScope;
}): CaseNode[] {
  return opts.library.listAdmittedCases(CURATED_CASE_STATUSES, opts.knowledgeScope)
    .filter(caseNode => isStructuralMatch(caseNode, opts.sceneType, opts.architectureType))
    .sort(compareBackgroundCases)
    .slice(0, Math.max(1, opts.topK));
}

function isStructuralMatch(
  caseNode: CaseNode,
  sceneType?: string,
  architectureType?: string,
): boolean {
  const knowledge = caseNode.knowledge;
  if (!knowledge) return false;
  if (sceneType && knowledge.scene !== sceneType) return false;
  if (sceneType && knowledge.domainPack !== `${sceneType}.v1`) return false;
  return caseAppliesToArchitecture(caseNode, architectureType);
}

function compareBackgroundCases(a: CaseNode, b: CaseNode): number {
  return caseStatusRank(b.status) - caseStatusRank(a.status) ||
    caseKnowledgeQualityRank(b.knowledge?.quality) - caseKnowledgeQualityRank(a.knowledge?.quality) ||
    a.caseId.localeCompare(b.caseId);
}

function formatCaseLine(caseNode: CaseNode, template: string): string {
  const knowledge = caseNode.knowledge!;
  const evidence = [
    ...knowledge.evidenceSignatures.required,
    ...knowledge.evidenceSignatures.supportive,
  ].slice(0, 3);
  return renderTemplate(template, {
    case_id: caseNode.caseId,
    title: caseNode.title,
    status: caseNode.status,
    primary_root_cause: knowledge.taxonomy.primary_root_cause,
    evidence_conditions: formatEvidenceConditions(evidence),
  });
}

function formatEvidenceConditions(signatures: CaseEvidenceSignature[]): string {
  if (signatures.length === 0) return '-';
  return signatures
    .map(signature => `${signature.field} ${signature.op} ${JSON.stringify(signature.value)}`)
    .join('; ');
}
