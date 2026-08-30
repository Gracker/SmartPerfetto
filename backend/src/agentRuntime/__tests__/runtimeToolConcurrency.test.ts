// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from '@jest/globals';

import {
  createRuntimeToolConcurrencyCoordinator,
  resolveRuntimeToolConcurrencyPolicy,
  SMARTPERFETTO_SAFE_TOOL_CONCURRENCY_ENV,
  type RuntimeToolConcurrencyPolicy,
} from '../runtimeToolConcurrency';
import {SMARTPERFETTO_ADMITTED_RUNTIME_CANDIDATES_ENV} from '../runtimeCandidateAdmission';

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return {promise, resolve, reject};
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

const readPolicy: RuntimeToolConcurrencyPolicy = {mode: 'commutative_read'};
const exclusivePolicy: RuntimeToolConcurrencyPolicy = {mode: 'exclusive'};

describe('runtime tool concurrency coordinator', () => {
  const admittedEnv = {
    [SMARTPERFETTO_ADMITTED_RUNTIME_CANDIDATES_ENV]: 'task5',
  };

  it('overlaps admitted read tools and caps active reads at four', async () => {
    const coordinator = createRuntimeToolConcurrencyCoordinator({env: admittedEnv});
    const gates = Array.from({length: 5}, () => createDeferred<string>());
    const started: string[] = [];

    const runs = gates.map((gate, index) => coordinator.run({
      toolName: index % 2 === 0 ? 'lookup_sql_schema' : 'list_stdlib_modules',
      policy: readPolicy,
      execute: async () => {
        const id = `read-${index}`;
        started.push(id);
        return gate.promise;
      },
    }));

    await flushPromises();
    expect(started).toEqual(['read-0', 'read-1', 'read-2', 'read-3']);

    gates[1].resolve('done-1');
    await expect(runs[1]).resolves.toBe('done-1');
    await flushPromises();

    expect(started).toEqual(['read-0', 'read-1', 'read-2', 'read-3', 'read-4']);

    gates[0].resolve('done-0');
    gates[2].resolve('done-2');
    gates[3].resolve('done-3');
    gates[4].resolve('done-4');
    await expect(Promise.all(runs)).resolves.toEqual([
      'done-0',
      'done-1',
      'done-2',
      'done-3',
      'done-4',
    ]);
  });

  it('gives a waiting writer priority over later reads', async () => {
    const coordinator = createRuntimeToolConcurrencyCoordinator({env: admittedEnv});
    const firstRead = createDeferred<string>();
    const writer = createDeferred<string>();
    const lateRead = createDeferred<string>();
    const started: string[] = [];

    const first = coordinator.run({
      toolName: 'lookup_sql_schema',
      policy: readPolicy,
      execute: async () => {
        started.push('first-read');
        return firstRead.promise;
      },
    });
    await flushPromises();

    const write = coordinator.run({
      toolName: 'execute_sql',
      policy: exclusivePolicy,
      execute: async () => {
        started.push('writer');
        return writer.promise;
      },
    });
    const second = coordinator.run({
      toolName: 'list_stdlib_modules',
      policy: readPolicy,
      execute: async () => {
        started.push('late-read');
        return lateRead.promise;
      },
    });
    await flushPromises();

    expect(started).toEqual(['first-read']);

    firstRead.resolve('read-done');
    await expect(first).resolves.toBe('read-done');
    await flushPromises();

    expect(started).toEqual(['first-read', 'writer']);

    writer.resolve('write-done');
    await expect(write).resolves.toBe('write-done');
    await flushPromises();

    expect(started).toEqual(['first-read', 'writer', 'late-read']);
    lateRead.resolve('late-read-done');
    await expect(second).resolves.toBe('late-read-done');
  });

  it('removes queued reads and writers on abort without starving later work', async () => {
    const coordinator = createRuntimeToolConcurrencyCoordinator({env: admittedEnv});
    const active = createDeferred<string>();
    const queuedReadAbort = new AbortController();
    const queuedWriterAbort = new AbortController();
    const survivor = createDeferred<string>();
    const started: string[] = [];

    const activeRun = coordinator.run({
      toolName: 'execute_sql',
      policy: exclusivePolicy,
      execute: async () => {
        started.push('active-writer');
        return active.promise;
      },
    });
    await flushPromises();

    const abortedRead = coordinator.run({
      toolName: 'lookup_sql_schema',
      policy: readPolicy,
      signal: queuedReadAbort.signal,
      execute: async () => {
        started.push('aborted-read');
        return 'unexpected';
      },
    });
    const abortedWriter = coordinator.run({
      toolName: 'invoke_skill',
      policy: exclusivePolicy,
      signal: queuedWriterAbort.signal,
      execute: async () => {
        started.push('aborted-writer');
        return 'unexpected';
      },
    });
    const survivingRead = coordinator.run({
      toolName: 'list_stdlib_modules',
      policy: readPolicy,
      execute: async () => {
        started.push('surviving-read');
        return survivor.promise;
      },
    });

    queuedReadAbort.abort();
    queuedWriterAbort.abort();
    await expect(abortedRead).rejects.toMatchObject({name: 'AbortError'});
    await expect(abortedWriter).rejects.toMatchObject({name: 'AbortError'});

    active.resolve('active-done');
    await expect(activeRun).resolves.toBe('active-done');
    await flushPromises();

    expect(started).toEqual(['active-writer', 'surviving-read']);
    survivor.resolve('survivor-done');
    await expect(survivingRead).resolves.toBe('survivor-done');
  });

  it('keeps coordinators request scoped', async () => {
    const first = createRuntimeToolConcurrencyCoordinator({env: admittedEnv});
    const second = createRuntimeToolConcurrencyCoordinator({env: admittedEnv});
    const active = createDeferred<string>();
    const started: string[] = [];

    const blockedInFirst = first.run({
      toolName: 'execute_sql',
      policy: exclusivePolicy,
      execute: async () => {
        started.push('first-writer');
        return active.promise;
      },
    });
    await flushPromises();

    await expect(second.run({
      toolName: 'lookup_sql_schema',
      policy: readPolicy,
      execute: async () => {
        started.push('second-read');
        return 'second-done';
      },
    })).resolves.toBe('second-done');

    active.resolve('first-done');
    await expect(blockedInFirst).resolves.toBe('first-done');
    expect(started).toEqual(['first-writer', 'second-read']);
  });

  it('rejects nested same-coordinator tool invocations before deadlock and leaves the queue usable', async () => {
    const coordinator = createRuntimeToolConcurrencyCoordinator({env: admittedEnv});
    const started: string[] = [];

    await expect(coordinator.run({
      toolName: 'execute_sql',
      policy: exclusivePolicy,
      execute: async () => {
        started.push('outer');
        return coordinator.run({
          toolName: 'lookup_sql_schema',
          policy: readPolicy,
          execute: async () => {
            started.push('inner');
            return 'unexpected';
          },
        });
      },
    })).rejects.toThrow('runtime_tool_concurrency_reentrant');

    expect(started).toEqual(['outer']);
    await expect(coordinator.run({
      toolName: 'lookup_sql_schema',
      policy: readPolicy,
      execute: async () => {
        started.push('after');
        return 'after-ok';
      },
    })).resolves.toBe('after-ok');
    expect(started).toEqual(['outer', 'after']);
  });

  it('allows detached descendants after outer completion while rejecting active nested invocations', async () => {
    const coordinator = createRuntimeToolConcurrencyCoordinator({env: admittedEnv});
    const releaseDetached = createDeferred<void>();
    const detachedScheduled = createDeferred<void>();
    let detachedRun: Promise<string> | undefined;
    const started: string[] = [];

    await expect(coordinator.run({
      toolName: 'execute_sql',
      policy: exclusivePolicy,
      execute: async () => {
        started.push('outer');
        await expect(coordinator.run({
          toolName: 'lookup_sql_schema',
          policy: readPolicy,
          execute: async () => {
            started.push('active-nested');
            return 'unexpected-active';
          },
        })).rejects.toThrow('runtime_tool_concurrency_reentrant');

        void (async () => {
          await releaseDetached.promise;
          detachedRun = coordinator.run({
            toolName: 'lookup_sql_schema',
            policy: readPolicy,
            execute: async () => {
              started.push('detached-after');
              return 'detached-ok';
            },
          });
          detachedScheduled.resolve();
        })();

        return 'outer-ok';
      },
    })).resolves.toBe('outer-ok');

    releaseDetached.resolve();
    await detachedScheduled.promise;
    await expect(detachedRun).resolves.toBe('detached-ok');
    expect(started).toEqual(['outer', 'detached-after']);
  });

  it('resolves exact safe-read tools and rollback flag to effective policies', () => {
    expect(resolveRuntimeToolConcurrencyPolicy('lookup_sql_schema', readPolicy)).toEqual({
      policy: {mode: 'exclusive'},
      fallbackReason: 'commutative_read_not_admitted',
    });
    expect(resolveRuntimeToolConcurrencyPolicy('lookup_sql_schema', readPolicy, admittedEnv).policy)
      .toEqual({mode: 'commutative_read', maxParallel: 4});
    expect(resolveRuntimeToolConcurrencyPolicy('list_stdlib_modules', readPolicy, admittedEnv).policy)
      .toEqual({mode: 'commutative_read', maxParallel: 4});
    expect(resolveRuntimeToolConcurrencyPolicy('fetch_artifact', readPolicy, admittedEnv))
      .toEqual({
        policy: {mode: 'exclusive'},
        fallbackReason: 'commutative_read_not_admitted',
      });
    expect(resolveRuntimeToolConcurrencyPolicy('lookup_sql_schema', readPolicy, {
      ...admittedEnv,
      [SMARTPERFETTO_SAFE_TOOL_CONCURRENCY_ENV]: 'false',
    })).toEqual({
      policy: {mode: 'exclusive'},
      fallbackReason: 'disabled_by_env',
    });
    expect(resolveRuntimeToolConcurrencyPolicy('execute_sql', undefined).policy)
      .toEqual({mode: 'exclusive'});
    expect(resolveRuntimeToolConcurrencyPolicy('lookup_sql_schema', readPolicy, {
      [SMARTPERFETTO_SAFE_TOOL_CONCURRENCY_ENV]: 'true',
    })).toEqual({
      policy: {mode: 'exclusive'},
      fallbackReason: 'commutative_read_not_admitted',
    });
  });
});
