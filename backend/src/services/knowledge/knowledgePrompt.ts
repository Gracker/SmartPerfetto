// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * What a run's prompt says about its selected knowledge bases: the
 * knowledge-authorization prompt segment and the knowledge-use guidance. Independent
 * of source access; present whenever a knowledge base is selected.
 */

import {DEFAULT_OUTPUT_LANGUAGE, type OutputLanguage} from '../../agentv3/outputLanguage';
import {loadPromptSegment} from '../../agentv3/strategyLoader';
import {
  safeCodebaseDisplayName,
  type SourceAuthorizationPromptData,
} from '../codebase/selectedCodebaseCapabilities';
import {
  type ExternalKnowledgeKind,
  type ExternalKnowledgeSource,
  externalKnowledgeSourceHasActiveIndex,
} from '../externalKnowledgeSourceRegistry';

/** Owner-written description characters a provider prompt may carry per knowledge base (the registry's own cap). */
/** The prompt keeps a short description; the registry stores up to 280 characters. */
const PROMPT_KNOWLEDGE_DESCRIPTION_MAX_CHARS = 120;

/**
 * One selected knowledge base as a run sees it. Name and description are
 * owner-written, projected like a codebase name; the template treats them as
 * data. A selection the registry cannot resolve keeps its id, with no index.
 */
interface SelectedKnowledgeBaseView {
  id: string;
  displayName?: string;
  description?: string;
  kind?: ExternalKnowledgeKind;
  activeIndex: boolean;
}

/** The run's selected knowledge bases: no mode, depth or source budget of their own. */
export interface KnowledgeAuthorizationPromptData {
  knowledgeBases: SelectedKnowledgeBaseView[];
}

/** The selected knowledge bases in selection order, from the sources the run resolved; undefined when none is selected. */
export function describeSelectedKnowledgeBases(
  knowledgeSourceIds: readonly string[],
  sources: ReadonlyMap<string, ExternalKnowledgeSource>,
): KnowledgeAuthorizationPromptData | undefined {
  if (knowledgeSourceIds.length === 0) return undefined;
  return {
    knowledgeBases: knowledgeSourceIds.map(id => {
      const source = sources.get(id);
      if (!source) return {id, activeIndex: false};
      const displayName = safeCodebaseDisplayName(source.displayName);
      const description = safeCodebaseDisplayName(source.description, PROMPT_KNOWLEDGE_DESCRIPTION_MAX_CHARS);
      return {
        id,
        ...(displayName ? {displayName} : {}),
        ...(description ? {description} : {}),
        kind: source.kind,
        activeIndex: externalKnowledgeSourceHasActiveIndex(source),
      };
    }),
  };
}

/**
 * The knowledge-use guidance and knowledge-authorization prompt data for a run with
 * selected knowledge bases, undefined without any. The orchestrator prompt
 * and Claude sub-agents both carry them, whatever the source mode.
 */
export function knowledgeUsePrompt(
  sourceAuthorization: SourceAuthorizationPromptData | undefined,
  outputLanguage: OutputLanguage = DEFAULT_OUTPUT_LANGUAGE,
): {guidance: string; authorization: KnowledgeAuthorizationPromptData} | undefined {
  const authorization = sourceAuthorization?.knowledgeAuthorization;
  if (!authorization?.knowledgeBases.length) return undefined;
  const templateName = outputLanguage === 'en' ? 'prompt-knowledge-use-en' : 'prompt-knowledge-use-zh';
  const guidance = loadPromptSegment(templateName);
  if (!guidance) throw new Error(`Missing required knowledge-use prompt template: ${templateName}`);
  return {guidance, authorization};
}
