// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {createRuntimeToolResult, runtimeToolReceiptMetadata} from '../agentRuntime/runtimeToolResult';
import {assertSceneRuntimeCapability} from '../agent/scene/sceneRuntimeBinding';
import {sceneRunState, type SceneRunContext} from '../agent/scene/sceneRunContext';
import {projectSceneRunCandidate} from '../agent/scene/sceneTimelineProjection';
import {proposeSceneTimeline, sceneProposalActionRequired} from '../agent/scene/sceneTimelineProposal';
import {createSceneAcquisitionPolicy} from '../agent/scene/sceneAcquisitionPolicy';
import {sceneTimelineProposalToolShape} from '../agent/scene/sceneTimelineContract';
import type {RuntimeToolObserver} from '../agentRuntime/runtimeToolObserver';
import type {AnalysisHistoryReader} from '../agentRuntime/analysisHistory';
import {renderRequiredLocalizedStrategyTemplate} from './localizedStrategyTemplate';
import { tool as sdkTool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import type { TraceProcessorService } from '../services/traceProcessorService';
import type { SkillExecutor } from '../services/skillEngine/skillExecutor';
import {
  createSkillAnalysisAdapter,
  type SkillRegistryView,
} from '../services/skillEngine/skillAnalysisAdapter';
import { skillRegistry } from '../services/skillEngine/skillLoader';
import { getWorkspaceSkillRegistry } from '../services/skillPacks/workspaceSkillRegistryProvider';
import type {RunManifestAttributionSink} from '../types/selfEvolution';
import {canonicalContentHash} from '../services/selfEvolution/canonicalJson';
import {
  currentRunManifestAttributionSink,
  resolveRunManifestAttributionSink,
} from '../services/selfEvolution/runManifestLifecycle';
import {buildSkillRegistryAttribution} from '../services/selfEvolution/skillFingerprint';
import {
  currentEffectiveRuntimeRegistrySnapshot,
  type ReadonlyStrategyRegistrySnapshot,
} from '../services/selfEvolution/effectiveRuntimeRegistryContext';
import {
  commitEvaluationExposureSince,
  currentEvaluationInjectionContract,
  discardPendingEvaluationExposures,
  evaluationExposureCursor,
  registerEvaluationInjection,
} from '../services/selfEvolution/evaluationInjectionContext';
import {
  currentEvaluationTelemetryActive,
  recordEvaluationToolCall,
} from '../services/selfEvolution/evaluationTelemetry';
import { createArchitectureDetector } from '../agent/detectors/architectureDetector';
import {resolveRegisteredDrillDownSkillParams} from '../agent/core/drillDownEntityResolver';
import {findDrillDownSkillConfig} from '../agent/config/drillDownRegistry';
import { createDataEnvelope, displayResultToEnvelope } from '../types/dataContract';
import type { ColumnDefinition } from '../types/dataContract';
import {nsToMs} from '../utils/traceProcessorRowUtils';
import {
  analyzeCriticalPath,
  chainWaitTotals,
  classifySlice,
  CRITICAL_PATH_DEFAULTS,
  CRITICAL_PATH_ENGINE_VERSION,
  CriticalPathInputError,
  pct,
  type CriticalPathAnalyzeOptions,
} from '../services/criticalPathAnalyzer';
import { renderCriticalPathAnalysis } from '../services/criticalPathLocalization';
import { buildDeterministicCriticalPathSummary } from '../services/criticalPathSummary';
import {
  MAX_THREAD_CANDIDATES,
  resolveCriticalPathThread,
  type ResolvedCriticalPathThread,
} from '../services/criticalPathThreadResolver';
import type {
  DisplayResult as SkillDisplayResult,
  SkillDefinition,
  SkillExecutionResult,
} from '../services/skillEngine/types';
import type { IdentityResolutionV1 } from '../types/identityContract';
import type { StreamingUpdate } from '../agent/types';
import type { ArchitectureInfo } from '../agent/detectors/types';
import { isEvidenceCapableToolName, isInformationalToolName } from './types';
import type { SqlSchemaEntry, SqlSchemaIndex, AnalysisNote, AnalysisPlanV3, PlanAspectWaiver, PlanPhase, PlanRevision, Hypothesis, HypothesisResolutionRecord, ToolCallRecord, UncertaintyFlag } from './types';
import type { SceneType } from './sceneClassifier';
import { summarizeSqlResult, type SqlSummary } from './sqlSummarizer';
import { matchPatterns, matchNegativePatterns, extractTraceFeatures } from './analysisPatternMemory';
import { loadSkillNotes } from './selfImprove/skillNotesInjector';
import {
  getPerfettoStdlibModules,
  getPerfettoStdlibPath,
} from '../services/perfettoStdlibScanner';
import {
  listPerfettoSqlModuleDocs,
  searchPerfettoSqlDocs,
  type PerfettoSqlDocEntry,
} from '../services/perfettoSqlDocs';
import {
  buildTraceProcessorQueryProvenance,
  type TraceProcessorPaneSide,
  type TraceProcessorQueryProvenance,
  type TraceProcessorTraceSide,
} from '../services/traceProcessorConnectionModel';
import {getConsumableProcessIdentitySelectors, sqlUsesProcessNameFilter} from '../services/processIdentity/identityGate';
import {hasProcessIdentitySelector, PROCESS_IDENTITY_SELECTORS} from '../services/processIdentity/types';
import type {EffectiveProcessScope} from '../services/processIdentity/effectiveProcessScope';
import {getExactProcessScopeSupport} from '../services/skillEngine/processScopeSql';
import {captureEvidenceTable, captureRawSqlEvidence, evidenceCaptureHash, evidenceTableFor,
  projectEvidenceColumnUnitsForModel, projectEvidenceTableForModel,
  type CapturedFieldSemantics, type EvidenceTableWitness} from '../services/evidence/evidenceCapture';
import {scopeMetadata, identityForScopeEvidence, mergeScopeProvenance, type EvidenceScopeProvenanceV1} from '../types/identityContract';
import {assessScrollingJankClaimBoundary} from '../services/scrollingJankClaimBoundary';
import { injectStdlibIncludes } from './sqlIncludeInjector';
import { normalizeRawSql } from './rawSqlNormalizer';
import {
  buildStrategyRegistrySnapshotFromDefinitions,
  getRegisteredScenes,
  getStrategyDetailByRef,
  getStrategyDetails,
  loadPromptSegment,
  loadPromptTemplate,
  renderTemplate,
  stripPromptComments,
} from './strategyLoader';
import { buildActivePhaseReminder } from './activePhaseReminder';
import {loadSourceInvestigationPolicy} from './sourceInvestigationPolicy';
import { summarizeToolCallInput } from './toolCallSummary';
import {
  findCompletedPhaseEvidenceGaps,
  getPhaseToolEvidenceStatus,
  replayPrePlanToolCalls,
} from './planToolCallRecorder';
import {hasValidPlanSkipDisposition, resolvePlanPhaseForCall} from './planPhaseSemantics';
import {getAnalysisPlanCompletionStatus} from './planCompletionStatus';
import { formatToolCallNarration, type ToolNarrationOptions } from './toolNarration';
import { planPhaseUpdatedContent } from './planPhaseEvents';
import type { ArtifactStore, CompactArtifactSummary } from './artifactStore';
import {resolveArtifactAccessPolicy} from './artifactAccessPolicy';
import { DEFAULT_OUTPUT_LANGUAGE, localize, type OutputLanguage } from './outputLanguage';
import {
  localizeSkillDefinition,
  localizeSkillDiagnostics,
  localizeSkillDisplayResults,
} from '../services/skillLocalization';

import { buildSqlQueryReview } from '../services/queryReview/queryReviewBuilder';
import { buildSkillQueryReview } from '../services/queryReview/skillQueryReviewBuilder';
import { compactQueryReviewForToolResponse, type QueryReviewV1 } from '../types/queryReviewContract';
import { RagStore, getDefaultRagStore } from '../services/ragStore';
import {
  BaselineStore,
  deriveBaselineId,
} from '../services/baselineStore';
import {
  computeBaselineDiff,
  evaluateRegressionGate,
  type RegressionRule,
} from '../services/baselineDiffer';
import {ProjectMemory} from './projectMemory';
import {CaseLibrary} from '../services/caseLibrary';
import { createCaseRetriever } from '../services/caseEvolution/caseRecommendationRetriever';
import {
  DEFAULT_DEV_USER_ID,
  DEFAULT_TENANT_ID,
  DEFAULT_WORKSPACE_ID,
} from '../middleware/auth';
import { openEnterpriseDb } from '../services/enterpriseDb';
import { createAnalysisResultSnapshotRepository } from '../services/analysisResultSnapshotStore';

const tool: typeof sdkTool = ((
  name: string,
  description: string,
  schema: unknown,
  handler: (...args: unknown[]) => unknown,
) => sdkTool(
  name,
  description,
  schema as never,
  async (...args: unknown[]) => {
    if (currentEvaluationTelemetryActive()) recordEvaluationToolCall();
    const cursor = currentEvaluationInjectionContract()
      ? evaluationExposureCursor()
      : undefined;
    try {
      const result = await handler(...args);
      if (cursor !== undefined) {
        commitEvaluationExposureSince(cursor, 'sdk_handoff_observed');
      }
      return result as never;
    } catch (error) {
      if (cursor !== undefined) discardPendingEvaluationExposures(cursor);
      throw error;
    }
  },
)) as unknown as typeof sdkTool;
import {
  createTraceSimilarityService,
  type TraceSimilaritySnapshotRepository,
} from '../services/similarity/similarityService';
import {
  enterpriseKnowledgeStoreEnabled,
  type KnowledgeScope,
  resolveKnowledgeScope,
} from '../services/scopedKnowledgeStore';
import {
  McpToolRegistry,
  MCP_NAME_PREFIX as REGISTRY_MCP_NAME_PREFIX,
  splitPlanAttribution,
  type ToolRequestScope,
} from './mcpToolRegistry';
import { backendLogPath } from '../runtimePaths';
import {diagnosticLogIdentity} from '../utils/logger';
import {activeCodebaseGeneration, CodebaseRegistry} from '../services/codebase/codebaseRegistry';
import {getDefaultCodebaseRegistry} from '../services/codebase/defaultCodebaseServices';
import {CodeLookupLedger, type CodeLookupLedgerEntry} from '../services/codebase/codeLookupLedger';
import {PatchProposer} from '../services/codebase/patchProposer';
import {normalizeCodeAwareMode, type CodeAwareMode} from '../services/codebase/codeAwareFeature';
import {
  SOURCE_USE_DECISION_SCHEMA_VERSION,
  MAX_SOURCE_REFERENCE_COUNT,
  loadSourceUseDecisionToolDescription,
  sanitizeSourceIncompleteReason,
  sanitizeSourceReference,
  sanitizeSourceReferences,
  sanitizeSourceUseDecision,
  type SourceExecutionScopeV1,
  type SourceReferenceV1,
  type SourceUseDecisionV1,
} from '../services/codebase/sourceUseDecision';
import {OnDemandSourceAccessService} from '../services/codebase/onDemandSourceAccess';
import {registerOnDemandSourceLookupForEcho} from '../services/security/codeAwareOutputRegistry';
import {
  GitNexusCodeGraphNavigator,
  type CodeGraphNavigator,
} from '../services/codebase/gitNexusCodeGraphNavigator';
import {
  filterRagLookup,
  type SanitizedRagHit,
  type SanitizedRagResult,
} from '../services/rag/lookupResponseFilter';
import type {RagRetrievalResult} from '../types/sparkContracts';
import {
  getDefaultAndroidInternalsPackStore,
  isAndroidInternalsPackRevoked,
} from '../services/androidInternalsPack/androidInternalsPackResolver';
import type {
  AndroidInternalsPackStoreLike,
} from '../services/androidInternalsPack/types';
import {
  ExternalKnowledgeSourceRegistry,
  getDefaultExternalKnowledgeSourceRegistry,
} from '../services/externalKnowledgeSourceRegistry';
import {SymbolResolver} from '../services/symbol/symbolResolver';
import {
  analysisContextUsesPrivateKnowledge,
  buildAnalysisContextAuthorizationFingerprint,
  type AnalysisContextSelection,
} from '../services/resolvedAnalysisContext';
import type { RuntimeToolExtra } from '../agentRuntime/runtimeToolSpec';
import {
  rethrowIfTraceProcessorQueryCancelled,
  throwIfTraceProcessorQueryCancelled,
} from '../services/traceProcessorCancellation';
import type {
  CriticalPathAnalysis,
  CriticalPathInputErrorCode,
  CriticalPathSegment,
  SliceKind,
  WakeSourceSummary,
} from '../types/criticalPathContract';

export function requireToolDescription(templateName: string, loaded?: string): string {
  const content = loaded === undefined ? loadPromptSegment(templateName) : stripPromptComments(loaded);
  if (!content) throw new Error(`Required tool description template is missing or empty: ${templateName}`);
  return content;
}

/**
 * Process-wide RagStore singleton, lazily initialized on first MCP tool
 * call. Backs the `lookup_blog_knowledge` tool (Plan 55) and will back
 * the project-memory recall tool (Plan 44) when that lands.
 *
 * Storage path lives next to the existing analysis_*.json files so
 * operators can find every long-lived agent state in one directory.
 */
function getRagStore(): RagStore {
  return getDefaultRagStore();
}


function getRuntimeToolSignal(extra: unknown): AbortSignal | undefined {
  const runtimeExtra = extra && typeof extra === 'object' ? extra as RuntimeToolExtra : undefined;
  const signal = runtimeExtra?.signal;
  if (
    signal &&
    typeof signal === 'object' &&
    typeof (signal as AbortSignal).aborted === 'boolean' &&
    typeof (signal as AbortSignal).addEventListener === 'function'
  ) {
    return signal as AbortSignal;
  }
  return undefined;
}

/** Process-wide BaselineStore singleton (Plan 50). Storage lives next
 * to the other long-lived JSON files so operators have one mental
 * model for agent state. */
const BASELINE_STORE_PATH = backendLogPath('baselines.json');
let cachedBaselineStore: BaselineStore | null = null;
function getBaselineStore(): BaselineStore {
  if (!cachedBaselineStore)
    cachedBaselineStore = new BaselineStore(BASELINE_STORE_PATH);
  return cachedBaselineStore;
}

function quoteLooseObjectKeys(value: string): string {
  let out = '';
  let i = 0;
  let inString = false;
  let escaped = false;

  while (i < value.length) {
    const char = value[i];
    if (inString) {
      out += char;
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      i++;
      continue;
    }

    if (char === '"') {
      inString = true;
      out += char;
      i++;
      continue;
    }

    if (char === '{' || char === ',') {
      out += char;
      i++;
      while (i < value.length && /\s/.test(value[i])) {
        out += value[i++];
      }
      const keyStart = i;
      if (/[A-Za-z_$]/.test(value[i] || '')) {
        i++;
        while (i < value.length && /[A-Za-z0-9_$]/.test(value[i])) i++;
        const keyEnd = i;
        let hasDanglingClosingQuote = false;
        if (value[i] === '"') {
          let colonIndex = i + 1;
          while (colonIndex < value.length && /\s/.test(value[colonIndex])) colonIndex++;
          if (value[colonIndex] === ':') {
            hasDanglingClosingQuote = true;
          }
        }
        if (hasDanglingClosingQuote) {
          let colonIndex = i + 1;
          while (colonIndex < value.length && /\s/.test(value[colonIndex])) colonIndex++;
          out += `"${value.slice(keyStart, keyEnd)}"`;
          out += value.slice(keyEnd + 1, colonIndex + 1);
          i = colonIndex + 1;
          continue;
        }
        let colonIndex = i;
        while (colonIndex < value.length && /\s/.test(value[colonIndex])) colonIndex++;
        if (value[colonIndex] === ':') {
          out += `"${value.slice(keyStart, keyEnd)}"`;
          out += value.slice(keyEnd, colonIndex + 1);
          i = colonIndex + 1;
          continue;
        }
      }
      out += value.slice(keyStart, i);
      continue;
    }

    out += char;
    i++;
  }

  return out;
}

function parseToolArrayInput<T>(value: unknown): T[] | null {
  if (Array.isArray(value)) return value as T[];
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  const withoutTrailingComma = trimmed.replace(/,\s*$/, '');
  const candidates = [
    trimmed,
    withoutTrailingComma,
    quoteLooseObjectKeys(trimmed),
    quoteLooseObjectKeys(withoutTrailingComma),
  ].filter((entry, index, all) => entry.length > 0 && all.indexOf(entry) === index);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      return Array.isArray(parsed) ? parsed as T[] : null;
    } catch {
      // Try the next normalization variant.
    }
  }
  return null;
}

function parseToolObjectInput(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  const candidates = [trimmed, quoteLooseObjectKeys(trimmed)]
    .filter((entry, index, all) => entry.length > 0 && all.indexOf(entry) === index);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Try the next normalization variant.
    }
  }
  return null;
}

function parseOptionalToolArrayInput<T>(value: unknown): T[] | null {
  if (value === undefined || value === null) return [];
  if (typeof value === 'string') {
    const trimmed = value.trim().toLowerCase();
    if (!trimmed || trimmed === 'null' || trimmed === 'undefined') return [];
  }
  return parseToolArrayInput<T>(value);
}

export function normalizeOptionalToolString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const normalized = trimmed.toLowerCase();
  if (normalized === 'null' || normalized === 'undefined' || normalized === 'none') {
    return undefined;
  }
  return trimmed;
}

function parseToolStringArrayInput(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map(entry => typeof entry === 'string' || typeof entry === 'number' ? String(entry).trim() : '')
      .filter(Boolean);
  }
  if (typeof value !== 'string') return [];

  const trimmed = value.trim();
  if (!trimmed) return [];
  const parsed = parseToolArrayInput<unknown>(trimmed);
  if (parsed) {
    return parsed.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
  }
  return trimmed
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean);
}

function readAliasedField(source: unknown, names: string[]): unknown {
  if (!source || typeof source !== 'object') return undefined;
  const record = source as Record<string, unknown>;
  for (const name of names) {
    if (record[name] !== undefined) return record[name];
  }
  return undefined;
}

function coercePlanString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return undefined;
}

function coerceOptionalInteger(
  value: unknown,
  field: string,
  options: { min: number; max?: number },
): { value?: number; error?: string } {
  if (value === undefined || value === null || value === '') {
    return {};
  }

  const numeric = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number(value.trim())
      : Number.NaN;
  if (!Number.isInteger(numeric)) {
    return { error: `${field} must be an integer` };
  }
  if (numeric < options.min) {
    return { error: `${field} must be >= ${options.min}` };
  }
  if (options.max !== undefined && numeric > options.max) {
    return { error: `${field} must be <= ${options.max}` };
  }
  return { value: numeric };
}

type PlanPhaseToolInput = Omit<PlanPhase, 'status' | 'expectedTools' | 'expectedCalls' | 'completionSource'> & {
  expectedTools?: unknown;
  expected_tools?: unknown;
  expectedCalls?: unknown;
  expected_calls?: unknown;
  phaseId?: unknown;
  phase_id?: unknown;
  phaseName?: unknown;
  phase_name?: unknown;
  title?: unknown;
  objective?: unknown;
  description?: unknown;
  status?: unknown;
};
type NormalizedPlanPhaseToolInput = Omit<PlanPhase, 'status'> & {
  status?: PlanPhase['status'];
};

const PLAN_STRING_ARRAY_OR_STRING_SCHEMA = z.array(z.union([z.string(), z.number()]));
const PLAN_SKILL_SCOPED_EXPECTED_CALL_TOOL_NAMES = ['invoke_skill', 'compare_skill'] as const;
const PLAN_EXPECTED_CALL_ARG_SCHEMA = z.union([
  z.string(),
  z.object({
    tool: z.enum(PLAN_SKILL_SCOPED_EXPECTED_CALL_TOOL_NAMES),
    skillId: z.union([z.string(), z.number()]),
  }).strict(),
  z.object({
    tool: z.union([z.string(), z.number()]),
  }).strict(),
]);
const PLAN_EXPECTED_CALLS_ARG_SCHEMA = z.array(PLAN_EXPECTED_CALL_ARG_SCHEMA);
const PLAN_PHASE_ARG_SCHEMA = z.object({
  id: z.union([z.string(), z.number()]),
  name: z.union([z.string(), z.number()]),
  goal: z.union([z.string(), z.number()]),
  expectedTools: PLAN_STRING_ARRAY_OR_STRING_SCHEMA.optional(),
  expectedCalls: PLAN_EXPECTED_CALLS_ARG_SCHEMA.optional(),
  status: z.string().optional(),
}).strict();
const PLAN_PHASES_ARG_SCHEMA = z.array(PLAN_PHASE_ARG_SCHEMA);
const PLAN_WAIVER_ARG_SCHEMA = z.object({
  aspectId: z.string(),
  reason: z.string(),
}).strict();
const PLAN_WAIVERS_ARG_SCHEMA = z.array(PLAN_WAIVER_ARG_SCHEMA);

const CORE_EXPECTED_CALL_TOOL_NAMES = new Set([
  'detect_architecture',
  'execute_sql',
  'execute_sql_on',
  'fetch_artifact',
  'lookup_sql_schema',
  'lookup_knowledge',
  'submit_hypothesis',
  'resolve_hypothesis',
  'flag_uncertainty',
]);
const SKILL_SCOPED_EXPECTED_CALL_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...PLAN_SKILL_SCOPED_EXPECTED_CALL_TOOL_NAMES,
]);
const EXPECTED_CALLS_FIELD_ALIASES = ['expectedCalls', 'expected_calls'];
const EXPECTED_CALL_STRONG_TOOL_FIELD_ALIASES = ['tool', 'toolName', 'tool_name'];
const EXPECTED_CALL_FALLBACK_TOOL_FIELD_ALIASES = ['name'];
const EXPECTED_CALL_SKILL_FIELD_ALIASES = ['skillId', 'skill_id', 'skill', 'skillName', 'skill_name'];
const EXPECTED_CALL_PARAMS_FIELD_ALIASES = ['params', 'arguments', 'args', 'input'];

type SkillArtifactSummaryForModel = CompactArtifactSummary & {
  evidenceRefId: string;
  sourceToolCallId?: string;
};

function shortExpectedToolName(toolName: string): string {
  const MCP_PREFIX = 'mcp__smartperfetto__';
  return toolName.startsWith(MCP_PREFIX) ? toolName.slice(MCP_PREFIX.length) : toolName;
}

function collectMeaningfulAliasedValues(source: unknown, names: string[]): unknown[] {
  if (!source || typeof source !== 'object') return [];
  const record = source as Record<string, unknown>;
  return names
    .map(name => record[name])
    .filter(value => {
      if (value === undefined || value === null) return false;
      if (typeof value !== 'string') return true;
      const normalized = value.trim().toLowerCase();
      return Boolean(normalized && normalized !== 'null' && normalized !== 'undefined');
    });
}

function collectExpectedCallAliasStrings(source: unknown, names: string[]): string[] {
  const values = collectMeaningfulAliasedValues(source, names)
    .map(coercePlanString)
    .filter((value): value is string => Boolean(value))
    .map(value => shortExpectedToolName(value));
  return [...new Set(values)];
}

function collectNonScalarExpectedCallAliases(source: unknown, names: string[]): string[] {
  if (!source || typeof source !== 'object') return [];
  const record = source as Record<string, unknown>;
  return names.filter(name => {
    if (collectMeaningfulAliasedValues({ [name]: record[name] }, [name]).length === 0) return false;
    return !coercePlanString(record[name]);
  });
}

type ExpectedCallResolution = {
  call?: NonNullable<PlanPhase['expectedCalls']>[number];
  errors: string[];
};

function resolveExpectedCall(call: unknown): ExpectedCallResolution {
  if (typeof call === 'string') {
    return resolveExpectedCall(parseExpectedCallShorthand(call));
  }
  if (!call || typeof call !== 'object') return { errors: [] };

  const errors: string[] = [];
  const hasStrongToolAlias = collectMeaningfulAliasedValues(
    call,
    EXPECTED_CALL_STRONG_TOOL_FIELD_ALIASES,
  ).length > 0;
  const strongToolValues = collectExpectedCallAliasStrings(call, EXPECTED_CALL_STRONG_TOOL_FIELD_ALIASES);
  const toolFieldAliases = hasStrongToolAlias
    ? EXPECTED_CALL_STRONG_TOOL_FIELD_ALIASES
    : EXPECTED_CALL_FALLBACK_TOOL_FIELD_ALIASES;
  const invalidToolAliases = collectNonScalarExpectedCallAliases(call, toolFieldAliases);
  const invalidSkillAliases = collectNonScalarExpectedCallAliases(call, EXPECTED_CALL_SKILL_FIELD_ALIASES);
  errors.push(...invalidToolAliases.map(name => `contains non-scalar tool alias "${name}"`));
  errors.push(...invalidSkillAliases.map(name => `contains non-scalar skill alias "${name}"`));
  const toolValues = hasStrongToolAlias
    ? strongToolValues
    : collectExpectedCallAliasStrings(call, EXPECTED_CALL_FALLBACK_TOOL_FIELD_ALIASES);
  const skillValues = collectExpectedCallAliasStrings(call, EXPECTED_CALL_SKILL_FIELD_ALIASES);
  for (const rawNestedParams of collectMeaningfulAliasedValues(call, EXPECTED_CALL_PARAMS_FIELD_ALIASES)) {
    const nestedParams = parseToolObjectInput(rawNestedParams);
    if (!nestedParams) {
      if (
        typeof rawNestedParams === 'string'
        && /["']?(?:skillId|skill_id|skillName|skill_name|skill)["']?\s*[:=]/i.test(rawNestedParams)
      ) {
        errors.push('nested params contains a skill scope but is not a valid object');
      } else {
        errors.push('nested params must be an object or serialized object');
      }
      continue;
    }
    errors.push(...collectNonScalarExpectedCallAliases(nestedParams, EXPECTED_CALL_SKILL_FIELD_ALIASES)
      .map(name => `contains non-scalar nested skill alias "${name}"`));
    skillValues.push(...collectExpectedCallAliasStrings(nestedParams, EXPECTED_CALL_SKILL_FIELD_ALIASES));
  }

  const distinctSkillValues = [...new Set(skillValues)];
  if (toolValues.length > 1) {
    errors.push(`contains conflicting tool aliases: ${toolValues.join(', ')}`);
  }
  if (distinctSkillValues.length > 1) {
    errors.push(`contains conflicting skill aliases: ${distinctSkillValues.join(', ')}`);
  }
  if (errors.length > 0 || toolValues.length === 0) return { errors };

  const normalizedTool = toolValues[0];
  const normalizedSkillId = distinctSkillValues[0];
  if (SKILL_SCOPED_EXPECTED_CALL_TOOL_NAMES.has(normalizedTool) && !normalizedSkillId) {
    return {
      errors: [`requires a non-empty skillId for tool "${normalizedTool}"`],
    };
  }
  if (normalizedTool === 'invoke_skill' && normalizedSkillId && CORE_EXPECTED_CALL_TOOL_NAMES.has(normalizedSkillId)) {
    return { call: { tool: normalizedSkillId }, errors: [] };
  }
  return {
    call: normalizedSkillId ? { tool: normalizedTool, skillId: normalizedSkillId } : { tool: normalizedTool },
    errors: [],
  };
}

function normalizeExpectedCall(call: unknown): NonNullable<PlanPhase['expectedCalls']>[number] | undefined {
  return resolveExpectedCall(call).call;
}

function parseExpectedCallShorthand(value: string): Record<string, unknown> | undefined {
  const text = value.trim();
  if (!text) return undefined;
  const functionMatch = text.match(/^([A-Za-z0-9_.:-]+)\(([^)]*)\)$/);
  if (functionMatch) {
    const skillId = functionMatch[2].trim();
    return skillId ? { tool: functionMatch[1], skillId } : { tool: functionMatch[1] };
  }
  const colonIndex = text.indexOf(':');
  if (colonIndex > 0) {
    const tool = text.slice(0, colonIndex).trim();
    const skillId = text.slice(colonIndex + 1).trim();
    return skillId ? { tool, skillId } : { tool };
  }
  return { tool: text };
}

function parseExpectedCallStringList(value: string): unknown[] {
  return value
    .split(/[,;\n]+/)
    .map(part => parseExpectedCallShorthand(part))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry));
}

function collectInformationalExpectationErrors(input: PlanPhaseToolInput, phaseIndex: number): string[] {
  const normalizedId = coercePlanString(readAliasedField(input, ['id', 'phaseId', 'phase_id']));
  const label = normalizedId
    ? normalizedId
    : `phase#${phaseIndex + 1}`;
  const errors: string[] = [];

  for (const tool of parseToolStringArrayInput(readAliasedField(input, ['expectedTools', 'expected_tools']))) {
    const shortTool = shortExpectedToolName(tool.trim());
    if (shortTool && !isEvidenceCapableToolName(shortTool)) {
      errors.push(`${label}.expectedTools includes informational tool "${shortTool}"`);
    }
  }

  const expectedCalls = normalizeExpectedCallsInput(readExpectedCallsInput(input));
  for (const call of expectedCalls ?? []) {
    const tool = shortExpectedToolName(call.tool.trim());
    const skillId = typeof call.skillId === 'string' ? shortExpectedToolName(call.skillId.trim()) : undefined;
    const evidenceTool = tool === 'invoke_skill' && skillId && CORE_EXPECTED_CALL_TOOL_NAMES.has(skillId)
      ? skillId
      : tool;
    if (evidenceTool && !isEvidenceCapableToolName(evidenceTool)) {
      errors.push(`${label}.expectedCalls includes informational tool "${evidenceTool}"`);
    } else if (skillId && isInformationalToolName(skillId)) {
      errors.push(`${label}.expectedCalls references informational tool "${skillId}" as skillId`);
    }
  }

  return errors;
}

function collectPlanExpectationErrors(inputs: PlanPhaseToolInput[]): string[] {
  return inputs.flatMap((input, index) => collectInformationalExpectationErrors(input, index));
}

function parseExpectedCallsInput(input: unknown): unknown[] | null {
  const parsed = parseToolArrayInput<unknown>(input);
  if (parsed) return parsed;
  if (typeof input === 'string') return parseExpectedCallStringList(input);
  return null;
}

function readExpectedCallsInput(input: PlanPhaseToolInput): unknown {
  return collectMeaningfulAliasedValues(input, EXPECTED_CALLS_FIELD_ALIASES)[0];
}

function collectExpectedCallShapeErrors(input: PlanPhaseToolInput, phaseIndex: number): string[] {
  const label = coercePlanString(readAliasedField(input, ['id', 'phaseId', 'phase_id'])) || `phase#${phaseIndex + 1}`;
  const rawExpectedCallsInputs = collectMeaningfulAliasedValues(input, EXPECTED_CALLS_FIELD_ALIASES);
  if (rawExpectedCallsInputs.length === 0) return [];
  const parsedInputs = rawExpectedCallsInputs.map(parseExpectedCallsInput);
  if (parsedInputs.some(parsed => !parsed)) {
    return [`${label}.expectedCalls must be an array, JSON array string, or shorthand string`];
  }

  const errors: string[] = [];
  for (const parsed of parsedInputs) {
    parsed?.forEach((call, index) => {
      const resolution = resolveExpectedCall(call);
      if (resolution.errors.length > 0) {
        errors.push(...resolution.errors.map(error => `${label}.expectedCalls[${index}] ${error}`));
        return;
      }
      const normalizedCall = resolution.call;
      if (!normalizedCall) {
        errors.push(`${label}.expectedCalls[${index}] must include a non-empty tool/toolName/tool_name/name`);
      } else if (
        normalizedCall.tool === 'compare_skill'
        && normalizedCall.skillId
        && CORE_EXPECTED_CALL_TOOL_NAMES.has(normalizedCall.skillId)
      ) {
        errors.push(
          `${label}.expectedCalls[${index}] cannot use core tool "${normalizedCall.skillId}" as compare_skill skillId; `
          + 'compare_skill requires a registered analysis skill',
        );
      } else if (
        normalizedCall.skillId
        && !SKILL_SCOPED_EXPECTED_CALL_TOOL_NAMES.has(normalizedCall.tool)
      ) {
        errors.push(
          `${label}.expectedCalls[${index}] cannot scope tool "${normalizedCall.tool}" by skillId; `
          + 'only invoke_skill and compare_skill support skill-scoped expectedCalls',
        );
      }
    });
  }
  const uniqueErrors = [...new Set(errors)];
  if (uniqueErrors.length > 0) return uniqueErrors;

  const canonicalInputs = parsedInputs.map(parsed => {
    const normalized = normalizeExpectedCallsInput(parsed) ?? [];
    return JSON.stringify(normalized
      .map(call => `${call.tool}\u0000${call.skillId ?? ''}`)
      .sort());
  });
  if (new Set(canonicalInputs).size > 1) {
    return [`${label}.expectedCalls and expected_calls must not contain conflicting values`];
  }
  return [];
}

function collectPlanExpectedCallShapeErrors(inputs: PlanPhaseToolInput[]): string[] {
  return inputs.flatMap((input, index) => collectExpectedCallShapeErrors(input, index));
}

function normalizeExpectedCallsInput(input: unknown): PlanPhase['expectedCalls'] | undefined {
  const parsed = parseExpectedCallsInput(input);
  if (!parsed) return undefined;
  const normalized = parsed
    .map(normalizeExpectedCall)
    .filter((call): call is NonNullable<PlanPhase['expectedCalls']>[number] => Boolean(call));
  if (normalized.length === 0) return [];
  const seen = new Set<string>();
  return normalized.filter(call => {
    const key = `${call.tool}:${call.skillId ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizePlanPhaseToolInput(input: PlanPhaseToolInput): Omit<PlanPhase, 'status'> {
  const expectedCalls = normalizeExpectedCallsInput(readExpectedCallsInput(input));
  return {
    id: coercePlanString(readAliasedField(input, ['id', 'phaseId', 'phase_id'])) || '',
    name: coercePlanString(readAliasedField(input, ['name', 'phaseName', 'phase_name', 'title'])) || '',
    goal: coercePlanString(readAliasedField(input, ['goal', 'objective', 'description'])) || '',
    expectedTools: parseToolStringArrayInput(readAliasedField(input, ['expectedTools', 'expected_tools'])),
    ...(expectedCalls ? { expectedCalls } : {}),
  };
}

function normalizePlanWaivers(inputs: PlanAspectWaiver[]): PlanAspectWaiver[] {
  return inputs
    .map(input => {
      const aspectId = coercePlanString(readAliasedField(input, ['aspectId', 'aspect_id', 'aspect']));
      const reason = coercePlanString(readAliasedField(input, ['reason', 'justification']));
      return aspectId && reason ? { aspectId, reason } : undefined;
    })
    .filter((entry): entry is PlanAspectWaiver => Boolean(entry));
}

function normalizePlanPhaseStatus(input: unknown): PlanPhase['status'] | undefined {
  const status = coercePlanString(input);
  if (status === 'pending' || status === 'in_progress' || status === 'completed' || status === 'skipped') {
    return status;
  }
  return undefined;
}

type PlanPhaseUpdateStatus = Exclude<PlanPhase['status'], 'pending'>;

function resolvePlanPhaseUpdateStatus(
  status: unknown,
  phaseStatus: unknown,
): {status: PlanPhaseUpdateStatus} | {error: 'missing' | 'invalid' | 'conflict'} {
  const supplied = [status, phaseStatus].filter(value => value !== undefined);
  if (supplied.length === 0) return {error: 'missing'};

  const normalized = supplied.map((value): PlanPhaseUpdateStatus | undefined => {
    if (value === 'active') return 'in_progress';
    if (value === 'in_progress' || value === 'completed' || value === 'skipped') return value;
    return undefined;
  });
  if (normalized.some(value => value === undefined)) return {error: 'invalid'};
  if (new Set(normalized).size > 1) return {error: 'conflict'};
  return {status: normalized[0]!};
}

function collectPlanPhaseShapeErrors(phases: Pick<PlanPhase, 'id' | 'name' | 'goal'>[]): string[] {
  const errors: string[] = phases.length === 0 ? ['phases must not be empty'] : [];
  const phaseIds = new Set<string>();
  phases.forEach((phase, index) => {
    const label = phase.id || `phase#${index + 1}`;
    if (!phase.id) errors.push(`${label}.id is required`);
    if (phaseIds.has(phase.id)) errors.push(`${label}.id is duplicated`);
    phaseIds.add(phase.id);
    if (!phase.name) errors.push(`${label}.name is required`);
    if (!phase.goal) errors.push(`${label}.goal is required`);
  });
  return errors;
}

const TIMESTAMP_EXPRESSION_PARAM_KEYS = new Set([
  'ts',
  'start_ts',
  'end_ts',
  'frame_ts',
  'startTs',
  'endTs',
  'frameTs',
]);

function normalizeTimestampExpression(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  const match = trimmed.match(/^(\d{6,})([+-])(\d{1,15})$/);
  if (!match) return value;
  try {
    const left = BigInt(match[1]);
    const right = BigInt(match[3]);
    const result = match[2] === '+' ? left + right : left - right;
    return result.toString();
  } catch {
    return value;
  }
}

/** Process-wide ProjectMemory singleton (Plan 44). Independent of the
 * existing `analysisPatternMemory.ts` session-scope store. */
const PROJECT_MEMORY_PATH = backendLogPath('analysis_project_memory.json');
let cachedProjectMemory: ProjectMemory | null = null;
function getProjectMemory(): ProjectMemory {
  if (!cachedProjectMemory)
    cachedProjectMemory = new ProjectMemory(PROJECT_MEMORY_PATH);
  return cachedProjectMemory;
}

/** Process-wide CaseLibrary singleton (Plan 54). Storage path matches
 * the other long-lived agent-state JSON files. */
const CASE_LIBRARY_PATH = backendLogPath('case_library.json');
let cachedCaseLibrary: CaseLibrary | null = null;
function getCaseLibrary(): CaseLibrary {
  if (!cachedCaseLibrary)
    cachedCaseLibrary = new CaseLibrary(CASE_LIBRARY_PATH);
  return cachedCaseLibrary;
}

/** MCP tool name prefix — derived from the server name 'smartperfetto'.
 * Re-exported from `mcpToolRegistry.ts` so consumers (claudeAgentDefinitions,
 * tests) keep their existing import path. */
export const MCP_NAME_PREFIX = REGISTRY_MCP_NAME_PREFIX;

let sqlSchemaCache: SqlSchemaIndex | null = null;

/**
 * SQL structural keywords to exclude when computing Jaccard similarity
 * for error-fix pair matching. Without this filter, any two Perfetto SQL
 * queries match at >30% simply by sharing common keywords like SELECT/FROM/WHERE.
 */
const SQL_STOP_WORDS = new Set([
  // SQL structural keywords
  'select', 'from', 'where', 'and', 'or', 'not', 'in', 'is', 'as', 'on',
  'join', 'left', 'right', 'inner', 'outer', 'cross', 'full',
  'group', 'by', 'order', 'limit', 'having', 'offset',
  'with', 'case', 'when', 'then', 'else', 'end',
  'null', 'like', 'glob', 'between',
  'cast', 'count', 'sum', 'avg', 'max', 'min', 'round', 'coalesce',
  'lag', 'lead', 'over', 'partition', 'row_number', 'rank',
  'distinct', 'union', 'all', 'exists', 'into',
  'asc', 'desc', 'true', 'false', 'integer', 'text', 'real',
  'printf', 'substr', 'instr', 'replace', 'length', 'trim', 'upper', 'lower',
  // Perfetto domain-structural tokens — appear in virtually all trace queries
  // and inflate Jaccard similarity between unrelated queries
  'upid', 'utid', 'track_id', 'layer_name', 'jank_type', 'dur', 'name',
  'surface_frame_token', 'display_frame_token', 'frame_number',
  'process', 'thread', 'slice', 'counter', 'counter_track',
  'actual_frame_timeline_slice', 'expected_frame_timeline_slice',
]);

/** Extract meaningful content tokens from SQL, filtering out structural keywords. */
function sqlContentTokens(sql: string): Set<string> {
  return new Set(
    sql.toLowerCase()
      .split(/[\s,()=<>!+\-*/|;'"]+/)
      .filter(t => t.length > 2 && !SQL_STOP_WORDS.has(t))
  );
}

const SQL_ERROR_LOG_DIR = backendLogPath('sql_learning');

interface SqlErrorFixPair {
  errorSql: string;
  errorMessage: string;
  fixedSql?: string;
  timestamp: number;
}

/**
 * Load previously learned SQL error-fix pairs from disk.
 * Returns only pairs that have a fixedSql (i.e., successfully corrected).
 * Used to seed new sessions with cross-session learning.
 */
/** TTL for error-fix pairs: 30 days. Older pairs may reference outdated schemas. */
const ERROR_FIX_PAIR_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * P0-G2: ReAct reasoning nudge — appended to successful data tool results.
 * Prompts Claude to explicitly reason about observations before next action.
 * Cost: ~20 tokens per data tool call, ~200-300 total per analysis.
 */
const REASONING_NUDGE_ZH = '\n\n[REFLECT] 在执行下一步之前：这个数据的关键发现是什么？是否支持/反驳你的假设？如有重要推断，请用 submit_hypothesis 或 write_analysis_note 记录。';
const REASONING_NUDGE_EN = '\n\n[REFLECT] Before the next action: what is the key finding from this data? Does it support or refute your hypothesis? If there is an important inference, record it with submit_hypothesis or write_analysis_note.';
/** Compatibility export for runtime callers; summary length no longer controls plan completion. */
export const MIN_PHASE_SUMMARY_CHARS = 15;

function sqlErrorLogFile(scope?: KnowledgeScope): string {
  if (!enterpriseKnowledgeStoreEnabled() && !scope) {
    return path.join(SQL_ERROR_LOG_DIR, 'error_fix_pairs.json');
  }
  const resolved = resolveKnowledgeScope(scope);
  return path.join(
    SQL_ERROR_LOG_DIR,
    resolved.tenantId,
    resolved.workspaceId,
    'error_fix_pairs.json',
  );
}

export function loadLearnedSqlFixPairs(
  maxPairs = 10,
  scope?: KnowledgeScope,
  selection: AnalysisContextSelection = {},
): SqlErrorFixPair[] {
  if (analysisContextUsesPrivateKnowledge(selection)) return [];
  try {
    const logFile = sqlErrorLogFile(scope);
    if (!fs.existsSync(logFile)) return [];
    const data = fs.readFileSync(logFile, 'utf-8');
    const pairs: SqlErrorFixPair[] = JSON.parse(data);
    const cutoff = Date.now() - ERROR_FIX_PAIR_TTL_MS;
    // Only return pairs that have successful fixes and are within TTL
    return pairs
      .filter(p => p.fixedSql && p.timestamp >= cutoff)
      .slice(-maxPairs);
  } catch {
    return [];
  }
}

async function logSqlErrorFixPair(
  pair: SqlErrorFixPair,
  scope?: KnowledgeScope,
): Promise<void> {
  try {
    const logFile = sqlErrorLogFile(scope);
    let pairs: SqlErrorFixPair[] = [];
    try {
      const data = await fs.promises.readFile(logFile, 'utf-8');
      pairs = JSON.parse(data);
    } catch { /* fresh start */ }
    // Deduplicate: if an equivalent error+fix pair already exists, update timestamp instead of appending
    const existingIdx = pairs.findIndex(p =>
      p.errorMessage === pair.errorMessage && p.fixedSql === pair.fixedSql
    );
    if (existingIdx >= 0) {
      pairs[existingIdx].timestamp = pair.timestamp;
    } else {
      pairs.push(pair);
    }
    // Keep last 200 pairs
    if (pairs.length > 200) pairs = pairs.slice(-200);
    await fs.promises.mkdir(path.dirname(logFile), { recursive: true });
    // Atomic write: write to tmp file, then rename
    const tmpFile = logFile + '.tmp';
    await fs.promises.writeFile(tmpFile, JSON.stringify(pairs));
    await fs.promises.rename(tmpFile, logFile);
  } catch (err) {
    console.warn('[ClaudeMCP] Failed to log SQL error-fix pair:', (err as Error).message);
  }
}

function loadSqlSchema(): SqlSchemaIndex {
  if (sqlSchemaCache) return sqlSchemaCache;

  const indexPath = path.resolve(__dirname, '../../data/perfettoSqlIndex.light.json');
  try {
    const raw = fs.readFileSync(indexPath, 'utf-8');
    sqlSchemaCache = JSON.parse(raw) as SqlSchemaIndex;
  } catch (err) {
    console.warn('[ClaudeMCP] Failed to load SQL schema index:', (err as Error).message);
    sqlSchemaCache = { version: '0.0.0', generatedAt: '', templates: [] };
  }
  return sqlSchemaCache;
}

function compactSqlDocEntry(entry: PerfettoSqlDocEntry): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: entry.name,
    type: entry.type,
    category: entry.category,
    module: entry.module,
    description: entry.description,
    include: entry.include,
  };
  if (entry.tags?.length) out.tags = entry.tags;
  if (entry.columns?.length) out.columns = entry.columns;
  if (entry.params?.length) out.params = entry.params;
  if (entry.returnType) out.returnType = entry.returnType;
  if (entry.moduleIncludes?.length) out.moduleIncludes = entry.moduleIncludes;
  if (entry.transitiveIncludes?.length) out.transitiveIncludes = entry.transitiveIncludes;
  if (entry.lineage) out.lineage = entry.lineage;
  if (entry.dataCheckSql) out.dataCheckSql = entry.dataCheckSql;
  if (entry.sourcePath) out.sourcePath = entry.sourcePath;
  return out;
}

function compactLegacySqlSchemaEntry(entry: SqlSchemaEntry): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: entry.name,
    type: entry.type,
    category: entry.category,
    description: entry.description,
  };
  if (entry.module) out.module = entry.module;
  if (entry.include) out.include = entry.include;
  if (entry.dependencies?.length) out.dependencies = entry.dependencies;
  if (entry.requiredMetric) out.requiredMetric = entry.requiredMetric;
  if (entry.setupSql) out.setupSql = entry.setupSql;
  if (entry.sourcePath) out.sourcePath = entry.sourcePath;
  if (entry.filePath) out.filePath = entry.filePath;
  if (entry.columns?.length) out.columns = entry.columns;
  if (entry.params?.length) out.params = entry.params;
  if (entry.returnType) out.returnType = entry.returnType;
  return out;
}

/**
 * Normalize synthesizeData entry's `data` field into { columns, rows } format.
 * synthesizeData entries can be:
 *   - Array of objects: [{ col1: val1, col2: val2 }, ...]
 *   - Already columnar: { columns: [...], rows: [[...], ...] }
 *   - Iterator results: [{ itemIndex, item, result: { ... } }]
 *   - Single object: { key: value, ... }
 * All are normalized to { columns: string[], rows: any[][] } for ArtifactStore.
 */
function normalizeSynthesizeDataForStorage(data: any): { columns: string[]; rows: any[][] } {
  if (!data) return { columns: [], rows: [] };

  // Already columnar format
  if (data.columns && Array.isArray(data.rows)) {
    return { columns: data.columns, rows: data.rows };
  }

  // Array of objects
  if (Array.isArray(data) && data.length > 0) {
    const first = data[0];
    // Iterator format: flatten item + result
    if (first && typeof first === 'object' && 'itemIndex' in first && 'result' in first) {
      const allKeys = new Set<string>();
      const flatRows = data.map((entry: any) => {
        const flat: Record<string, any> = { itemIndex: entry.itemIndex };
        // Merge item fields
        if (entry.item && typeof entry.item === 'object') {
          for (const [k, v] of Object.entries(entry.item)) {
            flat[k] = v;
            allKeys.add(k);
          }
        }
        // Merge result fields (top-level scalars only, skip nested objects)
        if (entry.result && typeof entry.result === 'object') {
          for (const [k, v] of Object.entries(entry.result)) {
            if (typeof v !== 'object' || v === null) {
              flat[`result_${k}`] = v;
              allKeys.add(`result_${k}`);
            }
          }
        }
        allKeys.add('itemIndex');
        return flat;
      });
      const columns = ['itemIndex', ...Array.from(allKeys).filter(k => k !== 'itemIndex')];
      const rows = flatRows.map((row: Record<string, any>) => columns.map(c => row[c] ?? null));
      return { columns, rows };
    }

    // Plain array of objects
    if (typeof first === 'object' && first !== null) {
      const columns = Object.keys(first);
      const rows = data.map((row: Record<string, any>) => columns.map(c => row[c] ?? null));
      return { columns, rows };
    }

    // Array of primitives — single column
    return { columns: ['value'], rows: data.map((v: any) => [v]) };
  }

  // Single object → single row
  if (typeof data === 'object' && data !== null) {
    const columns = Object.keys(data);
    const rows = [columns.map(c => data[c] ?? null)];
    return { columns, rows };
  }

  // Scalar
  return { columns: ['value'], rows: [[data]] };
}

function previewFromColumnarData(data: any): Record<string, any> | undefined {
  const columns: string[] = Array.isArray(data?.columns)
    ? data.columns.filter((col: unknown): col is string => typeof col === 'string')
    : [];
  const firstRow = Array.isArray(data?.rows) ? data.rows[0] : undefined;
  if (columns.length === 0 || !Array.isArray(firstRow)) return undefined;
  const preview: Record<string, any> = {};
  columns.forEach((column, index) => {
    preview[column] = index < firstRow.length ? firstRow[index] : null;
  });
  return preview;
}

export interface ClaudeMcpServerOptions {
  traceId: string;
  traceProcessorService: TraceProcessorService;
  skillExecutor: SkillExecutor;
  packageName?: string;
  /** Callback to emit StreamingUpdate events (e.g. DataEnvelopes from skill results) */
  emitUpdate?: (update: StreamingUpdate) => void;
  toolObserver?: RuntimeToolObserver;
  /** Restrict-only typed turn policy; omitted preserves authorized evidence acquisition. */
  allowNewEvidence?: boolean;
  /** Runtime lease: no tool body may execute after acquisition closes. */
  canInvokeTool?: () => boolean;
  /** In-process, product-issued scene capability. Never reconstructed from tool JSON. */
  sceneRunContext?: SceneRunContext;
  /** Issued session-bound reader, never accepted from HTTP/SDK tool arguments. */
  analysisHistoryReader?: AnalysisHistoryReader;
  strategyRegistry?: ReadonlyStrategyRegistrySnapshot;
  /** Callback when invoke_skill returns a successful result (used for entity capture) */
  onSkillResult?: (result: { skillId: string; displayResults: Array<{ stepId?: string; data?: any }> }) => void;
  /** Mutable notes array for the write_analysis_note tool — passed by reference from analyze() scope */
  analysisNotes?: AnalysisNote[];
  /** Optional artifact store for token-efficient skill result references */
  artifactStore?: ArtifactStore;
  /** Original user query, used only as conditional plan-template trigger context. */
  userQuery?: string;
  /** Cached architecture detection result — avoids redundant re-detection */
  cachedArchitecture?: ArchitectureInfo;
  /** Per-session SQL error-fix pairs for in-context learning */
  recentSqlErrors?: SqlErrorFixPair[];
  /** Mutable analysis plan — passed by reference from analyze() scope */
  analysisPlan?: { current: AnalysisPlanV3 | null; prePlanToolCallLog?: ToolCallRecord[] };
  /** Mutable watchdog warning — set by runtime when repetitive failures detected, consumed by next tool call */
  watchdogWarning?: { current: string | null };
  /** Mutable hypotheses array for hypothesis-verify cycle (P0-G4) */
  hypotheses?: Hypothesis[];
  /** Scene type for plan template validation (P1-G11) */
  sceneType?: SceneType;
  /** Mutable uncertainty flags array (P1-G1) */
  uncertaintyFlags?: UncertaintyFlag[];
  /** Cached vendor detection result (e.g. "xiaomi", "pixel", "aosp") — avoids redundant re-detection */
  cachedVendor?: string | null;
  /** Reference trace ID for comparison mode — enables dual-trace MCP tools */
  referenceTraceId?: string;
  /** Pre-computed comparison context (capabilities, metadata) for get_comparison_context tool */
  comparisonContext?: import('./types').ComparisonContext;
  /** Lightweight response budgets; authorized tool capabilities are unchanged. */
  lightweight?: boolean;
  /** Conversation-only tool boundary. false exposes authorized source tools but no Trace tools. */
  conversationTraceAttached?: boolean;
  /** Per-analysis budget for skill-notes injection on invoke_skill responses.
   *  When omitted (default) no notes are injected. The runtime constructs and
   *  passes the same instance for every tool call so the running totals are
   *  shared across the analysis. See skillNotesInjector.ts. */
  skillNotesBudget?: import('./selfImprove/skillNotesInjector').SkillNotesBudget;
  /** User-facing output language for backend-emitted progress and hints. */
  outputLanguage?: OutputLanguage;
  /** Enterprise tenant/workspace scope for knowledge, memory, case, and baseline tools. */
  knowledgeScope?: KnowledgeScope;
  /** SmartPerfetto session id, used for code lookup ledger sidecars. */
  sessionId?: string;
  /** Code-aware analysis mode. `metadata_only` never sends source snippets to the provider. */
  codeAwareMode?: CodeAwareMode;
  /** Codebase ids whitelisted for this analysis session. */
  codebaseIds?: string[];
  /** Private external-knowledge source ids whitelisted for this analysis session. */
  knowledgeSourceIds?: string[];
  /** Source phase routing and optional hard tool budget. */
  sourceUsePolicy?: {
    phase: 'explicit' | 'automatic_enrichment' | 'deep_enrichment';
    maxSearchCalls?: number;
    maxReadCalls?: number;
    maxDurationMs?: number;
  };
  /** Non-secret authorization partition for active lookup/patch capability state. */
  analysisContextFingerprint?: string;
  /** Test hook / alternate private external-knowledge registry. */
  externalKnowledgeRegistry?: ExternalKnowledgeSourceRegistry;
  /** Test hook / alternate registry. */
  codebaseRegistry?: CodebaseRegistry;
  /** Test hook / deterministic on-demand source backend. */
  onDemandSourceAccess?: Pick<OnDemandSourceAccessService, 'search' | 'read'>;
  /** Test hook / alternate code lookup ledger. */
  codeLookupLedger?: CodeLookupLedger;
  /** Test hook / alternate optional code graph navigator. */
  codeGraphNavigator?: CodeGraphNavigator;
  /** Test hook / alternate case library. */
  caseLibrary?: CaseLibrary;
  /** Test hook / alternate case RAG store. */
  ragStore?: RagStore;
  /** Test hook / session-pinned built-in Android Internals Knowledge Pack. */
  androidInternalsPackStore?: AndroidInternalsPackStoreLike | null;
  /** Immutable public Knowledge Pack identity pinned by the session snapshot. */
  androidInternalsPackPin?: import('../services/androidInternalsPack/types').AndroidInternalsPackIdentity;
  analysisResultSnapshotRepository?: TraceSimilaritySnapshotRepository;
  /** Explicit per-run attribution boundary for detached/shared tool callbacks. */
  runManifestAttributionSink?: RunManifestAttributionSink;
}

export interface SourceUseDecisionAccessor {
  getSourceUseDecision(): SourceUseDecisionV1 | undefined;
  /** Missing or invalidated scope cannot establish source non-applicability. */
  getSourceExecutionScope?(): SourceExecutionScopeV1 | undefined;
}

/**
 * Creates an in-process MCP server scoped to a specific trace session.
 * Exposes domain tools: execute_sql, invoke_skill, list_skills,
 * detect_architecture, lookup_sql_schema, and optionally write_analysis_note.
 */
export function createClaudeMcpServer(options: ClaudeMcpServerOptions) {
  const { traceId, traceProcessorService, skillExecutor, packageName, emitUpdate, onSkillResult, analysisNotes, artifactStore } = options;
  const artifactAccessPolicy = resolveArtifactAccessPolicy(options.userQuery);
  const artifactSummaryState = new Map<string, { complete?: boolean }>();
  const recentSqlErrors: SqlErrorFixPair[] = options.recentSqlErrors || [];
  const watchdogRef = options.watchdogWarning;
  const skillNotesBudget = options.skillNotesBudget;
  const outputLanguage = options.outputLanguage ?? DEFAULT_OUTPUT_LANGUAGE;
  const knowledgeScope = options.knowledgeScope;
  const runManifestAttributionSink = resolveRunManifestAttributionSink(
    options.runManifestAttributionSink,
    currentRunManifestAttributionSink(),
  );
  const runtimeRegistrySnapshot = currentEffectiveRuntimeRegistrySnapshot();
  const strategyRegistry = options.strategyRegistry ?? runtimeRegistrySnapshot?.strategyRegistry ??
    buildStrategyRegistrySnapshotFromDefinitions({definitions: getRegisteredScenes(), overlayGeneration: 'mcp-base'});
  if (runManifestAttributionSink && !runtimeRegistrySnapshot) {
    throw new Error('effective_runtime_registry_snapshot_missing_for_run');
  }
  let pinnedSkillRegistry: SkillRegistryView =
    runtimeRegistrySnapshot?.skillRegistry ?? skillRegistry;
  let pinnedSkillRegistryFingerprint =
    runtimeRegistrySnapshot?.skillRegistry.registryFingerprint ?? 'built_in';
  const skillAdapter = createSkillAnalysisAdapter(
    traceProcessorService,
    undefined,
    {
      registry: pinnedSkillRegistry,
      registryFingerprint: pinnedSkillRegistryFingerprint,
    },
  );
  skillExecutor.setRunManifestAttributionSink(runManifestAttributionSink);
  runManifestAttributionSink?.recordSkillRegistry(
    buildSkillRegistryAttribution(pinnedSkillRegistry),
  );
  const codeAwareMode = normalizeCodeAwareMode(options.codeAwareMode);
  const sourceUsePolicy = options.sourceUsePolicy;
  const codebaseIds = codeAwareMode === 'off'
    ? []
    : Array.from(new Set(options.codebaseIds ?? [])).filter(Boolean);
  const knowledgeSourceIds = Array.from(new Set(options.knowledgeSourceIds ?? [])).filter(Boolean);
  const retrievedContextSafety = loadPromptTemplate('retrieved-context-tool-safety');
  if (!retrievedContextSafety) {
    throw new Error('Missing required retrieved-context-safety prompt template');
  }
  const retrievedContextToolBoundary = retrievedContextSafety.replace(/\s+/g, ' ').trim();
  const retrievedData = <T extends Record<string, unknown>>(payload: T): T & {
    dataTrust: 'untrusted_retrieved_data';
  } => ({...payload, dataTrust: 'untrusted_retrieved_data'});
  const ragToolResult = (
    result: RagRetrievalResult | SanitizedRagResult,
    shape: 'inline' | 'nested',
  ) => {
    // A top-level reason denotes whole-retrieval failure; zero hits alone do not.
    const success = result.unsupportedReason === undefined;
    const payload = shape === 'nested' ? {success, result} : {...result};
    return {
      _meta: runtimeToolReceiptMetadata({success}),
      content: [{type: 'text' as const, text: JSON.stringify(retrievedData(payload))}],
      ...(success ? {} : {isError: true}),
    };
  };
  const filterAndRecordKnowledgeDocuments = (
    value: SanitizedRagResult,
  ): SanitizedRagResult => {
    const exactKeys = (
      record: Record<string, unknown>,
      allowed: readonly string[],
    ) => Object.keys(record).every(key => allowed.includes(key));
    if (
      !value
      || typeof value !== 'object'
      || Array.isArray(value)
      || !exactKeys(value as unknown as Record<string, unknown>, [
        'query',
        'hits',
        'probed',
        'retrievedAt',
        'unsupportedReason',
        'legacyPath',
        'backgroundKnowledgeReferences',
      ])
      || typeof value.query !== 'string'
      || !Array.isArray(value.hits)
      || !Array.isArray(value.probed)
      || !value.probed.every(entry => typeof entry === 'string')
      || !Number.isFinite(value.retrievedAt)
      || typeof value.legacyPath !== 'boolean'
      || (
        value.unsupportedReason !== undefined
        && typeof value.unsupportedReason !== 'string'
      )
      || (
        value.backgroundKnowledgeReferences !== undefined
        && (
          !Array.isArray(value.backgroundKnowledgeReferences)
          || value.backgroundKnowledgeReferences.some(reference =>
            !reference
            || typeof reference !== 'object'
            || Array.isArray(reference)
            || Object.values(reference).some(field =>
              typeof field !== 'string' && field !== undefined)
          )
        )
      )
    ) {
      throw new Error('evaluation_knowledge_payload_invalid');
    }
    const hits = value.hits.flatMap(hit => {
      if (
        !hit
        || typeof hit !== 'object'
        || Array.isArray(hit)
        || !exactKeys(hit as unknown as Record<string, unknown>, [
          'chunkId',
          'score',
          'metadata',
          'snippet',
          'unsupportedReason',
          'redactedCount',
        ])
        || typeof hit.chunkId !== 'string'
        || !hit.chunkId.trim()
        || !Number.isFinite(hit.score)
        || (
          hit.snippet !== undefined
          && typeof hit.snippet !== 'string'
        )
        || (
          hit.unsupportedReason !== undefined
          && typeof hit.unsupportedReason !== 'string'
        )
        || (
          hit.redactedCount !== undefined
          && !Number.isSafeInteger(hit.redactedCount)
        )
        || (
          hit.metadata !== undefined
          && (
            !hit.metadata
            || typeof hit.metadata !== 'object'
            || Array.isArray(hit.metadata)
            || Object.values(hit.metadata).some(field =>
              field !== undefined
              && typeof field !== 'string'
              && typeof field !== 'number'
              && typeof field !== 'boolean'
              && (
                !field
                || typeof field !== 'object'
                || Array.isArray(field)
                || !exactKeys(field as Record<string, unknown>, ['start', 'end'])
                || Object.values(field).some(boundary =>
                  !Number.isSafeInteger(boundary))
              )
            )
          )
        )
      ) {
        throw new Error('evaluation_knowledge_payload_invalid');
      }
      const normalizedHit = {
        chunkId: hit.chunkId,
        score: hit.score,
        ...(hit.metadata === undefined ? {} : {metadata: hit.metadata}),
        ...(hit.snippet === undefined ? {} : {snippet: hit.snippet}),
        ...(hit.unsupportedReason === undefined
          ? {}
          : {unsupportedReason: hit.unsupportedReason}),
        ...(hit.redactedCount === undefined
          ? {}
          : {redactedCount: hit.redactedCount}),
      };
      if (normalizedHit.snippet === undefined) return [normalizedHit];
      const contentHash = canonicalContentHash(normalizedHit);
      const decision = registerEvaluationInjection({
        category: 'knowledgeDocs',
        id: hit.chunkId,
        contentHash,
        placement: 'mcp:knowledge_lookup',
      });
      if (!decision.allowed) return [];
      runManifestAttributionSink?.recordInjection(
        'knowledgeDocs',
        hit.chunkId,
        contentHash,
      );
      return [normalizedHit];
    });
    return {...value, hits};
  };
  const knowledgeSourceCapabilityHint = knowledgeSourceIds.length > 0
    ? ` Request-authorized knowledge source ids: ${knowledgeSourceIds.join(', ')}.`
    : ' No private knowledge source is authorized for this request.';
  const externalKnowledgeRegistry = options.externalKnowledgeRegistry ??
    getDefaultExternalKnowledgeSourceRegistry();
  const codebaseRegistry = options.codebaseRegistry ?? getDefaultCodebaseRegistry();
  const onDemandSourceAccess = options.onDemandSourceAccess ??
    new OnDemandSourceAccessService({registry: codebaseRegistry});
  const codeGraphNavigator = options.codeGraphNavigator ??
    new GitNexusCodeGraphNavigator({registry: codebaseRegistry});
  const ragStore = options.ragStore ?? getRagStore();
  const androidInternalsPackStore = options.androidInternalsPackStore === undefined
    ? getDefaultAndroidInternalsPackStore(options.androidInternalsPackPin)
    : options.androidInternalsPackStore ?? undefined;
  const analysisContextSelection = {codeAwareMode, codebaseIds, knowledgeSourceIds};
  const privateAnalysisContext = analysisContextUsesPrivateKnowledge(analysisContextSelection);
  const pinnedAnalysisContextFingerprint = options.analysisContextFingerprint ??
    buildAnalysisContextAuthorizationFingerprint(analysisContextSelection, knowledgeScope ?? {}, {
      codebaseRegistry,
      knowledgeRegistry: externalKnowledgeRegistry,
    });
  const pinnedCodebaseGenerations = Object.fromEntries(codebaseIds.flatMap(codebaseId => {
    const ref = codebaseRegistry.get(codebaseId, knowledgeScope);
    return ref ? [[codebaseId, activeCodebaseGeneration(ref)]] : [];
  }));
  const pinnedKnowledgeSourceGenerations = Object.fromEntries(knowledgeSourceIds.flatMap(sourceId => {
    const source = externalKnowledgeRegistry.get(sourceId, knowledgeScope ?? {});
    return source?.activeGeneration ? [[sourceId, source.activeGeneration]] : [];
  }));
  const assertPrivateAnalysisContextCurrent = (): void => {
    const currentFingerprint = buildAnalysisContextAuthorizationFingerprint(
      analysisContextSelection,
      knowledgeScope ?? {},
      {codebaseRegistry, knowledgeRegistry: externalKnowledgeRegistry},
    );
    if (currentFingerprint !== pinnedAnalysisContextFingerprint) {
      throw new Error('analysis_context_changed_restart_required');
    }
  };
  const codeLookupLedger = options.codeLookupLedger ?? (
    options.sessionId
      ? CodeLookupLedger.restore(
          options.sessionId,
          sourceUsePolicy?.phase === 'deep_enrichment'
            ? Number.MAX_SAFE_INTEGER
            : 12_000,
          2,
          undefined,
          pinnedAnalysisContextFingerprint,
        )
      : undefined
  );
  const activeCodebaseGenerations = (ids: readonly string[]): Record<string, string> => {
    assertPrivateAnalysisContextCurrent();
    return Object.fromEntries(ids.flatMap(codebaseId => {
      const generation = pinnedCodebaseGenerations[codebaseId];
      return generation ? [[codebaseId, generation]] : [];
    }));
  };
  const toolRequestScope: ToolRequestScope = {
    sessionId: options.sessionId ?? traceId,
    hasCodebaseAccess: codeAwareMode !== 'off' && codebaseIds.length > 0,
    allowNewEvidence: options.allowNewEvidence,
  };
  const initialSourceUseDecision = toolRequestScope.hasCodebaseAccess
    ? sanitizeSourceUseDecision({
        schemaVersion: SOURCE_USE_DECISION_SCHEMA_VERSION,
        codeAwareMode,
        selectedCodebaseIds: codebaseIds,
        status: options.allowNewEvidence === false ? 'not_needed' : 'pending',
        ...(options.allowNewEvidence === false ? {reasonCode: 'not_needed'} : {}),
        attemptedTools: [],
        queriedCodebaseIds: [],
        usedCodebaseIds: [],
        references: [],
      }, codebaseIds)
    : undefined;
  let sourceUseDecision = initialSourceUseDecision?.selectedCodebaseIds.length
    ? initialSourceUseDecision
    : undefined;
  let explicitSourceUseDecisionReason: string | undefined;
  const sourceExecutionScope: SourceExecutionScopeV1 = {
    codeAwareMode,
    selectedCodebaseIds: [...codebaseIds],
    hasCodebaseAccess: toolRequestScope.hasCodebaseAccess === true,
    analysisContextFingerprint: pinnedAnalysisContextFingerprint,
  };
  const sourceUse: SourceUseDecisionAccessor = {
    getSourceUseDecision: () => sourceUseDecision
      ? structuredClone(sourceUseDecision)
      : undefined,
    getSourceExecutionScope: () => {
      try {
        assertPrivateAnalysisContextCurrent();
        return structuredClone(sourceExecutionScope);
      } catch {
        // Finalization also runs on errors/cancellation. Losing scope authority
        // must withhold a receipt rather than replace the original failure.
        return undefined;
      }
    },
  };

  const syncSourceUseDecisionStatusToPlan = (): void => {
    const plan = options.analysisPlan?.current;
    if (!plan) return;
    if (sourceUseDecision) {
      plan.sourceUseDecisionStatus = sourceUseDecision.status;
    } else {
      delete plan.sourceUseDecisionStatus;
    }
  };

  const commitSourceUseDecision = (value: SourceUseDecisionV1): void => {
    const sanitized = sanitizeSourceUseDecision(value, codebaseIds);
    if (!sanitized || sanitized.selectedCodebaseIds.length === 0) return;
    sourceUseDecision = sanitized;
    syncSourceUseDecisionStatusToPlan();
  };

  // Admission precedes provider delivery. Never expose a new source body or
  // location that the bounded, current-run provenance ledger cannot retain.
  const issuedSourceReferences = new Map<string, SourceReferenceV1>();
  const admitSourceItems = <T>(items: readonly T[], referenceFor: (item: T) => unknown) => {
    const known = issuedSourceReferences;
    const admitted: T[] = [];
    const references: SourceReferenceV1[] = [];
    let incompleteReason: 'source_reference_limit_exceeded' | 'invalid_source_reference' | undefined;
    for (const item of items) {
      const reference = sanitizeSourceReference(referenceFor(item));
      if (!reference || !codebaseIds.includes(reference.codebaseId)) {
        incompleteReason ??= 'invalid_source_reference';
        continue;
      }
      if (!known.has(reference.id) && known.size >= MAX_SOURCE_REFERENCE_COUNT) {
        incompleteReason = 'source_reference_limit_exceeded';
        continue;
      }
      known.set(reference.id, reference);
      admitted.push(item);
      references.push(reference);
    }
    return {items: admitted, references: sanitizeSourceReferences(references), incompleteReason};
  };

  type SourceLookupObservation = {
    toolName: string;
    codebaseIds: readonly string[];
    references?: readonly SourceReferenceV1[];
    bodyAvailable?: boolean;
    success: boolean;
    coverageComplete?: boolean;
    incompleteReasons?: readonly string[];
  };
  const observeSourceLookup = (observation: SourceLookupObservation): void => {
    let current = sourceUseDecision;
    if (!current) return;
    const selected = new Set(current.selectedCodebaseIds);
    const queriedCodebaseIds = observation.codebaseIds.filter(id => selected.has(id));
    if (queriedCodebaseIds.length === 0) return;
    if (explicitSourceUseDecisionReason) {
      // A model's earlier decision cannot conceal later execution facts.
      current = {...current, status: 'pending', reasonCode: undefined,
        coverageComplete: undefined, incompleteReasons: undefined};
      explicitSourceUseDecisionReason = undefined;
    }
    const references = sanitizeSourceReferences(observation.references ?? [])
      .filter(reference => selected.has(reference.codebaseId));
    const incompleteReasons = [...new Set((observation.incompleteReasons ?? [])
      .map(sanitizeSourceIncompleteReason)
      .filter((reason): reason is string => Boolean(reason)))];
    const incomplete = observation.coverageComplete === false || incompleteReasons.length > 0;
    const mayCorroborate = codeAwareMode === 'provider_send' &&
      observation.bodyAvailable === true &&
      references.some(reference => reference.lookupKind === 'body' || reference.lookupKind === 'indexed');
    const observedStatus = incomplete
      ? 'search_incomplete'
      : references.length > 0
        ? mayCorroborate ? 'corroborated' : 'located'
        : observation.success && observation.coverageComplete === true
          ? 'not_found_complete'
          : 'attempted';
    const rank = {
      pending: 0,
      attempted: 1,
      not_found_complete: 2,
      located: 3,
      corroborated: 4,
    } as const;
    const currentRank = current.status in rank
      ? rank[current.status as keyof typeof rank]
      : Number.POSITIVE_INFINITY;
    const observedRank = observedStatus in rank
      ? rank[observedStatus as keyof typeof rank]
      : Number.POSITIVE_INFINITY;
    const status = current.status === 'search_incomplete'
      ? current.status
      : observedStatus === 'search_incomplete'
        ? observedStatus
        : observedRank >= currentRank ? observedStatus : current.status;
    const reasonCode = status === 'search_incomplete' || status === 'not_found_complete'
      ? status
      : undefined;
    commitSourceUseDecision({
      ...current,
      status,
      reasonCode,
      attemptedTools: [...new Set([...current.attemptedTools, observation.toolName])],
      queriedCodebaseIds: [...new Set([...current.queriedCodebaseIds, ...queriedCodebaseIds])],
      usedCodebaseIds: [...new Set([
        ...current.usedCodebaseIds,
        ...references.map(reference => reference.codebaseId),
      ])],
      ...(status === 'search_incomplete'
        ? {
            coverageComplete: false,
            incompleteReasons: [...new Set([
              ...(current.incompleteReasons ?? []),
              ...incompleteReasons,
              ...(incompleteReasons.length === 0 ? ['coverage_incomplete'] : []),
            ])],
          }
        : observation.coverageComplete === true && current.coverageComplete !== false
          ? {coverageComplete: true}
          : {}),
      references: sanitizeSourceReferences([...current.references, ...references]),
    });
  };

  const observeSourceOperation = async <T>(
    toolName: CodeLookupLedgerEntry['toolName'],
    queriedCodebaseIds: readonly string[],
    operation: () => T | Promise<T>,
  ): Promise<T> => {
    observeSourceLookup({toolName, codebaseIds: queriedCodebaseIds, success: false});
    const startedAt = Date.now();
    try {
      return await operation();
    } catch (error) {
      for (const codebaseId of new Set(queriedCodebaseIds.filter(id => codebaseIds.includes(id)))) {
        codeLookupLedger?.record({turn: 0, ts: Date.now(), toolName, codebaseId,
          chunkIds: [], returnedReferenceCount: 0, tokensSpent: 0,
          consentApplied: codeAwareMode === 'provider_send', outcome: 'rejected', legacyPath: false,
          durationMs: Date.now() - startedAt});
      }
      await codeLookupLedger?.flush();
      throw error;
    }
  };

  const observeOnDemandSourceLookup = (
    toolName: 'search_codebase' | 'read_codebase_file',
    result: {
      success: boolean;
      codebaseId: string;
      matches?: Array<{
        referenceId: string;
        codebaseId: string;
        filePath: string;
        lineRange: {start: number; end: number};
        text?: string;
      }>;
      reference?: {
        referenceId: string;
        codebaseId: string;
        filePath: string;
        lineRange: {start: number; end: number};
        text?: string;
      };
      coverageComplete?: boolean;
      searchIncompleteReason?: string;
      unsupportedReason?: string;
      truncated: boolean;
    },
  ) => {
    const rawReferences = [...(result.matches ?? []), ...(result.reference ? [result.reference] : [])];
    const admitted = admitSourceItems(rawReferences, reference => ({
      ...reference,
      lookupKind: codeAwareMode === 'provider_send' && reference.text ? 'body' : 'metadata',
    }));
    const delivered = {
      ...result,
      ...(result.matches ? {matches: admitted.items} : {}),
      ...(result.reference ? {reference: admitted.items[0]} : {}),
      sourceReferences: admitted.references,
      ...(admitted.incompleteReason ? toolName === 'search_codebase'
        ? {coverageComplete: false, truncated: true, searchIncompleteReason: admitted.incompleteReason}
        : {success: false, unsupportedReason: admitted.incompleteReason} : {}),
    };
    const incompleteReasons = [
      delivered.searchIncompleteReason,
      admitted.incompleteReason,
      ...(result.unsupportedReason === 'budget_exceeded' ? ['budget_exceeded'] : []),
      ...(toolName === 'search_codebase' && result.truncated && result.coverageComplete !== true ? ['result_truncated'] : []),
    ].filter((reason): reason is string => Boolean(reason));
    observeSourceLookup({
      toolName,
      codebaseIds: [result.codebaseId],
      references: admitted.references,
      bodyAvailable: admitted.items.some(reference => Boolean(reference.text)),
      success: delivered.success,
      ...(typeof delivered.coverageComplete === 'boolean'
        ? {coverageComplete: delivered.coverageComplete}
        : {}),
      incompleteReasons,
    });
    return delivered;
  };

  const observeGraphSourceLookup = (
    toolName: 'query_code_graph' | 'inspect_code_symbol',
    result: {
      success: boolean;
      codebaseId: string;
      references: Array<{
        referenceId: string;
        codebaseId: string;
        filePath: string;
        lineRange?: {start: number; end: number};
        symbol?: string;
      }>;
      truncated: boolean;
      unsupportedReason?: string;
    },
  ) => {
    const admitted = admitSourceItems(result.references, reference => ({...reference, lookupKind: 'graph'}));
    const delivered = {...result, references: admitted.items, sourceReferences: admitted.references,
      ...(admitted.incompleteReason ? {truncated: true, unsupportedReason: admitted.incompleteReason, processes: []} : {})};
    observeSourceLookup({
      toolName,
      codebaseIds: [result.codebaseId],
      references: admitted.references,
      success: result.success,
      ...(delivered.truncated ? {coverageComplete: false} : {}),
      incompleteReasons: [
        ...(admitted.incompleteReason ? [admitted.incompleteReason] : []),
        ...(result.truncated ? ['result_truncated'] : []),
        ...(result.unsupportedReason === 'budget_exceeded' ? ['budget_exceeded'] : []),
      ],
    });
    return delivered;
  };

  const indexedSourceReference = (hit: SanitizedRagHit) => ({
    chunkId: hit.chunkId,
    codebaseId: hit.metadata?.codebaseId,
    filePath: hit.metadata?.filePath,
    lineRange: hit.metadata?.lineRange,
    symbol: hit.metadata?.symbol,
    buildId: hit.metadata?.buildId,
    commitHash: hit.metadata?.commitHash,
    sourceGeneration: hit.metadata?.sourceGeneration,
    lookupKind: codeAwareMode === 'provider_send' && hit.snippet ? 'indexed' : 'metadata',
  });
  const observeIndexedSourceLookup = (
    toolName: 'lookup_app_source' | 'lookup_kernel_source' | 'lookup_aosp_source' | 'lookup_oem_sdk',
    result: SanitizedRagResult,
    queriedCodebaseIds: readonly string[],
    bodyAdmissionReason?: string,
  ) => {
    const registeredHits = result.hits.filter(hit => hit.metadata?.codebaseId);
    const admitted = admitSourceItems(registeredHits, indexedSourceReference);
    const incompleteReason = admitted.incompleteReason ?? bodyAdmissionReason;
    const admittedHits = new Set(admitted.items);
    const delivered = {...result,
      hits: result.hits.filter(hit => !hit.metadata?.codebaseId || admittedHits.has(hit)),
      sourceReferences: admitted.references,
      ...(incompleteReason
        ? {coverageComplete: false, searchIncompleteReason: incompleteReason}
        : {}),
    };
    const blockingReasons = [
      incompleteReason,
      result.unsupportedReason,
      ...result.hits.flatMap(hit => hit.unsupportedReason === 'budget_exceeded'
        ? [hit.unsupportedReason]
        : []),
    ].filter((reason): reason is string => Boolean(reason));
    observeSourceLookup({
      toolName,
      codebaseIds: queriedCodebaseIds,
      references: admitted.references,
      bodyAvailable: delivered.hits.some(hit => typeof hit.snippet === 'string' && hit.snippet.length > 0),
      success: result.unsupportedReason === undefined,
      ...(blockingReasons.length > 0 ? {coverageComplete: false} : {}),
      incompleteReasons: blockingReasons,
    });
    return delivered;
  };
  const filterIndexedSourceLookup = async (
    toolName: Parameters<typeof observeIndexedSourceLookup>[0],
    raw: RagRetrievalResult,
    queriedCodebaseIds: readonly string[],
  ) => {
    let bodyAdmissionReason: string | undefined;
    const filtered = await observeSourceOperation(toolName, queriedCodebaseIds, () => filterRagLookup(raw, {toolName, turn: 0, codebaseRegistry,
      ledger: codeLookupLedger, allowProviderSend: codeAwareMode === 'provider_send',
      sessionId: options.sessionId, knowledgeScope,
      admitSourceHit: hit => {
        const admitted = admitSourceItems([hit], indexedSourceReference);
        bodyAdmissionReason ??= admitted.incompleteReason;
        return admitted.items.length > 0;
      },
    }));
    return observeIndexedSourceLookup(toolName, filtered, queriedCodebaseIds, bodyAdmissionReason);
  };
  let skillRuntimeRegistryBound = false;
  let directWorkspaceRegistryPromise:
    | ReturnType<typeof getWorkspaceSkillRegistry>
    | undefined;

  function paneSideForTraceSide(traceSide: TraceProcessorTraceSide): TraceProcessorPaneSide | undefined {
    return options.comparisonContext?.tracePairContext?.panes.find(pane => pane.traceSide === traceSide)?.side;
  }

  function toolNarrationOptions(): ToolNarrationOptions {
    const tracePairContext = options.comparisonContext?.tracePairContext;
    return tracePairContext ? { tracePairContext } : {};
  }

  function tracePaneDisplayLabel(paneSide: TraceProcessorPaneSide): string {
    switch (paneSide) {
      case 'left':
        return localize(outputLanguage, '左侧', 'left pane');
      case 'right':
        return localize(outputLanguage, '右侧', 'right pane');
      case 'top':
        return localize(outputLanguage, '上方', 'top pane');
      case 'bottom':
        return localize(outputLanguage, '下方', 'bottom pane');
    }
  }

  function traceRoleDisplayLabel(traceSide: TraceProcessorTraceSide): string {
    return traceSide === 'reference'
      ? localize(outputLanguage, '对比 Trace', 'comparison trace')
      : localize(outputLanguage, '基线 Trace', 'baseline trace');
  }

  function traceLocationDisplayLabel(traceSide: TraceProcessorTraceSide): string {
    const paneSide = paneSideForTraceSide(traceSide);
    const roleLabel = traceRoleDisplayLabel(traceSide);
    return paneSide ? `${tracePaneDisplayLabel(paneSide)}/${roleLabel}` : roleLabel;
  }

  function comparisonSqlProducerReason(traceSide: TraceProcessorTraceSide): string {
    const traceLabel = traceLocationDisplayLabel(traceSide);
    return localize(
      outputLanguage,
      `执行${traceLabel} SQL，验证对比差异。`,
      `Run SQL on the ${traceLabel} to verify comparison deltas.`,
    );
  }

  function buildScopedTraceProvenance(
    targetTraceId: string,
    traceSide: TraceProcessorTraceSide,
  ): TraceProcessorQueryProvenance {
    return buildTraceProcessorQueryProvenance({
      traceId: targetTraceId,
      traceSide,
      paneSide: paneSideForTraceSide(traceSide),
    });
  }

  async function bindSkillRuntimeRegistry(): Promise<SkillRegistryView> {
    if (!skillRuntimeRegistryBound) {
      if (
        !runtimeRegistrySnapshot
        && knowledgeScope?.tenantId
        && knowledgeScope.workspaceId
      ) {
        directWorkspaceRegistryPromise ??= getWorkspaceSkillRegistry({
          tenantId: knowledgeScope.tenantId,
          workspaceId: knowledgeScope.workspaceId,
          userId: knowledgeScope.userId,
        });
        const handle = await directWorkspaceRegistryPromise;
        pinnedSkillRegistry = handle.registry;
        pinnedSkillRegistryFingerprint = handle.registryFingerprint;
      }
      // Production runs receive an executor that was initialized from the
      // same frozen snapshot before MCP construction. Never replace that
      // registry while a run is active. The fallback mutation is limited to
      // legacy/direct MCP use that has no run snapshot.
      if (!runtimeRegistrySnapshot) {
        skillAdapter.setSkillRegistry(
          pinnedSkillRegistry,
          pinnedSkillRegistryFingerprint,
        );
        skillExecutor.replaceRegisteredSkills(
          pinnedSkillRegistry.getAllSkills(),
        );
        skillExecutor.setFragmentRegistry(
          typeof pinnedSkillRegistry.getFragmentCache === 'function'
            ? pinnedSkillRegistry.getFragmentCache()
            : new Map(),
        );
      }
      skillRuntimeRegistryBound = true;
    }
    runManifestAttributionSink?.recordSkillRegistry(
      buildSkillRegistryAttribution(pinnedSkillRegistry),
    );
    return pinnedSkillRegistry;
  }

  function collectUnavailableExpectedSkillErrors(
    phases: ReadonlyArray<Pick<PlanPhase, 'id' | 'expectedTools' | 'expectedCalls'>>,
    registry: SkillRegistryView,
    availableToolNames: ReadonlySet<string>,
  ): string[] {
    return phases.flatMap(phase => {
      const errors: string[] = [];
      for (const tool of phase.expectedTools ?? []) {
        const toolName = shortExpectedToolName(tool);
        if (toolName && !availableToolNames.has(toolName)) {
          errors.push(`${phase.id}.expectedTools references unavailable MCP tool "${toolName}"`);
        }
      }
      for (const [index, call] of (phase.expectedCalls ?? []).entries()) {
        const toolName = shortExpectedToolName(call.tool);
        if (toolName && !availableToolNames.has(toolName)) {
          errors.push(`${phase.id}.expectedCalls[${index}] references unavailable MCP tool "${toolName}"`);
          continue;
        }
        if (!call.skillId) continue;
        const skill = registry.getSkill(call.skillId);
        if (!skill) {
          errors.push(`${phase.id}.expectedCalls[${index}] references unavailable analysis skill "${call.skillId}"`);
        } else if (skill.type === 'pipeline_definition' || skill.type === 'comparison') {
          errors.push(`${phase.id}.expectedCalls[${index}] references non-executable metadata skill "${call.skillId}"`);
        }
      }
      return errors;
    });
  }

  function suggestRegisteredSkillIds(
    unavailableExpectedSkills: readonly string[],
    registry: SkillRegistryView,
  ): string[] {
    const genericTokens = new Set([
      'analysis', 'detail', 'frame', 'jank', 'render', 'rendering', 'skill', 'trace',
    ]);
    const unavailableIds = unavailableExpectedSkills.flatMap(error => {
      const match = /(?:unavailable analysis skill|non-executable metadata skill) "([^"]+)"/.exec(error);
      return match?.[1] ? [match[1]] : [];
    });
    if (unavailableIds.length === 0) return [];

    const requestTokens = new Set(unavailableIds.flatMap(skillId =>
      skillId.toLowerCase().split(/[^a-z0-9]+/)
        .filter(token => token.length >= 3 && !genericTokens.has(token)),
    ));
    if (requestTokens.size === 0) return [];

    return registry.getAllSkills()
      .filter(skill => skill.type !== 'pipeline_definition' && skill.type !== 'comparison')
      .map(skill => {
        const normalizedName = skill.name.toLowerCase();
        const score = [...requestTokens].reduce(
          (sum, token) => sum + (normalizedName.includes(token) ? token.length : 0),
          0,
        );
        return {skillId: skill.name, score};
      })
      .filter(candidate => candidate.score > 0)
      .sort((left, right) => right.score - left.score || left.skillId.localeCompare(right.skillId))
      .slice(0, 8)
      .map(candidate => candidate.skillId);
  }

  function unavailableSkillResult(skillId: string, options: {comparison?: boolean} = {}) {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          success: false,
          ...(options.comparison ? {partial: false} : {}),
          unavailable: true,
          skillId,
          error: localize(
            outputLanguage,
            `分析 Skill 不存在或未在当前会话注册：${skillId}`,
            `Analysis Skill is unavailable or not registered for this session: ${skillId}`,
          ),
          action_required: 'list_skills',
        }),
      }],
      isError: true,
    };
  }

  function executePreparedSkill(skillId: string, selectedTraceId: string, params: Record<string, any>,
    inherited: Record<string, any>, processScope?: EffectiveProcessScope) {
    return processScope ? skillExecutor.execute(skillId, selectedTraceId, params, inherited, processScope)
      : skillExecutor.execute(skillId, selectedTraceId, params, inherited);
  }

  /** Normalize skill params while respecting the target Skill's declared inputs. */
  function normalizeSkillParams(
    params: Record<string, any> | undefined,
    defaultPackage?: string,
    skill?: SkillDefinition,
  ): Record<string, any> {
    const p = { ...params };
    for (const key of Object.keys(p)) {
      if (TIMESTAMP_EXPRESSION_PARAM_KEYS.has(key)) {
        p[key] = normalizeTimestampExpression(p[key]);
      }
    }
    const declaredNames = new Set((skill?.inputs ?? []).map(input => input.name));
    const acceptsProcessIdentity = !skill || [...getConsumableProcessIdentitySelectors(skill)]
      .some(key => key === 'process_name' || key === 'package');
    if (acceptsProcessIdentity && defaultPackage && !hasProcessIdentitySelector(p)) {
      p[declaredNames.has('process_name') && !declaredNames.has('package') ? 'process_name' : 'package'] = defaultPackage;
    }
    return p;
  }

  function undeclaredModelSkillParams(
    skill: SkillDefinition,
    params: Record<string, any> | undefined,
    beforeEnrichment = false,
  ): string[] {
    if (!params) return [];
    const reserved = Object.keys(params).filter(key => key === '__process_scope' || key.startsWith('__process_scope.'));
    const selectors = getConsumableProcessIdentitySelectors(skill);
    const allowed = new Set([...(skill.inputs || []).map(input => input.name), ...selectors]);
    if (beforeEnrichment) {
      const registered = findDrillDownSkillConfig(skill.name);
      if (registered?.dropEntityParamAfterResolution) {
        for (const [key, source] of Object.entries(registered.paramMapping)) {
          if (source === `${registered.entityType}Id`) allowed.add(key);
        }
      }
    }
    // Legacy definitions without input schemas remain open for ordinary params,
    // but identity selectors still need a declared consumer.
    return [...new Set([...reserved, ...Object.keys(params).filter(key =>
      !allowed.has(key) && (Boolean(skill.inputs) || PROCESS_IDENTITY_SELECTORS.includes(key)))])].sort();
  }

  function referenceSharedParamsForComparison(
    params: Record<string, any> | undefined,
    currentDefaultPackage?: string,
    referenceDefaultPackage?: string,
    skill?: SkillDefinition,
  ): { params: Record<string, any>; identityRemapped: boolean } {
    if (hasProcessIdentitySelector(params)) return {params: {...params}, identityRemapped: false};
    const normalized = normalizeSkillParams(params, referenceDefaultPackage, skill);
    return {params: normalized, identityRemapped: hasProcessIdentitySelector(normalized) &&
      referenceDefaultPackage !== currentDefaultPackage};
  }

  /**
   * Consume and prepend any watchdog warning to a tool result.
   * This is the feedback channel from runtime watchdog → Claude's execution context.
   * When the watchdog detects repetitive tool failures, the warning appears
   * in the NEXT tool result, which Claude reads and can act upon.
   */
  function consumeWatchdogWarning(resultText: string): string {
    if (watchdogRef?.current) {
      const warning = watchdogRef.current;
      watchdogRef.current = null; // consume once
      return `⚠️ SYSTEM WARNING: ${warning}\n\n${resultText}`;
    }
    return resultText;
  }

  function rawSqlProcessIdentityWarning(sql: string): string | undefined {
    if (!sqlUsesProcessNameFilter(sql)) return undefined;
    return localize(
      outputLanguage,
      'Raw SQL 使用了进程/包名过滤；Process Identity Gate 只会自动保护 invoke_skill。信任这个 SQL 结论前，先用 process_identity_resolver 确认 canonical_package_name 与 recommended_process_name_param，或优先改用对应 Skill。',
      'Raw SQL uses process/package-name filters; Process Identity Gate only protects invoke_skill automatically. Before trusting this SQL result, verify canonical_package_name and recommended_process_name_param with process_identity_resolver, or prefer the matching skill.',
    );
  }

  function skipSqlQuotedText(sql: string, index: number, quote: string): number {
    let i = index + 1;
    while (i < sql.length) {
      if (sql[i] === quote) {
        if (sql[i + 1] === quote) {
          i += 2;
          continue;
        }
        return i + 1;
      }
      i += 1;
    }
    return sql.length;
  }

  function skipSqlIgnoredText(sql: string, index: number): number {
    const char = sql[index];
    const next = sql[index + 1];
    if (char === '-' && next === '-') {
      let i = index + 2;
      while (i < sql.length && sql[i] !== '\n' && sql[i] !== '\r') i += 1;
      return i;
    }
    if (char === '/' && next === '*') {
      let i = index + 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i += 1;
      return Math.min(sql.length, i + 2);
    }
    if (char === '\'' || char === '"' || char === '`') return skipSqlQuotedText(sql, index, char);
    if (char === '[') {
      let i = index + 1;
      while (i < sql.length && sql[i] !== ']') i += 1;
      return Math.min(sql.length, i + 1);
    }
    return index;
  }

  function readSqlIdentifierToken(sql: string, index: number): { value: string; end: number } | null {
    const char = sql[index];
    if (char === '\'' || char === '"' || char === '`') {
      const end = skipSqlQuotedText(sql, index, char);
      const inner = sql.slice(index + 1, end - 1).split(`${char}${char}`).join(char);
      return { value: inner, end };
    }
    if (char === '[') {
      const end = skipSqlIgnoredText(sql, index);
      return { value: sql.slice(index + 1, end - 1), end };
    }

    let i = index;
    while (i < sql.length && /[A-Za-z0-9_$-]/.test(sql[i])) i += 1;
    if (i === index) return null;
    return { value: sql.slice(index, i), end: i };
  }

  function readSqlTableNameAfterFromOrJoin(sql: string, index: number): { tableName: string; end: number } | null {
    let i = index;
    while (i < sql.length && /\s/.test(sql[i])) i += 1;
    if (sql[i] === '(') return null;

    let token = readSqlIdentifierToken(sql, i);
    if (!token) return null;
    let tableName = token.value;
    i = token.end;

    while (i < sql.length && /\s/.test(sql[i])) i += 1;
    if (sql[i] === '.') {
      i += 1;
      while (i < sql.length && /\s/.test(sql[i])) i += 1;
      token = readSqlIdentifierToken(sql, i);
      if (!token) return { tableName, end: i };
      tableName = token.value;
      i = token.end;
    }

    return { tableName, end: i };
  }

  const tableAliasBoundaryWord = /^(WHERE|JOIN|LEFT|RIGHT|INNER|OUTER|CROSS|FULL|NATURAL|GROUP|ORDER|LIMIT|ON|USING|HAVING|UNION|EXCEPT|INTERSECT|WINDOW|QUALIFY|VALUES)$/i;

  function readOptionalSqlAliasEnd(sql: string, index: number): number {
    let i = index;
    while (i < sql.length && /\s/.test(sql[i])) i += 1;
    const asMatch = /^AS\b/i.exec(sql.slice(i));
    if (asMatch) {
      i += asMatch[0].length;
      while (i < sql.length && /\s/.test(sql[i])) i += 1;
    }

    const token = readSqlIdentifierToken(sql, i);
    if (!token || tableAliasBoundaryWord.test(token.value)) return index;
    return token.end;
  }

  function isArtifactPseudoTableName(tableName: string): boolean {
    const lower = tableName.toLowerCase();
    return (
      lower !== '__intrinsic_batch_frame_root_cause' &&
      (
        /^__intrinsic_[a-z_]\w*$/i.test(tableName) ||
        /^art[-_]\d+(?:[-_]\w+)*$/i.test(tableName) ||
        lower === 'synthesizeartifacts' ||
        lower === 'synthesize_artifacts' ||
        lower === 'artifacts'
      )
    );
  }

  function findArtifactPseudoTableNameInReference(sql: string, index: number): { tableName: string | null; end: number | null } {
    const table = readSqlTableNameAfterFromOrJoin(sql, index);
    if (!table) return { tableName: null, end: null };
    const end = readOptionalSqlAliasEnd(sql, table.end);
    return {
      tableName: isArtifactPseudoTableName(table.tableName) ? table.tableName : null,
      end: Math.max(table.end, end),
    };
  }

  function findArtifactPseudoTableName(sql: string): string | null {
    let i = 0;
    while (i < sql.length) {
      const skipped = skipSqlIgnoredText(sql, i);
      if (skipped !== i) {
        i = skipped;
        continue;
      }

      if (/[A-Za-z_]/.test(sql[i])) {
        const wordStart = i;
        while (i < sql.length && /[A-Za-z0-9_]/.test(sql[i])) i += 1;
        const word = sql.slice(wordStart, i);
        if (/^FROM$/i.test(word)) {
          while (i < sql.length) {
            const reference = findArtifactPseudoTableNameInReference(sql, i);
            if (reference.tableName) return reference.tableName;
            if (reference.end === null) break;
            i = reference.end;
            while (i < sql.length && /\s/.test(sql[i])) i += 1;
            if (sql[i] !== ',') break;
            i += 1;
          }
          continue;
        }
        if (/^JOIN$/i.test(word)) {
          const reference = findArtifactPseudoTableNameInReference(sql, i);
          if (reference.tableName) return reference.tableName;
          if (reference.end !== null) i = Math.max(i, reference.end);
        }
        continue;
      }

      i += 1;
    }

    return null;
  }

  function findArtifactPseudoFunctionReference(
    sql: string,
  ): { functionName: string; artifactId: string } | null {
    let i = 0;
    while (i < sql.length) {
      const skipped = skipSqlIgnoredText(sql, i);
      if (skipped !== i) {
        i = skipped;
        continue;
      }

      if (!/[A-Za-z_]/.test(sql[i])) {
        i += 1;
        continue;
      }
      const wordStart = i;
      while (i < sql.length && /[A-Za-z0-9_]/.test(sql[i])) i += 1;
      const functionName = sql.slice(wordStart, i);
      if (!/^(?:read|query|fetch)_artifact(?:_rows)?$/i.test(functionName)) continue;

      let argsStart = i;
      while (argsStart < sql.length && /\s/.test(sql[argsStart])) argsStart += 1;
      const artifactMatch = /^\(\s*(['"])(?:art[-_])(\d+)\1/i.exec(sql.slice(argsStart));
      if (artifactMatch?.[2]) {
        return {functionName, artifactId: `art-${artifactMatch[2]}`};
      }
    }
    return null;
  }

  function artifactSqlMisuseHint(sql: string, language: OutputLanguage): Record<string, unknown> | null {
    const functionReference = findArtifactPseudoFunctionReference(sql);
    const tableName = findArtifactPseudoTableName(sql);
    if (!functionReference && !tableName) return null;
    const artifactNumber = tableName ? /^art[-_](\d+)/i.exec(tableName)?.[1] : undefined;
    const artifactId = functionReference?.artifactId ?? (artifactNumber ? `art-${artifactNumber}` : undefined);
    const pseudoReference = functionReference?.functionName ?? tableName!;

    return {
      success: false,
      blocked: true,
      error: localize(
        language,
        `${pseudoReference} 不是 trace_processor SQL 表或函数。Skill 返回的 art-* / synthesizeArtifacts 是 SmartPerfetto artifact 引用，不能用 execute_sql 查询。`,
        `${pseudoReference} is not a trace_processor SQL table or function. art-* / synthesizeArtifacts from Skill results are SmartPerfetto artifact references and cannot be queried with execute_sql.`,
      ),
      action_required: 'fetch_artifact',
      ...(artifactId ? {artifactId} : {}),
      hint: artifactId
        ? `Use fetch_artifact(artifactId="${artifactId}", detail="summary") first. Read the minimum rows needed only if the summary lacks a required field or the user explicitly requests row-level data.`
        : 'Use fetch_artifact(artifactId="art-N", detail="summary") first with the artifactId returned by invoke_skill. Read the minimum rows needed only if the summary lacks a required field or the user explicitly requests row-level data.',
      sql,
    };
  }

  /** Planning is optional; a submitted plan keeps its revision and evidence obligations. */
  const analysisPlanRef = options.analysisPlan;
  // Phase 1-C: Conditional REASONING_NUDGE — only append for first N data tool calls.
  // After N calls, Claude should have internalized the reflect habit from system prompt.
  const REASONING_NUDGE_MAX_CALLS = 4;
  let dataToolCallCount = 0;
  function getReasoningNudge(): string {
    dataToolCallCount++;
    if (dataToolCallCount > REASONING_NUDGE_MAX_CALLS) return '';
    return outputLanguage === 'en' ? REASONING_NUDGE_EN : REASONING_NUDGE_ZH;
  }

  let evidenceProducerOrdinal = 0;
  type PlanPhaseAttribution = 'active' | 'inferred' | 'missing' | 'ambiguous' | 'unexpected_tool' | 'none';
  function toolInputToPlanCallRecord(
    toolName: string,
    input: Record<string, unknown>,
    matchedPhaseId?: string,
  ): ToolCallRecord {
    const skillId = typeof input.skillId === 'string' ? input.skillId : undefined;
    return {
      toolName,
      timestamp: Date.now(),
      ...(skillId ? { skillId } : {}),
      ...(matchedPhaseId ? { matchedPhaseId } : {}),
    };
  }

  function autoStartPhaseForEvidence(
    phase: PlanPhase,
    toolName: string,
    input: Record<string, unknown>,
  ): boolean {
    const plan = analysisPlanRef?.current;
    if (!plan || phase.status !== 'pending') return false;

    closeSupersededInProgressPhases(plan, phase);
    phase.status = 'in_progress';
    delete phase.completionSource;
    phase.completedAt = undefined;
    phase.summary = undefined;

    const narration = formatToolCallNarration(toolName, input, outputLanguage, toolNarrationOptions());
    // The consumer prefixes the phase name; this text is the reason only.
    const summary = narration.slice(0, 260);

    emitUpdate?.({
      type: 'plan_phase_updated',
      content: planPhaseUpdatedContent({ phaseId: phase.id, status: 'in_progress', summary, phaseName: phase.name, origin: 'auto' }),
      timestamp: Date.now(),
    });

    return true;
  }

  function closeSupersededInProgressPhases(plan: AnalysisPlanV3, nextPhase: PlanPhase): void {
    const nextIndex = plan.phases.findIndex(p => p.id === nextPhase.id);
    for (const other of plan.phases) {
      if (other.id === nextPhase.id || other.status !== 'in_progress') continue;

      const otherIndex = plan.phases.findIndex(p => p.id === other.id);
      if (otherIndex >= 0 && nextIndex >= 0 && otherIndex < nextIndex) {
        const toolCallLog = Array.isArray(plan.toolCallLog) ? plan.toolCallLog : [];
        const evidenceStatus = getPhaseToolEvidenceStatus(plan, other, toolCallLog);
        if (!evidenceStatus.satisfied) {
          other.status = 'pending';
          other.completedAt = undefined;
          other.summary = undefined;
          emitUpdate?.({
            type: 'plan_phase_updated',
            content: planPhaseUpdatedContent({
              phaseId: other.id,
              status: 'pending',
              // The consumer prefixes the phase name and status; repeating
              // both here rendered them twice on the same line.
              summary: localize(
                outputLanguage,
                `已进入后续阶段「${nextPhase.name}」，但仍缺少关键工具证据。`,
                `Moved behind "${nextPhase.name}" but still missing required tool evidence.`,
              ),
              phaseName: other.name,
              origin: 'auto',
            }),
            timestamp: Date.now(),
          });
          continue;
        }

        const summary = other.summary ?? '';
        other.status = 'completed';
        other.completedAt = Date.now();
        other.summary = summary;
        emitUpdate?.({
          type: 'plan_phase_updated',
          content: planPhaseUpdatedContent({ phaseId: other.id, status: 'completed', summary, phaseName: other.name, origin: 'auto' }),
          timestamp: Date.now(),
        });
      } else {
        other.status = 'pending';
        other.completedAt = undefined;
        other.summary = undefined;
      }
    }
  }

  function laterInProgressPhase(plan: AnalysisPlanV3, phase: PlanPhase): PlanPhase | undefined {
    const phaseIndex = plan.phases.findIndex(p => p.id === phase.id);
    if (phaseIndex < 0) return undefined;
    return plan.phases.find((p, index) => p.status === 'in_progress' && index > phaseIndex);
  }

  function bindPendingPhaseForEvidence(
    phase: PlanPhase,
    toolName: string,
    input: Record<string, unknown>,
  ): { phase: PlanPhase; attribution: PlanPhaseAttribution; warning?: string } {
    const plan = analysisPlanRef?.current;
    const laterActive = plan ? laterInProgressPhase(plan, phase) : undefined;
    if (plan && phase.status === 'pending' && laterActive) {
      // Dispatch can bind a backfill, but only the completed result recorder
      // may close it. The query has not run yet at this point.
      return {phase, attribution: 'inferred'};
    }

    autoStartPhaseForEvidence(phase, toolName, input);
    return { phase, attribution: 'active' };
  }

  function activePlanPhaseForEvidence(
    toolName: string,
    input: Record<string, unknown>,
  ): { phase?: PlanPhase; attribution: PlanPhaseAttribution; warning?: string } {
    const plan = analysisPlanRef?.current;
    if (!plan) return {attribution: 'none'};
    const resolution = resolvePlanPhaseForCall(plan, toolInputToPlanCallRecord(toolName, input),
      typeof input.planPhaseId === 'string' ? input.planPhaseId : undefined);
    if (!resolution.phase) {
      return {attribution: resolution.attribution === 'ambiguous' ? 'ambiguous' : 'unexpected_tool'};
    }
    if (resolution.phase.status === 'pending') return bindPendingPhaseForEvidence(resolution.phase, toolName, input);
    return {phase: resolution.phase, attribution: resolution.phase.status === 'in_progress' ? 'active' : 'inferred'};
  }

  function createEvidenceProducerContext(
    toolName: string,
    input: Record<string, unknown>,
    producerReason: string,
    suffix?: string,
  ): EvidenceProducerContext {
    const {toolInput: evidenceInput} = splitPlanAttribution(input);
    const summary = summarizeToolCallInput(toolName, evidenceInput);
    const phaseResolution = activePlanPhaseForEvidence(toolName, input);
    const phase = phaseResolution.phase;
    const paramsHash = summary.paramsHash || evidenceHash(evidenceInput);
    const ordinal = ++evidenceProducerOrdinal;
    const sourceToolCallId = [toolName, ordinal, paramsHash, suffix].filter(Boolean).join(':');
    return {
      sourceToolCallId, paramsHash,
      planPhaseId: phase?.id,
      planPhaseTitle: phase?.name,
      planPhaseGoal: phase?.goal,
      planPhaseAttribution: phaseResolution.attribution,
      planPhaseWarning: phaseResolution.warning,
      toolNarration: formatToolCallNarration(toolName, evidenceInput, outputLanguage, toolNarrationOptions()),
      producerReason,
    };
  }

  async function detectArchitecturePayload(signal?: AbortSignal): Promise<Record<string, unknown>> {
    throwIfTraceProcessorQueryCancelled(signal);
    const serializeArchitectureEvidence = (info: ArchitectureInfo) =>
      (info.evidence ?? []).map(e => ({
        source: e.source,
        type: e.type,
        value: e.value,
        weight: e.weight,
      }));
    if (options.cachedArchitecture) {
      const info = options.cachedArchitecture;
      return {
        type: info.type,
        confidence: info.confidence,
        evidence: serializeArchitectureEvidence(info),
        flutter: info.flutter,
        compose: info.compose,
        webview: info.webview,
        additionalInfo: info.additionalInfo,
        cached: true,
      };
    }
    const detector = createArchitectureDetector();
    const info = await detector.detect({ traceId, traceProcessorService, packageName, signal });
    return {
      type: info.type,
      confidence: info.confidence,
      evidence: serializeArchitectureEvidence(info),
      flutter: info.flutter,
      compose: info.compose,
      webview: info.webview,
      additionalInfo: info.additionalInfo,
    };
  }

  function retainArchitectureReceipt(producer: EvidenceProducerContext): void {
    // Architecture detection is heuristic context, not a captured SQL cell.
    // Retain its issued locator so a citation remains explicitly unverified.
    const envelope = createDataEnvelope({columns: [], rows: []}, {
      type: 'diagnostic', source: 'detect_architecture', title: 'detect_architecture',
      evidenceRefId: producer.sourceToolCallId,
      ...producerEnvelopeOptions(producer), traceId, traceSide: 'current',
    });
    artifactStore?.registerStandaloneEvidenceCapture?.(
      captureEvidenceTable(undefined, {}, 'execution_witness_unavailable'),
      {meta: envelope.meta, display: envelope.display},
    );
  }

  // Auto-inject `INCLUDE PERFETTO MODULE ...;` for stdlib tables/functions
  // referenced in raw SQL. Shared between execute_sql and execute_sql_on
  // so comparison-mode queries get the same treatment. See
  // sqlIncludeInjector.ts for the full rationale.
  async function runRawSqlWithIncludeInjection(
    targetTraceId: string,
    sql: string,
    traceSide: TraceProcessorTraceSide = 'current',
    signal?: AbortSignal,
  ) {
    throwIfTraceProcessorQueryCancelled(signal);
    const normalized = normalizeRawSql(sql);
    const { sql: finalSql, injected } = injectStdlibIncludes(normalized.sql);
    const traceProvenance = buildScopedTraceProvenance(targetTraceId, traceSide);
    if (emitUpdate && injected.length > 0) {
      emitUpdate({
        type: 'progress',
        content: {
          phase: 'analyzing',
          message: localize(
            outputLanguage,
            `自动加载 stdlib 模块: ${injected.join(', ')}`,
            `Auto-loaded stdlib module(s): ${injected.join(', ')}`,
          ),
        },
        timestamp: Date.now(),
      });
    }
    const result = await traceProcessorService.query(targetTraceId, finalSql, { signal });
    return {
      result,
      finalSql,
      injected,
      traceProvenance,
      normalizedSql: normalized.sql,
      sqlRewrites: normalized.rewrites,
    };
  }

  const executeSql = tool(
    'execute_sql',
    requireToolDescription('prompt-execute-sql-tool-description') + '\n\n' +
    requireToolDescription('prompt-sql-evidence-guidance'),
    {
      planPhaseId: z.string().optional().describe('Optional explicit plan phase ID for this invocation.'),
      sql: z.string().describe(
        'The SQL query to execute. Use Perfetto stdlib tables/functions (e.g. android_jank_cuj, slice, thread, process).'
      ),
      summary: z.boolean().optional().describe(
        'When true, returns column statistics (min/max/avg/percentiles) + 10 most interesting sample rows instead of full results. Use for large result sets where you need aggregate understanding, not row-level data. Default: false.'
      ),
    },
    async ({ sql, summary, planPhaseId }, extra) => {
      const signal = getRuntimeToolSignal(extra);
      throwIfTraceProcessorQueryCancelled(signal);
      const artifactSqlHint = artifactSqlMisuseHint(sql, outputLanguage);
      if (artifactSqlHint) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(artifactSqlHint) }],
          isError: true,
        };
      }

      const producer = createEvidenceProducerContext(
        'execute_sql',
        {sql, summary, planPhaseId},
        localize(outputLanguage, '执行当前 Trace SQL，验证本阶段的具体数据点。', 'Run SQL on the current trace to verify this phase of evidence.'),
      );
      try {
        const sqlStart = Date.now();
        const { result, finalSql, injected, traceProvenance, normalizedSql, sqlRewrites } = await runRawSqlWithIncludeInjection(
          traceId,
          sql,
          'current',
          signal,
        );
        const processIdentityWarning = rawSqlProcessIdentityWarning(normalizedSql);
        const success = !result.error;
        const executionWitness = success ? captureRawSqlEvidence(result, {traceId, traceSide: 'current'}) : undefined;
        const columnUnits = projectEvidenceColumnUnitsForModel(
          {columns: result.columns, rows: result.rows}, executionWitness);
        const truncated = result.rows.length > 200;
        const rows = truncated ? result.rows.slice(0, 200) : result.rows;
        const sqlArtifact = success && result.columns.length > 0 && result.rows.length > SQL_RAW_INLINE_ROW_LIMIT
          ? storeSqlResultArtifact(artifactStore, {
              toolName: 'execute_sql',
              executionWitness,
              columns: result.columns,
              rows: result.rows,
              sql: finalSql,
              stdlibInjectedModules: injected,
              traceProvenance,
              producer,
            })
          : undefined;
        const shouldReturnSqlSummary = success && result.rows.length > 0 && (summary || !!sqlArtifact);

        const sqlDuration = Date.now() - sqlStart;
        if (emitUpdate && sqlDuration > 500) {
          emitUpdate({
            type: 'progress',
            content: {
              phase: 'analyzing',
              message: localize(
                outputLanguage,
                `SQL 查询完成 (${result.rows.length} 行, ${sqlDuration}ms)`,
                `SQL query completed (${result.rows.length} rows, ${sqlDuration}ms)`,
              ),
            },
            timestamp: Date.now(),
          });
        }

        let emittedEvidence: { evidenceRefId: string; queryHash: string; queryReview?: QueryReviewV1 } | undefined;

        if (emitUpdate && !success && result.error) {
          emitUpdate({
            type: 'progress',
            content: {
              phase: 'analyzing',
              message: localize(
                outputLanguage,
                'SQL 查询未产出可用结果，已记录诊断信息供修正后重试。',
                'SQL query did not produce usable results; diagnostic details were recorded for a corrected retry.',
              ),
            },
            timestamp: Date.now(),
          });
        }

        // SQL error-fix pair learning: capture errors and match subsequent fixes
        if (!success && result.error) {
          recentSqlErrors.push({ errorSql: sql, errorMessage: result.error, timestamp: Date.now() });
          // Keep only last 10 errors in memory
          if (recentSqlErrors.length > 10) recentSqlErrors.shift();
        } else if (success && recentSqlErrors.length > 0) {
          // Match error-fix pairs by timestamp proximity (same turn, within 60s)
          // and structural similarity (>30% token overlap via Jaccard similarity).
          // SQL structural keywords + Perfetto domain tokens are excluded to avoid
          // false matches between unrelated queries that share common vocabulary.
          const matchingError = recentSqlErrors.find(e => {
            // Must be within 60 seconds (covers multi-turn reasoning gaps)
            if (Date.now() - e.timestamp > 60_000) return false;
            // Require reasonable structural similarity (not a totally different query)
            const errorTokens = sqlContentTokens(e.errorSql);
            const fixTokens = sqlContentTokens(sql);
            if (errorTokens.size === 0) return false;
            let intersection = 0;
            for (const t of errorTokens) {
              if (fixTokens.has(t)) intersection++;
            }
            const union = new Set([...errorTokens, ...fixTokens]).size;
            const jaccard = union > 0 ? intersection / union : 0;
            return jaccard > 0.3; // At least 30% token overlap
          });
          if (matchingError) {
            // Private source/RAG runs may learn within this in-memory turn, but
            // raw SQL and provider errors must never cross the durable boundary.
            if (!privateAnalysisContext) {
            await logSqlErrorFixPair(
              { ...matchingError, fixedSql: sql },
              knowledgeScope,
            );
            }
            const idx = recentSqlErrors.indexOf(matchingError);
            if (idx >= 0) recentSqlErrors.splice(idx, 1);
          }
        }

        // Summary mode: return column statistics + sample rows instead of raw data.
        // M3: large raw SQL results automatically take this path and expose the
        // full row set through a paginated artifact reference.
        if (shouldReturnSqlSummary) {
          const summaryResult = summarizeSqlResult(result.columns, result.rows);
          if (emitUpdate) {
            emittedEvidence = emitSqlSummaryDataEnvelope(
              emitUpdate,
              summaryResult,
              finalSql,
              injected,
              traceProvenance,
              producer,
              processIdentityWarning,
              sqlArtifact?.artifactId,
              {
                durationMs: result.durationMs,
                truncated: false,
                captureStore: artifactStore, executionWitness,
                sqlRewrites,
                toolName: 'execute_sql',
                outputLanguage,
              },
            );
            updateSqlArtifactQueryReview(artifactStore, sqlArtifact, emittedEvidence.queryReview);
          }
          return createRuntimeToolResult({
            success: true,
            mode: 'summary',
            autoSummarized: !summary && !!sqlArtifact,
            totalRows: summaryResult.totalRows,
            columns: summaryResult.columns,
            columnStats: summaryResult.columnStats,
            sampleRows: summaryResult.sampleRows,
            sampleRowIndices: summaryResult.sampleRowIndices,
            ...(columnUnits ? {columnUnits} : {}),
            ...(sqlArtifact ? {
              artifactId: sqlArtifact.artifactId,
              artifact: sqlArtifact.artifactSummary,
              rowsAvailableViaArtifact: true,
              pageSize: SQL_ARTIFACT_PAGE_SIZE,
              hint: `Use the current summary first. Fetch detail="rows" from artifactId="${sqlArtifact.artifactId}" only when a required field or representative sample is missing, or the user explicitly requests row-level data; read the minimum rows needed.`,
            } : {}),
            durationMs: result.durationMs,
            traceSide: traceProvenance.traceSide,
            traceId: traceProvenance.traceId,
            traceProvenance,
            evidenceRefId: emittedEvidence?.evidenceRefId,
            ...(emittedEvidence?.queryReview ? { queryReview: compactQueryReviewForToolResponse(emittedEvidence.queryReview) } : {}),
            sourceToolCallId: producer.sourceToolCallId,
            paramsHash: producer.paramsHash,
            planPhaseId: producer.planPhaseId,
            executableSql: finalSql,
            ...(sqlRewrites.length > 0 ? { sqlRewrites } : {}),
            stdlibInjectedModules: injected,
            ...(processIdentityWarning ? { processIdentityWarning } : {}),
          }, {
            decorate: text => consumeWatchdogWarning(text) + getReasoningNudge(),
          });
        }

        if (emitUpdate && success && result.columns.length > 0) {
          emittedEvidence = emitSqlDataEnvelope(
            emitUpdate,
            result.columns,
            rows,
            finalSql,
            injected,
            traceProvenance,
            producer,
            processIdentityWarning,
            undefined,
            {
              durationMs: result.durationMs,
              truncated,
              captureStore: artifactStore, executionWitness,
              sqlRewrites,
              toolName: 'execute_sql',
              rowCount: result.rows.length,
              outputLanguage,
            },
          );
        }

        return createRuntimeToolResult(success ? {
          success,
          columns: result.columns,
          rows,
          ...(columnUnits ? {columnUnits} : {}),
          totalRows: result.rows.length,
          truncated,
          durationMs: result.durationMs,
          traceSide: traceProvenance.traceSide,
          traceId: traceProvenance.traceId,
          traceProvenance,
          evidenceRefId: emittedEvidence?.evidenceRefId,
          ...(emittedEvidence?.queryReview ? { queryReview: compactQueryReviewForToolResponse(emittedEvidence.queryReview) } : {}),
          sourceToolCallId: producer.sourceToolCallId,
          paramsHash: producer.paramsHash,
          planPhaseId: producer.planPhaseId,
          executableSql: finalSql,
          ...(sqlRewrites.length > 0 ? { sqlRewrites } : {}),
          stdlibInjectedModules: injected,
          ...(processIdentityWarning ? { processIdentityWarning } : {}),
        } : buildSqlFailureToolPayload({
          error: result.error || localize(outputLanguage, 'SQL 执行失败', 'SQL execution failed'),
          traceSide: traceProvenance.traceSide,
          traceId: traceProvenance.traceId,
          traceProvenance,
          sourceToolCallId: producer.sourceToolCallId,
          paramsHash: producer.paramsHash,
          planPhaseId: producer.planPhaseId,
          executableSql: finalSql,
          sqlRewrites,
          stdlibInjectedModules: injected,
          processIdentityWarning,
          durationMs: result.durationMs,
          outputLanguage,
        }), {
          decorate: text => consumeWatchdogWarning(text + (success ? getReasoningNudge() : '')),
        });
      } catch (err) {
        rethrowIfTraceProcessorQueryCancelled(err);
        const errMsg = (err as Error).message;
        const traceProvenance = buildScopedTraceProvenance(traceId, 'current');
        emitUpdate?.({
          type: 'progress',
          content: {
            phase: 'analyzing',
            message: localize(
              outputLanguage,
              'SQL 查询未产出可用结果，已记录诊断信息供修正后重试。',
              'SQL query did not produce usable results; diagnostic details were recorded for a corrected retry.',
            ),
          },
          timestamp: Date.now(),
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(buildSqlFailureToolPayload({
            traceSide: 'current',
            traceId,
            traceProvenance,
            sourceToolCallId: producer.sourceToolCallId,
            paramsHash: producer.paramsHash,
            planPhaseId: producer.planPhaseId,
            error: errMsg,
            executableSql: sql,
            outputLanguage,
          })) }],
          isError: true,
        };
      }
    },
    { annotations: { readOnlyHint: true } },
  );

  const invokeSkill = tool(
    'invoke_skill',
    requireToolDescription('prompt-invoke-skill-tool-description'),
    {
      planPhaseId: z.string().optional().describe('Optional explicit plan phase ID for this invocation.'),
      skillId: z.string().describe('Skill identifier (e.g. "scrolling_analysis", "jank_frame_detail", "cpu_analysis")'),
      params: z.record(z.string(), z.any()).optional().describe(
        'Optional parameters to pass to the skill. Common: { process_name, start_ts, end_ts, max_frames_per_session }'
      ),
    },
    async ({ skillId, params, planPhaseId }, extra) => {
      const signal = getRuntimeToolSignal(extra);
      throwIfTraceProcessorQueryCancelled(signal);

      if (skillId === 'detect_architecture') {
        if (params?.upid != null || params?.pid != null) return createRuntimeToolResult({ success: false, skillId,
          error: 'The detect_architecture delegation does not accept trace-local UPID/PID selectors.',
          action_required: 'choose_a_skill_with_declared_exact_process_support' });
        const effectiveParams = normalizeSkillParams(params, packageName);
        const producer = createEvidenceProducerContext(
          'invoke_skill',
          {skillId, params: effectiveParams, planPhaseId},
          localize(outputLanguage, '调用 Skill detect_architecture，确认渲染架构并决定后续分析链路。', 'Run Skill detect_architecture to identify the rendering pipeline for later analysis.'),
        );
        try {
          emitUpdate?.({
            type: 'progress',
            content: {
              phase: 'analyzing',
              message: localize(outputLanguage, '检测渲染架构...', 'Detecting rendering architecture...'),
            },
            timestamp: Date.now(),
          });
          const payload = await detectArchitecturePayload(signal);
          retainArchitectureReceipt(producer);
          emitUpdate?.({
            type: 'progress',
            content: {
              phase: 'analyzing',
              message: localize(
                outputLanguage,
                `架构检测完成: ${String(payload.type ?? 'unknown')} (置信度 ${Math.round(Number(payload.confidence ?? 0) * 100)}%)`,
                `Architecture detection completed: ${String(payload.type ?? 'unknown')} (${Math.round(Number(payload.confidence ?? 0) * 100)}% confidence)`,
              ),
            },
            timestamp: Date.now(),
          });
          return createRuntimeToolResult({
            success: true,
            skillId: 'detect_architecture',
            delegatedTool: 'detect_architecture',
            evidenceRefId: producer.sourceToolCallId,
            sourceToolCallId: producer.sourceToolCallId,
            paramsHash: producer.paramsHash,
            planPhaseId: producer.planPhaseId,
            ...payload,
          }, {
            decorate: text => consumeWatchdogWarning(text) + getReasoningNudge(),
          });
        } catch (err) {
          rethrowIfTraceProcessorQueryCancelled(err);
          const errMsg = (err as Error).message;
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({
                success: false,
                skillId,
                sourceToolCallId: producer.sourceToolCallId,
                paramsHash: producer.paramsHash,
                planPhaseId: producer.planPhaseId,
                error: errMsg,
              }) }],
            isError: true,
          };
        }
      }

      try {
        const effectiveSkillRegistry = await bindSkillRuntimeRegistry();
        const skillDef = effectiveSkillRegistry.getSkill(skillId);
        if (!skillDef) return unavailableSkillResult(skillId);
        if (skillDef?.type === 'pipeline_definition' || skillDef?.type === 'comparison') {
          const useHint = skillDef.type === 'comparison'
            ? 'It describes analysis result comparison. Use the multi-trace comparison API/tools instead.'
            : 'Use `detect_architecture` to detect the rendering pipeline, or call a composite analysis skill like `scrolling_analysis`, `gpu_analysis`, etc.';
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: `Skill "${skillId}" is metadata-only and cannot be used for single-trace analysis. ${useHint}`,
              }),
            }],
          };
        }

        const normalizedParams = normalizeSkillParams(params, packageName, skillDef);
        const explicitInvalidParams = undeclaredModelSkillParams(skillDef, params, true);
        if (explicitInvalidParams.length) return createRuntimeToolResult({ success: false, skillId,
          invalidParams: explicitInvalidParams, error: `Undeclared Skill parameters: ${explicitInvalidParams.join(', ')}`,
          action_required: 'retry_invoke_skill_with_declared_params' });
        const prepared = await skillExecutor.prepareInvocation(skillId, traceId, normalizedParams,
          { __traceSide: 'current', __outputLanguage: outputLanguage, signal });
        if (!prepared.allowed) return createRuntimeToolResult({ success: false, skillId,
          error: prepared.error, action_required: 'choose_supported_exact_skill_or_correct_process_selector' });
        const paramResolution = await resolveRegisteredDrillDownSkillParams({
          skillId,
          params: prepared.params,
          processScope: prepared.processScope,
          traceId,
          traceProcessorService,
          signal,
        });
        const effectiveParams = paramResolution.params;
        const invalidParams = undeclaredModelSkillParams(skillDef, effectiveParams);
        if (invalidParams.length > 0) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                partial: false,
                skillId,
                invalidParams,
                error: `Undeclared Skill parameters: ${invalidParams.join(', ')}`,
                action_required: 'retry_invoke_skill_with_declared_params',
              }),
            }],
            isError: true,
          };
        }
        const producer = createEvidenceProducerContext(
          'invoke_skill',
          {
            skillId, planPhaseId,
            params: effectiveParams,
            ...(paramResolution.audit ? {drillDownResolution: paramResolution.audit} : {}),
          },
          localize(outputLanguage, `调用 Skill ${skillId}，收集本阶段结构化证据。`, `Run Skill ${skillId} to collect structured evidence for this phase.`),
        );
        const skillTraceProvenance = buildScopedTraceProvenance(traceId, 'current');

        emitUpdate?.({
          type: 'progress',
          content: {
            phase: 'analyzing',
            message: localize(outputLanguage, `运行分析技能: ${skillId}...`, `Running analysis skill: ${skillId}...`),
            // The tool dispatch line already said "调用 Skill <id>：<intent>" one
            // step earlier. Keep the event for progress indicators, but do not
            // spend a timeline line restating it.
            duplicatesToolCall: true,
          },
          timestamp: Date.now(),
        });

        const skillStart = Date.now();
        const currentPaneSide = paneSideForTraceSide('current');
        const executionContext = {
          ...(currentPaneSide ? { __paneSide: currentPaneSide } : {}),
          __outputLanguage: outputLanguage, __traceSide: 'current', signal,
        };
        const result = prepared.processScope
          ? await skillExecutor.execute(skillId, traceId, effectiveParams, executionContext, prepared.processScope)
          : await skillExecutor.execute(skillId, traceId, effectiveParams, executionContext);
        const skillDuration = Date.now() - skillStart;

        emitUpdate?.({
          type: 'progress',
          content: {
            phase: 'analyzing',
            // Duration is a real signal in a performance tool. The result-layer
            // count is not: the evidence line that follows already says what
            // arrived, and repeating the number twice reads as bookkeeping.
            message: localize(
              outputLanguage,
              `技能 ${skillId} 完成 (${skillDuration}ms)`,
              `Skill ${skillId} completed (${skillDuration}ms)`,
            ),
          },
          timestamp: Date.now(),
        });

        // Capture skill SQL errors in the learning system — skill SQL is the most complex
        // and most likely to break across Perfetto versions.
        // P1-3: Also persist to disk for cross-session learning (same as execute_sql errors).
        if (!result.success && result.error && result.error.includes('SQL')) {
          const errorPair: SqlErrorFixPair = {
            errorSql: `[skill:${skillId}] ${JSON.stringify(effectiveParams)}`,
            errorMessage: result.error,
            timestamp: Date.now(),
          };
          recentSqlErrors.push(errorPair);
          if (recentSqlErrors.length > 10) recentSqlErrors.shift();
          // Persist only trace-public learning. Skill params/errors can contain
          // private source text or provider echoes.
          if (!privateAnalysisContext) {
            logSqlErrorFixPair(errorPair, knowledgeScope).catch(() => {});
          }
        }

        // Artifact mode stores displayResults before emitting DataEnvelopes so
        // evidence meta can carry the same artifact ids that the model sees.
        let artifacts: SkillArtifactSummaryForModel[] | undefined;
        let diagnosticsArtifactId: string | undefined;
        let synthesizeArtifacts: Array<{ artifactId: string; stepId: string; rowCount: number; columns: string[] }> | undefined;
        const artifactIdsByDisplayIndex: Array<string | undefined> = [];
        const queryReviewsByDisplayIndex: Array<QueryReviewV1 | undefined> = [];
        const modelDisplayProjections = (result.displayResults || []).map(dr =>
          projectEvidenceTableForModel(dr.data, evidenceTableFor(dr)));
        if (artifactStore && result.displayResults?.length) {
          artifacts = result.displayResults.map((dr, displayIndex) => {
            const modelProjection = modelDisplayProjections[displayIndex];
            const evidenceRefId = stableSkillEvidenceRefId(
              result.skillId || skillId,
              dr.stepId,
              dr.title,
              dr.data,
              skillTraceProvenance,
              producer,
              dr.scopeProvenance,
            );
            const artId = artifactStore.store({
              skillId: result.skillId || skillId,
              stepId: dr.stepId,
              layer: dr.layer,
              title: dr.title,
              data: modelProjection.data,
              modelProjection: modelProjection.modelProjection,
              executionStatus: dr.executionStatus,
              executionMessage: dr.executionMessage,
              executionError: dr.executionError,
              diagnostics: undefined,
              planPhaseId: producer.planPhaseId,
              planPhaseTitle: producer.planPhaseTitle,
              planPhaseGoal: producer.planPhaseGoal,
              sourceToolCallId: producer.sourceToolCallId,
              paramsHash: producer.paramsHash,
              identityResolution: identityForScopeEvidence(dr.scopeProvenance, result.identityResolution),
              scopeProvenance: dr.scopeProvenance,
              traceProvenance: skillTraceProvenance,
            });
            const witness = evidenceTableFor(dr) || captureEvidenceTable(undefined, {}, 'display_transformation_unmapped');
            artifactStore.registerEvidenceCapture?.(artId, witness, {evidenceRefId,
              ...(dr.sql ? {queryHash: evidenceHash(dr.sql)} : {})});
            const queryReview = buildSkillQueryReview({
              skillId: result.skillId || skillId,
              displayResult: dr as SkillDisplayResult,
              traceProvenance: skillTraceProvenance,
              producer,
              artifactId: artId,
              evidenceRefId,
              outputLanguage,
            });
            if (queryReview) {
              artifactStore.updateQueryReview(artId, queryReview);
              queryReviewsByDisplayIndex[displayIndex] = queryReview;
            }
            artifactIdsByDisplayIndex[displayIndex] = artId;
            const storedSummary = artifactStore.generateCompactSummary(artId);
            const summary = storedSummary && artifactAccessPolicy.forbidRows
              ? (({preview: _preview, ...rowFreeSummary}) => rowFreeSummary)(storedSummary)
              : storedSummary;
            const preview = artifactAccessPolicy.forbidRows
              ? undefined
              : storedSummary?.preview ?? previewFromColumnarData(modelProjection.data);
            return summary ? {
              ...summary,
              ...(preview ? { preview } : {}),
              evidenceRefId,
              ...(producer.sourceToolCallId ? { sourceToolCallId: producer.sourceToolCallId } : {}),
            } : undefined;
          }).filter((summary): summary is SkillArtifactSummaryForModel => Boolean(summary));
        }

        // Store diagnostics as a separate artifact if present, even for
        // diagnostics-only skill results that do not emit displayResults.
        if (artifactStore && result.diagnostics && Array.isArray(result.diagnostics) && result.diagnostics.length > 0) {
          diagnosticsArtifactId = artifactStore.store({
            skillId: result.skillId || skillId,
            stepId: '_diagnostics',
            layer: 'diagnosis',
            title: `${skillId} diagnostics`,
            data: { columns: ['diagnostic'], rows: result.diagnostics.map((d: any) => [d]) },
            diagnostics: result.diagnostics,
            planPhaseId: producer.planPhaseId,
            planPhaseTitle: producer.planPhaseTitle,
            planPhaseGoal: producer.planPhaseGoal,
            sourceToolCallId: producer.sourceToolCallId,
            paramsHash: producer.paramsHash,
            identityResolution: identityForScopeEvidence(mergeScopeProvenance(result.diagnostics.map(diagnostic => diagnostic.scopeProvenance)), result.identityResolution),
            scopeProvenance: mergeScopeProvenance(result.diagnostics.map(diagnostic => diagnostic.scopeProvenance)),
            traceProvenance: skillTraceProvenance,
          });
        }

        // Store synthesizeData entries as artifacts too — these contain the
        // raw step data that would otherwise overflow token limits.
        if (artifactStore && result.synthesizeData && Array.isArray(result.synthesizeData) && result.synthesizeData.length > 0) {
          synthesizeArtifacts = result.synthesizeData
            .filter((sd: any) => sd.data && sd.success !== false)
            .map((sd: any) => {
              const normalizedData = normalizeSynthesizeDataForStorage(sd.data);
              const artId = artifactStore.store({
                skillId: result.skillId || skillId,
                stepId: sd.stepId,
                layer: sd.layer || 'synthesize',
                title: sd.stepName || sd.stepId,
                data: normalizedData,
                planPhaseId: producer.planPhaseId,
                planPhaseTitle: producer.planPhaseTitle,
                planPhaseGoal: producer.planPhaseGoal,
                sourceToolCallId: producer.sourceToolCallId,
                paramsHash: producer.paramsHash,
                identityResolution: identityForScopeEvidence(sd.scopeProvenance, result.identityResolution),
                scopeProvenance: sd.scopeProvenance,
                traceProvenance: skillTraceProvenance,
              });
              // A display and synthesize artifact may expose the same SQL step.
              // Keep their locators distinct without changing existing display IDs.
              const evidenceRefId = `${stableSkillEvidenceRefId(result.skillId || skillId, sd.stepId,
                sd.stepName || sd.stepId, normalizedData, skillTraceProvenance, producer, sd.scopeProvenance)}:artifact:${artId}`;
              // The normalizer flattens iterator-shaped rows and rewrites empty
              // arrays. Only its plain object-row branch preserves this table.
              const firstRow = Array.isArray(sd.data) ? sd.data[0] : undefined;
              const directRows = firstRow && typeof firstRow === 'object' &&
                !('itemIndex' in firstRow && 'result' in firstRow);
              const witness = (directRows && evidenceTableFor(sd)) ||
                captureEvidenceTable(undefined, {}, 'synthesize_transformation_unmapped');
              artifactStore.registerEvidenceCapture?.(artId, witness, {evidenceRefId});
              return {
                artifactId: artId,
                stepId: sd.stepId,
                rowCount: normalizedData.rows?.length ?? 0,
                columns: normalizedData.columns ?? [],
              };
            });
        }

        const externalAuthored =
          effectiveSkillRegistry.getSkillOrigin(skillId)?.origin ===
          'external_pack';
        const localizedDisplayResults = localizeSkillDisplayResults(
          result.skillId || skillId,
          result.displayResults,
          outputLanguage,
          {externalAuthored, parameters: effectiveParams},
        ) || [];
        const localizedDiagnostics = localizeSkillDiagnostics(
          result.diagnostics,
          outputLanguage,
          {externalAuthored},
        ) || [];
        const localizedSkillName = skillDef
          ? localizeSkillDefinition(
              skillDef,
              outputLanguage,
              {externalAuthored},
            ).meta.display_name
          : result.skillName;
        if (artifacts?.length) {
          const localizedTitleByArtifactId = new Map<string, string>();
          artifactIdsByDisplayIndex.forEach((artifactId, displayIndex) => {
            const localizedTitle = localizedDisplayResults[displayIndex]?.title;
            if (artifactId && localizedTitle) {
              localizedTitleByArtifactId.set(artifactId, localizedTitle);
            }
          });
          artifacts = artifacts.map(artifact => ({
            ...artifact,
            ...(localizedTitleByArtifactId.has(artifact.id)
              ? {title: localizedTitleByArtifactId.get(artifact.id)}
              : {}),
          }));
        }

        if (emitUpdate && localizedDisplayResults.length) {
          emitSkillDataEnvelopes(
            localizedDisplayResults as SkillDisplayResult[],
            result.skillId || skillId,
            emitUpdate,
            skillTraceProvenance,
            producer,
            result.identityResolution,
            artifactIdsByDisplayIndex,
            queryReviewsByDisplayIndex,
            result.displayResults as SkillDisplayResult[],
            outputLanguage,
            artifactStore,
          );
        }

        if (onSkillResult && result.success && localizedDisplayResults.length) {
          onSkillResult({
            skillId: result.skillId || skillId,
            displayResults: localizedDisplayResults,
          });
        }

        // Prepend skill notes when the per-analysis budget allows. Notes
        // only attach on the success path so a failed skill doesn't pollute
        // the agent's context with unrelated guidance.
        let skillNotesPrefix = '';
        if (skillNotesBudget && result.success) {
          try {
            const candidates = loadSkillNotes(result.skillId || skillId);
            if (candidates.length > 0) {
              const consumed = skillNotesBudget.tryConsume(result.skillId || skillId, candidates);
              if (consumed) skillNotesPrefix = `${consumed.text}\n\n`;
            }
          } catch (err) {
            console.warn('[invoke_skill] skill notes injection failed:', (err as Error).message);
          }
        }

        // Vendor override hint: if a vendor is detected and overrides exist for this skill,
        // include a hint in the result so Claude can consider vendor-specific analysis steps.
        let vendorOverrideHint: { vendor: string; displayName?: string; additionalStepIds: string[] } | undefined;
        const detectedVendor = options.cachedVendor;
        if (detectedVendor && detectedVendor !== 'aosp' && result.success) {
          const vendorOverride = effectiveSkillRegistry.getVendorOverride(skillId, detectedVendor);
          if (vendorOverride && vendorOverride.additionalSteps.length > 0) {
            vendorOverrideHint = {
              vendor: vendorOverride.vendor,
              displayName: vendorOverride.displayName,
              additionalStepIds: vendorOverride.additionalSteps
                .map((s: any) => s.id || s.name)
                .filter(Boolean),
            };
          }
        }

        // Artifact mode: return compact references whenever any fetchable
        // artifact was created.
        if (artifactStore && (artifacts?.length || diagnosticsArtifactId || synthesizeArtifacts?.length)) {
          // Bound inline previews, not the evidence inventory. Later, empty and
          // unavailable artifacts still need locators so findings are not lost.
          const lightweightArtifacts = options.lightweight
            ? artifacts?.map((summary, index) => {
                if (index < 10) return summary;
                const {preview: _preview, ...locator} = summary;
                return {...locator, previewOmitted: true};
              })
            : artifacts;
          return createRuntimeToolResult({
            success: result.success,
            skillId: result.skillId,
            partial: result.partial,
            scopeLimitations: result.scopeLimitations,
            scopeProvenance: result.scopeProvenance,
            skillName: localizedSkillName,
            ...(result.error ? { error: result.error } : {}),
            ...(paramResolution.audit ? {drillDownResolution: paramResolution.audit} : {}),
            ...(result.identityResolution
              ? options.lightweight
                ? {
                    identity: {
                      identityRefId: result.identityResolution.identityRefId,
                      status: result.identityResolution.status,
                      packageName: result.identityResolution.target?.packageName,
                      processName: result.identityResolution.target?.processName,
                      warnings: result.identityResolution.warnings,
                    },
                  }
                : { identityResolution: result.identityResolution }
              : {}),
            artifacts: lightweightArtifacts,
            ...(diagnosticsArtifactId ? { diagnosticsArtifactId } : {}),
            ...(synthesizeArtifacts && synthesizeArtifacts.length > 0
              ? { synthesizeArtifacts }
              : {}),
            ...(vendorOverrideHint ? { vendorOverride: vendorOverrideHint } : {}),
            hint: renderTemplate(requireToolDescription('prompt-artifact-result-guidance'), {
              forbidRows: String(artifactAccessPolicy.forbidRows),
              requireSummaryBeforeRows: String(artifactAccessPolicy.requireSummaryBeforeRows),
            }),
          }, {
            facts: {success: result.success, planPhaseId: producer.planPhaseId},
            decorate: text => skillNotesPrefix + consumeWatchdogWarning(text) + (result.success ? getReasoningNudge() : ''),
          });
        }

        // Default: return full displayResults (backward compatible)
        return createRuntimeToolResult({
          success: result.success,
          skillId: result.skillId,
          partial: result.partial,
          scopeLimitations: result.scopeLimitations,
          scopeProvenance: result.scopeProvenance,
          skillName: localizedSkillName,
          ...(result.error ? { error: result.error } : {}),
          ...(paramResolution.audit ? {drillDownResolution: paramResolution.audit} : {}),
          ...(result.identityResolution ? { identityResolution: result.identityResolution } : {}),
          ...(vendorOverrideHint ? { vendorOverride: vendorOverrideHint } : {}),
          displayResults: localizedDisplayResults.map((dr, index) => ({
            stepId: dr.stepId,
            title: dr.title,
            layer: dr.layer,
            data: modelDisplayProjections[index]?.data ?? dr.data,
            modelProjection: modelDisplayProjections[index]?.modelProjection,
            ...(modelDisplayProjections[index]?.columnUnits
              ? {columnUnits: modelDisplayProjections[index].columnUnits} : {}),
            executionStatus: dr.executionStatus,
            executionMessage: dr.executionMessage,
            executionError: dr.executionError,
            ...scopeMetadata(dr.scopeProvenance),
          })),
          diagnostics: localizedDiagnostics,
          synthesizeData: result.synthesizeData,
        }, {
          facts: {success: result.success, planPhaseId: producer.planPhaseId},
          decorate: text => skillNotesPrefix + consumeWatchdogWarning(text) + (result.success ? getReasoningNudge() : ''),
        });
      } catch (err) {
        rethrowIfTraceProcessorQueryCancelled(err);
        const errMsg = (err as Error).message;
        emitUpdate?.({
          type: 'progress',
          content: {
            phase: 'analyzing',
            message: localize(outputLanguage, `技能 ${skillId} 执行失败: ${errMsg}`, `Skill ${skillId} failed: ${errMsg}`),
          },
          timestamp: Date.now(),
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: errMsg }) }],
          isError: true,
        };
      }
    },
    { annotations: { readOnlyHint: true } },
  );

  /**
   * Quick mode never hides a match — a truncated catalog can silently omit the
   * one skill that answers the question. Only the expensive part (descriptions)
   * is bounded; every matched id stays visible so the model can invoke it or
   * narrow with `category`.
   */
  const QUICK_SKILL_DESCRIBED_MATCHES = 15;
  const QUICK_SKILL_DESCRIPTION_CHARS = 90;

  /** First sentence of a skill description, bounded, for the quick catalog. */
  const firstSentence = (text: string | undefined, maxChars: number): string => {
    const normalized = (text ?? '').replace(/\s+/g, ' ').trim();
    const end = normalized.search(/[。.!！?？]/);
    const sentence = end > 0 ? normalized.slice(0, end + 1) : normalized;
    return sentence.length > maxChars ? `${sentence.slice(0, maxChars)}…` : sentence;
  };

  /**
   * Which matched skills get their description inside the bounded window.
   * The registry's own order is alphabetical by directory, so without this a
   * question about the network reads descriptions for `anr_*` and `binder_*`
   * and finds `network_analysis` as a bare id. Ranking only reorders: the cap
   * applies to descriptions, never to the matched set.
   *
   * Pure and stable — equal hit counts keep the incoming order.
   */
  const rankSkillsByQuery = <T extends {id: string; keywords?: string[]; tags?: string[]}>(
    items: readonly T[],
    query: string | undefined,
  ): Array<T & {matchedByQuery: boolean}> => {
    const haystack = (query ?? '').toLowerCase();
    const hits = (skill: T): number => {
      if (!haystack) return 0;
      const terms = [...(skill.keywords ?? []), ...(skill.tags ?? []), skill.id];
      // A one-character term matches nearly any question; it ranks nothing.
      return new Set(terms.map(term => term.trim().toLowerCase())
        .filter(term => term.length > 1 && haystack.includes(term))).size;
    };
    return items
      .map((skill, index) => ({skill, index, hits: hits(skill)}))
      .sort((a, b) => b.hits - a.hits || a.index - b.index)
      .map(({skill, hits: count}) => ({...skill, matchedByQuery: count > 0}));
  };

  const listSkills = tool(
    'list_skills',
    'List all available SmartPerfetto analysis skills. ' +
    'Use this to discover which skills exist before invoking one. ' +
    'Filter by category to narrow results (e.g. "scrolling", "startup", "cpu", "memory").',
    {
      category: z.string().optional().describe(
        'Optional filter: only return skills whose keywords or tags match this category'
      ),
    },
    async ({ category }) => {
      try {
        const capabilityRegistry = await bindSkillRuntimeRegistry();
        const definitions = new Map(capabilityRegistry.getAllSkills().map(skill => [skill.name, skill]));
        const fragments = capabilityRegistry.getFragmentCache?.() || new Map<string, string>();
        const scopeCapability = (id: string) => {
          const definition = definitions.get(id);
          return definition ? getExactProcessScopeSupport(definition, definitions, fragments)
            : { supported: false, reason: 'Skill definition is unavailable' };
        };
        const allSkills = await skillAdapter.listSkills(outputLanguage);
        const filtered = category
          ? allSkills.filter(s =>
              s.keywords.some(k => k.toLowerCase().includes(category.toLowerCase())) ||
              s.tags?.some(t => t.toLowerCase().includes(category.toLowerCase())) ||
              s.id.toLowerCase().includes(category.toLowerCase())
            )
          : allSkills;
        if (options.lightweight) {
          // Full descriptions for the leading matches, bare ids for the rest:
          // the catalog stays affordable in a few-turn run without any match
          // becoming invisible.
          const ranked = rankSkillsByQuery(filtered, options.userQuery);
          const described = ranked.slice(0, QUICK_SKILL_DESCRIBED_MATCHES);
          const remainingIds = ranked.slice(QUICK_SKILL_DESCRIBED_MATCHES).map(s => s.id);
          // With no query to rank against, every entry is `matchedByQuery: false`
          // — a column of noise that reads as "nothing here matches you".
          const ranksAgainstQuery = Boolean(options.userQuery?.trim());
          return {
            _meta: runtimeToolReceiptMetadata({success: true}),
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                matched: filtered.length,
                skills: described.map(s => ({
                  id: s.id,
                  displayName: s.displayName,
                  description: firstSentence(s.description, QUICK_SKILL_DESCRIPTION_CHARS),
                  ...(ranksAgainstQuery ? {matchedByQuery: s.matchedByQuery} : {}),
                  exactProcessScope: scopeCapability(s.id),
                })),
                ...(remainingIds.length > 0
                  ? {
                      otherMatchedIds: remainingIds,
                      otherScopeCapabilities: Object.fromEntries(remainingIds.map(id => [id, scopeCapability(id)])),
                      hint: 'Every matched id is listed; pass a narrower `category` for their descriptions.',
                    }
                  : {}),
              }),
            }],
          };
        }
        return {
          _meta: runtimeToolReceiptMetadata({success: true}),
          content: [{
            type: 'text' as const,
            text: JSON.stringify(
              filtered.map(s => ({
                id: s.id,
                displayName: s.displayName,
                description: s.description,
                type: s.type,
                keywords: s.keywords.slice(0, 5),
                origin: s.origin,
                localizationStatus: s.localizationStatus,
                exactProcessScope: scopeCapability(s.id),
              }))
            ),
          }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: (err as Error).message }) }],
          isError: true,
        };
      }
    },
    { annotations: { readOnlyHint: true } },
  );

  const detectArchitecture = tool(
    'detect_architecture',
    'Detect the rendering architecture of the app in the current trace. ' +
    'Returns architecture type (STANDARD/FLUTTER/COMPOSE/WEBVIEW/etc.), confidence, and evidence. ' +
    'Call this early to understand which analysis approach to use.',
    {planPhaseId: z.string().optional().describe('Optional explicit plan phase ID for this invocation.')},
    async ({planPhaseId}, extra) => {
      const signal = getRuntimeToolSignal(extra);
      throwIfTraceProcessorQueryCancelled(signal);
      const producer = createEvidenceProducerContext(
        'detect_architecture',
        {planPhaseId},
        localize(outputLanguage, '检测渲染架构，确定后续分析路径。', 'Detect rendering architecture to choose the later analysis path.'),
      );
      try {
        const payload = await detectArchitecturePayload(signal);
        retainArchitectureReceipt(producer);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              ...payload,
              success: true,
              evidenceRefId: producer.sourceToolCallId,
              sourceToolCallId: producer.sourceToolCallId,
              paramsHash: producer.paramsHash,
              planPhaseId: producer.planPhaseId,
            }),
          }],
        };
      } catch (err) {
        rethrowIfTraceProcessorQueryCancelled(err);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            success: false,
            sourceToolCallId: producer.sourceToolCallId,
            paramsHash: producer.paramsHash,
            planPhaseId: producer.planPhaseId,
            error: (err as Error).message,
          }) }],
          isError: true,
        };
      }
    },
    { annotations: { readOnlyHint: true } },
  );

  // analyze_wait_chain — the critical-path wait-chain engine, addressed by the
  // selectors a model has rather than the thread_state row id the timeline UI
  // has. `POST /api/critical-path/:traceId/analyze` keeps its own contract; this
  // shares the engine, never its AI summary.
  const analyzeWaitChain = tool(
    'analyze_wait_chain',
    requireToolDescription('prompt-analyze-wait-chain-tool-description'),
    {
      planPhaseId: z.string().optional().describe('Optional explicit plan phase ID for this invocation.'),
      thread_state_id: waitChainIntLike.optional().describe(
        'Exact thread_state row id. When given, the window comes from that row and start_ts/end_ts are ignored.'),
      utid: waitChainIntLike.optional().describe('Exact utid of the thread to analyze.'),
      upid: waitChainIntLike.optional().describe('Optional upid, to disambiguate same-named processes.'),
      pid: waitChainIntLike.optional().describe('Optional pid, to disambiguate same-named processes.'),
      process_name: z.string().max(200).optional().describe(
        'Process/package name. Matched exactly first, then as a prefix.'),
      tid: waitChainIntLike.optional().describe('Optional tid of the thread to analyze.'),
      thread_name: z.string().max(200).optional().describe(
        'Thread name, matched as a prefix (kernel comm is truncated to 15 characters).'),
      main_thread: z.boolean().optional().describe('Select the process main thread.'),
      start_ts: waitChainIntLike.optional().describe('Window start timestamp in ns. Required without thread_state_id.'),
      end_ts: waitChainIntLike.optional().describe('Window end timestamp in ns. Required without thread_state_id.'),
      max_segments: z.number().int().min(20).max(1000).optional().describe(
        'How many chain segments to display, store and recurse into; totals always cover the whole chain '
        + `(default ${CRITICAL_PATH_DEFAULTS.agent.maxSegments}).`),
      recursion_depth: z.number().int().min(0).max(2).optional().describe(
        'Levels of re-running the critical path inside the longest segments of other threads (up to 3 per '
        + `level, each at least 4 ms, at most ${CRITICAL_PATH_DEFAULTS.agent.segmentBudget} child segments in `
        + `total). The chain already follows each waker to its own waker (default ${CRITICAL_PATH_DEFAULTS.agent.recursionDepth}).`),
    },
    async (input, extra) => {
      const signal = getRuntimeToolSignal(extra);
      throwIfTraceProcessorQueryCancelled(signal);
      const {
        planPhaseId, thread_state_id: threadStateId, utid, upid, pid, process_name: processName,
        tid, thread_name: threadName, main_thread: mainThread, start_ts: startTs, end_ts: endTs,
        max_segments: maxSegments, recursion_depth: recursionDepth,
      } = input;
      const producer = createEvidenceProducerContext(
        'analyze_wait_chain',
        input as Record<string, unknown>,
        localize(
          outputLanguage,
          '追查这个线程在该区间内等什么、被谁唤醒，为后续定位收敛方向。',
          'Determine what this thread waited on in the window and who woke it, to narrow the later diagnosis.',
        ),
      );
      const refusal = (payload: Record<string, unknown>) => createRuntimeToolResult({
        ...payload,
        success: false,
        sourceToolCallId: producer.sourceToolCallId,
        paramsHash: producer.paramsHash,
        planPhaseId: producer.planPhaseId,
      }, {facts: {success: false, planPhaseId: producer.planPhaseId}, isError: true});

      try {
        let identity: ResolvedCriticalPathThread | undefined;
        let resolvedUtid: number | undefined;
        if (threadStateId === undefined) {
          if (utid !== undefined) {
            resolvedUtid = Number(utid);
          } else {
            const resolution = await resolveCriticalPathThread(traceProcessorService, traceId, {
              upid, pid, processName, tid, threadName, mainThread,
            }, {signal});
            throwIfTraceProcessorQueryCancelled(signal);
            if (resolution.status === 'ambiguous') {
              return refusal({
                error: 'ambiguous_thread_selection',
                action_required: 'narrow_thread_selection',
                candidates: resolution.candidates,
                // A lower bound, not a total: the resolver stops counting at
                // MAX_THREAD_CANDIDATES + 1, so a sixteen-thread pool reports
                // eleven and `candidatesTruncated` says the rest were not read.
                candidatesAtLeast: resolution.candidatesAtLeast,
                candidatesTruncated: resolution.candidatesAtLeast > MAX_THREAD_CANDIDATES,
              });
            }
            if (resolution.status === 'not_found') {
              return refusal({
                error: resolution.reason === 'no_selector'
                  ? 'no_thread_selector'
                  : 'thread_not_found',
                action_required: 'specify_thread',
              });
            }
            identity = resolution.thread;
            resolvedUtid = resolution.thread.utid;
          }
          if (startTs === undefined || endTs === undefined) {
            return refusal({error: 'missing_window', action_required: 'provide_start_and_end_ts'});
          }
          if (Number(endTs) <= Number(startTs)) {
            return refusal({error: 'invalid_window', action_required: 'provide_end_ts_after_start_ts'});
          }
        }

        const analyzeOptions: CriticalPathAnalyzeOptions = {
          ...(threadStateId !== undefined
            ? {threadStateId}
            : {utid: resolvedUtid, startTs, endTs}),
          maxSegments: maxSegments ?? CRITICAL_PATH_DEFAULTS.agent.maxSegments,
          recursionDepth: recursionDepth ?? CRITICAL_PATH_DEFAULTS.agent.recursionDepth,
          segmentBudget: CRITICAL_PATH_DEFAULTS.agent.segmentBudget,
          recursionEnabled: true,
          signal,
        };
        const raw = await analyzeCriticalPath(traceProcessorService, traceId, analyzeOptions);
        throwIfTraceProcessorQueryCancelled(signal);
        const analysis = renderCriticalPathAnalysis(raw, outputLanguage);

        // The summary row is captured first and the projection's headline
        // numbers are read from it, so every number the model quotes is a
        // cell it can cite.
        const flat = flattenWaitChain(analysis.wakeupChain);
        const summaryColumns = [...WAIT_CHAIN_SUMMARY_COLUMNS];
        const summary = waitChainSummaryRow(analysis, flat.length);
        const summaryRows = [summaryColumns.map(column => summary[column])];
        const projection = projectWaitChainForModel(analysis, summary, flat, outputLanguage, identity);

        const columns = [...WAIT_CHAIN_SEGMENT_COLUMNS];
        const rows = waitChainSegmentRows(flat);
        const traceProvenance = buildScopedTraceProvenance(traceId, 'current');
        const stored = storeToolTableArtifact(artifactStore, {
          toolName: 'analyze_wait_chain',
          stepId: 'wait_segments',
          title: `Wait chain segments (${rows.length})`,
          layer: 'deep',
          columns,
          rows,
          executionWitness: captureEvidenceTable({columns, rows}, WAIT_CHAIN_SEGMENT_FIELDS),
          traceProvenance,
          producer,
        });
        const storedSummary = storeToolTableArtifact(artifactStore, {
          toolName: 'analyze_wait_chain',
          stepId: 'wait_summary',
          title: 'Wait chain summary',
          layer: 'overview',
          columns: summaryColumns,
          rows: summaryRows,
          executionWitness: captureEvidenceTable({columns: summaryColumns, rows: summaryRows}, WAIT_CHAIN_SUMMARY_FIELDS),
          traceProvenance,
          producer,
        });

        // A Running selection, a window with no waiting time and a trace
        // without sched_wakeup all answer `available: false` with an empty
        // chain. An empty table in chat says less than the projection's own
        // explanation of why there is no chain.
        if (emitUpdate && stored && analysis.available && rows.length > 0) {
          const envelope = createDataEnvelope({columns, rows}, {
            type: 'diagnostic',
            source: 'analyze_wait_chain',
            title: localize(outputLanguage, '线程等待链', 'Thread wait chain'),
            layer: 'deep',
            format: 'table',
            columns: WAIT_CHAIN_SEGMENT_COLUMN_DEFS,
            evidenceRefId: stored.evidenceRefId,
            artifactId: stored.artifactId,
            sourceArtifactId: stored.artifactId,
            traceId,
            traceSide: traceProvenance.traceSide,
            paneSide: traceProvenance.paneSide,
            ...producerEnvelopeOptions(producer),
          });
          emitUpdate({type: 'data', content: [envelope], timestamp: Date.now()});
        }

        return createRuntimeToolResult({
          ...projection,
          success: true,
          // `segmentCount` counts the whole chain; this is what the artifact
          // actually holds, so a fetch of it is not read as the whole chain.
          ...(stored ? {artifactId: stored.artifactId, evidenceRefId: stored.evidenceRefId,
            storedSegmentRows: rows.length} : {}),
          // The one-row table the headline numbers come from; cite its ns cells.
          ...(storedSummary ? {summaryArtifactId: storedSummary.artifactId,
            summaryEvidenceRefId: storedSummary.evidenceRefId} : {}),
          sourceToolCallId: producer.sourceToolCallId,
          paramsHash: producer.paramsHash,
          planPhaseId: producer.planPhaseId,
          planPhaseTitle: producer.planPhaseTitle,
          planPhaseGoal: producer.planPhaseGoal,
          planPhaseAttribution: producer.planPhaseAttribution,
        }, {facts: {success: true, planPhaseId: producer.planPhaseId}});
      } catch (err) {
        rethrowIfTraceProcessorQueryCancelled(err);
        // A bad selector is the caller's to fix, not a tool malfunction: answer
        // it as a refusal that names the fix, so it never counts as a failure.
        if (err instanceof CriticalPathInputError) {
          return refusal({
            error: err.code,
            action_required: WAIT_CHAIN_INPUT_ERROR_ACTION[err.code],
            detail: err.message,
          });
        }
        return createRuntimeToolResult({
          success: false,
          error: (err as Error).message,
          sourceToolCallId: producer.sourceToolCallId,
          paramsHash: producer.paramsHash,
          planPhaseId: producer.planPhaseId,
        }, {facts: {success: false, planPhaseId: producer.planPhaseId}, isError: true});
      }
    },
    { annotations: { readOnlyHint: true } },
  );

  const lookupSqlSchema = tool(
    'lookup_sql_schema',
    'Search the Perfetto SQL stdlib index for table, view, and function definitions matching a keyword. ' +
    'Use this to discover available SQL entities before writing raw SQL queries.\n\n' +
    'Use when: you need to find table/view/function names before writing SQL, or verifying column names exist.\n' +
    'Don\'t use when: you already know the exact table name, or need the full stdlib module list (use list_stdlib_modules).\n\n' +
    'Examples:\n' +
    '1. Find frame-related tables: keyword="frame_timeline"\n' +
    '2. Find binder tables: keyword="binder"\n' +
    '3. Find thread state columns: keyword="thread_state"',
    {
      keyword: z.string().describe(
        'Search keyword (e.g. "jank", "slice", "thread_state", "android_frames")'
      ),
    },
    async ({ keyword }) => {
      const schema = loadSqlSchema();
      const lower = keyword.toLowerCase();
      const docResults = searchPerfettoSqlDocs(keyword, { limit: 30 });

      // P2-G8: Token-based fuzzy matching — split keyword into tokens and match independently
      const tokens = lower.split(/[\s_]+/).filter(t => t.length >= 2);

      // Scoring function: exact substring match scores highest, token prefix matches next
      function scoreEntry(t: { name: string; category: string; description: string; columns?: Array<{ name?: string }> }): number {
        const name = t.name.toLowerCase();
        const cat = t.category.toLowerCase();
        const desc = t.description.toLowerCase();
        const columnNames = (t.columns ?? [])
          .map(c => c.name ?? '')
          .filter(Boolean)
          .map(c => c.toLowerCase());
        const columns = columnNames.join(' ');
        const searchable = `${name} ${cat} ${desc} ${columns}`;

        if (name === lower) return 2000;
        if (columnNames.some(column => column === lower)) return 1900;
        if (name.includes(lower)) return 500;
        if (columnNames.some(column => column.includes(lower))) return 400;
        if (cat.includes(lower)) return 100;
        if (desc.includes(lower)) return 50;

        // Token-based matching: count how many query tokens match
        if (tokens.length <= 1) return 0;
        let matchedTokens = 0;
        for (const tok of tokens) {
          if (searchable.includes(tok)) matchedTokens++;
          // Prefix match on name segments (e.g., "frame_time" matches "frame_timeline")
          else if (name.split('_').some(seg => seg.startsWith(tok))) matchedTokens += 0.5;
        }
        return matchedTokens >= tokens.length * 0.5 ? matchedTokens : 0;
      }

      const scored = schema.templates
        .map(t => ({ entry: t, score: scoreEntry(t) }))
        .filter(s => s.score > 0)
        .sort((a, b) => b.score - a.score);

      const merged = new Map<string, { score: number; source: 'stdlib_docs' | 'legacy_index'; entry: Record<string, unknown> }>();
      for (const result of docResults) {
        const key = `${result.entry.module}\n${result.entry.name}\n${result.entry.type}`;
        merged.set(key, {
          score: result.score + 1000,
          source: 'stdlib_docs',
          entry: compactSqlDocEntry(result.entry),
        });
      }
      for (const legacy of scored) {
        const module = legacy.entry.module || '';
        const key = `${module}\n${legacy.entry.name}\n${legacy.entry.type}`;
        if (merged.has(key)) continue;
        merged.set(key, {
          score: legacy.score,
          source: 'legacy_index',
          entry: compactLegacySqlSchemaEntry(legacy.entry),
        });
      }

      const entries = Array.from(merged.values())
        .sort((a, b) => b.score - a.score)
        .slice(0, 30)
        .map(item => ({ ...item.entry, source: item.source }));

      return {
        _meta: runtimeToolReceiptMetadata({success: true}),
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            totalMatches: entries.length,
            sources: {
              stdlibDocs: docResults.length,
              legacyIndex: scored.length,
            },
            entries,
          }),
        }],
      };
    },
    { annotations: { readOnlyHint: true } },
  );

  // Conditional tool: write_analysis_note (only available when analysisNotes array is provided)
  const MAX_NOTES = 20;
  const writeAnalysisNote = analysisNotes ? tool(
    'write_analysis_note',
    'Persist a structured analysis note that survives context compression. ' +
    'Use this for important cross-domain observations, hypotheses, or findings that you want to reference later. ' +
    'Do NOT overuse — only record observations that would be lost if context is compressed.',
    {
      section: z.enum(['hypothesis', 'finding', 'observation', 'next_step']).describe(
        'Note category: hypothesis (untested theory), finding (confirmed result), observation (data point), next_step (planned action)'
      ),
      content: z.string().describe('The note content — be specific, include data references'),
      priority: z.enum(['high', 'medium', 'low']).optional().describe('Priority for retention when notes exceed limit. Default: medium'),
    },
    async ({ section, content, priority }) => {
      const note = { section, content, priority: priority || 'medium' as const, timestamp: Date.now() };
      analysisNotes.push(note);

      // Evict notes when over limit.
      // Priority order: next_step (ephemeral) → low (oldest first) → medium (oldest first) → oldest high
      if (analysisNotes.length > MAX_NOTES) {
        const priorityRank = { low: 0, medium: 1, high: 2 };
        // Find the best candidate to evict: lowest priority, then oldest timestamp
        let evictIdx = -1;
        let evictRank = Infinity;
        let evictTs = Infinity;

        for (let i = 0; i < analysisNotes.length; i++) {
          const n = analysisNotes[i];
          // Always prefer evicting next_step (ephemeral planning notes)
          if (n.section === 'next_step') { evictIdx = i; break; }
          const rank = priorityRank[n.priority as keyof typeof priorityRank] ?? 1;
          if (rank < evictRank || (rank === evictRank && n.timestamp < evictTs)) {
            evictRank = rank;
            evictTs = n.timestamp;
            evictIdx = i;
          }
        }
        if (evictIdx >= 0) analysisNotes.splice(evictIdx, 1);
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ success: true, totalNotes: analysisNotes.length, section, priority: priority || 'medium' }),
        }],
      };
    }
  ) : null;

  // Conditional tool: fetch_artifact (only available when artifactStore is provided)
  const artifactAccessDescription = artifactAccessPolicy.forbidRows
    ? 'This request explicitly forbids raw artifact rows. Only detail="summary" is allowed; rows/full are rejected. Summary responses omit row previews.\n\n'
    : artifactAccessPolicy.requireSummaryBeforeRows
      ? 'This request requires summary-first access per artifact. Fetch detail="summary" for that artifact before rows/full. When aggregate.complete=true, rows/full are rejected as redundant.\n\n'
      : 'Rows/full remain available when summary evidence is insufficient or the user explicitly requests row-level data.\n\n';
  const fetchArtifact = artifactStore ? tool(
    'fetch_artifact',
    'Retrieve a stored artifact. Default to detail="summary". Use detail="rows" with offset/limit only when the summary lacks a required field or representative sample, or the user explicitly requests row-level data; read the minimum rows and stop. Rows responses include totalRows and hasMore.\n\n' +
    'Use for summary or targeted row evidence from invoke_skill. Do not copy artifact rows into execute_sql. Use invoke_skill or execute_sql for new data. Set purpose to one short sentence.\n\n' +
    artifactAccessDescription +
    'Examples:\n' +
    '1. Get summary of skill result: artifactId="art-1", detail="summary"\n' +
    '2. Read a few representative jank frames missing from the summary: artifactId="art-2", detail="rows", offset=0, limit=5\n' +
    '3. Read another targeted page only if the first page lacks required evidence or the user requested complete rows: artifactId="art-2", detail="rows", offset=5, limit=5',
    {
      planPhaseId: z.string().optional().describe('Optional explicit plan phase ID for this invocation.'),
      artifactId: z.string().describe('Artifact ID (e.g. "art-1") from a previous invoke_skill response'),
      detail: z.enum(['summary', 'rows', 'full']).optional().describe(
        'Detail level: summary (default, compact stats), rows (paginated data rows), full (complete original structure — use with caution on large artifacts)'
      ),
      offset: z.coerce.number().int().min(0).optional().describe(
        'Row offset for pagination (detail="rows" only). Default: 0. Use with limit to select a targeted row window.'
      ),
      limit: z.coerce.number().int().min(0).max(200).optional().describe(
        'Maximum rows to return (detail="rows" only, 1-200). Ignored for summary/full. Default for rows: 50.'
      ),
      purpose: z.string().optional().describe(
        'One short sentence explaining why this artifact is needed for the current plan phase. Used in the user-visible timeline.'
      ),
    },
    async ({ artifactId, detail, offset, limit, purpose, planPhaseId }) => {
      const effectiveDetail = detail || 'summary';
      if (effectiveDetail === 'rows' || effectiveDetail === 'full') {
        const summaryState = artifactSummaryState.get(artifactId);
        const blockedReason = artifactAccessPolicy.forbidRows
          ? 'raw_rows_forbidden'
          : artifactAccessPolicy.requireSummaryBeforeRows && !summaryState
            ? 'summary_required_before_rows'
            : artifactAccessPolicy.forbidRowsWhenSummaryComplete && summaryState?.complete === true
              ? 'complete_summary_already_available'
              : undefined;
        if (blockedReason) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({
              success: false,
              error: 'artifact_access_policy_blocked',
              reason: blockedReason,
              artifactId,
              requestedDetail: effectiveDetail,
              hint: blockedReason === 'summary_required_before_rows'
                ? 'Fetch detail="summary" for this artifact first.'
                : 'Use the existing summary aggregate and report any remaining evidence boundary.',
            }) }],
            isError: true,
          };
        }
      }
      const usesPagination = effectiveDetail === 'rows';
      const normalizedOffset = usesPagination
        ? coerceOptionalInteger(offset, 'offset', { min: 0 })
        : {};
      const normalizedLimit = usesPagination
        ? coerceOptionalInteger(limit, 'limit', { min: 1, max: 200 })
        : {};
      const paginationErrors = [normalizedOffset.error, normalizedLimit.error].filter(Boolean);
      const producerReason = purpose || localize(
        outputLanguage,
        '读取前序证据表的明细数据，用于当前阶段判断。',
        'Read detailed rows from a previous evidence artifact for the current phase.',
      );
      if (paginationErrors.length > 0) {
        const producer = createEvidenceProducerContext(
          'fetch_artifact',
          {artifactId, detail: effectiveDetail, offset, limit, purpose, planPhaseId},
          producerReason,
        );
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            success: false,
            error: `Invalid pagination arguments: ${paginationErrors.join('; ')}`,
          }) }],
          isError: true,
        };
      }

      const result = artifactStore.fetch(artifactId, effectiveDetail, normalizedOffset.value, normalizedLimit.value);
      if (result && effectiveDetail === 'summary') {
        const complete = typeof result.aggregate?.complete === 'boolean'
          ? result.aggregate.complete
          : undefined;
        artifactSummaryState.set(artifactId, {complete});
      }
      const producer = createEvidenceProducerContext(
        'fetch_artifact',
        {
          artifactId, planPhaseId,
          detail: effectiveDetail,
          offset,
          limit,
          purpose,
          artifactPlanPhaseId: result?.planPhaseId,
          artifactPlanPhaseTitle: result?.planPhaseTitle,
          artifactTitle: result?.title,
          artifactStepId: result?.stepId,
        },
        producerReason,
      );
      if (!result) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            success: false,
            error: `Artifact ${artifactId} not found — it may have been evicted (LRU cap: 50) or lost after a backend restart. Use invoke_skill to re-execute the skill if you need this data again.`,
            sourceToolCallId: producer.sourceToolCallId,
            paramsHash: producer.paramsHash,
            planPhaseId: producer.planPhaseId,
          }) }],
          isError: true,
        };
      }
      // Phase 3-4 of v2.1 — high-risk path recitation. `full` and `rows` detail
      // levels return large payloads that push the agent's working memory; in
      // those cases append a one-line plan reminder so the agent doesn't drift
      // away from the active phase's constraints. Summary mode skips the
      // reminder (compact responses already keep the agent on-track).
      const reminder = (effectiveDetail === 'full' || effectiveDetail === 'rows')
        ? buildActivePhaseReminder(analysisPlanRef?.current, options.sceneType, strategyRegistry)
        : '';
      const responseResult = result && effectiveDetail === 'summary' && artifactAccessPolicy.forbidRows
        ? (({sampleRow: _sampleRow, preview: _preview, ...rowFreeResult}) => rowFreeResult)(result)
        : result;
      const payload = {
        success: true,
        detail: effectiveDetail,
        ...responseResult,
        sourceToolCallId: result?.sourceToolCallId || producer.sourceToolCallId,
        fetchedByToolCallId: producer.sourceToolCallId,
        artifactPlanPhaseId: result?.planPhaseId,
        artifactPlanPhaseTitle: result?.planPhaseTitle,
        artifactPlanPhaseGoal: result?.planPhaseGoal,
        paramsHash: producer.paramsHash,
        planPhaseId: producer.planPhaseId,
        planPhaseTitle: producer.planPhaseTitle,
        planPhaseGoal: producer.planPhaseGoal,
        planPhaseAttribution: producer.planPhaseAttribution,
        sourceArtifactId: artifactId,
        ...(purpose ? { purpose } : {}),
      };
      return createRuntimeToolResult(payload, {
        decorate: text => reminder ? text + reminder : text,
      });
    },
    { annotations: { readOnlyHint: true } },
  ) : null;

  // list_stdlib_modules: Expose Perfetto stdlib module inventory to the agent.
  // Enables Claude to discover available stdlib modules by namespace (e.g., "android.frames", "sched").
  const listStdlibModules = tool(
    'list_stdlib_modules',
    'List available Perfetto SQL stdlib modules by namespace. Use this to discover what pre-built tables, views, and functions ' +
    'are available before writing custom SQL. Modules can be loaded via INCLUDE PERFETTO MODULE <name> in SQL queries. ' +
    'Core modules (android.frames.timeline, android.startup.startups, android.binder) are pre-loaded; ' +
    'others load on-demand via skill prerequisites or INCLUDE PERFETTO MODULE in your SQL.',
    {
      namespace: z.string().optional().describe(
        'Filter by namespace prefix (e.g., "android", "android.frames", "sched", "chrome", "wattson"). Omit to list all.'
      ),
    },
    async ({ namespace }) => {
      const allModules = getPerfettoStdlibModules();
      const docsModules = listPerfettoSqlModuleDocs(namespace);
      // Enforce dot-boundary matching to avoid "android" matching a hypothetical "androidos.*"
      const filtered = namespace
        ? allModules.filter(m => m === namespace || m.startsWith(namespace + '.'))
        : allModules;

      // Group by top-level namespace
      const grouped: Record<string, string[]> = {};
      for (const mod of filtered) {
        const ns = mod.split('.')[0];
        if (!grouped[ns]) grouped[ns] = [];
        grouped[ns].push(mod);
      }

      return {
        _meta: runtimeToolReceiptMetadata({success: true}),
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            totalModules: filtered.length,
            namespaces: Object.keys(grouped).sort(),
            // When filtering by namespace, return full module list.
            // When unfiltered, return only counts per namespace to save context tokens (~1500 tokens).
            modules: namespace
              ? filtered.sort()
              : Object.fromEntries(Object.entries(grouped).map(([ns, mods]) => [ns, mods.length])),
            moduleDocs: namespace
              ? docsModules.slice(0, 50).map(mod => ({
                module: mod.module,
                description: mod.moduleDoc,
                tags: mod.tags,
                includes: mod.includes,
                transitiveIncludes: mod.transitiveIncludes,
                symbols: mod.symbols.slice(0, 30),
                missingIncludes: mod.missingIncludes,
                errors: mod.errors,
                sourcePath: mod.sourcePath,
              }))
              : undefined,
            hint: namespace
              ? 'Use lookup_sql_schema to find specific tables/views/functions within a module.'
              : 'Call again with a namespace (e.g., "android.frames") to see full module list. ' +
                'Critical modules (android.frames.*, android.binder*, android.startup.*, sched.*) are pre-loaded.',
          }),
        }],
      };
    },
    { annotations: { readOnlyHint: true } },
  );

  // lookup_knowledge: Load background knowledge on performance analysis topics on demand.
  // The agent calls this when it needs to explain a root cause mechanism to the user.
  // Topics are auto-discovered from knowledge-*.template.md files in the strategies directory.
  const knowledgeTopics = (() => {
    const strategiesDir = path.resolve(__dirname, '../../../strategies');
    try {
      return fs.readdirSync(strategiesDir)
        .filter(f => f.startsWith('knowledge-') && f.endsWith('.template.md'))
        .map(f => f.replace('knowledge-', '').replace('.template.md', ''))
        .sort();
    } catch {
      return ['rendering-pipeline', 'binder-ipc', 'gc-dynamics', 'cpu-scheduler', 'thermal-throttling', 'lock-contention'];
    }
  })();

  const lookupKnowledge = tool(
    'lookup_knowledge',
    'Load background knowledge about a performance analysis topic. Use this when you discover a root cause ' +
    'and want to explain the underlying mechanism to the user. Returns concise explanations of how the ' +
    'system works, common trace signatures, and typical solutions. ' +
    `Available topics: ${knowledgeTopics.join(', ')}.`,
    {
      topic: z.string().describe(
        `Knowledge topic: ${knowledgeTopics.map(t => `"${t}"`).join(' | ')}`
      ),
    },
    async ({ topic }) => {
      const content = loadPromptTemplate('knowledge-' + topic);
      if (!content) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: `Unknown topic "${topic}". Available: ${knowledgeTopics.join(', ')}`,
            }),
          }],
          isError: true,
        };
      }
      const id = `knowledge-topic-${canonicalContentHash(topic).slice(0, 16)}`;
      const contentHash = canonicalContentHash(content);
      const decision = registerEvaluationInjection({
        category: 'knowledgeDocs',
        id,
        contentHash,
        placement: 'mcp:lookup_knowledge',
      });
      if (!decision.allowed) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              unsupportedReason: 'evaluation_injection_filtered',
            }),
          }],
        };
      }
      runManifestAttributionSink?.recordInjection(
        'knowledgeDocs',
        id,
        contentHash,
      );
      return {
        _meta: runtimeToolReceiptMetadata({success: true}),
        content: [{ type: 'text' as const, text: content }],
      };
    },
    { annotations: { readOnlyHint: true } },
  );

  // lookup_blog_knowledge (Plan 55): retrieve indexed public blog chunks or,
  // only with an explicit request-scoped source capability, private Android
  // Internals Wiki chunks.
  // Read-only — calls ragStore.search() which never writes. The index
  // is populated by the M2 admin route + ingester; until then the
  // search returns `unsupportedReason='index empty'` so the agent
  // never invents content.
  const lookupBlogKnowledge = tool(
    'lookup_blog_knowledge',
    `Retrieve public blog, signed built-in Android Internals Pack, or authorized private Wiki background; knowledge hits are not trace evidence.${knowledgeSourceCapabilityHint} ` +
    'On unsupportedReason, report unavailable without invention. ' +
    retrievedContextToolBoundary,
    {
      query: z.string().describe('Search query — natural language is fine; tokens are lowercased and matched against snippet + title.'),
      top_k: z.number().int().min(1).max(20).optional().describe('Maximum hits returned (1-20, default 5).'),
      source: z.enum([
        'androidperformance.com',
        'android_internals_pack',
        'android_internals_wiki',
      ]).optional()
        .describe('Knowledge source. Use android_internals_pack for bundled, signed Android system background; omission preserves the androidperformance.com default.'),
      knowledge_source_id: z.string().optional()
        .describe(`Request-whitelisted source id for Android Internals Wiki.${knowledgeSourceCapabilityHint}`),
    },
    async ({ query, top_k, source, knowledge_source_id }) => {
      if (source === 'android_internals_pack') {
        if (!androidInternalsPackStore) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                unsupportedReason: 'android_internals_pack_unavailable',
              }),
            }],
          };
        }
        if (isAndroidInternalsPackRevoked(androidInternalsPackStore.handle)) {
          throw new Error('analysis_context_changed_restart_required');
        }
        const raw = androidInternalsPackStore.search(query, {topK: top_k ?? 5});
        const filtered = await filterRagLookup(raw, {
          toolName: 'lookup_blog_knowledge',
          turn: 0,
          ledger: codeLookupLedger,
          sessionId: options.sessionId,
        });
        await codeLookupLedger?.flush();
        if (isAndroidInternalsPackRevoked(androidInternalsPackStore.handle)) {
          throw new Error('analysis_context_changed_restart_required');
        }
        const evaluated = filterAndRecordKnowledgeDocuments(filtered);
        return ragToolResult(evaluated, 'nested');
      }
      if (source === 'android_internals_wiki') {
        assertPrivateAnalysisContextCurrent();
        const sourceId = normalizeOptionalToolString(knowledge_source_id) ??
          (knowledgeSourceIds.length === 1 ? knowledgeSourceIds[0] : undefined);
        if (!sourceId || !knowledgeSourceIds.includes(sourceId) || !knowledgeScope) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                unsupportedReason: 'private_knowledge_source_not_whitelisted',
                authorizedKnowledgeSourceIds: knowledgeSourceIds,
              }),
            }],
          };
        }
        const access = externalKnowledgeRegistry.evaluateAccess(
          sourceId,
          knowledgeScope,
          knowledgeSourceIds,
        );
        if (!access.allowed || !access.source.activeGeneration) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                unsupportedReason: access.allowed
                  ? 'private_knowledge_index_not_active'
                  : access.reason,
              }),
            }],
          };
        }
        const pinnedGeneration = pinnedKnowledgeSourceGenerations[sourceId];
        if (!pinnedGeneration) {
          throw new Error('analysis_context_changed_restart_required');
        }
        const raw = ragStore.search(query, {
          topK: top_k ?? 5,
          kinds: ['android_internals_wiki'],
          knowledgeSourceIds: [sourceId],
          activeSourceGenerations: {[sourceId]: pinnedGeneration},
          scope: knowledgeScope,
        });
        const filtered = await filterRagLookup(raw, {
          toolName: 'lookup_blog_knowledge',
          turn: 0,
          ledger: codeLookupLedger,
          sessionId: options.sessionId,
          externalKnowledgeRegistry,
          knowledgeSourceIds,
          knowledgeScope,
        });
        await codeLookupLedger?.flush();
        assertPrivateAnalysisContextCurrent();
        const evaluated = filterAndRecordKnowledgeDocuments(filtered);
        return ragToolResult(evaluated, 'nested');
      }
      const raw = ragStore.search(query, {
        topK: top_k ?? 5,
        kinds: ['androidperformance.com'],
        scope: knowledgeScope,
        activeCodebaseGenerations: activeCodebaseGenerations(codebaseIds),
      });
      const filtered = await filterRagLookup(raw, {
        toolName: 'lookup_blog_knowledge',
        turn: 0,
        ledger: codeLookupLedger,
        sessionId: options.sessionId,
      });
      await codeLookupLedger?.flush();
      const evaluated = filterAndRecordKnowledgeDocuments(filtered);
      return ragToolResult(evaluated, 'inline');
    },
    { annotations: { readOnlyHint: true } },
  );

  // lookup_baseline (Plan 50): fetch a stored App/Device/Build/CUJ
  // baseline by id or by composite key. Read-only — no store mutation.
  // The agent uses this to pull the canonical "what this app/device
  // historically does" record before making regression claims.
  const lookupBaseline = tool(
    'lookup_baseline',
    'Fetch a stored App/Device/Build/CUJ baseline. ' +
    'Pass either `baseline_id` (canonical "appId/deviceId/buildId/cuj") OR all four key components. ' +
    'Returns the BaselineRecord with metrics, status, redactionState, and curatorNote. ' +
    'When the baseline does not exist, the result carries `success: false` and the agent must NOT fabricate baseline values.',
    {
      baseline_id: z.string().optional().describe('Canonical baselineId, e.g. "com.example.feed/pixel-9-android-15/main-abc/scroll_feed".'),
      app_id: z.string().optional().describe('Component appId; required when baseline_id is omitted.'),
      device_id: z.string().optional().describe('Component deviceId; required when baseline_id is omitted.'),
      build_id: z.string().optional().describe('Component buildId; required when baseline_id is omitted.'),
      cuj: z.string().optional().describe('Component CUJ id; required when baseline_id is omitted.'),
    },
    async ({ baseline_id, app_id, device_id, build_id, cuj }) => {
      const store = getBaselineStore();
      let id = baseline_id;
      if (!id) {
        if (app_id && device_id && build_id && cuj) {
          id = deriveBaselineId({appId: app_id, deviceId: device_id, buildId: build_id, cuj});
        } else {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: 'Provide either `baseline_id` or all four key components (app_id, device_id, build_id, cuj).',
              }),
            }],
            isError: true,
          };
        }
      }
      const baseline = store.getBaseline(id, knowledgeScope);
      if (!baseline) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({success: false, error: `Baseline '${id}' not found`}),
          }],
        };
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({success: true, baseline}) }],
      };
    },
    { annotations: { readOnlyHint: true } },
  );

  // compare_baselines (Plan 50): diff two stored baselines and
  // optionally evaluate a CI-style regression gate. Read-only —
  // computes from the stored baselines without mutating either.
  // Trace-vs-baseline (compare_to_baseline) is deferred until the
  // trace metric extraction pipeline is built.
  const compareBaselines = tool(
    'compare_baselines',
    'Diff two stored baselines and (optionally) evaluate a regression gate. ' +
    'Returns a BaselineDiffArtifact with per-metric deltas plus an optional RegressionGateResult when `rules` are supplied. ' +
    'Per-metric `severity` is one of none / info / warning / regression / unsupported; consult `unsupportedReason` whenever severity is "unsupported" — the agent must NOT treat unsupported metrics as confirming or refuting a regression claim.',
    {
      base_baseline_id: z.string().describe('Canonical baselineId for the historical/reference side.'),
      candidate_baseline_id: z.string().describe('Canonical baselineId for the candidate/new side.'),
      rules: z.array(z.object({
        metric_id: z.string().describe('Metric id to gate on.'),
        threshold: z.number().describe('Maximum allowed absolute fractional delta. 0.10 == 10%.'),
        expect_increase: z.boolean().optional().describe('When false, gate fails on improvements (must-decrease metrics). Defaults to true.'),
      })).optional().describe('Optional gate rules. When supplied a RegressionGateResult is returned alongside the diff.'),
      gate_id: z.string().optional().describe('Stable id for the gate result. Required when `rules` is supplied; otherwise ignored.'),
    },
    async ({ base_baseline_id, candidate_baseline_id, rules, gate_id }) => {
      const store = getBaselineStore();
      const base = store.getBaseline(base_baseline_id, knowledgeScope);
      const candidate = store.getBaseline(candidate_baseline_id, knowledgeScope);
      if (!base) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({success: false, error: `Base baseline '${base_baseline_id}' not found`}),
          }],
        };
      }
      if (!candidate) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({success: false, error: `Candidate baseline '${candidate_baseline_id}' not found`}),
          }],
        };
      }
      const diff = computeBaselineDiff(base, candidate);
      let gate = undefined;
      if (rules && rules.length > 0) {
        if (!gate_id) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({success: false, error: '`gate_id` is required when `rules` is supplied.'}),
            }],
            isError: true,
          };
        }
        const mappedRules: RegressionRule[] = rules.map(r => ({
          metricId: r.metric_id,
          threshold: r.threshold,
          ...(r.expect_increase !== undefined ? {expectIncrease: r.expect_increase} : {}),
        }));
        gate = evaluateRegressionGate(base_baseline_id, diff, mappedRules, {gateId: gate_id});
      }
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({success: true, diff, ...(gate ? {gate} : {})}),
        }],
      };
    },
    { annotations: { readOnlyHint: true } },
  );

  // lookup_aosp_source (Plan 55 M1): retrieve indexed AOSP source
  // chunks. Public read-only. License gate at ingestion guarantees
  // every retrieved chunk carries an explicit license; the agent
  // contract still applies — when the result is `unsupportedReason
  // === 'license_blocked'` (or empty index), do NOT summarize, do
  // NOT cite as evidence, say the source is unavailable.
  const lookupAospSource = tool(
    'lookup_aosp_source',
    'Retrieve indexed AOSP source with license and commit provenance. On unsupportedReason, report unavailable without invention. ' +
    retrievedContextToolBoundary,
    {
      query: z.string().describe('Search query — typically a function or class name, or a behavior description.'),
      top_k: z.number().int().min(1).max(20).optional().describe('Maximum hits returned (1-20, default 5).'),
      codebase_id: z.string().optional().describe('Optional whitelisted registered AOSP codebase id.'),
      build_id: z.string().optional().describe('Optional native build id filter.'),
      symbol: z.string().optional().describe('Exact symbol filter when known.'),
      path_prefix: z.string().optional().describe('Optional relative source path prefix.'),
    },
    async ({ query, top_k, codebase_id, build_id, symbol, path_prefix }) => {
      const codebaseId = normalizeOptionalToolString(codebase_id);
      const buildId = normalizeOptionalToolString(build_id);
      const symbolExact = normalizeOptionalToolString(symbol);
      const pathPrefix = normalizeOptionalToolString(path_prefix);
      if (codebaseId && !codebaseIds.includes(codebaseId)) {
        return {
          content: [{type: 'text' as const, text: JSON.stringify({success: false, error: 'Requested codebase is not whitelisted for this session'})}],
          isError: true,
        };
      }
      const selectedAospIds = codebaseIds.filter(id =>
        codebaseRegistry.get(id, knowledgeScope)?.kind === 'aosp');
      const effectiveCodebaseIds = codebaseId ? [codebaseId] : selectedAospIds;
      if (codebaseId && !selectedAospIds.includes(codebaseId)) {
        return {
          content: [{type: 'text' as const, text: JSON.stringify({success: false, error: 'Requested codebase is not a registered AOSP source'})}],
          isError: true,
        };
      }
      const result = await observeSourceOperation('lookup_aosp_source', effectiveCodebaseIds, () => ragStore.search(query, {
        topK: top_k ?? 5,
        kinds: ['aosp'],
        ...(effectiveCodebaseIds.length > 0 ? {codebaseIds: effectiveCodebaseIds} : {}),
        ...(buildId ? {buildId} : {}),
        ...(symbolExact ? {symbolExact} : {}),
        ...(pathPrefix ? {pathPrefix} : {}),
        scope: knowledgeScope,
        activeCodebaseGenerations: activeCodebaseGenerations(effectiveCodebaseIds),
      }));
      if (result.results.some(hit => hit.chunk?.registryOrigin === 'codebase_registry')) {
        const scopedResult = {
          ...result,
          results: result.results.filter(hit =>
            hit.chunk?.registryOrigin !== 'codebase_registry' ||
            (hit.chunk.codebaseId && effectiveCodebaseIds.includes(hit.chunk.codebaseId))),
        };
        const delivered = await filterIndexedSourceLookup('lookup_aosp_source', scopedResult, effectiveCodebaseIds);
        await codeLookupLedger?.flush();
        assertPrivateAnalysisContextCurrent();
        return ragToolResult(delivered, 'nested');
      }
      observeSourceLookup({
        toolName: 'lookup_aosp_source',
        codebaseIds: effectiveCodebaseIds,
        success: result.unsupportedReason === undefined,
      });
      return ragToolResult(result, 'inline');
    },
    { annotations: { readOnlyHint: true } },
  );

  // lookup_oem_sdk (Plan 55 M2): retrieve indexed OEM SDK chunks
  // (MTK / Qualcomm / Samsung tuning docs etc.). Public read-only.
  // Same agent contract as lookup_aosp_source: blocked / empty
  // results must NOT be paraphrased or fabricated.
  const lookupOemSdk = tool(
    'lookup_oem_sdk',
    'Retrieve indexed OEM SDK/tuning documentation, optionally by vendor. On unsupportedReason, report unavailable without invention. ' +
    retrievedContextToolBoundary,
    {
      query: z.string().describe('Search query — typically a tuning concept or vendor-specific knob.'),
      top_k: z.number().int().min(1).max(20).optional().describe('Maximum hits returned (1-20, default 5).'),
      codebase_id: z.string().optional().describe('Optional whitelisted registered OEM codebase id.'),
      vendor: z.string().optional().describe('Optional vendor filter.'),
    },
    async ({ query, top_k, codebase_id, vendor }) => {
      const codebaseId = normalizeOptionalToolString(codebase_id);
      const vendorId = normalizeOptionalToolString(vendor);
      if (codebaseId && !codebaseIds.includes(codebaseId)) {
        return {
          content: [{type: 'text' as const, text: JSON.stringify({success: false, error: 'Requested codebase is not whitelisted for this session'})}],
          isError: true,
        };
      }
      const selectedOemIds = codebaseIds.filter(id =>
        codebaseRegistry.get(id, knowledgeScope)?.kind === 'oem_sdk');
      const effectiveCodebaseIds = codebaseId ? [codebaseId] : selectedOemIds;
      if (codebaseId && !selectedOemIds.includes(codebaseId)) {
        return {
          content: [{type: 'text' as const, text: JSON.stringify({success: false, error: 'Requested codebase is not a registered OEM SDK source'})}],
          isError: true,
        };
      }
      const result = await observeSourceOperation('lookup_oem_sdk', effectiveCodebaseIds, () => ragStore.search(query, {
        topK: top_k ?? 5,
        kinds: ['oem_sdk'],
        ...(effectiveCodebaseIds.length > 0 ? {codebaseIds: effectiveCodebaseIds} : {}),
        ...(vendorId ? {vendor: vendorId} : {}),
        scope: knowledgeScope,
        activeCodebaseGenerations: activeCodebaseGenerations(effectiveCodebaseIds),
      }));
      if (result.results.some(hit => hit.chunk?.registryOrigin === 'codebase_registry')) {
        const scopedResult = {
          ...result,
          results: result.results.filter(hit =>
            hit.chunk?.registryOrigin !== 'codebase_registry' ||
            (hit.chunk.codebaseId && effectiveCodebaseIds.includes(hit.chunk.codebaseId))),
        };
        const delivered = await filterIndexedSourceLookup('lookup_oem_sdk', scopedResult, effectiveCodebaseIds);
        await codeLookupLedger?.flush();
        assertPrivateAnalysisContextCurrent();
        return ragToolResult(delivered, 'nested');
      }
      observeSourceLookup({
        toolName: 'lookup_oem_sdk',
        codebaseIds: effectiveCodebaseIds,
        success: result.unsupportedReason === undefined,
      });
      return ragToolResult(result, 'inline');
    },
    { annotations: { readOnlyHint: true } },
  );

  const listCodebases = tool(
    'list_codebases',
    'List whitelisted codebases; metadata only, no root paths.',
    {},
    async () => {
      assertPrivateAnalysisContextCurrent();
      const allowed = new Set(codebaseIds);
      const codebases = codebaseRegistry.list(knowledgeScope)
        .filter(ref => allowed.has(ref.codebaseId))
        .map(ref => {
          const fullRef = codebaseRegistry.get(ref.codebaseId, knowledgeScope);
          return {
            codebaseId: ref.codebaseId,
            kind: ref.kind,
            displayName: ref.displayName,
            rootAvailable: ref.rootAvailable,
            indexGeneration: ref.indexGeneration,
            activeGeneration: ref.activeGeneration,
            contentFingerprint: ref.contentFingerprint,
            indexedRevision: ref.indexedRevision,
            indexedDirty: ref.indexedDirty,
            commitProvenance: ref.commitProvenance,
            chunkCount: ref.chunkCount,
            eligibleForSendToProvider: ref.eligibleForSendToProvider,
            ...(ref.rootAvailable && fullRef && fs.existsSync(path.join(fullRef.rootRealpath, '.gitnexus'))
              ? {optionalGraphNavigation: {engine: 'gitnexus', indexPresent: true, verificationRequired: true}}
              : {}),
          };
        });
      assertPrivateAnalysisContextCurrent();
      return {
        content: [{type: 'text' as const, text: JSON.stringify({success: true, codebases})}],
      };
    },
    {annotations: {readOnlyHint: true}},
  );

  const recordSourceUseDecisionDescription = loadSourceUseDecisionToolDescription({
    codeAwareMode,
    codebaseIds,
    outputLanguage,
  });
  if (sourceUseDecision && !recordSourceUseDecisionDescription) {
    throw new Error('Missing required source-use decision prompt template');
  }
  const recordSourceUseDecision = tool(
    'record_source_use_decision',
    recordSourceUseDecisionDescription ?? '',
    {
      status: z.enum([
        'not_needed',
        'disallowed',
        'no_queryable_anchor',
        'ambiguous_candidates',
        'not_found_complete',
        'search_incomplete',
        'unverified',
      ]),
      reason: z.string().min(30).max(1000),
    },
    async ({status, reason}) => {
      const current = sourceUseDecision;
      if (!current) {
        return {
          content: [{type: 'text' as const, text: JSON.stringify({
            success: false,
            unsupportedReason: 'source_use_decision_not_required',
          })}],
          isError: true,
        };
      }
      const normalizedReason = reason.trim();
      if (
        normalizedReason.length < 30 ||
        normalizedReason.length > 1000 ||
        /[\u0000-\u001f\u007f]/.test(normalizedReason)
      ) {
        return {
          content: [{type: 'text' as const, text: JSON.stringify({
            success: false,
            unsupportedReason: 'source_use_decision_reason_invalid',
          })}],
          isError: true,
        };
      }
      const allowedStatuses = new Set(
        loadSourceInvestigationPolicy().default.stopStates,
      );
      if (!allowedStatuses.has(status)) {
        return {
          content: [{type: 'text' as const, text: JSON.stringify({
            success: false,
            unsupportedReason: 'source_use_decision_status_not_allowed',
            status,
          })}],
          isError: true,
        };
      }
      if (current.status !== 'pending' || current.attemptedTools.length > 0) {
        return {
          content: [{type: 'text' as const, text: JSON.stringify({
            success: false,
            unsupportedReason: 'source_use_decision_conflict',
            currentStatus: current.status,
          })}],
          isError: true,
        };
      }
      explicitSourceUseDecisionReason = normalizedReason;
      commitSourceUseDecision({
        ...current,
        status,
        reasonCode: status,
        ...(status === 'search_incomplete'
          ? {coverageComplete: false, incompleteReasons: ['explicit_decision']}
          : status === 'not_found_complete'
            ? {coverageComplete: true}
            : {}),
      });
      return {
        content: [{type: 'text' as const, text: JSON.stringify({
          success: true,
          status,
        })}],
      };
    },
    {annotations: {readOnlyHint: false}},
  );

  const resolveOnDemandCodebaseId = (requested: unknown): string | undefined => {
    const codebaseId = normalizeOptionalToolString(requested);
    if (codebaseId) return codebaseIds.includes(codebaseId) ? codebaseId : undefined;
    return codebaseIds.length === 1 ? codebaseIds[0] : undefined;
  };
  const onDemandSourceTokens = (result: {
    matches?: Array<{text?: string}>;
    reference?: {text?: string};
  }, presentation?: {numberedText: string}): number => {
    const text = result.matches?.map(match => match.text ?? '').join('\n') ?? result.reference?.text ?? '';
    const deliveredText = `${text}${presentation?.numberedText ?? ''}`;
    return deliveredText ? Math.max(1, Math.ceil(deliveredText.length / 4)) : 0;
  };
  const sourceReadPresentation = (reference?: {
    text?: string;
    lineRange?: {start: number; end: number};
  }): {
    schemaVersion: 'source_read_presentation@1';
    format: 'line_numbered';
    numberedText: string;
  } | undefined => {
    const lineRange = reference?.lineRange;
    if (codeAwareMode !== 'provider_send' || typeof reference?.text !== 'string' ||
      !lineRange || !Number.isSafeInteger(lineRange.start) || !Number.isSafeInteger(lineRange.end) ||
      lineRange.start < 1 || lineRange.end < lineRange.start) return undefined;
    const lines = reference.text.split('\n');
    if (lines.length !== lineRange.end - lineRange.start + 1) return undefined;
    return {
      schemaVersion: 'source_read_presentation@1',
      format: 'line_numbered',
      numberedText: lines.map((line, index) => `${lineRange.start + index}: ${line}`).join('\n'),
    };
  };
  const recordOnDemandSourceLookup = async (input: {
    toolName: 'search_codebase' | 'read_codebase_file';
    codebaseId: string;
    tokensSpent: number;
    returnedReferenceCount: number;
    outcome: 'success' | 'budget_exceeded' | 'consent_blocked' | 'rejected';
    durationMs?: number;
  }): Promise<void> => {
    codeLookupLedger?.record({
      turn: 0,
      ts: Date.now(),
      toolName: input.toolName,
      codebaseId: input.codebaseId,
      chunkIds: [],
      consentApplied: codeAwareMode === 'provider_send',
      tokensSpent: input.tokensSpent,
      ...(input.durationMs !== undefined ? {durationMs: input.durationMs} : {}),
      outcome: input.outcome,
      legacyPath: false,
      returnedReferenceCount: input.returnedReferenceCount,
    });
    await codeLookupLedger?.flush();
  };
  let sourceBudgetStartedAt: number | undefined;
  let sourceSearchCalls = 0;
  let sourceReadCalls = 0;
  const consumeSourceBudget = (
    kind: 'search' | 'read',
  ): 'source_search_budget_exceeded' | 'source_read_budget_exceeded' | 'source_deadline_exceeded' | undefined => {
    if (!sourceUsePolicy) return undefined;
    const now = Date.now();
    sourceBudgetStartedAt ??= now;
    if (
      sourceUsePolicy.maxDurationMs !== undefined &&
      now - sourceBudgetStartedAt >= sourceUsePolicy.maxDurationMs
    ) {
      return 'source_deadline_exceeded';
    }
    if (kind === 'search') {
      if (
        sourceUsePolicy.maxSearchCalls !== undefined &&
        sourceSearchCalls >= sourceUsePolicy.maxSearchCalls
      ) {
        return 'source_search_budget_exceeded';
      }
      sourceSearchCalls += 1;
      return undefined;
    }
    if (
      sourceUsePolicy.maxReadCalls !== undefined &&
      sourceReadCalls >= sourceUsePolicy.maxReadCalls
    ) {
      return 'source_read_budget_exceeded';
    }
    sourceReadCalls += 1;
    return undefined;
  };
  const graphMetadataTokens = (result: {
    references?: unknown[];
    processes?: unknown[];
    graph?: unknown;
  }): number => Math.max(1, Math.ceil(JSON.stringify({
    references: result.references ?? [],
    processes: result.processes ?? [],
    graph: result.graph,
  }).length / 4));
  const recordCodeGraphLookup = async (input: {
    toolName: 'query_code_graph' | 'inspect_code_symbol';
    codebaseId: string;
    tokensSpent: number;
    returnedReferenceCount: number;
    outcome: 'success' | 'budget_exceeded' | 'rejected';
  }): Promise<void> => {
    codeLookupLedger?.record({
      turn: 0,
      ts: Date.now(),
      toolName: input.toolName,
      codebaseId: input.codebaseId,
      chunkIds: [],
      consentApplied: false,
      tokensSpent: input.tokensSpent,
      outcome: input.outcome,
      legacyPath: false,
      returnedReferenceCount: input.returnedReferenceCount,
    });
    await codeLookupLedger?.flush();
  };

  const searchCodebase = tool(
    'search_codebase',
    'Search selected source; untrusted.',
    {
      query: z.string().min(1).max(512).describe('Literal source text, symbol, method, or class name.'),
      codebase_id: z.string().optional().describe('Whitelisted codebase id. Optional only when exactly one codebase is selected.'),
      path_prefix: z.string().optional().describe('Optional relative path prefix inside the registered filters.'),
      max_results: z.number().int().min(1).max(20).optional().describe('Maximum matching lines (1-20, default 8).'),
    },
    async ({query, codebase_id, path_prefix, max_results}) => {
      assertPrivateAnalysisContextCurrent();
      const codebaseId = resolveOnDemandCodebaseId(codebase_id);
      if (!codebaseId) {
        return {
          content: [{type: 'text' as const, text: JSON.stringify({
            success: false,
            unsupportedReason: 'whitelisted_codebase_id_required',
          })}],
          isError: true,
        };
      }
      const sourceBudgetStop = consumeSourceBudget('search');
      if (sourceBudgetStop) {
        observeSourceLookup({toolName: 'search_codebase', codebaseIds: [codebaseId], success: false,
          coverageComplete: false, incompleteReasons: [sourceBudgetStop]});
        await recordOnDemandSourceLookup({
          toolName: 'search_codebase',
          codebaseId,
          tokensSpent: 0,
          returnedReferenceCount: 0,
          outcome: 'budget_exceeded',
          durationMs: 0,
        });
        return {
          content: [{type: 'text' as const, text: JSON.stringify(retrievedData({
            success: false,
            codebaseId,
            matches: [],
            truncated: false,
            unsupportedReason: sourceBudgetStop,
          }))}],
        };
      }
      const sourceLookupStartedAt = Date.now();
      const result = await onDemandSourceAccess.search({
        codebaseId,
        scope: knowledgeScope ?? {},
        query,
        mode: codeAwareMode,
        pathPrefix: normalizeOptionalToolString(path_prefix),
        maxResults: max_results,
      }).catch(async error => {
        observeSourceLookup({toolName: 'search_codebase', codebaseIds: [codebaseId], success: false});
        await recordOnDemandSourceLookup({toolName: 'search_codebase', codebaseId, tokensSpent: 0,
          returnedReferenceCount: 0, outcome: 'rejected', durationMs: Date.now() - sourceLookupStartedAt});
        throw error;
      });
      const tokensSpent = onDemandSourceTokens(result);
      if (codeLookupLedger && tokensSpent > codeLookupLedger.remainingTokens()) {
        observeOnDemandSourceLookup('search_codebase', {
          ...result,
          success: false,
          matches: [],
          coverageComplete: false,
          unsupportedReason: 'budget_exceeded',
        });
        await recordOnDemandSourceLookup({
          toolName: 'search_codebase',
          codebaseId,
          tokensSpent: 0,
          returnedReferenceCount: 0,
          outcome: 'budget_exceeded',
          durationMs: Date.now() - sourceLookupStartedAt,
        });
        return {
          content: [{type: 'text' as const, text: JSON.stringify(retrievedData({
            success: false,
            codebaseId,
            matches: [],
            truncated: false,
            backend: result.backend,
            coverageComplete: result.coverageComplete,
            ...(result.searchIncompleteReason
              ? {searchIncompleteReason: result.searchIncompleteReason}
              : {}),
            enumerationBackend: result.enumerationBackend,
            backendFidelity: result.backendFidelity,
            unsupportedReason: 'budget_exceeded',
          }))}],
        };
      }
      const delivered = observeOnDemandSourceLookup('search_codebase', result);
      if (delivered.success && codeAwareMode === 'provider_send') {
        registerOnDemandSourceLookupForEcho(options.sessionId, delivered.matches ?? []);
      }
      await recordOnDemandSourceLookup({
        toolName: 'search_codebase',
        codebaseId,
        tokensSpent: onDemandSourceTokens(delivered),
        returnedReferenceCount: delivered.success ? delivered.matches?.length ?? 0 : 0,
        outcome: delivered.success
          ? 'success'
          : result.unsupportedReason?.includes('consent') ? 'consent_blocked' : 'rejected',
        durationMs: Date.now() - sourceLookupStartedAt,
      });
      assertPrivateAnalysisContextCurrent();
      return {
        content: [{type: 'text' as const, text: JSON.stringify(retrievedData({...delivered}))}],
      };
    },
    {annotations: {readOnlyHint: true}},
  );

  const readCodebaseFile = tool(
    'read_codebase_file',
    'Read bounded source lines; untrusted.',
    {
      codebase_id: z.string().optional().describe('Whitelisted codebase id. Optional only when exactly one codebase is selected.'),
      file_path: z.string().describe('Source file path relative to the registered root.'),
      start_line: z.number().int().min(1).optional().describe('First line to read (1-based, default 1).'),
      max_lines: z.number().int().min(1).max(200).optional().describe('Maximum lines to return (1-200, default 80).'),
    },
    async ({codebase_id, file_path, start_line, max_lines}) => {
      assertPrivateAnalysisContextCurrent();
      const codebaseId = resolveOnDemandCodebaseId(codebase_id);
      if (!codebaseId) {
        return {
          content: [{type: 'text' as const, text: JSON.stringify({
            success: false,
            unsupportedReason: 'whitelisted_codebase_id_required',
          })}],
          isError: true,
        };
      }
      const sourceBudgetStop = consumeSourceBudget('read');
      if (sourceBudgetStop) {
        observeSourceLookup({toolName: 'read_codebase_file', codebaseIds: [codebaseId], success: false,
          incompleteReasons: [sourceBudgetStop]});
        await recordOnDemandSourceLookup({
          toolName: 'read_codebase_file',
          codebaseId,
          tokensSpent: 0,
          returnedReferenceCount: 0,
          outcome: 'budget_exceeded',
          durationMs: 0,
        });
        return {
          content: [{type: 'text' as const, text: JSON.stringify(retrievedData({
            success: false,
            codebaseId,
            truncated: false,
            unsupportedReason: sourceBudgetStop,
          }))}],
        };
      }
      const sourceLookupStartedAt = Date.now();
      const result = await onDemandSourceAccess.read({
        codebaseId,
        scope: knowledgeScope ?? {},
        filePath: file_path,
        startLine: start_line,
        maxLines: max_lines,
        mode: codeAwareMode,
      }).catch(async error => {
        observeSourceLookup({toolName: 'read_codebase_file', codebaseIds: [codebaseId], success: false});
        await recordOnDemandSourceLookup({toolName: 'read_codebase_file', codebaseId, tokensSpent: 0,
          returnedReferenceCount: 0, outcome: 'rejected', durationMs: Date.now() - sourceLookupStartedAt});
        throw error;
      });
      const requestedPresentation = sourceReadPresentation(result.reference);
      const tokensSpent = onDemandSourceTokens(result, requestedPresentation);
      if (codeLookupLedger && tokensSpent > codeLookupLedger.remainingTokens()) {
        observeOnDemandSourceLookup('read_codebase_file', {
          ...result,
          success: false,
          reference: undefined,
          unsupportedReason: 'budget_exceeded',
        });
        await recordOnDemandSourceLookup({
          toolName: 'read_codebase_file',
          codebaseId,
          tokensSpent: 0,
          returnedReferenceCount: 0,
          outcome: 'budget_exceeded',
          durationMs: Date.now() - sourceLookupStartedAt,
        });
        return {
          content: [{type: 'text' as const, text: JSON.stringify(retrievedData({
            success: false,
            codebaseId,
            truncated: false,
            unsupportedReason: 'budget_exceeded',
          }))}],
        };
      }
      const delivered = observeOnDemandSourceLookup('read_codebase_file', result);
      const presentation = delivered.success
        ? sourceReadPresentation(delivered.reference)
        : undefined;
      if (delivered.success && codeAwareMode === 'provider_send' && delivered.reference) {
        registerOnDemandSourceLookupForEcho(options.sessionId, [delivered.reference]);
      }
      await recordOnDemandSourceLookup({
        toolName: 'read_codebase_file',
        codebaseId,
        tokensSpent: onDemandSourceTokens(delivered, presentation),
        returnedReferenceCount: delivered.success && delivered.reference ? 1 : 0,
        outcome: delivered.success
          ? 'success'
          : result.unsupportedReason?.includes('consent') ? 'consent_blocked' : 'rejected',
        durationMs: Date.now() - sourceLookupStartedAt,
      });
      assertPrivateAnalysisContextCurrent();
      return {
        content: [{type: 'text' as const, text: JSON.stringify(retrievedData({
          ...delivered,
          ...(presentation ? {presentation} : {}),
        }))}],
      };
    },
    {annotations: {readOnlyHint: true}},
  );

  const queryCodeGraph = tool(
    'query_code_graph',
    'GitNexus navigation hints; verify with search/read.',
    {
      query: z.string().min(1).max(512).describe('Symbol, concept, class, method, or execution-flow query.'),
      codebase_id: z.string().optional().describe('Whitelisted codebase id. Required when multiple codebases are selected.'),
      max_results: z.number().int().min(1).max(20).optional().describe('Maximum graph references (1-20, default 8).'),
    },
    async ({query, codebase_id, max_results}) => {
      assertPrivateAnalysisContextCurrent();
      const codebaseId = resolveOnDemandCodebaseId(codebase_id);
      if (!codebaseId) {
        return {
          content: [{type: 'text' as const, text: JSON.stringify({
            success: false,
            unsupportedReason: 'whitelisted_codebase_id_required',
          })}],
          isError: true,
        };
      }
      const result = await observeSourceOperation('query_code_graph', [codebaseId], () => codeGraphNavigator.query({
        codebaseId,
        scope: knowledgeScope ?? {},
        query,
        limit: max_results,
      }));
      const tokensSpent = graphMetadataTokens(result);
      if (codeLookupLedger && tokensSpent > codeLookupLedger.remainingTokens()) {
        observeGraphSourceLookup('query_code_graph', {
          ...result,
          success: false,
          references: [],
          truncated: true,
          unsupportedReason: 'budget_exceeded',
        });
        await recordCodeGraphLookup({
          toolName: 'query_code_graph',
          codebaseId,
          tokensSpent: 0,
          returnedReferenceCount: 0,
          outcome: 'budget_exceeded',
        });
        return {
          content: [{type: 'text' as const, text: JSON.stringify(retrievedData({
            success: false,
            codebaseId,
            references: [],
            processes: [],
            graph: result.graph,
            truncated: false,
            unsupportedReason: 'budget_exceeded',
          }))}],
        };
      }
      const delivered = observeGraphSourceLookup('query_code_graph', result);
      await recordCodeGraphLookup({
        toolName: 'query_code_graph',
        codebaseId,
        tokensSpent,
        returnedReferenceCount: delivered.references.length,
        outcome: result.success ? 'success' : 'rejected',
      });
      assertPrivateAnalysisContextCurrent();
      return {
        content: [{type: 'text' as const, text: JSON.stringify(retrievedData({...delivered}))}],
      };
    },
    {annotations: {readOnlyHint: true}},
  );

  const inspectCodeSymbol = tool(
    'inspect_code_symbol',
    'GitNexus symbol hints; verify with search/read.',
    {
      symbol: z.string().min(1).max(256).describe('Exact or qualified symbol name.'),
      codebase_id: z.string().optional().describe('Whitelisted codebase id. Required when multiple codebases are selected.'),
      file_path: z.string().optional().describe('Optional relative source file path inside registered filters.'),
      max_relations: z.number().int().min(1).max(20).optional().describe('Maximum graph references or relations (1-20, default 8).'),
    },
    async ({symbol, codebase_id, file_path, max_relations}) => {
      assertPrivateAnalysisContextCurrent();
      const codebaseId = resolveOnDemandCodebaseId(codebase_id);
      if (!codebaseId) {
        return {
          content: [{type: 'text' as const, text: JSON.stringify({
            success: false,
            unsupportedReason: 'whitelisted_codebase_id_required',
          })}],
          isError: true,
        };
      }
      const result = await observeSourceOperation('inspect_code_symbol', [codebaseId], () => codeGraphNavigator.inspectSymbol({
        codebaseId,
        scope: knowledgeScope ?? {},
        symbol,
        filePath: normalizeOptionalToolString(file_path),
        limit: max_relations,
      }));
      const tokensSpent = graphMetadataTokens(result);
      if (codeLookupLedger && tokensSpent > codeLookupLedger.remainingTokens()) {
        observeGraphSourceLookup('inspect_code_symbol', {
          ...result,
          success: false,
          references: [],
          truncated: true,
          unsupportedReason: 'budget_exceeded',
        });
        await recordCodeGraphLookup({
          toolName: 'inspect_code_symbol',
          codebaseId,
          tokensSpent: 0,
          returnedReferenceCount: 0,
          outcome: 'budget_exceeded',
        });
        return {
          content: [{type: 'text' as const, text: JSON.stringify(retrievedData({
            success: false,
            codebaseId,
            references: [],
            processes: [],
            graph: result.graph,
            truncated: false,
            unsupportedReason: 'budget_exceeded',
          }))}],
        };
      }
      const delivered = observeGraphSourceLookup('inspect_code_symbol', result);
      await recordCodeGraphLookup({
        toolName: 'inspect_code_symbol',
        codebaseId,
        tokensSpent,
        returnedReferenceCount: delivered.references.length,
        outcome: result.success ? 'success' : 'rejected',
      });
      assertPrivateAnalysisContextCurrent();
      return {
        content: [{type: 'text' as const, text: JSON.stringify(retrievedData({...delivered}))}],
      };
    },
    {annotations: {readOnlyHint: true}},
  );

  const lookupAppSource = tool(
    'lookup_app_source',
    'Look up registered app source chunks for this analysis session. ' +
    'Only whitelisted codebase IDs are accepted. In metadata_only mode the result carries file/symbol references without snippets. ' +
    retrievedContextToolBoundary,
    {
      query: z.string().describe('Natural-language query, symbol, class, method, or file term.'),
      top_k: z.number().int().min(1).max(20).optional().describe('Maximum hits returned (1-20, default 5).'),
      codebase_id: z.string().optional().describe('Restrict to one whitelisted codebase id. Defaults to all session codebases.'),
      symbol: z.string().optional().describe('Exact symbol filter when known.'),
      file_path: z.string().optional().describe('Exact source file path relative to the registered root.'),
      path_prefix: z.string().optional().describe('Restrict lookup to a relative path prefix.'),
    },
    async ({query, top_k, codebase_id, symbol, file_path, path_prefix}) => {
      const codebaseId = normalizeOptionalToolString(codebase_id);
      const symbolExact = normalizeOptionalToolString(symbol);
      const filePath = normalizeOptionalToolString(file_path);
      const pathPrefix = normalizeOptionalToolString(path_prefix);
      const requestedIds = codebaseId ? [codebaseId] : codebaseIds;
      const allowed = requestedIds.filter(id => codebaseIds.includes(id));
      if (allowed.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({success: false, error: 'No requested codebase is whitelisted for this session'}),
          }],
          isError: true,
        };
      }
      const raw = await observeSourceOperation('lookup_app_source', allowed, () => ragStore.search(query, {
        topK: top_k ?? 5,
        kinds: ['app_source'],
        codebaseIds: allowed,
        ...(symbolExact ? {symbolExact} : {}),
        ...(filePath ? {filePathExact: filePath} : {}),
        ...(pathPrefix ? {pathPrefix} : {}),
        scope: knowledgeScope,
        activeCodebaseGenerations: activeCodebaseGenerations(allowed),
      }));
      const delivered = await filterIndexedSourceLookup('lookup_app_source', raw, allowed);
      await codeLookupLedger?.flush();
      assertPrivateAnalysisContextCurrent();
      return ragToolResult(delivered, 'nested');
    },
    {annotations: {readOnlyHint: true}},
  );

  const lookupKernelSource = tool(
    'lookup_kernel_source',
    'Retrieve whitelisted kernel/vendor source after trace evidence points to a kernel subsystem or symbol. Requires codebase/vendor and path prefix; metadata_only omits snippets. ' +
    retrievedContextToolBoundary,
    {
      query: z.string().describe('Kernel symbol, subsystem, or behavior query.'),
      top_k: z.number().int().min(1).max(20).optional().describe('Maximum hits returned (1-20, default 5).'),
      codebase_id: z.string().optional().describe('Restrict to one whitelisted kernel codebase id.'),
      vendor: z.string().optional().describe('Vendor id. Required when multiple kernel codebases are available and codebase_id is omitted.'),
      symbol: z.string().optional().describe('Exact symbol filter when known.'),
      path_prefix: z.string().optional().describe('Required subsystem path prefix, for example drivers/android/binder.'),
    },
    async ({query, top_k, codebase_id, vendor, symbol, path_prefix}) => {
      const codebaseId = normalizeOptionalToolString(codebase_id);
      const vendorId = normalizeOptionalToolString(vendor);
      const symbolExact = normalizeOptionalToolString(symbol);
      const pathPrefix = normalizeOptionalToolString(path_prefix);
      const requestedIds = codebaseId ? [codebaseId] : codebaseIds;
      const allowed = requestedIds.filter(id => codebaseIds.includes(id));
      if (allowed.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({success: false, error: 'No requested codebase is whitelisted for this session'}),
          }],
          isError: true,
        };
      }
      const kernelRefs = allowed
        .map(id => codebaseRegistry.get(id, knowledgeScope))
        .filter(ref => ref?.kind === 'kernel_source');
      const vendors = new Set(kernelRefs.map(ref => ref!.vendor).filter(Boolean));
      if (!codebaseId && !vendorId && vendors.size > 1) {
        return {
          content: [{type: 'text' as const, text: JSON.stringify({
            success: false,
            unsupportedReason: 'vendor_required_for_multi_vendor_kernel_lookup',
            vendors: Array.from(vendors).sort(),
          })}],
          isError: true,
        };
      }
      const raw = await observeSourceOperation('lookup_kernel_source', kernelRefs.map(ref => ref!.codebaseId), () => ragStore.search(query, {
        topK: top_k ?? 5,
        kinds: ['kernel_source'],
        codebaseIds: kernelRefs.map(ref => ref!.codebaseId),
        ...(vendorId ? {vendor: vendorId} : {}),
        ...(symbolExact ? {symbolExact} : {}),
        ...(pathPrefix ? {pathPrefix} : {}),
        scope: knowledgeScope,
        activeCodebaseGenerations: activeCodebaseGenerations(kernelRefs.map(ref => ref!.codebaseId)),
      }));
      const delivered = await filterIndexedSourceLookup('lookup_kernel_source', raw, kernelRefs.map(ref => ref!.codebaseId));
      await codeLookupLedger?.flush();
      assertPrivateAnalysisContextCurrent();
      return ragToolResult(delivered, 'nested');
    },
    {annotations: {readOnlyHint: true}},
  );

  const resolveSymbol = tool(
    'resolve_symbol',
    'Use when trace frames or obfuscated names must be resolved to CodeRef metadata before source lookup. ' +
    'Do NOT use to guess file:line when build_id is missing; return the degraded result instead. ' +
    'Prerequisites: whitelisted codebase ids and indexed source/symbol metadata. Budget: top_k capped at 20. Outcomes: app, native/AOSP, or kernel candidates with degradation reasons.',
    {
      symbol: z.string().describe('Class, function, or method name to resolve.'),
      kind: z.enum(['app', 'native', 'kernel']).optional().describe('Resolution domain; default app.'),
      codebase_id: z.string().optional().describe('Restrict to one whitelisted codebase id. Defaults to all session codebases.'),
      file_path: z.string().optional().describe('Optional relative source file path for fallback matching.'),
      build_id: z.string().optional().describe('Optional build id. Missing build id returns a degraded result.'),
      vendor: z.string().optional().describe('Vendor id for kernel lookup.'),
      top_k: z.number().int().min(1).max(20).optional().describe('Maximum candidates returned.'),
    },
    async ({symbol, kind, codebase_id, file_path, build_id, vendor, top_k}) => {
      assertPrivateAnalysisContextCurrent();
      const codebaseId = normalizeOptionalToolString(codebase_id);
      const filePath = normalizeOptionalToolString(file_path);
      const buildId = normalizeOptionalToolString(build_id);
      const vendorId = normalizeOptionalToolString(vendor);
      const requestedIds = codebaseId ? [codebaseId] : codebaseIds;
      const allowed = requestedIds.filter(id => codebaseIds.includes(id));
      if (allowed.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({success: false, error: 'No requested codebase is whitelisted for this session'}),
          }],
          isError: true,
        };
      }
      const resolver = new SymbolResolver(ragStore, knowledgeScope, codebaseRegistry);
      const results = await observeSourceOperation('resolve_symbol', allowed, () => allowed.map(id => {
        const ref = codebaseRegistry.get(id, knowledgeScope);
        if (kind === 'kernel' || ref?.kind === 'kernel_source') {
          return resolver.resolveKernel({
            symbol,
            codebaseId: id,
            vendor: vendorId ?? ref?.vendor,
            ...(buildId ? {buildId} : {}),
            topK: top_k ?? 5,
          });
        }
        if (kind === 'native' || ref?.kind === 'aosp') {
          return resolver.resolveNative({
            symbol,
            codebaseId: id,
            ...(buildId ? {buildId} : {}),
            topK: top_k ?? 5,
          });
        }
        return resolver.resolveApp({
          symbol,
          codebaseId: id,
          ...(filePath ? {filePath} : {}),
          ...(buildId ? {buildId} : {}),
          topK: top_k ?? 5,
        });
      }));
      const admitted = admitSourceItems(results.flatMap(result => result.candidates),
        candidate => ({...candidate, lookupKind: 'metadata'}));
      const admittedCandidates = new Set(admitted.items);
      const delivered = results.map(result => ({...result,
        candidates: result.candidates.filter(candidate => admittedCandidates.has(candidate)),
      }));
      observeSourceLookup({
        toolName: 'resolve_symbol',
        codebaseIds: allowed,
        references: admitted.references,
        success: results.some(result => result.success),
        ...(admitted.incompleteReason ? {coverageComplete: false, incompleteReasons: [admitted.incompleteReason]} : {}),
      });
      assertPrivateAnalysisContextCurrent();
      return {
        content: [{type: 'text' as const, text: JSON.stringify({
          success: results.some(result => result.success),
          results: delivered,
          sourceReferences: admitted.references,
          ...(admitted.incompleteReason ? {coverageComplete: false, searchIncompleteReason: admitted.incompleteReason} : {}),
        })}],
      };
    },
    {annotations: {readOnlyHint: true}},
  );

  const proposePatch = tool(
    'propose_patch',
    requireToolDescription('prompt-propose-patch-tool-description'),
    {
      context_chunk_ids: z.array(z.string()).min(1).describe('Chunk ids previously returned by a successful source lookup in this session.'),
      problem: z.string().describe('Performance problem the patch should address.'),
      proposed_diff: z.string().optional().describe('Optional unified diff to validate. Only returned to the user if git apply --check passes.'),
      patch_sketch: z.string().optional().describe('Optional high-level sketch when no verified diff is available.'),
    },
    async ({context_chunk_ids, problem, proposed_diff, patch_sketch}) => {
      assertPrivateAnalysisContextCurrent();
      const proposer = new PatchProposer(
        ragStore,
        codebaseRegistry,
        codeLookupLedger,
        knowledgeScope,
      );
      const result = proposer.propose({
        contextChunkIds: context_chunk_ids,
        problem,
        ...(proposed_diff ? {proposedDiff: proposed_diff} : {}),
        ...(patch_sketch ? {patchSketch: patch_sketch} : {}),
        turn: 0,
      });
      await codeLookupLedger?.flush();
      assertPrivateAnalysisContextCurrent();
      return {
        content: [{type: 'text' as const, text: JSON.stringify({success: result.patchStatus !== 'unverified', result})}],
        ...(result.patchStatus === 'unverified' ? {isError: true} : {}),
      };
    },
    {annotations: {readOnlyHint: false}},
  );

  // recall_project_memory (Plan 44): pure-read recall over project +
  // world memory entries. Strict invariant: handler MUST NOT cause any
  // disk writes; ProjectMemory.recallProjectMemory() is enforced via
  // the "1000 calls / mtime unchanged" unit test in projectMemory.test.ts.
  // Use this when the agent wants to ground claims in past analysis
  // insights for the same project (or in world-scope insights consolidated
  // by reviewer approval). The session-scope `recall_patterns` tool is a
  // separate path that runs against the existing analysisPatternMemory store.
  const recallProjectMemory = tool(
    'recall_project_memory',
    'Recall project- or world-scope memory entries by tag overlap with the query. Read-only — never writes. ' +
    'Returns up to top_k hits ranked by tag-overlap score; entries with `unsupportedReason` (evicted, retracted) are skipped. ' +
    'Session-scope memory lives elsewhere (use `recall_patterns` for that path).',
    {
      tags: z.array(z.string()).optional().describe('Tags to score against. Without tags, entries rank by their stored confidence.'),
      project_key: z.string().optional().describe('Restrict to entries created under this project key (e.g. "appId/deviceId").'),
      scope: z.enum(['project', 'world']).optional().describe('Restrict to a scope. Defaults to both project and world.'),
      top_k: z.number().int().min(1).max(20).optional().describe('Maximum hits returned (1-20, default 5).'),
    },
    async ({ tags, project_key, scope, top_k }) => {
      const memory = getProjectMemory();
      const hits = memory.recallProjectMemory({
        tags,
        projectKey: project_key,
        scope,
        topK: top_k ?? 5,
      }, knowledgeScope);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({success: true, hits, count: hits.length}),
        }],
      };
    },
    { annotations: { readOnlyHint: true } },
  );

  // recall_similar_case (Plan 54): pure-read recall over the case
  // library. The agent uses this to ground claims in prior curated
  // cases ("similar root cause to case-...") instead of repeating
  // analysis. Read-only. Note: `cite_case_in_report` (the session-side
  // writer counterpart) is intentionally deferred — it requires
  // deeper integration with the report generation path and lands as
  // its own commit later.
  const recallSimilarCase = tool(
    'recall_similar_case',
    'Recall published or reviewed cases that share tags with the current trace, optionally restricted to the same App/Device/Build/CUJ key. ' +
    'Read-only over the case library. Returns up to top_k cases ranked by tag-overlap score; published cases rank above reviewed when scores tie. ' +
    'When the result is empty the agent must NOT fabricate prior cases — say "no matching prior case in the library" explicitly.',
    {
      tags: z.array(z.string()).optional().describe('Tag tokens to score against. Without tags, results rank by published > reviewed > others.'),
      app_id: z.string().optional().describe('Restrict to cases whose key.appId matches.'),
      device_id: z.string().optional().describe('Restrict to cases whose key.deviceId matches.'),
      cuj: z.string().optional().describe('Restrict to cases whose key.cuj matches.'),
      include_unpublished: z.boolean().optional().describe('Include reviewed/draft cases (default false — only published surface to the agent).'),
      top_k: z.number().int().min(1).max(20).optional().describe('Maximum cases returned (1-20, default 5).'),
      scene: z.string().optional().describe('Optional scene for evidence-gated case retrieval (for example scrolling).'),
      domain_pack: z.string().optional().describe('Optional case domain pack for evidence-gated retrieval (default scrolling.v1 for scrolling).'),
      root_cause: z.string().optional().describe('Optional primary root cause for evidence-gated retrieval.'),
      evidence_signatures: z.record(z.string(), z.unknown()).optional().describe('Optional evidence signatures gathered in this run. When present, retrieval returns strong/partial/background matchStrength.'),
    },
    async ({ tags, app_id, device_id, cuj, include_unpublished, top_k, scene, domain_pack, root_cause, evidence_signatures }) => {
      const library = options.caseLibrary ?? getCaseLibrary();
      const wantedTags = tags ? new Set(tags) : null;
      const limit = top_k ?? 5;

      if (evidence_signatures && typeof evidence_signatures === 'object') {
        const retriever = createCaseRetriever({
          library,
          ragStore,
          scope: knowledgeScope,
        });
        const effectiveScene = scene || options.sceneType || 'scrolling';
        const effectiveRootCause = root_cause || tags?.[0] || 'unknown';
        const hits = retriever.retrieve({
          scene: effectiveScene,
          domainPack: domain_pack || (effectiveScene === 'scrolling' ? 'scrolling.v1' : effectiveScene),
          rootCause: effectiveRootCause,
          audiences: ['app', 'oem'],
          evidenceSignatures: evidence_signatures as Record<string, unknown>,
          textQuery: [effectiveRootCause, ...(tags ?? [])].join(' '),
          topK: limit,
          includeStatuses: include_unpublished ? ['published', 'reviewed'] : ['published'],
        });
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({success: true, hits, count: hits.length}),
          }],
        };
      }

      // Pull either published-only or published+reviewed depending on the
      // include_unpublished flag. Drafts and private cases never surface
      // through this tool — those are operator-side concerns.
      const allCases = include_unpublished
        ? [
            ...library.listCases({status: 'published'}, knowledgeScope),
            ...library.listCases({status: 'reviewed'}, knowledgeScope),
          ]
        : library.listCases({status: 'published'}, knowledgeScope);

      const candidates: Array<{caseScore: number; case: typeof allCases[number]}> = [];
      for (const c of allCases) {
        if (app_id && c.key?.appId !== app_id) continue;
        if (device_id && c.key?.deviceId !== device_id) continue;
        if (cuj && c.key?.cuj !== cuj) continue;
        let score = 0;
        if (wantedTags) {
          for (const t of c.tags) if (wantedTags.has(t)) score += 1;
          if (score === 0) continue;
          score = score / Math.max(wantedTags.size, 1);
        } else {
          // Without tags, prefer published over reviewed; both above 0.
          score = c.status === 'published' ? 1 : 0.5;
        }
        candidates.push({caseScore: score, case: c});
      }

      candidates.sort((a, b) => {
        if (a.caseScore !== b.caseScore) return b.caseScore - a.caseScore;
        // Tie-break: published before reviewed before others.
        const rank = (s: string): number =>
          s === 'published' ? 0 : s === 'reviewed' ? 1 : 2;
        return rank(a.case.status) - rank(b.case.status);
      });

      const hits = candidates.slice(0, limit).map(c => ({
        caseId: c.case.caseId,
        score: c.caseScore,
        title: c.case.title,
        status: c.case.status,
        tags: c.case.tags,
        findings: c.case.findings,
        traceArtifactId: c.case.traceArtifactId,
        traceUnavailableReason: c.case.traceUnavailableReason,
      }));

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({success: true, hits, count: hits.length}),
        }],
      };
    },
    { annotations: { readOnlyHint: true } },
  );

  const recallSimilarResult = tool(
    'recall_similar_result',
    'Recall similar persisted analysis-result snapshots for navigation. Read-only. Returns navigation_hint_only hints; not diagnostic evidence.',
    {
      snapshot_id: z.string().describe('Current analysis result snapshot id.'),
      include_cases: z.boolean().optional().describe('Also include published case-library hints when structured evidence is available (default false).'),
      top_k: z.number().int().min(1).max(20).optional().describe('Maximum hints returned, default 5.'),
    },
    async ({ snapshot_id, include_cases, top_k }) => {
      const snapshotId = snapshot_id.trim();
      if (!snapshotId) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              allowedUse: 'navigation_hint_only',
              error: 'snapshot_id is required',
            }),
          }],
          isError: true,
        };
      }

      const scope = {
        tenantId: knowledgeScope?.tenantId || DEFAULT_TENANT_ID,
        workspaceId: knowledgeScope?.workspaceId || DEFAULT_WORKSPACE_ID,
        userId: knowledgeScope?.userId || DEFAULT_DEV_USER_ID,
      };
      let closeDb: (() => void) | undefined;
      let snapshotRepository = options.analysisResultSnapshotRepository;
      if (!snapshotRepository) {
        const db = openEnterpriseDb();
        closeDb = () => db.close();
        snapshotRepository = createAnalysisResultSnapshotRepository(db);
      }

      try {
        const service = createTraceSimilarityService({
          snapshotRepository,
          ...(include_cases
            ? {
              caseLibrary: options.caseLibrary ?? getCaseLibrary(),
              ragStore,
            }
            : {}),
        });
        const result = service.findSimilarAnalysisResult({
          scope,
          knowledgeScope: scope,
          snapshotId,
          includeCases: include_cases ?? false,
          limit: top_k,
        });
        if (!result) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                allowedUse: 'navigation_hint_only',
                error: 'Analysis result snapshot not found',
              }),
            }],
            isError: true,
          };
        }
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              allowedUse: 'navigation_hint_only',
              ...result,
            }),
          }],
        };
      } finally {
        closeDb?.();
      }
    },
    { annotations: { readOnlyHint: true } },
  );

  // query_perfetto_source: Search the Perfetto stdlib for SQL patterns and usage examples.
  // Enables Claude to self-learn by finding how official code uses tables/functions.
  const queryPerfettoSource = tool(
    'query_perfetto_source',
    'Search the Perfetto SQL stdlib source code for usage patterns. Packaged builds fall back to the bundled SQL schema index when the source tree is unavailable. Use this when you encounter an unfamiliar table/function, get an SQL error, or need to find how the official codebase uses a specific table or column.',
    {
      keyword: z.string().describe('Search keyword (table name, function name, column name, or SQL pattern)'),
      max_results: z.number().optional().describe('Maximum number of matching files to return (default: 5)'),
    },
    async ({ keyword, max_results }) => {
      const maxFiles = max_results ?? 5;
      const stdlibDir = getPerfettoStdlibPath();
      const docsMatches = searchPerfettoSqlDocs(keyword, { limit: maxFiles });
      const compactDocs = docsMatches.map(result => compactSqlDocEntry(result.entry));

      if (!fs.existsSync(stdlibDir)) {
        const lowerKeyword = keyword.toLowerCase();
        const schema = loadSqlSchema();
        const results = schema.templates
          .filter(t => {
            const searchable = `${t.name} ${t.category} ${t.description ?? ''}`.toLowerCase();
            return searchable.includes(lowerKeyword);
          })
          .slice(0, maxFiles)
          .map(t => ({
            file: t.id,
            matches: [
              [
                `name: ${t.name}`,
                `category: ${t.category}`,
                `type: ${t.type ?? 'unknown'}`,
                `description: ${t.description ?? ''}`,
              ].join('\n'),
            ],
          }));

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              keyword,
              source: 'bundled_schema_index',
              docs: compactDocs,
              matchedFiles: results.length,
              results: results.map(r => ({
                file: r.file,
                matchCount: r.matches.length,
                matches: r.matches,
              })),
              note: 'Perfetto stdlib source tree is unavailable in this runtime; returned bundled schema-index matches instead.',
            }),
          }],
        };
      }

      try {
        const results: Array<{ file: string; matches: string[] }> = [];
        const lowerKeyword = keyword.toLowerCase();

        // Recursively search .sql files (async to avoid blocking event loop)
        const searchDir = async (dir: string): Promise<void> => {
          if (results.length >= maxFiles) return;
          const entries = await fs.promises.readdir(dir, { withFileTypes: true });
          for (const entry of entries) {
            if (results.length >= maxFiles) return;
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              await searchDir(fullPath);
            } else if (entry.name.endsWith('.sql')) {
              const content = await fs.promises.readFile(fullPath, 'utf-8');
              if (content.toLowerCase().includes(lowerKeyword)) {
                const relPath = path.relative(stdlibDir, fullPath);
                const lines = content.split('\n');
                const matchLines: string[] = [];
                for (let i = 0; i < lines.length; i++) {
                  if (lines[i].toLowerCase().includes(lowerKeyword)) {
                    // Include 1 line of context before and after
                    const start = Math.max(0, i - 1);
                    const end = Math.min(lines.length - 1, i + 1);
                    const context = lines.slice(start, end + 1)
                      .map((l, j) => `${start + j + 1}: ${l}`)
                      .join('\n');
                    matchLines.push(context);
                    if (matchLines.length >= 8) break; // Cap matches per file
                  }
                }
                results.push({ file: relPath, matches: matchLines });
              }
            }
          }
        };

        await searchDir(stdlibDir);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              keyword,
              source: 'stdlib_source',
              docs: compactDocs,
              matchedFiles: results.length,
              results: results.map(r => ({
                file: r.file,
                matchCount: r.matches.length,
                matches: r.matches,
              })),
            }),
          }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: (err as Error).message }) }],
          isError: true,
        };
      }
    },
    { annotations: { readOnlyHint: true } },
  );

  // P1-G11: Scene plan templates extracted to `./scenePlanTemplates` (Phase 0.2 of
  // v2.1). The previous inline `'touch-tracking'` key (hyphen) silently disabled
  // hard-gate for the touch_tracking scene because strategy frontmatter uses
  // underscore-form `scene: touch_tracking`; coverage test now guards this.

  // Planning tools: submit_plan + update_plan_phase (P0-1: Explicit planning capability)
  // analysisPlanRef is declared above (P0-G10) and shared with planning tools
  const submitPlan = analysisPlanRef ? tool(
    'submit_plan',
    'Optionally submit a structured analysis plan. ' +
    'Define phases with goals and expected tools. The system tracks plan adherence and warns on deviation. ' +
    'Use when: an explicit multi-phase plan helps organize the analysis.\n' +
    'Don\'t use when: plan already submitted (use revise_plan to modify, update_plan_phase to track progress).\n' +
    'expectedCalls skillId is only valid for invoke_skill/compare_skill; scope every other tool as {tool:"fetch_artifact"} or {tool:"execute_sql"} with no skillId.\n\n' +
    'Examples:\n' +
    '1. Scrolling plan: phases=[{id:"p1", name:"概览采集", goal:"获取帧统计和卡顿分布", expectedTools:["invoke_skill"], expectedCalls:[{tool:"invoke_skill", skillId:"scrolling_analysis"}]}, ' +
    '{id:"p2", name:"根因分析", goal:"逐帧诊断卡顿原因", expectedTools:["invoke_skill","execute_sql"], expectedCalls:[{tool:"invoke_skill", skillId:"jank_frame_detail"}]}, ' +
    '{id:"p3", name:"深入验证", goal:"验证根因假设", expectedTools:["execute_sql","fetch_artifact"]}], ' +
    'successCriteria="识别卡顿根因并提供量化证据"',
    {
      phases: PLAN_PHASES_ARG_SCHEMA.describe('Ordered list of analysis phases.'),
      successCriteria: z.string().describe('What constitutes a successful analysis (e.g. "Identify root cause of jank frames with evidence")'),
      waivers: PLAN_WAIVERS_ARG_SCHEMA.optional().describe('Optional opt-outs for scene-template aspects when the trace genuinely cannot support them.'),
    },
    async (args: any, extra?: unknown) => {
      if (analysisPlanRef.current) return createRuntimeToolResult({
        success: false, error: 'plan_already_submitted', action_required: 'revise_plan',
      }, {isError: true});
      const signal = getRuntimeToolSignal(extra);
      throwIfTraceProcessorQueryCancelled(signal);
      const phaseInputs = parseToolArrayInput<PlanPhaseToolInput>(
        readAliasedField(args, ['phases', 'phase_list', 'phaseList']),
      );
      if (!phaseInputs) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: localize(outputLanguage, 'submit_plan 参数 phases 必须是数组或 JSON 数组字符串。', 'submit_plan argument phases must be an array or JSON array string.'),
            }),
          }],
          isError: true,
        };
      }

      const rawWaiverInputs = parseOptionalToolArrayInput<PlanAspectWaiver>(args.waivers);
      const waiverInputs = rawWaiverInputs ? normalizePlanWaivers(rawWaiverInputs) : null;
      if (!waiverInputs) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: localize(outputLanguage, 'submit_plan 参数 waivers 必须是数组或 JSON 数组字符串。', 'submit_plan argument waivers must be an array or JSON array string.'),
            }),
          }],
          isError: true,
        };
      }
      const normalizedSuccessCriteria = coercePlanString(readAliasedField(args, ['successCriteria', 'success_criteria']));
      if (!normalizedSuccessCriteria) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: localize(outputLanguage, 'submit_plan 参数 successCriteria 必须是字符串。', 'submit_plan argument successCriteria must be a string.'),
            }),
          }],
          isError: true,
        };
      }
      const expectedCallShapeErrors = collectPlanExpectedCallShapeErrors(phaseInputs);
      if (expectedCallShapeErrors.length > 0) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: localize(
                outputLanguage,
                'submit_plan 的 expectedCalls 形状无效；不会静默删除已声明的证据要求。',
                'submit_plan expectedCalls shape is invalid; declared evidence requirements will not be silently removed.',
              ),
              invalidExpectedCalls: expectedCallShapeErrors,
              action_required: 'submit_plan',
            }),
          }],
          isError: true,
        };
      }

      const expectationErrors = collectPlanExpectationErrors(phaseInputs);
      if (expectationErrors.length > 0) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: localize(
                outputLanguage,
                'submit_plan 不能把 informational 工具声明为 expectedTools/expectedCalls；它们不能满足证据门禁。',
                'submit_plan cannot declare informational tools in expectedTools/expectedCalls; they cannot satisfy evidence gates.',
              ),
              invalidExpectations: expectationErrors,
              action_required: 'submit_plan',
            }),
          }],
          isError: true,
        };
      }

      const normalizedPhases = phaseInputs.map(normalizePlanPhaseToolInput);
      const phaseShapeErrors = collectPlanPhaseShapeErrors(normalizedPhases);
      if (phaseShapeErrors.length > 0) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: localize(
                outputLanguage,
                'submit_plan 阶段缺少必填字段 id/name/goal。',
                'submit_plan phases are missing required id/name/goal fields.',
              ),
              invalidPhases: phaseShapeErrors,
            }),
          }],
          isError: true,
        };
      }

      const expectedSkillRegistry = await bindSkillRuntimeRegistry();
      throwIfTraceProcessorQueryCancelled(signal);
      const unavailableExpectedSkills = collectUnavailableExpectedSkillErrors(
        normalizedPhases,
        expectedSkillRegistry,
        new Set(registry.listForRequest(toolRequestScope).map(toolDefinition => toolDefinition.name)),
      );
      if (unavailableExpectedSkills.length > 0) {
        const suggestedSkillIds = suggestRegisteredSkillIds(unavailableExpectedSkills, expectedSkillRegistry);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: localize(
                outputLanguage,
                'submit_plan 只能声明当前会话可用的 MCP 工具，以及已注册且可执行的分析 Skill。',
                'submit_plan can only declare MCP tools available in this session and registered executable analysis Skills.',
              ),
              unavailableExpectedSkills,
              ...(suggestedSkillIds.length > 0 ? {suggestedSkillIds} : {}),
              action_required: 'submit_plan',
              hint: suggestedSkillIds.length > 0
                ? 'Replace the unavailable skill with one of suggestedSkillIds. Call list_skills only if none matches the evidence gap.'
                : 'Use a tool exposed in this session; for invoke_skill/compare_skill, call list_skills and choose a registered analysis Skill.',
            }),
          }],
          isError: true,
        };
      }

      const plan: AnalysisPlanV3 = {
        phases: normalizedPhases.map((p): PlanPhase => ({
          ...p,
          status: 'pending' as const,
        })),
        successCriteria: normalizedSuccessCriteria,
        submittedAt: Date.now(),
        toolCallLog: [],
        ...(sourceUseDecision
          ? {sourceUseDecisionStatus: sourceUseDecision.status}
          : {}),
        ...(waiverInputs.length > 0 ? {waivers: waiverInputs} : {}),
      };
      analysisPlanRef.current = plan;
      replayPrePlanToolCalls(analysisPlanRef);
      emitUpdate?.({
        type: 'plan_submitted',
        content: {
          phases: plan.phases.map(p => ({ id: p.id, name: p.name, goal: p.goal, status: p.status })),
          successCriteria: normalizedSuccessCriteria,
        },
        timestamp: Date.now(),
      });

      const response = {success: true};
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(response),
        }],
      };
    }
  ) : null;

  const updatePlanPhase = analysisPlanRef ? tool(
    'update_plan_phase',
    'Update an explicitly identified plan phase. Ordinary transitions start automatically from attributed evidence calls; do NOT call this merely to announce a transition. ' +
    'Completion requires successful receipts for every declared call. Skipping requires a typed disposition and preserves unresolved calls. ' +
    'summary is optional display text; it cannot prove completion or unavailability.',
    {
      phaseId: z.string(),
      status: z.enum(['in_progress', 'completed', 'skipped', 'active']).optional(),
      phaseStatus: z.enum(['in_progress', 'completed', 'skipped', 'active']).optional(),
      summary: z.string().optional(),
      skipDisposition: z.object({
        kind: z.enum(['not_applicable', 'evidence_unavailable', 'deferred']),
        failureToolCallIds: z.array(z.string()).optional(),
      }).strict().optional(),
    },
    async ({phaseId, status, phaseStatus, summary, skipDisposition}) => {
      const resolution = resolvePlanPhaseUpdateStatus(status, phaseStatus);
      if ('error' in resolution) return createRuntimeToolResult({
        success: false, error: 'invalid_phase_status', reason: resolution.error,
      }, {isError: true});
      const plan = analysisPlanRef.current;
      const phase = plan?.phases.find(candidate => candidate.id === phaseId);
      if (!plan || !phase) return createRuntimeToolResult({
        success: false, error: 'unknown_plan_phase', phaseId,
      }, {isError: true});
      const nextStatus = resolution.status;
      if (phase.status === 'completed' || phase.status === 'skipped') {
        return nextStatus === phase.status
          ? createRuntimeToolResult({success: true, unchanged: true, phaseId, status: phase.status})
          : createRuntimeToolResult({success: false, error: 'closed_phase_immutable', phaseId}, {isError: true});
      }
      const evidence = getPhaseToolEvidenceStatus(plan, phase);
      if (nextStatus === 'completed' && !evidence.satisfied) return createRuntimeToolResult({
        success: false, error: 'missing_phase_evidence', action_required: evidence.missingExpectedTools.length > 0
          ? 'run_expected_tools_before_completing_phase' : 'run_expected_calls_before_completing_phase',
        phaseId, missingExpectedCalls: evidence.missingExpectedCalls, missingExpectedTools: evidence.missingExpectedTools,
        ...(evidence.missingExpectedTools.length ? {expectedTools: evidence.missingExpectedTools} : {}),
      }, {isError: true});
      if (nextStatus === 'skipped' && !hasValidPlanSkipDisposition(plan, {...phase, skipDisposition})) {
        return createRuntimeToolResult({success: false, error: 'invalid_skip_disposition', phaseId}, {isError: true});
      }
      if (nextStatus === 'in_progress') closeSupersededInProgressPhases(plan, phase);
      phase.status = nextStatus;
      delete phase.completionSource;
      if (nextStatus === 'in_progress') {
        delete phase.completedAt;
        delete phase.skipDisposition;
      } else {
        phase.completedAt = Date.now();
        if (nextStatus === 'skipped') phase.skipDisposition = structuredClone(skipDisposition!);
      }
      phase.summary = typeof summary === 'string' ? summary.trim() : undefined;
      emitUpdate?.({
        type: 'plan_phase_updated',
        content: planPhaseUpdatedContent({phaseId, status: nextStatus, summary: phase.summary ?? '', phaseName: phase.name, origin: 'model'}),
        timestamp: Date.now(),
      });
      const completion = getAnalysisPlanCompletionStatus(plan, {minSummaryChars: 0});
      return createRuntimeToolResult({
        success: true, allPhasesComplete: completion.complete,
        ...(completion.unresolvedExpectations?.length ? {
          unresolvedExpectations: completion.unresolvedExpectations.map(gap => ({
            phaseId: gap.phase.id, disposition: gap.phase.skipDisposition,
            missingExpectedCalls: gap.missingExpectedCalls, missingExpectedTools: gap.missingExpectedTools,
          })),
        } : {}),
      });
    },
  ) : null;

  const revisePlan = analysisPlanRef ? tool(
    'revise_plan',
    'Revise your analysis plan mid-execution when new information changes priorities. ' +
    'Use this when initial data reveals unexpected conditions (e.g., discovered Flutter architecture but planned for Standard, ' +
    'or found ANR signals in a scrolling query). Preserves completed phases and audit trail.',
    {
      reason: z.string().describe('Why the plan needs revision (what new information triggered this)'),
      updatedPhases: PLAN_PHASES_ARG_SCHEMA.describe('The revised phase list. Must include all completed/in-progress phases from original plan.'),
      updatedSuccessCriteria: z.string().optional().describe('Updated success criteria (only if the goal changed)'),
      waivers: PLAN_WAIVERS_ARG_SCHEMA.optional().describe('Optional opt-outs for waivable scene-template aspects when the trace genuinely cannot support them.'),
    },
    async (args: any) => {
      const updatedPhaseInputs = parseToolArrayInput<PlanPhaseToolInput>(
        readAliasedField(args, ['updatedPhases', 'updated_phases']),
      );
      if (!updatedPhaseInputs) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: localize(outputLanguage, 'revise_plan 参数 updatedPhases 必须是数组或 JSON 数组字符串。', 'revise_plan argument updatedPhases must be an array or JSON array string.'),
            }),
          }],
          isError: true,
        };
      }

      const rawWaiverInputs = parseOptionalToolArrayInput<PlanAspectWaiver>(args.waivers);
      const waiverInputs = rawWaiverInputs ? normalizePlanWaivers(rawWaiverInputs) : null;
      if (!waiverInputs) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: localize(outputLanguage, 'revise_plan 参数 waivers 必须是数组或 JSON 数组字符串。', 'revise_plan argument waivers must be an array or JSON array string.'),
            }),
          }],
          isError: true,
        };
      }
      const normalizedReason = coercePlanString(readAliasedField(args, ['reason', 'reason_text']));
      if (!normalizedReason) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: localize(outputLanguage, 'revise_plan 参数 reason 必须是字符串。', 'revise_plan argument reason must be a string.'),
            }),
          }],
          isError: true,
        };
      }
      const expectedCallShapeErrors = collectPlanExpectedCallShapeErrors(updatedPhaseInputs);
      if (expectedCallShapeErrors.length > 0) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: localize(
                outputLanguage,
                'revise_plan 的 expectedCalls 形状无效；不会静默删除已声明的证据要求。',
                'revise_plan expectedCalls shape is invalid; declared evidence requirements will not be silently removed.',
              ),
              invalidExpectedCalls: expectedCallShapeErrors,
              action_required: 'revise_plan',
            }),
          }],
          isError: true,
        };
      }

      const expectationErrors = collectPlanExpectationErrors(updatedPhaseInputs);
      if (expectationErrors.length > 0) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: localize(
                outputLanguage,
                'revise_plan 不能把 informational 工具声明为 expectedTools/expectedCalls；它们不能满足证据门禁。',
                'revise_plan cannot declare informational tools in expectedTools/expectedCalls; they cannot satisfy evidence gates.',
              ),
              invalidExpectations: expectationErrors,
              action_required: 'revise_plan',
            }),
          }],
          isError: true,
        };
      }

      const normalizedUpdatedPhases = updatedPhaseInputs.map((p): NormalizedPlanPhaseToolInput => ({
        ...normalizePlanPhaseToolInput(p),
        status: normalizePlanPhaseStatus(readAliasedField(p, ['status'])),
      }));
      const phaseShapeErrors = collectPlanPhaseShapeErrors(normalizedUpdatedPhases);
      if (phaseShapeErrors.length > 0) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: localize(
                outputLanguage,
                'revise_plan 阶段缺少必填字段 id/name/goal。',
                'revise_plan phases are missing required id/name/goal fields.',
              ),
              invalidPhases: phaseShapeErrors,
            }),
          }],
          isError: true,
        };
      }

      const expectedSkillRegistry = await bindSkillRuntimeRegistry();
      const unavailableExpectedSkills = collectUnavailableExpectedSkillErrors(
        normalizedUpdatedPhases,
        expectedSkillRegistry,
        new Set(registry.listForRequest(toolRequestScope).map(toolDefinition => toolDefinition.name)),
      );
      if (unavailableExpectedSkills.length > 0) {
        const suggestedSkillIds = suggestRegisteredSkillIds(unavailableExpectedSkills, expectedSkillRegistry);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: localize(
                outputLanguage,
                'revise_plan 只能声明当前会话可用的 MCP 工具，以及已注册且可执行的分析 Skill。',
                'revise_plan can only declare MCP tools available in this session and registered executable analysis Skills.',
              ),
              unavailableExpectedSkills,
              ...(suggestedSkillIds.length > 0 ? {suggestedSkillIds} : {}),
              action_required: 'revise_plan',
              hint: suggestedSkillIds.length > 0
                ? 'Replace the unavailable skill with one of suggestedSkillIds. Call list_skills only if none matches the evidence gap.'
                : 'Use a tool exposed in this session; for invoke_skill/compare_skill, call list_skills and choose a registered analysis Skill.',
            }),
          }],
          isError: true,
        };
      }

      const plan = analysisPlanRef.current;
      if (!plan) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: localize(outputLanguage, '还没有提交 plan，请先调用 submit_plan。', 'No plan submitted yet. Call submit_plan first.'),
            }),
          }],
          isError: true,
        };
      }

      // Validate: completed phases from original plan must be preserved
      const originalCompleted = plan.phases.filter(p => p.status === 'completed' || p.status === 'skipped');
      const preservedIds = new Set(normalizedUpdatedPhases.map(p => p.id));
      const missingCompleted = originalCompleted.filter(p => !preservedIds.has(p.id));
      if (missingCompleted.length > 0) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: localize(
                outputLanguage,
                `已完成阶段必须保留: ${missingCompleted.map(p => p.id).join(', ')}。请把它们放入 updatedPhases。`,
                `Completed phases must be preserved: ${missingCompleted.map(p => p.id).join(', ')}. Include them in updatedPhases.`,
              ),
            }),
          }],
          isError: true,
        };
      }

      const newlyClosedPhases = normalizedUpdatedPhases.filter(up => {
        if (up.status !== 'completed' && up.status !== 'skipped') return false;
        const original = plan.phases.find(phase => phase.id === up.id);
        return !original || (original.status !== 'completed' && original.status !== 'skipped');
      });
      if (newlyClosedPhases.length > 0) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: localize(
                outputLanguage,
                `revise_plan 只能修改计划结构，不能直接闭合未完成阶段: ${newlyClosedPhases.map(phase => phase.id).join(', ')}。请保留阶段状态，并用 update_plan_phase 提交摘要与证据门禁验证。`,
                `revise_plan changes plan structure and cannot directly close unfinished phases: ${newlyClosedPhases.map(phase => phase.id).join(', ')}. Preserve their status and use update_plan_phase so summaries and evidence gates are validated.`,
              ),
              invalidPhaseIds: newlyClosedPhases.map(phase => phase.id),
              action_required: 'update_plan_phase',
            }),
          }],
          isError: true,
        };
      }

      const candidatePhases = normalizedUpdatedPhases.map((up): PlanPhase => {
        const original = plan.phases.find(p => p.id === up.id);
        if (original && (original.status === 'completed' || original.status === 'skipped')) {
          // Preserve completed phase data
          return structuredClone(original);
        }
        return {
          id: up.id,
          name: up.name,
          goal: up.goal,
          expectedTools: up.expectedTools,
          expectedCalls: up.expectedCalls,
          status: (up.status || 'pending') as any,
        };
      });

      const expectedCallKey = (call: NonNullable<PlanPhase['expectedCalls']>[number]): string =>
        `${shortExpectedToolName(call.tool)}:${call.skillId ? shortExpectedToolName(call.skillId) : ''}`;
      const updatedPhaseById = new Map(candidatePhases.map(phase => [phase.id, phase]));
      const weakenedPhases = plan.phases.flatMap(original => {
        if (original.status === 'completed' || original.status === 'skipped') return [];
        const updated = updatedPhaseById.get(original.id);
        const updatedCallKeys = new Set((updated?.expectedCalls ?? []).map(expectedCallKey));
        const removedExpectedCalls = (original.expectedCalls ?? [])
          .filter(call => !updatedCallKeys.has(expectedCallKey(call)));
        const updatedTools = new Set((updated?.expectedTools ?? []).map(shortExpectedToolName));
        const removedExpectedTools = (original.expectedTools ?? []).filter(tool => !updatedTools.has(shortExpectedToolName(tool)));
        return removedExpectedCalls.length > 0 || removedExpectedTools.length > 0
          ? [{phaseId: original.id, removedExpectedCalls, removedExpectedTools}]
          : [];
      });
      if (weakenedPhases.length > 0) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: localize(
                outputLanguage,
                `revise_plan 不能移除未完成阶段已声明的 expectedCalls: ${weakenedPhases.map(item => item.phaseId).join(', ')}。请保留证据要求；若触发条件未成立或 trace 证据不可用，请用 update_plan_phase 按边界跳过。`,
                `revise_plan cannot remove declared expectedCalls from unfinished phases: ${weakenedPhases.map(item => item.phaseId).join(', ')}. Preserve the evidence requirements; if a trigger is not met or trace evidence is unavailable, skip through update_plan_phase with that boundary.`,
              ),
              weakenedPhases,
              action_required: 'preserve_expected_calls',
            }),
          }],
          isError: true,
        };
      }

      // Save revision history for audit trail
      const revision: PlanRevision = {
        revisedAt: Date.now(),
        reason: normalizedReason,
        previousPhases: structuredClone(plan.phases),
      };
      if (!plan.revisionHistory) plan.revisionHistory = [];
      plan.revisionHistory.push(revision);

      // Apply revision: merge completed phase data (summary, completedAt) with updated structure
      plan.phases = candidatePhases;

      const normalizedUpdatedSuccessCriteria = coercePlanString(
        readAliasedField(args, ['updatedSuccessCriteria', 'updated_success_criteria']),
      );
      if (normalizedUpdatedSuccessCriteria) {
        plan.successCriteria = normalizedUpdatedSuccessCriteria;
      }
      if (waiverInputs.length > 0) plan.waivers = waiverInputs;
      delete plan.unresolvedAspects;

      emitUpdate?.({
        type: 'plan_revised',
        content: {
          reason: normalizedReason,
          phases: plan.phases.map(p => ({ id: p.id, name: p.name, goal: p.goal, status: p.status })),
          revisionCount: plan.revisionHistory.length,
        },
        timestamp: Date.now(),
      });

      const pending = plan.phases.filter(p => p.status === 'pending');
      const reviseResponse: Record<string, unknown> = {
        success: true,
        message: localize(
          outputLanguage,
          `Plan 已修订（第 ${plan.revisionHistory.length} 次）: ${normalizedReason}`,
          `Plan revised (revision #${plan.revisionHistory.length}): ${normalizedReason}`,
        ),
        totalPhases: plan.phases.length,
        pendingPhases: pending.length,
        nextPhase: pending[0]?.id,
      };
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(reviseResponse),
        }],
      };
    }
  ) : null;

  const lookupStrategyDetail = tool(
    'lookup_strategy_detail',
    (loadPromptTemplate('prompt-strategy-detail-tool-description') ?? '').replace(/<!--[\s\S]*?-->/g, '').trim(),
    {
      detailRef: z.string().optional().describe('Detail ref from the scene strategy catalog.'),
      detailId: z.string().optional().describe('Detail id without scene prefix, used with scene or current sceneType.'),
      scene: z.string().optional().describe('Optional scene id when detailRef is not prefixed. Defaults to the current scene.'),
    },
    async ({ detailRef, detailId, scene }) => {
      const effectiveScene = scene?.trim() || options.sceneType;
      const requestedRef = detailRef?.trim()
        || (detailId?.trim()
          ? (effectiveScene ? `${effectiveScene}:${detailId.trim()}` : detailId.trim())
          : '');
      if (!requestedRef) {
        const details = effectiveScene ? getStrategyDetails(effectiveScene, strategyRegistry) :
          strategyRegistry.getAllStrategies().filter(def => def.strategyKind !== 'contract_only').flatMap(def => def.detailSections ?? []);
        const catalog = details.slice(0, 24).map(detail => ({
          detailRef: detail.ref, title: detail.title.slice(0, 160), description: detail.content.slice(0, 240),
        }));
        return createRuntimeToolResult({success: true, informational: true, catalog, truncated: details.length > catalog.length});
      }
      const candidate = getStrategyDetailByRef(requestedRef, effectiveScene, strategyRegistry);
      const detail = candidate?.ref === requestedRef ? candidate : undefined;
      if (!detail) {
        const availableDetails = effectiveScene
          ? getStrategyDetails(effectiveScene, strategyRegistry).map(d => ({ detailRef: d.ref, title: d.title }))
          : [];
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: localize(
                outputLanguage,
                '未找到 strategy detail。请使用 submit_plan/update_plan_phase 返回的 detailRef，或从 availableDetails 选择。',
                'Strategy detail not found. Use the detailRef returned by submit_plan/update_plan_phase, or choose from availableDetails.',
              ),
              requestedRef,
              scene: effectiveScene,
              availableDetails,
            }),
          }],
          isError: true,
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            informational: true,
            detailRef: detail.ref,
            title: detail.title,
            content: detail.content,
            contentTruncated: false,
            note: localize(
              outputLanguage,
              '此 detail 仅提供执行方法/SQL/检查表；必须通过 Skill/SQL/artifact 获取 trace 证据后才能完成阶段或写结论。',
              'This detail only provides execution method/SQL/checklist guidance; collect trace evidence through Skill/SQL/artifacts before completing phases or writing conclusions.',
            ),
          }),
        }],
      };
    },
    { annotations: { readOnlyHint: true } },
  );

  // P0-G4: Hypothesis-verify cycle tools
  const hypothesesRef = options.hypotheses;
  let hypothesisCounter = 0;

  const submitHypothesis = hypothesesRef ? tool(
    'submit_hypothesis',
    'Record a formal hypothesis that needs verification through data. ' +
    'Use this when you form a testable theory about the root cause of a performance issue. ' +
    'Every hypothesis MUST be resolved (confirmed/rejected with evidence) before concluding.',
    {
      id: z.string().optional().describe('Optional caller-provided hypothesis ID (e.g., "h1"). If omitted, the system assigns one.'),
      statement: z.string().describe(
        'The hypothesis statement (e.g., "RenderThread is blocked by Binder transactions causing jank frames").'
      ),
      basis: z.string().optional().describe(
        'What observation prompted this hypothesis (e.g., "Observed 3 frames with RenderThread in sleeping state").'
      ),
    },
    async (args: any) => {
      const {id, statement, title, basis, reasoning} = args;
      const normalizedStatement = statement?.trim();
      const normalizedTitle = title?.trim();
      const normalizedBasis = basis?.trim();
      const normalizedReasoning = reasoning?.trim();
      const effectiveStatement = normalizedStatement || normalizedTitle;
      const effectiveBasis = normalizedBasis || normalizedReasoning;
      if (!effectiveStatement) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: 'submit_hypothesis requires statement (or title)',
            }),
          }],
          isError: true,
        };
      }

      const requestedId = id?.trim();
      const existing = requestedId ? hypothesesRef.find(h => h.id === requestedId) : undefined;
      if (existing) {
        if (existing.statement !== effectiveStatement) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: `Hypothesis "${existing.id}" is already bound to a different immutable statement`,
                hypothesisId: existing.id,
                statement: existing.statement,
                action_required: 'submit_new_hypothesis_id_for_replacement_statement',
              }),
            }],
            isError: true,
          };
        }
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              hypothesisId: existing.id,
              statement: existing.statement,
              status: existing.status,
              reused: true,
            }),
          }],
        };
      }

      const hypothesisId = requestedId || `h${++hypothesisCounter}`;
      const numericId = /^h(\d+)$/i.exec(hypothesisId);
      if (numericId) {
        hypothesisCounter = Math.max(hypothesisCounter, Number(numericId[1]));
      }
      const hypothesis: Hypothesis = {
        id: hypothesisId,
        statement: effectiveStatement,
        status: 'formed',
        basis: effectiveBasis,
        formedAt: Date.now(),
      };
      hypothesesRef.push(hypothesis);

      return {
        content: [{
          type: 'text' as const,
            text: JSON.stringify({
              success: true,
              hypothesisId,
              statement: hypothesis.statement,
            }),
          }],
        };
    }
  ) : null;

  const resolveHypothesis = hypothesesRef ? tool(
    'resolve_hypothesis',
    'Resolve a submitted hypothesis\'s exact immutable statement. ' +
    'confirmed supports it; rejected contradicts it. ' +
    'For a different cause, reject the original, then submit a new hypothesis. ' +
    'New evidence may overturn a prior resolution; re-resolving supersedes (history kept).',
    {
      hypothesisId: z.string().optional().describe('Hypothesis ID to resolve (e.g., "h1"). Alias: id.'),
      id: z.string().optional().describe('Alias for hypothesisId, accepted for Claude SDK argument compatibility.'),
      status: z.enum(['confirmed', 'rejected']).optional().describe(
        'Resolution of the original immutable statement: confirmed only if evidence supports it; rejected if evidence contradicts or replaces it. Alias: verdict.'
      ),
      verdict: z.enum(['confirmed', 'rejected']).optional().describe('Alias for status, accepted for Claude SDK argument compatibility.'),
      evidence: z.string().describe(
        'Specific data, timestamps, or tool results showing why the original immutable statement is supported or contradicted.'
      ),
    },
    async ({ hypothesisId, id, status, verdict, evidence }) => {
      const normalizedHypothesisId = hypothesisId?.trim();
      const normalizedId = id?.trim();
      if (
        (normalizedHypothesisId && normalizedId && normalizedHypothesisId !== normalizedId)
        || (status && verdict && status !== verdict)
      ) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: 'resolve_hypothesis aliases must contain matching values',
              action_required: 'retry_resolve_hypothesis_with_matching_aliases',
            }),
          }],
          isError: true,
        };
      }

      const effectiveHypothesisId = normalizedHypothesisId || normalizedId;
      const effectiveStatus = status || verdict;
      if (!effectiveHypothesisId || !effectiveStatus) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: 'resolve_hypothesis requires hypothesisId (or id) and status (or verdict)',
            }),
          }],
          isError: true,
        };
      }
      const hypothesis = hypothesesRef.find(h => h.id === effectiveHypothesisId);
      if (!hypothesis) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: `Hypothesis "${effectiveHypothesisId}" was not submitted`,
              hypothesisId: effectiveHypothesisId,
              action_required: 'submit_hypothesis_before_resolving',
            }),
          }],
          isError: true,
        };
      }
      // A re-resolution supersedes the prior verdict after every guard below
      // has passed; until then the ledger must stay untouched.
      const priorResolution: HypothesisResolutionRecord | null =
        hypothesis.status !== 'formed' && hypothesis.resolvedAt !== undefined
          ? { status: hypothesis.status, evidence: hypothesis.evidence ?? '', resolvedAt: hypothesis.resolvedAt }
          : null;

      if (effectiveStatus === 'confirmed' && options.sceneType === 'scrolling') {
        const claimBoundaryIssue = assessScrollingJankClaimBoundary(hypothesis.statement);
        if (claimBoundaryIssue) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                hypothesisId: effectiveHypothesisId,
                statement: hypothesis.statement,
                error: localize(
                  outputLanguage,
                  claimBoundaryIssue.code === 'prediction_error_noise_overclaim'
                    ? 'Prediction Error 只能作为 scheduler 预测偏差标签解释；不能把密集或连续样本一概确认为统计噪声、统计假象或 measurement artifact。请拒绝原假设，再提交带“孤立错误通常不代表用户可感知 App 卡顿”等边界的新假设。'
                    : '不能确认“唯一真实/唯一用户可感知掉帧”这类排他性结论。请拒绝原假设，再提交只描述直接证据范围的新假设。',
                  claimBoundaryIssue.code === 'prediction_error_noise_overclaim'
                    ? 'Prediction Error is a scheduler prediction-drift label; dense or continuous samples cannot be confirmed as statistical noise. Reject the original hypothesis, then submit a bounded replacement such as “isolated errors usually do not imply user-perceived app jank.”'
                    : 'An exclusive “only real/user-perceived jank” conclusion cannot be confirmed. Reject the original hypothesis, then submit a replacement limited to the directly supported evidence.',
                ),
                action_required: 'reject_hypothesis_and_submit_bounded_replacement',
              }),
            }],
            isError: true,
          };
        }
      }

      if (priorResolution) {
        (hypothesis.history ??= []).push(priorResolution);
      }
      hypothesis.status = effectiveStatus;
      hypothesis.evidence = evidence;
      hypothesis.resolvedAt = Date.now();

      const unresolvedCount = hypothesesRef.filter(h => h.status === 'formed').length;
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            hypothesisId: effectiveHypothesisId,
            statement: hypothesis.statement,
            status: effectiveStatus,
            ...(priorResolution
              ? { superseded: true, priorStatus: priorResolution.status, historyDepth: hypothesis.history!.length }
              : {}),
            unresolvedCount,
          }),
        }],
      };
    }
  ) : null;

  // ── P1-G1: flag_uncertainty — non-blocking human interaction ──
  const uncertaintyFlagsRef = options.uncertaintyFlags;
  const flagUncertainty = uncertaintyFlagsRef ? tool(
    'flag_uncertainty',
    'Signal that you are uncertain about an aspect and making an assumption to proceed. ' +
    'Use this when you encounter ambiguity (e.g., unclear which process is the focus app, ' +
    'multiple possible root causes, unclear user intent). Analysis continues without blocking — ' +
    'the user sees your flag and can provide clarification in the next turn.',
    {
      topic: z.string().describe('What aspect you are uncertain about'),
      assumption: z.string().describe('What assumption you are making to proceed'),
      question: z.string().describe('What you would ask the user if you could'),
    },
    async ({ topic, assumption, question }) => {
      const flag: UncertaintyFlag = { topic, assumption, question, timestamp: Date.now() };
      uncertaintyFlagsRef.push(flag);

      // Emit as SSE event so the user sees it in real-time
      emitUpdate?.({
        type: 'progress',
        content: {
          phase: 'analyzing',
          message: localize(
            outputLanguage,
            `⚠️ 不确定性标记: ${topic}\n假设: ${assumption}\n建议确认: ${question}`,
            `⚠️ Uncertainty flagged: ${topic}\nAssumption: ${assumption}\nSuggested confirmation: ${question}`,
          ),
        },
        timestamp: Date.now(),
      });

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            message: localize(
              outputLanguage,
              `已标记不确定性。将基于假设继续: "${assumption}"。用户会看到该标记，并可在下一轮纠正。`,
              `Uncertainty flagged. Proceeding with assumption: "${assumption}". The user will see this flag and can correct it in the next turn.`,
            ),
            flagCount: uncertaintyFlagsRef.length,
          }),
        }],
      };
    }
  ) : null;

  // ── P1-G19: recall_patterns — agent-queryable long-term memory ──
  const recallPatterns = tool(
    'recall_patterns',
    'Query long-term analysis pattern memory for insights from past sessions with similar traces. ' +
    'Use this when you want to check if similar traces have been analyzed before and what was discovered. ' +
    'Provide trace characteristics like architecture type, scene type, and domain keywords.',
    {
      architectureType: z.string().optional().describe('Architecture type (e.g., "standard", "flutter_surfaceview", "compose")'),
      sceneType: z.string().optional().describe('Scene type (e.g., "scrolling", "startup", "anr")'),
      keywords: z.array(z.string()).optional().describe('Domain keywords (e.g., ["jank", "binder", "gpu"])'),
    },
    async ({ architectureType, sceneType: querySceneType, keywords }) => {
      if (privateAnalysisContext) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            success: true,
            disabled: 'private_analysis_context',
            positivePatterns: [],
            negativePatterns: [],
            message: 'Cross-session pattern recall is disabled for private source and RAG analyses.',
          }) }],
        };
      }
      const features = extractTraceFeatures({
        architectureType,
        sceneType: querySceneType,
        packageName,
      });
      // Add extra keyword features if provided
      if (keywords) {
        for (const kw of keywords) {
          features.push(`domain:${kw.toLowerCase()}`);
        }
      }

      const positiveMatches = matchPatterns(features, knowledgeScope);
      const negativeMatches = matchNegativePatterns(features, knowledgeScope);

      if (positiveMatches.length === 0 && negativeMatches.length === 0) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            success: true,
            message: 'No matching patterns found in memory. This may be a novel trace configuration.',
            positivePatterns: [],
            negativePatterns: [],
          }) }],
        };
      }

      const positive = positiveMatches.map(m => ({
        sceneType: m.sceneType,
        architectureType: m.architectureType,
        score: Math.round(m.score * 100),
        insights: m.keyInsights.slice(0, 3),
        matchCount: m.matchCount,
      }));

      const negative = negativeMatches.flatMap(m =>
        m.failedApproaches.slice(0, 3).map(a => ({
          type: a.type,
          approach: a.approach,
          reason: a.reason,
          workaround: a.workaround,
        }))
      );

      // P1-10: Also include verifier's learned misdiagnosis patterns
      let learnedMisdiagnosis: Array<{ keywords: string[]; message: string; occurrences: number }> = [];
      try {
        const learnedPatternsFile = backendLogPath('learned_misdiagnosis_patterns.json');
        if (fs.existsSync(learnedPatternsFile)) {
          const raw = JSON.parse(fs.readFileSync(learnedPatternsFile, 'utf-8'));
          const cutoff = Date.now() - 60 * 24 * 60 * 60 * 1000; // 60-day TTL
          learnedMisdiagnosis = (raw as any[])
            .filter((p: any) => p.createdAt >= cutoff && p.occurrences >= 2)
            .slice(0, 10)
            .map((p: any) => ({
              keywords: p.keywords,
              message: p.message,
              occurrences: p.occurrences,
            }));
        }
      } catch { /* non-fatal */ }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          success: true,
          positivePatterns: positive,
          negativePatterns: negative,
          learnedMisdiagnosis: learnedMisdiagnosis.length > 0 ? learnedMisdiagnosis : undefined,
          message: `Found ${positive.length} positive and ${negative.length} negative patterns from past sessions.` +
            (learnedMisdiagnosis.length > 0 ? ` Also ${learnedMisdiagnosis.length} learned misdiagnosis avoidance patterns.` : ''),
        }) }],
      };
    },
    { annotations: { readOnlyHint: true } },
  );

  // ---------------------------------------------------------------------------
  // Comparison mode tools — conditional on referenceTraceId
  // ---------------------------------------------------------------------------
  const { referenceTraceId, comparisonContext } = options;

  const executeSqlOn = referenceTraceId ? tool(
    'execute_sql_on',
    requireToolDescription('prompt-execute-sql-on-tool-description') + '\n\n' +
    requireToolDescription('prompt-sql-evidence-guidance'),
    {
      planPhaseId: z.string().optional().describe('Optional explicit plan phase ID for this invocation.'),
      trace: z.enum(['current', 'reference']).describe(
        'Which trace to query: "current" = primary trace loaded in Perfetto, "reference" = comparison trace.'
      ),
      sql: z.string().describe('The SQL query to execute against the specified trace.'),
      summary: z.boolean().optional().describe(
        'When true, returns column statistics + sample rows instead of full results. Default: false.'
      ),
    },
    async ({ trace, sql, summary, planPhaseId }, extra) => {
      const signal = getRuntimeToolSignal(extra);
      throwIfTraceProcessorQueryCancelled(signal);
      const artifactSqlHint = artifactSqlMisuseHint(sql, outputLanguage);
      if (artifactSqlHint) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(artifactSqlHint) }],
          isError: true,
        };
      }

      const targetTraceId = trace === 'reference' ? referenceTraceId : traceId;
      const traceLabel = `[${traceLocationDisplayLabel(trace)}]`;
      const producer = createEvidenceProducerContext(
        'execute_sql_on',
        {trace, sql, summary, planPhaseId},
        comparisonSqlProducerReason(trace),
        trace,
      );
      try {
        const sqlStart = Date.now();
        const { result, finalSql, injected, traceProvenance, normalizedSql, sqlRewrites } = await runRawSqlWithIncludeInjection(
          targetTraceId,
          sql,
          trace,
          signal,
        );
        const processIdentityWarning = rawSqlProcessIdentityWarning(normalizedSql);
        const success = !result.error;
        const executionWitness = success ? captureRawSqlEvidence(result, {traceId: targetTraceId, traceSide: trace}) : undefined;
        const columnUnits = projectEvidenceColumnUnitsForModel(
          {columns: result.columns, rows: result.rows}, executionWitness);
        const truncated = result.rows.length > 200;
        const rows = truncated ? result.rows.slice(0, 200) : result.rows;
        const sqlArtifact = success && result.columns.length > 0 && result.rows.length > SQL_RAW_INLINE_ROW_LIMIT
          ? storeSqlResultArtifact(artifactStore, {
              toolName: 'execute_sql_on',
              executionWitness,
              columns: result.columns,
              rows: result.rows,
              sql: finalSql,
              stdlibInjectedModules: injected,
              traceProvenance,
              producer,
            })
          : undefined;
        const shouldReturnSqlSummary = success && result.rows.length > 0 && (summary || !!sqlArtifact);
        let emittedEvidence: { evidenceRefId: string; queryHash: string; queryReview?: QueryReviewV1 } | undefined;

        if (shouldReturnSqlSummary) {
          const summaryResult = summarizeSqlResult(result.columns, result.rows);
          const durationMs = Date.now() - sqlStart;
          if (emitUpdate) {
            emittedEvidence = emitSqlSummaryDataEnvelope(
              emitUpdate,
              summaryResult,
              finalSql,
              injected,
              traceProvenance,
              producer,
              processIdentityWarning,
              sqlArtifact?.artifactId,
              {
                durationMs,
                truncated: false,
                captureStore: artifactStore, executionWitness,
                sqlRewrites,
                toolName: 'execute_sql_on',
                outputLanguage,
              },
            );
            updateSqlArtifactQueryReview(artifactStore, sqlArtifact, emittedEvidence.queryReview);
          }
          const text = {
            success: true,
            trace: traceLabel,
            traceSide: trace,
            traceId: targetTraceId,
            traceProvenance,
            mode: 'summary',
            autoSummarized: !summary && !!sqlArtifact,
            summary: summaryResult,
            ...(columnUnits ? {columnUnits} : {}),
            totalRows: result.rows.length,
            ...(sqlArtifact ? {
              artifactId: sqlArtifact.artifactId,
              artifact: sqlArtifact.artifactSummary,
              rowsAvailableViaArtifact: true,
              pageSize: SQL_ARTIFACT_PAGE_SIZE,
              hint: `Use the current summary first. Fetch detail="rows" from artifactId="${sqlArtifact.artifactId}" only when a required field or representative sample is missing, or the user explicitly requests row-level data; read the minimum rows needed.`,
            } : {}),
            durationMs,
            evidenceRefId: emittedEvidence?.evidenceRefId,
            ...(emittedEvidence?.queryReview ? { queryReview: compactQueryReviewForToolResponse(emittedEvidence.queryReview) } : {}),
            sourceToolCallId: producer.sourceToolCallId,
            paramsHash: producer.paramsHash,
            planPhaseId: producer.planPhaseId,
            executableSql: finalSql,
            ...(sqlRewrites.length > 0 ? { sqlRewrites } : {}),
            stdlibInjectedModules: injected,
            ...(processIdentityWarning ? { processIdentityWarning } : {}),
          };
          return createRuntimeToolResult(text, {
            decorate: text => consumeWatchdogWarning(text + getReasoningNudge()),
          });
        }

        const durationMs = Date.now() - sqlStart;
        if (emitUpdate && success && result.columns.length > 0) {
          emittedEvidence = emitSqlDataEnvelope(
            emitUpdate,
            result.columns,
            rows,
            finalSql,
            injected,
            traceProvenance,
            producer,
            processIdentityWarning,
            undefined,
            {
              durationMs,
              truncated,
              captureStore: artifactStore, executionWitness,
              sqlRewrites,
              toolName: 'execute_sql_on',
              rowCount: result.rows.length,
              outputLanguage,
            },
          );
        }

        const text = success ? {
          success,
          trace: traceLabel,
          traceSide: trace,
          traceId: targetTraceId,
          traceProvenance,
          columns: result.columns,
          rows,
          ...(columnUnits ? {columnUnits} : {}),
          totalRows: result.rows.length,
          truncated,
          durationMs,
          evidenceRefId: emittedEvidence?.evidenceRefId,
          ...(emittedEvidence?.queryReview ? { queryReview: compactQueryReviewForToolResponse(emittedEvidence.queryReview) } : {}),
          sourceToolCallId: producer.sourceToolCallId,
          paramsHash: producer.paramsHash,
          planPhaseId: producer.planPhaseId,
          executableSql: finalSql,
          ...(sqlRewrites.length > 0 ? { sqlRewrites } : {}),
          stdlibInjectedModules: injected,
          ...(processIdentityWarning ? { processIdentityWarning } : {}),
        } : buildSqlFailureToolPayload({
          error: result.error || localize(outputLanguage, 'SQL 执行失败', 'SQL execution failed'),
          trace: traceLabel,
          traceSide: trace,
          traceId: targetTraceId,
          traceProvenance,
          sourceToolCallId: producer.sourceToolCallId,
          paramsHash: producer.paramsHash,
          planPhaseId: producer.planPhaseId,
          executableSql: finalSql,
          sqlRewrites,
          stdlibInjectedModules: injected,
          processIdentityWarning,
          durationMs,
          outputLanguage,
        });
        return createRuntimeToolResult(text, {
          decorate: text => consumeWatchdogWarning(success ? text + getReasoningNudge() : text),
        });
      } catch (e: any) {
        rethrowIfTraceProcessorQueryCancelled(e);
        const traceProvenance = buildScopedTraceProvenance(targetTraceId, trace);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(buildSqlFailureToolPayload({
              trace: traceLabel,
              traceSide: trace,
              traceId: targetTraceId,
              traceProvenance,
              sourceToolCallId: producer.sourceToolCallId,
              paramsHash: producer.paramsHash,
              planPhaseId: producer.planPhaseId,
              error: e.message,
              executableSql: sql,
              outputLanguage,
            })),
          }],
        };
      }
    },
    { annotations: { readOnlyHint: true } },
  ) : null;

  const compareSkill = referenceTraceId ? tool(
    'compare_skill',
    'Run the same skill on both current and reference traces in parallel, returning side-by-side results with schema alignment info.\n\n' +
    'Use when: you want to compare the same analysis dimension across both traces (e.g., scrolling_analysis, cpu_analysis).\n' +
    'When the two traces need different package names, startup IDs, or time windows, use currentParams/referenceParams for side-specific values.\n' +
    'Don\'t use when: you need different skills on each trace, or ad-hoc SQL queries (use execute_sql_on instead).\n\n' +
    'Examples:\n' +
    '1. Compare scrolling: skillId="scrolling_analysis", params={process_name: "com.example.app"}\n' +
    '2. Compare startup detail with different windows: skillId="startup_detail", currentParams={startup_id:1,start_ts:100,end_ts:200}, referenceParams={startup_id:1,start_ts:500,end_ts:650}\n' +
    '3. Compare CPU: skillId="cpu_analysis"',
    {
      planPhaseId: z.string().optional().describe('Optional explicit plan phase ID for this invocation.'),
      skillId: z.string().describe('Skill identifier to run on both traces'),
      params: z.record(z.string(), z.any()).optional().describe(
        'Shared parameters passed to both skill executions. Common: { process_name, start_ts, end_ts }'
      ),
      currentParams: z.record(z.string(), z.any()).optional().describe(
        'Parameters for the current trace only. Overrides shared params for the current side.'
      ),
      referenceParams: z.record(z.string(), z.any()).optional().describe(
        'Parameters for the reference trace only. Overrides shared params for the reference side.'
      ),
      current_params: z.record(z.string(), z.any()).optional().describe(
        'Alias for currentParams for OpenAI-compatible callers.'
      ),
      reference_params: z.record(z.string(), z.any()).optional().describe(
        'Alias for referenceParams for OpenAI-compatible callers.'
      ),
    },
    async ({ skillId, params, currentParams, referenceParams, current_params, reference_params, planPhaseId }, extra) => {
      const signal = getRuntimeToolSignal(extra);
      throwIfTraceProcessorQueryCancelled(signal);
      try {
        const comparisonRegistry = await bindSkillRuntimeRegistry();
        const comparisonSkillDef = comparisonRegistry.getSkill(skillId);
        if (!comparisonSkillDef) return unavailableSkillResult(skillId, {comparison: true});
        if (
          comparisonSkillDef.type === 'pipeline_definition'
          || comparisonSkillDef.type === 'comparison'
        ) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                partial: false,
                skillId,
                error: `Skill "${skillId}" is metadata-only and cannot be executed on either trace.`,
                action_required: 'list_skills',
              }),
            }],
            isError: true,
          };
        }
        const currentSideParams = currentParams ?? current_params;
        const referenceSideParams = referenceParams ?? reference_params;
        const explicitInvalidParamsBySide = {
          current: undeclaredModelSkillParams(comparisonSkillDef, {...params, ...currentSideParams}, true),
          reference: undeclaredModelSkillParams(comparisonSkillDef, {...params, ...referenceSideParams}, true),
        };
        if (explicitInvalidParamsBySide.current.length || explicitInvalidParamsBySide.reference.length) {
          return createRuntimeToolResult({success: false, skillId,
            invalidParamsBySide: explicitInvalidParamsBySide,
            action_required: 'retry_compare_skill_with_declared_side_params'});
        }
        // Process ids and heap dump timestamps only mean something inside one trace.
        const sharedTraceLocalSelectors = ['upid', 'pid', 'graph_sample_ts'].filter(key => params?.[key] != null);
        if (sharedTraceLocalSelectors.some(key => currentSideParams?.[key] == null || referenceSideParams?.[key] == null)) {
          return createRuntimeToolResult({ success: false, skillId,
            error: 'Trace-local UPID/PID/graph_sample_ts selectors require explicit currentParams and referenceParams; they cannot be shared across traces.',
            action_required: 'provide_per_trace_process_selectors' });
        }
        const referenceSharedParams = referenceSharedParamsForComparison(
          {...params, ...referenceSideParams},
          packageName,
          comparisonContext?.referencePackageName,
          comparisonSkillDef,
        );
        const normalizedCurrentParams = normalizeSkillParams(
          { ...(params ?? {}), ...(currentSideParams ?? {}) },
          packageName,
          comparisonSkillDef,
        );
        const normalizedReferenceParams = normalizeSkillParams(
          { ...referenceSharedParams.params, ...(referenceSideParams ?? {}) },
          comparisonContext?.referencePackageName,
          comparisonSkillDef,
        );
        const [preparedCurrent, preparedReference] = await Promise.all([
          skillExecutor.prepareInvocation(skillId, traceId, normalizedCurrentParams, { __traceSide: 'current', signal }),
          skillExecutor.prepareInvocation(skillId, referenceTraceId, normalizedReferenceParams, { __traceSide: 'reference', signal }),
        ]);
        if (!preparedCurrent.allowed || !preparedReference.allowed) return createRuntimeToolResult({ success: false, skillId,
          error: 'Process scope admission failed for comparison.',
          sideErrors: { current: preparedCurrent.error, reference: preparedReference.error },
          action_required: 'provide_per_trace_process_selectors' });
        const [currentParamResolution, referenceParamResolution] = await Promise.allSettled([
          resolveRegisteredDrillDownSkillParams({
            skillId,
            params: preparedCurrent.params,
            processScope: preparedCurrent.processScope,
            traceId,
            traceProcessorService,
            signal,
          }),
          resolveRegisteredDrillDownSkillParams({
            skillId,
            params: preparedReference.params,
            processScope: preparedReference.processScope,
            traceId: referenceTraceId,
            traceProcessorService,
            signal,
          }),
        ]);
        if (currentParamResolution.status === 'rejected') {
          rethrowIfTraceProcessorQueryCancelled(currentParamResolution.reason);
        }
        if (referenceParamResolution.status === 'rejected') {
          rethrowIfTraceProcessorQueryCancelled(referenceParamResolution.reason);
        }
        if (
          currentParamResolution.status === 'rejected'
          || referenceParamResolution.status === 'rejected'
        ) {
          const resolutionFailedSides = [
            ...(currentParamResolution.status === 'rejected' ? ['current' as const] : []),
            ...(referenceParamResolution.status === 'rejected' ? ['reference' as const] : []),
          ];
          const errorBySide = {
            ...(currentParamResolution.status === 'rejected' ? {
              current: currentParamResolution.reason instanceof Error
                ? currentParamResolution.reason.message
                : String(currentParamResolution.reason),
            } : {}),
            ...(referenceParamResolution.status === 'rejected' ? {
              reference: referenceParamResolution.reason instanceof Error
                ? referenceParamResolution.reason.message
                : String(referenceParamResolution.reason),
            } : {}),
          };
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                partial: false,
                failedSides: resolutionFailedSides,
                error: 'Dual-trace drill-down parameter resolution failed before skill execution.',
                sideErrors: errorBySide,
                action_required: 'retry_compare_skill_with_valid_side_params',
              }),
            }],
            isError: true,
          };
        }
        const effectiveParams = currentParamResolution.value.params;
        const refParams = referenceParamResolution.value.params;
        const invalidParamsBySide = {
          current: undeclaredModelSkillParams(comparisonSkillDef, effectiveParams),
          reference: undeclaredModelSkillParams(comparisonSkillDef, refParams),
        };
        if (invalidParamsBySide.current.length > 0 || invalidParamsBySide.reference.length > 0) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                partial: false,
                skillId,
                invalidParamsBySide,
                error: 'Undeclared Skill parameters were supplied for one or both comparison sides.',
                action_required: 'retry_compare_skill_with_declared_side_params',
              }),
            }],
            isError: true,
          };
        }
        const producerInput = {
          skillId,
          currentEffectiveParams: effectiveParams,
          referenceEffectiveParams: refParams,
          ...(currentParamResolution.value.audit ? {
            currentDrillDownResolution: currentParamResolution.value.audit,
          } : {}),
          ...(referenceParamResolution.value.audit ? {
            referenceDrillDownResolution: referenceParamResolution.value.audit,
          } : {}),
          parameterMapping: {
            referenceIdentityRemapped: referenceSharedParams.identityRemapped,
            currentOverrideKeys: Object.keys(currentSideParams ?? {}),
            referenceOverrideKeys: Object.keys(referenceSideParams ?? {}),
          },
        };
        const baseProducer = createEvidenceProducerContext(
          'compare_skill',
          {...producerInput, planPhaseId},
          localize(
            outputLanguage,
            `对比 Skill ${skillId}，在${traceLocationDisplayLabel('current')}和${traceLocationDisplayLabel('reference')}上收集同构证据。`,
            `Compare Skill ${skillId} to collect aligned evidence on ${traceLocationDisplayLabel('current')} and ${traceLocationDisplayLabel('reference')}.`,
          ),
        );

        emitUpdate?.({
          type: 'progress',
          content: {
            phase: 'analyzing',
            message: localize(
              outputLanguage,
              `对比技能 ${skillId}：在${traceLocationDisplayLabel('current')}和${traceLocationDisplayLabel('reference')}上并行执行...`,
              `Comparing skill ${skillId}: running on ${traceLocationDisplayLabel('current')} and ${traceLocationDisplayLabel('reference')} in parallel...`,
            ),
          },
          timestamp: Date.now(),
        });

        const compareStart = Date.now();
        const currentTraceProvenance = buildScopedTraceProvenance(traceId, 'current');
        const referenceTraceProvenance = buildScopedTraceProvenance(referenceTraceId, 'reference');
        const [currentSettled, referenceSettled] = await Promise.allSettled([
          executePreparedSkill(skillId, traceId, effectiveParams, {
            __traceSide: 'current',
            __outputLanguage: outputLanguage,
            ...(currentTraceProvenance.paneSide ? { __paneSide: currentTraceProvenance.paneSide } : {}),
            signal,
          }, preparedCurrent.processScope),
          executePreparedSkill(skillId, referenceTraceId, refParams, {
            __traceSide: 'reference',
            __outputLanguage: outputLanguage,
            ...(referenceTraceProvenance.paneSide ? { __paneSide: referenceTraceProvenance.paneSide } : {}),
            signal,
          }, preparedReference.processScope),
        ]);
        if (currentSettled.status === 'rejected') {
          rethrowIfTraceProcessorQueryCancelled(currentSettled.reason);
        }
        if (referenceSettled.status === 'rejected') {
          rethrowIfTraceProcessorQueryCancelled(referenceSettled.reason);
        }
        const rejectedResult = (reason: unknown): SkillExecutionResult => ({
          skillId,
          skillName: skillId,
          success: false,
          displayResults: [],
          diagnostics: [],
          executionTimeMs: 0,
          error: reason instanceof Error ? reason.message : String(reason),
        });
        const currentResult = currentSettled.status === 'fulfilled'
          ? currentSettled.value
          : rejectedResult(currentSettled.reason);
        const refResult = referenceSettled.status === 'fulfilled'
          ? referenceSettled.value
          : rejectedResult(referenceSettled.reason);
        const comparisonExternalAuthored =
          comparisonRegistry.getSkillOrigin(skillId)?.origin ===
          'external_pack';
        const localizedCurrentDisplayResults = localizeSkillDisplayResults(
          skillId,
          currentResult.displayResults,
          outputLanguage,
          {externalAuthored: comparisonExternalAuthored},
        ) || [];
        const localizedReferenceDisplayResults = localizeSkillDisplayResults(
          skillId,
          refResult.displayResults,
          outputLanguage,
          {externalAuthored: comparisonExternalAuthored},
        ) || [];
        const compareDuration = Date.now() - compareStart;
        const currentSuccess = currentResult.success === true;
        const referenceSuccess = refResult.success === true;
        const success = currentSuccess && referenceSuccess;
        const failedSides = [
          ...(!currentSuccess ? ['current' as const] : []),
          ...(!referenceSuccess ? ['reference' as const] : []),
        ];

        // Schema alignment: check which steps are comparable
        const currentStepIds = new Set((currentResult.displayResults || []).map(r => r.stepId));
        const refStepIds = new Set((refResult.displayResults || []).map(r => r.stepId));
        const comparableSteps = [...currentStepIds].filter(id => refStepIds.has(id));
        const incompatibleSteps = [
          ...[...currentStepIds]
            .filter(id => !refStepIds.has(id))
            .map(id => `${id} ${localize(outputLanguage, '(仅基线 Trace)', '(baseline trace only)')}`),
          ...[...refStepIds]
            .filter(id => !currentStepIds.has(id))
            .map(id => `${id} ${localize(outputLanguage, '(仅对比 Trace)', '(comparison trace only)')}`),
        ];

        // Emit data envelopes for both sides (labeled)
        if (emitUpdate && localizedCurrentDisplayResults.length) {
          emitSkillDataEnvelopes(
            localizedCurrentDisplayResults as SkillDisplayResult[],
            skillId,
            emitUpdate,
            currentTraceProvenance,
            {
              ...baseProducer,
              sourceToolCallId: `${baseProducer.sourceToolCallId}:current`,
              producerReason: localize(
                outputLanguage,
                `${traceLocationDisplayLabel('current')}对比 Skill ${skillId} 结果。`,
                `${traceLocationDisplayLabel('current')} result for comparison Skill ${skillId}.`,
              ),
            },
            currentResult.identityResolution,
            undefined,
            undefined,
            currentResult.displayResults as SkillDisplayResult[],
            outputLanguage,
            artifactStore,
          );
        }
        if (emitUpdate && localizedReferenceDisplayResults.length) {
          emitSkillDataEnvelopes(
            localizedReferenceDisplayResults as SkillDisplayResult[],
            skillId,
            emitUpdate,
            referenceTraceProvenance,
            {
              ...baseProducer,
              sourceToolCallId: `${baseProducer.sourceToolCallId}:reference`,
              producerReason: localize(
                outputLanguage,
                `${traceLocationDisplayLabel('reference')}对比 Skill ${skillId} 结果。`,
                `${traceLocationDisplayLabel('reference')} result for comparison Skill ${skillId}.`,
              ),
            },
            refResult.identityResolution,
            undefined,
            undefined,
            refResult.displayResults as SkillDisplayResult[],
            outputLanguage,
            artifactStore,
          );
        }

        // Build compact comparison summary for Claude
        const buildStepSummary = (results: any[]) =>
          results.map(r => ({
            stepId: r.stepId,
            title: r.title,
            rowCount: r.data?.rows?.length || 0,
            columns: r.data?.columns || [],
            ...scopeMetadata(r.scopeProvenance),
            executionStatus: r.executionStatus,
            executionMessage: r.executionMessage,
          }));

        const text = {
          success,
          ...(!success ? {
            partial: currentSuccess !== referenceSuccess,
            failedSides,
            error: localize(
              outputLanguage,
              `双 Trace 对比未完成：${failedSides.map(side => side === 'current' ? '当前侧' : '参考侧').join('、')}执行失败。`,
              `Dual-trace comparison did not complete: ${failedSides.join(' and ')} side execution failed.`,
            ),
            action_required: 'retry_compare_skill_with_valid_side_params',
          } : {}),
          durationMs: compareDuration,
          parameterMapping: {
            referenceIdentityRemapped: referenceSharedParams.identityRemapped,
            currentOverrideKeys: Object.keys(currentSideParams ?? {}),
            referenceOverrideKeys: Object.keys(referenceSideParams ?? {}),
          },
          current: {
            traceSide: 'current',
            paneSide: currentTraceProvenance.paneSide,
            traceId,
            traceProvenance: currentTraceProvenance,
            effectiveParams,
            drillDownResolution: currentParamResolution.value.audit,
            success: currentResult.success,
            stepCount: localizedCurrentDisplayResults.length,
            steps: buildStepSummary(localizedCurrentDisplayResults),
            diagnosticCount: currentResult.diagnostics?.length || 0,
            identityResolution: currentResult.identityResolution,
            scopeProvenance: currentResult.scopeProvenance,
            scopeLimitations: currentResult.scopeLimitations,
            partial: currentResult.partial,
            error: currentResult.error,
          },
          reference: {
            traceSide: 'reference',
            paneSide: referenceTraceProvenance.paneSide,
            traceId: referenceTraceId,
            traceProvenance: referenceTraceProvenance,
            effectiveParams: refParams,
            drillDownResolution: referenceParamResolution.value.audit,
            success: refResult.success,
            stepCount: localizedReferenceDisplayResults.length,
            steps: buildStepSummary(localizedReferenceDisplayResults),
            diagnosticCount: refResult.diagnostics?.length || 0,
            identityResolution: refResult.identityResolution,
            scopeProvenance: refResult.scopeProvenance,
            scopeLimitations: refResult.scopeLimitations,
            partial: refResult.partial,
            error: refResult.error,
          },
          alignment: {
            comparableSteps,
            incompatibleSteps: incompatibleSteps.length > 0 ? incompatibleSteps : undefined,
          },
          hint: success
            ? localize(
                outputLanguage,
                '使用 execute_sql_on 深钻具体差异指标，或使用 fetch_artifact 获取详细数据。',
                'Use execute_sql_on to drill into specific delta metrics, or fetch_artifact for detailed data.',
              )
            : localize(
                outputLanguage,
                '修正失败侧的参数后重试 compare_skill；如果两侧分析窗口不同，请同时提供 currentParams 和 referenceParams。',
                'Fix the failed-side parameters and retry compare_skill; provide both currentParams and referenceParams when the analysis windows differ.',
              ),
        };

        return createRuntimeToolResult(text, {
          decorate: text => consumeWatchdogWarning(text + getReasoningNudge()),
          isError: !success,
        });
      } catch (e: any) {
        rethrowIfTraceProcessorQueryCancelled(e);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              partial: false,
              failedSides: ['current', 'reference'],
              error: e.message,
              action_required: 'retry_compare_skill_after_runtime_error',
            }),
          }],
          isError: true,
        };
      }
    },
  ) : null;

  const getComparisonContext = (referenceTraceId && comparisonContext) ? tool(
    'get_comparison_context',
    'Get metadata comparison between the current trace and the reference trace. ' +
    'Returns device info, focus app, architecture, capability alignment, and any UI pane mapping for both traces.\n\n' +
    'ALWAYS call this first in comparison mode to understand what you are comparing ' +
    'and confirm the traces are comparable (same app, compatible capabilities).',
    {},
    async () => {
      const ctx = comparisonContext!;
      const currentPane = ctx.tracePairContext?.panes.find(pane => pane.traceSide === 'current');
      const referencePane = ctx.tracePairContext?.panes.find(pane => pane.traceSide === 'reference');
      const text = JSON.stringify({
        success: true,
        current: {
          traceId,
          paneSide: currentPane?.side,
          visualState: currentPane?.visualState,
          traceName: currentPane?.traceName,
          packageName: packageName || 'unknown',
          architecture: options.cachedArchitecture?.type || 'unknown',
          focusApps: options.cachedArchitecture ? undefined : 'detect with detect_architecture',
        },
        reference: {
          traceId: referenceTraceId,
          paneSide: referencePane?.side,
          visualState: referencePane?.visualState,
          traceName: referencePane?.traceName,
          packageName: ctx.referencePackageName || 'unknown',
          architecture: ctx.referenceArchitecture?.type || 'unknown',
        },
        tracePairContext: ctx.tracePairContext,
        packageAlignment: packageName && ctx.referencePackageName
          ? (packageName === ctx.referencePackageName ? 'same' : 'different')
          : 'unknown',
        commonCapabilities: ctx.commonCapabilities,
        capabilityDiff: ctx.capabilityDiff,
      });
      return { content: [{ type: 'text' as const, text }] };
    },
    { annotations: { readOnlyHint: true } },
  ) : null;

  // Plan 41 M0 (P2-G1 evolution): the canonical tool list lives in
  // `McpToolRegistry`. Each register call carries the §4.5 exposure
  // level so future hosts (stdio, A2A) can filter without
  // re-deciding policy. Registration order is preserved exactly to
  // keep SDK behavior identical to the pre-refactor toolEntries
  // array — trace regression validates that.
  const readSessionHistory = options.analysisHistoryReader ? tool(
    'read_session_history',
    renderRequiredLocalizedStrategyTemplate('prompt-runtime-history-tool', outputLanguage, {}),
    {
      turnId: z.string().max(200).optional(),
      offset: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(50).optional(),
      textOffset: z.number().int().min(0).optional(),
      maxChars: z.number().int().min(1).max(12000).optional(),
    },
    async request => {
      try { return createRuntimeToolResult(options.analysisHistoryReader!.read(request)); }
      catch { return createRuntimeToolResult({success: false, action_required: 'use_available_history',
        unsupportedReason: 'analysis_history_unavailable'}, {isError: true}); }
    },
    {annotations: {readOnlyHint: true}},
  ) : null;
  const sceneContext = options.sceneRunContext;
  if (sceneContext) assertSceneRuntimeCapability(sceneContext, options);
  const registry = new McpToolRegistry({
    runManifestAttributionSink,
    toolObserver: options.toolObserver,
    acquisitionObserver: event => { artifactStore?.observeInvestigationTool?.(event); },
    requestScope: toolRequestScope,
    canInvokeTool: options.canInvokeTool,
    // A scene run must commit its timeline before its acquisition budget runs out.
    ...(sceneContext ? {acquisitionPolicy: createSceneAcquisitionPolicy(sceneContext)} : {}),
  });
  const sourceOnlyPhase = sourceUsePolicy?.phase === 'automatic_enrichment' ||
    sourceUsePolicy?.phase === 'deep_enrichment';

  if (sceneContext) {
    const context = sceneContext;
    const description = requireToolDescription('scene-tool-guidance');
    registry.registerShared({
      name: 'propose_scene_timeline', description, exposure: 'internal',
      inputSchema: sceneTimelineProposalToolShape, evidenceEffect: 'read_existing',
      handler: async (input, extra) => {
        extra.signal?.throwIfAborted();
        assertSceneRuntimeCapability(context, options);
        // Plan attribution never reaches the strict proposal contract.
        const {toolInput: proposalInput} = splitPlanAttribution(input);
        const phase = activePlanPhaseForEvidence('propose_scene_timeline', input).phase;
        const previousRevision = sceneRunState(context).revision;
        const result = await proposeSceneTimeline(context, proposalInput);
        extra.signal?.throwIfAborted();
        const candidate = result.accepted && result.revision === sceneRunState(context).revision
          ? projectSceneRunCandidate(context) : undefined;
        if (result.accepted && result.revision > previousRevision) {
          emitUpdate?.({type: 'scene_timeline_updated', content: candidate, timestamp: Date.now()});
        }
        const changedIds = result.segments?.filter(item => item.issuedRevision === result.revision)
          .map(item => item.segment.id) ?? [];
        const removedIds = result.removedSegmentIds ?? [];
        // Diagnostic details are already bounded by the proposal contract; only counts are cut here.
        const diagnostics = result.diagnostics.slice(0, 24);
        const rejectedGroups = (result.rejectedGroups ?? []).slice(0, 16).map(group => ({
          segmentIds: group.segmentIds.slice(0, 16), segmentIndices: group.segmentIndices.slice(0, 16),
          removedSegmentIds: group.removedSegmentIds.slice(0, 16), diagnostics: group.diagnostics.slice(0, 8)}));
        const actionRequired = sceneProposalActionRequired(result);
        // success/planPhaseId are the same receipt facts evidence tools emit, so an accepted revision
        // can satisfy a plan phase; an actionable rejection is a policy refusal, a read failure is not.
        return createRuntimeToolResult({success: result.accepted, accepted: result.accepted, revision: result.revision,
          ...(phase ? {planPhaseId: phase.id} : {}), ...(actionRequired ? {action_required: actionRequired} : {}),
          changedSegmentIds: changedIds.slice(0, 32), omittedChangedSegmentCount: Math.max(0, changedIds.length - 32),
          removedSegmentIds: removedIds.slice(0, 32), omittedRemovedSegmentCount: Math.max(0, removedIds.length - 32),
          ...(rejectedGroups.length ? {rejectedGroups,
            omittedRejectedGroupCount: (result.rejectedGroups?.length ?? 0) - rejectedGroups.length} : {}),
          diagnostics, omittedDiagnosticCount: result.diagnostics.length - diagnostics.length,
          ...(candidate ? {coverage: {
            status: candidate.coverage.status, captureStatus: candidate.coverage.captureStatus,
            reason: candidate.coverage.reason,
            targets: (candidate.coverage.targets ?? []).slice(0, 16).map(target => ({
              id: target.id, capabilityStatus: target.capabilityStatus, scanStatus: target.scanStatus,
              unscannedWindowCount: target.unscannedWindows.length,
              issues: target.issues.slice(0, 3), omittedIssueCount: Math.max(0, target.issues.length - 3),
            })),
            omittedTargetCount: Math.max(0, (candidate.coverage.targets?.length ?? 0) - 16),
          }} : {}),
        }, {isError: !result.accepted});
      },
    });
  }

  if (sourceOnlyPhase) {
    registry.registerSdk(listCodebases, 'list_codebases', 'requires_codebase_permission', {evidenceEffect: 'none'});
    registry.registerSdk(searchCodebase, 'search_codebase', 'requires_codebase_permission', {evidenceEffect: 'acquire'});
    registry.registerSdk(readCodebaseFile, 'read_codebase_file', 'requires_codebase_permission', {evidenceEffect: 'acquire'});
  } else {
    // Budget mode does not change the authorized capability set.
    if (options.conversationTraceAttached !== false) {
      registry.registerSdk(executeSql, 'execute_sql', 'public', {evidenceEffect: 'acquire'});
      registry.registerSdk(invokeSkill, 'invoke_skill', 'public', {evidenceEffect: 'acquire'});
      registry.registerSdk(detectArchitecture, 'detect_architecture', 'public', {evidenceEffect: 'acquire'});
      registry.registerSdk(analyzeWaitChain, 'analyze_wait_chain', 'public', {evidenceEffect: 'acquire'});
    }
    registry.registerSdk(listSkills, 'list_skills', 'public', {evidenceEffect: 'none'});
    registry.registerSdk(lookupSqlSchema, 'lookup_sql_schema', 'public', {
      evidenceEffect: 'none',
      concurrency: {mode: 'commutative_read'},
    });
    registry.registerSdk(listStdlibModules, 'list_stdlib_modules', 'public', {
      evidenceEffect: 'none',
      concurrency: {mode: 'commutative_read'},
    });
    registry.registerSdk(lookupKnowledge, 'lookup_knowledge', 'public', {evidenceEffect: 'none'});
    registry.registerSdk(lookupBlogKnowledge, 'lookup_blog_knowledge', 'public', {evidenceEffect: 'acquire'});
    registry.registerSdk(listCodebases, 'list_codebases', 'requires_codebase_permission', {evidenceEffect: 'none'});
    registry.registerSdk(searchCodebase, 'search_codebase', 'requires_codebase_permission', {evidenceEffect: 'acquire'});
    registry.registerSdk(readCodebaseFile, 'read_codebase_file', 'requires_codebase_permission', {evidenceEffect: 'acquire'});
    if (!sourceUsePolicy) {
      registry.registerSdk(queryPerfettoSource, 'query_perfetto_source', 'public', {evidenceEffect: 'acquire'});
      registry.registerSdk(lookupAospSource, 'lookup_aosp_source', 'public', {evidenceEffect: 'acquire'});
      registry.registerSdk(lookupOemSdk, 'lookup_oem_sdk', 'public', {evidenceEffect: 'acquire'});
      registry.registerSdk(queryCodeGraph, 'query_code_graph', 'requires_codebase_permission', {evidenceEffect: 'acquire'});
      registry.registerSdk(inspectCodeSymbol, 'inspect_code_symbol', 'requires_codebase_permission', {evidenceEffect: 'acquire'});
      registry.registerSdk(lookupAppSource, 'lookup_app_source', 'requires_codebase_permission', {evidenceEffect: 'acquire'});
      registry.registerSdk(lookupKernelSource, 'lookup_kernel_source', 'requires_codebase_permission', {evidenceEffect: 'acquire'});
      registry.registerSdk(resolveSymbol, 'resolve_symbol', 'requires_codebase_permission', {evidenceEffect: 'acquire'});
      registry.registerSdk(proposePatch, 'propose_patch', 'requires_codebase_permission', {evidenceEffect: 'acquire'});
    }
    registry.registerSdk(lookupBaseline, 'lookup_baseline', 'public', {evidenceEffect: 'read_existing'});
    registry.registerSdk(compareBaselines, 'compare_baselines', 'public', {evidenceEffect: 'read_existing'});
    registry.registerSdk(recallProjectMemory, 'recall_project_memory', 'public', {evidenceEffect: 'read_existing'});
    registry.registerSdk(recallSimilarCase, 'recall_similar_case', 'public', {evidenceEffect: 'acquire'});
    registry.registerSdk(recallSimilarResult, 'recall_similar_result', 'public', {evidenceEffect: 'acquire'});
    if (writeAnalysisNote) registry.registerSdk(writeAnalysisNote, 'write_analysis_note', 'internal', {evidenceEffect: 'none'});
    if (fetchArtifact) registry.registerSdk(fetchArtifact, 'fetch_artifact', 'public', {evidenceEffect: 'read_existing'});
    if (readSessionHistory) registry.registerSdk(readSessionHistory, 'read_session_history', 'public', {evidenceEffect: 'read_existing'});
    if (submitPlan) registry.registerSdk(submitPlan, 'submit_plan', 'internal', {evidenceEffect: 'none'});
    if (updatePlanPhase) registry.registerSdk(updatePlanPhase, 'update_plan_phase', 'internal', {evidenceEffect: 'none'});
    if (revisePlan) registry.registerSdk(revisePlan, 'revise_plan', 'internal', {evidenceEffect: 'none'});
    registry.registerSdk(lookupStrategyDetail, 'lookup_strategy_detail', 'internal', {evidenceEffect: 'none'});
    if (submitHypothesis) registry.registerSdk(submitHypothesis, 'submit_hypothesis', 'internal', {evidenceEffect: 'none'});
    if (resolveHypothesis) registry.registerSdk(resolveHypothesis, 'resolve_hypothesis', 'internal', {evidenceEffect: 'none'});
    if (flagUncertainty) registry.registerSdk(flagUncertainty, 'flag_uncertainty', 'internal', {evidenceEffect: 'none'});
    // recall_patterns stays 'internal' for one more commit. Plan 41 M1b
    // routes the recall path through openSupersedeStoreReadOnly so it no
    // longer mkdir's or migrates the supersede DB on first call. The
    // public-readonly exposure flip is gated on the M1b invariant test
    // soaking for one release cycle to catch any hidden writable code
    // path; that flip is the M1b commit 2 follow-up.
    registry.registerSdk(recallPatterns, 'recall_patterns', 'internal', {evidenceEffect: 'read_existing'});
    // Comparison mode tools — only when referenceTraceId is provided.
    if (options.conversationTraceAttached !== false && compareSkill) registry.registerSdk(compareSkill, 'compare_skill', 'internal', {evidenceEffect: 'acquire'});
    if (options.conversationTraceAttached !== false && executeSqlOn) registry.registerSdk(executeSqlOn, 'execute_sql_on', 'internal', {evidenceEffect: 'acquire'});
    if (getComparisonContext) registry.registerSdk(getComparisonContext, 'get_comparison_context', 'internal', {evidenceEffect: 'read_existing'});
  }

  if (!sourceUsePolicy) {
    registry.registerSdk(
      recordSourceUseDecision,
      'record_source_use_decision',
      'requires_codebase_permission',
      {evidenceEffect: 'none'},
    );
  }

  const allowedTools = registry.buildAllowedTools(toolRequestScope);
  const toolDefinitions = registry.listForRequest(toolRequestScope);
  runManifestAttributionSink?.recordToolAllowlist(
    toolDefinitions.map(definition => definition.name),
  );
  return {
    server: registry.buildSdkServer({scope: toolRequestScope}),
    allowedTools,
    toolDefinitions,
    sourceUse,
  };
}

function evidenceHash(input: unknown): string {
  const text = typeof input === 'string'
    ? input
    : JSON.stringify(input, (_key, value) => typeof value === 'bigint' ? value.toString() : value);
  return createHash('sha256').update(text || '').digest('hex').slice(0, 12);
}

const SQL_RAW_INLINE_ROW_LIMIT = 50;
const SQL_ARTIFACT_PAGE_SIZE = 50;

function evidencePart(value: unknown, fallback = 'unknown'): string {
  const text = String(value ?? fallback)
    .trim()
    .replace(/[^a-zA-Z0-9_.-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
  return text || fallback;
}

function evidenceTracePart(traceProvenance?: TraceProcessorQueryProvenance): string {
  if (!traceProvenance) return 'trace_unknown';
  const side = evidencePart(traceProvenance.traceSide || 'current', 'current');
  const trace = evidenceHash(traceProvenance.traceId);
  return `${side}:${trace}`;
}

interface EvidenceProducerContext {
  sourceToolCallId?: string;
  paramsHash?: string;
  planPhaseId?: string;
  planPhaseTitle?: string;
  planPhaseGoal?: string;
  planPhaseAttribution?: 'active' | 'inferred' | 'missing' | 'ambiguous' | 'unexpected_tool' | 'none';
  planPhaseWarning?: string;
  toolNarration?: string;
  producerReason?: string;
}

function storeSqlResultArtifact(
  artifactStore: ArtifactStore | undefined,
  input: {
    toolName: 'execute_sql' | 'execute_sql_on';
    executionWitness?: EvidenceTableWitness;
    columns: string[];
    rows: any[][];
    sql: string;
    stdlibInjectedModules?: string[];
    traceProvenance: TraceProcessorQueryProvenance;
    producer: EvidenceProducerContext;
  },
): { artifactId: string; artifactSummary?: ReturnType<ArtifactStore['generateCompactSummary']> } | undefined {
  if (!artifactStore) return undefined;
  const artifactId = artifactStore.store({
    skillId: input.toolName,
    stepId: 'sql_result',
    layer: 'list',
    title: `SQL Query Result (${input.rows.length} rows)`,
    data: {
      columns: input.columns,
      rows: input.rows,
      sql: input.sql,
      stdlibInjectedModules: input.stdlibInjectedModules ?? [],
    },
    planPhaseId: input.producer.planPhaseId,
    planPhaseTitle: input.producer.planPhaseTitle,
    planPhaseGoal: input.producer.planPhaseGoal,
    sourceToolCallId: input.producer.sourceToolCallId,
    paramsHash: input.producer.paramsHash,
    traceProvenance: input.traceProvenance,
  });
  if (input.executionWitness) artifactStore.registerEvidenceCapture?.(artifactId, input.executionWitness,
    stableSqlEvidenceRefId(input.sql, input.columns, input.rows, input.traceProvenance, input.producer));
  return {
    artifactId,
    artifactSummary: artifactStore.generateCompactSummary(artifactId),
  };
}

/**
 * Retain a tool-produced table the same way a SQL result is retained, minus the
 * SQL: a tool that composes several queries has no single statement to record.
 * The witness carries only the field semantics the tool declares as the native
 * producer of that value; a claim citing any other field stays `not_checked`,
 * and every row stays fetchable for review.
 */
function storeToolTableArtifact(
  artifactStore: ArtifactStore | undefined,
  input: {
    toolName: string;
    stepId: string;
    title: string;
    layer?: string;
    columns: string[];
    rows: unknown[][];
    executionWitness?: EvidenceTableWitness;
    traceProvenance?: TraceProcessorQueryProvenance;
    producer: EvidenceProducerContext;
  },
): { artifactId: string; evidenceRefId: string; artifactSummary?: CompactArtifactSummary } | undefined {
  if (!artifactStore) return undefined;
  const evidenceRefId = [
    'data:tool',
    evidencePart(input.toolName, 'tool'),
    evidencePart(input.stepId, 'step'),
    evidenceTracePart(input.traceProvenance),
    evidenceHash({columns: input.columns, sampleRows: input.rows.slice(0, 5), rowCount: input.rows.length}),
    evidencePart(input.producer.paramsHash || 'tool', 'tool'),
  ].join(':');
  const artifactId = artifactStore.store({
    skillId: input.toolName,
    stepId: input.stepId,
    layer: input.layer ?? 'deep',
    title: input.title,
    data: {columns: input.columns, rows: input.rows},
    planPhaseId: input.producer.planPhaseId,
    planPhaseTitle: input.producer.planPhaseTitle,
    planPhaseGoal: input.producer.planPhaseGoal,
    sourceToolCallId: input.producer.sourceToolCallId,
    paramsHash: input.producer.paramsHash,
    traceProvenance: input.traceProvenance,
  });
  if (input.executionWitness) {
    artifactStore.registerEvidenceCapture?.(artifactId, input.executionWitness, {evidenceRefId});
  }
  return {artifactId, evidenceRefId, artifactSummary: artifactStore.generateCompactSummary(artifactId)};
}

/**
 * Trace timestamps exceed 2^53 on long captures, so a model may legitimately
 * send them as decimal strings. Same shape the critical-path route already
 * accepts; no `.strict()` anywhere, because the registry injects `planPhaseId`.
 */
const waitChainIntLike = z.union([
  z.number().int().nonnegative(),
  z.string().regex(/^\d+$/, 'must be a non-negative integer string'),
]);

/** Columns of the `analyze_wait_chain` segment table, in artifact and envelope order. */
const WAIT_CHAIN_SEGMENT_COLUMNS = [
  'segment_index', 'start_ts', 'dur_ns', 'duration_ms', 'state', 'blocked_function', 'io_wait',
  'utid', 'process_name', 'thread_name', 'waker_kind', 'waker_thread', 'wake_source_class', 'modules',
] as const;

/**
 * The one-row summary the tool's headline numbers are read from. `*_ns` cells
 * are the engine's exact integers; `*_ms`, the share and the count are the
 * rounded display values and carry no semantics, so citing them never proves
 * or contradicts a claim.
 */
const WAIT_CHAIN_SUMMARY_COLUMNS = [
  'utid', 'window_start_ts', 'window_end_ts', 'window_dur_ns',
  'blocking_ns', 'self_ns', 'waiting_ns', 'chain_wait_ns', 'best_case_ns', 'max_saving_ns',
  'window_ms', 'blocking_ms', 'self_ms', 'waiting_ms', 'chain_wait_ms', 'external_blocking_pct',
  'best_case_ms', 'max_saving_ms', 'chain_segment_count',
] as const;
type WaitChainSummaryColumn = typeof WAIT_CHAIN_SUMMARY_COLUMNS[number];
type WaitChainSummaryRow = Record<WaitChainSummaryColumn, number | null>;

type DeclaredFieldSemantics = Omit<CapturedFieldSemantics, 'origin'>;

const NS_START: DeclaredFieldSemantics = {unit: 'ns', timeRole: 'start', clock: 'trace_monotonic'};
const NS_END: DeclaredFieldSemantics = {unit: 'ns', timeRole: 'end', clock: 'trace_monotonic'};
const NS_DURATION: DeclaredFieldSemantics = {unit: 'ns', timeRole: 'duration', clock: 'trace_monotonic'};
const NS_TOTAL: DeclaredFieldSemantics = {unit: 'ns'};
const UTID_IDENTITY: DeclaredFieldSemantics = {identityRole: 'utid'};

/**
 * Producer semantics for one table, fingerprinted by what defines them: the
 * engine version, the table's columns and the declarations themselves. A
 * change to any of them yields a new fingerprint.
 */
function nativeProducerFields(
  table: string,
  columns: readonly string[],
  declared: Record<string, DeclaredFieldSemantics>,
): Record<string, CapturedFieldSemantics> {
  const definitionFingerprint = evidenceCaptureHash({
    producer: 'analyze_wait_chain', table, engine: CRITICAL_PATH_ENGINE_VERSION, columns, fields: declared,
  });
  return Object.fromEntries(Object.entries(declared).map(([column, field]) =>
    [column, {...field, origin: {kind: 'native_producer' as const, definitionFingerprint}}]));
}

const WAIT_CHAIN_SEGMENT_FIELDS = nativeProducerFields('wait_segments', WAIT_CHAIN_SEGMENT_COLUMNS, {
  start_ts: NS_START, dur_ns: NS_DURATION, utid: UTID_IDENTITY,
});

const WAIT_CHAIN_SUMMARY_FIELDS = nativeProducerFields('wait_summary', WAIT_CHAIN_SUMMARY_COLUMNS, {
  utid: UTID_IDENTITY,
  window_start_ts: NS_START,
  window_end_ts: NS_END,
  window_dur_ns: NS_DURATION,
  blocking_ns: NS_TOTAL,
  self_ns: NS_TOTAL,
  waiting_ns: NS_TOTAL,
  chain_wait_ns: NS_TOTAL,
  best_case_ns: NS_TOTAL,
  max_saving_ns: NS_TOTAL,
});

const WAIT_CHAIN_SEGMENT_COLUMN_DEFS: ColumnDefinition[] = [
  {name: 'segment_index', type: 'number'},
  {name: 'start_ts', type: 'timestamp', unit: 'ns', format: 'timestamp_relative',
    clickAction: 'navigate_range', durationColumn: 'dur_ns'},
  {name: 'dur_ns', type: 'duration', unit: 'ns'},
  {name: 'duration_ms', type: 'duration', unit: 'ms'},
  {name: 'state', type: 'string'},
  {name: 'blocked_function', type: 'string'},
  {name: 'io_wait', type: 'boolean'},
  {name: 'utid', type: 'number'},
  {name: 'process_name', type: 'string'},
  {name: 'thread_name', type: 'string'},
  {name: 'waker_kind', type: 'string'},
  {name: 'waker_thread', type: 'string'},
  {name: 'wake_source_class', type: 'string'},
  {name: 'modules', type: 'string'},
];

/**
 * What the model has to change for each engine input error. `satisfies` makes
 * a code the engine adds without an action here a type error.
 */
const WAIT_CHAIN_INPUT_ERROR_ACTION = {
  invalid_thread_state_id: 'provide_valid_thread_state_id',
  thread_state_not_found: 'provide_existing_thread_state_id',
  missing_selector: 'provide_thread_state_id_or_thread_and_window',
  non_positive_duration: 'provide_window_with_positive_duration',
  invalid_integer: 'provide_integer_ids_and_timestamps',
  invalid_name: 'provide_printable_name_up_to_200_chars',
} satisfies Record<CriticalPathInputErrorCode, string>;

const WAIT_CHAIN_TOP_WAITS = 8;
const WAIT_CHAIN_MAX_ANOMALIES = 5;
const WAIT_CHAIN_MAX_WARNINGS = 8;
const WAIT_CHAIN_MAX_RECURSION = 6;
const WAIT_CHAIN_MAX_SEGMENT_ROWS = 400;

/** A sleeping or uninterruptible state, in the engine's own reading. */
function isWaitState(state: string | null | undefined): boolean {
  const kind = classifySlice(state);
  return kind === 'sleeping' || kind === 'uninterruptible';
}

function flattenWaitChain(segments: readonly CriticalPathSegment[]): CriticalPathSegment[] {
  const flat: CriticalPathSegment[] = [];
  const walk = (list: readonly CriticalPathSegment[]): void => {
    for (const segment of list) {
      flat.push(segment);
      if (segment.children?.length) walk(segment.children);
    }
  };
  walk(segments);
  return flat;
}

/** The longest wake source observed on a segment; the shortest ones are noise. */
function dominantWakeSource(segment: CriticalPathSegment) {
  return (segment.semantics?.wakeSources ?? [])
    .reduce<WakeSourceSummary | undefined>(
      (best, candidate) => (!best || candidate.durMs > best.durMs ? candidate : best),
      undefined,
    );
}


function waitChainSegmentRows(segments: readonly CriticalPathSegment[]): unknown[][] {
  return segments.slice(0, WAIT_CHAIN_MAX_SEGMENT_ROWS).map((segment, index) => {
    const waker = dominantWakeSource(segment);
    return [
      index,
      segment.startTs,
      segment.dur,
      segment.durationMs,
      segment.state ?? null,
      segment.blockedFunction ?? null,
      segment.ioWait ?? null,
      segment.utid,
      segment.processName ?? null,
      segment.threadName ?? null,
      waker?.wakeSource ?? null,
      waker?.wakerThreadName ?? null,
      segment.wakeSourceClass ?? null,
      segment.modules.join(', ') || null,
    ];
  });
}

/**
 * The summary row the headline numbers come from: exact ns from the engine
 * (`totalsNs`, the counterfactual, the target's own slices), and beside them
 * the rounded values the engine displays.
 */
function waitChainSummaryRow(analysis: CriticalPathAnalysis, flatSegments: number): WaitChainSummaryRow {
  const totals = analysis.totalsNs;
  const counterfactual = analysis.quantification?.counterfactual ?? null;
  return {
    utid: analysis.task.utid,
    window_start_ts: analysis.task.startTs,
    window_end_ts: analysis.task.startTs + analysis.task.dur,
    window_dur_ns: analysis.task.dur,
    blocking_ns: totals?.blocking ?? null,
    self_ns: totals ? Math.max(0, analysis.task.dur - totals.blocking) : null,
    waiting_ns: totals?.waiting ?? null,
    chain_wait_ns: totals?.chainWait ?? null,
    best_case_ns: counterfactual?.bestCaseDurationNs ?? null,
    max_saving_ns: counterfactual?.maxSavingNs ?? null,
    window_ms: analysis.totalMs,
    blocking_ms: analysis.blockingMs,
    self_ms: analysis.selfMs,
    waiting_ms: totals ? nsToMs(totals.waiting) : null,
    chain_wait_ms: analysis.chainWaitMs ?? 0,
    external_blocking_pct: analysis.externalBlockingPercentage,
    best_case_ms: counterfactual?.bestCaseDurationMs ?? null,
    max_saving_ms: counterfactual?.maxSavingMs ?? null,
    chain_segment_count: analysis.chainSegmentCount ?? flatSegments,
  };
}

/** Exact ns of the target thread's own window, per state kind (slices are clipped to the window). */
function sliceKindNs(analysis: CriticalPathAnalysis): Record<SliceKind, number> {
  const byKind: Record<SliceKind, number> = {sleeping: 0, uninterruptible: 0, runnable: 0, running: 0, unknown: 0};
  for (const slice of analysis.slices ?? []) {
    byKind[slice.kind] += Math.max(0, slice.endTs - slice.startTs);
  }
  return byKind;
}

interface WaitChainRecursionEntry {
  level: number;
  processName: string | null;
  threadName: string | null;
  durationMs: number;
  childSegments: number;
  dominantWaitClass: string | null;
  dominantWaitMs: number | null;
}

/**
 * One line per segment the engine recursed into, at every level, level by
 * level so the cap drops the deepest lines first; `omitted` counts the rest.
 */
function waitChainRecursion(chain: readonly CriticalPathSegment[]): {entries: WaitChainRecursionEntry[]; omitted: number} {
  const entries: WaitChainRecursionEntry[] = [];
  let omitted = 0;
  let level = 1;
  let current = chain.filter(segment => segment.children?.length);
  while (current.length > 0) {
    const next: CriticalPathSegment[] = [];
    for (const segment of current) {
      const children = segment.children ?? [];
      next.push(...children.filter(child => child.children?.length));
      if (entries.length >= WAIT_CHAIN_MAX_RECURSION) {
        omitted += 1;
        continue;
      }
      const dominant = Object.entries(chainWaitTotals(children).waitClassTotalsMs)
        .sort((a, b) => b[1] - a[1])[0];
      entries.push({
        level,
        processName: segment.processName ?? null,
        threadName: segment.threadName ?? null,
        durationMs: segment.durationMs,
        childSegments: children.length,
        dominantWaitClass: dominant?.[0] ?? null,
        dominantWaitMs: dominant?.[1] ?? null,
      });
    }
    current = next;
    level += 1;
  }
  return {entries, omitted};
}

/**
 * Bound the engine's full analysis into something a model can read inside the
 * 2000-char transport cap. The complete segment table stays in the artifact and
 * the DataEnvelope; this keeps the shape of the wait, not every row of it.
 * Headline numbers are read from `summary`, the captured row, verbatim.
 */
function projectWaitChainForModel(
  analysis: CriticalPathAnalysis,
  summary: WaitChainSummaryRow,
  flat: readonly CriticalPathSegment[],
  outputLanguage: OutputLanguage,
  identity?: Pick<ResolvedCriticalPathThread, 'pid' | 'processName' | 'threadName' | 'tid'>,
): Record<string, unknown> {
  const windowNs = analysis.task.dur;
  const stateBreakdown: Record<string, {ms: number; percent: number}> = {};
  for (const [kind, ns] of Object.entries(sliceKindNs(analysis))) {
    if (ns <= 0) continue;
    stateBreakdown[kind] = {ms: nsToMs(ns), percent: pct(ns, windowNs)};
  }

  const waits = flat.filter(segment => isWaitState(segment.state));

  // Wait totals come from the engine over the whole chain. `wakeupChain`, and
  // so `waits`, holds only the displayed prefix, which still serves `topWaits`.
  const waitClassSummary: Record<string, number> = analysis.waitClassTotalsMs ?? {};

  const topWaits = [...waits]
    .sort((a, b) => b.durationMs - a.durationMs || a.startTs - b.startTs)
    .slice(0, WAIT_CHAIN_TOP_WAITS)
    .map(segment => {
      const waker = dominantWakeSource(segment);
      return {
        startTs: segment.startTs,
        durationMs: segment.durationMs,
        state: segment.state ?? null,
        kind: classifySlice(segment.state),
        blockedFunction: segment.blockedFunction ?? null,
        ioWait: segment.ioWait ?? null,
        processName: segment.processName ?? null,
        threadName: segment.threadName ?? null,
        wakeSourceClass: segment.wakeSourceClass ?? null,
        ...(waker ? {
          waker: {
            kind: waker.wakeSource,
            threadName: waker.wakerThreadName,
            processName: waker.wakerProcessName,
            irqContext: waker.irqContext,
          },
        } : {}),
        modules: segment.modules.slice(0, 4),
        reasons: segment.reasons.slice(0, 3),
      };
    });

  const recursion = waitChainRecursion(analysis.wakeupChain);

  return {
    available: analysis.available,
    // The engine's own reason, never re-derived here: a range with no
    // waiting time is not a Running selection.
    ...(analysis.available ? {} : {unavailableReason: analysis.unavailableReason ?? null}),
    task: {
      processName: analysis.task.processName ?? identity?.processName ?? null,
      // The engine resolves upid, not pid; pid is only known when the caller
      // reached this thread through the name resolver.
      pid: identity?.pid ?? null,
      upid: analysis.task.upid ?? null,
      threadName: analysis.task.threadName ?? identity?.threadName ?? null,
      tid: analysis.task.tid ?? identity?.tid ?? null,
      utid: summary.utid,
      windowStartTs: summary.window_start_ts,
      windowEndTs: summary.window_end_ts,
      windowMs: summary.window_ms,
    },
    totalMs: summary.window_ms,
    blockingMs: summary.blocking_ms,
    selfMs: summary.self_ms,
    externalBlockingPercentage: summary.external_blocking_pct,
    // The target thread's own S/D time, not the chain's: the chain also holds
    // the waker tasks' waits, which belong to other threads.
    waitingMs: summary.waiting_ms,
    chainWaitMs: summary.chain_wait_ms,
    // The exact values behind the ms figures, as captured in the summary row.
    exactNs: {
      window: summary.window_dur_ns,
      blocking: summary.blocking_ns,
      self: summary.self_ns,
      waiting: summary.waiting_ns,
      chainWait: summary.chain_wait_ns,
      bestCase: summary.best_case_ns,
      maxSaving: summary.max_saving_ns,
    },
    stateBreakdown,
    waitClassSummary,
    topWaits,
    ...(analysis.directWaker ? {
      directWaker: {
        kind: analysis.directWaker.kind,
        threadName: analysis.directWaker.threadName,
        processName: analysis.directWaker.processName,
        state: analysis.directWaker.state,
        irqContext: analysis.directWaker.irqContext,
      },
    } : {}),
    recursion: recursion.entries,
    ...(recursion.omitted > 0 ? {recursionOmitted: recursion.omitted} : {}),
    anomalies: analysis.anomalies.slice(0, WAIT_CHAIN_MAX_ANOMALIES).map(anomaly => ({
      severity: anomaly.severity,
      title: anomaly.title,
      detail: anomaly.detail,
    })),
    // Best case after removing the longest external segment, and the most that
    // removal can save; another wait may become the bottleneck first.
    counterfactualBestCaseMs: summary.best_case_ms,
    counterfactualMaxSavingMs: summary.max_saving_ms,
    segmentCount: summary.chain_segment_count,
    truncated: analysis.truncated,
    warnings: analysis.warnings.slice(0, WAIT_CHAIN_MAX_WARNINGS),
    deterministicSummary: buildDeterministicCriticalPathSummary(analysis, outputLanguage),
  };
}

function updateSqlArtifactQueryReview(
  artifactStore: ArtifactStore | undefined,
  sqlArtifact: { artifactId: string; artifactSummary?: CompactArtifactSummary | undefined } | undefined,
  queryReview: QueryReviewV1 | undefined,
): void {
  if (!artifactStore || !sqlArtifact || !queryReview) return;
  artifactStore.updateQueryReview(sqlArtifact.artifactId, queryReview);
  sqlArtifact.artifactSummary = artifactStore.generateCompactSummary(sqlArtifact.artifactId);
}

function stableSqlEvidenceRefId(
  sql: string | undefined,
  columns: string[],
  rows: any[],
  traceProvenance?: TraceProcessorQueryProvenance,
  producer?: EvidenceProducerContext,
  mode: 'table' | 'summary' | 'diagnostic' = 'table',
): { evidenceRefId: string; queryHash: string } {
  const queryHash = evidenceHash(sql || { columns, sampleRows: rows.slice(0, 5), rowCount: rows.length });
  const toolPart = evidencePart(producer?.paramsHash || 'tool', 'tool');
  return {
    evidenceRefId: `data:sql_${mode}:${evidenceTracePart(traceProvenance)}:${queryHash}:${toolPart}`,
    queryHash,
  };
}

function stableSkillEvidenceRefId(
  skillId: string,
  stepId: string | undefined,
  title: string | undefined,
  data: unknown,
  traceProvenance?: TraceProcessorQueryProvenance,
  producer?: EvidenceProducerContext,
  scopeProvenance?: EvidenceScopeProvenanceV1,
): string {
  const dataHash = evidenceHash({
    title,
    data,
    scopeProvenance,
  });
  const toolPart = evidencePart(producer?.paramsHash || 'tool', 'tool');
  return `data:skill:${evidencePart(skillId, 'skill')}:${evidencePart(stepId || title, 'step')}:${evidenceTracePart(traceProvenance)}:${dataHash}:${toolPart}`;
}

function sqlSummaryMarkdown(summary: SqlSummary): string {
  const stats = Array.isArray(summary.columnStats) ? summary.columnStats : [];
  const lines = [
    `Total rows: ${summary.totalRows}`,
    '',
    '| Column | Type | Min | Avg | P95 | Max | Nulls |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const stat of stats.slice(0, 20)) {
    lines.push([
      stat.column,
      stat.type,
      stat.min ?? '',
      stat.avg ?? '',
      stat.p95 ?? '',
      stat.max ?? '',
      stat.nullCount,
    ].join(' | '));
  }
  return lines.join('\n');
}

function sqlSummaryMetrics(summary: SqlSummary): Array<{
  label: string;
  value: string | number;
  severity?: 'info' | 'warning' | 'critical';
}> {
  const metrics: Array<{ label: string; value: string | number; severity?: 'info' | 'warning' | 'critical' }> = [
    { label: 'total_rows', value: summary.totalRows, severity: 'info' },
  ];
  const stats = Array.isArray(summary.columnStats) ? summary.columnStats : [];
  for (const stat of stats.slice(0, 8)) {
    if (stat.type !== 'numeric') continue;
    if (stat.avg !== undefined) metrics.push({ label: `${stat.column}.avg`, value: stat.avg, severity: 'info' });
    if (stat.p95 !== undefined) metrics.push({ label: `${stat.column}.p95`, value: stat.p95, severity: 'info' });
  }
  return metrics;
}

function producerEnvelopeOptions(producer?: EvidenceProducerContext): Pick<
  Parameters<typeof createDataEnvelope>[1],
  'sourceToolCallId' | 'paramsHash' | 'planPhaseId' | 'planPhaseTitle' | 'planPhaseGoal' | 'planPhaseAttribution' | 'planPhaseWarning' | 'toolNarration' | 'producerReason'
> {
  return {
    sourceToolCallId: producer?.sourceToolCallId,
    paramsHash: producer?.paramsHash,
    planPhaseId: producer?.planPhaseId,
    planPhaseTitle: producer?.planPhaseTitle,
    planPhaseGoal: producer?.planPhaseGoal,
    planPhaseAttribution: producer?.planPhaseAttribution,
    planPhaseWarning: producer?.planPhaseWarning,
    toolNarration: producer?.toolNarration,
    producerReason: producer?.producerReason,
  };
}

/** Emit a DataEnvelope for SQL query results. */
function emitSqlDataEnvelope(
  emit: (update: StreamingUpdate) => void,
  columns: string[],
  rows: any[],
  sql?: string,
  stdlibInjectedModules?: string[],
  traceProvenance?: TraceProcessorQueryProvenance,
  producer?: EvidenceProducerContext,
  processIdentityWarning?: string,
  artifactId?: string,
  options?: {
    captureStore?: ArtifactStore;
    executionWitness?: EvidenceTableWitness;
    durationMs?: number;
    truncated?: boolean;
    sqlRewrites?: string[];
    toolName?: 'execute_sql' | 'execute_sql_on';
    rowCount?: number;
    outputLanguage?: OutputLanguage;
  },
): { evidenceRefId: string; queryHash: string; queryReview?: QueryReviewV1 } {
  const { evidenceRefId, queryHash } = stableSqlEvidenceRefId(sql, columns, rows, traceProvenance, producer);
  const toolName = options?.toolName ?? 'execute_sql';
  const queryReview = buildSqlQueryReview({
    producerKind: toolName,
    executableSql: sql,
    outputColumns: columns.map((col: string) => ({ name: col, type: inferSqlColumnType(col) })),
    traceProvenance,
    producer,
    evidenceRefId,
    queryHash,
    artifactId,
    durationMs: options?.durationMs,
    rowCount: options?.rowCount ?? rows.length,
    truncated: options?.truncated,
    sqlRewrites: options?.sqlRewrites,
    stdlibInjectedModules,
    processIdentityWarning,
    outputLanguage: options?.outputLanguage ?? DEFAULT_OUTPUT_LANGUAGE,
  });
  const envelope = createDataEnvelope(
    { columns, rows },
    {
      type: 'sql_result',
      source: toolName,
      title: `SQL Query (${rows.length} rows)`,
      layer: 'list',
      format: 'table',
      columns: columns.map((col: string) => ({
        name: col,
        type: inferSqlColumnType(col),
      })),
      evidenceRefId,
      traceSide: traceProvenance?.traceSide,
      paneSide: traceProvenance?.paneSide,
      traceId: traceProvenance?.traceId,
      queryHash,
      queryReview,
      ...producerEnvelopeOptions(producer),
      artifactId,
      sourceArtifactId: artifactId,
      processIdentityWarning,
      intent: 'ad_hoc_sql_verification',
    },
  );

  if (options?.executionWitness && options.captureStore) {
    if (artifactId) options.captureStore.registerEvidenceCapture?.(artifactId, options.executionWitness, {evidenceRefId, queryHash});
    else options.captureStore.registerStandaloneEvidenceCapture?.(options.executionWitness, {meta: envelope.meta, display: envelope.display});
  }
  emit({
    type: 'data',
    content: [{
      ...envelope,
      ...(sql ? { sql } : {}),
      ...(stdlibInjectedModules?.length ? { stdlibInjectedModules } : {}),
      ...(traceProvenance ? {
        traceSide: traceProvenance.traceSide,
        paneSide: traceProvenance.paneSide,
        traceId: traceProvenance.traceId,
        traceProvenance,
      } : {}),
    }],
    timestamp: Date.now(),
  });
  return { evidenceRefId, queryHash, queryReview };
}

/** Emit a DataEnvelope for SQL summary-mode results. */
function emitSqlSummaryDataEnvelope(
  emit: (update: StreamingUpdate) => void,
  summary: SqlSummary,
  sql?: string,
  stdlibInjectedModules?: string[],
  traceProvenance?: TraceProcessorQueryProvenance,
  producer?: EvidenceProducerContext,
  processIdentityWarning?: string,
  artifactId?: string,
  options?: {
    captureStore?: ArtifactStore;
    executionWitness?: EvidenceTableWitness;
    durationMs?: number;
    truncated?: boolean;
    sqlRewrites?: string[];
    toolName?: 'execute_sql' | 'execute_sql_on';
    outputLanguage?: OutputLanguage;
  },
): { evidenceRefId: string; queryHash: string; queryReview?: QueryReviewV1 } {
  const { evidenceRefId, queryHash } = stableSqlEvidenceRefId(
    sql,
    summary.columns,
    summary.sampleRows,
    traceProvenance,
    producer,
    'summary',
  );
  const toolName = options?.toolName ?? 'execute_sql';
  const queryReview = buildSqlQueryReview({
    producerKind: toolName,
    executableSql: sql,
    outputColumns: summary.columns,
    traceProvenance,
    producer,
    evidenceRefId,
    queryHash,
    artifactId,
    durationMs: options?.durationMs,
    rowCount: summary.totalRows,
    truncated: options?.truncated,
    sqlRewrites: options?.sqlRewrites,
    stdlibInjectedModules,
    processIdentityWarning,
    title: `SQL Summary Review (${summary.totalRows} rows)`,
    outputLanguage: options?.outputLanguage ?? DEFAULT_OUTPUT_LANGUAGE,
  });
  const envelope = createDataEnvelope(
    {
      summary: {
        title: `SQL Summary (${summary.totalRows} rows)`,
        content: sqlSummaryMarkdown(summary),
        metrics: sqlSummaryMetrics(summary),
      },
    },
    {
      type: 'sql_result',
      source: toolName,
      title: `SQL Summary (${summary.totalRows} rows)`,
      layer: 'overview',
      format: 'summary',
      evidenceRefId,
      traceSide: traceProvenance?.traceSide,
      paneSide: traceProvenance?.paneSide,
      traceId: traceProvenance?.traceId,
      queryHash,
      queryReview,
      ...producerEnvelopeOptions(producer),
      artifactId,
      sourceArtifactId: artifactId,
      processIdentityWarning,
      intent: 'ad_hoc_sql_summary',
    },
  );

  if (options?.executionWitness && options.captureStore) {
    if (artifactId) options.captureStore.registerEvidenceCapture?.(artifactId, options.executionWitness, {evidenceRefId, queryHash});
    else options.captureStore.registerStandaloneEvidenceCapture?.(options.executionWitness, {meta: envelope.meta, display: envelope.display});
  }
  emit({
    type: 'data',
    content: [{
      ...envelope,
      ...(sql ? { sql } : {}),
      ...(stdlibInjectedModules?.length ? { stdlibInjectedModules } : {}),
      ...(traceProvenance ? {
        traceSide: traceProvenance.traceSide,
        paneSide: traceProvenance.paneSide,
        traceId: traceProvenance.traceId,
        traceProvenance,
      } : {}),
    }],
    timestamp: Date.now(),
  });
  return { evidenceRefId, queryHash, queryReview };
}

interface SqlFailureToolPayloadInput {
  error: string;
  trace?: string;
  traceSide?: TraceProcessorTraceSide;
  paneSide?: TraceProcessorPaneSide;
  traceId?: string;
  traceProvenance: TraceProcessorQueryProvenance;
  sourceToolCallId?: string;
  paramsHash?: string;
  planPhaseId?: string;
  executableSql?: string;
  sqlRewrites?: string[];
  stdlibInjectedModules?: string[];
  processIdentityWarning?: string;
  durationMs?: number;
  outputLanguage?: OutputLanguage;
}

function buildSqlFailureToolPayload(input: SqlFailureToolPayloadInput): Record<string, unknown> {
  const outputLanguage = input.outputLanguage ?? DEFAULT_OUTPUT_LANGUAGE;
  const queryReview = input.executableSql
    ? buildSqlQueryReview({
        producerKind: input.sourceToolCallId?.startsWith('execute_sql_on') ? 'execute_sql_on' : 'execute_sql',
        executableSql: input.executableSql,
        outputColumns: [],
        traceProvenance: input.traceProvenance,
        producer: {
          sourceToolCallId: input.sourceToolCallId,
          paramsHash: input.paramsHash,
          planPhaseId: input.planPhaseId,
        },
        durationMs: input.durationMs,
        rowCount: 0,
        truncated: false,
        sqlRewrites: input.sqlRewrites,
        stdlibInjectedModules: input.stdlibInjectedModules,
        processIdentityWarning: input.processIdentityWarning,
        title: 'Failed SQL review',
        purpose: `Review attempted SQL after execution failure: ${input.error}`,
      })
    : undefined;
  return {
    success: false,
    ...(input.trace ? { trace: input.trace } : {}),
    traceSide: input.traceSide,
    paneSide: input.paneSide ?? input.traceProvenance.paneSide,
    traceId: input.traceId,
    traceProvenance: input.traceProvenance,
    columns: [],
    rows: [],
    totalRows: 0,
    truncated: false,
    ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
    sourceToolCallId: input.sourceToolCallId,
    paramsHash: input.paramsHash,
    planPhaseId: input.planPhaseId,
    executableSql: input.executableSql,
    ...(queryReview ? { queryReview: compactQueryReviewForToolResponse(queryReview) } : {}),
    ...(input.sqlRewrites && input.sqlRewrites.length > 0 ? { sqlRewrites: input.sqlRewrites } : {}),
    stdlibInjectedModules: input.stdlibInjectedModules || [],
    ...(input.processIdentityWarning ? { processIdentityWarning: input.processIdentityWarning } : {}),
    error: input.error,
    diagnostic: {
      type: 'sql_execution_failed',
      citableEvidence: false,
      message: localize(
        outputLanguage,
        'SQL 执行未产出可用表格；这不是可引用的性能证据。',
        'SQL execution did not produce a usable table; this is not citable performance evidence.',
      ),
      retryHint: localize(
        outputLanguage,
        '修正 SQL 或改用 fetch_artifact / invoke_skill 后重试。不要把失败诊断作为结论证据。',
        'Fix the SQL or retry with fetch_artifact / invoke_skill. Do not cite failed diagnostics as conclusion evidence.',
      ),
    },
  };
}

function inferSqlColumnType(col: string): 'timestamp' | 'duration' | 'percentage' | 'string' {
  if (col.includes('ts') || col.includes('timestamp')) return 'timestamp';
  if (col.includes('dur')) return 'duration';
  if (col.includes('pct') || col.includes('percent')) return 'percentage';
  return 'string';
}

/**
 * Convert skill DisplayResults to DataEnvelopes and emit as SSE 'data' events.
 * This enables interactive tables (clickable timestamps, expandable rows) in the frontend.
 */
function emitSkillDataEnvelopes(
  displayResults: SkillDisplayResult[],
  skillId: string,
  emit: (update: StreamingUpdate) => void,
  traceProvenance?: TraceProcessorQueryProvenance,
  producer?: EvidenceProducerContext,
  identityResolution?: IdentityResolutionV1,
  artifactIdsByDisplayIndex?: ReadonlyArray<string | undefined>,
  queryReviewsByDisplayIndex?: ReadonlyArray<QueryReviewV1 | undefined>,
  evidenceSourceDisplayResults?: SkillDisplayResult[],
  outputLanguage: OutputLanguage = DEFAULT_OUTPUT_LANGUAGE,
  captureStore?: ArtifactStore,
): void {
  const envelopes = displayResults
    .map((dr, index) => ({
      displayIndex: index,
      displayResult: dr,
      evidenceSource: evidenceSourceDisplayResults?.[index] ?? dr,
    }))
    .filter(({displayResult}) => Boolean(displayResult.data))
    .map(({displayIndex, displayResult: dr, evidenceSource}) => {
      const explicitColumns = (dr as any).columnDefinitions;
      const drForEnvelope = {
        ...(dr as any),
        metadataConfig: (dr as any).metadataConfig || (Array.isArray((dr as any).metadataFields)
          ? { fields: (dr as any).metadataFields }
          : undefined),
      };
      const envelope = displayResultToEnvelope(drForEnvelope as any, skillId, explicitColumns);
      const evidenceRefId = stableSkillEvidenceRefId(
        skillId,
        envelope.meta.stepId,
        evidenceSource.title,
        evidenceSource.data,
        traceProvenance,
        producer,
        evidenceSource.scopeProvenance,
      );
      const artifactId = artifactIdsByDisplayIndex?.[displayIndex];
      const queryReview = envelope.meta.stepId
        ? queryReviewsByDisplayIndex?.[displayIndex] ?? buildSkillQueryReview({
            skillId,
            displayResult: evidenceSource,
            traceProvenance,
            producer,
            artifactId,
            evidenceRefId,
            outputLanguage,
          })
        : undefined;
      const evidenceIdentity = identityForScopeEvidence(evidenceSource.scopeProvenance, identityResolution);
      const withEvidence = {
        ...envelope,
        meta: {
          ...envelope.meta,
          evidenceRefId,
          ...scopeMetadata(evidenceSource.scopeProvenance),
          traceSide: traceProvenance?.traceSide,
          paneSide: traceProvenance?.paneSide,
          traceId: traceProvenance?.traceId,
          ...(artifactId ? { artifactId, sourceArtifactId: artifactId } : {}),
          ...(queryReview ? { queryReview } : {}),
          ...(evidenceIdentity ? {
            identityRefId: evidenceIdentity.identityRefId,
            identityStatus: evidenceIdentity.status,
            identityWarnings: evidenceIdentity.warnings,
            identityResolution: evidenceIdentity,
          } : {}),
          ...producerEnvelopeOptions(producer),
          intent: 'skill_structured_result',
        },
      };
      const witness = evidenceTableFor(evidenceSource) || captureEvidenceTable(undefined, {}, 'display_transformation_unmapped');
      if (captureStore) {
        if (artifactId) captureStore.registerEvidenceCapture?.(artifactId, witness, {evidenceRefId,
          ...(evidenceSource.sql ? {queryHash: evidenceHash(evidenceSource.sql)} : {})});
        else captureStore.registerStandaloneEvidenceCapture?.(witness, {meta: withEvidence.meta, display: withEvidence.display});
      }
      return traceProvenance
        ? {
          ...withEvidence,
          traceSide: traceProvenance.traceSide,
          paneSide: traceProvenance.paneSide,
          traceId: traceProvenance.traceId,
          traceProvenance,
        }
        : withEvidence;
    });

  if (envelopes.length > 0) {
    emit({ type: 'data', content: envelopes, timestamp: Date.now() });
  }
}
