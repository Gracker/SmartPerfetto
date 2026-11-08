// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * StandaloneMcpServer — Plan 41 M1 stdio server.
 *
 * Implements the minimum subset of the Model Context Protocol that
 * Claude Code, Cursor, and Codex CLI clients use:
 *   - `initialize` handshake with capabilities advertisement
 *   - `tools/list` — returns the public-exposure tools from
 *     `McpToolRegistry`
 *   - `tools/call` — invokes the requested tool's handler with
 *     args, returns the structured content
 *
 * Wire protocol is JSON-RPC 2.0 over line-delimited JSON
 * (one request per stdin line, one response per stdout line).
 *
 * The dispatcher is factored out from the actual stdio wiring so
 * unit tests can drive request/response pairs without spawning a
 * subprocess. `bin/smartperfetto-mcp.ts` is the thin entry that
 * pipes process.stdin/stdout into `runStdioLoop`.
 *
 * Out of scope:
 * - Capability negotiation beyond `tools` (no resources / prompts).
 * - Auth handshake (deferred to Plan 41 M2 A2A).
 * - Streaming tool output (the agent SDK handlers we wrap are
 *   request/response only).
 *
 * @module standaloneMcpServer
 */

import {
  McpToolRegistry,
  filterByExposure,
  MCP_SERVER_NAME,
  type McpToolDefinition,
} from './mcpToolRegistry';
import { createJsonSchemaFromZodRawShape } from '../agentRuntime/runtimeToolSpec';

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_VERSION = '1.0.0';

/** JSON-RPC 2.0 request shape. `id` is optional for notifications. */
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: unknown;
}

/** JSON-RPC 2.0 response shape. Either `result` or `error` is set. */
export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: {code: number; message: string; data?: unknown};
}

/** Standard JSON-RPC error codes plus MCP-specific tool errors. */
export const RPC_ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  TOOL_EXECUTION_FAILED: -32000,
} as const;

/** Dispatch one JSON-RPC request against the registry. Pure
 * function — no I/O. The stdio loop wraps this and writes the
 * response back. */
export async function dispatch(
  registry: McpToolRegistry,
  req: JsonRpcRequest,
): Promise<JsonRpcResponse | null> {
  // Notifications (no id) — execute side effects but never reply.
  // Our protocol surface has none, but per JSON-RPC we silently drop.
  if (req.id === undefined) return null;
  const id = req.id;

  // Codex round E P2#5: parse-error sentinel surfaces with a real
  // PARSE_ERROR response instead of falling through to METHOD_NOT_FOUND.
  if (req.method === '__parse_error__') {
    return rpcError(null, RPC_ERROR_CODES.PARSE_ERROR, 'Invalid JSON');
  }

  if (req.method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        serverInfo: {name: MCP_SERVER_NAME, version: SERVER_VERSION},
        capabilities: {tools: {}},
      },
    };
  }

  if (req.method === 'tools/list') {
    // External hosts only see public tools. Internal session-protocol
    // tools (submit_plan, write_analysis_note, etc.) stay hidden so a
    // remote Claude Code instance cannot corrupt our session state.
    const publicDefs = filterByExposure(registry.list(), ['public']);
    return {
      jsonrpc: '2.0',
      id,
      result: {
        tools: publicDefs.map(d => sdkToolToMcpDescriptor(d)),
      },
    };
  }

  if (req.method === 'tools/call') {
    const params = (req.params ?? {}) as {name?: string; arguments?: unknown};
    if (!params.name || typeof params.name !== 'string') {
      return rpcError(id, RPC_ERROR_CODES.INVALID_PARAMS, '`name` is required');
    }
    const def = registry.list().find(d => d.name === params.name);
    if (!def) {
      return rpcError(
        id,
        RPC_ERROR_CODES.METHOD_NOT_FOUND,
        `Unknown tool '${params.name}'`,
      );
    }
    if (def.exposure !== 'public') {
      // Internal / deprecated tools stay invisible to external hosts
      // both in the listing and at call time.
      return rpcError(
        id,
        RPC_ERROR_CODES.METHOD_NOT_FOUND,
        `Tool '${params.name}' is not exposed to external hosts`,
      );
    }
    try {
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const out = await def.shared.handler(args, {});
      return {jsonrpc: '2.0', id, result: out};
    } catch (err) {
      return rpcError(
        id,
        RPC_ERROR_CODES.TOOL_EXECUTION_FAILED,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return rpcError(
    id,
    RPC_ERROR_CODES.METHOD_NOT_FOUND,
    `Unknown method '${req.method}'`,
  );
}

function rpcError(
  id: string | number | null,
  code: number,
  message: string,
): JsonRpcResponse {
  return {jsonrpc: '2.0', id, error: {code, message}};
}

function sdkToolToMcpDescriptor(def: McpToolDefinition): {
  name: string;
  description: string;
  inputSchema: unknown;
} {
  return {
    name: def.name,
    description: def.summary || def.shared.description,
    inputSchema: createJsonSchemaFromZodRawShape(def.shared.inputSchema),
  };
}

/** Stream of incoming JSON-RPC messages. Implementations split a
 * stdin readable into one parsed request per line. */
export interface RequestSource {
  /** Yields the next request, or null when input is closed. */
  next(): Promise<JsonRpcRequest | null>;
}

/** Sink for outgoing JSON-RPC responses. */
export interface ResponseSink {
  send(response: JsonRpcResponse): void;
}

/** Run the dispatch loop until the source is exhausted. Each
 * request is dispatched independently; failures in one tool call
 * never bring down the loop. */
export async function runStdioLoop(
  registry: McpToolRegistry,
  source: RequestSource,
  sink: ResponseSink,
): Promise<void> {
  while (true) {
    const req = await source.next();
    if (req === null) return;
    try {
      const resp = await dispatch(registry, req);
      if (resp) sink.send(resp);
    } catch (err) {
      // Defensive: dispatch itself shouldn't throw, but if a tool
      // handler throws synchronously past the inner catch, log it
      // back as an internal error rather than crashing the server.
      const id = req.id ?? null;
      sink.send(
        rpcError(
          id,
          RPC_ERROR_CODES.INTERNAL_ERROR,
          err instanceof Error ? err.message : String(err),
        ),
      );
    }
  }
}

/** stdin-backed request source: reads line-delimited JSON from a
 * Node Readable. Returns null when the stream ends. Malformed JSON
 * lines are surfaced as a special MALFORMED_PARSE request so the
 * dispatch layer can emit a proper PARSE_ERROR. */
export class LineDelimitedJsonSource implements RequestSource {
  private buffer = '';
  private queue: (JsonRpcRequest | typeof PARSE_ERROR_SENTINEL)[] = [];
  private closed = false;
  private wakeup: (() => void) | null = null;

  constructor(stream: NodeJS.ReadableStream) {
    stream.setEncoding?.('utf-8');
    stream.on('data', (chunk: string) => {
      this.buffer += chunk;
      this.drainBuffer();
      this.wake();
    });
    stream.on('end', () => {
      // Flush any partial line.
      if (this.buffer.trim().length > 0) {
        this.tryParseAndQueue(this.buffer);
        this.buffer = '';
      }
      this.closed = true;
      this.wake();
    });
    stream.on('close', () => {
      this.closed = true;
      this.wake();
    });
  }

  private drainBuffer(): void {
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line.length > 0) this.tryParseAndQueue(line);
    }
  }

  private tryParseAndQueue(line: string): void {
    try {
      const obj = JSON.parse(line) as JsonRpcRequest;
      this.queue.push(obj);
    } catch {
      this.queue.push(PARSE_ERROR_SENTINEL);
    }
  }

  private wake(): void {
    const w = this.wakeup;
    this.wakeup = null;
    w?.();
  }

  async next(): Promise<JsonRpcRequest | null> {
    while (this.queue.length === 0 && !this.closed) {
      await new Promise<void>(resolve => (this.wakeup = resolve));
    }
    const head = this.queue.shift();
    if (!head) return null;
    if (head === PARSE_ERROR_SENTINEL) {
      // Synthesize a parse-error request — the dispatcher emits the
      // proper PARSE_ERROR response. id=null since we have no real id.
      return {jsonrpc: '2.0', id: null, method: '__parse_error__'};
    }
    return head;
  }
}

const PARSE_ERROR_SENTINEL = Symbol('parse-error');

/** stdout-backed response sink. Writes one JSON-encoded response
 * per line. */
export class LineDelimitedJsonSink implements ResponseSink {
  constructor(private stream: NodeJS.WritableStream) {}
  send(response: JsonRpcResponse): void {
    this.stream.write(JSON.stringify(response) + '\n');
  }
}
