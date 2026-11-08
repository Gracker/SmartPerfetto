// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Mock for @anthropic-ai/claude-agent-sdk
 *
 * The real SDK is ESM-only (.mjs) and cannot be imported in Jest's CommonJS context.
 * This mock provides the minimum surface needed for compilation and testing.
 */

type QueryImplementation = (params: any) => AsyncIterable<any>;

const queryCalls: any[] = [];
let queryImplementation: QueryImplementation | undefined;

export const SYSTEM_PROMPT_DYNAMIC_BOUNDARY = '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__';

async function* emptyGenerator(): AsyncGenerator<any, void> {
  // No-op in tests by default.
}

function withClose(iterable: AsyncIterable<any>): AsyncIterable<any> & { close: () => void } {
  return Object.assign(iterable, { close: () => undefined });
}

/** Test helper for suites that need to inspect SDK query options. */
export function __setQueryImplementation(impl: QueryImplementation): void {
  queryImplementation = impl;
}

export function __getQueryCalls(): any[] {
  return queryCalls;
}

export function __resetQueryMock(): void {
  queryCalls.length = 0;
  queryImplementation = undefined;
}

/** Mock query function — returns an empty async generator unless a test overrides it. */
export function query(options: any): AsyncIterable<any> & { close: () => void } {
  queryCalls.push(options);
  return withClose(queryImplementation ? queryImplementation(options) : emptyGenerator());
}

/** Mock tool() builder — returns the tool definition as-is. */
export function tool(
  name: string,
  description: string,
  schema: Record<string, any>,
  handler: (...args: any[]) => any,
  options?: { annotations?: Record<string, unknown>; _meta?: Record<string, unknown> },
): any {
  return {
    name,
    description,
    inputSchema: schema,
    schema,
    handler,
    annotations: options?.annotations,
    _meta: options?._meta,
  };
}

/** Mock createSdkMcpServer — returns a config object. */
export function createSdkMcpServer(config: {
  name: string;
  version: string;
  tools: any[];
}): any {
  return {
    type: 'sdk' as const,
    name: config.name,
    instance: { name: config.name, version: config.version, tools: config.tools },
  };
}
