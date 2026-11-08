// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * The Claude Agent SDK view of SmartPerfetto's shared tools. The registry holds
 * SDK-neutral `SharedToolSpec`s; the Claude runtime adapts them here, and
 * nowhere else.
 */

import {
  createSdkMcpServer,
  tool as createClaudeSdkTool,
  type SdkMcpToolDefinition,
} from '@anthropic-ai/claude-agent-sdk';

import {delegateRuntimeToolHandler, type SharedToolSpec} from '../../runtimeToolSpec';
import {MCP_SERVER_NAME, type McpToolDefinition} from '../../../agentv3/mcpToolRegistry';

// The shared `RuntimeToolResult`/`RuntimeToolAnnotations` mirror the MCP types
// the SDK uses, so the delegate handler and annotations pass without a cast.

/** The SDK descriptor of one shared tool; its handler keeps the spec's single timing receipt. */
export function createClaudeSdkToolFromSharedSpec(
  spec: SharedToolSpec,
): SdkMcpToolDefinition {
  const {spec: timedSpec, handler} = delegateRuntimeToolHandler(spec);
  const sdkTool = createClaudeSdkTool(
    timedSpec.name,
    timedSpec.description,
    timedSpec.inputSchema,
    handler,
    timedSpec.annotations ? {annotations: timedSpec.annotations} : undefined,
  );
  return Object.assign(sdkTool, {
    inputSchema: timedSpec.inputSchema,
    annotations: timedSpec.annotations,
  });
}

/**
 * The SDK's in-process MCP server for a run's request-authorized tools, in
 * registration order. It is named `MCP_SERVER_NAME`, matching `MCP_NAME_PREFIX`
 * in the run's `allowedTools`.
 */
export function createClaudeSdkMcpServer(definitions: readonly McpToolDefinition[]) {
  return createSdkMcpServer({
    name: MCP_SERVER_NAME,
    version: '1.0.0',
    tools: definitions.map(definition => createClaudeSdkToolFromSharedSpec(definition.shared)),
  });
}
