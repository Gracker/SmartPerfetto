// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as path from 'path';

import type {KnowledgeAuthorizationPromptData} from '../knowledge/knowledgePrompt';
import {findCredentialSpans} from '../security/secretPatterns';
import type {CodeAwareMode} from './codeAwareFeature';
import {codebaseHasActiveIndex, type CodebaseRef, type CodebaseScope} from './codebaseRegistry';
import {codebaseOnDemandAvailability, onDemandConsentFailure} from './onDemandSourceAccess';

/**
 * What a run can do with one selected codebase. `search` and `read_body` are
 * on-demand access to the live root; `index` and `graph` are optional
 * accelerators (an active retrieval index, a GitNexus graph).
 */
export interface SelectedCodebaseCapabilities {
  search: boolean;
  read_body: boolean;
  index: boolean;
  graph: boolean;
}

/** Name characters a provider prompt may carry per codebase; 32 selected stay well inside the prompt budget. */
const PROMPT_DISPLAY_NAME_MAX_CHARS = 64;

/**
 * A registered display name safe to show outside the owner's registry: no
 * control characters, nothing path- or URL-like (a name may be the absolute
 * root it was registered from), no credential, bounded. Undefined when the
 * name cannot be shown; the codebase id still identifies it.
 */
export function safeCodebaseDisplayName(value: unknown, maxChars = PROMPT_DISPLAY_NAME_MAX_CHARS): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (!trimmed || trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('://')) return undefined;
  if (findCredentialSpans(trimmed).length > 0) return undefined;
  return trimmed.slice(0, maxChars);
}

/**
 * One selected codebase as a run sees it. A selection the registry cannot
 * resolve in this scope keeps its id with every capability false.
 */
export interface SelectedCodebaseView {
  id: string;
  displayName?: string;
  kind?: CodebaseRef['kind'];
  /**
   * Whether the registration selects the whole root or only part of it. The
   * filters themselves are owner configuration the model is never shown (an
   * exclude glob can name the private directory it hides); search results are
   * admitted paths by construction.
   */
  pathScope?: 'whole_root' | 'registered_filters';
  capabilities: SelectedCodebaseCapabilities;
}

const NO_CAPABILITIES: SelectedCodebaseCapabilities = {search: false, read_body: false, index: false, graph: false};

function describeSelectedCodebase(ref: CodebaseRef, codeAwareMode: CodeAwareMode): SelectedCodebaseView {
  // The same root and consent checks the on-demand gate applies to every call.
  const rootAvailable = codebaseOnDemandAvailability(ref).available;
  const search = rootAvailable && !onDemandConsentFailure(ref, codeAwareMode);
  const displayName = safeCodebaseDisplayName(ref.displayName);
  return {
    id: ref.codebaseId,
    ...(displayName ? {displayName} : {}),
    kind: ref.kind,
    pathScope: ref.pathFilters?.length || ref.excludeGlobs?.length ? 'registered_filters' : 'whole_root',
    capabilities: {
      search,
      read_body: search && codeAwareMode === 'provider_send',
      index: codebaseHasActiveIndex(ref),
      graph: rootAvailable && fs.existsSync(path.join(ref.rootRealpath, '.gitnexus')),
    },
  };
}

/** The selected codebases this scope can resolve, in selection order. */
export function describeSelectedCodebases(
  registry: {get(codebaseId: string, scope?: CodebaseScope): CodebaseRef | undefined},
  codebaseIds: readonly string[],
  scope: CodebaseScope | undefined,
  codeAwareMode: CodeAwareMode,
): SelectedCodebaseView[] {
  if (codeAwareMode === 'off') return [];
  return codebaseIds.map(codebaseId => {
    const ref = registry.get(codebaseId, scope);
    return ref
      ? describeSelectedCodebase(ref, codeAwareMode)
      : {id: codebaseId, capabilities: {...NO_CAPABILITIES}};
  });
}

/**
 * The run's source facts for the system prompt: what each selected codebase
 * supports, and the source depth and budget the run starts with (the same
 * `budget` fields every source tool result reports as it is spent). The
 * selected knowledge bases ride along as their own nested field, which the
 * prompt renders as a separate `knowledge_authorization` segment.
 */
export interface SourceAuthorizationPromptData {
  codebases: SelectedCodebaseView[];
  depth?: string;
  budget?: {searchesLeft: number; readsLeft: number; locatesLeft: number; tokensLeft: number; maxReadLines: number};
  knowledgeAuthorization?: KnowledgeAuthorizationPromptData;
}

/**
 * The `source_authorization` payload the orchestrator prompt and Claude
 * sub-agents both carry. Without the run server's view (a prompt built with no
 * MCP server) the selection is listed with no capability claimed.
 */
export function sourceAuthorizationPayload(input: {
  codeAwareMode?: CodeAwareMode;
  codebaseIds?: readonly string[];
  sourceAuthorization?: SourceAuthorizationPromptData;
  evidenceAccess?: string;
}) {
  const mode = input.codeAwareMode ?? 'off';
  // Knowledge bases are their own segment, not a source capability.
  const {knowledgeAuthorization: _knowledge, ...sourceView} = input.sourceAuthorization ?? {
    codebases: mode === 'off' ? [] : (input.codebaseIds ?? []).map(id => ({id, capabilities: {...NO_CAPABILITIES}})),
  };
  return {
    mode,
    ...(input.evidenceAccess ? {evidenceAccess: input.evidenceAccess} : {}),
    ...sourceView,
  };
}
