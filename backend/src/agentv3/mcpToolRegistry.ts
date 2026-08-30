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
 * Critical invariant: this file changes NO runtime behavior. The
 * existing in-process SDK MCP server keeps registering the same
 * tools with the same short names; the registry is just the named
 * vehicle. Trace regression 6/6 PASS proves zero impact.
 *
 * Out of scope for M0:
 *   - stdio adapter (lands in M1 as `standaloneMcpServer.ts`)
 *   - A2A AgentCard (M2)
 *   - SupersedeStoreReadOnlyAdapter (M1a, prerequisite for raising
 *     `recall_patterns` exposure from internal back to public)
 *
 * @module mcpToolRegistry
 */

import {createSdkMcpServer} from '@anthropic-ai/claude-agent-sdk';

import {
  compactSharedToolSpec,
  createClaudeSdkToolFromSharedSpec,
  sharedToolSpecFromClaudeSdkTool,
  withRuntimeToolConcurrency,
  type SharedToolSpec,
} from '../agentRuntime/runtimeToolSpec';
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
import type {RunManifestAttributionSink} from '../types/selfEvolution';

/** MCP tool name prefix — derived from the server name `'smartperfetto'`.
 * `claudeMcpServer.ts` exports the same constant; both files agree
 * because both import from this module. The SDK consumes prefixed
 * names in its `allowedTools` array; the MCP protocol itself uses
 * short names. */
export const MCP_NAME_PREFIX = 'mcp__smartperfetto__';

/** One tool stored in the registry. `shared` is the SDK-neutral
 * SmartPerfetto tool body; `tool` is the Claude SDK-native view
 * generated from it. */
export interface McpToolDefinition {
  /** Short MCP tool name (no prefix). */
  name: string;
  /** Shared SmartPerfetto tool body and schema. */
  shared: SharedToolSpec;
  /** Claude SDK tool descriptor — passed to `createSdkMcpServer`. */
  tool: unknown;
  /** Exposure level — drives stdio / A2A filtering downstream. */
  exposure: McpToolExposure;
  /** Human-readable summary surfaced via `getAci()`. Optional during
   * M0 because most existing tools already carry their own description
   * inside the SDK tool object; M1 populates this as it migrates the
   * description text to a stable place. */
  summary?: string;
  /** Required env vars or capability flags. */
  requires?: string[];
}

export type McpToolRegistration = Omit<McpToolDefinition, 'shared'> & {
  shared?: SharedToolSpec;
};

export interface ToolRequestScope {
  sessionId: string;
  hasCodebaseAccess: boolean;
  capabilities?: string[];
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
 * the existing `claudeMcpServer.ts` consumer needs (SDK server +
 * allowedTools list) plus the views M1 will need (stdio dispatcher,
 * ACI snapshot for `McpPublicApiContract`).
 *
 * Stateful registration order matters — the SDK uses array order to
 * match `allowedTools[i]` to `tools[i]`. `register()` appends; later
 * calls cannot reorder the registry.
 */
export class McpToolRegistry {
  private readonly entries: McpToolDefinition[] = [];
  private readonly toolConcurrencyCoordinator: RuntimeToolConcurrencyCoordinator;
  private readonly runManifestAttributionSink?: RunManifestAttributionSink;

  constructor(options: {
    toolConcurrencyCoordinator?: RuntimeToolConcurrencyCoordinator;
    runManifestAttributionSink?: RunManifestAttributionSink;
  } = {}) {
    this.toolConcurrencyCoordinator = options.toolConcurrencyCoordinator
      ?? createRuntimeToolConcurrencyCoordinator();
    this.runManifestAttributionSink = options.runManifestAttributionSink;
  }

  /** Add a tool to the registry. Does NOT prevent duplicates by
   * name; callers control ordering and uniqueness explicitly so the
   * existing conditional registration patterns
   * (`if (writeAnalysisNote) registry.register(...)`) keep working. */
  register(def: McpToolRegistration): void {
    const shared = def.shared ?? sharedToolSpecFromClaudeSdkTool(
      def.name,
      def.tool,
      def.exposure,
      {summary: def.summary, requires: def.requires},
    );
    const runtimeShared = withRuntimeToolConcurrency(
      compactSharedToolSpec(shared),
      this.toolConcurrencyCoordinator,
      {runManifestAttributionSink: this.runManifestAttributionSink},
    );
    this.entries.push({
      name: runtimeShared.name,
      shared: runtimeShared,
      tool: createClaudeSdkToolFromSharedSpec(runtimeShared),
      exposure: runtimeShared.exposure,
      summary: runtimeShared.summary,
      requires: runtimeShared.requires,
    });
  }

  /** Convenience for the existing call sites that pass `(tool,
   * name)` — keeps the migration patch in `claudeMcpServer.ts`
   * minimal. */
  registerSdk(
    tool: unknown,
    name: string,
    exposure: McpToolExposure,
    extras?: Pick<McpToolDefinition, 'summary' | 'requires'> & Pick<SharedToolSpec, 'concurrency'>,
  ): void {
    this.register({
      tool,
      name,
      exposure,
      shared: sharedToolSpecFromClaudeSdkTool(name, tool, exposure, extras),
      ...extras,
    });
  }

  /** Register an SDK-neutral SmartPerfetto tool body and build the
   * Claude SDK-native descriptor view from it. */
  registerShared(spec: SharedToolSpec): void {
    this.register({
      name: spec.name,
      exposure: spec.exposure,
      tool: createClaudeSdkToolFromSharedSpec(spec),
      shared: spec,
      summary: spec.summary,
      requires: spec.requires,
    });
  }

  /** Read-only view of every entry in registration order. */
  list(): readonly McpToolDefinition[] {
    return this.entries;
  }

  listForRequest(scope: ToolRequestScope): McpToolDefinition[] {
    return this.entries.filter(entry => {
      if (entry.exposure === 'requires_codebase_permission') {
        return scope.hasCodebaseAccess;
      }
      return entry.exposure !== 'deprecated';
    });
  }

  /** Build the SDK's in-process MCP server. The SDK names the server
   * `smartperfetto` to align with `MCP_NAME_PREFIX`; that linkage is
   * preserved here. */
  buildSdkServer(opts: {name?: string; version?: string; scope?: ToolRequestScope} = {}) {
    const entries = opts.scope ? this.listForRequest(opts.scope) : this.entries;
    return createSdkMcpServer({
      name: opts.name ?? 'smartperfetto',
      version: opts.version ?? '1.0.0',
      // The SDK accepts `unknown[]` here because tool() returns its own
      // opaque shape. Cast at the boundary; consumers do not get to
      // peek inside a tool descriptor.
      tools: entries.map(e => e.tool) as never,
    });
  }

  /** Allowed-tools array prefixed for the SDK call site. Matches the
   * exact format `claudeMcpServer.ts` returned before the refactor. */
  buildAllowedTools(scope?: ToolRequestScope): string[] {
    return buildAllowedTools(scope ? this.listForRequest(scope) : this.entries);
  }

  /** Snapshot of the registry as `McpToolAci[]` — drives the future
   * `McpPublicApiContract.tools` field once M1 populates summary /
   * inputSchema / examples per tool. M0 emits a minimal ACI with
   * just name + qualified name + exposure; the description / schema
   * fields stay optional so older snapshots remain readable. */
  getAci(scope?: ToolRequestScope): McpToolAci[] {
    const entries = scope ? this.listForRequest(scope) : this.entries;
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

  /** Number of registered tools — useful in tests. */
  size(): number {
    return this.entries.length;
  }

  probeCapabilities(scope: ToolRequestScope): {
    codeAwareAvailable: boolean;
    reason?: 'feature_disabled' | 'no_codebase_configured' | 'no_permission' | 'consent_required_but_missing';
  } {
    if (process.env.SMARTPERFETTO_CODE_AWARE === 'off') {
      return {codeAwareAvailable: false, reason: 'feature_disabled'};
    }
    if (!scope.hasCodebaseAccess) {
      return {codeAwareAvailable: false, reason: 'no_permission'};
    }
    return {codeAwareAvailable: true};
  }
}
