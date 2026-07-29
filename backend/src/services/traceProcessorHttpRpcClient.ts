// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import http from 'http';
import {
  decodeQueryResult,
  encodeQueryArgs,
} from './traceProcessorProtobuf';
import {
  createTraceProcessorQueryCancelledError,
  throwIfTraceProcessorQueryCancelled,
} from './traceProcessorCancellation';

export interface TraceProcessorHttpRpcRequest {
  hostname?: string;
  port: number;
  path?: '/query' | '/status';
  body: Buffer;
  timeoutMs: number;
  signal?: AbortSignal;
  maxResponseBytes?: number;
}

export interface TraceProcessorHttpRpcSqlRequest {
  hostname?: string;
  port: number;
  sql: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface TraceProcessorHttpRpcSqlResult {
  columns: string[];
  rows: any[][];
  durationMs: number;
  error?: string;
}

export async function executeTraceProcessorHttpRpcRaw(
  request: TraceProcessorHttpRpcRequest,
): Promise<Buffer> {
  throwIfTraceProcessorQueryCancelled(request.signal);
  if (
    request.maxResponseBytes !== undefined
    && (
      !Number.isSafeInteger(request.maxResponseBytes)
      || request.maxResponseBytes < 0
    )
  ) {
    throw new Error('trace_processor_response_budget_invalid');
  }
  const hostname = request.hostname || '127.0.0.1';
  const path = request.path || '/query';

  return new Promise((resolve, reject) => {
    let settled = false;
    let req: http.ClientRequest | null = null;
    let wallClockTimer: NodeJS.Timeout | undefined;
    const onAbort = (): void => {
      req?.destroy();
      finish(createTraceProcessorQueryCancelledError(request.signal?.reason));
    };

    const finish = (error: Error | null, body?: Buffer): void => {
      if (settled) return;
      settled = true;
      clearTimeout(wallClockTimer);
      request.signal?.removeEventListener('abort', onAbort);
      if (error) {
        reject(error);
      } else {
        resolve(body || Buffer.alloc(0));
      }
    };

    wallClockTimer = setTimeout(() => {
      req?.destroy();
      finish(new Error('Query timeout'));
    }, request.timeoutMs);
    if (typeof (wallClockTimer as any).unref === 'function') {
      (wallClockTimer as any).unref();
    }

    request.signal?.addEventListener('abort', onAbort, { once: true });
    if (request.signal?.aborted) {
      onAbort();
      return;
    }

    req = http.request({
      hostname,
      port: request.port,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-protobuf',
        'Content-Length': request.body.length,
      },
      timeout: request.timeoutMs,
    }, (res) => {
      const chunks: Buffer[] = [];
      let responseBytes = 0;
      res.on('data', chunk => {
        if (settled) return;
        const buffer = Buffer.from(chunk);
        responseBytes += buffer.byteLength;
        if (
          request.maxResponseBytes !== undefined
          && responseBytes > request.maxResponseBytes
        ) {
          req?.destroy();
          finish(new Error('trace_processor_response_budget_exceeded'));
          return;
        }
        chunks.push(buffer);
      });
      res.on('end', () => {
        const responseBody = Buffer.concat(chunks);
        if (res.statusCode !== 200) {
          finish(new Error(`HTTP ${res.statusCode}: ${responseBody.toString('utf8')}`));
          return;
        }
        finish(null, responseBody);
      });
    });

    req.on('error', error => {
      finish(error);
    });

    req.on('timeout', () => {
      req?.destroy();
      finish(new Error('Query timeout'));
    });

    req.write(request.body);
    req.end();
  });
}

export async function executeTraceProcessorHttpRpcSql(
  request: TraceProcessorHttpRpcSqlRequest,
): Promise<TraceProcessorHttpRpcSqlResult> {
  const startTime = Date.now();
  const response = await executeTraceProcessorHttpRpcRaw({
    hostname: request.hostname,
    port: request.port,
    path: '/query',
    body: encodeQueryArgs(request.sql),
    timeoutMs: request.timeoutMs,
    signal: request.signal,
  });
  const parsed = decodeQueryResult(response);
  return {
    columns: parsed.columnNames,
    rows: parsed.rows,
    durationMs: Date.now() - startTime,
    ...(parsed.error ? { error: parsed.error } : {}),
  };
}
