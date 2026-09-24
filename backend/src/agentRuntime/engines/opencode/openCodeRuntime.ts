// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {snapshotSceneCoverageRegistry} from '../../../agent/scene/sceneCoveragePlan';
import { EventEmitter } from 'events';
import * as crypto from 'crypto';
import type {ChildProcess} from 'child_process';
import spawn from 'cross-spawn';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import type {
  AnalysisOptions,
  AnalysisResult,
  IOrchestrator,
} from '../../../agent/core/orchestratorTypes';
import type { ConversationTurn, StreamingUpdate } from '../../../agent/types';
import type { ArchitectureInfo } from '../../../agent/detectors/types';
import { createArchitectureDetector } from '../../../agent/detectors/architectureDetector';
import { sessionContextManager } from '../../../agent/context/enhancedSessionContext';
import { createSkillExecutor } from '../../../services/skillEngine/skillExecutor';
import { ensureSkillRegistryInitialized, skillRegistry } from '../../../services/skillEngine/skillLoader';
import {resolveEffectiveSkillRegistryForRuntime} from '../../../services/selfEvolution/effectiveRuntimeRegistryProvider';
import {
  commitEvaluationSdkHandoffIfActive,
  recordEvaluationTokenDeltaIfPresent,
} from '../../../services/selfEvolution/evaluationRuntimeHooks';
import { ArtifactStore } from '../../../agentv3/artifactStore';
import {resolveRuntimeEvidenceStore} from '../../runtimeEvidenceContext';
import {activateSceneRuntime, resolveSceneProductScope} from '../../../agent/scene/sceneRuntimeBinding';
import {
  buildNegativePatternSection,
  buildPatternContextSection,
  extractTraceFeatures,
} from '../../../agentv3/analysisPatternMemory';
import {
  createClaudeMcpServer,
  loadLearnedSqlFixPairs,
  MIN_PHASE_SUMMARY_CHARS,
} from '../../../agentv3/claudeMcpServer';
import {
  buildQuickSystemPrompt,
  buildSystemPrompt,
} from '../../../agentv3/claudeSystemPrompt';
import { extractFindingsFromText } from '../../../agentv3/claudeFindingExtractor';
import { detectFocusApps, focusAppTimeRangeFromSelection } from '../../../agentv3/focusAppDetector';
import { localize, parseOutputLanguage, type OutputLanguage } from '../../../agentv3/outputLanguage';
import { formatToolCallNarration, formatToolResultNarration, issuePrivateToolResultNarrationReceipt, toolResultIsFailure } from '../../../agentv3/toolNarration';
import { estimateAnalysisConfidence } from '../../../agentv3/analysisTermination';
import {planPhaseUpdatedContent} from '../../../agentv3/planPhaseEvents';
import { type SceneType } from '../../../agentv3/sceneClassifier';
import { probeTraceCompleteness } from '../../../agentv3/traceCompletenessProber';
import type {
  AnalysisNote,
  AnalysisPlanV3,
  ClaudeAnalysisContext,
  Hypothesis,
  PlanPhase,
  UncertaintyFlag,
} from '../../../agentv3/types';
import {
  getAnalysisPlanCompletionStatus,
  type AnalysisPlanCompletionStatus,
} from '../../../agentv3/planCompletionStatus';
import {
  recordPlanOrPrePlanToolCall,
  resetPrePlanToolCallsForNewRun,
  readToolResultFacts,
} from '../../../agentv3/planToolCallRecorder';
import {
  createOpenCodeSnapshotEngineState,
  getOpenCodeSnapshotEngineState,
  projectSessionFieldsForDurableSnapshot,
  type OpenCodeOpaqueState,
  type SessionFieldsForSnapshot,
  sessionFieldsUsePrivateKnowledge,
  type SessionStateSnapshot,
} from '../../../agentv3/sessionStateSnapshot';
import type { McpToolDefinition } from '../../../agentv3/mcpToolRegistry';
import type { JsonRpcRequest, JsonRpcResponse } from '../../../agentv3/standaloneMcpServer';
import { RPC_ERROR_CODES } from '../../../agentv3/standaloneMcpServer';
import {
  applyFinalResultQualityGate,
  type FinalResultComparisonIdentity,
} from '../../../services/finalResultQualityGate';
import {analysisContextUsesPrivateKnowledge, assertCurrentAnalysisContextAuthorization,
  buildAnalysisContextAuthorizationFingerprint} from '../../../services/resolvedAnalysisContext';
import {resolveKnowledgeScope} from '../../../services/scopedKnowledgeStore';
import {createRuntimeAnalysisHistoryReader, renderAnalysisHistoryContext, toAnalysisHistoryTurn,
  type AnalysisHistoryReader} from '../../analysisHistory';
import {createRuntimeTurnCloseoutTape, resolveRuntimeTurnBudget} from '../../runtimeTurnCloseout';
import {
  acceptNativeDeclarationCompletion,
  buildNativeDeclarationCompletionPrompt,
  nativeDeclarationBodyCanFitOutput,
  requestNativeDeclarationCompletion,
} from '../../runtimeConclusionProtocol';
import type {RuntimeToolObserver} from '../../runtimeToolObserver';
import { verifyConclusion } from '../claude/claudeVerifier';
import { getExtendedKnowledgeBase } from '../../../services/sqlKnowledgeBase';
import {projectToolResultForExternalSurface} from '../../../services/rag/toolResultProjectionFilter';
import {extractSourceLookupCodeReferences} from '../../../services/codebase/sourceLookupTools';
import {finalizeOwnerSourceAwareAnalysisResultWithProjection} from '../../../services/codebase/sourceClaimVerifier';
import { getProviderService, type ProviderConfig, type ProviderScope } from '../../../services/providerManager';
import {providerSubprocessEnv} from '../../../services/providerManager/envIsolation';
import type { RuntimeSelection } from '../../runtimeSelection';
import type { EngineCapabilities } from '../../runtimeDescriptorTypes';
import type { RuntimeEngineDefinition, RuntimeFactoryInput } from '../../runtimeRegistry';
import {
  createRuntimePerformanceRun,
  runtimeOutcomeFromError,
  type RuntimePerformanceOutcome,
  type RuntimePerformanceRun,
} from '../../runtimePerformance';
import { createAnalysisRunSpec, type AnalysisRunSpec } from '../../analysisRunSpec';
import {
  buildRuntimeTracePairComparisonContext,
  buildRuntimeTracePairIdentityContext,
} from '../../runtimePromptContext';
import {
  buildQuickRunReceipt,
  buildQuickMemoryContextPayload,
  captureSkillDisplayEntities,
  createRuntimeSkillNotesBudget,
  quickStopReasonFromTermination,
  resolveQuickTurnBudget,
  toProtocolHypothesis as toRuntimeProtocolHypothesis,
} from '../../runtimeCommon';
import { buildRuntimeCaseBackgroundContext } from '../../../services/caseEvolution/caseBackgroundContext';
import {createAnalysisTurnIntentResolver, type AnalysisTurnIntent} from '../../analysisTurnIntent';
import {buildComplexityClassifierInput} from '../../../agentv3/queryComplexityContext';
import {runOpenCodeIntentTransport, type OpenCodeClassifierHost, type OpenCodeIntentTransportInput} from './openCodeIntentTransport';
import {resolveRuntimeTurnPolicy, usesLightweightToolCatalog, type RuntimeTurnPolicy} from '../../runtimeTurnPolicy';
import {attachFinalizationContext} from '../../analysisFinalizationContext';
import type {ReadonlyStrategyRegistrySnapshot} from '../../../services/selfEvolution/effectiveRuntimeRegistryContext';
import {analysisDeliveryFingerprint, type AnalysisCompletion, type AnalysisDeliveryContext} from '../../../types/analysisDelivery';
import {resolveAgentRuntimeBudgetConfig} from '../../../config';
import { RuntimeExecutionGuard, type RuntimeExecutionLease } from '../../runtimeExecutionGuard';
import {isRuntimeCandidateAdmitted} from '../../runtimeCandidateAdmission';
import {countCompletedQuickConversationTurns} from '../../quickDirectResult';
import {
  createJsonSchemaFromZodRawShape,
  normalizeRuntimeToolArgs,
  normalizeRuntimeToolExtra,
} from '../../runtimeToolSpec';
import { isTraceProcessorQueryCancelledError } from '../../../services/traceProcessorCancellation';
import { backendDataPath } from '../../../runtimePaths';
import {diagnosticLogIdentity} from '../../../utils/logger';
import {canonicalContentHash} from '../../../services/selfEvolution/canonicalJson';
import {
  EXPERIMENTAL_OPENCODE_RUNTIME_KIND,
  OPENCODE_RUNTIME_KIND,
} from '../../runtimeKinds';
import {getLruCacheEntry, setLruCacheEntry} from '../../runtimeCache';

export type ExperimentalOpenCodeRuntimeKind = typeof EXPERIMENTAL_OPENCODE_RUNTIME_KIND;
export type PublicOpenCodeRuntimeKind = typeof OPENCODE_RUNTIME_KIND;
export type OpenCodeRuntimeKind = ExperimentalOpenCodeRuntimeKind | PublicOpenCodeRuntimeKind;
export {
  EXPERIMENTAL_OPENCODE_RUNTIME_KIND,
  OPENCODE_RUNTIME_KIND,
};

export const OPENCODE_SDK_MODULE_PATH_ENV = 'SMARTPERFETTO_OPENCODE_SDK_MODULE_PATH';
export const OPENCODE_PROJECT_DIR_ENV = 'SMARTPERFETTO_OPENCODE_PROJECT_DIR';
export const OPENCODE_SERVER_PORT_ENV = 'SMARTPERFETTO_OPENCODE_SERVER_PORT';
export const OPENCODE_SERVER_TIMEOUT_MS_ENV = 'SMARTPERFETTO_OPENCODE_SERVER_TIMEOUT_MS';
export const OPENCODE_PROMPT_TIMEOUT_MS_ENV = 'SMARTPERFETTO_OPENCODE_PROMPT_TIMEOUT_MS';
export const OPENCODE_MODEL_JSON_ENV = 'SMARTPERFETTO_OPENCODE_MODEL_JSON';
export const OPENCODE_SYSTEM_PROMPT_ENV = 'SMARTPERFETTO_OPENCODE_SYSTEM_PROMPT';
export const OPENCODE_ENABLE_STANDALONE_MCP_ENV = 'SMARTPERFETTO_OPENCODE_ENABLE_STANDALONE_MCP';
export const OPENCODE_MCP_COMMAND_JSON_ENV = 'SMARTPERFETTO_OPENCODE_MCP_COMMAND_JSON';
export const OPENCODE_MCP_TIMEOUT_MS_ENV = 'SMARTPERFETTO_OPENCODE_MCP_TIMEOUT_MS';
export const OPENCODE_REAL_ANALYSIS_ENV = 'SMARTPERFETTO_OPENCODE_REAL_ANALYSIS';

const DEFAULT_SERVER_TIMEOUT_MS = 15_000;
const DEFAULT_PROMPT_TIMEOUT_MS = 20 * 60_000;
const PROMPT_POLL_INITIAL_INTERVAL_MS = 100;
const PROMPT_POLL_MAX_INTERVAL_MS = 1_000;
const OPENCODE_MESSAGE_WINDOW_INITIAL_LIMIT = 50;
const OPENCODE_MESSAGE_WINDOW_MAX_LIMIT = 1_000;
const DEFAULT_MCP_TIMEOUT_MS = 5_000;
/** Lower bound shared by the OpenCode client, bridge child, and parent handler. */
export const OPENCODE_MCP_TIMEOUT_MIN_MS = 100;
/** Upper bound prevents accidental multi-hour bridge leases from malformed input. */
export const OPENCODE_MCP_TIMEOUT_MAX_MS = 300_000;
const OPENCODE_BRIDGE_TIMEOUT_MS_ENV = 'SMARTPERFETTO_OPENCODE_BRIDGE_TIMEOUT_MS';
const STANDALONE_MCP_NAME = 'smartperfetto';

const STANDALONE_MCP_PUBLIC_TOOLS = [
  'lookup_blog_knowledge',
  'lookup_aosp_source',
  'lookup_oem_sdk',
  'lookup_baseline',
  'compare_baselines',
  'recall_project_memory',
  'recall_similar_case',
] as const;

const OPENCODE_BUILT_IN_TOOL_IDS = [
  'invalid',
  'question',
  'bash',
  'read',
  'glob',
  'grep',
  'edit',
  'write',
  'task',
  'webfetch',
  'todowrite',
  'websearch',
  'skill',
  'apply_patch',
] as const;

type EnvLike = Record<string, string | undefined>;

interface OpenCodeServerHandle {
  url: string;
  close(): void | Promise<void>;
}

interface OpenCodeSdkResponse<T> {
  data?: T;
}

interface OpenCodeSession {
  id: string;
}

interface OpenCodeModelRef {
  providerID: string;
  modelID: string;
}

interface OpenCodeClient {
  mcp?: {
    status(input?: { query?: { directory?: string } }): Promise<unknown>;
  };
  session: {
    create(input: {
      body?: { title?: string };
      query?: { directory?: string };
    }): Promise<OpenCodeSdkResponse<OpenCodeSession> | OpenCodeSession>;
    get?(input: {
      path: { id: string };
      query?: { directory?: string };
    }): Promise<OpenCodeSdkResponse<OpenCodeSession> | OpenCodeSession>;
    prompt(input: OpenCodePromptInput): Promise<unknown>;
    promptAsync?(input: OpenCodePromptInput): Promise<unknown>;
    status?(input?: { query?: { directory?: string } }): Promise<unknown>;
    messages?(input: {
      path: { id: string };
      query?: { directory?: string; limit?: number; order?: 'asc' | 'desc' };
    }): Promise<unknown>;
    abort?(input: { path: { id: string } }): Promise<unknown>;
  };
}

interface OpenCodePromptInput {
  path: { id: string };
  query?: { directory?: string };
  body?: {
    noReply?: boolean;
    model?: OpenCodeModelRef;
    agent?: string;
    system?: string;
    tools?: Record<string, boolean>;
    parts: Array<{ type: 'text'; text: string }>;
  };
}

interface OpenCodeInstance {
  client: OpenCodeClient;
  server: OpenCodeServerHandle;
}

interface OpenCodeSdkModule {
  createOpencode?(options?: Record<string, unknown>): Promise<OpenCodeInstance>;
  createOpencodeWithEnv?(
    options: Record<string, unknown>,
    processEnv: NodeJS.ProcessEnv,
  ): Promise<OpenCodeInstance>;
  createOpencodeClient?(options?: Record<string, unknown>): OpenCodeClient;
}

interface OpenCodeActiveSession {
  openCodeSessionId?: string;
  projectDir?: string;
  homeDir?: string;
  configDir?: string;
  server?: OpenCodeServerHandle;
  client?: OpenCodeClient;
  closeBridge?: () => Promise<void>;
  closePromise?: Promise<void>;
  abortController?: AbortController;
  aborted: boolean;
}

export type OpenCodeSdkModuleLoader = (env: EnvLike) => Promise<OpenCodeSdkModule>;
type OpenCodeBridgeStarter = typeof startOpenCodeMcpBridge;

export interface OpenCodeRuntimeOptions {
  env?: EnvLike;
  moduleLoader?: OpenCodeSdkModuleLoader;
  bridgeStarter?: OpenCodeBridgeStarter;
}

interface OpenCodeSessionDirs {
  projectDir: string;
  homeDir: string;
  configDir: string;
}

interface OpenCodeModelConfig {
  model: OpenCodeModelRef;
  providerConfig?: Record<string, unknown>;
  smallModel?: string;
}

interface OpenCodeAnalysisPreparation {
  systemPrompt: string;
  prompt: string;
  toolDefinitions: McpToolDefinition[];
  allowedToolNames: Set<string>;
  quickMode: boolean;
  turnIntent: AnalysisTurnIntent;
  turnPolicy: RuntimeTurnPolicy;
  sceneType: SceneType;
  packageName?: string;
  architecture?: ArchitectureInfo;
  sessionContext: ReturnType<typeof sessionContextManager.getOrCreate>;
  previousTurns: ConversationTurn[];
  analysisPlan: { current: AnalysisPlanV3 | null; history: AnalysisPlanV3[] };
  notes: AnalysisNote[];
  hypotheses: Hypothesis[];
  uncertaintyFlags: UncertaintyFlag[];
  analysisRunSpec: AnalysisRunSpec;
  comparisonIdentity?: FinalResultComparisonIdentity;
  quickMemoryContextCounts?: ReturnType<typeof buildQuickMemoryContextPayload>['counts'];
  sourceUse: ReturnType<typeof createClaudeMcpServer>['sourceUse'];
}

export type OpenCodeEvent =
  | {
      type?: string;
      name?: string;
      data?: Record<string, unknown>;
      properties?: Record<string, unknown>;
    }
  | Record<string, unknown>;

const importEsmModule = new Function(
  'specifier',
  'return import(specifier);',
) as (specifier: string) => Promise<unknown>;

function truthyEnv(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'on' || normalized === 'yes';
}

function numericEnv(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function resolveOpenCodeMcpTimeoutMs(value: string | number | undefined): number {
  if (typeof value === 'string' && !/^(?:0|[1-9]\d*)$/.test(value)) {
    return DEFAULT_MCP_TIMEOUT_MS;
  }
  const parsed = typeof value === 'number' ? value : value === undefined ? Number.NaN : Number(value);
  return Number.isSafeInteger(parsed) &&
    parsed >= OPENCODE_MCP_TIMEOUT_MIN_MS &&
    parsed <= OPENCODE_MCP_TIMEOUT_MAX_MS
    ? parsed
    : DEFAULT_MCP_TIMEOUT_MS;
}

function parseCommandJson(value: string | undefined): string[] | undefined {
  if (!value?.trim()) return undefined;
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.some(item => typeof item !== 'string' || item.trim() === '')) {
      throw new Error('command must be a JSON string array');
    }
    return parsed;
  } catch (err) {
    throw new Error(
      `${OPENCODE_MCP_COMMAND_JSON_ENV} must be a JSON string array: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function describeOpenCodeSdkError(error: unknown): string {
  if (!error) return 'unknown error';
  if (typeof error === 'string') return error;
  if (!isRecord(error)) return String(error);
  const data = isRecord(error.data) ? error.data : undefined;
  const message = typeof error.message === 'string'
    ? error.message
    : typeof data?.message === 'string'
      ? data.message
      : undefined;
  if (message) return message;
  try {
    return JSON.stringify(error);
  } catch {
    return 'unserializable error';
  }
}

function unwrapSdkData<T>(value: OpenCodeSdkResponse<T> | T, context = 'OpenCode SDK request'): T {
  if (value && typeof value === 'object' && 'data' in value) {
    const response = value as OpenCodeSdkResponse<T> & { error?: unknown };
    if (response.error !== undefined) {
      throw new Error(`${context} failed: ${describeOpenCodeSdkError(response.error)}`);
    }
    if (response.data === undefined || response.data === null) {
      throw new Error(`${context} returned no data`);
    }
    return response.data as T;
  }
  return value as T;
}

function assertSdkSuccess(value: unknown, context: string): void {
  if (!isRecord(value)) return;
  if ('error' in value && value.error !== undefined) {
    throw new Error(`${context} failed: ${describeOpenCodeSdkError(value.error)}`);
  }
}

export function getOpenCodeEngineCapabilities(
  kind: OpenCodeRuntimeKind = EXPERIMENTAL_OPENCODE_RUNTIME_KIND,
): EngineCapabilities {
  const publicRuntime = kind === OPENCODE_RUNTIME_KIND;
  return {
    kind,
    displayName: publicRuntime ? 'OpenCode' : 'Experimental OpenCode',
    production: publicRuntime,
    publicRuntime,
    promptCache: { systemPromptDynamicBoundary: false },
  };
}

export function getOpenCodeRuntimeDiagnostics(
  env: EnvLike = process.env,
  kind: OpenCodeRuntimeKind = OPENCODE_RUNTIME_KIND,
  selectedProviderId?: string | null,
) {
  const modulePath = env[OPENCODE_SDK_MODULE_PATH_ENV]?.trim();
  const projectDir = env[OPENCODE_PROJECT_DIR_ENV]?.trim();
  const modelJson = env[OPENCODE_MODEL_JSON_ENV]?.trim();
  const standaloneMcpEnabled = truthyEnv(env[OPENCODE_ENABLE_STANDALONE_MCP_ENV]);
  const selection: RuntimeSelection<string> = selectedProviderId
    ? {kind, source: 'provider', providerId: selectedProviderId}
    : {kind, source: 'env'};
  const modelConfiguration = validateOpenCodeModelConfiguration(env, selection);
  return {
    configured: modelConfiguration.configured,
    runtime: kind,
    experimental: kind === EXPERIMENTAL_OPENCODE_RUNTIME_KIND,
    package: '@opencode-ai/sdk',
    cliPackage: 'opencode-ai',
    modulePath: modulePath || undefined,
    projectDir: projectDir || undefined,
    modelConfigured: modelConfiguration.configured,
    serverPort: numericEnv(env[OPENCODE_SERVER_PORT_ENV]),
    serverTimeoutMs: numericEnv(env[OPENCODE_SERVER_TIMEOUT_MS_ENV]) ?? DEFAULT_SERVER_TIMEOUT_MS,
    standaloneMcpEnabled,
    standaloneMcpTimeoutMs: resolveOpenCodeMcpTimeoutMs(env[OPENCODE_MCP_TIMEOUT_MS_ENV]),
  };
}

export async function loadOpenCodeSdkModule(
  env: EnvLike = process.env,
): Promise<OpenCodeSdkModule> {
  const explicitModulePath = env[OPENCODE_SDK_MODULE_PATH_ENV]?.trim();
  const specifier = explicitModulePath
    ? pathToFileURL(explicitModulePath).href
    : '@opencode-ai/sdk';
  const module = await importEsmModule(specifier) as Partial<OpenCodeSdkModule>;
  if (
    typeof module.createOpencodeClient !== 'function' &&
    typeof module.createOpencodeWithEnv !== 'function'
  ) {
    throw new Error(
      'OpenCode SDK module must export createOpencodeClient or explicit createOpencodeWithEnv',
    );
  }
  return module as OpenCodeSdkModule;
}

export function createOpenCodeToolAllowlist(
  allowedToolNames: readonly string[] = [],
): Record<string, boolean> {
  const tools: Record<string, boolean> = {};
  for (const toolId of OPENCODE_BUILT_IN_TOOL_IDS) {
    tools[toolId] = false;
  }
  for (const toolName of allowedToolNames) {
    tools[toolName] = true;
  }
  return tools;
}

export function createOpenCodeStandaloneMcpToolNames(
  mcpName = STANDALONE_MCP_NAME,
): string[] {
  return STANDALONE_MCP_PUBLIC_TOOLS.flatMap(toolName => [
    toolName,
    `${mcpName}_${toolName}`,
    `mcp__${mcpName}__${toolName}`,
  ]);
}

export function createOpenCodeStandaloneMcpConfig(
  env: EnvLike = process.env,
): Record<string, unknown> {
  if (!truthyEnv(env[OPENCODE_ENABLE_STANDALONE_MCP_ENV])) {
    return {};
  }

  const explicitCommand = parseCommandJson(env[OPENCODE_MCP_COMMAND_JSON_ENV]);
  const command = explicitCommand ?? [
    path.resolve(process.cwd(), 'node_modules/.bin/tsx'),
    path.resolve(process.cwd(), 'bin/smartperfetto-mcp.ts'),
  ];

  return {
    [STANDALONE_MCP_NAME]: {
      type: 'local',
      enabled: true,
      timeout: resolveOpenCodeMcpTimeoutMs(env[OPENCODE_MCP_TIMEOUT_MS_ENV]),
      command,
      environment: {
        SMARTPERFETTO_STANDALONE_MCP: '1',
      },
    },
  };
}

export function createOpenCodeHardenedConfig(
  allowedToolNames: readonly string[] = [],
  env: EnvLike = process.env,
  bridge?: OpenCodeMcpBridgeHandle,
  modelConfig?: OpenCodeModelConfig,
  maxSteps = resolveAgentRuntimeBudgetConfig(env).maxTurns,
): Record<string, unknown> {
  const mcpToolNames = bridge
    ? createOpenCodeMcpToolNames(allowedToolNames)
    : truthyEnv(env[OPENCODE_ENABLE_STANDALONE_MCP_ENV])
      ? createOpenCodeStandaloneMcpToolNames()
      : [];
  const mcpConfig = bridge
    ? {
        [STANDALONE_MCP_NAME]: {
          type: 'local',
          enabled: true,
          timeout: resolveOpenCodeMcpTimeoutMs(bridge.requestTimeoutMs),
          command: resolveOpenCodeBridgeCommand(env),
          environment: {
            SMARTPERFETTO_OPENCODE_BRIDGE_PORT: String(bridge.port),
            SMARTPERFETTO_OPENCODE_BRIDGE_TOKEN: bridge.token,
            [OPENCODE_BRIDGE_TIMEOUT_MS_ENV]: String(
              resolveOpenCodeMcpTimeoutMs(bridge.requestTimeoutMs),
            ),
          },
        },
      }
    : createOpenCodeStandaloneMcpConfig(env);
  const standaloneMcpToolNames = mcpToolNames;
  const tools = createOpenCodeToolAllowlist(allowedToolNames);
  for (const toolName of standaloneMcpToolNames) {
    tools[toolName] = true;
  }
  const permission = {
    edit: 'deny',
    bash: 'deny',
    webfetch: 'deny',
    external_directory: 'deny',
  };

  return {
    autoupdate: false,
    share: 'disabled',
    snapshot: false,
    instructions: [],
    mcp: mcpConfig,
    lsp: false,
    formatter: false,
    ...(modelConfig?.providerConfig ? { provider: modelConfig.providerConfig } : {}),
    ...(modelConfig?.smallModel ? { small_model: modelConfig.smallModel } : {}),
    ...(modelConfig ? { model: `${modelConfig.model.providerID}/${modelConfig.model.modelID}` } : {}),
    tools,
    permission,
    agent: {
      smartperfetto: {
        mode: 'primary',
        hidden: true,
        ...(modelConfig ? { model: `${modelConfig.model.providerID}/${modelConfig.model.modelID}` } : {}),
        tools,
        permission,
        maxSteps,
      },
    },
  };
}

export function projectOpenCodeEventToStreamingUpdate(
  event: OpenCodeEvent,
  timestamp = Date.now(),
): StreamingUpdate | undefined {
  const type = typeof event.type === 'string' ? event.type : undefined;
  const name = typeof event.name === 'string' ? event.name : type;
  const data = (event.data ?? event.properties ?? {}) as Record<string, unknown>;

  if (name === 'session.next.text.delta.1' || type === 'session.next.text.delta') {
    const delta = typeof data.delta === 'string' ? data.delta : '';
    if (!delta) return undefined;
    return { type: 'answer_token', content: delta, timestamp };
  }

  if (name === 'session.next.tool.called.1' || type === 'session.next.tool.called') {
    return {
      type: 'tool_call',
      content: {
        name: data.tool ?? data.name ?? 'unknown_tool',
        input: data.input,
        callId: data.callID ?? data.callId,
        runtime: EXPERIMENTAL_OPENCODE_RUNTIME_KIND,
      },
      timestamp,
    };
  }

  if (name === 'session.next.tool.success.1' || type === 'session.next.tool.success') {
    return {
      type: 'progress',
      content: `OpenCode tool completed: ${String(data.tool ?? data.name ?? 'unknown_tool')}`,
      timestamp,
    };
  }

  if (name === 'session.next.tool.failed.1' || type === 'session.next.tool.failed') {
    return {
      type: 'degraded',
      content: {
        source: EXPERIMENTAL_OPENCODE_RUNTIME_KIND,
        reason: 'tool_failed',
        tool: data.tool ?? data.name ?? 'unknown_tool',
        error: data.error,
      },
      timestamp,
    };
  }

  if (name === 'session.status' || type === 'session.status') {
    return {
      type: 'progress',
      content: {
        runtime: EXPERIMENTAL_OPENCODE_RUNTIME_KIND,
        status: data.status,
      },
      timestamp,
    };
  }

  return undefined;
}

function buildSmokePrompt(query: string, traceId: string, options?: AnalysisOptions): string {
  const mode = options?.analysisMode ?? 'auto';
  const packageName = options?.packageName ?? 'unknown';
  return [
    'SmartPerfetto OpenCode hidden-runtime smoke.',
    `Trace ID: ${traceId}`,
    `Package: ${packageName}`,
    `Analysis mode: ${mode}`,
    `User query: ${query}`,
  ].join('\n');
}

function resolveOpenCodeBridgeCommand(env: EnvLike): string[] {
  const explicitCommand = parseCommandJson(env[OPENCODE_MCP_COMMAND_JSON_ENV]);
  if (explicitCommand) return explicitCommand;

  const child = path.join(__dirname, 'openCodeMcpBridgeChild.cjs');
  if (!fs.existsSync(child)) {
    throw new Error(`OpenCode MCP bridge child is unavailable: ${child}`);
  }
  return [process.execPath, child];
}

async function assertOpenCodeMcpReady(
  client: OpenCodeClient,
  projectDir: string,
  getBridgeDiagnostics?: () => OpenCodeMcpBridgeDiagnostics,
): Promise<void> {
  if (!client.mcp?.status) return;
  const statusMap = unwrapSdkData<Record<string, unknown>>(
    await client.mcp.status({query: {directory: projectDir}}) as OpenCodeSdkResponse<Record<string, unknown>>,
    'OpenCode MCP status',
  );
  const status = isRecord(statusMap[STANDALONE_MCP_NAME])
    ? statusMap[STANDALONE_MCP_NAME]
    : undefined;
  if (status?.status === 'connected') return;
  const reason = typeof status?.error === 'string'
    ? status.error
    : status?.status
      ? `status=${String(status.status)}`
      : 'status unavailable';
  const bridgeDiagnostics = getBridgeDiagnostics?.();
  const diagnostic = bridgeDiagnostics
    ? ` (connections=${bridgeDiagnostics.connectionCount}, requests=${bridgeDiagnostics.requestCount}, lastMethod=${bridgeDiagnostics.lastMethod ?? 'none'}, lastError=${bridgeDiagnostics.lastError ?? 'none'})`
    : '';
  throw new Error(`OpenCode SmartPerfetto MCP bridge unavailable: ${reason}${diagnostic}`);
}

export const __testing = {
  allocateCandidateOpenCodePort,
  assertOpenCodeMcpReady,
  createIsolatedOpenCodeProcessEnv,
  createOpenCodeInstanceWithExplicitEnv,
  resolveOpenCodeBridgeCommand,
  resolveOpenCodeCliPath,
  startOpenCodeMcpBridge,
  waitForOpenCodeServer,
  windowsTaskkillArgs,
  cleanupStaleEphemeralOpenCodeDirs: (now?: number) => {
    staleEphemeralOpenCodeDirsCleaned = false;
    cleanupStaleEphemeralOpenCodeDirs(now);
  },
};

function createOpenCodeMcpToolNames(
  toolNames: readonly string[],
  mcpName = STANDALONE_MCP_NAME,
): string[] {
  return toolNames.flatMap(toolName => [
    toolName,
    `${mcpName}_${toolName}`,
    `mcp__${mcpName}__${toolName}`,
  ]);
}

function normalizeOpenCodeMcpToolName(
  name: string,
  definitions: readonly McpToolDefinition[],
  mcpName = STANDALONE_MCP_NAME,
): McpToolDefinition | undefined {
  return definitions.find(definition => (
    definition.name === name ||
    `${mcpName}_${definition.name}` === name ||
    `mcp__${mcpName}__${definition.name}` === name
  ));
}

function rpcError(
  id: string | number | null,
  code: number,
  message: string,
): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

type OpenCodeBridgeUpdateEmitter = (update: StreamingUpdate) => void;

interface OpenCodeBridgeDispatchOptions {
  getSignal?: () => AbortSignal | undefined;
  analysisPlan?: { current: AnalysisPlanV3 | null };
  isDeliverable?: () => boolean;
  timeoutMs?: number;
  /** Output language for shared tool call/result narration. */
  outputLanguage?: OutputLanguage;
}

function openCodeOutputLanguage(options: OpenCodeBridgeDispatchOptions): OutputLanguage {
  return options.outputLanguage ?? parseOutputLanguage(process.env.SMARTPERFETTO_OUTPUT_LANGUAGE);
}

function openCodeBridgeAbortError(message: string): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function throwIfOpenCodeBridgeUndeliverable(options: OpenCodeBridgeDispatchOptions): void {
  if (options.getSignal?.()?.aborted || options.isDeliverable?.() === false) {
    throw openCodeBridgeAbortError('OpenCode SmartPerfetto MCP bridge request is no longer deliverable');
  }
}

function emitOpenCodeBridgeUpdateIfDeliverable(
  emitUpdate: OpenCodeBridgeUpdateEmitter | undefined,
  options: OpenCodeBridgeDispatchOptions,
  update: StreamingUpdate,
): void {
  if (options.getSignal?.()?.aborted || options.isDeliverable?.() === false) return;
  emitUpdate?.(update);
}

function summarizeOpenCodeToolResult(result: unknown): string {
  if (typeof result === 'string') {
    return result.length > 2000 ? `${result.slice(0, 2000)}...` : result;
  }
  const content = isRecord(result) && Array.isArray(result.content)
    ? result.content
      .map(block => isRecord(block) && typeof block.text === 'string' ? block.text : '')
      .filter(Boolean)
      .join('\n')
    : '';
  if (content) {
    return content.length > 2000 ? `${content.slice(0, 2000)}...` : content;
  }
  let text: string;
  try {
    text = JSON.stringify(result);
  } catch {
    text = String(result);
  }
  if (!text) return '';
  return text.length > 2000 ? `${text.slice(0, 2000)}...` : text;
}

export async function dispatchOpenCodeBridgeRequest(
  definitions: readonly McpToolDefinition[],
  req: JsonRpcRequest,
  emitUpdate?: OpenCodeBridgeUpdateEmitter,
  options: OpenCodeBridgeDispatchOptions = {},
): Promise<JsonRpcResponse | null> {
  if (req.id === undefined) return null;
  const id = req.id;
  if (req.method === '__parse_error__') {
    return rpcError(null, RPC_ERROR_CODES.PARSE_ERROR, 'Invalid JSON');
  }
  if (req.method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        serverInfo: { name: STANDALONE_MCP_NAME, version: '1.0.0' },
        capabilities: { tools: {} },
      },
    };
  }
  if (req.method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        tools: definitions.map(definition => ({
          name: definition.name,
          description: definition.summary || definition.shared.description,
          inputSchema: createJsonSchemaFromZodRawShape(definition.shared.inputSchema),
        })),
      },
    };
  }
  if (req.method === 'tools/call') {
    throwIfOpenCodeBridgeUndeliverable(options);
    const params = (req.params ?? {}) as { name?: string; arguments?: unknown };
    if (!params.name || typeof params.name !== 'string') {
      return rpcError(id, RPC_ERROR_CODES.INVALID_PARAMS, '`name` is required');
    }
    const definition = normalizeOpenCodeMcpToolName(params.name, definitions);
    if (!definition) {
      return rpcError(id, RPC_ERROR_CODES.METHOD_NOT_FOUND, `Unknown tool '${params.name}'`);
    }
    const args = normalizeRuntimeToolArgs(params.arguments ?? {}, definition.shared.inputSchema) as Record<string, unknown>;
    const taskId = String(id ?? `${params.name}-${Date.now()}`);
    try {
      emitOpenCodeBridgeUpdateIfDeliverable(emitUpdate, options, {
        type: 'agent_task_dispatched',
        content: {
          taskId,
          toolName: definition.name,
          args,
          // Shared narrator, so the timeline reads the same across runtimes.
          message: formatToolCallNarration(definition.name, args, openCodeOutputLanguage(options)),
        },
        timestamp: Date.now(),
      });
      const result = await definition.shared.handler(
        args,
        normalizeRuntimeToolExtra({
          runtime: OPENCODE_RUNTIME_KIND,
          signal: options.getSignal?.(),
          toolCallId: taskId,
        }),
      );
      throwIfOpenCodeBridgeUndeliverable(options);
      // The shared MCP handler reports failure on the result envelope itself;
      // projection can replace that envelope for sensitive tools, so read it
      // from the raw result first.
      const resultIsFailure = toolResultIsFailure({toolName: definition.name, result});
      const projectedResult = projectToolResultForExternalSurface(definition.name, result);
      const privateToolResultReceipt = issuePrivateToolResultNarrationReceipt({
        toolName: definition.name, result: projectedResult, isError: resultIsFailure,
      });
      const resultText = summarizeOpenCodeToolResult(projectedResult);
      const codeReferences = extractSourceLookupCodeReferences(definition.name, result);
      recordPlanOrPrePlanToolCall(options.analysisPlan, {
        toolName: definition.name,
        toolCallId: taskId,
        onPhaseAutoCompleted: phase => emitOpenCodeBridgeUpdateIfDeliverable(emitUpdate, options, {
          type: 'plan_phase_updated',
          content: planPhaseUpdatedContent({phaseId: phase.id, phaseName: phase.name, status: 'completed', summary: phase.summary, origin: 'auto'}),
          timestamp: Date.now(),
        }),
        input: args,
        resultText,
        // Read before truncation: planPhaseId and success sit after the body.
        resultFacts: readToolResultFacts(result),
        returnedCodeReferences: codeReferences.length > 0,
        returnedCodeReferenceHints: codeReferences,
      });
      emitOpenCodeBridgeUpdateIfDeliverable(emitUpdate, options, {
        type: 'agent_response',
        content: {
          taskId,
          toolName: definition.name,
          result: resultText,
          ...(privateToolResultReceipt ? {privateToolResultReceipt} : {}),
          // Narrate the projected object; resultText is byte-truncated.
          resultNarration: formatToolResultNarration({
            toolName: definition.name,
            args,
            result: projectedResult,
            isError: resultIsFailure,
            language: openCodeOutputLanguage(options),
          }),
          isError: resultIsFailure,
        },
        timestamp: Date.now(),
      });
      return { jsonrpc: '2.0', id, result };
    } catch (err) {
      if (isTraceProcessorQueryCancelledError(err)) {
        throw err;
      }
      if (
        (err instanceof Error && err.name === 'AbortError') ||
        options.getSignal?.()?.aborted ||
        options.isDeliverable?.() === false
      ) {
        throw openCodeBridgeAbortError('OpenCode SmartPerfetto MCP bridge request was aborted');
      }
      const failureMessage = err instanceof Error ? err.message : String(err);
      const projectedFailure = projectToolResultForExternalSurface(definition.name, {
        success: false, error: failureMessage,
      });
      const privateToolResultReceipt = issuePrivateToolResultNarrationReceipt({
        toolName: definition.name, result: projectedFailure, isError: true,
      });
      emitOpenCodeBridgeUpdateIfDeliverable(emitUpdate, options, {
        type: 'agent_response',
        content: {
          taskId,
          toolName: definition.name,
          result: summarizeOpenCodeToolResult(projectedFailure),
          ...(privateToolResultReceipt ? {privateToolResultReceipt} : {}),
          resultNarration: formatToolResultNarration({
            toolName: definition.name,
            args,
            result: projectedFailure,
            isError: true,
            language: openCodeOutputLanguage(options),
          }),
          isError: true,
        },
        timestamp: Date.now(),
      });
      return rpcError(
        id,
        RPC_ERROR_CODES.TOOL_EXECUTION_FAILED,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  return rpcError(id, RPC_ERROR_CODES.METHOD_NOT_FOUND, `Unknown method '${req.method}'`);
}

interface OpenCodeMcpBridgeHandle {
  port: number;
  token: string;
  requestTimeoutMs: number;
  getDiagnostics(): OpenCodeMcpBridgeDiagnostics;
  close(): Promise<void>;
}

interface OpenCodeMcpBridgeDiagnostics {
  connectionCount: number;
  requestCount: number;
  lastMethod?: string;
  lastError?: string;
}

function startOpenCodeMcpBridge(
  definitions: readonly McpToolDefinition[],
  emitUpdate?: OpenCodeBridgeUpdateEmitter,
  options: OpenCodeBridgeDispatchOptions = {},
): Promise<OpenCodeMcpBridgeHandle> {
  const token = crypto.randomBytes(24).toString('hex');
  const requestTimeoutMs = resolveOpenCodeMcpTimeoutMs(options.timeoutMs);
  const diagnostics: OpenCodeMcpBridgeDiagnostics = {
    connectionCount: 0,
    requestCount: 0,
  };
  const sockets = new Set<net.Socket>();
  const activeRequestControllers = new Set<AbortController>();
  let closePromise: Promise<void> | undefined;
  const server = net.createServer((socket) => {
    diagnostics.connectionCount += 1;
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.setEncoding('utf-8');
    socket.setTimeout(requestTimeoutMs, () => {
      diagnostics.lastError = 'bridge_handshake_timeout';
      socket.destroy();
    });
    let buffer = '';
    let bufferedBytes = 0;
    let requestStarted = false;
    socket.on('data', (chunk: string) => {
      if (requestStarted) return;
      buffer += chunk;
      bufferedBytes += Buffer.byteLength(chunk, 'utf8');
      if (bufferedBytes > 64 * 1024) {
        diagnostics.lastError = 'bridge_request_too_large';
        socket.destroy();
        return;
      }
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      requestStarted = true;
      socket.setTimeout(0);
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      void (async () => {
        try {
          const envelope = JSON.parse(line) as { token?: string; request?: JsonRpcRequest };
          if (envelope.token !== token || !envelope.request) {
            diagnostics.lastError = 'invalid_bridge_request';
            socket.write(`${JSON.stringify(rpcError(null, RPC_ERROR_CODES.INVALID_REQUEST, 'Invalid bridge request'))}\n`);
            socket.end();
            return;
          }
          diagnostics.requestCount += 1;
          diagnostics.lastMethod = envelope.request.method;
          const requestController = new AbortController();
          activeRequestControllers.add(requestController);
          let requestSettled = false;
          const outerSignal = options.getSignal?.();
          const abortRequest = () => {
            if (!requestSettled) requestController.abort();
          };
          outerSignal?.addEventListener('abort', abortRequest, {once: true});
          if (outerSignal?.aborted) requestController.abort();
          socket.once('close', abortRequest);
          socket.once('error', abortRequest);
          const deadline = setTimeout(() => {
            if (requestSettled) return;
            diagnostics.lastError = 'bridge_request_timeout';
            requestController.abort();
            socket.destroy();
          }, requestTimeoutMs);
          const isDeliverable = () => (
            !requestController.signal.aborted &&
            !socket.destroyed &&
            socket.writable
          );
          let response: JsonRpcResponse | null;
          try {
            response = await dispatchOpenCodeBridgeRequest(
              definitions,
              envelope.request,
              emitUpdate,
              {
                ...options,
                getSignal: () => requestController.signal,
                isDeliverable,
              },
            );
          } finally {
            requestSettled = true;
            clearTimeout(deadline);
            activeRequestControllers.delete(requestController);
            outerSignal?.removeEventListener('abort', abortRequest);
          }
          if (response && isDeliverable()) socket.write(`${JSON.stringify(response)}\n`);
          socket.end();
        } catch (error) {
          diagnostics.lastError = error instanceof Error ? error.message : String(error);
          if (
            isTraceProcessorQueryCancelledError(error) ||
            (error instanceof Error && error.name === 'AbortError') ||
            socket.destroyed
          ) {
            socket.end();
            return;
          }
          socket.write(`${JSON.stringify(rpcError(null, RPC_ERROR_CODES.PARSE_ERROR, 'Invalid bridge JSON'))}\n`);
          socket.end();
        }
      })();
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('OpenCode MCP bridge did not bind to a TCP port'));
        return;
      }
      resolve({
        port: address.port,
        token,
        requestTimeoutMs,
        getDiagnostics: () => ({...diagnostics}),
        close: () => {
          if (!closePromise) {
            for (const controller of activeRequestControllers) controller.abort();
            for (const socket of sockets) socket.destroy();
            closePromise = new Promise<void>((closeResolve, closeReject) => {
              server.close(err => err ? closeReject(err) : closeResolve());
            });
          }
          return closePromise;
        },
      });
    });
  });
}

function safeSessionPathSegment(sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 96);
  return safe || 'session';
}

function ensureDirectory(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function openCodeSessionRoot(sessionId: string): string {
  return backendDataPath('agent-runtime', 'opencode', safeSessionPathSegment(sessionId));
}

function createDurableOpenCodeSessionDirs(
  sessionId: string,
  env: EnvLike,
): OpenCodeSessionDirs {
  const root = openCodeSessionRoot(sessionId);
  const projectDir = env[OPENCODE_PROJECT_DIR_ENV]?.trim()
    ? path.resolve(env[OPENCODE_PROJECT_DIR_ENV]!.trim())
    : path.join(root, 'project');
  return {
    projectDir: ensureDirectory(projectDir),
    homeDir: ensureDirectory(path.join(root, 'home')),
    configDir: ensureDirectory(path.join(root, 'config')),
  };
}

function createEphemeralOpenCodeSessionDirs(): OpenCodeSessionDirs & {ephemeralRoot: string} {
  cleanupStaleEphemeralOpenCodeDirs();
  const ephemeralRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-opencode-private-'));
  fs.writeFileSync(
    path.join(ephemeralRoot, '.owner.json'),
    JSON.stringify({pid: process.pid, createdAt: Date.now()}),
    {encoding: 'utf8', mode: 0o600},
  );
  return {
    ephemeralRoot,
    projectDir: ensureDirectory(path.join(ephemeralRoot, 'project')),
    homeDir: ensureDirectory(path.join(ephemeralRoot, 'home')),
    configDir: ensureDirectory(path.join(ephemeralRoot, 'config')),
  };
}

let staleEphemeralOpenCodeDirsCleaned = false;

function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

function readEphemeralOpenCodeOwner(candidate: string): {pid: number; createdAt: number} | null {
  try {
    const raw = fs.readFileSync(path.join(candidate, '.owner.json'), 'utf8');
    if (raw.length > 4096) return null;
    const value = JSON.parse(raw) as {pid?: unknown; createdAt?: unknown};
    if (!Number.isSafeInteger(value.pid) || Number(value.pid) <= 0) return null;
    if (!Number.isFinite(value.createdAt) || Number(value.createdAt) <= 0) return null;
    return {pid: Number(value.pid), createdAt: Number(value.createdAt)};
  } catch {
    return null;
  }
}

function cleanupStaleEphemeralOpenCodeDirs(now = Date.now()): void {
  if (staleEphemeralOpenCodeDirsCleaned) return;
  staleEphemeralOpenCodeDirsCleaned = true;
  const root = os.tmpdir();
  const maxAgeMs = 24 * 60 * 60 * 1000;
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(root, {withFileTypes: true});
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('smartperfetto-opencode-private-')) continue;
    const candidate = path.join(root, entry.name);
    try {
      const stat = fs.statSync(candidate);
      if (now - stat.mtimeMs < maxAgeMs) continue;
      if (typeof process.getuid === 'function' && typeof stat.uid === 'number' && stat.uid !== process.getuid()) {
        continue;
      }
      const owner = readEphemeralOpenCodeOwner(candidate);
      if (owner && isProcessAlive(owner.pid)) continue;
      fs.rmSync(candidate, {recursive: true, force: true});
    } catch {
      // Best-effort crash residue cleanup. Unknown failures preserve the directory.
    }
  }
}

function openCodeOpaqueDirsExist(opaque: OpenCodeOpaqueState): boolean {
  return Boolean(
    opaque.projectDir &&
    opaque.homeDir &&
    opaque.configDir &&
    fs.existsSync(opaque.projectDir) &&
    fs.existsSync(opaque.homeDir) &&
    fs.existsSync(opaque.configDir),
  );
}

function createOpenCodeOpaqueState(
  openCodeSessionId: string | undefined,
  dirs: OpenCodeSessionDirs,
): OpenCodeOpaqueState {
  if (!openCodeSessionId) {
    return { version: 1, degradedReason: 'state_unavailable' };
  }
  return {
    version: 1,
    openCodeSessionId,
    projectDir: dirs.projectDir,
    homeDir: dirs.homeDir,
    configDir: dirs.configDir,
  };
}

function resolveOpenCodeCliPath(): string {
  const packageJsonPath = require.resolve('opencode-ai/package.json');
  const packageRoot = path.dirname(packageJsonPath);
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as {
    bin?: string | Record<string, string>;
  };
  const relativeBin = typeof packageJson.bin === 'string'
    ? packageJson.bin
    : packageJson.bin?.opencode;
  if (!relativeBin) throw new Error('opencode-ai package does not declare the opencode CLI');
  const executable = path.resolve(packageRoot, relativeBin);
  const relative = path.relative(packageRoot, executable);
  if (relative.startsWith('..') || path.isAbsolute(relative) || !fs.existsSync(executable)) {
    throw new Error('opencode-ai CLI path is unavailable or outside its package');
  }
  return executable;
}

const OPENCODE_START_MAX_ATTEMPTS = 3;

interface OpenCodeProcessIsolation {
  env: NodeJS.ProcessEnv;
  authorizationHeader: string;
}

interface OpenCodeSpawnOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdio: ['ignore', 'pipe', 'pipe'];
  windowsHide: boolean;
}

interface OpenCodeProcessDeps {
  allocatePort?: (hostname: string) => Promise<number>;
  spawnChild?: (
    executable: string,
    args: string[],
    options: OpenCodeSpawnOptions,
  ) => ChildProcess;
}

class OpenCodeServerStartError extends Error {
  constructor(message: string, readonly portCollision: boolean) {
    super(message);
    this.name = 'OpenCodeServerStartError';
  }
}

function isolatedOpenCodeDirectory(root: string, ...segments: string[]): string {
  return ensureDirectory(path.join(root, ...segments));
}

function createIsolatedOpenCodeProcessEnv(
  dirs: OpenCodeSessionDirs,
  inheritedEnv: EnvLike,
  config?: Record<string, unknown>,
): OpenCodeProcessIsolation {
  const username = `smartperfetto-${crypto.randomBytes(12).toString('hex')}`;
  const password = crypto.randomBytes(32).toString('base64url');
  const appData = isolatedOpenCodeDirectory(dirs.homeDir, 'AppData', 'Roaming');
  const localAppData = isolatedOpenCodeDirectory(dirs.homeDir, 'AppData', 'Local');
  const tempDir = isolatedOpenCodeDirectory(dirs.homeDir, 'tmp');
  const env = {
    ...providerSubprocessEnv(inheritedEnv),
    HOME: dirs.homeDir,
    USERPROFILE: dirs.homeDir,
    XDG_DATA_HOME: isolatedOpenCodeDirectory(dirs.homeDir, 'xdg', 'data'),
    XDG_STATE_HOME: isolatedOpenCodeDirectory(dirs.homeDir, 'xdg', 'state'),
    XDG_CACHE_HOME: isolatedOpenCodeDirectory(dirs.homeDir, 'xdg', 'cache'),
    XDG_CONFIG_HOME: dirs.configDir,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    TMPDIR: tempDir,
    TMP: tempDir,
    TEMP: tempDir,
    OPENCODE_CONFIG_DIR: dirs.configDir,
    OPENCODE_SERVER_USERNAME: username,
    OPENCODE_SERVER_PASSWORD: password,
    ...(config ? {OPENCODE_CONFIG_CONTENT: JSON.stringify(config)} : {}),
  } as NodeJS.ProcessEnv;
  return {
    env,
    authorizationHeader: `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`,
  };
}

function allocateCandidateOpenCodePort(hostname: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const reservation = net.createServer();
    reservation.unref();
    reservation.once('error', reject);
    reservation.listen(0, hostname, () => {
      const address = reservation.address();
      if (!address || typeof address === 'string') {
        reservation.close();
        reject(new Error('Unable to reserve an OpenCode server port'));
        return;
      }
      const port = address.port;
      reservation.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function isOpenCodePortCollision(error: unknown): boolean {
  if (error instanceof OpenCodeServerStartError) return error.portCollision;
  const candidate = error as {code?: unknown; message?: unknown};
  return candidate?.code === 'EADDRINUSE' ||
    /EADDRINUSE|address already in use|port is already in use/i.test(String(candidate?.message || ''));
}

async function createOpenCodeInstanceWithExplicitEnv(
  sdk: OpenCodeSdkModule,
  dirs: OpenCodeSessionDirs,
  env: EnvLike,
  options: Record<string, unknown>,
  deps: OpenCodeProcessDeps = {},
): Promise<OpenCodeInstance> {
  const hostname = typeof options.hostname === 'string' ? options.hostname : '127.0.0.1';
  const configuredPort = typeof options.port === 'number' && options.port > 0
    ? options.port
    : undefined;
  const allocatePort = deps.allocatePort ?? allocateCandidateOpenCodePort;
  const config = isRecord(options.config) ? options.config : {};
  const isolation = createIsolatedOpenCodeProcessEnv(dirs, env, config);
  if (!sdk.createOpencodeClient) {
    if (!sdk.createOpencodeWithEnv) {
      throw new Error('OpenCode adapter does not support explicit per-process environment isolation');
    }
    for (let attempt = 1; attempt <= (configuredPort ? 1 : OPENCODE_START_MAX_ATTEMPTS); attempt += 1) {
      const port = configuredPort ?? await allocatePort(hostname);
      try {
        return await sdk.createOpencodeWithEnv({...options, port}, isolation.env);
      } catch (error) {
        if (configuredPort || attempt === OPENCODE_START_MAX_ATTEMPTS || !isOpenCodePortCollision(error)) {
          throw error;
        }
      }
    }
    throw new Error('OpenCode server failed to start after port collision retries');
  }
  const timeout = typeof options.timeout === 'number' ? options.timeout : DEFAULT_SERVER_TIMEOUT_MS;
  const spawnChild = deps.spawnChild ?? ((executable, args, spawnOptions) => (
    spawn(executable, args, spawnOptions) as ChildProcess
  ));
  for (let attempt = 1; attempt <= (configuredPort ? 1 : OPENCODE_START_MAX_ATTEMPTS); attempt += 1) {
    const port = configuredPort ?? await allocatePort(hostname);
    const args = ['serve', `--hostname=${hostname}`, `--port=${port}`];
    if (typeof config.logLevel === 'string') args.push(`--log-level=${config.logLevel}`);
    const child = spawnChild(resolveOpenCodeCliPath(), args, {
      cwd: dirs.projectDir,
      env: isolation.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    try {
      const url = await waitForOpenCodeServer(child, timeout);
      const client = sdk.createOpencodeClient({
        baseUrl: url,
        headers: {Authorization: isolation.authorizationHeader},
      });
      return {
        client,
        server: {url, close: () => terminateOpenCodeChild(child)},
      };
    } catch (error) {
      await terminateOpenCodeChild(child);
      if (configuredPort || attempt === OPENCODE_START_MAX_ATTEMPTS || !isOpenCodePortCollision(error)) {
        throw error;
      }
    }
  }
  throw new Error('OpenCode server failed to start after port collision retries');
}

function waitForOpenCodeServer(child: ChildProcess, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const maxStartupOutputChars = 64 * 1024;
    let output = '';
    let settled = false;
    let timer: NodeJS.Timeout;
    const cleanup = (): void => {
      clearTimeout(timer);
      child.removeListener('error', onError);
      child.removeListener('exit', onExit);
      child.stdout?.removeListener('data', inspect);
      child.stderr?.removeListener('data', inspect);
    };
    const finish = (error?: Error, url?: string): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else {
        // The long-lived server keeps stdout/stderr piped. Continue draining
        // both streams after startup without retaining provider/private logs,
        // otherwise a full OS pipe buffer can deadlock the child.
        child.stdout?.resume();
        child.stderr?.resume();
        resolve(url!);
      }
    };
    const inspect = (chunk: Buffer | string): void => {
      output = `${output}${chunk.toString()}`.slice(-maxStartupOutputChars);
      for (const line of output.split(/\r?\n/)) {
        const match = line.match(/opencode server listening.*on\s+(https?:\/\/[^\s]+)/);
        if (match) finish(undefined, match[1]);
      }
    };
    const onError = (error: Error): void => finish(new OpenCodeServerStartError(
      error.message,
      isOpenCodePortCollision(error),
    ));
    const onExit = (code: number | null): void => finish(new OpenCodeServerStartError(
      `OpenCode server exited code=${code ?? 'unknown'} ${diagnosticLogIdentity(output, {domain: 'opencode_process', code: 'process_exit'})}`,
      /EADDRINUSE|address already in use|port is already in use/i.test(output),
    ));
    child.stdout?.on('data', inspect);
    child.stderr?.on('data', inspect);
    child.once('error', onError);
    child.once('exit', onExit);
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      const timeoutError = new Error(
        `OpenCode server start timeout after ${timeoutMs}ms ${diagnosticLogIdentity(output, {domain: 'opencode_process', code: 'start_timeout'})}`,
      );
      void terminateOpenCodeChild(child).then(() => reject(timeoutError), () => reject(timeoutError));
    }, timeoutMs);
  });
}

function windowsTaskkillArgs(pid: number): string[] {
  return ['/PID', String(pid), '/T', '/F'];
}

async function terminateWindowsProcessTree(pid: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const killer = spawn('taskkill', windowsTaskkillArgs(pid), {
      stdio: 'ignore',
      windowsHide: true,
    });
    killer.once('error', reject);
    killer.once('exit', code => {
      if (code === 0) resolve();
      else reject(new Error(`taskkill exited with code ${code ?? 'unknown'}`));
    });
  });
}

async function terminateOpenCodeChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32' && child.pid) {
    try {
      await terminateWindowsProcessTree(child.pid);
    } catch {
      // Best-effort fallback for an already-exited/unavailable taskkill. The
      // primary Windows path above always targets the complete process tree.
      child.kill();
    }
    return;
  }
  child.kill('SIGTERM');
  await new Promise<void>(resolve => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      const forceTimer = setTimeout(resolve, 500);
      child.once('exit', () => {
        clearTimeout(forceTimer);
        resolve();
      });
    }, 2_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function getProviderForSelection(
  selection: RuntimeSelection<string>,
  providerScope?: ProviderScope,
): ProviderConfig | undefined {
  if (selection.source !== 'provider' || !selection.providerId) return undefined;
  return getProviderService().getRawProvider(selection.providerId, providerScope);
}

function createOpenCodeProviderConfig(
  providerID: string,
  modelID: string,
  options: {
    name?: string;
    baseURL?: string;
    apiKey?: string;
  },
): Record<string, unknown> {
  return {
    [providerID]: {
      npm: '@ai-sdk/openai-compatible',
      name: options.name ?? 'SmartPerfetto OpenAI-compatible',
      options: {
        ...(options.baseURL ? { baseURL: options.baseURL } : {}),
        ...(options.apiKey ? { apiKey: options.apiKey } : {}),
      },
      models: {
        [modelID]: {
          id: modelID,
          name: modelID,
          tool_call: true,
          reasoning: false,
          temperature: true,
          cost: { input: 0, output: 0 },
          modalities: { input: ['text'], output: ['text'] },
          status: 'active',
        },
      },
    },
  };
}

function resolveOpenCodeModelConfig(
  env: EnvLike,
  selection: RuntimeSelection<string>,
  providerScope?: ProviderScope,
): OpenCodeModelConfig {
  const provider = getProviderForSelection(selection, providerScope);
  const providerModelJson = provider?.connection.openCodeModelJson?.trim();
  const rawModel = providerModelJson || env[OPENCODE_MODEL_JSON_ENV]?.trim();
  if (rawModel) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(rawModel) as Record<string, unknown>;
    } catch {
      throw new Error(`${OPENCODE_MODEL_JSON_ENV} must be valid JSON`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${OPENCODE_MODEL_JSON_ENV} must be a JSON object`);
    }
    const providerID = normalizeOptionalString(parsed.providerID)
      || normalizeOptionalString(parsed.providerId)
      || normalizeOptionalString(parsed.provider)
      || 'smartperfetto';
    const modelID = normalizeOptionalString(parsed.modelID)
      || normalizeOptionalString(parsed.modelId)
      || normalizeOptionalString(parsed.model)
      || normalizeOptionalString(parsed.id);
    if (!modelID) throw new Error(`${OPENCODE_MODEL_JSON_ENV} must include modelID/model/id`);
    const baseURL = normalizeOptionalString(parsed.baseURL)
      || normalizeOptionalString(parsed.baseUrl);
    const apiKey = normalizeOptionalString(parsed.apiKey)
      || (normalizeOptionalString(parsed.apiKeyEnv)
        ? env[normalizeOptionalString(parsed.apiKeyEnv)!]?.trim()
        : undefined);
    return {
      model: { providerID, modelID },
      providerConfig: createOpenCodeProviderConfig(providerID, modelID, {
        baseURL,
        apiKey,
        name: normalizeOptionalString(parsed.name),
      }),
      smallModel: normalizeOptionalString(parsed.smallModel)
        || normalizeOptionalString(parsed.smallModelID),
    };
  }

  const providerConnection = provider?.connection;
  const modelID = provider?.models.primary
    || env.OPENAI_MODEL
    || env.SMARTPERFETTO_OPENCODE_MODEL;
  const baseURL = providerConnection?.openaiBaseUrl
    || providerConnection?.baseUrl
    || env.OPENAI_BASE_URL;
  const apiKey = providerConnection?.openaiApiKey
    || providerConnection?.apiKey
    || env.OPENAI_API_KEY;
  if (!modelID) {
    throw new Error(`${OPENCODE_MODEL_JSON_ENV} or an OpenAI-compatible primary model is required for OpenCode`);
  }
  if (!baseURL) {
    throw new Error(`${OPENCODE_MODEL_JSON_ENV} or an OpenAI-compatible base URL is required for OpenCode`);
  }
  return {
    model: { providerID: 'smartperfetto', modelID },
    providerConfig: createOpenCodeProviderConfig('smartperfetto', modelID, {
      baseURL,
      apiKey,
      name: provider?.name,
    }),
    smallModel: provider?.models.light
      ? `smartperfetto/${provider.models.light}`
      : env.OPENAI_LIGHT_MODEL
        ? `smartperfetto/${env.OPENAI_LIGHT_MODEL}`
        : undefined,
  };
}

export type OpenCodeModelConfigurationValidation =
  | {configured: true}
  | {configured: false; reason: 'invalid_json' | 'incomplete'; error: string};

export function validateOpenCodeModelConfiguration(
  env: EnvLike,
  selection: RuntimeSelection<string>,
  providerScope?: ProviderScope,
): OpenCodeModelConfigurationValidation {
  try {
    resolveOpenCodeModelConfig(env, selection, providerScope);
    return {configured: true};
  } catch (error) {
    return {
      configured: false,
      reason: error instanceof Error && error.message === `${OPENCODE_MODEL_JSON_ENV} must be valid JSON`
        ? 'invalid_json'
        : 'incomplete',
      error: 'OpenCode model configuration is invalid or incomplete; set valid SMARTPERFETTO_OPENCODE_MODEL_JSON or an OpenAI-compatible model and base URL.',
    };
  }
}

/** Register an explicitly configured same-provider light model with its complete connection. */
function registerOpenCodeLightModel(config: OpenCodeModelConfig): OpenCodeModelConfig {
  const configured = config.smallModel?.trim();
  if (!configured || !config.providerConfig) return {...config, smallModel: undefined};
  const prefix = `${config.model.providerID}/`;
  const lightId = configured.startsWith(prefix) ? configured.slice(prefix.length)
    : configured.includes('/') ? undefined : configured;
  const provider = config.providerConfig[config.model.providerID];
  const models = isRecord(provider) && isRecord(provider.models) ? provider.models : undefined;
  const primary = models?.[config.model.modelID];
  if (!lightId || !isRecord(provider) || !models || !isRecord(primary)) {
    return {...config, smallModel: undefined};
  }
  return {
    ...config, smallModel: `${prefix}${lightId}`,
    providerConfig: {...config.providerConfig, [config.model.providerID]: {
      ...provider, models: {...models, [lightId]: {...primary, id: lightId, name: lightId}},
    }},
  };
}

function extractTextParts(value: unknown): string {
  if (!value) return '';
  if (Array.isArray(value)) {
    return value
      .map(part => isRecord(part) && part.type === 'text' && typeof part.text === 'string' ? part.text : '')
      .filter(Boolean)
      .join('\n');
  }
  if (!isRecord(value)) return '';
  if (value.type === 'text' && typeof value.text === 'string') return value.text;
  return Array.isArray(value.parts) ? extractTextParts(value.parts) : '';
}

function getOpenCodeMessageRole(value: Record<string, unknown>): string | undefined {
  if (typeof value.role === 'string') return value.role;
  const info = isRecord(value.info) ? value.info : undefined;
  return typeof info?.role === 'string' ? info.role : undefined;
}

function collectOpenCodeAssistantTexts(value: unknown, output: string[]): void {
  if (!value) return;
  if (Array.isArray(value)) {
    for (const item of value) collectOpenCodeAssistantTexts(item, output);
    return;
  }
  if (!isRecord(value)) return;

  if (getOpenCodeMessageRole(value) === 'assistant') {
    const text = extractTextParts(value).trim();
    if (text) output.push(text);
    return;
  }

  for (const key of ['data', 'message', 'messages', 'response', 'result']) {
    if (key in value) collectOpenCodeAssistantTexts(value[key], output);
  }
}

export function extractOpenCodeAssistantText(value: unknown): string {
  const assistantTexts: string[] = [];
  collectOpenCodeAssistantTexts(value, assistantTexts);
  const nonEmptyAssistantTexts = assistantTexts.filter(Boolean);
  const assistantText = selectBestOpenCodeAssistantText(nonEmptyAssistantTexts);
  if (assistantText) return assistantText;
  return '';
}

function selectBestOpenCodeAssistantText(texts: readonly string[]): string | undefined {
  return texts[texts.length - 1];
}

function collectOpenCodeAssistantMessages(value: unknown, output: Record<string, unknown>[]): void {
  if (!value) return;
  if (Array.isArray(value)) {
    for (const item of value) collectOpenCodeAssistantMessages(item, output);
    return;
  }
  if (!isRecord(value)) return;
  if (getOpenCodeMessageRole(value) === 'assistant') {
    output.push(value);
    return;
  }
  for (const key of ['data', 'message', 'messages', 'response', 'result']) {
    if (key in value) collectOpenCodeAssistantMessages(value[key], output);
  }
}

function getOpenCodeAssistantMessages(value: unknown): Record<string, unknown>[] {
  const messages: Record<string, unknown>[] = [];
  collectOpenCodeAssistantMessages(value, messages);
  return messages;
}

interface OpenCodeAssistantMessageWatermark {
  id?: string;
  signature: string;
}

function getOpenCodeAssistantMessageId(message: Record<string, unknown>): string | undefined {
  const info = isRecord(message.info) ? message.info : message;
  return typeof info.id === 'string'
    ? info.id
    : typeof message.id === 'string'
      ? message.id
      : undefined;
}

function projectOpenCodeStructuredValue(value: unknown): unknown {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(entry => projectOpenCodeStructuredValue(entry));
  }
  if (!isRecord(value)) {
    return String(value);
  }
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .filter(key => value[key] !== undefined)
      .map(key => [key, projectOpenCodeStructuredValue(value[key])]),
  );
}

function getOpenCodeAssistantStructuredContent(message: Record<string, unknown>): unknown {
  const structured: Record<string, unknown> = {};
  if ('parts' in message) {
    structured.parts = projectOpenCodeStructuredValue(message.parts);
  }
  if ('content' in message) {
    structured.content = projectOpenCodeStructuredValue(message.content);
  }
  if (Object.keys(structured).length === 0) {
    structured.text = extractTextParts(message).trim();
  }
  return structured;
}

function getOpenCodeAssistantMessageSignature(message: Record<string, unknown>): string {
  const info = isRecord(message.info) ? message.info : message;
  const id = getOpenCodeAssistantMessageId(message) ?? '';
  const time = isRecord(info.time) ? info.time : undefined;
  const completed = typeof time?.completed === 'number' ? time.completed : '';
  const finish = typeof info.finish === 'string' ? info.finish : '';
  const digest = canonicalContentHash({
    id,
    completed,
    finish,
    structuredContent: getOpenCodeAssistantStructuredContent(message),
  });
  return `sha256:${digest}`;
}

function createOpenCodeAssistantMessageWatermark(
  message: Record<string, unknown> | undefined,
): OpenCodeAssistantMessageWatermark | undefined {
  return message ? {
    id: getOpenCodeAssistantMessageId(message),
    signature: getOpenCodeAssistantMessageSignature(message),
  } : undefined;
}

function getOpenCodeAssistantMessagesAfterBaseline(
  messagesResponse: unknown,
  baselineWatermark: OpenCodeAssistantMessageWatermark | undefined,
): Record<string, unknown>[] {
  const messages = getOpenCodeAssistantMessages(messagesResponse);
  if (!baselineWatermark) return [...messages].reverse();

  const baselineIndex = messages.findIndex(
    message => getOpenCodeAssistantMessageSignature(message) === baselineWatermark.signature,
  );
  if (baselineIndex >= 0) return messages.slice(0, baselineIndex).reverse();
  if (baselineWatermark.id) {
    const reusedIdIndex = messages.findIndex(
      message => getOpenCodeAssistantMessageId(message) === baselineWatermark.id,
    );
    if (reusedIdIndex >= 0) return messages.slice(0, reusedIdIndex + 1).reverse();
  }
  return [...messages].reverse();
}

function hasOpenCodeAssistantBaselineBoundary(
  messagesResponse: unknown,
  baselineWatermark: OpenCodeAssistantMessageWatermark,
): boolean {
  const messages = getOpenCodeAssistantMessages(messagesResponse);
  return messages.some(message => (
    getOpenCodeAssistantMessageSignature(message) === baselineWatermark.signature ||
    Boolean(
      baselineWatermark.id &&
      getOpenCodeAssistantMessageId(message) === baselineWatermark.id,
    )
  ));
}

function getOpenCodeRawMessageWindowCount(messagesResponse: unknown): number {
  if (Array.isArray(messagesResponse)) return messagesResponse.length;
  if (!isRecord(messagesResponse)) return 0;
  for (const key of ['messages', 'items', 'result']) {
    if (Array.isArray(messagesResponse[key])) return messagesResponse[key].length;
  }
  return 0;
}

function nextOpenCodeMessageWindowLimit(limit: number): number {
  return Math.min(OPENCODE_MESSAGE_WINDOW_MAX_LIMIT, limit * 2);
}

function openCodeAssistantMessagesResponse(messages: Record<string, unknown>[]): unknown {
  return { data: messages };
}

function recordOpenCodeAssistantUsage(
  messages: readonly Record<string, unknown>[],
): void {
  for (const message of messages) {
    recordEvaluationTokenDeltaIfPresent(
      isRecord(message.info) ? message.info.usage ?? message.info.tokens : message,
    );
  }
}

function getLatestOpenCodeAssistantMessage(value: unknown): Record<string, unknown> | undefined {
  const messages = getOpenCodeAssistantMessages(value);
  return messages[messages.length - 1];
}

function isOpenCodeAssistantMessageComplete(message: Record<string, unknown> | undefined): boolean {
  if (!message) return false;
  const info = isRecord(message.info) ? message.info : message;
  if (info.error != null) return true;
  if (typeof info.finish === 'string' && info.finish.trim()) {
    return info.finish.trim() !== 'tool-calls';
  }
  const time = isRecord(info.time) ? info.time : undefined;
  return typeof time?.completed === 'number';
}

type OpenCodeSessionStatus = 'idle' | 'active' | 'unknown';

function getOpenCodeSessionStatus(statusResponse: unknown, sessionId: string): OpenCodeSessionStatus {
  if (!isRecord(statusResponse)) return 'unknown';
  const statusMap = isRecord(statusResponse.data) ? statusResponse.data : statusResponse;
  const directStatus = isRecord(statusMap[sessionId]) ? statusMap[sessionId] : undefined;
  if (!directStatus || typeof directStatus.type !== 'string') return 'unknown';
  return directStatus.type === 'idle' ? 'idle' : 'active';
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function openCodePromptAbortError(): Error {
  const error = new Error('OpenCode prompt aborted');
  error.name = 'AbortError';
  return error;
}

function openCodePromptTimeoutError(timeoutMs: number): Error {
  return Object.assign(new Error(`OpenCode prompt timed out after ${timeoutMs}ms`), {
    name: 'TimeoutError', code: 'OPENCODE_PROMPT_TIMEOUT', timeoutMs,
  });
}

function throwIfOpenCodePromptStopped(options: {
  signal?: AbortSignal;
  isAborted?: () => boolean;
  deadlineAt: number;
  timeoutMs: number;
}): void {
  if (options.signal?.aborted || options.isAborted?.()) {
    throw openCodePromptAbortError();
  }
  if (Date.now() >= options.deadlineAt) {
    throw openCodePromptTimeoutError(options.timeoutMs);
  }
}

function awaitOpenCodePromptOperation<T>(
  operation: () => Promise<T> | T,
  options: {
    signal?: AbortSignal;
    isAborted?: () => boolean;
    deadlineAt: number;
    timeoutMs: number;
  },
): Promise<T> {
  throwIfOpenCodePromptStopped(options);
  const remainingMs = Math.max(1, options.deadlineAt - Date.now());
  const operationPromise = Promise.resolve().then(operation);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(openCodePromptAbortError()));
    const timer = setTimeout(() => {
      finish(() => reject(openCodePromptTimeoutError(options.timeoutMs)));
    }, remainingMs);
    options.signal?.addEventListener('abort', onAbort, {once: true});
    if (options.signal?.aborted || options.isAborted?.()) {
      onAbort();
    }
    operationPromise.then(
      value => finish(() => {
        try {
          throwIfOpenCodePromptStopped(options);
          resolve(value);
        } catch (error) {
          reject(error);
        }
      }),
      error => finish(() => reject(error)),
    );
  });
}

async function resolveOpenCodeCurrentTurnMessages(options: {
  initialMessagesResponse: unknown;
  baselineWatermark: OpenCodeAssistantMessageWatermark | undefined;
  fetchWindow: (limit: number) => Promise<unknown>;
}): Promise<Record<string, unknown>[]> {
  let messagesResponse = options.initialMessagesResponse;
  let limit = OPENCODE_MESSAGE_WINDOW_INITIAL_LIMIT;
  while (true) {
    const rawWindowCount = getOpenCodeRawMessageWindowCount(messagesResponse);
    if (
      options.baselineWatermark
        ? hasOpenCodeAssistantBaselineBoundary(messagesResponse, options.baselineWatermark)
        : rawWindowCount < limit
    ) {
      const currentMessages = getOpenCodeAssistantMessagesAfterBaseline(
        messagesResponse,
        options.baselineWatermark,
      );
      // A fresh session still has a bounded messages API. Expand a full window
      // before counting, and count each native message ID only once.
      const seenIds = new Set<string>();
      return [...currentMessages].reverse().filter(message => {
        const id = getOpenCodeAssistantMessageId(message);
        if (!id) return true;
        if (seenIds.has(id)) return false;
        seenIds.add(id);
        return true;
      }).reverse();
    }

    if (rawWindowCount < limit) {
      throw new Error('OpenCode current-turn history no longer contains the restored assistant watermark');
    }
    if (limit >= OPENCODE_MESSAGE_WINDOW_MAX_LIMIT) {
      throw new Error(
        `OpenCode current-turn history exceeded the bounded ${OPENCODE_MESSAGE_WINDOW_MAX_LIMIT}-message window`,
      );
    }

    limit = nextOpenCodeMessageWindowLimit(limit);
    messagesResponse = await options.fetchWindow(limit);
  }
}

export async function runOpenCodePrompt(
  opencode: OpenCodeInstance,
  promptInput: OpenCodePromptInput,
  options: {
    sessionId: string;
    projectDir: string;
    timeoutMs: number;
    isAborted?: () => boolean;
    signal?: AbortSignal;
    onFirstAssistantMessage?: () => void;
    resumedSession?: boolean;
    pollDelay?: (ms: number) => Promise<void>;
    adaptiveObservation?: boolean;
    maxSteps?: number;
    onTurnLimit?: () => void;
  },
): Promise<{ promptResponse?: unknown; messagesResponse?: unknown; turnLimitReached?: boolean;
  turnLimitCandidate?: Record<string, unknown> }> {
  const {
    sessionId,
    projectDir,
    timeoutMs,
    isAborted,
    signal,
    onFirstAssistantMessage,
    resumedSession = true,
    pollDelay = delay,
    adaptiveObservation = isRuntimeCandidateAdmitted('task8'),
  } = options;
  const deadlineAt = Date.now() + timeoutMs;
  const waitOptions = {signal, isAborted, deadlineAt, timeoutMs};
  const awaitOperation = <T>(operation: () => Promise<T> | T): Promise<T> =>
    awaitOpenCodePromptOperation(operation, waitOptions);
  const throwIfStopped = (): void => throwIfOpenCodePromptStopped(waitOptions);
  const fetchMessagesWindow = async (limit: number, context = 'OpenCode messages'): Promise<unknown> =>
    unwrapSdkData(await awaitOperation(() => opencode.client.session.messages!({
      path: {id: sessionId},
      query: {directory: projectDir, limit, order: 'desc'},
    })), context);
  const recordFirstAssistantMessage = (): void => {
    try {
      onFirstAssistantMessage?.();
    } catch {
      // Runtime performance is internal observability only.
    }
  };
  let turnLimitCandidate: Record<string, unknown> | undefined;
  const stopAtTurnLimit = async (messages: Record<string, unknown>[], baselineWatermark?: OpenCodeAssistantMessageWatermark) => {
    if (options.maxSteps === undefined || messages.length < options.maxSteps) return false;
    const latest = messages[messages.length - 1];
    const info = latest && (isRecord(latest.info) ? latest.info : latest);
    // An error or output-token limit does not authorize a budget closeout.
    if (info?.error != null || info?.finish === 'length' || info?.finish === 'error') return false;
    const naturalEnd = info?.finish === 'stop' || info?.finish === 'end_turn' || info?.finish === 'stop_sequence';
    if (naturalEnd && messages.length === options.maxSteps) return false;
    turnLimitCandidate = structuredClone([...messages].reverse().find(message => extractTextParts(message).trim()) ?? latest);
    options.onTurnLimit?.();
    if (opencode.client.session.abort) {
      await awaitOperation(() => opencode.client.session.abort!({path: {id: sessionId}}));
      if (opencode.client.session.messages) {
        const finalMessages = await resolveOpenCodeCurrentTurnMessages({
          initialMessagesResponse: await fetchMessagesWindow(OPENCODE_MESSAGE_WINDOW_INITIAL_LIMIT),
          baselineWatermark, fetchWindow: limit => fetchMessagesWindow(limit),
        });
        if (finalMessages.length >= messages.length) messages.splice(0, messages.length, ...finalMessages);
      }
    } else {
      // Old SDKs cannot cancel an active session; close the owned host before
      // returning so it cannot keep acquiring data in the background.
      await awaitOperation(() => opencode.server.close());
    }
    return true;
  };
  if (opencode.client.session.promptAsync && opencode.client.session.messages) {
    throwIfStopped();
    const baselineMessagesResponse = resumedSession
      ? unwrapSdkData(await awaitOperation(() => opencode.client.session.messages!({
          path: {id: sessionId},
          query: {directory: projectDir, limit: 1, order: 'desc'},
        })), 'OpenCode messages')
      : undefined;
    throwIfStopped();
    const baselineWatermark = createOpenCodeAssistantMessageWatermark(
      getOpenCodeAssistantMessages(baselineMessagesResponse)[0],
    );

    commitEvaluationSdkHandoffIfActive();
    assertSdkSuccess(
      await awaitOperation(() => opencode.client.session.promptAsync!(promptInput)),
      'OpenCode async prompt',
    );
    let messagesResponse: unknown;
    let firstAssistantMessageObserved = false;
    let pollIntervalMs = adaptiveObservation
      ? PROMPT_POLL_INITIAL_INTERVAL_MS
      : PROMPT_POLL_MAX_INTERVAL_MS;
    while (true) {
      throwIfStopped();
      const readMessages = () => opencode.client.session.messages!({
          path: {id: sessionId},
          query: {directory: projectDir, limit: OPENCODE_MESSAGE_WINDOW_INITIAL_LIMIT, order: 'desc'},
        });
      const readStatus = () => opencode.client.session.status
          ? opencode.client.session.status({query: {directory: projectDir}})
          : Promise.resolve(undefined);
      let rawMessagesResponse: unknown;
      let statusResponse: unknown;
      if (adaptiveObservation) {
        [rawMessagesResponse, statusResponse] = await awaitOperation(() => Promise.all([
          readMessages(),
          readStatus(),
        ]));
      } else {
        rawMessagesResponse = await awaitOperation(readMessages);
        statusResponse = await awaitOperation(readStatus);
      }
      messagesResponse = unwrapSdkData(rawMessagesResponse, 'OpenCode messages');
      throwIfStopped();
      const newAssistantMessages = await resolveOpenCodeCurrentTurnMessages({
        initialMessagesResponse: messagesResponse,
        baselineWatermark,
        fetchWindow: limit => fetchMessagesWindow(limit),
      });
      if (!firstAssistantMessageObserved && newAssistantMessages.length > 0) {
        firstAssistantMessageObserved = true;
        recordFirstAssistantMessage();
      }
      const currentTurnMessagesResponse = openCodeAssistantMessagesResponse(newAssistantMessages);
      const latestAssistant = newAssistantMessages[newAssistantMessages.length - 1];
      const latestAssistantComplete = isOpenCodeAssistantMessageComplete(latestAssistant);
      if (await stopAtTurnLimit(newAssistantMessages, baselineWatermark)) {
        recordOpenCodeAssistantUsage(newAssistantMessages);
        return {messagesResponse: openCodeAssistantMessagesResponse(newAssistantMessages), turnLimitReached: true, turnLimitCandidate};
      }
      if (statusResponse !== undefined) {
        throwIfStopped();
        assertSdkSuccess(statusResponse, 'OpenCode session status');
        const sessionStatus = getOpenCodeSessionStatus(statusResponse, sessionId);
        if (
          sessionStatus === 'idle' && latestAssistant
        ) {
          const finalMessagesResponse = await fetchMessagesWindow(
            OPENCODE_MESSAGE_WINDOW_INITIAL_LIMIT,
            'OpenCode final messages',
          );
          throwIfStopped();
          const finalAssistantMessages = await resolveOpenCodeCurrentTurnMessages({
            initialMessagesResponse: finalMessagesResponse,
            baselineWatermark,
            fetchWindow: limit => fetchMessagesWindow(limit, 'OpenCode final messages'),
          });
          const latestCanonical = finalAssistantMessages[finalAssistantMessages.length - 1];
          if (await stopAtTurnLimit(finalAssistantMessages, baselineWatermark)) {
            recordOpenCodeAssistantUsage(finalAssistantMessages);
            return {messagesResponse: openCodeAssistantMessagesResponse(finalAssistantMessages), turnLimitReached: true, turnLimitCandidate};
          }
          if (
            latestCanonical &&
            (isOpenCodeAssistantMessageComplete(latestCanonical) ||
              (options.maxSteps !== undefined && finalAssistantMessages.length >= options.maxSteps))
          ) {
            recordOpenCodeAssistantUsage(finalAssistantMessages);
            return {messagesResponse: openCodeAssistantMessagesResponse(finalAssistantMessages)};
          }
        }
        if (sessionStatus === 'unknown' && latestAssistantComplete) {
          recordOpenCodeAssistantUsage(newAssistantMessages);
          return { messagesResponse: currentTurnMessagesResponse };
        }
      } else if (latestAssistantComplete) {
        recordOpenCodeAssistantUsage(newAssistantMessages);
        return { messagesResponse: currentTurnMessagesResponse };
      }
      const remainingMs = Math.max(1, deadlineAt - Date.now());
      await awaitOperation(() => pollDelay(Math.min(pollIntervalMs, remainingMs)));
      if (adaptiveObservation) {
        pollIntervalMs = Math.min(PROMPT_POLL_MAX_INTERVAL_MS, pollIntervalMs * 2);
      }
    }
  }

  throwIfStopped();
  const baselineMessagesResponse = resumedSession && opencode.client.session.messages
    ? unwrapSdkData(await awaitOperation(() => opencode.client.session.messages!({
        path: { id: sessionId },
        query: { directory: projectDir, limit: 1, order: 'desc' },
      })), 'OpenCode messages')
    : undefined;
  throwIfStopped();
  const baselineWatermark = createOpenCodeAssistantMessageWatermark(
    getOpenCodeAssistantMessages(baselineMessagesResponse)[0],
  );
  commitEvaluationSdkHandoffIfActive();
  const promptResponse = unwrapSdkData(
    await awaitOperation(() => opencode.client.session.prompt(promptInput)),
    'OpenCode prompt',
  );
  throwIfStopped();
  const allMessagesResponse = opencode.client.session.messages
    ? await fetchMessagesWindow(OPENCODE_MESSAGE_WINDOW_INITIAL_LIMIT)
    : undefined;
  const currentTurnMessages = await resolveOpenCodeCurrentTurnMessages({
    initialMessagesResponse: allMessagesResponse,
    baselineWatermark,
    fetchWindow: limit => fetchMessagesWindow(limit),
  });
  const promptAssistantMessages = getOpenCodeAssistantMessages(promptResponse).filter(message =>
    !baselineWatermark || getOpenCodeAssistantMessageSignature(message) !== baselineWatermark.signature);
  const directIds = new Set(promptAssistantMessages.map(getOpenCodeAssistantMessageId).filter(Boolean));
  const combinedMessages = [
    ...currentTurnMessages.filter(message => !directIds.has(getOpenCodeAssistantMessageId(message))),
    ...promptAssistantMessages,
  ];
  const messagesResponse = openCodeAssistantMessagesResponse(combinedMessages);
  const observedAssistantMessages = promptAssistantMessages.length > 0
    ? promptAssistantMessages
    : currentTurnMessages.slice(-1);
  if (observedAssistantMessages.length > 0) {
    recordFirstAssistantMessage();
  }
  recordOpenCodeAssistantUsage(observedAssistantMessages);
  const turnLimitReached = await stopAtTurnLimit(combinedMessages, baselineWatermark);
  return { promptResponse: openCodeAssistantMessagesResponse(promptAssistantMessages), messagesResponse,
    ...(turnLimitReached ? {turnLimitReached: true, turnLimitCandidate} : {}) };
}

export function getOpenCodePlanCompletionStatus(plan: AnalysisPlanV3 | null): AnalysisPlanCompletionStatus & {
  pending: string[];
} {
  const status = getAnalysisPlanCompletionStatus(plan, {
    minSummaryChars: MIN_PHASE_SUMMARY_CHARS,
  });
  const pending = status.hasPlan
    ? status.pendingPhases.map((phase: any) => phase.id || phase.title || 'unknown')
    : [];
  return { ...status, complete: !status.hasPlan || status.complete, pending };
}

/** @deprecated Final output does not implicitly complete a model-submitted plan. */
export function completeOpenCodeFinalReportPhaseIfDelivered(
  _plan: AnalysisPlanV3 | null,
  _conclusion: string,
  _outputLanguage: string,
  _now: () => number = Date.now,
): PlanPhase | undefined {
  return undefined;
}

export function sanitizeOpenCodeConclusionText(conclusion: string): string {
  return conclusion.trim();
}

export class OpenCodeRuntime extends EventEmitter implements IOrchestrator {
  private readonly env: EnvLike;
  private readonly moduleLoader: OpenCodeSdkModuleLoader;
  private readonly bridgeStarter: OpenCodeBridgeStarter;
  private readonly selection: RuntimeSelection<OpenCodeRuntimeKind>;
  private currentSessionId?: string;
  private currentServer?: OpenCodeServerHandle;
  private readonly activeSessions = new Map<string, OpenCodeActiveSession>();
  private readonly artifactStores = new Map<string, ArtifactStore>();
  private readonly sessionNotes = new Map<string, AnalysisNote[]>();
  private readonly sessionPlans = new Map<string, { current: AnalysisPlanV3 | null; history: AnalysisPlanV3[] }>();
  private readonly sessionHypotheses = new Map<string, Hypothesis[]>();
  private readonly sessionUncertaintyFlags = new Map<string, UncertaintyFlag[]>();
  private readonly architectureCache = new Map<string, ArchitectureInfo>();
  private readonly sessionOpaqueStates = new Map<string, OpenCodeOpaqueState>();
  private readonly executionGuard = new RuntimeExecutionGuard();

  constructor(
    private readonly input: RuntimeFactoryInput,
    options: OpenCodeRuntimeOptions = {},
  ) {
    super();
    this.env = options.env ?? input.env ?? process.env;
    this.moduleLoader = options.moduleLoader ?? loadOpenCodeSdkModule;
    this.bridgeStarter = options.bridgeStarter ?? startOpenCodeMcpBridge;
    this.selection = input.selection as RuntimeSelection<OpenCodeRuntimeKind>;
  }

  private emitOpenCodeStateDegraded(reason: string, fallback = 'fresh_session'): void {
    this.emitUpdate({
      type: 'degraded',
      content: {
        module: 'opencode',
        fallback,
        reason,
        message: 'OpenCode session state unavailable; started a fresh OpenCode session with SmartPerfetto context.',
      },
      timestamp: Date.now(),
    });
  }

  private resolveSessionDirs(sessionId: string, privateKnowledge = false): {
    dirs: OpenCodeSessionDirs;
    restoredOpenCodeSessionId?: string;
    ephemeralRoot?: string;
  } {
    if (privateKnowledge) {
      this.sessionOpaqueStates.delete(sessionId);
      const ephemeral = createEphemeralOpenCodeSessionDirs();
      return {dirs: ephemeral, ephemeralRoot: ephemeral.ephemeralRoot};
    }
    const restored = this.sessionOpaqueStates.get(sessionId);
    if (restored?.degradedReason) {
      this.emitOpenCodeStateDegraded(restored.degradedReason);
      this.sessionOpaqueStates.delete(sessionId);
      return { dirs: createDurableOpenCodeSessionDirs(sessionId, this.env) };
    }
    if (restored?.openCodeSessionId && openCodeOpaqueDirsExist(restored)) {
      return {
        dirs: {
          projectDir: restored.projectDir!,
          homeDir: restored.homeDir!,
          configDir: restored.configDir!,
        },
        // Reuse isolated provider directories, but logical history is injected
        // from SmartPerfetto's authorized context into a fresh native session.
      };
    }
    if (restored) {
      this.emitOpenCodeStateDegraded('missing_required_fields');
      this.sessionOpaqueStates.delete(sessionId);
    }
    return { dirs: createDurableOpenCodeSessionDirs(sessionId, this.env) };
  }

  private async createOpenCodeInstance(
    sdk: OpenCodeSdkModule,
    dirs: OpenCodeSessionDirs,
    options: Record<string, unknown>,
  ): Promise<OpenCodeInstance> {
    return createOpenCodeInstanceWithExplicitEnv(sdk, dirs, this.env, options);
  }

  private async canReuseOpenCodeSession(
    client: OpenCodeClient,
    openCodeSessionId: string,
    projectDir: string,
  ): Promise<boolean> {
    try {
      if (client.session.get) {
        const existing = unwrapSdkData(await client.session.get({
          path: { id: openCodeSessionId },
          query: { directory: projectDir },
        }), 'OpenCode restored session get');
        return Boolean(existing?.id);
      }
      if (client.session.messages) {
        unwrapSdkData(await client.session.messages({
          path: { id: openCodeSessionId },
          query: { directory: projectDir, limit: 1, order: 'asc' },
        }), 'OpenCode restored session messages');
        return true;
      }
    } catch {
      return false;
    }
    return false;
  }

  private async resolveOpenCodeSessionId(
    client: OpenCodeClient,
    sessionId: string,
    projectDir: string,
    restoredOpenCodeSessionId?: string,
  ): Promise<string> {
    if (restoredOpenCodeSessionId) {
      const reusable = await this.canReuseOpenCodeSession(client, restoredOpenCodeSessionId, projectDir);
      if (reusable) return restoredOpenCodeSessionId;
      this.emitOpenCodeStateDegraded('session_restore_failed');
      this.sessionOpaqueStates.delete(sessionId);
    }
    const created = unwrapSdkData(await client.session.create({
      query: { directory: projectDir },
      body: { title: `SmartPerfetto ${sessionId}` },
    }), 'OpenCode session create');
    return created.id;
  }

  async analyze(
    query: string,
    sessionId: string,
    traceId: string,
    options?: AnalysisOptions,
  ): Promise<AnalysisResult> {
    options = {
      ...(options ?? {}),
      analysisMode: options?.analysisMode ?? 'auto',
    };
    const executionLease = this.executionGuard.begin({
      runtime: OPENCODE_RUNTIME_KIND,
      sessionId,
      referenceTraceId: options.referenceTraceId,
      runId: options.runId,
    });
    const runtimePerformance = createRuntimePerformanceRun(
      options.runManifestAttributionSink,
    );
    let runtimePerformanceOutcome: RuntimePerformanceOutcome = 'ok';
    let result: AnalysisResult | undefined;
    try {
      executionLease.throwIfAborted();
      if (
        this.selection.kind === OPENCODE_RUNTIME_KIND ||
        truthyEnv(this.env[OPENCODE_REAL_ANALYSIS_ENV])
      ) {
        result = await this.analyzeWithSmartPerfettoTools(
          query,
          sessionId,
          traceId,
          options ?? {},
          executionLease,
          runtimePerformance,
        );
        executionLease.throwIfAborted();
        runtimePerformanceOutcome = executionLease.signal.aborted
          ? 'cancelled'
          : result.success === false ? 'error' : 'ok';
        return result;
      }
      result = await this.analyzeHiddenSmoke(query, sessionId, traceId, options ?? {}, executionLease, runtimePerformance);
      executionLease.throwIfAborted();
      runtimePerformanceOutcome = executionLease.signal.aborted
        ? 'cancelled'
        : result.success === false ? 'error' : 'ok';
      return result;
    } catch (error) {
      runtimePerformanceOutcome = runtimeOutcomeFromError(
        error,
        executionLease.signal,
      );
      throw error;
    } finally {
      const finalizationPhase = runtimePerformance.startPhase('finalization');
      try {
        executionLease.settle();
      } finally {
        finalizationPhase.end(runtimePerformanceOutcome);
        runtimePerformance.finalize(runtimePerformanceOutcome);
      }
    }
  }

  private async analyzeHiddenSmoke(
    query: string,
    sessionId: string,
    traceId: string,
    options: AnalysisOptions,
    executionLease: RuntimeExecutionLease,
    runtimePerformance: RuntimePerformanceRun,
  ): Promise<AnalysisResult> {
    const startedAt = Date.now();
    executionLease.throwIfAborted();
    this.emitUpdate({
      type: 'progress',
      content: 'Starting experimental OpenCode hidden runtime smoke',
      timestamp: Date.now(),
    });

    const sdkStartPhase = runtimePerformance.startPhase('sdk_start');
    let sdk: Awaited<ReturnType<OpenCodeSdkModuleLoader>>;
    try {
      sdk = await this.moduleLoader(this.env);
      sdkStartPhase.end('ok');
    } catch (error) {
      sdkStartPhase.end(runtimeOutcomeFromError(error, executionLease.signal));
      throw error;
    }
    executionLease.throwIfAborted();
    const privateKnowledge = analysisContextUsesPrivateKnowledge(options ?? {});
    const {dirs, restoredOpenCodeSessionId, ephemeralRoot} = this.resolveSessionDirs(
      sessionId,
      privateKnowledge,
    );
    const port = numericEnv(this.env[OPENCODE_SERVER_PORT_ENV]);
    const timeout = numericEnv(this.env[OPENCODE_SERVER_TIMEOUT_MS_ENV]) ?? DEFAULT_SERVER_TIMEOUT_MS;

    let activeSession: OpenCodeActiveSession | undefined;
    const abortController = new AbortController();
    try {
      const opencode = await this.createOpenCodeInstance(sdk, dirs, {
        hostname: '127.0.0.1',
        ...(port ? { port } : {}),
        timeout,
        config: createOpenCodeHardenedConfig([], this.env),
      });
      executionLease.throwIfAborted();
      activeSession = {
        server: opencode.server,
        client: opencode.client,
        abortController,
        aborted: false,
        projectDir: dirs.projectDir,
        homeDir: dirs.homeDir,
        configDir: dirs.configDir,
      };
      this.activeSessions.set(sessionId, activeSession);
      executionLease.throwIfAborted();
      this.currentServer = opencode.server;
      const openCodeSessionId = await this.resolveOpenCodeSessionId(
        opencode.client,
        sessionId,
        dirs.projectDir,
        restoredOpenCodeSessionId,
      );
      activeSession.openCodeSessionId = openCodeSessionId;
      this.currentSessionId = openCodeSessionId;
      executionLease.throwIfAborted();
      runtimePerformance.finishClassification('ok');
      const providerPhase = runtimePerformance.startPhase('provider');
      try {
        unwrapSdkData(await opencode.client.session.prompt({
        path: { id: openCodeSessionId },
        query: { directory: dirs.projectDir },
        body: {
          noReply: true,
          system: 'SmartPerfetto OpenCode hidden runtime smoke. Do not run tools.',
          tools: createOpenCodeToolAllowlist(),
          parts: [{ type: 'text', text: buildSmokePrompt(query, traceId, options) }],
        },
        }), 'OpenCode hidden prompt');
        providerPhase.end('ok');
      } catch (error) {
        providerPhase.end(runtimeOutcomeFromError(error, executionLease.signal));
        throw error;
      }
      executionLease.throwIfAborted();
    } finally {
      if (activeSession && !privateKnowledge && !executionLease.signal.aborted) {
        this.sessionOpaqueStates.set(sessionId, createOpenCodeOpaqueState(
          activeSession.openCodeSessionId,
          dirs,
        ));
      }
      await this.closeSessionHandle(sessionId, activeSession);
      if (ephemeralRoot) fs.rmSync(ephemeralRoot, {recursive: true, force: true});
    }

    const duration = Date.now() - startedAt;
    const conclusion = [
      'OpenCode hidden runtime smoke completed.',
      'This M13 path verifies server/session/config isolation only; it is not a full SmartPerfetto analysis result yet.',
      'Public OpenCode runtime exposure remains blocked until real startup/scrolling E2E and report verification pass.',
    ].join('\n');

    this.emitUpdate({
      type: 'conclusion',
      content: conclusion,
      timestamp: Date.now(),
    });

    return {
      sessionId,
      success: true,
      findings: [],
      hypotheses: [],
      conclusion,
      confidence: 0.1,
      rounds: 1,
      totalDurationMs: duration,
      partial: true,
      terminationReason: 'plan_incomplete',
      terminationMessage: 'experimental-opencode hidden smoke is not real analysis',
    };
  }

  private async analyzeWithSmartPerfettoTools(
    query: string,
    sessionId: string,
    traceId: string,
    options: AnalysisOptions,
    executionLease: RuntimeExecutionLease,
    runtimePerformance: RuntimePerformanceRun,
  ): Promise<AnalysisResult> {
    const startedAt = Date.now();
    executionLease.throwIfAborted();
    const outputLanguage = options.outputLanguage
      ?? parseOutputLanguage(this.env.SMARTPERFETTO_OUTPUT_LANGUAGE);
    const pinnedEnv = {...this.env};
    const modelConfig = registerOpenCodeLightModel(
      resolveOpenCodeModelConfig(pinnedEnv, this.selection, this.input.providerScope),
    );
    const classifierModel = modelConfig.smallModel
      ? {providerID: modelConfig.model.providerID,
          modelID: modelConfig.smallModel.slice(modelConfig.model.providerID.length + 1)}
      : modelConfig.model;
    let sdkPromise: Promise<OpenCodeSdkModule> | undefined;
    const loadSdk = () => sdkPromise ??= this.moduleLoader(this.env);
    const sessionContext = sessionContextManager.getOrCreate(sessionId, traceId);
    const authorizationScope = resolveKnowledgeScope(options);
    const authorizationFingerprint = options.analysisContextFingerprint ??
      buildAnalysisContextAuthorizationFingerprint(options, authorizationScope);
    const assertActive = () => {
      executionLease.throwIfAborted();
      assertCurrentAnalysisContextAuthorization(options, authorizationScope, authorizationFingerprint);
    };
    const analysisHistoryReader = createRuntimeAnalysisHistoryReader({options, sessionId, traceId,
      getTurns: () => sessionContext.getAnalysisHistory?.() ?? (sessionContext.getAllTurns?.() ?? [])
        .map(turn => toAnalysisHistoryTurn({...turn, traceId, sourceDerived: turn.result?.sourceDerived,
          analysisContextFingerprint: turn.result?.analysisContextFingerprint})), assertActive});
    const createNoToolsHost: OpenCodeIntentTransportInput['createClassifierHost'] = async ({signal, deadlineMs, model}) => {
      const sdk = await loadSdk();
      signal.throwIfAborted();
      const dirs = createEphemeralOpenCodeSessionDirs();
      let instance: OpenCodeInstance | undefined;
      try {
        const classifierEnv = {...pinnedEnv, [OPENCODE_ENABLE_STANDALONE_MCP_ENV]: '0'};
        const config = createOpenCodeHardenedConfig([], classifierEnv, undefined,
          {...modelConfig, model, smallModel: undefined}, 1);
        instance = await createOpenCodeInstanceWithExplicitEnv(sdk, dirs, classifierEnv, {
          hostname: '127.0.0.1', timeout: Math.max(1, deadlineMs - Date.now()), config,
        });
        // The transport owns late resources too: return the host even if its
        // deadline elapsed while the native server was being created.
        const host = instance;
        return {
          client: host.client as OpenCodeClassifierHost['client'],
          projectDir: dirs.projectDir,
          agentName: 'smartperfetto',
          disabledTools: createOpenCodeToolAllowlist([]),
          close: async () => {
            try { await host.server.close(); }
            finally { fs.rmSync(dirs.ephemeralRoot, {recursive: true, force: true}); }
          },
        };
      } catch (error) {
        try { await instance?.server.close(); }
        finally { fs.rmSync(dirs.ephemeralRoot, {recursive: true, force: true}); }
        throw error;
      }
    };
    const resolver = createAnalysisTurnIntentResolver({
      productRun: {options, runId: executionLease.key.runId!, sessionId, traceId},
      context: buildComplexityClassifierInput({
        query, sceneType: 'general', selectionContext: options.selectionContext,
        hasReferenceTrace: Boolean(options.referenceTraceId), previousTurns: [], history: analysisHistoryReader.getTurns(),
        requestedMode: options.analysisMode ?? 'auto',
      }),
      signal: executionLease.signal,
      deadlineMs: Date.now() + (numericEnv(this.env.OPENCODE_CLASSIFIER_TIMEOUT_MS) ?? 30_000),
      dispatch: input => runOpenCodeIntentTransport({
        ...input,
        model: classifierModel,
        createClassifierHost: createNoToolsHost,
      }),
    });
    const turnIntent = await resolver.resolve();
    const turnPolicy = resolveRuntimeTurnPolicy(turnIntent, options.analysisMode);
    runtimePerformance.finishClassification(turnIntent.status === 'resolved' ? 'ok' : 'error');
    executionLease.throwIfAborted();
    // The classifier and answer share a fully configured provider/model. A
    // failed optional classifier never switches the answer to an invalid light ID.
    const sdkStartPhase = runtimePerformance.startPhase('sdk_start');
    let sdk: OpenCodeSdkModule;
    try {
      const timeoutMs = numericEnv(this.env[OPENCODE_SERVER_TIMEOUT_MS_ENV]) ?? DEFAULT_SERVER_TIMEOUT_MS;
      sdk = await awaitOpenCodePromptOperation(loadSdk, {
        signal: executionLease.signal, deadlineAt: Date.now() + timeoutMs, timeoutMs,
      });
      sdkStartPhase.end('ok');
    } catch (error) {
      sdkStartPhase.end(runtimeOutcomeFromError(error, executionLease.signal));
      throw error;
    }
    executionLease.throwIfAborted();
    const closeoutTape = createRuntimeTurnCloseoutTape();
    let toolAdmissionsOpen = true;
    const quickBudget = resolveQuickTurnBudget({env: this.env, enforcement: 'timeout_only'});
    const maxSteps = turnPolicy.budgetMode === 'quick' ? quickBudget.hardCapTurns : resolveAgentRuntimeBudgetConfig(this.env).maxTurns;
    const turnBudget = resolveRuntimeTurnBudget(maxSteps);
    const promptTimeout = Math.min(
      numericEnv(this.env[OPENCODE_PROMPT_TIMEOUT_MS_ENV]) ?? DEFAULT_PROMPT_TIMEOUT_MS,
      turnPolicy.budgetMode === 'quick' ? maxSteps * (numericEnv(this.env.OPENCODE_QUICK_PER_TURN_MS) ?? 30_000) : DEFAULT_PROMPT_TIMEOUT_MS,
    );
    const sceneDeadlineMs = resolveSceneProductScope(options, {runId: executionLease.key.runId!, sessionId, traceId})
      ? Date.now() + promptTimeout : undefined;
    const prep = await this.prepareAnalysis(
      query, sessionId, traceId, options,
      `${modelConfig.model.providerID}/${modelConfig.model.modelID}`,
      turnIntent, turnPolicy, resolver.strategyRegistry, analysisHistoryReader, closeoutTape.observe,
      () => toolAdmissionsOpen && !executionLease.signal.aborted, sceneDeadlineMs, executionLease.signal,
    );
    executionLease.throwIfAborted();
    const resolveFinalReportSceneType = () => prep.sceneType;
    const abortController = new AbortController();
    const mcpTimeout = resolveOpenCodeMcpTimeoutMs(this.env[OPENCODE_MCP_TIMEOUT_MS_ENV]);
    const bridge = await this.bridgeStarter(
      prep.toolDefinitions,
      update => this.emitUpdate(update),
      {
        getSignal: () => abortController.signal,
        analysisPlan: prep.analysisPlan,
        timeoutMs: mcpTimeout,
      },
    );
    try {
      executionLease.throwIfAborted();
    } catch (error) {
      await bridge.close().catch(() => undefined);
      throw error;
    }
    const privateKnowledge = analysisContextUsesPrivateKnowledge(options);
    const {dirs, restoredOpenCodeSessionId, ephemeralRoot} = this.resolveSessionDirs(
      sessionId,
      privateKnowledge,
    );
    try {
      executionLease.throwIfAborted();
    } catch (error) {
      await bridge.close().catch(() => undefined);
      throw error;
    }
    const port = numericEnv(this.env[OPENCODE_SERVER_PORT_ENV]);
    const timeout = numericEnv(this.env[OPENCODE_SERVER_TIMEOUT_MS_ENV]) ?? DEFAULT_SERVER_TIMEOUT_MS;
    // SDK maxSteps forces a text-only iteration; it does not guarantee a total call cap.
    // The native answer and final semantic review share one absolute budget.
    const deadlineMs = sceneDeadlineMs ?? Date.now() + promptTimeout;
    const runId = options.runId ?? crypto.randomUUID();
    let attemptId = crypto.randomUUID();
    let turnLimitReached = false;
    let closeoutAccepted = false;
    let acceptedMessage: Record<string, unknown> | undefined;
    let actualTurns = 0;

    let promptResponse: unknown;
    let messagesResponse: unknown;
    let conclusion = '';
    let activeSession: OpenCodeActiveSession | undefined;
    let bridgeOwnedByActiveSession = false;
    let unownedOpenCodeInstance: OpenCodeInstance | undefined;
    try {
      const opencode = await this.createOpenCodeInstance(sdk, dirs, {
        hostname: '127.0.0.1',
        ...(port ? { port } : {}),
        timeout,
        config: createOpenCodeHardenedConfig(
          Array.from(prep.allowedToolNames),
          this.env,
          bridge,
          turnIntent.status === 'unavailable' ? {...modelConfig, smallModel: undefined} : modelConfig,
          turnBudget.acquisitionTurns,
        ),
      });
      unownedOpenCodeInstance = opencode;
      executionLease.throwIfAborted();
      await assertOpenCodeMcpReady(opencode.client, dirs.projectDir, () => bridge.getDiagnostics());
      executionLease.throwIfAborted();
      activeSession = {
        server: opencode.server,
        client: opencode.client,
        closeBridge: () => bridge.close().catch(() => undefined),
        abortController,
        aborted: false,
        projectDir: dirs.projectDir,
        homeDir: dirs.homeDir,
        configDir: dirs.configDir,
      };
      bridgeOwnedByActiveSession = true;
      unownedOpenCodeInstance = undefined;
      this.activeSessions.set(sessionId, activeSession);
      executionLease.throwIfAborted();
      this.currentServer = opencode.server;
      const openCodeSessionId = await this.resolveOpenCodeSessionId(
        opencode.client,
        sessionId,
        dirs.projectDir,
        restoredOpenCodeSessionId,
      );
      activeSession.openCodeSessionId = openCodeSessionId;
      this.currentSessionId = openCodeSessionId;
      executionLease.throwIfAborted();
      this.emitUpdate({
        type: 'progress',
        content: {
          module: 'opencode',
          runtime: this.selection.kind,
          mode: prep.quickMode ? 'fast' : 'full',
          toolCount: prep.toolDefinitions.length,
          message: 'OpenCode SmartPerfetto analysis started',
          source: this.selection.source,
        },
        timestamp: Date.now(),
      });
      const promptSession = activeSession;
      if (!promptSession) {
        throw new Error('OpenCode active session was not registered before prompt execution');
      }
      let resumedPromptSession = Boolean(
        restoredOpenCodeSessionId && openCodeSessionId === restoredOpenCodeSessionId,
      );
      const runAnalysisPrompt = async (text: string) => {
        if (Date.now() >= deadlineMs) throw openCodePromptTimeoutError(promptTimeout);
        const promptResult = await runOpenCodePrompt(opencode, {
          path: {id: openCodeSessionId},
          query: {directory: dirs.projectDir},
          body: {
            model: modelConfig.model,
            agent: 'smartperfetto',
            system: prep.systemPrompt,
            tools: createOpenCodeToolAllowlist(
              createOpenCodeMcpToolNames(Array.from(prep.allowedToolNames)),
            ),
            parts: [{type: 'text', text}],
          },
        }, {
          sessionId: openCodeSessionId,
          projectDir: dirs.projectDir,
          timeoutMs: Math.max(1, deadlineMs - Date.now()),
          maxSteps: turnBudget.acquisitionTurns,
          onTurnLimit: () => {toolAdmissionsOpen = false;},
          resumedSession: resumedPromptSession,
          signal: promptSession.abortController?.signal,
          isAborted: () => (
            this.activeSessions.get(sessionId) === promptSession &&
            promptSession.aborted
          ),
          onFirstAssistantMessage: () => runtimePerformance.recordFirstOutput(),
          adaptiveObservation: isRuntimeCandidateAdmitted('task8', this.env),
        });
        resumedPromptSession = true;
        return promptResult;
      };
      const providerPhase = runtimePerformance.startPhase('provider');
      let promptResult: Awaited<ReturnType<typeof runAnalysisPrompt>>;
      try {
        promptResult = await runAnalysisPrompt(prep.prompt);
        providerPhase.end('ok');
      } catch (error) {
        providerPhase.end(runtimeOutcomeFromError(error, executionLease.signal));
        throw error;
      }
      executionLease.throwIfAborted();
      promptResponse = promptResult.promptResponse;
      messagesResponse = promptResult.messagesResponse;
      const observed = getOpenCodeAssistantMessages(messagesResponse);
      const direct = getOpenCodeAssistantMessages(promptResponse);
      acceptedMessage = promptResult.turnLimitCandidate ?? observed[observed.length - 1] ?? direct[direct.length - 1];
      actualTurns = observed.length || direct.length;
      turnLimitReached = promptResult.turnLimitReached === true;
      // Bind terminal facts to the actual native body before privacy projection.
      conclusion = acceptedMessage ? extractTextParts(acceptedMessage).trim() : '';
    } finally {
      toolAdmissionsOpen = false;
      if (activeSession && !privateKnowledge && !executionLease.signal.aborted) {
        this.sessionOpaqueStates.set(sessionId, createOpenCodeOpaqueState(
          activeSession.openCodeSessionId,
          dirs,
        ));
      }
      await this.closeSessionHandle(sessionId, activeSession);
      if (!activeSession && unownedOpenCodeInstance) {
        await Promise.resolve(unownedOpenCodeInstance.server.close()).catch(() => undefined);
      }
      if (!bridgeOwnedByActiveSession) {
        await bridge.close().catch(() => undefined);
      }
      if (ephemeralRoot) fs.rmSync(ephemeralRoot, {recursive: true, force: true});
    }

    if (turnLimitReached && turnBudget.deliveryTurns > 0
      && actualTurns < turnBudget.totalTurns && Date.now() < deadlineMs) {
      const closeoutPrompt = closeoutTape.buildPrompt({query, priorConclusion: conclusion, outputLanguage});
      if (closeoutPrompt) {
        try {
          assertActive();
          const closeoutAttemptId = crypto.randomUUID();
          actualTurns++;
          const closeout = await runOpenCodeIntentTransport({
            prompt: closeoutPrompt, systemPrompt: prep.systemPrompt,
            signal: executionLease.signal, deadlineMs, outputByteLimit: 64 * 1024,
            model: modelConfig.model, createClassifierHost: createNoToolsHost,
          });
          assertActive();
          if (closeout.status === 'ok') {
            conclusion = closeout.text;
            attemptId = closeoutAttemptId;
            acceptedMessage = {info: {role: 'assistant', finish: closeout.finishReason ?? 'stop'},
              parts: [{type: 'text', text: closeout.text}]};
            closeoutAccepted = true;
          }
        } catch {
          executionLease.throwIfAborted();
          // A failed or no-longer-authorized closeout cannot replace the draft.
        }
      }
    }

    const initialInfo = acceptedMessage && (isRecord(acceptedMessage.info) ? acceptedMessage.info : acceptedMessage);
    const initialFinish = typeof initialInfo?.finish === 'string' ? initialInfo.finish : undefined;
    const initialCompleted = initialInfo?.error == null &&
      (initialFinish === 'stop' || initialFinish === 'end_turn' || initialFinish === 'stop_sequence');
    const declarationRequest = requestNativeDeclarationCompletion({
      intent: turnIntent,
      completion: {status: initialCompleted ? 'completed' : 'unknown'},
      candidate: conclusion,
      remainingDeliveryTurns: !turnLimitReached && actualTurns < turnBudget.totalTurns
        ? turnBudget.deliveryTurns : 0,
      repairInvalid: true,
    });
    const declarationOutputLimit = 64 * 1024;
    if (declarationRequest && nativeDeclarationBodyCanFitOutput(conclusion, declarationOutputLimit) &&
        Date.now() < deadlineMs) {
      try {
        assertActive();
        actualTurns++;
        const repaired = await runOpenCodeIntentTransport({
          prompt: buildNativeDeclarationCompletionPrompt({request: declarationRequest, intent: turnIntent, outputLanguage}),
          systemPrompt: prep.systemPrompt,
          signal: executionLease.signal,
          deadlineMs,
          outputByteLimit: declarationOutputLimit,
          model: modelConfig.model,
          createClassifierHost: createNoToolsHost,
        });
        assertActive();
        if (repaired.status === 'ok' && acceptNativeDeclarationCompletion({
          request: declarationRequest, completion: {status: 'completed'}, candidate: repaired.text,
          outputByteLimit: declarationOutputLimit,
        })) {
          conclusion = repaired.text;
          attemptId = crypto.randomUUID();
          acceptedMessage = {info: {role: 'assistant', finish: repaired.finishReason ?? 'stop'},
            parts: [{type: 'text', text: repaired.text}]};
        }
      } catch {
        executionLease.throwIfAborted();
        // A failed declaration completion cannot replace the original candidate.
      }
    }

    const info = acceptedMessage && (isRecord(acceptedMessage.info) ? acceptedMessage.info : acceptedMessage);
    const finish = typeof info?.finish === 'string' ? info.finish : undefined;
    const sdkError = info?.error != null;
    const outputLimited = finish === 'length';
    const turnLimited = turnLimitReached;
    const completed = !sdkError && (finish === 'stop' || finish === 'end_turn' || finish === 'stop_sequence');
    const completion: AnalysisCompletion = {
      schemaVersion: 1, runtimeKind: prep.analysisRunSpec.runtime.kind,
      candidateRef: crypto.randomUUID(), runId, attemptId,
      conclusionFingerprint: analysisDeliveryFingerprint(conclusion),
      status: sdkError ? 'failed' : turnLimited ? 'incomplete' : completed ? 'completed' : outputLimited ? 'incomplete' : 'unknown',
      ...(sdkError ? {reason: 'provider_error' as const}
        : outputLimited ? {reason: 'output_limit' as const}
        : turnLimited ? {reason: 'turn_limit' as const} : {}),
      ...(finish ? {sdkFinishReason: finish} : {}),
    };
    const partial = completion.status !== 'completed' || !conclusion;
    const findings = extractFindingsFromText(conclusion);
    const result: AnalysisResult = {
      sessionId, success: Boolean(conclusion) && !sdkError, findings,
      hypotheses: prep.hypotheses.map(h => toRuntimeProtocolHypothesis(h, 'opencode')),
      conclusion, confidence: estimateAnalysisConfidence({findings, partial}),
      rounds: actualTurns, totalDurationMs: Date.now() - startedAt,
      turnIntent, completion, outputOrigin: acceptedMessage ? 'sdk_final' : 'assistant_stream',
      partial: partial || undefined,
      ...(turnLimited ? {terminationReason: 'max_turns' as const} : {}),
      ...(turnLimited && !closeoutAccepted && actualTurns >= turnBudget.totalTurns ? {
        terminationMessage: localize(outputLanguage,
          'OpenCode 在两次状态观测之间已用完轮次预算，保留当前结果；未追加总结请求。',
          'OpenCode exhausted the turn budget between observations; the current result is retained without an extra summary request.'),
      } : {}),
      quickRun: prep.quickMode ? buildQuickRunReceipt({
        requestedMode: options.analysisMode ?? 'auto', turnIntent, budget: quickBudget,
        actualTurns, elapsedMs: Date.now() - startedAt,
        stopReason: quickStopReasonFromTermination({partial, terminationReason: turnLimited ? 'max_turns' : undefined,
          actualTurns, targetTurns: quickBudget.targetTurns, hardCapTurns: quickBudget.hardCapTurns}),
        evidence: {frontendPrequeryInjected: prep.analysisRunSpec.traceContext.datasetCount},
        contextInjected: {
          conversationTurns: countCompletedQuickConversationTurns(prep.previousTurns),
          ...prep.quickMemoryContextCounts,
        },
      }) : undefined,
    };
    const nativeDeliveryContext: AnalysisDeliveryContext = {
      entry: 'runtime_draft', acceptedCandidate: completion, completion,
      turnIntent, outputOrigin: result.outputOrigin,
    };
    const {deliveryContext, protocolProjection} = finalizeOwnerSourceAwareAnalysisResultWithProjection(result, prep.sourceUse, {
      context: nativeDeliveryContext,
    });
    executionLease.throwIfAborted();
    const verificationPhase = runtimePerformance.startPhase('verification');
    try {
      const verification = await verifyConclusion(result.findings, result.conclusion, {
        emitUpdate: update => this.emitUpdate(update), enableLLM: false,
        plan: prep.analysisPlan.current, hypotheses: prep.hypotheses,
        sceneType: prep.sceneType, outputLanguage: prep.analysisRunSpec.outputLanguage,
        query, emitIssueProgress: false,
        deliveryContext,
        allowPersistentLearning: !analysisContextUsesPrivateKnowledge(options) && turnPolicy.allowNewEvidence,
      });
      const issue = [...verification.heuristicIssues, ...(verification.llmIssues ?? [])]
        .find(issue => issue.severity === 'error' && issue.type !== 'plan_deviation' && issue.type !== 'unresolved_hypothesis');
      if (issue) {
        result.partial = true;
        result.terminationReason ??= 'quality_gate_failed';
        result.terminationMessage ??= issue.message;
        result.confidence = estimateAnalysisConfidence({findings: result.findings, partial: true});
      }
      verificationPhase.end('ok');
    } catch (error) {
      verificationPhase.end(runtimeOutcomeFromError(error, executionLease.signal));
      throw error;
    }
    executionLease.throwIfAborted();
    const wasPartialBeforeQualityGate = result.partial === true;
    const gateIssue = applyFinalResultQualityGate({
      result,
      query,
      sceneType: resolveFinalReportSceneType(),
      comparisonIdentity: prep.comparisonIdentity,
      deferFocusedEvidenceFinalization: true,
      context: deliveryContext,
    });
    if (gateIssue && result.partial === true && !wasPartialBeforeQualityGate) {
      result.confidence = estimateAnalysisConfidence({findings: result.findings, partial: true});
      this.emitUpdate({
        type: 'degraded',
        content: {
          module: 'openCodeRuntime',
          fallback: gateIssue.code,
          message: gateIssue.message,
          partial: true,
        },
        timestamp: Date.now(),
      });
    }

    executionLease.throwIfAborted();
    prep.sessionContext.addTurn(
      query,
      {
        primaryGoal: query,
        aspects: [],
        expectedOutputType: 'diagnosis',
        complexity: prep.quickMode ? 'simple' : 'complex',
        followUpType: prep.previousTurns.length > 0 ? 'extend' : 'initial',
      },
      {
        agentId: 'opencode',
        success: result.success,
        findings: result.findings,
        confidence: result.confidence,
        message: result.conclusion,
        partial: result.partial,
        terminationReason: result.terminationReason,
        terminationMessage: result.terminationMessage,
        completion: result.completion,
        conclusionContract: result.conclusionContract,
        sourceDerived: privateKnowledge || undefined,
        analysisContextFingerprint: options.analysisContextFingerprint,
      },
      result.findings,
    );

    if (!deliveryContext || deliveryContext.entry === 'historical_restore' || !deliveryContext.acceptedCandidate) {
      throw new Error('OpenCode finalization requires the accepted projected candidate');
    }
    const artifactStore = this.artifactStores.get(sessionId);
    const scopeIdentity = (scope: AnalysisRunSpec['scopes']['knowledge']) => scope
      ? Object.fromEntries(Object.entries(scope).filter(([, value]) => value !== undefined)) : null;
    attachFinalizationContext(result, {
      runId, sessionId, deadlineMs, turnIntent, strategyRegistry: resolver.strategyRegistry,
      selection: prep.analysisRunSpec.selection,
      traceIdentity: {currentTraceId: traceId, referenceTraceId: options.referenceTraceId},
      deliveryContext, protocolProjection,
      sourceUse: prep.sourceUse?.getSourceUseDecision(),
      sourceScope: prep.sourceUse?.getSourceExecutionScope?.(),
      ...(artifactStore ? {evidenceReadView: artifactStore.createEvidenceReadView({
        currentRunId: runId,
        allowedTraces: [
          {traceId, traceSide: 'current'},
          ...(options.referenceTraceId ? [{traceId: options.referenceTraceId, traceSide: 'reference' as const}] : []),
        ],
        ownerKey: canonicalContentHash({runId, sessionId, scopes: {
          provider: scopeIdentity(prep.analysisRunSpec.scopes.provider),
          knowledge: scopeIdentity(prep.analysisRunSpec.scopes.knowledge),
          providerId: prep.analysisRunSpec.scopes.providerId ?? null,
        }, providerScope: scopeIdentity(this.input.providerScope),
          analysisContextFingerprint: options.analysisContextFingerprint ?? null}),
      })} : {}),
      ...(result.success && result.completion?.status !== 'failed' && result.completion?.status !== 'cancelled'
        && result.completion?.reason !== 'turn_limit' ? {
        providerQuery: {text: prep.analysisRunSpec.query.text, analysisContextFingerprint: options.analysisContextFingerprint},
        dispatchText: input => runOpenCodeIntentTransport({
          ...input, model: modelConfig.model, createClassifierHost: createNoToolsHost,
        }),
      } : {}),
    });
    return result;
  }

  private async prepareAnalysis(
    query: string,
    sessionId: string,
    traceId: string,
    options: AnalysisOptions,
    model: string,
    turnIntent: AnalysisTurnIntent,
    turnPolicy: RuntimeTurnPolicy,
    strategyRegistry: ReadonlyStrategyRegistrySnapshot,
    analysisHistoryReader: AnalysisHistoryReader,
    toolObserver?: RuntimeToolObserver,
    canInvokeTool?: () => boolean,
    sceneDeadlineMs?: number,
    sceneSignal?: AbortSignal,
  ): Promise<OpenCodeAnalysisPreparation> {
    const outputLanguage = options.outputLanguage
      ?? parseOutputLanguage(this.env.SMARTPERFETTO_OUTPUT_LANGUAGE);
    const sceneType = turnIntent.sceneId;
    const sessionContext = sessionContextManager.getOrCreate(sessionId, traceId);
    const previousTurns = sessionContext.getAllTurns?.() || [];
    const quickMode = turnPolicy.budgetMode === 'quick';
    const focusResult = turnPolicy.preflight !== 'none'
      ? await detectFocusApps(this.input.traceProcessorService, traceId, {
          timeRange: focusAppTimeRangeFromSelection(options.selectionContext),
        })
      : {apps: [], method: 'none' as const};
    const effectivePackageName = options.packageName || focusResult.primaryApp;
    const analysisRunSpec = createAnalysisRunSpec({
      history: analysisHistoryReader.getTurns(),
      query, sessionId, traceId, options, turnIntent,
      runtimeSelection: this.selection,
      engineCapabilities: getOpenCodeEngineCapabilities(this.selection.kind),
      sceneType, outputLanguage, resolvedMode: quickMode ? 'quick' : 'full', resolvedModel: model,
      budget: {model, maxTurns: quickMode ? resolveAgentRuntimeBudgetConfig(this.env).quickMaxTurns
        : resolveAgentRuntimeBudgetConfig(this.env).maxTurns},
    });

    await ensureSkillRegistryInitialized();
    const skillExecutor = createSkillExecutor(this.input.traceProcessorService);
    const effectiveSkillRegistry =
      resolveEffectiveSkillRegistryForRuntime(skillRegistry);
    const sceneCoverageRegistry = resolveSceneProductScope(options, {sessionId, traceId, runId: options.runId ?? ''})
      ? snapshotSceneCoverageRegistry(effectiveSkillRegistry, strategyRegistry, turnIntent.sceneId) : undefined;
    skillExecutor.registerSkills(sceneCoverageRegistry ? [...sceneCoverageRegistry.skills] : effectiveSkillRegistry.getAllSkills());
    skillExecutor.setFragmentRegistry(
      sceneCoverageRegistry ? new Map(sceneCoverageRegistry.fragments) : effectiveSkillRegistry.getFragmentCache(),
    );

    let architecture = getLruCacheEntry(this.architectureCache, traceId);
    if (!architecture && turnPolicy.preflight !== 'none') {
      try {
        architecture = await createArchitectureDetector().detect({
          traceId,
          traceProcessorService: this.input.traceProcessorService,
          packageName: effectivePackageName,
        });
        if (architecture) setLruCacheEntry(this.architectureCache, traceId, architecture);
      } catch (err) {
        console.warn('[OpenCodeRuntime] Architecture detection failed:', (err as Error).message);
      }
    }
    if (architecture) {
      this.emitUpdate({
        type: 'architecture_detected',
        content: { architecture },
        timestamp: Date.now(),
      });
    }

    let traceCompleteness: Awaited<ReturnType<typeof probeTraceCompleteness>> | undefined;
    if (turnPolicy.preflight !== 'none') {
      try {
        traceCompleteness = await probeTraceCompleteness(
          this.input.traceProcessorService,
          traceId,
          architecture?.type,
        );
      } catch (err) {
        console.warn('[OpenCodeRuntime] Trace completeness probe failed:', (err as Error).message);
      }
    }

    const artifactStore = resolveRuntimeEvidenceStore(options, {sessionId, traceId},
      () => this.artifactStores.get(sessionId) ?? new ArtifactStore());
    this.artifactStores.set(sessionId, artifactStore);

    let notes = this.sessionNotes.get(sessionId);
    if (!notes) {
      notes = [];
      this.sessionNotes.set(sessionId, notes);
    }
    if (!this.sessionPlans.has(sessionId)) {
      this.sessionPlans.set(sessionId, { current: null, history: [] });
    }
    const analysisPlan = this.sessionPlans.get(sessionId)!;
    if (analysisPlan.current) {
      analysisPlan.history.push(analysisPlan.current);
      if (analysisPlan.history.length > 3) analysisPlan.history.shift();
    }
    analysisPlan.current = null;
    resetPrePlanToolCallsForNewRun(analysisPlan);

    if (!this.sessionHypotheses.has(sessionId)) this.sessionHypotheses.set(sessionId, []);
    const hypotheses = this.sessionHypotheses.get(sessionId)!;
    hypotheses.splice(0);
    if (!this.sessionUncertaintyFlags.has(sessionId)) this.sessionUncertaintyFlags.set(sessionId, []);
    const uncertaintyFlags = this.sessionUncertaintyFlags.get(sessionId)!;
    uncertaintyFlags.splice(0);

    const knowledgeScope = analysisRunSpec.scopes.knowledge;
    const privateAnalysisContext = analysisContextUsesPrivateKnowledge(options);
    const allowMemoryPrefetch = turnPolicy.allowAutomaticPrefetch && !privateAnalysisContext;
    const recentSqlErrors = turnPolicy.allowAutomaticPrefetch ? loadLearnedSqlFixPairs(5, knowledgeScope, options) : [];
    const skillNotesBudget = createRuntimeSkillNotesBudget(turnPolicy.budgetMode === 'quick');
    const comparisonContext = turnPolicy.allowAutomaticPrefetch
      ? await buildRuntimeTracePairComparisonContext({
      traceProcessorService: this.input.traceProcessorService,
      currentTraceId: traceId,
      ...(options.referenceTraceId ? { referenceTraceId: options.referenceTraceId } : {}),
      ...(options.tracePairContext ? { tracePairContext: options.tracePairContext } : {}),
    }) : buildRuntimeTracePairIdentityContext({
      referenceTraceId: options.referenceTraceId, tracePairContext: options.tracePairContext});
    const comparisonIdentity = comparisonContext ? {
      currentPackageName: effectivePackageName,
      referencePackageName: comparisonContext.referencePackageName,
    } : undefined;
    const extraSystemPrompt = normalizeOptionalString(
      getProviderForSelection(this.selection, this.input.providerScope)?.connection.openCodeSystemPrompt,
    ) || normalizeOptionalString(this.env[OPENCODE_SYSTEM_PROMPT_ENV]);
    const withConfiguredSystemPrompt = (prompt: string): string => extraSystemPrompt
      ? `${prompt}\n\n${extraSystemPrompt}` : prompt;
    const sceneRunContext = await activateSceneRuntime(options, {sessionId, traceId, runId: options.runId ?? '',
      deadlineMs: sceneDeadlineMs ?? 0, traceProcessorService: this.input.traceProcessorService,
      artifactStore, sceneCoverageRegistry, signal: sceneSignal, canInvokeTool});
    const { toolDefinitions, sourceUse } = createClaudeMcpServer({
      sceneRunContext,
      toolObserver, canInvokeTool, analysisHistoryReader,
      strategyRegistry,
      conversationTraceAttached: options.assistantSurface === 'conversation'
        ? options.conversationTraceAttached === true
        : undefined,
      runManifestAttributionSink: options.runManifestAttributionSink,
      sessionId,
      traceId,
      userQuery: query,
      traceProcessorService: this.input.traceProcessorService,
      skillExecutor,
      packageName: effectivePackageName,
      emitUpdate: update => this.emitUpdate(update),
      onSkillResult: (result) => {
        captureSkillDisplayEntities(result.displayResults, sessionContext.getEntityStore(), 'opencode');
      },
      analysisNotes: notes,
      artifactStore,
      cachedArchitecture: architecture,
      recentSqlErrors,
      analysisPlan,
      watchdogWarning: { current: null },
      hypotheses,
      sceneType,
      uncertaintyFlags,
      lightweight: usesLightweightToolCatalog(turnPolicy),
      allowNewEvidence: turnPolicy.allowNewEvidence,
      skillNotesBudget,
      outputLanguage,
      knowledgeScope,
      codeAwareMode: options.codeAwareMode,
      codebaseIds: options.codebaseIds,
      knowledgeSourceIds: options.knowledgeSourceIds,
      sourceUsePolicy: options.sourceUsePolicy,
      analysisContextFingerprint: options.analysisContextFingerprint,
      androidInternalsPackPin: options.androidInternalsPackPin,
      referenceTraceId: options.referenceTraceId,
      ...(comparisonContext ? { comparisonContext } : {}),
    });
    const allowedToolNames = new Set(toolDefinitions.map(definition => definition.name));

    let prompt = query;
    const historyContext = renderAnalysisHistoryContext(analysisHistoryReader.getTurns(), {outputLanguage});
    if (historyContext) prompt = `${historyContext}\n\n${prompt}`;
    if (analysisRunSpec.traceContext.promptSection) {
      prompt = `${analysisRunSpec.traceContext.promptSection}\n\n${prompt}`;
    }
    const traceFeatures = extractTraceFeatures({
      architectureType: architecture?.type,
      sceneType,
      packageName: effectivePackageName,
    });
    let knowledgeBaseContext: string | undefined;
    if (turnPolicy.allowAutomaticPrefetch) {
      try {
        const kb = await getExtendedKnowledgeBase();
        knowledgeBaseContext = kb.getContextForAI(query, 8);
      } catch {
        // On-demand lookup tools remain available if automatic context fails.
      }
    }

    if (turnPolicy.onDemandContext) {
      const quickMemoryPayload = buildQuickMemoryContextPayload({
        patternContext: allowMemoryPrefetch
          ? buildPatternContextSection(traceFeatures, knowledgeScope) : undefined,
        negativePatternContext: allowMemoryPrefetch
          ? buildNegativePatternSection(traceFeatures, knowledgeScope) : undefined,
        caseBackgroundContext: allowMemoryPrefetch ? buildRuntimeCaseBackgroundContext({
          sceneType,
          architectureType: architecture?.type,
          knowledgeScope,
          outputLanguage,
          privateAnalysisContext,
        }) : undefined,
        sqlErrorFixPairs: recentSqlErrors,
        outputLanguage,
      });
      const quickMemoryContext = quickMemoryPayload.text;
      return {
        systemPrompt: withConfiguredSystemPrompt(buildQuickSystemPrompt({
          turnIntent, strategyRegistry, onDemandContext: turnPolicy.onDemandContext,
          ...(comparisonContext ? {comparison: comparisonContext} : {}),
          architecture,
          packageName: effectivePackageName,
          focusApps: focusResult.apps.length > 0 ? focusResult.apps : undefined,
          focusMethod: focusResult.method,
          selectionContext: options.selectionContext,
          quickMemoryContext,
          knowledgeBaseContext,
          // The probe already ran for every `preflight !== 'none'` turn; the
          // on-demand variant chooses which memory context the prompt carries,
          // not whether the run may say what the capture actually contains.
          traceCompleteness,
          outputLanguage,
          codeAwareMode: options.codeAwareMode,
          codebaseIds: options.codebaseIds,
        })),
        prompt,
        toolDefinitions,
        allowedToolNames,
        quickMode, turnIntent, turnPolicy,
        sceneType,
        packageName: effectivePackageName,
        architecture,
        sessionContext,
        previousTurns,
        analysisPlan,
        notes,
        hypotheses,
        uncertaintyFlags,
        analysisRunSpec,
        sourceUse,
        comparisonIdentity,
        quickMemoryContextCounts: quickMemoryPayload.counts,
      };
    }

    const traceInfo = this.input.traceProcessorService.getTrace(traceId);
    const analysisContext: ClaudeAnalysisContext = {
      turnIntent, strategyRegistry, onDemandContext: turnPolicy.onDemandContext,
      query,
      architecture,
      packageName: effectivePackageName,
      focusApps: focusResult.apps.length > 0 ? focusResult.apps : undefined,
      focusMethod: focusResult.method,
      knowledgeBaseContext,
      sceneType,
      sqlErrorFixPairs: recentSqlErrors
        .filter((entry: any) => entry.fixedSql)
        .slice(-3)
        .map((entry: any) => ({
          errorSql: entry.errorSql,
          errorMessage: entry.errorMessage,
          fixedSql: entry.fixedSql,
        })),
      patternContext: allowMemoryPrefetch
        ? buildPatternContextSection(traceFeatures, knowledgeScope) : undefined,
      negativePatternContext: allowMemoryPrefetch
        ? buildNegativePatternSection(traceFeatures, knowledgeScope) : undefined,
      caseBackgroundContext: allowMemoryPrefetch ? buildRuntimeCaseBackgroundContext({
        sceneType,
        architectureType: architecture?.type,
        knowledgeScope,
        outputLanguage,
        privateAnalysisContext,
      }) : undefined,
      selectionContext: options.selectionContext,
      traceCompleteness,
      traceOs: traceInfo?.traceOs,
      traceFormat: traceInfo?.traceFormat,
      outputLanguage,
      codeAwareMode: options.codeAwareMode,
      codebaseIds: options.codebaseIds,
      ...(comparisonContext ? { comparison: comparisonContext } : {}),
    };
    const sharedSystemPrompt = buildSystemPrompt(analysisContext);
    return {
      systemPrompt: withConfiguredSystemPrompt(sharedSystemPrompt),
      prompt,
      toolDefinitions,
      allowedToolNames,
      quickMode, turnIntent, turnPolicy,
      sceneType,
      packageName: effectivePackageName,
      architecture,
      sessionContext,
      previousTurns,
      analysisPlan,
      notes,
      hypotheses,
      uncertaintyFlags,
      analysisRunSpec,
      sourceUse,
      comparisonIdentity,
    };
  }

  reset(): void {
    this.executionGuard.clear();
    this.currentSessionId = undefined;
    void this.abortAllSessions();
    this.sessionOpaqueStates.clear();
    this.architectureCache.clear();
    this.removeAllListeners();
  }

  async cleanupSession(sessionId: string): Promise<void> {
    await this.abortSession(sessionId);
    this.artifactStores.delete(sessionId);
    this.sessionNotes.delete(sessionId);
    this.sessionPlans.delete(sessionId);
    this.sessionHypotheses.delete(sessionId);
    this.sessionUncertaintyFlags.delete(sessionId);
    this.sessionOpaqueStates.delete(sessionId);
    fs.rmSync(openCodeSessionRoot(sessionId), {recursive: true, force: true});
  }

  async abortSession(sessionId: string): Promise<void> {
    await this.executionGuard.abortSession(sessionId);
    const handle = this.activeSessions.get(sessionId);
    if (!handle) return;
    handle.aborted = true;
    handle.abortController?.abort();
    if (handle.client?.session.abort && handle.openCodeSessionId) {
      await handle.client.session.abort({
        path: { id: handle.openCodeSessionId },
      }).catch(() => undefined);
    }
    await this.closeSessionResources(handle);
  }

  restoreArchitectureCache(traceId: string, architecture: ArchitectureInfo): void {
    setLruCacheEntry(this.architectureCache, traceId, architecture);
  }

  getCachedArchitecture(traceId: string): ArchitectureInfo | undefined {
    return getLruCacheEntry(this.architectureCache, traceId);
  }

  getSessionNotes(sessionId: string): AnalysisNote[] {
    return this.sessionNotes.get(sessionId) || [];
  }

  getSessionPlan(sessionId: string): AnalysisPlanV3 | null {
    return this.sessionPlans.get(sessionId)?.current ?? null;
  }

  getSessionUncertaintyFlags(sessionId: string): UncertaintyFlag[] {
    return this.sessionUncertaintyFlags.get(sessionId) || [];
  }

  takeSnapshot(
    sessionId: string,
    traceId: string,
    sessionFields: SessionFieldsForSnapshot,
  ): SessionStateSnapshot {
    const privateKnowledge = sessionFieldsUsePrivateKnowledge(sessionFields);
    const durableFields = projectSessionFieldsForDurableSnapshot(sessionFields);
    const planState = this.sessionPlans.get(sessionId);
    const artifactStore = this.artifactStores.get(sessionId);
    const activeSession = this.activeSessions.get(sessionId);
    let activeOpaque: OpenCodeOpaqueState | undefined;
    if (activeSession) {
      const activeDirs: OpenCodeSessionDirs = (
        activeSession.projectDir &&
        activeSession.homeDir &&
        activeSession.configDir
      ) ? {
          projectDir: activeSession.projectDir,
          homeDir: activeSession.homeDir,
          configDir: activeSession.configDir,
        }
        : createDurableOpenCodeSessionDirs(sessionId, this.env);
      activeOpaque = createOpenCodeOpaqueState(activeSession.openCodeSessionId, activeDirs);
    }
    const opaque = privateKnowledge
      ? undefined
      : this.sessionOpaqueStates.get(sessionId)
        ?? activeOpaque
        ?? {version: 1, degradedReason: 'state_unavailable' as const};
    return {
      version: 1,
      snapshotTimestamp: Date.now(),
      sessionId,
      traceId,
      ...durableFields,
      analysisNotes: privateKnowledge ? [] : this.sessionNotes.get(sessionId) || [],
      analysisPlan: privateKnowledge ? null : planState?.current ?? null,
      planHistory: privateKnowledge ? [] : planState?.history ?? [],
      uncertaintyFlags: privateKnowledge ? [] : this.sessionUncertaintyFlags.get(sessionId) || [],
      claudeHypotheses: privateKnowledge ? undefined : this.sessionHypotheses.get(sessionId) || undefined,
      architecture: getLruCacheEntry(this.architectureCache, traceId),
      engineState: createOpenCodeSnapshotEngineState({
        providerId: sessionFields.agentRuntimeProviderId,
        providerSnapshotHash: sessionFields.agentRuntimeProviderSnapshotHash,
        opaque,
      }),
      agentRuntimeKind: OPENCODE_RUNTIME_KIND,
      agentRuntimeProviderId: sessionFields.agentRuntimeProviderId,
      agentRuntimeProviderSnapshotHash: sessionFields.agentRuntimeProviderSnapshotHash,
      artifacts: privateKnowledge ? undefined : artifactStore?.serialize(),
    };
  }

  restoreFromSnapshot(sessionId: string, traceId: string, snapshot: SessionStateSnapshot): void {
    if (snapshot.analysisNotes.length > 0) {
      this.sessionNotes.set(sessionId, [...snapshot.analysisNotes]);
    }
    if (snapshot.analysisPlan || snapshot.planHistory.length > 0) {
      this.sessionPlans.set(sessionId, {
        current: snapshot.analysisPlan,
        history: snapshot.planHistory,
      });
    }
    if (snapshot.claudeHypotheses && snapshot.claudeHypotheses.length > 0) {
      this.sessionHypotheses.set(sessionId, [...snapshot.claudeHypotheses]);
    }
    if (snapshot.uncertaintyFlags.length > 0) {
      this.sessionUncertaintyFlags.set(sessionId, [...snapshot.uncertaintyFlags]);
    }
    if (snapshot.architecture) {
      setLruCacheEntry(this.architectureCache, traceId, snapshot.architecture);
    }
    if (snapshot.artifacts) {
      try {
        this.artifactStores.set(sessionId, ArtifactStore.fromSnapshot(snapshot.artifacts));
      } catch {
        // Ignore malformed legacy artifact snapshots.
      }
    }
    const opaque = getOpenCodeSnapshotEngineState(snapshot)?.opaque;
    if (opaque) {
      this.sessionOpaqueStates.set(sessionId, opaque);
    }
  }

  private async closeSessionHandle(
    sessionId: string,
    handle: OpenCodeActiveSession | undefined,
  ): Promise<void> {
    if (!handle) return;
    if (this.currentServer === handle.server) this.currentServer = undefined;
    if (this.currentSessionId === handle.openCodeSessionId) this.currentSessionId = undefined;
    await this.closeSessionResources(handle);
    if (this.activeSessions.get(sessionId) === handle) {
      this.activeSessions.delete(sessionId);
    }
  }

  private closeSessionResources(handle: OpenCodeActiveSession): Promise<void> {
    if (!handle.closePromise) {
      handle.closePromise = (async () => {
        await Promise.resolve(handle.server?.close()).catch(() => undefined);
        await handle.closeBridge?.().catch(() => undefined);
      })();
    }
    return handle.closePromise;
  }

  private async abortAllSessions(): Promise<void> {
    const sessions = Array.from(this.activeSessions.keys());
    await Promise.all(sessions.map(sessionId => this.abortSession(sessionId)));
  }

  private emitUpdate(update: StreamingUpdate): void {
    this.emit('update', update);
  }
}

export function createOpenCodeRuntimeDefinition(
  kind: OpenCodeRuntimeKind = EXPERIMENTAL_OPENCODE_RUNTIME_KIND,
): RuntimeEngineDefinition {
  return {
    kind,
    capabilities: getOpenCodeEngineCapabilities(kind),
    createOrchestrator: input => new OpenCodeRuntime(input),
  };
}
