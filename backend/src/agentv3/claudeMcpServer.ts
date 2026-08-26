// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

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
import {
  evaluationPhaseHintInjectionContentHash,
} from '../services/selfEvolution/evaluationTreatment';
import { createArchitectureDetector } from '../agent/detectors/architectureDetector';
import {resolveRegisteredDrillDownSkillParams} from '../agent/core/drillDownEntityResolver';
import { createDataEnvelope, displayResultToEnvelope } from '../types/dataContract';
import type {
  DisplayResult as SkillDisplayResult,
  SkillExecutionResult,
} from '../services/skillEngine/types';
import type { IdentityResolutionV1 } from '../types/identityContract';
import type { StreamingUpdate } from '../agent/types';
import type { ArchitectureInfo } from '../agent/detectors/types';
import { isEvidenceCapableToolName, isInformationalToolName, phaseMatchesCall } from './types';
import type { SqlSchemaEntry, SqlSchemaIndex, AnalysisNote, AnalysisPlanV3, PlanAspectWaiver, PlanPhase, PlanRevision, Hypothesis, ToolCallRecord, UncertaintyFlag } from './types';
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
import { sqlUsesProcessNameFilter } from '../services/processIdentity/identityGate';
import { injectStdlibIncludes } from './sqlIncludeInjector';
import { normalizeRawSql } from './rawSqlNormalizer';
import {
  buildStrategyDetailExcerpt,
  getStrategyDetailByRef,
  getStrategyDetails,
  loadPromptTemplate,
  getPhaseHints,
  matchStrategyDetailForPhase,
} from './strategyLoader';
import { matchPhaseHintForNextPhase } from './phaseHintMatcher';
import { buildActivePhaseReminder } from './activePhaseReminder';
import {
  validatePlanAgainstSceneTemplate,
  MIN_WAIVER_REASON_CHARS,
  type PlanValidationResult,
} from './scenePlanTemplates';
import { summarizeToolCallInput } from './toolCallSummary';
import { buildQuickArtifactGuidance } from './quickAnswerContract';
import {
  findBestPhaseForExpectedCallGap,
  findCompletedPhaseEvidenceGaps,
  findMissingExpectedCallsForPhase,
  formatPlanEvidenceGap,
  getPhaseToolEvidenceStatus,
  replayPrePlanToolCalls,
} from './planToolCallRecorder';
import { isConclusionLikePlanPhase } from './planPhaseSemantics';
import { formatToolCallNarration, type ToolNarrationOptions } from './toolNarration';
import type { ArtifactStore, CompactArtifactSummary } from './artifactStore';
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
  type ToolRequestScope,
} from './mcpToolRegistry';
import { backendLogPath } from '../runtimePaths';
import {diagnosticLogIdentity} from '../utils/logger';
import {activeCodebaseGeneration, CodebaseRegistry} from '../services/codebase/codebaseRegistry';
import {getDefaultCodebaseRegistry} from '../services/codebase/defaultCodebaseServices';
import {CodeLookupLedger} from '../services/codebase/codeLookupLedger';
import {PatchProposer} from '../services/codebase/patchProposer';
import {normalizeCodeAwareMode, type CodeAwareMode} from '../services/codebase/codeAwareFeature';
import {OnDemandSourceAccessService} from '../services/codebase/onDemandSourceAccess';
import {
  GitNexusCodeGraphNavigator,
  type CodeGraphNavigator,
} from '../services/codebase/gitNexusCodeGraphNavigator';
import {
  filterRagLookup,
  type SanitizedRagResult,
} from '../services/rag/lookupResponseFilter';
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

type PlanPhaseToolInput = Omit<PlanPhase, 'status' | 'expectedTools' | 'expectedCalls'> & {
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

const PLAN_STRING_ARRAY_OR_STRING_SCHEMA = z.union([z.array(z.union([z.string(), z.number()])), z.string()]);
const PLAN_EXPECTED_CALL_ARG_SCHEMA = z.union([
  z.string(),
  z.object({
    tool: z.union([z.string(), z.number()]).optional(),
    toolName: z.union([z.string(), z.number()]).optional(),
    tool_name: z.union([z.string(), z.number()]).optional(),
    name: z.union([z.string(), z.number()]).optional(),
    skillId: z.union([z.string(), z.number()]).optional(),
    skill_id: z.union([z.string(), z.number()]).optional(),
    skill: z.union([z.string(), z.number()]).optional(),
    skillName: z.union([z.string(), z.number()]).optional(),
    skill_name: z.union([z.string(), z.number()]).optional(),
  }).passthrough().refine(
    value => Boolean(coercePlanString(readAliasedField(value, ['tool', 'toolName', 'tool_name', 'name']))),
    { message: 'expectedCalls entries require tool/toolName/tool_name/name' },
  ),
]);
const PLAN_EXPECTED_CALLS_ARG_SCHEMA = z.union([z.array(PLAN_EXPECTED_CALL_ARG_SCHEMA), z.string()]);
const PLAN_PHASE_ARG_SCHEMA = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  phaseId: z.union([z.string(), z.number()]).optional(),
  phase_id: z.union([z.string(), z.number()]).optional(),
  name: z.union([z.string(), z.number()]).optional(),
  phaseName: z.union([z.string(), z.number()]).optional(),
  phase_name: z.union([z.string(), z.number()]).optional(),
  title: z.union([z.string(), z.number()]).optional(),
  goal: z.union([z.string(), z.number()]).optional(),
  objective: z.union([z.string(), z.number()]).optional(),
  description: z.union([z.string(), z.number()]).optional(),
  expectedTools: PLAN_STRING_ARRAY_OR_STRING_SCHEMA.optional(),
  expected_tools: PLAN_STRING_ARRAY_OR_STRING_SCHEMA.optional(),
  expectedCalls: PLAN_EXPECTED_CALLS_ARG_SCHEMA.optional(),
  expected_calls: PLAN_EXPECTED_CALLS_ARG_SCHEMA.optional(),
  status: z.string().optional(),
}).passthrough();
const PLAN_PHASES_ARG_SCHEMA = z.union([z.array(PLAN_PHASE_ARG_SCHEMA), z.string()]);
const PLAN_WAIVER_ARG_SCHEMA = z.object({
  aspectId: z.string().optional(),
  aspect_id: z.string().optional(),
  aspect: z.string().optional(),
  reason: z.string().optional(),
  justification: z.string().optional(),
}).passthrough();
const PLAN_WAIVERS_ARG_SCHEMA = z.union([z.array(PLAN_WAIVER_ARG_SCHEMA), z.string()]);

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
const SKILL_SCOPED_EXPECTED_CALL_TOOL_NAMES = new Set([
  'invoke_skill',
  'compare_skill',
]);
const EXPECTED_CALLS_FIELD_ALIASES = ['expectedCalls', 'expected_calls'];
const EXPECTED_CALL_TOOL_FIELD_ALIASES = ['tool', 'toolName', 'tool_name', 'name'];
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
  const invalidToolAliases = collectNonScalarExpectedCallAliases(call, EXPECTED_CALL_TOOL_FIELD_ALIASES);
  const invalidSkillAliases = collectNonScalarExpectedCallAliases(call, EXPECTED_CALL_SKILL_FIELD_ALIASES);
  errors.push(...invalidToolAliases.map(name => `contains non-scalar tool alias "${name}"`));
  errors.push(...invalidSkillAliases.map(name => `contains non-scalar skill alias "${name}"`));
  const toolValues = collectExpectedCallAliasStrings(call, EXPECTED_CALL_TOOL_FIELD_ALIASES);
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
  const errors: string[] = [];
  phases.forEach((phase, index) => {
    const label = phase.id || `phase#${index + 1}`;
    if (!phase.id) errors.push(`${label}.id is required`);
    if (!phase.name) errors.push(`${label}.name is required`);
    if (!phase.goal) errors.push(`${label}.goal is required`);
  });
  return errors;
}

function moveConclusionPhasesLast<T extends Pick<PlanPhase, 'id' | 'name' | 'goal'>>(phases: T[]): T[] {
  const conclusionPhases = phases.filter(isConclusionLikePlanPhase);
  if (conclusionPhases.length === 0) return phases;
  const nonConclusionPhases = phases.filter(phase => !isConclusionLikePlanPhase(phase));
  return [...nonConclusionPhases, ...conclusionPhases];
}

type PhaseSemanticKind =
  | 'architecture'
  | 'overview'
  | 'global_context'
  | 'root_drill'
  | 'gap_detection'
  | 'conclusion';

const PHASE_SEMANTIC_LABELS: Record<PhaseSemanticKind, string> = {
  architecture: '架构检测',
  overview: '概览采集',
  global_context: '全局上下文',
  root_drill: '根因深钻',
  gap_detection: '缺帧检测',
  conclusion: '综合结论',
};

const PHASE_SEMANTIC_PATTERNS: Array<{ kind: PhaseSemanticKind; pattern: RegExp }> = [
  {
    kind: 'conclusion',
    pattern: /(综合结论|最终结论|结论输出|输出.*(?:结论|报告)|最终报告|优化建议|final conclusion|conclusion|final report|write final answer)/i,
  },
  {
    kind: 'gap_detection',
    pattern: /(缺帧|帧生产\s*gap|frame[_ -]?production[_ -]?gap|rt_no_drawframe|ui_no_frame|sf_backpressure|buffer stuffing 假阳性|gap 列表|gap overview)/i,
  },
  {
    kind: 'root_drill',
    pattern: /(根因深钻|根因诊断|代表帧|四象限|机制级|jank_frame_detail|blocking_chain|workload_heavy|lock_binder_wait|top slices?|主线程耗时|renderthread 耗时|root cause|drill)/i,
  },
  {
    kind: 'global_context',
    pattern: /(全局上下文|温控|thermal|视频|插帧|后台|background|干扰|系统干扰|global context)/i,
  },
  {
    kind: 'architecture',
    pattern: /(架构检测|渲染架构|textureview|surfaceview|webview|detect_architecture|architecture)/i,
  },
  {
    kind: 'overview',
    pattern: /(概览|批量根因分类|根因分布|reason_code\s*分布|batch_frame_root_cause|滑动性能概览|启动概览|启动事件|启动类型|数据质量|ttid|ttfd|dur\s*=|帧统计|掉帧分布|scrolling_analysis|startup_overview|overview|startup event|launch type)/i,
  },
];

function inferPhaseSemanticKinds(text: string | undefined): PhaseSemanticKind[] {
  if (!text) return [];
  return PHASE_SEMANTIC_PATTERNS
    .filter(({ pattern }) => pattern.test(text))
    .map(({ kind }) => kind);
}

function findPhaseSemanticMismatch(
  plan: AnalysisPlanV3,
  phase: PlanPhase,
  summary: string | undefined,
): { summaryKind: PhaseSemanticKind; suggestedPhase: PlanPhase } | null {
  const summaryKinds = inferPhaseSemanticKinds(summary);
  if (summaryKinds.length === 0) return null;

  const phaseKinds = new Set(inferPhaseSemanticKinds(`${phase.name} ${phase.goal}`));
  if (phaseKinds.size === 0) return null;
  if (summaryKinds.some(kind => phaseKinds.has(kind))) return null;

  const mismatchedKind = summaryKinds.find(kind => !phaseKinds.has(kind));
  if (!mismatchedKind) return null;

  const suggestedPhase = plan.phases.find(candidate => {
    if (candidate.id === phase.id) return false;
    if (candidate.status === 'completed' || candidate.status === 'skipped') return false;
    return inferPhaseSemanticKinds(`${candidate.name} ${candidate.goal}`).includes(mismatchedKind);
  });

  return suggestedPhase ? { summaryKind: mismatchedKind, suggestedPhase } : null;
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
const RECENT_COMPLETED_PHASE_ATTRIBUTION_WINDOW_MS = 15 * 60 * 1000;

/**
 * P0-G2: ReAct reasoning nudge — appended to successful data tool results.
 * Prompts Claude to explicitly reason about observations before next action.
 * Cost: ~20 tokens per data tool call, ~200-300 total per analysis.
 */
const REASONING_NUDGE_ZH = '\n\n[REFLECT] 在执行下一步之前：这个数据的关键发现是什么？是否支持/反驳你的假设？如有重要推断，请用 submit_hypothesis 或 write_analysis_note 记录。';
const REASONING_NUDGE_EN = '\n\n[REFLECT] Before the next action: what is the key finding from this data? Does it support or refute your hypothesis? If there is an important inference, record it with submit_hypothesis or write_analysis_note.';
export const MIN_PHASE_SUMMARY_CHARS = 15;

const EXPECTED_CALL_SKIP_CONDITION_PATTERN =
  /(条件|触发条件|阈值|threshold|condition).{0,32}(未触发|未达到|未满足|不满足|not (?:triggered|met|satisfied)|below (?:the )?threshold)|(不是|并非)(?:冷|热|温)?启动|not (?:a )?(?:cold|warm|hot) start/i;
const EXPECTED_CALL_SKIP_EVIDENCE_SUBJECT_PATTERN =
  /(trace|跟踪|数据|信号|事件|窗口|进程|线程|帧|启动记录|schema|字段|列|表|模块|stdlib|data|signal|event|window|process|thread|frame|startup)/i;
const EXPECTED_CALL_SKIP_UNAVAILABLE_PATTERN =
  /(无(?:对应|相关|可用|足够)?|没有(?:对应|相关|可用|足够)?|缺少|缺失|不可用|不支持|无法执行|not (?:available|present|found|supported)|missing|absent|unavailable|unsupported|insufficient|no (?:matching |relevant |available )?)/i;

function skipSummaryExplainsEvidenceBoundary(summary: string): boolean {
  if (EXPECTED_CALL_SKIP_CONDITION_PATTERN.test(summary)) return true;
  return EXPECTED_CALL_SKIP_EVIDENCE_SUBJECT_PATTERN.test(summary) &&
    EXPECTED_CALL_SKIP_UNAVAILABLE_PATTERN.test(summary);
}

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
  /** Lightweight mode for quick queries — only registers core data tools.
   *  Skips planning, hypothesis, knowledge, patterns, notes, and comparison tools.
   *  Also disables the plan gate since planning tools are not available. */
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
  /** Non-secret authorization partition for active lookup/patch capability state. */
  analysisContextFingerprint?: string;
  /** Test hook / alternate private external-knowledge registry. */
  externalKnowledgeRegistry?: ExternalKnowledgeSourceRegistry;
  /** Test hook / alternate registry. */
  codebaseRegistry?: CodebaseRegistry;
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

/**
 * Creates an in-process MCP server scoped to a specific trace session.
 * Exposes domain tools: execute_sql, invoke_skill, list_skills,
 * detect_architecture, lookup_sql_schema, and optionally write_analysis_note.
 */
export function createClaudeMcpServer(options: ClaudeMcpServerOptions) {
  const { traceId, traceProcessorService, skillExecutor, packageName, emitUpdate, onSkillResult, analysisNotes, artifactStore } = options;
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
  const onDemandSourceAccess = new OnDemandSourceAccessService({registry: codebaseRegistry});
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
          12_000,
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

  function buildArchitectureTriggerContext(info: Partial<ArchitectureInfo> | undefined | null): string[] {
    if (!info) return [];
    const collectStringValues = (value: unknown, depth = 0): string[] => {
      if (depth > 2 || value === undefined || value === null) return [];
      if (typeof value === 'string') return [value];
      if (typeof value === 'number' || typeof value === 'boolean') return [String(value)];
      if (Array.isArray(value)) return value.flatMap(entry => collectStringValues(entry, depth + 1));
      if (typeof value === 'object') {
        return Object.values(value as Record<string, unknown>)
          .flatMap(entry => collectStringValues(entry, depth + 1));
      }
      return [];
    };
    const parts = [
      info.type,
      info.type ? String(info.type).replace(/_/g, ' ') : undefined,
    ];
    if (info.flutter) {
      parts.push('Flutter', info.flutter.engine, info.flutter.surfaceType, `Flutter ${info.flutter.surfaceType}`);
    }
    if (info.webview) {
      parts.push('WebView', info.webview.engine, info.webview.surfaceType, `WebView ${info.webview.surfaceType}`);
    }
    if (info.compose) {
      parts.push('Compose', ...(info.compose.features ?? []));
      if (info.compose.isHybridView) parts.push('mixed', 'hybrid');
    }
    for (const evidence of info.evidence ?? []) {
      if (evidence.value) parts.push(evidence.value);
      if (evidence.type) parts.push(evidence.type);
    }
    parts.push(...collectStringValues(info.additionalInfo));
    return parts.filter((part): part is string => Boolean(part && String(part).trim()));
  }

  let architectureTriggerContext = buildArchitectureTriggerContext(options.cachedArchitecture);

  function getPlanTemplateTriggerContext(): string[] {
    return [
      options.userQuery || '',
      ...architectureTriggerContext,
    ].filter(Boolean);
  }

  let pendingPlanRevisionGate: {
    missingAspectIds: string[];
    nonWaivableMissingAspectIds: string[];
    warnings: string[];
    requirements: NonNullable<PlanValidationResult['missingAspectRequirements']>;
  } | null = null;

  function clearPendingPlanRevisionGate(plan = options.analysisPlan?.current): void {
    if (!pendingPlanRevisionGate) return;
    if (plan?.unresolvedAspects) {
      const resolvedIds = new Set(pendingPlanRevisionGate.missingAspectIds);
      plan.unresolvedAspects = plan.unresolvedAspects.filter(id => !resolvedIds.has(id));
      if (plan.unresolvedAspects.length === 0) delete plan.unresolvedAspects;
    }
    pendingPlanRevisionGate = null;
  }

  function buildPendingPlanRevisionResponse(toolName: string): Record<string, unknown> {
    const gate = pendingPlanRevisionGate;
    return {
      success: false,
      error: localize(
        outputLanguage,
        `架构检测触发了当前 plan 未覆盖的不可 waiver 场景硬门禁，必须先调用 revise_plan 补充结构化 expectedCalls，暂不能继续使用 ${toolName}。`,
        `Architecture detection triggered non-waivable scene hard gates not covered by the current plan. Call revise_plan with structured expectedCalls before using ${toolName}.`,
      ),
      action_required: 'revise_plan',
      blockedTool: toolName,
      missingAspectIds: gate?.missingAspectIds ?? [],
      nonWaivableMissingAspectIds: gate?.nonWaivableMissingAspectIds ?? [],
      missingAspectSuggestions: gate?.warnings ?? [],
      missingAspectRequirements: gate?.requirements ?? [],
    };
  }

  function requireNoPendingPlanRevision(toolName: string): string | null {
    return pendingPlanRevisionGate
      ? JSON.stringify(buildPendingPlanRevisionResponse(toolName))
      : null;
  }

  function buildStrategyDetailDelivery(
    phase: Pick<PlanPhase, 'id' | 'name' | 'goal' | 'expectedTools' | 'expectedCalls'> | undefined,
    reason: 'first_phase' | 'next_phase',
  ): Record<string, unknown> | undefined {
    const match = matchStrategyDetailForPhase(options.sceneType, phase);
    if (!match) return undefined;
    const excerpt = buildStrategyDetailExcerpt(match.detail);
    console.log(`[MCP] Strategy detail ${reason}: ${match.detail.ref} for ${options.sceneType ?? 'unknown scene'} (score=${match.score})`);
    return {
      informational: true,
      reason,
      detailRef: match.detail.ref,
      title: match.detail.title,
      excerpt: excerpt.excerpt,
      excerptTruncated: excerpt.truncated,
      excerptMaxChars: excerpt.maxChars,
      lookupTool: 'lookup_strategy_detail',
      matchLog: {
        sceneType: options.sceneType,
        phaseId: phase?.id,
        phaseName: phase?.name,
        matchedKeywords: match.matchedKeywords,
        score: match.score,
      },
      note: localize(
        outputLanguage,
        '此 detail 为 informational：用于指导下一步执行，不计入 expectedCalls，也不能替代 trace 证据。',
        'This detail is informational: it guides execution, does not count as expectedCalls, and cannot replace trace evidence.',
      ),
    };
  }

  /** Normalize skill params: ensure process_name ↔ package are both set. */
  function normalizeSkillParams(params: Record<string, any> | undefined, defaultPackage?: string): Record<string, any> {
    const p = { ...params };
    for (const key of Object.keys(p)) {
      if (TIMESTAMP_EXPRESSION_PARAM_KEYS.has(key)) {
        p[key] = normalizeTimestampExpression(p[key]);
      }
    }
    if (defaultPackage && !p.process_name) p.process_name = defaultPackage;
    if (p.process_name && !p.package) p.package = p.process_name;
    if (p.package && !p.process_name) p.process_name = p.package;
    return p;
  }

  function undeclaredModelSkillParams(
    skill: {inputs?: Array<{name: string}>; identity?: {aliases?: string[]}},
    params: Record<string, any> | undefined,
  ): string[] {
    if (!params || !skill.inputs?.length) return [];
    const allowed = new Set(skill.inputs.map(input => input.name));
    for (const alias of skill.identity?.aliases ?? []) allowed.add(alias);
    if (allowed.has('process_name')) allowed.add('package');
    if (allowed.has('package')) allowed.add('process_name');
    return Object.keys(params).filter(key => !allowed.has(key)).sort();
  }

  function referenceSharedParamsForComparison(
    params: Record<string, any> | undefined,
    currentDefaultPackage?: string,
    referenceDefaultPackage?: string,
  ): { params: Record<string, any>; identityRemapped: boolean } {
    const p = { ...params };
    const processName = typeof p.process_name === 'string' ? p.process_name : undefined;
    const packageParam = typeof p.package === 'string' ? p.package : undefined;
    const pointsAtCurrentPackage = Boolean(currentDefaultPackage && (
      processName === currentDefaultPackage || packageParam === currentDefaultPackage
    ));
    const hasIdentityFilter = Boolean(processName || packageParam);

    if (referenceDefaultPackage && (!hasIdentityFilter || pointsAtCurrentPackage)) {
      if (processName !== referenceDefaultPackage || packageParam !== referenceDefaultPackage) {
        p.process_name = referenceDefaultPackage;
        p.package = referenceDefaultPackage;
        return { params: p, identityRemapped: true };
      }
    }

    if (!referenceDefaultPackage && pointsAtCurrentPackage) {
      delete p.process_name;
      delete p.package;
      return { params: p, identityRemapped: true };
    }

    return { params: p, identityRemapped: false };
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
        /^art-\d+$/i.test(tableName) ||
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

  function artifactSqlMisuseHint(sql: string, language: OutputLanguage): Record<string, unknown> | null {
    const tableName = findArtifactPseudoTableName(sql);
    if (!tableName) return null;

    return {
      success: false,
      blocked: true,
      error: localize(
        language,
        `${tableName} 不是 trace_processor SQL 表。Skill 返回的 art-* / synthesizeArtifacts 是 SmartPerfetto artifact 引用，不能用 execute_sql 查询。`,
        `${tableName} is not a trace_processor SQL table. art-* / synthesizeArtifacts from Skill results are SmartPerfetto artifact references and cannot be queried with execute_sql.`,
      ),
      action_required: 'fetch_artifact',
      hint: 'Use fetch_artifact(artifactId="art-N", detail="rows", offset=0, limit=50) with the artifactId returned by invoke_skill.',
      sql,
    };
  }

  /**
   * P0-G10: Enforce planning before analysis.
   * Returns error JSON if plan is required but not yet submitted, null if OK.
   * Only action tools (execute_sql, invoke_skill) are gated — informational
   * and planning tools are exempt to allow plan formation.
   */
  const analysisPlanRef = options.analysisPlan;
  const MAX_PLAN_ATTEMPTS = 5;
  /** Track submit_plan attempts for scene-template hard gates. */
  let planSubmitAttempts = 0;
  /** Track revise_plan attempts separately so a revised plan cannot bypass the same gate. */
  let planReviseAttempts = 0;

  function validatePhasesAgainstSceneTemplate(
    phases: ReadonlyArray<Pick<PlanPhase, 'name' | 'goal' | 'expectedTools' | 'expectedCalls'>>,
    waivers?: ReadonlyArray<PlanAspectWaiver>,
  ) {
    return validatePlanAgainstSceneTemplate(
      phases,
      options.sceneType,
      waivers,
      { triggerContext: getPlanTemplateTriggerContext() },
    );
  }

  function buildPlanGateRejectPayload(input: {
    missingAspectIds: string[];
    nonWaivableMissingAspectIds: string[];
    planWarnings: string[];
    missingAspectRequirements: NonNullable<PlanValidationResult['missingAspectRequirements']>;
    attempt: number;
    tooShortWaivers?: PlanAspectWaiver[];
    mode: 'submit_plan' | 'revise_plan';
  }): Record<string, unknown> {
    const isRevise = input.mode === 'revise_plan';
    return {
      success: false,
      error: localize(
        outputLanguage,
        `${isRevise ? '修订后的计划' : '计划'}缺少 ${options.sceneType ?? '当前'} 场景的必要分析阶段`,
        `${isRevise ? 'The revised plan' : 'The plan'} is missing mandatory analysis phases for the ${options.sceneType ?? 'current'} scene`,
      ),
      missingAspectIds: input.missingAspectIds,
      nonWaivableMissingAspectIds: input.nonWaivableMissingAspectIds.length > 0
        ? input.nonWaivableMissingAspectIds
        : undefined,
      missingAspectSuggestions: input.planWarnings,
      missingAspectRequirements: input.missingAspectRequirements,
      attempt: input.attempt,
      maxAttempts: MAX_PLAN_ATTEMPTS,
      tooShortWaivers: input.tooShortWaivers && input.tooShortWaivers.length > 0
        ? input.tooShortWaivers
        : undefined,
      action_required: input.mode,
      hint: localize(
        outputLanguage,
        input.nonWaivableMissingAspectIds.length > 0
          ? `修复 plan，为不可 waiver 的 aspect 添加结构化 expectedCalls 后重新调用 ${input.mode}；这些 aspect 不能用 waivers 绕过。`
          : `修复 plan 添加缺失阶段并重新调用 ${input.mode}，或在 waivers 中给出 ≥${MIN_WAIVER_REASON_CHARS} 字符的理由说明为什么无法覆盖。`,
        input.nonWaivableMissingAspectIds.length > 0
          ? `Fix the plan by adding structured expectedCalls for the non-waivable aspect(s), then call ${input.mode} again; waivers cannot bypass them.`
          : `Add the missing phases and call ${input.mode} again, or provide a waiver reason of at least ${MIN_WAIVER_REASON_CHARS} characters explaining why it cannot be covered.`,
      ),
    };
  }

  function recordArchitecturePlanGate(payload: Partial<ArchitectureInfo>): Record<string, unknown> {
    architectureTriggerContext = buildArchitectureTriggerContext(payload);
    const plan = analysisPlanRef?.current;
    if (!plan) return {};
    const planValidation = validatePhasesAgainstSceneTemplate(plan.phases, plan.waivers);
    const missingAspectIds = planValidation.missingAspectIds;
    if (missingAspectIds.length === 0) {
      clearPendingPlanRevisionGate(plan);
      return {};
    }

    const nonWaivableMissingAspectIds = planValidation.nonWaivableMissingAspectIds ?? [];
    if (nonWaivableMissingAspectIds.length > 0) {
      pendingPlanRevisionGate = {
        missingAspectIds,
        nonWaivableMissingAspectIds,
        warnings: planValidation.warnings,
        requirements: planValidation.missingAspectRequirements ?? [],
      };
      plan.unresolvedAspects = Array.from(new Set([
        ...(plan.unresolvedAspects ?? []),
        ...missingAspectIds,
      ]));
    }

    return {
      planRevisionRequired: true,
      missingAspectIds,
      nonWaivableMissingAspectIds: nonWaivableMissingAspectIds.length > 0
        ? nonWaivableMissingAspectIds
        : undefined,
      missingAspectSuggestions: planValidation.warnings,
      missingAspectRequirements: planValidation.missingAspectRequirements ?? [],
      action_required: 'revise_plan',
      note: localize(
        outputLanguage,
        nonWaivableMissingAspectIds.length > 0
          ? '架构检测触发了当前 plan 未覆盖的不可 waiver 场景硬门禁；请调用 revise_plan 补充对应 expectedCalls 后再继续。'
          : '架构检测触发了当前 plan 未覆盖的场景检查项；建议调用 revise_plan 补充对应 expectedCalls 或 waiver。' ,
        nonWaivableMissingAspectIds.length > 0
          ? 'Architecture detection triggered non-waivable scene hard gates not covered by the current plan; call revise_plan with the corresponding expectedCalls before continuing.'
          : 'Architecture detection triggered scene checks not covered by the current plan; call revise_plan with corresponding expectedCalls or a waiver.',
      ),
    };
  }

  function requirePlan(toolName: string): string | null {
    if (!analysisPlanRef) return null; // Planning feature not enabled
    if (analysisPlanRef.current) return requireNoPendingPlanRevision(toolName); // Plan already submitted
    return JSON.stringify({
      success: false,
      error: localize(
        outputLanguage,
        `必须先调用 submit_plan 提交分析计划，然后才能使用 ${toolName}。请先制定你的分析计划，包含分析阶段、目标和预期工具。`,
        `You must call submit_plan before using ${toolName}. Create an analysis plan with phases, goals, and expected tools first.`,
      ),
      action_required: 'submit_plan',
    });
  }

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
  type EvidencePhaseOverride = {
    phaseId?: string;
    phaseTitle?: string;
    phaseGoal?: string;
    attribution?: PlanPhaseAttribution;
    warning?: string;
  };

  function phaseHasToolExpectation(phase: PlanPhase): boolean {
    return (phase.expectedCalls?.length || 0) > 0 || (phase.expectedTools?.length || 0) > 0;
  }

  function phaseMatchesToolInput(
    phase: PlanPhase,
    toolName: string,
    input: Record<string, unknown>,
  ): boolean {
    const skillId = typeof input.skillId === 'string' ? input.skillId : undefined;
    return phaseMatchesCall(phase, {
      toolName,
      timestamp: Date.now(),
      skillId,
    });
  }

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

  function phaseExpectedCallsSatisfiedAfterEvidence(
    phase: PlanPhase,
    toolName: string,
    input: Record<string, unknown>,
  ): boolean {
    const plan = analysisPlanRef?.current;
    if (!plan) return true;
    const toolCallLog = Array.isArray(plan.toolCallLog) ? plan.toolCallLog : [];
    const records = [
      ...toolCallLog,
      toolInputToPlanCallRecord(toolName, input, phase.id),
    ];
    return getPhaseToolEvidenceStatus(plan, phase, records).satisfied;
  }

  function phaseSemanticScore(
    phase: PlanPhase,
    toolName: string,
    input: Record<string, unknown>,
  ): number {
    const skillId = typeof input.skillId === 'string' ? input.skillId : undefined;
    const sql = typeof input.sql === 'string' ? input.sql : '';
    const expected = [
      ...(phase.expectedTools || []),
      ...(phase.expectedCalls || []).map(call => call.skillId || call.tool),
    ].join(' ');
    const text = `${phase.id} ${phase.name} ${phase.goal} ${expected}`.toLowerCase();
    const inputText = JSON.stringify(input ?? {}).toLowerCase();
    let score = 0;

    if (skillId) {
      const id = skillId.toLowerCase();
      if (text.includes(id)) score += 100;
      if (text.includes(id.replace(/_/g, ' '))) score += 60;
      const hints: Record<string, string[]> = {
        detect_architecture: ['架构', '渲染架构', '架构确认', '架构检测', '管线', 'pipeline', 'architecture'],
        scrolling_analysis: ['滑动', 'scroll', '概览', '掉帧列表', '帧统计', '数据收集'],
        startup_analysis: ['启动概览', '启动类型', '启动事件', 'startup', 'launch'],
        startup_detail: ['启动详情', '四象限', '阻塞关系', '热点slice', '调度'],
        startup_slow_reasons: ['慢原因', 'sr01', 'sr20', '交叉验证'],
        memory_pressure_in_range: ['内存压力', 'memory', 'd状态', 'lmk', 'kswapd'],
        blocking_chain_analysis: ['阻塞链', '阻塞关系', '唤醒', 'waker', 'blocked_functions', 'blocking_chain'],
        lock_contention_in_range: ['锁竞争', 'futex', 'blocked_functions', '阻塞'],
        binder_blocking_in_range: ['binder', '阻塞', '同步binder', 'ipc'],
        jank_frame_detail: ['根因深钻', '单帧', '逐帧', 'jank_frame_detail', 'blocking_chain'],
        frame_blocking_calls: ['根因深钻', '阻塞调用', 'frame_blocking_calls', 'blocking_chain'],
        lock_binder_wait: ['根因深钻', '锁', 'binder', '阻塞', '等待', 'blocking_chain'],
        frame_production_gap: ['缺帧', 'gap', '帧间', '隐形缺帧', '生产'],
        batch_frame_root_cause: ['逐帧根因', 'reason_code', '根因分类'],
      };
      for (const hint of hints[id] || []) {
        if (text.includes(hint.toLowerCase())) score += 20;
      }
      if (id === 'jank_frame_detail') {
        if (/根因深钻|深钻|单帧|代表帧|最严重帧|机制级|detail|drill/.test(text)) score += 60;
        if (/分布|分类|聚合|统计|batch|reason_code/.test(text) && !/深钻|单帧|代表帧|最严重帧|机制级/.test(text)) score -= 15;
      }
      if (id === 'blocking_chain_analysis') {
        if (/阻塞链|阻塞关系|唤醒|waker|blocked_functions|blocking_chain|锁竞争|binder/.test(text)) score += 70;
        if (/根因|深钻|机制|代表帧|最严重帧|单帧|深入诊断|detail|drill|root cause/.test(text)) score += 60;
      }
      if (id === 'memory_pressure_in_range') {
        if (/内存压力|memory|lmk|kswapd|reclaim|gc|根因|交叉验证|排除/.test(text)) score += 70;
      }
      if (id === 'startup_slow_reasons') {
        if (/慢原因|启动慢|sr\d+|sr01|sr20|根因|交叉验证|已知原因/.test(text)) score += 70;
      }
    }

    if (toolName === 'detect_architecture') {
      if (/架构|渲染架构|架构确认|架构检测|管线|architecture|pipeline|trace 时间范围|time range/.test(text)) score += 120;
      if (/缺帧检测|frame_production_gap|gap detection/.test(text)) score -= 120;
      if (/综合结论|结论|conclusion|报告|report/.test(text)) score -= 40;
    }

    if (toolName === 'fetch_artifact') {
      if (/fetch_artifact|artifact|分页|全量|完整|掉帧数据|batch_frame_root_cause|根因数据/.test(text) &&
        /全量|完整|掉帧|root_cause|batch_frame_root_cause|reason_code|artifact/.test(inputText)) {
        score += 120;
      }
      if (/全量|完整|分页|batch_frame_root_cause|根因数据/.test(text) &&
        /全量|完整|batch_frame_root_cause|reason_code|根因分布/.test(inputText)) {
        score += 90;
      }
      if (/根因深钻|深钻|代表帧|最严重帧|机制级|blocking|jank_frame_detail|frame_blocking/.test(text) &&
        /阻塞|blocking|代表|最严重|top_slice|jank_frame_detail|frame_blocking|主线程/.test(inputText)) {
        score += 85;
      }
      if (/根因深钻|深钻|代表帧|最严重帧|机制级/.test(text) &&
        /全量|完整|根因分布|batch_frame_root_cause/.test(inputText) &&
        !/代表|最严重|阻塞|blocking|top_slice/.test(inputText)) {
        score -= 40;
      }
      if (/概览|overview|滑动区间|帧统计|掉帧分布/.test(text) &&
        /概览|summary|滑动区间|session|jank_type|性能概览/.test(inputText)) {
        score += 60;
      }
      if (/综合结论|结论|conclusion|报告|report/.test(text)) score -= 30;
    }

    if (toolName === 'execute_sql' || toolName === 'execute_sql_on') {
      const sqlText = sql.toLowerCase();
      const isFrameOverviewSql =
        /actual_frame_timeline_slice/.test(sqlText) &&
        (
          /min\s*\(\s*ts\s*\)/.test(sqlText) ||
          /max\s*\(\s*ts\s*\+\s*dur\s*\)/.test(sqlText) ||
          /count\s*\(\s*\*\s*\)/.test(sqlText) ||
          /\b(frame_count|total_frames|layer_count)\b/.test(sqlText)
        );
      const isTraceRangeSql =
        /actual_frame_timeline_slice/.test(sqlText) &&
        /min\s*\(\s*ts\s*\)/.test(sqlText) &&
        /max\s*\(\s*ts\s*\+\s*dur\s*\)/.test(sqlText);
      const hasFrameOverviewPhaseHint =
        /概览|overview|数据收集|采集|帧统计|帧率统计|滑动区间|时间范围|time range/.test(text);
      if (isTraceRangeSql) {
        if (/trace|时间范围|时间边界|边界|time range|range/.test(text)) score += 180;
        if (/架构确认|确认.*架构|架构检测|检测.*架构|detect.*architecture|architecture.*detect/.test(text)) score += 60;
        if (/hwui|producer|surfaceflinger|sf|合成|链路/.test(text) && !hasFrameOverviewPhaseHint) score -= 50;
        if (/根因|深钻|逐帧|reason_code|综合结论|报告/.test(text) && !hasFrameOverviewPhaseHint) score -= 50;
      }
      if (isFrameOverviewSql) {
        if (hasFrameOverviewPhaseHint) score += 80;
        if (/根因|深钻|逐帧|diagnos|root cause/.test(text)) score -= 20;
      }
      const isRootCauseDrillSql = /\b(thread|thread_state|thread_slice|thread_track|slice|slice_self_dur|sched|futex|binder|blocking|root_cause|reason_code|top_slice|main_q4b|__intrinsic_batch_frame_root_cause)\b/.test(sqlText);
      if (isRootCauseDrillSql) {
        if (/根因|深钻|机制|阻塞|代表帧|逐帧|单帧|detail|drill|root cause|blocking/.test(text)) score += 80;
        if (/概览|overview|帧统计|掉帧分布|数据收集|采集/.test(text)) score -= 10;
      }
      const isWebViewStartupSql = /webview|chromium|v8|crrenderermain|parsehtml|drawgl/.test(sqlText);
      if (isWebViewStartupSql) {
        if (/webview|chromium|v8|crrenderermain|parsehtml|drawgl|页面渲染/.test(text)) score += 140;
        if (/综合结论|结论|conclusion|报告|report/.test(text) && !/webview|chromium|v8/.test(text)) score -= 30;
      }
      const sqlHints: Array<[RegExp, string[]]> = [
        [/webview|chromium|v8|crrenderermain|parsehtml|drawgl/, ['webview', 'chromium', 'v8', '页面渲染']],
        [/actual_frame_timeline|expected_frame_timeline|jank|frame/, ['滑动', '掉帧', '帧', 'frame']],
        [/\bthread\b|thread_state|thread_slice|slice_self_dur|sched|cpu|freq/, ['线程', '调度', 'cpu', '频率', '热点', '主线程', '阻塞']],
        [/memory|lmk|kswapd|reclaim/, ['内存', 'memory', 'lmk']],
      ];
      for (const [pattern, hints] of sqlHints) {
        if (!pattern.test(sqlText)) continue;
        for (const hint of hints) {
          if (text.includes(hint.toLowerCase())) score += 15;
        }
      }
    }

    return score;
  }

  function inferSemanticPhase(
    phases: PlanPhase[],
    toolName: string,
    input: Record<string, unknown>,
  ): PlanPhase | undefined {
    const scored = phases
      .map(phase => ({ phase, score: phaseSemanticScore(phase, toolName, input) }))
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score);
    if (scored.length === 0) return undefined;
    if (scored.length === 1 || scored[0].score > scored[1].score) return scored[0].phase;
    return undefined;
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
    phase.completedAt = undefined;
    phase.summary = undefined;

    const narration = formatToolCallNarration(toolName, input, outputLanguage, toolNarrationOptions());
    const summary = localize(
      outputLanguage,
      `自动进入阶段：${narration}`,
      `Auto-started phase for: ${narration}`,
    ).slice(0, 260);

    emitUpdate?.({
      type: 'plan_phase_updated',
      content: { phaseId: phase.id, status: 'in_progress', summary, phaseName: phase.name },
      timestamp: Date.now(),
    });

    return true;
  }

  function autoClosedPhaseSummary(closedPhase: PlanPhase, nextPhase: PlanPhase): string {
    const artifacts = typeof artifactStore?.serialize === 'function'
      ? artifactStore.serialize().filter(artifact => artifact.planPhaseId === closedPhase.id)
      : [];
    const titles = Array.from(new Set(
      artifacts
        .map(artifact => artifact.title || artifact.stepId)
        .filter((title): title is string => typeof title === 'string' && title.trim().length > 0)
    )).slice(0, 4);
    const skillIds = Array.from(new Set(
      artifacts
        .map(artifact => artifact.skillId)
        .filter((skillId): skillId is string => typeof skillId === 'string' && skillId.trim().length > 0)
    )).slice(0, 3);
    const moreCount = Math.max(0, artifacts.length - titles.length);
    const titleSummary = titles.length
      ? localize(
          outputLanguage,
          `：${titles.join('、')}${moreCount > 0 ? `等 ${moreCount} 个` : ''}`,
          `: ${titles.join(', ')}${moreCount > 0 ? ` and ${moreCount} more` : ''}`,
        )
      : '';
    const evidenceSummary = artifacts.length > 0
      ? localize(
          outputLanguage,
          `本阶段已产生 ${artifacts.length} 个证据表${skillIds.length ? `（来源：${skillIds.join('、')}）` : ''}${titleSummary}。`,
          `This phase produced ${artifacts.length} evidence table(s)${skillIds.length ? ` from ${skillIds.join(', ')}` : ''}${titleSummary}.`,
        )
      : localize(
          outputLanguage,
          `本阶段未记录 artifact，但已保留该阶段的工具调用和时间线事件。`,
          `This phase did not record artifacts, but its tool calls and timeline events remain available.`,
        );
    return localize(
      outputLanguage,
      `自动完成阶段「${closedPhase.name}」：已进入后续阶段「${nextPhase.name}」。${evidenceSummary}阶段目标：${closedPhase.goal}。上一阶段未收到显式完成摘要。`,
      `Auto-completed phase "${closedPhase.name}" after moving to "${nextPhase.name}". ${evidenceSummary} Phase goal: ${closedPhase.goal}. The previous phase did not provide an explicit completion summary.`,
    );
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
            content: {
              phaseId: other.id,
              status: 'pending',
              summary: localize(
                outputLanguage,
                `阶段「${other.name}」已进入后续阶段「${nextPhase.name}」，但仍缺少关键工具证据，保持待补证状态。`,
                `Phase "${other.name}" moved behind "${nextPhase.name}" but is still missing required tool evidence, so it remains pending.`,
              ),
              phaseName: other.name,
            },
            timestamp: Date.now(),
          });
          continue;
        }

        const summary = autoClosedPhaseSummary(other, nextPhase);
        other.status = 'completed';
        other.completedAt = Date.now();
        other.summary = summary;
        emitUpdate?.({
          type: 'plan_phase_updated',
          content: { phaseId: other.id, status: 'completed', summary, phaseName: other.name },
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
      const shouldClosePhase = phaseExpectedCallsSatisfiedAfterEvidence(phase, toolName, input);
      if (!shouldClosePhase) {
        return {
          phase,
          attribution: 'inferred',
          warning: localize(
            outputLanguage,
            `证据语义匹配较早阶段 "${phase.name}"，但该阶段仍缺少其他关键工具证据；已先绑定证据，阶段保持待补证。`,
            `Evidence semantically matched earlier phase "${phase.name}", but that phase is still missing other required tool evidence; bound this evidence while keeping the phase pending.`,
          ),
        };
      }

      const narration = formatToolCallNarration(toolName, input, outputLanguage, toolNarrationOptions());
      const summary = localize(
        outputLanguage,
        `自动补记阶段：收到本阶段证据（${narration}），但当前已在后续阶段「${laterActive.name}」。该阶段直接标记完成，证据以推断方式绑定。`,
        `Backfilled phase evidence (${narration}) while later phase "${laterActive.name}" was active. Marked this phase complete and bound the evidence as inferred.`,
      ).slice(0, 260);
      phase.status = 'completed';
      phase.completedAt = Date.now();
      phase.summary = summary;
      emitUpdate?.({
        type: 'plan_phase_updated',
        content: { phaseId: phase.id, status: 'completed', summary, phaseName: phase.name },
        timestamp: Date.now(),
      });
      return {
        phase,
        attribution: 'inferred',
        warning: localize(
          outputLanguage,
          `证据语义匹配较早阶段 "${phase.name}"，但当前已在后续阶段 "${laterActive.name}"；已按补记阶段绑定，需要核对顺序。`,
          `Evidence semantically matched earlier phase "${phase.name}" while later phase "${laterActive.name}" was active; bound as a backfilled phase and should be checked for ordering.`,
        ),
      };
    }

    autoStartPhaseForEvidence(phase, toolName, input);
    return { phase, attribution: 'active' };
  }

  function activePlanPhaseForEvidence(
    toolName: string,
    input: Record<string, unknown>,
  ): { phase?: PlanPhase; attribution: PlanPhaseAttribution; warning?: string } {
    const plan = analysisPlanRef?.current;
    if (!plan) return { attribution: 'none' };

    const expectedGapPhase = findBestPhaseForExpectedCallGap(
      plan,
      toolInputToPlanCallRecord(toolName, input),
      'structured_only',
    );
    if (expectedGapPhase) {
      if (expectedGapPhase.status === 'pending') {
        return bindPendingPhaseForEvidence(expectedGapPhase, toolName, input);
      }
      if (expectedGapPhase.status === 'in_progress') {
        return { phase: expectedGapPhase, attribution: 'active' };
      }
      return {
        phase: expectedGapPhase,
        attribution: 'inferred',
        warning: localize(
          outputLanguage,
          `工具调用补齐了较早阶段 "${expectedGapPhase.name}" 的关键证据缺口；已按补证绑定到该阶段。`,
          `Tool call filled a required evidence gap for earlier phase "${expectedGapPhase.name}"; bound it to that phase as backfilled evidence.`,
        ),
      };
    }

    const active = plan.phases.filter(p => p.status === 'in_progress');
    if (active.length === 0) {
      const isRawSqlTool = toolName === 'execute_sql' || toolName === 'execute_sql_on';
      if (isRawSqlTool) {
        const semanticPending = inferSemanticPhase(
          plan.phases.filter(p => p.status === 'pending'),
          toolName,
          input,
        );
        if (semanticPending) {
          return bindPendingPhaseForEvidence(semanticPending, toolName, input);
        }
        const semanticRecentCompleted = inferSemanticPhase(
          plan.phases
            .filter(p =>
              p.status === 'completed' &&
              typeof p.completedAt === 'number' &&
              Date.now() - p.completedAt <= RECENT_COMPLETED_PHASE_ATTRIBUTION_WINDOW_MS
            )
            .sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0)),
          toolName,
          input,
        );
        if (semanticRecentCompleted) {
          return {
            phase: semanticRecentCompleted,
            attribution: 'inferred',
            warning: localize(
              outputLanguage,
              `当前没有明确进行中的 plan 阶段；已按 SQL 内容绑定到最近完成的阶段 "${semanticRecentCompleted.name}"，需要核对。`,
              `No plan phase is explicitly in progress; bound to the recently completed phase "${semanticRecentCompleted.name}" by SQL content and should be verified.`,
            ),
          };
        }
      }

      const matchingPending = plan.phases.filter(p =>
        p.status === 'pending' &&
        phaseHasToolExpectation(p) &&
        phaseMatchesToolInput(p, toolName, input)
      );
      if (matchingPending.length === 1) {
        const phase = matchingPending[0];
        return bindPendingPhaseForEvidence(phase, toolName, input);
      }
      if (matchingPending.length > 1) {
        const phase = inferSemanticPhase(matchingPending, toolName, input);
        if (phase) {
          return bindPendingPhaseForEvidence(phase, toolName, input);
        }
        return {
          attribution: 'ambiguous',
          warning: localize(
            outputLanguage,
            `当前没有明确进行中的 plan 阶段，且 ${matchingPending.length} 个待执行阶段都匹配 ${toolName}；此数据未绑定具体阶段。`,
            `No plan phase is explicitly in progress and ${matchingPending.length} pending phases match ${toolName}; this data is not bound to a concrete phase.`,
          ),
        };
      }
      const recentCompleted = plan.phases
        .filter(p =>
          p.status === 'completed' &&
          typeof p.completedAt === 'number' &&
          Date.now() - p.completedAt <= RECENT_COMPLETED_PHASE_ATTRIBUTION_WINDOW_MS &&
          phaseHasToolExpectation(p) &&
          phaseMatchesToolInput(p, toolName, input)
        )
        .sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0));
      if (recentCompleted.length > 0) {
        const phase = inferSemanticPhase(recentCompleted, toolName, input) || recentCompleted[0];
        return {
          phase,
          attribution: 'inferred',
          warning: localize(
            outputLanguage,
            `当前没有明确进行中的 plan 阶段；已绑定到最近完成且匹配工具的阶段 "${phase.name}"，需要核对。`,
            `No plan phase is explicitly in progress; bound to the most recently completed matching phase "${phase.name}" and should be verified.`,
          ),
        };
      }
      const semanticRecentCompleted = inferSemanticPhase(
        plan.phases
          .filter(p =>
            p.status === 'completed' &&
            typeof p.completedAt === 'number' &&
            Date.now() - p.completedAt <= RECENT_COMPLETED_PHASE_ATTRIBUTION_WINDOW_MS
          )
          .sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0)),
        toolName,
        input,
      );
      if (semanticRecentCompleted &&
        phaseSemanticScore(semanticRecentCompleted, toolName, input) >= 50) {
        return {
          phase: semanticRecentCompleted,
          attribution: 'inferred',
          warning: localize(
            outputLanguage,
            `当前没有明确进行中的 plan 阶段；已按证据语义绑定到最近完成的阶段 "${semanticRecentCompleted.name}"，需要核对。`,
            `No plan phase is explicitly in progress; bound to the recently completed phase "${semanticRecentCompleted.name}" by evidence semantics and should be verified.`,
          ),
        };
      }
      const semanticPending = inferSemanticPhase(
        plan.phases.filter(p => p.status === 'pending' && phaseHasToolExpectation(p)),
        toolName,
        input,
      );
      if (semanticPending) {
        return bindPendingPhaseForEvidence(semanticPending, toolName, input);
      }
      return {
        attribution: 'missing',
        warning: localize(
          outputLanguage,
          '当前没有明确进行中的 plan 阶段；此数据未绑定具体阶段。',
          'No plan phase is explicitly in progress; this data is not bound to a concrete phase.',
        ),
      };
    }
    if (active.length > 1) {
      return {
        attribution: 'ambiguous',
        warning: localize(
          outputLanguage,
          `当前有 ${active.length} 个 plan 阶段同时进行；此数据未绑定具体阶段。`,
          `${active.length} plan phases are in progress at the same time; this data is not bound to a concrete phase.`,
        ),
      };
    }

    const phase = active[0];
    const skillId = typeof input.skillId === 'string' ? input.skillId : undefined;
    if (phaseHasToolExpectation(phase) && !phaseMatchesToolInput(phase, toolName, input)) {
      const activeSemanticScore = phaseSemanticScore(phase, toolName, input);
      const matchingPending = plan.phases.filter(p =>
        p.status === 'pending' &&
        phaseHasToolExpectation(p) &&
        phaseMatchesToolInput(p, toolName, input)
      );
      const inferredPhase = matchingPending.length === 1
        ? matchingPending[0]
        : inferSemanticPhase(matchingPending, toolName, input);
      const recentCompleted = plan.phases
        .filter(p =>
          p.status === 'completed' &&
          typeof p.completedAt === 'number' &&
          Date.now() - p.completedAt <= RECENT_COMPLETED_PHASE_ATTRIBUTION_WINDOW_MS &&
          phaseHasToolExpectation(p) &&
          phaseMatchesToolInput(p, toolName, input)
        )
        .sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0));
      const recentCompletedPhase = recentCompleted.length === 1
        ? recentCompleted[0]
        : inferSemanticPhase(recentCompleted, toolName, input);
      const recentCompletedScore = recentCompletedPhase
        ? phaseSemanticScore(recentCompletedPhase, toolName, input)
        : 0;
      const inferredSemanticScore = inferredPhase
        ? phaseSemanticScore(inferredPhase, toolName, input)
        : 0;
      if (recentCompletedPhase &&
        recentCompletedScore >= 50 &&
        (!inferredPhase || recentCompletedScore >= inferredSemanticScore + 30)) {
        return {
          phase: recentCompletedPhase,
          attribution: 'inferred',
          warning: localize(
            outputLanguage,
            `工具结果语义匹配刚完成的阶段 "${recentCompletedPhase.name}"，但当前已进入阶段 "${phase.name}"；已按并发工具回填绑定。`,
            `Tool result semantically matched recently completed phase "${recentCompletedPhase.name}" while phase "${phase.name}" is now active; bound as concurrent-tool backfill.`,
          ),
        };
      }
      if (inferredPhase) {
        if (activeSemanticScore >= 50 && inferredSemanticScore < activeSemanticScore + 30) {
          return { phase, attribution: 'active' };
        }
        return bindPendingPhaseForEvidence(inferredPhase, toolName, input);
      }
      const semanticPending = inferSemanticPhase(
        plan.phases.filter(p => p.status === 'pending' && phaseHasToolExpectation(p)),
        toolName,
        input,
      );
      if (semanticPending && phaseSemanticScore(semanticPending, toolName, input) >= 50) {
        return bindPendingPhaseForEvidence(semanticPending, toolName, input);
      }
      if (recentCompletedPhase) {
        const recentSemanticScore = recentCompletedScore;
        if (recentSemanticScore >= 50 && recentSemanticScore >= activeSemanticScore + 30) {
          return {
            phase: recentCompletedPhase,
            attribution: 'inferred',
            warning: localize(
              outputLanguage,
              `工具结果语义匹配刚完成的阶段 "${recentCompletedPhase.name}"，但当前已进入阶段 "${phase.name}"；已按并发工具回填绑定。`,
              `Tool result semantically matched recently completed phase "${recentCompletedPhase.name}" while phase "${phase.name}" is now active; bound as concurrent-tool backfill.`,
            ),
          };
        }
      }
      if (activeSemanticScore >= 50) {
        return { phase, attribution: 'active' };
      }
      return {
        phase,
        attribution: 'unexpected_tool',
        warning: localize(
          outputLanguage,
          `当前阶段 "${phase.name}" 未声明会调用 ${toolName}${skillId ? `(${skillId})` : ''}；此阶段归因需要人工核对。`,
          `Active phase "${phase.name}" did not declare ${toolName}${skillId ? `(${skillId})` : ''}; verify this phase attribution.`,
        ),
      };
    }

    const activeSemanticScore = phaseSemanticScore(phase, toolName, input);
    const semanticPending = inferSemanticPhase(
      plan.phases.filter(p => p.status === 'pending' && phaseHasToolExpectation(p)),
      toolName,
      input,
    );
    if (semanticPending) {
      const pendingSemanticScore = phaseSemanticScore(semanticPending, toolName, input);
      if (pendingSemanticScore >= 50 && pendingSemanticScore >= activeSemanticScore + 30) {
        return bindPendingPhaseForEvidence(semanticPending, toolName, input);
      }
    }

    return { phase, attribution: 'active' };
  }

  function createEvidenceProducerContext(
    toolName: string,
    input: Record<string, unknown>,
    producerReason: string,
    suffix?: string,
    phaseOverride?: EvidencePhaseOverride,
  ): EvidenceProducerContext {
    const summary = summarizeToolCallInput(toolName, input);
    const phaseResolution = phaseOverride?.phaseId
      ? undefined
      : activePlanPhaseForEvidence(toolName, input);
    const phase = phaseResolution?.phase;
    const lightweightPhase = !phaseOverride?.phaseId && !phase?.id && options.lightweight
      ? {
          id: 'quick',
          name: localize(outputLanguage, '快速回答', 'Quick answer'),
          goal: localize(outputLanguage, '用轻量工具链快速回答当前问题', 'Answer the current question with the lightweight tool chain.'),
        }
      : undefined;
    const paramsHash = summary.paramsHash || evidenceHash(input);
    const ordinal = ++evidenceProducerOrdinal;
    const sourceToolCallId = [
      toolName,
      ordinal,
      paramsHash,
      suffix,
    ].filter(Boolean).join(':');
    return {
      sourceToolCallId,
      paramsHash,
      planPhaseId: phaseOverride?.phaseId ?? phase?.id ?? lightweightPhase?.id,
      planPhaseTitle: phaseOverride?.phaseTitle ?? phase?.name ?? lightweightPhase?.name,
      planPhaseGoal: phaseOverride?.phaseGoal ?? phase?.goal ?? lightweightPhase?.goal,
      planPhaseAttribution: phaseOverride?.attribution ?? (lightweightPhase ? 'active' : phaseResolution?.attribution),
      planPhaseWarning: phaseOverride?.warning ?? phaseResolution?.warning,
      toolNarration: formatToolCallNarration(toolName, input, outputLanguage, toolNarrationOptions()),
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
    'Run raw SQL against the current Perfetto trace_processor trace. Use summary=true for large results (column stats + sample rows).\n\n' +
    'Use when: custom SQL is needed to verify a hypothesis or inspect raw trace data.\n' +
    'Don\'t use when: a skill covers the task (use invoke_skill), schema info is needed (lookup_sql_schema), or rows are already in an artifact (fetch_artifact; do not copy artifact rows into FROM (VALUES ...)).\n\n' +
    'SQL safety rules: qualify duplicate column names after JOINs; use s.name AS slice_name, s.ts, s.dur, t.name AS thread_name, p.name AS process_name, or prefer thread_slice. FrameTimeline rows expose upid, not utid/process_name; JOIN process USING(upid) for actual_frame_timeline_slice. For thread_slice self time, JOIN slice_self_dur USING(id); read thread_name/process_name directly unless you explicitly JOIN thread/process. The main-thread column is is_main_thread. Do not query __intrinsic_* names or skill step names such as batch_frame_root_cause as SQL tables; use fetch_artifact for skill artifact rows.\n\n' +
    'Examples:\n' +
    '1. Count jank frames: sql="SELECT COUNT(*) as jank_count FROM actual_frame_timeline_slice WHERE jank_type != \'None\'", summary=false\n' +
    '2. CPU frequency overview: sql="SELECT cpu, MIN(value) as min_freq, MAX(value) as max_freq, AVG(value) as avg_freq FROM counter JOIN counter_track ON counter.track_id=counter_track.id WHERE counter_track.name GLOB \'cpu*freq\' GROUP BY cpu", summary=true\n' +
    '3. Thread state in time range: sql="SELECT state, SUM(dur)/1e6 as total_ms FROM thread_state WHERE utid=123 AND ts BETWEEN 1000 AND 2000 GROUP BY state", summary=false',
    {
      sql: z.string().describe(
        'The SQL query to execute. Use Perfetto stdlib tables/functions (e.g. android_jank_cuj, slice, thread, process).'
      ),
      summary: z.boolean().optional().describe(
        'When true, returns column statistics (min/max/avg/percentiles) + 10 most interesting sample rows instead of full results. Use for large result sets where you need aggregate understanding, not row-level data. Default: false.'
      ),
    },
    async ({ sql, summary }, extra) => {
      const signal = getRuntimeToolSignal(extra);
      throwIfTraceProcessorQueryCancelled(signal);
      // P0-G10: Block analysis tools until plan is submitted
      const planError = requirePlan('execute_sql');
      if (planError) {
        return { content: [{ type: 'text' as const, text: planError }] };
      }
      const artifactSqlHint = artifactSqlMisuseHint(sql, outputLanguage);
      if (artifactSqlHint) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(artifactSqlHint) }],
          isError: true,
        };
      }
      const producer = createEvidenceProducerContext(
        'execute_sql',
        { sql, summary },
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
        const truncated = result.rows.length > 200;
        const rows = truncated ? result.rows.slice(0, 200) : result.rows;
        const success = !result.error;
        const sqlArtifact = success && result.columns.length > 0 && result.rows.length > SQL_RAW_INLINE_ROW_LIMIT
          ? storeSqlResultArtifact(artifactStore, {
              toolName: 'execute_sql',
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
                sqlRewrites,
                toolName: 'execute_sql',
              },
            );
            updateSqlArtifactQueryReview(artifactStore, sqlArtifact, emittedEvidence.queryReview);
          }
          return {
            content: [{
              type: 'text' as const,
              text: consumeWatchdogWarning(JSON.stringify({
                success: true,
                mode: 'summary',
                autoSummarized: !summary && !!sqlArtifact,
                totalRows: summaryResult.totalRows,
                columns: summaryResult.columns,
                columnStats: summaryResult.columnStats,
                sampleRows: summaryResult.sampleRows,
                ...(sqlArtifact ? {
                  artifactId: sqlArtifact.artifactId,
                  artifact: sqlArtifact.artifactSummary,
                  rowsAvailableViaArtifact: true,
                  pageSize: SQL_ARTIFACT_PAGE_SIZE,
                  hint: `Use fetch_artifact(artifactId="${sqlArtifact.artifactId}", detail="rows", offset=0, limit=${SQL_ARTIFACT_PAGE_SIZE}) to page full SQL rows.`,
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
              })) + getReasoningNudge(),
            }],
          };
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
              sqlRewrites,
              toolName: 'execute_sql',
              rowCount: result.rows.length,
            },
          );
        }

        return {
          content: [{
            type: 'text' as const,
            text: consumeWatchdogWarning(JSON.stringify(success ? {
              success,
              columns: result.columns,
              rows,
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
            })) + (success ? getReasoningNudge() : '')),
          }],
        };
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
    'Execute a named SmartPerfetto skill pipeline against the current trace. ' +
    'Skills are pre-built analysis routines that produce layered results (overview → list → diagnosis → deep). ' +
    'Use list_skills first to find the right skill ID when list_skills is available; quick mode may name the relevant skill in the prompt.\n\n' +
    'Use when: a pre-built skill covers your analysis need — always prefer this over raw SQL for supported scenarios.\n' +
    'Don\'t use when: you need a custom query not covered by any skill (use execute_sql), or exploring what skills exist (use list_skills).\n\n' +
    'Examples:\n' +
    '1. Full scrolling analysis: skillId="scrolling_analysis", params={process_name: "com.example.app"}\n' +
    '2. Single jank frame detail: skillId="jank_frame_detail", params={frame_id: 42, start_ts: 123, end_ts: 456, process_name: "com.example.app"}\n' +
    '3. Startup analysis: skillId="startup_analysis", params={process_name: "com.example.app"}\n' +
    '4. Selected range CPU scheduling/frequency: skillId="selection_range_cpu_sched_summary", params={start_ts: 123, end_ts: 456}',
    {
      skillId: z.string().describe('Skill identifier (e.g. "scrolling_analysis", "jank_frame_detail", "cpu_analysis")'),
      params: z.record(z.string(), z.any()).optional().describe(
        'Optional parameters to pass to the skill. Common: { process_name, start_ts, end_ts, max_frames_per_session }'
      ),
    },
    async ({ skillId, params }, extra) => {
      const signal = getRuntimeToolSignal(extra);
      throwIfTraceProcessorQueryCancelled(signal);
      // P0-G10: Block analysis tools until plan is submitted
      const skillPlanError = requirePlan('invoke_skill');
      if (skillPlanError) {
        return { content: [{ type: 'text' as const, text: skillPlanError }] };
      }

      if (skillId === 'detect_architecture') {
        const effectiveParams = normalizeSkillParams(params, packageName);
        const producer = createEvidenceProducerContext(
          'invoke_skill',
          { skillId, params: effectiveParams },
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
          const planGate = recordArchitecturePlanGate(payload as Partial<ArchitectureInfo>);
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
          return {
            content: [{
              type: 'text' as const,
              text: consumeWatchdogWarning(JSON.stringify({
                success: true,
                skillId: 'detect_architecture',
                delegatedTool: 'detect_architecture',
                sourceToolCallId: producer.sourceToolCallId,
                paramsHash: producer.paramsHash,
                planPhaseId: producer.planPhaseId,
                ...payload,
                ...planGate,
              })) + getReasoningNudge(),
            }],
          };
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

        const normalizedParams = normalizeSkillParams(params, packageName);
        const paramResolution = await resolveRegisteredDrillDownSkillParams({
          skillId,
          params: normalizedParams,
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
            skillId,
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
          },
          timestamp: Date.now(),
        });

        const skillStart = Date.now();
        const currentPaneSide = paneSideForTraceSide('current');
        const result = await skillExecutor.execute(skillId, traceId, effectiveParams, {
          ...(currentPaneSide ? { __paneSide: currentPaneSide } : {}),
          __outputLanguage: outputLanguage,
          signal,
        });
        const skillDuration = Date.now() - skillStart;

        emitUpdate?.({
          type: 'progress',
          content: {
            phase: 'analyzing',
            message: localize(
              outputLanguage,
              `技能 ${skillId} 完成 (${skillDuration}ms, ${result.displayResults?.length || 0} 个结果层)`,
              `Skill ${skillId} completed (${skillDuration}ms, ${result.displayResults?.length || 0} result layers)`,
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
        if (artifactStore && result.displayResults?.length) {
          artifacts = result.displayResults.map((dr, displayIndex) => {
            const evidenceRefId = stableSkillEvidenceRefId(
              result.skillId || skillId,
              dr.stepId,
              dr.title,
              dr.data,
              skillTraceProvenance,
              producer,
            );
            const artId = artifactStore.store({
              skillId: result.skillId || skillId,
              stepId: dr.stepId,
              layer: dr.layer,
              title: dr.title,
              data: dr.data,
              executionStatus: dr.executionStatus,
              executionMessage: dr.executionMessage,
              executionError: dr.executionError,
              diagnostics: undefined,
              planPhaseId: producer.planPhaseId,
              planPhaseTitle: producer.planPhaseTitle,
              planPhaseGoal: producer.planPhaseGoal,
              sourceToolCallId: producer.sourceToolCallId,
              paramsHash: producer.paramsHash,
              identityResolution: result.identityResolution,
            });
            const queryReview = buildSkillQueryReview({
              skillId: result.skillId || skillId,
              displayResult: dr as SkillDisplayResult,
              traceProvenance: skillTraceProvenance,
              producer,
              artifactId: artId,
              evidenceRefId,
            });
            if (queryReview) {
              artifactStore.updateQueryReview(artId, queryReview);
              queryReviewsByDisplayIndex[displayIndex] = queryReview;
            }
            artifactIdsByDisplayIndex[displayIndex] = artId;
            const summary = artifactStore.generateCompactSummary(artId);
            const preview = summary?.preview ?? previewFromColumnarData(dr.data);
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
            identityResolution: result.identityResolution,
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
                identityResolution: result.identityResolution,
              });
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
          {externalAuthored},
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
          const lightweightArtifacts = options.lightweight
            ? artifacts?.filter(summary => summary.rowCount > 0 || summary.preview).slice(0, 10)
            : artifacts;
          return {
            content: [{
              type: 'text' as const,
              text: skillNotesPrefix + consumeWatchdogWarning(JSON.stringify({
                success: result.success,
                skillId: result.skillId,
                skillName: localizedSkillName,
                ...(result.error ? { error: result.error } : {}),
                ...(paramResolution.audit ? {drillDownResolution: paramResolution.audit} : {}),
                ...(options.lightweight
                  ? {
                      quickMode: {
                        answerNow: true,
                        guidance: buildQuickArtifactGuidance(),
                      },
                    }
                  : {}),
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
                ...((!options.lightweight || !artifacts?.length) && synthesizeArtifacts && synthesizeArtifacts.length > 0
                  ? { synthesizeArtifacts }
                  : {}),
                ...(vendorOverrideHint ? { vendorOverride: vendorOverrideHint } : {}),
                hint: options.lightweight
                  ? 'Quick mode: answer from previews/evidenceRefId now; fetch artifacts only for explicit row-level follow-up.'
                  : 'Use fetch_artifact(artifactId=<id>, detail="rows", offset=0, limit=50) to page through large datasets. All data is accessible — use offset/limit to paginate.',
              })) + (result.success ? getReasoningNudge() : ''),
            }],
          };
        }

        // Default: return full displayResults (backward compatible)
        return {
          content: [{
            type: 'text' as const,
            text: skillNotesPrefix + consumeWatchdogWarning(JSON.stringify({
              success: result.success,
              skillId: result.skillId,
              skillName: localizedSkillName,
              ...(result.error ? { error: result.error } : {}),
              ...(paramResolution.audit ? {drillDownResolution: paramResolution.audit} : {}),
              ...(result.identityResolution ? { identityResolution: result.identityResolution } : {}),
              ...(vendorOverrideHint ? { vendorOverride: vendorOverrideHint } : {}),
              displayResults: localizedDisplayResults.map(dr => ({
                stepId: dr.stepId,
                title: dr.title,
                layer: dr.layer,
                data: dr.data,
                executionStatus: dr.executionStatus,
                executionMessage: dr.executionMessage,
                executionError: dr.executionError,
              })),
              diagnostics: localizedDiagnostics,
              synthesizeData: result.synthesizeData,
            })) + (result.success ? getReasoningNudge() : ''),
          }],
        };
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
        await bindSkillRuntimeRegistry();
        const allSkills = await skillAdapter.listSkills(outputLanguage);
        const filtered = category
          ? allSkills.filter(s =>
              s.keywords.some(k => k.toLowerCase().includes(category.toLowerCase())) ||
              s.tags?.some(t => t.toLowerCase().includes(category.toLowerCase())) ||
              s.id.toLowerCase().includes(category.toLowerCase())
            )
          : allSkills;
        return {
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
    {},
    async (_args, extra) => {
      const signal = getRuntimeToolSignal(extra);
      throwIfTraceProcessorQueryCancelled(signal);
      const producer = createEvidenceProducerContext(
        'detect_architecture',
        {},
        localize(outputLanguage, '检测渲染架构，确定后续分析路径。', 'Detect rendering architecture to choose the later analysis path.'),
      );
      try {
        const payload = await detectArchitecturePayload(signal);
        const planGate = recordArchitecturePlanGate(payload as Partial<ArchitectureInfo>);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              ...payload,
              sourceToolCallId: producer.sourceToolCallId,
              paramsHash: producer.paramsHash,
              planPhaseId: producer.planPhaseId,
              ...planGate,
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
  const fetchArtifact = artifactStore ? tool(
    'fetch_artifact',
    'Retrieve detailed data for a previously stored artifact from invoke_skill results. ' +
    'Supports pagination for large datasets — use offset/limit to page through rows without token overflow. ' +
    'Response includes totalRows and hasMore to guide pagination. ALL data is accessible; nothing is hidden.\n\n' +
    'Use when: you need detailed data from a previous invoke_skill result (artifacts are referenced by ID in skill responses). Analyze these rows directly; do not copy them into execute_sql as FROM (VALUES ...).\n' +
    'Don\'t use when: you need new data (use invoke_skill or execute_sql instead).\n' +
    'Always set purpose to one short sentence explaining why this artifact is needed for the current plan phase.\n\n' +
    'Examples:\n' +
    '1. Get summary of skill result: artifactId="art-1", detail="summary"\n' +
    '2. Page through jank frames: artifactId="art-2", detail="rows", offset=0, limit=50\n' +
    '3. Get next page: artifactId="art-2", detail="rows", offset=50, limit=50',
    {
      artifactId: z.string().describe('Artifact ID (e.g. "art-1") from a previous invoke_skill response'),
      detail: z.enum(['summary', 'rows', 'full']).optional().describe(
        'Detail level: summary (default, compact stats), rows (paginated data rows), full (complete original structure — use with caution on large artifacts)'
      ),
      offset: z.coerce.number().int().min(0).optional().describe(
        'Row offset for pagination (detail="rows" only). Default: 0. Use with limit to page through large datasets.'
      ),
      limit: z.coerce.number().int().min(1).max(200).optional().describe(
        'Maximum rows to return (detail="rows" only). Default: 50. Increase up to 200 if you need more rows per page.'
      ),
      purpose: z.string().optional().describe(
        'One short sentence explaining why this artifact is needed for the current plan phase. Used in the user-visible timeline.'
      ),
    },
    async ({ artifactId, detail, offset, limit, purpose }) => {
      const planRevisionError = requireNoPendingPlanRevision('fetch_artifact');
      if (planRevisionError) {
        return { content: [{ type: 'text' as const, text: planRevisionError }], isError: true };
      }
      const effectiveDetail = detail || 'summary';
      const normalizedOffset = coerceOptionalInteger(offset, 'offset', { min: 0 });
      const normalizedLimit = coerceOptionalInteger(limit, 'limit', { min: 1, max: 200 });
      const paginationErrors = [normalizedOffset.error, normalizedLimit.error].filter(Boolean);
      const producerReason = purpose || localize(
        outputLanguage,
        '读取前序证据表的明细数据，用于当前阶段判断。',
        'Read detailed rows from a previous evidence artifact for the current phase.',
      );
      if (paginationErrors.length > 0) {
        const producer = createEvidenceProducerContext(
          'fetch_artifact',
          { artifactId, detail: effectiveDetail, offset, limit, purpose },
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
      const originPhase = result?.planPhaseId
        ? {
            phaseId: result.planPhaseId,
            phaseTitle: result.planPhaseTitle,
            phaseGoal: result.planPhaseGoal,
            attribution: 'inferred' as const,
          }
        : undefined;
      const producer = createEvidenceProducerContext(
        'fetch_artifact',
        {
          artifactId,
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
        undefined,
        originPhase,
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
        ? buildActivePhaseReminder(analysisPlanRef?.current, options.sceneType)
        : '';
      const payload = JSON.stringify({
        success: true,
        detail: effectiveDetail,
        ...result,
        sourceToolCallId: result?.sourceToolCallId || producer.sourceToolCallId,
        fetchedByToolCallId: producer.sourceToolCallId,
        paramsHash: producer.paramsHash,
        planPhaseId: producer.planPhaseId,
        planPhaseTitle: producer.planPhaseTitle,
        planPhaseGoal: producer.planPhaseGoal,
        planPhaseAttribution: producer.planPhaseAttribution,
        sourceArtifactId: artifactId,
        ...(purpose ? { purpose } : {}),
      });
      return {
        content: [{
          type: 'text' as const,
          text: reminder ? payload + reminder : payload,
        }],
      };
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
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(retrievedData({success: true, result: evaluated})),
          }],
        };
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
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(retrievedData({success: true, result: evaluated})),
          }],
        };
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
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(retrievedData({...evaluated})),
        }],
      };
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
      const result = ragStore.search(query, {
        topK: top_k ?? 5,
        kinds: ['aosp'],
        ...(effectiveCodebaseIds.length > 0 ? {codebaseIds: effectiveCodebaseIds} : {}),
        ...(buildId ? {buildId} : {}),
        ...(symbolExact ? {symbolExact} : {}),
        ...(pathPrefix ? {pathPrefix} : {}),
        scope: knowledgeScope,
        activeCodebaseGenerations: activeCodebaseGenerations(effectiveCodebaseIds),
      });
      if (result.results.some(hit => hit.chunk?.registryOrigin === 'codebase_registry')) {
        const scopedResult = {
          ...result,
          results: result.results.filter(hit =>
            hit.chunk?.registryOrigin !== 'codebase_registry' ||
            (hit.chunk.codebaseId && effectiveCodebaseIds.includes(hit.chunk.codebaseId))),
        };
        const filtered = await filterRagLookup(scopedResult, {
          toolName: 'lookup_aosp_source',
          turn: 0,
          codebaseRegistry,
          ledger: codeLookupLedger,
          allowProviderSend: codeAwareMode === 'provider_send',
          sessionId: options.sessionId,
          knowledgeScope,
        });
        await codeLookupLedger?.flush();
        assertPrivateAnalysisContextCurrent();
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(retrievedData({success: true, result: filtered})) }],
        };
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(retrievedData({...result})) }],
      };
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
      const result = ragStore.search(query, {
        topK: top_k ?? 5,
        kinds: ['oem_sdk'],
        ...(effectiveCodebaseIds.length > 0 ? {codebaseIds: effectiveCodebaseIds} : {}),
        ...(vendorId ? {vendor: vendorId} : {}),
        scope: knowledgeScope,
        activeCodebaseGenerations: activeCodebaseGenerations(effectiveCodebaseIds),
      });
      if (result.results.some(hit => hit.chunk?.registryOrigin === 'codebase_registry')) {
        const scopedResult = {
          ...result,
          results: result.results.filter(hit =>
            hit.chunk?.registryOrigin !== 'codebase_registry' ||
            (hit.chunk.codebaseId && effectiveCodebaseIds.includes(hit.chunk.codebaseId))),
        };
        const filtered = await filterRagLookup(scopedResult, {
          toolName: 'lookup_oem_sdk',
          turn: 0,
          codebaseRegistry,
          ledger: codeLookupLedger,
          allowProviderSend: codeAwareMode === 'provider_send',
          sessionId: options.sessionId,
          knowledgeScope,
        });
        await codeLookupLedger?.flush();
        assertPrivateAnalysisContextCurrent();
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(retrievedData({success: true, result: filtered})) }],
        };
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(retrievedData({...result})) }],
      };
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

  const resolveOnDemandCodebaseId = (requested: unknown): string | undefined => {
    const codebaseId = normalizeOptionalToolString(requested);
    if (codebaseId) return codebaseIds.includes(codebaseId) ? codebaseId : undefined;
    return codebaseIds.length === 1 ? codebaseIds[0] : undefined;
  };
  const onDemandSourceTokens = (result: {
    matches?: Array<{text?: string}>;
    reference?: {text?: string};
  }): number => {
    const text = result.matches?.map(match => match.text ?? '').join('\n') ?? result.reference?.text ?? '';
    return text ? Math.max(1, Math.ceil(text.length / 4)) : 0;
  };
  const recordOnDemandSourceLookup = async (input: {
    toolName: 'search_codebase' | 'read_codebase_file';
    codebaseId: string;
    tokensSpent: number;
    returnedReferenceCount: number;
    outcome: 'success' | 'budget_exceeded' | 'consent_blocked' | 'rejected';
  }): Promise<void> => {
    codeLookupLedger?.record({
      turn: 0,
      ts: Date.now(),
      toolName: input.toolName,
      codebaseId: input.codebaseId,
      chunkIds: [],
      consentApplied: codeAwareMode === 'provider_send',
      tokensSpent: input.tokensSpent,
      outcome: input.outcome,
      legacyPath: false,
      returnedReferenceCount: input.returnedReferenceCount,
    });
    await codeLookupLedger?.flush();
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
      const result = await onDemandSourceAccess.search({
        codebaseId,
        scope: knowledgeScope ?? {},
        query,
        mode: codeAwareMode,
        pathPrefix: normalizeOptionalToolString(path_prefix),
        maxResults: max_results,
      });
      const tokensSpent = onDemandSourceTokens(result);
      if (codeLookupLedger && tokensSpent > codeLookupLedger.remainingTokens()) {
        await recordOnDemandSourceLookup({
          toolName: 'search_codebase',
          codebaseId,
          tokensSpent: 0,
          returnedReferenceCount: 0,
          outcome: 'budget_exceeded',
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
      await recordOnDemandSourceLookup({
        toolName: 'search_codebase',
        codebaseId,
        tokensSpent,
        returnedReferenceCount: result.success ? result.matches?.length ?? 0 : 0,
        outcome: result.success
          ? 'success'
          : result.unsupportedReason?.includes('consent') ? 'consent_blocked' : 'rejected',
      });
      assertPrivateAnalysisContextCurrent();
      return {
        content: [{type: 'text' as const, text: JSON.stringify(retrievedData({...result}))}],
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
      const result = await onDemandSourceAccess.read({
        codebaseId,
        scope: knowledgeScope ?? {},
        filePath: file_path,
        startLine: start_line,
        maxLines: max_lines,
        mode: codeAwareMode,
      });
      const tokensSpent = onDemandSourceTokens(result);
      if (codeLookupLedger && tokensSpent > codeLookupLedger.remainingTokens()) {
        await recordOnDemandSourceLookup({
          toolName: 'read_codebase_file',
          codebaseId,
          tokensSpent: 0,
          returnedReferenceCount: 0,
          outcome: 'budget_exceeded',
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
      await recordOnDemandSourceLookup({
        toolName: 'read_codebase_file',
        codebaseId,
        tokensSpent,
        returnedReferenceCount: result.success && result.reference ? 1 : 0,
        outcome: result.success
          ? 'success'
          : result.unsupportedReason?.includes('consent') ? 'consent_blocked' : 'rejected',
      });
      assertPrivateAnalysisContextCurrent();
      return {
        content: [{type: 'text' as const, text: JSON.stringify(retrievedData({...result}))}],
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
      const result = await codeGraphNavigator.query({
        codebaseId,
        scope: knowledgeScope ?? {},
        query,
        limit: max_results,
      });
      const tokensSpent = graphMetadataTokens(result);
      if (codeLookupLedger && tokensSpent > codeLookupLedger.remainingTokens()) {
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
      await recordCodeGraphLookup({
        toolName: 'query_code_graph',
        codebaseId,
        tokensSpent,
        returnedReferenceCount: result.references.length,
        outcome: result.success ? 'success' : 'rejected',
      });
      assertPrivateAnalysisContextCurrent();
      return {
        content: [{type: 'text' as const, text: JSON.stringify(retrievedData({...result}))}],
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
      const result = await codeGraphNavigator.inspectSymbol({
        codebaseId,
        scope: knowledgeScope ?? {},
        symbol,
        filePath: normalizeOptionalToolString(file_path),
        limit: max_relations,
      });
      const tokensSpent = graphMetadataTokens(result);
      if (codeLookupLedger && tokensSpent > codeLookupLedger.remainingTokens()) {
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
      await recordCodeGraphLookup({
        toolName: 'inspect_code_symbol',
        codebaseId,
        tokensSpent,
        returnedReferenceCount: result.references.length,
        outcome: result.success ? 'success' : 'rejected',
      });
      assertPrivateAnalysisContextCurrent();
      return {
        content: [{type: 'text' as const, text: JSON.stringify(retrievedData({...result}))}],
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
      const raw = ragStore.search(query, {
        topK: top_k ?? 5,
        kinds: ['app_source'],
        codebaseIds: allowed,
        ...(symbolExact ? {symbolExact} : {}),
        ...(filePath ? {filePathExact: filePath} : {}),
        ...(pathPrefix ? {pathPrefix} : {}),
        scope: knowledgeScope,
        activeCodebaseGenerations: activeCodebaseGenerations(allowed),
      });
      const filtered = await filterRagLookup(raw, {
        toolName: 'lookup_app_source',
        turn: 0,
        codebaseRegistry,
        ledger: codeLookupLedger,
        allowProviderSend: codeAwareMode === 'provider_send',
        sessionId: options.sessionId,
        knowledgeScope,
      });
      await codeLookupLedger?.flush();
      assertPrivateAnalysisContextCurrent();
      return {
        content: [{type: 'text' as const, text: JSON.stringify(retrievedData({success: true, result: filtered}))}],
      };
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
      const raw = ragStore.search(query, {
        topK: top_k ?? 5,
        kinds: ['kernel_source'],
        codebaseIds: kernelRefs.map(ref => ref!.codebaseId),
        ...(vendorId ? {vendor: vendorId} : {}),
        ...(symbolExact ? {symbolExact} : {}),
        ...(pathPrefix ? {pathPrefix} : {}),
        scope: knowledgeScope,
        activeCodebaseGenerations: activeCodebaseGenerations(kernelRefs.map(ref => ref!.codebaseId)),
      });
      const filtered = await filterRagLookup(raw, {
        toolName: 'lookup_kernel_source',
        turn: 0,
        codebaseRegistry,
        ledger: codeLookupLedger,
        allowProviderSend: codeAwareMode === 'provider_send',
        sessionId: options.sessionId,
        knowledgeScope,
      });
      await codeLookupLedger?.flush();
      assertPrivateAnalysisContextCurrent();
      return {
        content: [{type: 'text' as const, text: JSON.stringify(retrievedData({success: true, result: filtered}))}],
      };
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
      const results = allowed.map(id => {
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
      });
      assertPrivateAnalysisContextCurrent();
      return {
        content: [{type: 'text' as const, text: JSON.stringify({
          success: results.some(result => result.success),
          results,
        })}],
      };
    },
    {annotations: {readOnlyHint: true}},
  );

  const proposePatch = tool(
    'propose_patch',
    'Use when the user asks for a concrete fix after successful code lookup. Do NOT use before lookup_app_source/lookup_kernel_source/lookup_aosp_source has returned prior contextChunkIds. ' +
    'Prerequisites: all contextChunkIds must belong to one whitelisted codebase and provider_send consent must be enabled. Budget: patch attempts are capped by the session ledger. Outcomes: verified diff, non-copyable sketch, or unverified rejection.',
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
    'Submit your structured analysis plan BEFORE starting any analysis. ' +
    'Define phases with goals and expected tools. The system tracks plan adherence and warns on deviation. ' +
    'You MUST call this tool as your first action in every analysis.\n\n' +
    'Use when: starting any new analysis — this is mandatory before execute_sql or invoke_skill.\n' +
    'Don\'t use when: plan already submitted (use revise_plan to modify, update_plan_phase to track progress).\n\n' +
    'Examples:\n' +
    '1. Scrolling plan: phases=[{id:"p1", name:"概览采集", goal:"获取帧统计和卡顿分布", expectedTools:["invoke_skill"], expectedCalls:[{tool:"invoke_skill", skillId:"scrolling_analysis"}]}, ' +
    '{id:"p2", name:"根因分析", goal:"逐帧诊断卡顿原因", expectedTools:["invoke_skill","execute_sql"], expectedCalls:[{tool:"invoke_skill", skillId:"jank_frame_detail"}]}, ' +
    '{id:"p3", name:"深入验证", goal:"验证根因假设", expectedTools:["execute_sql","fetch_artifact"]}], ' +
    'successCriteria="识别卡顿根因并提供量化证据"',
    {
      phases: PLAN_PHASES_ARG_SCHEMA.optional().describe('Ordered list of analysis phases, or a JSON string encoding that list.'),
      phase_list: PLAN_PHASES_ARG_SCHEMA.optional().describe('Alias for phases for OpenAI-compatible callers.'),
      successCriteria: z.string().optional().describe('What constitutes a successful analysis (e.g. "Identify root cause of jank frames with evidence")'),
      success_criteria: z.string().optional().describe('Alias for successCriteria for OpenAI-compatible callers.'),
      waivers: PLAN_WAIVERS_ARG_SCHEMA.optional().describe('Optional opt-outs for scene-template aspects when the trace genuinely cannot support them.'),
    },
    async (args: any) => {
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

      const normalizedPhases = moveConclusionPhasesLast(
        phaseInputs.map(normalizePlanPhaseToolInput),
      );
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
      const unavailableExpectedSkills = collectUnavailableExpectedSkillErrors(
        normalizedPhases,
        expectedSkillRegistry,
        new Set(registry.listForRequest(toolRequestScope).map(toolDefinition => toolDefinition.name)),
      );
      if (unavailableExpectedSkills.length > 0) {
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
              action_required: 'submit_plan',
              hint: 'Use a tool exposed in this session; for invoke_skill/compare_skill, call list_skills and choose a registered analysis Skill.',
            }),
          }],
          isError: true,
        };
      }

      // P1-G11: Validate against the scene template, honouring agent waivers.
      const validation = validatePhasesAgainstSceneTemplate(normalizedPhases, waiverInputs);
      const { warnings: planWarnings, missingAspectIds } = validation;
      const nonWaivableMissingAspectIds = validation.nonWaivableMissingAspectIds ?? [];

      // Track only waivers whose reason met the minimum threshold; the rest
      // are reported back so the agent knows they didn't count.
      const acceptedWaivers = waiverInputs.filter(
        w => typeof w.reason === 'string' && w.reason.trim().length >= MIN_WAIVER_REASON_CHARS,
      );
      const tooShortWaivers = waiverInputs.filter(
        w => !acceptedWaivers.some(a => a.aspectId === w.aspectId),
      );

      planSubmitAttempts++;

      // Phase 2.3: 真硬拦截 — keep rejecting until plan covers all aspects
      // or supplies a substantial waiver. Strategy-owned non-waivable aspects
      // cannot be force-accepted because they encode execution-time quality gates.
      if (planWarnings.length > 0 &&
        (planSubmitAttempts < MAX_PLAN_ATTEMPTS || nonWaivableMissingAspectIds.length > 0)) {
        console.log(`[MCP] Plan rejected (attempt ${planSubmitAttempts}/${MAX_PLAN_ATTEMPTS}): missing ${missingAspectIds.length} aspects for ${options.sceneType ?? 'unknown scene'}`);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(buildPlanGateRejectPayload({
              missingAspectIds,
              nonWaivableMissingAspectIds,
              planWarnings,
              missingAspectRequirements: validation.missingAspectRequirements ?? [],
              attempt: planSubmitAttempts,
              tooShortWaivers,
              mode: 'submit_plan',
            })),
          }],
          isError: true,
        };
      }

      const forcedAccept = planWarnings.length > 0; // hit the attempt cap
      const plan: AnalysisPlanV3 = {
        phases: normalizedPhases.map((p): PlanPhase => ({
          ...p,
          status: 'pending' as const,
        })),
        successCriteria: normalizedSuccessCriteria,
        submittedAt: Date.now(),
        toolCallLog: [],
        ...(acceptedWaivers.length > 0 ? { waivers: acceptedWaivers } : {}),
        ...(forcedAccept ? { unresolvedAspects: missingAspectIds } : {}),
      };
      analysisPlanRef.current = plan;
      replayPrePlanToolCalls(analysisPlanRef);
      clearPendingPlanRevisionGate(plan);
      planReviseAttempts = 0;
      if (!forcedAccept) planSubmitAttempts = 0;

      if (forcedAccept) {
        console.warn(`[MCP] Plan force-accepted at attempt ${planSubmitAttempts} with ${missingAspectIds.length} unresolved aspects: ${missingAspectIds.join(', ')}`);
      }

      emitUpdate?.({
        type: 'plan_submitted',
        content: {
          phases: plan.phases.map(p => ({ id: p.id, name: p.name, goal: p.goal, status: p.status })),
          successCriteria: normalizedSuccessCriteria,
        },
        timestamp: Date.now(),
      });

      const response: Record<string, any> = { success: true };
      if (acceptedWaivers.length > 0) {
        response.acceptedWaivers = acceptedWaivers.map(w => w.aspectId);
      }
      if (tooShortWaivers.length > 0) {
        response.tooShortWaivers = tooShortWaivers;
        response.waiverHint = localize(
          outputLanguage,
          `已忽略 ${tooShortWaivers.length} 条理由不足 ${MIN_WAIVER_REASON_CHARS} 字符的 waiver。`,
          `Ignored ${tooShortWaivers.length} waiver(s) whose reason is shorter than ${MIN_WAIVER_REASON_CHARS} characters.`,
        );
      }
      if (forcedAccept) {
        response.unresolvedAspects = missingAspectIds;
        response.warning = localize(
          outputLanguage,
          `已强制接受 plan（达到第 ${MAX_PLAN_ATTEMPTS} 次尝试上限），但未覆盖的 aspect 会在最终 verifier 中报错。`,
          `Plan force-accepted after reaching the ${MAX_PLAN_ATTEMPTS}-attempt limit, but uncovered aspects will be reported by the final verifier.`,
        );
      }
      const firstExecutionPhase = plan.phases.find(p => !isConclusionLikePlanPhase(p)) || plan.phases[0];
      const firstPhaseDetail = buildStrategyDetailDelivery(firstExecutionPhase, 'first_phase');
      if (firstPhaseDetail) {
        response.first_phase_detail = firstPhaseDetail;
      }
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
    'Update the status of a plan phase. Call this when transitioning between phases or when skipping a phase. ' +
    'This helps track analysis progress and enables plan adherence verification. ' +
    'When completing a phase, you MUST provide a summary with key evidence collected (e.g. "发现 5 帧卡顿，主因是 RenderThread 阻塞，最长耗时 45ms"). ' +
    'When skipping, explain why (e.g. "trace 中无启动数据，跳过启动分析").',
    {
      phaseId: z.string().describe('Phase ID to update (e.g. "p1")'),
      status: z.enum(['in_progress', 'completed', 'skipped', 'active']).optional().describe('New phase status. "active" is accepted as an alias for "in_progress".'),
      phaseStatus: z.enum(['in_progress', 'completed', 'skipped', 'active']).optional().describe('Compatibility alias for status. If both are present, they must resolve to the same status.'),
      summary: z.string().optional().describe('REQUIRED for completed/skipped: key evidence or reason. Must include specific data (numbers, names, findings).'),
    },
    async ({ phaseId, status, phaseStatus, summary }) => {
      const statusResolution = resolvePlanPhaseUpdateStatus(status, phaseStatus);
      if ('error' in statusResolution) {
        const error = statusResolution.error === 'missing'
          ? localize(outputLanguage, '必须提供 status 或 phaseStatus。', 'Provide status or phaseStatus.')
          : statusResolution.error === 'conflict'
            ? localize(outputLanguage, 'status 与 phaseStatus 冲突。', 'status and phaseStatus conflict.')
            : localize(outputLanguage, 'status/phaseStatus 不是支持的阶段状态。', 'status/phaseStatus is not a supported phase status.');
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error,
              action_required: 'retry_update_plan_phase_with_valid_status',
            }),
          }],
          isError: true,
        };
      }
      const normalizedStatus = statusResolution.status;
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

      const phase = plan.phases.find(p => p.id === phaseId);
      if (!phase) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: localize(outputLanguage, `plan 中没有找到阶段 "${phaseId}"`, `Phase "${phaseId}" not found in plan`),
            }),
          }],
          isError: true,
        };
      }

      const trimmedSummary = summary?.trim();
      if ((normalizedStatus === 'completed' || normalizedStatus === 'skipped') && pendingPlanRevisionGate) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(buildPendingPlanRevisionResponse('update_plan_phase')),
          }],
          isError: true,
        };
      }
      if ((normalizedStatus === 'completed' || normalizedStatus === 'skipped') &&
        (!trimmedSummary || trimmedSummary.length < MIN_PHASE_SUMMARY_CHARS)) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: localize(
                outputLanguage,
                `阶段 ${phaseId} 的 summary 太短。完成/跳过阶段时必须给出具体证据、数据或原因，至少 ${MIN_PHASE_SUMMARY_CHARS} 个字符。`,
                `Phase ${phaseId} summary is too brief. Completed/skipped phases require concrete evidence, data, or reason with at least ${MIN_PHASE_SUMMARY_CHARS} characters.`,
              ),
              action_required: 'retry_update_plan_phase_with_evidence',
            }),
          }],
          isError: true,
        };
      }

      if (normalizedStatus === 'skipped' && isConclusionLikePlanPhase(phase)) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: localize(
                outputLanguage,
                `阶段 ${phaseId} 是最终结论阶段，不能标记为 skipped。请先补齐必要证据，然后将该阶段标记为 completed，并输出最终结论。`,
                `Phase ${phaseId} is the final conclusion phase and cannot be skipped. Collect the required evidence first, then mark it completed and produce the final conclusion.`,
              ),
              action_required: 'complete_final_conclusion_phase',
              currentPhaseId: phase.id,
              currentPhaseName: phase.name,
            }),
          }],
          isError: true,
        };
      }

      if (normalizedStatus === 'skipped' && (phase.expectedCalls ?? []).length > 0) {
        const missingExpectedCalls = findMissingExpectedCallsForPhase(
          phase,
          Array.isArray(plan.toolCallLog) ? plan.toolCallLog : [],
        );
        if (missingExpectedCalls.length > 0 && !skipSummaryExplainsEvidenceBoundary(trimmedSummary!)) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: localize(
                  outputLanguage,
                  `阶段 ${phaseId} 声明了关键证据调用，不能仅因已有初步根因或认为不再重要而跳过。请先执行缺失调用；只有条件未触发或 Trace/参数确实不可用时，才能以具体证据边界标记 skipped。`,
                  `Phase ${phaseId} declares critical evidence calls and cannot be skipped merely because a preliminary root cause already looks likely. Run the missing calls first; only an unmet condition or genuinely unavailable trace data/parameters can justify skipped.`,
                ),
                action_required: 'run_expected_calls_or_explain_unavailability',
                currentPhaseId: phase.id,
                currentPhaseName: phase.name,
                missingExpectedCalls,
              }),
            }],
            isError: true,
          };
        }
      }

      const semanticMismatch = findPhaseSemanticMismatch(plan, phase, trimmedSummary);
      if (normalizedStatus === 'completed' && !semanticMismatch) {
        const prospectivePlan: AnalysisPlanV3 = {
          ...plan,
          phases: plan.phases.map(p =>
            p.id === phase.id
              ? {
                  ...p,
                  status: 'completed' as const,
                  summary: trimmedSummary,
                  completedAt: Date.now(),
                }
              : p,
          ),
        };
        const evidenceGap = findCompletedPhaseEvidenceGaps(prospectivePlan)
          .find(gap => gap.phase.id === phase.id);
        if (evidenceGap) {
          const message = formatPlanEvidenceGap(evidenceGap, outputLanguage);
          const missingGenericToolEvidence = Boolean(evidenceGap.missingGenericToolEvidence);
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: localize(
                  outputLanguage,
                  `${message}。请先调用缺失的关键工具，或如果数据确实不可用则将阶段标记为 skipped 并说明原因。`,
                  `${message}. Call the missing required tool first, or mark the phase skipped with a concrete reason if the data is genuinely unavailable.`,
                ),
                action_required: missingGenericToolEvidence
                  ? 'run_expected_tools_before_completing_phase'
                  : 'run_expected_calls_before_completing_phase',
                currentPhaseId: phase.id,
                currentPhaseName: phase.name,
                missingExpectedCalls: evidenceGap.missingExpectedCalls,
                ...(missingGenericToolEvidence
                  ? {expectedTools: phase.expectedTools}
                  : {}),
              }),
            }],
            isError: true,
          };
        }
      }

      if (semanticMismatch) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: localize(
                outputLanguage,
                `阶段 ${phaseId} 是「${phase.name}」，但 summary 更像「${PHASE_SEMANTIC_LABELS[semanticMismatch.summaryKind]}」。请改用阶段 ${semanticMismatch.suggestedPhase.id}（${semanticMismatch.suggestedPhase.name}）或重写 summary。`,
                `Phase ${phaseId} is "${phase.name}", but the summary looks like "${PHASE_SEMANTIC_LABELS[semanticMismatch.summaryKind]}". Use phase ${semanticMismatch.suggestedPhase.id} (${semanticMismatch.suggestedPhase.name}) or rewrite the summary.`,
              ),
              action_required: 'retry_update_plan_phase_with_correct_phase',
              currentPhaseId: phase.id,
              currentPhaseName: phase.name,
              suggestedPhaseId: semanticMismatch.suggestedPhase.id,
              suggestedPhaseName: semanticMismatch.suggestedPhase.name,
              detectedSummaryKind: semanticMismatch.summaryKind,
            }),
          }],
          isError: true,
        };
      }

      if (normalizedStatus === 'in_progress') {
        closeSupersededInProgressPhases(plan, phase);
        phase.completedAt = undefined;
        phase.summary = undefined;
      }

      phase.status = normalizedStatus;
      if (normalizedStatus === 'completed' || normalizedStatus === 'skipped') {
        phase.completedAt = Date.now();
        phase.summary = trimmedSummary;
      }

      emitUpdate?.({
        type: 'plan_phase_updated',
        content: { phaseId, status: normalizedStatus, summary: trimmedSummary || '', phaseName: phase.name },
        timestamp: Date.now(),
      });

      // Report overall plan progress
      const allPhasesClosed =
        plan.phases.every(p => p.status === 'completed' || p.status === 'skipped') &&
        findCompletedPhaseEvidenceGaps(plan).length === 0;
      const nextPhase = plan.phases.find(p => p.status === 'pending');

      // Compact return: only include feedback when needed (normal path = minimal ACK)
      const response: Record<string, any> = { success: true };
      if (allPhasesClosed) response.allPhasesComplete = true;

      // Restatement injection: leverage tool response's high-attention position
      // to re-state next-phase constraints from strategy frontmatter phase_hints.
      // Match logic lives in `phaseHintMatcher` so it can be unit tested.
      const shouldReportNextPhase = normalizedStatus === 'completed' || normalizedStatus === 'skipped';
      if (shouldReportNextPhase && nextPhase && options.sceneType) {
        const hints = getPhaseHints(options.sceneType);
        const matchedHint = matchPhaseHintForNextPhase({
          hints,
          nextPhase: { name: nextPhase.name, goal: nextPhase.goal },
          finishedPhases: plan.phases.map(p => ({
            name: p.name,
            goal: p.goal,
            summary: p.summary,
            status: p.status,
          })),
        });

        if (matchedHint) {
          const contentHash =
            evaluationPhaseHintInjectionContentHash(matchedHint);
          const decision = registerEvaluationInjection({
            category: 'phaseHints',
            id: matchedHint.id,
            contentHash,
            placement: 'mcp:update_plan_phase',
          });
          if (decision.allowed) {
            runManifestAttributionSink?.recordInjection(
              'phaseHints',
              matchedHint.id,
              contentHash,
            );
            response.next_phase_reminder = {
              phaseId: nextPhase.id,
              name: nextPhase.name,
              constraints: matchedHint.constraints,
              criticalTools: matchedHint.criticalTools,
            };
            console.log(`[MCP] Phase hint injected: ${matchedHint.id} for ${options.sceneType}`);
          }
        } else if (hints.length > 0) {
          console.log(
            `[MCP] Phase hint not found for ${options.sceneType}: ` +
            diagnosticLogIdentity(nextPhase.name),
          );
        }

        // Always include basic next phase info for non-hint scenarios
        if (!response.next_phase_reminder) {
          response.next = {
            phaseId: nextPhase.id,
            name: nextPhase.name,
            expectedTools: nextPhase.expectedTools,
          };
        }
        const nextPhaseDetail = buildStrategyDetailDelivery(nextPhase, 'next_phase');
        if (nextPhaseDetail) {
          response.next_phase_detail = nextPhaseDetail;
        }
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(response),
        }],
      };
    }
  ) : null;

  // P1-3: Dynamic replan — allows Claude to revise the plan mid-analysis when new information emerges
  const revisePlan = analysisPlanRef ? tool(
    'revise_plan',
    'Revise your analysis plan mid-execution when new information changes priorities. ' +
    'Use this when initial data reveals unexpected conditions (e.g., discovered Flutter architecture but planned for Standard, ' +
    'or found ANR signals in a scrolling query). Preserves completed phases and audit trail.',
    {
      reason: z.string().optional().describe('Why the plan needs revision (what new information triggered this)'),
      reason_text: z.string().optional().describe('Alias for reason for OpenAI-compatible callers.'),
      updatedPhases: PLAN_PHASES_ARG_SCHEMA.optional().describe('The revised phase list, or a JSON string encoding it. Must include all completed/in-progress phases from original plan.'),
      updated_phases: PLAN_PHASES_ARG_SCHEMA.optional().describe('Alias for updatedPhases for OpenAI-compatible callers.'),
      updatedSuccessCriteria: z.string().optional().describe('Updated success criteria (only if the goal changed)'),
      updated_success_criteria: z.string().optional().describe('Alias for updatedSuccessCriteria for OpenAI-compatible callers.'),
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

      const normalizedUpdatedPhases = moveConclusionPhasesLast(
        updatedPhaseInputs.map((p): NormalizedPlanPhaseToolInput => ({
          ...normalizePlanPhaseToolInput(p),
          status: normalizePlanPhaseStatus(readAliasedField(p, ['status'])),
        })),
      );
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
              action_required: 'revise_plan',
              hint: 'Use a tool exposed in this session; for invoke_skill/compare_skill, call list_skills and choose a registered analysis Skill.',
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
          return { ...original };
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

      const validation = validatePhasesAgainstSceneTemplate(candidatePhases, waiverInputs);
      const revisedPlanWarnings = validation.warnings;
      const missingAspectIds = validation.missingAspectIds;
      const nonWaivableMissingAspectIds = validation.nonWaivableMissingAspectIds ?? [];
      const acceptedWaivers = waiverInputs.filter(
        w => typeof w.reason === 'string' && w.reason.trim().length >= MIN_WAIVER_REASON_CHARS,
      );
      const tooShortWaivers = waiverInputs.filter(
        w => !acceptedWaivers.some(a => a.aspectId === w.aspectId),
      );

      planReviseAttempts++;
      if (revisedPlanWarnings.length > 0 &&
        (planReviseAttempts < MAX_PLAN_ATTEMPTS || nonWaivableMissingAspectIds.length > 0)) {
        console.log(`[MCP] Revised plan rejected (attempt ${planReviseAttempts}/${MAX_PLAN_ATTEMPTS}): missing ${missingAspectIds.length} aspects for ${options.sceneType ?? 'unknown scene'}`);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(buildPlanGateRejectPayload({
              missingAspectIds,
              nonWaivableMissingAspectIds,
              planWarnings: revisedPlanWarnings,
              missingAspectRequirements: validation.missingAspectRequirements ?? [],
              attempt: planReviseAttempts,
              tooShortWaivers,
              mode: 'revise_plan',
            })),
          }],
          isError: true,
        };
      }
      const forcedAccept = revisedPlanWarnings.length > 0;

      const expectedCallKey = (call: NonNullable<PlanPhase['expectedCalls']>[number]): string =>
        `${shortExpectedToolName(call.tool)}:${call.skillId ? shortExpectedToolName(call.skillId) : ''}`;
      const updatedPhaseById = new Map(normalizedUpdatedPhases.map(phase => [phase.id, phase]));
      const weakenedPhases = plan.phases.flatMap(original => {
        if (original.status === 'completed' || original.status === 'skipped') return [];
        const updated = updatedPhaseById.get(original.id);
        const updatedCallKeys = new Set((updated?.expectedCalls ?? []).map(expectedCallKey));
        const removedExpectedCalls = (original.expectedCalls ?? [])
          .filter(call => !updatedCallKeys.has(expectedCallKey(call)));
        return removedExpectedCalls.length > 0
          ? [{ phaseId: original.id, removedExpectedCalls }]
          : [];
      });
      if (weakenedPhases.length > 0) {
        planReviseAttempts = 0;
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
        previousPhases: plan.phases.map(p => ({ ...p })),
      };
      if (!plan.revisionHistory) plan.revisionHistory = [];
      plan.revisionHistory.push(revision);

      // Apply revision: merge completed phase data (summary, completedAt) with updated structure
      plan.phases = candidatePhases;
      clearPendingPlanRevisionGate(plan);

      const normalizedUpdatedSuccessCriteria = coercePlanString(
        readAliasedField(args, ['updatedSuccessCriteria', 'updated_success_criteria']),
      );
      if (normalizedUpdatedSuccessCriteria) {
        plan.successCriteria = normalizedUpdatedSuccessCriteria;
      }
      if (acceptedWaivers.length > 0) {
        plan.waivers = acceptedWaivers;
      }
      if (forcedAccept) {
        plan.unresolvedAspects = Array.from(new Set([
          ...(plan.unresolvedAspects ?? []),
          ...missingAspectIds,
        ]));
      } else if (plan.unresolvedAspects) {
        plan.unresolvedAspects = plan.unresolvedAspects.filter(id => missingAspectIds.includes(id));
        if (plan.unresolvedAspects.length === 0) delete plan.unresolvedAspects;
      }
      planReviseAttempts = 0;

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
      if (acceptedWaivers.length > 0) {
        reviseResponse.acceptedWaivers = acceptedWaivers.map(w => w.aspectId);
      }
      if (tooShortWaivers.length > 0) {
        reviseResponse.tooShortWaivers = tooShortWaivers;
      }
      if (forcedAccept) {
        reviseResponse.unresolvedAspects = missingAspectIds;
        reviseResponse.sceneWarnings = revisedPlanWarnings;
        console.log(`[MCP] Revised plan force-accepted with ${revisedPlanWarnings.length} unmet aspects for ${options.sceneType ?? 'unknown scene'}`);
      }
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
    'Look up an on-demand scene strategy detail by detailRef returned from submit_plan/update_plan_phase. ' +
    'This is an informational fallback only: it does not collect trace evidence, does not satisfy expectedCalls, ' +
    'and should not replace invoke_skill/execute_sql/fetch_artifact.',
    {
      detailRef: z.string().optional().describe('Detail ref returned by plan tools, e.g. "scrolling:root_cause_drill".'),
      detailId: z.string().optional().describe('Detail id without scene prefix, used with scene or current sceneType.'),
      scene: z.string().optional().describe('Optional scene id when detailRef is not prefixed. Defaults to the current scene.'),
    },
    async ({ detailRef, detailId, scene }) => {
      const effectiveScene = scene?.trim() || options.sceneType;
      const requestedRef = detailRef?.trim()
        || (detailId?.trim()
          ? (effectiveScene ? `${effectiveScene}:${detailId.trim()}` : detailId.trim())
          : '');
      const detail = requestedRef ? getStrategyDetailByRef(requestedRef, effectiveScene) : undefined;
      if (!detail) {
        const availableDetails = effectiveScene
          ? getStrategyDetails(effectiveScene).map(d => ({ detailRef: d.ref, title: d.title }))
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

      const body = buildStrategyDetailExcerpt(detail, 6000);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            informational: true,
            detailRef: detail.ref,
            title: detail.title,
            content: body.excerpt,
            contentTruncated: body.truncated,
            contentMaxChars: body.maxChars,
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
      statement: z.string().optional().describe(
        'The hypothesis statement (e.g., "RenderThread is blocked by Binder transactions causing jank frames"). Alias: title.'
      ),
      title: z.string().optional().describe('Alias for statement, accepted for Claude SDK argument compatibility.'),
      basis: z.string().optional().describe(
        'What observation prompted this hypothesis (e.g., "Observed 3 frames with RenderThread in sleeping state"). Alias: reasoning.'
      ),
      reasoning: z.string().optional().describe('Alias for basis, accepted for Claude SDK argument compatibility.'),
    },
    async ({ id, statement, title, basis, reasoning }) => {
      const normalizedStatement = statement?.trim();
      const normalizedTitle = title?.trim();
      const normalizedBasis = basis?.trim();
      const normalizedReasoning = reasoning?.trim();
      if (
        (normalizedStatement && normalizedTitle && normalizedStatement !== normalizedTitle)
        || (normalizedBasis && normalizedReasoning && normalizedBasis !== normalizedReasoning)
      ) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: 'submit_hypothesis aliases must contain matching values',
              action_required: 'retry_submit_hypothesis_with_matching_aliases',
            }),
          }],
          isError: true,
        };
      }

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
    'confirmed supports that same causal claim; rejected contradicts or replaces it. ' +
    'For a different cause, reject the original, then submit a new hypothesis. ' +
    'Resolve all before the final conclusion.',
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
      if (hypothesis.status !== 'formed') {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            success: false,
            error: `Hypothesis "${effectiveHypothesisId}" already resolved as ${hypothesis.status}`,
            hypothesisId: effectiveHypothesisId,
            statement: hypothesis.statement,
            status: hypothesis.status,
          }) }],
          isError: true,
        };
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
    'Run SQL against the current or reference trace in comparison mode.\n\n' +
    'Use when: drilling into one side of a comparison or verifying compare_skill findings with targeted SQL. Use fetch_artifact rows directly instead of copying compare_skill/fetch_artifact rows into FROM (VALUES ...).\n\n' +
    'SQL safety rules: qualify duplicate column names after JOINs; use s.name AS slice_name, s.ts, s.dur, t.name AS thread_name, p.name AS process_name, or prefer thread_slice. FrameTimeline rows expose upid, not utid/process_name; JOIN process USING(upid) for actual_frame_timeline_slice. For thread_slice self time, JOIN slice_self_dur USING(id); read thread_name/process_name directly unless you explicitly JOIN thread/process. The main-thread column is is_main_thread.\n\n' +
    'Examples:\n' +
    '1. Check reference trace jank: trace="reference", sql="SELECT COUNT(*) FROM actual_frame_timeline_slice WHERE jank_type != \'None\'"\n' +
    '2. Compare CPU freq: trace="current", sql="SELECT cpu, AVG(value) as avg_freq FROM counter JOIN counter_track ON counter.track_id=counter_track.id WHERE counter_track.name GLOB \'cpu*freq\' GROUP BY cpu"',
    {
      trace: z.enum(['current', 'reference']).describe(
        'Which trace to query: "current" = primary trace loaded in Perfetto, "reference" = comparison trace.'
      ),
      sql: z.string().describe('The SQL query to execute against the specified trace.'),
      summary: z.boolean().optional().describe(
        'When true, returns column statistics + sample rows instead of full results. Default: false.'
      ),
    },
    async ({ trace, sql, summary }, extra) => {
      const signal = getRuntimeToolSignal(extra);
      throwIfTraceProcessorQueryCancelled(signal);
      const planError = requirePlan('execute_sql_on');
      if (planError) {
        return { content: [{ type: 'text' as const, text: planError }] };
      }
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
        { trace, sql, summary },
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
        const truncated = result.rows.length > 200;
        const rows = truncated ? result.rows.slice(0, 200) : result.rows;
        const success = !result.error;
        const sqlArtifact = success && result.columns.length > 0 && result.rows.length > SQL_RAW_INLINE_ROW_LIMIT
          ? storeSqlResultArtifact(artifactStore, {
              toolName: 'execute_sql_on',
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
                sqlRewrites,
                toolName: 'execute_sql_on',
              },
            );
            updateSqlArtifactQueryReview(artifactStore, sqlArtifact, emittedEvidence.queryReview);
          }
          const text = JSON.stringify({
            success: true,
            trace: traceLabel,
            traceSide: trace,
            traceId: targetTraceId,
            traceProvenance,
            mode: 'summary',
            autoSummarized: !summary && !!sqlArtifact,
            summary: summaryResult,
            totalRows: result.rows.length,
            ...(sqlArtifact ? {
              artifactId: sqlArtifact.artifactId,
              artifact: sqlArtifact.artifactSummary,
              rowsAvailableViaArtifact: true,
              pageSize: SQL_ARTIFACT_PAGE_SIZE,
              hint: `Use fetch_artifact(artifactId="${sqlArtifact.artifactId}", detail="rows", offset=0, limit=${SQL_ARTIFACT_PAGE_SIZE}) to page full SQL rows.`,
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
          });
          return { content: [{ type: 'text' as const, text: consumeWatchdogWarning(text + getReasoningNudge()) }] };
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
              sqlRewrites,
              toolName: 'execute_sql_on',
              rowCount: result.rows.length,
            },
          );
        }

        const text = JSON.stringify(success ? {
          success,
          trace: traceLabel,
          traceSide: trace,
          traceId: targetTraceId,
          traceProvenance,
          columns: result.columns,
          rows,
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
        }));
        return { content: [{ type: 'text' as const, text: consumeWatchdogWarning(success ? text + getReasoningNudge() : text) }] };
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
    async ({ skillId, params, currentParams, referenceParams, current_params, reference_params }, extra) => {
      const signal = getRuntimeToolSignal(extra);
      throwIfTraceProcessorQueryCancelled(signal);
      const planError = requirePlan('compare_skill');
      if (planError) {
        return { content: [{ type: 'text' as const, text: planError }] };
      }
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
        const referenceSharedParams = referenceSharedParamsForComparison(
          params,
          packageName,
          comparisonContext?.referencePackageName,
        );
        const normalizedCurrentParams = normalizeSkillParams(
          { ...(params ?? {}), ...(currentSideParams ?? {}) },
          packageName,
        );
        const normalizedReferenceParams = normalizeSkillParams(
          { ...referenceSharedParams.params, ...(referenceSideParams ?? {}) },
          comparisonContext?.referencePackageName,
        );
        const [currentParamResolution, referenceParamResolution] = await Promise.allSettled([
          resolveRegisteredDrillDownSkillParams({
            skillId,
            params: normalizedCurrentParams,
            traceId,
            traceProcessorService,
            signal,
          }),
          resolveRegisteredDrillDownSkillParams({
            skillId,
            params: normalizedReferenceParams,
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
          producerInput,
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
          skillExecutor.execute(skillId, traceId, effectiveParams, {
            __traceSide: 'current',
            __outputLanguage: outputLanguage,
            ...(currentTraceProvenance.paneSide ? { __paneSide: currentTraceProvenance.paneSide } : {}),
            signal,
          }),
          skillExecutor.execute(skillId, referenceTraceId, refParams, {
            __traceSide: 'reference',
            __outputLanguage: outputLanguage,
            ...(referenceTraceProvenance.paneSide ? { __paneSide: referenceTraceProvenance.paneSide } : {}),
            signal,
          }),
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
          );
        }

        // Build compact comparison summary for Claude
        const buildStepSummary = (results: any[]) =>
          results.map(r => ({
            stepId: r.stepId,
            title: r.title,
            rowCount: r.data?.rows?.length || 0,
            columns: r.data?.columns || [],
          }));

        const text = JSON.stringify({
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
        });

        return {
          content: [{ type: 'text' as const, text: consumeWatchdogWarning(text + getReasoningNudge()) }],
          ...(!success ? { isError: true } : {}),
        };
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
  const registry = new McpToolRegistry();

  if (options.lightweight) {
    // Lightweight mode: core data-access tools only — no planning,
    // hypothesis, notes, or advanced tools. Plan gate is automatically
    // disabled because analysisPlan is not passed in lightweight mode.
    // `invoke_skill` returns artifact references, so `fetch_artifact` must
    // stay available or lightweight models try to query artifact IDs as SQL.
    const isConversation = options.conversationTraceAttached !== undefined;
    if (!isConversation || options.conversationTraceAttached) {
      registry.registerSdk(executeSql, 'execute_sql', 'public');
      registry.registerSdk(invokeSkill, 'invoke_skill', 'public');
      registry.registerSdk(lookupSqlSchema, 'lookup_sql_schema', 'public');
      if (fetchArtifact) registry.registerSdk(fetchArtifact, 'fetch_artifact', 'public');
    }
    if (isConversation) {
      if (knowledgeSourceIds.length > 0) {
        registry.registerSdk(lookupBlogKnowledge, 'lookup_blog_knowledge', 'public');
      }
      registry.registerSdk(listCodebases, 'list_codebases', 'requires_codebase_permission');
      registry.registerSdk(searchCodebase, 'search_codebase', 'requires_codebase_permission');
      registry.registerSdk(readCodebaseFile, 'read_codebase_file', 'requires_codebase_permission');
      registry.registerSdk(queryCodeGraph, 'query_code_graph', 'requires_codebase_permission');
      registry.registerSdk(inspectCodeSymbol, 'inspect_code_symbol', 'requires_codebase_permission');
      registry.registerSdk(lookupAppSource, 'lookup_app_source', 'requires_codebase_permission');
      registry.registerSdk(lookupKernelSource, 'lookup_kernel_source', 'requires_codebase_permission');
      registry.registerSdk(resolveSymbol, 'resolve_symbol', 'requires_codebase_permission');
    }
  } else {
    // Full mode: all always-on tools + conditional tools.
    registry.registerSdk(executeSql, 'execute_sql', 'public');
    registry.registerSdk(invokeSkill, 'invoke_skill', 'public');
    registry.registerSdk(listSkills, 'list_skills', 'public');
    registry.registerSdk(detectArchitecture, 'detect_architecture', 'public');
    registry.registerSdk(lookupSqlSchema, 'lookup_sql_schema', 'public');
    registry.registerSdk(queryPerfettoSource, 'query_perfetto_source', 'public');
    registry.registerSdk(listStdlibModules, 'list_stdlib_modules', 'public');
    registry.registerSdk(lookupKnowledge, 'lookup_knowledge', 'public');
    registry.registerSdk(lookupBlogKnowledge, 'lookup_blog_knowledge', 'public');
    registry.registerSdk(lookupAospSource, 'lookup_aosp_source', 'public');
    registry.registerSdk(lookupOemSdk, 'lookup_oem_sdk', 'public');
    registry.registerSdk(listCodebases, 'list_codebases', 'requires_codebase_permission');
    registry.registerSdk(searchCodebase, 'search_codebase', 'requires_codebase_permission');
    registry.registerSdk(readCodebaseFile, 'read_codebase_file', 'requires_codebase_permission');
    registry.registerSdk(queryCodeGraph, 'query_code_graph', 'requires_codebase_permission');
    registry.registerSdk(inspectCodeSymbol, 'inspect_code_symbol', 'requires_codebase_permission');
    registry.registerSdk(lookupAppSource, 'lookup_app_source', 'requires_codebase_permission');
    registry.registerSdk(lookupKernelSource, 'lookup_kernel_source', 'requires_codebase_permission');
    registry.registerSdk(resolveSymbol, 'resolve_symbol', 'requires_codebase_permission');
    registry.registerSdk(proposePatch, 'propose_patch', 'requires_codebase_permission');
    registry.registerSdk(lookupBaseline, 'lookup_baseline', 'public');
    registry.registerSdk(compareBaselines, 'compare_baselines', 'public');
    registry.registerSdk(recallProjectMemory, 'recall_project_memory', 'public');
    registry.registerSdk(recallSimilarCase, 'recall_similar_case', 'public');
    registry.registerSdk(recallSimilarResult, 'recall_similar_result', 'public');
    if (writeAnalysisNote) registry.registerSdk(writeAnalysisNote, 'write_analysis_note', 'internal');
    if (fetchArtifact) registry.registerSdk(fetchArtifact, 'fetch_artifact', 'public');
    if (submitPlan) registry.registerSdk(submitPlan, 'submit_plan', 'internal');
    if (updatePlanPhase) registry.registerSdk(updatePlanPhase, 'update_plan_phase', 'internal');
    if (revisePlan) registry.registerSdk(revisePlan, 'revise_plan', 'internal');
    registry.registerSdk(lookupStrategyDetail, 'lookup_strategy_detail', 'internal');
    if (submitHypothesis) registry.registerSdk(submitHypothesis, 'submit_hypothesis', 'internal');
    if (resolveHypothesis) registry.registerSdk(resolveHypothesis, 'resolve_hypothesis', 'internal');
    if (flagUncertainty) registry.registerSdk(flagUncertainty, 'flag_uncertainty', 'internal');
    // recall_patterns stays 'internal' for one more commit. Plan 41 M1b
    // routes the recall path through openSupersedeStoreReadOnly so it no
    // longer mkdir's or migrates the supersede DB on first call. The
    // public-readonly exposure flip is gated on the M1b invariant test
    // soaking for one release cycle to catch any hidden writable code
    // path; that flip is the M1b commit 2 follow-up.
    registry.registerSdk(recallPatterns, 'recall_patterns', 'internal');
    // Comparison mode tools — only when referenceTraceId is provided.
    if (compareSkill) registry.registerSdk(compareSkill, 'compare_skill', 'internal');
    if (executeSqlOn) registry.registerSdk(executeSqlOn, 'execute_sql_on', 'internal');
    if (getComparisonContext) registry.registerSdk(getComparisonContext, 'get_comparison_context', 'internal');
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
  return {
    artifactId,
    artifactSummary: artifactStore.generateCompactSummary(artifactId),
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
): string {
  const dataHash = evidenceHash({
    title,
    data,
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
    durationMs?: number;
    truncated?: boolean;
    sqlRewrites?: string[];
    toolName?: 'execute_sql' | 'execute_sql_on';
    rowCount?: number;
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
    durationMs?: number;
    truncated?: boolean;
    sqlRewrites?: string[];
    toolName?: 'execute_sql' | 'execute_sql_on';
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
          })
        : undefined;
      const withEvidence = {
        ...envelope,
        meta: {
          ...envelope.meta,
          evidenceRefId,
          traceSide: traceProvenance?.traceSide,
          paneSide: traceProvenance?.paneSide,
          traceId: traceProvenance?.traceId,
          ...(artifactId ? { artifactId, sourceArtifactId: artifactId } : {}),
          ...(queryReview ? { queryReview } : {}),
          ...(identityResolution ? {
            identityRefId: identityResolution.identityRefId,
            identityStatus: identityResolution.status,
            identityWarnings: identityResolution.warnings,
            identityResolution,
          } : {}),
          ...producerEnvelopeOptions(producer),
          intent: 'skill_structured_result',
        },
      };
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
