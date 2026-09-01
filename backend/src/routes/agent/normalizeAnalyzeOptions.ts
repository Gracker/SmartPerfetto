// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {
  MAX_CODEBASE_IDS_PER_ANALYSIS,
  MAX_KNOWLEDGE_SOURCE_IDS_PER_ANALYSIS,
  type CodeAwareMode,
} from '../../services/codebase/codeAwareFeature';
import type {
  SelectionContext,
  SelectionTrackInfo,
  TracePairContext,
  TracePairLayout,
  TracePaneSide,
  TraceSource,
} from '../../agentv3/types';
import type {
  SceneAnalysisSelection,
  SceneAnalysisSelectionScope,
} from '../../agent/scene/types';
import type {OutputLanguage} from '../../agentv3/outputLanguage';
import {resolveEffectiveAnalysisMode} from '../../services/effectiveAnalysisMode';

export type AnalyzeEndpointKind = '/analyze' | '/sessions/:id/runs';
export type AnalyzePreset = 'smart';
export type AnalyzeMode = 'fast' | 'full' | 'auto';
export type SmartAnalyzeAction = 'preview' | 'analyze';

export interface NormalizedAnalyzeOptions {
  analysisMode: AnalyzeMode;
  /** Per-request presentation language. Pinned to the session on first use. */
  outputLanguage?: OutputLanguage;
  preset?: AnalyzePreset;
  codeAwareMode?: CodeAwareMode;
  codebaseIds?: string[];
  knowledgeSourceIds?: string[];
  generateTracks?: boolean;
  forceRefresh?: boolean;
  selectionContext?: SelectionContext;
  tracePairContext?: TracePairContext;
  blockedStrategyIds?: string[];
  taskTimeoutMs?: number;
  packageName?: string;
  timeRange?: unknown;
  adb?: unknown;
  estimatedSqlMs?: number;
  heavySkill?: boolean;
  longTask?: boolean;
  traceSizeBytes?: number;
  smartAction?: SmartAnalyzeAction;
  smartSelection?: SceneAnalysisSelection;
}

export class AnalyzeOptionsError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly httpStatus = 400,
    readonly details?: Readonly<Record<string, string | number>>,
  ) {
    super(message);
    this.name = 'AnalyzeOptionsError';
  }
}

export interface NormalizeAnalyzeOptionsContext {
  readonly endpoint: AnalyzeEndpointKind;
  readonly hasReferenceTraceId: boolean;
  readonly traceId?: string;
  readonly referenceTraceId?: string;
}

export function normalizeAnalyzeOptions(
  rawOptions: unknown,
  ctx: NormalizeAnalyzeOptionsContext,
): NormalizedAnalyzeOptions {
  if (
    rawOptions !== undefined &&
    (!rawOptions || typeof rawOptions !== 'object' || Array.isArray(rawOptions))
  ) {
    throw new AnalyzeOptionsError(
      'options must be an object',
      'INVALID_ANALYZE_OPTIONS',
    );
  }
  const raw = (rawOptions ?? {}) as Record<string, unknown>;

  rejectUnsupportedRuntimeControls(raw);

  const analysisMode = normalizeAnalysisMode(raw.analysisMode);
  const preset = normalizePreset(raw.preset);
  if (preset === 'smart' && ctx.hasReferenceTraceId) {
    throw new AnalyzeOptionsError(
      '智能分析暂不支持双 trace 对比',
      'SMART_COMPARISON_UNSUPPORTED',
    );
  }
  if (preset === 'smart' && ctx.endpoint === '/sessions/:id/runs') {
    throw new AnalyzeOptionsError(
      '智能分析仅支持新会话，不能作为已有会话的后续轮次运行',
      'SMART_CONTINUATION_UNSUPPORTED',
    );
  }

  const normalized: NormalizedAnalyzeOptions = { analysisMode };
  const outputLanguage = normalizeOutputLanguage(raw.outputLanguage);
  if (outputLanguage) normalized.outputLanguage = outputLanguage;
  if (preset) normalized.preset = preset;
  const smartAction = normalizeSmartAction(raw.smartAction, preset);
  if (smartAction) {
    normalized.smartAction = smartAction;
    if (smartAction === 'analyze') {
      normalized.smartSelection = normalizeSmartSelection(raw.smartSelection);
    }
  } else if (raw.smartSelection !== undefined) {
    throw new AnalyzeOptionsError(
      'smartSelection requires preset=smart',
      'SMART_SELECTION_REQUIRES_SMART_PRESET',
    );
  }

  const codebaseIds = normalizeBoundedAuthorizationIds(
    raw.codebaseIds,
    'codebaseIds',
    MAX_CODEBASE_IDS_PER_ANALYSIS,
  );
  if (codebaseIds.length > 0) normalized.codebaseIds = codebaseIds;

  const knowledgeSourceIds = normalizeBoundedAuthorizationIds(
    raw.knowledgeSourceIds,
    'knowledgeSourceIds',
    MAX_KNOWLEDGE_SOURCE_IDS_PER_ANALYSIS,
  );
  if (knowledgeSourceIds.length > 0) normalized.knowledgeSourceIds = knowledgeSourceIds;

  const codeAwareMode = normalizeCodeAwareMode(raw.codeAwareMode, codebaseIds.length > 0);
  if (codeAwareMode === 'off' && codebaseIds.length > 0) {
    throw new AnalyzeOptionsError(
      'codebaseIds require codeAwareMode=metadata_only or provider_send',
      'CODEBASE_IDS_REQUIRE_CODE_AWARE_MODE',
    );
  }
  if (codeAwareMode) normalized.codeAwareMode = codeAwareMode;

  // Source authorization is independent from per-run source activation. Only
  // comparison and private RAG remain intrinsically full-analysis contexts.
  normalized.analysisMode = resolveEffectiveAnalysisMode(normalized.analysisMode, {
    referenceTraceId: ctx.hasReferenceTraceId ? ctx.referenceTraceId ?? 'reference' : undefined,
    knowledgeSourceIds,
  });

  const blockedStrategyIds = normalizeStringArray(raw.blockedStrategyIds);
  if (blockedStrategyIds.length > 0) normalized.blockedStrategyIds = blockedStrategyIds;

  copyBoolean(raw, normalized, 'generateTracks');
  copyBoolean(raw, normalized, 'forceRefresh');
  copyBoolean(raw, normalized, 'heavySkill');
  copyBoolean(raw, normalized, 'longTask');
  copyNumber(raw, normalized, 'taskTimeoutMs');
  copyNumber(raw, normalized, 'estimatedSqlMs');
  copyNumber(raw, normalized, 'traceSizeBytes');
  copyString(raw, normalized, 'packageName');

  const selectionContext = normalizeSelectionContext(raw.selectionContext);
  if (selectionContext) normalized.selectionContext = selectionContext;
  if (ctx.hasReferenceTraceId) {
    const tracePairContext = normalizeTracePairContext(
      raw.tracePairContext,
      tracePairIdentityFromContext(ctx),
    );
    if (tracePairContext) normalized.tracePairContext = tracePairContext;
  }
  if (raw.timeRange && typeof raw.timeRange === 'object') {
    normalized.timeRange = raw.timeRange;
  }
  if (raw.adb && typeof raw.adb === 'object') {
    normalized.adb = raw.adb;
  }

  return normalized;
}

function normalizeOutputLanguage(value: unknown): OutputLanguage | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (value === 'en' || value === 'zh-CN') return value;
  throw new AnalyzeOptionsError(
    'outputLanguage must be en or zh-CN',
    'UNSUPPORTED_OUTPUT_LANGUAGE',
  );
}

function normalizeAnalysisMode(value: unknown): AnalyzeMode {
  if (value === undefined || value === null || value === '') return 'auto';
  if (value === 'fast' || value === 'full' || value === 'auto') return value;
  throw new AnalyzeOptionsError(
    'analysisMode must be fast, full, or auto',
    'UNSUPPORTED_ANALYSIS_MODE',
  );
}

const UNSUPPORTED_RUNTIME_CONTROLS = [
  'maxRounds',
  'confidenceThreshold',
  'maxNoProgressRounds',
  'maxFailureRounds',
  'maxConcurrentTasks',
] as const;

function rejectUnsupportedRuntimeControls(raw: Record<string, unknown>): void {
  const field = UNSUPPORTED_RUNTIME_CONTROLS.find(key =>
    Object.prototype.hasOwnProperty.call(raw, key));
  if (!field) return;
  throw new AnalyzeOptionsError(
    `${field} is not a provider-neutral runtime control`,
    'UNSUPPORTED_RUNTIME_CONTROL',
    400,
    {field},
  );
}

function normalizePreset(value: unknown): AnalyzePreset | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (value === 'smart') return 'smart';
  throw new AnalyzeOptionsError(
    `Unsupported analyze preset: ${String(value)}`,
    'UNSUPPORTED_ANALYZE_PRESET',
  );
}

function normalizeSmartAction(
  value: unknown,
  preset: AnalyzePreset | undefined,
): SmartAnalyzeAction | undefined {
  if (!preset) {
    if (value === undefined || value === null || value === '') return undefined;
    throw new AnalyzeOptionsError(
      'smartAction requires preset=smart',
      'SMART_ACTION_REQUIRES_SMART_PRESET',
    );
  }

  if (value === undefined || value === null || value === '') return 'preview';
  if (value === 'preview' || value === 'analyze') return value;
  throw new AnalyzeOptionsError(
    `Unsupported smartAction: ${String(value)}`,
    'UNSUPPORTED_SMART_ACTION',
  );
}

function normalizeSmartSelection(value: unknown): SceneAnalysisSelection {
  if (value === undefined || value === null || value === '') {
    return { scope: 'all' };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AnalyzeOptionsError(
      'smartSelection must be an object',
      'INVALID_SMART_SELECTION',
    );
  }

  const raw = value as Record<string, unknown>;
  const scope = normalizeSmartSelectionScope(raw.scope);
  const label = normalizeOptionalString(raw.label, 80);
  const reportId = normalizeOptionalString(raw.reportId, 128);
  const sceneSnapshotId = normalizeOptionalString(raw.sceneSnapshotId, 128);
  if (reportId && sceneSnapshotId && reportId !== sceneSnapshotId) {
    throw new AnalyzeOptionsError(
      'smartSelection.reportId and sceneSnapshotId must identify the same preview report',
      'INVALID_SMART_SELECTION',
    );
  }
  const common = {
    ...(label ? { label } : {}),
    ...(reportId ? { reportId } : {}),
    ...(sceneSnapshotId ? { sceneSnapshotId } : {}),
  };
  if (scope === 'all') {
    return { scope, ...common };
  }

  if (scope === 'scene_types') {
    const sceneTypes = normalizeStringArray(raw.sceneTypes).slice(0, 64);
    if (sceneTypes.length === 0) {
      throw new AnalyzeOptionsError(
        'smartSelection.sceneTypes is required for scene_types scope',
        'INVALID_SMART_SELECTION',
      );
    }
    return { scope, sceneTypes, ...common };
  }

  const sceneIds = normalizeStringArray(raw.sceneIds).slice(0, 128);
  if (sceneIds.length === 0) {
    throw new AnalyzeOptionsError(
      'smartSelection.sceneIds is required for scene_ids scope',
      'INVALID_SMART_SELECTION',
    );
  }
  return { scope, sceneIds, ...common };
}

function normalizeSmartSelectionScope(value: unknown): SceneAnalysisSelectionScope {
  if (value === 'all' || value === 'scene_types' || value === 'scene_ids') {
    return value;
  }
  throw new AnalyzeOptionsError(
    `Unsupported smartSelection.scope: ${String(value)}`,
    'INVALID_SMART_SELECTION',
  );
}

function normalizeCodeAwareMode(value: unknown, hasCodebases: boolean): CodeAwareMode | undefined {
  if (value === 'off' || value === 'metadata_only' || value === 'provider_send') {
    return value;
  }
  if (value === undefined || value === null || value === '') {
    return hasCodebases ? 'metadata_only' : undefined;
  }
  throw new AnalyzeOptionsError(
    `Unsupported codeAwareMode: ${String(value)}`,
    'UNSUPPORTED_CODE_AWARE_MODE',
  );
}

function normalizeBoundedAuthorizationIds(
  value: unknown,
  field: 'codebaseIds' | 'knowledgeSourceIds',
  maxItems: number,
): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some(
    item => typeof item !== 'string' || item.trim().length === 0,
  )) {
    throw new AnalyzeOptionsError(
      `${field} must be an array of non-empty strings`,
      'INVALID_ANALYSIS_SOURCE_ALLOWLIST',
      400,
      {field},
    );
  }
  const normalized = normalizeStringArray(value);
  if (normalized.length > maxItems) {
    throw new AnalyzeOptionsError(
      `${field} exceeds the maximum of ${maxItems} unique ids`,
      'ANALYSIS_SOURCE_ALLOWLIST_TOO_LARGE',
      400,
      {field, maxItems},
    );
  }
  return normalized;
}

function safeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function normalizeSelectionTrackInfo(
  value: unknown,
  index: number,
): SelectionTrackInfo {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AnalyzeOptionsError(
      'area selectionContext tracks must contain objects',
      'INVALID_SELECTION_CONTEXT',
      400,
      {index},
    );
  }
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.uri !== 'string' ||
    raw.uri.trim().length === 0 ||
    raw.uri.trim().length > 512
  ) {
    throw new AnalyzeOptionsError(
      'area selectionContext track uri must be a non-empty bounded string',
      'INVALID_SELECTION_CONTEXT',
      400,
      {index},
    );
  }
  for (const key of ['utid', 'upid', 'cpu'] as const) {
    if (raw[key] !== undefined && !safeNonNegativeInteger(raw[key])) {
      throw new AnalyzeOptionsError(
        `area selectionContext track ${key} must be a non-negative safe integer`,
        'INVALID_SELECTION_CONTEXT',
        400,
        {index},
      );
    }
  }
  if (
    raw.kind !== undefined &&
    (typeof raw.kind !== 'string' ||
      raw.kind.trim().length === 0 ||
      raw.kind.trim().length > 128)
  ) {
    throw new AnalyzeOptionsError(
      'area selectionContext track kind must be a non-empty bounded string',
      'INVALID_SELECTION_CONTEXT',
      400,
      {index},
    );
  }
  return {
    uri: raw.uri.trim(),
    ...(safeNonNegativeInteger(raw.utid) ? {utid: raw.utid} : {}),
    ...(safeNonNegativeInteger(raw.upid) ? {upid: raw.upid} : {}),
    ...(safeNonNegativeInteger(raw.cpu) ? {cpu: raw.cpu} : {}),
    ...(typeof raw.kind === 'string' ? {kind: raw.kind.trim()} : {}),
  };
}

/** Strict shared parser for every HTTP surface that accepts a UI selection. */
export function normalizeSelectionContext(value: unknown): SelectionContext | undefined {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AnalyzeOptionsError(
      'selectionContext must be an object',
      'INVALID_SELECTION_CONTEXT',
    );
  }
  const raw = value as Record<string, unknown>;
  if (raw.kind === 'area') {
    if (
      !safeNonNegativeInteger(raw.startNs) ||
      !safeNonNegativeInteger(raw.endNs) ||
      raw.endNs <= raw.startNs
    ) {
      throw new AnalyzeOptionsError(
        'area selectionContext requires safe integer startNs < endNs',
        'INVALID_SELECTION_CONTEXT',
      );
    }
    if (
      raw.durationNs !== undefined &&
      (!safeNonNegativeInteger(raw.durationNs) || raw.durationNs > raw.endNs - raw.startNs)
    ) {
      throw new AnalyzeOptionsError(
        'area selectionContext.durationNs must fit the selected range',
        'INVALID_SELECTION_CONTEXT',
      );
    }
    if (
      raw.source !== undefined &&
      raw.source !== 'area_selection' &&
      raw.source !== 'visible_window'
    ) {
      throw new AnalyzeOptionsError(
        'area selectionContext.source is unsupported',
        'INVALID_SELECTION_CONTEXT',
      );
    }
    if (raw.tracks !== undefined && (!Array.isArray(raw.tracks) || raw.tracks.length > 256)) {
      throw new AnalyzeOptionsError(
        'area selectionContext.tracks must be a bounded array',
        'INVALID_SELECTION_CONTEXT',
      );
    }
    return {
      kind: 'area',
      ...(raw.source ? {source: raw.source as 'area_selection' | 'visible_window'} : {}),
      startNs: raw.startNs,
      endNs: raw.endNs,
      ...(raw.durationNs !== undefined ? {durationNs: raw.durationNs as number} : {}),
      ...(Array.isArray(raw.tracks)
        ? {tracks: raw.tracks.map(normalizeSelectionTrackInfo)}
        : {}),
      ...(safeNonNegativeInteger(raw.trackCount) ? {trackCount: raw.trackCount} : {}),
    };
  }
  if (raw.kind === 'track_event') {
    if (!safeNonNegativeInteger(raw.eventId) || !safeNonNegativeInteger(raw.ts)) {
      throw new AnalyzeOptionsError(
        'track_event selectionContext requires safe integer eventId and ts',
        'INVALID_SELECTION_CONTEXT',
      );
    }
    if (raw.dur !== undefined && !safeNonNegativeInteger(raw.dur)) {
      throw new AnalyzeOptionsError(
        'track_event selectionContext.dur must be a non-negative safe integer',
        'INVALID_SELECTION_CONTEXT',
      );
    }
    if (raw.source !== undefined && raw.source !== 'track_event_selection') {
      throw new AnalyzeOptionsError(
        'track_event selectionContext.source is unsupported',
        'INVALID_SELECTION_CONTEXT',
      );
    }
    const trackUri = normalizeOptionalString(raw.trackUri, 512);
    return {
      kind: 'track_event',
      ...(raw.source ? {source: 'track_event_selection' as const} : {}),
      eventId: raw.eventId,
      ts: raw.ts,
      ...(raw.dur !== undefined ? {dur: raw.dur as number} : {}),
      ...(trackUri ? {trackUri} : {}),
    };
  }
  throw new AnalyzeOptionsError(
    `Unsupported selectionContext.kind: ${String(raw.kind)}`,
    'INVALID_SELECTION_CONTEXT',
  );
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const text = item.trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

const TRACE_PANE_SIDES = new Set<TracePaneSide>(['left', 'right', 'top', 'bottom']);
const TRACE_PAIR_LAYOUTS = new Set<TracePairLayout>(['horizontal', 'vertical']);
const TRACE_SOURCES = new Set<TraceSource>(['current', 'reference']);
const HORIZONTAL_TRACE_PANE_SIDES = new Set<TracePaneSide>(['left', 'right']);
const VERTICAL_TRACE_PANE_SIDES = new Set<TracePaneSide>(['top', 'bottom']);

interface TracePairIdentity {
  readonly currentTraceId?: string;
  readonly referenceTraceId?: string;
}

function tracePairIdentityFromContext(ctx: NormalizeAnalyzeOptionsContext): TracePairIdentity {
  return {
    ...(ctx.traceId ? { currentTraceId: ctx.traceId } : {}),
    ...(ctx.referenceTraceId ? { referenceTraceId: ctx.referenceTraceId } : {}),
  };
}

function normalizeTracePairContext(
  value: unknown,
  identity: TracePairIdentity,
): TracePairContext | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== 1) return undefined;

  const layout = normalizeTracePairLayout(raw.layout);
  const primarySide = normalizeTracePaneSide(raw.primarySide);
  const referenceSide = normalizeTracePaneSide(raw.referenceSide);
  if (!layout || !primarySide || !referenceSide) return undefined;
  if (primarySide === referenceSide) return undefined;
  if (!tracePaneSideMatchesLayout(layout, primarySide)) return undefined;
  if (!tracePaneSideMatchesLayout(layout, referenceSide)) return undefined;

  const panes = Array.isArray(raw.panes)
    ? raw.panes
        .slice(0, 4)
        .map(normalizeTracePairPane)
        .filter((pane): pane is TracePairContext['panes'][number] => pane !== undefined)
    : [];
  const currentPane = panes.find(pane => pane.traceSide === 'current');
  const referencePane = panes.find(pane => pane.traceSide === 'reference');
  if (!currentPane || !referencePane) return undefined;
  if (currentPane.side !== primarySide || referencePane.side !== referenceSide) return undefined;
  if (!tracePairPaneMatchesIdentity(currentPane, identity.currentTraceId)) return undefined;
  if (!tracePairPaneMatchesIdentity(referencePane, identity.referenceTraceId)) return undefined;

  const activeSide = normalizeTracePaneSide(raw.activeSide);
  const layoutActiveSide = activeSide && tracePaneSideMatchesLayout(layout, activeSide)
    ? activeSide
    : undefined;
  const workspaceOpen = typeof raw.workspaceOpen === 'boolean'
    ? raw.workspaceOpen
    : undefined;
  const splitPercent = normalizeTracePairSplitPercent(raw.splitPercent);
  const maximizedTraceSide = normalizeTraceSource(raw.maximizedTraceSide);
  const minimizedTraceSides = normalizeTraceSources(raw.minimizedTraceSides);
  return {
    schemaVersion: 1,
    layout,
    primarySide,
    referenceSide,
    ...(layoutActiveSide ? { activeSide: layoutActiveSide } : {}),
    ...(workspaceOpen !== undefined ? { workspaceOpen } : {}),
    ...(splitPercent !== undefined ? { splitPercent } : {}),
    ...(maximizedTraceSide ? { maximizedTraceSide } : {}),
    ...(minimizedTraceSides.length > 0 ? { minimizedTraceSides } : {}),
    ...normalizeTracePairAliases(raw.aliases),
    panes,
  };
}

function tracePaneSideMatchesLayout(layout: TracePairLayout, side: TracePaneSide): boolean {
  return layout === 'horizontal'
    ? HORIZONTAL_TRACE_PANE_SIDES.has(side)
    : VERTICAL_TRACE_PANE_SIDES.has(side);
}

function tracePairPaneMatchesIdentity(
  pane: TracePairContext['panes'][number],
  expectedTraceId: string | undefined,
): boolean {
  return expectedTraceId === undefined || pane.traceId === expectedTraceId;
}

function normalizeTracePairPane(value: unknown): TracePairContext['panes'][number] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const side = normalizeTracePaneSide(raw.side);
  const traceSide = normalizeTraceSource(raw.traceSide);
  const traceId = normalizeOptionalString(raw.traceId, 256);
  if (!side || !traceSide || !traceId) return undefined;

  const traceName = normalizeOptionalString(raw.traceName, 256);
  const traceFingerprint = normalizeOptionalString(raw.traceFingerprint, 256);
  const active = typeof raw.active === 'boolean' ? raw.active : undefined;
  const visualState = raw.visualState === 'live' || raw.visualState === 'context_only'
    ? raw.visualState
    : undefined;

  return {
    side,
    traceSide,
    traceId,
    ...(traceName ? { traceName } : {}),
    ...(traceFingerprint ? { traceFingerprint } : {}),
    ...(active !== undefined ? { active } : {}),
    ...(visualState ? { visualState } : {}),
  };
}

function normalizeTracePaneSide(value: unknown): TracePaneSide | undefined {
  return typeof value === 'string' && TRACE_PANE_SIDES.has(value as TracePaneSide)
    ? value as TracePaneSide
    : undefined;
}

function normalizeTracePairLayout(value: unknown): TracePairLayout | undefined {
  return typeof value === 'string' && TRACE_PAIR_LAYOUTS.has(value as TracePairLayout)
    ? value as TracePairLayout
    : undefined;
}

function normalizeTraceSource(value: unknown): TraceSource | undefined {
  return typeof value === 'string' && TRACE_SOURCES.has(value as TraceSource)
    ? value as TraceSource
    : undefined;
}

function normalizeTraceSources(value: unknown): TraceSource[] {
  if (!Array.isArray(value)) return [];
  const out: TraceSource[] = [];
  for (const item of value.slice(0, 2)) {
    const traceSource = normalizeTraceSource(item);
    if (traceSource && !out.includes(traceSource)) out.push(traceSource);
  }
  return out;
}

function normalizeTracePairSplitPercent(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.min(82, Math.max(18, Math.round(value)));
}

function normalizeTracePairAliases(value: unknown): { aliases?: Record<string, TraceSource> } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const aliases: Record<string, TraceSource> = {};
  for (const [key, rawTraceSide] of Object.entries(raw).slice(0, 24)) {
    const alias = normalizeOptionalString(key, 32);
    const traceSide = normalizeTraceSource(rawTraceSide);
    if (!alias || !traceSide) continue;
    aliases[alias] = traceSide;
  }
  return Object.keys(aliases).length > 0 ? { aliases } : {};
}

type BooleanAnalyzeOptionKey = 'generateTracks' | 'forceRefresh' | 'heavySkill' | 'longTask';
type NumberAnalyzeOptionKey =
  | 'taskTimeoutMs'
  | 'estimatedSqlMs'
  | 'traceSizeBytes';
type StringAnalyzeOptionKey = 'packageName';

function copyBoolean(
  raw: Record<string, unknown>,
  out: NormalizedAnalyzeOptions,
  key: BooleanAnalyzeOptionKey,
): void {
  const value = raw[key];
  if (typeof value !== 'boolean') return;
  assignBooleanOption(out, key, value);
}

function copyNumber(
  raw: Record<string, unknown>,
  out: NormalizedAnalyzeOptions,
  key: NumberAnalyzeOptionKey,
): void {
  const value = raw[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) return;
  assignNumberOption(out, key, value);
}

function copyString(
  raw: Record<string, unknown>,
  out: NormalizedAnalyzeOptions,
  key: StringAnalyzeOptionKey,
): void {
  const value = raw[key];
  if (typeof value !== 'string' || !value.trim()) return;
  assignStringOption(out, key, value.trim());
}

function assignBooleanOption(
  out: NormalizedAnalyzeOptions,
  key: BooleanAnalyzeOptionKey,
  value: boolean,
): void {
  switch (key) {
    case 'generateTracks':
      out.generateTracks = value;
      return;
    case 'forceRefresh':
      out.forceRefresh = value;
      return;
    case 'heavySkill':
      out.heavySkill = value;
      return;
    case 'longTask':
      out.longTask = value;
      return;
  }
}

function assignNumberOption(
  out: NormalizedAnalyzeOptions,
  key: NumberAnalyzeOptionKey,
  value: number,
): void {
  switch (key) {
    case 'taskTimeoutMs':
      out.taskTimeoutMs = value;
      return;
    case 'estimatedSqlMs':
      out.estimatedSqlMs = value;
      return;
    case 'traceSizeBytes':
      out.traceSizeBytes = value;
      return;
  }
}

function assignStringOption(
  out: NormalizedAnalyzeOptions,
  key: StringAnalyzeOptionKey,
  value: string,
): void {
  switch (key) {
    case 'packageName':
      out.packageName = value;
      return;
  }
}

function normalizeOptionalString(value: unknown, maxLen: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text) return undefined;
  return text.length > maxLen ? text.slice(0, maxLen) : text;
}
