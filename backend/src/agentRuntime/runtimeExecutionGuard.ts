// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type { AgentRuntimeKind } from './runtimeKinds';

export interface RuntimeExecutionKey {
  runtime: AgentRuntimeKind;
  sessionId: string;
  referenceTraceId?: string;
  runId?: string;
}

export interface RuntimeExecutionLease {
  readonly key: RuntimeExecutionKey;
  readonly signal: AbortSignal;
  throwIfAborted(): void;
  settle(): void;
}

interface RuntimeExecutionEntry {
  key: RuntimeExecutionKey;
  token: symbol;
  controller: AbortController;
}

function canonicalExecutionKey(key: RuntimeExecutionKey): string {
  return JSON.stringify([key.runtime, key.sessionId]);
}

function throwAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  if (typeof signal.throwIfAborted === 'function') {
    signal.throwIfAborted();
  }
  const reason = signal.reason;
  if (reason instanceof Error) throw reason;
  throw new Error(reason ? String(reason) : 'Runtime execution aborted');
}

export class RuntimeExecutionGuard {
  private readonly entries = new Map<string, RuntimeExecutionEntry>();
  private readonly sessionKeys = new Map<string, Set<string>>();

  begin(key: RuntimeExecutionKey): RuntimeExecutionLease {
    const canonicalKey = canonicalExecutionKey(key);
    if (this.entries.has(canonicalKey)) {
      throw new Error(`Runtime analysis already in progress for session ${key.sessionId}`);
    }

    const token = Symbol(canonicalKey);
    const controller = new AbortController();
    const entry: RuntimeExecutionEntry = {
      key: { ...key },
      token,
      controller,
    };
    this.entries.set(canonicalKey, entry);
    let activeKeys = this.sessionKeys.get(key.sessionId);
    if (!activeKeys) {
      activeKeys = new Set<string>();
      this.sessionKeys.set(key.sessionId, activeKeys);
    }
    activeKeys.add(canonicalKey);

    return {
      key: entry.key,
      signal: controller.signal,
      throwIfAborted: () => throwAborted(controller.signal),
      settle: () => this.settle(canonicalKey, token),
    };
  }

  async abortSession(sessionId: string, reason?: unknown): Promise<number> {
    const activeKeys = this.sessionKeys.get(sessionId);
    if (!activeKeys) return 0;

    let aborted = 0;
    for (const canonicalKey of [...activeKeys]) {
      const entry = this.entries.get(canonicalKey);
      if (!entry) continue;
      if (!entry.controller.signal.aborted) {
        try {
          entry.controller.abort(reason ?? new Error(`Runtime analysis aborted for session ${sessionId}`));
        } catch {
          // Abort is best-effort signalling. Some provider adapters attach
          // abort listeners that can throw while the owning analysis is still
          // responsible for observing the aborted signal and producing the
          // cancellation result. Do not let cancellation delivery become an
          // unhandled rejection at the caller that requested the abort.
        }
        aborted += 1;
      }
    }
    return aborted;
  }

  clear(): void {
    for (const entry of this.entries.values()) {
      if (!entry.controller.signal.aborted) {
        entry.controller.abort(new Error('Runtime execution guard cleared'));
      }
    }
  }

  private settle(canonicalKey: string, token: symbol): void {
    const entry = this.entries.get(canonicalKey);
    if (!entry || entry.token !== token) return;

    this.entries.delete(canonicalKey);
    const activeKeys = this.sessionKeys.get(entry.key.sessionId);
    activeKeys?.delete(canonicalKey);
    if (activeKeys?.size === 0) {
      this.sessionKeys.delete(entry.key.sessionId);
    }
  }
}
