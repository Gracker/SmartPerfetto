// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * McpToolRegistry — single source of truth for MCP tools registered
 * by SmartPerfetto.
 *
 * Plan 41 M0 (this file): extract the registry that
 * `claudeMcpServer.ts` already maintained as an inline
 * `toolEntries: Array<{tool, name}>` array. The registry adds:
 *   - explicit `McpToolExposure` per entry (public / internal /
 *     deprecated) so future hosts (stdio, A2A) can filter without
 *     re-deciding policy
 *   - shared `MCP_NAME_PREFIX` handling so `allowedTools` always
 *     matches the SDK's expectation
 *   - one place to derive an `McpToolAci[]` snapshot (used by M1
 *     to populate `McpPublicApiContract`)
 *
 * Critical invariant: registration preserves each tool's canonical
 * name, exposure, schema, and handler result. Runtime wrappers may
 * coordinate admitted tool concurrency and record timing receipts;
 * those policies come from the canonical `SharedToolSpec` rather
 * than being re-decided by individual runtime adapters.
 *
 * Out of scope for M0:
 *   - stdio adapter (lands in M1 as `standaloneMcpServer.ts`)
 *   - A2A AgentCard (M2)
 *   - SupersedeStoreReadOnlyAdapter (M1a, prerequisite for raising
 *     `recall_patterns` exposure from internal back to public)
 *
 * @module mcpToolRegistry
 */

import {z} from 'zod';

import {
  compactSharedToolSpec,
  sharedToolSpecFromRuntimeToolDefinition,
  withRuntimeToolAuthorization,
  withRuntimeToolConcurrency,
  withRuntimeToolGuard,
  withRuntimeToolTiming,
  type RuntimeToolDefinition,
  type SharedToolSpec,
} from '../agentRuntime/runtimeToolSpec';
import type {RunAuthorizationCheck} from '../agentRuntime/runAuthorizationFence';
import {
  createRuntimeToolConcurrencyCoordinator,
  type RuntimeToolConcurrencyCoordinator,
} from '../agentRuntime/runtimeToolConcurrency';
import {
  type McpToolAci,
  type McpToolExposure,
  makeSparkProvenance,
  type McpPublicApiContract,
} from '../types/sparkContracts';
import {getPlanToolCapability} from './types';
import type {RunManifestAttributionSink} from '../types/selfEvolution';
import {withRuntimeToolObserver, type RuntimeToolInvocationEvent, type RuntimeToolObserver} from '../agentRuntime/runtimeToolObserver';
import {withRuntimeToolInvocationScope} from '../agentRuntime/runtimeToolInvocationContext';
import {createRuntimeToolResult} from '../agentRuntime/runtimeToolResult';
import type {RuntimeToolResult} from '../agentRuntime/runtimeToolSpec';

/** The MCP server name every SmartPerfetto tool host uses: the Claude
 * engine's in-process SDK server and the standalone stdio server. */
export const MCP_SERVER_NAME = 'smartperfetto';

/** MCP tool name prefix — derived from `MCP_SERVER_NAME`.
 * `claudeMcpServer.ts` exports the same constant; both files agree
 * because both import from this module. The SDK consumes prefixed
 * names in its `allowedTools` array; the MCP protocol itself uses
 * short names. */
export const MCP_NAME_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

/** One tool stored in the registry. `shared` is the SDK-neutral
 * SmartPerfetto tool body every runtime adapts to its own SDK view. */
export interface McpToolDefinition {
  /** Short MCP tool name (no prefix). */
  name: string;
  /** Shared SmartPerfetto tool body and schema. */
  shared: SharedToolSpec;
  /** Exposure level — drives stdio / A2A filtering downstream. */
  exposure: McpToolExposure;
  /** Human-readable summary surfaced via `getAci()`. Optional during
   * M0 because most existing tools already carry their own description
   * inside the tool definition; M1 populates this as it migrates the
   * description text to a stable place. */
  summary?: string;
  /** Required env vars or capability flags. */
  requires?: string[];
  evidenceEffect?: SharedToolSpec['evidenceEffect'];
  role?: SharedToolSpec['role'];
}

export interface ToolRequestScope {
  readonly sessionId: string;
  readonly hasCodebaseAccess: boolean;
  readonly capabilities?: readonly string[];
  readonly allowNewEvidence?: boolean;
}

/**
 * Whether a request scope admits a tool with this access. The registry gates
 * every registered tool with it; product-owned acquisition outside the
 * registry (scene entry evidence) asks it about `invoke_skill`'s access.
 */
export function isToolAllowedForScope(
  tool: Pick<McpToolDefinition, 'exposure' | 'evidenceEffect'>,
  scope: ToolRequestScope | undefined,
): boolean {
  if (!scope) return true;
  if (tool.exposure === 'deprecated') return false;
  if (tool.exposure === 'requires_codebase_permission' && !scope.hasCodebaseAccess) return false;
  return scope.allowNewEvidence !== false || tool.evidenceEffect === 'none' ||
    tool.evidenceEffect === 'read_existing' || tool.evidenceEffect === 'background';
}

/**
 * Run-supplied pacing for evidence acquisition. It is consulted only after the
 * request scope and runtime lifecycle guards admit a call, so authorization
 * and closed-run refusals always win; it never applies to non-acquisition
 * tools. Refusals use the ordinary `{success: false, action_required}` shape.
 */
export interface RuntimeAcquisitionPolicy {
  /** Every invocation's lifecycle, for pacing clocks only. */
  observe?(event: RuntimeToolInvocationEvent): void;
  /** A policy refusal stops this acquisition; undefined admits it. */
  admit(toolName: string): RuntimeToolResult | undefined;
  /** An admitted acquisition returned; may add one reminder to its result. */
  complete?(toolName: string, result: RuntimeToolResult): RuntimeToolResult;
}

const acquisitionClosedRefusal = () => createRuntimeToolResult({success: false,
  action_required: 'deliver_existing_conclusion', unsupportedReason: 'acquisition_closed'}, {isError: true});

function withAcquisitionPolicy(spec: SharedToolSpec, policy: RuntimeAcquisitionPolicy): SharedToolSpec {
  const admitted = withRuntimeToolTiming(spec).handler;
  const handler: SharedToolSpec['handler'] = async (args, extra) => {
    let refusal: RuntimeToolResult | undefined;
    // Fail closed: a policy that cannot decide (e.g. its run was revoked) must not admit acquisition.
    try { refusal = policy.admit(spec.name); } catch { refusal = acquisitionClosedRefusal(); }
    if (refusal) return withRuntimeToolTiming({...spec, handler: async () => refusal!}).handler(args, extra);
    const result = await admitted(args, extra);
    try { return policy.complete ? policy.complete(spec.name, result) : result; } catch { return result; }
  };
  // Carries the timed marker: both branches are timed exactly once, so outer guards do not re-time.
  Object.assign(handler, admitted);
  return {...spec, handler};
}

/**
 * `register` publishes an optional `planPhaseId` on every evidence-capable
 * tool. It is plan attribution, not tool input: handlers with a strict input
 * contract take the tool input from here.
 */
export function splitPlanAttribution<T extends Record<string, unknown>>(input: T):
  {planPhaseId?: string; toolInput: Omit<T, 'planPhaseId'>} {
  const {planPhaseId, ...toolInput} = input;
  return {...(typeof planPhaseId === 'string' ? {planPhaseId} : {}), toolInput};
}

/**
 * Filter the registry contents by one or more exposure levels.
 *
 * Useful for stdio adapter (`['public']`) or admin-only paths
 * (`['internal']`). The default `claudeMcpServer.ts` consumer takes
 * everything, including internal session-protocol tools, because the
 * Claude SDK is the agent itself and is the legitimate caller of
 * those tools.
 */
export function filterByExposure(
  defs: readonly McpToolDefinition[],
  exposures: readonly McpToolExposure[],
): McpToolDefinition[] {
  const wanted = new Set(exposures);
  return defs.filter(d => wanted.has(d.exposure));
}

/** Derive the SDK `allowedTools` array — short names with the
 * SmartPerfetto prefix. Order is preserved so callers that care
 * about deterministic ordering get it. */
export function buildAllowedTools(
  defs: readonly McpToolDefinition[],
): string[] {
  return defs.map(d => `${MCP_NAME_PREFIX}${d.name}`);
}

/**
 * The McpToolRegistry collects tool definitions and emits the views
 * the existing `claudeMcpServer.ts` consumer needs (request-authorized
 * definitions + allowedTools list) plus the views M1 will need (stdio
 * dispatcher, ACI snapshot for `McpPublicApiContract`). Each runtime
 * adapts the definitions' shared specs to its own SDK.
 *
 * Stateful registration order matters — an SDK server uses array order
 * to match `allowedTools[i]` to `tools[i]`. Registration appends; later
 * calls cannot reorder the registry.
 */
export class McpToolRegistry {
  private readonly entries: McpToolDefinition[] = [];
  private readonly toolConcurrencyCoordinator: RuntimeToolConcurrencyCoordinator;
  private readonly runManifestAttributionSink?: RunManifestAttributionSink;
  private readonly toolObserver?: RuntimeToolObserver;
  private readonly acquisitionObserver?: RuntimeToolObserver;
  private readonly requestScope?: ToolRequestScope;
  private readonly canInvokeTool?: () => boolean;
  private readonly acquisitionPolicy?: RuntimeAcquisitionPolicy;
  private readonly runId?: string;
  private readonly runAuthorization?: RunAuthorizationCheck;

  constructor(options: {
    toolConcurrencyCoordinator?: RuntimeToolConcurrencyCoordinator;
    runManifestAttributionSink?: RunManifestAttributionSink;
    toolObserver?: RuntimeToolObserver;
    acquisitionObserver?: RuntimeToolObserver;
    requestScope?: ToolRequestScope;
    canInvokeTool?: () => boolean;
    acquisitionPolicy?: RuntimeAcquisitionPolicy;
    runId?: string;
    /** The run's pinned authorization, checked around every tool call. */
    runAuthorization?: RunAuthorizationCheck;
  } = {}) {
    this.toolConcurrencyCoordinator = options.toolConcurrencyCoordinator
      ?? createRuntimeToolConcurrencyCoordinator();
    this.runManifestAttributionSink = options.runManifestAttributionSink;
    this.toolObserver = options.toolObserver;
    this.acquisitionObserver = options.acquisitionObserver;
    this.canInvokeTool = options.canInvokeTool;
    this.acquisitionPolicy = options.acquisitionPolicy;
    this.runId = options.runId;
    this.runAuthorization = options.runAuthorization;
    this.requestScope = options.requestScope && Object.freeze({
      ...options.requestScope,
      ...(options.requestScope.capabilities
        ? {capabilities: Object.freeze([...options.requestScope.capabilities])}
        : {}),
    });
  }

  /** Register an SDK-neutral SmartPerfetto tool spec. Does NOT prevent
   * duplicates by name; callers control ordering and uniqueness explicitly
   * so the existing conditional registration patterns
   * (`if (writeAnalysisNote) registry.registerTool(...)`) keep working. */
  registerShared(base: SharedToolSpec): void {
    const planCapability = getPlanToolCapability(base.name);
    const shared = base.role !== 'final_candidate_submission' && planCapability === 'evidence' && !base.inputSchema.planPhaseId
      ? {...base, inputSchema: {...base.inputSchema,
          planPhaseId: z.string().optional().describe('Optional explicit plan phase ID for this invocation.'),
        }}
      : base;
    const access = Object.freeze({exposure: shared.exposure, evidenceEffect: shared.evidenceEffect});
    const compact = compactSharedToolSpec(shared);
    // Innermost, so scope and lifecycle guards below are evaluated first.
    const paced = shared.evidenceEffect === 'acquire' && this.acquisitionPolicy
      ? withAcquisitionPolicy(compact, this.acquisitionPolicy) : compact;
    const scopeGuarded = withRuntimeToolGuard(
      paced,
      () => isToolAllowedForScope(access, this.requestScope),
      async () => createRuntimeToolResult({
        success: false,
        action_required: 'use_authorized_existing_evidence',
        unsupportedReason: 'tool_not_allowed_for_request',
      }, {isError: true}),
    );
    const guarded = withRuntimeToolGuard(scopeGuarded, () => {
      try { return this.canInvokeTool?.() !== false; } catch { return false; }
    }, async () => acquisitionClosedRefusal());
    const acquisitionObserver = shared.role !== 'final_candidate_submission' && shared.evidenceEffect === 'acquire'
      ? this.acquisitionObserver : undefined;
    const pacing = shared.role === 'final_candidate_submission' ? undefined : this.acquisitionPolicy;
    const observer: RuntimeToolObserver | undefined = acquisitionObserver || pacing?.observe ? async event => {
      try { pacing?.observe?.(event); } catch { /* Pacing clocks never change a tool outcome. */ }
      if (acquisitionObserver) {
        try { await acquisitionObserver(event); } catch { /* Retained captures remain independently checked. */ }
      }
      if (this.toolObserver) await this.toolObserver(event);
    } : this.toolObserver;
    const scoped = withRuntimeToolInvocationScope(withRuntimeToolObserver(guarded, observer), this.runId);
    const runtimeShared = withRuntimeToolConcurrency(
      this.runAuthorization?.enforced ? withRuntimeToolAuthorization(scoped, this.runAuthorization) : scoped,
      this.toolConcurrencyCoordinator,
      {runManifestAttributionSink: this.runManifestAttributionSink},
    );
    this.entries.push(Object.freeze({
      name: runtimeShared.name,
      shared: runtimeShared,
      exposure: runtimeShared.exposure,
      summary: runtimeShared.summary,
      requires: runtimeShared.requires,
      evidenceEffect: runtimeShared.evidenceEffect,
      ...(runtimeShared.role ? {role: runtimeShared.role} : {}),
    }));
  }

  /** Register a `defineRuntimeTool` body under `name` with the call
   * site's exposure and evidence policy. */
  registerTool(
    tool: RuntimeToolDefinition,
    name: string,
    exposure: McpToolExposure,
    extras?: Pick<McpToolDefinition, 'summary' | 'requires' | 'evidenceEffect' | 'role'> & Pick<SharedToolSpec, 'concurrency'>,
  ): void {
    this.registerShared(sharedToolSpecFromRuntimeToolDefinition(name, tool, exposure, extras));
  }

  /** Request-authorized entries in registration order. */
  list(): readonly McpToolDefinition[] {
    return this.listForRequest();
  }

  listForRequest(scope?: ToolRequestScope): McpToolDefinition[] {
    return this.entries.filter(entry =>
      isToolAllowedForScope(entry, this.requestScope) && isToolAllowedForScope(entry, scope),
    );
  }

  /** Allowed-tools array prefixed for the SDK call site. Matches the
   * exact format `claudeMcpServer.ts` returned before the refactor. */
  buildAllowedTools(scope?: ToolRequestScope): string[] {
    return buildAllowedTools(this.listForRequest(scope));
  }

  /** Snapshot of the registry as `McpToolAci[]` — drives the future
   * `McpPublicApiContract.tools` field once M1 populates summary /
   * inputSchema / examples per tool. M0 emits a minimal ACI with
   * just name + qualified name + exposure; the description / schema
   * fields stay optional so older snapshots remain readable. */
  getAci(scope?: ToolRequestScope): McpToolAci[] {
    const entries = this.listForRequest(scope);
    return entries.map(e => ({
      toolName: e.name,
      qualifiedName: `${MCP_NAME_PREFIX}${e.name}`,
      exposure: e.exposure,
      summary: e.summary ?? '',
      ...(e.requires ? {requires: e.requires} : {}),
    }));
  }

  /** Build a minimal `McpPublicApiContract` for export / inspection.
   * `agentCards` is empty for now (Plan 41 M2 populates it once A2A
   * is opt-in enabled). */
  buildPublicApiContract(opts: {
    serverVersion?: string;
    protocolVersion?: string;
    scope?: ToolRequestScope;
  } = {}): McpPublicApiContract {
    return {
      ...makeSparkProvenance({source: 'mcpToolRegistry'}),
      tools: this.getAci(opts.scope),
      serverVersion: opts.serverVersion ?? '1.0.0',
      protocolVersion: opts.protocolVersion ?? '2024-11-05',
      coverage: [
        {sparkId: 91, planId: '41', status: 'scaffolded'},
        {sparkId: 92, planId: '41', status: 'scaffolded'},
        {sparkId: 96, planId: '41', status: 'scaffolded'},
        {sparkId: 133, planId: '41', status: 'scaffolded'},
        {sparkId: 139, planId: '41', status: 'scaffolded'},
        {sparkId: 173, planId: '41', status: 'scaffolded'},
      ],
    };
  }

  /** Number of request-authorized tools. */
  size(): number {
    return this.listForRequest().length;
  }

  probeCapabilities(scope: ToolRequestScope): {
    codeAwareAvailable: boolean;
    reason?: 'feature_disabled' | 'no_codebase_configured' | 'no_permission' | 'consent_required_but_missing';
  } {
    if (process.env.SMARTPERFETTO_CODE_AWARE === 'off') {
      return {codeAwareAvailable: false, reason: 'feature_disabled'};
    }
    if (!scope.hasCodebaseAccess || this.requestScope?.hasCodebaseAccess === false) {
      return {codeAwareAvailable: false, reason: 'no_permission'};
    }
    return {codeAwareAvailable: true};
  }
}
