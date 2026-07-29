// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { parentPort } from 'worker_threads';
import { executeTraceProcessorHttpRpcRaw } from './traceProcessorHttpRpcClient';

interface WorkerQueryMessage {
  id: number;
  hostname?: string;
  port: number;
  body: Uint8Array;
  timeoutMs: number;
  maxResponseBytes?: number;
  cancel?: false;
}

interface WorkerCancelMessage {
  id: number;
  cancel: true;
}

if (!parentPort) {
  throw new Error('traceProcessorSqlWorkerThread must run inside a worker_thread');
}

const activeRequests = new Map<number, AbortController>();

parentPort.on('message', (message: WorkerQueryMessage | WorkerCancelMessage) => {
  if (message.cancel) {
    activeRequests.get(message.id)?.abort();
    return;
  }
  void (async () => {
    const controller = new AbortController();
    activeRequests.set(message.id, controller);
    try {
      const body = await executeTraceProcessorHttpRpcRaw({
        hostname: message.hostname,
        port: message.port,
        body: Buffer.from(message.body),
        timeoutMs: message.timeoutMs,
        maxResponseBytes: message.maxResponseBytes,
        signal: controller.signal,
      });
      parentPort!.postMessage({
        id: message.id,
        ok: true,
        body,
      });
    } catch (error: any) {
      parentPort!.postMessage({
        id: message.id,
        ok: false,
        error: error?.message || String(error),
      });
    } finally {
      activeRequests.delete(message.id);
    }
  })();
});
