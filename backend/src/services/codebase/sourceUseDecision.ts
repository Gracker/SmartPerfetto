// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {createHash} from 'crypto';
import * as path from 'path';

import {DEFAULT_OUTPUT_LANGUAGE, type OutputLanguage} from '../../agentv3/outputLanguage';
import {loadPromptTemplate, renderTemplate} from '../../agentv3/strategyLoader';
import type {CodeAwareMode} from './codeAwareFeature';
import type {CodebaseKind} from './codebaseRegistry';
import {sourceExtensionsForKind} from './sourceSelectionPolicy';

export const SOURCE_USE_DECISION_SCHEMA_VERSION = 'source_use_decision@1' as const;

export type SourceUseStatus =
  | 'pending'
  | 'not_needed'
  | 'disallowed'
  | 'no_queryable_anchor'
  | 'attempted'
  | 'located'
  | 'corroborated'
  | 'ambiguous_candidates'
  | 'not_found_complete'
  | 'search_incomplete'
  | 'unverified';

export type SourceMechanismStatus =
  | 'corroborated'
  | 'compatible'
  | 'ambiguous'
  | 'unverified';

export interface SourceReferenceV1 {
  id: string;
  chunkId?: string;
  referenceId?: string;
  codebaseId: string;
  filePath: string;
  lineRange?: {start: number; end: number};
  symbol?: string;
  buildId?: string;
  commitHash?: string;
  sourceGeneration?: string;
  lookupKind: 'metadata' | 'body' | 'indexed' | 'graph';
}

export interface SourceUseDecisionV1 {
  schemaVersion: typeof SOURCE_USE_DECISION_SCHEMA_VERSION;
  codeAwareMode: 'metadata_only' | 'provider_send';
  selectedCodebaseIds: string[];
  status: SourceUseStatus;
  reasonCode?: Exclude<SourceUseStatus, 'pending' | 'attempted' | 'located' | 'corroborated'>;
  attemptedTools: string[];
  queriedCodebaseIds: string[];
  usedCodebaseIds: string[];
  coverageComplete?: boolean;
  incompleteReasons?: string[];
  references: SourceReferenceV1[];
}

export interface SourceClaimBindingV1 {
  claimId: string;
  mechanismStatus: SourceMechanismStatus;
  sourceReferenceIds: string[];
  traceEvidenceRefIds: string[];
  reason?: string;
}

export const MAX_SOURCE_REFERENCE_COUNT = 100;
export const MAX_SOURCE_REFERENCE_PATH_LENGTH = 512;

const SOURCE_USE_TOOL_DESCRIPTION_START = '<!-- tool-description:start -->';
const SOURCE_USE_TOOL_DESCRIPTION_END = '<!-- tool-description:end -->';
const SOURCE_USE_TOOL_DESCRIPTION_MAX_CHARS = 240;

interface RenderedSourceUseDecisionAsset {
  prompt: string;
  toolDescription: string;
}

function renderSourceUseDecisionAsset(input: {
  codeAwareMode: Exclude<CodeAwareMode, 'off'>;
  codebaseIds: readonly string[];
  outputLanguage: OutputLanguage;
}): RenderedSourceUseDecisionAsset {
  const templateName = input.outputLanguage === 'en'
    ? 'prompt-source-use-decision-en'
    : 'prompt-source-use-decision-zh';
  const template = loadPromptTemplate(templateName);
  if (!template?.trim()) {
    throw new Error(`Missing required source-use decision prompt template: ${templateName}`);
  }
  const rendered = renderTemplate(template, {
    codeAwareMode: input.codeAwareMode,
    codebaseIds: input.codebaseIds.join(', '),
  });
  const startCount = rendered.split(SOURCE_USE_TOOL_DESCRIPTION_START).length - 1;
  const endCount = rendered.split(SOURCE_USE_TOOL_DESCRIPTION_END).length - 1;
  if (startCount !== 1 || endCount !== 1) {
    throw new Error(`Invalid source-use tool-description markers: ${templateName}`);
  }
  const descriptionStart = rendered.indexOf(SOURCE_USE_TOOL_DESCRIPTION_START);
  const descriptionEnd = rendered.indexOf(SOURCE_USE_TOOL_DESCRIPTION_END);
  if (descriptionEnd <= descriptionStart) {
    throw new Error(`Invalid source-use tool-description marker order: ${templateName}`);
  }
  const toolDescription = rendered
    .slice(descriptionStart + SOURCE_USE_TOOL_DESCRIPTION_START.length, descriptionEnd)
    .trim();
  if (!toolDescription || toolDescription.length > SOURCE_USE_TOOL_DESCRIPTION_MAX_CHARS) {
    throw new Error(`Invalid source-use tool description length: ${templateName}`);
  }
  return {
    toolDescription,
    prompt: `${toolDescription}\n\n${rendered
      .slice(descriptionEnd + SOURCE_USE_TOOL_DESCRIPTION_END.length)
      .trim()}`.trim(),
  };
}

export function loadSourceUseDecisionPrompt(input: {
  codeAwareMode?: CodeAwareMode;
  codebaseIds?: readonly string[];
  outputLanguage?: OutputLanguage;
}): string | undefined {
  if (!input.codeAwareMode || input.codeAwareMode === 'off' || !input.codebaseIds?.length) {
    return undefined;
  }
  return renderSourceUseDecisionAsset({
    codeAwareMode: input.codeAwareMode,
    codebaseIds: input.codebaseIds,
    outputLanguage: input.outputLanguage ?? DEFAULT_OUTPUT_LANGUAGE,
  }).prompt;
}

export function loadSourceUseDecisionToolDescription(input: {
  codeAwareMode?: CodeAwareMode;
  codebaseIds?: readonly string[];
  outputLanguage?: OutputLanguage;
}): string | undefined {
  if (!input.codeAwareMode || input.codeAwareMode === 'off' || !input.codebaseIds?.length) {
    return undefined;
  }
  return renderSourceUseDecisionAsset({
    codeAwareMode: input.codeAwareMode,
    codebaseIds: input.codebaseIds,
    outputLanguage: input.outputLanguage ?? DEFAULT_OUTPUT_LANGUAGE,
  }).toolDescription;
}

const MAX_SOURCE_IDENTIFIER_LENGTH = 160;
const MAX_SOURCE_REFERENCE_ID_LENGTH = 256;
const MAX_SOURCE_SYMBOL_LENGTH = 256;
const MAX_SOURCE_TOOL_COUNT = 64;
const MAX_SOURCE_INCOMPLETE_REASON_COUNT = 20;
const MAX_SOURCE_LINE = 2_147_483_647;
const LEGACY_REFERENCE_ONLY_EXTENSIONS = ['.sql', '.md'] as const;
const CODEBASE_KINDS = [
  'app_source',
  'aosp',
  'kernel_source',
  'oem_sdk',
] as const satisfies readonly CodebaseKind[];
const SOURCE_LOOKUP_KINDS: ReadonlySet<SourceReferenceV1['lookupKind']> = new Set([
  'metadata',
  'body',
  'indexed',
  'graph',
]);
const SOURCE_USE_STATUSES: ReadonlySet<SourceUseStatus> = new Set([
  'pending',
  'not_needed',
  'disallowed',
  'no_queryable_anchor',
  'attempted',
  'located',
  'corroborated',
  'ambiguous_candidates',
  'not_found_complete',
  'search_incomplete',
  'unverified',
]);
const SOURCE_USE_REASON_CODES = new Set<NonNullable<SourceUseDecisionV1['reasonCode']>>([
  'not_needed',
  'disallowed',
  'no_queryable_anchor',
  'ambiguous_candidates',
  'not_found_complete',
  'search_incomplete',
  'unverified',
]);
const SUPPORTED_SOURCE_EXTENSIONS = new Set(
  [...CODEBASE_KINDS.flatMap(kind => sourceExtensionsForKind(kind)), ...LEGACY_REFERENCE_ONLY_EXTENSIONS]
    .map(extension => extension.toLocaleLowerCase('en-US')),
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function strictIdentifier(value: unknown, maxLength = MAX_SOURCE_IDENTIFIER_LENGTH): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized.length > 0 &&
    normalized.length <= maxLength &&
    /^[A-Za-z0-9][A-Za-z0-9_.:@+-]*$/.test(normalized)
    ? normalized
    : undefined;
}

function boundedSymbol(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > MAX_SOURCE_SYMBOL_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    return undefined;
  }
  return normalized;
}

function boundedLineRange(value: unknown): SourceReferenceV1['lineRange'] {
  if (!isRecord(value)) return undefined;
  const start = Number(value.start);
  const end = Number(value.end);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 1 ||
    end < start ||
    end > MAX_SOURCE_LINE
  ) {
    return undefined;
  }
  return {start, end};
}

function uniqueBoundedIdentifiers(
  value: unknown,
  maxCount: number,
  maxLength = MAX_SOURCE_IDENTIFIER_LENGTH,
): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    const identifier = strictIdentifier(candidate, maxLength);
    if (!identifier || seen.has(identifier)) continue;
    seen.add(identifier);
    result.push(identifier);
    if (result.length >= maxCount) break;
  }
  return result;
}

export function normalizeSourceReferencePath(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  let normalized = value.trim().replace(/\\/g, '/');
  while (normalized.startsWith('./')) normalized = normalized.slice(2);
  if (
    !normalized ||
    normalized.length > MAX_SOURCE_REFERENCE_PATH_LENGTH ||
    normalized.startsWith('/') ||
    /^[a-z]:\//i.test(normalized) ||
    normalized.includes('://') ||
    /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    return undefined;
  }
  const segments = normalized.split('/');
  if (
    segments.some(segment =>
      !segment ||
      segment === '.' ||
      segment === '..' ||
      !/^[A-Za-z0-9_.@+,-]+$/.test(segment))
  ) {
    return undefined;
  }
  const extension = path.posix.extname(normalized).toLocaleLowerCase('en-US');
  return SUPPORTED_SOURCE_EXTENSIONS.has(extension) ? normalized : undefined;
}

function sourceReferenceId(reference: Omit<SourceReferenceV1, 'id'>): string {
  const identity = [
    reference.lookupKind,
    reference.codebaseId,
    reference.filePath,
    reference.chunkId ?? '',
    reference.referenceId ?? '',
    reference.lineRange?.start ?? '',
    reference.lineRange?.end ?? '',
    reference.symbol ?? '',
    reference.buildId ?? '',
    reference.commitHash ?? '',
    reference.sourceGeneration ?? '',
  ];
  return `source-ref-v1-${createHash('sha256')
    .update(JSON.stringify(identity))
    .digest('hex')
    .slice(0, 24)}`;
}

export function sanitizeSourceReference(value: unknown): SourceReferenceV1 | undefined {
  if (!isRecord(value)) return undefined;
  const chunkId = strictIdentifier(value.chunkId, MAX_SOURCE_REFERENCE_ID_LENGTH);
  const referenceId = strictIdentifier(value.referenceId, MAX_SOURCE_REFERENCE_ID_LENGTH);
  const codebaseId = strictIdentifier(value.codebaseId);
  const filePath = normalizeSourceReferencePath(value.filePath);
  const lookupKind = typeof value.lookupKind === 'string' &&
    SOURCE_LOOKUP_KINDS.has(value.lookupKind as SourceReferenceV1['lookupKind'])
    ? value.lookupKind as SourceReferenceV1['lookupKind']
    : undefined;
  if (!codebaseId || !filePath || !lookupKind) return undefined;

  const lineRange = boundedLineRange(value.lineRange);
  const symbol = boundedSymbol(value.symbol);
  const buildId = strictIdentifier(value.buildId, MAX_SOURCE_REFERENCE_ID_LENGTH);
  const commitHash = typeof value.commitHash === 'string' &&
    /^[a-f0-9]{7,128}$/i.test(value.commitHash.trim())
    ? value.commitHash.trim()
    : undefined;
  const sourceGeneration = strictIdentifier(value.sourceGeneration, MAX_SOURCE_REFERENCE_ID_LENGTH);
  const referenceWithoutId: Omit<SourceReferenceV1, 'id'> = {
    ...(chunkId ? {chunkId} : {}),
    ...(referenceId ? {referenceId} : {}),
    codebaseId,
    filePath,
    ...(lineRange ? {lineRange} : {}),
    ...(symbol ? {symbol} : {}),
    ...(buildId ? {buildId} : {}),
    ...(commitHash ? {commitHash} : {}),
    ...(sourceGeneration ? {sourceGeneration} : {}),
    lookupKind,
  };
  return {
    id: sourceReferenceId(referenceWithoutId),
    ...referenceWithoutId,
  };
}

export function sanitizeSourceReferences(value: unknown): SourceReferenceV1[] {
  if (!Array.isArray(value)) return [];
  const references: SourceReferenceV1[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    const reference = sanitizeSourceReference(candidate);
    if (!reference || seen.has(reference.id)) continue;
    seen.add(reference.id);
    references.push(reference);
    if (references.length >= MAX_SOURCE_REFERENCE_COUNT) break;
  }
  return references;
}

export function sanitizeSourceIncompleteReason(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized.length > 0 &&
    normalized.length <= 128 &&
    /^[a-z][a-z0-9_.:-]*$/.test(normalized)
    ? normalized
    : undefined;
}

export function sanitizeSourceUseDecision(
  value: unknown,
  currentSelectedCodebaseIds?: readonly string[],
): SourceUseDecisionV1 | undefined {
  if (!isRecord(value) || value.schemaVersion !== SOURCE_USE_DECISION_SCHEMA_VERSION) {
    return undefined;
  }
  const codeAwareMode = value.codeAwareMode === 'metadata_only' || value.codeAwareMode === 'provider_send'
    ? value.codeAwareMode
    : undefined;
  const declaredStatus = typeof value.status === 'string' && SOURCE_USE_STATUSES.has(value.status as SourceUseStatus)
    ? value.status as SourceUseStatus
    : undefined;
  if (!codeAwareMode || !declaredStatus) return undefined;
  const status = codeAwareMode === 'metadata_only' && declaredStatus === 'corroborated'
    ? 'located'
    : declaredStatus;

  const declaredCodebaseIds = uniqueBoundedIdentifiers(
    value.selectedCodebaseIds,
    MAX_SOURCE_REFERENCE_COUNT,
  ).sort();
  const currentSelection = currentSelectedCodebaseIds === undefined
    ? undefined
    : new Set(uniqueBoundedIdentifiers(
      currentSelectedCodebaseIds,
      MAX_SOURCE_REFERENCE_COUNT,
    ));
  const selectedCodebaseIds = currentSelection
    ? declaredCodebaseIds.filter(codebaseId => currentSelection.has(codebaseId))
    : declaredCodebaseIds;
  const selected = new Set(selectedCodebaseIds);
  const queriedCodebaseIds = uniqueBoundedIdentifiers(
    value.queriedCodebaseIds,
    MAX_SOURCE_REFERENCE_COUNT,
  ).filter(codebaseId => selected.has(codebaseId));
  const usedCodebaseIds = uniqueBoundedIdentifiers(
    value.usedCodebaseIds,
    MAX_SOURCE_REFERENCE_COUNT,
  ).filter(codebaseId => selected.has(codebaseId));
  const references = sanitizeSourceReferences(value.references)
    .filter(reference => selected.has(reference.codebaseId));
  const reasonCode = SOURCE_USE_REASON_CODES.has(status as NonNullable<SourceUseDecisionV1['reasonCode']>) &&
    typeof value.reasonCode === 'string' &&
    SOURCE_USE_REASON_CODES.has(value.reasonCode as NonNullable<SourceUseDecisionV1['reasonCode']>)
    ? value.reasonCode as NonNullable<SourceUseDecisionV1['reasonCode']>
    : undefined;
  const incompleteReasons = Array.isArray(value.incompleteReasons)
    ? [...new Set(value.incompleteReasons
      .map(sanitizeSourceIncompleteReason)
      .filter((reason): reason is string => Boolean(reason)))]
      .slice(0, MAX_SOURCE_INCOMPLETE_REASON_COUNT)
    : [];
  return {
    schemaVersion: SOURCE_USE_DECISION_SCHEMA_VERSION,
    codeAwareMode,
    selectedCodebaseIds,
    status,
    ...(reasonCode ? {reasonCode} : {}),
    attemptedTools: uniqueBoundedIdentifiers(
      value.attemptedTools,
      MAX_SOURCE_TOOL_COUNT,
      128,
    ),
    queriedCodebaseIds,
    usedCodebaseIds,
    ...(typeof value.coverageComplete === 'boolean'
      ? {coverageComplete: value.coverageComplete}
      : {}),
    ...(incompleteReasons.length > 0 ? {incompleteReasons} : {}),
    references,
  };
}
