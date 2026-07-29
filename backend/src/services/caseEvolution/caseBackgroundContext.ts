// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { estimatePromptTokens } from '../../agentv3/claudeSystemPrompt';
import type {OutputLanguage} from '../../agentv3/outputLanguage';
import { loadPromptTemplate, renderTemplate } from '../../agentv3/strategyLoader';
import { backendLogPath } from '../../runtimePaths';
import type { CaseEvidenceSignature, CaseKnowledgeQuality } from '../../types/caseKnowledge';
import type { CaseNode, CurationStatus } from '../../types/sparkContracts';
import { CaseLibrary } from '../caseLibrary';
import type { KnowledgeScope } from '../scopedKnowledgeStore';
import {
  loadCaseEvolutionConfig,
  validateCaseEvolutionConfig,
  type CaseEvolutionConfigValidation,
} from './caseEvolutionConfig';
import {
  recordCaseEvolutionPromptDroppedForBudget,
  recordCaseEvolutionPromptSegmentBuilt,
} from './caseEvolutionRuntimeMetrics';
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
  config?: ReturnType<typeof loadCaseEvolutionConfig>;
  maxTokens?: number;
  topK?: number;
  loadTemplate?: typeof loadPromptTemplate;
  validateConfig?: typeof validateCaseEvolutionConfig;
  outputLanguage?: OutputLanguage;
}

export interface RuntimeCaseBackgroundContextInput {
  sceneType?: string;
  architectureType?: string;
  knowledgeScope?: KnowledgeScope;
  outputLanguage: OutputLanguage;
  privateAnalysisContext: boolean;
}

/** Shared privacy and localization boundary for every production runtime. */
export function buildRuntimeCaseBackgroundContext(
  input: RuntimeCaseBackgroundContextInput,
  opts: BuildCaseBackgroundContextOptions = {},
): string | undefined {
  if (input.privateAnalysisContext) return undefined;
  return buildCaseBackgroundContext(
    input.sceneType,
    input.architectureType,
    input.knowledgeScope,
    {...opts, outputLanguage: input.outputLanguage},
  );
}

export function buildCaseBackgroundContext(
  sceneType: string | undefined,
  architectureType?: string,
  knowledgeScope?: KnowledgeScope,
  opts: BuildCaseBackgroundContextOptions = {},
): string | undefined {
  const rawConfig = opts.config ?? loadCaseEvolutionConfig();
  const validation = (opts.validateConfig ?? validateCaseEvolutionConfig)(rawConfig);
  if (!canInjectCaseBackground(validation)) return undefined;

  const library = opts.library ?? new CaseLibrary(backendLogPath('case_library.json'));
  const cases = findBackgroundCases({
    library,
    sceneType,
    architectureType,
    includeDrafts: validation.effectiveConfig.includeDrafts,
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
  if (estimatePromptTokens(context) > maxTokens) {
    recordCaseEvolutionPromptDroppedForBudget();
    return undefined;
  }
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
  recordCaseEvolutionPromptSegmentBuilt();
  return context;
}

function canInjectCaseBackground(validation: CaseEvolutionConfigValidation): boolean {
  return validation.ok &&
    validation.effectiveConfig.retrieveEnabled &&
    validation.effectiveConfig.promptInjectEnabled;
}

function findBackgroundCases(opts: {
  library: CaseLibrary;
  sceneType?: string;
  architectureType?: string;
  includeDrafts: boolean;
  topK: number;
  knowledgeScope?: KnowledgeScope;
}): CaseNode[] {
  const statuses: CurationStatus[] = opts.includeDrafts
    ? ['published', 'reviewed', 'draft']
    : ['published', 'reviewed'];
  const seen = new Set<string>();
  const candidates: CaseNode[] = [];
  for (const status of statuses) {
    for (const caseNode of opts.library.listCases({status}, opts.knowledgeScope)) {
      if (seen.has(caseNode.caseId)) continue;
      seen.add(caseNode.caseId);
      if (!isStructuralMatch(caseNode, opts.sceneType, opts.architectureType)) continue;
      candidates.push(caseNode);
    }
  }
  return candidates
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
  const caseArchitecture = knowledge.context?.architectureType;
  if (!architectureType || !caseArchitecture || caseArchitecture === 'unknown') return true;
  return String(caseArchitecture).toLowerCase() === architectureType.toLowerCase();
}

function compareBackgroundCases(a: CaseNode, b: CaseNode): number {
  return statusRank(b.status) - statusRank(a.status) ||
    draftQualityRank(b) - draftQualityRank(a) ||
    qualityRank(b.knowledge?.quality) - qualityRank(a.knowledge?.quality) ||
    a.caseId.localeCompare(b.caseId);
}

function statusRank(status: CurationStatus): number {
  switch (status) {
    case 'published':
      return 4;
    case 'reviewed':
      return 3;
    case 'draft':
      return 2;
    case 'private':
      return 1;
    default:
      return 0;
  }
}

function draftQualityRank(caseNode: CaseNode): number {
  if (caseNode.status !== 'draft') return 0;
  return qualityRank(caseNode.knowledge?.quality);
}

function qualityRank(quality: CaseKnowledgeQuality | undefined): number {
  switch (quality) {
    case 'curated':
      return 3;
    case 'imported':
      return 2;
    case 'weak':
      return 1;
    default:
      return 0;
  }
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
