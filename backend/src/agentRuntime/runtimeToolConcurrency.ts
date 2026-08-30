// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {AsyncLocalStorage} from 'async_hooks';
import {performance as nodePerformance} from 'perf_hooks';

import {isRuntimeCandidateAdmitted} from './runtimeCandidateAdmission';

export type RuntimeToolConcurrencyMode = 'exclusive' | 'commutative_read';

export interface RuntimeToolConcurrencyPolicy {
  mode: RuntimeToolConcurrencyMode;
  maxParallel?: number;
}

export interface RuntimeToolScheduling {
  policy: Required<Pick<RuntimeToolConcurrencyPolicy, 'mode'>> & Pick<RuntimeToolConcurrencyPolicy, 'maxParallel'>;
  schedulerWaitMs: number;
  fallbackReason?: RuntimeToolConcurrencyFallbackReason;
}

export type RuntimeToolConcurrencyFallbackReason =
  | 'disabled_by_env'
  | 'commutative_read_not_admitted';

export interface RuntimeToolConcurrencyDecision {
  policy: RuntimeToolScheduling['policy'];
  fallbackReason?: RuntimeToolConcurrencyFallbackReason;
}

export interface RuntimeToolConcurrencyRunInput<T> {
  toolName: string;
  policy?: RuntimeToolConcurrencyPolicy;
  signal?: AbortSignal;
  execute: (scheduling: RuntimeToolScheduling) => Promise<T> | T;
}

export interface RuntimeToolConcurrencyCoordinator {
  run<T>(input: RuntimeToolConcurrencyRunInput<T>): Promise<T>;
}

interface RuntimeToolConcurrencyCoordinatorOptions {
  now?: () => number;
  env?: Record<string, string | undefined>;
}

interface RuntimeToolCoordinatorExecutionToken {
  active: boolean;
  coordinators: Set<object>;
}

interface QueueEntry<T> {
  toolName: string;
  policy: RuntimeToolScheduling['policy'];
  fallbackReason?: RuntimeToolConcurrencyFallbackReason;
  enqueuedAt: number;
  signal?: AbortSignal;
  abortListener?: () => void;
  execute: (scheduling: RuntimeToolScheduling) => Promise<T> | T;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

export const SMARTPERFETTO_SAFE_TOOL_CONCURRENCY_ENV = 'SMARTPERFETTO_SAFE_TOOL_CONCURRENCY';
export const RUNTIME_TOOL_COMMUTATIVE_READ_MAX_PARALLEL = 4;
export const RUNTIME_TOOL_COMMUTATIVE_READ_NAMES = [
  'lookup_sql_schema',
  'list_stdlib_modules',
] as const;

const COMMUTATIVE_READ_TOOLS = new Set<string>(RUNTIME_TOOL_COMMUTATIVE_READ_NAMES);
const activeRuntimeToolCoordinatorTokens =
  new AsyncLocalStorage<readonly RuntimeToolCoordinatorExecutionToken[]>();

function hasActiveCoordinator(
  tokens: readonly RuntimeToolCoordinatorExecutionToken[] | undefined,
  coordinator: object,
): boolean {
  return tokens?.some(token => token.active && token.coordinators.has(coordinator)) ?? false;
}

function defaultNow(): number {
  return nodePerformance.now();
}

function safeToolConcurrencyEnabled(env: Record<string, string | undefined>): boolean {
  if (!isRuntimeCandidateAdmitted('task5', env)) return false;
  const raw = env[SMARTPERFETTO_SAFE_TOOL_CONCURRENCY_ENV];
  if (raw === undefined) return true;
  return !['0', 'false', 'no', 'off'].includes(raw.trim().toLowerCase());
}

function normalizeReadCap(maxParallel: number | undefined): number {
  if (maxParallel === undefined || !Number.isSafeInteger(maxParallel) || maxParallel <= 0) {
    return RUNTIME_TOOL_COMMUTATIVE_READ_MAX_PARALLEL;
  }
  return Math.min(maxParallel, RUNTIME_TOOL_COMMUTATIVE_READ_MAX_PARALLEL);
}

export function resolveRuntimeToolConcurrencyPolicy(
  toolName: string,
  policy?: RuntimeToolConcurrencyPolicy,
  env: Record<string, string | undefined> = process.env,
): RuntimeToolConcurrencyDecision {
  if (!safeToolConcurrencyEnabled(env)) {
    return {
      policy: {mode: 'exclusive'},
      fallbackReason: policy?.mode === 'commutative_read'
        ? (isRuntimeCandidateAdmitted('task5', env)
            ? 'disabled_by_env'
            : 'commutative_read_not_admitted')
        : undefined,
    };
  }

  if (policy?.mode !== 'commutative_read') {
    return {policy: {mode: 'exclusive'}};
  }

  if (!COMMUTATIVE_READ_TOOLS.has(toolName)) {
    return {
      policy: {mode: 'exclusive'},
      fallbackReason: 'commutative_read_not_admitted',
    };
  }

  return {
    policy: {
      mode: 'commutative_read',
      maxParallel: normalizeReadCap(policy.maxParallel),
    },
  };
}

function createAbortError(): Error {
  const error = new Error('Runtime tool execution aborted before scheduling');
  error.name = 'AbortError';
  return error;
}

export class FairRuntimeToolConcurrencyCoordinator implements RuntimeToolConcurrencyCoordinator {
  private readonly now: () => number;
  private readonly env: Record<string, string | undefined>;
  private readonly queue: Array<QueueEntry<unknown>> = [];
  private activeReads = 0;
  private activeWriter = false;

  constructor(options: RuntimeToolConcurrencyCoordinatorOptions = {}) {
    this.now = options.now ?? defaultNow;
    this.env = options.env ?? process.env;
  }

  run<T>(input: RuntimeToolConcurrencyRunInput<T>): Promise<T> {
    if (hasActiveCoordinator(activeRuntimeToolCoordinatorTokens.getStore(), this)) {
      return Promise.reject(new Error('runtime_tool_concurrency_reentrant'));
    }

    const decision = resolveRuntimeToolConcurrencyPolicy(input.toolName, input.policy, this.env);
    if (input.signal?.aborted) {
      return Promise.reject(createAbortError());
    }

    return new Promise<T>((resolve, reject) => {
      const entry: QueueEntry<T> = {
        toolName: input.toolName,
        policy: decision.policy,
        fallbackReason: decision.fallbackReason,
        enqueuedAt: this.now(),
        signal: input.signal,
        execute: input.execute,
        resolve,
        reject,
      };
      entry.abortListener = () => {
        const index = this.queue.indexOf(entry as QueueEntry<unknown>);
        if (index < 0) return;
        this.queue.splice(index, 1);
        input.signal?.removeEventListener('abort', entry.abortListener!);
        reject(createAbortError());
        this.drain();
      };
      input.signal?.addEventListener('abort', entry.abortListener, {once: true});
      this.queue.push(entry as QueueEntry<unknown>);
      this.drain();
    });
  }

  private drain(): void {
    if (this.activeWriter) return;

    while (this.queue.length > 0) {
      const next = this.queue[0];
      if (next.policy.mode === 'exclusive') {
        if (this.activeReads > 0 || this.activeWriter) return;
        this.queue.shift();
        this.start(next);
        return;
      }

      if (this.activeReads >= (next.policy.maxParallel ?? RUNTIME_TOOL_COMMUTATIVE_READ_MAX_PARALLEL)) {
        return;
      }

      this.queue.shift();
      this.start(next);
    }
  }

  private start<T>(entry: QueueEntry<T>): void {
    entry.signal?.removeEventListener('abort', entry.abortListener!);
    const schedulerWaitMs = Math.max(0, Math.round(this.now() - entry.enqueuedAt));
    if (entry.policy.mode === 'commutative_read') this.activeReads += 1;
    else this.activeWriter = true;

    const inheritedTokens = activeRuntimeToolCoordinatorTokens.getStore() ?? [];
    const executionToken: RuntimeToolCoordinatorExecutionToken = {
      active: true,
      coordinators: new Set([this]),
    };

    Promise.resolve()
      .then(() => activeRuntimeToolCoordinatorTokens.run(
        [...inheritedTokens, executionToken],
        async () => {
          try {
            return await entry.execute({
              policy: entry.policy,
              schedulerWaitMs,
              fallbackReason: entry.fallbackReason,
            });
          } finally {
            executionToken.coordinators.delete(this);
            executionToken.active = false;
          }
        },
      ))
      .then(entry.resolve, entry.reject)
      .finally(() => {
        if (entry.policy.mode === 'commutative_read') this.activeReads -= 1;
        else this.activeWriter = false;
        this.drain();
      });
  }
}

export function createRuntimeToolConcurrencyCoordinator(
  options: RuntimeToolConcurrencyCoordinatorOptions = {},
): RuntimeToolConcurrencyCoordinator {
  return new FairRuntimeToolConcurrencyCoordinator(options);
}
