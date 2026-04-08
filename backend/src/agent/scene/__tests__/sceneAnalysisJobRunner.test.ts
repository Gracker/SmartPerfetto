// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Unit tests for SceneAnalysisJobRunner — concurrency, retry, cancel,
 * waitForAllDone, and event ordering.
 */

import {
  JobRunnerEvent,
  SceneAnalysisJobRunner,
  SceneSkillExecutionResult,
  SceneSkillExecutor,
} from '../sceneAnalysisJobRunner';
import { AnalysisInterval } from '../types';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeInterval(id: string, skillId = 'mock_skill'): AnalysisInterval {
  return {
    displayedSceneId: `scene-${id}`,
    priority: 50,
    routeRuleId: 'mock_route',
    skillId,
    params: { id },
  };
}

interface PendingCall {
  id: string;
  resolve: (result: SceneSkillExecutionResult) => void;
  reject: (err: Error) => void;
}

/**
 * A skill executor that suspends every call until the test explicitly
 * resolves it. Lets the test inspect concurrency at any point in time.
 */
class ManualSkillExecutor implements SceneSkillExecutor {
  public pending: PendingCall[] = [];
  public callCount = 0;

  async execute(
    skillId: string,
    _traceId: string,
    params: Record<string, any>,
  ): Promise<SceneSkillExecutionResult> {
    this.callCount += 1;
    return new Promise((resolve, reject) => {
      this.pending.push({ id: String(params.id), resolve, reject });
    });
  }

  resolveNext(result: Partial<SceneSkillExecutionResult> = {}): void {
    const call = this.pending.shift();
    if (!call) throw new Error('no pending call to resolve');
    call.resolve({ success: true, executionTimeMs: 10, displayResults: [], ...result });
  }

  rejectNext(error = new Error('boom')): void {
    const call = this.pending.shift();
    if (!call) throw new Error('no pending call to reject');
    call.reject(error);
  }

  failNext(message = 'skill failed'): void {
    const call = this.pending.shift();
    if (!call) throw new Error('no pending call to fail');
    call.resolve({ success: false, error: message, executionTimeMs: 5 });
  }
}

/** Wait until the microtask + setImmediate queues are flushed. */
function flush(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

function buildRunner(executor: SceneSkillExecutor, opts: Partial<{
  concurrency: number;
  maxRetries: number;
}> = {}) {
  const events: JobRunnerEvent[] = [];
  const runner = new SceneAnalysisJobRunner({
    concurrency: opts.concurrency ?? 3,
    maxRetries: opts.maxRetries ?? 1,
    traceId: 'trace-1',
    analysisId: 'analysis-1',
    skillExecutor: executor,
    onEvent: (e) => events.push(e),
  });
  return { runner, events };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SceneAnalysisJobRunner', () => {
  it('honors the concurrency cap', async () => {
    const exec = new ManualSkillExecutor();
    const { runner } = buildRunner(exec, { concurrency: 3 });

    runner.enqueue([
      makeInterval('a'), makeInterval('b'), makeInterval('c'),
      makeInterval('d'), makeInterval('e'),
    ]);
    await flush();

    // Only 3 of 5 should be in flight.
    expect(exec.pending.length).toBe(3);
    expect(exec.callCount).toBe(3);

    // Resolve one — the next queued job should pick up.
    exec.resolveNext();
    await flush();
    expect(exec.pending.length).toBe(3);
    expect(exec.callCount).toBe(4);

    exec.resolveNext();
    await flush();
    expect(exec.callCount).toBe(5);

    // Drain.
    exec.resolveNext();
    exec.resolveNext();
    exec.resolveNext();
    await runner.waitForAllDone();
    expect(runner.getJobs().every((j) => j.state === 'completed')).toBe(true);
  });

  it('retries a failed job once before marking it failed', async () => {
    const exec = new ManualSkillExecutor();
    const { runner, events } = buildRunner(exec, { concurrency: 1, maxRetries: 1 });

    runner.enqueue([makeInterval('only')]);
    await flush();

    // First attempt fails — runner should retry.
    exec.failNext('first try blew up');
    await flush();

    expect(exec.pending.length).toBe(1);
    const retryEvent = events.find((e) => e.type === 'job_retrying');
    expect(retryEvent).toBeDefined();

    // Second attempt succeeds.
    exec.resolveNext();
    await runner.waitForAllDone();

    const completed = events.find((e) => e.type === 'job_completed');
    expect(completed).toBeDefined();
    const job = runner.getJobs()[0];
    expect(job.state).toBe('completed');
    expect(job.attempt).toBe(1);
  });

  it('marks a job failed when retries are exhausted', async () => {
    const exec = new ManualSkillExecutor();
    const { runner, events } = buildRunner(exec, { concurrency: 1, maxRetries: 1 });

    runner.enqueue([makeInterval('only')]);
    await flush();

    exec.failNext('try one');
    await flush();
    exec.failNext('try two');
    await runner.waitForAllDone();

    const failedEvent = events.find((e) => e.type === 'job_failed');
    expect(failedEvent).toBeDefined();
    const job = runner.getJobs()[0];
    expect(job.state).toBe('failed');
    expect(job.error?.message).toContain('try two');
  });

  it('cancels queued jobs immediately', async () => {
    const exec = new ManualSkillExecutor();
    const { runner, events } = buildRunner(exec, { concurrency: 2 });

    runner.enqueue([
      makeInterval('a'), makeInterval('b'),
      makeInterval('c'), makeInterval('d'),
    ]);
    await flush();

    // 2 are running, 2 are queued.
    expect(exec.pending.length).toBe(2);

    runner.cancel();
    await flush();

    // Queued jobs (c, d) should be cancelled immediately.
    const jobs = runner.getJobs();
    const cancelled = jobs.filter((j) => j.state === 'cancelled');
    expect(cancelled.length).toBe(2);
    const cancelEvents = events.filter((e) => e.type === 'job_cancelled');
    expect(cancelEvents.length).toBe(2);
  });

  it('drops late results when cancel happens mid-flight', async () => {
    const exec = new ManualSkillExecutor();
    const { runner, events } = buildRunner(exec, { concurrency: 2 });

    runner.enqueue([makeInterval('a'), makeInterval('b')]);
    await flush();

    runner.cancel();
    await flush();

    // The two running calls finish AFTER cancel.
    exec.resolveNext();
    exec.resolveNext();
    await runner.waitForAllDone();

    const dropped = events.filter((e) => e.type === 'job_dropped');
    expect(dropped.length).toBe(2);
    expect(runner.getJobs().every((j) => j.state === 'dropped')).toBe(true);
  });

  it('emits all_done exactly once and resolves waitForAllDone', async () => {
    const exec = new ManualSkillExecutor();
    const { runner, events } = buildRunner(exec);

    runner.enqueue([makeInterval('a'), makeInterval('b')]);
    await flush();
    exec.resolveNext();
    exec.resolveNext();
    await runner.waitForAllDone();

    const allDoneEvents = events.filter((e) => e.type === 'all_done');
    expect(allDoneEvents.length).toBe(1);
    // waitForAllDone after completion still resolves immediately.
    await runner.waitForAllDone();
    expect(allDoneEvents.length).toBe(1);
  });

  it('emits all_done immediately on empty enqueue', async () => {
    const exec = new ManualSkillExecutor();
    const { runner, events } = buildRunner(exec);

    runner.enqueue([]);
    await runner.waitForAllDone();

    expect(events.filter((e) => e.type === 'all_done').length).toBe(1);
    expect(runner.getJobs().length).toBe(0);
  });

  it('emits all_done after cancel even with no in-flight jobs', async () => {
    const exec = new ManualSkillExecutor();
    const { runner, events } = buildRunner(exec, { concurrency: 1 });

    runner.enqueue([makeInterval('a'), makeInterval('b')]);
    await flush();
    runner.cancel();
    // Resolve the only running call.
    exec.resolveNext();
    await runner.waitForAllDone();

    expect(events.filter((e) => e.type === 'all_done').length).toBe(1);
  });

  it('rejects invalid concurrency / maxRetries', () => {
    const exec = new ManualSkillExecutor();
    expect(() => new SceneAnalysisJobRunner({
      concurrency: 0,
      maxRetries: 1,
      traceId: 't', analysisId: 'a',
      skillExecutor: exec, onEvent: () => {},
    })).toThrow(/concurrency/);
    expect(() => new SceneAnalysisJobRunner({
      concurrency: 1,
      maxRetries: -1,
      traceId: 't', analysisId: 'a',
      skillExecutor: exec, onEvent: () => {},
    })).toThrow(/maxRetries/);
  });
});
